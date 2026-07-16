import type { Flow } from "./schema";

export type KnowledgeTraversalDirection = "both" | "outgoing" | "incoming";

export type KnowledgeGraphSlice = {
  nodeIds: string[];
  edgeIds: string[];
  truncated: boolean;
};

export type GraphViewportTransform = { x: number; y: number; scale: number };

/** Zoom while keeping the graph point under the pointer visually stationary. */
export function zoomGraphAtPoint(
  current: GraphViewportTransform,
  pointer: { x: number; y: number },
  factor: number,
  limits: { min: number; max: number }
): GraphViewportTransform {
  const scale = Math.max(limits.min, Math.min(limits.max, current.scale * factor));
  const worldX = (pointer.x - current.x) / current.scale;
  const worldY = (pointer.y - current.y) / current.scale;
  return { scale, x: pointer.x - worldX * scale, y: pointer.y - worldY * scale };
}

export function boundedKnowledgeNeighborhood(
  flow: Flow,
  seedNodeIds: string[],
  options: { depth?: number; maxNodes?: number; maxEdges?: number; direction?: KnowledgeTraversalDirection } = {}
): KnowledgeGraphSlice {
  const depth = Math.max(0, Math.min(8, options.depth ?? 2));
  const maxNodes = Math.max(1, Math.min(256, options.maxNodes ?? 24));
  const maxEdges = Math.max(0, Math.min(512, options.maxEdges ?? 48));
  const direction = options.direction ?? "both";
  const validNodeIds = new Set(flow.nodes.map((node) => node.id));
  const nodeIds: string[] = [];
  const edgeIds: string[] = [];
  const visitedNodes = new Set<string>();
  const visitedEdges = new Set<string>();
  const queue = seedNodeIds.filter((id) => validNodeIds.has(id)).map((id) => ({ id, depth: 0 }));
  let truncated = false;
  for (const seed of queue) {
    if (visitedNodes.has(seed.id)) continue;
    visitedNodes.add(seed.id);
    nodeIds.push(seed.id);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (!current || current.depth >= depth) continue;
    const adjacent = flow.edges.filter((edge) =>
      (direction !== "incoming" && edge.source === current.id) ||
      (direction !== "outgoing" && edge.target === current.id)
    ).sort((left, right) => left.id.localeCompare(right.id));
    for (const edge of adjacent) {
      if (!visitedEdges.has(edge.id)) {
        if (edgeIds.length >= maxEdges) {
          truncated = true;
          continue;
        }
        visitedEdges.add(edge.id);
        edgeIds.push(edge.id);
      }
      const nextId = edge.source === current.id ? edge.target : edge.source;
      if (visitedNodes.has(nextId) || !validNodeIds.has(nextId)) continue;
      if (nodeIds.length >= maxNodes) {
        truncated = true;
        continue;
      }
      visitedNodes.add(nextId);
      nodeIds.push(nextId);
      queue.push({ id: nextId, depth: current.depth + 1 });
    }
  }
  return { nodeIds, edgeIds, truncated };
}

/** Nodes that may depend on the changed node (reverse dependency traversal). */
export function knowledgeImpact(flow: Flow, changedNodeId: string, maxNodes = 24): KnowledgeGraphSlice {
  return boundedKnowledgeNeighborhood(flow, [changedNodeId], {
    depth: 8,
    maxNodes,
    maxEdges: Math.max(0, maxNodes * 2),
    direction: "incoming"
  });
}

export function shortestKnowledgePath(
  flow: Flow,
  sourceNodeId: string,
  targetNodeId: string,
  options: { directed?: boolean; maxVisited?: number } = {}
): { nodeIds: string[]; edgeIds: string[] } | null {
  if (sourceNodeId === targetNodeId) return { nodeIds: [sourceNodeId], edgeIds: [] };
  const maxVisited = Math.max(2, Math.min(2048, options.maxVisited ?? 256));
  const queue = [sourceNodeId];
  const previous = new Map<string, { nodeId: string; edgeId: string }>();
  const visited = new Set([sourceNodeId]);
  for (let cursor = 0; cursor < queue.length && visited.size <= maxVisited; cursor += 1) {
    const current = queue[cursor];
    if (!current) continue;
    const adjacent = flow.edges.filter((edge) => edge.source === current || (!options.directed && edge.target === current));
    for (const edge of adjacent) {
      const next = edge.source === current ? edge.target : edge.source;
      if (visited.has(next)) continue;
      visited.add(next);
      previous.set(next, { nodeId: current, edgeId: edge.id });
      if (next === targetNodeId) {
        const nodeIds = [targetNodeId];
        const edgeIds: string[] = [];
        let step = targetNodeId;
        while (step !== sourceNodeId) {
          const parent = previous.get(step);
          if (!parent) return null;
          nodeIds.push(parent.nodeId);
          edgeIds.push(parent.edgeId);
          step = parent.nodeId;
        }
        return { nodeIds: nodeIds.reverse(), edgeIds: edgeIds.reverse() };
      }
      queue.push(next);
      if (visited.size >= maxVisited) break;
    }
  }
  return null;
}
