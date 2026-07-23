import { describe, expect, it } from "vitest";
import { researchChatSessionSchema, type ResearchChatSession, type ResearchChatMessage } from "../src/shared/schema";
import { researchTaskTiming } from "../src/renderer/src/utils/researchTaskTiming";

function message(id: string, role: ResearchChatMessage["role"], createdAt: string): ResearchChatMessage {
  return {
    id,
    role,
    content: id,
    createdAt,
    attachmentIds: [],
    webUsed: false,
    mcpToolCalls: [],
    subagentRuns: []
  };
}

function session(messages: ResearchChatMessage[]): ResearchChatSession {
  return researchChatSessionSchema.parse({
    id: "chat-1",
    projectRoot: "/project",
    scope: { type: "project", projectId: "project-1" },
    title: "Chat",
    messages,
    createdAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:00:00.000Z"
  });
}

describe("research task timing", () => {
  it("runs from the latest user command while the chat is busy", () => {
    const chat = session([
      message("user-1", "user", "2026-07-22T10:00:00.000Z"),
      message("research-waiting-1", "assistant", "2026-07-22T10:00:01.000Z")
    ]);

    expect(researchTaskTiming(chat, true)).toEqual({
      startedAtMs: Date.parse("2026-07-22T10:00:00.000Z"),
      completedAtMs: null
    });
  });

  it("freezes at the latest persisted continuation after completion", () => {
    const chat = session([
      message("user-1", "user", "2026-07-22T10:00:00.000Z"),
      message("assistant-1", "assistant", "2026-07-22T10:00:20.000Z"),
      message("review-result", "system", "2026-07-22T10:00:35.000Z")
    ]);

    expect(researchTaskTiming(chat, false)).toEqual({
      startedAtMs: Date.parse("2026-07-22T10:00:00.000Z"),
      completedAtMs: Date.parse("2026-07-22T10:00:35.000Z")
    });
  });

  it("resets only when a newer user command becomes the task boundary", () => {
    const chat = session([
      message("user-1", "user", "2026-07-22T10:00:00.000Z"),
      message("assistant-1", "assistant", "2026-07-22T10:00:20.000Z"),
      message("user-2", "user", "2026-07-22T10:01:00.000Z"),
      message("assistant-2", "assistant", "2026-07-22T10:01:08.000Z")
    ]);

    expect(researchTaskTiming(chat, false)).toEqual({
      startedAtMs: Date.parse("2026-07-22T10:01:00.000Z"),
      completedAtMs: Date.parse("2026-07-22T10:01:08.000Z")
    });
  });

  it("does not mistake an optimistic waiting bubble for completion", () => {
    const chat = session([
      message("user-1", "user", "2026-07-22T10:00:00.000Z"),
      message("research-waiting-1", "assistant", "2026-07-22T10:00:01.000Z")
    ]);

    expect(researchTaskTiming(chat, false)).toBeNull();
  });
});
