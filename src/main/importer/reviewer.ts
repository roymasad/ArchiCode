import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  archicodeNodeSchema,
  codebaseReviewPartitionBudget,
  flowEdgeSchema,
  flowSchema,
  nodeVisualSchema,
  type ArchicodeNode,
  type Flow,
  type FlowEdge,
  type ResearchGraphOperation
} from "../../shared/schema";
import { projectStatePath, writeJson } from "../storage/persistence";
import {
  CodebaseImportCancelledError,
  type CodebaseImportProgress,
  type CodebaseImportProviderCallOptions,
  type CodebaseImportReviewEffort,
  type RepoScan
} from "./types";
import type { ContentInventory } from "./inventory";

const REVIEW_LEDGER_FILE = "import-review-latest.json";
const MAX_SOURCE_BYTES = 2_800;
const MAX_SOURCE_SLICES_PER_UNIT = 14;
const MAX_NODES_PER_UNIT = 14;
const MAX_PATCH_RETRIES = 1;
const REVIEW_INACTIVITY_TIMEOUT_MS = 3 * 60_000;
const REVIEW_PARTITION_TIMEOUT_MS = 6 * 60_000;
const REVIEW_ACTIVE_GRACE_MS = 30_000;
const REVIEW_PROVIDER_ATTEMPTS = 2;
const REVIEW_CANCELLATION_POLL_MS = 250;
const REVIEW_PREFLIGHT_CONCURRENCY = 2;

class ReviewProviderTimeoutError extends Error {
  attempts: number;

  constructor(message: string, attempts = 1) {
    super(message);
    this.name = "ReviewProviderTimeoutError";
    this.attempts = attempts;
  }
}

const reviewCitationSchema = z.object({
  path: z.string().trim().min(1),
  line: z.number().int().positive().optional(),
  fact: z.string().trim().min(1).optional()
});

const nodeContentPatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(8_000).optional(),
  type: z.string().trim().min(1).max(80).optional(),
  techStack: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(600)).max(8).optional(),
  visual: nodeVisualSchema.optional(),
  setProperties: z.record(z.string().max(2_000)).optional(),
  removeProperties: z.array(z.string().trim().min(1)).max(12).optional()
});

const reviewEditSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("update-flow"),
    flowId: z.string(),
    patch: z.object({
      name: z.string().trim().min(1).max(140).optional(),
      description: z.string().trim().min(1).max(4_000).optional(),
      question: z.string().trim().min(1).max(600).optional(),
      confidence: z.enum(["high", "medium", "exploratory"]).optional(),
      addLimitations: z.array(z.string().trim().min(1).max(600)).max(6).optional()
    }),
    reason: z.string().trim().min(1),
    citations: z.array(reviewCitationSchema).max(12).default([])
  }),
  z.object({
    kind: z.literal("update-node"),
    flowId: z.string(),
    nodeId: z.string(),
    patch: nodeContentPatchSchema,
    reason: z.string().trim().min(1),
    citations: z.array(reviewCitationSchema).min(1).max(12)
  }),
  z.object({
    kind: z.literal("update-edge"),
    flowId: z.string(),
    edgeId: z.string(),
    patch: z.object({
      label: z.string().trim().min(1).max(160).optional(),
      lineStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
      animated: z.boolean().optional(),
      bidirectional: z.boolean().optional()
    }),
    reason: z.string().trim().min(1),
    citations: z.array(reviewCitationSchema).min(1).max(12)
  }),
  z.object({
    kind: z.literal("exclude-perspective-node"),
    flowId: z.string(),
    nodeId: z.string(),
    reason: z.string().trim().min(1),
    citations: z.array(reviewCitationSchema).min(1).max(12)
  }),
  z.object({
    kind: z.literal("exclude-perspective-edge"),
    flowId: z.string(),
    edgeId: z.string(),
    reason: z.string().trim().min(1),
    citations: z.array(reviewCitationSchema).min(1).max(12)
  }),
  z.object({
    kind: z.literal("include-subject"),
    flowId: z.string(),
    subjectRefId: z.string(),
    patch: nodeContentPatchSchema.optional(),
    reason: z.string().trim().min(1),
    citations: z.array(reviewCitationSchema).min(1).max(12)
  }),
  z.object({
    kind: z.literal("include-relationship"),
    flowId: z.string(),
    sourceSubjectRefId: z.string(),
    targetSubjectRefId: z.string(),
    label: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1),
    citations: z.array(reviewCitationSchema).min(1).max(12)
  }),
  z.object({
    kind: z.literal("create-lens-concept"),
    flowId: z.string(),
    nodeKey: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().trim().min(1).max(120),
    type: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(4_000),
    relationships: z.array(z.object({
      direction: z.enum(["from-concept", "to-concept"]),
      subjectRefId: z.string().trim().min(1),
      label: z.string().trim().min(1).max(160)
    })).max(6).default([]),
    reason: z.string().trim().min(1),
    citations: z.array(reviewCitationSchema).min(1).max(12)
  })
]);

const reviewResponseSchema = z.object({
  summary: z.string().default(""),
  findings: z.array(z.string()).max(20).default([]),
  edits: z.array(reviewEditSchema).max(30).default([]),
  unresolved: z.array(z.string()).max(20).default([])
});

export type ImportReviewLedger = {
  version: 1;
  runId: string;
  status: "running" | "complete" | "partial" | "failed";
  objective: string;
  startedAt: string;
  completedAt?: string;
  totalUnits: number;
  /** Total units the exhaustive legacy partitioner could have produced. */
  totalPlannedUnits: number;
  reviewedUnits: number;
  totalSubjects: number;
  reviewedSubjectIds: string[];
  totalSourceFiles: number;
  reviewedSourceFiles: string[];
  /** Repository files cited by edits that passed deterministic validation and were applied. */
  citedSourceFiles: string[];
  totalSourceSlices: number;
  reviewedSourceSlices: string[];
  proposedEdits: number;
  appliedEdits: number;
  rejectedBatches: number;
  /** Provider invocations that threw or timed out before returning a review response. */
  failedProviderAttempts: number;
  findings: string[];
  unresolved: string[];
  limitations: string[];
  unitResults: Array<{
    unitId: string;
    flowId: string;
    kind: ReviewUnit["kind"];
    purpose: string;
    priority: number;
    anomalySignals: string[];
    startedAt: string;
    completedAt: string;
    durationMs: number;
    providerAttempts: number;
    failedProviderAttempts: number;
    proposedEdits: number;
    appliedEdits: number;
    appliedChanges: Array<z.infer<typeof reviewEditSchema>>;
    findings: string[];
    unresolved: string[];
  }>;
};

type ReviewFlow = Flow & { evidenceFlow: boolean };
type SourceSlice = { path: string; offset: number; length: number };
type ReviewUnit = {
  id: string;
  kind: "evidence" | "perspective" | "global";
  flowId: string;
  flowName: string;
  nodeIds: string[];
  sourceSlices: SourceSlice[];
  purpose: string;
  priority: number;
  anomalySignals: string[];
};

type PrefetchedReview = {
  raw?: string;
  error?: Error;
  providerAttempts: number;
  failedProviderAttempts: number;
  startedAt: string;
  startedAtMs: number;
  partitionDeadlineMs: number;
};

export type ImportReviewResult = {
  operations: ResearchGraphOperation[];
  ledger: ImportReviewLedger;
};

const PROTECTED_PROPERTIES = new Set([
  "Code role",
  "Evidence basis",
  "Dependency centrality",
  "Entrypoint reachable",
  "Dependency cycle",
  "Dependency community",
  "Repository boundary",
  "Routes",
  "Runtime interactions",
  "Included because",
  "Canonical code anchors",
  "Evidence paths",
  "Evidence status",
  "Claim basis",
  "Storage durability",
  "Declared behavior evidence",
  "Semantic safeguards",
  "Interpretation boundary"
]);

function cloneOperations(operations: ResearchGraphOperation[]): ResearchGraphOperation[] {
  return structuredClone(operations);
}

function nodeFromCreateOperation(operation: Extract<ResearchGraphOperation, { kind: "create-node" }>, index: number): ArchicodeNode {
  return archicodeNodeSchema.parse({
    ...operation.node,
    position: "position" in operation.node && operation.node.position && "x" in operation.node.position
      ? operation.node.position
      : { x: 120 + (index % 4) * 340, y: 120 + Math.floor(index / 4) * 230 },
    updatedAt: ""
  });
}

function materializeFlows(operations: ResearchGraphOperation[], baseFlowId: string): ReviewFlow[] {
  const update = operations.find((operation): operation is Extract<ResearchGraphOperation, { kind: "update-flow" }> => operation.kind === "update-flow" && operation.flowId === baseFlowId);
  const nodes = operations
    .filter((operation): operation is Extract<ResearchGraphOperation, { kind: "create-node" }> => operation.kind === "create-node" && operation.flowId === baseFlowId)
    .map(nodeFromCreateOperation);
  const evidence = flowSchema.parse({
    id: baseFlowId,
    name: update?.patch.name ?? "Codebase Structure (Evidence)",
    description: update?.patch.description ?? "Code-derived architecture evidence.",
    ignored: false,
    nodes,
    edges: operations.flatMap((operation) => operation.kind === "create-edge" && operation.flowId === baseFlowId ? [flowEdgeSchema.parse(operation.edge)] : []),
    subflows: operations.flatMap((operation) => operation.kind === "create-subflow" && operation.flowId === baseFlowId ? [operation.subflow] : []),
    groups: operations.flatMap((operation) => operation.kind === "create-group" && operation.flowId === baseFlowId ? [operation.group] : []),
    updatedAt: ""
  });
  return [
    { ...evidence, evidenceFlow: true },
    ...operations.flatMap((operation) => operation.kind === "create-flow" ? [{ ...flowSchema.parse(operation.flow), evidenceFlow: false }] : [])
  ];
}

function normalizedRepoPath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(normalized)) return normalized === "." ? "." : null;
  return normalized;
}

function nodeClaimsPath(node: ArchicodeNode, filePath: string): boolean {
  return (node.implementationScope?.claims ?? []).some((claim) => {
    const claimed = normalizedRepoPath(claim.path);
    if (!claimed) return false;
    return claim.kind === "directory"
      ? claimed === "." || filePath === claimed || filePath.startsWith(`${claimed}/`)
      : filePath === claimed;
  });
}

function bestNodeForFile(nodes: ArchicodeNode[], filePath: string): ArchicodeNode | undefined {
  return nodes
    .filter((node) => node.subjectRef?.kind === "code" && nodeClaimsPath(node, filePath))
    .sort((left, right) => {
      const specificity = (node: ArchicodeNode): number => Math.max(...(node.implementationScope?.claims ?? []).flatMap((claim) => {
        const claimed = normalizedRepoPath(claim.path);
        if (!claimed) return [];
        if (claim.kind !== "directory" && claimed === filePath) return [100_000 + claimed.length];
        if (claim.kind === "directory" && (claimed === "." || filePath === claimed || filePath.startsWith(`${claimed}/`))) return [claimed.length];
        return [];
      }), -1);
      return specificity(right) - specificity(left);
    })[0];
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}

function sourceSliceKey(slice: SourceSlice): string {
  return `${slice.path}@${slice.offset}:${slice.length}`;
}

function slicesForFile(file: RepoScan["files"][number]): SourceSlice[] {
  if (file.sizeBytes <= 0) return [{ path: file.relPath, offset: 0, length: MAX_SOURCE_BYTES }];
  const slices: SourceSlice[] = [];
  for (let offset = 0; offset < file.sizeBytes; offset += MAX_SOURCE_BYTES) {
    slices.push({ path: file.relPath, offset, length: Math.min(MAX_SOURCE_BYTES, file.sizeBytes - offset) });
  }
  return slices;
}

function sourceReviewPriority(file: RepoScan["files"][number], hotspotCategories: string[] = []): number {
  const name = file.relPath.toLowerCase();
  let score = 0;
  if (/(^|\/)(readme|architecture|overview)(\.|$)/.test(name)) score += 100;
  if (/(^|\/)(package\.json|pubspec\.yaml|cargo\.toml|go\.mod|pyproject\.toml|pom\.xml|build\.gradle(?:\.kts)?|wrangler\.toml|dockerfile)$/.test(name)) score += 80;
  if (/(^|\/)(main|index|app|server|bootstrap|entrypoint)\.[^/]+$/.test(name)) score += 70;
  if (/(route|router|screen|page|database|storage|repository|schema|migration|deploy|infra|workflow)/.test(name)) score += 35;
  if (file.role === "production") score += 15;
  if (file.role === "config" || file.role === "migration") score += 10;
  if (hotspotCategories.includes("runtime-boundary")) score += 90;
  if (hotspotCategories.includes("runtime-contract") || hotspotCategories.includes("route")) score += 70;
  if (hotspotCategories.includes("business-rule") || hotspotCategories.includes("human-facing-contract")) score += 65;
  if (hotspotCategories.includes("application-state") || hotspotCategories.includes("user-interface")) score += 45;
  return score;
}

function nodeEvidencePaths(node: ArchicodeNode): string[] {
  return [...new Set([
    ...(node.implementationScope?.claims ?? []).map((claim) => normalizedRepoPath(claim.path)).filter((value): value is string => Boolean(value)),
    ...(node.customProperties["Evidence paths"] ?? "").split(",").map((value) => normalizedRepoPath(value.trim())).filter((value): value is string => Boolean(value))
  ])];
}

function pathCoveredByFlow(flow: ReviewFlow, evidencePath: string): boolean {
  return flow.nodes.some((node) => nodeEvidencePaths(node).some((claimed) => claimed === evidencePath || evidencePath.startsWith(`${claimed}/`) || claimed.startsWith(`${evidencePath}/`)));
}

function hotspotCategoriesForLens(kind: string | undefined): Set<string> {
  if (kind === "product-capabilities") return new Set(["business-rule", "human-facing-contract", "user-interface", "application-state", "behavior", "route"]);
  if (kind === "user-journeys") return new Set(["user-interface", "application-state", "behavior", "route", "runtime-contract"]);
  if (kind === "runtime-integrations") return new Set(["entrypoint", "runtime-boundary", "runtime-contract", "route"]);
  if (kind === "data-persistence") return new Set(["application-state", "business-rule", "runtime-contract"]);
  if (kind === "cloud-infrastructure") return new Set(["entrypoint", "runtime-boundary", "runtime-contract"]);
  if (kind === "system-context") return new Set(["entrypoint", "runtime-boundary"]);
  return new Set();
}

function hotspotCategoryOrder(kind: string | undefined): string[] {
  if (kind === "product-capabilities") return ["business-rule", "human-facing-contract", "user-interface", "application-state", "behavior", "route"];
  if (kind === "user-journeys") return ["user-interface", "application-state", "behavior", "route", "runtime-contract"];
  if (kind === "runtime-integrations") return ["runtime-boundary", "runtime-contract", "route", "entrypoint"];
  if (kind === "data-persistence") return ["application-state", "business-rule", "runtime-contract"];
  if (kind === "cloud-infrastructure") return ["runtime-boundary", "entrypoint", "runtime-contract"];
  if (kind === "system-context") return ["runtime-boundary", "entrypoint"];
  return [];
}

function bestHotspotForFlow(flow: ReviewFlow, hotspots: NonNullable<ContentInventory["evidenceHotspots"]>) {
  const order = hotspotCategoryOrder(flow.perspective?.kind);
  return [...hotspots].sort((left, right) => {
    const rank = (categories: string[]): number => {
      const indexes = categories.map((category) => order.indexOf(category)).filter((index) => index >= 0);
      return indexes.length ? Math.min(...indexes) : Number.MAX_SAFE_INTEGER;
    };
    return rank(left.categories) - rank(right.categories) || left.offset - right.offset;
  })[0];
}

function hotspotPathsForFlow(flow: ReviewFlow, inventory?: ContentInventory): string[] {
  const accepted = hotspotCategoriesForLens(flow.perspective?.kind);
  if (!accepted.size) return [];
  return [...new Set((inventory?.evidenceHotspots ?? [])
    .filter((hotspot) => hotspot.categories.some((category) => accepted.has(category)))
    .map((hotspot) => hotspot.file))];
}

function perspectiveAnomalies(flow: ReviewFlow, inventory?: ContentInventory): { priority: number; signals: string[] } {
  const nodes = flow.nodes.filter((node) => node.id !== "node-project");
  const connected = new Set(flow.edges.flatMap((edge) => [edge.source, edge.target]));
  const isolated = nodes.filter((node) => !connected.has(node.id)).length;
  const signals: string[] = [];
  let priority = 10;
  if (!flow.edges.length && nodes.length > 1) {
    priority += 70;
    signals.push("multiple subjects but zero relationships");
  }
  if (nodes.length >= 4 && isolated / nodes.length > 0.5) {
    priority += 45;
    signals.push(`${isolated}/${nodes.length} subjects are disconnected`);
  }
  if (nodes.length <= 2) {
    priority += 25;
    signals.push("very low subject coverage");
  }
  const kind = flow.perspective?.kind;
  const highValuePaths = hotspotPathsForFlow(flow, inventory);
  const uncoveredHighValuePaths = highValuePaths.filter((sourcePath) => !pathCoveredByFlow(flow, sourcePath));
  const genericRelationships = flow.edges.filter((edge) => /^(?:imports?|dependency|depends? on|uses?|connects? to)(?:\s*\(\d+\))?$/i.test(edge.label?.trim() ?? ""));
  if (flow.edges.length >= 4 && genericRelationships.length / flow.edges.length > 0.4) {
    priority += 40;
    signals.push(`${genericRelationships.length}/${flow.edges.length} relationships are generic plumbing labels`);
  }
  if (kind === "product-capabilities") {
    const capabilityNodes = nodes.filter((node) => /capability/i.test(node.type));
    if (nodes.length >= 3 && capabilityNodes.length / nodes.length < 0.6) {
      priority += 75;
      signals.push("product lens is dominated by technical modules rather than user/business capabilities");
    }
    if (uncoveredHighValuePaths.length) {
      priority += 65;
      signals.push(`product lens omits behavioral evidence from ${uncoveredHighValuePaths.slice(0, 6).join(", ")}`);
    }
    const productText = nodes.map((node) => `${node.title} ${node.description}`).join(" ").toLowerCase();
    const uncoveredContracts = (inventory?.behavioralContracts ?? []).filter((contract) => {
      const nodeTerms = new Set(productText.match(/[a-z][a-z0-9-]{2,}/g) ?? []);
      return contract.terms.filter((term) => nodeTerms.has(term)).length < Math.min(2, Math.max(1, contract.terms.length));
    });
    if (uncoveredContracts.length >= 2) {
      priority += 90;
      signals.push(`product lens collapses ${uncoveredContracts.length} distinct source-observed behaviors, including ${uncoveredContracts.slice(0, 4).map((contract) => contract.title).join("; ")}`);
    }
  }
  if (kind === "user-journeys") {
    const journeyNodes = nodes.filter((node) => /^(actor|trigger|journey-step|decision|outcome)$/.test(node.type));
    const orderedEdges = flow.edges.filter((edge) => edge.evidence?.relationKinds.includes("user-flow"));
    if (journeyNodes.length / Math.max(1, nodes.length) < 0.6 || orderedEdges.length < Math.max(1, journeyNodes.length - 1)) {
      priority += 80;
      signals.push("UX lens does not form an ordered actor/trigger/step/decision/outcome journey");
    }
    if (uncoveredHighValuePaths.length >= 2) {
      priority += 35;
      signals.push(`journey lens does not cover interaction evidence from ${uncoveredHighValuePaths.slice(0, 5).join(", ")}`);
    }
  }
  if (kind === "system-context") {
    const boundaryNodes = nodes.filter((node) => node.type === "external-system"
      || /(?:entrypoint|runtime|route|boundary|manifest|deployable|host|external)/i.test(`${node.title} ${node.description} ${node.customProperties["Included because"] ?? ""}`));
    const internalNodes = nodes.filter((node) => /^(?:assets?|components?|router|routes?|src|stores?|state|views?|widgets?)$/i.test(node.title.trim()));
    if ((nodes.length >= 3 && boundaryNodes.length < Math.min(2, nodes.length)) || internalNodes.length > Math.floor(nodes.length / 3)) {
      priority += 95;
      signals.push(`system context exposes ${internalNodes.length}/${nodes.length} obvious internal areas and only ${boundaryNodes.length} evidenced process/trust/entrypoint/external boundaries`);
    }
  }
  if (kind === "runtime-integrations") {
    const runtimeText = JSON.stringify({
      nodes: nodes.map((node) => ({ title: node.title, description: node.description, interactions: node.customProperties["Runtime interactions"] })),
      edges: flow.edges.map((edge) => edge.label)
    }).toLowerCase();
    const missingTargets = [...new Set((inventory?.interactions ?? [])
      .filter((interaction) => ["http-call", "http-url", "http-route", "ipc-handle", "ipc-send", "event-publish", "event-subscribe"].includes(interaction.kind))
      .map((interaction) => interaction.target)
      .filter((target) => target && !runtimeText.includes(target.toLowerCase())))];
    if (missingTargets.length) {
      priority += 70;
      signals.push(`runtime lens omits observed contracts: ${missingTargets.slice(0, 6).join(", ")}`);
    }
    const runtimeChannelKinds = new Set(["http-call", "ipc-send", "event-publish", "shared-write", "platform-host"]);
    const missingSourceChannels = (inventory?.interactions ?? []).filter((interaction) => runtimeChannelKinds.has(interaction.kind)
      && !flow.edges.some((edge) => edge.evidence?.locations.some((location) => location.path === interaction.file)));
    if (missingSourceChannels.length) {
      priority += 95;
      signals.push(`runtime lens lacks source-specific channels: ${missingSourceChannels.slice(0, 6).map((interaction) => `${interaction.file} → ${interaction.target}`).join(", ")}`);
    }
  }
  if (kind === "data-persistence") {
    const dataNodes = nodes.filter((node) => /^(data-owner|data-state|data-store|data-entity|data-transform|data-sync|migration)$/.test(node.type));
    const roles = new Set(dataNodes.flatMap((node) => {
      if (node.type === "data-owner") return ["owner"];
      if (node.type === "data-store" || node.type === "data-state") return ["store"];
      if (node.type === "data-entity") return ["entity"];
      if (node.type === "data-transform") return ["transform"];
      return ["movement"];
    }));
    const requiredRoles = nodes.length >= 6 ? 3 : 2;
    if (dataNodes.length / Math.max(1, nodes.length) < 0.6 || roles.size < requiredRoles) {
      priority += 70;
      signals.push(`data lens does not preserve ${requiredRoles} distinct owner/entity/store/transform/movement roles`);
    }
    if (nodes.length >= 4 && isolated > Math.max(1, Math.floor(nodes.length * 0.2))) {
      priority += 55;
      signals.push(`${isolated}/${nodes.length} data subjects are isolated instead of forming lineage or ownership paths`);
    }
    if (uncoveredHighValuePaths.length >= 2) {
      priority += 30;
      signals.push(`data lens omits state/contract evidence from ${uncoveredHighValuePaths.slice(0, 5).join(", ")}`);
    }
  }
  if (kind === "cloud-infrastructure") {
    const infrastructureNodes = nodes.filter((node) => /^(delivery-automation|build-artifact|deployable|hosting|managed-resource|external-boundary)$/.test(node.type));
    const deliveryEdges = flow.edges.filter((edge) => edge.evidence?.relationKinds.includes("delivery-flow"));
    const roles = new Set(infrastructureNodes.flatMap((node) => {
      if (node.type === "delivery-automation") return ["delivery"];
      if (node.type === "build-artifact") return ["artifact"];
      if (node.type === "external-boundary") return ["boundary"];
      return ["runtime"];
    }));
    const requiredRoles = nodes.length >= 6 ? 3 : 2;
    if (infrastructureNodes.length / Math.max(1, nodes.length) < 0.6 || roles.size < requiredRoles || (nodes.length >= 3 && !deliveryEdges.length)) {
      priority += 75;
      signals.push(`infrastructure lens does not connect ${requiredRoles} distinct delivery/artifact/runtime/boundary roles`);
    }
    if (nodes.length >= 4 && isolated > Math.max(1, Math.floor(nodes.length * 0.2))) {
      priority += 55;
      signals.push(`${isolated}/${nodes.length} infrastructure subjects are isolated instead of forming deployment chains`);
    }
  }
  if (kind === "modules-components" && nodes.length >= 12 && !flow.subflows.length) {
    priority += 70;
    signals.push("module decomposition is flat instead of navigable through drill-down subflows");
  }
  if (["system-context", "product-capabilities", "user-journeys", "data-persistence"].includes(kind ?? "")) priority += 20;
  return { priority, signals };
}

function buildReviewUnits(flows: ReviewFlow[], scan: RepoScan, inventory?: ContentInventory): ReviewUnit[] {
  const evidence = flows.find((flow) => flow.evidenceFlow);
  if (!evidence) return [];
  const hotspotsByFile = new Map<string, NonNullable<ContentInventory["evidenceHotspots"]>>();
  for (const hotspot of inventory?.evidenceHotspots ?? []) {
    hotspotsByFile.set(hotspot.file, [...(hotspotsByFile.get(hotspot.file) ?? []), hotspot]);
  }
  const reviewableFiles = scan.files.filter((file) =>
    (Boolean(file.detectedLanguage ?? file.language) || file.role === "config" || file.role === "migration")
    && file.role !== "asset"
    && file.role !== "generated"
  ).sort((left, right) => sourceReviewPriority(right, (hotspotsByFile.get(right.relPath) ?? []).flatMap((item) => item.categories))
    - sourceReviewPriority(left, (hotspotsByFile.get(left.relPath) ?? []).flatMap((item) => item.categories))
    || left.relPath.localeCompare(right.relPath));
  const sourcePaths = reviewableFiles.map((file) => file.relPath);
  const byNode = new Map<string, SourceSlice[]>();
  for (const file of reviewableFiles) {
    const owner = bestNodeForFile(evidence.nodes, file.relPath) ?? evidence.nodes.find((node) => node.id === "node-project");
    if (!owner) continue;
    const hotspotSlices = (hotspotsByFile.get(file.relPath) ?? []).map((hotspot) => ({
      path: file.relPath,
      offset: Math.floor(hotspot.offset / MAX_SOURCE_BYTES) * MAX_SOURCE_BYTES,
      length: MAX_SOURCE_BYTES
    }));
    const orderedSlices = [...new Map([...hotspotSlices, ...slicesForFile(file)].map((slice) => [sourceSliceKey(slice), slice])).values()];
    byNode.set(owner.id, [...(byNode.get(owner.id) ?? []), ...orderedSlices]);
  }
  const evidenceUnits: ReviewUnit[] = [];
  let pendingNodes: string[] = [];
  let pendingSources: SourceSlice[] = [];
  const flush = (): void => {
    if (!pendingNodes.length && !pendingSources.length) return;
    evidenceUnits.push({
      id: `evidence-${evidenceUnits.length + 1}`,
      kind: "evidence",
      flowId: evidence.id,
      flowName: evidence.name,
      nodeIds: [...new Set(pendingNodes)],
      sourceSlices: [...new Map(pendingSources.map((slice) => [sourceSliceKey(slice), slice])).values()],
      purpose: "Verify canonical subjects, responsibilities, properties, and observed relationships against source.",
      priority: evidenceUnits.length ? 5 : 80,
      anomalySignals: evidenceUnits.length ? [] : ["high-value repository evidence"]
    });
    pendingNodes = [];
    pendingSources = [];
  };
  for (const [nodeId, ownedSources] of byNode) {
    for (const sourceBatch of chunks(ownedSources, MAX_SOURCE_SLICES_PER_UNIT)) {
      if (pendingSources.length + sourceBatch.length > MAX_SOURCE_SLICES_PER_UNIT || pendingNodes.length >= MAX_NODES_PER_UNIT) flush();
      pendingNodes.push(nodeId);
      pendingSources.push(...sourceBatch);
      if (sourceBatch.length === MAX_SOURCE_SLICES_PER_UNIT) flush();
    }
  }
  flush();

  const perspectiveUnits = flows.flatMap((flow) => flow.evidenceFlow ? [] : chunks(flow.nodes.filter((node) => node.id !== "node-project"), MAX_NODES_PER_UNIT).map((nodes, index): ReviewUnit => {
    const anomaly = perspectiveAnomalies(flow, inventory);
    const relevantPaths = [...new Set([...hotspotPathsForFlow(flow, inventory), ...nodes.flatMap((node) => {
      const lensEvidencePaths = (node.customProperties["Evidence paths"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value && !value.startsWith("none"));
      const declaredPaths = [
        ...(node.implementationScope?.claims ?? []).map((claim) => ({ path: claim.path, directory: claim.kind === "directory" })),
        ...lensEvidencePaths.map((path) => ({ path, directory: false }))
      ];
      return declaredPaths.flatMap((claim) => {
      const claimed = normalizedRepoPath(claim.path);
      if (!claimed || claimed === ".") return [];
      if (!claim.directory) return [claimed];
      return sourcePaths.filter((sourcePath) => sourcePath === claimed || sourcePath.startsWith(`${claimed}/`)).slice(0, 2);
      });
    })])].slice(0, MAX_SOURCE_SLICES_PER_UNIT);
    const fileByPath = new Map(reviewableFiles.map((file) => [file.relPath, file]));
    return {
      id: `${flow.id}-part-${index + 1}`,
      kind: "perspective",
      flowId: flow.id,
      flowName: flow.name,
      nodeIds: nodes.map((node) => node.id),
      sourceSlices: relevantPaths.flatMap((sourcePath) => {
        const file = fileByPath.get(sourcePath);
        if (!file) return [];
        const availableHotspots = hotspotsByFile.get(sourcePath) ?? [];
        const hotspot = availableHotspots.length ? bestHotspotForFlow(flow, availableHotspots) : undefined;
        return hotspot
          ? [{ path: sourcePath, offset: Math.floor(hotspot.offset / MAX_SOURCE_BYTES) * MAX_SOURCE_BYTES, length: MAX_SOURCE_BYTES }]
          : slicesForFile(file).slice(0, 1);
      }),
      purpose: `Judge whether this ${flow.perspective?.kind ?? "architecture"} flow is truthful, coherent, and useful as a human-authored engineering design view.`,
      priority: anomaly.priority - index * 5,
      anomalySignals: anomaly.signals
    };
  }));
  const overviewSlices = reviewableFiles.slice(0, MAX_SOURCE_SLICES_PER_UNIT).flatMap((file) => {
    const hotspot = hotspotsByFile.get(file.relPath)?.[0];
    return hotspot
      ? [{ path: file.relPath, offset: Math.floor(hotspot.offset / MAX_SOURCE_BYTES) * MAX_SOURCE_BYTES, length: MAX_SOURCE_BYTES }]
      : slicesForFile(file).slice(0, 1);
  });
  const crossLensSignals = [...new Set(perspectiveUnits.flatMap((unit) => unit.anomalySignals.map((signal) => `${unit.flowName}: ${signal}`)))].slice(0, 24);
  return [...evidenceUnits, ...perspectiveUnits, {
    id: "global-consistency",
    kind: "global",
    flowId: evidence.id,
    flowName: "Architecture atlas",
    nodeIds: [],
    sourceSlices: overviewSlices,
    purpose: "Audit cross-flow subject identity, naming, confidence, coverage, omissions, and contradictions using high-value repository evidence.",
    priority: 100,
    anomalySignals: ["final cross-lens omission and contradiction audit", ...crossLensSignals]
  }];
}

function selectReviewUnits(allUnits: ReviewUnit[], budget: number): ReviewUnit[] {
  const global = allUnits.find((unit) => unit.kind === "global");
  const evidence = allUnits.filter((unit) => unit.kind === "evidence").sort((left, right) => right.priority - left.priority);
  const perspectives = allUnits
    .filter((unit) => unit.kind === "perspective" && unit.anomalySignals.length > 0)
    .sort((left, right) => right.priority - left.priority);
  const selected: ReviewUnit[] = [];
  const slots = Math.max(0, budget - (global ? 1 : 0));
  if (slots > 0 && evidence.length) selected.push(evidence.shift() as ReviewUnit);
  // Spend the bounded budget on anomalous/high-value lenses first. Deterministic lens
  // contracts provide the floor; the LLM is reserved for exceptions and ambiguity.
  const perspectiveByFlow = new Map<string, ReviewUnit[]>();
  for (const unit of perspectives) perspectiveByFlow.set(unit.flowId, [...(perspectiveByFlow.get(unit.flowId) ?? []), unit]);
  const firstByPriority = [...perspectiveByFlow.values()].map((units) => units[0]).sort((left, right) => right.priority - left.priority);
  for (const first of firstByPriority) {
    if (selected.length >= slots) break;
    const units = perspectiveByFlow.get(first.flowId) as ReviewUnit[];
    units.shift();
    selected.push(first);
  }
  // One deeper partition per anomalous lens is normally more valuable than
  // spending most of a bounded run on one very large flow.
  const secondPass = [...perspectiveByFlow.values()].flatMap((units) => units.slice(0, 1)).sort((left, right) => right.priority - left.priority);
  while (selected.length < slots && secondPass.length) selected.push(secondPass.shift() as ReviewUnit);
  // Clean lenses do not consume budget. Relocate unused capacity to deeper
  // canonical source verification, which benefits every perspective.
  while (selected.length < slots && evidence.length) {
    selected.push(evidence.shift() as ReviewUnit);
  }
  const overflowPerspectives = [...perspectiveByFlow.values()].flat().filter((unit) => !selected.includes(unit)).sort((left, right) => right.priority - left.priority);
  while (selected.length < slots && overflowPerspectives.length) selected.push(overflowPerspectives.shift() as ReviewUnit);
  if (global && selected.length < budget) selected.push(global);
  return selected;
}

async function sourceExcerpt(projectRoot: string, slice: SourceSlice): Promise<string | null> {
  const normalized = normalizedRepoPath(slice.path);
  if (!normalized || normalized === ".") return null;
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
  try {
    const content = await readFile(absolute);
    if (slice.offset >= content.byteLength) return null;
    const end = Math.min(content.byteLength, slice.offset + slice.length);
    const startLine = content.subarray(0, slice.offset).toString("utf8").split(/\r?\n/).length;
    const excerpt = content.subarray(slice.offset, end).toString("utf8");
    return `--- ${normalized} (bytes ${slice.offset}-${end - 1}, starts near line ${startLine})\n${excerpt}${end < content.byteLength ? "\n…[continues in another review partition]" : ""}`;
  } catch {
    return null;
  }
}

function compactNode(node: ArchicodeNode): Record<string, unknown> {
  return {
    id: node.id,
    subjectRef: node.subjectRef,
    type: node.type,
    title: node.title,
    description: node.description,
    techStack: node.techStack,
    acceptanceCriteria: node.acceptanceCriteria,
    customProperties: node.customProperties,
    implementationScope: node.implementationScope
  };
}

function stableReviewContext(flows: ReviewFlow[], source: string[]): string {
  const evidence = flows.find((flow) => flow.evidenceFlow);
  return [
    "Shared immutable baseline for this import-review session.",
    "This canonical snapshot and repository evidence are identical across review partitions. Later-unit graph context and the applied-change ledger supersede baseline presentation fields changed by an earlier safe patch; subjectRef and implementationScope remain immutable.",
    "Canonical evidence subjects:",
    "```json",
    JSON.stringify(evidence?.nodes.filter((node) => node.id !== "node-project").map(compactNode) ?? []),
    "```",
    "High-value repository evidence:",
    source.join("\n\n")
  ].join("\n");
}

function unitGraphContext(flows: ReviewFlow[], unit: ReviewUnit): Record<string, unknown> {
  if (unit.kind === "global") {
    const occurrences = new Map<string, Array<{ flowId: string; nodeId: string; title: string; type: string }>>();
    for (const flow of flows) for (const node of flow.nodes) {
      if (!node.subjectRef) continue;
      occurrences.set(node.subjectRef.id, [...(occurrences.get(node.subjectRef.id) ?? []), { flowId: flow.id, nodeId: node.id, title: node.title, type: node.type }]);
    }
    return {
      flows: flows.map((flow) => ({
        id: flow.id,
        name: flow.name,
        description: flow.description,
        perspective: flow.perspective,
        subjectCount: flow.nodes.length,
        relationCount: flow.edges.length,
        sampleSubjects: flow.nodes.filter((node) => node.id !== "node-project").slice(0, 24).map((node) => ({ subjectRef: node.subjectRef?.id, title: node.title, type: node.type })),
        relationKinds: [...new Set(flow.edges.flatMap((edge) => edge.evidence?.relationKinds ?? []))]
      })),
      repeatedSubjects: [...occurrences]
        .filter(([, items]) => items.length > 1)
        .slice(0, 120)
        .map(([subjectRefId, items]) => ({ subjectRefId, occurrences: items }))
    };
  }
  const flow = flows.find((candidate) => candidate.id === unit.flowId);
  if (!flow) return {};
  const selected = new Set(unit.nodeIds);
  const relevantEdges = flow.edges.filter((edge) => selected.has(edge.source) || selected.has(edge.target));
  const neighborIds = new Set(relevantEdges.flatMap((edge) => [edge.source, edge.target]));
  const currentSubjectIds = new Set(flow.nodes.flatMap((node) => node.subjectRef ? [node.subjectRef.id] : []));
  const reusableBySubject = new Map<string, ArchicodeNode>();
  // Prefer canonical evidence-flow nodes, then add evidence-backed external
  // boundaries that only exist in another perspective flow.
  for (const candidateFlow of [...flows].sort((left, right) => Number(right.evidenceFlow) - Number(left.evidenceFlow))) {
    for (const node of candidateFlow.nodes) {
      if (!node.subjectRef || !["code", "external-system"].includes(node.subjectRef.kind) || reusableBySubject.has(node.subjectRef.id)) continue;
      reusableBySubject.set(node.subjectRef.id, node);
    }
  }
  return {
    flow: { id: flow.id, name: flow.name, description: flow.description, perspective: flow.perspective },
    detectedAnomalies: unit.anomalySignals,
    nodes: flow.nodes.filter((node) => selected.has(node.id) || neighborIds.has(node.id)).map(compactNode),
    edges: relevantEdges,
    reviewTargets: unit.nodeIds,
    completeFlowOverview: {
      subjects: flow.nodes.filter((node) => node.id !== "node-project").map((node) => ({ nodeId: node.id, subjectRefId: node.subjectRef?.id, title: node.title, type: node.type })),
      relationships: flow.edges.map((edge) => ({ source: edge.source, target: edge.target, label: edge.label, origin: edge.evidence?.origin }))
    },
    availableReusableSubjects: [...reusableBySubject.values()]
      .filter((node) => !currentSubjectIds.has(node.subjectRef?.id ?? ""))
      .slice(0, 80)
      .map((node) => ({
        subjectRefId: node.subjectRef?.id,
        subjectKind: node.subjectRef?.kind,
        nodeId: node.id,
        title: node.title,
        type: node.type,
        description: node.description,
        implementationScope: node.implementationScope
      }))
  };
}

const REVIEW_EDIT_SHAPES = [
  { kind: "update-flow", flowId: "flow-id", patch: { description: "Grounded description" }, reason: "Why", citations: [{ path: "src/file.ts", line: 1 }] },
  { kind: "update-node", flowId: "flow-id", nodeId: "node-id", patch: { title: "Grounded title", description: "Grounded responsibility" }, reason: "Why", citations: [{ path: "src/file.ts", line: 1 }] },
  { kind: "update-edge", flowId: "flow-id", edgeId: "edge-id", patch: { label: "specific directional verb phrase" }, reason: "Why", citations: [{ path: "src/file.ts", line: 1 }] },
  { kind: "include-subject", flowId: "perspective-flow-id", subjectRefId: "exact id from availableReusableSubjects", reason: "Why this canonical subject belongs in this lens", citations: [{ path: "src/file.ts", line: 1 }] },
  { kind: "exclude-perspective-node", flowId: "perspective-flow-id", nodeId: "node-id", reason: "Why this subject is irrelevant or misleading in this lens", citations: [{ path: "src/file.ts", line: 1 }] },
  { kind: "include-relationship", flowId: "perspective-flow-id", sourceSubjectRefId: "source subjectRef id", targetSubjectRefId: "target subjectRef id", label: "specific directional verb phrase", reason: "Why this inferred lens relationship is useful", citations: [{ path: "src/file.ts", line: 1 }] },
  { kind: "create-lens-concept", flowId: "perspective-flow-id", nodeKey: "stable-local-key", title: "Missing lens concept", type: "capability", description: "Evidence-bounded interpretation", relationships: [{ direction: "to-concept", subjectRefId: "existing subjectRef id", label: "produces" }], reason: "Why the lens needs this concept", citations: [{ path: "src/file.ts", line: 1 }] },
  { kind: "exclude-perspective-edge", flowId: "perspective-flow-id", edgeId: "edge-id", reason: "Why this relationship is irrelevant or misleading in this lens", citations: [{ path: "src/file.ts", line: 1 }] }
];

function reviewPrompt(input: {
  flows: ReviewFlow[];
  unit: ReviewUnit;
  source: string[];
  ledger: ImportReviewLedger;
  validationErrors?: string[];
}): string {
  return [
    "You are the final architecture reviewer for an imported existing codebase.",
    "Mission: reverse-engineer the implementation into truthful, useful graph flows resembling the design model a skilled engineer or architect would have authored to explain—and potentially generate—the same system.",
    "Represent the system as actually built, including debt and inconsistencies. Never beautify unsupported intent. Distinguish observed behavior from inference.",
    "The evidence flow is the implementation backbone. Perspective flows are separate human mental lenses over shared stable subjectRef identities; they are not competing sources of truth.",
    "Review the complete deliverable: flow metadata, node titles/descriptions/types/tech/properties/criteria, relationship direction/meaning, lens membership, confidence, limitations, and cross-flow consistency.",
    "Only propose a factual edit when citations in the supplied repository source support it. An edit without sufficient evidence is worse than no edit.",
    "Natural-language prompts, policies, and workflow prose prove declared or intended behavior only. They do not prove durable persistence, submitted orders, registered ratings, completed payments, embedded catalogs, deployed resources, or other external effects. Those claims require a matching observed sink, write, channel, or catalog in the supplied evidence.",
    "A generic application store/state module is transient unless concrete database, repository, schema, migration, shared-write, or equivalent durable evidence proves otherwise.",
    "Never edit IDs, subjectRef, implementationScope, edge evidence, or evidence-derived protected properties. Never remove a node or edge from the evidence flow.",
    "For perspective membership, you may include an existing subjectRef, exclude a lens-irrelevant subject/edge, add a clearly inferred relationship, or create one evidence-bounded lens concept (capability, journey step, data role, deployment role, or context boundary). An inferred relationship is always stored at confidence 0.6; do not provide confidence. Only deterministic analyzers may promote a specific semantic relationship to observed truth.",
    "Structural perspective repair IS supported. Never claim that the edit envelope cannot add/remove perspective subjects or relationships. Use include-subject, create-lens-concept, exclude-perspective-node, include-relationship, and exclude-perspective-edge when grounded evidence supports the change.",
    "For a missing subject, copy its exact subjectRef.id from availableReusableSubjects. If a missing relationship also needs that subject, place include-subject before include-relationship in the same edits array; edits are validated and applied in order.",
    "A create-lens-concept is an inferred explanation anchored by supplied citations; it never claims code ownership or creates a second implementation identity. Use it only when no canonical code/external subject can express a missing mental-model role.",
    "Return no edits when the draft is already accurate and useful. Keep edits surgical.",
    "Allowed edit shapes (choose only the operations needed):",
    "```json",
    JSON.stringify(REVIEW_EDIT_SHAPES, null, 2),
    "```",
    "",
    `Review unit: ${input.unit.id} (${input.unit.kind})`,
    `Purpose: ${input.unit.purpose}`,
    input.unit.anomalySignals.length ? `Deterministic anomaly signals: ${input.unit.anomalySignals.join("; ")}` : "",
    `Progress: ${input.ledger.reviewedUnits}/${input.ledger.totalUnits} units; ${input.ledger.reviewedSourceFiles.length}/${input.ledger.totalSourceFiles} source files inspected.`,
    "The displayed total is the complete selected budget for this run. Do not defer a visible omission on the assumption that a later unseen partition will fix it. Make any grounded safe correction now.",
    input.ledger.unitResults.some((result) => result.appliedChanges.length)
      ? `Earlier validated changes in this same review session (these supersede matching baseline presentation fields):\n${JSON.stringify(input.ledger.unitResults.flatMap((result) => result.appliedChanges))}`
      : "No earlier reviewer changes have modified the baseline presentation fields.",
    input.validationErrors?.length ? `Previous patch was rejected by deterministic validation:\n${input.validationErrors.map((error) => `- ${error}`).join("\n")}\nReturn a corrected complete response.` : "",
    "",
    "Graph section:",
    "```json",
    JSON.stringify(unitGraphContext(input.flows, input.unit)),
    "```",
    "",
    "Repository source excerpts:",
    input.source.length ? input.source.join("\n\n") : "No new raw source excerpt is needed for this global consistency unit; use the cited graph evidence and review ledger.",
    "",
    "Return ONLY this JSON envelope:",
    "```json",
    JSON.stringify({
      archicodeImportReview: {
        summary: "What was checked",
        findings: ["Grounded finding"],
        edits: [{ kind: "update-node", flowId: input.unit.flowId, nodeId: "node-id", patch: { title: "Grounded title", description: "Grounded responsibility" }, reason: "Why this improves truth/usefulness", citations: [{ path: "src/file.ts", line: 1, fact: "supporting fact" }] }],
        unresolved: ["Anything source evidence could not settle"]
      }
    }, null, 2),
    "```"
  ].filter(Boolean).join("\n");
}

function extractReviewResponse(raw: string): z.infer<typeof reviewResponseSchema> | null {
  const candidates: string[] = [];
  for (const block of raw.match(/```(?:json)?\s*([\s\S]*?)```/g) ?? []) candidates.push(block.replace(/```(?:json)?\s*/, "").replace(/```\s*$/, ""));
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const envelope = parsed.archicodeImportReview ?? parsed;
      const result = reviewResponseSchema.safeParse(envelope);
      if (result.success) return result.data;
    } catch {
      continue;
    }
  }
  return null;
}

function reviewCapabilityErrors(response: z.infer<typeof reviewResponseSchema>): string[] {
  const falseConstraintClaims = response.unresolved.filter((item) =>
    /(?:cannot|unable to|not possible to).{0,100}(?:add|include|remove|exclude|connect|relationship).{0,120}(?:operation constraints?|edit envelope|unsupported|not supported)/i.test(item)
    || /(?:operation constraints?|edit envelope).{0,120}(?:cannot|unable to|not possible)/i.test(item)
  );
  return falseConstraintClaims.length ? [
    "The response incorrectly claimed that structural perspective repair is unsupported. Use include-subject/exclude-perspective-node and include-relationship/exclude-perspective-edge with exact IDs from the supplied graph context, or state the actual missing source evidence instead."
  ] : [];
}

function updateNodeContent(node: ArchicodeNode, patch: z.infer<typeof nodeContentPatchSchema>): ArchicodeNode {
  const customProperties = { ...node.customProperties };
  for (const [key, value] of Object.entries(patch.setProperties ?? {})) {
    if (!PROTECTED_PROPERTIES.has(key)) customProperties[key] = value;
  }
  for (const key of (patch.removeProperties ?? []) as string[]) if (!PROTECTED_PROPERTIES.has(key)) delete customProperties[key];
  return archicodeNodeSchema.parse({
    ...node,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.type !== undefined ? { type: patch.type } : {}),
    ...(patch.techStack !== undefined ? { techStack: patch.techStack } : {}),
    ...(patch.acceptanceCriteria !== undefined ? { acceptanceCriteria: patch.acceptanceCriteria } : {}),
    ...(patch.visual !== undefined ? { visual: { ...node.visual, ...patch.visual } } : {}),
    customProperties
  });
}

function citationErrors(citations: Array<z.infer<typeof reviewCitationSchema>>, knownPaths: Set<string>, suppliedPaths?: Set<string>): string[] {
  return citations.flatMap((citation) => {
    const normalized = normalizedRepoPath(citation.path);
    if (!normalized || normalized === "." || !knownPaths.has(normalized)) return [`Citation path does not exist in the scanned repository: ${citation.path}`];
    if (suppliedPaths && !suppliedPaths.has(normalized)) return [`Citation path was not included in raw source supplied to this review partition: ${citation.path}`];
    return [];
  });
}

async function validateCitationLocations(projectRoot: string, edits: Array<z.infer<typeof reviewEditSchema>>, knownPaths: Set<string>, suppliedPaths: Set<string>): Promise<void> {
  const citations = edits.flatMap((edit) => edit.citations);
  const pathErrors = citationErrors(citations, knownPaths, suppliedPaths);
  if (pathErrors.length) throw new Error(pathErrors.join(" "));
  const lineCountByPath = new Map<string, number>();
  for (const citation of citations) {
    if (!citation.line) continue;
    const normalized = normalizedRepoPath(citation.path) as string;
    let lineCount = lineCountByPath.get(normalized);
    if (lineCount === undefined) {
      try {
        lineCount = (await readFile(path.resolve(projectRoot, normalized), "utf8")).split(/\r?\n/).length;
      } catch {
        throw new Error(`Citation source could not be read: ${normalized}`);
      }
      lineCountByPath.set(normalized, lineCount);
    }
    if (citation.line > lineCount) throw new Error(`Citation line ${citation.line} is outside ${normalized} (${lineCount} lines).`);
  }
}

function applyNodeToOperations(operations: ResearchGraphOperation[], baseFlowId: string, flowId: string, node: ArchicodeNode): void {
  if (flowId === baseFlowId) {
    const operation = operations.find((candidate): candidate is Extract<ResearchGraphOperation, { kind: "create-node" }> => candidate.kind === "create-node" && candidate.flowId === flowId && candidate.node.id === node.id);
    if (!operation) throw new Error(`Node ${node.id} was not found in ${flowId}.`);
    operation.node = {
      ...operation.node,
      type: node.type,
      title: node.title,
      description: node.description,
      visual: node.visual,
      techStack: node.techStack,
      acceptanceCriteria: node.acceptanceCriteria,
      customProperties: node.customProperties
    };
    return;
  }
  const operation = operations.find((candidate): candidate is Extract<ResearchGraphOperation, { kind: "create-flow" }> => candidate.kind === "create-flow" && candidate.flow.id === flowId);
  if (!operation) throw new Error(`Flow ${flowId} was not found.`);
  operation.flow.nodes = operation.flow.nodes.map((candidate) => candidate.id === node.id ? node : candidate);
}

function applyEdgeToOperations(operations: ResearchGraphOperation[], baseFlowId: string, flowId: string, edge: FlowEdge): void {
  if (flowId === baseFlowId) {
    const operation = operations.find((candidate): candidate is Extract<ResearchGraphOperation, { kind: "create-edge" }> => candidate.kind === "create-edge" && candidate.flowId === flowId && candidate.edge.id === edge.id);
    if (!operation) throw new Error(`Edge ${edge.id} was not found in ${flowId}.`);
    operation.edge = { ...operation.edge, label: edge.label, lineStyle: edge.lineStyle, animated: edge.animated, bidirectional: edge.bidirectional };
    return;
  }
  const operation = operations.find((candidate): candidate is Extract<ResearchGraphOperation, { kind: "create-flow" }> => candidate.kind === "create-flow" && candidate.flow.id === flowId);
  if (!operation) throw new Error(`Flow ${flowId} was not found.`);
  operation.flow.edges = operation.flow.edges.map((candidate) => candidate.id === edge.id ? edge : candidate);
}

function flowOperation(operations: ResearchGraphOperation[], flowId: string): Extract<ResearchGraphOperation, { kind: "create-flow" }> | undefined {
  return operations.find((operation): operation is Extract<ResearchGraphOperation, { kind: "create-flow" }> => operation.kind === "create-flow" && operation.flow.id === flowId);
}

const LENS_CONCEPT_TYPES: Partial<Record<NonNullable<Flow["perspective"]>["kind"], Set<string>>> = {
  "system-context": new Set(["system-boundary", "external-boundary", "actor", "context-note"]),
  "product-capabilities": new Set(["capability", "outcome"]),
  "user-journeys": new Set(["actor", "trigger", "journey-step", "decision", "outcome"]),
  "runtime-integrations": new Set(["runtime-step", "external-boundary", "data-contract", "event"]),
  "data-persistence": new Set(["data-owner", "data-state", "data-store", "data-entity", "data-transform", "data-sync", "migration"]),
  "cloud-infrastructure": new Set(["delivery-automation", "build-artifact", "deployable", "hosting", "managed-resource", "external-boundary"])
};

function inferredReviewEdge(input: {
  flowId: string;
  source: string;
  target: string;
  label: string;
  citations: Array<z.infer<typeof reviewCitationSchema>>;
  salt: string;
}): FlowEdge {
  const digest = createHash("sha1").update(`${input.flowId}:${input.source}:${input.target}:${input.salt}`).digest("hex").slice(0, 12);
  return flowEdgeSchema.parse({
    id: `edge-review-${digest}`,
    source: input.source,
    target: input.target,
    label: input.label,
    lineStyle: "dashed",
    evidence: {
      origin: "inferred",
      confidence: 0.6,
      relationKinds: ["architecture-review"],
      locations: input.citations,
      analyzerVersion: 1,
      checkedAt: new Date().toISOString(),
      verification: "ambiguous",
      freshness: "current"
    }
  });
}

function applyReviewEdits(input: {
  operations: ResearchGraphOperation[];
  baseFlowId: string;
  edits: Array<z.infer<typeof reviewEditSchema>>;
  knownPaths: Set<string>;
  suppliedCitationPaths: Set<string>;
}): ResearchGraphOperation[] {
  const next = cloneOperations(input.operations);
  for (const edit of input.edits) {
    const citations = citationErrors(edit.citations, input.knownPaths, input.suppliedCitationPaths);
    if (citations.length) throw new Error(citations.join(" "));
    const flow = materializeFlows(next, input.baseFlowId).find((candidate) => candidate.id === edit.flowId);
    if (!flow) throw new Error(`Flow ${edit.flowId} was not found.`);
    if (edit.kind === "update-flow") {
      if ((edit.patch.name || edit.patch.description || edit.patch.question) && !edit.citations.length) throw new Error(`Flow naming, description, or question edits require repository citations.`);
      if (edit.flowId === input.baseFlowId) {
        const operation = next.find((candidate): candidate is Extract<ResearchGraphOperation, { kind: "update-flow" }> => candidate.kind === "update-flow" && candidate.flowId === edit.flowId);
        if (!operation) throw new Error(`Evidence flow update operation was not found.`);
        operation.patch = { ...operation.patch, ...(edit.patch.name ? { name: edit.patch.name } : {}), ...(edit.patch.description ? { description: edit.patch.description } : {}) };
      } else {
        const operation = flowOperation(next, edit.flowId);
        if (!operation) throw new Error(`Perspective flow ${edit.flowId} was not found.`);
        if (edit.patch.name) operation.flow.name = edit.patch.name;
        if (edit.patch.description) operation.flow.description = edit.patch.description;
        if (operation.flow.perspective) {
          const currentConfidence = operation.flow.perspective.confidence;
          const rank = { exploratory: 0, medium: 1, high: 2 } as const;
          if (edit.patch.confidence && rank[edit.patch.confidence] > rank[currentConfidence]) throw new Error(`Review cannot increase confidence for ${edit.flowId}; new evidence must come from deterministic analysis.`);
          operation.flow.perspective = {
            ...operation.flow.perspective,
            ...(edit.patch.question ? { question: edit.patch.question } : {}),
            ...(edit.patch.confidence ? { confidence: edit.patch.confidence } : {}),
            limitations: [...new Set([...operation.flow.perspective.limitations, ...(edit.patch.addLimitations ?? [])])].slice(0, 12)
          };
        }
      }
      continue;
    }
    if (edit.kind === "update-node") {
      const node = flow.nodes.find((candidate) => candidate.id === edit.nodeId);
      if (!node) throw new Error(`Node ${edit.nodeId} was not found in ${edit.flowId}.`);
      const protectedKeys = [...Object.keys(edit.patch.setProperties ?? {}), ...(edit.patch.removeProperties ?? [])].filter((key) => PROTECTED_PROPERTIES.has(key));
      if (protectedKeys.length) throw new Error(`Review cannot rewrite evidence-derived node properties: ${[...new Set(protectedKeys)].join(", ")}.`);
      applyNodeToOperations(next, input.baseFlowId, edit.flowId, updateNodeContent(node, edit.patch));
      continue;
    }
    if (edit.kind === "update-edge") {
      const edge = flow.edges.find((candidate) => candidate.id === edit.edgeId);
      if (!edge) throw new Error(`Edge ${edit.edgeId} was not found in ${edit.flowId}.`);
      applyEdgeToOperations(next, input.baseFlowId, edit.flowId, flowEdgeSchema.parse({ ...edge, ...edit.patch }));
      continue;
    }
    if (edit.flowId === input.baseFlowId) throw new Error(`${edit.kind} is not allowed on the evidence flow.`);
    const operation = flowOperation(next, edit.flowId);
    if (!operation) throw new Error(`Perspective flow ${edit.flowId} was not found.`);
    if (edit.kind === "create-lens-concept") {
      const allowed = operation.flow.perspective ? LENS_CONCEPT_TYPES[operation.flow.perspective.kind] : undefined;
      if (!allowed?.has(edit.type)) throw new Error(`${edit.type} is not an allowed inferred concept role for ${operation.flow.perspective?.kind ?? edit.flowId}.`);
      const evidencePaths = [...new Set(edit.citations.map((citation) => normalizedRepoPath(citation.path)).filter((value): value is string => Boolean(value)))];
      const fingerprint = createHash("sha1").update(`${edit.flowId}:${edit.nodeKey}:${evidencePaths.join("\0")}`).digest("hex").slice(0, 20);
      const subjectRefId = `concept:review:${fingerprint}`;
      if (operation.flow.nodes.some((node) => node.subjectRef?.id === subjectRefId || node.id === `node-lens-review-${fingerprint}`)) {
        throw new Error(`Lens concept ${edit.nodeKey} already exists in ${edit.flowId}.`);
      }
      const concept = archicodeNodeSchema.parse({
        id: `node-lens-review-${fingerprint}`,
        type: edit.type,
        title: edit.title,
        description: edit.description,
        stage: "draft-approved-production",
        ignored: false,
        flags: [],
        locked: false,
        visual: { backgroundColor: "#5f88a8", shape: edit.type === "context-note" ? "note" : "rounded" },
        position: { x: 120 + (operation.flow.nodes.length % 4) * 340, y: 120 + Math.floor(operation.flow.nodes.length / 4) * 230 },
        techStack: [],
        acceptanceCriteria: [],
        acceptanceChecks: [],
        subjectRef: { id: subjectRefId, kind: edit.type === "context-note" ? "context-note" : "concept", evidenceStatus: edit.type === "context-note" ? "context" : "inferred", scopeFingerprint: fingerprint },
        customProperties: {
          "Lens role": edit.type,
          "Evidence paths": evidencePaths.join(", "),
          "Evidence status": "Architectural interpretation grounded in cited repository evidence",
          "Interpretation boundary": "This lens concept explains an evidenced behavior without claiming canonical code ownership"
        },
        attachments: [],
        todos: []
      });
      operation.flow.nodes.push(concept);
      for (const [index, relationship] of edit.relationships.entries()) {
        const target = operation.flow.nodes.find((node) => node.subjectRef?.id === relationship.subjectRefId);
        if (!target || target.id === concept.id) throw new Error(`Relationship subject ${relationship.subjectRefId} was not found in ${edit.flowId}.`);
        const sourceId = relationship.direction === "from-concept" ? concept.id : target.id;
        const targetId = relationship.direction === "from-concept" ? target.id : concept.id;
        if (operation.flow.edges.some((edge) => edge.source === sourceId && edge.target === targetId)) throw new Error(`Relationship ${sourceId} -> ${targetId} already exists in ${edit.flowId}.`);
        operation.flow.edges.push(inferredReviewEdge({ flowId: edit.flowId, source: sourceId, target: targetId, label: relationship.label, citations: edit.citations, salt: `${edit.nodeKey}:${index}` }));
      }
      continue;
    }
    if (edit.kind === "exclude-perspective-node") {
      const node = operation.flow.nodes.find((candidate) => candidate.id === edit.nodeId);
      if (!node || node.id === "node-project") throw new Error(`Perspective node ${edit.nodeId} cannot be excluded.`);
      operation.flow.nodes = operation.flow.nodes.filter((candidate) => candidate.id !== edit.nodeId);
      operation.flow.edges = operation.flow.edges.filter((edge) => edge.source !== edit.nodeId && edge.target !== edit.nodeId);
      continue;
    }
    if (edit.kind === "exclude-perspective-edge") {
      if (!operation.flow.edges.some((edge) => edge.id === edit.edgeId)) throw new Error(`Perspective edge ${edit.edgeId} was not found.`);
      operation.flow.edges = operation.flow.edges.filter((edge) => edge.id !== edit.edgeId);
      continue;
    }
    if (edit.kind === "include-subject") {
      if (operation.flow.nodes.some((node) => node.subjectRef?.id === edit.subjectRefId)) throw new Error(`Subject ${edit.subjectRefId} already exists in ${edit.flowId}.`);
      const source = materializeFlows(next, input.baseFlowId).flatMap((candidate) => candidate.nodes).find((node) => node.subjectRef?.id === edit.subjectRefId);
      if (!source || source.subjectRef?.kind === "concept") throw new Error(`Reusable subject ${edit.subjectRefId} was not found.`);
      const sourceIdUsedByAnotherSubject = operation.flow.nodes.some((node) => node.id === source.id && node.subjectRef?.id !== edit.subjectRefId);
      const reusableNodeId = sourceIdUsedByAnotherSubject
        ? `node-review-${createHash("sha1").update(`${edit.flowId}:${edit.subjectRefId}`).digest("hex").slice(0, 12)}`
        : source.id;
      const cloned = updateNodeContent(archicodeNodeSchema.parse({
        ...source,
        id: reusableNodeId,
        subflowId: undefined,
        groupId: undefined,
        position: { x: 120 + (operation.flow.nodes.length % 4) * 340, y: 120 + Math.floor(operation.flow.nodes.length / 4) * 230 }
      }), edit.patch ?? {});
      operation.flow.nodes.push(cloned);
      continue;
    }
    if (edit.kind === "include-relationship") {
      const source = operation.flow.nodes.find((node) => node.subjectRef?.id === edit.sourceSubjectRefId);
      const target = operation.flow.nodes.find((node) => node.subjectRef?.id === edit.targetSubjectRefId);
      if (!source || !target || source.id === target.id) throw new Error(`Relationship subjects must already exist as distinct nodes in ${edit.flowId}.`);
      if (operation.flow.edges.some((edge) => edge.source === source.id && edge.target === target.id)) throw new Error(`Relationship ${source.id} -> ${target.id} already exists in ${edit.flowId}.`);
      operation.flow.edges.push(inferredReviewEdge({
        flowId: edit.flowId,
        source: source.id,
        target: target.id,
        label: edit.label,
        citations: edit.citations,
        salt: `${edit.sourceSubjectRefId}:${edit.targetSubjectRefId}`
      }));
    }
  }
  validateReviewedOperations(next, input.operations, input.baseFlowId, input.knownPaths);
  if (JSON.stringify(next) === JSON.stringify(input.operations)) throw new Error("Review patch made no effective graph change.");
  return next;
}

function updatePerspectiveCoverage(flow: Flow): Flow {
  if (!flow.perspective) return flow;
  const observedRelations = flow.edges.filter((edge) => edge.evidence?.origin === "extracted" || edge.evidence?.origin === "resolved").length;
  return {
    ...flow,
    perspective: {
      ...flow.perspective,
      coverage: {
        subjects: Math.max(0, flow.nodes.filter((node) => node.id !== "node-project").length),
        relations: flow.edges.length,
        observedRelations,
        inferredRelations: Math.max(0, flow.edges.length - observedRelations)
      }
    }
  };
}

function newlyIntroducedUserJourneyCycleWithoutDecision(flow: Flow, baselineFlow: Flow | undefined): string[] | null {
  if (flow.perspective?.kind !== "user-journeys") return null;
  const eligible = new Set(flow.nodes.filter((node) => node.type !== "decision").map((node) => node.id));
  const adjacency = new Map<string, Array<{ target: string; edgeId: string }>>();
  for (const nodeId of eligible) adjacency.set(nodeId, []);
  for (const edge of flow.edges) {
    if (!eligible.has(edge.source) || !eligible.has(edge.target)) continue;
    adjacency.get(edge.source)?.push({ target: edge.target, edgeId: edge.id });
  }
  const baselineEdges = new Map((baselineFlow?.edges ?? []).map((edge) => [edge.id, edge]));
  const introducedEdges = flow.edges.filter((edge) => {
    const original = baselineEdges.get(edge.id);
    return eligible.has(edge.source)
      && eligible.has(edge.target)
      && (!original || original.source !== edge.source || original.target !== edge.target);
  });
  for (const introduced of introducedEdges) {
    const pending: Array<{ nodeId: string; path: string[] }> = [{ nodeId: introduced.target, path: [introduced.target] }];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop() as { nodeId: string; path: string[] };
      if (current.nodeId === introduced.source) return [introduced.source, ...current.path];
      if (visited.has(current.nodeId)) continue;
      visited.add(current.nodeId);
      for (const next of adjacency.get(current.nodeId) ?? []) {
        if (next.edgeId === introduced.id) continue;
        pending.push({ nodeId: next.target, path: [...current.path, next.target] });
      }
    }
  }
  return null;
}

export function validateReviewedOperations(
  operations: ResearchGraphOperation[],
  baselineOperations: ResearchGraphOperation[],
  baseFlowId: string,
  knownPaths: Set<string>
): void {
  const flows = materializeFlows(operations, baseFlowId);
  const baseline = materializeFlows(baselineOperations, baseFlowId);
  const baselineNodes = new Map(baseline.flatMap((flow) => flow.nodes.map((node) => [`${flow.id}\0${node.id}`, node] as const)));
  const baselineEdges = new Map(baseline.flatMap((flow) => flow.edges.map((edge) => [`${flow.id}\0${edge.id}`, edge] as const)));
  for (const flow of flows) {
    const originalFlow = baseline.find((candidate) => candidate.id === flow.id);
    if (!flow.nodes.some((node) => node.id === "node-project")) throw new Error(`${flow.id} lost its project/context node.`);
    const nodeIds = new Set<string>();
    const subjectIds = new Set<string>();
    for (const node of flow.nodes) {
      if (nodeIds.has(node.id)) throw new Error(`${flow.id} contains duplicate node ID ${node.id}.`);
      nodeIds.add(node.id);
      if (!node.subjectRef) throw new Error(`${flow.id}/${node.id} is missing subjectRef.`);
      if (subjectIds.has(node.subjectRef.id)) throw new Error(`${flow.id} depicts subject ${node.subjectRef.id} more than once.`);
      subjectIds.add(node.subjectRef.id);
      const original = baselineNodes.get(`${flow.id}\0${node.id}`);
      if (original && JSON.stringify(node.subjectRef) !== JSON.stringify(original.subjectRef)) throw new Error(`${flow.id}/${node.id} changed immutable subject identity.`);
      if (original) for (const property of PROTECTED_PROPERTIES) {
        if (node.customProperties[property] !== original.customProperties[property]) throw new Error(`${flow.id}/${node.id} changed protected evidence property ${property}.`);
      }
      for (const claim of node.implementationScope?.claims ?? []) {
        const normalized = normalizedRepoPath(claim.path);
        const knownDirectory = normalized === "." || (normalized !== null && [...knownPaths].some((knownPath) => knownPath === normalized || knownPath.startsWith(`${normalized}/`)));
        if (!normalized
          || (claim.kind === "directory" ? !knownDirectory : !knownPaths.has(normalized))) {
          throw new Error(`${flow.id}/${node.id} contains an invalid implementation-scope path: ${claim.path}`);
        }
      }
    }
    const edgeIds = new Set<string>();
    for (const edge of flow.edges) {
      if (edgeIds.has(edge.id)) throw new Error(`${flow.id} contains duplicate edge ID ${edge.id}.`);
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new Error(`${flow.id}/${edge.id} has a dangling endpoint.`);
      if (edge.source === edge.target) throw new Error(`${flow.id}/${edge.id} is a self-edge.`);
      for (const location of edge.evidence?.locations ?? []) if (!knownPaths.has(location.path)) throw new Error(`${flow.id}/${edge.id} cites a missing path: ${location.path}`);
      const original = baselineEdges.get(`${flow.id}\0${edge.id}`);
      if (original && JSON.stringify(edge.evidence) !== JSON.stringify(original.evidence)) throw new Error(`${flow.id}/${edge.id} changed immutable extracted evidence.`);
    }
    if (flow.perspective?.kind === "user-journeys") {
      const actorIds = new Set(flow.nodes.filter((node) => node.type === "actor").map((node) => node.id));
      const originalActorIds = new Set(originalFlow?.nodes.filter((node) => node.type === "actor").map((node) => node.id) ?? []);
      const originalEdges = new Map((originalFlow?.edges ?? []).map((edge) => [edge.id, edge]));
      const actorIncomingEdge = flow.edges.find((edge) => {
        if (!actorIds.has(edge.target)) return false;
        const original = originalEdges.get(edge.id);
        return !originalActorIds.has(edge.target) || !original || original.source !== edge.source || original.target !== edge.target;
      });
      if (actorIncomingEdge) {
        const actor = flow.nodes.find((node) => node.id === actorIncomingEdge.target);
        throw new Error(`${flow.id}/${actorIncomingEdge.id} creates an incoming relationship to journey actor ${actor?.title ?? actorIncomingEdge.target}; actors must initiate the journey.`);
      }
      const cycle = newlyIntroducedUserJourneyCycleWithoutDecision(flow, originalFlow);
      if (cycle) {
        const titleById = new Map(flow.nodes.map((node) => [node.id, node.title]));
        throw new Error(`${flow.id} contains a directed journey cycle without a decision node: ${cycle.map((nodeId) => titleById.get(nodeId) ?? nodeId).join(" -> ")}.`);
      }
    }
    const subflowIds = new Set(flow.subflows.map((subflow) => subflow.id));
    const groupIds = new Set(flow.groups.map((group) => group.id));
    for (const node of flow.nodes) {
      if (node.subflowId && !subflowIds.has(node.subflowId)) throw new Error(`${flow.id}/${node.id} references missing subflow ${node.subflowId}.`);
      if (node.groupId && !groupIds.has(node.groupId)) throw new Error(`${flow.id}/${node.id} references missing group ${node.groupId}.`);
    }
    flowSchema.parse(updatePerspectiveCoverage(flow));
    if (!flow.evidenceFlow && originalFlow) {
      const currentSubjects = flow.nodes.filter((node) => node.id !== "node-project").length;
      const originalSubjects = originalFlow.nodes.filter((node) => node.id !== "node-project").length;
      if (currentSubjects < 1) throw new Error(`${flow.id} cannot be reduced to an empty perspective.`);
      if (originalSubjects >= 4 && currentSubjects < Math.ceil(originalSubjects * 0.65)) throw new Error(`${flow.id} review removed more than 35% of its subjects in one atomic patch.`);
    }
  }
  const evidenceBaseline = baseline.find((flow) => flow.id === baseFlowId);
  const evidenceCurrent = flows.find((flow) => flow.id === baseFlowId);
  if (!evidenceBaseline || !evidenceCurrent || evidenceCurrent.nodes.length !== evidenceBaseline.nodes.length || evidenceCurrent.edges.length !== evidenceBaseline.edges.length) {
    throw new Error("The canonical evidence flow cannot lose or gain subjects or relationships during LLM review.");
  }
}

function persistCoverage(operations: ResearchGraphOperation[], baseFlowId: string): ResearchGraphOperation[] {
  const next = cloneOperations(operations);
  for (const operation of next) {
    if (operation.kind === "create-flow") operation.flow = updatePerspectiveCoverage(operation.flow);
  }
  return next;
}

function appendPartialReviewLimitation(operations: ResearchGraphOperation[], ledger: ImportReviewLedger): ResearchGraphOperation[] {
  if (ledger.status !== "partial") return operations;
  const next = cloneOperations(operations);
  const limitation = `Post-generation agentic review covered ${ledger.reviewedSubjectIds.length}/${ledger.totalSubjects} shared subjects, fully supplied ${ledger.reviewedSourceFiles.length}/${ledger.totalSourceFiles} reviewable source files, and grounded accepted edits in ${ledger.citedSourceFiles.length} cited source files within the selected budget; remaining claims rely on deterministic importer evidence.`;
  for (const operation of next) {
    if (operation.kind !== "create-flow" || !operation.flow.perspective) continue;
    operation.flow.perspective.limitations = [...new Set([...operation.flow.perspective.limitations, limitation])].slice(0, 12);
  }
  return next;
}

async function writeLedger(projectRoot: string, ledger: ImportReviewLedger, persist: boolean): Promise<void> {
  if (!persist) return;
  await writeJson(projectStatePath(projectRoot, "runtime", REVIEW_LEDGER_FILE), ledger);
}

function callReviewProviderAttempt(input: {
  prompt: string;
  callProvider: (prompt: string, options?: CodebaseImportProviderCallOptions) => Promise<string>;
  shouldCancel?: () => boolean;
  inactivityTimeoutMs: number;
  partitionDeadlineMs: number;
  activeGraceMs: number;
  stableContext: string;
}): Promise<string> {
  if (input.shouldCancel?.()) return Promise.reject(new CodebaseImportCancelledError());
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let lastActivityAt: number | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let cancellationTimer: ReturnType<typeof setInterval> | undefined;

    const cleanup = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (cancellationTimer) clearInterval(cancellationTimer);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      controller.abort();
      cleanup();
      reject(error);
    };
    const succeed = (value: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const scheduleInactivityTimeout = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        fail(new ReviewProviderTimeoutError(`Reviewer produced no activity for ${Math.round(input.inactivityTimeoutMs / 60_000)} minutes.`));
      }, input.inactivityTimeoutMs);
    };
    const effectiveDeadline = (): number => {
      if (lastActivityAt === undefined) return input.partitionDeadlineMs;
      const recentlyActiveAtDeadline = input.partitionDeadlineMs - lastActivityAt <= input.activeGraceMs;
      if (!recentlyActiveAtDeadline) return input.partitionDeadlineMs;
      return Math.min(input.partitionDeadlineMs + input.activeGraceMs, lastActivityAt + input.activeGraceMs);
    };
    const schedulePartitionDeadline = (): void => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const deadline = effectiveDeadline();
      deadlineTimer = setTimeout(() => {
        const extendedDeadline = effectiveDeadline();
        if (extendedDeadline > Date.now()) {
          schedulePartitionDeadline();
          return;
        }
        fail(new ReviewProviderTimeoutError("Reviewer exceeded the six-minute partition limit."));
      }, Math.max(1, deadline - Date.now()));
    };
    const onActivity = (): void => {
      if (settled) return;
      lastActivityAt = Date.now();
      scheduleInactivityTimeout();
      schedulePartitionDeadline();
    };

    scheduleInactivityTimeout();
    schedulePartitionDeadline();
    cancellationTimer = setInterval(() => {
      if (input.shouldCancel?.()) fail(new CodebaseImportCancelledError());
    }, REVIEW_CANCELLATION_POLL_MS);

    Promise.resolve()
      .then(() => input.callProvider(input.prompt, { signal: controller.signal, onActivity, stableContext: input.stableContext }))
      .then(succeed, (error) => {
        if (input.shouldCancel?.()) {
          fail(new CodebaseImportCancelledError());
          return;
        }
        fail(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

async function callReviewProviderWithRetry(input: {
  prompt: string;
  callProvider: (prompt: string, options?: CodebaseImportProviderCallOptions) => Promise<string>;
  shouldCancel?: () => boolean;
  inactivityTimeoutMs: number;
  partitionDeadlineMs: number;
  activeGraceMs: number;
  onRetry?: () => void;
  onAttemptFailure?: () => void;
  stableContext: string;
}): Promise<string> {
  let timeoutError: ReviewProviderTimeoutError | undefined;
  for (let attempt = 1; attempt <= REVIEW_PROVIDER_ATTEMPTS; attempt += 1) {
    try {
      return await callReviewProviderAttempt(input);
    } catch (error) {
      if (error instanceof CodebaseImportCancelledError || input.shouldCancel?.()) throw new CodebaseImportCancelledError();
      input.onAttemptFailure?.();
      if (!(error instanceof ReviewProviderTimeoutError)) throw error;
      timeoutError = new ReviewProviderTimeoutError(error.message, attempt);
      if (attempt >= REVIEW_PROVIDER_ATTEMPTS || Date.now() >= input.partitionDeadlineMs) break;
      input.onRetry?.();
    }
  }
  throw timeoutError ?? new ReviewProviderTimeoutError("Reviewer timed out.", REVIEW_PROVIDER_ATTEMPTS);
}

export async function reviewArchitectureAtlasOperations(input: {
  projectRoot: string;
  baseFlowId: string;
  operations: ResearchGraphOperation[];
  scan: RepoScan;
  inventory?: ContentInventory;
  effort: CodebaseImportReviewEffort;
  callProvider: (prompt: string, options?: CodebaseImportProviderCallOptions) => Promise<string>;
  onProgress?: (progress: CodebaseImportProgress) => void;
  shouldCancel?: () => boolean;
  persistLedger?: boolean;
  maxUnits?: number;
  /** Test/diagnostic override; production defaults to three minutes without provider token activity. */
  inactivityTimeoutMs?: number;
  /** Test/diagnostic override; production defaults to six minutes for the complete partition. */
  partitionTimeoutMs?: number;
  /** Test/diagnostic override for the small grace period granted to a response active at the deadline. */
  activeGraceMs?: number;
}): Promise<ImportReviewResult> {
  const baseline = cloneOperations(input.operations);
  let operations = cloneOperations(input.operations);
  const sourceFiles = new Set(input.scan.files.map((file) => file.relPath));
  // A malformed generated atlas is not an LLM-review problem. Reject it before
  // building prompts or spending a single provider call.
  validateReviewedOperations(baseline, baseline, input.baseFlowId, sourceFiles);
  const flows = materializeFlows(operations, input.baseFlowId);
  const allUnits = buildReviewUnits(flows, input.scan, input.inventory);
  const defaultBudget = codebaseReviewPartitionBudget[input.effort];
  const budget = Math.max(1, input.maxUnits ?? defaultBudget);
  const units = selectReviewUnits(allUnits, budget);
  const stableUnit = allUnits.find((unit) => unit.kind === "global");
  const stableSlices = stableUnit?.sourceSlices ?? [];
  const excerptPromises = new Map<string, Promise<string | null>>();
  const readSlice = (slice: SourceSlice): Promise<string | null> => {
    const key = sourceSliceKey(slice);
    const current = excerptPromises.get(key);
    if (current) return current;
    const pending = sourceExcerpt(input.projectRoot, slice);
    excerptPromises.set(key, pending);
    return pending;
  };
  const stableEntries = await Promise.all(stableSlices.map(async (slice) => ({ slice, excerpt: await readSlice(slice) })));
  const stableSliceKeys = new Set(stableEntries.filter((entry) => entry.excerpt).map((entry) => sourceSliceKey(entry.slice)));
  const stableSuppliedPaths = new Set(stableEntries.filter((entry) => entry.excerpt).map((entry) => entry.slice.path));
  const stableSource = stableEntries.flatMap((entry) => entry.excerpt ? [entry.excerpt] : []);
  const sharedStableContext = stableReviewContext(flows, stableSource);
  const reviewSlices = [...new Map(allUnits.flatMap((unit) => unit.sourceSlices).map((slice) => [sourceSliceKey(slice), slice])).values()];
  const reviewableSourceFiles = new Set(reviewSlices.map((slice) => slice.path));
  const plannedSliceKeysByFile = new Map<string, Set<string>>();
  for (const slice of reviewSlices) plannedSliceKeysByFile.set(slice.path, new Set([...(plannedSliceKeysByFile.get(slice.path) ?? []), sourceSliceKey(slice)]));
  const initiallyReviewedSliceKeys = units.length ? [...stableSliceKeys] : [];
  const initiallyReviewedSourceFiles = [...reviewableSourceFiles].filter((sourcePath) => {
    const required = plannedSliceKeysByFile.get(sourcePath) ?? new Set<string>();
    return [...required].every((key) => initiallyReviewedSliceKeys.includes(key));
  });
  const totalSubjects = new Set(flows.flatMap((flow) => flow.nodes.flatMap((node) => node.subjectRef && (node.subjectRef.kind === "code" || node.subjectRef.kind === "external-system") ? [node.subjectRef.id] : []))).size;
  const ledger: ImportReviewLedger = {
    version: 1,
    runId: `import-review-${Date.now().toString(36)}`,
    status: "running",
    objective: "Reverse-engineer the implemented codebase into truthful, useful, human-quality architecture flows without replacing code-derived evidence.",
    startedAt: new Date().toISOString(),
    totalUnits: units.length,
    totalPlannedUnits: allUnits.length,
    reviewedUnits: 0,
    totalSubjects,
    reviewedSubjectIds: [],
    totalSourceFiles: reviewableSourceFiles.size,
    reviewedSourceFiles: initiallyReviewedSourceFiles,
    citedSourceFiles: [],
    totalSourceSlices: reviewSlices.length,
    reviewedSourceSlices: initiallyReviewedSliceKeys,
    proposedEdits: 0,
    appliedEdits: 0,
    rejectedBatches: 0,
    failedProviderAttempts: 0,
    findings: [],
    unresolved: [],
    limitations: allUnits.length > units.length ? [`Anomaly-driven review selected ${units.length}/${allUnits.length} possible partitions; deterministic architecture contracts protect unselected areas.`] : [],
    unitResults: []
  };
  await writeLedger(input.projectRoot, ledger, input.persistLedger ?? false);

  const sourceForUnit = async (unit: ReviewUnit): Promise<{ excerpts: string[]; suppliedPaths: Set<string>; suppliedSliceKeys: string[] }> => {
    const dynamicSlices = unit.sourceSlices.filter((slice) => !stableSliceKeys.has(sourceSliceKey(slice)));
    const entries = await Promise.all(dynamicSlices.map(async (slice) => ({ slice, excerpt: await readSlice(slice) })));
    return {
      excerpts: entries.flatMap((entry) => entry.excerpt ? [entry.excerpt] : []),
      suppliedPaths: new Set(entries.filter((entry) => entry.excerpt).map((entry) => entry.slice.path)),
      suppliedSliceKeys: entries.filter((entry) => entry.excerpt).map((entry) => sourceSliceKey(entry.slice))
    };
  };
  const prefetched = new Map<string, PrefetchedReview>();
  const seenPerspectiveFlows = new Set<string>();
  const independentPerspectiveUnits = units.filter((unit) => {
    if (unit.kind !== "perspective" || seenPerspectiveFlows.has(unit.flowId)) return false;
    seenPerspectiveFlows.add(unit.flowId);
    return true;
  });
  if (independentPerspectiveUnits.length > 1) {
    input.onProgress?.({
      phase: "review",
      label: `Reviewing ${independentPerspectiveUnits.length} independent architecture lenses`,
      detail: `Running up to ${REVIEW_PREFLIGHT_CONCURRENCY} non-overlapping lens reviews concurrently; patches will still be validated and applied in order.`,
      itemsDone: 0,
      itemsTotal: units.length
    });
    await mapWithConcurrency(independentPerspectiveUnits, REVIEW_PREFLIGHT_CONCURRENCY, async (unit) => {
      if (input.shouldCancel?.()) throw new CodebaseImportCancelledError();
      const startedAtMs = Date.now();
      const result: PrefetchedReview = {
        providerAttempts: 0,
        failedProviderAttempts: 0,
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        partitionDeadlineMs: startedAtMs + Math.max(input.inactivityTimeoutMs ?? REVIEW_INACTIVITY_TIMEOUT_MS, input.partitionTimeoutMs ?? REVIEW_PARTITION_TIMEOUT_MS)
      };
      try {
        const source = await sourceForUnit(unit);
        result.raw = await callReviewProviderWithRetry({
          prompt: reviewPrompt({ flows, unit, source: source.excerpts, ledger }),
          callProvider: async (prompt, options) => {
            result.providerAttempts += 1;
            return input.callProvider(prompt, options);
          },
          shouldCancel: input.shouldCancel,
          inactivityTimeoutMs: Math.max(1, input.inactivityTimeoutMs ?? REVIEW_INACTIVITY_TIMEOUT_MS),
          partitionDeadlineMs: result.partitionDeadlineMs,
          activeGraceMs: Math.max(0, input.activeGraceMs ?? REVIEW_ACTIVE_GRACE_MS),
          onAttemptFailure: () => {
            result.failedProviderAttempts += 1;
          },
          stableContext: sharedStableContext
        });
      } catch (error) {
        if (error instanceof CodebaseImportCancelledError || input.shouldCancel?.()) throw new CodebaseImportCancelledError();
        result.error = error instanceof Error ? error : new Error(String(error));
      }
      prefetched.set(unit.id, result);
    });
  }

  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    if (input.shouldCancel?.()) throw new CodebaseImportCancelledError();
    const unit = units[unitIndex];
    const prefetchedReview = prefetched.get(unit.id);
    const unitStartedAt = prefetchedReview?.startedAt ?? new Date().toISOString();
    const unitStartedAtMs = prefetchedReview?.startedAtMs ?? Date.now();
    let providerAttempts = prefetchedReview?.providerAttempts ?? 0;
    let failedProviderAttempts = prefetchedReview?.failedProviderAttempts ?? 0;
    let appliedChanges: Array<z.infer<typeof reviewEditSchema>> = [];
    input.onProgress?.({
      phase: "review",
      label: `Reviewing generated architecture (${unitIndex + 1}/${units.length})`,
      detail: `${unit.flowName} · ${unit.purpose}`,
      itemsDone: unitIndex,
      itemsTotal: units.length
    });
    const source = await sourceForUnit(unit);
    const suppliedCitationPaths = new Set([...stableSuppliedPaths, ...source.suppliedPaths]);
    const inactivityTimeoutMs = Math.max(1, input.inactivityTimeoutMs ?? REVIEW_INACTIVITY_TIMEOUT_MS);
    const partitionTimeoutMs = Math.max(inactivityTimeoutMs, input.partitionTimeoutMs ?? REVIEW_PARTITION_TIMEOUT_MS);
    const activeGraceMs = Math.max(0, input.activeGraceMs ?? REVIEW_ACTIVE_GRACE_MS);
    // A prefetched response already satisfied its own deadline. If deterministic
    // validation asks for a repair, grant that repair the normal fresh ceiling.
    const partitionDeadlineMs = Date.now() + partitionTimeoutMs;
    let response: z.infer<typeof reviewResponseSchema> | null = null;
    let validationErrors: string[] | undefined;
    for (let attempt = 0; attempt <= MAX_PATCH_RETRIES; attempt += 1) {
      const currentFlows = materializeFlows(operations, input.baseFlowId);
      let raw: string;
      if (attempt === 0 && prefetchedReview) {
        if (prefetchedReview.error) {
          validationErrors = [`Provider call failed: ${prefetchedReview.error.message}`];
          if (prefetchedReview.error instanceof ReviewProviderTimeoutError) break;
          continue;
        }
        raw = prefetchedReview.raw ?? "";
      } else {
        try {
          raw = await callReviewProviderWithRetry({
          prompt: reviewPrompt({ flows: currentFlows, unit, source: source.excerpts, ledger, validationErrors }),
          callProvider: async (prompt, options) => {
            providerAttempts += 1;
            return input.callProvider(prompt, options);
          },
          shouldCancel: input.shouldCancel,
          inactivityTimeoutMs,
          partitionDeadlineMs,
          activeGraceMs,
          onAttemptFailure: () => {
            failedProviderAttempts += 1;
          },
          stableContext: sharedStableContext,
          onRetry: () => input.onProgress?.({
            phase: "review",
            label: `Retrying generated architecture review (${unitIndex + 1}/${units.length})`,
            detail: `${unit.flowName} · No model activity for three minutes; retrying once.`,
            itemsDone: unitIndex,
            itemsTotal: units.length
          })
          });
        } catch (error) {
          if (error instanceof CodebaseImportCancelledError || input.shouldCancel?.()) throw new CodebaseImportCancelledError();
          validationErrors = [`Provider call failed: ${error instanceof Error ? error.message : String(error)}`];
          if (error instanceof ReviewProviderTimeoutError) break;
          continue;
        }
      }
      response = extractReviewResponse(raw);
      if (!response) {
        validationErrors = ["Response was not valid archicodeImportReview JSON."];
        ledger.rejectedBatches += 1;
        continue;
      }
      const capabilityErrors = reviewCapabilityErrors(response);
      if (capabilityErrors.length) {
        validationErrors = capabilityErrors;
        ledger.rejectedBatches += 1;
        response = null;
        continue;
      }
      ledger.proposedEdits += response.edits.length;
      try {
        if (response.edits.length) {
          await validateCitationLocations(input.projectRoot, response.edits, sourceFiles, suppliedCitationPaths);
          operations = applyReviewEdits({ operations, baseFlowId: input.baseFlowId, edits: response.edits, knownPaths: sourceFiles, suppliedCitationPaths });
          operations = persistCoverage(operations, input.baseFlowId);
          appliedChanges = structuredClone(response.edits);
        }
        ledger.appliedEdits += response.edits.length;
        validationErrors = undefined;
        break;
      } catch (error) {
        validationErrors = [error instanceof Error ? error.message : String(error)];
        ledger.rejectedBatches += 1;
        response = null;
      }
    }
    const reviewedFlow = materializeFlows(operations, input.baseFlowId).find((flow) => flow.id === unit.flowId);
    for (const nodeId of unit.nodeIds) {
      const subjectRef = reviewedFlow?.nodes.find((node) => node.id === nodeId)?.subjectRef;
      if (subjectRef && (subjectRef.kind === "code" || subjectRef.kind === "external-system") && !ledger.reviewedSubjectIds.includes(subjectRef.id)) ledger.reviewedSubjectIds.push(subjectRef.id);
    }
    for (const key of source.suppliedSliceKeys) {
      if (!ledger.reviewedSourceSlices.includes(key)) ledger.reviewedSourceSlices.push(key);
    }
    for (const sourcePath of new Set(unit.sourceSlices.map((slice) => slice.path))) {
      const required = plannedSliceKeysByFile.get(sourcePath) ?? new Set<string>();
      if ([...required].every((key) => ledger.reviewedSourceSlices.includes(key)) && !ledger.reviewedSourceFiles.includes(sourcePath)) ledger.reviewedSourceFiles.push(sourcePath);
    }
    for (const sourcePath of appliedChanges.flatMap((change) => change.citations.map((citation) => normalizedRepoPath(citation.path))).filter((value): value is string => Boolean(value))) {
      if (!ledger.citedSourceFiles.includes(sourcePath)) ledger.citedSourceFiles.push(sourcePath);
    }
    ledger.reviewedUnits += 1;
    ledger.failedProviderAttempts += failedProviderAttempts;
    if (response) {
      ledger.findings.push(...response.findings.map((finding) => `${unit.id}: ${finding}`));
      ledger.unresolved.push(...response.unresolved.map((finding) => `${unit.id}: ${finding}`));
    } else if (validationErrors?.length) {
      ledger.unresolved.push(`${unit.id}: provider review could not produce a valid safe patch (${validationErrors.join(" ")})`);
    }
    ledger.findings = ledger.findings.slice(-200);
    ledger.unresolved = ledger.unresolved.slice(-200);
    const unitFindings = response?.findings ?? [];
    const unitUnresolved = response?.unresolved ?? (validationErrors?.length ? [`Provider review could not produce a valid safe patch (${validationErrors.join(" ")})`] : []);
    const completedAt = new Date().toISOString();
    ledger.unitResults.push({
      unitId: unit.id,
      flowId: unit.flowId,
      kind: unit.kind,
      purpose: unit.purpose,
      priority: unit.priority,
      anomalySignals: [...unit.anomalySignals],
      startedAt: unitStartedAt,
      completedAt,
      durationMs: Date.now() - unitStartedAtMs,
      providerAttempts,
      failedProviderAttempts,
      proposedEdits: response?.edits.length ?? 0,
      appliedEdits: appliedChanges.length,
      appliedChanges,
      findings: unitFindings,
      unresolved: unitUnresolved
    });
    await writeLedger(input.projectRoot, ledger, input.persistLedger ?? false);
  }

  input.onProgress?.({ phase: "verify", label: "Verifying reviewed graph flows", detail: "Checking schema, evidence, subject identity, references, and perspective coverage." });
  const failedReviewUnit = ledger.unresolved.some((item) => item.includes("provider review could not produce a valid safe patch"));
  ledger.status = ledger.reviewedUnits === allUnits.length && !failedReviewUnit ? "complete" : "partial";
  operations = appendPartialReviewLimitation(persistCoverage(operations, input.baseFlowId), ledger);
  validateReviewedOperations(operations, baseline, input.baseFlowId, sourceFiles);
  ledger.completedAt = new Date().toISOString();
  if (ledger.unresolved.length) ledger.limitations.push(`${ledger.unresolved.length} review question${ledger.unresolved.length === 1 ? " remains" : "s remain"} unresolved and ${ledger.unresolved.length === 1 ? "was" : "were"} not converted into graph truth.`);
  await writeLedger(input.projectRoot, ledger, input.persistLedger ?? false);
  return { operations, ledger };
}
