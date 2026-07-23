import type { ArchicodeNode, Flow } from "./schema";
import { layoutScopeByDependencyDepth } from "./graphLayout";

/**
 * Places newly-created Research nodes without moving existing user-positioned
 * nodes. This is shared by the approval preview and the persisted apply path so
 * the coordinates shown during review are the coordinates the user receives.
 */
export function placeCreatedResearchNodes(flow: Flow, createdNodeIds: Set<string>, mutationTimestamp?: string): Flow {
  const scopedSubflowIds = new Set<string | null>();
  for (const node of flow.nodes) {
    if (createdNodeIds.has(node.id)) scopedSubflowIds.add(node.subflowId ?? null);
  }
  if (!scopedSubflowIds.size) return flow;

  let nextFlow = flow;
  for (const subflowId of scopedSubflowIds) {
    nextFlow = placeCreatedResearchNodesInScope(nextFlow, createdNodeIds, subflowId, mutationTimestamp);
  }
  return nextFlow;
}

function placeCreatedResearchNodesInScope(
  flow: Flow,
  createdNodeIds: Set<string>,
  subflowId: string | null,
  mutationTimestamp?: string
): Flow {
  const scopedNodes = flow.nodes.filter((node) => (node.subflowId ?? null) === subflowId);
  const createdNodes = scopedNodes.filter((node) => createdNodeIds.has(node.id));
  if (!createdNodes.length) return flow;

  const existingNodes = scopedNodes.filter((node) => !createdNodeIds.has(node.id));
  const scopedIds = new Set(scopedNodes.map((node) => node.id));
  const scopedEdges = flow.edges.filter((edge) => scopedIds.has(edge.source) && scopedIds.has(edge.target));
  const createdIds = new Set(createdNodes.map((node) => node.id));
  if (!existingNodes.length && scopedEdges.length) {
    // A wholly generated canvas can use the full SCC-aware dependency layout
    // without disturbing any user-positioned nodes.
    return layoutScopeByDependencyDepth(flow, subflowId);
  }
  const xGap = 330;
  const yGap = 220;
  const fallbackX = 80;
  const fallbackY = 80;
  const byId = new Map(scopedNodes.map((node) => [node.id, node]));
  const positioned = new Map<string, { x: number; y: number }>();
  const anchorIds = new Set<string>();
  const createdParents = new Map<string, Set<string>>();
  const desiredAnchorY = new Map<string, number[]>();

  for (const edge of scopedEdges) {
    const sourceCreated = createdIds.has(edge.source);
    const targetCreated = createdIds.has(edge.target);
    if (sourceCreated && targetCreated) {
      const parents = createdParents.get(edge.target) ?? new Set<string>();
      parents.add(edge.source);
      createdParents.set(edge.target, parents);
    }
    if (sourceCreated === targetCreated) continue;
    const createdId = sourceCreated ? edge.source : edge.target;
    const anchorId = sourceCreated ? edge.target : edge.source;
    anchorIds.add(anchorId);
    const values = desiredAnchorY.get(createdId) ?? [];
    values.push(byId.get(anchorId)?.position.y ?? fallbackY);
    desiredAnchorY.set(createdId, values);
  }

  const anchorNodes = [...anchorIds].map((id) => byId.get(id)).filter((node): node is ArchicodeNode => Boolean(node));
  const scopeNodesForBounds = existingNodes.length ? existingNodes : anchorNodes;
  const baseX = scopeNodesForBounds.length
    ? Math.max(...scopeNodesForBounds.map((node) => node.position.x)) + xGap
    : fallbackX;
  const baselineY = anchorNodes.length
    ? average(anchorNodes.map((node) => node.position.y))
    : existingNodes.length
      ? average(existingNodes.map((node) => node.position.y))
      : fallbackY;
  const hasCreatedNodeEdges = scopedEdges.some((edge) => createdIds.has(edge.source) || createdIds.has(edge.target));
  if (!hasCreatedNodeEdges && createdNodes.length > 1) {
    const sorted = [...createdNodes].sort((left, right) => left.title.localeCompare(right.title));
    const columnCount = Math.max(2, Math.ceil(Math.sqrt(sorted.length)));
    const rowCount = Math.ceil(sorted.length / columnCount);
    const startY = Math.max(fallbackY, baselineY - ((rowCount - 1) * yGap) / 2);
    sorted.forEach((node, index) => {
      positioned.set(node.id, {
        x: baseX + (index % columnCount) * xGap,
        y: startY + Math.floor(index / columnCount) * yGap
      });
    });
  } else {
    const depthMemo = new Map<string, number>();
    const depthForNode = (nodeId: string, stack: Set<string> = new Set()): number => {
      const cached = depthMemo.get(nodeId);
      if (cached !== undefined) return cached;
      if (stack.has(nodeId)) return 0;
      stack.add(nodeId);
      const parents = [...(createdParents.get(nodeId) ?? [])];
      const depth = parents.length ? 1 + Math.max(...parents.map((parentId) => depthForNode(parentId, stack))) : 0;
      stack.delete(nodeId);
      depthMemo.set(nodeId, depth);
      return depth;
    };

    const columns = new Map<number, ArchicodeNode[]>();
    for (const node of createdNodes) {
      const depth = depthForNode(node.id);
      const column = columns.get(depth) ?? [];
      column.push(node);
      columns.set(depth, column);
    }

    const sortedDepths = [...columns.keys()].sort((left, right) => left - right);
    for (const depth of sortedDepths) {
      const columnNodes = columns.get(depth) ?? [];
      const ranked = columnNodes
        .map((node) => {
          const explicitYTargets = desiredAnchorY.get(node.id) ?? [];
          const parentTargets = [...(createdParents.get(node.id) ?? [])]
            .map((parentId) => positioned.get(parentId)?.y)
            .filter((value): value is number => typeof value === "number");
          const targets = [...explicitYTargets, ...parentTargets];
          return {
            node,
            desiredY: targets.length ? average(targets) : baselineY
          };
        })
        .sort((left, right) => left.desiredY === right.desiredY
          ? left.node.title.localeCompare(right.node.title)
          : left.desiredY - right.desiredY);
      const columnCenterY = average(ranked.map((item) => item.desiredY));
      const startY = columnCenterY - ((ranked.length - 1) * yGap) / 2;
      ranked.forEach((item, index) => {
        positioned.set(item.node.id, {
          x: baseX + depth * xGap,
          y: startY + index * yGap
        });
      });
    }
  }

  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const nextPosition = positioned.get(node.id);
      return nextPosition
        ? { ...node, position: nextPosition, ...(mutationTimestamp ? { updatedAt: mutationTimestamp } : {}) }
        : node;
    }),
    ...(mutationTimestamp ? { updatedAt: mutationTimestamp } : {})
  };
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
