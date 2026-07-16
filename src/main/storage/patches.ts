import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyNodePatch,
  archicodeNodeSchema,
  flowSchema,
  llmPatchProposalSchema,
  patchOperationDecisionSchema,
  patchReviewRecordSchema,
  artifactSchema,
  runSchema
} from "../../shared/schema";
import type {
  Artifact,
  Flow,
  LlmPatchProposal,
  PatchReviewRecord,
  ProjectBundle,
  ProjectSettings,
  Run,
  RunEffort,
  PatchOperationDecision,
  SourceFileProposal,
  SourceFileSafetyResult,
  FlowEdge,
  FlowSubflow,
  NodePatch
} from "../../shared/schema";
import { projectSchema } from "../../shared/schema";
import { extractTextDocument, isSupportedTextDocumentMediaType } from "../documentText";
import { isSupportedTextAttachmentMediaType } from "./artifacts";
import { type SourceSnapshot, isSameOrInside } from "./contextBuilder";
import { type ImplementationFileMapping, ensureProject, loadProject, persistImplementationFileMappings, saveFlow, touchProject, updateNode, writeProjectFiles } from "./projectStore";
import { SOURCE_DIFF_IGNORE_DIRS, SOURCE_PROPOSAL_MAX_BYTES, SOURCE_PROPOSAL_REVIEW_PATHS, SOURCE_PROPOSAL_SECRET_PATTERNS, buildUnifiedSourceDiff, collectSourceSnapshot, markRunNodesWithDiff, persistAndMaybeApplyPatchProposal, writeSourceDiffArtifact } from "./runEngine";
import { readRun, writeRun } from "./runLogs";
import type { QuarantinedPatchOperation } from "../../shared/patchExtraction";
import { sourceFileProposalNodeIds } from "../../shared/sourceHandoff";
import { mediaTypeForFile } from "./artifacts";
import { addNote, deleteNote, updateNoteResolved } from "./notes";
import { PROJECT_STATE_DIR, exists, id, iso, projectStatePath, readJson, readTextIfExists, safeParseMany, safeParseOne, readJsonDirectory, sha256File, writeJson } from "./persistence";

export type PatchProposalView = {
  artifact: Artifact;
  proposal: unknown;
  review: PatchReviewRecord | null;
  validationErrors: string[];
};

export type PersistedPatchProposal = {
  artifact: Artifact;
  mode: ProjectSettings["patchReviewMode"];
  autoApplied: boolean;
  pendingReview: boolean;
  pendingSourceOperationIndexes?: number[];
  pendingSourcePaths?: string[];
  sourceOperationsBlocked?: boolean;
  hasSourceFileOperations?: boolean;
  valid: boolean;
  summary?: string;
  implementationStatus?: "complete" | "continue" | "blocked";
  implementationNotes?: string;
  nextSourceSlice?: string;
  needsReplan?: boolean;
  replanReason?: string;
  suggestedQuestions?: string[];
  implementationEffort?: Exclude<RunEffort, "auto">;
  implementationTasks?: Array<{ id?: string; title: string; summary?: string; verificationCommand?: string; lightVerificationCommand?: string; batchBudget?: number }>;
  warnings?: string[];
  quarantinedOperations?: QuarantinedPatchOperation[];
  validationError?: string;
};

export async function listPatchProposals(projectRoot: string): Promise<PatchProposalView[]> {
  await ensureProject(projectRoot);
  const artifactFiles = await readdir(projectStatePath(projectRoot, "artifacts"));
  const proposals: PatchProposalView[] = [];

  for (const fileName of artifactFiles.filter((file) => file.endsWith(".json")).sort()) {
    const filePath = projectStatePath(projectRoot, "artifacts", fileName);
    const raw = await readJson<Record<string, unknown>>(filePath, {});
    if (!("archicodePatch" in raw)) continue;

    const artifactResult = artifactSchema.safeParse(raw);
    const proposalResult = llmPatchProposalSchema.safeParse(raw.archicodePatch);
    const validationErrors: string[] = [];

    if (!artifactResult.success) {
      validationErrors.push(...artifactResult.error.issues.map((issue) => `${fileName}: ${issue.path.join(".")} ${issue.message}`));
    }

    if (!proposalResult.success) {
      validationErrors.push(...proposalResult.error.issues.map((issue) => `${fileName}: archicodePatch.${issue.path.join(".")} ${issue.message}`));
    }

    if (artifactResult.success) {
      proposals.push({
        artifact: artifactResult.data,
        proposal: proposalResult.success ? proposalResult.data : raw.archicodePatch,
        review: await readPatchReview(projectRoot, artifactResult.data.id),
        validationErrors
      });
    }
  }

  return proposals;
}

export async function readArtifactText(projectRoot: string, artifactRelativePath: string): Promise<string> {
  const root = await realpath(projectRoot);
  const absolutePath = await realpath(path.resolve(projectRoot, artifactRelativePath));
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Artifact preview is limited to files inside the project folder.");
  }
  const fileStat = await stat(absolutePath);
  const mediaType = mediaTypeForFile(absolutePath);
  if (isSupportedTextAttachmentMediaType(mediaType)) {
    if (fileStat.size > 12_000_000) {
      return `Preview omitted. Artifact is ${(fileStat.size / 1024 / 1024).toFixed(1)} MB, which is larger than the document extraction limit.`;
    }
    if (mediaType.startsWith("text/") && fileStat.size > 250_000) {
      return `Preview omitted. Artifact is ${(fileStat.size / 1024).toFixed(1)} KB, which is larger than the inline preview limit.`;
    }
    const extracted = await extractTextDocument(absolutePath, mediaType);
    const prefix = extracted.extracted
      ? [
          "[text extracted from document attachment]",
          ...extracted.warnings.slice(0, 3).map((warning) => `[extraction warning] ${warning}`)
        ].join("\n")
      : "";
    if (absolutePath.endsWith(".json")) {
      try {
        const parsed = JSON.parse(extracted.text) as Record<string, unknown>;
        if (parsed.type === "plan") {
          return [prefix, JSON.stringify(parsed, null, 2)].filter(Boolean).join("\n");
        }
        for (const key of ["diff", "patch", "text", "content"]) {
          if (typeof parsed[key] === "string") return [prefix, parsed[key]].filter(Boolean).join("\n");
        }
        return [prefix, JSON.stringify(parsed, null, 2)].filter(Boolean).join("\n");
      } catch {
        return [prefix, extracted.text].filter(Boolean).join("\n");
      }
    }
    return [prefix, extracted.text].filter(Boolean).join("\n");
  }
  if (fileStat.size > 250_000) {
    return `Preview omitted. Artifact is ${(fileStat.size / 1024).toFixed(1)} KB, which is larger than the inline preview limit.`;
  }
  const text = await readFile(absolutePath, "utf8");
  if (absolutePath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.type === "plan") return JSON.stringify(parsed, null, 2);
      for (const key of ["diff", "patch", "text", "content"]) {
        if (typeof parsed[key] === "string") return parsed[key];
      }
      return JSON.stringify(parsed, null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

export async function readArtifactDataUrl(projectRoot: string, artifactRelativePath: string): Promise<string> {
  const root = await realpath(projectRoot);
  const absolutePath = await realpath(path.resolve(projectRoot, artifactRelativePath));
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Artifact preview is limited to files inside the project folder.");
  }
  const mediaType = mediaTypeForFile(absolutePath);
  if (!mediaType.startsWith("image/")) {
    throw new Error("Inline artifact previews are only available for image attachments.");
  }
  const fileStat = await stat(absolutePath);
  if (fileStat.size > 8_000_000) {
    throw new Error(`Image preview omitted. Artifact is ${(fileStat.size / 1024 / 1024).toFixed(1)} MB.`);
  }
  const bytes = await readFile(absolutePath);
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

export async function readPatchReview(projectRoot: string, artifactId: string): Promise<PatchReviewRecord | null> {
  const reviewPath = projectStatePath(projectRoot, "reviews", `${artifactId}.json`);
  if (!(await exists(reviewPath))) return null;
  return patchReviewRecordSchema.parse(await readJson(reviewPath, null));
}

export const REVIEWABLE_GRAPH_OPERATION_KINDS = new Set([
  "update-project", "create-flow", "update-flow", "update-subflow", "link-node-subflow",
  "update-node", "update-edge", "add-note", "resolve-note", "delete-note",
  "create-node", "create-edge", "create-subflow", "delete-node", "delete-edge", "delete-subflow",
  "create-group", "update-group", "delete-group"
]);

export async function applyPatchProposal(
  projectRoot: string,
  proposalArtifactId: string,
  decisions: PatchOperationDecision[],
  options: { recordSourceDiff?: boolean } = {}
): Promise<ProjectBundle> {
  const proposals = await listPatchProposals(projectRoot);
  const item = proposals.find((proposal) => proposal.artifact.id === proposalArtifactId);
  if (!item) throw new Error(`Patch proposal ${proposalArtifactId} was not found.`);

  const proposal = llmPatchProposalSchema.parse(item.proposal);
  const parsedDecisions = decisions.map((decision) => patchOperationDecisionSchema.parse(decision));
  const accepted = new Map(parsedDecisions.map((decision) => [decision.operationIndex, decision]));
  const results: PatchReviewRecord["results"] = [];
  const appliedImplementationMappings: ImplementationFileMapping[] = [];
  const shouldRecordSourceDiff = options.recordSourceDiff !== false;
  const before = shouldRecordSourceDiff ? await collectSourceSnapshot(projectRoot) : null;

  for (const [operationIndex, operation] of proposal.operations.entries()) {
    const decision = accepted.get(operationIndex);
    if (!decision || decision.decision === "rejected") {
      results.push({
        operationIndex,
        status: "rejected",
        message: decision?.reason ?? "Rejected or left unapplied by the user."
      });
      continue;
    }

    try {
      if (operation.kind === "update-node") {
        await applyPatchNodeOperation(projectRoot, operation.flowId, operation.patch);
      } else if (operation.kind === "add-note") {
        await addNote(projectRoot, operation.note);
      } else if (operation.kind === "resolve-note") {
        await updateNoteResolved(projectRoot, operation.noteId, operation.resolved);
      } else if (operation.kind === "delete-note") {
        await deleteNote(projectRoot, operation.noteId);
      } else if (operation.kind === "add-artifact-reference") {
        await writePatchArtifactReference(projectRoot, operation.artifact);
      } else if (operation.kind === "propose-node") {
        await applyProposedNodeOperation(projectRoot, operation.flowId, operation.node);
      } else if (operation.kind === "propose-edge") {
        await applyProposedEdgeOperation(projectRoot, operation.flowId, operation.edge);
      } else if (operation.kind === "propose-subflow") {
        await applyProposedSubflowOperation(projectRoot, operation.flowId, operation.subflow);
      } else if (operation.kind === "propose-graph-operation") {
        const graphOperationKind = typeof operation.operation.kind === "string" ? operation.operation.kind : "";
        if (!REVIEWABLE_GRAPH_OPERATION_KINDS.has(graphOperationKind)) {
          throw new Error(`Unsupported reviewed graph operation: ${graphOperationKind || "missing kind"}.`);
        }
        const { applyExternalGraphOperation } = await import("../research/graphOps");
        await applyExternalGraphOperation(projectRoot, operation.operation);
      } else if (operation.kind === "propose-source-file") {
        const result = await applyProposedSourceFileOperation(projectRoot, operation, true, proposal.runId);
        if (result.status !== "applied") throw new Error(result.message);
        appliedImplementationMappings.push(...sourceFileProposalNodeIds(operation)
          .map((nodeId) => ({ nodeId, path: operation.path, action: operation.action })));
        results.push({ operationIndex, status: "applied", message: result.message });
        continue;
      } else if (operation.kind === "propose-run-profile") {
        await applyProposedRunProfileOperation(projectRoot, operation);
      } else {
        await applyProposedProjectFileOperation(projectRoot, operation);
      }
      results.push({ operationIndex, status: "applied", message: "Applied successfully." });
    } catch (error) {
      results.push({
        operationIndex,
        status: "failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const review: PatchReviewRecord = patchReviewRecordSchema.parse({
    proposalArtifactId,
    runId: proposal.runId,
    reviewedAt: iso(),
    decisions: parsedDecisions,
    results
  });
  await writeJson(projectStatePath(projectRoot, "reviews", `${proposalArtifactId}.json`), review);
  await updatePatchArtifactStatus(projectRoot, item.artifact.path, results);
  if (proposal.runId && appliedImplementationMappings.length) {
    await persistImplementationFileMappings(projectRoot, proposal.runId, appliedImplementationMappings);
  }
  if (shouldRecordSourceDiff && before && results.some((result) => result.status === "applied")) {
    const run = proposal.runId ? await readRun(projectRoot, proposal.runId).catch(() => null) : null;
    if (run) {
      const after = await collectSourceSnapshot(projectRoot);
      const diffArtifact = await writeSourceDiffArtifact(projectRoot, run, buildUnifiedSourceDiff(before, after));
      if (diffArtifact) {
        await markRunNodesWithDiff(projectRoot, run, diffArtifact);
        const latestRun = await readRun(projectRoot, run.id).catch(() => run);
        await writeRun(projectRoot, runSchema.parse({
          ...latestRun,
          sourceDiffArtifactIds: latestRun.sourceDiffArtifactIds.includes(diffArtifact.id)
            ? latestRun.sourceDiffArtifactIds
            : [...latestRun.sourceDiffArtifactIds, diffArtifact.id],
          contextArtifacts: latestRun.contextArtifacts.includes(diffArtifact.id)
            ? latestRun.contextArtifacts
            : [...latestRun.contextArtifacts, diffArtifact.id],
          logs: [
            ...latestRun.logs,
            { at: iso(), stream: "system", text: `Source diff artifact: ${diffArtifact.path}` }
          ]
        }));
      }
    }
  }
  await touchProject(projectRoot);
  return loadProject(projectRoot);
}

export function isAutoPatchOperationAllowed(operation: LlmPatchProposal["operations"][number]): boolean {
  if (operation.kind === "add-note" || operation.kind === "resolve-note" || operation.kind === "add-artifact-reference") return true;
  if (operation.kind === "propose-project-file") return true;
  if (operation.kind === "propose-run-profile") return true;
  if (
    operation.kind === "delete-note" ||
    operation.kind === "propose-node" ||
    operation.kind === "propose-edge" ||
    operation.kind === "propose-subflow" ||
    operation.kind === "propose-graph-operation" ||
    operation.kind === "propose-source-file"
  ) return false;
  if (isApprovalPatchOperation(operation)) return false;
  const managerialNodeFields = new Set(["id", "stage", "flags", "todos", "attachments"]);
  if (operation.patch.locked === false) return false;
  const fields = operation.patch.fields;
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    const entries = Object.entries(fields as Record<string, unknown>);
    if (entries.some(([key]) => !managerialNodeFields.has(key))) return false;
    if ((fields as Record<string, unknown>).stage && (fields as Record<string, unknown>).stage !== "draft") return false;
    return Object.keys(operation.patch).every((key) => key === "id" || key === "fields");
  }
  if (operation.patch.stage && operation.patch.stage !== "draft") return false;
  return Object.keys(operation.patch).every((key) => managerialNodeFields.has(key));
}

export function isApprovalPatchOperation(operation: LlmPatchProposal["operations"][number]): boolean {
  if (operation.kind === "update-node") {
    return operation.patch.stage === "plan-approved" ||
      operation.patch.stage === "draft-approved-production" ||
      operation.patch.locked === true ||
      Array.isArray(operation.patch.flags) && operation.patch.flags.includes("user-approved") ||
      operation.patch.forceUnlockRevision === true;
  }
  if (operation.kind === "propose-node") {
    return operation.node.stage === "plan-approved" ||
      operation.node.stage === "draft-approved-production" ||
      operation.node.locked === true ||
      operation.node.flags.includes("user-approved");
  }
  if (operation.kind === "propose-graph-operation") return false;
  return false;
}

export function hasStructuralProposalOperations(proposal: LlmPatchProposal): boolean {
  return proposal.operations.some((operation) =>
    operation.kind === "propose-node" ||
    operation.kind === "propose-edge" ||
    operation.kind === "propose-subflow" ||
    operation.kind === "propose-graph-operation"
  );
}

export function hasSourceFileOperations(proposal: LlmPatchProposal): boolean {
  return proposal.operations.some((operation) => operation.kind === "propose-source-file");
}

export function isManualGraphReviewOperation(operation: LlmPatchProposal["operations"][number]): boolean {
  if (operation.kind === "propose-node" || operation.kind === "propose-edge" || operation.kind === "propose-subflow" || operation.kind === "propose-graph-operation") return true;
  if (operation.kind !== "update-node") return false;
  const fields = operation.patch.fields;
  const entries = fields && typeof fields === "object" && !Array.isArray(fields)
    ? Object.entries(fields as Record<string, unknown>)
    : Object.entries(operation.patch).filter(([key]) => key !== "id");
  const bookkeepingFields = new Set(["stage", "flags", "todos", "attachments"]);
  return entries.some(([key]) => !bookkeepingFields.has(key));
}

export function hasManualGraphReviewOperations(proposal: LlmPatchProposal): boolean {
  return proposal.operations.some(isManualGraphReviewOperation);
}

export function hasOnlyProjectFileOperations(proposal: LlmPatchProposal): boolean {
  return proposal.operations.length > 0 && proposal.operations.every((operation) => operation.kind === "propose-project-file");
}

export function proposedSourceContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export async function autoPatchDecisions(
  projectRoot: string,
  proposal: LlmPatchProposal,
  options: { allowReviewRequiredSourceFiles?: boolean; rejectSourceFileOperations?: boolean; rejectPlanningQuestions?: boolean; runId?: string } = {}
): Promise<PatchOperationDecision[]> {
  const decisions: PatchOperationDecision[] = [];
  for (const [operationIndex, operation] of proposal.operations.entries()) {
    decisions.push(await autoPatchDecision(projectRoot, operation, operationIndex, options));
  }
  return decisions;
}

export async function autoPatchDecision(
  projectRoot: string,
  operation: LlmPatchProposal["operations"][number],
  operationIndex: number,
  options: { allowReviewRequiredSourceFiles?: boolean; rejectSourceFileOperations?: boolean; rejectPlanningQuestions?: boolean; runId?: string } = {}
): Promise<PatchOperationDecision> {
  if (operation.kind === "add-note" && operation.note.kind === "llm-question" && options.rejectPlanningQuestions) {
    return {
      operationIndex,
      decision: "rejected",
      reason: "Skipped planning question because plan review is automatic."
    };
  }
  if (operation.kind === "propose-source-file") {
    if (options.rejectSourceFileOperations) {
      return {
        operationIndex,
        decision: "rejected",
        reason: "Source-file proposals are only actionable during coding; planning output should update graph notes or ask questions."
      };
    }
    const safety = await evaluateSourceFileSafety(projectRoot, operation, { runId: options.runId });
    const reviewCanBeAutoApproved = options.allowReviewRequiredSourceFiles && operation.action !== "delete";
    if (safety.safe && (!safety.requiresReview || reviewCanBeAutoApproved)) {
      return {
        operationIndex,
        decision: "accepted",
        reason: `Auto-applied safe source-file proposal: ${safety.reason}`
      };
    }
    return {
      operationIndex,
      decision: "rejected",
      reason: `Source-file proposal requires review: ${safety.reason}`
    };
  }
  if (operation.kind === "propose-project-file") {
    return {
      operationIndex,
      decision: "accepted",
      reason: "Auto-applied harness-managed project convention file proposal."
    };
  }
  if (operation.kind === "propose-run-profile") {
    return {
      operationIndex,
      decision: "accepted",
      reason: "Auto-applied harness run target profile proposal."
    };
  }
  if (isApprovalPatchOperation(operation)) {
    return {
      operationIndex,
      decision: "rejected",
      reason: "LLM-generated patches cannot approve nodes, set user approval flags, or lock nodes as approved."
    };
  }
  if (isAutoPatchOperationAllowed(operation)) {
    return {
      operationIndex,
      decision: "accepted",
      reason: operation.kind === "update-node" && operation.patch.stage === "draft"
        ? "Auto-applied deterministic node stage bookkeeping."
        : "Auto-applied safe graph bookkeeping operation."
    };
  }
  return {
    operationIndex,
    decision: "rejected",
    reason: "Skipped in automatic mode because this operation changes node content or structure. Enable manual patch review to apply it."
  };
}

export async function applyPatchNodeOperation(projectRoot: string, flowId: string, patch: unknown): Promise<void> {
  const parsed = archicodeNodeSchema.partial().extend({ id: archicodeNodeSchema.shape.id }).passthrough().parse(patch) as NodePatch;
  const bundle = await updateNode(projectRoot, flowId, parsed, "llm");
  if (!bundle.flows.some((flow) => flow.id === flowId && flow.nodes.some((node) => node.id === parsed.id))) {
    throw new Error(`Node ${parsed.id} was not found after applying the patch.`);
  }
}

export type ProposedNodeOperation = Extract<LlmPatchProposal["operations"][number], { kind: "propose-node" }>;
export type ProposedEdgeOperation = Extract<LlmPatchProposal["operations"][number], { kind: "propose-edge" }>;
export type ProposedSubflowOperation = Extract<LlmPatchProposal["operations"][number], { kind: "propose-subflow" }>;
export type ProposedProjectFileOperation = Extract<LlmPatchProposal["operations"][number], { kind: "propose-project-file" }>;
export type ProposedRunProfileOperation = Extract<LlmPatchProposal["operations"][number], { kind: "propose-run-profile" }>;

export async function applyProposedNodeOperation(projectRoot: string, flowId: string, proposed: ProposedNodeOperation["node"]): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  if (
    proposed.stage === "plan-approved" ||
    proposed.stage === "draft-approved-production" ||
    proposed.ignored ||
    proposed.locked ||
    proposed.flags.includes("user-approved")
  ) {
    throw new Error("LLM-proposed nodes cannot be created in an approved, locked, or ignored state.");
  }

  const nodeId = proposed.id ?? id("node");
  if (flow.nodes.some((node) => node.id === nodeId)) {
    throw new Error(`Node ${nodeId} already exists.`);
  }
  if (proposed.subflowId && !flow.subflows.some((subflow) => subflow.id === proposed.subflowId)) {
    throw new Error(`Subflow ${proposed.subflowId} was not found.`);
  }

  const node = archicodeNodeSchema.parse({
    ...proposed,
    ...(proposed.implementationScope
      ? { implementationScope: { ...proposed.implementationScope, checkedAt: iso() } }
      : {}),
    id: nodeId,
    position: proposed.position ?? { x: 120 + flow.nodes.length * 36, y: 120 + flow.nodes.length * 28 },
    flags: Array.from(new Set([...(proposed.flags ?? []), "changed"])),
    updatedAt: iso()
  });
  await saveFlow(projectRoot, {
    ...flow,
    nodes: [...flow.nodes, node],
    updatedAt: iso()
  });
}

export async function applyProposedEdgeOperation(projectRoot: string, flowId: string, proposed: ProposedEdgeOperation["edge"]): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  if (!flow.nodes.some((node) => node.id === proposed.source)) throw new Error(`Source node ${proposed.source} was not found.`);
  if (!flow.nodes.some((node) => node.id === proposed.target)) throw new Error(`Target node ${proposed.target} was not found.`);
  if (proposed.source === proposed.target) throw new Error("Proposed edge cannot connect a node to itself.");

  const edge: FlowEdge = {
    ...proposed,
    id: proposed.id ?? id("edge")
  };
  if (flow.edges.some((item) => item.id === edge.id)) throw new Error(`Edge ${edge.id} already exists.`);
  if (flow.edges.some((item) => item.source === edge.source && item.target === edge.target)) {
    throw new Error(`Edge ${edge.source} -> ${edge.target} already exists.`);
  }
  await saveFlow(projectRoot, {
    ...flow,
    edges: [...flow.edges, edge],
    updatedAt: iso()
  });
}

export async function applyProposedSubflowOperation(projectRoot: string, flowId: string, proposed: ProposedSubflowOperation["subflow"]): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  const subflow: FlowSubflow = {
    ...proposed,
    id: proposed.id ?? id("subflow"),
    ignored: proposed.ignored ?? false
  };
  if (flow.subflows.some((item) => item.id === subflow.id)) throw new Error(`Subflow ${subflow.id} already exists.`);
  if (subflow.parentNodeId && !flow.nodes.some((node) => node.id === subflow.parentNodeId)) {
    throw new Error(`Parent node ${subflow.parentNodeId} was not found.`);
  }
  if (subflow.parentSubflowId && !flow.subflows.some((item) => item.id === subflow.parentSubflowId)) {
    throw new Error(`Parent subflow ${subflow.parentSubflowId} was not found.`);
  }
  await saveFlow(projectRoot, {
    ...flow,
    subflows: [...flow.subflows, subflow],
    updatedAt: iso()
  });
}

export async function applyProposedRunProfileOperation(projectRoot: string, operation: ProposedRunProfileOperation): Promise<void> {
  const project = (await loadProject(projectRoot)).project;
  if (project.settings.buildTargetsLocked) {
    throw new Error("Build targets are locked in Project Settings. AI run-target changes are not allowed.");
  }
  const profile = operation.profile;
  const existingProfiles = project.settings.runTargetProfiles;
  const hasProfile = existingProfiles.some((item) => item.id === profile.id);
  if (hasProfile && operation.mode === "create") {
    throw new Error(`Run target profile ${profile.id} already exists.`);
  }
  const runTargetProfiles = hasProfile
    ? existingProfiles.map((item) => item.id === profile.id ? profile : item)
    : [...existingProfiles, profile];
  await writeProjectFiles(projectRoot, projectSchema.parse({
    ...project,
    settings: {
      ...project.settings,
      runTargetProfiles
    },
    updatedAt: iso()
  }));
}

export async function applyProposedProjectFileOperation(projectRoot: string, operation: ProposedProjectFileOperation): Promise<void> {
  const allowedProjectFiles = new Set([
    ".gitignore",
    "AGENTS.md",
    "agents.md",
    "CLAUDE.md",
    "claude.md",
    "GEMINI.md",
    "gemini.md",
    ".github/copilot-instructions.md",
    "README.md",
    "readme.md"
  ]);
  const normalizedPath = operation.path.replace(/\\/g, "/");
  if (!allowedProjectFiles.has(normalizedPath)) {
    throw new Error("Project-file proposals are limited to .gitignore, agent instruction files, README.md, or readme.md.");
  }

  const root = await realpath(projectRoot);
  const targetPath = path.resolve(root, normalizedPath);
  if (!isSameOrInside(root, targetPath)) {
    throw new Error("Project-file proposal target must stay inside the project root.");
  }

  const fileExists = await exists(targetPath);
  if (fileExists && operation.mode === "create") {
    return;
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, operation.content.endsWith("\n") ? operation.content : `${operation.content}\n`, "utf8");
}

export type GeneratedArtifactProvenance = {
  path: string;
  sha256: string;
  command: string;
  runId: string;
  recordedAt: string;
  source: "verification" | "legacy-verification";
};

export const GENERATED_ARTIFACT_PROVENANCE_FILE = "generated-artifacts.json";

export function generatedArtifactProvenancePath(projectRoot: string): string {
  return projectStatePath(projectRoot, "runtime", GENERATED_ARTIFACT_PROVENANCE_FILE);
}

export function sourceContentSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function readGeneratedArtifactProvenance(projectRoot: string): Promise<GeneratedArtifactProvenance[]> {
  const value = await readJson<unknown>(generatedArtifactProvenancePath(projectRoot), []);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is GeneratedArtifactProvenance => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return typeof record.path === "string" &&
      typeof record.sha256 === "string" &&
      typeof record.command === "string" &&
      typeof record.runId === "string" &&
      typeof record.recordedAt === "string" &&
      (record.source === "verification" || record.source === "legacy-verification");
  });
}

export async function writeGeneratedArtifactProvenance(projectRoot: string, records: GeneratedArtifactProvenance[]): Promise<void> {
  await writeJson(generatedArtifactProvenancePath(projectRoot), records);
}

export async function recordVerificationGeneratedArtifacts(
  projectRoot: string,
  runId: string,
  command: string,
  before: SourceSnapshot,
  after: SourceSnapshot
): Promise<void> {
  const existing = await readGeneratedArtifactProvenance(projectRoot);
  const nextByPath = new Map<string, GeneratedArtifactProvenance>();
  for (const record of existing) {
    const beforeContent = before.get(record.path);
    const afterContent = after.get(record.path);
    if (afterContent === undefined) continue;
    const beforeHash = beforeContent === undefined ? null : sourceContentSha256(beforeContent);
    const afterHash = sourceContentSha256(afterContent);
    if (record.sha256 === afterHash) {
      nextByPath.set(record.path, record);
    } else if (beforeHash === record.sha256) {
      nextByPath.set(record.path, {
        ...record,
        sha256: afterHash,
        command,
        runId,
        recordedAt: iso(),
        source: "verification"
      });
    }
  }
  for (const [filePath, content] of after) {
    if (before.has(filePath)) continue;
    nextByPath.set(filePath, {
      path: filePath,
      sha256: sourceContentSha256(content),
      command,
      runId,
      recordedAt: iso(),
      source: "verification"
    });
  }
  await writeGeneratedArtifactProvenance(projectRoot, [...nextByPath.values()].sort((a, b) => a.path.localeCompare(b.path)));
}

export async function legacyVerificationProvenance(
  projectRoot: string,
  normalizedPath: string,
  currentHash: string
): Promise<GeneratedArtifactProvenance | null> {
  const fileStats = await stat(path.join(projectRoot, normalizedPath)).catch(() => null);
  if (!fileStats) return null;
  const runs = await readJsonDirectory<Run>(projectStatePath(projectRoot, "runs"));
  const artifacts = await readJsonDirectory<Artifact>(projectStatePath(projectRoot, "artifacts"));
  for (const run of runs) {
    for (const checkpoint of run.implementation?.checkpoints ?? []) {
      if (!checkpoint.verification || !checkpoint.sourceDiffArtifactId || !checkpoint.completedAt) continue;
      const startedAt = Date.parse(checkpoint.startedAt);
      const completedAt = Date.parse(checkpoint.completedAt);
      if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) continue;
      if (fileStats.mtimeMs < startedAt || fileStats.mtimeMs > completedAt + 2_000) continue;
      const diffArtifact = artifacts.find((artifact) => artifact.id === checkpoint.sourceDiffArtifactId);
      if (!diffArtifact?.path) continue;
      const diffValue = await readJson<Record<string, unknown> | null>(path.join(projectRoot, diffArtifact.path), null);
      const diff = typeof diffValue?.diff === "string" ? diffValue.diff : "";
      const changedPaths = new Set([...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]));
      if (changedPaths.has(normalizedPath)) continue;
      return {
        path: normalizedPath,
        sha256: currentHash,
        command: checkpoint.verification.command,
        runId: run.id,
        recordedAt: iso(),
        source: "legacy-verification"
      };
    }
  }
  return null;
}

export async function generatedArtifactProvenance(
  projectRoot: string,
  normalizedPath: string,
  targetPath: string
): Promise<GeneratedArtifactProvenance | null> {
  const content = await readFile(targetPath, "utf8").catch(() => null);
  if (content === null) return null;
  const currentHash = sourceContentSha256(content);
  const records = await readGeneratedArtifactProvenance(projectRoot);
  const recorded = records.find((record) => record.path === normalizedPath && record.sha256 === currentHash);
  if (recorded) return recorded;
  const legacy = await legacyVerificationProvenance(projectRoot, normalizedPath, currentHash);
  if (!legacy) return null;
  await writeGeneratedArtifactProvenance(projectRoot, [
    ...records.filter((record) => record.path !== normalizedPath),
    legacy
  ].sort((a, b) => a.path.localeCompare(b.path)));
  return legacy;
}

export async function removeGeneratedArtifactProvenance(projectRoot: string, normalizedPath: string): Promise<void> {
  const records = await readGeneratedArtifactProvenance(projectRoot);
  if (!records.some((record) => record.path === normalizedPath)) return;
  await writeGeneratedArtifactProvenance(projectRoot, records.filter((record) => record.path !== normalizedPath));
}

export type RunCreatedFileProvenance = {
  path: string;
  sha256: string;
  runId: string;
  recordedAt: string;
};

export const RUN_CREATED_FILE_PROVENANCE_FILE = "run-created-files.json";

export function runCreatedFileProvenancePath(projectRoot: string): string {
  return projectStatePath(projectRoot, "runtime", RUN_CREATED_FILE_PROVENANCE_FILE);
}

export async function readRunCreatedFileProvenance(projectRoot: string): Promise<RunCreatedFileProvenance[]> {
  const value = await readJson<unknown>(runCreatedFileProvenancePath(projectRoot), []);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RunCreatedFileProvenance => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return typeof record.path === "string" &&
      typeof record.sha256 === "string" &&
      typeof record.runId === "string" &&
      typeof record.recordedAt === "string";
  });
}

export async function writeRunCreatedFileProvenance(projectRoot: string, records: RunCreatedFileProvenance[]): Promise<void> {
  await writeJson(runCreatedFileProvenancePath(projectRoot), records);
}

export async function recordRunCreatedFiles(
  projectRoot: string,
  runId: string,
  before: SourceSnapshot,
  after: SourceSnapshot
): Promise<void> {
  const existing = await readRunCreatedFileProvenance(projectRoot);
  const nextByPath = new Map<string, RunCreatedFileProvenance>();
  for (const record of existing) {
    const beforeContent = before.get(record.path);
    const afterContent = after.get(record.path);
    if (afterContent === undefined) continue;
    const beforeHash = beforeContent === undefined ? null : sourceContentSha256(beforeContent);
    const afterHash = sourceContentSha256(afterContent);
    if (record.runId === runId && beforeHash === record.sha256) {
      nextByPath.set(record.path, { ...record, sha256: afterHash, recordedAt: iso() });
    } else if (record.sha256 === afterHash) {
      nextByPath.set(record.path, record);
    }
  }
  for (const [filePath, content] of after) {
    if (before.has(filePath)) continue;
    nextByPath.set(filePath, {
      path: filePath,
      sha256: sourceContentSha256(content),
      runId,
      recordedAt: iso()
    });
  }
  await writeRunCreatedFileProvenance(projectRoot, [...nextByPath.values()].sort((a, b) => a.path.localeCompare(b.path)));
}

export async function unchangedFileCreatedByRun(
  projectRoot: string,
  runId: string | undefined,
  normalizedPath: string,
  targetPath: string
): Promise<boolean> {
  if (!runId) return false;
  const record = (await readRunCreatedFileProvenance(projectRoot))
    .find((candidate) => candidate.path === normalizedPath && candidate.runId === runId);
  if (!record) return false;
  const currentHash = await sha256File(targetPath).catch(() => null);
  return currentHash === record.sha256;
}

export async function snapshotDeletionRequiresPermission(
  projectRoot: string,
  runId: string,
  normalizedPath: string,
  previousContent: string
): Promise<boolean> {
  const previousHash = sourceContentSha256(previousContent);
  const runCreated = (await readRunCreatedFileProvenance(projectRoot))
    .some((record) => record.path === normalizedPath && record.runId === runId && record.sha256 === previousHash);
  if (runCreated) return false;
  const generated = (await readGeneratedArtifactProvenance(projectRoot))
    .some((record) => record.path === normalizedPath && record.sha256 === previousHash);
  if (generated) return false;
  return !(await legacyVerificationProvenance(projectRoot, normalizedPath, previousHash));
}

export async function restoreDirectDeletionsRequiringPermission(
  projectRoot: string,
  run: Run,
  before: SourceSnapshot,
  after: SourceSnapshot,
  phase: "coding" | "debugging",
  batchNumber: number
): Promise<PersistedPatchProposal | null> {
  const rejectedPaths = new Set((run.sourceDeletionDecisions ?? [])
    .filter((item) => item.decision === "rejected")
    .map((item) => item.path));
  const reviewPaths: string[] = [];
  for (const [filePath, previousContent] of before) {
    if (after.has(filePath)) continue;
    const needsPermission = await snapshotDeletionRequiresPermission(projectRoot, run.id, filePath, previousContent);
    if (!needsPermission || rejectedPaths.has(filePath)) {
      if (!needsPermission) {
        await removeGeneratedArtifactProvenance(projectRoot, filePath);
        await removeRunCreatedFileProvenance(projectRoot, filePath);
      } else {
        const targetPath = path.resolve(projectRoot, filePath);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, previousContent, "utf8");
      }
      continue;
    }
    const targetPath = path.resolve(projectRoot, filePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, previousContent, "utf8");
    reviewPaths.push(filePath);
  }
  if (!reviewPaths.length) return null;
  const bundle = await loadProject(projectRoot);
  const allowedNodes = bundle.flows.flatMap((flow) => flow.ignored ? [] : flow.nodes.filter((node) => !node.ignored));
  const allowedNodeIds = new Set(allowedNodes.map((node) => node.id));
  const scopedNodeIds = [
    ...run.affectedNodeIds,
    ...(run.scope?.kind === "nodes" ? run.scope.nodeIds : []),
    ...(run.nodeId ? [run.nodeId] : [])
  ].filter((nodeId, index, all) => allowedNodeIds.has(nodeId) && all.indexOf(nodeId) === index);
  const fallbackNodeIds = scopedNodeIds.length
    ? scopedNodeIds
    : [allowedNodes.find((node) => node.type === "project") ?? allowedNodes[0]].flatMap((node) => node ? [node.id] : []);
  return persistAndMaybeApplyPatchProposal(projectRoot, run.id, JSON.stringify({
    archicodePatch: {
      schemaVersion: 1,
      runId: run.id,
      summary: "Review file deletion attempted by the coding provider.",
      operations: reviewPaths.map((filePath) => ({
        kind: "propose-source-file",
        path: filePath,
        action: "delete",
        nodeIds: fallbackNodeIds,
        reason: "The coding provider attempted to delete this existing project file."
      }))
    }
  }), {
    phase,
    artifactSuffix: `direct-delete-batch-${batchNumber}`
  });
}

export async function removeRunCreatedFileProvenance(projectRoot: string, normalizedPath: string): Promise<void> {
  const records = await readRunCreatedFileProvenance(projectRoot);
  if (!records.some((record) => record.path === normalizedPath)) return;
  await writeRunCreatedFileProvenance(projectRoot, records.filter((record) => record.path !== normalizedPath));
}

export async function evaluateSourceFileSafety(
  projectRoot: string,
  operation: SourceFileProposal,
  options: { runId?: string } = {}
): Promise<SourceFileSafetyResult> {
  const normalizedPath = operation.path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedPath || normalizedPath.includes("\0")) {
    return { safe: false, requiresReview: true, reason: "Path is empty or invalid.", risk: "high" };
  }
  if (normalizedPath.split("/").some((part) => part === "..")) {
    return { safe: false, requiresReview: true, reason: "Path traversal is not allowed.", normalizedPath, risk: "high" };
  }

  const root = await realpath(projectRoot);
  const targetPath = path.resolve(root, normalizedPath);
  if (!isSameOrInside(root, targetPath)) {
    return { safe: false, requiresReview: true, reason: "Target path escapes the project root.", normalizedPath, risk: "high" };
  }

  const segments = normalizedPath.split("/");
  if (segments.some((segment) => SOURCE_DIFF_IGNORE_DIRS.has(segment))) {
    return { safe: false, requiresReview: true, reason: "Target path is inside an ignored or generated directory.", normalizedPath, risk: "high" };
  }

  const content = operation.content ?? "";
  if ((operation.action === "create" || operation.action === "replace") && !operation.content) {
    return { safe: false, requiresReview: true, reason: "Create and replace operations require content.", normalizedPath, risk: "high" };
  }
  if (Buffer.byteLength(content, "utf8") > SOURCE_PROPOSAL_MAX_BYTES) {
    return { safe: false, requiresReview: true, reason: "Proposed content is larger than the auto-apply limit.", normalizedPath, risk: "high" };
  }
  if (content.includes("\0")) {
    return { safe: false, requiresReview: true, reason: "Binary content is not supported by source-file proposals.", normalizedPath, risk: "high" };
  }
  if (SOURCE_PROPOSAL_SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    return { safe: false, requiresReview: true, reason: "Proposed content appears to contain secret-like material.", normalizedPath, risk: "high" };
  }

  const fileExists = await exists(targetPath);
  if ((operation.action === "create" || operation.action === "replace") && fileExists && operation.content) {
    const currentContent = await readFile(targetPath, "utf8");
    if (currentContent === proposedSourceContent(operation.content)) {
      return { safe: true, requiresReview: false, reason: "Proposed content already exists on disk.", normalizedPath, risk: "low" };
    }
  }
  if (operation.action === "delete" && !fileExists) {
    return { safe: true, requiresReview: false, reason: "File is already absent.", normalizedPath, risk: "low" };
  }
  if (operation.action === "create" && fileExists) {
    return { safe: false, requiresReview: true, reason: "Create operation would overwrite an existing file.", normalizedPath, risk: "medium" };
  }
  if ((operation.action === "replace" || operation.action === "delete") && !fileExists) {
    return { safe: false, requiresReview: true, reason: `${operation.action} operation targets a missing file.`, normalizedPath, risk: "medium" };
  }
  if (operation.action === "replace") {
    const actualHash = await sha256File(targetPath);
    if (!operation.baseSha256) {
      return { safe: false, requiresReview: true, reason: "Replace operation is missing baseSha256.", normalizedPath, risk: "medium" };
    }
    if (actualHash !== operation.baseSha256) {
      return { safe: false, requiresReview: true, reason: "Replace operation baseSha256 does not match the current file.", normalizedPath, risk: "high" };
    }
  }
  if (operation.action === "delete") {
    if (await unchangedFileCreatedByRun(root, options.runId, normalizedPath, targetPath)) {
      return {
        safe: true,
        requiresReview: false,
        reason: `Safe same-run cleanup: ${normalizedPath} was created by this run and is unchanged.`,
        normalizedPath,
        risk: "low"
      };
    }
    const provenance = await generatedArtifactProvenance(root, normalizedPath, targetPath);
    if (provenance) {
      return {
        safe: true,
        requiresReview: false,
        reason: `Safe generated-artifact cleanup: created by managed verification \`${provenance.command}\` and unchanged since it was recorded.`,
        normalizedPath,
        risk: "low"
      };
    }
    return { safe: true, requiresReview: true, reason: "Deleting a pre-existing or modified file requires explicit permission.", normalizedPath, risk: "high" };
  }
  if (normalizedPath === "package.json" && operation.action === "create" && !fileExists) {
    return { safe: true, requiresReview: false, reason: "New package.json scaffold can be auto-applied in an empty project.", normalizedPath, risk: "low" };
  }
  if (SOURCE_PROPOSAL_REVIEW_PATHS.some((pattern) => pattern.test(normalizedPath))) {
    return { safe: true, requiresReview: true, reason: "Sensitive project/config file requires review.", normalizedPath, risk: "medium" };
  }

  return { safe: true, requiresReview: false, reason: "Text source-file proposal is safe to apply automatically.", normalizedPath, risk: "low" };
}

export async function applyProposedSourceFileOperation(
  projectRoot: string,
  operation: SourceFileProposal,
  reviewed: boolean,
  runId?: string
): Promise<{ status: "applied" | "rejected" | "failed"; message: string; safety: SourceFileSafetyResult }> {
  const safety = await evaluateSourceFileSafety(projectRoot, operation, { runId });
  if (!safety.safe) {
    return { status: "failed", message: safety.reason, safety };
  }
  if (safety.requiresReview && !reviewed) {
    return { status: "rejected", message: safety.reason, safety };
  }
  if (!safety.normalizedPath) {
    return { status: "failed", message: "Source-file proposal did not resolve to a normalized path.", safety };
  }

  const targetPath = path.resolve(projectRoot, safety.normalizedPath);
  try {
    if (operation.action === "delete") {
      if (await exists(targetPath)) await rm(targetPath);
      await removeGeneratedArtifactProvenance(projectRoot, safety.normalizedPath);
      await removeRunCreatedFileProvenance(projectRoot, safety.normalizedPath);
    } else {
      if (await exists(targetPath)) {
        const currentContent = await readFile(targetPath, "utf8");
        if (currentContent === proposedSourceContent(operation.content!)) {
          return { status: "applied", message: `${operation.action} ${safety.normalizedPath} already existed with matching content`, safety };
        }
      }
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, proposedSourceContent(operation.content!), "utf8");
    }
    return { status: "applied", message: `${operation.action} ${safety.normalizedPath}`, safety };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error), safety };
  }
}

export async function writePatchArtifactReference(projectRoot: string, artifact: Artifact): Promise<void> {
  const targetPath = path.resolve(projectRoot, artifact.path);
  const artifactRoot = path.resolve(projectRoot, PROJECT_STATE_DIR, "artifacts");
  if (!targetPath.startsWith(`${artifactRoot}${path.sep}`)) {
    throw new Error("Patch artifact references must be written under .archicode/artifacts.");
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeJson(targetPath, artifactSchema.parse(artifact));
}

export async function updatePatchArtifactStatus(
  projectRoot: string,
  artifactRelativePath: string,
  results: PatchReviewRecord["results"]
): Promise<void> {
  const artifactPath = path.join(projectRoot, artifactRelativePath);
  const raw = await readJson<Record<string, unknown>>(artifactPath, {});
  const appliedCount = results.filter((result) => result.status === "applied").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  const status = failedCount > 0
    ? "partially-applied"
    : appliedCount === 0
      ? "rejected"
      : appliedCount === results.length
        ? "applied"
        : "partially-applied";
  await writeJson(artifactPath, {
    ...raw,
    status
  });
}
