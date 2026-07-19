import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { persistDelphiScreenshot, type DelphiObservationArtifact } from "./evidenceArtifacts";

export type DelphiMobileTargetAction = {
  action: "assert-device-ready" | "screenshot" | "tap" | "text" | "keyevent" | "dump-ui" | "assert-text" | "open-url";
  x?: number;
  y?: number;
  value?: string;
  label?: string;
  purpose?: string;
};

type MobileStepResult = { exitCode: number | null; stdout: Buffer; stderr: string };
type MobileStep = (command: string, args: string[], options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<MobileStepResult>;

async function runMobileStep(command: string, args: string[], options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<MobileStepResult> {
  if (options?.signal?.aborted) throw new Error("Mobile target action was cancelled before it started.");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), Math.min(120_000, Math.max(1_000, options?.timeoutMs ?? 30_000)));
    const abort = (): void => { child.kill("SIGTERM"); };
    options?.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", abort);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutBytes += chunk.byteLength;
      while (stdoutBytes > 20 * 1024 * 1024 && stdout.length > 1) stdoutBytes -= stdout.shift()!.byteLength;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 80_000) stderr = stderr.slice(-80_000);
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode) => {
      cleanup();
      resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: stderr.trim() });
    });
  });
}

function safeDeviceId(value: string): string {
  const deviceId = value.trim();
  if (!deviceId || deviceId.length > 300 || /[\r\n\0]/.test(deviceId)) throw new Error("Invalid mobile target id.");
  return deviceId;
}

function safeLabel(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}

function requireSuccess(result: MobileStepResult, label: string): void {
  if (result.exitCode !== 0) throw new Error(`${label} failed with code ${result.exitCode ?? "unknown"}.${result.stderr ? ` ${result.stderr.slice(-2000)}` : ""}`);
}

async function androidUiXml(deviceId: string, step: MobileStep, signal?: AbortSignal): Promise<string> {
  const result = await step("adb", ["-s", deviceId, "exec-out", "uiautomator", "dump", "/dev/tty"], { signal, timeoutMs: 30_000 });
  requireSuccess(result, "Android UI hierarchy capture");
  return result.stdout.toString("utf8").slice(-200_000);
}

export async function runDelphiMobileTargetFlow(
  projectRoot: string,
  input: { platform: "android" | "ios"; deviceId: string; actions: DelphiMobileTargetAction[]; capture?: "key-steps" | "final" | "none" },
  options?: { signal?: AbortSignal; onProgress?: (message: string) => void; onArtifact?: (artifact: DelphiObservationArtifact) => void; runStep?: MobileStep; maxArtifacts?: number; onExecutionStart?: () => void }
): Promise<{
  status: "passed";
  platform: "android" | "ios";
  deviceId: string;
  actions: Array<{ index: number; action: DelphiMobileTargetAction["action"]; detail: string }>;
  artifacts: Array<{ id: string; label: string; path: string; mediaType: "image/png" }>;
}> {
  const deviceId = safeDeviceId(input.deviceId);
  if (!input.actions.length || input.actions.length > 80) throw new Error("A mobile target flow must contain between 1 and 80 actions.");
  for (const action of input.actions) {
    if (input.platform === "ios" && !["assert-device-ready", "screenshot", "open-url"].includes(action.action)) throw new Error(`${action.action} requires Appium for iOS; Delphi's native iOS adapter supports readiness, screenshots, and open-url.`);
    if (action.action === "tap" && (!Number.isFinite(action.x) || !Number.isFinite(action.y))) throw new Error("tap requires numeric x and y coordinates.");
    if ((action.action === "text" || action.action === "assert-text" || action.action === "keyevent" || action.action === "open-url") && !action.value) throw new Error(`${action.action} requires a value.`);
    if (action.action === "text" && !/^[a-z0-9 ._@%+,:!?-]*$/i.test((action.value ?? "").slice(0, 1000))) throw new Error("Android native text input contains unsupported characters; use Appium for complex text.");
    if (action.action === "keyevent" && !/^[A-Z0-9_]+$/i.test(action.value ?? "")) throw new Error("keyevent requires an Android key code/name.");
    if (action.action === "open-url" && (!/^https?:\/\//i.test(action.value ?? "") || /[;&|`$<>\r\n]/.test(action.value ?? ""))) throw new Error("open-url requires a safe http or https URL.");
  }
  const explicitArtifacts = input.actions.filter((action) => action.action === "screenshot").length;
  const finalArtifact = input.capture === "final" && input.actions.at(-1)?.action !== "screenshot" ? 1 : 0;
  const maxArtifacts = options?.maxArtifacts ?? Number.POSITIVE_INFINITY;
  if (explicitArtifacts + finalArtifact > maxArtifacts) throw new Error(`This mobile flow requires ${explicitArtifacts + finalArtifact} explicit/final screenshots, exceeding the remaining Delphi evidence budget of ${maxArtifacts}.`);
  const step = options?.runStep ?? runMobileStep;
  options?.onExecutionStart?.();
  const actions: Array<{ index: number; action: DelphiMobileTargetAction["action"]; detail: string }> = [];
  const artifacts: Array<{ id: string; label: string; path: string; mediaType: "image/png" }> = [];

  const captureScreenshot = async (label: string): Promise<DelphiObservationArtifact> => {
    let png: Buffer;
    if (input.platform === "android") {
      const result = await step("adb", ["-s", deviceId, "exec-out", "screencap", "-p"], { signal: options?.signal });
      requireSuccess(result, "Android screenshot");
      png = result.stdout;
    } else {
      const temporaryRoot = await mkdtemp(path.join(tmpdir(), "archicode-delphi-ios-"));
      const screenshotPath = path.join(temporaryRoot, "screenshot.png");
      try {
        const result = await step("xcrun", ["simctl", "io", deviceId, "screenshot", screenshotPath], { signal: options?.signal });
        requireSuccess(result, "iOS simulator screenshot");
        png = await readFile(screenshotPath);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
    const artifact = await persistDelphiScreenshot(projectRoot, safeLabel(label, `${input.platform}-observation`), png);
    artifacts.push(artifact);
    options?.onArtifact?.(artifact);
    options?.onProgress?.(`Observation captured: ${artifact.path}`);
    return artifact;
  };

  for (let index = 0; index < input.actions.length; index += 1) {
    const action = input.actions[index]!;
    if (options?.signal?.aborted) throw new Error("Mobile target audit was cancelled.");
    options?.onProgress?.(`${input.platform === "android" ? "Android" : "iOS"} ${index + 1}/${input.actions.length}: ${action.action}`);
    if (action.action === "assert-device-ready") {
      const result = input.platform === "android"
        ? await step("adb", ["-s", deviceId, "get-state"], { signal: options?.signal })
        : await step("xcrun", ["simctl", "list", "devices", "booted", "--json"], { signal: options?.signal });
      requireSuccess(result, "Device readiness check");
      const output = result.stdout.toString("utf8");
      if (input.platform === "android" ? !/device/i.test(output) : !output.includes(deviceId)) throw new Error(`Selected ${input.platform} target ${deviceId} is not ready.`);
      actions.push({ index, action: action.action, detail: `${deviceId} is ready` });
    } else if (action.action === "screenshot") {
      const label = safeLabel(action.label, `${input.platform}-screenshot-${index + 1}`);
      const artifact = await captureScreenshot(label);
      actions.push({ index, action: action.action, detail: `${artifact.path}${action.purpose ? ` — ${action.purpose}` : ""}` });
    } else if (action.action === "open-url") {
      if (!action.value || !/^https?:\/\//i.test(action.value)) throw new Error("open-url requires an http or https URL.");
      if (/[;&|`$<>\r\n]/.test(action.value)) throw new Error("open-url contains unsupported shell metacharacters.");
      const result = input.platform === "android"
        ? await step("adb", ["-s", deviceId, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", action.value], { signal: options?.signal })
        : await step("xcrun", ["simctl", "openurl", deviceId, action.value], { signal: options?.signal });
      requireSuccess(result, "Open URL");
      actions.push({ index, action: action.action, detail: action.value });
    } else {
      if (input.platform !== "android") throw new Error(`${action.action} requires Appium for iOS; Delphi's native iOS adapter supports readiness, screenshots, and open-url.`);
      if (action.action === "tap") {
        if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) throw new Error("tap requires numeric x and y coordinates.");
        const result = await step("adb", ["-s", deviceId, "shell", "input", "tap", String(Math.round(action.x!)), String(Math.round(action.y!))], { signal: options?.signal });
        requireSuccess(result, "Android tap");
        actions.push({ index, action: action.action, detail: `${Math.round(action.x!)},${Math.round(action.y!)}` });
      } else if (action.action === "text") {
        const rawValue = (action.value ?? "").slice(0, 1000);
        if (!/^[a-z0-9 ._@%+,:!?-]*$/i.test(rawValue)) throw new Error("Android native text input contains unsupported characters; use Appium for complex text.");
        const value = rawValue.replace(/\s/g, "%s");
        const result = await step("adb", ["-s", deviceId, "shell", "input", "text", value], { signal: options?.signal });
        requireSuccess(result, "Android text input");
        actions.push({ index, action: action.action, detail: "Entered text" });
      } else if (action.action === "keyevent") {
        if (!action.value || !/^[A-Z0-9_]+$/i.test(action.value)) throw new Error("keyevent requires an Android key code/name.");
        const result = await step("adb", ["-s", deviceId, "shell", "input", "keyevent", action.value], { signal: options?.signal });
        requireSuccess(result, "Android key event");
        actions.push({ index, action: action.action, detail: action.value });
      } else {
        const xml = await androidUiXml(deviceId, step, options?.signal);
        if (action.action === "assert-text") {
          if (!xml.includes(action.value ?? "")) throw new Error(`Android UI assertion failed: ${JSON.stringify(action.value ?? "")} was not found.`);
          actions.push({ index, action: action.action, detail: `UI contains ${JSON.stringify(action.value ?? "")}` });
        } else {
          actions.push({ index, action: action.action, detail: xml.slice(0, 4000) });
        }
      }
    }
  }
  if (input.capture === "final" && input.actions.at(-1)?.action !== "screenshot") {
    await captureScreenshot(`${input.platform}-final`);
  }
  return { status: "passed", platform: input.platform, deviceId, actions, artifacts };
}
