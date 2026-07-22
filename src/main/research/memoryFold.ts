import { createHash } from "node:crypto";
import type { ProjectBundle, ProjectSettings, ResearchChatMessage, ResearchChatScope, ResearchChatSession, ResearchGoalCheckpointInput, ResearchGoalStartInput, ResearchGraphChangeResult, ResearchMemory, ResearchMemoryDelta, ResearchOrchestration } from "../../shared/schema";
import { researchChatSessionSchema, researchGoalCheckpointInputSchema, researchGoalStartInputSchema, researchGraphChangeSetSchema, researchMemoryDeltaSchema, researchMemorySchema, researchOrchestrationSchema } from "../../shared/schema";
import { extractResearchMemoryDelta } from "../../shared/researchExtraction";
import { researchChangeSetCategory } from "../../shared/researchChangeSetSemantics";
import { callResearchProvider, researchHistoryWindowStart } from "../providers";
import { hydrateProviderForUse } from "../storage/projectStore";
import { id, iso } from "../research";
import { type ResearchChangeSet, normalizeResearchAgentRunNodeIds, normalizeResearchQueueProviders, normalizeResearchSubflowFlowIds } from "./graphOps";

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
  plan: { recentMessageLimit: number; compactionTriggerLimit: number; historyTokenBudget?: number } =
    { recentMessageLimit: RESEARCH_RECENT_MESSAGE_LIMIT, compactionTriggerLimit: RESEARCH_COMPACTION_TRIGGER_LIMIT }
): Promise<ResearchChatSession> {
  // Same batched-eviction window the prompt uses, so every message that has
  // left (or is about to leave) the prompt window is folded into memory. A
  // token-heavy chat can cross that boundary before it crosses the count-based
  // trigger, so calculate the actual window in both cases.
  const recentStart = researchHistoryWindowStart(session.messages, plan.recentMessageLimit, plan.historyTokenBudget);
  if (session.messages.length <= plan.compactionTriggerLimit && recentStart <= 0) return session;
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
export function buildResearchTurnChangeSet(captured: unknown, envelope: unknown, bundle: ProjectBundle): ResearchChangeSet | undefined {
  const source = captured !== undefined ? captured : envelope;
  if (!source || typeof source !== "object") return undefined;
  const validated = researchGraphChangeSetSchema.omit({ id: true, createdAt: true }).safeParse(source);
  if (!validated.success || !validated.data.operations.length) return undefined;
  return {
    ...validated.data,
    operations: normalizeResearchAgentRunNodeIds(
      bundle,
      normalizeResearchQueueProviders(normalizeResearchSubflowFlowIds(validated.data.operations))
    ),
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
    delta.supersedesFactIds.length ||
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
 * Applies an optional semantic memory delta supplied by the model. Observable
 * continuity is folded separately from persisted host events, so omitting this
 * tool is ordinary completion rather than a missing bookkeeping decision.
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

/**
 * Fold host-observed facts into memory without asking the model to perform a
 * bookkeeping tool call. The transcript remains the semantic source; this
 * fold records only facts the host can prove from persisted turn state.
 */
export function applyHostObservedResearchMemory(
  session: ResearchChatSession,
  turn: ResearchMemoryTurnInput
): ResearchChatSession {
  const sourceMessageIds = [turn.userMessage.id, turn.assistantMessage.id];
  const terminalRuns = turn.assistantMessage.subagentRuns.filter((run) =>
    run.status === "completed" || run.status === "failed" || run.status === "blocked" || run.status === "rejected");
  const delta = researchMemoryDeltaSchema.parse({
    summary: session.summary || session.memory.summary,
    runRefs: terminalRuns.map((run) => ({
      runId: run.id,
      title: run.title,
      status: run.status,
      note: run.resultSummary ?? run.error ?? `${run.kind} finished with status ${run.status}.`,
      sourceMessageIds
    })),
    debugFindings: terminalRuns
      .filter((run) => run.status === "failed" || run.status === "blocked")
      .map((run) => ({
        text: `${run.title}: ${run.error ?? run.resultSummary ?? run.status}`,
        sourceMessageIds
      }))
  });
  if (!researchMemoryDeltaHasContent(delta)) return session;
  const memory = applyResearchMemoryDelta(session.memory, delta, iso());
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
    "    \"supersedesFactIds\": string[],",
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
    "All fields inside researchMemoryDelta are optional, but use arrays for collection fields. Do not use raw string arrays except supersedesFactIds. In graphRefs, omit flowId, subflowId, or nodeId when that identifier does not apply; never emit null placeholders.",
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
    "When conclusive new evidence contradicts or makes an existing currentMemory fact obsolete, list that fact's exact id in supersedesFactIds and add the corrected fact. Never keep mutually contradictory facts active.",
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
  const goal = orchestration.goal;
  if (!activeTodos.length && !goal) return "";
  return JSON.stringify({
    goal: goal ? {
      id: goal.id,
      objective: goal.objective,
      successCriteria: goal.successCriteria,
      status: goal.status,
      currentStepId: goal.currentStepId,
      checkpointSummary: goal.checkpointSummary,
      blockers: goal.blockers,
      waitingFor: goal.waitingFor,
      steps: goal.steps.map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status,
        notes: step.notes,
        evidence: step.evidence
      }))
    } : undefined,
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

function uniqueGoalStepId(preferred: string | undefined, index: number, used: Set<string>): string {
  const base = (preferred?.trim() || `step-${index + 1}`)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `step-${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

export function startResearchGoal(
  orchestration: ResearchOrchestration,
  rawInput: ResearchGoalStartInput,
  updatedAt: string
): ResearchOrchestration {
  const input = researchGoalStartInputSchema.parse(rawInput);
  const usedIds = new Set<string>();
  const steps = input.steps.map((step, index) => ({
    id: uniqueGoalStepId(step.id, index, usedIds),
    title: step.title,
    status: index === 0 ? "doing" as const : "open" as const,
    evidence: [],
    createdAt: updatedAt,
    updatedAt
  }));
  return researchOrchestrationSchema.parse({
    ...orchestration,
    goal: {
      id: id("research-goal"),
      objective: input.objective,
      successCriteria: input.successCriteria,
      status: "active",
      steps,
      currentStepId: steps[0]?.id,
      checkpointSummary: input.summary,
      completionEvidence: [],
      blockers: [],
      waitingFor: [],
      createdAt: updatedAt,
      updatedAt
    },
    updatedAt
  });
}

export function checkpointResearchGoal(
  orchestration: ResearchOrchestration,
  rawInput: ResearchGoalCheckpointInput,
  updatedAt: string
): ResearchOrchestration {
  const input = researchGoalCheckpointInputSchema.parse(rawInput);
  const goal = orchestration.goal;
  if (!goal || goal.status === "completed" || goal.status === "cancelled") {
    throw new Error("There is no active durable goal to checkpoint.");
  }
  const updates = new Map(input.stepUpdates.map((update) => [update.id, update]));
  for (const stepId of updates.keys()) {
    if (!goal.steps.some((step) => step.id === stepId)) {
      throw new Error(`Goal step ${stepId} was not found.`);
    }
  }
  const steps = goal.steps.map((step) => {
    const update = updates.get(step.id);
    if (!update) return step;
    return {
      ...step,
      status: update.status,
      notes: update.notes ?? step.notes,
      evidence: [...new Set([...step.evidence, ...update.evidence])],
      updatedAt
    };
  });
  const currentStepId = input.status === "completed" || input.status === "cancelled" || input.currentStepId === null
    ? undefined
    : input.currentStepId ?? goal.currentStepId;
  if (currentStepId && !steps.some((step) => step.id === currentStepId)) {
    throw new Error(`Current goal step ${currentStepId} was not found.`);
  }
  if (input.status === "completed") {
    const unfinished = steps.filter((step) => step.status !== "done" && step.status !== "cancelled");
    if (unfinished.length) {
      throw new Error(`Goal cannot be completed while steps remain unfinished: ${unfinished.map((step) => step.id).join(", ")}.`);
    }
    if (!input.evidence.length && !steps.some((step) => step.evidence.length)) {
      throw new Error("Goal completion requires concrete evidence.");
    }
  }
  if (input.status === "waiting" && !input.waitingFor.length) {
    throw new Error("A waiting goal checkpoint must identify the run, runtime, subagent, or approval event it is waiting for.");
  }
  if (input.status === "waiting" && input.waitingFor.some((reference) => !reference.id)) {
    throw new Error("A waiting goal checkpoint requires the exact id of every external event.");
  }
  if (input.status === "blocked" && !input.blockers.length) {
    throw new Error("A blocked goal checkpoint must include a concrete blocker.");
  }
  const status = input.status === "continue" ? "active" : input.status;
  return researchOrchestrationSchema.parse({
    ...orchestration,
    goal: {
      ...goal,
      status,
      steps,
      currentStepId,
      checkpointSummary: input.summary,
      completionEvidence: input.status === "completed"
        ? [...new Set([...goal.completionEvidence, ...input.evidence])]
        : goal.completionEvidence,
      blockers: input.blockers,
      waitingFor: input.waitingFor,
      updatedAt,
      completedAt: input.status === "completed" ? updatedAt : undefined
    },
    updatedAt
  });
}

export function trackResearchChangeSetTodo(
  orchestration: ResearchOrchestration,
  changeSet: NonNullable<ResearchChatMessage["changeSet"]>,
  messageId: string,
  updatedAt: string
): ResearchOrchestration {
  const existingIndex = orchestration.todos.findIndex((todo) => todo.changeSetId === changeSet.id);
  const category = researchChangeSetCategory(changeSet.operations);
  const operationLabel = category === "queue" ? "queue action" : category === "graph" ? "graph operation" : "review action";
  const todo = {
    ...(existingIndex >= 0 ? orchestration.todos[existingIndex] : {
      id: id("research-todo"),
      createdAt: updatedAt
    }),
    title: changeSet.summary,
    status: "awaiting-approval" as const,
    notes: `${changeSet.operations.length} ${operationLabel}${changeSet.operations.length === 1 ? "" : "s"} waiting for review.`,
    changeSetId: changeSet.id,
    messageId,
    operationIndexes: changeSet.operations.map((_, operationIndex) => operationIndex),
    updatedAt
  };
  const todos = existingIndex >= 0
    ? orchestration.todos.map((item, index) => index === existingIndex ? todo : item)
    : [...orchestration.todos, todo];
  return {
    ...orchestration,
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
    ...orchestration,
    todos: orchestration.todos.map((todo, index) => index === existingIndex
      ? { ...todo, status, notes, updatedAt }
      : todo),
    updatedAt
  };
}

/**
 * Retires every still-unreviewed change-set card in the session except the one being
 * kept, stamping them superseded so only a single card stays actionable. Prevents two
 * live proposals — often re-creating the same node IDs — from both being appliable.
 * Returns the updated messages, an orchestration with the retired todos cancelled, and
 * how many cards were superseded.
 */
export function supersedePriorUnreviewedChangeSets(
  session: ResearchChatSession,
  keepChangeSetId: string,
  at: string
): { messages: ResearchChatMessage[]; orchestration: ResearchOrchestration; supersededCount: number } {
  const supersededChangeSetIds = new Set<string>();
  const messages = session.messages.map((message) => {
    const changeSet = message.changeSet;
    if (!changeSet || changeSet.reviewedAt || changeSet.id === keepChangeSetId) return message;
    supersededChangeSetIds.add(changeSet.id);
    return { ...message, changeSet: { ...changeSet, reviewedAt: at, supersededAt: at } };
  });
  if (!supersededChangeSetIds.size) {
    return { messages: session.messages, orchestration: session.orchestration, supersededCount: 0 };
  }
  const orchestration: ResearchOrchestration = {
    ...session.orchestration,
    todos: session.orchestration.todos.map((todo) =>
      todo.changeSetId && supersededChangeSetIds.has(todo.changeSetId) && todo.status === "awaiting-approval"
        ? { ...todo, status: "cancelled" as const, notes: "Superseded by a newer proposal.", updatedAt: at }
        : todo),
    updatedAt: at
  };
  return { messages, orchestration, supersededCount: supersededChangeSetIds.size };
}

export function applyResearchMemoryDelta(
  memory: ResearchMemory,
  delta: ResearchMemoryDelta,
  updatedAt: string,
  lastCompactedMessageId?: string
): ResearchMemory {
  const supersededFactIds = new Set(delta.supersedesFactIds);
  return researchMemorySchema.parse({
    ...memory,
    summary: mergeMemorySummary(memory.summary, delta.summary),
    decisions: mergeTextMemory(memory.decisions, delta.decisions, "decision", updatedAt, RESEARCH_MEMORY_TEXT_LIMIT),
    todos: mergeTodoMemory(memory.todos, delta.todos, updatedAt, RESEARCH_MEMORY_TEXT_LIMIT),
    openQuestions: mergeQuestionMemory(memory.openQuestions, delta.openQuestions, updatedAt, RESEARCH_MEMORY_TEXT_LIMIT),
    links: mergeLinkMemory(memory.links, delta.links, updatedAt, RESEARCH_MEMORY_LINK_LIMIT),
    facts: mergeTextMemory(memory.facts.filter((fact) => !supersededFactIds.has(fact.id)), delta.facts, "fact", updatedAt, RESEARCH_MEMORY_TEXT_LIMIT),
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
