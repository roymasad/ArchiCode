import { describe, expect, it } from "vitest";
import { subflowDepth } from "../src/shared/graph";
import {
  createReadmeShowcaseBundle,
  createReadmeShowcaseResearchSessions
} from "../src/shared/readmeShowcase";

describe("README showcase scenarios", () => {
  it("provides a realistic overview graph with nested layers for 2D and 3D captures", () => {
    const bundle = createReadmeShowcaseBundle("/tmp/archicode-showcase", "overview");
    const flow = bundle.flows.find((candidate) => candidate.id === bundle.project.activeFlowId)!;
    const rootNodes = flow.nodes.filter((node) => !node.subflowId);
    const depths = flow.subflows.map((subflow) => subflowDepth(flow, subflow.id));

    expect(flow.name).toBe("ArchiCode Architecture");
    expect(rootNodes).toHaveLength(8);
    expect(flow.groups).toHaveLength(4);
    expect(flow.nodes.length).toBeGreaterThanOrEqual(36);
    expect(Math.max(...depths)).toBeGreaterThanOrEqual(1);
    expect(flow.edges.every((edge) => edge.evidence?.locations.length)).toBe(true);
  });

  it("provides deterministic relationship communities and inspectable evidence", () => {
    const bundle = createReadmeShowcaseBundle("/tmp/archicode-showcase", "knowledge");
    const flow = bundle.flows.find((candidate) => candidate.id === bundle.project.activeFlowId)!;
    const communityIds = new Set(flow.nodes.map((node) => node.customProperties["Dependency community"]));

    expect(flow.name).toBe("Architecture Knowledge Communities");
    expect(communityIds.size).toBe(5);
    expect(flow.nodes).toHaveLength(25);
    expect(flow.edges.length).toBeGreaterThan(20);
    expect(flow.edges.some((edge) => edge.evidence?.origin === "inferred")).toBe(true);
    expect(flow.edges.every((edge) => edge.evidence?.freshness === "current")).toBe(true);
  });

  it("provides a populated scoped chat with memory, tool evidence, and a review card", () => {
    const [session] = createReadmeShowcaseResearchSessions("/tmp/archicode-showcase");
    const answer = session.messages.find((message) => message.role === "assistant")!;

    expect(session.scope).toEqual({ type: "flow", flowId: "flow-showcase" });
    expect(session.memory.decisions).toHaveLength(1);
    expect(session.messages.every((message) => message.delivery === "realtime")).toBe(true);
    expect(answer.mcpToolCalls).toHaveLength(2);
    expect(answer.changeSet?.operations).toHaveLength(3);
    expect(answer.usage?.contextMode).toBe("compact");
  });
});
