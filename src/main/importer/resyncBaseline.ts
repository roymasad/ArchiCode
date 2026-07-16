import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import type { Flow, FlowEdge, ArchicodeNode, ProjectBundle } from "../../shared/schema";
import { projectStatePath, readJson, writeJson } from "../storage/persistence";
import type { FileDependencyGraph, ParsedFile, RepoScan } from "./types";
import type { ResyncBaseline, ResyncConflict, ResyncEntityBaseline, ResyncEntityOrigin, ResyncFileFingerprint, ResyncFlowFileFingerprint } from "./resyncTypes";

export const RESYNC_BASELINE_FILE = "resync-baseline.json";
export const RESYNC_IMPORTER_VERSION = "incremental-resync-v1";

type AnalysisSnapshot = { scan: RepoScan; parsed: ParsedFile[]; fileGraph: FileDependencyGraph };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

export function resyncHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function durableEvidence(evidence: FlowEdge["evidence"]): unknown {
  if (!evidence) return undefined;
  const { checkedAt: _checkedAt, freshness: _freshness, ...durable } = evidence;
  return durable;
}

export function graphEntityFingerprint(kind: ResyncEntityBaseline["kind"], value: unknown): string {
  if (!value || typeof value !== "object") return resyncHash(value);
  const record = value as Record<string, unknown>;
  if (kind === "node") {
    const {
      updatedAt: _updatedAt,
      position: _position,
      size: _size,
      stage: _stage,
      flags: _flags,
      visual: _visual,
      locked: _locked,
      ...semantic
    } = record;
    return resyncHash(semantic);
  }
  if (kind === "edge") {
    const { evidence, ...edge } = record;
    return resyncHash({ ...edge, evidence: durableEvidence(evidence as FlowEdge["evidence"]) });
  }
  if (kind === "flow") {
    const { updatedAt: _updatedAt, nodes: _nodes, edges: _edges, subflows: _subflows, groups: _groups, perspective, ...flow } = record;
    const durablePerspective = perspective && typeof perspective === "object"
      ? (() => {
          const { checkedAt: _checkedAt, coverage: _coverage, ...rest } = perspective as Record<string, unknown>;
          return rest;
        })()
      : perspective;
    return resyncHash({ ...flow, perspective: durablePerspective });
  }
  return resyncHash(record);
}

export function graphEntityOwnershipFingerprint(kind: ResyncEntityBaseline["kind"], value: unknown): string {
  if (kind !== "node" || !value || typeof value !== "object") return graphEntityFingerprint(kind, value);
  const { updatedAt: _updatedAt, ...durable } = value as Record<string, unknown>;
  return resyncHash(durable);
}

function splitEvidencePaths(value: string | undefined): string[] {
  return (value ?? "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

export function evidencePathsForNode(node: ArchicodeNode): string[] {
  const claims = node.implementationScope?.claims.flatMap((claim) => claim.kind === "directory" ? [] : [claim.path]) ?? [];
  const custom = splitEvidencePaths(node.customProperties["Evidence paths"]);
  return [...new Set([...claims, ...custom])].sort();
}

export function evidencePathsForEdge(edge: FlowEdge): string[] {
  return [...new Set((edge.evidence?.locations ?? []).map((location) => location.path))].sort();
}

export function graphEntityKey(flowId: string, kind: ResyncEntityBaseline["kind"], id: string): string {
  return `${flowId}\u0000${kind}\u0000${id}`;
}

function evidenceFingerprint(paths: string[], files: Record<string, ResyncFileFingerprint>): string {
  return resyncHash(paths.map((evidencePath) => [evidencePath, files[evidencePath]?.contentHash ?? "missing"]));
}

export async function fingerprintAnalysisFiles(projectRoot: string, analysis: AnalysisSnapshot): Promise<Record<string, ResyncFileFingerprint>> {
  const parsedByPath = new Map(analysis.parsed.map((file) => [file.relPath, file]));
  const relationships = new Map<string, unknown[]>();
  for (const edge of analysis.fileGraph.edges) {
    relationships.set(edge.from, [...(relationships.get(edge.from) ?? []), edge]);
    relationships.set(edge.to, [...(relationships.get(edge.to) ?? []), { incomingFrom: edge.from, kinds: edge.kinds, relationKinds: edge.relationKinds }]);
  }
  const limit = pLimit(12);
  const entries = await Promise.all(analysis.scan.files.map((file) => limit(async (): Promise<[string, ResyncFileFingerprint]> => {
    const parsed = parsedByPath.get(file.relPath);
    const bytes = await readFile(path.join(projectRoot, file.relPath));
    const parsedShape = parsed ? {
      language: parsed.language,
      imports: parsed.imports,
      namespaces: parsed.declaredNamespaces,
      symbols: parsed.symbols,
      symbolRefs: parsed.symbolRefs,
      semanticSymbols: parsed.semanticSymbols,
      calledSymbols: parsed.calledSymbols,
      callSites: parsed.callSites,
      exportCount: parsed.exportCount,
      loc: parsed.loc,
      parseError: parsed.parseError
    } : null;
    return [file.relPath, {
      path: file.relPath,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: file.sizeBytes,
      language: file.language ?? file.detectedLanguage ?? null,
      parsedFingerprint: resyncHash(parsedShape),
      symbolFingerprint: resyncHash(parsed ? { symbols: parsed.symbols, symbolRefs: parsed.symbolRefs, semanticSymbols: parsed.semanticSymbols } : null),
      relationshipFingerprint: resyncHash((relationships.get(file.relPath) ?? []).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
    }];
  })));
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

export function repositoryFingerprint(files: Record<string, ResyncFileFingerprint>): string {
  return resyncHash(Object.values(files).map((file) => [file.path, file.contentHash, file.parsedFingerprint, file.relationshipFingerprint]));
}

export function compactFlowFileCheckpoint(files: Record<string, ResyncFileFingerprint>): Record<string, ResyncFlowFileFingerprint> {
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([filePath, file]) => [filePath, {
    contentHash: file.contentHash,
    language: file.language,
    symbolFingerprint: file.symbolFingerprint
  }]));
}

function entityRecord(input: {
  flowId: string;
  kind: ResyncEntityBaseline["kind"];
  id: string;
  value: unknown;
  paths: string[];
  files: Record<string, ResyncFileFingerprint>;
  origin: ResyncEntityOrigin;
  previous?: ResyncEntityBaseline;
  verified: boolean;
  conflicted: boolean;
  subjectId?: string;
}): ResyncEntityBaseline {
  const current = graphEntityFingerprint(input.kind, input.value);
  const currentOwnership = graphEntityOwnershipFingerprint(input.kind, input.value);
  return {
    key: graphEntityKey(input.flowId, input.kind, input.id),
    flowId: input.flowId,
    kind: input.kind,
    id: input.id,
    origin: input.origin,
    lastVerifiedGraphFingerprint: input.verified && !input.conflicted ? current : input.previous?.lastVerifiedGraphFingerprint ?? current,
    lastVerifiedOwnershipFingerprint: input.verified && !input.conflicted ? currentOwnership : input.previous?.lastVerifiedOwnershipFingerprint ?? currentOwnership,
    lastObservedGraphFingerprint: current,
    evidenceFingerprint: evidenceFingerprint(input.paths, input.files),
    evidencePaths: input.paths,
    ...(input.subjectId ? { subjectId: input.subjectId } : {})
  };
}

export function baselineEntities(input: {
  bundle: ProjectBundle;
  files: Record<string, ResyncFileFingerprint>;
  importerFlowIds: string[];
  previous?: ResyncBaseline | null;
  verifiedEntityKeys?: Set<string>;
  conflictEntityKeys?: Set<string>;
  legacyBootstrap?: boolean;
}): Record<string, ResyncEntityBaseline> {
  const records: ResyncEntityBaseline[] = [];
  const importerFlows = new Set(input.importerFlowIds);
  const verified = input.verifiedEntityKeys ?? new Set<string>();
  const conflicts = input.conflictEntityKeys ?? new Set<string>();
  const originFor = (key: string, flowId: string, currentFingerprint: string): ResyncEntityOrigin => {
    const previous = input.previous?.entities[key];
    if (!previous) {
      if (input.legacyBootstrap) return "unknown";
      if (input.previous) return verified.has(key) ? "resync" : "user";
      return importerFlows.has(flowId) ? "importer" : "user";
    }
    if (verified.has(key)) return previous.origin === "user" || previous.origin === "unknown" ? previous.origin : "resync";
    if (previous.lastVerifiedGraphFingerprint !== currentFingerprint && (previous.origin === "importer" || previous.origin === "resync")) return "importer-modified";
    return previous.origin;
  };
  for (const flow of input.bundle.flows) {
    const flowKey = graphEntityKey(flow.id, "flow", flow.id);
    const flowFingerprint = graphEntityFingerprint("flow", flow);
    records.push(entityRecord({ flowId: flow.id, kind: "flow", id: flow.id, value: flow, paths: [], files: input.files, origin: originFor(flowKey, flow.id, flowFingerprint), previous: input.previous?.entities[flowKey], verified: verified.has(flowKey) || !input.previous, conflicted: conflicts.has(flowKey) }));
    for (const node of flow.nodes) {
      const key = graphEntityKey(flow.id, "node", node.id);
      const fingerprint = graphEntityFingerprint("node", node);
      records.push(entityRecord({ flowId: flow.id, kind: "node", id: node.id, value: node, paths: evidencePathsForNode(node), files: input.files, origin: originFor(key, flow.id, fingerprint), previous: input.previous?.entities[key], verified: verified.has(key) || !input.previous, conflicted: conflicts.has(key), subjectId: node.subjectRef?.id }));
    }
    for (const edge of flow.edges) {
      const key = graphEntityKey(flow.id, "edge", edge.id);
      const fingerprint = graphEntityFingerprint("edge", edge);
      records.push(entityRecord({ flowId: flow.id, kind: "edge", id: edge.id, value: edge, paths: evidencePathsForEdge(edge), files: input.files, origin: originFor(key, flow.id, fingerprint), previous: input.previous?.entities[key], verified: verified.has(key) || !input.previous, conflicted: conflicts.has(key) }));
    }
    for (const subflow of flow.subflows) {
      const key = graphEntityKey(flow.id, "subflow", subflow.id);
      const fingerprint = graphEntityFingerprint("subflow", subflow);
      records.push(entityRecord({ flowId: flow.id, kind: "subflow", id: subflow.id, value: subflow, paths: [], files: input.files, origin: originFor(key, flow.id, fingerprint), previous: input.previous?.entities[key], verified: verified.has(key) || !input.previous, conflicted: conflicts.has(key) }));
    }
    for (const group of flow.groups) {
      const key = graphEntityKey(flow.id, "group", group.id);
      const fingerprint = graphEntityFingerprint("group", group);
      records.push(entityRecord({ flowId: flow.id, kind: "group", id: group.id, value: group, paths: [], files: input.files, origin: originFor(key, flow.id, fingerprint), previous: input.previous?.entities[key], verified: verified.has(key) || !input.previous, conflicted: conflicts.has(key) }));
    }
  }
  return Object.fromEntries(records.map((record) => [record.key, record]));
}

export async function createResyncBaseline(input: {
  projectRoot: string;
  bundle: ProjectBundle;
  analysis: AnalysisSnapshot;
  settings: ResyncBaseline["settings"];
  importerFlowIds: string[];
  previous?: ResyncBaseline | null;
  verifiedEntityKeys?: Set<string>;
  conflictEntityKeys?: Set<string>;
  unresolvedConflicts?: ResyncConflict[];
  /** Flows whose repository evidence checkpoint advances with this baseline. Defaults to every flow. */
  syncedFlowIds?: string[];
  legacyBootstrap?: boolean;
  now?: string;
}): Promise<ResyncBaseline> {
  const now = input.now ?? new Date().toISOString();
  const files = await fingerprintAnalysisFiles(input.projectRoot, input.analysis);
  const currentCheckpoint = compactFlowFileCheckpoint(files);
  const syncedFlowIds = new Set(input.syncedFlowIds ?? input.bundle.flows.map((flow) => flow.id));
  const flowFileCheckpoints: NonNullable<ResyncBaseline["flowFileCheckpoints"]> = {};
  if (input.previous) {
    for (const flow of input.bundle.flows) {
      if (syncedFlowIds.has(flow.id)) continue;
      const checkpoint = input.previous.flowFileCheckpoints?.[flow.id] ?? compactFlowFileCheckpoint(input.previous.files);
      if (resyncHash(checkpoint) !== resyncHash(currentCheckpoint)) flowFileCheckpoints[flow.id] = checkpoint;
    }
  }
  return {
    schemaVersion: 1,
    baselineVersion: (input.previous?.baselineVersion ?? 0) + 1,
    baselineId: `baseline-${now.replace(/[:.]/g, "-")}`,
    importerVersion: RESYNC_IMPORTER_VERSION,
    createdAt: input.previous?.createdAt ?? now,
    lastSuccessfulSyncAt: now,
    repositoryFingerprint: repositoryFingerprint(files),
    settings: input.settings,
    files,
    // Keep historical normalized records so a flow skipped during a scoped
    // resync can still recognize a later move from its older checkpoint.
    parsedFiles: { ...input.previous?.parsedFiles, ...Object.fromEntries(input.analysis.parsed.map((file) => [file.relPath, file])) },
    flowFileCheckpoints,
    entities: baselineEntities({ bundle: input.bundle, files, importerFlowIds: input.importerFlowIds, previous: input.previous, verifiedEntityKeys: input.verifiedEntityKeys, conflictEntityKeys: input.conflictEntityKeys, legacyBootstrap: input.legacyBootstrap }),
    importerFlowIds: [...new Set(input.importerFlowIds)],
    unresolvedConflicts: input.unresolvedConflicts ?? []
  };
}

export async function readResyncBaseline(projectRoot: string): Promise<ResyncBaseline | null> {
  try {
    const value = await readJson<ResyncBaseline | null>(projectStatePath(projectRoot, "runtime", RESYNC_BASELINE_FILE), null);
    return value?.schemaVersion === 1 && typeof value.repositoryFingerprint === "string"
      ? {
          ...value,
          parsedFiles: value.parsedFiles ?? {},
          flowFileCheckpoints: value.flowFileCheckpoints ?? {},
          entities: Object.fromEntries(Object.entries(value.entities ?? {}).map(([key, entity]) => [key, {
            ...entity,
            lastVerifiedOwnershipFingerprint: entity.lastVerifiedOwnershipFingerprint ?? entity.lastVerifiedGraphFingerprint
          }]))
        }
      : null;
  } catch {
    return null;
  }
}

export async function writeResyncBaseline(projectRoot: string, baseline: ResyncBaseline): Promise<void> {
  await writeJson(projectStatePath(projectRoot, "runtime", RESYNC_BASELINE_FILE), baseline);
}
