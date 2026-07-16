import { describe, expect, it } from "vitest";
import { classifyRunFailure, runFailureStatusLabel, runFailureTitle } from "../src/renderer/src/utils/runFailureTaxonomy";
import type { Run } from "../src/shared/schema";

function makeRun(overrides: Partial<Run>): Run {
  return {
    id: "run-failure-taxonomy-test",
    flowId: "flow-main",
    providerId: "codex-local",
    status: "failed",
    phase: "complete",
    effort: "high",
    promptSummary: "Failure taxonomy test",
    permission: { decision: "allowed" },
    env: [],
    mcpToolCalls: [],
    contextArtifacts: [],
    planArtifactIds: [],
    sourceDiffArtifactIds: [],
    affectedNodeIds: [],
    plannedCommands: [],
    plannedAllowedRoots: [],
    reviewDecisions: [],
    todos: [],
    logs: [],
    createdAt: "2026-06-29T08:00:00.000Z",
    ...overrides
  };
}

describe("run failure taxonomy", () => {
  it("classifies invalid coding handoffs as provider failures", () => {
    const run = makeRun({
      logs: [
        {
          at: "2026-06-29T08:01:00.000Z",
          stream: "stderr",
          text: "Provider returned source changes that ArchiCode could not safely use."
        }
      ]
    });

    expect(classifyRunFailure(run)).toEqual({
      family: "provider",
      code: "invalid-source-proposal"
    });
  });

  it("classifies tool schema rejections as harness failures", () => {
    const run = makeRun({
      logs: [
        {
          at: "2026-06-29T08:01:00.000Z",
          stream: "stderr",
          text: "Invalid schema for function 'archicode_project_read_artifact': schema must have type 'object'."
        }
      ]
    });

    expect(classifyRunFailure(run)).toEqual({
      family: "harness",
      code: "tool-schema-invalid"
    });
  });

  it("classifies approval-blocked verification separately from build failures", () => {
    const run = makeRun({
      stoppedAtPhase: "verifying",
      runInstructions: "Verification requires approval or a reusable shell policy before it can continue.",
      mcpToolCalls: [
        {
          id: "tool-call-1",
          serverId: "archicode-internal-tools",
          toolName: "run_command",
          status: "failed",
          resultSummary: JSON.stringify({
            command: "npm run build",
            status: "approval-required",
            message: "Medium/high-risk command requires approval or a reusable shell policy before the built-in console tool can run it."
          }),
          startedAt: "2026-06-29T08:01:00.000Z"
        }
      ]
    });

    const classification = classifyRunFailure(run);
    expect(classification).toEqual({
      family: "environment",
      code: "verification-blocked-approval"
    });
    expect(runFailureStatusLabel(classification!)).toBe("blocked");
    expect(runFailureTitle(classification!)).toBe("Verification blocked");
  });

  it("uses the terminal implementation cause instead of historical MCP approval responses", () => {
    const run = makeRun({
      stoppedAtPhase: "coding",
      runInstructions: "Implementation stopped before all planned source tasks completed. Retry with the latest checkpoint context.",
      implementation: {
        currentBatch: 7,
        maxBatches: 7,
        currentTaskId: "task-5",
        needsMoreWork: false,
        summary: "Functional work is complete; generated cleanup did not apply.",
        checkpoints: [],
        tasks: [{
          id: "task-5",
          title: "Final cleanup and verification",
          status: "doing"
        }]
      },
      mcpToolCalls: [{
        id: "historical-tool-call",
        serverId: "archicode-internal-tools",
        toolName: "run_command",
        status: "succeeded",
        resultSummary: JSON.stringify({
          command: "npm run build 2>&1",
          status: "approval-required",
          message: "Medium/high-risk command requires approval or a reusable shell policy before the built-in console tool can run it."
        }),
        startedAt: "2026-06-29T08:00:00.000Z",
        completedAt: "2026-06-29T08:00:01.000Z"
      }]
    });

    const classification = classifyRunFailure(run);
    expect(classification).toEqual({ family: "provider", code: "implementation-incomplete" });
    expect(runFailureStatusLabel(classification!)).toBe("incomplete");
    expect(runFailureTitle(classification!)).toBe("Implementation incomplete");
  });

  it("classifies missing newly referenced packages as dependency sync failures", () => {
    const run = makeRun({
      logs: [
        {
          at: "2026-06-29T08:01:00.000Z",
          stream: "system",
          text: "Targeted verification failed: npm run test -- --run"
        },
        {
          at: "2026-06-29T08:01:01.000Z",
          stream: "stderr",
          text: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vitest' imported from /project/vitest.config.ts"
        }
      ]
    });

    expect(classifyRunFailure(run)).toEqual({
      family: "dependency",
      code: "dependency-sync-needed"
    });
  });

  it("classifies cross-stack missing modules or restore blockers as dependency sync failures", () => {
    const run = makeRun({
      logs: [
        {
          at: "2026-06-29T08:01:00.000Z",
          stream: "system",
          text: "Verification phase started: pytest"
        },
        {
          at: "2026-06-29T08:01:01.000Z",
          stream: "stderr",
          text: "ModuleNotFoundError: No module named 'fastapi'"
        }
      ]
    });

    expect(classifyRunFailure(run)).toEqual({
      family: "dependency",
      code: "dependency-sync-needed"
    });
  });

  it("classifies non-zero build verification as a build failure when no stronger cause applies", () => {
    const run = makeRun({
      logs: [
        {
          at: "2026-06-29T08:01:00.000Z",
          stream: "system",
          text: "Verification phase started: npm run build"
        },
        {
          at: "2026-06-29T08:01:01.000Z",
          stream: "stderr",
          text: "ERROR: vite build failed"
        },
        {
          at: "2026-06-29T08:01:02.000Z",
          stream: "system",
          text: "Command exited with code 1."
        }
      ]
    });

    expect(classifyRunFailure(run)).toEqual({
      family: "verification",
      code: "build-command-failed"
    });
  });
});
