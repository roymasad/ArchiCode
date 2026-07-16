import { describe, expect, it } from "vitest";
import type { ResearchChatSession } from "../src/shared/schema";
import { canRetryResearchMessage, previousUserResearchMessage } from "../src/renderer/src/utils/researchRetry";

type ResearchMessage = ResearchChatSession["messages"][number];

function message(overrides: Partial<ResearchMessage>): ResearchMessage {
  return {
    id: "msg-test",
    role: "assistant",
    content: "Research provider failed. Check provider settings, API keys, web capability, or rate limits, then try again.",
    createdAt: new Date().toISOString(),
    attachmentIds: [],
    webUsed: false,
    mcpToolCalls: [],
    subagentRuns: [],
    ...overrides
  };
}

describe("research retry helpers", () => {
  it("allows retry for failed assistant sends", () => {
    expect(canRetryResearchMessage(message({
      error: "OpenAI-compatible research provider failed with 429: insufficient_quota"
    }))).toBe(true);
    expect(canRetryResearchMessage(message({
      content: "Codex Local failed. Check that the Codex CLI/app bridge is installed, signed in, and reachable from the Local command setting, then try again.",
      error: "Codex local research provider failed with exit code 1."
    }))).toBe(true);
    expect(canRetryResearchMessage(message({
      error: "src/router is not a readable file."
    }))).toBe(true);
  });

  it("does not show retry for non-assistant or special assistant states", () => {
    expect(canRetryResearchMessage(message({
      role: "user",
      error: "OpenAI-compatible research provider failed with 429: insufficient_quota"
    }))).toBe(false);
    expect(canRetryResearchMessage(message({
      changeSet: {
        id: "changes-1",
        summary: "summary",
        operations: [],
        createdAt: new Date().toISOString()
      }
    }))).toBe(false);
    expect(canRetryResearchMessage(message({
      mcpApprovalRequest: {
        serverIds: ["server-1"],
        serverLabels: ["Server"],
        toolName: "tool",
        providerToolName: "provider_tool",
        originalContent: "content",
        filePaths: []
      }
    }))).toBe(false);
  });

  it("finds the nearest earlier user message for retry", () => {
    const messages: ResearchMessage[] = [
      message({ id: "sys", role: "system", content: "hi" }),
      message({ id: "user-1", role: "user", content: "first" }),
      message({ id: "assistant-1", role: "assistant", content: "reply" }),
      message({ id: "user-2", role: "user", content: "retry me" }),
      message({ id: "assistant-2", role: "assistant", content: "Research provider failed.", error: "429 quota" })
    ];

    expect(previousUserResearchMessage(messages, 4)?.id).toBe("user-2");
    expect(previousUserResearchMessage(messages, 1)).toBeNull();
  });
});
