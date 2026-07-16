import { describe, expect, it } from "vitest";
import { collectRunErrors, runFailureDetails, runFailureMessage } from "../src/renderer/src/utils/runErrors";
import type { Run } from "../src/shared/schema";

function makeRun(overrides: Partial<Run>): Run {
  return {
    id: "run-error-test",
    flowId: "flow-main",
    providerId: "codex-local",
    status: "awaiting-code-review",
    phase: "awaiting-code-review",
    effort: "high",
    promptSummary: "Review generated code",
    permission: { decision: "allowed" },
    env: [],
    mcpToolCalls: [],
    contextArtifacts: [],
    planArtifactIds: [],
    sourceDiffArtifactIds: ["diff-1"],
    affectedNodeIds: [],
    plannedCommands: [],
    plannedAllowedRoots: [],
    reviewDecisions: [],
    todos: [],
    logs: [],
    createdAt: "2026-06-25T12:00:00.000Z",
    ...overrides
  };
}

describe("run error summaries", () => {
  it("does not treat stderr on approval runs as an open error", () => {
    const run = makeRun({
      logs: [
        {
          at: "2026-06-25T12:01:00.000Z",
          stream: "stderr",
          text: "ERROR codex_core::tools::router: blocked by policy"
        }
      ]
    });

    expect(runFailureMessage(run)).toBeNull();
    expect(collectRunErrors([run])).toEqual([]);
  });

  it("still surfaces stderr for failed runs", () => {
    const run = makeRun({
      status: "failed",
      phase: "complete",
      logs: [
        {
          at: "2026-06-25T12:00:59.000Z",
          stream: "system",
          text: "Verification phase started: npm run build"
        },
        {
          at: "2026-06-25T12:01:00.000Z",
          stream: "stderr",
          text: "ERROR: npm run build failed\nstack details"
        },
        {
          at: "2026-06-25T12:01:01.000Z",
          stream: "system",
          text: "Command exited with code 1."
        }
      ]
    });

    expect(runFailureDetails(run)?.title).toBe("Build failed");
    expect(runFailureMessage(run)).toContain("ERROR: npm run build failed");
    expect(runFailureMessage(run)).toContain("Inspect the verification log and changed files");
    expect(collectRunErrors([run])).toHaveLength(1);
  });

  it("classifies provider quota failures separately from verification failures", () => {
    const run = makeRun({
      status: "failed",
      phase: "complete",
      logs: [
        {
          at: "2026-06-25T12:00:59.000Z",
          stream: "system",
          text: "Planning phase started."
        },
        {
          at: "2026-06-25T12:01:00.000Z",
          stream: "stderr",
          text: "OpenAI-compatible Responses provider failed with 429: insufficient_quota"
        }
      ],
      runInstructions: "Provider quota or rate limit blocked planning."
    });

    expect(runFailureDetails(run)?.title).toBe("Provider quota exceeded");
    expect(runFailureMessage(run)).toContain("Check provider billing/quota");
  });

  it("treats a failed run as resolved when a retry descendant succeeds", () => {
    const failed = makeRun({
      id: "run-failed",
      status: "failed",
      phase: "complete",
      logs: [
        {
          at: "2026-06-25T12:01:00.000Z",
          stream: "stderr",
          text: "ERROR: npm run test failed"
        }
      ]
    });
    const succeeded = makeRun({
      id: "run-succeeded",
      status: "succeeded",
      phase: "complete",
      retryOf: failed.id,
      logs: [
        {
          at: "2026-06-25T12:02:00.000Z",
          stream: "system",
          text: "Final handoff: Verification completed with `npm run test`."
        }
      ]
    });

    expect(runFailureMessage(failed, [failed, succeeded])).toBeNull();
    expect(collectRunErrors([failed, succeeded])).toEqual([]);
  });
});
