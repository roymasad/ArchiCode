import {
  archicodeNodeSchema,
  flowEdgeSchema,
  flowGroupSchema,
  flowSubflowSchema,
  flowSchema,
  type ArchitecturePerspectiveKind,
  type Flow,
  type ResearchGraphOperation
} from "../../shared/schema";
import { applyAnnotationMerges, emitImportOperations, subjectRefForCluster } from "./emit";
import { compileLensPlan, deterministicContractLensPlan, type LensCompilationDiagnostics } from "./lensFlows";
import { normalizeProjectionSemanticScope } from "./semanticTruth";
import type { ArchitectureLensPlan, GraphProjection, ImportAnnotations, ModuleCluster, ModuleEdge, ModuleGraph } from "./types";

const PERSPECTIVE_KIND: Record<GraphProjection["id"], ArchitecturePerspectiveKind> = {
  system: "system-context",
  functional: "product-capabilities",
  "user-journey": "user-journeys",
  runtime: "runtime-integrations",
  data: "data-persistence",
  infrastructure: "cloud-infrastructure",
  code: "modules-components",
  "dependency-health": "dependency-health"
};

const LIMITATIONS: Record<GraphProjection["id"], string[]> = {
  system: ["Repository boundaries and manifests do not prove the live deployment topology."],
  functional: ["Capability names summarize code responsibilities; they are not a substitute for product requirements."],
  "user-journey": ["Only routes and interaction paths visible in source are shown; analytics and undocumented behavior are outside this view."],
  runtime: ["Only statically recoverable entrypoints and matched runtime contracts are shown; dynamic configuration may add paths."],
  data: ["Durable persistence is claimed only when a concrete repository sink is observed; otherwise this lens represents transient state or declared data concepts."],
  infrastructure: ["This reflects repository declarations, not the current state of cloud accounts or deployed resources."],
  code: ["Dense low-value relationships may be reduced for readability; the evidence structure flow retains hierarchical drill-down."],
  "dependency-health": ["Topology indicates coupling risk, not observed incidents, latency, or defect frequency."]
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "perspective";
}

function isRepositoryExternalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".internal") || normalized.endsWith(".local")) return false;
  if (/^(?:127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(normalized)) return false;
  const private172 = normalized.match(/^172\.(\d{1,3})\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
  if (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) return false;
  return true;
}

function perspectiveFlowId(baseFlowId: string, projection: GraphProjection): string {
  return `${baseFlowId}--${slug(PERSPECTIVE_KIND[projection.id])}`;
}

function mergeProjectedEdge(target: ModuleEdge, source: ModuleEdge): ModuleEdge {
  return {
    ...target,
    importCount: target.importCount + source.importCount,
    occurrences: (target.occurrences ?? target.importCount) + (source.occurrences ?? source.importCount),
    sampleImports: [...new Set([...target.sampleImports, ...source.sampleImports])].slice(0, 6),
    importedNames: [...new Set([...(target.importedNames ?? []), ...(source.importedNames ?? [])])].slice(0, 20),
    evidence: [...(target.evidence ?? []), ...(source.evidence ?? [])]
      .filter((item, index, all) => all.findIndex((candidate) => candidate.from === item.from && candidate.to === item.to && candidate.line === item.line && candidate.specifier === item.specifier) === index)
      .slice(0, 16),
    kinds: [...new Set([...(target.kinds ?? []), ...(source.kinds ?? [])])],
    relationKinds: [...new Set([...(target.relationKinds ?? []), ...(source.relationKinds ?? [])])],
    confidence: Math.min(target.confidence ?? 1, source.confidence ?? 1)
  };
}

function condensedDataProjection(graph: ModuleGraph, projection: GraphProjection): { projection: GraphProjection; edges: ModuleEdge[] } {
  if (projection.id !== "data") return { projection, edges: graph.edges };
  const byId = new Map(graph.clusters.map((cluster) => [cluster.id, cluster]));
  const evidenceById = new Map((projection.subjectEvidence ?? []).map((item) => [item.clusterId, item.signals]));
  const representative = (clusterId: string): string => {
    if (!(evidenceById.get(clusterId) ?? []).includes("direct persistence collaborator")) return clusterId;
    let current = byId.get(clusterId);
    while (current && current.tier > 2 && current.parentClusterId && byId.has(current.parentClusterId)) {
      current = byId.get(current.parentClusterId);
    }
    return current?.id ?? clusterId;
  };
  const representativeById = new Map(projection.clusterIds.map((clusterId) => [clusterId, representative(clusterId)]));
  const selected = new Set(representativeById.values());
  const allowedPairs = new Set(projection.edgePairs.map((edge) => `${edge.source}\u0000${edge.target}`));
  const edgesByPair = new Map<string, ModuleEdge>();
  for (const edge of graph.edges) {
    if (!allowedPairs.has(`${edge.source}\u0000${edge.target}`)) continue;
    const source = representativeById.get(edge.source);
    const target = representativeById.get(edge.target);
    if (!source || !target || source === target) continue;
    const projected = { ...edge, source, target };
    const key = `${source}\u0000${target}`;
    const existing = edgesByPair.get(key);
    edgesByPair.set(key, existing ? mergeProjectedEdge(existing, projected) : projected);
  }
  const signalsByRepresentative = new Map<string, Set<string>>();
  for (const clusterId of projection.clusterIds) {
    const targetId = representativeById.get(clusterId) as string;
    const signals = signalsByRepresentative.get(targetId) ?? new Set<string>();
    if (targetId === clusterId) for (const signal of evidenceById.get(clusterId) ?? []) signals.add(signal);
    else signals.add("aggregated direct persistence collaborators");
    signalsByRepresentative.set(targetId, signals);
  }
  const edges = [...edgesByPair.values()];
  return {
    projection: {
      ...projection,
      clusterIds: [...selected],
      edgePairs: edges.map(({ source, target }) => ({ source, target })),
      subjectEvidence: [...signalsByRepresentative].map(([clusterId, signals]) => ({ clusterId, signals: [...signals] }))
    },
    edges
  };
}

function projectionGraph(graph: ModuleGraph, originalProjection: GraphProjection): ModuleGraph {
  const condensed = condensedDataProjection(graph, originalProjection);
  const projection = condensed.projection;
  const clusterById = new Map(graph.clusters.map((cluster) => [cluster.id, cluster]));
  const representativeBySubject = new Map<string, string>();
  const representativeByCluster = new Map<string, string>();
  const selectedIds: string[] = [];
  const evidenceScope = (cluster: ModuleCluster): Set<string> => new Set(cluster.ownedFiles !== undefined ? cluster.ownedFiles : cluster.files);
  const nearEquivalentRepresentative = (cluster: ModuleCluster): string | undefined => {
    if (projection.id === "code" || cluster.catalogItem || cluster.catalogRef) return undefined;
    const scope = evidenceScope(cluster);
    if (scope.size < 3) return undefined;
    for (const selectedId of selectedIds) {
      const selectedCluster = clusterById.get(selectedId);
      if (!selectedCluster || selectedCluster.catalogItem || selectedCluster.catalogRef) continue;
      const selectedScope = evidenceScope(selectedCluster);
      if (selectedScope.size < 3) continue;
      const intersection = [...scope].filter((file) => selectedScope.has(file)).length;
      const union = new Set([...scope, ...selectedScope]).size;
      if (intersection / union >= 0.8) return selectedId;
    }
    return undefined;
  };
  for (const clusterId of projection.clusterIds) {
    const cluster = clusterById.get(clusterId);
    if (!cluster) continue;
    const subjectId = subjectRefForCluster(cluster).id;
    const representative = representativeBySubject.get(subjectId) ?? nearEquivalentRepresentative(cluster) ?? clusterId;
    if (!representativeBySubject.has(subjectId) && representative === clusterId) {
      representativeBySubject.set(subjectId, clusterId);
      selectedIds.push(clusterId);
    }
    representativeBySubject.set(subjectId, representative);
    representativeByCluster.set(clusterId, representative);
  }
  const selected = new Set(selectedIds);
  const pairKeys = new Set(projection.edgePairs.map((edge) => `${edge.source}\u0000${edge.target}`));
  const edgesByPair = new Map<string, ModuleEdge>();
  for (const edge of condensed.edges) {
    if (!pairKeys.has(`${edge.source}\u0000${edge.target}`)) continue;
    const source = representativeByCluster.get(edge.source);
    const target = representativeByCluster.get(edge.target);
    if (!source || !target || source === target) continue;
    const projected = { ...edge, source, target };
    const key = `${source}\u0000${target}`;
    const existing = edgesByPair.get(key);
    // Aliases can expose the same extracted relationship at multiple hierarchy
    // levels. Preserve all evidence but do not double-count the observation.
    edgesByPair.set(key, existing ? {
      ...mergeProjectedEdge(existing, projected),
      importCount: Math.max(existing.importCount, projected.importCount),
      occurrences: Math.max(existing.occurrences ?? existing.importCount, projected.occurrences ?? projected.importCount)
    } : projected);
  }
  const evidenceByRepresentative = new Map<string, Set<string>>();
  for (const item of projection.subjectEvidence ?? []) {
    const clusterId = representativeByCluster.get(item.clusterId);
    if (!clusterId) continue;
    const signals = evidenceByRepresentative.get(clusterId) ?? new Set<string>();
    item.signals.forEach((signal) => signals.add(signal));
    evidenceByRepresentative.set(clusterId, signals);
  }
  const edges = [...edgesByPair.values()];
  const canonicalProjection: GraphProjection = {
    ...projection,
    clusterIds: selectedIds,
    edgePairs: edges.map(({ source, target }) => ({ source, target })),
    subjectEvidence: [...evidenceByRepresentative].map(([clusterId, signals]) => ({ clusterId, signals: [...signals] }))
  };
  return {
    ...graph,
    clusters: graph.clusters
      .filter((cluster) => selected.has(cluster.id))
      .map((cluster): ModuleCluster => {
        if (projection.id !== "code") return { ...cluster, tier: 1, parentClusterId: undefined };
        const parentClusterId = cluster.parentClusterId ? representativeByCluster.get(cluster.parentClusterId) : undefined;
        return {
          ...cluster,
          ...(parentClusterId && selected.has(parentClusterId) && parentClusterId !== cluster.id ? { parentClusterId } : { parentClusterId: undefined })
        };
      }),
    edges,
    projections: [canonicalProjection]
  };
}

function annotationsForPerspective(annotations: ImportAnnotations | null, clusterIds: Set<string>): ImportAnnotations | null {
  if (!annotations) return null;
  return {
    ...annotations,
    clusters: annotations.clusters
      .filter((cluster) => clusterIds.has(cluster.id))
      .map(({ mergeInto: _mergeInto, ...cluster }) => cluster),
    groups: annotations.groups
      .map((group) => ({ ...group, memberClusterIds: group.memberClusterIds.filter((id) => clusterIds.has(id)) }))
      .filter((group) => group.memberClusterIds.length > 0)
  };
}

function graphAndAnnotationsAfterMerges(
  graph: ModuleGraph,
  annotations: ImportAnnotations | null
): { graph: ModuleGraph; annotations: ImportAnnotations | null } {
  if (!annotations) return { graph, annotations };
  const direct = new Map(annotations.clusters.flatMap((cluster) => cluster.mergeInto && cluster.mergeInto !== cluster.id
    ? [[cluster.id, cluster.mergeInto] as const]
    : []));
  if (!direct.size) return { graph, annotations };
  const merged = applyAnnotationMerges(graph, annotations);
  const validIds = new Set(merged.clusters.map((cluster) => cluster.id));
  const resolve = (clusterId: string): string => {
    let current = clusterId;
    const seen = new Set<string>();
    while (direct.has(current) && !seen.has(current)) {
      seen.add(current);
      current = direct.get(current) as string;
    }
    return validIds.has(current) ? current : clusterId;
  };
  const projections = (graph.projections ?? []).map((projection): GraphProjection => {
    const clusterIds = [...new Set(projection.clusterIds.map(resolve).filter((id) => validIds.has(id)))];
    const pairs = new Map<string, { source: string; target: string }>();
    for (const edge of projection.edgePairs) {
      const source = resolve(edge.source);
      const target = resolve(edge.target);
      if (source === target || !validIds.has(source) || !validIds.has(target)) continue;
      pairs.set(`${source}\u0000${target}`, { source, target });
    }
    const evidence = new Map<string, Set<string>>();
    for (const item of projection.subjectEvidence ?? []) {
      const clusterId = resolve(item.clusterId);
      if (!validIds.has(clusterId)) continue;
      const signals = evidence.get(clusterId) ?? new Set<string>();
      item.signals.forEach((signal) => signals.add(signal));
      evidence.set(clusterId, signals);
    }
    return {
      ...projection,
      clusterIds,
      edgePairs: [...pairs.values()],
      subjectEvidence: [...evidence].map(([clusterId, signals]) => ({ clusterId, signals: [...signals] }))
    };
  });
  return {
    graph: { ...merged, projections },
    annotations: {
      ...annotations,
      clusters: annotations.clusters
        .filter((cluster) => validIds.has(cluster.id))
        .map(({ mergeInto: _mergeInto, ...cluster }) => cluster)
    }
  };
}

function flowFromOperations(input: {
  id: string;
  projection: GraphProjection;
  graph: ModuleGraph;
  operations: ResearchGraphOperation[];
  projectName: string;
  checkedAt: string;
  globalLimitations: string[];
}): Flow {
  const nodes = input.operations
    .filter((operation): operation is Extract<ResearchGraphOperation, { kind: "create-node" }> => operation.kind === "create-node")
    .map((operation, index) => archicodeNodeSchema.parse({
      ...operation.node,
      position: { x: 120 + (index % 4) * 340, y: 120 + Math.floor(index / 4) * 230 },
      updatedAt: input.checkedAt
    }));
  const projectNode = nodes.find((node) => node.id === "node-project");
  if (projectNode) {
    const productTitle = projectNode.title.trim() || input.projectName;
    projectNode.type = "perspective";
    projectNode.title = `${productTitle} — ${input.projection.title}`;
    projectNode.description = `${input.projection.question} ${input.projection.description}`;
    projectNode.visual = { ...projectNode.visual, shape: "note" };
    projectNode.customProperties = {
      "Perspective question": input.projection.question,
      Confidence: input.projection.confidence,
      "Evidence basis": input.projection.evidenceBasis.join(", "),
      Limitations: [...LIMITATIONS[input.projection.id], ...input.globalLimitations].join(" ")
    };
  }
  const inclusionByNodeId = new Map((input.projection.subjectEvidence ?? []).map((item) => [
    item.clusterId.replace(/^cluster-/, "node-"),
    item.signals
  ]));
  for (const node of nodes) {
    const signals = inclusionByNodeId.get(node.id);
    if (!signals?.length) continue;
    node.customProperties = { ...node.customProperties, "Included because": signals.join("; ") };
  }
  const edges = input.operations
    .filter((operation): operation is Extract<ResearchGraphOperation, { kind: "create-edge" }> => operation.kind === "create-edge")
    .map((operation) => flowEdgeSchema.parse(operation.edge));
  const groups = input.operations
    .filter((operation): operation is Extract<ResearchGraphOperation, { kind: "create-group" }> => operation.kind === "create-group")
    .map((operation) => flowGroupSchema.parse(operation.group));
  const subflows = input.operations
    .filter((operation): operation is Extract<ResearchGraphOperation, { kind: "create-subflow" }> => operation.kind === "create-subflow")
    .map((operation) => flowSubflowSchema.parse(operation.subflow));
  if (input.projection.id === "system" || input.projection.id === "runtime" || input.projection.id === "infrastructure") {
    const externalNodeIds = new Map<string, string>();
    for (const cluster of input.graph.clusters) {
      const sourceNodeId = cluster.id.replace(/^cluster-/, "node-");
      if (!nodes.some((node) => node.id === sourceNodeId)) continue;
      for (const interaction of cluster.interactions ?? []) {
        if (interaction.kind !== "http-call" && interaction.kind !== "http-url") continue;
        let hostname: string;
        try {
          hostname = new URL(interaction.target).hostname.toLowerCase();
        } catch {
          continue;
        }
        if (!hostname || !isRepositoryExternalHostname(hostname)) continue;
        let targetNodeId = externalNodeIds.get(hostname);
        if (!targetNodeId) {
          targetNodeId = `node-external-${slug(hostname)}`;
          externalNodeIds.set(hostname, targetNodeId);
          nodes.push(archicodeNodeSchema.parse({
            id: targetNodeId,
            type: "external-system",
            title: hostname,
            description: `${hostname} is an external boundary observed in a literal HTTP endpoint. Its internal behavior and ownership are outside this repository.`,
            stage: "draft-approved-production",
            ignored: false,
            flags: [],
            locked: false,
            visual: { shape: "capsule", backgroundColor: "#6f7891" },
            position: { x: 120 + (nodes.length % 4) * 340, y: 120 + Math.floor(nodes.length / 4) * 230 },
            techStack: [],
            acceptanceCriteria: [],
            acceptanceChecks: [],
            subjectRef: { id: `external:${hostname}`, kind: "external-system", evidenceStatus: "observed", scopeFingerprint: hostname },
            customProperties: { "Evidence boundary": "External endpoint literal; implementation not present in this repository" },
            attachments: [],
            todos: [],
            updatedAt: input.checkedAt
          }));
        }
        const edgeId = `edge-${sourceNodeId.replace(/^node-/, "")}--external-${slug(hostname)}`;
        if (edges.some((edge) => edge.id === edgeId)) continue;
        edges.push(flowEdgeSchema.parse({
          id: edgeId,
          source: sourceNodeId,
          target: targetNodeId,
          label: `${interaction.method ?? "HTTP"} ${hostname}`,
          lineStyle: "solid",
          evidence: {
            origin: "extracted",
            confidence: interaction.confidence ?? 0.95,
            relationKinds: ["http", "external-boundary"],
            locations: [{ path: interaction.file, ...(interaction.line ? { line: interaction.line } : {}), fact: interaction.target }],
            analyzerVersion: 1,
            checkedAt: input.checkedAt,
            verification: "verified",
            freshness: "current"
          }
        }));
      }
    }
  }
  const observedRelations = edges.filter((edge) => edge.evidence?.origin === "extracted").length;
  return flowSchema.parse({
    id: input.id,
    name: input.projection.title,
    description: input.projection.description,
    ignored: false,
    perspective: {
      kind: PERSPECTIVE_KIND[input.projection.id],
      source: "codebase-importer",
      generated: true,
      question: input.projection.question,
      confidence: input.projection.confidence,
      evidenceBasis: input.projection.evidenceBasis,
      limitations: [...LIMITATIONS[input.projection.id], ...input.globalLimitations],
      checkedAt: input.checkedAt,
      coverage: {
        subjects: Math.max(0, nodes.length - 1),
        relations: edges.length,
        observedRelations,
        inferredRelations: Math.max(0, edges.length - observedRelations)
      }
    },
    nodes,
    edges,
    subflows,
    groups,
    updatedAt: input.checkedAt
  });
}

/**
 * Keep one evidence-oriented hierarchy and add independently navigable perspective
 * flows. Perspective nodes reuse stable subjectRef values instead of becoming new truths.
 */
export function emitArchitectureAtlasOperations(input: {
  baseFlowId: string;
  moduleGraph: ModuleGraph;
  annotations: ImportAnnotations | null;
  projectName: string;
  codebaseHints: string[];
  checkedAt: string;
  globalLimitations?: string[];
  preparedModuleGraph?: ModuleGraph;
  lensPlans?: ArchitectureLensPlan[];
  expectLensPlans?: boolean;
  repairAttemptedLensIds?: ArchitectureLensPlan["id"][];
}): { operations: ResearchGraphOperation[]; flowIds: string[]; perspectiveFlowIds: string[]; lensDiagnostics: LensCompilationDiagnostics[] } {
  const merged = graphAndAnnotationsAfterMerges(input.moduleGraph, input.annotations);
  const evidenceOperations = emitImportOperations({
    flowId: input.baseFlowId,
    moduleGraph: merged.graph,
    annotations: merged.annotations,
    projectName: input.projectName,
    codebaseHints: input.codebaseHints,
    checkedAt: input.checkedAt,
    preparedModuleGraph: input.preparedModuleGraph
  });
  const operations: ResearchGraphOperation[] = [{
    kind: "update-flow",
    flowId: input.baseFlowId,
    patch: {
      name: "Codebase Structure (Evidence)",
      description: "Code-derived hierarchy, implementation scopes, and evidence-backed relationships. Perspective flows reuse these subjects without becoming separate implementation truths."
    }
  }, ...evidenceOperations];
  const perspectiveFlowIds: string[] = [];
  const lensDiagnostics: LensCompilationDiagnostics[] = [];
  const semanticLensIds = new Set<ArchitectureLensPlan["id"]>(["functional", "user-journey", "data", "infrastructure"]);
  const repairAttempted = new Set(input.repairAttemptedLensIds ?? []);
  for (const projection of merged.graph.projections ?? []) {
    if (!projection.clusterIds.length) continue;
    const graph = projectionGraph(merged.graph, projection);
    if (!graph.clusters.length) continue;
    const effectiveProjection = normalizeProjectionSemanticScope(graph.projections?.[0] ?? projection, merged.graph);
    const flowId = perspectiveFlowId(input.baseFlowId, effectiveProjection);
    const viewOperations = emitImportOperations({
      flowId,
      moduleGraph: graph,
      annotations: annotationsForPerspective(merged.annotations, new Set(graph.clusters.map((cluster) => cluster.id))),
      projectName: input.projectName,
      codebaseHints: input.codebaseHints,
      checkedAt: input.checkedAt
    });
    const fallbackFlow = flowFromOperations({
      id: flowId,
      projection: effectiveProjection,
      graph,
      operations: viewOperations,
      projectName: input.projectName,
      checkedAt: input.checkedAt,
      globalLimitations: input.globalLimitations ?? []
    });
    const semanticLensId = semanticLensIds.has(effectiveProjection.id as ArchitectureLensPlan["id"])
      ? effectiveProjection.id as ArchitectureLensPlan["id"]
      : undefined;
    const plan = semanticLensId ? input.lensPlans?.find((candidate) => candidate.id === semanticLensId) : undefined;
    const compiled = plan ? compileLensPlan({ fallbackFlow, projection: effectiveProjection, plan, graph: merged.graph, checkedAt: input.checkedAt }) : undefined;
    const deterministicPlan = semanticLensId && !compiled?.flow
      ? deterministicContractLensPlan(effectiveProjection, semanticLensId)
      : null;
    const deterministicCompiled = deterministicPlan
      ? compileLensPlan({ fallbackFlow, projection: effectiveProjection, plan: deterministicPlan, graph: merged.graph, checkedAt: input.checkedAt })
      : undefined;
    const missingDiagnostics: LensCompilationDiagnostics | undefined = semanticLensId && !plan && (input.expectLensPlans || Boolean(input.lensPlans?.length)) ? {
      lensId: semanticLensId,
      status: "missing-plan",
      planProvided: false,
      proposedNodes: 0,
      resolvedNodes: 0,
      emittedNodes: 0,
      proposedEdges: 0,
      emittedEdges: 0,
      droppedNodes: [],
      droppedEdges: [],
      normalizedTypes: [],
      issues: ["no provider-authored plan was retained for this detected lens"],
      fallbackUsed: true
    } : undefined;
    const lensDiagnostic = compiled?.diagnostics ?? missingDiagnostics;
    if (lensDiagnostic) {
      lensDiagnostic.repairAttempted = repairAttempted.has(lensDiagnostic.lensId);
      lensDiagnostics.push(lensDiagnostic);
    }
    const fallbackReason = lensDiagnostic?.fallbackUsed
      ? `Provider-authored ${effectiveProjection.title} could not be compiled safely (${lensDiagnostic.issues.join("; ")}); this deterministic technical projection is shown as an explicitly degraded fallback.`
      : undefined;
    const emittedFlow = compiled?.flow ?? deterministicCompiled?.flow ?? (fallbackReason && fallbackFlow.perspective ? flowSchema.parse({
      ...fallbackFlow,
      perspective: {
        ...fallbackFlow.perspective,
        limitations: [...new Set([...fallbackFlow.perspective.limitations, fallbackReason, ...(deterministicPlan && !deterministicCompiled?.flow ? ["Source-observed behavioral contracts were insufficient to compile a safe deterministic mental model."] : [])])]
      }
    }) : fallbackFlow);
    operations.push({
      kind: "create-flow",
      flow: emittedFlow
    });
    perspectiveFlowIds.push(flowId);
  }
  return { operations, flowIds: [input.baseFlowId, ...perspectiveFlowIds], perspectiveFlowIds, lensDiagnostics };
}
