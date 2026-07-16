import { describe, expect, it } from "vitest";
import { displayPlanText, runPlanText, runProgressItems, runTraceGroups } from "../src/renderer/src/utils/runProgress";
import { runStageItems } from "../src/renderer/src/utils/runStages";
import { verificationOutcome } from "../src/renderer/src/utils/runStatus";
import type { Run } from "../src/shared/schema";

function makeRun(logs: Run["logs"], overrides: Partial<Run> = {}): Run {
  return {
    id: "run-trace-test",
    flowId: "flow-main",
    providerId: "codex-local",
    status: "running",
    phase: "coding",
    effort: "high",
    promptSummary: "Trace test",
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
    logs,
    createdAt: "2026-06-25T12:00:00.000Z",
    ...overrides
  };
}

describe("run progress trace summaries", () => {
  it("drops generic provider lifecycle noise from compact trace items", () => {
    const run = makeRun([
      { at: "2026-06-25T12:00:01.000Z", stream: "stdout", text: JSON.stringify({ type: "item.started" }) },
      { at: "2026-06-25T12:00:02.000Z", stream: "stdout", text: JSON.stringify({ type: "item.completed" }) },
      { at: "2026-06-25T12:00:03.000Z", stream: "stdout", text: "Source diff artifact: .archicode/artifacts/run-source-diff.patch" }
    ]);

    const items = runProgressItems(run, 10);

    expect(items).toHaveLength(1);
    expect(items[0]?.label).toContain("Source diff artifact");
  });

  it("turns command execution provider events into useful trace rows", () => {
    const run = makeRun([
      {
        at: "2026-06-25T12:00:01.000Z",
        stream: "stdout",
        text: JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "npm run build",
            status: "failed",
            exit_code: 1,
            aggregated_output: "vite build failed"
          }
        })
      }
    ]);

    const [item] = runProgressItems(run, 10);

    expect(item?.label).toBe("Command");
    expect(item?.detail).toContain("npm run build");
    expect(item?.detail).toContain("vite build failed");
  });

  it("keeps compact progress row ids unique for same-timestamp command events", () => {
    const command = "/bin/zsh -lc \"node -e \\\"JSON.parse(require('fs').readFileSync('package.json','utf8'))\\\"\"";
    const run = makeRun([
      {
        at: "2026-06-25T12:00:01.000Z",
        stream: "stdout",
        text: JSON.stringify({
          type: "item.started",
          item: {
            type: "command_execution",
            command
          }
        })
      },
      {
        at: "2026-06-25T12:00:01.000Z",
        stream: "stdout",
        text: JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            command
          }
        })
      }
    ]);

    const items = runProgressItems(run, 10);
    const ids = new Set(items.map((item) => item.id));

    expect(items).toHaveLength(2);
    expect(ids.size).toBe(items.length);
  });

  it("drops split provider JSON fragments instead of rendering raw blobs", () => {
    const run = makeRun([
      {
        at: "2026-06-25T12:00:01.000Z",
        stream: "stdout",
        text: "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_7\",\"type\":\"command_execution\",\"command\":\"/bin/zsh -lc \\\"sed -n '1,220p'"
      },
      {
        at: "2026-06-25T12:00:02.000Z",
        stream: "stdout",
        text: " .archicode/runs/run-test.json\\\"\",\"aggregated_output\":\"{\\n  \\\"id\\\": \\\"run-test\\\""
      }
    ]);

    expect(runProgressItems(run, 10)).toEqual([]);
  });

  it("reassembles split provider JSON fragments into one trace group", () => {
    const run = makeRun([
      {
        at: "2026-06-25T12:00:01.000Z",
        stream: "stdout",
        text: "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"command\":\"npm run build\","
      },
      {
        at: "2026-06-25T12:00:01.400Z",
        stream: "stdout",
        text: "\"status\":\"failed\",\"exit_code\":1,\"aggregated_output\":\"vite build failed\"}}"
      }
    ]);

    const [group] = runTraceGroups(run, 10);

    expect(group?.label).toBe("Command");
    expect(group?.detail).toContain("npm run build");
    expect(group?.detail).toContain("vite build failed");
    expect(group?.lineCount).toBe(2);
    expect(group?.collapsible).toBe(true);
  });

  it("collapses adjacent multiline provider output into one trace group", () => {
    const run = makeRun([
      {
        at: "2026-06-25T12:00:01.000Z",
        stream: "stdout",
        text: "src/App.tsx"
      },
      {
        at: "2026-06-25T12:00:01.200Z",
        stream: "stdout",
        text: "src/routes.ts"
      },
      {
        at: "2026-06-25T12:00:01.350Z",
        stream: "stdout",
        text: "package.json"
      }
    ]);

    const [group] = runTraceGroups(run, 10);

    expect(group?.label).toBe("Provider output");
    expect(group?.lineCount).toBe(3);
    expect(group?.raw).toContain("src/routes.ts");
    expect(group?.collapsible).toBe(true);
  });

  it("turns tool lifecycle logs into one expandable file-listing entry", () => {
    const run = makeRun([
      { at: "2026-06-25T12:00:01.000Z", stream: "system", text: "ArchiCode tool started: ArchiCode Tools / list_files" },
      { at: "2026-06-25T12:00:02.000Z", stream: "system", text: "ArchiCode tool succeeded: ArchiCode Tools / list_files" }
    ], {
      mcpToolCalls: [{
        id: "tool-list",
        serverId: "archicode-internal-tools",
        serverLabel: "ArchiCode Tools",
        toolName: "list_files",
        argumentsJson: JSON.stringify({ directory: "src", recursive: true }),
        status: "succeeded",
        resultSummary: JSON.stringify({ directory: "src", files: [{ path: "src/App.tsx" }, { path: "src/main.ts" }], omitted: 3 }),
        startedAt: "2026-06-25T12:00:01.000Z",
        completedAt: "2026-06-25T12:00:02.000Z"
      }]
    });

    const groups = runTraceGroups(run, 10);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("List Files");
    expect(groups[0]?.detail).toContain("src");
    expect(groups[0]?.detail).toContain("2 entries");
    expect(groups[0]?.detail).toContain("3 omitted");
    expect(groups[0]?.collapsible).toBe(true);
    expect(groups[0]?.raw).toContain("Request");
    expect(groups[0]?.raw).toContain("src/App.tsx");
  });

  it("shows the file and line range for expandable read-file entries", () => {
    const run = makeRun([], {
      mcpToolCalls: [{
        id: "tool-read",
        serverId: "archicode-internal-tools",
        serverLabel: "ArchiCode Tools",
        toolName: "read_file",
        argumentsJson: JSON.stringify({ path: "src/main/storage.ts", startLine: 1969, endLine: 2020 }),
        status: "succeeded",
        resultSummary: JSON.stringify({ path: "src/main/storage.ts", totalLines: 12000, text: "async function updateRunNodeOutcome(...)" }),
        startedAt: "2026-06-25T12:00:01.000Z",
        completedAt: "2026-06-25T12:00:02.000Z"
      }]
    });

    const [group] = runTraceGroups(run, 10);

    expect(group?.label).toBe("Read File");
    expect(group?.detail).toContain("src/main/storage.ts");
    expect(group?.detail).toContain("lines 1969-2020");
    expect(group?.detail).toContain("12000 lines");
    expect(group?.raw).toContain("Result preview");
  });

  it("uses the latest verification command exit when retry logs include an older failure", () => {
    const run = makeRun([
      { at: "2026-06-25T12:00:01.000Z", stream: "system", text: "Command exited with code 1." },
      { at: "2026-06-25T12:00:02.000Z", stream: "system", text: "Automatic debug pass 1/6 continuing in this run after verification failure." },
      { at: "2026-06-25T12:00:03.000Z", stream: "system", text: "Command exited with code 0." }
    ]);

    expect(verificationOutcome(run)).toBe("passed");
  });

  it("shows the summary from fenced plan JSON instead of the raw payload", () => {
    const text = [
      "```json",
      JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          summary: "Add renderer test infrastructure and route coverage.",
          runSummary: {
            notes: "This longer internal handoff can stay in the plan artifact."
          }
        }
      }),
      "```"
    ].join("\n");

    expect(displayPlanText(text)).toBe("Add renderer test infrastructure and route coverage.");
  });

  it("prefers the generated plan summary over the original prompt for completed runs", () => {
    const run = makeRun([
      {
        at: "2026-06-25T12:00:01.000Z",
        stream: "system",
        text: "```json\n{\"archicodePatch\":{\"summary\":\"Internal planner summary.\"}}\n```"
      },
      {
        at: "2026-06-25T12:00:02.000Z",
        stream: "system",
        text: "Final handoff: Verification completed with `npm run build`. Run completed without detected verification failures."
      }
    ], {
      status: "succeeded",
      phase: "complete",
      promptSummary: "Implement the Contact Us and Portfolio pages.",
      runInstructions: "Verification completed with `npm run build`. Run completed without detected verification failures.",
      planArtifactIds: ["plan-1"]
    });

    expect(runPlanText(run, [{
      id: "plan-1",
      title: "Plan",
      summary: "Internal planner summary.",
      promptSummary: "Implement the Contact Us and Portfolio pages.",
      providerSummary: "Internal planner summary.",
      planOutputAt: "2026-06-25T12:00:01.000Z"
    }])).toBe(
      "Internal planner summary."
    );
  });

  it("does not replace the plan line with final handoff verification text after completion", () => {
    const run = makeRun([
      {
        at: "2026-06-25T12:00:01.000Z",
        stream: "system",
        text: "Decision: proceed\n\n```json\n{\"archicodePatch\":{\"summary\":\"Proceed with a 5-step implementation plan.\"}}\n```"
      },
      {
        at: "2026-06-25T12:00:05.000Z",
        stream: "system",
        text: "Final handoff: Verification completed with `npm run build`. Run completed without detected verification failures. Preview with Run App when needed; runtime launch is separate from verification."
      }
    ], {
      status: "succeeded",
      phase: "complete",
      promptSummary: "Plan from project context.",
      runInstructions: "Verification completed with `npm run build`. Run completed without detected verification failures.",
      planArtifactIds: ["plan-1"]
    });

    expect(runPlanText(run, [{
      id: "plan-1",
      title: "Plan",
      summary: "Proceed with a 5-step implementation plan.",
      promptSummary: "Plan from project context.",
      providerSummary: "Proceed with a 5-step implementation plan.",
      planOutputAt: "2026-06-25T12:00:01.000Z"
    }])).toBe("Proceed with a 5-step implementation plan.");
  });

  it("shows detailed planning output while the run is still awaiting plan review", () => {
    const run = makeRun([
      {
        at: "2026-06-25T12:00:01.000Z",
        stream: "system",
        text: [
          "Planning complete.",
          "```json",
          JSON.stringify({
            archicodePatch: {
              summary: "Create ContactPage.vue, PortfolioPage.vue, and update the nav."
            }
          }),
          "```"
        ].join("\n")
      }
    ], {
      status: "awaiting-plan-review",
      phase: "awaiting-plan-review",
      promptSummary: "Implement the Contact Us and Portfolio pages."
    });

    expect(runPlanText(run)).toBe("Create ContactPage.vue, PortfolioPage.vue, and update the nav.");
  });

  it("marks provider failures during planning as plan failures without implying code ran", () => {
    const run = makeRun([
      { at: "2026-06-25T12:00:01.000Z", stream: "system", text: "Plan artifact: .archicode/artifacts/run-plan.json" },
      { at: "2026-06-25T12:00:02.000Z", stream: "system", text: "Planning phase started." },
      { at: "2026-06-25T12:00:03.000Z", stream: "stderr", text: "OpenAI-compatible Responses provider failed with 429: insufficient_quota" }
    ], {
      status: "failed",
      phase: "complete",
      planArtifactIds: ["plan-1"],
      runInstructions: "Provider quota or rate limit blocked planning."
    });

    expect(runStageItems(run)).toEqual([
      { label: "Plan", tone: "danger", detail: "failed" },
      { label: "Plan review", tone: "neutral", detail: "not run" },
      { label: "Code", tone: "neutral", detail: "not run" },
      { label: "Code review", tone: "neutral", detail: "not needed" },
      { label: "Verify", tone: "neutral", detail: "not run" }
    ]);
  });

  it("shows automatic review gates as skipped while verification waits", () => {
    const run = makeRun([
      { at: "2026-06-25T12:00:01.000Z", stream: "system", text: "Planning phase started." }
    ], {
      status: "planning",
      phase: "planning",
      effort: "high"
    });

    expect(runStageItems(run, {
      planningReviewMode: "auto",
      codeReviewMode: "auto-apply"
    })).toEqual([
      { label: "Plan", tone: "accent", detail: "running" },
      { label: "Plan review", tone: "success", detail: "skipped" },
      { label: "Code", tone: "neutral", detail: "waiting" },
      { label: "Code review", tone: "success", detail: "skipped" },
      { label: "Verify", tone: "neutral", detail: "waiting" }
    ]);
  });
});
