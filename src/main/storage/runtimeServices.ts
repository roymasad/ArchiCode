import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { runtimeServiceSchema } from "../../shared/schema";
import type { ProjectSettings, Run, RuntimeService } from "../../shared/schema";
import { classifyCommandRisk } from "../../shared/execution";
import { stripAnsiEscapes } from "../../shared/terminalText";
import { evaluateFilesystemScope, normalizeForCompare } from "./contextBuilder";
import { loadProject } from "./projectStore";
import { exists, id, iso } from "./persistence";

type ActiveRuntimeService = {
  service: RuntimeService;
  child?: ChildProcessWithoutNullStreams;
  initiallyOccupiedPorts?: number[];
  urlObservedFromProcess?: boolean;
};

export const activeRuntimeServices = new Map<string, ActiveRuntimeService>();

export type RunTarget = {
  id: string;
  label: string;
};

async function localAddressIsListening(host: "127.0.0.1" | "::1", port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function localPortIsListening(port: number): Promise<boolean> {
  const states = await Promise.all([
    localAddressIsListening("127.0.0.1", port),
    localAddressIsListening("::1", port)
  ]);
  return states.some(Boolean);
}

export async function runtimePortsInUse(ports: number[]): Promise<number[]> {
  const unique = Array.from(new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)));
  const states = await Promise.all(unique.map(async (port) => ({ port, listening: await localPortIsListening(port) })));
  return states.filter((entry) => entry.listening).map((entry) => entry.port);
}

export function runProfileCommands(profile: ProjectSettings["runTargetProfiles"][number]): string[] {
  return [
    profile.discoverCommand,
    profile.installCommand,
    profile.setupCommand,
    profile.buildCommand,
    profile.testCommand,
    profile.launchCommand,
    profile.waitCommand,
    profile.stopCommand,
    profile.targetStopCommand,
    profile.healthCommand,
    ...profile.diagnosticCommands,
    ...profile.recoveryCommands,
    profile.runCommand
  ].filter((command): command is string => Boolean(command?.trim()));
}

export function runProfileLaunchCommands(profile: ProjectSettings["runTargetProfiles"][number]): string[] {
  return [
    profile.discoverCommand,
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

export function assertSafeRuntimeTargetId(value: string | undefined, label = "runtime target id"): string | undefined {
  const targetId = value?.trim();
  if (!targetId) return undefined;
  // Runtime profiles interpolate target ids into reviewed shell commands. Keep
  // the value to the identifier alphabet used by Flutter, ADB, and simctl so
  // discovered or model-supplied text cannot add another shell expression.
  if (targetId.length > 300 || !/^[a-z0-9._:/-]+$/i.test(targetId)) {
    throw new Error(`Invalid ${label}: only letters, numbers, dot, underscore, colon, slash, and hyphen are allowed.`);
  }
  return targetId;
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
  const discoveredUrl = stream === "system" ? undefined : runtimeUrlFromText(cleanText);
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

type RuntimeProfileStepResult = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
};

async function executeRuntimeProfileStep(
  command: string,
  cwd: string,
  timeoutMs: number,
  onOutput?: (stream: "stdout" | "stderr", text: string) => void
): Promise<RuntimeProfileStepResult> {
  return new Promise((resolve) => {
    const child = spawn(command, runtimeServiceSpawnOptions(cwd));
    let output = "";
    let settled = false;
    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      if (output.length > 80_000) output = output.slice(-80_000);
      onOutput?.(stream, text);
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void terminateChildProcess(child).finally(() => resolve({ exitCode: null, output, timedOut: true }));
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onOutput?.("stderr", error.message);
      resolve({ exitCode: null, output: `${output}\n${error.message}`.trim(), timedOut: false });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, output, timedOut: false });
    });
  });
}

export async function discoverRuntimeProfileTargets(projectRoot: string, profileId: string): Promise<RunTarget[]> {
  const bundle = await loadProject(projectRoot);
  const profile = bundle.project.settings.runTargetProfiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Runtime profile ${profileId} was not found.`);
  if (!profile.discoverCommand) return [];
  const cwdInfo = await resolveProfileCwd(projectRoot, profile.cwd);
  const risk = classifyCommandRisk(profile.discoverCommand);
  if (risk !== "low") throw new Error(`Target discovery for "${profile.label}" is ${risk} risk and cannot run before launch approval. Select a target id explicitly or make the discovery command read-only.`);
  const scope = await evaluateFilesystemScope(projectRoot, bundle.project.settings, profile.discoverCommand, cwdInfo.cwd, risk);
  if (!scope.allowed) throw new Error(`Target discovery for "${profile.label}" is outside the allowed filesystem scope: ${scope.violations.join(" ")}`);
  const result = await executeRuntimeProfileStep(profile.discoverCommand, cwdInfo.cwd, 20_000);
  if (result.exitCode !== 0) throw new Error(`Target discovery failed for "${profile.label}".${result.output ? ` ${result.output.slice(-2000)}` : ""}`);
  return parseRunTargets(result.output, profile.targetPattern);
}

async function checkRuntimeTargetReady(
  profile: ProjectSettings["runTargetProfiles"][number],
  targetId: string | undefined,
  cwd: string,
  onOutput: (stream: "stdout" | "stderr", text: string) => void
): Promise<{ ready: boolean; runTargetId?: string }> {
  if (!profile.waitCommand) return { ready: true, runTargetId: targetId };
  const command = fillRunProfilePlaceholders(profile.waitCommand, targetId);
  const result = await executeRuntimeProfileStep(command, cwd, 12_000, onOutput);
  const readyPattern = compileRunProfilePattern(profile.readyPattern, targetId);
  const notReadyPattern = compileRunProfilePattern(profile.notReadyPattern, targetId);
  const ready = result.exitCode === 0
    && (!notReadyPattern || !notReadyPattern.test(result.output))
    && (!readyPattern || readyPattern.test(result.output));
  return {
    ready,
    runTargetId: ready
      ? assertSafeRuntimeTargetId(extractReadyTargetId(result.output, profile.readyTargetPattern, targetId) ?? targetId, "attached runtime target id")
      : undefined
  };
}

async function waitForRuntimeTarget(
  profile: ProjectSettings["runTargetProfiles"][number],
  targetId: string | undefined,
  cwd: string,
  onOutput: (stream: "stdout" | "stderr", text: string) => void
): Promise<{ ready: boolean; runTargetId?: string }> {
  const deadline = Date.now() + profile.timeoutSeconds * 1000;
  do {
    const result = await checkRuntimeTargetReady(profile, targetId, cwd, onOutput);
    if (result.ready) return result;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } while (Date.now() < deadline);
  return { ready: false };
}

export async function listRuntimeServices(projectRoot: string): Promise<RuntimeService[]> {
  const normalizedRoot = normalizeForCompare(projectRoot);
  return [...activeRuntimeServices.values()]
    .map((entry) => entry.service)
    .filter((service) => normalizeForCompare(service.projectRoot) === normalizedRoot)
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function runtimeUrlResponds(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    // A 4xx proves that something is listening, but not that the reviewed app
    // route is ready. Profiles with an intentionally protected endpoint can
    // use healthCommand or runtimeReadyPattern as their explicit signal.
    return response.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForRuntimeServiceReady(
  projectRoot: string,
  serviceId: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<RuntimeService> {
  const deadline = Date.now() + Math.min(10 * 60_000, Math.max(1_000, options?.timeoutMs ?? 120_000));
  const initialService = (await listRuntimeServices(projectRoot)).find((item) => item.id === serviceId);
  if (!initialService) throw new Error(`Runtime service ${serviceId} was not found.`);
  const bundle = await loadProject(projectRoot);
  const profile = initialService.profileId ? bundle.project.settings.runTargetProfiles.find((item) => item.id === initialService.profileId) : undefined;
  while (Date.now() < deadline) {
    if (options?.signal?.aborted) throw new Error("Runtime readiness wait was cancelled.");
    const service = (await listRuntimeServices(projectRoot)).find((item) => item.id === serviceId);
    if (!service) throw new Error(`Runtime service ${serviceId} was not found.`);
    if (service.status === "failed" || service.status === "stopped" || service.status === "stale") {
      const detail = service.logs.slice(-8).map((entry) => entry.text.trim()).filter(Boolean).join(" ");
      throw new Error(`Runtime service "${service.label}" became ${service.status}.${detail ? ` ${detail.slice(-2000)}` : ""}`);
    }
    // System entries echo commands and can therefore contain the configured
    // ready pattern before the child process has produced any real output.
    const processOutput = service.logs
      .filter((entry) => entry.stream === "stdout" || entry.stream === "stderr")
      .map((entry) => entry.text)
      .join("\n");
    const activeEntry = activeRuntimeServices.get(serviceId);
    const observedProcessUrl = Boolean(activeEntry?.urlObservedFromProcess || runtimeUrlFromText(processOutput));
    let serviceUrlPort: number | undefined;
    if (service.url) {
      try {
        const parsed = new URL(service.url);
        serviceUrlPort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
      } catch {
        serviceUrlPort = undefined;
      }
    }
    const configuredUrlWasPreoccupied = serviceUrlPort !== undefined
      && Boolean(activeEntry?.initiallyOccupiedPorts?.includes(serviceUrlPort));
    // A configured URL that was already listening before this child launched
    // proves only that *some* app is alive. Trust it only when this process
    // emitted that URL itself, or when the port was free before launch.
    const serviceUrlIdentifiesThisProcess = observedProcessUrl || !configuredUrlWasPreoccupied;
    const configuredPattern = profile?.runtimeReadyPattern
      ?? ((service.kind === "web" || service.kind === "api") ? profile?.readyPattern : undefined);
    const configuredReady = configuredPattern
      ? Boolean(compileRunProfilePattern(configuredPattern, service.targetId, service.runTargetId)?.test(processOutput))
      : false;
    const flutterReady = service.kind === "flutter" && /Flutter run key commands|Syncing files to|A Dart VM Service|The Flutter DevTools debugger/i.test(processOutput);
    const urlReady = service.url && serviceUrlIdentifiesThisProcess ? await runtimeUrlResponds(service.url) : false;
    const healthCommand = profile?.healthCommand
      ? fillRunProfilePlaceholders(profile.healthCommand, service.targetId, service.runTargetId)
      : undefined;
    const healthReady = healthCommand
      ? (await executeRuntimeProfileStep(healthCommand, service.cwd, 5_000)).exitCode === 0
      : false;
    const processSignalReady = configuredReady || flutterReady || healthReady;
    const webIdentityReady = service.kind !== "web" && service.kind !== "api"
      ? true
      : !service.url || serviceUrlIdentifiesThisProcess;
    if ((processSignalReady && webIdentityReady) || urlReady) return service;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const service = (await listRuntimeServices(projectRoot)).find((item) => item.id === serviceId);
  const missingExplicitReadiness = service
    && service.kind !== "web"
    && service.kind !== "api"
    && service.kind !== "flutter"
    && !profile?.runtimeReadyPattern
    && !profile?.healthCommand
    && !service.url;
  const conflictPorts = activeRuntimeServices.get(serviceId)?.initiallyOccupiedPorts ?? [];
  throw new Error(`Runtime service "${service?.label ?? serviceId}" did not become ready before the timeout.${conflictPorts.length ? ` Configured port${conflictPorts.length === 1 ? "" : "s"} ${conflictPorts.join(", ")} belonged to another listener before launch, and this process did not report a usable fallback URL. Stop that listener with approval or configure a different port.` : ""}${missingExplicitReadiness ? " Configure runtimeReadyPattern, healthCommand, or an app URL for reliable desktop/native readiness." : ""}`);
}

export async function runStopCommand(command: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, windowsHide: true });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      void terminateChildProcess(child).finally(finish);
    }, 10_000);
    child.on("close", finish);
    child.on("error", finish);
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
  const cwdInfo = await resolveProfileCwd(input.projectRoot, input.cwd ?? profile?.cwd);
  const commandTemplate = (input.command ?? profile?.runCommand ?? "").trim();
  if (!commandTemplate) throw new Error("Runtime service needs a run command.");
  const requestedTargetId = assertSafeRuntimeTargetId(input.targetId, "requested runtime target id");
  let targetId = assertSafeRuntimeTargetId(requestedTargetId ?? profile?.defaultTargetId, "runtime target id");
  let runTargetId: string | undefined;
  let targetStartedByService = false;
  const serviceId = runtimeServiceKey(input.projectRoot, profile?.id, `${commandTemplate}|${targetId ?? "auto"}`, cwdInfo.cwd);
  const existing = activeRuntimeServices.get(serviceId);
  if (existing?.child && (existing.service.status === "starting" || existing.service.status === "running")) {
    return listRuntimeServices(input.projectRoot);
  }

  const startedAt = iso();
  const initiallyOccupiedPorts = await runtimePortsInUse(profile?.ports ?? []);
  let service = runtimeServiceSchema.parse({
    id: serviceId,
    projectRoot: input.projectRoot,
    profileId: profile?.id,
    label: input.label ?? profile?.label ?? commandTemplate,
    kind: profile?.kind ?? "generic",
    status: "starting",
    command: fillRunProfilePlaceholders(commandTemplate, targetId),
    cwd: cwdInfo.cwd,
    relativeCwd: cwdInfo.relativeCwd,
    url: profile?.url,
    targetId,
    runTargetId,
    targetStartedByService,
    ports: profile?.ports ?? [],
    startedAt,
    logs: [
      { at: startedAt, stream: "system", text: `Starting ${profile?.label ?? "runtime service"}.` },
      { at: startedAt, stream: "system", text: `Working directory: ${cwdInfo.relativeCwd || "."}` },
      ...(initiallyOccupiedPorts.length
        ? [{
            at: startedAt,
            stream: "system" as const,
            text: `Configured port${initiallyOccupiedPorts.length === 1 ? "" : "s"} already occupied before launch: ${initiallyOccupiedPorts.join(", ")}. ArchiCode will not treat the existing listener as this runtime or stop it without approval; it will wait for this process to report a safe fallback URL.`
          }]
        : [])
    ]
  });
  activeRuntimeServices.set(serviceId, { service, initiallyOccupiedPorts, urlObservedFromProcess: false });

  const update = (stream: "system" | "stdout" | "stderr", text: string): void => {
    const current = activeRuntimeServices.get(serviceId);
    if (!current) return;
    if (stream !== "system" && runtimeUrlFromText(text)) current.urlObservedFromProcess = true;
    current.service = appendRuntimeLog(current.service, stream, text);
    activeRuntimeServices.set(serviceId, current);
  };
  const system = (text: string): void => update("system", text);
  const assertAllowed = async (command: string): Promise<void> => {
    const risk = classifyCommandRisk(command);
    const scope = await evaluateFilesystemScope(input.projectRoot, bundle.project.settings, command, cwdInfo.cwd, risk);
    if (!scope.allowed) throw new Error(`Runtime service blocked by filesystem scope: ${scope.violations.join(" ")}`);
  };
  const fail = async (message: string): Promise<RuntimeService[]> => {
    const current = activeRuntimeServices.get(serviceId) ?? { service };
    if (targetStartedByService && profile?.targetStopCommand) {
      const targetStopCommand = fillRunProfilePlaceholders(profile.targetStopCommand, targetId, runTargetId);
      current.service = appendRuntimeLog(current.service, "system", `Cleaning up target after failed startup: ${targetStopCommand}`);
      activeRuntimeServices.set(serviceId, current);
      await runStopCommand(targetStopCommand, cwdInfo.cwd);
      targetStartedByService = false;
    }
    current.service = runtimeServiceSchema.parse({
      ...appendRuntimeLog(current.service, "stderr", message),
      status: "failed",
      targetId,
      runTargetId,
      targetStartedByService,
      stoppedAt: iso()
    });
    current.child = undefined;
    activeRuntimeServices.set(serviceId, current);
    return listRuntimeServices(input.projectRoot);
  };

  try {
    if (profile?.discoverCommand) {
      const discoverCommand = fillRunProfilePlaceholders(profile.discoverCommand, targetId);
      await assertAllowed(discoverCommand);
      system(`Discovering runtime targets: ${discoverCommand}`);
      const discovered = await executeRuntimeProfileStep(discoverCommand, cwdInfo.cwd, 20_000, update);
      if (discovered.exitCode !== 0) return fail(`Target discovery failed with code ${discovered.exitCode ?? "unknown"}.`);
      const targets = parseRunTargets(discovered.output, profile.targetPattern);
      const selected = requestedTargetId
        ? targets.find((target) => target.id === requestedTargetId) ?? null
        : chooseRunTarget(targets, undefined, profile.defaultTargetId, profile.targetPreferencePattern);
      if (requestedTargetId && targets.length && !selected) {
        return fail(`Requested runtime target ${requestedTargetId} was not found. Available targets: ${targets.map((target) => `${target.label} (${target.id})`).join(", ")}.`);
      }
      targetId = assertSafeRuntimeTargetId(selected?.id ?? targetId, "discovered runtime target id");
      if (selected) system(`Selected runtime target: ${selected.label} (${selected.id}).`);
    }

    if (profile?.targetRequired && !targetId) return fail(`Runtime profile "${profile.label}" did not discover a usable target.`);

    if (profile?.targetStopCommand) {
      await assertAllowed(fillRunProfilePlaceholders(profile.targetStopCommand, targetId, runTargetId));
    }
    if (profile?.stopCommand) {
      await assertAllowed(fillRunProfilePlaceholders(profile.stopCommand, targetId, runTargetId));
    }
    if (profile?.healthCommand) {
      await assertAllowed(fillRunProfilePlaceholders(profile.healthCommand, targetId, runTargetId));
    }

    const setupCommand = profile?.setupCommand ? fillRunProfilePlaceholders(profile.setupCommand.trim(), targetId) : undefined;
    if (setupCommand) {
      await assertAllowed(setupCommand);
      system(`Running setup command: ${setupCommand}`);
      const setupExitCode = await runManagedPreflightCommand(setupCommand, cwdInfo.cwd, update);
      if (setupExitCode !== 0) return fail(`Setup command exited with code ${setupExitCode ?? "unknown"}.`);
      system("Setup command completed.");
    }

    let targetReady = false;
    if (profile?.waitCommand) {
      system(`Checking runtime target readiness: ${fillRunProfilePlaceholders(profile.waitCommand, targetId)}`);
      const initialReady = await checkRuntimeTargetReady(profile, targetId, cwdInfo.cwd, update);
      targetReady = initialReady.ready;
      runTargetId = initialReady.runTargetId;
      if (targetReady) system(`Runtime target is already ready${runTargetId ? `: ${runTargetId}` : ""}.`);
    }

    if (profile?.launchCommand && !targetReady) {
      const launchCommand = fillRunProfilePlaceholders(profile.launchCommand, targetId, runTargetId);
      await assertAllowed(launchCommand);
      system(`Launching runtime target: ${launchCommand}`);
      const launched = await executeRuntimeProfileStep(launchCommand, cwdInfo.cwd, 30_000, update);
      if (launched.exitCode !== 0) return fail(`Target launch failed with code ${launched.exitCode ?? "unknown"}.`);
      targetStartedByService = true;
      const current = activeRuntimeServices.get(serviceId);
      if (current) {
        current.service = runtimeServiceSchema.parse({ ...current.service, targetId, targetStartedByService: true });
        activeRuntimeServices.set(serviceId, current);
      }
      system("Runtime target launch command completed.");
    }

    if (profile?.waitCommand && !targetReady) {
      system(`Waiting for runtime target: ${fillRunProfilePlaceholders(profile.waitCommand, targetId)}`);
      let waited = await waitForRuntimeTarget(profile, targetId, cwdInfo.cwd, update);
      if (!waited.ready && (profile.diagnosticCommands.length || profile.recoveryCommands.length)) {
        for (const template of [...profile.diagnosticCommands, ...profile.recoveryCommands]) {
          const command = fillRunProfilePlaceholders(template, targetId, runTargetId);
          await assertAllowed(command);
          system(`Runtime target recovery/check: ${command}`);
          await executeRuntimeProfileStep(command, cwdInfo.cwd, 20_000, update);
        }
        if (profile.retryAfterRecovery) waited = await waitForRuntimeTarget(profile, targetId, cwdInfo.cwd, update);
      }
      if (!waited.ready) return fail(`Runtime target was not ready within ${profile.timeoutSeconds}s.`);
      targetReady = true;
      runTargetId = waited.runTargetId ?? runTargetId;
      system(`Runtime target is ready${runTargetId ? `: ${runTargetId}` : ""}.`);
    }

    const command = fillRunProfilePlaceholders(commandTemplate, targetId, runTargetId);
    await assertAllowed(command);
    service = runtimeServiceSchema.parse({
      ...(activeRuntimeServices.get(serviceId)?.service ?? service),
      command,
      targetId,
      runTargetId: runTargetId ?? targetId,
      targetStartedByService
    });
    service = appendRuntimeLog(service, "system", `Starting app runtime: ${command}`);
    const active = activeRuntimeServices.get(serviceId);
    activeRuntimeServices.set(serviceId, { ...active, service, initiallyOccupiedPorts: active?.initiallyOccupiedPorts ?? initiallyOccupiedPorts });

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
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function stopRuntimeService(projectRoot: string, serviceId: string): Promise<RuntimeService[]> {
  const entry = activeRuntimeServices.get(serviceId);
  if (!entry || normalizeForCompare(entry.service.projectRoot) !== normalizeForCompare(projectRoot)) return listRuntimeServices(projectRoot);
  const profile = entry.service.profileId
    ? (await loadProject(projectRoot)).project.settings.runTargetProfiles.find((item) => item.id === entry.service.profileId)
    : undefined;
  if (profile?.stopCommand) {
    const stopCommand = fillRunProfilePlaceholders(profile.stopCommand, entry.service.targetId, entry.service.runTargetId);
    entry.service = appendRuntimeLog(entry.service, "system", `Stopping with: ${stopCommand}`);
    activeRuntimeServices.set(serviceId, entry);
    await runStopCommand(stopCommand, entry.service.cwd);
  }
  if (entry.child) await terminateChildProcess(entry.child);
  if (entry.service.targetStartedByService && profile?.targetStopCommand) {
    const targetStopCommand = fillRunProfilePlaceholders(profile.targetStopCommand, entry.service.targetId, entry.service.runTargetId);
    entry.service = appendRuntimeLog(entry.service, "system", `Stopping owned runtime target with: ${targetStopCommand}`);
    activeRuntimeServices.set(serviceId, entry);
    await runStopCommand(targetStopCommand, entry.service.cwd);
  }
  entry.service = runtimeServiceSchema.parse({
    ...appendRuntimeLog(entry.service, "system", "Runtime service stopped."),
    status: "stopped",
    targetStartedByService: false,
    stoppedAt: iso()
  });
  entry.child = undefined;
  activeRuntimeServices.set(serviceId, entry);
  return listRuntimeServices(projectRoot);
}

/** Stops every runtime process owned by this ArchiCode process during app shutdown. */
export async function shutdownRuntimeServices(): Promise<void> {
  const ownedServices = [...activeRuntimeServices.values()]
    .filter((entry) => entry.child || entry.service.targetStartedByService)
    .map((entry) => ({ projectRoot: entry.service.projectRoot, serviceId: entry.service.id }));
  await Promise.allSettled(ownedServices.map(({ projectRoot, serviceId }) => stopRuntimeService(projectRoot, serviceId)));
}

export async function restartRuntimeService(projectRoot: string, serviceId: string): Promise<RuntimeService[]> {
  const entry = activeRuntimeServices.get(serviceId);
  if (!entry || normalizeForCompare(entry.service.projectRoot) !== normalizeForCompare(projectRoot)) return listRuntimeServices(projectRoot);
  const { profileId, command, label, relativeCwd, targetId } = entry.service;
  await stopRuntimeService(projectRoot, serviceId);
  return startRuntimeService({ projectRoot, profileId, command: profileId ? undefined : command, label, cwd: relativeCwd, targetId });
}
