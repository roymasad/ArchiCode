import { randomUUID } from "node:crypto";
import type { ResearchChatSession } from "../../shared/schema";
import { cancelResearchChatMessage, sendResearchChatMessage } from "../research";
import {
  appendDetachedResearchResult,
  createDetachedResearchWorkerSession,
  removeDetachedResearchWorkerSession
} from "./chatStore";

export type RealtimeResearchTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type RealtimeResearchDeliverable =
  | "answer"
  | "graph-review"
  | "project-action"
  | "run-app"
  | "implementation"
  | "verification";

export type RealtimeResearchTask = {
  assistantMessageId?: string;
  cancelledAt?: string;
  createdAt: string;
  deliverable: RealtimeResearchDeliverable;
  error?: string;
  label: string;
  projectRoot: string;
  researchSessionId: string;
  resultSummary?: string;
  sourceUserMessageId?: string | null;
  startedAt?: string;
  status: RealtimeResearchTaskStatus;
  taskId: string;
  updatedAt: string;
  reused?: boolean;
};

export type RealtimeResearchTaskEvent = RealtimeResearchTask & {
  activity?: string;
  activityKind?: "parent" | "subagent";
  activityRunId?: string;
  activityStatus?: "running" | "completed" | "blocked" | "failed";
  activityTitle?: string;
};

export type StartRealtimeResearchTaskInput = {
  activeFlowId?: string | null;
  activeSubflowId?: string | null;
  content: string;
  deliverable?: RealtimeResearchDeliverable;
  modelId?: string | null;
  projectRoot: string;
  providerId?: string;
  requestKey?: string;
  researchSessionId: string;
  reuseCompletedWithinMs?: number;
  selectedNodeIds?: string[];
  sourceUserMessageId?: string | null;
};

type RealtimeResearchTaskCallbacks = {
  onEvent: (event: RealtimeResearchTaskEvent) => void;
  onSessionUpdated: (session: ResearchChatSession) => void;
};

const tasks = new Map<string, RealtimeResearchTask>();
const taskRequestKeys = new Map<string, string>();
const sessionQueues = new Map<string, Promise<void>>();
const REALTIME_RESEARCH_INACTIVITY_TIMEOUT_MS = 120_000;
const taskExecutions = new Map<string, {
  callbacks: RealtimeResearchTaskCallbacks;
}>();

function taskDeliverable(input: StartRealtimeResearchTaskInput): RealtimeResearchDeliverable {
  if (
    input.deliverable === "graph-review"
    || input.deliverable === "project-action"
    || input.deliverable === "run-app"
    || input.deliverable === "implementation"
    || input.deliverable === "verification"
    || input.deliverable === "answer"
  ) {
    return input.deliverable;
  }
  return "answer";
}

function taskInstructions(content: string, deliverable: RealtimeResearchDeliverable): string {
  const contract = deliverable === "graph-review"
    ? [
        "DELIVERABLE: graph-review.",
        "This task succeeds only when your final assistant message contains a structured graph changeSet that ArchiCode can render as an actionable review card, or a real approval request needed to continue.",
        "Use archicode_propose_graph_change_set for a bounded graph proposal, or Picasso for graph design that genuinely needs it. A prose description, promise, or statement that a review path was started is not a graph review card.",
        "Do not claim that proposed changes were applied. The user reviews and applies the visible card through ArchiCode."
      ]
    : deliverable === "run-app"
      ? [
          "DELIVERABLE: run-app.",
          "The user means ArchiCode Run App: inspect or launch a configured runtime target so they can interact with the running app.",
          "Do not substitute AI Implement, npm run build, or a Delphi verification audit. If launch was requested, call archicode_project_start_runtime_service for the correct configured target. Do not create a start-run-profile review operation or Activity run. If target selection is genuinely ambiguous, report the available Run App choices and ask which one."
        ]
      : deliverable === "implementation"
        ? [
            "DELIVERABLE: implementation.",
            "The user means AI Implement: queue coding work that changes source files. Use a start-agent-run review operation for the intended graph scope. Do not launch a Run App target or substitute a Delphi audit."
          ]
        : deliverable === "verification"
          ? [
              "DELIVERABLE: verification.",
              "The user explicitly asked for checks, tests, or behavioral inspection. Use Delphi or bounded verification tools as appropriate. Do not describe this as merely launching Run App, and do not queue AI Implement unless a separate requested fix requires it."
            ]
          : deliverable === "project-action"
            ? [
                "DELIVERABLE: project-action.",
                "Use the appropriate Research tools to perform or queue the requested host action. Report only actions or approval requests that actually completed; do not replace execution with a promise."
              ]
            : [
                "DELIVERABLE: answer.",
                "Return a self-contained, evidence-grounded answer. Use tools, retrieval, and subagents when the task requires fresh facts."
              ];
  return [
    "BACKGROUND RESEARCH TASK FROM ARCHI LIVE.",
    "Work as Archi's classical Research reasoning layer. The user continues to interact with the same visible Archi conversation while this detached task runs.",
    "Return one self-contained final result for Archi to publish in that conversation. Use normal Research tools, retrieval, approvals, and subagents when useful.",
    ...contract,
    `Task: ${content.trim()}`
  ].join("\n");
}

function taskActionIntent(deliverable: RealtimeResearchDeliverable): "general" | "run-app" | "implementation" | "verification" {
  if (deliverable === "run-app" || deliverable === "implementation" || deliverable === "verification") return deliverable;
  return "general";
}

function taskLabel(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function normalizedRequestKey(input: StartRealtimeResearchTaskInput, deliverable: RealtimeResearchDeliverable): string {
  return (input.requestKey?.trim() || `${deliverable}:${input.content}`)
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function reusableTask(input: StartRealtimeResearchTaskInput, deliverable: RealtimeResearchDeliverable): RealtimeResearchTask | undefined {
  const requestKey = normalizedRequestKey(input, deliverable);
  const completedWindow = Math.max(0, input.reuseCompletedWithinMs ?? 0);
  return [...tasks.values()]
    .filter((task) => task.projectRoot === input.projectRoot
      && task.researchSessionId === input.researchSessionId
      && task.deliverable === deliverable
      && taskRequestKeys.get(task.taskId) === requestKey)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .find((task) => task.status === "queued"
      || task.status === "running"
      || (task.status === "completed"
        && completedWindow > 0
        && Date.now() - Date.parse(task.updatedAt) <= completedWindow));
}

function latestAssistantAfter(session: ResearchChatSession, messageCount: number) {
  return [...session.messages.slice(messageCount)].reverse().find((message) => message.role === "assistant");
}

function hasPendingApproval(message: ResearchChatSession["messages"][number]): boolean {
  return Boolean(message.mcpApprovalRequest)
    || message.subagentRuns.some((run) => run.status === "awaiting-approval");
}

function timestamp(): string {
  return new Date().toISOString();
}

function publicTask(task: RealtimeResearchTask): RealtimeResearchTask {
  return { ...task };
}

function updateTask(
  taskId: string,
  patch: Partial<RealtimeResearchTask>,
  callbacks: RealtimeResearchTaskCallbacks,
  activity?: string,
  activityMeta: Pick<RealtimeResearchTaskEvent, "activityKind" | "activityRunId" | "activityStatus" | "activityTitle"> = {}
): RealtimeResearchTask {
  const current = tasks.get(taskId);
  if (!current) throw new Error(`Background Research task ${taskId} was not found.`);
  const next = { ...current, ...patch, updatedAt: timestamp() };
  tasks.set(taskId, next);
  callbacks.onEvent({ ...publicTask(next), activity, ...activityMeta });
  return next;
}

function trimFinishedTasks(): void {
  const finished = [...tasks.values()]
    .filter((task) => task.status === "completed" || task.status === "failed" || task.status === "cancelled")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const task of finished.slice(100)) {
    tasks.delete(task.taskId);
    taskRequestKeys.delete(task.taskId);
  }
}

async function runTask(input: StartRealtimeResearchTaskInput, taskId: string, callbacks: RealtimeResearchTaskCallbacks): Promise<void> {
  const execution = taskExecutions.get(taskId);
  if (!execution || tasks.get(taskId)?.status === "cancelled") return;
  const workerSessionId = `research-worker-${taskId}`;
  const deliverable = taskDeliverable(input);
  let worker: ResearchChatSession | null = null;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityReject: ((error: Error) => void) | undefined;
  let inactivityTimedOut = false;
  const inactivityFailure = new Promise<never>((_resolve, reject) => {
    inactivityReject = reject;
  });
  const stopInactivityWatchdog = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
  };
  const noteProgress = () => {
    stopInactivityWatchdog();
    inactivityTimer = setTimeout(() => {
      inactivityTimedOut = true;
      cancelResearchChatMessage(workerSessionId);
      inactivityReject?.(new Error("Background Research stopped after two minutes without provider, tool, or subagent progress."));
    }, REALTIME_RESEARCH_INACTIVITY_TIMEOUT_MS);
  };
  const awaitActiveTurn = <T>(turn: Promise<T>): Promise<T> => Promise.race([turn, inactivityFailure]);
  const progressCallbacks = {
    onActivity: (message: string, status?: "running" | "completed" | "failed") => {
      noteProgress();
      if (tasks.get(taskId)?.status === "cancelled") return;
      if (message) updateTask(taskId, {}, callbacks, message, {
        activityKind: "parent",
        activityStatus: status === "failed" ? "failed" as const : status === "completed" ? "completed" as const : "running" as const
      });
    },
    onSubagentProgress: ({ kind, message, runId, status, title }: {
      kind: string;
      message: string;
      runId: string;
      status?: "running" | "completed" | "blocked" | "failed";
      title?: string;
    }) => {
      noteProgress();
      if (tasks.get(taskId)?.status === "cancelled") return;
      if (message) updateTask(taskId, {}, callbacks, message, {
        activityKind: "subagent",
        activityRunId: runId,
        activityStatus: status ?? "running",
        activityTitle: title || kind
      });
    },
    onToken: () => noteProgress()
  };
  try {
    updateTask(taskId, { startedAt: timestamp(), status: "running" }, callbacks, "Archi's Research model is working in the background.");
    worker = await createDetachedResearchWorkerSession({
      projectRoot: input.projectRoot,
      sourceSessionId: input.researchSessionId,
      workerSessionId
    });
    if (tasks.get(taskId)?.status === "cancelled") return;
    noteProgress();
    let previousMessageCount = worker.messages.length;
    let result = await awaitActiveTurn(sendResearchChatMessage({
      actionIntent: taskActionIntent(deliverable),
      activeFlowId: input.activeFlowId,
      activeSubflowId: input.activeSubflowId,
      content: taskInstructions(input.content, deliverable),
      modelId: input.modelId,
      projectRoot: input.projectRoot,
      providerId: input.providerId,
      selectedNodeIds: input.selectedNodeIds,
      sessionId: workerSessionId,
      ...progressCallbacks
    }));
    if (tasks.get(taskId)?.status === "cancelled") return;
    let finalAssistant = latestAssistantAfter(result, previousMessageCount);
    if (deliverable === "graph-review" && finalAssistant && !finalAssistant.changeSet && !hasPendingApproval(finalAssistant)) {
      worker = result;
      previousMessageCount = worker.messages.length;
      updateTask(taskId, {}, callbacks, "Research is correcting a missing graph review artifact.");
      result = await awaitActiveTurn(sendResearchChatMessage({
        actionIntent: taskActionIntent(deliverable),
        activeFlowId: input.activeFlowId,
        activeSubflowId: input.activeSubflowId,
        content: [
          "REQUIRED GRAPH-REVIEW CORRECTION.",
          "Your prior result did not contain a structured graph changeSet, so ArchiCode cannot render the review card requested by the user.",
          "Continue now and call archicode_propose_graph_change_set with supported operations, or use Picasso if the design is genuinely complex.",
          "Do not return another prose-only promise. If a prerequisite requires approval, return the real approval request instead."
        ].join("\n"),
        modelId: input.modelId,
        projectRoot: input.projectRoot,
        providerId: input.providerId,
        selectedNodeIds: input.selectedNodeIds,
        sessionId: workerSessionId,
        ...progressCallbacks
      }));
      if (tasks.get(taskId)?.status === "cancelled") return;
      finalAssistant = latestAssistantAfter(result, previousMessageCount);
    }
    if (!finalAssistant) throw new Error("The background Research model completed without an assistant result.");
    if (deliverable === "graph-review" && !finalAssistant.changeSet && !hasPendingApproval(finalAssistant)) {
      throw new Error("The background Research model did not produce the required graph review card.");
    }
    const canonical = await appendDetachedResearchResult({
      projectRoot: input.projectRoot,
      sessionId: input.researchSessionId,
      message: finalAssistant,
      summary: result.summary,
      memory: result.memory
    });
    const appended = canonical.messages[canonical.messages.length - 1];
    callbacks.onSessionUpdated(canonical);
    const completionActivity = finalAssistant.changeSet
      ? "Background Research completed and added a graph review card to this chat."
      : hasPendingApproval(finalAssistant)
        ? "Background Research needs approval to continue; the approval card was added to this chat."
        : "Background Research completed and the result was added to this chat.";
    updateTask(taskId, {
      assistantMessageId: appended?.id,
      resultSummary: finalAssistant.content.slice(0, 2_000),
      status: "completed"
    }, callbacks, completionActivity);
  } catch (error) {
    if (tasks.get(taskId)?.status === "cancelled") return;
    const message = inactivityTimedOut
      ? "Background Research stopped after two minutes without provider, tool, or subagent progress. Retry the task or choose another research path."
      : error instanceof Error ? error.message : "Background Research failed.";
    const failureMessage = {
      id: `research-background-error-${taskId}`,
      role: "assistant" as const,
      content: `I couldn't complete that background Research task: ${message}`,
      createdAt: timestamp(),
      attachmentIds: [],
      webUsed: false,
      mcpToolCalls: [],
      subagentRuns: [],
      error: message
    };
    let failureAssistantMessageId: string | undefined;
    try {
      const canonical = await appendDetachedResearchResult({
        projectRoot: input.projectRoot,
        sessionId: input.researchSessionId,
        message: failureMessage
      });
      failureAssistantMessageId = canonical.messages[canonical.messages.length - 1]?.id;
      callbacks.onSessionUpdated(canonical);
    } catch {
      // Preserve the original task failure when the chat itself disappeared.
    }
    updateTask(taskId, { assistantMessageId: failureAssistantMessageId, error: message, status: "failed" }, callbacks, message);
  } finally {
    stopInactivityWatchdog();
    await removeDetachedResearchWorkerSession(input.projectRoot, workerSessionId).catch(() => undefined);
    trimFinishedTasks();
  }
}

export function startRealtimeResearchTask(input: StartRealtimeResearchTaskInput, callbacks: RealtimeResearchTaskCallbacks): RealtimeResearchTask {
  const content = input.content.trim();
  if (!content) throw new Error("Background Research task content cannot be empty.");
  const deliverable = taskDeliverable(input);
  const existing = reusableTask(input, deliverable);
  if (existing) return { ...publicTask(existing), reused: true };
  const taskId = randomUUID();
  const createdAt = timestamp();
  const task: RealtimeResearchTask = {
    createdAt,
    deliverable,
    label: taskLabel(content),
    projectRoot: input.projectRoot,
    researchSessionId: input.researchSessionId,
    sourceUserMessageId: input.sourceUserMessageId,
    status: "queued",
    taskId,
    updatedAt: createdAt
  };
  tasks.set(taskId, task);
  taskRequestKeys.set(taskId, normalizedRequestKey(input, deliverable));
  const execution = { callbacks };
  taskExecutions.set(taskId, execution);
  callbacks.onEvent({ ...task, activity: "Background Research queued." });
  const queueKey = `${input.projectRoot}:${input.researchSessionId}`;
  const previous = sessionQueues.get(queueKey) ?? Promise.resolve();
  const queued = previous.then(() => runTask(input, taskId, callbacks), () => runTask(input, taskId, callbacks));
  const tail = queued.finally(() => {
    if (sessionQueues.get(queueKey) === tail) sessionQueues.delete(queueKey);
    if (taskExecutions.get(taskId) === execution) taskExecutions.delete(taskId);
  });
  sessionQueues.set(queueKey, tail);
  void queued.catch(() => undefined);
  return publicTask(task);
}

export function getRealtimeResearchTask(taskId: string, projectRoot?: string): RealtimeResearchTask {
  const task = tasks.get(taskId);
  if (!task || (projectRoot && task.projectRoot !== projectRoot)) {
    throw new Error(`Background Research task ${taskId} was not found.`);
  }
  return publicTask(task);
}

export function cancelRealtimeResearchTask(input: {
  projectRoot: string;
  researchSessionId: string;
  taskId: string;
}): RealtimeResearchTask {
  const task = tasks.get(input.taskId);
  if (
    !task
    || task.projectRoot !== input.projectRoot
    || task.researchSessionId !== input.researchSessionId
  ) {
    throw new Error(`Background Research task ${input.taskId} was not found in this chat.`);
  }
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    return publicTask(task);
  }
  const execution = taskExecutions.get(task.taskId);
  if (task.status === "running") cancelResearchChatMessage(`research-worker-${task.taskId}`);
  const cancelledAt = timestamp();
  if (!execution) {
    const cancelled = { ...task, cancelledAt, status: "cancelled" as const, updatedAt: cancelledAt };
    tasks.set(task.taskId, cancelled);
    return publicTask(cancelled);
  }
  return updateTask(
    task.taskId,
    { cancelledAt, status: "cancelled" },
    execution.callbacks,
    task.status === "queued"
      ? "Queued background Research task cancelled before it started."
      : "Running background Research task cancelled."
  );
}
