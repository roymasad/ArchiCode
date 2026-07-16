import { readFile } from "node:fs/promises";
import path from "node:path";
import { flowSchema, type ArchicodeNode, type Flow, type GraphEdgeEvidence, type ProjectBundle } from "../../shared/schema";
import { buildContentInventory } from "./inventory";
import { buildFileDependencyGraph } from "./fileGraph";
import { parseFiles } from "./parsers";
import { addHighConfidenceRuntimeEdges } from "./runtimeEdges";
import { scanRepository } from "./scanner";
import type { FileEdge, ParsedFile, RepoScan } from "./types";
import { loadProject } from "../storage/projectStore";
import { projectStatePath, writeJson } from "../storage/persistence";
import { buildCodeKnowledgeSnapshot, writeCodeKnowledgeSnapshot } from "./knowledgeSnapshot";
import { rememberGraphEvidenceLocalState } from "../storage/graphEvidenceLocalState";
import { evaluateAndStoreArchitecturePolicies, hasArchitecturePolicies } from "../policies/architecturePolicies";

export type GraphEvidenceRefreshProgress = {
  phase: "scan" | "parse" | "resolve" | "write";
  label: string;
  itemsDone?: number;
  itemsTotal?: number;
};

export type GraphEvidenceRefreshResult = {
  bundle: ProjectBundle;
  filesScanned: number;
  filesParsed: number;
  refreshedEdges: number;
  unresolvedEdges: number;
  policyViolations: number;
  policyEvaluationChanged: boolean;
  skippedFlows: number;
  durationMs: number;
};

type RefreshOptions = {
  flowId?: string;
  staleOnly?: boolean;
  refreshCodeKnowledge?: boolean;
  refreshCodeKnowledgeOnly?: boolean;
  preparedScan?: RepoScan;
  preparedFiles?: ParsedFile[];
  onProgress?: (progress: GraphEvidenceRefreshProgress) => void;
};

const EVIDENCE_ANALYZER_VERSION = 2;

function normalizedRelativePath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function filesForNode(node: ArchicodeNode, scan: RepoScan): Set<string> {
  const files = new Set<string>();
  const available = new Set(scan.files.map((file) => file.relPath));
  for (const claim of node.implementationScope?.claims ?? []) {
    const claimPath = normalizedRelativePath(claim.path);
    if (claim.kind === "directory") {
      const prefix = claimPath === "." ? "" : `${claimPath.replace(/\/$/, "")}/`;
      for (const file of scan.files) {
        if (!prefix || file.relPath === claimPath || file.relPath.startsWith(prefix)) files.add(file.relPath);
      }
      continue;
    }
    if (available.has(claimPath)) files.add(claimPath);
  }
  return files;
}

function evidenceOrigin(confidence: number, matches: FileEdge[]): GraphEdgeEvidence["origin"] {
  const runtime = matches.some((match) => match.relationKinds?.some((kind) => ["ipc", "http", "hosts", "runtime-load"].includes(kind)));
  if (runtime || confidence < 1) return confidence >= 0.85 ? "resolved" : "inferred";
  return "extracted";
}

function refreshedEvidence(previous: GraphEdgeEvidence, matches: FileEdge[], checkedAt: string): GraphEdgeEvidence {
  if (!matches.length) {
    return {
      ...previous,
      confidence: 0,
      checkedAt,
      analyzerVersion: EVIDENCE_ANALYZER_VERSION,
      verification: "unresolved",
      freshness: "stale"
    };
  }
  const confidence = Math.max(0, Math.min(1, Math.min(...matches.map((match) => match.confidence ?? 1))));
  const relationKinds = [...new Set(matches.flatMap((match) => [...(match.relationKinds ?? []), ...(match.kinds ?? [])]))].slice(0, 12);
  const locations = [...new Map(matches.flatMap((match) => (match.evidence ?? [{ specifier: "dependency" }]).map((item) => {
    const location = {
      path: match.from,
      ...(item.line ? { line: item.line } : {}),
      ...(item.specifier ? { fact: item.specifier } : {})
    };
    return [`${location.path}:${location.line ?? ""}:${location.fact ?? ""}`, location] as const;
  }))).values()].slice(0, 16);
  const origin = evidenceOrigin(confidence, matches);
  return {
    origin,
    confidence,
    relationKinds,
    locations,
    analyzerVersion: EVIDENCE_ANALYZER_VERSION,
    checkedAt,
    verification: origin === "extracted" ? "verified" : origin === "resolved" ? "unresolved" : "ambiguous",
    freshness: confidence < 0.85 ? "stale" : "current"
  };
}

export function reconcileFlowEvidence(flow: Flow, scan: RepoScan, fileEdges: FileEdge[], checkedAt: string): { flow: Flow; refreshed: number; unresolved: number } {
  const nodeFiles = new Map(flow.nodes.map((node) => [node.id, filesForNode(node, scan)]));
  const outgoing = new Map<string, FileEdge[]>();
  for (const edge of fileEdges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  let refreshed = 0;
  let unresolved = 0;
  const edges = flow.edges.map((edge) => {
    if (!edge.evidence) return edge;
    const sourceFiles = nodeFiles.get(edge.source) ?? new Set<string>();
    const targetFiles = nodeFiles.get(edge.target) ?? new Set<string>();
    const matches: FileEdge[] = [];
    const collect = (fromFiles: Set<string>, toFiles: Set<string>) => {
      for (const sourceFile of fromFiles) {
        for (const candidate of outgoing.get(sourceFile) ?? []) {
          if (toFiles.has(candidate.to)) matches.push(candidate);
        }
      }
    };
    collect(sourceFiles, targetFiles);
    if (edge.bidirectional) collect(targetFiles, sourceFiles);
    const evidence = refreshedEvidence(edge.evidence, matches, checkedAt);
    refreshed += 1;
    if (evidence.verification !== "verified") unresolved += 1;
    return { ...edge, evidence };
  });
  return { flow: flowSchema.parse({ ...flow, edges, updatedAt: checkedAt }), refreshed, unresolved };
}

async function persistedFlow(projectRoot: string, flowId: string, fallback: Flow): Promise<Flow> {
  try {
    return flowSchema.parse(JSON.parse(await readFile(projectStatePath(projectRoot, "flows", `${flowId}.json`), "utf8")));
  } catch {
    return fallback;
  }
}

export async function refreshProjectGraphEvidence(projectRoot: string, options: RefreshOptions = {}): Promise<GraphEvidenceRefreshResult> {
  const startedAt = Date.now();
  const bundle = await loadProject(projectRoot);
  const candidates = options.refreshCodeKnowledgeOnly ? [] : bundle.flows.filter((flow) =>
    !flow.ignored &&
    (!options.flowId || flow.id === options.flowId) &&
    flow.edges.some((edge) => edge.evidence && (!options.staleOnly || edge.evidence.freshness === "stale"))
  );
  if (!candidates.length && !options.refreshCodeKnowledge && !hasArchitecturePolicies(bundle)) {
    return { bundle, filesScanned: 0, filesParsed: 0, refreshedEdges: 0, unresolvedEdges: 0, policyViolations: bundle.policyEvaluation?.violations.length ?? 0, policyEvaluationChanged: false, skippedFlows: bundle.flows.length, durationMs: Date.now() - startedAt };
  }

  options.onProgress?.({ phase: "scan", label: "Scanning changed code relationships" });
  const scan = options.preparedScan ?? await scanRepository(projectRoot, {
    onProgress: (done) => options.onProgress?.({ phase: "scan", label: "Scanning changed code relationships", itemsDone: done })
  });
  options.onProgress?.({ phase: "parse", label: "Parsing source relationships", itemsTotal: scan.files.filter((file) => file.language).length });
  const parsed = options.preparedFiles ?? await parseFiles(projectRoot, scan.files, {
    onProgress: (done, total) => options.onProgress?.({ phase: "parse", label: "Parsing source relationships", itemsDone: done, itemsTotal: total })
  });
  options.onProgress?.({ phase: "resolve", label: "Resolving refreshed relationships" });
  const fileGraph = await buildFileDependencyGraph(projectRoot, scan, parsed, {
    onProgress: (done, total) => options.onProgress?.({ phase: "resolve", label: "Resolving refreshed relationships", itemsDone: done, itemsTotal: total })
  });
  const inventory = await buildContentInventory(projectRoot, scan);
  addHighConfidenceRuntimeEdges(fileGraph, inventory);

  const checkedAt = new Date().toISOString();
  let refreshedEdges = 0;
  let unresolvedEdges = 0;
  const refreshedFlows: Flow[] = [];
  options.onProgress?.({ phase: "write", label: "Updating relationship evidence", itemsTotal: candidates.length });
  for (const [index, candidate] of candidates.entries()) {
    const diskFlow = await persistedFlow(projectRoot, candidate.id, candidate);
    const result = reconcileFlowEvidence(diskFlow, scan, fileGraph.edges, checkedAt);
    await writeJson(projectStatePath(projectRoot, "flows", `${candidate.id}.json`), result.flow);
    refreshedFlows.push(result.flow);
    refreshedEdges += result.refreshed;
    unresolvedEdges += result.unresolved;
    options.onProgress?.({ phase: "write", label: "Updating relationship evidence", itemsDone: index + 1, itemsTotal: candidates.length });
  }
  if (refreshedFlows.length) await rememberGraphEvidenceLocalState(projectRoot, refreshedFlows);
  const policyResult = await evaluateAndStoreArchitecturePolicies(projectRoot, bundle, fileGraph.edges, checkedAt, {
    files: scan.files,
    parsedFiles: parsed
  });
  const snapshotFlow = bundle.flows.find((flow) => flow.id === options.flowId)
    ?? bundle.flows.find((flow) => flow.id === bundle.project.activeFlowId)
    ?? bundle.flows[0];
  await writeCodeKnowledgeSnapshot(projectRoot, buildCodeKnowledgeSnapshot({
    scan,
    parsed,
    fileGraph,
    source: "evidence-refresh",
    flow: snapshotFlow,
    generatedAt: checkedAt
  }));

  return {
    bundle: await loadProject(projectRoot),
    filesScanned: scan.stats.totalFiles,
    filesParsed: parsed.filter((file) => !file.parseError).length,
    refreshedEdges,
    unresolvedEdges,
    policyViolations: policyResult.evaluation.violations.length,
    policyEvaluationChanged: policyResult.changed,
    skippedFlows: bundle.flows.length - candidates.length,
    durationMs: Date.now() - startedAt
  };
}
