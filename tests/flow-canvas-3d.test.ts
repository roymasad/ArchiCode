import { describe, expect, it } from "vitest";
import { flowSchema } from "../src/shared/schema";
import { build3dScopeOffsets } from "../src/renderer/src/utils/flow3dLayout";
import flowFixture from "../fixtures/sample-project/.archicode/flows/flow-main.json";

describe("3D flow canvas layout", () => {
  it("packs sibling subflow canvases into non-overlapping spaces on their shared layer", () => {
    const siblingIds = ["subflow-orchestrator", "subflow-json"];
    const nodeIds = ["node-project", "node-json-model"];
    const flow = flowSchema.parse({
      ...flowFixture,
      nodes: flowFixture.nodes.map((node) => {
        const siblingIndex = nodeIds.indexOf(node.id);
        return siblingIndex === -1
          ? node
          : { ...node, subflowId: siblingIds[siblingIndex], position: { x: 80, y: 80 } };
      })
    });

    const siblingNodes = flow.nodes.filter((node) => nodeIds.includes(node.id));
    const offsets = build3dScopeOffsets(flow, siblingNodes);
    const first = offsets.get(siblingIds[0])!;
    const second = offsets.get(siblingIds[1])!;

    expect(Math.hypot(first.x - second.x, first.z - second.z)).toBeGreaterThan(300);
  });
});
