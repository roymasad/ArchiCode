import type { ArchicodeNode, Flow, FlowSubflow } from "./schema";

const evidenceSuffix = /\s*\(Evidence\)\s*$/i;

export function isEvidenceFlow(flow: Pick<Flow, "name" | "perspective" | "evidenceBackbone">): boolean {
  return flow.evidenceBackbone === true || (!flow.perspective && evidenceSuffix.test(flow.name));
}

export function editableFlowName(flow: Pick<Flow, "name" | "perspective" | "evidenceBackbone">): string {
  return isEvidenceFlow(flow) ? flow.name.replace(evidenceSuffix, "").trim() : flow.name;
}

export function flowDisplayName(flow: Pick<Flow, "name" | "perspective" | "evidenceBackbone">): string {
  if (!isEvidenceFlow(flow)) return flow.name;
  return `${editableFlowName(flow) || "Codebase Structure"} (Evidence)`;
}

export function normalizeEvidenceFlow(flow: Flow): Flow {
  if (!isEvidenceFlow(flow)) return flow;
  return { ...flow, name: flowDisplayName(flow), evidenceBackbone: true };
}

export function compareTopLevelFlows(left: Flow, right: Flow): number {
  const evidenceOrder = Number(isEvidenceFlow(right)) - Number(isEvidenceFlow(left));
  if (evidenceOrder) return evidenceOrder;
  const ignoredOrder = Number(left.ignored) - Number(right.ignored);
  if (ignoredOrder) return ignoredOrder;
  return flowDisplayName(left).localeCompare(flowDisplayName(right), undefined, { sensitivity: "base", numeric: true })
    || left.id.localeCompare(right.id);
}

export function compareSiblingSubflows(left: FlowSubflow, right: FlowSubflow): number {
  const ignoredOrder = Number(left.ignored) - Number(right.ignored);
  if (ignoredOrder) return ignoredOrder;
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
    || left.id.localeCompare(right.id);
}

function stamp(): string {
  return new Date().toISOString();
}

export function visibleNodesForFlow(flow: Flow, activeSubflowId: string | null, searchQuery: string): ArchicodeNode[] {
  const query = searchQuery.trim().toLowerCase();
  return flow.nodes.filter((node) => {
    const matchesSubflow = activeSubflowId ? node.subflowId === activeSubflowId : !node.subflowId;
    const matchesSearch = !query || [
      node.title,
      node.description,
      node.type,
      node.stage,
      node.ignored ? "ignored" : "included",
      ...node.flags,
      ...node.techStack,
      ...node.acceptanceCriteria,
      ...Object.values(node.customProperties ?? {})
    ].some((value) => value.toLowerCase().includes(query));
    return matchesSubflow && matchesSearch;
  });
}

export function visibleEdgesForNodes(flow: Flow, visibleNodeIds: Set<string>) {
  return flow.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
}

export function childSubflowsForFlow(flow: Flow, parentSubflowId: string | null): FlowSubflow[] {
  return flow.subflows.filter((subflow) =>
    parentSubflowId ? subflow.parentSubflowId === parentSubflowId : !subflow.parentSubflowId
  );
}

export function isSubflowIgnored(flow: Flow, subflowId: string | null | undefined): boolean {
  if (!subflowId) return false;
  const byId = new Map(flow.subflows.map((subflow) => [subflow.id, subflow]));
  const seen = new Set<string>();
  let current = byId.get(subflowId);
  while (current && !seen.has(current.id)) {
    if (current.ignored) return true;
    seen.add(current.id);
    current = current.parentSubflowId ? byId.get(current.parentSubflowId) : undefined;
  }
  return false;
}

export function workingNodesForFlow(flow: Flow): ArchicodeNode[] {
  return flow.nodes.filter((node) => !node.ignored && !isSubflowIgnored(flow, node.subflowId));
}

export function subflowDepth(flow: Flow, subflowId: string): number {
  const byId = new Map(flow.subflows.map((subflow) => [subflow.id, subflow]));
  let depth = 0;
  let current = byId.get(subflowId);
  const seen = new Set<string>();
  while (current?.parentSubflowId && !seen.has(current.parentSubflowId)) {
    seen.add(current.id);
    depth += 1;
    current = byId.get(current.parentSubflowId);
  }
  return depth;
}

function isSubflowDescendant(flow: Flow, subflowId: string, possibleAncestorId: string): boolean {
  const byId = new Map(flow.subflows.map((subflow) => [subflow.id, subflow]));
  let current = byId.get(subflowId);
  const seen = new Set<string>();
  while (current?.parentSubflowId && !seen.has(current.id)) {
    if (current.parentSubflowId === possibleAncestorId) return true;
    seen.add(current.id);
    current = byId.get(current.parentSubflowId);
  }
  return false;
}

export function duplicateNode(node: ArchicodeNode, existingCount: number, overrides: Partial<ArchicodeNode> = {}): ArchicodeNode {
  const id = `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    ...node,
    ...overrides,
    id,
    title: overrides.title ?? `${node.title} Copy`,
    ignored: overrides.ignored ?? false,
    locked: false,
    flags: Array.from(new Set([...(overrides.flags ?? node.flags.filter((flag) => flag !== "user-approved")), "changed"])),
    position: overrides.position ?? {
      x: node.position.x + 44 + existingCount * 4,
      y: node.position.y + 44 + existingCount * 4
    },
    updatedAt: stamp()
  };
}

export function deleteSubflowFromFlow(flow: Flow, subflowId: string): Flow {
  const deleted = flow.subflows.find((subflow) => subflow.id === subflowId);
  const promotedParentSubflowId = deleted?.parentSubflowId;
  return {
    ...flow,
    subflows: flow.subflows
      .filter((subflow) => subflow.id !== subflowId)
      .map((subflow) => subflow.parentSubflowId === subflowId
        ? { ...subflow, parentSubflowId: promotedParentSubflowId }
        : subflow),
    nodes: flow.nodes.map((node) => node.subflowId === subflowId
      ? { ...node, subflowId: promotedParentSubflowId, updatedAt: stamp() }
      : node),
    updatedAt: stamp()
  };
}

export function reparentSubflowInFlow(flow: Flow, subflowId: string, parentSubflowId: string | null): Flow {
  const subflow = flow.subflows.find((item) => item.id === subflowId);
  if (!subflow) return flow;
  if (parentSubflowId === subflowId) return flow;
  if (parentSubflowId && !flow.subflows.some((item) => item.id === parentSubflowId)) return flow;
  if (parentSubflowId && isSubflowDescendant(flow, parentSubflowId, subflowId)) return flow;
  const normalizedParent = parentSubflowId ?? undefined;
  if ((subflow.parentSubflowId ?? undefined) === normalizedParent && !subflow.parentNodeId) return flow;
  return {
    ...flow,
    subflows: flow.subflows.map((item) => item.id === subflowId
      ? { ...item, parentSubflowId: normalizedParent, parentNodeId: undefined }
      : item),
    updatedAt: stamp()
  };
}

export function linkNodeToSubflow(flow: Flow, nodeId: string, subflowId: string | null): Flow {
  const node = flow.nodes.find((item) => item.id === nodeId);
  if (!node) return flow;
  return {
    ...flow,
    subflows: flow.subflows.map((subflow) => {
      if (subflowId && subflow.id === subflowId) {
        if (node.subflowId === subflow.id || (node.subflowId && isSubflowDescendant(flow, node.subflowId, subflow.id))) {
          return subflow;
        }
        return { ...subflow, parentNodeId: nodeId, parentSubflowId: node.subflowId };
      }
      if (subflow.parentNodeId === nodeId) return { ...subflow, parentNodeId: undefined };
      return subflow;
    }),
    updatedAt: stamp()
  };
}

export function autoLayoutFlow(flow: Flow, activeSubflowId: string | null): Flow {
  const scopedNodes = visibleNodesForFlow(flow, activeSubflowId, "");
  const scopedIds = new Set(scopedNodes.map((node) => node.id));
  const columns = Math.max(2, Math.ceil(Math.sqrt(scopedNodes.length || 1)));
  const xGap = 330;
  const yGap = 210;
  const xStart = 80;
  const yStart = 80;

  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      if (!scopedIds.has(node.id)) return node;
      const index = scopedNodes.findIndex((item) => item.id === node.id);
      return {
        ...node,
        position: {
          x: xStart + (index % columns) * xGap,
          y: yStart + Math.floor(index / columns) * yGap
        },
        updatedAt: stamp()
      };
    }),
    updatedAt: stamp()
  };
}
