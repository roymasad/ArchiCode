import type { ResearchChatSession } from "@shared/schema";

export type ResearchTaskTiming = {
  startedAtMs: number;
  completedAtMs: number | null;
};

/**
 * Treat the newest user message as the task boundary. Everything persisted
 * after it (tool continuations, approvals, graph review, and subagent work)
 * still belongs to that task until another user message starts a new one.
 */
export function researchTaskTiming(
  session: ResearchChatSession | null | undefined,
  busy: boolean
): ResearchTaskTiming | null {
  if (!session) return null;

  let userMessageIndex = -1;
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    if (session.messages[index]?.role === "user") {
      userMessageIndex = index;
      break;
    }
  }
  if (userMessageIndex < 0) return null;

  const startedAtMs = Date.parse(session.messages[userMessageIndex]!.createdAt);
  if (!Number.isFinite(startedAtMs)) return null;
  if (busy) return { startedAtMs, completedAtMs: null };

  // `research-waiting-*` is an optimistic placeholder timestamped when work
  // starts, not evidence that the task completed. The final persisted message
  // replaces it with a stable message and completion-time timestamp.
  for (let index = session.messages.length - 1; index > userMessageIndex; index -= 1) {
    const message = session.messages[index]!;
    if (message.id.startsWith("research-waiting")) continue;
    const completedAtMs = Date.parse(message.createdAt);
    if (Number.isFinite(completedAtMs)) {
      return { startedAtMs, completedAtMs: Math.max(startedAtMs, completedAtMs) };
    }
  }

  return null;
}
