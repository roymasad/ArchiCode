import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { archicodeNodeSchema, flowSchema, type ArchicodeNode, type Flow, type FlowEdge, type ProjectBundle, type ResearchGraphOperation } from "../../shared/schema";
import { loadProject } from "../storage/projectStore";
import { runCodebaseImport } from "./index";
import { parseFiles } from "./parsers";
import { scanRepository } from "./scanner";
import {
  createResyncBaseline,
  baselineEntities,
  compactFlowFileCheckpoint,
  evidencePathsForEdge,
  evidencePathsForNode,
  graphEntityFingerprint,
  graphEntityOwnershipFingerprint,
  graphEntityKey,
  readResyncBaseline,
  resyncHash
} from "./resyncBaseline";
import { commitResyncTransaction } from "./resyncPersistence";
import type {
  ResyncBaseline,
  ResyncCodeDelta,
  ResyncConflict,
  ResyncEntityBaseline,
  ResyncFileFingerprint,
  ResyncPatchSummary,
  ResyncProgress,
  ResyncReport,
  ResyncResult,
  ResyncScope
} from "./resyncTypes";
import { CodebaseResyncCancelledError } from "./resyncTypes";
import { CodebaseImportCancelledError } from "./types";

type ResyncProviderSuggestion = {
  flowId: string;
  nodeId: string;
  title?: string;
  description?: string;
  reason: string;
  citations: string[];
};

export type ResyncCodebaseInput = {
  projectRoot: string;
  /** Defaults to the whole project. */
  scope?: ResyncScope;
  provider?: { label: string; kind: string; model?: string } | null;
  callProvider?: (prompt: string, options?: { signal?: AbortSignal; onActivity?: () => void; stableContext?: string }) => Promise<string>;
  shouldCancel?: () => boolean;
  onProgress?: (progress: ResyncProgress) => void;
  /** Test-only persistence fault injection; production callers leave this unset. */
  beforePersistReplace?: (relativePath: string, index: number) => void | Promise<void>;
};

const OWNED_CUSTOM_PROPERTIES = new Set([
  "Code role",
  "Mental lenses",
  "Lens confidence",
  "Evidence basis",
  "Interpretation boundary",
  "Dependency centrality",
  "Entrypoint reachable",
  "Dependency cycle",
  "Dependency community",
  "Repository boundary",
  "Routes",
  "Runtime interactions",
  "Included because",
  "Evidence paths",
  "Evidence line",
  "Evidence status",
  "Claim basis",
  "Storage durability",
  "Declared behavior evidence",
  "Semantic safeguards",
  "Canonical code anchors"
]);

function assertNotCancelled(input: ResyncCodebaseInput): void {
  if (input.shouldCancel?.()) throw new CodebaseResyncCancelledError();
}

function contentRepositoryFingerprint(files: Record<string, Pick<ResyncFileFingerprint, "path" | "contentHash">>): string {
  return resyncHash(Object.values(files).sort((left, right) => left.path.localeCompare(right.path)).map((file) => [file.path, file.contentHash]));
}

type DeltaFileFingerprint = Pick<ResyncFileFingerprint, "contentHash" | "language" | "symbolFingerprint">;

function normalizeResyncScope(bundle: ProjectBundle, requested: ResyncScope | undefined): { reportScope: ResyncScope; flowIds: Set<string> } {
  if (!requested || requested.kind === "project") return { reportScope: { kind: "project" }, flowIds: new Set(bundle.flows.map((flow) => flow.id)) };
  const flowIds = [...new Set(requested.flowIds.map((flowId) => flowId.trim()).filter(Boolean))];
  if (!flowIds.length) throw new Error("Select at least one flow to resync.");
  const available = new Set(bundle.flows.map((flow) => flow.id));
  const missing = flowIds.filter((flowId) => !available.has(flowId));
  if (missing.length) throw new Error(`The selected resync scope contains unknown flows: ${missing.join(", ")}.`);
  return { reportScope: { kind: "flows", flowIds }, flowIds: new Set(flowIds) };
}

function flowFileCheckpoint(baseline: ResyncBaseline, flowId: string): Record<string, DeltaFileFingerprint> {
  return baseline.flowFileCheckpoints?.[flowId] ?? compactFlowFileCheckpoint(baseline.files);
}

function detectScopedResyncCodeDelta(previous: ResyncBaseline, current: Record<string, ResyncFileFingerprint>, flowIds: Set<string>): ResyncCodeDelta {
  const checkpoints = [...flowIds].map((flowId) => flowFileCheckpoint(previous, flowId));
  if (!checkpoints.length) return { added: [], modified: [], deleted: [], moved: [], renamed: [], unchanged: Object.keys(current).length };
  const deltas = checkpoints.map((checkpoint) => detectResyncCodeDelta(checkpoint, current));
  const added = new Set(deltas.flatMap((delta) => delta.added));
  const modified = new Set(deltas.flatMap((delta) => delta.modified));
  const deleted = new Set(deltas.flatMap((delta) => delta.deleted));
  const moved = new Map<string, { from: string; to: string }>();
  const renamed = new Map<string, { from: string; to: string }>();
  for (const delta of deltas) {
    for (const pair of delta.moved) moved.set(`${pair.from}\u0000${pair.to}`, pair);
    for (const pair of delta.renamed) renamed.set(`${pair.from}\u0000${pair.to}`, pair);
  }
  for (const pair of [...moved.values(), ...renamed.values()]) {
    added.delete(pair.to);
    deleted.delete(pair.from);
  }
  // Added dominates modified when selected flows have checkpoints from
  // different repository generations; parsing behavior is identical and the
  // older flow still needs the new evidence introduced.
  for (const filePath of added) modified.delete(filePath);
  const unchanged = Object.keys(current).filter((filePath) => checkpoints.every((checkpoint) => checkpoint[filePath]?.contentHash === current[filePath].contentHash)).length;
  return {
    added: [...added].sort(),
    modified: [...modified].sort(),
    deleted: [...deleted].sort(),
    moved: [...moved.values()].sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
    renamed: [...renamed.values()].sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
    unchanged
  };
}

function previousScopedFile(previous: ResyncBaseline, flowIds: Set<string>, filePath: string, current?: ResyncFileFingerprint): DeltaFileFingerprint | undefined {
  const checkpoints = [...flowIds].map((flowId) => flowFileCheckpoint(previous, flowId));
  return checkpoints.find((checkpoint) => checkpoint[filePath] && checkpoint[filePath].contentHash !== current?.contentHash)?.[filePath]
    ?? checkpoints.find((checkpoint) => checkpoint[filePath])?.[filePath]
    ?? previous.files[filePath];
}

async function scanContentFingerprints(input: ResyncCodebaseInput): Promise<{ scan: Awaited<ReturnType<typeof scanRepository>>; files: Record<string, ResyncFileFingerprint> }> {
  const scan = await scanRepository(input.projectRoot, {
    shouldCancel: input.shouldCancel,
    onProgress: (done) => input.onProgress?.({ projectRoot: input.projectRoot, phase: "scan", label: "Scanning repository files", itemsDone: done })
  });
  const limit = pLimit(12);
  const entries = await Promise.all(scan.files.map((file) => limit(async (): Promise<[string, ResyncFileFingerprint]> => {
    assertNotCancelled(input);
    const bytes = await readFile(path.join(input.projectRoot, file.relPath));
    return [file.relPath, {
      path: file.relPath,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: file.sizeBytes,
      language: file.language ?? file.detectedLanguage ?? null,
      parsedFingerprint: "",
      symbolFingerprint: "",
      relationshipFingerprint: ""
    }];
  })));
  return { scan, files: Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))) };
}

export function detectResyncCodeDelta(previous: Record<string, DeltaFileFingerprint>, current: Record<string, DeltaFileFingerprint>): ResyncCodeDelta {
  const oldPaths = new Set(Object.keys(previous));
  const newPaths = new Set(Object.keys(current));
  const added = [...newPaths].filter((filePath) => !oldPaths.has(filePath)).sort();
  const deleted = [...oldPaths].filter((filePath) => !newPaths.has(filePath)).sort();
  const modified = [...newPaths].filter((filePath) => oldPaths.has(filePath) && previous[filePath].contentHash !== current[filePath].contentHash).sort();
  const addedByHash = new Map<string, string[]>();
  for (const filePath of added) addedByHash.set(current[filePath].contentHash, [...(addedByHash.get(current[filePath].contentHash) ?? []), filePath]);
  const matchedAdded = new Set<string>();
  const matchedDeleted = new Set<string>();
  const moved: ResyncCodeDelta["moved"] = [];
  const renamed: ResyncCodeDelta["renamed"] = [];
  for (const from of deleted) {
    const candidates = addedByHash.get(previous[from].contentHash) ?? [];
    const to = candidates.find((candidate) => !matchedAdded.has(candidate));
    if (!to) continue;
    matchedAdded.add(to);
    matchedDeleted.add(from);
    const pair = { from, to };
    if (path.posix.basename(from) === path.posix.basename(to)) moved.push(pair);
    else renamed.push(pair);
  }
  // A move can include a local implementation edit. When exact bytes no
  // longer match, retain identity if the normalized parser found the same
  // symbol structure. This is deliberately exact rather than fuzzy so two
  // boilerplate files are not conflated.
  for (const from of deleted.filter((filePath) => !matchedDeleted.has(filePath))) {
    const symbolFingerprint = previous[from].symbolFingerprint;
    if (!symbolFingerprint) continue;
    const to = added.find((candidate) => !matchedAdded.has(candidate) && current[candidate].symbolFingerprint === symbolFingerprint);
    if (!to) continue;
    matchedAdded.add(to);
    matchedDeleted.add(from);
    const pair = { from, to };
    if (path.posix.basename(from) === path.posix.basename(to)) moved.push(pair);
    else renamed.push(pair);
  }
  return {
    added: added.filter((filePath) => !matchedAdded.has(filePath)),
    modified,
    deleted: deleted.filter((filePath) => !matchedDeleted.has(filePath)),
    moved,
    renamed,
    unchanged: [...newPaths].filter((filePath) => oldPaths.has(filePath) && previous[filePath].contentHash === current[filePath].contentHash).length
  };
}

function changedPaths(delta: ResyncCodeDelta): Set<string> {
  return new Set([
    ...delta.added,
    ...delta.modified,
    ...delta.deleted,
    ...delta.moved.flatMap(({ from, to }) => [from, to]),
    ...delta.renamed.flatMap(({ from, to }) => [from, to])
  ]);
}

function renameMap(delta: ResyncCodeDelta): Map<string, string> {
  return new Map([...delta.moved, ...delta.renamed].map(({ from, to }) => [from, to]));
}

function currentEntityValue(bundle: ProjectBundle, baseline: ResyncEntityBaseline): unknown {
  const flow = bundle.flows.find((candidate) => candidate.id === baseline.flowId);
  if (!flow) return undefined;
  if (baseline.kind === "flow") return flow;
  if (baseline.kind === "node") return flow.nodes.find((candidate) => candidate.id === baseline.id);
  if (baseline.kind === "edge") return flow.edges.find((candidate) => candidate.id === baseline.id);
  if (baseline.kind === "subflow") return flow.subflows.find((candidate) => candidate.id === baseline.id);
  return flow.groups.find((candidate) => candidate.id === baseline.id);
}

export function buildResyncImpactCone(bundle: ProjectBundle, baseline: ResyncBaseline, delta: ResyncCodeDelta): { paths: Set<string>; entityKeys: Set<string>; flowIds: Set<string> } {
  const paths = changedPaths(delta);
  const entityKeys = new Set<string>();
  const flowIds = new Set<string>();
  for (const entity of Object.values(baseline.entities)) {
    if (!entity.evidencePaths.some((evidencePath) => paths.has(evidencePath))) continue;
    entityKeys.add(entity.key);
    flowIds.add(entity.flowId);
  }
  // Relationships and immediate neighbors are the deterministic impact boundary.
  for (const flow of bundle.flows) {
    const impactedNodeIds = new Set([...entityKeys]
      .map((key) => baseline.entities[key])
      .filter((entity) => entity?.flowId === flow.id && entity.kind === "node")
      .map((entity) => entity.id));
    for (const edge of flow.edges) {
      const edgeKey = graphEntityKey(flow.id, "edge", edge.id);
      if (entityKeys.has(edgeKey) || impactedNodeIds.has(edge.source) || impactedNodeIds.has(edge.target)) {
        entityKeys.add(edgeKey);
        entityKeys.add(graphEntityKey(flow.id, "node", edge.source));
        entityKeys.add(graphEntityKey(flow.id, "node", edge.target));
        flowIds.add(flow.id);
      }
    }
    if (flowIds.has(flow.id)) entityKeys.add(graphEntityKey(flow.id, "flow", flow.id));
  }
  return { paths, entityKeys, flowIds };
}

function candidateFlowsFromOperations(baseFlow: Flow, operations: ResearchGraphOperation[]): Flow[] {
  const base: Flow = {
    ...structuredClone(baseFlow),
    nodes: [],
    edges: [],
    subflows: [],
    groups: []
  };
  const flows = new Map<string, Flow>([[base.id, base]]);
  let nodeSequence = 0;
  for (const operation of operations) {
    if (operation.kind === "create-flow") {
      flows.set(operation.flow.id, flowSchema.parse({
        ...operation.flow,
        nodes: operation.flow.nodes.map((node) => ({
          ...node,
          stage: "draft-approved-production",
          flags: node.flags.filter((flag) => flag !== "changed" && flag !== "needs-attention" && flag !== "modified-not-built")
        }))
      }));
      continue;
    }
    if (operation.kind === "update-flow") {
      const flow = flows.get(operation.flowId);
      if (flow) flows.set(flow.id, { ...flow, ...operation.patch });
      continue;
    }
    if (!("flowId" in operation) || typeof operation.flowId !== "string") continue;
    const flow = flows.get(operation.flowId);
    if (!flow) continue;
    if (operation.kind === "create-group") flow.groups.push(operation.group as Flow["groups"][number]);
    if (operation.kind === "create-subflow") flow.subflows.push(operation.subflow as Flow["subflows"][number]);
    if (operation.kind === "create-node") {
      flow.nodes.push(archicodeNodeSchema.parse({
        ...operation.node,
        position: operation.node.position && "x" in operation.node.position ? operation.node.position : { x: 120 + (nodeSequence % 4) * 340, y: 120 + Math.floor(nodeSequence++ / 4) * 230 },
        flags: (operation.node.flags ?? []).filter((flag) => flag !== "changed" && flag !== "needs-attention" && flag !== "modified-not-built"),
        stage: "draft-approved-production",
        updatedAt: ""
      }));
    }
    if (operation.kind === "create-edge") flow.edges.push(operation.edge as FlowEdge);
  }
  return [...flows.values()].map((flow) => flowSchema.parse(flow));
}

function mappedPaths(paths: string[], renames: Map<string, string>): string[] {
  return [...new Set(paths.map((evidencePath) => renames.get(evidencePath) ?? evidencePath))].sort();
}

function pathSimilarity(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const a = new Set(left);
  const b = new Set(right);
  const intersection = [...a].filter((value) => b.has(value)).length;
  return intersection / new Set([...a, ...b]).size;
}

function matchNodes(current: Flow, candidate: Flow, renames: Map<string, string>): { currentToCandidate: Map<string, ArchicodeNode>; candidateToCurrent: Map<string, ArchicodeNode> } {
  const currentToCandidate = new Map<string, ArchicodeNode>();
  const candidateToCurrent = new Map<string, ArchicodeNode>();
  const unused = new Set(candidate.nodes.map((node) => node.id));
  const take = (currentNode: ArchicodeNode, candidateNode: ArchicodeNode | undefined): void => {
    if (!candidateNode || !unused.has(candidateNode.id)) return;
    currentToCandidate.set(currentNode.id, candidateNode);
    candidateToCurrent.set(candidateNode.id, currentNode);
    unused.delete(candidateNode.id);
  };
  for (const currentNode of current.nodes) take(currentNode, candidate.nodes.find((node) => node.id === currentNode.id));
  for (const currentNode of current.nodes) {
    if (currentToCandidate.has(currentNode.id) || !currentNode.subjectRef) continue;
    take(currentNode, candidate.nodes.find((node) => unused.has(node.id) && node.subjectRef?.id === currentNode.subjectRef?.id));
  }
  for (const currentNode of current.nodes) {
    if (currentToCandidate.has(currentNode.id)) continue;
    const currentPaths = mappedPaths(evidencePathsForNode(currentNode), renames);
    const best = candidate.nodes
      .filter((node) => unused.has(node.id) && node.subjectRef?.kind === currentNode.subjectRef?.kind)
      .map((node) => ({ node, similarity: pathSimilarity(currentPaths, evidencePathsForNode(node)) }))
      .sort((left, right) => right.similarity - left.similarity || left.node.id.localeCompare(right.node.id))[0];
    if (best && best.similarity >= 0.75) take(currentNode, best.node);
  }
  return { currentToCandidate, candidateToCurrent };
}

function replaceMovedPaths(text: string, renames: Map<string, string>): string {
  let next = text;
  for (const [from, to] of renames) next = next.split(from).join(to);
  return next;
}

function conservativelyUpdatedNode(current: ArchicodeNode, candidate: ArchicodeNode, renames: Map<string, string>): ArchicodeNode {
  const customProperties = { ...current.customProperties };
  for (const key of OWNED_CUSTOM_PROPERTIES) {
    if (candidate.customProperties[key] !== undefined) customProperties[key] = candidate.customProperties[key];
    else if (key in customProperties && key !== "Interpretation boundary") delete customProperties[key];
  }
  return archicodeNodeSchema.parse({
    ...current,
    description: replaceMovedPaths(current.description, renames),
    acceptanceCriteria: current.acceptanceCriteria.map((criterion) => replaceMovedPaths(criterion, renames)),
    implementationScope: candidate.implementationScope ? {
      ...candidate.implementationScope,
      source: current.implementationScope?.source ?? candidate.implementationScope.source,
      updatedByRunId: current.implementationScope?.updatedByRunId
    } : current.implementationScope,
    // The graph subject identity is durable across responsibility/file moves.
    subjectRef: current.subjectRef ? { ...current.subjectRef } : candidate.subjectRef,
    customProperties,
    position: current.position,
    size: current.size,
    visual: current.visual,
    stage: current.stage,
    flags: current.flags,
    locked: current.locked,
    attachments: current.attachments,
    todos: current.todos,
    updatedAt: current.updatedAt
  });
}

function entityWasUserModified(entity: ResyncEntityBaseline | undefined, current: unknown): boolean {
  if (!entity) return true;
  if (entity.origin === "user" || entity.origin === "unknown" || entity.origin === "importer-modified") return true;
  return graphEntityFingerprint(entity.kind, current) !== entity.lastVerifiedGraphFingerprint;
}

function entityWasModifiedForDeletion(entity: ResyncEntityBaseline | undefined, current: unknown): boolean {
  if (entityWasUserModified(entity, current) || !entity) return true;
  return graphEntityOwnershipFingerprint(entity.kind, current) !== entity.lastVerifiedOwnershipFingerprint;
}

function actionableConflict(flow: Flow, kind: ResyncEntityBaseline["kind"], id: string, reason: string, disappearedEvidence: string[], category: ResyncConflict["category"] = "user-conflict"): ResyncConflict {
  const node = kind === "node" ? flow.nodes.find((candidate) => candidate.id === id) : undefined;
  const edge = kind === "edge" ? flow.edges.find((candidate) => candidate.id === id) : undefined;
  return {
    id: `conflict-${resyncHash([flow.id, kind, id, reason]).slice(0, 16)}`,
    category,
    flowId: flow.id,
    entityKind: kind,
    entityId: id,
    title: node?.title ?? edge?.label ?? `${kind} ${id}`,
    reason,
    disappearedEvidence
  };
}

function parseProviderSuggestions(response: string): ResyncProviderSuggestion[] {
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? response;
  try {
    const value = JSON.parse(fenced.trim()) as { changes?: unknown[] };
    if (!Array.isArray(value.changes)) return [];
    return value.changes.flatMap((item): ResyncProviderSuggestion[] => {
      if (!item || typeof item !== "object") return [];
      const change = item as Record<string, unknown>;
      if (typeof change.flowId !== "string" || typeof change.nodeId !== "string" || typeof change.reason !== "string" || !Array.isArray(change.citations) || !change.citations.every((citation) => typeof citation === "string")) return [];
      if (change.title !== undefined && typeof change.title !== "string") return [];
      if (change.description !== undefined && typeof change.description !== "string") return [];
      return [{ flowId: change.flowId, nodeId: change.nodeId, reason: change.reason, citations: change.citations as string[], ...(typeof change.title === "string" ? { title: change.title } : {}), ...(typeof change.description === "string" ? { description: change.description } : {}) }];
    });
  } catch {
    return [];
  }
}

function validateFlowStructure(flow: Flow, currentPaths: Set<string>, conflictEdgeIds: Set<string>): void {
  const nodeIds = new Set<string>();
  for (const node of flow.nodes) {
    if (nodeIds.has(node.id)) throw new Error(`Resync proposed duplicate node id ${node.id} in ${flow.id}.`);
    nodeIds.add(node.id);
  }
  const subflowIds = new Set(flow.subflows.map((subflow) => subflow.id));
  const groupIds = new Set(flow.groups.map((group) => group.id));
  for (const subflow of flow.subflows) {
    if (subflow.parentNodeId && !nodeIds.has(subflow.parentNodeId)) throw new Error(`Resync proposed dangling parent node ${subflow.parentNodeId} for ${subflow.id}.`);
    if (subflow.parentSubflowId && !subflowIds.has(subflow.parentSubflowId)) throw new Error(`Resync proposed dangling parent subflow ${subflow.parentSubflowId} for ${subflow.id}.`);
  }
  for (const node of flow.nodes) {
    if (node.subflowId && !subflowIds.has(node.subflowId)) throw new Error(`Resync proposed dangling subflow ${node.subflowId} for ${node.id}.`);
    if (node.groupId && !groupIds.has(node.groupId)) throw new Error(`Resync proposed dangling group ${node.groupId} for ${node.id}.`);
  }
  const edgeIds = new Set<string>();
  for (const edge of flow.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`Resync proposed duplicate edge id ${edge.id} in ${flow.id}.`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new Error(`Resync proposed dangling edge ${edge.id}.`);
    if (edge.source === edge.target) throw new Error(`Resync proposed self edge ${edge.id}.`);
    // Newly emitted/updated evidence must cite current source paths. Legacy
    // stale claims are retained only as explicit conflicts and are not fed here.
    for (const location of conflictEdgeIds.has(edge.id) ? [] : edge.evidence?.locations ?? []) {
      if (!currentPaths.has(location.path)) throw new Error(`Resync proposed obsolete evidence path ${location.path} on ${edge.id}.`);
    }
  }
  flowSchema.parse(flow);
}

function estimateAccuracy(input: { files: number; parsed: number; resolutionRate: number; conflicts: number; stale: number; failedMutations: number; llmReviewed: number; affected: number }): ResyncReport["accuracyEstimate"] {
  const sourceCoverage = input.files ? input.parsed / input.files : 1;
  const conflictPenalty = Math.min(24, input.conflicts * 6 + input.stale * 2);
  const mutationPenalty = Math.min(30, input.failedMutations * 10);
  const score = Math.max(0, Math.min(99, Math.round(48 + sourceCoverage * 20 + input.resolutionRate * 20 + (input.affected ? Math.min(8, input.llmReviewed / input.affected * 8) : 8) - conflictPenalty - mutationPenalty)));
  const label = score >= 90 ? "High" as const : score >= 78 ? "Good" as const : score >= 60 ? "Moderate" as const : "Limited" as const;
  return {
    score,
    label,
    explanation: "Evidence-based estimate from current parser/source coverage, relationship resolution, validated affected-scope reconciliation, and unresolved review items. It is not a guarantee.",
    factors: [
      { label: "Deterministic source coverage", value: `${Math.round(sourceCoverage * 100)}%` },
      { label: "Relationship resolution", value: `${Math.round(input.resolutionRate * 100)}%` },
      { label: "Architecture contracts", value: input.failedMutations ? "Failed mutation detected" : "Validated before commit" },
      { label: "Evidence citations", value: input.failedMutations ? "Incomplete" : "Current for applied changes" },
      { label: "Affected-scope semantic review", value: input.affected ? `${input.llmReviewed}/${input.affected} entities` : "Not needed" },
      { label: "Unresolved conflicts", value: String(input.conflicts) },
      { label: "Potential stale items", value: String(input.stale) },
      { label: "Failed graph mutations", value: String(input.failedMutations) }
    ]
  };
}

function reportStatus(patch: ResyncPatchSummary, codeChanged: boolean): ResyncReport["status"] {
  if (patch.conflicts.length || patch.potentialStale) return "review-required";
  return codeChanged || patch.changedFlowIds.length ? "synchronized" : "up-to-date";
}

function resyncReportId(now: string): string {
  return `resync-${now.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runCodebaseResync(input: ResyncCodebaseInput): Promise<ResyncResult> {
  const startedAt = Date.now();
  const phaseTimings: ResyncReport["phaseTimings"] = [];
  let activePhase: { phase: ResyncProgress["phase"]; label: string; startedAt: number } | null = null;
  const emit = (phase: ResyncProgress["phase"], label: string, detail?: string, progress?: Pick<ResyncProgress, "itemsDone" | "itemsTotal">): void => {
    const now = Date.now();
    if (!activePhase || activePhase.phase !== phase) {
      if (activePhase) phaseTimings.push({ phase: activePhase.phase, label: activePhase.label, durationMs: now - activePhase.startedAt });
      activePhase = { phase, label, startedAt: now };
    } else activePhase.label = label;
    input.onProgress?.({ projectRoot: input.projectRoot, phase, label, detail, ...progress });
  };
  const finishTimings = (): void => {
    if (activePhase) phaseTimings.push({ phase: activePhase.phase, label: activePhase.label, durationMs: Date.now() - activePhase.startedAt });
    activePhase = null;
  };
  try {
    emit("baseline", "Reading synchronization baseline", "Comparing the last verified evidence with the current map.");
    const [bundle, previous] = await Promise.all([loadProject(input.projectRoot), readResyncBaseline(input.projectRoot)]);
    const scope = normalizeResyncScope(bundle, input.scope);
    assertNotCancelled(input);

    emit("scan", "Scanning and hashing repository", "Hashing files first so unchanged code never enters review.");
    const fast = await scanContentFingerprints(input);
    assertNotCancelled(input);

    if (!previous) {
      emit("parse", "Bootstrapping current evidence", "This legacy project has no historical baseline; ArchiCode will record current evidence without changing the graph.");
      const baseFlow = bundle.flows.find((flow) => flow.id === bundle.project.activeFlowId) ?? bundle.flows[0];
      if (!baseFlow) throw new Error("The project has no graph flow to synchronize.");
      const outcome = await runCodebaseImport({
        projectRoot: input.projectRoot,
        flowId: baseFlow.id,
        levels: "3",
        detail: "balanced",
        reviewEffort: "balanced",
        granularity: "component",
        codebaseHints: bundle.project.settings.stackAssumptions,
        semanticEnabled: false,
        persistKnowledgeSnapshot: false,
        reviewEnabled: false,
        shouldCancel: input.shouldCancel,
        onProgress: (progress) => emit(progress.phase === "scan" ? "scan" : "parse", progress.label, progress.detail, { itemsDone: progress.itemsDone, itemsTotal: progress.itemsTotal })
      });
      assertNotCancelled(input);
      const now = new Date().toISOString();
      const baseline = await createResyncBaseline({
        projectRoot: input.projectRoot,
        bundle,
        analysis: outcome.analysisSnapshot,
        settings: { levels: "3", detail: "balanced", reviewEffort: "balanced", granularity: "component" },
        importerFlowIds: bundle.flows.filter((flow) => flow.evidenceBackbone || flow.perspective?.source === "codebase-importer").map((flow) => flow.id),
        legacyBootstrap: true,
        now
      });
      if (contentRepositoryFingerprint(baseline.files) !== contentRepositoryFingerprint(fast.files)) throw new Error("Repository files changed while the synchronization baseline was being prepared. Run resync again after the edits settle.");
      const patch: ResyncPatchSummary = { changedFlowIds: [], verifiedUnchanged: Object.keys(baseline.entities).length, nodesUpdated: 0, edgesUpdated: 0, flowsUpdated: 0, nodesAdded: 0, edgesAdded: 0, flowsAdded: 0, nodesRemoved: 0, edgesRemoved: 0, potentialStale: 0, staleItems: [], conflicts: [], rejectedSuggestions: [] };
      finishTimings();
      const report: ResyncReport = {
        reportId: resyncReportId(now),
        status: "up-to-date",
        completedAt: now,
        durationMs: Date.now() - startedAt,
        provider: input.provider ?? null,
        baselineVersion: baseline.baselineVersion,
        bootstrappedLegacyBaseline: true,
        scope: scope.reportScope,
        files: { scanned: fast.scan.stats.totalFiles, changed: 0, parsed: outcome.stats.filesParsed, resolutionRate: outcome.stats.resolutionRate },
        delta: { added: [], modified: [], deleted: [], moved: [], renamed: [], unchanged: fast.scan.stats.totalFiles },
        patch,
        impact: { paths: [], flowIds: [], entityKeys: [] },
        accuracyEstimate: estimateAccuracy({ files: outcome.stats.filesScanned, parsed: outcome.stats.filesParsed, resolutionRate: outcome.stats.resolutionRate, conflicts: 0, stale: 0, failedMutations: 0, llmReviewed: 0, affected: 0 }),
        llmReview: { requested: false, calls: 0, failedCalls: 0, affectedEntitiesReviewed: 0, suggestionsApplied: 0, suggestionsRejected: 0 },
        safeguards: ["Legacy baseline bootstrapped from current evidence without mutating the graph."],
        phaseTimings,
        technical: ["Historical changes before this baseline are intentionally not inferred."]
      };
      emit("persist", "Saving synchronization baseline", "The visible graph remains byte-for-byte unchanged.");
      await commitResyncTransaction({ projectRoot: input.projectRoot, flows: [], baseline, report }, { beforeReplace: async (relativePath, index) => { assertNotCancelled(input); await input.beforePersistReplace?.(relativePath, index); } });
      return { bundle: await loadProject(input.projectRoot), report };
    }

    emit("compare", "Comparing repository fingerprints", "Detecting additions, edits, deletions, moves, and renames.");
    let delta = detectScopedResyncCodeDelta(previous, fast.files, scope.flowIds);
    let earlyParsed = [] as Awaited<ReturnType<typeof parseFiles>>;
    if (delta.added.length && delta.deleted.length) {
      const possibleEditedMoves = fast.scan.files.filter((file) => delta.added.includes(file.relPath) && file.language);
      if (possibleEditedMoves.length) {
        emit("parse", "Recognizing edited file moves", "Comparing normalized symbol fingerprints before changing graph identity.");
        earlyParsed = await parseFiles(input.projectRoot, possibleEditedMoves, { shouldCancel: input.shouldCancel });
        for (const parsed of earlyParsed) {
          fast.files[parsed.relPath].symbolFingerprint = resyncHash({ symbols: parsed.symbols, symbolRefs: parsed.symbolRefs, semanticSymbols: parsed.semanticSymbols });
        }
        delta = detectScopedResyncCodeDelta(previous, fast.files, scope.flowIds);
      }
    }
    const codeChanged = Boolean(delta.added.length || delta.modified.length || delta.deleted.length || delta.moved.length || delta.renamed.length);
    const completeImpact = buildResyncImpactCone(bundle, previous, delta);
    const impact = {
      paths: completeImpact.paths,
      entityKeys: new Set([...completeImpact.entityKeys].filter((key) => {
        const entity = previous.entities[key];
        return Boolean(entity && scope.flowIds.has(entity.flowId));
      })),
      flowIds: new Set([...completeImpact.flowIds].filter((flowId) => scope.flowIds.has(flowId)))
    };
    const unchangedVerified = Object.values(previous.entities).filter((entity) => {
      if (!scope.flowIds.has(entity.flowId)) return false;
      if (impact.entityKeys.has(entity.key)) return false;
      const current = currentEntityValue(bundle, entity);
      return current !== undefined && graphEntityFingerprint(entity.kind, current) === entity.lastObservedGraphFingerprint;
    }).length;

    if (!codeChanged) {
      const unresolvedItems = previous.unresolvedConflicts.filter((conflict) => {
        const entity = previous.entities[graphEntityKey(conflict.flowId, conflict.entityKind, conflict.entityId)];
        return Boolean(entity && currentEntityValue(bundle, entity) !== undefined);
      });
      const scopedUnresolvedItems = unresolvedItems.filter((item) => scope.flowIds.has(item.flowId));
      const conflicts = scopedUnresolvedItems.filter((item) => item.category !== "potential-stale");
      const staleItems = scopedUnresolvedItems.filter((item) => item.category === "potential-stale");
      const now = new Date().toISOString();
      const baseline: ResyncBaseline = {
        ...previous,
        baselineVersion: previous.baselineVersion + 1,
        baselineId: `baseline-${now.replace(/[:.]/g, "-")}`,
        lastSuccessfulSyncAt: now,
        entities: baselineEntities({ bundle, files: previous.files, importerFlowIds: previous.importerFlowIds, previous }),
        unresolvedConflicts: unresolvedItems
      };
      const patch: ResyncPatchSummary = { changedFlowIds: [], verifiedUnchanged: unchangedVerified, nodesUpdated: 0, edgesUpdated: 0, flowsUpdated: 0, nodesAdded: 0, edgesAdded: 0, flowsAdded: 0, nodesRemoved: 0, edgesRemoved: 0, potentialStale: staleItems.length, staleItems, conflicts, rejectedSuggestions: [] };
      finishTimings();
      const report: ResyncReport = {
        reportId: resyncReportId(now),
        status: scopedUnresolvedItems.length ? "review-required" : "up-to-date",
        completedAt: now,
        durationMs: Date.now() - startedAt,
        provider: input.provider ?? null,
        baselineVersion: baseline.baselineVersion,
        bootstrappedLegacyBaseline: false,
        scope: scope.reportScope,
        files: { scanned: fast.scan.stats.totalFiles, changed: 0, parsed: 0, resolutionRate: 1 },
        delta,
        patch,
        impact: { paths: [], flowIds: [], entityKeys: [] },
        accuracyEstimate: estimateAccuracy({ files: fast.scan.stats.totalFiles, parsed: fast.scan.stats.totalFiles, resolutionRate: 1, conflicts: conflicts.length, stale: staleItems.length, failedMutations: 0, llmReviewed: 0, affected: 0 }),
        llmReview: { requested: false, calls: 0, failedCalls: 0, affectedEntitiesReviewed: 0, suggestionsApplied: 0, suggestionsRejected: 0 },
        safeguards: [scope.reportScope.kind === "project"
          ? "Repository fingerprints match the previous baseline; no graph entities were regenerated or reviewed."
          : "Repository fingerprints match the selected flows' checkpoints; no graph entities were regenerated or reviewed."],
        phaseTimings,
        technical: []
      };
      emit("persist", "Recording up-to-date result", "No graph files will be written.");
      await commitResyncTransaction({ projectRoot: input.projectRoot, flows: [], baseline, report }, { beforeReplace: async (relativePath, index) => { assertNotCancelled(input); await input.beforePersistReplace?.(relativePath, index); } });
      return { bundle, report };
    }

    emit("impact", "Building affected graph scope", `${impact.paths.size} changed paths currently affect ${impact.entityKeys.size} graph entities across ${impact.flowIds.size} flows.`);
    assertNotCancelled(input);
    const baseFlow = bundle.flows.find((flow) => flow.id === previous.importerFlowIds[0])
      ?? bundle.flows.find((flow) => flow.evidenceBackbone)
      ?? bundle.flows.find((flow) => flow.id === bundle.project.activeFlowId)
      ?? bundle.flows[0];
    if (!baseFlow) throw new Error("The project has no graph flow to synchronize.");

    emit("parse", "Parsing changed code evidence", "Reusing the normalized language-agnostic importer analysis without provider generation.");
    const changedForParsing = new Set([...delta.added, ...delta.modified, ...delta.moved.map((item) => item.to), ...delta.renamed.map((item) => item.to)]);
    const movedFromByTo = new Map([...delta.moved, ...delta.renamed].map(({ from, to }) => [to, from]));
    const earlyParsedByPath = new Map(earlyParsed.map((file) => [file.relPath, file]));
    const changedParsed = await parseFiles(input.projectRoot, fast.scan.files.filter((file) => changedForParsing.has(file.relPath) && file.language && !earlyParsedByPath.has(file.relPath)), {
      shouldCancel: input.shouldCancel,
      onProgress: (done, total) => emit("parse", "Parsing changed source files", `${done.toLocaleString()} / ${total.toLocaleString()} changed files`, { itemsDone: done, itemsTotal: total })
    });
    const changedParsedByPath = new Map([...earlyParsed, ...changedParsed].map((file) => [file.relPath, file]));
    const parsed = fast.scan.files.flatMap((file) => {
      if (!file.language) return [];
      const changed = changedParsedByPath.get(file.relPath);
      if (changed) return [changed];
      const previousPath = movedFromByTo.get(file.relPath) ?? file.relPath;
      const reused = previous.parsedFiles[previousPath];
      return reused ? [{ ...reused, relPath: file.relPath }] : [];
    });
    const outcome = await runCodebaseImport({
      projectRoot: input.projectRoot,
      flowId: baseFlow.id,
      levels: previous.settings.levels,
      detail: previous.settings.detail,
      reviewEffort: previous.settings.reviewEffort,
      granularity: previous.settings.granularity,
      codebaseHints: bundle.project.settings.stackAssumptions,
      semanticEnabled: false,
      persistKnowledgeSnapshot: false,
      reviewEnabled: false,
      analysisSeed: { scan: fast.scan, parsed },
      shouldCancel: input.shouldCancel,
      onProgress: (progress) => emit(progress.phase === "scan" ? "scan" : "parse", progress.label, progress.detail, { itemsDone: progress.itemsDone, itemsTotal: progress.itemsTotal })
    });
    assertNotCancelled(input);
    const candidateFlows = candidateFlowsFromOperations(baseFlow, outcome.operations);
    const candidateById = new Map(candidateFlows.map((flow) => [flow.id, flow]));
    const renames = renameMap(delta);
    const currentPaths = new Set(Object.keys(fast.files));
    const nextFlows = new Map(bundle.flows.map((flow) => [flow.id, structuredClone(flow)]));
    const changedFlowIds = new Set<string>();
    const verifiedEntityKeys = new Set<string>();
    const conflictEntityKeys = new Set<string>();
    const carriedItems = previous.unresolvedConflicts.filter((conflict) => {
      const key = graphEntityKey(conflict.flowId, conflict.entityKind, conflict.entityId);
      const entity = previous.entities[key];
      return !impact.entityKeys.has(key) && Boolean(entity && currentEntityValue(bundle, entity) !== undefined);
    });
    const scopedCarriedItems = carriedItems.filter((item) => scope.flowIds.has(item.flowId));
    const outOfScopeCarriedItems = carriedItems.filter((item) => !scope.flowIds.has(item.flowId));
    const conflicts: ResyncConflict[] = scopedCarriedItems.filter((item) => item.category !== "potential-stale");
    const staleItems: ResyncConflict[] = scopedCarriedItems.filter((item) => item.category === "potential-stale");
    const rejectedSuggestions: string[] = [];
    let nodesUpdated = 0;
    let edgesUpdated = 0;
    let flowsUpdated = 0;
    let nodesAdded = 0;
    let edgesAdded = 0;
    let flowsAdded = 0;
    let nodesRemoved = 0;
    let edgesRemoved = 0;
    let potentialStale = staleItems.length;
    carriedItems.forEach((conflict) => conflictEntityKeys.add(graphEntityKey(conflict.flowId, conflict.entityKind, conflict.entityId)));

    emit("reconcile", "Reconciling affected graph entities", "Preserving user edits and applying only evidence-supported minimal changes.");
    for (const currentSource of bundle.flows) {
      assertNotCancelled(input);
      if (!scope.flowIds.has(currentSource.id)) continue;
      const candidate = candidateById.get(currentSource.id);
      if (!candidate || (!impact.flowIds.has(currentSource.id) && !candidate.nodes.some((node) => evidencePathsForNode(node).some((evidencePath) => impact.paths.has(evidencePath))))) continue;
      const current = nextFlows.get(currentSource.id) as Flow;
      const matches = matchNodes(current, candidate, renames);
      const removedNodeIds = new Set<string>();

      for (const node of [...current.nodes]) {
        const key = graphEntityKey(current.id, "node", node.id);
        const baselineEntity = previous.entities[key];
        const candidateNode = matches.currentToCandidate.get(node.id);
        const affected = impact.entityKeys.has(key) || evidencePathsForNode(node).some((evidencePath) => impact.paths.has(evidencePath));
        if (!affected) continue;
        if (candidateNode) {
          if (entityWasUserModified(baselineEntity, node)) {
            const conflict = actionableConflict(current, "node", node.id, "Code evidence changed, but this imported node was edited by a user or has unknown ownership. Its wording and properties were preserved.", baselineEntity?.evidencePaths.filter((evidencePath) => !currentPaths.has(evidencePath)) ?? []);
            conflicts.push(conflict);
            conflictEntityKeys.add(key);
            continue;
          }
          const updated = conservativelyUpdatedNode(node, candidateNode, renames);
          if (graphEntityFingerprint("node", updated) !== graphEntityFingerprint("node", node)) {
            current.nodes[current.nodes.findIndex((item) => item.id === node.id)] = updated;
            nodesUpdated += 1;
            changedFlowIds.add(current.id);
          }
          verifiedEntityKeys.add(key);
          continue;
        }
        const disappeared = baselineEntity?.evidencePaths.filter((evidencePath) => !currentPaths.has(evidencePath)) ?? [];
        const directCodeDerived = node.subjectRef?.kind === "code";
        const safelyOwned = baselineEntity && !entityWasModifiedForDeletion(baselineEntity, node) && (baselineEntity.origin === "importer" || baselineEntity.origin === "resync");
        const ambiguousReplacement = disappeared.some((evidencePath) => {
          const deletedLanguage = previousScopedFile(previous, scope.flowIds, evidencePath)?.language;
          return Boolean(deletedLanguage && delta.added.some((addedPath) => fast.files[addedPath]?.language === deletedLanguage));
        });
        const isSubflowParent = current.subflows.some((subflow) => subflow.parentNodeId === node.id && current.nodes.some((child) => child.subflowId === subflow.id));
        const unsafeIncidentEdge = current.edges.some((edge) => {
          if (edge.source !== node.id && edge.target !== node.id) return false;
          const edgeBaseline = previous.entities[graphEntityKey(current.id, "edge", edge.id)];
          return !edgeBaseline || entityWasUserModified(edgeBaseline, edge);
        });
        if (safelyOwned && directCodeDerived && disappeared.length > 0 && disappeared.length === baselineEntity.evidencePaths.length && !ambiguousReplacement && !isSubflowParent && !unsafeIncidentEdge) {
          current.nodes = current.nodes.filter((item) => item.id !== node.id);
          current.subflows = current.subflows.filter((subflow) => subflow.parentNodeId !== node.id);
          removedNodeIds.add(node.id);
          nodesRemoved += 1;
          changedFlowIds.add(current.id);
          verifiedEntityKeys.add(key);
        } else if (entityWasUserModified(baselineEntity, node)) {
          const conflict = actionableConflict(current, "node", node.id, "Supporting code disappeared, but this node is user-authored, user-modified, or legacy content. It was not deleted.", disappeared);
          conflicts.push(conflict);
          conflictEntityKeys.add(key);
        } else {
          potentialStale += 1;
          const stale = actionableConflict(current, "node", node.id, "Current source evidence no longer proves this conceptual or structurally connected item. It was preserved for review instead of being deleted.", disappeared, "potential-stale");
          staleItems.push(stale);
          conflictEntityKeys.add(key);
        }
      }

      // Add only concepts directly introduced by changed evidence. Existing
      // semantic lens concepts are never regenerated from deterministic fallbacks.
      const isEvidenceFlow = current.evidenceBackbone || current.id === baseFlow.id;
      const candidateNodesToAdd = candidate.nodes.filter((candidateNode) => {
        if (matches.candidateToCurrent.has(candidateNode.id)) return false;
        if (!evidencePathsForNode(candidateNode).some((evidencePath) => impact.paths.has(evidencePath))) return false;
        return isEvidenceFlow || candidateNode.subjectRef?.kind === "code" || candidateNode.subjectRef?.kind === "external-system";
      });
      for (const groupId of new Set(candidateNodesToAdd.flatMap((node) => node.groupId ? [node.groupId] : []))) {
        if (current.groups.some((group) => group.id === groupId)) continue;
        const group = candidate.groups.find((item) => item.id === groupId);
        if (!group) continue;
        current.groups.push(structuredClone(group));
        changedFlowIds.add(current.id);
        verifiedEntityKeys.add(graphEntityKey(current.id, "group", group.id));
      }
      const addedCandidateNodeIds = new Set<string>();
      for (const candidateNode of candidateNodesToAdd) {
        const evidence = evidencePathsForNode(candidateNode);
        const nextNodeId = current.nodes.some((node) => node.id === candidateNode.id)
          ? `${candidateNode.id}-resync-${resyncHash(evidence).slice(0, 8)}`
          : candidateNode.id;
        const nextNode = archicodeNodeSchema.parse({
          ...candidateNode,
          id: nextNodeId,
          subflowId: candidateNode.subflowId && current.subflows.some((subflow) => subflow.id === candidateNode.subflowId) ? candidateNode.subflowId : undefined,
          groupId: candidateNode.groupId && current.groups.some((group) => group.id === candidateNode.groupId) ? candidateNode.groupId : undefined,
          position: { x: 120 + (current.nodes.length % 4) * 340, y: 120 + Math.floor(current.nodes.length / 4) * 230 },
          stage: "draft-approved-production",
          flags: []
        });
        current.nodes.push(nextNode);
        matches.candidateToCurrent.set(candidateNode.id, nextNode);
        addedCandidateNodeIds.add(candidateNode.id);
        nodesAdded += 1;
        changedFlowIds.add(current.id);
        verifiedEntityKeys.add(graphEntityKey(current.id, "node", nextNode.id));
      }
      const requiredSubflowIds = new Set(candidateNodesToAdd.flatMap((node) => node.subflowId ? [node.subflowId] : []));
      let discoveredParent = true;
      while (discoveredParent) {
        discoveredParent = false;
        for (const subflowId of [...requiredSubflowIds]) {
          const parentId = candidate.subflows.find((subflow) => subflow.id === subflowId)?.parentSubflowId;
          if (parentId && !requiredSubflowIds.has(parentId)) {
            requiredSubflowIds.add(parentId);
            discoveredParent = true;
          }
        }
      }
      let addedSubflow = true;
      while (addedSubflow) {
        addedSubflow = false;
        for (const candidateSubflow of candidate.subflows.filter((subflow) => requiredSubflowIds.has(subflow.id))) {
          if (current.subflows.some((subflow) => subflow.id === candidateSubflow.id)) continue;
          const parentNode = candidateSubflow.parentNodeId ? matches.candidateToCurrent.get(candidateSubflow.parentNodeId) : undefined;
          if (candidateSubflow.parentNodeId && !parentNode) continue;
          if (candidateSubflow.parentSubflowId && !current.subflows.some((subflow) => subflow.id === candidateSubflow.parentSubflowId)) continue;
          current.subflows.push({ ...candidateSubflow, ...(parentNode ? { parentNodeId: parentNode.id } : {}) });
          changedFlowIds.add(current.id);
          verifiedEntityKeys.add(graphEntityKey(current.id, "subflow", candidateSubflow.id));
          addedSubflow = true;
        }
      }
      for (const candidateNode of candidateNodesToAdd.filter((node) => addedCandidateNodeIds.has(node.id))) {
        const addedNode = matches.candidateToCurrent.get(candidateNode.id);
        if (!addedNode) continue;
        const nextSubflowId = candidateNode.subflowId && current.subflows.some((subflow) => subflow.id === candidateNode.subflowId) ? candidateNode.subflowId : undefined;
        const nextGroupId = candidateNode.groupId && current.groups.some((group) => group.id === candidateNode.groupId) ? candidateNode.groupId : undefined;
        if (addedNode.subflowId === nextSubflowId && addedNode.groupId === nextGroupId) continue;
        const updated = archicodeNodeSchema.parse({ ...addedNode, subflowId: nextSubflowId, groupId: nextGroupId });
        current.nodes[current.nodes.findIndex((node) => node.id === addedNode.id)] = updated;
        matches.candidateToCurrent.set(candidateNode.id, updated);
      }

      const candidateEdgesByCurrentPair = new Map<string, FlowEdge>();
      for (const edge of candidate.edges) {
        const source = matches.candidateToCurrent.get(edge.source);
        const target = matches.candidateToCurrent.get(edge.target);
        if (source && target) candidateEdgesByCurrentPair.set(`${source.id}\u0000${target.id}`, edge);
      }
      for (const edge of [...current.edges]) {
        const key = graphEntityKey(current.id, "edge", edge.id);
        const baselineEntity = previous.entities[key];
        const candidateEdge = candidate.edges.find((item) => item.id === edge.id)
          ?? candidateEdgesByCurrentPair.get(`${edge.source}\u0000${edge.target}`);
        const affected = impact.entityKeys.has(key) || removedNodeIds.has(edge.source) || removedNodeIds.has(edge.target) || evidencePathsForEdge(edge).some((evidencePath) => impact.paths.has(evidencePath));
        if (!affected) continue;
        if (removedNodeIds.has(edge.source) || removedNodeIds.has(edge.target) || !candidateEdge) {
          if (baselineEntity && !entityWasUserModified(baselineEntity, edge) && baselineEntity.origin !== "user" && baselineEntity.origin !== "unknown") {
            current.edges = current.edges.filter((item) => item.id !== edge.id);
            edgesRemoved += 1;
            changedFlowIds.add(current.id);
            verifiedEntityKeys.add(key);
          } else if (baselineEntity) {
            const conflict = actionableConflict(current, "edge", edge.id, "The relationship is no longer supported, but its ownership or user edits make automatic removal unsafe.", baselineEntity.evidencePaths.filter((evidencePath) => !currentPaths.has(evidencePath)));
            conflicts.push(conflict);
            conflictEntityKeys.add(key);
          }
          continue;
        }
        if (entityWasUserModified(baselineEntity, edge)) {
          const conflict = actionableConflict(current, "edge", edge.id, "Relationship evidence changed, but the edge label or properties were edited by a user or have unknown ownership.", baselineEntity?.evidencePaths.filter((evidencePath) => !currentPaths.has(evidencePath)) ?? []);
          conflicts.push(conflict);
          conflictEntityKeys.add(key);
          continue;
        }
        const updated: FlowEdge = { ...edge, evidence: candidateEdge.evidence ? { ...candidateEdge.evidence } : edge.evidence };
        if (graphEntityFingerprint("edge", updated) !== graphEntityFingerprint("edge", edge)) {
          current.edges[current.edges.findIndex((item) => item.id === edge.id)] = updated;
          edgesUpdated += 1;
          changedFlowIds.add(current.id);
        }
        verifiedEntityKeys.add(key);
      }
      for (const candidateEdge of candidate.edges) {
        const source = matches.candidateToCurrent.get(candidateEdge.source);
        const target = matches.candidateToCurrent.get(candidateEdge.target);
        if (!source || !target || current.edges.some((edge) => edge.source === source.id && edge.target === target.id)) continue;
        if (!evidencePathsForEdge(candidateEdge).some((evidencePath) => impact.paths.has(evidencePath)) && !verifiedEntityKeys.has(graphEntityKey(current.id, "node", source.id)) && !verifiedEntityKeys.has(graphEntityKey(current.id, "node", target.id))) continue;
        const id = current.edges.some((edge) => edge.id === candidateEdge.id) ? `${candidateEdge.id}-resync-${resyncHash([source.id, target.id]).slice(0, 8)}` : candidateEdge.id;
        current.edges.push({ ...candidateEdge, id, source: source.id, target: target.id });
        edgesAdded += 1;
        changedFlowIds.add(current.id);
        verifiedEntityKeys.add(graphEntityKey(current.id, "edge", id));
      }
      if (changedFlowIds.has(current.id)) {
        nextFlows.set(current.id, flowSchema.parse(current));
        const flowKey = graphEntityKey(current.id, "flow", current.id);
        const flowBaseline = previous.entities[flowKey];
        if (flowBaseline && !entityWasUserModified(flowBaseline, currentSource)) verifiedEntityKeys.add(flowKey);
        flowsUpdated += 1;
      }
    }

    // A newly evidenced lens may legitimately add one generated flow. Never
    // replace an existing user flow and never delete a flow automatically.
    for (const candidate of candidateFlows) {
      if (scope.reportScope.kind !== "project") continue;
      if (nextFlows.has(candidate.id) || !candidate.perspective || !candidate.nodes.some((node) => evidencePathsForNode(node).some((evidencePath) => impact.paths.has(evidencePath)))) continue;
      nextFlows.set(candidate.id, candidate);
      changedFlowIds.add(candidate.id);
      flowsAdded += 1;
      nodesAdded += candidate.nodes.length;
      edgesAdded += candidate.edges.length;
      verifiedEntityKeys.add(graphEntityKey(candidate.id, "flow", candidate.id));
      candidate.nodes.forEach((node) => verifiedEntityKeys.add(graphEntityKey(candidate.id, "node", node.id)));
      candidate.edges.forEach((edge) => verifiedEntityKeys.add(graphEntityKey(candidate.id, "edge", edge.id)));
    }

    let llmCalls = 0;
    let failedLlmCalls = 0;
    let suggestionsApplied = 0;
    if (input.callProvider && (conflicts.length || potentialStale)) {
      emit("review", "Reviewing ambiguous affected claims", "Only changed evidence and conflicted entities are sent for a minimal-patch review.");
      llmCalls += 1;
      try {
        const reviewPaths = [...currentPaths].filter((filePath) => impact.paths.has(filePath)).sort().slice(0, 16);
        const changedEvidence = await Promise.all(reviewPaths.map(async (filePath) => ({
          path: filePath,
          excerpt: (await readFile(path.join(input.projectRoot, filePath), "utf8").catch(() => "[Non-text or unreadable current evidence]")).slice(0, 4_000)
        })));
        const affectedGraph = bundle.flows.flatMap((flow) => {
          const affectedNodeIds = new Set(flow.nodes.filter((node) => impact.entityKeys.has(graphEntityKey(flow.id, "node", node.id))).map((node) => node.id));
          if (!affectedNodeIds.size) return [];
          return [{
            flowId: flow.id,
            lens: flow.perspective ? { kind: flow.perspective.kind, question: flow.perspective.question } : { kind: "evidence-backbone", question: "What does the current code evidence prove?" },
            nodes: flow.nodes.filter((node) => affectedNodeIds.has(node.id) || flow.edges.some((edge) => (affectedNodeIds.has(edge.source) && edge.target === node.id) || (affectedNodeIds.has(edge.target) && edge.source === node.id))).map((node) => ({
              id: node.id,
              title: node.title,
              type: node.type,
              description: node.description,
              evidencePaths: evidencePathsForNode(node)
            })),
            relationships: flow.edges.filter((edge) => affectedNodeIds.has(edge.source) || affectedNodeIds.has(edge.target)).map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, label: edge.label, evidencePaths: evidencePathsForEdge(edge) }))
          }];
        });
        const stableContext = JSON.stringify({
          instruction: "Produce only a minimal structured patch. Do not restyle, summarize, or rephrase still-valid content. Never delete user-authored content.",
          changedEvidence,
          affectedGraph,
          itemsRequiringReview: [...conflicts, ...staleItems]
        });
        const controller = new AbortController();
        const cancellationPoll = setInterval(() => {
          if (input.shouldCancel?.()) controller.abort();
        }, 100);
        let response: string;
        try {
          response = await input.callProvider(`archicodeResyncPatch\nReturn JSON {"changes":[{"flowId":"...","nodeId":"...","title":"optional","description":"optional","reason":"why the current claim is false","citations":["current/source/path"]}]}. Every citation must be a provided current path. Omit unchanged entities. Do not add, delete, restyle, summarize, or rephrase still-valid graph content.\n${stableContext}`, { stableContext, signal: controller.signal });
        } finally {
          clearInterval(cancellationPoll);
        }
        assertNotCancelled(input);
        const suggestions = parseProviderSuggestions(response);
        for (const suggestion of suggestions) {
          const flow = nextFlows.get(suggestion.flowId);
          const node = flow?.nodes.find((candidate) => candidate.id === suggestion.nodeId);
          const key = graphEntityKey(suggestion.flowId, "node", suggestion.nodeId);
          const entity = previous.entities[key];
          const valid = Boolean(flow && node && entity
            && impact.entityKeys.has(key)
            && !entityWasUserModified(entity, currentEntityValue(bundle, entity))
            && suggestion.citations.length
            && suggestion.citations.every((citation) => currentPaths.has(citation) && impact.paths.has(citation))
            && (suggestion.title?.trim() || suggestion.description?.trim())
            && (suggestion.title?.length ?? 0) <= 160
            && (suggestion.description?.length ?? 0) <= 2_000);
          if (!valid || !flow || !node) {
            rejectedSuggestions.push(`Rejected unsafe provider suggestion for ${suggestion.flowId}/${suggestion.nodeId}: missing affected ownership, current citations, or bounded content.`);
            continue;
          }
          const updated = archicodeNodeSchema.parse({ ...node, ...(suggestion.title?.trim() ? { title: suggestion.title.trim() } : {}), ...(suggestion.description?.trim() ? { description: suggestion.description.trim() } : {}) });
          flow.nodes[flow.nodes.findIndex((candidate) => candidate.id === node.id)] = updated;
          nextFlows.set(flow.id, flowSchema.parse(flow));
          changedFlowIds.add(flow.id);
          verifiedEntityKeys.add(key);
          suggestionsApplied += 1;
          nodesUpdated += 1;
        }
        if (!suggestions.length && response.trim()) rejectedSuggestions.push("The provider response did not contain a valid structured minimal patch and was ignored.");
      } catch (error) {
        if (error instanceof CodebaseResyncCancelledError || input.shouldCancel?.()) throw new CodebaseResyncCancelledError();
        failedLlmCalls += 1;
        rejectedSuggestions.push(`Affected-scope provider review failed and no provider edits were applied: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    emit("validate", "Validating complete proposed map", "Checking references, IDs, current citations, user-content preservation, and impact-cone boundaries.");
    assertNotCancelled(input);
    const changedFlows = [...changedFlowIds].map((flowId) => nextFlows.get(flowId) as Flow);
    const conflictEdgesByFlow = new Map<string, Set<string>>();
    for (const conflict of conflicts.filter((item) => item.entityKind === "edge")) {
      const ids = conflictEdgesByFlow.get(conflict.flowId) ?? new Set<string>();
      ids.add(conflict.entityId);
      conflictEdgesByFlow.set(conflict.flowId, ids);
    }
    for (const flow of changedFlows) validateFlowStructure(flow, currentPaths, conflictEdgesByFlow.get(flow.id) ?? new Set());
    for (const entity of Object.values(previous.entities)) {
      if (impact.entityKeys.has(entity.key) || verifiedEntityKeys.has(entity.key)) continue;
      const before = currentEntityValue(bundle, entity);
      const after = currentEntityValue({ ...bundle, flows: [...nextFlows.values()] }, entity);
      if (before !== undefined && graphEntityFingerprint(entity.kind, before) !== graphEntityFingerprint(entity.kind, after)) {
        throw new Error(`Resync validation rejected an out-of-impact mutation to ${entity.key}.`);
      }
    }
    const changedEntityCount = nodesUpdated + edgesUpdated + nodesAdded + edgesAdded + nodesRemoved + edgesRemoved;
    if (changedEntityCount > Math.max(25, impact.entityKeys.size * 4 + delta.added.length * 12)) throw new Error("Resync validation rejected an unexplained mass rewrite outside the affected scope.");

    const nextBundle: ProjectBundle = { ...bundle, flows: [...nextFlows.values()] };
    const now = new Date().toISOString();
    const baseline = await createResyncBaseline({
      projectRoot: input.projectRoot,
      bundle: nextBundle,
      analysis: outcome.analysisSnapshot,
      settings: previous.settings,
      importerFlowIds: [...new Set([...previous.importerFlowIds, ...outcome.flowIds])],
      previous,
      verifiedEntityKeys,
      conflictEntityKeys,
      unresolvedConflicts: [...outOfScopeCarriedItems, ...conflicts, ...staleItems],
      syncedFlowIds: [...scope.flowIds],
      now
    });
    if (contentRepositoryFingerprint(baseline.files) !== contentRepositoryFingerprint(fast.files)) throw new Error("Repository files changed while resync was analyzing them. No graph or baseline changes were saved; run resync again after the edits settle.");

    const patch: ResyncPatchSummary = {
      changedFlowIds: [...changedFlowIds],
      verifiedUnchanged: unchangedVerified,
      nodesUpdated,
      edgesUpdated,
      flowsUpdated,
      nodesAdded,
      edgesAdded,
      flowsAdded,
      nodesRemoved,
      edgesRemoved,
      potentialStale,
      staleItems,
      conflicts,
      rejectedSuggestions
    };
    finishTimings();
    const report: ResyncReport = {
      reportId: resyncReportId(now),
      status: reportStatus(patch, codeChanged),
      completedAt: now,
      durationMs: Date.now() - startedAt,
      provider: input.provider ?? null,
      baselineVersion: baseline.baselineVersion,
      bootstrappedLegacyBaseline: false,
      scope: scope.reportScope,
      files: { scanned: fast.scan.stats.totalFiles, changed: changedPaths(delta).size, parsed: outcome.stats.filesParsed, resolutionRate: outcome.stats.resolutionRate },
      delta,
      patch,
      impact: { paths: [...impact.paths].sort(), flowIds: [...impact.flowIds].sort(), entityKeys: [...impact.entityKeys].sort() },
      accuracyEstimate: estimateAccuracy({ files: outcome.stats.filesScanned, parsed: outcome.stats.filesParsed, resolutionRate: outcome.stats.resolutionRate, conflicts: conflicts.length, stale: potentialStale, failedMutations: 0, llmReviewed: input.callProvider ? impact.entityKeys.size : 0, affected: impact.entityKeys.size }),
      llmReview: { requested: Boolean(input.callProvider && (conflicts.length || potentialStale)), calls: llmCalls, failedCalls: failedLlmCalls, affectedEntitiesReviewed: llmCalls ? impact.entityKeys.size : 0, suggestionsApplied, suggestionsRejected: rejectedSuggestions.length },
      safeguards: [
        scope.reportScope.kind === "project"
          ? "Entities outside the impact cone were fingerprint-checked and left unchanged."
          : "Flows outside the selected scope retain their graph content and repository checkpoints for a later resync.",
        "Existing positions, dimensions, production state, notes, attachments, todos, visual styling, and custom user properties were preserved.",
        "User-authored, user-modified, conceptual, and unknown entities were never automatically deleted.",
        "The graph, new baseline, and resync report are committed through one recoverable transaction."
      ],
      phaseTimings,
      technical: outcome.stats.degraded
    };

    emit("persist", "Applying validated map patch atomically", `${changedFlows.length} graph flow${changedFlows.length === 1 ? "" : "s"} will be written with the new baseline and report.`);
    await commitResyncTransaction({ projectRoot: input.projectRoot, flows: changedFlows, baseline, report }, {
      beforeReplace: async (relativePath, index) => {
        assertNotCancelled(input);
        await input.beforePersistReplace?.(relativePath, index);
      }
    });
    return { bundle: await loadProject(input.projectRoot), report };
  } catch (error) {
    if (error instanceof CodebaseResyncCancelledError || error instanceof CodebaseImportCancelledError || input.shouldCancel?.()) throw new CodebaseResyncCancelledError();
    throw error;
  }
}
