import { describe, expect, it } from "vitest";
import { createSeedProject } from "../src/shared/fixtures";
import { computeGraphVersion, semanticNodeChangedFields } from "../src/main/storage/graphVersion";

describe("semantic graph versions", () => {
  it("is stable across presentation-only changes", () => {
    const { flow } = createSeedProject("/tmp/project");
    const changedPresentation = {
      ...flow,
      updatedAt: "2099-01-01T00:00:00.000Z",
      visual: { icon: "network" as const, color: "#123456" },
      nodes: flow.nodes.map((node, index) => ({
        ...node,
        updatedAt: "2099-01-01T00:00:00.000Z",
        position: { x: node.position.x + index + 100, y: node.position.y - index - 100 },
        visual: { ...node.visual, color: "#654321" }
      }))
    };

    expect(computeGraphVersion([changedPresentation])).toBe(computeGraphVersion([flow]));
  });

  it("changes when semantic node state changes", () => {
    const { flow } = createSeedProject("/tmp/project");
    const changed = {
      ...flow,
      nodes: flow.nodes.map((node, index) => index === 0 ? { ...node, title: `${node.title} evolved` } : node)
    };

    expect(computeGraphVersion([changed])).not.toBe(computeGraphVersion([flow]));
  });

  it("does not depend on entity array order", () => {
    const { flow } = createSeedProject("/tmp/project");
    expect(computeGraphVersion([{ ...flow, nodes: [...flow.nodes].reverse(), edges: [...flow.edges].reverse() }]))
      .toBe(computeGraphVersion([flow]));
  });

  it("reports semantic fields without attributing layout-only edits", () => {
    const { flow } = createSeedProject("/tmp/project");
    const node = flow.nodes[0]!;
    expect(semanticNodeChangedFields(node, { ...node, title: `${node.title} changed`, position: { x: 999, y: 999 } })).toEqual(["title"]);
    expect(semanticNodeChangedFields(node, { ...node, position: { x: 999, y: 999 } })).toEqual([]);
  });
});
