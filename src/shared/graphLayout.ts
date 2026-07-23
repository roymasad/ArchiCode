import type { Flow } from "./schema";
import { autoLayoutFlow } from "./graph";

const X_GAP = 330;
const Y_GAP = 220;
const BASE_X = 80;
const BASE_Y = 80;
const DENSE_X_GAP = 390;
const DENSE_Y_GAP = 280;
const DENSE_SECTION_GAP = 120;
const DEFAULT_NODE_SIZE = { width: 248, height: 154 };

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : BASE_Y;
}

/** Dense cyclic scopes are architectural neighborhoods, not useful dependency columns. */
function layoutDenseScope(flow: Flow, scopedNodes: Flow["nodes"]): Flow {
  const groupOrder = new Map((flow.groups ?? []).map((group, index) => [group.id, index]));
  const buckets = new Map<string, Flow["nodes"]>();
  for (const node of scopedNodes) {
    const key = node.groupId && groupOrder.has(node.groupId) ? node.groupId : "~ungrouped";
    buckets.set(key, [...(buckets.get(key) ?? []), node]);
  }
  const orderedBuckets = [...buckets.entries()].sort(([left], [right]) => {
    if (left === "~ungrouped") return 1;
    if (right === "~ungrouped") return -1;
    return (groupOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (groupOrder.get(right) ?? Number.MAX_SAFE_INTEGER);
  });
  const positioned = new Map<string, { x: number; y: number }>();
  let sectionY = BASE_Y;
  for (const [, nodes] of orderedBuckets) {
    const sorted = [...nodes].sort((left, right) => left.title.localeCompare(right.title));
    const columnCount = Math.min(3, Math.max(2, Math.ceil(Math.sqrt(sorted.length))));
    sorted.forEach((node, index) => {
      positioned.set(node.id, {
        x: BASE_X + (index % columnCount) * DENSE_X_GAP,
        y: sectionY + Math.floor(index / columnCount) * DENSE_Y_GAP
      });
    });
    sectionY += Math.ceil(sorted.length / columnCount) * DENSE_Y_GAP + DENSE_SECTION_GAP;
  }
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const position = positioned.get(node.id);
      return position ? { ...node, position } : node;
    })
  };
}

function groupLayoutCollides(flow: Flow, scopeSubflowId: string | null): boolean {
  const nodes = flow.nodes.filter((node) => (node.subflowId ?? null) === scopeSubflowId);
  const boxes = (flow.groups ?? []).flatMap((group) => {
    const members = nodes.filter((node) => node.groupId === group.id);
    if (members.length < 2) return [];
    const minX = Math.min(...members.map((node) => node.position.x));
    const minY = Math.min(...members.map((node) => node.position.y));
    const maxX = Math.max(...members.map((node) => node.position.x + (node.size?.width ?? DEFAULT_NODE_SIZE.width)));
    const maxY = Math.max(...members.map((node) => node.position.y + (node.size?.height ?? DEFAULT_NODE_SIZE.height)));
    return [{ groupId: group.id, memberIds: new Set(members.map((node) => node.id)), left: minX - 30, top: minY - 42, right: maxX + 30, bottom: maxY + 28 }];
  });
  const overlapsMaterially = (left: { left: number; top: number; right: number; bottom: number }, right: { left: number; top: number; right: number; bottom: number }): boolean =>
    Math.min(left.right, right.right) - Math.max(left.left, right.left) > 16
      && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 16;
  for (let index = 0; index < boxes.length; index += 1) {
    for (let other = index + 1; other < boxes.length; other += 1) {
      if (overlapsMaterially(boxes[index], boxes[other])) return true;
    }
    for (const node of nodes) {
      if (boxes[index].memberIds.has(node.id)) continue;
      const size = node.size ?? DEFAULT_NODE_SIZE;
      if (overlapsMaterially(boxes[index], { left: node.position.x, top: node.position.y, right: node.position.x + size.width, bottom: node.position.y + size.height })) return true;
    }
  }
  return false;
}

/** Column layout by dependency depth: importers on the left, imported-by targets to the right. */
export function layoutScopeByDependencyDepth(flow: Flow, scopeSubflowId: string | null): Flow {
  const scopedNodes = flow.nodes.filter((node) => (node.subflowId ?? null) === scopeSubflowId);
  if (scopedNodes.length < 2) return flow;
  const scopedIds = new Set(scopedNodes.map((node) => node.id));
  const scopedEdges = flow.edges.filter((edge) => scopedIds.has(edge.source) && scopedIds.has(edge.target));
  if (!scopedEdges.length) return autoLayoutFlow(flow, scopeSubflowId);

  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const edge of scopedEdges) {
    const list = predecessors.get(edge.target) ?? [];
    list.push(edge.source);
    predecessors.set(edge.target, list);
    const next = successors.get(edge.source) ?? [];
    next.push(edge.target);
    successors.set(edge.source, next);
  }

  // Condense strongly connected components before assigning dependency depth so
  // cyclic subsystems occupy one architectural column instead of arbitrary depths.
  let traversalIndex = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const componentByNode = new Map<string, number>();
  let componentCount = 0;
  const visit = (nodeId: string): void => {
    indices.set(nodeId, traversalIndex);
    lowlinks.set(nodeId, traversalIndex);
    traversalIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);
    for (const target of successors.get(nodeId) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId) as number, lowlinks.get(target) as number));
      } else if (onStack.has(target)) {
        lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId) as number, indices.get(target) as number));
      }
    }
    if (lowlinks.get(nodeId) !== indices.get(nodeId)) return;
    while (stack.length) {
      const member = stack.pop() as string;
      onStack.delete(member);
      componentByNode.set(member, componentCount);
      if (member === nodeId) break;
    }
    componentCount += 1;
  };
  for (const node of scopedNodes) if (!indices.has(node.id)) visit(node.id);

  const membersByComponent = new Map<number, number>();
  for (const component of componentByNode.values()) membersByComponent.set(component, (membersByComponent.get(component) ?? 0) + 1);
  const largestComponent = Math.max(0, ...membersByComponent.values());
  const possibleDirectedEdges = scopedNodes.length * Math.max(1, scopedNodes.length - 1);
  const dense = scopedNodes.length >= 5 && (largestComponent >= 5 || scopedEdges.length / possibleDirectedEdges >= 0.28);
  if (dense) return layoutDenseScope(flow, scopedNodes);

  const componentPredecessors = new Map<number, number[]>();
  for (const edge of scopedEdges) {
    const source = componentByNode.get(edge.source) as number;
    const target = componentByNode.get(edge.target) as number;
    if (source === target) continue;
    const list = componentPredecessors.get(target) ?? [];
    if (!list.includes(source)) list.push(source);
    componentPredecessors.set(target, list);
  }
  const depthMemo = new Map<string, number>();
  const depthFor = (nodeId: string): number => {
    const cached = depthMemo.get(nodeId);
    if (cached !== undefined) return cached;
    const component = componentByNode.get(nodeId) as number;
    const componentParents = componentPredecessors.get(component) ?? [];
    const representativeFor = (candidate: number): string => scopedNodes.find((node) => componentByNode.get(node.id) === candidate)?.id ?? nodeId;
    const depth = componentParents.length ? 1 + Math.max(...componentParents.map((parent) => depthFor(representativeFor(parent)))) : 0;
    for (const node of scopedNodes) if (componentByNode.get(node.id) === component) depthMemo.set(node.id, depth);
    depthMemo.set(nodeId, depth);
    return depth;
  };

  const columns = new Map<number, typeof scopedNodes>();
  for (const node of scopedNodes) {
    const depth = depthFor(node.id);
    const column = columns.get(depth) ?? [];
    column.push(node);
    columns.set(depth, column);
  }

  const positioned = new Map<string, { x: number; y: number }>();
  const sortedDepths = [...columns.keys()].sort((a, b) => a - b);
  for (const depth of sortedDepths) {
    const columnNodes = columns.get(depth) ?? [];
    const ranked = columnNodes
      .map((node) => {
        const parentYs = (predecessors.get(node.id) ?? [])
          .map((parent) => positioned.get(parent)?.y)
          .filter((value): value is number => typeof value === "number");
        return { node, desiredY: parentYs.length ? average(parentYs) : BASE_Y };
      })
      .sort((a, b) => (a.desiredY === b.desiredY ? a.node.title.localeCompare(b.node.title) : a.desiredY - b.desiredY));
    const centerY = average(ranked.map((item) => item.desiredY));
    const startY = Math.max(BASE_Y, centerY - ((ranked.length - 1) * Y_GAP) / 2);
    ranked.forEach((item, index) => {
      positioned.set(item.node.id, { x: BASE_X + depth * X_GAP, y: startY + index * Y_GAP });
    });
  }

  const dependencyLayout = {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const position = positioned.get(node.id);
      return position ? { ...node, position } : node;
    })
  };
  return groupLayoutCollides(dependencyLayout, scopeSubflowId) ? layoutDenseScope(dependencyLayout, scopedNodes) : dependencyLayout;
}

export function layoutImportedFlow(flow: Flow): Flow {
  let laidOut = layoutScopeByDependencyDepth(flow, null);
  for (const subflow of laidOut.subflows) {
    laidOut = layoutScopeByDependencyDepth(laidOut, subflow.id);
  }
  return laidOut;
}
