import { describe, expect, it } from "vitest";
import { researchChatSessionSchema, researchMemoryDeltaSchema, researchMemorySchema, researchOrchestrationSchema } from "../src/shared/schema";
import {
  applyResearchMemoryDelta,
  checkpointResearchGoal,
  formatResearchOrchestrationForPrompt,
  startResearchGoal,
  supersedePriorUnreviewedChangeSets,
  trackResearchChangeSetTodo
} from "../src/main/research/memoryFold";
import {
  RESEARCH_MEMORY_TOOL,
  researchSinkTools
} from "../src/main/research/inspectionTools";

describe("durable research goals", () => {
  const started = () => startResearchGoal(researchOrchestrationSchema.parse({}), {
    objective: "Build, run, and verify the requested feature",
    successCriteria: ["The build succeeds", "The live target is verified"],
    steps: [
      { id: "build", title: "Build the project" },
      { id: "verify", title: "Verify the live target" }
    ]
  }, "2026-07-18T00:00:00.000Z");

  it("persists an active goal with stable executable steps", () => {
    const orchestration = started();
    expect(orchestration.goal?.status).toBe("active");
    expect(orchestration.goal?.currentStepId).toBe("build");
    expect(orchestration.goal?.steps.map((step) => step.status)).toEqual(["doing", "open"]);
    expect(formatResearchOrchestrationForPrompt(orchestration)).toContain("The live target is verified");
  });

  it("refuses unsupported completion and accepts evidence-backed completion", () => {
    const orchestration = started();
    expect(() => checkpointResearchGoal(orchestration, {
      status: "completed",
      summary: "Done",
      stepUpdates: [],
      evidence: ["build passed"]
    }, "2026-07-18T00:01:00.000Z")).toThrow(/unfinished/);

    const completed = checkpointResearchGoal(orchestration, {
      status: "completed",
      summary: "Build and live verification passed",
      currentStepId: null,
      stepUpdates: [
        { id: "build", status: "done", evidence: ["npm run build exited 0"] },
        { id: "verify", status: "done", evidence: ["Delphi captured the expected page"] }
      ],
      evidence: ["Build exit 0", "Delphi visual evidence"]
    }, "2026-07-18T00:02:00.000Z");
    expect(completed.goal?.status).toBe("completed");
    expect(completed.goal?.completionEvidence).toHaveLength(2);
  });

  it("requires an exact external reference before waiting", () => {
    expect(() => checkpointResearchGoal(started(), {
      status: "waiting",
      summary: "Waiting for the implementation run",
      stepUpdates: [{ id: "build", status: "waiting" }],
      waitingFor: []
    }, "2026-07-18T00:03:00.000Z")).toThrow(/must identify/);
  });

  it("preserves a durable goal while tracking approval-card work", () => {
    const orchestration = started();
    const tracked = trackResearchChangeSetTodo(orchestration, {
      id: "change-1",
      summary: "Start the build target",
      operations: [],
      createdAt: "2026-07-18T00:00:00.000Z"
    }, "message-1", "2026-07-18T00:04:00.000Z");
    expect(tracked.goal?.id).toBe(orchestration.goal?.id);
    expect(tracked.todos[0]?.status).toBe("awaiting-approval");
  });

  it("keeps durable goal bookkeeping out of the provider tool surface", () => {
    const names = researchSinkTools().map((tool) => tool.providerToolName);
    expect(names).toContain(RESEARCH_MEMORY_TOOL);
    expect(names).not.toContain("archicode_start_goal");
    expect(names).not.toContain("archicode_checkpoint_goal");
    expect(names).not.toContain("archicode_leave_memory_unchanged");
  });

  it("supersedes stale durable facts when conclusive evidence replaces them", () => {
    const memory = researchMemorySchema.parse({
      facts: [{ id: "fact-old-port", text: "The live site uses port 5173.", sourceMessageIds: ["old"], createdAt: "2026-07-18T00:00:00.000Z" }]
    });
    const updated = applyResearchMemoryDelta(memory, researchMemoryDeltaSchema.parse({
      supersedesFactIds: ["fact-old-port"],
      facts: [{ text: "The live site is available on the runtime service URL and may use a dynamically selected port.", sourceMessageIds: ["new"] }]
    }), "2026-07-18T00:05:00.000Z");

    expect(updated.facts).toHaveLength(1);
    expect(updated.facts[0]?.text).toContain("dynamically selected port");
  });

  it("retires prior unreviewed change-set cards when a newer proposal arrives", () => {
    const message = (msgId: string, changeSetId: string, reviewedAt?: string) => ({
      id: msgId,
      role: "assistant" as const,
      content: "proposal",
      createdAt: "2026-07-21T00:00:00.000Z",
      attachmentIds: [],
      webUsed: false,
      mcpToolCalls: [],
      subagentRuns: [],
      changeSet: {
        id: changeSetId,
        summary: `Change ${changeSetId}`,
        operations: [],
        createdAt: "2026-07-21T00:00:00.000Z",
        ...(reviewedAt ? { reviewedAt } : {})
      }
    });
    const session = researchChatSessionSchema.parse({
      id: "session-1",
      projectRoot: "/tmp/project",
      scope: { type: "project", projectId: "project-1" },
      title: "chat",
      memory: researchMemorySchema.parse({}),
      orchestration: trackResearchChangeSetTodo(
        trackResearchChangeSetTodo(researchOrchestrationSchema.parse({}), {
          id: "change-old", summary: "Old", operations: [], createdAt: "2026-07-21T00:00:00.000Z"
        }, "msg-old", "2026-07-21T00:00:00.000Z"),
        { id: "change-new", summary: "New", operations: [], createdAt: "2026-07-21T00:01:00.000Z" },
        "msg-new", "2026-07-21T00:01:00.000Z"
      ),
      autoApproveGraphChanges: { enabled: false, includeDestructive: false },
      messages: [
        message("msg-reviewed", "change-reviewed", "2026-07-21T00:00:30.000Z"),
        message("msg-old", "change-old"),
        message("msg-new", "change-new")
      ],
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:01:00.000Z"
    });

    const result = supersedePriorUnreviewedChangeSets(session, "change-new", "2026-07-21T00:02:00.000Z");
    expect(result.supersededCount).toBe(1);
    const byChangeSet = Object.fromEntries(result.messages.map((item) => [item.changeSet?.id, item.changeSet]));
    // The prior unreviewed card is retired...
    expect(byChangeSet["change-old"]?.supersededAt).toBe("2026-07-21T00:02:00.000Z");
    expect(byChangeSet["change-old"]?.reviewedAt).toBe("2026-07-21T00:02:00.000Z");
    // ...the kept card and an already-reviewed card are untouched.
    expect(byChangeSet["change-new"]?.supersededAt).toBeUndefined();
    expect(byChangeSet["change-reviewed"]?.supersededAt).toBeUndefined();
    expect(byChangeSet["change-reviewed"]?.reviewedAt).toBe("2026-07-21T00:00:30.000Z");
    // The retired card's orchestration todo is cancelled; the kept card's stays live.
    const oldTodo = result.orchestration.todos.find((todo) => todo.changeSetId === "change-old");
    const newTodo = result.orchestration.todos.find((todo) => todo.changeSetId === "change-new");
    expect(oldTodo?.status).toBe("cancelled");
    expect(newTodo?.status).toBe("awaiting-approval");
  });

  it("no-ops when there is no prior unreviewed card to supersede", () => {
    const session = researchChatSessionSchema.parse({
      id: "session-2",
      projectRoot: "/tmp/project",
      scope: { type: "project", projectId: "project-1" },
      title: "chat",
      memory: researchMemorySchema.parse({}),
      orchestration: researchOrchestrationSchema.parse({}),
      autoApproveGraphChanges: { enabled: false, includeDestructive: false },
      messages: [],
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z"
    });
    const result = supersedePriorUnreviewedChangeSets(session, "change-new", "2026-07-21T00:02:00.000Z");
    expect(result.supersededCount).toBe(0);
    expect(result.messages).toBe(session.messages);
    expect(result.orchestration).toBe(session.orchestration);
  });
});
