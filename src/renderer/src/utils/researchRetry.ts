import type { ResearchChatSession } from "@shared/schema";

type ResearchMessage = ResearchChatSession["messages"][number];

export function previousUserResearchMessage(
  messages: ResearchMessage[],
  assistantIndex: number
): ResearchMessage | null {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return null;
}

export function canRetryResearchMessage(message: ResearchMessage): boolean {
  return message.role === "assistant" &&
    Boolean(message.error) &&
    !message.changeSet &&
    !message.mcpApprovalRequest;
}
