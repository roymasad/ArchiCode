import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runSchema } from "../../shared/schema";
import type { LlmPhase, LlmUsage, Run, RunPhase } from "../../shared/schema";
import type { ProviderProgressEvent } from "../providers";
import { sumLlmUsage, isAllUsageUnavailable } from "../../shared/llmPricing";
import { isTerminalRunStatus } from "./runEngine";
import { exists, iso, projectStatePath, readJson, readJsonLines, writeJson } from "./persistence";

export const runLogAppendQueues = new Map<string, Promise<void>>();
export let publishRunUpdate: ((projectRoot: string, run: Run) => void) | null = null;
export function setRunUpdatePublisher(publisher: (projectRoot: string, run: Run) => void): void {
  publishRunUpdate = publisher;
}

// Last observed status/phase per run in this process, so writeRun can record
// structured bookkeeping about transitions (e.g. the phase a run stopped in)
// without re-reading the file on every write.
export const lastKnownRunStateByRunId = new Map<string, { status: Run["status"]; phase: RunPhase }>();

export function rememberRunState(run: Run): void {
  lastKnownRunStateByRunId.set(run.id, { status: run.status, phase: run.phase });
}

// The phases each status may legally carry. Status and phase are stored as two
// fields, so nothing structural prevents persisting e.g. succeeded+coding;
// this table is the invariant, enforced on every write.
export const runPhasesByStatus: Record<Run["status"], readonly RunPhase[]> = {
  "preparing": ["planning", "coding"],
  "queued": ["planning", "coding", "debugging", "verifying"],
  "needs-permission": ["planning", "coding", "debugging", "verifying"],
  "running": ["coding", "verifying"],
  "planning": ["planning"],
  "awaiting-plan-review": ["awaiting-plan-review"],
  "coding": ["coding"],
  "awaiting-code-review": ["awaiting-code-review"],
  "debugging": ["debugging"],
  "needs-replan": ["needs-replan"],
  "verifying": ["verifying"],
  "succeeded": ["complete"],
  "failed": ["complete"],
  "cancelled": ["complete"]
};

export class IllegalRunTransitionError extends Error {}

export function assertLegalRunWrite(previous: { status: Run["status"]; phase: RunPhase } | undefined, next: Run): void {
  if (!runPhasesByStatus[next.status].includes(next.phase)) {
    throw new IllegalRunTransitionError(
      `Illegal run state for ${next.id}: status "${next.status}" cannot carry phase "${next.phase}".`
    );
  }
  if (!previous) return;
  if (next.status === "preparing" && previous.status !== "preparing") {
    throw new IllegalRunTransitionError(
      `Illegal run transition for ${next.id}: "${previous.status}" -> "preparing" (runs are only preparing at creation).`
    );
  }
  // A terminal run re-enters only through a retry/resume status (queued,
  // review, or an active phase status) — never straight to running or a
  // different terminal outcome. In particular a cancelled run can never
  // silently flip to succeeded/failed: this centrally closes the
  // check-then-write races the scattered runWasCancelled guards cannot cover.
  const illegalFromTerminal = next.status === "running" || isTerminalRunStatus(next.status);
  if (isTerminalRunStatus(previous.status) && previous.status !== next.status && illegalFromTerminal) {
    throw new IllegalRunTransitionError(
      `Illegal run transition for ${next.id}: "${previous.status}" -> "${next.status}" (terminal runs re-enter only via a retry/resume status).`
    );
  }
}

// Run logs live in an append-only JSONL sidecar next to the run document, so
// streaming output appends a few bytes per chunk instead of rewriting (and
// re-validating) the entire run JSON with its whole log history every time.
// In-memory Run objects still carry full logs: readers hydrate from the
// sidecar, writers persist only the delta.
export function runLogPath(projectRoot: string, runId: string): string {
  return projectStatePath(projectRoot, "runs", `${runId}.log.jsonl`);
}

export type RunLogState = { persistedCount: number; sidecarBytes: number; logs: Run["logs"] };
export const runLogStateByRunId = new Map<string, RunLogState>();
export const runSidecarLocks = new Map<string, Promise<void>>();

// Serializes sidecar append + counter updates per run so two concurrent
// writeRun calls cannot both append the same delta.
export function withRunSidecarLock<T>(runId: string, task: () => Promise<T>): Promise<T> {
  const previous = runSidecarLocks.get(runId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  runSidecarLocks.set(runId, next.then(() => undefined, () => undefined));
  return next;
}

export async function loadRunLogState(projectRoot: string, runId: string, documentLogs: Run["logs"]): Promise<RunLogState> {
  const sidecarPath = runLogPath(projectRoot, runId);
  const sidecarBytes = await stat(sidecarPath).then((info) => info.size).catch(() => 0);
  const cached = runLogStateByRunId.get(runId);
  // The size check keeps a second read-only instance from pinning stale logs
  // while another process (holding the queue lease) appends.
  if (cached && cached.sidecarBytes === sidecarBytes) return cached;
  const sidecar = sidecarBytes ? await readJsonLines<Run["logs"][number]>(sidecarPath) : [];
  // Documents persisted before the sidecar split carry their logs inline; the
  // document wins until the next write migrates it into the sidecar.
  const logs = documentLogs.length > sidecar.length ? documentLogs : sidecar;
  const state: RunLogState = { persistedCount: sidecar.length, sidecarBytes, logs };
  runLogStateByRunId.set(runId, state);
  return state;
}

export async function persistRunLogSidecar(projectRoot: string, run: Run): Promise<void> {
  await withRunSidecarLock(run.id, async () => {
    const state = await loadRunLogState(projectRoot, run.id, []);
    const delta = run.logs.slice(state.persistedCount);
    if (!delta.length) {
      runLogStateByRunId.set(run.id, { ...state, logs: run.logs });
      return;
    }
    const payload = `${delta.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await appendFile(runLogPath(projectRoot, run.id), payload, "utf8");
    runLogStateByRunId.set(run.id, {
      persistedCount: state.persistedCount + delta.length,
      sidecarBytes: state.sidecarBytes + Buffer.byteLength(payload),
      logs: run.logs
    });
  });
}

export async function hydrateRunLogs(projectRoot: string, document: Run): Promise<Run> {
  const logState = await loadRunLogState(projectRoot, document.id, document.logs);
  return logState.logs === document.logs ? document : runSchema.parse({ ...document, logs: logState.logs });
}

export async function readRun(projectRoot: string, runId: string): Promise<Run> {
  const document = runSchema.parse(await readJson(projectStatePath(projectRoot, "runs", `${runId}.json`), null));
  const run = await hydrateRunLogs(projectRoot, document);
  rememberRunState(run);
  return run;
}

export async function writeRun(projectRoot: string, run: Run): Promise<void> {
  let parsed = runSchema.parse(run);
  const previous = lastKnownRunStateByRunId.get(parsed.id);
  assertLegalRunWrite(previous, parsed);
  // Record the phase the run was in when it reached its terminal state so
  // retry/resume logic reads a structured field instead of parsing logs.
  if (parsed.phase === "complete" && !parsed.stoppedAtPhase && previous && previous.phase !== "complete") {
    parsed = runSchema.parse({ ...parsed, stoppedAtPhase: previous.phase });
  }
  rememberRunState(parsed);
  await persistRunLogSidecar(projectRoot, parsed);
  await writeJson(projectStatePath(projectRoot, "runs", `${parsed.id}.json`), { ...parsed, logs: [] });
  publishRunUpdate?.(projectRoot, parsed);
  await resolveRetriedRunFailure(projectRoot, parsed);
}

// Merges one phase's captured LLM usage into a run's aggregated `usage` and
// `usageByPhase` breakdown. Sums within the phase entry and the run total so
// incremental per-call persists stay double-count-free.
export function mergePhaseUsageIntoRun(run: Run, phase: LlmPhase, usages: LlmUsage[]): Run {
  if (!usages.length) return run;
  const phaseTotal = sumLlmUsage(usages);
  const allUnavailable = isAllUsageUnavailable(usages);
  const phaseUsage = phaseTotal ?? (allUnavailable ? usages[0] : undefined);
  if (!phaseUsage) return run;
  const existingByPhase = run.usageByPhase ?? [];
  const existingEntry = existingByPhase.find((entry) => entry.phase === phase);
  const mergedEntry = existingEntry
    ? { phase, usage: sumLlmUsage([existingEntry.usage, phaseUsage]) ?? phaseUsage }
    : { phase, usage: phaseUsage };
  const usageByPhase = existingEntry
    ? existingByPhase.map((entry) => entry.phase === phase ? mergedEntry : entry)
    : [...existingByPhase, mergedEntry];
  const totalUsage = sumLlmUsage([run.usage, phaseUsage]) ?? run.usage;
  return { ...run, usage: totalUsage, usageByPhase };
}

// Reads the latest run from disk, merges the given phase usage, and persists it
// so the run-detail Cost line / radial tooltip update live as the run proceeds.
// Returns the merged run (or undefined if the run could not be read).
export async function persistRunUsage(projectRoot: string, runId: string, phase: LlmPhase, usages: LlmUsage[]): Promise<Run | undefined> {
  if (!usages.length) return undefined;
  const latest = await readRun(projectRoot, runId).catch(() => undefined);
  if (!latest) return undefined;
  const merged = mergePhaseUsageIntoRun(latest, phase, usages);
  if (merged === latest) return latest;
  await writeRun(projectRoot, merged);
  return merged;
}

export async function resolveRetriedRunFailure(projectRoot: string, run: Run): Promise<void> {
  if (run.status !== "succeeded" || !run.retryOf) return;
  const parent = await readRun(projectRoot, run.retryOf).catch(() => null);
  if (!parent || (parent.status !== "failed" && parent.status !== "cancelled") || parent.errorDismissedAt) return;
  const resolved = runSchema.parse({
    ...parent,
    errorDismissedAt: iso(),
    logs: [
      ...parent.logs,
      { at: iso(), stream: "system", text: `Run error resolved by successful follow-up run ${run.id}.` }
    ]
  });
  await writeRun(projectRoot, resolved);
}

export function splitProgressLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function truncateLogText(text: string): string {
  return text.length > 6000 ? `${text.slice(0, 6000)}\n... truncated ...` : text;
}

// Every log append is serialized through a per-run promise chain so concurrent
// writers (stdout/stderr handlers, provider progress loggers, system notes)
// cannot interleave read-modify-write cycles and lose lines.
export function appendRunLogEntries(projectRoot: string, runId: string, entries: Run["logs"]): Promise<Run> {
  const previous = runLogAppendQueues.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      let current: Run | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          current = await readRun(projectRoot, runId);
          break;
        } catch (error) {
          if (!(error instanceof SyntaxError) || attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      if (!current) throw new Error(`Run ${runId} could not be read to append log entries.`);
      const updated = runSchema.parse({ ...current, logs: [...current.logs, ...entries] });
      await writeRun(projectRoot, updated);
      return updated;
    });
  runLogAppendQueues.set(runId, next.then(() => undefined, () => undefined));
  return next;
}

export function queueRunLogAppend(projectRoot: string, runId: string, stream: Run["logs"][number]["stream"], text: string): void {
  const lines = splitProgressLines(text);
  if (!lines.length) return;
  void appendRunLogEntries(projectRoot, runId, lines.map((line) => ({ at: iso(), stream, text: truncateLogText(line) }))).catch(() => undefined);
}

export async function flushRunLogAppends(runId: string): Promise<void> {
  await runLogAppendQueues.get(runId)?.catch(() => undefined);
  runLogAppendQueues.delete(runId);
}

export function createProviderProgressLogger(projectRoot: string, runId: string): (event: ProviderProgressEvent) => void {
  return (event) => queueRunLogAppend(projectRoot, runId, event.stream, event.text);
}

export function publishRunUpdateEvent(projectRoot: string, run: Run): void {
  publishRunUpdate?.(projectRoot, run);
}
