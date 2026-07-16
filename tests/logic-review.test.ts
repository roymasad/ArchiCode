import { describe, expect, it } from "vitest";
import { buildLogicReviewPrompt } from "../src/renderer/src/utils/logicReview";

describe("logic review prompt", () => {
  it("focuses a current-flow review on graph logic and traceable findings", () => {
    const prompt = buildLogicReviewPrompt({ kind: "flow", name: "Checkout" });

    expect(prompt).toContain('current flow "Checkout"');
    expect(prompt).toContain("root canvas and linked detail flows");
    expect(prompt).toContain("contradict");
    expect(prompt).toContain("Missing information");
    expect(prompt).toContain("source → target");
    expect(prompt).not.toContain("Duplicated or conflicting responsibilities, terminology, assumptions, and handoffs across different project flows.");
  });

  it("adds cross-flow checks for a project-wide review and keeps it read-only", () => {
    const prompt = buildLogicReviewPrompt({ kind: "project", name: "Storefront" });

    expect(prompt).toContain('all flows in the project "Storefront"');
    expect(prompt).toContain("across different project flows");
    expect(prompt).toContain("Do not edit the graph");
    expect(prompt).toContain("Do not edit the graph, prepare a graph change set, queue an agent run, or change source files");
    expect(prompt).toContain("follow up before deciding what to change");
  });
});
