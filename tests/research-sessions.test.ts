import { describe, expect, it } from "vitest";
import type { ResearchChatSession } from "../src/shared/schema";
import { RESEARCH_THINKING_PHRASES } from "../src/shared/researchPersonality";
import { mergeResearchSessionsPreservingOptimistic } from "../src/renderer/src/utils/researchSessions";

function sessionWithMessages(
  id: string,
  updatedAt: string,
  messages: ResearchChatSession["messages"]
): ResearchChatSession {
  return {
    id,
    projectRoot: "C:/project",
    scope: { type: "project", projectId: "project-seed" },
    title: "Chat",
    summary: "",
    memory: {
      summary: "",
      decisions: [],
      todos: [],
      openQuestions: [],
      links: [],
      facts: [],
      assumptions: [],
      graphRefs: [],
      runRefs: [],
      fileRefs: [],
      artifactRefs: [],
      imageRefs: [],
      debugFindings: [],
      updatedAt: ""
    },
    orchestration: { todos: [], updatedAt: "" },
    autoApproveGraphChanges: { enabled: false, includeDestructive: false },
    archived: false,
    messages,
    providerId: "codex-local",
    webEnabled: false,
    createdAt: "2026-07-03T07:00:00.000Z",
    updatedAt
  };
}

describe("research session optimistic merge", () => {
  it("drops a stale thinking bubble once a real assistant reply exists", () => {
    const current = sessionWithMessages("session-1", "2026-07-03T07:00:02.000Z", [
      {
        id: "research-user-1",
        role: "user",
        content: "hi what is this project ?",
        createdAt: "2026-07-03T07:00:00.000Z",
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: []
      },
      {
        id: "research-waiting-1",
        role: "assistant",
        content: RESEARCH_THINKING_PHRASES[0],
        createdAt: "2026-07-03T07:00:01.000Z",
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: []
      }
    ]);
    const incoming = sessionWithMessages("session-1", "2026-07-03T07:00:03.000Z", [
      {
        id: "msg-user-1",
        role: "user",
        content: "hi what is this project ?",
        createdAt: "2026-07-03T07:00:00.000Z",
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: []
      },
      {
        id: "msg-assistant-1",
        role: "assistant",
        content: "This is a small site project.",
        createdAt: "2026-07-03T07:00:02.000Z",
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: []
      }
    ]);

    const merged = mergeResearchSessionsPreservingOptimistic([incoming], [current])[0];

    expect(merged?.messages).toHaveLength(2);
    expect(merged?.messages.some((message) => message.id === "research-waiting-1")).toBe(false);
    expect(merged?.messages.at(-1)?.content).toBe("This is a small site project.");
  });

  it("keeps the optimistic thinking bubble when the backend snapshot is still behind", () => {
    const current = sessionWithMessages("session-1", "2026-07-03T07:00:02.000Z", [
      {
        id: "research-user-1",
        role: "user",
        content: "hi what is this project ?",
        createdAt: "2026-07-03T07:00:00.000Z",
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: []
      },
      {
        id: "research-waiting-1",
        role: "assistant",
        content: RESEARCH_THINKING_PHRASES[0],
        createdAt: "2026-07-03T07:00:01.000Z",
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: []
      }
    ]);
    const incoming = sessionWithMessages("session-1", "2026-07-03T07:00:01.500Z", [
      {
        id: "msg-user-1",
        role: "user",
        content: "hi what is this project ?",
        createdAt: "2026-07-03T07:00:00.000Z",
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: []
      }
    ]);

    const merged = mergeResearchSessionsPreservingOptimistic([incoming], [current])[0];

    expect(merged?.messages.some((message) => message.id === "research-waiting-1")).toBe(true);
  });
});
