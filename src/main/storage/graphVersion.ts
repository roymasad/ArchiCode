import { createHash } from "node:crypto";
import type { Flow } from "../../shared/schema";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
}

export function semanticNodeValue(node: Flow["nodes"][number]): Record<string, unknown> {
  const {
    visual: _visual,
    position: _position,
    size: _size,
    updatedAt: _updatedAt,
    attachments: _attachments,
    ...semantic
  } = node;
  return semantic;
}

export function canonicalSemanticNode(node: Flow["nodes"][number]): string {
  return JSON.stringify(stableValue(semanticNodeValue(node)));
}

export function semanticNodeChangedFields(before: Flow["nodes"][number], after: Flow["nodes"][number]): string[] {
  const left = semanticNodeValue(before);
  const right = semanticNodeValue(after);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort()
    .filter((key) => JSON.stringify(stableValue(left[key])) !== JSON.stringify(stableValue(right[key])));
}

function semanticEdge(edge: Flow["edges"][number]): unknown {
  const { evidence, ...semantic } = edge;
  if (!evidence) return semantic;
  const { checkedAt: _checkedAt, freshness: _freshness, ...durableEvidence } = evidence;
  return { ...semantic, evidence: durableEvidence };
}

function semanticFlow(flow: Flow): unknown {
  const { visual: _visual, updatedAt: _updatedAt, nodes, edges, subflows, groups, ...semantic } = flow;
  return {
    ...semantic,
    nodes: nodes.map(semanticNodeValue).sort(compareEntityIds),
    edges: edges.map(semanticEdge).sort(compareEntityIds),
    subflows: subflows.map((item) => ({ ...item })).sort(compareEntityIds),
    groups: groups.map((item) => ({ ...item })).sort(compareEntityIds)
  };
}

function compareEntityIds(left: unknown, right: unknown): number {
  const leftId = String((left as { id?: unknown })?.id ?? "");
  const rightId = String((right as { id?: unknown })?.id ?? "");
  return leftId.localeCompare(rightId);
}

export function canonicalSemanticGraph(flows: Flow[]): string {
  return JSON.stringify(stableValue({
    schemaVersion: 1,
    flows: flows.map(semanticFlow).sort(compareEntityIds)
  }));
}

export function computeGraphVersion(flows: Flow[]): string {
  return `sha256:${createHash("sha256").update(canonicalSemanticGraph(flows)).digest("hex")}`;
}
