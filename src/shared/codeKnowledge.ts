import { z } from "zod";
import { graphEdgeEvidenceSchema } from "./schema";

export const codeKnowledgeNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["file", "symbol"]),
  label: z.string(),
  path: z.string(),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  symbolKind: z.string().optional(),
  language: z.string().optional(),
  role: z.string().optional(),
  community: z.string(),
  architectureNodeId: z.string().optional()
});

export const codeKnowledgeEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: z.enum(["contains", "dependency", "calls", "runtime"]),
  evidence: graphEdgeEvidenceSchema
});

export const codeKnowledgeSnapshotSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  source: z.enum(["codebase-import", "evidence-refresh"]),
  nodes: z.array(codeKnowledgeNodeSchema).max(6000),
  edges: z.array(codeKnowledgeEdgeSchema).max(18000),
  communities: z.array(z.object({ id: z.string(), label: z.string(), nodeCount: z.number().int().nonnegative() })).max(512),
  stats: z.object({
    files: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    dependencies: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    availableNodes: z.number().int().nonnegative(),
    availableEdges: z.number().int().nonnegative(),
    truncated: z.boolean(),
    unresolvedImports: z.number().int().nonnegative(),
    resolutionRate: z.number().min(0).max(1)
  })
});

export type CodeKnowledgeNode = z.infer<typeof codeKnowledgeNodeSchema>;
export type CodeKnowledgeEdge = z.infer<typeof codeKnowledgeEdgeSchema>;
export type CodeKnowledgeSnapshot = z.infer<typeof codeKnowledgeSnapshotSchema>;

export type CodeKnowledgeQueryInput = {
  action: "search" | "neighbors" | "path" | "impact";
  query?: string;
  source?: string;
  target?: string;
  direction?: "incoming" | "outgoing" | "both";
  kinds?: CodeKnowledgeEdge["kind"][];
  maxResults?: number;
  maxDepth?: number;
};

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value!))) : fallback;
}

function nodeSummary(node: CodeKnowledgeNode) {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    path: node.path,
    line: node.line,
    symbolKind: node.symbolKind,
    language: node.language,
    community: node.community,
    architectureNodeId: node.architectureNodeId
  };
}

function edgeSummary(edge: CodeKnowledgeEdge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    evidence: {
      origin: edge.evidence.origin,
      confidence: edge.evidence.confidence,
      verification: edge.evidence.verification,
      freshness: edge.evidence.freshness,
      relationKinds: edge.evidence.relationKinds.slice(0, 6),
      locations: edge.evidence.locations.slice(0, 2)
    }
  };
}

function matchingCodeKnowledgeNodes(snapshot: CodeKnowledgeSnapshot, reference: string, limit = 10): CodeKnowledgeNode[] {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) return [];
  const exactId = snapshot.nodes.find((node) => node.id.toLowerCase() === normalized);
  if (exactId) return [exactId];
  const exactPathFile = snapshot.nodes.find((node) => node.kind === "file" && node.path.toLowerCase() === normalized);
  if (exactPathFile) return [exactPathFile];
  const exactLabel = snapshot.nodes.filter((node) => node.label.toLowerCase() === normalized);
  if (exactLabel.length === 1) return exactLabel;
  return snapshot.nodes.filter((node) =>
    node.label.toLowerCase().includes(normalized) ||
    node.path.toLowerCase().includes(normalized) ||
    node.symbolKind?.toLowerCase().includes(normalized) ||
    node.language?.toLowerCase().includes(normalized)
  ).slice(0, limit);
}

function resolveCodeKnowledgeReference(snapshot: CodeKnowledgeSnapshot, reference: string | undefined): { node?: CodeKnowledgeNode; candidates?: CodeKnowledgeNode[]; error?: string } {
  const matches = matchingCodeKnowledgeNodes(snapshot, reference ?? "", 10);
  if (!matches.length) return { error: `No code graph node matched ${JSON.stringify(reference ?? "")}.` };
  if (matches.length > 1) return { candidates: matches, error: `The reference ${JSON.stringify(reference ?? "")} is ambiguous; retry with an exact node id or file path.` };
  return { node: matches[0] };
}

export function queryCodeKnowledgeSnapshot(snapshot: CodeKnowledgeSnapshot, input: CodeKnowledgeQueryInput): Record<string, unknown> {
  const maxResults = boundedInteger(input.maxResults, 20, 1, 40);
  const allowedKinds = new Set(input.kinds?.length ? input.kinds : ["contains", "dependency", "calls", "runtime"]);
  if (input.action === "search") {
    const matches = matchingCodeKnowledgeNodes(snapshot, input.query ?? "", maxResults + 1);
    return { action: input.action, query: input.query, nodes: matches.slice(0, maxResults).map(nodeSummary), omitted: matches.length > maxResults, limit: maxResults };
  }

  const source = resolveCodeKnowledgeReference(snapshot, input.source);
  if (!source.node) return { action: input.action, error: source.error, candidates: source.candidates?.map(nodeSummary).slice(0, 10), limit: maxResults };
  if (input.action === "impact") {
    const impactedIds = [...codeKnowledgeImpact(snapshot, source.node.id, maxResults)];
    const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
    return {
      action: input.action,
      source: nodeSummary(source.node),
      nodes: impactedIds.flatMap((id) => byId.get(id) ? [nodeSummary(byId.get(id)!)] : []),
      direction: "reverse-dependents",
      limit: maxResults,
      bounded: true
    };
  }
  if (input.action === "path") {
    const target = resolveCodeKnowledgeReference(snapshot, input.target);
    if (!target.node) return { action: input.action, source: nodeSummary(source.node), error: target.error, candidates: target.candidates?.map(nodeSummary).slice(0, 10), limit: maxResults };
    const path = shortestCodeKnowledgePath(snapshot, source.node.id, target.node.id, 1000);
    if (!path) return { action: input.action, source: nodeSummary(source.node), target: nodeSummary(target.node), found: false, bounded: true };
    if (path.edgeIds.length > 24) return { action: input.action, source: nodeSummary(source.node), target: nodeSummary(target.node), found: true, omitted: true, reason: "The shortest path exceeds the 24-edge response limit." };
    const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const edgesById = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
    return {
      action: input.action,
      source: nodeSummary(source.node),
      target: nodeSummary(target.node),
      found: true,
      nodes: path.nodeIds.flatMap((id) => nodesById.get(id) ? [nodeSummary(nodesById.get(id)!)] : []),
      edges: path.edgeIds.flatMap((id) => edgesById.get(id) ? [edgeSummary(edgesById.get(id)!)] : []),
      bounded: true
    };
  }

  const direction = input.direction ?? "both";
  const maxDepth = boundedInteger(input.maxDepth, 1, 1, 4);
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const visited = new Set([source.node.id]);
  const edgeIds = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: source.node.id, depth: 0 }];
  for (let cursor = 0; cursor < queue.length && visited.size < maxResults; cursor += 1) {
    const current = queue[cursor]!;
    if (current.depth >= maxDepth) continue;
    for (const edge of snapshot.edges) {
      if (!allowedKinds.has(edge.kind)) continue;
      const outgoing = edge.source === current.id;
      const incoming = edge.target === current.id;
      if ((direction === "outgoing" && !outgoing) || (direction === "incoming" && !incoming) || (direction === "both" && !outgoing && !incoming)) continue;
      const adjacentId = outgoing ? edge.target : edge.source;
      edgeIds.add(edge.id);
      if (!visited.has(adjacentId) && nodesById.has(adjacentId)) {
        visited.add(adjacentId);
        queue.push({ id: adjacentId, depth: current.depth + 1 });
        if (visited.size >= maxResults) break;
      }
    }
  }
  return {
    action: input.action,
    source: nodeSummary(source.node),
    direction,
    depth: maxDepth,
    nodes: [...visited].flatMap((id) => nodesById.get(id) ? [nodeSummary(nodesById.get(id)!)] : []),
    edges: snapshot.edges.filter((edge) => edgeIds.has(edge.id)).slice(0, 80).map(edgeSummary),
    limit: maxResults,
    bounded: true
  };
}

export function codeKnowledgeImpact(snapshot: CodeKnowledgeSnapshot, changedNodeId: string, maxNodes = 128): Set<string> {
  const limit = Math.max(1, Math.min(1000, maxNodes));
  const dependents = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (edge.kind === "contains") continue;
    dependents.set(edge.target, [...(dependents.get(edge.target) ?? []), edge.source]);
  }
  const impacted = new Set([changedNodeId]);
  const queue = [changedNodeId];
  for (let cursor = 0; cursor < queue.length && impacted.size < limit; cursor += 1) {
    const current = queue[cursor];
    for (const dependent of dependents.get(current) ?? []) {
      // source depends on target, so changes propagate from target back to source.
      if (impacted.has(dependent)) continue;
      impacted.add(dependent);
      queue.push(dependent);
      if (impacted.size >= limit) break;
    }
  }
  return impacted;
}

export function shortestCodeKnowledgePath(snapshot: CodeKnowledgeSnapshot, sourceId: string, targetId: string, maxVisited = 1000): { nodeIds: string[]; edgeIds: string[] } | null {
  if (sourceId === targetId) return { nodeIds: [sourceId], edgeIds: [] };
  const adjacency = new Map<string, Array<{ nodeId: string; edgeId: string }>>();
  for (const edge of snapshot.edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), { nodeId: edge.target, edgeId: edge.id }]);
    adjacency.set(edge.target, [...(adjacency.get(edge.target) ?? []), { nodeId: edge.source, edgeId: edge.id }]);
  }
  const visited = new Set([sourceId]);
  const previous = new Map<string, { nodeId: string; edgeId: string }>();
  const queue = [sourceId];
  for (let cursor = 0; cursor < queue.length && visited.size < maxVisited; cursor += 1) {
    const current = queue[cursor];
    for (const adjacent of adjacency.get(current) ?? []) {
      const next = adjacent.nodeId;
      if (visited.has(next)) continue;
      visited.add(next);
      previous.set(next, { nodeId: current, edgeId: adjacent.edgeId });
      if (next === targetId) {
        const nodeIds = [targetId];
        const edgeIds: string[] = [];
        let step = targetId;
        while (step !== sourceId) {
          const parent = previous.get(step);
          if (!parent) return null;
          nodeIds.push(parent.nodeId);
          edgeIds.push(parent.edgeId);
          step = parent.nodeId;
        }
        return { nodeIds: nodeIds.reverse(), edgeIds: edgeIds.reverse() };
      }
      queue.push(next);
    }
  }
  return null;
}
