import { describe, expect, it } from "vitest";
import type { ArchicodeNode, ArchitecturePolicyViolation, Artifact, Run } from "../src/shared/schema";
import {
  explainArtifactPrompt,
  explainEdgePrompt,
  explainFilePrompt,
  explainNodesPrompt,
  explainPolicyViolationsPrompt,
  explainRunPrompt
} from "../src/renderer/src/utils/explainPrompts";

const readOnlyExpectation = (prompt: string) => {
  expect(prompt).toContain("read-only explanation");
  expect(prompt).toContain("Do not edit the graph");
  expect(prompt).toContain("prepare a graph change set");
  expect(prompt).toContain("queue a run");
  expect(prompt).toContain("change source files");
};

describe("AI explanation prompts", () => {
  it("identifies node and edge context without requesting changes", () => {
    const nodePrompt = explainNodesPrompt([
      { id: "node-api", title: "API Gateway" } as ArchicodeNode
    ], "Request Lifecycle");
    const edgePrompt = explainEdgePrompt({
      edgeId: "edge-api-db",
      flowName: "Request Lifecycle",
      sourceTitle: "API Gateway",
      targetTitle: "Database",
      label: "persists"
    });

    expect(nodePrompt).toContain("@API Gateway");
    expect(nodePrompt).toContain('flow "Request Lifecycle"');
    expect(edgePrompt).toContain("edge-api-db");
    expect(edgePrompt).toContain('labelled "persists"');
    readOnlyExpectation(nodePrompt);
    readOnlyExpectation(edgePrompt);
  });

  it("identifies files, runs, and artifacts without requesting changes", () => {
    const filePrompt = explainFilePrompt("src/server/api.ts");
    const runPrompt = explainRunPrompt({
      id: "run-42",
      status: "failed",
      phase: "verify",
      promptSummary: "Implement request validation"
    } as unknown as Run);
    const artifactPrompt = explainArtifactPrompt({
      id: "artifact-7",
      title: "Verification report",
      path: "artifacts/verification.md",
      type: "summary",
      runId: "run-42",
      nodeId: "node-api"
    } as unknown as Artifact);

    expect(filePrompt).toContain("src/server/api.ts");
    expect(runPrompt).toContain("run-42");
    expect(runPrompt).toContain('currently "failed" in phase "verify"');
    expect(artifactPrompt).toContain("Verification report");
    expect(artifactPrompt).toContain("artifacts/verification.md");
    readOnlyExpectation(filePrompt);
    readOnlyExpectation(runPrompt);
    readOnlyExpectation(artifactPrompt);
  });

  it("explains deterministic violations and asks for resolution options", () => {
    const prompt = explainPolicyViolationsPrompt([{
      id: "violation-1",
      policyId: "policy-boundaries",
      policyTitle: "Layer boundaries",
      severity: "error",
      enforcement: "block",
      message: "UI code imports the persistence layer directly.",
      source: { path: "src/ui/view.ts", line: 12, flowId: "flow-main", nodeId: "node-ui" },
      target: { path: "src/db/client.ts", nodeId: "node-db" }
    } as unknown as ArchitecturePolicyViolation], "Frontend");

    expect(prompt).toContain("Explain Violation");
    expect(prompt).toContain("Suggest Resolution");
    expect(prompt).toContain("UI code imports the persistence layer directly.");
    expect(prompt).toContain("focused resolution options with tradeoffs");
    readOnlyExpectation(prompt);
  });
});
