import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Flow } from "../../shared/schema";
import { codeKnowledgeSnapshotSchema, type CodeKnowledgeEdge, type CodeKnowledgeNode, type CodeKnowledgeSnapshot } from "../../shared/codeKnowledge";
import { projectStatePath, readJson, writeJson } from "../storage/persistence";
import type { FileDependencyGraph, ModuleGraph, ParsedFile, RepoScan } from "./types";

const SNAPSHOT_FILE = "code-knowledge.json";
const MAX_NODES = 6000;
const MAX_EDGES = 18000;
const MAX_SYMBOLS_PER_FILE = 40;

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha1").update(value).digest("hex").slice(0, 16)}`;
}

function moduleGraphCommunityLabels(moduleGraph: ModuleGraph | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!moduleGraph) return result;
  const byCommunity = new Map<string, typeof moduleGraph.clusters>();
  for (const cluster of moduleGraph.clusters) {
    if (!cluster.communityId) continue;
    byCommunity.set(cluster.communityId, [...(byCommunity.get(cluster.communityId) ?? []), cluster]);
  }
  for (const [community, clusters] of byCommunity) {
    const representative = [...clusters].sort((left, right) => (right.metrics?.centrality ?? 0) - (left.metrics?.centrality ?? 0) || left.title.localeCompare(right.title))[0];
    result.set(community, representative ? `Around ${representative.title}` : community);
  }
  return result;
}

function flowCommunityLabels(flow: Flow | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!flow) return result;
  const degree = new Map<string, number>();
  for (const edge of flow.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const byCommunity = new Map<string, Flow["nodes"]>();
  for (const node of flow.nodes) {
    const community = node.customProperties?.["Dependency community"]?.trim();
    if (!community || community === "isolated") continue;
    byCommunity.set(community, [...(byCommunity.get(community) ?? []), node]);
  }
  for (const [community, nodes] of byCommunity) {
    const representative = [...nodes].sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.title.localeCompare(right.title))[0];
    result.set(community, representative ? `Around ${representative.title}` : community);
  }
  return result;
}

function architectureAssignmentFromModuleGraph(moduleGraph: ModuleGraph | undefined, communityLabels: Map<string, string>, filePath: string): { community: string; architectureNodeId?: string } | null {
  if (!moduleGraph) return null;
  const cluster = moduleGraph.clusters
    .filter((candidate) => candidate.files.includes(filePath))
    .sort((left, right) => right.tier - left.tier || left.files.length - right.files.length)[0];
  if (!cluster) return null;
  return {
    community: (cluster.communityId && communityLabels.get(cluster.communityId)) || cluster.title,
    architectureNodeId: cluster.id.replace(/^cluster-/, "node-")
  };
}

function architectureAssignmentFromFlow(flow: Flow | undefined, communityLabels: Map<string, string>, filePath: string, allPaths: string[]): { community: string; architectureNodeId?: string } | null {
  if (!flow) return null;
  const candidates = flow.nodes.flatMap((node) => {
    const claims = node.implementationScope?.claims ?? [];
    let specificity = Number.POSITIVE_INFINITY;
    for (const claim of claims) {
      const normalized = claim.path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
      if (claim.kind === "directory") {
        const matches = normalized === "." || filePath === normalized || filePath.startsWith(`${normalized}/`);
        if (matches) specificity = Math.min(specificity, allPaths.filter((path) => normalized === "." || path === normalized || path.startsWith(`${normalized}/`)).length);
      } else if (normalized === filePath) {
        specificity = 1;
      }
    }
    return Number.isFinite(specificity) ? [{ node, specificity }] : [];
  }).sort((left, right) => left.specificity - right.specificity || left.node.title.localeCompare(right.node.title));
  const selected = candidates[0]?.node;
  if (!selected) return null;
  const groupName = selected.groupId ? flow.groups.find((group) => group.id === selected.groupId)?.name : undefined;
  const subflowName = selected.subflowId ? flow.subflows.find((subflow) => subflow.id === selected.subflowId)?.name : undefined;
  const dependencyCommunity = selected.customProperties?.["Dependency community"];
  return {
    community: groupName || subflowName || (dependencyCommunity && communityLabels.get(dependencyCommunity)) || selected.title,
    architectureNodeId: selected.id
  };
}

export function buildCodeKnowledgeSnapshot(input: {
  scan: RepoScan;
  parsed: ParsedFile[];
  fileGraph: FileDependencyGraph;
  source: CodeKnowledgeSnapshot["source"];
  moduleGraph?: ModuleGraph;
  flow?: Flow;
  generatedAt?: string;
}): CodeKnowledgeSnapshot {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const allPaths = input.scan.files.map((file) => file.relPath);
  const flowCommunityNames = flowCommunityLabels(input.flow);
  const moduleCommunityNames = moduleGraphCommunityLabels(input.moduleGraph);
  const relationshipPaths = new Set(input.fileGraph.edges.flatMap((edge) => [edge.from, edge.to]));
  const knowledgeFiles = input.scan.files.filter((file) => Boolean(file.language) || relationshipPaths.has(file.relPath));
  const parsedByPath = new Map(input.parsed.map((file) => [file.relPath, file]));
  const nodes: CodeKnowledgeNode[] = [];
  const edges: CodeKnowledgeEdge[] = [];
  const fileNodeId = new Map<string, string>();
  const fileNodeByPath = new Map<string, CodeKnowledgeNode>();
  const symbolsByName = new Map<string, CodeKnowledgeNode[]>();
  let availableSymbols = 0;

  for (const file of knowledgeFiles) {
    if (nodes.length >= MAX_NODES) break;
    const assignment = architectureAssignmentFromFlow(input.flow, flowCommunityNames, file.relPath, allPaths)
      ?? architectureAssignmentFromModuleGraph(input.moduleGraph, moduleCommunityNames, file.relPath)
      ?? { community: file.relPath.split("/")[0] || "project" };
    const id = stableId("file", file.relPath);
    fileNodeId.set(file.relPath, id);
    const node: CodeKnowledgeNode = {
      id,
      kind: "file",
      label: file.relPath.split("/").pop() || file.relPath,
      path: file.relPath,
      language: file.language ?? undefined,
      role: file.role,
      community: assignment.community,
      architectureNodeId: assignment.architectureNodeId
    };
    nodes.push(node);
    fileNodeByPath.set(file.relPath, node);
  }

  for (const parsed of input.parsed) {
    const parentId = fileNodeId.get(parsed.relPath);
    if (!parentId) continue;
    const assignment = fileNodeByPath.get(parsed.relPath);
    const candidates = (parsed.semanticSymbols?.length ? parsed.semanticSymbols : parsed.symbolRefs ?? []).slice(0, MAX_SYMBOLS_PER_FILE);
    availableSymbols += parsed.semanticSymbols?.length ?? parsed.symbolRefs?.length ?? 0;
    for (const [index, symbol] of candidates.entries()) {
      if (nodes.length >= MAX_NODES) break;
      const span = symbol as typeof symbol & { startLine?: number; endLine?: number };
      const line = typeof span.startLine === "number" ? span.startLine : undefined;
      const endLine = typeof span.endLine === "number" ? span.endLine : undefined;
      const id = stableId("symbol", `${parsed.relPath}:${line ?? index}:${symbol.kind}:${symbol.name}`);
      const node: CodeKnowledgeNode = {
        id,
        kind: "symbol",
        label: symbol.name,
        path: parsed.relPath,
        line,
        endLine,
        symbolKind: symbol.kind,
        language: parsed.language,
        role: "symbol",
        community: assignment?.community ?? "project",
        architectureNodeId: assignment?.architectureNodeId
      };
      nodes.push(node);
      symbolsByName.set(symbol.name, [...(symbolsByName.get(symbol.name) ?? []), node]);
      if (edges.length < MAX_EDGES) {
        edges.push({
          id: stableId("contains", `${parentId}:${id}`),
          source: parentId,
          target: id,
          kind: "contains",
          evidence: { origin: "extracted", confidence: 1, relationKinds: ["contains"], locations: [{ path: parsed.relPath, ...(line ? { line } : {}), symbol: symbol.name }], analyzerVersion: 1, checkedAt: generatedAt, verification: "verified", freshness: "current" }
        });
      }
    }
  }

  let dependencyCount = 0;
  for (const dependency of input.fileGraph.edges) {
    const source = fileNodeId.get(dependency.from);
    const target = fileNodeId.get(dependency.to);
    if (!source || !target) continue;
    dependencyCount += 1;
    if (edges.length >= MAX_EDGES) continue;
    const confidence = dependency.confidence ?? 1;
    const runtime = dependency.relationKinds?.some((kind) => ["ipc", "http", "hosts", "runtime-load"].includes(kind)) ?? false;
    edges.push({
      id: stableId("dependency", `${dependency.from}:${dependency.to}:${(dependency.relationKinds ?? []).join(",")}`),
      source,
      target,
      kind: runtime ? "runtime" : "dependency",
      evidence: {
        origin: runtime || confidence < 1 ? "resolved" : "extracted",
        confidence,
        relationKinds: [...new Set([...(dependency.relationKinds ?? []), ...(dependency.kinds ?? [])])].slice(0, 12),
        locations: (dependency.evidence ?? []).slice(0, 8).map((item) => ({ path: dependency.from, ...(item.line ? { line: item.line } : {}), fact: item.specifier })),
        analyzerVersion: 1,
        checkedAt: generatedAt,
        verification: runtime || confidence < 1 ? (confidence >= 0.85 ? "unresolved" : "ambiguous") : "verified",
        freshness: confidence >= 0.85 ? "current" : "stale"
      }
    });
  }

  let callCount = 0;
  for (const dependency of input.fileGraph.edges) {
    const source = fileNodeId.get(dependency.from);
    if (!source) continue;
    for (const call of dependency.callEvidence ?? []) {
      const targets = (symbolsByName.get(call.importedName) ?? []).filter((candidate) => candidate.path === dependency.to);
      if (targets.length !== 1) continue;
      callCount += 1;
      if (edges.length >= MAX_EDGES) continue;
      const target = targets[0];
      edges.push({
        id: stableId("calls", `${dependency.from}:${target.id}:${call.line}:${call.localName}`),
        source,
        target: target.id,
        kind: "calls",
        evidence: { origin: "resolved", confidence: 0.95, relationKinds: ["calls"], locations: [{ path: dependency.from, line: call.line, fact: `${call.kind}:${call.localName}` }], analyzerVersion: 1, checkedAt: generatedAt, verification: "unresolved", freshness: "current" }
      });
    }
  }

  const communityCounts = new Map<string, number>();
  for (const node of nodes) communityCounts.set(node.community, (communityCounts.get(node.community) ?? 0) + 1);
  const availableNodes = knowledgeFiles.length + availableSymbols;
  const availableEdges = input.fileGraph.edges.length + availableSymbols + callCount;
  return codeKnowledgeSnapshotSchema.parse({
    version: 1,
    generatedAt,
    source: input.source,
    nodes,
    edges,
    communities: [...communityCounts].map(([id, nodeCount]) => ({ id, label: id, nodeCount })).sort((left, right) => right.nodeCount - left.nodeCount),
    stats: {
      files: nodes.filter((node) => node.kind === "file").length,
      symbols: nodes.filter((node) => node.kind === "symbol").length,
      dependencies: dependencyCount,
      calls: callCount,
      availableNodes,
      availableEdges,
      truncated: nodes.length < availableNodes || edges.length < availableEdges,
      unresolvedImports: input.fileGraph.unresolved.length,
      resolutionRate: input.fileGraph.resolutionRate
    }
  });
}

export async function writeCodeKnowledgeSnapshot(projectRoot: string, snapshot: CodeKnowledgeSnapshot): Promise<void> {
  await writeJson(projectStatePath(projectRoot, "runtime", SNAPSHOT_FILE), codeKnowledgeSnapshotSchema.parse(snapshot));
}

export async function readCodeKnowledgeSnapshot(projectRoot: string): Promise<CodeKnowledgeSnapshot | null> {
  const raw = await readJson<unknown>(projectStatePath(projectRoot, "runtime", SNAPSHOT_FILE), null);
  const parsed = codeKnowledgeSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function codeKnowledgeSnapshotNeedsRefresh(projectRoot: string, snapshot: CodeKnowledgeSnapshot): Promise<boolean> {
  const generatedAt = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generatedAt)) return true;
  const paths = new Set<string>([projectRoot]);
  for (const node of snapshot.nodes) {
    if (node.kind !== "file") continue;
    paths.add(path.resolve(projectRoot, node.path));
    let directory = path.dirname(node.path);
    while (directory && directory !== ".") {
      paths.add(path.resolve(projectRoot, directory));
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const candidates = [...paths];
  for (let offset = 0; offset < candidates.length; offset += 64) {
    const changed = await Promise.all(candidates.slice(offset, offset + 64).map(async (candidate) => {
      try {
        return (await stat(candidate)).mtimeMs > generatedAt;
      } catch {
        return true;
      }
    }));
    if (changed.some(Boolean)) return true;
  }
  return false;
}
