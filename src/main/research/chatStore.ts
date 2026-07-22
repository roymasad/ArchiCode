import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { researchChatScopeSchema, researchChatSessionSchema, subagentRunSchema } from "../../shared/schema";
import type { ResearchChatMessage, ResearchChatScope, ResearchChatSession, SubagentRun, SubagentRunStatus } from "../../shared/schema";
import { loadProject, updateProjectSettings } from "../storage/projectStore";
import { defaultTitleForScope, id, iso } from "../research";
import { supersedePriorUnreviewedChangeSets, trackResearchChangeSetTodo } from "./memoryFold";

export let researchStorageRoot = process.cwd();

export function setResearchStorageRoot(rootPath: string): void {
  researchStorageRoot = rootPath;
}

export type StoredResearchChats = {
  projectRoot: string;
  sessions: ResearchChatSession[];
  /**
   * True when the on-disk store existed but could not be read/parsed, so its
   * contents are unknown. Mutators must refuse to overwrite in this state to
   * avoid turning a transient/corrupt read into permanent data loss.
   */
  loadFailed?: boolean;
};

export function projectKey(projectRoot: string): string {
  return createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 32);
}

export function storagePath(projectRoot: string): string {
  return path.join(researchStorageRoot, "research-chats", `${projectKey(projectRoot)}.json`);
}

export async function deleteResearchProjectState(projectRoot: string): Promise<void> {
  const filePath = storagePath(projectRoot);
  const fileName = path.basename(filePath);
  const storeDir = path.dirname(filePath);
  const removableNames = new Set([fileName, `${fileName}.bak`]);
  await rm(filePath, { force: true }).catch(() => undefined);
  await rm(`${filePath}.bak`, { force: true }).catch(() => undefined);
  const siblingNames = await readdir(storeDir).catch(() => [] as string[]);
  await Promise.all(siblingNames
    .filter((name) => removableNames.has(name) || name.startsWith(`${fileName}.corrupt-`) || name.startsWith(`${fileName}.tmp-`))
    .map((name) => rm(path.join(storeDir, name), { force: true })));
  const key = projectKey(projectRoot);
  projectChatsLocks.delete(key);
  for (const sessionKey of [...researchSessionLocks.keys()]) {
    if (sessionKey.startsWith(`${key}:`)) researchSessionLocks.delete(sessionKey);
  }
}

export type ReadChatsFileResult =
  | { ok: true; sessions: ResearchChatSession[] }
  | { ok: false; missing: boolean };

/**
 * Subagent run ids whose owning operation is currently executing in this
 * process. A persisted "running" run that is not registered here has no live
 * operation behind it (the app was restarted or the owning code path threw),
 * so listing reconciles it to an honest failed state instead of leaving a
 * forever-running card.
 */
const liveSubagentRunIds = new Set<string>();

export function markSubagentRunLive(runId: string): void {
  liveSubagentRunIds.add(runId);
}

export function markSubagentRunSettled(runId: string): void {
  liveSubagentRunIds.delete(runId);
}

const ALLOWED_SUBAGENT_RUN_TRANSITIONS: Record<SubagentRunStatus, ReadonlySet<SubagentRunStatus>> = {
  "awaiting-approval": new Set(["awaiting-approval", "running", "rejected", "failed"]),
  running: new Set(["running", "completed", "blocked", "failed"]),
  completed: new Set(["completed"]),
  blocked: new Set(["blocked"]),
  failed: new Set(["failed"]),
  rejected: new Set(["rejected"])
};

type SubagentRunTransitionPatch = Partial<Omit<SubagentRun, "id" | "kind" | "status" | "createdAt" | "updatedAt">>;

/**
 * The single owner for live Research subagent status transitions. Besides
 * rejecting impossible state changes, it keeps the in-process live registry
 * synchronized with the persisted status used by stale-run reconciliation.
 */
export function transitionSubagentRun(
  run: SubagentRun,
  nextStatus: SubagentRunStatus,
  patch: SubagentRunTransitionPatch = {},
  updatedAt = iso()
): SubagentRun {
  if (!ALLOWED_SUBAGENT_RUN_TRANSITIONS[run.status].has(nextStatus)) {
    throw new Error(`Invalid subagent run transition ${run.status} -> ${nextStatus} for ${run.id}.`);
  }
  const nextRun = subagentRunSchema.parse({ ...run, ...patch, status: nextStatus, updatedAt });
  if (nextStatus === "running") markSubagentRunLive(run.id);
  else markSubagentRunSettled(run.id);
  return nextRun;
}

const STALE_RUNNING_SUBAGENT_ERROR = "This subagent was still marked running after its owning operation ended (app restart or an interrupted approval flow), so no live work exists for it. Its recorded progress and evidence are preserved.";

function reconcileStaleRunningSubagentRuns(session: ResearchChatSession): { session: ResearchChatSession; changed: boolean } {
  let changed = false;
  const messages = session.messages.map((message) => {
    if (!message.subagentRuns.some((run) => run.status === "running" && !liveSubagentRunIds.has(run.id))) return message;
    changed = true;
    return {
      ...message,
      subagentRuns: message.subagentRuns.map((run) => run.status === "running" && !liveSubagentRunIds.has(run.id)
        ? transitionSubagentRun(run, "failed", { error: run.error ?? STALE_RUNNING_SUBAGENT_ERROR })
        : run)
    };
  });
  return changed
    ? { session: researchChatSessionSchema.parse({ ...session, messages, updatedAt: iso() }), changed }
    : { session, changed };
}

/** Persists honest terminal states for impossible "running" subagent cards. */
async function persistReconciledStaleRunningSubagents(projectRoot: string): Promise<void> {
  await withProjectChatsLock(projectRoot, async () => {
    const latest = await readChatsForMutation(projectRoot);
    let changed = false;
    const sessions = latest.sessions.map((session) => {
      const reconciled = reconcileStaleRunningSubagentRuns(session);
      changed = changed || reconciled.changed;
      return reconciled.session;
    });
    if (changed) await writeChats(projectRoot, sessions);
  });
}

const LEGACY_SHERLOCK_SOURCES_FAILURE = "Sherlock completed without a structured sources list.";
const LEGACY_OPTIONAL_MEMORY_DECISION_NOTICE = "The model omitted its optional semantic memory decision. Host-observed subagent status and evidence were preserved without an extra provider repair call.";

/**
 * Older versions treated a missing top-level source index as fatal even after
 * validating that every Sherlock finding had source/reference evidence. That
 * produced a red card beside a parent answer that had legitimately received
 * the dossier. The source index is now recovered from finding evidence, so
 * normalize that one historical false-negative while loading stored chats.
 */
function reconcileLegacySherlockSourceFailures(session: ResearchChatSession): ResearchChatSession {
  let changed = false;
  const messages = session.messages.map((message) => {
    let messageChanged = false;
    const subagentRuns = message.subagentRuns.map((run) => {
      if (run.kind !== "sherlock-research" || run.status !== "failed" || run.error !== LEGACY_SHERLOCK_SOURCES_FAILURE) {
        return run;
      }
      changed = true;
      messageChanged = true;
      const { error: _legacyError, ...rest } = run;
      return {
        ...rest,
        status: "completed" as const,
        resultSummary: "Investigation completed with evidence-backed findings; source references were recovered from the finding evidence."
      };
    });
    return messageChanged ? { ...message, subagentRuns } : message;
  });
  return changed ? { ...session, messages } : session;
}

function reconcileLegacyOptionalMemoryDecisionNotice(session: ResearchChatSession): ResearchChatSession {
  if (session.memory.lastUpdateError !== LEGACY_OPTIONAL_MEMORY_DECISION_NOTICE) return session;
  return {
    ...session,
    memory: {
      ...session.memory,
      lastUpdateError: undefined
    }
  };
}

export async function readChatsFile(projectRoot: string, filePath: string): Promise<ReadChatsFileResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, missing: false };
  }
  try {
    const raw = JSON.parse(text) as StoredResearchChats;
    return {
      ok: true,
      sessions: (raw.sessions ?? []).flatMap((session) => {
        const parsed = researchChatSessionSchema.safeParse({ ...session, projectRoot });
        return parsed.success
          ? [reconcileLegacyOptionalMemoryDecisionNotice(reconcileLegacySherlockSourceFailures(parsed.data))]
          : [];
      })
    };
  } catch {
    return { ok: false, missing: false };
  }
}

/**
 * Reads the research chat store without ever destroying data. On a corrupt
 * primary file the bad bytes are preserved as `<file>.corrupt-<ts>` and the
 * `<file>.bak` copy is tried; if nothing is recoverable, `loadFailed` is set so
 * mutators refuse to overwrite. A missing file is an empty (new) store, not a
 * failure.
 */
export async function readChats(projectRoot: string): Promise<StoredResearchChats> {
  const filePath = storagePath(projectRoot);
  const primary = await readChatsFile(projectRoot, filePath);
  if (primary.ok) return { projectRoot, sessions: primary.sessions };
  if (primary.missing) return { projectRoot, sessions: [] };

  // Primary exists but is unreadable/corrupt: preserve it, then fall back to .bak.
  await preserveCorruptChats(filePath);
  const backup = await readChatsFile(projectRoot, `${filePath}.bak`);
  if (backup.ok) return { projectRoot, sessions: backup.sessions };
  return { projectRoot, sessions: [], loadFailed: true };
}

export async function preserveCorruptChats(filePath: string): Promise<void> {
  try {
    await rename(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch {
    // Best effort: if we cannot move the corrupt file aside, leave it in place.
  }
}

export async function writeChats(projectRoot: string, sessions: ResearchChatSession[]): Promise<void> {
  const filePath = storagePath(projectRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmpPath, `${JSON.stringify({ projectRoot, sessions }, null, 2)}\n`, "utf8");
  // Keep the previous good file as a recovery copy before swapping the new one in.
  try {
    await copyFile(filePath, `${filePath}.bak`);
  } catch {
    // No existing file yet (first write): nothing to back up.
  }
  await rename(tmpPath, filePath);
}

/**
 * Serializes read-modify-write cycles per project so concurrent turns in
 * different chats of the same project cannot clobber each other's writes (the
 * store is a single whole-project file). This is a real mutex, unlike
 * `withSleepBlocked`, which only blocks OS sleep.
 */
export const projectChatsLocks = new Map<string, Promise<unknown>>();

export function withProjectChatsLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = projectKey(projectRoot);
  const prior = projectChatsLocks.get(key) ?? Promise.resolve();
  const run = prior.then(() => fn(), () => fn());
  projectChatsLocks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * Serializes whole read-modify-write *turns* for a single chat session, so two
 * long-running operations on the same session (e.g. a streaming chat turn and a
 * graph-change review, or two chat sends) cannot each persist a stale
 * whole-session snapshot and clobber the other's messages. Distinct sessions run
 * concurrently. This is a finer-grained lock than {@link withProjectChatsLock},
 * which only guards the brief file-write window.
 */
export const researchSessionLocks = new Map<string, Promise<unknown>>();

export function withResearchSessionLock<T>(projectRoot: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${projectKey(projectRoot)}:${sessionId}`;
  const prior = researchSessionLocks.get(key) ?? Promise.resolve();
  const run = prior.then(() => fn(), () => fn());
  researchSessionLocks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * Reads the store for a mutation, throwing rather than proceeding when the
 * on-disk data could not be read, so we never overwrite unknown contents.
 */
export async function readChatsForMutation(projectRoot: string): Promise<StoredResearchChats> {
  const store = await readChats(projectRoot);
  if (store.loadFailed) {
    throw new Error(
      "ArchiCode could not read the research chat store, so it refused to overwrite it and risk losing chats. A recovery copy was preserved next to the store file; restore it or remove the corrupt file, then try again."
    );
  }
  return store;
}

/**
 * Atomically persists a single session: under the per-project lock it re-reads
 * the latest store, replaces (or inserts) just this session, and writes. Other
 * chats' concurrent updates are preserved.
 */
export async function persistResearchSession(projectRoot: string, session: ResearchChatSession): Promise<void> {
  await withProjectChatsLock(projectRoot, async () => {
    const store = await readChatsForMutation(projectRoot);
    const exists = store.sessions.some((item) => item.id === session.id);
    const sessions = exists
      ? store.sessions.map((item) => (item.id === session.id ? session : item))
      : [session, ...store.sessions];
    await writeChats(projectRoot, sessions);
  });
}

export async function listResearchChats(projectRoot: string): Promise<ResearchChatSession[]> {
  const bundle = await loadProject(projectRoot);
  const store = await readChats(projectRoot);
  const reconciled = store.sessions.map((session) => reconcileStaleRunningSubagentRuns(session));
  if (!store.loadFailed && reconciled.some((entry) => entry.changed)) {
    await persistReconciledStaleRunningSubagents(projectRoot).catch(() => undefined);
  }
  return reconciled.map(({ session }) => session)
    .filter((session) => !session.archived)
    .map((session) => researchChatSessionSchema.parse({
      ...session,
      autoApproveGraphChanges: bundle.project.settings.researchAutoApproveGraphChanges
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createResearchChat(input: {
  projectRoot: string;
  scope: ResearchChatScope;
  title?: string;
  providerId?: string;
  modelId?: string;
  filePaths?: string[];
}): Promise<ResearchChatSession> {
  const now = iso();
  const bundle = await loadProject(input.projectRoot);
  const scope = researchChatScopeSchema.parse(input.scope);
  const providerId = input.providerId ?? bundle.project.settings.providers.find((provider) => provider.enabled)?.id;
  const session = researchChatSessionSchema.parse({
    id: id("research"),
    projectRoot: input.projectRoot,
    scope,
    title: input.title?.trim() || defaultTitleForScope(bundle, scope),
    summary: "",
    autoApproveGraphChanges: bundle.project.settings.researchAutoApproveGraphChanges,
    archived: false,
    messages: [],
    providerId,
    modelId: input.modelId?.trim() || undefined,
    webEnabled: bundle.project.settings.webSearch.enabled,
    createdAt: now,
    updatedAt: now
  });
  await withProjectChatsLock(input.projectRoot, async () => {
    const store = await readChatsForMutation(input.projectRoot);
    await writeChats(input.projectRoot, [session, ...store.sessions]);
  });
  return session;
}

/** Branches a new chat from an existing one, carrying messages up to and including `uptoMessageId`. */
export async function forkResearchChat(input: {
  projectRoot: string;
  sessionId: string;
  uptoMessageId: string;
}): Promise<ResearchChatSession> {
  return withProjectChatsLock(input.projectRoot, async () => {
    const store = await readChatsForMutation(input.projectRoot);
    const source = store.sessions.find((item) => item.id === input.sessionId);
    if (!source) throw new Error(`Research chat ${input.sessionId} was not found.`);
    const cutIndex = source.messages.findIndex((message) => message.id === input.uptoMessageId);
    if (cutIndex === -1) throw new Error("Message to fork from was not found.");
    const now = iso();
    const session = researchChatSessionSchema.parse({
      ...source,
      id: id("research"),
      title: `${source.title} (fork)`,
      summary: "",
      orchestration: undefined,
      messages: source.messages.slice(0, cutIndex + 1).map((message) => ({ ...message, id: id("msg") })),
      archived: false,
      createdAt: now,
      updatedAt: now
    });
    await writeChats(input.projectRoot, [session, ...store.sessions]);
    return session;
  });
}

export async function renameResearchChat(projectRoot: string, sessionId: string, title: string): Promise<ResearchChatSession> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("Research chat title cannot be empty.");
  return withProjectChatsLock(projectRoot, async () => {
    const store = await readChatsForMutation(projectRoot);
    let updated: ResearchChatSession | null = null;
    const sessions = store.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      updated = researchChatSessionSchema.parse({ ...session, title: trimmed, updatedAt: iso() });
      return updated;
    });
    if (!updated) throw new Error(`Research chat ${sessionId} was not found.`);
    await writeChats(projectRoot, sessions);
    return updated;
  });
}

export async function archiveResearchChat(projectRoot: string, sessionId: string): Promise<ResearchChatSession> {
  return withProjectChatsLock(projectRoot, async () => {
    const store = await readChatsForMutation(projectRoot);
    let updated: ResearchChatSession | null = null;
    const sessions = store.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      updated = researchChatSessionSchema.parse({ ...session, archived: true, updatedAt: iso() });
      return updated;
    });
    if (!updated) throw new Error(`Research chat ${sessionId} was not found.`);
    await writeChats(projectRoot, sessions);
    return updated;
  });
}

export async function updateResearchChatAutoApproval(input: {
  projectRoot: string;
  sessionId: string;
  autoApproveGraphChanges: ResearchChatSession["autoApproveGraphChanges"];
}): Promise<ResearchChatSession> {
  const bundle = await loadProject(input.projectRoot);
  await updateProjectSettings(input.projectRoot, {
    ...bundle.project.settings,
    researchAutoApproveGraphChanges: input.autoApproveGraphChanges
  });
  return withProjectChatsLock(input.projectRoot, async () => {
    const store = await readChatsForMutation(input.projectRoot);
    let updated: ResearchChatSession | null = null;
    const sessions = store.sessions.map((session) => {
      const nextSession = researchChatSessionSchema.parse({
        ...session,
        autoApproveGraphChanges: input.autoApproveGraphChanges,
        updatedAt: session.id === input.sessionId ? iso() : session.updatedAt
      });
      if (session.id === input.sessionId) updated = nextSession;
      return nextSession;
    });
    if (!updated) throw new Error(`Research chat ${input.sessionId} was not found.`);
    await writeChats(input.projectRoot, sessions);
    return updated;
  });
}

export async function appendResearchChatTranscript(input: {
  projectRoot: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
}): Promise<ResearchChatSession> {
  const text = input.text.trim();
  if (!text) throw new Error("Realtime transcript cannot be empty.");
  return withResearchSessionLock(input.projectRoot, input.sessionId, () =>
    withProjectChatsLock(input.projectRoot, async () => {
      const store = await readChatsForMutation(input.projectRoot);
      let updated: ResearchChatSession | null = null;
      const sessions = store.sessions.map((session) => {
        if (session.id !== input.sessionId) return session;
        const timestamp = iso();
        updated = researchChatSessionSchema.parse({
          ...session,
          messages: [
            ...session.messages,
            {
              id: id("research-live"),
              role: input.role,
              delivery: "realtime",
              content: text,
              createdAt: timestamp,
              attachmentIds: [],
              webUsed: false,
              mcpToolCalls: [],
              subagentRuns: []
            }
          ],
          updatedAt: timestamp
        });
        return updated;
      });
      if (!updated) throw new Error(`Research chat ${input.sessionId} was not found.`);
      await writeChats(input.projectRoot, sessions);
      return updated;
    })
  );
}

export async function createDetachedResearchWorkerSession(input: {
  projectRoot: string;
  sourceSessionId: string;
  workerSessionId: string;
}): Promise<ResearchChatSession> {
  return withProjectChatsLock(input.projectRoot, async () => {
    const store = await readChatsForMutation(input.projectRoot);
    const source = store.sessions.find((session) => session.id === input.sourceSessionId);
    if (!source) throw new Error(`Research chat ${input.sourceSessionId} was not found.`);
    const timestamp = iso();
    const worker = researchChatSessionSchema.parse({
      ...source,
      id: input.workerSessionId,
      title: `${source.title} (background worker)`,
      archived: true,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await writeChats(input.projectRoot, [worker, ...store.sessions.filter((session) => session.id !== worker.id)]);
    return worker;
  });
}

export async function removeDetachedResearchWorkerSession(projectRoot: string, workerSessionId: string): Promise<void> {
  await withProjectChatsLock(projectRoot, async () => {
    const store = await readChatsForMutation(projectRoot);
    await writeChats(projectRoot, store.sessions.filter((session) => session.id !== workerSessionId));
  });
}

export async function appendDetachedResearchResult(input: {
  projectRoot: string;
  sessionId: string;
  message: ResearchChatSession["messages"][number];
  summary?: string;
  memory?: ResearchChatSession["memory"];
}): Promise<ResearchChatSession> {
  return withResearchSessionLock(input.projectRoot, input.sessionId, () =>
    withProjectChatsLock(input.projectRoot, async () => {
      const store = await readChatsForMutation(input.projectRoot);
      let updated: ResearchChatSession | null = null;
      const sessions = store.sessions.map((session) => {
        if (session.id !== input.sessionId) return session;
        const timestamp = iso();
        const message: ResearchChatMessage = {
          ...input.message,
          id: id("research-background"),
          delivery: "background-research" as const,
          createdAt: timestamp
        };
        let priorMessages = session.messages;
        let orchestration = session.orchestration;
        const supersedeMessages: ResearchChatMessage[] = [];
        if (message.changeSet) {
          const superseded = supersedePriorUnreviewedChangeSets(session, message.changeSet.id, timestamp);
          priorMessages = superseded.messages;
          orchestration = trackResearchChangeSetTodo(
            superseded.orchestration,
            message.changeSet,
            message.id,
            timestamp
          );
          if (superseded.supersededCount) {
            supersedeMessages.push({
              id: id("research-background"),
              role: "system",
              delivery: "background-research",
              content: `Superseded ${superseded.supersededCount} earlier graph proposal${superseded.supersededCount === 1 ? "" : "s"} in this chat. Only the latest review card can be applied.`,
              createdAt: timestamp,
              attachmentIds: [],
              webUsed: false,
              mcpToolCalls: [],
              subagentRuns: []
            });
          }
        }
        updated = researchChatSessionSchema.parse({
          ...session,
          summary: input.summary?.trim() || session.summary,
          memory: input.memory ?? session.memory,
          orchestration,
          messages: [...priorMessages, ...supersedeMessages, message],
          updatedAt: timestamp
        });
        return updated;
      });
      if (!updated) throw new Error(`Research chat ${input.sessionId} was not found.`);
      await writeChats(input.projectRoot, sessions);
      return updated;
    })
  );
}
