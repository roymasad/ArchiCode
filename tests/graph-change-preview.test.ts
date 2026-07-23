import { describe, expect, it } from "vitest";
import { flowSchema, researchGraphOperationSchema, type ResearchGraphOperation } from "../src/shared/schema";
import { buildFlowGraphPreview } from "../src/renderer/src/utils/graphChangePreview";
import flowFixture from "../fixtures/sample-project/.archicode/flows/flow-main.json";

function operation(input: unknown): ResearchGraphOperation {
  return researchGraphOperationSchema.parse(input);
}

describe("graph change preview placement", () => {
  it("recalculates a surviving node with the same topology-aware layout used by apply", () => {
    const flow = flowSchema.parse(flowFixture);
    const anchor = flow.nodes.find((node) => node.id === "node-json-model")!;
    const createHeader = operation({
      kind: "create-node",
      flowId: flow.id,
      node: {
        id: "node-header",
        type: "component",
        title: "Header",
        description: "Shared site header.",
        visual: { shape: "rounded" }
      }
    });
    const createFooter = operation({
      kind: "create-node",
      flowId: flow.id,
      node: {
        id: "node-footer",
        type: "component",
        title: "Footer",
        description: "Shared site footer.",
        visual: { shape: "rounded" }
      }
    });
    const connectHeader = operation({
      kind: "create-edge",
      flowId: flow.id,
      edge: { source: anchor.id, target: "node-header", label: "uses shared layout" }
    });
    const connectFooter = operation({
      kind: "create-edge",
      flowId: flow.id,
      edge: { source: anchor.id, target: "node-footer", label: "uses shared layout" }
    });

    const fullPreview = buildFlowGraphPreview(flow, [createHeader, createFooter, connectHeader, connectFooter]);
    const partialPreview = buildFlowGraphPreview(flow, [createHeader, connectHeader]);
    const fullHeader = fullPreview.phantomNodes.find((node) => node.id === "node-header")!;
    const partialHeader = partialPreview.phantomNodes.find((node) => node.id === "node-header")!;

    expect(fullHeader.position.y).toBe(anchor.position.y + 110);
    expect(partialHeader.position).toEqual({
      x: Math.max(...flow.nodes.map((node) => node.position.x)) + 330,
      y: anchor.position.y
    });
    expect(partialPreview.phantomNodes.map((node) => node.id)).toEqual(["node-header"]);
    expect(partialPreview.phantomEdges).toHaveLength(1);
  });
});
