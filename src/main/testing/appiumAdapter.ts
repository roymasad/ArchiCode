import { persistDelphiScreenshot, type DelphiObservationArtifact } from "./evidenceArtifacts";

export type DelphiAppiumAction = {
  action: "find" | "click" | "fill" | "assert-text" | "back" | "source" | "screenshot";
  using?: "accessibility id" | "id" | "xpath" | "class name" | "-android uiautomator" | "-ios predicate string";
  selector?: string;
  value?: string;
  label?: string;
  purpose?: string;
};

export type DelphiAppiumFlowInput = {
  serverUrl: string;
  sessionId: string;
  actions: DelphiAppiumAction[];
  capture?: "key-steps" | "final" | "none";
};

type WebDriverResponse = { value?: unknown };

function validatedServerUrl(value: string): URL {
  const url = new URL(value);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !localHosts.has(url.hostname)) {
    throw new Error("Delphi's Appium client is limited to a localhost Appium server.");
  }
  if (url.username || url.password) throw new Error("Delphi's Appium server URL must not contain credentials.");
  return url;
}

function safeSessionId(value: string): string {
  const sessionId = value.trim();
  if (!/^[a-z0-9._:-]{1,200}$/i.test(sessionId)) throw new Error("Invalid Appium session id.");
  return sessionId;
}

function safeLabel(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}

async function webdriverCall(base: URL, sessionId: string, endpoint: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal): Promise<WebDriverResponse> {
  const root = base.toString().replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Appium request timed out after 60000ms.")), 60_000);
  const abort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let response: Response;
  try {
    response = await fetch(`${root}/session/${encodeURIComponent(sessionId)}${endpoint}`, {
      method,
      signal: controller.signal,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  const text = await response.text();
  let parsed: WebDriverResponse = {};
  try {
    parsed = text ? JSON.parse(text) as WebDriverResponse : {};
  } catch {
    throw new Error(`Appium returned a non-JSON response (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`Appium request failed (${response.status}): ${text.slice(0, 1000)}`);
  if (parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) && "error" in (parsed.value as Record<string, unknown>)) {
    const error = parsed.value as Record<string, unknown>;
    throw new Error(`Appium ${String(error.error)}: ${String(error.message ?? "unknown WebDriver error")}`);
  }
  return parsed;
}

function elementId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Appium did not return an element reference.");
  const record = value as Record<string, unknown>;
  const id = record["element-6066-11e4-a52e-4f735466cecf"] ?? record.ELEMENT;
  if (typeof id !== "string" || !id) throw new Error("Appium returned an invalid element reference.");
  return id;
}

async function findElement(base: URL, sessionId: string, action: DelphiAppiumAction, signal?: AbortSignal): Promise<string> {
  if (!action.selector?.trim()) throw new Error(`${action.action} requires a selector.`);
  const result = await webdriverCall(base, sessionId, "/element", "POST", {
    using: action.using ?? "accessibility id",
    value: action.selector
  }, signal);
  return elementId(result.value);
}

export async function runDelphiAppiumFlow(
  projectRoot: string,
  input: DelphiAppiumFlowInput,
  options?: { signal?: AbortSignal; onProgress?: (message: string) => void; onArtifact?: (artifact: DelphiObservationArtifact) => void; maxArtifacts?: number; onExecutionStart?: () => void }
): Promise<{
  status: "passed";
  sessionId: string;
  actions: Array<{ index: number; action: DelphiAppiumAction["action"]; detail: string }>;
  artifacts: Array<{ id: string; label: string; path: string; mediaType: "image/png" }>;
}> {
  const base = validatedServerUrl(input.serverUrl);
  const sessionId = safeSessionId(input.sessionId);
  if (!input.actions.length || input.actions.length > 80) throw new Error("An Appium flow must contain between 1 and 80 actions.");
  for (const action of input.actions) {
    if (["find", "click", "fill", "assert-text"].includes(action.action) && !action.selector?.trim()) throw new Error(`${action.action} requires a selector.`);
    if (action.action === "assert-text" && !action.value) throw new Error("assert-text requires a value.");
  }
  const explicitArtifacts = input.actions.filter((action) => action.action === "screenshot").length;
  const finalArtifact = input.capture === "final" && input.actions.at(-1)?.action !== "screenshot" ? 1 : 0;
  const maxArtifacts = options?.maxArtifacts ?? Number.POSITIVE_INFINITY;
  if (explicitArtifacts + finalArtifact > maxArtifacts) throw new Error(`This Appium flow requires ${explicitArtifacts + finalArtifact} explicit/final screenshots, exceeding the remaining Delphi evidence budget of ${maxArtifacts}.`);
  options?.onExecutionStart?.();
  const actions: Array<{ index: number; action: DelphiAppiumAction["action"]; detail: string }> = [];
  const artifacts: Array<{ id: string; label: string; path: string; mediaType: "image/png" }> = [];
  const captureScreenshot = async (label: string): Promise<DelphiObservationArtifact> => {
    const result = await webdriverCall(base, sessionId, "/screenshot", "GET", undefined, options?.signal);
    if (typeof result.value !== "string") throw new Error("Appium screenshot did not return base64 image data.");
    const artifact = await persistDelphiScreenshot(projectRoot, safeLabel(label, "appium-observation"), Buffer.from(result.value, "base64"));
    artifacts.push(artifact);
    options?.onArtifact?.(artifact);
    options?.onProgress?.(`Observation captured: ${artifact.path}`);
    return artifact;
  };
  for (let index = 0; index < input.actions.length; index += 1) {
    if (options?.signal?.aborted) throw new Error("Appium audit was cancelled.");
    const action = input.actions[index]!;
    options?.onProgress?.(`Appium ${index + 1}/${input.actions.length}: ${action.action}`);
    if (action.action === "back") {
      await webdriverCall(base, sessionId, "/back", "POST", {}, options?.signal);
      actions.push({ index, action: action.action, detail: "Navigated back" });
    } else if (action.action === "source") {
      const result = await webdriverCall(base, sessionId, "/source", "GET", undefined, options?.signal);
      actions.push({ index, action: action.action, detail: String(result.value ?? "").slice(0, 4000) });
    } else if (action.action === "screenshot") {
      const label = safeLabel(action.label, `appium-screenshot-${index + 1}`);
      const artifact = await captureScreenshot(label);
      actions.push({ index, action: action.action, detail: `${artifact.path}${action.purpose ? ` — ${action.purpose}` : ""}` });
    } else {
      const id = await findElement(base, sessionId, action, options?.signal);
      const endpoint = `/element/${encodeURIComponent(id)}`;
      if (action.action === "click") {
        await webdriverCall(base, sessionId, `${endpoint}/click`, "POST", {}, options?.signal);
        actions.push({ index, action: action.action, detail: action.selector ?? id });
      } else if (action.action === "fill") {
        const value = action.value ?? "";
        await webdriverCall(base, sessionId, `${endpoint}/value`, "POST", { text: value, value: Array.from(value) }, options?.signal);
        actions.push({ index, action: action.action, detail: action.selector ?? id });
      } else if (action.action === "assert-text") {
        const result = await webdriverCall(base, sessionId, `${endpoint}/text`, "GET", undefined, options?.signal);
        const actual = String(result.value ?? "");
        if (!actual.includes(action.value ?? "")) throw new Error(`Appium text assertion failed for ${action.selector}: expected ${JSON.stringify(action.value ?? "")}, received ${JSON.stringify(actual.slice(0, 500))}.`);
        actions.push({ index, action: action.action, detail: `${action.selector} contains ${JSON.stringify(action.value ?? "")}` });
      } else {
        actions.push({ index, action: action.action, detail: `${action.selector} -> ${id}` });
      }
    }
  }
  if (input.capture === "final" && input.actions.at(-1)?.action !== "screenshot") {
    await captureScreenshot("appium-final");
  }
  return { status: "passed", sessionId, actions, artifacts };
}
