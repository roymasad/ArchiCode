import path from "node:path";
import type { ModuleGraph, RepoScan } from "./types";
import { subjectRefForCluster } from "./emit";

export type ImportQualityReport = {
  sourceCoverage: number;
  uniqueClusterIds: boolean;
  typedEdgeRate: number;
  entrypointCoverage: number;
  parserCoverage: number;
  structuralFallbackFiles: number;
  projectionCount: number;
  perspectiveCoverage: Array<{
    id: string;
    subjects: number;
    relations: number;
    confidence: "high" | "medium" | "exploratory";
  }>;
  cycleCount: number;
  architectureFitnessScore: number;
  architectureCriticalIssues: number;
  warnings: string[];
};

export type ArchitectureFitness = {
  score: number;
  criticalIssues: string[];
  warnings: string[];
};

function projectionFor(graph: ModuleGraph, id: string) {
  return graph.projections?.find((projection) => projection.id === id);
}

function architectureSignal(cluster: ModuleGraph["clusters"][number], pattern: RegExp): boolean {
  return pattern.test([
    cluster.path,
    cluster.title,
    ...cluster.files,
    ...cluster.symbols,
    ...cluster.externalDeps,
    ...(cluster.routes ?? []),
    ...(cluster.interactions ?? []).flatMap((interaction) => [interaction.kind, interaction.target, interaction.reference ?? ""])
  ].join(" "));
}

function isSystemEntrypoint(file: string, cluster: ModuleGraph["clusters"][number]): boolean {
  const basename = path.posix.basename(file).toLowerCase();
  if (!/^index\.[^.]+$/.test(basename)) return true;
  if (file.split("/").length <= 2) return true;
  const boundaryPath = cluster.boundary?.path;
  return Boolean(boundaryPath && boundaryPath !== "." && (file === boundaryPath || file.startsWith(`${boundaryPath}/`)));
}

function isArchitecturalBoundaryInteraction(interaction: NonNullable<ModuleGraph["clusters"][number]["interactions"]>[number]): boolean {
  return ["http-route", "http-call", "http-url", "ipc-handle", "ipc-send", "platform-host"].includes(interaction.kind)
    && !/(?:^|\/)(?:__|@vite)|open-in-editor/i.test(interaction.target);
}

export function mixedRuntimeBoundaryIssues(graph: ModuleGraph): string[] {
  const clientResponsibility = /(?:^|\/)(?:ui|view|views|screen|screens|page|pages|component|components|widget|widgets|store|stores|state)(?:\/|\.)/i;
  return graph.clusters.flatMap((cluster) => {
    const ownedFiles = cluster.ownedFiles ?? cluster.files;
    const routeBoundaryFiles = [...new Set((cluster.interactions ?? [])
      .filter((interaction) => ["http-route", "ipc-handle", "platform-host"].includes(interaction.kind) && ownedFiles.includes(interaction.file))
      .map((interaction) => interaction.file))];
    const clientFiles = ownedFiles.filter((file) => clientResponsibility.test(file));
    return routeBoundaryFiles.length && clientFiles.length
      ? [`${cluster.title} combines runtime/trust-boundary files (${routeBoundaryFiles.join(", ")}) with client UI/application-state files (${clientFiles.join(", ")}).`]
      : [];
  });
}

/**
 * Scores the usefulness contracts that must hold regardless of language or stack.
 * This intentionally uses repository signals rather than a technology allow-list.
 */
export function evaluateArchitectureFitness(graph: ModuleGraph, scan: RepoScan): ArchitectureFitness {
  const criticalIssues: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(graph.clusters.map((cluster) => [cluster.id, cluster]));
  const system = projectionFor(graph, "system");
  const functional = projectionFor(graph, "functional");
  const code = projectionFor(graph, "code");
  const entrypointClusters = graph.clusters.filter((cluster) => cluster.files.some((file) => graph.entrypoints.includes(file) && isSystemEntrypoint(file, cluster)));
  criticalIssues.push(...mixedRuntimeBoundaryIssues(graph));
  const systemIds = new Set(system?.clusterIds ?? []);
  const systemCoversEntrypoint = (cluster: ModuleGraph["clusters"][number]): boolean => {
    let current: typeof cluster | undefined = cluster;
    while (current) {
      if (systemIds.has(current.id)) return true;
      current = current.parentClusterId ? byId.get(current.parentClusterId) : undefined;
    }
    return false;
  };

  if (!system?.clusterIds.length) criticalIssues.push("System Context has no implementation subjects.");
  if (entrypointClusters.some((cluster) => !systemCoversEntrypoint(cluster))) {
    criticalIssues.push("System Context omits one or more detected application/service entrypoints.");
  }
  if ((system?.clusterIds.length ?? 0) > 1 && !system?.edgePairs.length && graph.edges.length) {
    warnings.push("System Context contains multiple boundaries but no visible relationships.");
  }
  if (system) {
    const systemClusters = system.clusterIds.flatMap((id) => byId.get(id) ? [byId.get(id) as ModuleGraph["clusters"][number]] : []);
    const boundaryClusters = systemClusters.filter((cluster) => cluster.files.some((file) => graph.entrypoints.includes(file) && isSystemEntrypoint(file, cluster))
      || cluster.interactions?.some(isArchitecturalBoundaryInteraction));
    if (systemClusters.length >= 3 && boundaryClusters.length < Math.min(2, systemClusters.length)) {
      criticalIssues.push("System Context is dominated by internal implementation areas instead of observed process, trust, entrypoint, or external boundaries.");
    }
    const uncoveredBoundaryFiles = [...new Set(graph.clusters.flatMap((cluster) => (cluster.interactions ?? [])
      .filter(isArchitecturalBoundaryInteraction)
      .map((interaction) => interaction.file)))]
      .filter((file) => !systemClusters.some((cluster) => cluster.files.includes(file)));
    if (uncoveredBoundaryFiles.length) criticalIssues.push(`System Context omits observed runtime boundary files: ${uncoveredBoundaryFiles.slice(0, 6).join(", ")}.`);
  }
  if (!functional?.clusterIds.length) criticalIssues.push("Product Capabilities has no implementation responsibilities.");
  if (functional?.behavioralContracts?.length) {
    const functionalClusters = functional.clusterIds.flatMap((id) => byId.get(id) ? [byId.get(id) as ModuleGraph["clusters"][number]] : []);
    const uncoveredBehaviorFiles = [...new Set(functional.behavioralContracts.map((contract) => contract.file))]
      .filter((file) => !functionalClusters.some((cluster) => cluster.files.includes(file)));
    if (uncoveredBehaviorFiles.length) criticalIssues.push(`Product Capabilities omits source-observed behavioral contract files: ${uncoveredBehaviorFiles.slice(0, 6).join(", ")}.`);
  }
  if (!code?.clusterIds.length) criticalIssues.push("Modules & Components has no implementation subjects.");

  const runtime = projectionFor(graph, "runtime");
  if (runtime) {
    const runtimeClusters = runtime.clusterIds.flatMap((id) => byId.get(id) ? [byId.get(id) as ModuleGraph["clusters"][number]] : []);
    const observedChannels = graph.clusters.flatMap((cluster) => (cluster.interactions ?? [])
      .filter((interaction) => ["http-call", "http-url", "http-route", "ipc-handle", "ipc-send", "platform-host", "shared-read", "shared-write"].includes(interaction.kind)));
    const missingChannelFiles = [...new Set(observedChannels.map((interaction) => interaction.file))]
      .filter((file) => !runtimeClusters.some((cluster) => cluster.files.includes(file)));
    if (missingChannelFiles.length) criticalIssues.push(`Runtime & Integrations omits observed runtime-channel files: ${missingChannelFiles.slice(0, 6).join(", ")}.`);
  }

  const productionClusters = graph.clusters.filter((cluster) => !["test", "fixture", "generated", "asset", "docs", "tooling"].includes(cluster.role ?? "mixed"));
  const dataSignals = productionClusters.filter((cluster) => architectureSignal(cluster, /(?:db|database|storage|store|repository|persistence|schema|migration|sqlite|postgres|mysql|mongo|redis|firestore|dynamodb|realm)/i));
  const dataIds = new Set(projectionFor(graph, "data")?.clusterIds ?? []);
  if (dataSignals.length && !dataSignals.some((cluster) => dataIds.has(cluster.id))) {
    criticalIssues.push("Data-bearing implementation exists but Data Ownership & Persistence omits it.");
  }

  for (const projection of graph.projections ?? []) {
    const selected = new Set(projection.clusterIds);
    const subjectIds = new Set<string>();
    for (const clusterId of projection.clusterIds) {
      const cluster = byId.get(clusterId);
      if (!cluster) continue;
      const subjectId = subjectRefForCluster(cluster).id;
      if (subjectIds.has(subjectId)) {
        criticalIssues.push(`${projection.title} depicts canonical subject ${subjectId} more than once.`);
        break;
      }
      subjectIds.add(subjectId);
    }
    const connected = new Set(projection.edgePairs.flatMap((edge) => [edge.source, edge.target]));
    const isolated = [...selected].filter((id) => !connected.has(id)).length;
    if (selected.size >= 4 && isolated / selected.size > 0.6) warnings.push(`${projection.title} is dominated by disconnected subjects (${isolated}/${selected.size}).`);
  }

  const sourceFiles = scan.files.filter((file) => file.detectedLanguage ?? file.language).map((file) => file.relPath);
  const topLevelCoverage = new Set(graph.clusters.filter((cluster) => cluster.tier === 1).flatMap((cluster) => cluster.files));
  const sourceCoverage = sourceFiles.length ? sourceFiles.filter((file) => topLevelCoverage.has(file)).length / sourceFiles.length : 1;
  if (sourceCoverage < 0.98) criticalIssues.push(`Top-level evidence covers only ${Math.round(sourceCoverage * 100)}% of source files.`);

  const score = Math.max(0, 100
    - criticalIssues.length * 24
    - warnings.length * 6
    - Math.round((1 - sourceCoverage) * 30));
  return { score, criticalIssues, warnings };
}

export function compareArchitectureCandidates(baseline: ModuleGraph, candidate: ModuleGraph, scan: RepoScan): {
  accepted: boolean;
  baseline: ArchitectureFitness;
  candidate: ArchitectureFitness;
  reasons: string[];
} {
  const baselineFitness = evaluateArchitectureFitness(baseline, scan);
  const candidateFitness = evaluateArchitectureFitness(candidate, scan);
  const newCritical = candidateFitness.criticalIssues.filter((issue) => !baselineFitness.criticalIssues.includes(issue));
  const reasons = [
    ...newCritical.map((issue) => `introduced critical regression: ${issue}`),
    ...(candidateFitness.criticalIssues.length > baselineFitness.criticalIssues.length ? ["increased the number of failed architecture contracts"] : []),
    ...(candidateFitness.score < baselineFitness.score - 4 ? [`architecture fitness fell from ${baselineFitness.score} to ${candidateFitness.score}`] : [])
  ];
  return { accepted: reasons.length === 0, baseline: baselineFitness, candidate: candidateFitness, reasons };
}

/** Deterministic importer health metrics suitable for fixtures and production diagnostics. */
export function evaluateImportQuality(graph: ModuleGraph, scan: RepoScan): ImportQualityReport {
  const architectureFitness = evaluateArchitectureFitness(graph, scan);
  const sourceFiles = scan.files.filter((file) => file.detectedLanguage ?? file.language).map((file) => file.relPath);
  const parserSupportedFiles = scan.files.filter((file) => file.language).length;
  const tierOneFiles = new Set(graph.clusters.filter((cluster) => cluster.tier === 1).flatMap((cluster) => cluster.files));
  const coveredSources = sourceFiles.filter((file) => tierOneFiles.has(file));
  const clusterIds = graph.clusters.map((cluster) => cluster.id);
  const typedEdges = graph.edges.filter((edge) => edge.kinds?.length || edge.relationKinds?.length);
  const coveredEntrypoints = graph.entrypoints.filter((entrypoint) => graph.clusters.some((cluster) => cluster.files.includes(entrypoint)));
  const report: ImportQualityReport = {
    sourceCoverage: sourceFiles.length ? coveredSources.length / sourceFiles.length : 1,
    uniqueClusterIds: new Set(clusterIds).size === clusterIds.length,
    typedEdgeRate: graph.edges.length ? typedEdges.length / graph.edges.length : 1,
    entrypointCoverage: graph.entrypoints.length ? coveredEntrypoints.length / graph.entrypoints.length : 1,
    parserCoverage: sourceFiles.length ? parserSupportedFiles / sourceFiles.length : 1,
    structuralFallbackFiles: scan.stats.structuralFallbackFiles ?? Math.max(0, sourceFiles.length - parserSupportedFiles),
    projectionCount: graph.projections?.length ?? 0,
    perspectiveCoverage: (graph.projections ?? []).map((projection) => ({
      id: projection.id,
      subjects: projection.clusterIds.length,
      relations: projection.edgePairs.length,
      confidence: projection.confidence
    })),
    cycleCount: graph.insights?.stronglyConnectedComponents.length ?? 0,
    architectureFitnessScore: architectureFitness.score,
    architectureCriticalIssues: architectureFitness.criticalIssues.length,
    warnings: []
  };
  if (report.sourceCoverage < 1) report.warnings.push(`Only ${Math.round(report.sourceCoverage * 100)}% of source files are represented at the top level.`);
  if (!report.uniqueClusterIds) report.warnings.push("Cluster IDs are not unique.");
  if (report.typedEdgeRate < 0.8) report.warnings.push(`Only ${Math.round(report.typedEdgeRate * 100)}% of module edges retain relationship types.`);
  if (report.entrypointCoverage < 1) report.warnings.push("Some detected entrypoints are not represented by a cluster.");
  if (report.structuralFallbackFiles) report.warnings.push(`${report.structuralFallbackFiles} source files use structural fallback because no native parser is available.`);
  const projectionIds = new Set(graph.projections?.map((projection) => projection.id) ?? []);
  const missingCoreProjections = ["system", "functional", "code"].filter((id) => !projectionIds.has(id as "system" | "functional" | "code"));
  if (missingCoreProjections.length) report.warnings.push(`Core architecture lenses are missing: ${missingCoreProjections.join(", ")}.`);
  const emptyCoreProjections = report.perspectiveCoverage.filter((item) => ["system", "functional", "code"].includes(item.id) && item.subjects === 0);
  if (emptyCoreProjections.length) report.warnings.push(`Core architecture perspectives are empty: ${emptyCoreProjections.map((item) => item.id).join(", ")}.`);
  return report;
}
