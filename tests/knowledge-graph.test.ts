import { describe, expect, it } from "vitest";
import { createSeedProject } from "../src/shared/fixtures";
import { flowSchema } from "../src/shared/schema";
import { boundedKnowledgeNeighborhood, knowledgeImpact, shortestKnowledgePath, zoomGraphAtPoint } from "../src/shared/knowledgeGraph";

describe("bounded code knowledge traversal", () => {
  const seed = createSeedProject("/tmp/knowledge-graph").flow;
  const nodes = seed.nodes.slice(0, 4);
  const [a, b, c, d] = nodes;
  const flow = flowSchema.parse({
    ...seed,
    nodes,
    edges: [
      { id: "a-b", source: a.id, target: b.id },
      { id: "b-c", source: b.id, target: c.id },
      { id: "d-b", source: d.id, target: b.id }
    ]
  });

  it("returns a strict token-friendly neighborhood", () => {
    const slice = boundedKnowledgeNeighborhood(flow, [a.id], { depth: 2, maxNodes: 2, maxEdges: 2 });
    expect(slice.nodeIds).toEqual([a.id, b.id]);
    expect(slice.edgeIds).toContain("a-b");
    expect(slice.truncated).toBe(true);
  });

  it("traces shortest paths and reverse dependency impact", () => {
    expect(shortestKnowledgePath(flow, a.id, c.id)).toEqual({ nodeIds: [a.id, b.id, c.id], edgeIds: ["a-b", "b-c"] });
    const impact = knowledgeImpact(flow, b.id, 8);
    expect(impact.nodeIds).toEqual(expect.arrayContaining([b.id, a.id, d.id]));
    expect(impact.nodeIds).not.toContain(c.id);
  });

  it("keeps the graph point under the mouse fixed while zooming", () => {
    const before = { x: 40, y: -20, scale: 1.25 };
    const pointer = { x: 310, y: 220 };
    const worldBefore = { x: (pointer.x - before.x) / before.scale, y: (pointer.y - before.y) / before.scale };
    const after = zoomGraphAtPoint(before, pointer, 1.1, { min: .35, max: 3 });
    expect((pointer.x - after.x) / after.scale).toBeCloseTo(worldBefore.x);
    expect((pointer.y - after.y) / after.scale).toBeCloseTo(worldBefore.y);
  });
});
