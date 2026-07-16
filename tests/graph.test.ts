import { describe, expect, it } from "vitest";
import { autoLayoutFlow, childSubflowsForFlow, compareSiblingSubflows, compareTopLevelFlows, deleteSubflowFromFlow, duplicateNode, editableFlowName, flowDisplayName, linkNodeToSubflow, normalizeEvidenceFlow, reparentSubflowInFlow, visibleEdgesForNodes, visibleNodesForFlow } from "../src/shared/graph";
import { flowSchema } from "../src/shared/schema";
import flowFixture from "../fixtures/sample-project/.archicode/flows/flow-main.json";

describe("graph authoring helpers", () => {
  it("pins the evidence flow while sorting other top-level flows alphabetically", () => {
    const base = flowSchema.parse(flowFixture);
    const flows = [
      { ...base, id: "flow-z", name: "Zebra", ignored: false },
      { ...base, id: "flow-evidence", name: "Renamed Structure", evidenceBackbone: true, ignored: false },
      { ...base, id: "flow-ignored", name: "Aardvark", ignored: true },
      { ...base, id: "flow-a", name: "alpha", ignored: false }
    ].sort(compareTopLevelFlows);

    expect(flows.map((flow) => flow.id)).toEqual(["flow-evidence", "flow-a", "flow-z", "flow-ignored"]);
  });

  it("protects the evidence suffix while leaving its descriptive name editable", () => {
    const base = flowSchema.parse(flowFixture);
    const evidence = normalizeEvidenceFlow({ ...base, name: "Platform Shape (Evidence)" });
    const renamed = normalizeEvidenceFlow({ ...evidence, name: "System Blueprint" });

    expect(evidence.evidenceBackbone).toBe(true);
    expect(editableFlowName(evidence)).toBe("Platform Shape");
    expect(flowDisplayName(renamed)).toBe("System Blueprint (Evidence)");
    expect(renamed.name).toBe("System Blueprint (Evidence)");
  });

  it("sorts sibling subflows alphabetically with ignored items last", () => {
    const subflows = [
      { id: "subflow-z", name: "Zebra", ignored: false },
      { id: "subflow-ignored", name: "Aardvark", ignored: true },
      { id: "subflow-a", name: "alpha", ignored: false }
    ].sort(compareSiblingSubflows);

    expect(subflows.map((subflow) => subflow.id)).toEqual(["subflow-a", "subflow-z", "subflow-ignored"]);
  });

  it("filters visible nodes by subflow and search query", () => {
    const flow = flowSchema.parse({
      ...flowFixture,
      nodes: flowFixture.nodes.map((node) => node.id === "node-canvas" ? { ...node, subflowId: "subflow-ui" } : node),
      subflows: [...flowFixture.subflows, { id: "subflow-ui", name: "UI" }]
    });

    expect(visibleNodesForFlow(flow, "subflow-ui", "")).toHaveLength(1);
    expect(visibleNodesForFlow(flow, null, "canvas")).toHaveLength(0);
    expect(visibleNodesForFlow(flow, null, "orchestrator")[0]?.id).toBe("node-orchestrator");
  });

  it("keeps only edges where both endpoints are visible", () => {
    const flow = flowSchema.parse(flowFixture);
    const visibleIds = new Set(["node-project", "node-json-model"]);

    expect(visibleEdgesForNodes(flow, visibleIds)).toEqual([
      { id: "edge-project-json", source: "node-project", target: "node-json-model", label: "stores" }
    ]);
  });

  it("duplicates nodes as unlocked changed copies", () => {
    const flow = flowSchema.parse(flowFixture);
    const copy = duplicateNode(flow.nodes.find((node) => node.id === "node-approved-contract")!, flow.nodes.length);

    expect(copy.id).not.toBe("node-approved-contract");
    expect(copy.locked).toBe(false);
    expect(copy.flags).toContain("changed");
    expect(copy.flags).not.toContain("user-approved");
  });

  it("deletes a subflow without deleting its nodes", () => {
    const flow = flowSchema.parse({
      ...flowFixture,
      nodes: flowFixture.nodes.map((node) => node.id === "node-canvas" ? { ...node, subflowId: "subflow-ui" } : node),
      subflows: [...flowFixture.subflows, { id: "subflow-ui", name: "UI", parentNodeId: "node-project" }]
    });

    const updated = deleteSubflowFromFlow(flow, "subflow-ui");

    expect(updated.subflows.some((subflow) => subflow.id === "subflow-ui")).toBe(false);
    expect(updated.nodes.find((node) => node.id === "node-canvas")?.subflowId).toBeUndefined();
    expect(updated.nodes.some((node) => node.id === "node-canvas")).toBe(true);
  });

  it("supports nested subflows and promotes children when deleting a parent", () => {
    const flow = flowSchema.parse({
      ...flowFixture,
      nodes: flowFixture.nodes.map((node) => {
        if (node.id === "node-json-model") return { ...node, subflowId: "subflow-parent" };
        if (node.id === "node-canvas") return { ...node, subflowId: "subflow-child" };
        return node;
      }),
      subflows: [
        ...flowFixture.subflows,
        { id: "subflow-parent", name: "Parent" },
        { id: "subflow-child", name: "Child", parentSubflowId: "subflow-parent" }
      ]
    });

    expect(childSubflowsForFlow(flow, null).map((subflow) => subflow.id)).toContain("subflow-parent");
    expect(childSubflowsForFlow(flow, "subflow-parent").map((subflow) => subflow.id)).toEqual(["subflow-child"]);
    expect(visibleNodesForFlow(flow, "subflow-child", "")[0]?.id).toBe("node-canvas");

    const updated = deleteSubflowFromFlow(flow, "subflow-parent");

    expect(updated.subflows.find((subflow) => subflow.id === "subflow-child")?.parentSubflowId).toBeUndefined();
    expect(updated.nodes.find((node) => node.id === "node-json-model")?.subflowId).toBeUndefined();
    expect(updated.nodes.find((node) => node.id === "node-canvas")?.subflowId).toBe("subflow-child");
  });

  it("links and unlinks a node to a referenced subflow", () => {
    const flow = flowSchema.parse(flowFixture);
    const linked = linkNodeToSubflow(flow, "node-project", "subflow-orchestrator");
    const relinked = linkNodeToSubflow(linked, "node-project", "subflow-json");
    const unlinked = linkNodeToSubflow(relinked, "node-project", null);

    expect(linked.subflows.find((subflow) => subflow.id === "subflow-orchestrator")?.parentNodeId).toBe("node-project");
    expect(relinked.subflows.find((subflow) => subflow.id === "subflow-orchestrator")?.parentNodeId).toBeUndefined();
    expect(relinked.subflows.find((subflow) => subflow.id === "subflow-json")?.parentNodeId).toBe("node-project");
    expect(unlinked.subflows.some((subflow) => subflow.parentNodeId === "node-project")).toBe(false);
  });

  it("reparents subflows without allowing cycles", () => {
    const flow = flowSchema.parse({
      ...flowFixture,
      subflows: [
        ...flowFixture.subflows,
        { id: "subflow-parent", name: "Parent" },
        { id: "subflow-child", name: "Child", parentSubflowId: "subflow-parent" },
        { id: "subflow-sibling", name: "Sibling" }
      ]
    });

    const nested = reparentSubflowInFlow(flow, "subflow-sibling", "subflow-child");
    const cyclic = reparentSubflowInFlow(nested, "subflow-parent", "subflow-sibling");
    const topLevel = reparentSubflowInFlow(nested, "subflow-sibling", null);

    expect(nested.subflows.find((subflow) => subflow.id === "subflow-sibling")?.parentSubflowId).toBe("subflow-child");
    expect(cyclic.subflows.find((subflow) => subflow.id === "subflow-parent")?.parentSubflowId).toBeUndefined();
    expect(topLevel.subflows.find((subflow) => subflow.id === "subflow-sibling")?.parentSubflowId).toBeUndefined();
  });

  it("links detail flows under the selected node's current subflow", () => {
    const flow = flowSchema.parse({
      ...flowFixture,
      nodes: flowFixture.nodes.map((node) => node.id === "node-canvas" ? { ...node, subflowId: "subflow-ui" } : node),
      subflows: [...flowFixture.subflows, { id: "subflow-ui", name: "UI" }, { id: "subflow-component", name: "Component" }]
    });

    const linked = linkNodeToSubflow(flow, "node-canvas", "subflow-component");

    expect(linked.subflows.find((subflow) => subflow.id === "subflow-component")?.parentNodeId).toBe("node-canvas");
    expect(linked.subflows.find((subflow) => subflow.id === "subflow-component")?.parentSubflowId).toBe("subflow-ui");
  });

  it("auto-layouts only the active subflow when one is selected", () => {
    const flow = flowSchema.parse({
      ...flowFixture,
      nodes: flowFixture.nodes.map((node) => node.id === "node-canvas" ? { ...node, subflowId: "subflow-ui" } : node),
      subflows: [...flowFixture.subflows, { id: "subflow-ui", name: "UI" }]
    });
    const before = flow.nodes.find((node) => node.id === "node-project")!.position;
    const laidOut = autoLayoutFlow(flow, "subflow-ui");

    expect(laidOut.nodes.find((node) => node.id === "node-project")?.position).toEqual(before);
    expect(laidOut.nodes.find((node) => node.id === "node-canvas")?.position).toEqual({ x: 80, y: 80 });
  });
});
