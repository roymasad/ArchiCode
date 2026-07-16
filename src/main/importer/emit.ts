import { createHash } from "node:crypto";
import { nodeVisualShapeSchema, type GraphSubjectRef, type ImplementationScope, type ImplementationScopeClaim, type ResearchGraphOperation } from "../../shared/schema";
import { coherentClusterTitles, lintedEdgeLabel } from "./coherence";
import type { ImportAnnotations, ModuleCluster, ModuleEdge, ModuleGraph } from "./types";

const AREA_PALETTE = ["#4f83cc", "#5fa88a", "#b8875f", "#9a7fc4", "#c47f96", "#6aa4b8", "#a3a05e", "#7f8fc4", "#5faa9f", "#b87f7f"];
const IMPLEMENTATION_SCOPE_ANALYZER_VERSION = 1;
const EDGE_EVIDENCE_ANALYZER_VERSION = 1;
const MAX_IMPLEMENTATION_FILE_HINTS = 6;
const MAX_IMPLEMENTATION_SYMBOL_HINTS = 6;

const SHAPE_BY_UNIT: Record<ModuleCluster["unit"], "rounded" | "rectangle" | "capsule" | "document"> = {
  area: "rounded",
  module: "rectangle",
  component: "capsule",
  file: "document"
};

function nodeIdForCluster(clusterId: string): string {
  return clusterId.replace(/^cluster-/, "node-");
}

export function subjectRefForCluster(cluster: ModuleCluster): GraphSubjectRef {
  // An explicitly empty ownedFiles collection means an organizational parent owns no
  // files directly. Falling back to its descendant files makes that parent impersonate
  // its only child, which can place the same canonical subject into one lens twice.
  const scope = [...new Set(cluster.ownedFiles !== undefined ? cluster.ownedFiles : cluster.files)].sort();
  const symbolScope = (cluster.symbolRefs ?? [])
    .map((symbol) => `${symbol.path}\u0000${symbol.kind}\u0000${symbol.name}`)
    .sort();
  const fingerprintSource = cluster.catalogItem
    ? `catalog-item\n${cluster.catalogItem.file}\n${cluster.catalogItem.key}`
    : cluster.catalogRef
      ? `catalog-registry\n${cluster.catalogRef.file}\n${cluster.catalogRef.callee}`
      : cluster.unit === "component" && symbolScope.length
        ? `symbols\n${symbolScope.join("\n")}`
        : scope.length
          ? scope.join("\n")
          : `aggregate\n${cluster.unit}\n${cluster.path}`;
  const scopeFingerprint = createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 20);
  return {
    id: `code:${scopeFingerprint}`,
    kind: "code",
    evidenceStatus: "observed",
    scopeFingerprint
  };
}

function defaultShapeForCluster(cluster: ModuleCluster): "rounded" | "rectangle" | "capsule" | "document" | "database" | "note" {
  if (cluster.catalogRef) return "note";
  if (cluster.catalogItem) return "document";
  if (/\b(data|assets|content|fixtures|db|database|storage)\b/i.test(cluster.path)) return "database";
  if (cluster.docTitles.length && cluster.files.length <= cluster.docTitles.length + 1) return "document";
  return SHAPE_BY_UNIT[cluster.unit];
}

function defaultDescriptionForCluster(cluster: ModuleCluster, edges: ModuleEdge[]): string {
  if (cluster.catalogRef) {
    const titles = cluster.catalogRef.itemTitles.slice(0, 8).join(", ");
    return `${cluster.title} catalogues ${cluster.catalogRef.itemCount} items registered in ${cluster.catalogRef.file}: ${titles}${cluster.catalogRef.itemCount > 8 ? ", and more entries in the same registry" : ""}.`;
  }
  if (cluster.catalogItem) {
    const note = cluster.catalogItem.note?.trim();
    return note || `${cluster.catalogItem.title} is a catalogued entry (key "${cluster.catalogItem.key}") registered in ${cluster.catalogItem.file}.`;
  }
  const outgoing = edges.filter((edge) => edge.source === cluster.id).length;
  const incoming = edges.filter((edge) => edge.target === cluster.id).length;
  const languageText = cluster.languages.length ? ` written mainly in ${cluster.languages.slice(0, 3).join(", ")}` : "";
  const pathText = cluster.path.startsWith("(") ? "" : ` under ${cluster.path.includes(".") && cluster.files.length === 1 ? cluster.path : `${cluster.path}/`}`;
  const symbolText = cluster.symbols.length ? ` It defines ${cluster.symbols.slice(0, 6).join(", ")}.` : "";
  const keyFilesText = cluster.files.length >= 3 && cluster.topFiles.length ? ` Key files: ${cluster.topFiles.slice(0, 4).join(", ")}.` : "";
  // Line counts only exist for tree-sitter-parsed languages; don't report "(0 lines)" for the rest.
  const locText = cluster.loc > 0 ? ` (${cluster.loc} lines)` : "";
  return `${cluster.title} owns ${cluster.files.length} source file${cluster.files.length === 1 ? "" : "s"}${locText}${pathText}${languageText}.${symbolText}${keyFilesText} It imports from ${outgoing} sibling area${outgoing === 1 ? "" : "s"} and is imported by ${incoming}. This node was generated from the real import graph of the repository.`;
}

/**
 * The description field is the node's anchored source of truth
 * coding agents work from. When the LLM's prose is thin relative to the cluster's size,
 * append deterministic anchors (real files/symbols) rather than accepting vagueness.
 */
function anchoredDescription(llmDescription: string | undefined, cluster: ModuleCluster, edges: ModuleEdge[]): string {
  const base = llmDescription?.trim();
  if (!base) return defaultDescriptionForCluster(cluster, edges);
  if (cluster.files.length < 3 || base.length >= 200 || cluster.catalogItem || cluster.catalogRef) return base;
  const anchors: string[] = [];
  if (cluster.topFiles.length) anchors.push(`Key files: ${cluster.topFiles.slice(0, 4).join(", ")}.`);
  if (cluster.symbols.length) anchors.push(`Exports: ${cluster.symbols.slice(0, 6).join(", ")}.`);
  return anchors.length ? `${base} ${anchors.join(" ")}` : base;
}

function defaultCriteriaForCluster(cluster: ModuleCluster): string[] {
  if (cluster.catalogRef) {
    return [
      `${cluster.title} lists every entry registered in ${cluster.catalogRef.file}`,
      `Adding or removing registry entries in ${cluster.catalogRef.file} is reflected in this catalog`
    ];
  }
  if (cluster.catalogItem) {
    return [`${cluster.catalogItem.title} stays registered under key "${cluster.catalogItem.key}" in ${cluster.catalogItem.file}`];
  }
  return [
    `${cluster.title} covers the files currently under ${cluster.path.startsWith("(") ? "the project root" : `${cluster.path}/`}`,
    `Dependency edges of ${cluster.title} match the import statements found in its source files`
  ];
}

function defaultTechStackForCluster(cluster: ModuleCluster, hints: string[]): string[] {
  const languageLabels: Record<string, string> = {
    javascript: "JavaScript",
    typescript: "TypeScript",
    tsx: "React/TSX",
    python: "Python",
    go: "Go",
    rust: "Rust",
    php: "PHP",
    c: "C",
    cpp: "C++",
    c_sharp: "C#",
    dart: "Dart",
    java: "Java",
    kotlin: "Kotlin",
    swift: "Swift",
    ruby: "Ruby",
    scala: "Scala",
    lua: "Lua",
    elixir: "Elixir",
    vue: "Vue",
    objc: "Objective-C",
    solidity: "Solidity",
    zig: "Zig",
    bash: "Shell"
  };
  const fromLanguages = cluster.languages.map((language) => languageLabels[language] ?? language);
  const fromExternals = cluster.externalDeps.slice(0, 3);
  const stack = [...new Set([...fromLanguages, ...fromExternals])].slice(0, 5);
  return stack.length ? stack : hints.slice(0, 3).length ? hints.slice(0, 3) : ["Source files"];
}

function implementationScope(claims: ImplementationScopeClaim[], checkedAt: string): ImplementationScope {
  return {
    source: "codebase-importer",
    analyzerVersion: IMPLEMENTATION_SCOPE_ANALYZER_VERSION,
    checkedAt,
    claims: claims.slice(0, 24)
  };
}

function uniqueClusterFiles(cluster: ModuleCluster): string[] {
  return [...new Set([...cluster.topFiles, ...cluster.files])];
}

function scopeForCluster(cluster: ModuleCluster, hasChildren: boolean, checkedAt: string): ImplementationScope {
  const relation: ImplementationScopeClaim["relation"] = cluster.catalogRef || cluster.catalogItem ? "share" : hasChildren ? "cover" : "own";
  if (cluster.ownedFiles) {
    const ownedClaims = [...new Set(cluster.ownedFiles)].slice(0, 18).map((file): ImplementationScopeClaim => ({
      relation,
      kind: "file",
      path: file
    }));
    const symbolClaims = (cluster.symbolRefs ?? []).slice(0, MAX_IMPLEMENTATION_SYMBOL_HINTS).map((symbol): ImplementationScopeClaim => ({
      relation,
      kind: symbol.kind === "class" ? "class" : symbol.kind === "function" ? "function" : "symbol",
      path: symbol.path,
      symbol: symbol.name
    }));
    return implementationScope([...ownedClaims, ...symbolClaims], checkedAt);
  }
  const realDirectory = !cluster.path.split("/").some((segment) => segment.startsWith("("))
    && cluster.files.some((file) => file === cluster.path || file.startsWith(`${cluster.path}/`));
  if (hasChildren && realDirectory) {
    return implementationScope([{ relation, kind: "directory", path: cluster.path }], checkedAt);
  }

  const fileClaims = uniqueClusterFiles(cluster).slice(0, MAX_IMPLEMENTATION_FILE_HINTS).map((file): ImplementationScopeClaim => ({
    relation,
    kind: "file",
    path: file
  }));
  const symbolClaims = (cluster.symbolRefs ?? []).slice(0, MAX_IMPLEMENTATION_SYMBOL_HINTS).map((symbol): ImplementationScopeClaim => ({
    relation,
    kind: symbol.kind === "class" ? "class" : symbol.kind === "function" ? "function" : "symbol",
    path: symbol.path,
    symbol: symbol.name
  }));
  return implementationScope([...fileClaims, ...symbolClaims], checkedAt);
}

export function applyAnnotationMerges(graph: ModuleGraph, annotations: ImportAnnotations | null): ModuleGraph {
  if (!annotations) return graph;
  const merges = new Map<string, string>();
  for (const cluster of annotations.clusters) {
    if (cluster.mergeInto && cluster.mergeInto !== cluster.id) merges.set(cluster.id, cluster.mergeInto);
  }
  if (!merges.size) return graph;
  // Annotation merging is a view preparation step. Clone cluster collections so
  // repeated emissions (evidence flow + perspectives) cannot mutate the analyzer graph.
  const sourceClusters = graph.clusters.map((cluster): ModuleCluster => ({
    ...cluster,
    files: [...cluster.files],
    ...(cluster.ownedFiles ? { ownedFiles: [...cluster.ownedFiles] } : {}),
    languages: [...cluster.languages],
    topFiles: [...cluster.topFiles],
    externalDeps: [...cluster.externalDeps],
    docTitles: [...cluster.docTitles],
    symbols: [...cluster.symbols],
    ...(cluster.symbolRefs ? { symbolRefs: cluster.symbolRefs.map((symbol) => ({ ...symbol })) } : {}),
    ...(cluster.routes ? { routes: [...cluster.routes] } : {}),
    ...(cluster.interactions ? { interactions: cluster.interactions.map((interaction) => ({ ...interaction })) } : {})
  }));
  const byId = new Map(sourceClusters.map((cluster) => [cluster.id, cluster]));
  const resolveTarget = (id: string): string => {
    let current = id;
    const seen = new Set<string>();
    while (merges.has(current) && !seen.has(current)) {
      seen.add(current);
      current = merges.get(current) as string;
    }
    return byId.has(current) ? current : id;
  };
  const clusters: ModuleCluster[] = [];
  for (const cluster of sourceClusters) {
    if (merges.has(cluster.id)) {
      const target = byId.get(resolveTarget(cluster.id));
      if (target && target.id !== cluster.id && target.tier === cluster.tier) {
        target.files = [...target.files, ...cluster.files];
        target.loc += cluster.loc;
        target.languages = [...new Set([...target.languages, ...cluster.languages])];
        target.topFiles = [...new Set([...target.topFiles, ...cluster.topFiles])].slice(0, 5);
        target.symbols = [...new Set([...target.symbols, ...cluster.symbols])].slice(0, 12);
        target.symbolRefs = [...(target.symbolRefs ?? []), ...(cluster.symbolRefs ?? [])]
          .filter((symbol, index, all) => all.findIndex((candidate) => candidate.path === symbol.path && candidate.name === symbol.name) === index)
          .slice(0, 12);
        continue;
      }
    }
    clusters.push(cluster);
  }
  const edgeMap = new Map<string, ModuleEdge>();
  for (const edge of graph.edges) {
    const source = resolveTarget(edge.source);
    const target = resolveTarget(edge.target);
    if (source === target) continue;
    const key = `${source} ${target}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.importCount += edge.importCount;
      existing.sampleImports = [...existing.sampleImports, ...edge.sampleImports].slice(0, 3);
      existing.importedNames = [...new Set([...(existing.importedNames ?? []), ...(edge.importedNames ?? [])])].slice(0, 20);
      existing.evidence = [...(existing.evidence ?? []), ...(edge.evidence ?? [])].slice(0, 8);
      existing.kinds = [...new Set([...(existing.kinds ?? []), ...(edge.kinds ?? [])])];
      existing.relationKinds = [...new Set([...(existing.relationKinds ?? []), ...(edge.relationKinds ?? [])])];
      existing.occurrences = (existing.occurrences ?? existing.importCount - edge.importCount) + (edge.occurrences ?? edge.importCount);
      existing.confidence = Math.min(existing.confidence ?? 1, edge.confidence ?? 1);
    } else {
      edgeMap.set(key, { ...edge, source, target });
    }
  }
  return { ...graph, clusters, edges: [...edgeMap.values()] };
}

function hasRuntimeEvidence(edge: ModuleEdge): boolean {
  return (edge.evidence ?? []).some((item) => item.specifier.startsWith("http:") || item.specifier.startsWith("ipc:") || item.specifier.startsWith("hosts:") || item.specifier.startsWith("shared-data:"))
    || (edge.relationKinds ?? []).some((kind) => kind === "http" || kind === "ipc" || kind === "hosts" || kind === "shared-data");
}

function mergeEdgeSignals(target: ModuleEdge, source: ModuleEdge, addWeights: boolean): ModuleEdge {
  const importCount = addWeights ? target.importCount + source.importCount : Math.max(target.importCount, source.importCount);
  const occurrences = addWeights
    ? (target.occurrences ?? target.importCount) + (source.occurrences ?? source.importCount)
    : Math.max(target.occurrences ?? target.importCount, source.occurrences ?? source.importCount);
  return {
    ...target,
    importCount,
    occurrences,
    sampleImports: [...new Set([...target.sampleImports, ...source.sampleImports])].slice(0, 3),
    importedNames: [...new Set([...(target.importedNames ?? []), ...(source.importedNames ?? [])])].slice(0, 20),
    evidence: [...(target.evidence ?? []), ...(source.evidence ?? [])]
      .filter((item, index, all) => all.findIndex((candidate) => candidate.from === item.from && candidate.to === item.to && candidate.line === item.line && candidate.specifier === item.specifier) === index)
      .slice(0, 12),
    kinds: [...new Set([...(target.kinds ?? []), ...(source.kinds ?? [])])],
    relationKinds: [...new Set([...(target.relationKinds ?? []), ...(source.relationKinds ?? [])])],
    confidence: Math.min(target.confidence ?? 1, source.confidence ?? 1)
  };
}

/**
 * A detail flow should add navigable information. One- and two-node folder splits are
 * retained in the parent's evidence instead of creating nearly empty canvases. Two-node
 * flows survive only when they carry a runtime contract or both children are meaningful,
 * non-generic architectural units under a sufficiently substantial parent.
 */
function detailFlowParentIds(graph: ModuleGraph): Set<string> {
  const childrenByParent = new Map<string, ModuleCluster[]>();
  for (const cluster of graph.clusters) {
    if (!cluster.parentClusterId) continue;
    childrenByParent.set(cluster.parentClusterId, [...(childrenByParent.get(cluster.parentClusterId) ?? []), cluster]);
  }
  const result = new Set<string>();
  for (const [parentId, children] of childrenByParent) {
    if (children.length >= 3) {
      result.add(parentId);
      continue;
    }
    if (children.length !== 2) continue;
    const childIds = new Set(children.map((child) => child.id));
    const runtimeContract = graph.edges.some((edge) => childIds.has(edge.source) && childIds.has(edge.target) && hasRuntimeEvidence(edge));
    const parent = graph.clusters.find((cluster) => cluster.id === parentId);
    const genericTitle = /^(app|assets?|config|docs?|lib|src|tests?|other|support|verification support)$/i;
    const meaningfulPair = Boolean(parent && parent.files.length >= 5 && children.every((child) =>
      child.files.length > 0
      && !genericTitle.test(child.title.trim())
      && !child.path.endsWith("/(other)")
    ));
    if (runtimeContract || meaningfulPair) result.add(parentId);
  }
  return result;
}

function clustersVisibleThroughDetailFlows(graph: ModuleGraph, detailParents: Set<string>): ModuleCluster[] {
  const byId = new Map(graph.clusters.map((cluster) => [cluster.id, cluster]));
  const memo = new Map<string, boolean>();
  const visible = (cluster: ModuleCluster): boolean => {
    const cached = memo.get(cluster.id);
    if (cached !== undefined) return cached;
    if (!cluster.parentClusterId) {
      memo.set(cluster.id, true);
      return true;
    }
    const parent = byId.get(cluster.parentClusterId);
    const value = Boolean(parent && detailParents.has(parent.id) && visible(parent));
    memo.set(cluster.id, value);
    return value;
  };
  return graph.clusters.filter(visible);
}

/**
 * Emit an edge only between nodes that share a canvas. Cross-scope evidence is lifted to
 * the closest visible ancestors; when that ancestor edge already exists, it enriches the
 * evidence without double-counting the same file relationship at every hierarchy tier.
 */
function projectEdgesToVisibleScopes(graph: ModuleGraph, visibleClusters: ModuleCluster[]): ModuleEdge[] {
  const allById = new Map(graph.clusters.map((cluster) => [cluster.id, cluster]));
  const visibleIds = new Set(visibleClusters.map((cluster) => cluster.id));
  const parentOf = (cluster: ModuleCluster): ModuleCluster | undefined => cluster.parentClusterId ? allById.get(cluster.parentClusterId) : undefined;
  const nearestVisible = (cluster: ModuleCluster | undefined): ModuleCluster | undefined => {
    let current = cluster;
    while (current && !visibleIds.has(current.id)) current = parentOf(current);
    return current;
  };
  const projectPair = (edge: ModuleEdge): { source: ModuleCluster; target: ModuleCluster } | null => {
    let source = nearestVisible(allById.get(edge.source));
    let target = nearestVisible(allById.get(edge.target));
    while (source && target && source.id !== target.id && (source.parentClusterId ?? null) !== (target.parentClusterId ?? null)) {
      if (source.tier > target.tier) source = nearestVisible(parentOf(source));
      else if (target.tier > source.tier) target = nearestVisible(parentOf(target));
      else {
        source = nearestVisible(parentOf(source));
        target = nearestVisible(parentOf(target));
      }
    }
    return source && target && source.id !== target.id ? { source, target } : null;
  };

  const projected = new Map<string, ModuleEdge>();
  // Prefer the edge already aggregated for a visible canvas; it has the correct weight.
  for (const edge of graph.edges) {
    const source = allById.get(edge.source);
    const target = allById.get(edge.target);
    if (!source || !target || !visibleIds.has(source.id) || !visibleIds.has(target.id)) continue;
    if ((source.parentClusterId ?? null) !== (target.parentClusterId ?? null)) continue;
    projected.set(`${source.id} ${target.id}`, { ...edge });
  }
  for (const edge of graph.edges) {
    const pair = projectPair(edge);
    if (!pair) continue;
    const key = `${pair.source.id} ${pair.target.id}`;
    const lifted = { ...edge, source: pair.source.id, target: pair.target.id };
    const existing = projected.get(key);
    projected.set(key, existing ? mergeEdgeSignals(existing, lifted, false) : lifted);
  }
  return [...projected.values()];
}

function reduceEdgesForDisplay(
  edges: ModuleEdge[],
  clusters: ModuleCluster[],
  edgeLabelMap: Map<string, string>
): ModuleEdge[] {
  const byDirectedPair = new Map(edges.map((edge) => [`${edge.source} ${edge.target}`, edge]));
  const consumed = new Set<string>();
  const reciprocalReduced: ModuleEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.source} ${edge.target}`;
    if (consumed.has(key)) continue;
    const reverseKey = `${edge.target} ${edge.source}`;
    const reverse = byDirectedPair.get(reverseKey);
    if (!reverse || hasRuntimeEvidence(edge) || hasRuntimeEvidence(reverse)) {
      reciprocalReduced.push(edge);
      consumed.add(key);
      continue;
    }
    const label = edgeLabelMap.get(key)?.trim();
    const reverseLabel = edgeLabelMap.get(reverseKey)?.trim();
    if (label && !reverseLabel) {
      reciprocalReduced.push(edge);
    } else if (reverseLabel && !label) {
      reciprocalReduced.push(reverse);
    } else if (label && reverseLabel) {
      reciprocalReduced.push(edge, reverse);
    } else {
      reciprocalReduced.push({ ...mergeEdgeSignals(edge, reverse, true), bidirectional: true });
    }
    consumed.add(key);
    consumed.add(reverseKey);
  }

  // Dense canvases keep every runtime/LLM-labelled relationship, then only the strongest
  // generic dependencies up to a readable budget. The full evidence remains on nodes.
  const clustersByScope = new Map<string, ModuleCluster[]>();
  for (const cluster of clusters) {
    const scope = cluster.parentClusterId ?? "root";
    clustersByScope.set(scope, [...(clustersByScope.get(scope) ?? []), cluster]);
  }
  const edgesByScope = new Map<string, ModuleEdge[]>();
  for (const edge of reciprocalReduced) {
    const source = clusters.find((cluster) => cluster.id === edge.source);
    if (!source) continue;
    const scope = source.parentClusterId ?? "root";
    edgesByScope.set(scope, [...(edgesByScope.get(scope) ?? []), edge]);
  }
  const result: ModuleEdge[] = [];
  for (const [scope, scopedEdges] of edgesByScope) {
    const nodeCount = clustersByScope.get(scope)?.length ?? 0;
    const budget = Math.max(12, nodeCount * 2);
    if (scopedEdges.length <= budget) {
      result.push(...scopedEdges);
      continue;
    }
    const strong = scopedEdges.filter((edge) => hasRuntimeEvidence(edge) || Boolean(edgeLabelMap.get(`${edge.source} ${edge.target}`)?.trim()));
    const weak = scopedEdges
      .filter((edge) => !strong.includes(edge))
      .sort((a, b) => (b.occurrences ?? b.importCount) - (a.occurrences ?? a.importCount));
    result.push(...strong, ...weak.slice(0, Math.max(0, budget - strong.length)));
  }
  return result;
}

/** Final graph projection used by both the edge-label pass and operation emission. */
export function prepareModuleGraphForEmission(graph: ModuleGraph, annotations: ImportAnnotations | null): ModuleGraph {
  const mergedGraph = applyAnnotationMerges(graph, annotations);
  const edgeLabelMap = new Map((annotations?.edgeLabels ?? []).map((edge) => [`${edge.source} ${edge.target}`, edge.label]));
  const detailParents = detailFlowParentIds(mergedGraph);
  const visibleClusters = clustersVisibleThroughDetailFlows(mergedGraph, detailParents);
  return {
    ...mergedGraph,
    clusters: visibleClusters,
    edges: reduceEdgesForDisplay(projectEdgesToVisibleScopes(mergedGraph, visibleClusters), visibleClusters, edgeLabelMap)
  };
}

export function emitImportOperations(input: {
  flowId: string;
  moduleGraph: ModuleGraph;
  annotations: ImportAnnotations | null;
  projectName: string;
  codebaseHints: string[];
  checkedAt: string;
  /** Precomputed before the finalized-edge labeling pass so selection stays stable. */
  preparedModuleGraph?: ModuleGraph;
}): ResearchGraphOperation[] {
  const { flowId, annotations, projectName, codebaseHints, checkedAt } = input;
  const mergedGraph = applyAnnotationMerges(input.moduleGraph, annotations);
  const edgeLabelMap = new Map((annotations?.edgeLabels ?? []).map((edge) => [`${edge.source} ${edge.target}`, edge.label]));
  const moduleGraph = input.preparedModuleGraph ?? prepareModuleGraphForEmission(input.moduleGraph, annotations);
  const detailParents = detailFlowParentIds(mergedGraph);
  const clustersWithAnyChildren = new Set(
    mergedGraph.clusters.map((cluster) => cluster.parentClusterId).filter((id): id is string => Boolean(id))
  );
  const annotationById = new Map((annotations?.clusters ?? []).map((cluster) => [cluster.id, cluster]));
  // Zoom coherence: no parent-echo titles, no indistinguishable twin siblings.
  const finalTitles = coherentClusterTitles(moduleGraph.clusters, (cluster) => annotationById.get(cluster.id)?.title?.trim() || cluster.title);
  const titleFor = (clusterId: string, fallback: string): string => finalTitles.get(clusterId) ?? fallback;
  const roleById = new Map(moduleGraph.clusters.map((cluster) => [cluster.id, cluster.role]));
  const operations: ResearchGraphOperation[] = [];

  const areaColor = new Map<string, string>();
  const tierOne = moduleGraph.clusters.filter((cluster) => cluster.tier === 1);
  tierOne.forEach((cluster, index) => areaColor.set(cluster.id, AREA_PALETTE[index % AREA_PALETTE.length]));
  const lineageColor = (cluster: ModuleCluster): string => {
    let current: ModuleCluster | undefined = cluster;
    const byId = new Map(moduleGraph.clusters.map((item) => [item.id, item]));
    while (current) {
      const color = areaColor.get(current.id);
      if (color) return color;
      current = current.parentClusterId ? byId.get(current.parentClusterId) : undefined;
    }
    return AREA_PALETTE[0];
  };

  // Groups first: nodes referencing groupId validate against flow.groups on apply.
  const groupIdByName = new Map<string, string>();
  const groupByClusterId = new Map<string, string>();
  for (const group of annotations?.groups ?? []) {
    const visibleMembers = group.memberClusterIds.filter((clusterId) => moduleGraph.clusters.some((cluster) => cluster.id === clusterId));
    if (!visibleMembers.length) continue;
    const groupId = `group-${group.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || groupIdByName.size + 1}`;
    if (!groupIdByName.has(group.name)) {
      groupIdByName.set(group.name, groupId);
      operations.push({
        kind: "create-group",
        flowId,
        group: { id: groupId, name: group.name, ...(group.color ? { color: group.color } : {}) }
      });
    }
    for (const clusterId of visibleMembers) {
      groupByClusterId.set(clusterId, groupIdByName.get(group.name) as string);
    }
  }

  // Per-node detail flows: only clusters with children get a subflow ("Opens detail flow"),
  // anchored to the parent node via parentNodeId. Leaves get none — drill-down where it applies.
  const parentsWithChildren = new Set([...detailParents].filter((id) => moduleGraph.clusters.some((cluster) => cluster.id === id)));
  const subflowIdForCluster = (clusterId: string): string => `subflow-${clusterId.replace(/^cluster-/, "")}`;
  const orderedParents = moduleGraph.clusters
    .filter((cluster) => parentsWithChildren.has(cluster.id))
    .sort((a, b) => a.tier - b.tier);
  for (const parent of orderedParents) {
    operations.push({
      kind: "create-subflow",
      flowId,
      subflow: {
        id: subflowIdForCluster(parent.id),
        name: titleFor(parent.id, parent.title),
        ignored: false,
        parentNodeId: nodeIdForCluster(parent.id),
        // The subflow lives in the same scope as its parent node (app convention: linkNodeToSubflow).
        ...(parent.parentClusterId ? { parentSubflowId: subflowIdForCluster(parent.parentClusterId) } : {})
      }
    });
  }

  const shapeFor = (cluster: ModuleCluster): { backgroundColor: string; shape: (typeof nodeVisualShapeSchema)["options"][number] } => {
    const annotation = annotationById.get(cluster.id);
    const parsedShape = annotation?.visual?.shape ? nodeVisualShapeSchema.safeParse(annotation.visual.shape) : null;
    return {
      backgroundColor: annotation?.visual?.backgroundColor && /^#[0-9a-fA-F]{6}$/.test(annotation.visual.backgroundColor)
        ? annotation.visual.backgroundColor
        : lineageColor(cluster),
      shape: parsedShape?.success ? parsedShape.data : defaultShapeForCluster(cluster)
    };
  };

  // Project node at root.
  const projectAnnotation = annotations?.projectNode;
  const projectShape = projectAnnotation?.visual?.shape ? nodeVisualShapeSchema.safeParse(projectAnnotation.visual.shape) : null;
  operations.push({
    kind: "create-node",
    flowId,
    node: {
      id: "node-project",
      type: "project",
      title: projectAnnotation?.title?.trim() || projectName,
      description: projectAnnotation?.description?.trim() || `${projectName} maps ${moduleGraph.clusters.filter((cluster) => cluster.tier === 1).length} top-level areas generated from the repository's real import graph. Open area nodes to drill into deeper levels.`,
      stage: "draft-approved-production",
      ignored: false,
      flags: ["changed"],
      locked: false,
      visual: {
        ...(projectAnnotation?.visual?.backgroundColor && /^#[0-9a-fA-F]{6}$/.test(projectAnnotation.visual.backgroundColor)
          ? { backgroundColor: projectAnnotation.visual.backgroundColor }
          : {}),
        shape: projectShape?.success ? projectShape.data : "hexagon"
      },
      techStack: projectAnnotation?.techStack?.length ? projectAnnotation.techStack.slice(0, 6) : codebaseHints.slice(0, 5),
      acceptanceCriteria: projectAnnotation?.acceptanceCriteria?.length
        ? projectAnnotation.acceptanceCriteria
        : ["The map reflects the current repository structure", "Every top-level area node corresponds to real directories and files"],
      acceptanceChecks: [],
      subjectRef: { id: `concept:project:${projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, kind: "concept", evidenceStatus: "context" },
      implementationScope: implementationScope([{ relation: "cover", kind: "directory", path: "." }], checkedAt),
      customProperties: {
        "Architecture lenses": (moduleGraph.projections ?? []).map((projection) => projection.title).join(", "),
        "Lens evidence": (moduleGraph.projections ?? []).map((projection) => `${projection.title} [${projection.confidence}]: ${projection.evidenceBasis.join(", ")}`).join("; "),
        "Reverse-engineering model": "Canonical code-derived graph with evidence-bounded architectural interpretations"
      },
      attachments: [],
      todos: []
    }
  });

  for (const cluster of moduleGraph.clusters) {
    const annotation = annotationById.get(cluster.id);
    const typeByUnit: Record<ModuleCluster["unit"], string> = { area: "system", module: "module", component: "component", file: "file" };
    const defaultType = cluster.catalogRef ? "catalog" : cluster.catalogItem ? "data" : typeByUnit[cluster.unit];
    operations.push({
      kind: "create-node",
      flowId,
      node: {
        id: nodeIdForCluster(cluster.id),
        type: annotation?.type?.trim() || defaultType,
        title: titleFor(cluster.id, annotation?.title?.trim() || cluster.title),
        description: anchoredDescription(annotation?.description, cluster, moduleGraph.edges),
        stage: "draft-approved-production",
        ignored: false,
        flags: ["changed"],
        locked: false,
        visual: shapeFor(cluster),
        ...(cluster.parentClusterId ? { subflowId: subflowIdForCluster(cluster.parentClusterId) } : {}),
        ...(groupByClusterId.has(cluster.id) ? { groupId: groupByClusterId.get(cluster.id) } : {}),
        techStack: annotation?.techStack?.length ? annotation.techStack.slice(0, 6) : defaultTechStackForCluster(cluster, codebaseHints),
        acceptanceCriteria: annotation?.acceptanceCriteria?.length ? annotation.acceptanceCriteria : defaultCriteriaForCluster(cluster),
        acceptanceChecks: [],
        subjectRef: subjectRefForCluster(cluster),
        implementationScope: scopeForCluster(cluster, clustersWithAnyChildren.has(cluster.id), checkedAt),
        customProperties: {
          "Code role": cluster.role ?? "unknown",
          "Mental lenses": (moduleGraph.projections ?? [])
            .filter((projection) => projection.clusterIds.includes(cluster.id))
            .map((projection) => projection.title)
            .join(", "),
          "Lens confidence": (moduleGraph.projections ?? [])
            .filter((projection) => projection.clusterIds.includes(cluster.id))
            .map((projection) => `${projection.title}: ${projection.confidence}`)
            .join(", "),
          "Evidence basis": `${cluster.files.length} files; ${cluster.symbols.length} symbols; ${(cluster.routes ?? []).length} routes; ${(cluster.interactions ?? []).length} runtime interactions`,
          "Interpretation boundary": "Membership and relationships are code-derived; responsibility naming is architecturally inferred",
          "Dependency centrality": (cluster.metrics?.centrality ?? 0).toFixed(2),
          "Entrypoint reachable": cluster.metrics?.entrypointReachable ? "yes" : "no",
          "Dependency cycle": cluster.metrics?.cyclic ? "yes" : "no",
          "Dependency community": cluster.communityId ?? "isolated",
          "Repository boundary": cluster.boundary ? `${cluster.boundary.kind}: ${cluster.boundary.path}` : "none",
          "Routes": (cluster.routes ?? []).join(", "),
          "Runtime interactions": (cluster.interactions ?? []).map((interaction) => `${interaction.kind}:${interaction.target}`).join(", ")
        },
        attachments: [],
        todos: []
      }
    });
  }

  for (const edge of moduleGraph.edges) {
    const label = lintedEdgeLabel(edgeLabelMap.get(`${edge.source} ${edge.target}`));
    const kinds = edge.kinds ?? [];
    const dynamic = kinds.includes("dynamic");
    const structural = kinds.length > 0 && kinds.every((kind) => kind === "reexport" || kind === "mod");
    // Dev-time relationships (tests/tooling exercising the product) must not read like
    // runtime architecture arrows: thin and dotted so the context story stays product-first.
    const devTime = roleById.get(edge.source) === "test" || roleById.get(edge.source) === "tooling";
    const kindLabel = edge.relationKinds?.length ? edge.relationKinds.join("/") : kinds.length ? kinds.join("/") : "imports";
    const occurrenceCount = edge.occurrences ?? edge.importCount;
    const runtimeContracts = [...new Set((edge.evidence ?? []).map((item) => item.specifier).filter((specifier) => specifier.startsWith("ipc:") || specifier.startsWith("http:") || specifier.startsWith("hosts:") || specifier.startsWith("shared-data:")))];
    const runtimeEvidence = runtimeContracts[0];
    const evidenceLocations = [...new Map((edge.evidence ?? []).map((item) => [
      `${item.from}:${item.line ?? ""}:${item.specifier}`,
      {
        path: item.from,
        ...(item.line ? { line: item.line } : {}),
        ...(item.specifier ? { fact: item.specifier } : {})
      }
    ])).values()].slice(0, 16);
    const confidence = Math.max(0, Math.min(1, edge.confidence ?? 1));
    const evidenceOrigin = runtimeContracts.length || confidence < 1
      ? confidence >= 0.85 ? "resolved" as const : "inferred" as const
      : "extracted" as const;
    const verification = evidenceOrigin === "extracted"
      ? "verified" as const
      : evidenceOrigin === "resolved"
        ? "unresolved" as const
        : "ambiguous" as const;
    const evidenceLabel = runtimeContracts.length > 1
      ? `${runtimeContracts.length} ${runtimeContracts.every((contract) => contract.startsWith("http:")) ? "HTTP contracts" : runtimeContracts.every((contract) => contract.startsWith("ipc:")) ? "IPC channels" : "runtime contracts"}`
      : runtimeEvidence?.startsWith("ipc:")
        ? `IPC ${runtimeEvidence.slice(4)} (${occurrenceCount})`
          : runtimeEvidence?.startsWith("http:")
            ? `HTTP ${runtimeEvidence.slice(5)} (${occurrenceCount})`
          : runtimeEvidence?.startsWith("shared-data:")
            ? `shares data key ${runtimeEvidence.slice("shared-data:".length)} (${occurrenceCount})`
          : runtimeEvidence?.startsWith("hosts:")
            ? "hosts the Flutter runtime"
        : edge.importedNames?.length
          ? `${edge.relationKinds?.includes("calls") ? "calls" : edge.relationKinds?.includes("type-only") ? "imports types" : "imports"} ${edge.importedNames.slice(0, 4).join(", ")}${edge.importedNames.length > 4 ? ` +${edge.importedNames.length - 4}` : ""} (${occurrenceCount})`
          : kinds.length
            ? `${kindLabel} (${occurrenceCount})`
            : `imports (${edge.importCount} file${edge.importCount === 1 ? "" : "s"})`;
    operations.push({
      kind: "create-edge",
      flowId,
      edge: {
        id: `edge-${edge.source.replace(/^cluster-/, "")}--${edge.target.replace(/^cluster-/, "")}`,
        source: nodeIdForCluster(edge.source),
        target: nodeIdForCluster(edge.target),
        label: label || evidenceLabel,
        lineStyle: devTime ? "dotted" : dynamic ? "dashed" : structural ? "dotted" : "solid",
        animated: dynamic && !devTime,
        ...(edge.bidirectional ? { bidirectional: true } : {}),
        evidence: {
          origin: evidenceOrigin,
          confidence,
          relationKinds: [...new Set([...(edge.relationKinds ?? []), ...kinds])].slice(0, 12),
          locations: evidenceLocations,
          analyzerVersion: EDGE_EVIDENCE_ANALYZER_VERSION,
          checkedAt,
          verification,
          freshness: "current"
        }
        // No width: imported edges always use the app's default preset. Computed widths
        // (log-scaled occurrences) produced arbitrary values like 4.8px that fight the
        // UI's Default/3/4/6 presets and vary the arrowhead gap.
      }
    });
  }

  return operations;
}
