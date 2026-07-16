import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { runtimeServiceSchema } from "../../shared/schema";
import type { ProjectSettings, Run, RuntimeService } from "../../shared/schema";
import { classifyCommandRisk } from "../../shared/execution";
import { stripAnsiEscapes } from "../../shared/terminalText";
import { evaluateFilesystemScope, normalizeForCompare } from "./contextBuilder";
import { loadProject } from "./projectStore";
import { exists, id, iso } from "./persistence";

export const activeRuntimeServices = new Map<string, { service: RuntimeService; child?: ChildProcessWithoutNullStreams }>();

export type RunTarget = {
  id: string;
  label: string;
};

export function runProfileCommands(profile: ProjectSettings["runTargetProfiles"][number]): string[] {
  return [
    profile.discoverCommand,
    profile.installCommand,
    profile.setupCommand,
    profile.buildCommand,
    profile.testCommand,
    profile.launchCommand,
    profile.waitCommand,
    ...profile.diagnosticCommands,
    ...profile.recoveryCommands,
    profile.runCommand
  ].filter((command): command is string => Boolean(command?.trim()));
}

export function profileRisk(profile: ProjectSettings["runTargetProfiles"][number]): Run["risk"] {
  const risks = runProfileCommands(profile).map(classifyCommandRisk);
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  return "low";
}

export function fillRunProfilePlaceholders(text: string, targetId?: string, runTargetId?: string): string {
  return text
    .replaceAll("{targetId}", targetId ?? "")
    .replaceAll("{runTargetId}", runTargetId ?? targetId ?? "");
}

export function compileRunProfilePattern(pattern: string | undefined, targetId: string | undefined, runTargetId?: string): RegExp | null {
  const readyText = pattern ? fillRunProfilePlaceholders(pattern, targetId, runTargetId) : "";
  if (!readyText) return null;
  try {
    return new RegExp(readyText, "i");
  } catch {
    return new RegExp(readyText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

export function parseRunTargets(output: string, targetPattern?: string): RunTarget[] {
  if (!targetPattern) return [];
  let matcher: RegExp;
  try {
    matcher = new RegExp(targetPattern);
  } catch {
    return [];
  }
  return output.split(/\r?\n/).flatMap((line) => {
    const match = matcher.exec(line);
    if (!match) return [];
    const groups = match.groups ?? {};
    const id = groups.id ?? match[1];
    if (!id) return [];
    return [{
      id: id.trim(),
      label: (groups.label ?? match[2] ?? id).trim()
    }];
  });
}

export function chooseRunTarget(
  targets: RunTarget[],
  requestedTargetId?: string,
  defaultTargetId?: string,
  targetPreferencePattern?: string
): RunTarget | null {
  if (!targets.length) return null;
  const requested = requestedTargetId ? targets.find((target) => target.id === requestedTargetId) : null;
  if (requested) return requested;
  const preferred = defaultTargetId ? targets.find((target) => target.id === defaultTargetId) : null;
  if (preferred) return preferred;
  if (targetPreferencePattern) {
    try {
      const preference = new RegExp(targetPreferencePattern, "i");
      const matched = targets.find((target) => preference.test(`${target.id} ${target.label}`));
      if (matched) return matched;
    } catch {
      // Ignore invalid preference patterns; the profile can still use discovery order.
    }
  }
  return targets[0];
}

export function extractReadyTargetId(output: string, readyTargetPattern: string | undefined, targetId: string | undefined): string | undefined {
  const pattern = compileRunProfilePattern(readyTargetPattern, targetId);
  if (!pattern) return undefined;
  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    return (match.groups?.id ?? match[1])?.trim();
  }
  return undefined;
}

export function runtimeServiceKey(projectRoot: string, profileId: string | undefined, command: string, cwd: string): string {
  const source = `${normalizeForCompare(projectRoot)}|${profileId ?? ""}|${command}|${normalizeForCompare(cwd)}`;
  return `runtime-${createHash("sha1").update(source).digest("hex").slice(0, 12)}`;
}

export async function resolveProfileCwd(projectRoot: string, relativeCwd: string | undefined): Promise<{ cwd: string; relativeCwd: string }> {
  const trimmed = relativeCwd?.trim() ?? "";
  if (path.isAbsolute(trimmed)) throw new Error("Runtime profile cwd must be relative to the project root.");
  const cwd = path.resolve(projectRoot, trimmed || ".");
  const relative = path.relative(path.resolve(projectRoot), cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Runtime profile cwd escapes the project root: ${relativeCwd}`);
  }
  if (!(await exists(cwd))) throw new Error(`Runtime profile cwd does not exist: ${trimmed || "."}`);
  return { cwd, relativeCwd: relative === "" ? "" : relative.replace(/\\/g, "/") };
}

export const runtimeUrlPattern = /(https?:\/\/[^\s"'<>),]+)/g;

export function runtimeUrlFromText(text: string): string | undefined {
  return Array.from(stripAnsiEscapes(text).matchAll(runtimeUrlPattern), (match) => match[1]?.replace(/[.,;]+$/, ""))
    .find((url): url is string => Boolean(url));
}

export async function harnessWebContext(enabled: boolean, ...texts: Array<string | undefined>): Promise<string> {
  if (!enabled) return "";
  const urls = [...new Set(texts.join("\n").match(runtimeUrlPattern)?.map((url) => url.replace(/[.,;]+$/, "")) ?? [])]
    .filter((url) => url.startsWith("http://") || url.startsWith("https://"))
    .slice(0, 5);
  if (!urls.length) return "";
  const fetched: string[] = [];
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": "ArchiCode/0.1" } });
      clearTimeout(timeout);
      if (!response.ok) {
        fetched.push(`- ${url}: fetch failed with ${response.status}`);
        continue;
      }
      const text = (await response.text()).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      fetched.push(`- ${url}: ${text.slice(0, 4000)}`);
    } catch (error) {
      fetched.push(`- ${url}: fetch failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return fetched.length ? ["## Harness-Fed Web Context", ...fetched].join("\n") : "";
}

export function nativeWebSearchEnabled(settings: ProjectSettings): boolean {
  return settings.webSearch.enabled && (settings.webSearch.provider ?? "native") === "native";
}

export function appendRuntimeLog(service: RuntimeService, stream: "system" | "stdout" | "stderr", text: string): RuntimeService {
  const at = iso();
  const cleanText = stripAnsiEscapes(text);
  const discoveredUrl = runtimeUrlFromText(cleanText);
  return runtimeServiceSchema.parse({
    ...service,
    url: discoveredUrl ?? service.url,
    lastOutputAt: at,
    logs: [...service.logs, { at, stream, text: cleanText }].slice(-500)
  });
}

export async function runManagedPreflightCommand(
  command: string,
  cwd: string,
  onOutput: (stream: "stdout" | "stderr", text: string) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<number | null> {
  const child = spawn(command, {
    cwd,
    shell: true,
    env,
    detached: process.platform !== "win32"
  });
  child.stdout.on("data", (chunk: Buffer) => onOutput("stdout", chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => onOutput("stderr", chunk.toString()));
  return new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(1));
  });
}

export async function listRuntimeServices(projectRoot: string): Promise<RuntimeService[]> {
  const normalizedRoot = normalizeForCompare(projectRoot);
  return [...activeRuntimeServices.values()]
    .map((entry) => entry.service)
    .filter((service) => normalizeForCompare(service.projectRoot) === normalizedRoot)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function runStopCommand(command: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, windowsHide: true });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

export function runtimeServiceSpawnOptions(cwd: string): SpawnOptionsWithoutStdio {
  return {
    cwd,
    shell: true,
    env: process.env,
    detached: process.platform !== "win32",
    windowsHide: true
  };
}

export async function terminateChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) {
    child.kill("SIGTERM");
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true
      });
      killer.on("close", () => resolve());
      killer.on("error", () => {
        child.kill("SIGTERM");
        resolve();
      });
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export async function startRuntimeService(input: {
  projectRoot: string;
  profileId?: string;
  command?: string;
  label?: string;
  cwd?: string;
  targetId?: string;
}): Promise<RuntimeService[]> {
  const bundle = await loadProject(input.projectRoot);
  const profile = input.profileId ? bundle.project.settings.runTargetProfiles.find((item) => item.id === input.profileId) : undefined;
  if (input.profileId && !profile) throw new Error(`Runtime profile ${input.profileId} was not found.`);
  if (profile?.targetRequired && !(input.targetId ?? profile.defaultTargetId)) {
    throw new Error(`Runtime profile "${profile.label}" requires a target before it can start.`);
  }
  const targetId = input.targetId ?? profile?.defaultTargetId;
  const command = fillRunProfilePlaceholders((input.command ?? profile?.runCommand ?? "").trim(), targetId);
  if (!command) throw new Error("Runtime service needs a run command.");
  const setupCommand = profile?.setupCommand ? fillRunProfilePlaceholders(profile.setupCommand.trim(), targetId) : undefined;
  const cwdInfo = await resolveProfileCwd(input.projectRoot, input.cwd ?? profile?.cwd);
  for (const checkedCommand of [setupCommand, command].filter((item): item is string => Boolean(item?.trim()))) {
    const risk = classifyCommandRisk(checkedCommand);
    const scope = await evaluateFilesystemScope(input.projectRoot, bundle.project.settings, checkedCommand, cwdInfo.cwd, risk);
    if (!scope.allowed) throw new Error(`Runtime service blocked by filesystem scope: ${scope.violations.join(" ")}`);
  }

  const serviceId = runtimeServiceKey(input.projectRoot, profile?.id, command, cwdInfo.cwd);
  const existing = activeRuntimeServices.get(serviceId);
  if (existing?.child && (existing.service.status === "starting" || existing.service.status === "running")) {
    return listRuntimeServices(input.projectRoot);
  }

  const startedAt = iso();
  let service = runtimeServiceSchema.parse({
    id: serviceId,
    projectRoot: input.projectRoot,
    profileId: profile?.id,
    label: input.label ?? profile?.label ?? command,
    kind: profile?.kind ?? "generic",
    status: "starting",
    command,
    cwd: cwdInfo.cwd,
    relativeCwd: cwdInfo.relativeCwd,
    url: profile?.url,
    ports: profile?.ports ?? [],
    startedAt,
    logs: [
      { at: startedAt, stream: "system", text: `Starting ${profile?.label ?? "runtime service"}: ${command}` },
      { at: startedAt, stream: "system", text: `Working directory: ${cwdInfo.relativeCwd || "."}` }
    ]
  });
  activeRuntimeServices.set(serviceId, { service });

  const update = (stream: "stdout" | "stderr", text: string): void => {
    const current = activeRuntimeServices.get(serviceId);
    if (!current) return;
    current.service = appendRuntimeLog(current.service, stream, text);
    activeRuntimeServices.set(serviceId, current);
  };
  if (setupCommand) {
    service = appendRuntimeLog(service, "system", `Running setup command: ${setupCommand}`);
    activeRuntimeServices.set(serviceId, { service });
    const setupExitCode = await runManagedPreflightCommand(setupCommand, cwdInfo.cwd, update);
    const current = activeRuntimeServices.get(serviceId);
    if (!current) return listRuntimeServices(input.projectRoot);
    if (setupExitCode !== 0) {
      current.service = runtimeServiceSchema.parse({
        ...appendRuntimeLog(current.service, "stderr", `Setup command exited with code ${setupExitCode ?? "unknown"}.`),
        status: "failed",
        exitCode: setupExitCode,
        stoppedAt: iso()
      });
      activeRuntimeServices.set(serviceId, current);
      return listRuntimeServices(input.projectRoot);
    }
    current.service = appendRuntimeLog(current.service, "system", "Setup command completed.");
    activeRuntimeServices.set(serviceId, current);
  }

  const child = spawn(command, runtimeServiceSpawnOptions(cwdInfo.cwd));
  const current = activeRuntimeServices.get(serviceId) ?? { service };
  current.service = runtimeServiceSchema.parse({ ...current.service, status: "running", pid: child.pid });
  current.child = child;
  activeRuntimeServices.set(serviceId, current);

  child.stdout.on("data", (chunk: Buffer) => update("stdout", chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => update("stderr", chunk.toString()));
  child.on("error", (error) => {
    const current = activeRuntimeServices.get(serviceId);
    if (!current) return;
    current.service = runtimeServiceSchema.parse({
      ...appendRuntimeLog(current.service, "stderr", error.message),
      status: "failed",
      stoppedAt: iso()
    });
    current.child = undefined;
    activeRuntimeServices.set(serviceId, current);
  });
  child.on("close", (exitCode) => {
    const current = activeRuntimeServices.get(serviceId);
    if (!current) return;
    if (current.service.status === "stopped") {
      current.child = undefined;
      activeRuntimeServices.set(serviceId, current);
      return;
    }
    current.service = runtimeServiceSchema.parse({
      ...appendRuntimeLog(current.service, exitCode === 0 ? "system" : "stderr", `Runtime command exited with code ${exitCode ?? "unknown"}.`),
      status: exitCode === 0 ? "stopped" : "failed",
      exitCode,
      stoppedAt: iso()
    });
    current.child = undefined;
    activeRuntimeServices.set(serviceId, current);
  });

  return listRuntimeServices(input.projectRoot);
}

export async function stopRuntimeService(projectRoot: string, serviceId: string): Promise<RuntimeService[]> {
  const entry = activeRuntimeServices.get(serviceId);
  if (!entry || normalizeForCompare(entry.service.projectRoot) !== normalizeForCompare(projectRoot)) return listRuntimeServices(projectRoot);
  const profile = entry.service.profileId
    ? (await loadProject(projectRoot)).project.settings.runTargetProfiles.find((item) => item.id === entry.service.profileId)
    : undefined;
  if (profile?.stopCommand) {
    entry.service = appendRuntimeLog(entry.service, "system", `Stopping with: ${profile.stopCommand}`);
    activeRuntimeServices.set(serviceId, entry);
    await runStopCommand(profile.stopCommand, entry.service.cwd);
  }
  if (entry.child) await terminateChildProcess(entry.child);
  entry.service = runtimeServiceSchema.parse({
    ...appendRuntimeLog(entry.service, "system", "Runtime service stopped."),
    status: "stopped",
    stoppedAt: iso()
  });
  entry.child = undefined;
  activeRuntimeServices.set(serviceId, entry);
  return listRuntimeServices(projectRoot);
}

export async function restartRuntimeService(projectRoot: string, serviceId: string): Promise<RuntimeService[]> {
  const entry = activeRuntimeServices.get(serviceId);
  if (!entry || normalizeForCompare(entry.service.projectRoot) !== normalizeForCompare(projectRoot)) return listRuntimeServices(projectRoot);
  const { profileId, command, label, relativeCwd } = entry.service;
  await stopRuntimeService(projectRoot, serviceId);
  return startRuntimeService({ projectRoot, profileId, command: profileId ? undefined : command, label, cwd: relativeCwd });
}
