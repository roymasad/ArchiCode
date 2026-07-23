import { describe, expect, it } from "vitest";
import { researchChangeSetCategory, researchGraphOperationDependencies, toggleResearchGraphOperationSelection } from "../src/shared/researchChangeSetSemantics";

describe("research change-set semantics", () => {
  it("distinguishes queue submissions from graph edits and mixed changes", () => {
    expect(researchChangeSetCategory([{ kind: "start-agent-run" }])).toBe("queue");
    expect(researchChangeSetCategory([{ kind: "retry-run" }, { kind: "start-debugging-run" }])).toBe("queue");
    expect(researchChangeSetCategory([{ kind: "create-node" }, { kind: "create-edge" }])).toBe("graph");
    expect(researchChangeSetCategory([{ kind: "create-node" }, { kind: "start-agent-run" }])).toBe("change");
    expect(researchChangeSetCategory([{ kind: "run-acceptance-checks" }])).toBe("change");
  });

  it("links same-card edges to the node operations that create their endpoints", () => {
    const operations = [
      { kind: "create-node", flowId: "flow-main", node: { id: "header" } },
      { kind: "create-node", flowId: "flow-main", node: { id: "footer" } },
      { kind: "create-edge", flowId: "flow-main", edge: { source: "landing", target: "header" } },
      { kind: "create-edge", flowId: "flow-main", edge: { source: "landing", target: "footer" } },
      { kind: "create-edge", flowId: "flow-other", edge: { source: "landing", target: "header" } }
    ];

    expect(researchGraphOperationDependencies(operations)).toEqual([[], [], [0], [1], []]);
    expect([...toggleResearchGraphOperationSelection(operations, new Set([0, 1, 2, 3, 4]), 1)]).toEqual([0, 2, 4]);
  });
});
