import { createHash } from "node:crypto";
import type { ProjectSettings, ResearchChatMessage, ResearchChatScope, ResearchChatSession, ResearchGraphChangeResult, ResearchMemory, ResearchMemoryDelta, ResearchOrchestration } from "../../shared/schema";
import { researchChatSessionSchema, researchGraphChangeSetSchema, researchMemoryDeltaSchema, researchMemorySchema } from "../../shared/schema";
import { extractResearchMemoryDelta } from "../../shared/researchExtraction";
import { callResearchProvider } from "../providers";
import { hydrateProviderForUse } from "../storage/projectStore";
import { id, iso } from "../research";
import { type ResearchChangeSet, normalizeResearchQueueProviders, normalizeResearchSubflowFlowIds } from "./graphOps";

export type ResearchProvider = ProjectSettings["providers"][number];

export type ResearchMemoryTurnInput = {
  userMessage: ResearchChatMessage;
  assistantMessage: ResearchChatMessage;
};

export function withCurrentTurnTodoSources(delta: ResearchMemoryDelta, turn: ResearchMemoryTurnInput): ResearchMemoryDelta {
  const turnSourceIds = [turn.userMessage.id, turn.assistantMessage.id].filter(Boolean);
  if (!turnSourceIds.length || !delta.todos.length) return delta;
  return {
    ...delta,
    todos: delta.todos.map((todo) => ({
      ...todo,
      sourceMessageIds: mergeSources(todo.sourceMessageIds, turnSourceIds)
    }))
  };
}

export const RESEARCH_RECENT_MESSAGE_LIMIT = 64;
export const RESEARCH_COMPACTION_TRIGGER_LIMIT = 80;
export const RESEARCH_MEMORY_TEXT_LIMIT = 50;
export const RESEARCH_MEMORY_LINK_LIMIT = 80;
export const RESEARCH_MEMORY_REF_LIMIT = 40;
export const RESEARCH_MEMORY_SUMMARY_CHAR_LIMIT = 6000;
export const RESEARCH_ORCHESTRATION_TODO_LIMIT = 32;

export async function compactResearchMemoryIfNeeded(
  projectRoot: string,
  provider: ResearchProvider,
  session: ResearchChatSession,
  plan = { recentMessageLimit: RESEARCH_RECENT_MESSAGE_LIMIT, compactionTriggerLimit: RESEARCH_COMPACTION_TRIGGER_LIMIT }
): Promise<ResearchChatSession> {
  if (session.messages.length <= plan.compactionTriggerLimit) return session;
  const recentStart = Math.max(0, session.messages.length - plan.recentMessageLimit);
  if (recentStart <= 0) return session;
  const lastOmitted = session.messages[recentStart - 1];
  if (!lastOmitted || session.memory.lastCompactedMessageId === lastOmitted.id) return session;
  const previousCompactedIndex = session.memory.lastCompactedMessageId
    ? session.messages.findIndex((message) => message.id === session.memory.lastCompactedMessageId)
    : -1;
  const messagesToCompact = session.messages.slice(Math.max(0, previousCompactedIndex + 1), recentStart);
  if (!messagesToCompact.length) return session;

  try {
    const delta = await requestResearchMemoryDelta(provider, session, {
      mode: "compact",
      messagesToCompact,
      lastCompactedMessageId: session.memory.lastCompactedMessageId
    });
    const memory = applyResearchMemoryDelta(session.memory, delta, iso(), lastOmitted.id);
    return researchChatSessionSchema.parse({
      ...session,
      memory,
      summary: memory.summary || session.summary,
      updatedAt: iso()
    });
  } catch (error) {
    return researchChatSessionSchema.parse({
      ...session,
      memory: researchMemorySchema.parse({
        ...session.memory,
        lastUpdateError: error instanceof Error ? error.message : String(error),
        updatedAt: iso()
      })
    });
  }
}

/**
 * Builds the reviewable change set for a turn, preferring a change set captured
 * from the native propose_graph_change_set tool call and falling back to one
 * parsed from a legacy text envelope (codex/offline). Malformed or empty change
 * sets are dropped so the prose answer is still delivered.
 */
export function buildResearchTurnChangeSet(captured: unknown, envelope: unknown): ResearchChangeSet | undefined {
  const source = captured !== undefined ? captured : envelope;
  if (!source || typeof source !== "object") return undefined;
  const validated = researchGraphChangeSetSchema.omit({ id: true, createdAt: true }).safeParse(source);
  if (!validated.success || !validated.data.operations.length) return undefined;
  return {
    ...validated.data,
    operations: normalizeResearchQueueProviders(normalizeResearchSubflowFlowIds(validated.data.operations)),
    id: id("changes"),
    createdAt: iso()
  };
}

export function unwrapCapturedMemoryDelta(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "researchMemoryDelta" in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).researchMemoryDelta;
  }
  return raw;
}

export function researchMemoryDeltaHasContent(delta: ResearchMemoryDelta): boolean {
  return Boolean(
    delta.summary?.trim() ||
    delta.decisions.length ||
    delta.todos.length ||
    delta.openQuestions.length ||
    delta.links.length ||
    delta.facts.length ||
    delta.assumptions.length ||
    delta.graphRefs.length ||
    delta.runRefs.length ||
    delta.fileRefs.length ||
    delta.artifactRefs.length ||
    delta.imageRefs.length ||
    delta.debugFindings.length
  );
}

/**
 * Applies memory only when the model explicitly calls update_memory. Omitting
 * the tool is the model's structured decision that this turn has no durable
 * state worth carrying forward; the harness never infers or synthesizes one.
 */
export function applyResearchTurnMemory(
  session: ResearchChatSession,
  capturedMemoryDelta: unknown,
  turn: ResearchMemoryTurnInput
): ResearchChatSession {
  if (capturedMemoryDelta === undefined) return session;
  const extracted = extractResearchMemoryDelta(JSON.stringify({
    researchMemoryDelta: unwrapCapturedMemoryDelta(capturedMemoryDelta)
  }));
  if (!extracted.delta) {
    return researchChatSessionSchema.parse({
      ...session,
      memory: researchMemorySchema.parse({
        ...session.memory,
        lastUpdateError: `Memory tool arguments failed validation: ${extracted.errors.join(" | ") || "invalid memory delta"}`,
        updatedAt: iso()
      }),
      updatedAt: iso()
    });
  }
  if (!researchMemoryDeltaHasContent(extracted.delta)) return session;
  const memory = applyResearchMemoryDelta(session.memory, withCurrentTurnTodoSources(extracted.delta, turn), iso());
  return researchChatSessionSchema.parse({
    ...session,
    memory,
    summary: memory.summary || session.summary,
    updatedAt: iso()
  });
}

export async function requestResearchMemoryDelta(
  provider: ResearchProvider,
  session: ResearchChatSession,
  input: Record<string, unknown>
): Promise<ResearchMemoryDelta> {
  const memoryDeltaJsonContract = [
    "Research memory delta JSON contract:",
    "Return exactly one JSON object, preferably in a fenced ```json block, with this top-level shape: { \"researchMemoryDelta\": { ... } }.",
    "Do not return the bare delta object with summary, facts, or decisions at the top level; those fields belong inside researchMemoryDelta.",
    "researchMemoryDelta schema:",
    "{",
    "  \"researchMemoryDelta\": {",
    "    \"summary\": string,",
    "    \"decisions\": [{ \"text\": string, \"sourceMessageIds\": string[] }],",
    "    \"todos\": [{ \"title\": string, \"status\": \"open\" | \"awaiting-approval\" | \"doing\" | \"blocked\" | \"done\" | \"cancelled\", \"notes\": string, \"sourceMessageIds\": string[] }],",
    "    \"openQuestions\": [{ \"question\": string, \"status\": \"open\" | \"answered\" | \"resolved\", \"answer\": string, \"sourceMessageIds\": string[] }],",
    "    \"links\": [{ \"url\": string, \"title\": string, \"note\": string, \"sourceMessageIds\": string[] }],",
    "    \"facts\": [{ \"text\": string, \"sourceMessageIds\": string[] }],",
    "    \"assumptions\": [{ \"text\": string, \"sourceMessageIds\": string[] }],",
    "    \"graphRefs\": [{ \"kind\": \"project\" | \"flow\" | \"subflow\" | \"node\", \"flowId\": string, \"subflowId\": string, \"nodeId\": string, \"title\": string, \"note\": string, \"sourceMessageIds\": string[] }],",
    "    \"runRefs\": [{ \"runId\": string, \"title\": string, \"status\": string, \"note\": string, \"sourceMessageIds\": string[] }],",
    "    \"fileRefs\": [{ \"path\": string, \"title\": string, \"note\": string, \"sourceMessageIds\": string[] }],",
    "    \"artifactRefs\": [{ \"artifactId\": string, \"type\": string, \"title\": string, \"path\": string, \"note\": string, \"sourceMessageIds\": string[] }],",
    "    \"imageRefs\": [{ \"artifactId\": string, \"title\": string, \"mediaType\": string, \"visualSummary\": string, \"extractedText\": string, \"relevantFindings\": string[], \"sourceMessageIds\": string[] }],",
    "    \"debugFindings\": [{ \"text\": string, \"sourceMessageIds\": string[] }]",
    "  }",
    "}",
    "All fields inside researchMemoryDelta are optional, but use arrays for collection fields. Do not use raw string arrays. In graphRefs, omit flowId, subflowId, or nodeId when that identifier does not apply; never emit null placeholders.",
    "Valid memory update example:",
    "{",
    "  \"researchMemoryDelta\": {",
    "    \"summary\": \"The user asked about onboarding and Archi recommended treating the onboarding route as the first implementation focus.\",",
    "    \"decisions\": [{ \"text\": \"Prioritize the onboarding route first.\", \"sourceMessageIds\": [\"msg-user\", \"msg-assistant\"] }],",
    "    \"fileRefs\": [{ \"path\": \"src/routes/onboarding.tsx\", \"note\": \"Defines the onboarding route.\" }]",
    "  }",
    "}"
  ].join("\n");
  const prompt = [
    "Update ArchiCode Research chat memory only.",
    "Return only a JSON object shaped as { \"researchMemoryDelta\": { ... } }.",
    memoryDeltaJsonContract,
    "Capture durable decisions, todos, open questions, links, facts, assumptions, graph/run/file/artifact/image references, and debug findings.",
    "When project files, artifacts, screenshots, or images were read or inspected, capture concise durable findings plus fileRefs, artifactRefs, or imageRefs; do not copy raw file dumps or image data into memory.",
    "The researchMemoryDelta.summary field is the long-term compass for future research turns: write concise cumulative meeting notes about what has been discussed so far, ordered chronologically where useful.",
    "When writing summary, preserve important existing currentMemory.summary content and revise it with new durable information, including what the user asked or directed, what Archi answered or clarified, decisions/current direction, unresolved questions, and next likely focus.",
    "Do not write a raw chat log, generic capability blurb, greeting, acknowledgement, transient explanation, or context-only tangent.",
    "Use todo status \"awaiting-approval\" when the next step is blocked on the user reviewing or approving a proposed graph change.",
    "Do not propose graph changes, queue runs, answer the user, use web search, or include prose outside JSON.",
    "Keep entries concise and preserve sourceMessageIds when available."
  ].join(" ");
  const output = await callResearchProvider(await hydrateProviderForUse(provider), prompt, {
    webSearchEnabled: false,
    scopeContext: JSON.stringify({
      scope: session.scope,
      currentMemory: session.memory,
      legacySummary: session.summary,
      ...input
    }, null, 2),
    sessionSummary: session.summary,
    researchMemory: formatResearchMemoryForPrompt(session.memory),
    researchOrchestration: formatResearchOrchestrationForPrompt(session.orchestration),
    messages: [],
    imageAttachments: [],
    selectedSkillsPrompt: "",
    mcpTools: [],
    mcpServers: []
  });
  const extracted = extractResearchMemoryDelta(output);
  if (!extracted.delta) {
    throw new Error(`Research memory update did not return a valid memory delta.${extracted.errors.length ? ` ${extracted.errors.slice(0, 3).join("; ")}` : ""}`);
  }
  return researchMemoryDeltaSchema.parse(extracted.delta);
}

export function formatResearchMemoryForPrompt(memory: ResearchMemory): string {
  return JSON.stringify({
    summary: memory.summary,
    decisions: memory.decisions,
    todos: memory.todos.filter((todo) => todo.status !== "done" && todo.status !== "cancelled"),
    openQuestions: memory.openQuestions.filter((question) => question.status === "open"),
    links: memory.links,
    facts: memory.facts,
    assumptions: memory.assumptions,
    graphRefs: memory.graphRefs,
    runRefs: memory.runRefs,
    fileRefs: memory.fileRefs,
    artifactRefs: memory.artifactRefs,
    imageRefs: memory.imageRefs,
    debugFindings: memory.debugFindings,
    lastCompactedMessageId: memory.lastCompactedMessageId,
    lastUpdateError: memory.lastUpdateError
  }, null, 2);
}

export function formatResearchOrchestrationForPrompt(orchestration: ResearchOrchestration): string {
  const activeTodos = orchestration.todos.filter((todo) => todo.status !== "done" && todo.status !== "cancelled");
  if (!activeTodos.length) return "";
  return JSON.stringify({
    todos: activeTodos.map((todo) => ({
      title: todo.title,
      status: todo.status,
      notes: todo.notes,
      changeSetId: todo.changeSetId,
      messageId: todo.messageId,
      operationIndexes: todo.operationIndexes
    })),
    updatedAt: orchestration.updatedAt
  }, null, 2);
}

export function trackResearchChangeSetTodo(
  orchestration: ResearchOrchestration,
  changeSet: NonNullable<ResearchChatMessage["changeSet"]>,
  messageId: string,
  updatedAt: string
): ResearchOrchestration {
  const existingIndex = orchestration.todos.findIndex((todo) => todo.changeSetId === changeSet.id);
  const todo = {
    ...(existingIndex >= 0 ? orchestration.todos[existingIndex] : {
      id: id("research-todo"),
      createdAt: updatedAt
    }),
    title: changeSet.summary,
    status: "awaiting-approval" as const,
    notes: `${changeSet.operations.length} graph operation${changeSet.operations.length === 1 ? "" : "s"} waiting for review.`,
    changeSetId: changeSet.id,
    messageId,
    operationIndexes: changeSet.operations.map((_, operationIndex) => operationIndex),
    updatedAt
  };
  const todos = existingIndex >= 0
    ? orchestration.todos.map((item, index) => index === existingIndex ? todo : item)
    : [...orchestration.todos, todo];
  return {
    todos: todos.slice(-RESEARCH_ORCHESTRATION_TODO_LIMIT),
    updatedAt
  };
}

export function reviewResearchChangeSetTodo(
  orchestration: ResearchOrchestration,
  changeSet: NonNullable<ResearchChatMessage["changeSet"]>,
  results: ResearchGraphChangeResult[],
  updatedAt: string
): ResearchOrchestration {
  const existingIndex = orchestration.todos.findIndex((todo) => todo.changeSetId === changeSet.id);
  if (existingIndex < 0) return orchestration;
  const applied = results.filter((result) => result.status === "applied").length;
  const rejected = results.filter((result) => result.status === "rejected").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const status = failed ? "blocked" : applied ? "done" : "cancelled";
  const notes = `${applied} applied, ${rejected} rejected, ${failed} failed.`;
  return {
    todos: orchestration.todos.map((todo, index) => index === existingIndex
      ? { ...todo, status, notes, updatedAt }
      : todo),
    updatedAt
  };
}

export function applyResearchMemoryDelta(
  memory: ResearchMemory,
  delta: ResearchMemoryDelta,
  updatedAt: string,
  lastCompactedMessageId?: string
): ResearchMemory {
  return researchMemorySchema.parse({
    ...memory,
    summary: mergeMemorySummary(memory.summary, delta.summary),
    decisions: mergeTextMemory(memory.decisions, delta.decisions, "decision", updatedAt, RESEARCH_MEMORY_TEXT_LIMIT),
    todos: mergeTodoMemory(memory.todos, delta.todos, updatedAt, RESEARCH_MEMORY_TEXT_LIMIT),
    openQuestions: mergeQuestionMemory(memory.openQuestions, delta.openQuestions, updatedAt, RESEARCH_MEMORY_TEXT_LIMIT),
    links: mergeLinkMemory(memory.links, delta.links, updatedAt, RESEARCH_MEMORY_LINK_LIMIT),
    facts: mergeTextMemory(memory.facts, delta.facts, "fact", updatedAt, RESEARCH_MEMORY_TEXT_LIMIT),
    assumptions: mergeTextMemory(memory.assumptions, delta.assumptions, "assumption", updatedAt, RESEARCH_MEMORY_TEXT_LIMIT),
    graphRefs: mergeGraphRefMemory(memory.graphRefs, delta.graphRefs, updatedAt, RESEARCH_MEMORY_REF_LIMIT),
    runRefs: mergeRunRefMemory(memory.runRefs, delta.runRefs, updatedAt, RESEARCH_MEMORY_REF_LIMIT),
    fileRefs: mergeFileRefMemory(memory.fileRefs, delta.fileRefs, updatedAt, RESEARCH_MEMORY_REF_LIMIT),
    artifactRefs: mergeArtifactRefMemory(memory.artifactRefs, delta.artifactRefs, updatedAt, RESEARCH_MEMORY_REF_LIMIT),
    imageRefs: mergeImageRefMemory(memory.imageRefs, delta.imageRefs, updatedAt, RESEARCH_MEMORY_REF_LIMIT),
    debugFindings: mergeTextMemory(memory.debugFindings, delta.debugFindings, "debug", updatedAt, RESEARCH_MEMORY_REF_LIMIT),
    lastCompactedMessageId: lastCompactedMessageId ?? memory.lastCompactedMessageId,
    lastUpdateError: undefined,
    updatedAt
  });
}

export function compactMemorySummary(summary: string): string {
  return summary.trim().replace(/\s+\n/g, "\n").slice(0, RESEARCH_MEMORY_SUMMARY_CHAR_LIMIT);
}

export function mergeMemorySummary(existing: string, incoming?: string): string {
  const previous = compactMemorySummary(existing);
  const next = compactMemorySummary(incoming ?? "");
  if (!next) return previous;
  if (!previous) return next;

  const previousKey = normalizedKey(previous);
  const nextKey = normalizedKey(next);
  if (nextKey.includes(previousKey.slice(0, Math.min(previousKey.length, 160)))) return next;
  if (previousKey.includes(nextKey)) return previous;

  return compactMemorySummary(`${previous}\n${next}`);
}

export function normalizedKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function stableMemoryId(prefix: string, ...parts: Array<string | undefined>): string {
  const source = parts.filter(Boolean).join("|") || prefix;
  return `${prefix}-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}

export function mergeSources(left: string[] = [], right: string[] = []): string[] {
  return [...new Set([...left, ...right].filter(Boolean))];
}

export type TextMemoryRecord = ResearchMemory["facts"][number];
export type DeltaTextMemoryRecord = ResearchMemoryDelta["facts"][number];

export function mergeTextMemory(
  existing: TextMemoryRecord[],
  incoming: DeltaTextMemoryRecord[],
  prefix: string,
  updatedAt: string,
  limit: number
): TextMemoryRecord[] {
  const byKey = new Map<string, TextMemoryRecord>();
  for (const record of existing) byKey.set(record.id || normalizedKey(record.text), record);
  for (const item of incoming) {
    const text = item.text?.trim();
    if (!text) continue;
    const idValue = item.id?.trim() || stableMemoryId(prefix, text);
    const textKey = normalizedKey(text);
    const existingEntry = byKey.get(idValue) ?? [...byKey.values()].find((record) => normalizedKey(record.text) === textKey);
    byKey.set(existingEntry?.id ?? idValue, {
      id: existingEntry?.id ?? idValue,
      text,
      sourceMessageIds: mergeSources(existingEntry?.sourceMessageIds, item.sourceMessageIds),
      createdAt: existingEntry?.createdAt ?? item.createdAt ?? updatedAt,
      updatedAt
    });
  }
  return [...byKey.values()].slice(-limit);
}

export function mergeTodoMemory(
  existing: ResearchMemory["todos"],
  incoming: ResearchMemoryDelta["todos"],
  updatedAt: string,
  limit: number
): ResearchMemory["todos"] {
  const byKey = new Map(existing.map((todo) => [todo.id, todo]));
  for (const item of incoming) {
    const title = item.title?.trim();
    if (!title) continue;
    const idValue = item.id?.trim() || stableMemoryId("todo", title);
    const existingEntry = byKey.get(idValue) ?? [...byKey.values()].find((todo) => normalizedKey(todo.title) === normalizedKey(title));
    byKey.set(existingEntry?.id ?? idValue, {
      id: existingEntry?.id ?? idValue,
      title,
      status: item.status ?? existingEntry?.status ?? "open",
      notes: item.notes ?? existingEntry?.notes,
      sourceMessageIds: mergeSources(existingEntry?.sourceMessageIds, item.sourceMessageIds),
      createdAt: existingEntry?.createdAt ?? item.createdAt ?? updatedAt,
      updatedAt
    });
  }
  return [...byKey.values()].slice(-limit);
}

export function mergeQuestionMemory(
  existing: ResearchMemory["openQuestions"],
  incoming: ResearchMemoryDelta["openQuestions"],
  updatedAt: string,
  limit: number
): ResearchMemory["openQuestions"] {
  const byKey = new Map(existing.map((question) => [question.id, question]));
  for (const item of incoming) {
    const question = item.question?.trim();
    if (!question) continue;
    const idValue = item.id?.trim() || stableMemoryId("question", question);
    const existingEntry = byKey.get(idValue) ?? [...byKey.values()].find((entry) => normalizedKey(entry.question) === normalizedKey(question));
    byKey.set(existingEntry?.id ?? idValue, {
      id: existingEntry?.id ?? idValue,
      question,
      status: item.status ?? existingEntry?.status ?? "open",
      answer: item.answer ?? existingEntry?.answer,
      sourceMessageIds: mergeSources(existingEntry?.sourceMessageIds, item.sourceMessageIds),
      createdAt: existingEntry?.createdAt ?? item.createdAt ?? updatedAt,
      updatedAt
    });
  }
  return [...byKey.values()].slice(-limit);
}

export function mergeLinkMemory(
  existing: ResearchMemory["links"],
  incoming: ResearchMemoryDelta["links"],
  updatedAt: string,
  limit: number
): ResearchMemory["links"] {
  const byKey = new Map(existing.map((link) => [normalizedKey(link.url), link]));
  for (const item of incoming) {
    const url = item.url?.trim();
    if (!url) continue;
    const key = normalizedKey(url);
    const existingEntry = byKey.get(key);
    byKey.set(key, {
      id: existingEntry?.id ?? item.id?.trim() ?? stableMemoryId("link", url),
      url,
      title: item.title ?? existingEntry?.title,
      note: item.note ?? existingEntry?.note,
      sourceMessageIds: mergeSources(existingEntry?.sourceMessageIds, item.sourceMessageIds),
      createdAt: existingEntry?.createdAt ?? item.createdAt ?? updatedAt,
      updatedAt
    });
  }
  return [...byKey.values()].slice(-limit);
}

export function mergeGraphRefMemory(
  existing: ResearchMemory["graphRefs"],
  incoming: ResearchMemoryDelta["graphRefs"],
  updatedAt: string,
  limit: number
): ResearchMemory["graphRefs"] {
  const refKey = (ref: { kind: string; flowId?: string; subflowId?: string; nodeId?: string }) => [ref.kind, ref.flowId, ref.subflowId, ref.nodeId].filter(Boolean).join(":");
  const byKey = new Map(existing.map((ref) => [ref.id || refKey(ref), ref]));
  for (const item of incoming) {
    const keySource = refKey(item);
    if (!keySource) continue;
    const idValue = item.id?.trim() || stableMemoryId("graph", keySource);
    const existingEntry = byKey.get(idValue) ?? [...byKey.values()].find((ref) => refKey(ref) === keySource);
    byKey.set(existingEntry?.id ?? idValue, {
      id: existingEntry?.id ?? idValue,
      kind: item.kind,
      flowId: item.flowId,
      subflowId: item.subflowId,
      nodeId: item.nodeId,
      title: item.title ?? existingEntry?.title,
      note: item.note ?? existingEntry?.note,
      sourceMessageIds: mergeSources(existingEntry?.sourceMessageIds, item.sourceMessageIds),
      createdAt: existingEntry?.createdAt ?? item.createdAt ?? updatedAt,
      updatedAt
    });
  }
  return [...byKey.values()].slice(-limit);
}

export function mergeRunRefMemory(
  existing: ResearchMemory["runRefs"],
  incoming: ResearchMemoryDelta["runRefs"],
  updatedAt: string,
  limit: number
): ResearchMemory["runRefs"] {
  const byKey = new Map(existing.map((ref) => [ref.runId, ref]));
  for (const item of incoming) {
    const runId = item.runId?.trim();
    if (!runId) continue;
    const existingEntry = byKey.get(runId);
    byKey.set(runId, {
      id: existingEntry?.id ?? item.id?.trim() ?? stableMemoryId("run", runId),
      runId,
      title: item.title ?? existingEntry?.title,
      status: item.status ?? existingEntry?.status,
      note: item.note ?? existingEntry?.note,
      sourceMessageIds: mergeSources(existingEntry?.sourceMessageIds, item.sourceMessageIds),
      createdAt: existingEntry?.createdAt ?? item.createdAt ?? updatedAt,
      updatedAt
    });
  }
  return [...byKey.values()].slice(-limit);
}

export function mergeFileRefMemory(
  existing: ResearchMemory["fileRefs"],
  incoming: ResearchMemoryDelta["fileRefs"],
  updatedAt: string,
  limit: number
): ResearchMemory["fileRefs"] {
  const byKey = new Map(existing.map((ref) => [normalizedKey(ref.path), ref]));
  for (const item of incoming) {
    const filePath = item.path?.trim();
    if (!filePath) continue;
    const key = normalizedKey(filePath);
    const existingEntry = byKey.get(key);
    byKey.set(key, {
      id: existingEntry?.id ?? item.id?.trim() ?? stableMemoryId("file", filePath),
      path: filePath,
      title: item.title ?? existingEntry?.title,
      note: item.note ?? existingEntry?.note,
      sourceMessageIds: mergeSources(existingEntry?.sourceMessageIds, item.sourceMessageIds),
      createdAt: existingEntry?.createdAt ?? item.createdAt ?? updatedAt,
      updatedAt
    });
  }
  return [...byKey.values()].slice(-limit);
}

export function mergeArtifactRefMemory(
  existing: ResearchMemory["artifactRefs"],
  incoming: ResearchMemoryDelta["artifactRefs"],
  updatedAt: string,
  limit: number
): ResearchMemory["artifactRefs"] {
  const byKey = new Map(existing.map((ref) => [ref.artifactId, ref]));
  for (const item of incoming) {
    const artifactId = item.artifactId?.trim();
    if (!artifactId) continue;
    const existingEntry = byKey.get(artifactId);
    byKey.set(artifactId, {
      id: existingEntry?.id ?? item.id?.trim() ?? stableMemoryId("artifact", artifactId),
      artifactId,
      type: item.type ?? existingEntry?.type,
      title: item.title ?? existingEntry?.title,
      path: item.path ?? existingEntry?.path,
      note: item.note ?? existingEntry?.note,
      sourceMessageIds: mergeSources(existingEntry?.sourceMessageIds, item.sourceMessageIds),
      createdAt: existingEntry?.createdAt ?? item.createdAt ?? updatedAt,
      updatedAt
    });
  }
  return [...byKey.values()].slice(-limit);
}

export function mergeImageRefMemory(
  existing: ResearchMemory["imageRefs"],
  incoming: ResearchMemoryDelta["imageRefs"],
  updatedAt: string,
  limit: number
): ResearchMemory["imageRefs"] {
  const byKey = new Map(existing.map((ref) => [ref.artifactId, ref]));
  for (const item of incoming) {
    const artifactId = item.artifactId?.trim();
    if (!artifactId) continue;
    const existingEntry = byKey.get(artifactId);
    byKey.set(artifactId, {
      id: existingEntry?.id ?? item.id?.trim() ?? stableMemoryId("image", artifactId),
      artifactId,
      title: item.title ?? existingEntry?.title,
      mediaType: item.mediaType ?? existingEntry?.mediaType,
      visualSummary: item.visualSummary ?? existingEntry?.visualSummary,
      extractedText: item.extractedText ?? existingEntry?.extractedText,
      relevantFindings: mergeSources(existingEntry?.relevantFindings, item.relevantFindings),
      sourceMessageIds: mergeSources(existingEntry?.sourceMessageIds, item.sourceMessageIds),
      createdAt: existingEntry?.createdAt ?? item.createdAt ?? updatedAt,
      updatedAt
    });
  }
  return [...byKey.values()].slice(-limit);
}
