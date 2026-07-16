import type { ResearchChatSession } from "@shared/schema";

export function isOptimisticResearchMessage(message: ResearchChatSession["messages"][number]): boolean {
  return message.id.startsWith("research-user") ||
    message.id.startsWith("research-waiting") ||
    message.id.startsWith("research-summary");
}

function hasResolvedAssistantAfterOptimistic(
  session: ResearchChatSession,
  message: ResearchChatSession["messages"][number]
): boolean {
  if (message.role !== "assistant") return false;
  return session.messages.some((existing) =>
    existing.role === "assistant" &&
    !isOptimisticResearchMessage(existing) &&
    existing.createdAt >= message.createdAt
  );
}

export function mergeResearchSessionsPreservingOptimistic(
  incoming: ResearchChatSession[],
  current: ResearchChatSession[]
): ResearchChatSession[] {
  return incoming.map((session) => {
    const currentSession = current.find((item) => item.id === session.id);
    if (!currentSession) return session;

    const existingIds = new Set(session.messages.map((message) => message.id));
    const optimisticMessages = currentSession.messages.filter((message) => {
      if (!isOptimisticResearchMessage(message) || existingIds.has(message.id)) return false;
      if (message.id.startsWith("research-user")) {
        return !session.messages.some((existing) =>
          existing.role === "user" && existing.content === message.content
        );
      }
      if (hasResolvedAssistantAfterOptimistic(session, message)) return false;
      return true;
    });
    if (!optimisticMessages.length) return session;

    return {
      ...session,
      messages: [...session.messages, ...optimisticMessages],
      updatedAt: currentSession.updatedAt > session.updatedAt ? currentSession.updatedAt : session.updatedAt
    };
  });
}
