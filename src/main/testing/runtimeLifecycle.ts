import type { DelphiTestingInput, RuntimeService } from "../../shared/schema";
import { loadProject } from "../storage/projectStore";
import {
  chooseRunTarget,
  discoverRuntimeProfileTargets,
  fillRunProfilePlaceholders,
  assertSafeRuntimeTargetId,
  listRuntimeServices,
  runtimePortsInUse,
  startRuntimeService,
  stopRuntimeService,
  waitForRuntimeServiceReady
} from "../storage/runtimeServices";

export type DelphiRuntimeLaunchPlan = {
  profileId: string;
  profileLabel: string;
  kind: string;
  targetId?: string;
  existingServiceId?: string;
  requiresLaunch: boolean;
  occupiedPorts: number[];
  allowsReportedLocalFallback: boolean;
  commands: string[];
  cleanupCommands: string[];
};

export type DelphiRuntimeLease = {
  plan: DelphiRuntimeLaunchPlan;
  service: RuntimeService;
  startedByDelphi: boolean;
};

function activeServiceMatches(service: RuntimeService, profileId: string, requestedTargetId?: string): boolean {
  if (service.profileId !== profileId || (service.status !== "starting" && service.status !== "running")) return false;
  return !requestedTargetId || service.targetId === requestedTargetId || service.runTargetId === requestedTargetId;
}

export async function planDelphiRuntimeLaunch(projectRoot: string, input: DelphiTestingInput): Promise<DelphiRuntimeLaunchPlan | undefined> {
  const target = input.target;
  if (!target?.profileId || target.launch !== "if-needed") return undefined;
  const bundle = await loadProject(projectRoot);
  const profile = bundle.project.settings.runTargetProfiles.find((item) => item.id === target.profileId);
  if (!profile) throw new Error(`Delphi runtime profile ${target.profileId} was not found.`);
  if (target.cleanup === "stop-if-started" && profile.launchCommand && !profile.targetStopCommand) {
    throw new Error(`Runtime profile "${profile.label}" can launch a target but has no targetStopCommand. Add an owned-target stop command or choose keep-running cleanup before Delphi starts it.`);
  }
  const services = await listRuntimeServices(projectRoot);
  const existing = services.find((service) => activeServiceMatches(service, profile.id, target.deviceId));
  if (existing) {
    return {
      profileId: profile.id,
      profileLabel: profile.label,
      kind: profile.kind,
      targetId: existing.targetId ?? existing.runTargetId ?? target.deviceId,
      existingServiceId: existing.id,
      requiresLaunch: false,
      occupiedPorts: [],
      allowsReportedLocalFallback: false,
      commands: [],
      cleanupCommands: []
    };
  }

  let targetId = assertSafeRuntimeTargetId(target.deviceId ?? profile.defaultTargetId, "Delphi runtime target id");
  if (profile.discoverCommand) {
    const targets = await discoverRuntimeProfileTargets(projectRoot, profile.id);
    const selected = target.deviceId
      ? targets.find((candidate) => candidate.id === target.deviceId) ?? null
      : chooseRunTarget(targets, undefined, profile.defaultTargetId, profile.targetPreferencePattern);
    if (target.deviceId && targets.length && !selected) {
      throw new Error(`Requested target ${target.deviceId} was not found for "${profile.label}". Available targets: ${targets.map((candidate) => `${candidate.label} (${candidate.id})`).join(", ")}.`);
    }
    targetId = assertSafeRuntimeTargetId(selected?.id ?? targetId, "discovered Delphi runtime target id");
  }
  if (profile.targetRequired && !targetId) throw new Error(`Runtime profile "${profile.label}" requires a target, but none was discovered or selected.`);

  const commands = [
    profile.discoverCommand,
    profile.setupCommand,
    profile.launchCommand,
    profile.waitCommand,
    ...profile.diagnosticCommands,
    ...profile.recoveryCommands,
    profile.runCommand,
    profile.healthCommand
  ].filter((command): command is string => Boolean(command?.trim()))
    .map((command) => fillRunProfilePlaceholders(command, targetId));
  const cleanupCommands = [
    profile.stopCommand ? fillRunProfilePlaceholders(profile.stopCommand, targetId) : undefined,
    profile.targetStopCommand
      ? fillRunProfilePlaceholders(profile.targetStopCommand, targetId, "<attached-target-id>")
      : undefined
  ].filter((command): command is string => Boolean(command));
  const occupiedPorts = await runtimePortsInUse(profile.ports ?? []);
  return {
    profileId: profile.id,
    profileLabel: profile.label,
    kind: profile.kind,
    targetId,
    requiresLaunch: true,
    occupiedPorts,
    allowsReportedLocalFallback: occupiedPorts.length > 0 && (profile.kind === "web" || profile.kind === "api"),
    commands,
    cleanupCommands
  };
}

export async function acquireDelphiRuntimeTarget(
  projectRoot: string,
  input: DelphiTestingInput,
  options?: { signal?: AbortSignal; onProgress?: (message: string) => void }
): Promise<DelphiRuntimeLease | undefined> {
  const plan = await planDelphiRuntimeLaunch(projectRoot, input);
  if (!plan) return undefined;
  if (plan.existingServiceId) {
    options?.onProgress?.(`Reusing running target: ${plan.profileLabel}`);
    const service = await waitForRuntimeServiceReady(projectRoot, plan.existingServiceId, { signal: options?.signal });
    return { plan, service, startedByDelphi: false };
  }
  options?.onProgress?.(`Starting target: ${plan.profileLabel}${plan.targetId ? ` (${plan.targetId})` : ""}`);
  const services = await startRuntimeService({
    projectRoot,
    profileId: plan.profileId,
    targetId: plan.targetId
  });
  const started = services.find((service) => activeServiceMatches(service, plan.profileId, plan.targetId));
  if (!started) throw new Error(`Delphi could not find the runtime service after starting "${plan.profileLabel}".`);
  if (started.status === "failed") {
    const detail = started.logs.slice(-10).map((entry) => entry.text.trim()).filter(Boolean).join(" ");
    throw new Error(`Delphi failed to start "${plan.profileLabel}".${detail ? ` ${detail.slice(-3000)}` : ""}`);
  }
  let service: RuntimeService;
  try {
    service = await waitForRuntimeServiceReady(projectRoot, started.id, {
      timeoutMs: Math.max(1_000, (await loadProject(projectRoot)).project.settings.runTargetProfiles.find((item) => item.id === plan.profileId)!.timeoutSeconds * 1000),
      signal: options?.signal
    });
  } catch (error) {
    await stopRuntimeService(projectRoot, started.id).catch(() => undefined);
    throw error;
  }
  options?.onProgress?.(`Target ready: ${service.label}${service.runTargetId ? ` (${service.runTargetId})` : ""}${service.url ? ` at ${service.url}` : ""}`);
  return { plan, service, startedByDelphi: true };
}

export async function releaseDelphiRuntimeTarget(
  projectRoot: string,
  lease: DelphiRuntimeLease | undefined,
  input: DelphiTestingInput,
  onProgress?: (message: string) => void
): Promise<boolean> {
  if (!lease?.startedByDelphi || input.target?.cleanup !== "stop-if-started") return false;
  onProgress?.(`Stopping Delphi-owned target: ${lease.service.label}`);
  await stopRuntimeService(projectRoot, lease.service.id);
  return true;
}
