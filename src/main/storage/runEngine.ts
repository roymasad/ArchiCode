import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  applyNodePatch,
  archicodeNodeSchema,
  artifactSchema,
  noteSchema,
  contextManifestSchema,
  contextMemoryRecordSchema,
  debugIncidentSchema,
  defaultPhaseModelPolicies,
  estimateContextSize,
  acceptanceCheckSchema,
  flowSchema,
  graphChangeRecordSchema,
  isNoteActiveForModelContext,
  isProductionApproved,
  nodeAcceptanceChecksSatisfied,
  llmPatchProposalSchema,
  patchOperationDecisionSchema,
  patchReviewRecordSchema,
  projectBundleSchema,
  projectSchema,
  researchGraphChangeSetSchema,
  runtimeServiceSchema,
  runScopeSchema,
  runTargetProfileSchema,
  runSchema,
  mcpServerSchema,
  providerSettingsSchema,
  notificationSettingsSchema,
  canvasBackgroundSchema,
  canvasEdgeStyleSchema,
  delphiTestingInputSchema,
  type Artifact,
  type ContextLifecycle,
  type Note,
  type ContextManifest,
  type ContextMemoryRecord,
  type DebugIncident,
  type Flow,
  type FlowEdge,
  type FlowSubflow,
  type AcceptanceCheck,
  type AcceptanceCheckStatus,
  type GraphChangeRecord,
  type GraphChangeRetention,
  type ImplementationScopeClaim,
  type LlmPatchProposal,
  type NodeFlag,
  type NodeModuleProfileMode,
  type NodePatch,
  type PatchOperationDecision,
  type PatchReviewRecord,
  type Project,
  type ProjectBundle,
  type ProjectSettings,
  type RunContextSummary,
  type RunEvidenceKind,
  type RunEffort,
  type RunGuidance,
  type RunMemoryCard,
  type RunImplementationCheckpoint,
  type RunImplementationState,
  type RunImplementationTask,
  type RunPhase,
  type RuntimeService,
  type Run,
  type RunScope,
  type SourceFileProposal,
  type SourceFileSafetyResult,
  type LlmUsage,
  type LlmPhase,
  type SherlockResearchOutput,
  type PicassoGraphOutput,
  type DelphiTestingInput,
  type DelphiTestingOutput
} from "../../shared/schema";
import type { CreateProjectSkillInput, McpImportSource, McpRefreshResult, McpRegistryInstallInput, McpRegistryInstallResult, McpRegistrySearchInput, McpRegistrySearchResult, ProjectSkill } from "../../shared/capabilities";
import { createSeedProject } from "../../shared/fixtures";
import { createProjectFromTemplate, flutterRunTargetProfiles, type ProjectTemplateId } from "../../shared/templates";
import { extractArchicodePatch, type QuarantinedPatchOperation } from "../../shared/patchExtraction";
import { compactImplementationScope, implementationScopeAdvisory, semanticRetrievalAdvisory } from "../../shared/implementationScope";
import { gaiaAgent, pandoraAgent } from "../../shared/agentIdentities";
import { callProvider, checkProviderHealth, summarizeWithProvider, type ProviderCallOptions, type ProviderHealthResult, type ProviderImageAttachment, type ProviderProgressEvent, type ProviderTextAttachment } from "../providers";
import { runVerificationCommand, executeMicroRun } from "../microRuns";
import { registerAllMicroRunAgents } from "../microRunAgents";
import { detectTechStack, type TechStack } from "../techStack";
import { architecturePolicyBaselineViolationIds, blockingArchitecturePolicyViolationsSinceBaseline, hasEnforcedArchitecturePolicies, refreshArchitecturePolicyEvaluation } from "../policies/architecturePolicies";
import type { TestAuthoringInput, TestAuthoringOutput } from "../microRunAgents/testAuthoring";
import { createProjectSkill as writeProjectSkill, listProjectSkills as readProjectSkills, selectedSkillsPrompt } from "../skills";
import { callMcpTool, enabledMcpServers, importMcpServers, listMcpRegistryServers, mcpServerFromRegistryEntry, providerMcpTools, refreshMcpServerCapabilities, type ProviderMcpTool } from "../mcp";
import { archicodeInternalTools, callArchicodeInternalTool, createArchicodeInternalMcpServer, isArchicodeInternalTool, type InternalConsoleCommandResult } from "../internalTools";
import { type ShellCommandRisk, buildSubprocessEnv, classifyCommandRisk, commandAllowedBySettings, isKnownBinary } from "../../shared/execution";
import { assessAgentCommandSafety, type AgentCommandAuthorization } from "../actionSafety";
import { createConsecutiveToolCallLoopDetector } from "../agentRuntime";
import { deriveContextBudgetPlan, estimateTextTokens } from "../../shared/contextBudget";
import { sumLlmUsage, isAllUsageUnavailable } from "../../shared/llmPricing";
import { isSubflowIgnored, workingNodesForFlow } from "../../shared/graph";
import { classifyRunFailure } from "../../shared/runFailureTaxonomy";
import { stripAnsiEscapes } from "../../shared/terminalText";
import {
  SOURCE_BATCH_FINISH_TOOL,
  SOURCE_FILE_HANDOFF_TOOL,
  parseSourceBatchFinishArguments,
  parseSourceFileToolArguments,
  sourceFileProposalNodeIds,
  sourceHandoffPatch,
  type SourceBatchFinish
} from "../../shared/sourceHandoff";
import { importDrawioPageToArchicode, parseDrawioPages, type DrawioPage } from "../drawioImport";
import { exportArchicodeScopeToDrawioXml } from "../drawioExport";
import { compactProjectConventions, readProjectConventions } from "../projectConventions";
import { extractTextDocument, isSupportedTextDocumentMediaType } from "../documentText";
import { getGitStatus, readProjectFile, readProjectFileDiff } from "../projectTools";
import { isRepairableProjectToolError, normalizeProjectToolArguments, repairableProjectToolResult } from "../../shared/toolRepair";
import { archicodeCapabilityDigest, archicodeCapabilityVersion, archicodeCurrentProjectOptions } from "../../shared/appCapabilities";
import { installDelphiManagedTool } from "../testing/toolCache";
import { acquireDelphiRuntimeTarget, planDelphiRuntimeLaunch, releaseDelphiRuntimeTarget, type DelphiRuntimeLease } from "../testing/runtimeLifecycle";
import { searchSemanticIndex, semanticRelatedNodeIds, type SemanticSearchResult } from "../semanticIndex";
import {
  PROJECT_STATE_DIR,
  appendJsonLine,
  definedOnly,
  exists,
  id,
  iso,
  projectStatePath,
  readJson,
  readJsonDirectory,
  readJsonLines,
  readTextIfExists,
  replaceFileWithRetry,
  safeFileName,
  safeParseMany,
  safeParseOne,
  safeParseOptional,
  sha256File,
  writeJson,
  writeJsonLines
} from "./persistence";
import {
  CONTEXT_GRAPH_CHANGE_LIMIT,
  GRAPH_CHANGES_ARCHIVE_FILE,
  type GraphChangeActor,
  appendNote,
  graphChangeSnippets,
  markPendingGraphChangesImplemented,
  readGraphChanges,
  readNotes,
  recordFlowShapeChanges,
  recordGraphChange,
  shouldIncludeNoteInLlmContext,
  updateNoteById,
  writeGraphChangeRecord,
  writeGraphChanges,
  writeNotes
} from "./ledgers";
import {
  createAttachmentArtifacts,
  createImageArtifacts,
  isSupportedTextAttachmentMediaType,
  mediaTypeForFile,
  noteAttachmentMetadata,
  runImageAttachments
} from "./artifacts";
import {
  addNote,
  deleteNote,
  finalizeNodeNotesForApproval,
  isNoteAutoResolveNodeState,
  updateNoteResolved
} from "./notes";
import { RENDERED_NODE_BOUNDS } from "./flowImportExport";
import { verifyRunAcceptanceChecks } from "./acceptanceChecks";
import { AGENT_INSTRUCTION_FILE_CANDIDATES, type AgentInstructionFilePath, readAgentInstructionFile } from "./agentFiles";
import {
  type FilesystemScopeEvaluation,
  type SourceSnapshot,
  buildContext,
  evaluateFilesystemScope,
  normalizeForCompare,
  scopeOpenQuestions
} from "./contextBuilder";


import {
  appendRunLogEntries,
  createProviderProgressLogger,
  flushRunLogAppends,
  persistRunUsage,
  publishRunUpdateEvent,
  queueRunLogAppend,
  readRun,
  resolveRetriedRunFailure,
  splitProgressLines,
  truncateLogText,
  writeRun
} from "./runLogs";


import {
  commandAlreadyIncludesSetup,
  compactSummary,
  dependencyInstallPlanForCommand,
  dependencyRecoveryInstruction,
  ensureManagerialProjectFiles,
  finitePackageVerificationCommand,
  inferProjectCommands,
  inferredVerificationCommand,
  normalizeVerificationCommandForProject,
  prependInstallCommandIfNeeded,
  reconcileRuntimeProfilesWithLlm,
  refreshInferredProjectCommands
} from "./commandInference";


import {
  type ImplementationFileMapping,
  codexLocalSandboxDisplayLabel,
  ensureProjectGitignoreDefaults,
  hydrateProviderForUse,
  loadProject,
  persistImplementationFileMappings,
  touchProject,
  writeProjectFiles
} from "./projectStore";


import {
  activeRuntimeServices,
  chooseRunTarget,
  compileRunProfilePattern,
  extractReadyTargetId,
  fillRunProfilePlaceholders,
  harnessWebContext,
  listRuntimeServices,
  nativeWebSearchEnabled,
  parseRunTargets,
  profileRisk,
  resolveProfileCwd,
  runManagedPreflightCommand,
  runProfileLaunchCommands
} from "./runtimeServices";

import {
  type PersistedPatchProposal,
  REVIEWABLE_GRAPH_OPERATION_KINDS,
  applyPatchProposal,
  applyProposedSourceFileOperation,
  autoPatchDecisions,
  evaluateSourceFileSafety,
  hasManualGraphReviewOperations,
  hasOnlyProjectFileOperations,
  hasSourceFileOperations,
  hasStructuralProposalOperations,
  listPatchProposals,
  proposedSourceContent,
  readArtifactText,
  recordRunCreatedFiles,
  recordVerificationGeneratedArtifacts,
  restoreDirectDeletionsRequiringPermission,
  updatePatchArtifactStatus
} from "./patches";




registerAllMicroRunAgents();
export const SOURCE_PROPOSAL_MAX_BYTES = 300_000;
const SOURCE_DIFF_MAX_FILE_BYTES = 400_000;
const AUTO_VERIFICATION_DEBUG_MAX_ATTEMPTS = 6;
const MAX_TRANSIENT_VERIFICATION_RETRIES = 1;
const TRANSIENT_VERIFICATION_RETRY_BACKOFF_MS = 2_000;

// Stack-agnostic signals that a verification failure is environmental
// (network, package registry, DNS, disk, lock contention) rather than a
// deterministic code failure, so re-running the same command may succeed.
const TRANSIENT_VERIFICATION_FAILURE_PATTERNS = [
  "econnreset", "etimedout", "esockettimedout", "eai_again", "enotfound", "econnrefused",
  "enetunreach", "ehostunreach", "epipe", "socket hang up", "network timeout",
  "could not resolve host", "getaddrinfo", "fetch failed", "request to https",
  "npm err! network", "errno network", "err_socket", "tls handshake",
  "429 too many requests", "too many requests", "service temporarily unavailable",
  "enospc", "no space left on device", "resource temporarily unavailable",
  "eagain", "ebusy", "waiting for lock", "cannot acquire lock", "another process",
  "unable to acquire", "text file busy", "the operation was canceled by the runtime"
];

function isTransientVerificationFailure(output: string): boolean {
  const text = output.toLowerCase();
  return TRANSIENT_VERIFICATION_FAILURE_PATTERNS.some((pattern) => text.includes(pattern));
}
const IMPLEMENTATION_FALLBACK_BATCH_BUDGET = 6;
const HIGH_IMPLEMENTATION_MAX_BATCHES_PER_TASK = 6;
const HIGH_IMPLEMENTATION_TOTAL_BATCH_LIMIT = 24;
const FAST_IMPLEMENTATION_MAX_BATCHES_PER_TASK = 2;
const FAST_IMPLEMENTATION_TOTAL_BATCH_LIMIT = 2;
const FAST_IMPLEMENTATION_DYNAMIC_TOTAL_BATCH_LIMIT = 4;
// Bounded self-refinement passes for high-effort planning. Fast effort stays
// one-shot by design; each pass re-plans in the same phase with deterministic
// findings appended, and the run always proceeds with the best draft.
const PLAN_REFINE_CAP = 2;
const ACTIVE_RUN_STATUSES = new Set<Run["status"]>([
  "preparing",
  "queued",
  "needs-permission",
  "running",
  "planning",
  "awaiting-plan-review",
  "coding",
  "awaiting-code-review",
  "debugging",
  "needs-replan",
  "verifying"
]);
export const SOURCE_DIFF_IGNORE_DIRS = new Set([
  ".git",
  ".archicode",
  "node_modules",
  "out",
  "release",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".vite"
]);
export const SOURCE_PROPOSAL_REVIEW_PATHS = [
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^bun\.lockb$/,
  /^\.env($|\.)/,
  /(^|\/)\.env($|\.)/,
  /^package\.json$/,
  /^tsconfig.*\.json$/,
  /^electron\.vite\.config\.ts$/,
  /(^|\/)(auth|security|secrets?|credentials?)\b/i
];
const GENERATED_LOCKFILE_PATHS = [
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^bun\.lockb$/
];
export const SOURCE_PROPOSAL_SECRET_PATTERNS = [
  /api[_-]?key\s*[:=]/i,
  /secret\s*[:=]/i,
  /private[_-]?key/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];
const activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();
const activeRunAbortControllers = new Map<string, AbortController>();
const pendingTerminalCancellationRunIds = new Set<string>();
const activeProjectQueues = new Set<string>();
const queuedContextTextByRun = new Map<string, string>();
type StagedSourceToolBatch = {
  batchNumber: number;
  sourceSnapshot: SourceSnapshot;
  sourceSubmissionStarted: boolean;
  operations: Map<string, SourceFileProposal>;
  repairs: Map<string, string>;
  toolCalls: Run["mcpToolCalls"];
  finish?: SourceBatchFinish;
};
const stagedSourceToolBatches = new Map<string, StagedSourceToolBatch>();

function isActiveRunLane(run: Run): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status) && !run.queueRemovedAt;
}

function activeRunLane(runs: Run[], exceptRunId?: string): Run | undefined {
  return runs
    .filter((run) => run.id !== exceptRunId && isActiveRunLane(run))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function activeRunLaneMessage(active: Run, action: string): string {
  return `Finish or cancel the active run (${active.id}) before ${action}.`;
}

function assertNoActiveRunLane(bundle: ProjectBundle, action: string, exceptRunId?: string): void {
  const active = activeRunLane(bundle.runs, exceptRunId);
  if (!active) return;
  throw new Error(activeRunLaneMessage(active, action));
}

type RunCreationLock = { pid: number; token: string; createdAt: string };

function runCreationLockPath(projectRoot: string): string {
  return projectStatePath(projectRoot, "runtime", "run-creation-lock.json");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withRunCreationLock<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
  const lockPath = runCreationLockPath(projectRoot);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomBytes(16).toString("hex");
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lock: RunCreationLock = { pid: process.pid, token, createdAt: iso() };
    try {
      await writeFile(lockPath, `${JSON.stringify(lock)}\n`, { flag: "wx" });
      acquired = true;
      break;
    } catch {
      const existing = await readJson<RunCreationLock | null>(lockPath, null);
      const createdAt = existing ? Date.parse(existing.createdAt) : NaN;
      const stale = !existing || !processIsAlive(existing.pid) || (Number.isFinite(createdAt) && Date.now() - createdAt > 6 * 60 * 60 * 1000);
      if (stale) await rm(lockPath, { force: true }).catch(() => undefined);
      else await delay(20);
    }
  }
  if (!acquired) throw new Error("Another ArchiCode action is reserving the project run lane. Try again shortly.");
  try {
    return await task();
  } finally {
    const existing = await readJson<RunCreationLock | null>(lockPath, null);
    if (existing?.token === token) await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function beginRunAbortScope(runId: string): AbortController {
  const existing = activeRunAbortControllers.get(runId);
  if (existing && !existing.signal.aborted) existing.abort();
  const controller = new AbortController();
  activeRunAbortControllers.set(runId, controller);
  return controller;
}

function endRunAbortScope(runId: string, controller: AbortController): void {
  if (activeRunAbortControllers.get(runId) === controller) {
    activeRunAbortControllers.delete(runId);
  }
}

function abortActiveRunWork(runId: string): void {
  const controller = activeRunAbortControllers.get(runId);
  if (controller && !controller.signal.aborted) controller.abort();
}

function signalManagedChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the liveness check and signal.
    }
  }
  child.kill(signal);
}

function terminateActiveRunProcess(runId: string): void {
  const child = activeProcesses.get(runId);
  if (!child) return;
  signalManagedChild(child, "SIGTERM");
  const forceKill = setTimeout(() => {
    if (process.platform !== "win32" || (child.exitCode === null && child.signalCode === null)) {
      signalManagedChild(child, "SIGKILL");
    }
  }, 3_000);
  forceKill.unref?.();
  child.once("close", () => {
    // A detached shell can exit on SIGTERM while a stubborn descendant stays
    // alive in its process group. Keep the POSIX escalation timer in that case.
    if (process.platform === "win32") clearTimeout(forceKill);
    if (activeProcesses.get(runId) === child) activeProcesses.delete(runId);
  });
}

export function isTerminalRunStatus(status: Run["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

async function persistPendingRunCancellation(projectRoot: string, runId: string): Promise<void> {
  const latest = await readRun(projectRoot, runId).catch(() => null);
  if (!latest || isTerminalRunStatus(latest.status)) return;
  const cancelled = runSchema.parse({
    ...latest,
    status: "cancelled",
    phase: "complete",
    permission: latest.status === "needs-permission"
      ? {
          decision: "denied",
          reason: "Permission denied by the user."
        }
      : latest.permission,
    logs: [...latest.logs, { at: iso(), stream: "system", text: "Run cancelled." }],
    runInstructions: "Run cancelled before completion.",
    completedAt: latest.completedAt ?? iso()
  });
  await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, cancelled, cancelled.runInstructions ?? "Run cancelled before completion."));
}

async function runWasCancelled(projectRoot: string, runId: string): Promise<boolean> {
  if (pendingTerminalCancellationRunIds.has(runId)) {
    await persistPendingRunCancellation(projectRoot, runId);
    return true;
  }
  const latest = await readRun(projectRoot, runId).catch(() => null);
  return latest?.status === "cancelled";
}



export type ProviderCommandResult = {
  command: string;
  status?: string;
  exitCode?: number | null;
  output: string;
};

function extractProviderCommandResults(run: Run): ProviderCommandResult[] {
  const results: ProviderCommandResult[] = [];
  for (const log of run.logs) {
    if (log.stream !== "stdout" || !log.text.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(log.text) as {
        type?: string;
        item?: {
          type?: string;
          status?: string;
          command?: string;
          exit_code?: number | null;
          aggregated_output?: string;
        };
      };
      if (parsed.type !== "item.completed" || parsed.item?.type !== "command_execution" || !parsed.item.command) continue;
      results.push({
        command: parsed.item.command,
        status: parsed.item.status,
        exitCode: parsed.item.exit_code,
        output: parsed.item.aggregated_output ?? ""
      });
    } catch {
      // Provider progress is best-effort JSON; raw text remains in Trace.
    }
  }
  return results;
}

function isVerificationCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return /\b(run\s+)?(test|build|check|typecheck|lint|analy[sz]e|verify|package)\b/.test(normalized) ||
    /\b(vitest|jest|playwright|cypress|vue-tsc|tsc|pytest)\b/.test(normalized);
}

export function isRuntimeOrWatchCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  const segments = normalized.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  return segments.some((segment) =>
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|storybook)\b/.test(segment) ||
    /\b(?:vite|next|nuxt|astro|remix|svelte-kit|webpack-dev-server)\s*(?:$|\s+(?:dev|start|serve|preview)\b)/.test(segment) ||
    /\b(?:expo|react-native)\s+start\b/.test(segment) ||
    /\b(?:flutter|cargo|go|dotnet)\s+run\b/.test(segment) ||
    /\b(?:nodemon|ts-node-dev)\b/.test(segment) ||
    /\btsx\s+watch\b/.test(segment) ||
    (/\b(?:--watch|watch)\b/.test(segment) && !/\b(?:--watch(?:=|\s+)false|--watchall(?:=|\s+)false|vitest\s+run)\b/.test(segment))
  );
}

export function isFiniteVerificationCommand(command: string): boolean {
  return isVerificationCommand(command) && !isRuntimeOrWatchCommand(command);
}

function isBuildVerificationCommand(command: string): boolean {
  return /\b(?:build|compile|bundle)\b/i.test(command) && !/\b(?:test|check|lint|typecheck|tsc)\b/i.test(command);
}

function failedVerificationCommands(run: Run): ProviderCommandResult[] {
  return extractProviderCommandResults(run).filter((result) =>
    isVerificationCommand(result.command) &&
    (result.status === "failed" || (typeof result.exitCode === "number" && result.exitCode !== 0))
  );
}

function runHasVerificationLifecycleMarker(run: Run): boolean {
  return run.logs.some((line) =>
    /^(Verification phase started|Waiting for approval to verify with):/i.test(line.text) ||
    /^Final handoff: Verification completed with `/i.test(line.text)
  ) || Boolean(run.runInstructions?.match(/^Verification completed with `/i));
}

function runHasSuccessfulManagedVerification(run: Run): boolean {
  if (!run.command?.trim() || !runHasVerificationLifecycleMarker(run)) return false;
  return run.logs.some((line) => /command exited with code 0\b/i.test(line.text));
}

function runHasSuccessfulVerificationCommand(run: Run): boolean {
  if (!run.command?.trim() || run.status !== "succeeded") return false;
  if (runHasSuccessfulManagedVerification(run)) return true;
  if (!isVerificationCommand(run.command)) return false;
  return run.logs.some((line) => /command exited with code 0\b/i.test(line.text));
}

function runIsProjectLevelVerification(run: Run): boolean {
  const explicitlyProjectScoped = run.scope?.kind === "project";
  const projectBuildDiscovery = run.purpose === "build-discovery" && !run.nodeId;
  return runHasSuccessfulVerificationCommand(run) && (explicitlyProjectScoped || projectBuildDiscovery);
}

function hasDependencyInstallBlocker(results: ProviderCommandResult[]): boolean {
  return results.some((result) =>
    /(command not found|cannot find package|cannot find module|module_not_found|err_module_not_found|no module named|modulenotfounderror|unresolved import|could not resolve (?:module|package|import)|project\.assets\.json.*not found|not installed|vendor\/autoload|node_modules)/i.test(result.output)
  );
}

export function sortNotesForModelContext(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export async function writeRunCompletionNote(projectRoot: string, bundle: ProjectBundle | null, run: Run, message: string): Promise<void> {
  const flow = bundle?.flows.find((item) => item.id === run.flowId);
  const targetNodeId = run.nodeId ??
    run.affectedNodeIds.find((nodeId) => flow?.nodes.some((node) => node.id === nodeId)) ??
    flow?.nodes.find((node) => node.type === "project")?.id ??
    flow?.nodes[0]?.id;
  if (!targetNodeId) return;

  const existingNotes = await readNotes(projectRoot);
  if (existingNotes.some((note) => note.body.includes(`Run ${run.id}`) && note.kind === "system-note")) return;

  const note = noteSchema.parse({
    id: id("note"),
    flowId: run.flowId,
    nodeId: targetNodeId,
    kind: "system-note",
    author: "system",
    body: `Run ${run.id} ${run.status}.\n\n${message}`,
    resolved: run.status === "succeeded",
    attachmentIds: [],
    createdAt: iso()
  });
  await appendNote(projectRoot, note);
}

async function writeLlmHandoffNotes(projectRoot: string, bundle: ProjectBundle | null, run: Run, message: string): Promise<void> {
  const flow = bundle?.flows.find((item) => item.id === run.flowId);
  if (!flow) return;
  const shouldWrite = run.sourceDiffArtifactIds.length > 0 || run.status === "failed";
  if (!shouldWrite) return;

  const nodeIds = llmHandoffNodeIds(flow, run);
  if (!nodeIds.length) return;

  const existingNotes = await readNotes(projectRoot);
  for (const nodeId of nodeIds) {
    if (existingNotes.some((note) => note.nodeId === nodeId && note.author === "llm" && note.body.includes(`run ${run.id}`))) continue;
    const body = run.status === "succeeded"
      ? `LLM handoff for run ${run.id}: I applied the requested change for this node and left the source diff attached to the run. ${message}`
      : `LLM handoff for run ${run.id}: I could not finish this cleanly. ${message}`;
    const note = noteSchema.parse({
      id: id("note"),
      flowId: run.flowId,
      nodeId,
      kind: "system-note",
      author: "llm",
      body,
      resolved: false,
      attachmentIds: run.sourceDiffArtifactIds,
      createdAt: iso()
    });
    await appendNote(projectRoot, note);
  }
}

function llmHandoffNodeIds(flow: Flow, run: Run): string[] {
  if (run.affectedNodeIds.length) return run.affectedNodeIds.filter((nodeId) => flow.nodes.some((node) => node.id === nodeId));
  if (run.nodeId && flow.nodes.some((node) => node.id === run.nodeId)) return [run.nodeId];

  const relevantFlags = new Set<NodeFlag>(["changed", "needs-attention", "modified-not-built", "llm-question"]);
  const flaggedNodes = flow.nodes
    .filter((node) => !isProductionApproved(node) && node.flags.some((flag) => relevantFlags.has(flag)))
    .map((node) => node.id);
  if (flaggedNodes.length) return flaggedNodes.slice(0, 6);

  const projectNode = flow.nodes.find((node) => node.type === "project");
  return projectNode ? [projectNode.id] : flow.nodes[0] ? [flow.nodes[0].id] : [];
}

export function nodeIdsForRunOutcome(flow: Flow | undefined, run: Run): Set<string> {
  if (!flow) return new Set();
  if (run.affectedNodeIds.length) return new Set(run.affectedNodeIds);
  if (run.nodeId) return new Set([run.nodeId]);
  if (run.scope?.kind === "nodes") return new Set(run.scope.nodeIds);
  if (run.scope?.kind === "flow" && run.scope.flowId === flow.id) return new Set(workingNodesForFlow(flow).map((node) => node.id));
  if (run.scope?.kind === "project" || run.purpose === "build-discovery") return new Set(workingNodesForFlow(flow).map((node) => node.id));
  return run.sourceDiffArtifactIds.length ? new Set(workingNodesForFlow(flow).map((node) => node.id)) : new Set();
}

async function updateRunNodeOutcome(projectRoot: string, bundle: ProjectBundle | null, run: Run, verificationFailed: boolean): Promise<void> {
  const flow = bundle?.flows.find((item) => item.id === run.flowId);
  const projectLevelVerification = runIsProjectLevelVerification(run);
  const targetFlows = projectLevelVerification && bundle ? bundle.flows : flow ? [flow] : [];
  if (!targetFlows.length) return;

  const managedVerificationPassed = !verificationFailed && runHasSuccessfulVerificationCommand(run);
  for (const targetFlow of targetFlows) {
    const nodeIds = projectLevelVerification
      ? new Set(targetFlow.nodes.map((node) => node.id))
      : nodeIdsForRunOutcome(targetFlow, run);
    if (!nodeIds.size) continue;

    const hasSourceChanges = run.sourceDiffArtifactIds.length > 0 && targetFlow.id === run.flowId;
    let changed = false;
    // Nodes whose dirty flags were actually cleared this run. A verified build
    // only clears a node once its acceptance checks are satisfied, so nodes with
    // still-failing/unverified checks stay dirty and are excluded here — which in
    // turn keeps their pending graph-change records unresolved below.
    const clearedNodeIds = new Set<string>();
    const nodes = targetFlow.nodes.map((node) => {
      if (!nodeIds.has(node.id) || node.ignored || isSubflowIgnored(targetFlow, node.subflowId) || isProductionApproved(node)) return node;

      const flags = new Set(node.flags);
      let stage = node.stage;
      if (hasSourceChanges && (stage === "planned" || stage === "plan-approved" || stage === "working" || stage === "draft-rejected")) {
        stage = "draft";
      } else if (run.status === "failed" && stage === "planned") {
        stage = "working";
      } else if (run.status === "cancelled" && stage === "working") {
        stage = "planned";
      }

      if (hasSourceChanges) {
        flags.add("has-diff");
        flags.add("modified-not-built");
      }
      const acceptanceChecksPassed = node.acceptanceChecks.length > 0 && nodeAcceptanceChecksSatisfied(node);
      const nodeVerified = run.status === "succeeded" && (managedVerificationPassed || acceptanceChecksPassed);
      if ((run.status === "failed" || verificationFailed) && !nodeVerified) {
        flags.add("needs-attention");
      }
      if (nodeVerified && nodeAcceptanceChecksSatisfied(node)) {
        flags.delete("changed");
        flags.delete("needs-attention");
        flags.delete("modified-not-built");
        clearedNodeIds.add(node.id);
      }

      const nextFlags = Array.from(flags);
      const nextChanged = stage !== node.stage || nextFlags.join("|") !== node.flags.join("|");
      changed = changed || nextChanged;
      return nextChanged ? { ...node, stage, flags: nextFlags, updatedAt: iso() } : node;
    });

    if (changed) {
      await writeJson(projectStatePath(projectRoot, "flows", `${targetFlow.id}.json`), flowSchema.parse({ ...targetFlow, nodes, updatedAt: iso() }));
    }
    if (clearedNodeIds.size) {
      // Only nodes that actually cleared (build verified AND checks satisfied)
      // may retire their pending records. A flow fully covers its pending
      // flow-level records only when every node in it cleared.
      const coversEntireFlow = targetFlow.nodes.length > 0 && clearedNodeIds.size >= targetFlow.nodes.length;
      await markPendingGraphChangesImplemented(projectRoot, targetFlow.id, clearedNodeIds, run.id, coversEntireFlow);
    }
  }
}

export async function reconcileVerifiedNodeBuildFlags(projectRoot: string, flows: Flow[], runs: Run[]): Promise<Flow[]> {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const successfulDiffRunIdsByFlowId = new Map<string, Set<string>>();
  let hasSuccessfulProjectVerification = false;
  for (const run of runs) {
    if (runIsProjectLevelVerification(run)) {
      hasSuccessfulProjectVerification = true;
    }
    if (run.sourceDiffArtifactIds.length && runHasSuccessfulManagedVerification(run)) {
      const set = successfulDiffRunIdsByFlowId.get(run.flowId) ?? new Set<string>();
      set.add(run.id);
      successfulDiffRunIdsByFlowId.set(run.flowId, set);
    }
  }

  const reconciledFlows: Flow[] = [];
  for (const flow of flows) {
    const successfulRunIds = successfulDiffRunIdsByFlowId.get(flow.id);
    if (!successfulRunIds?.size && !hasSuccessfulProjectVerification) {
      reconciledFlows.push(flow);
      continue;
    }

    let changed = false;
    const nodes = flow.nodes.map((node) => {
      if (node.ignored || isProductionApproved(node) || !node.flags.includes("modified-not-built")) return node;
      if (!nodeAcceptanceChecksSatisfied(node)) return node;
      const diffAttachments = node.attachments
        .filter((artifact) => artifact.type === "diff" && artifact.runId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latestDiffRun = diffAttachments[0]?.runId ? runsById.get(diffAttachments[0].runId) : undefined;
      if (!hasSuccessfulProjectVerification && (!latestDiffRun || !successfulRunIds?.has(latestDiffRun.id))) return node;

      const flags = new Set(node.flags);
      flags.delete("changed");
      flags.delete("modified-not-built");
      if (!flags.has("llm-question")) flags.delete("needs-attention");
      const nextFlags = Array.from(flags);
      if (nextFlags.join("|") === node.flags.join("|")) return node;
      changed = true;
      return { ...node, flags: nextFlags, updatedAt: iso() };
    });

    const nextFlow = changed ? flowSchema.parse({ ...flow, nodes, updatedAt: iso() }) : flow;
    if (changed) await writeJson(projectStatePath(projectRoot, "flows", `${flow.id}.json`), nextFlow);
    reconciledFlows.push(nextFlow);
  }

  return reconciledFlows;
}

// Kinds whose referenced graph item is expected to be absent (the change *is* a
// deletion). These are never obsoleted for referencing a missing id.
const deletionGraphChangeKinds = new Set<GraphChangeRecord["kind"]>([
  "node-deleted",
  "edge-deleted",
  "subflow-deleted",
  "group-deleted"
]);

// Retire pending create/update records whose target graph item no longer exists
// (item or its whole flow was deleted). Without this, such records stay pending
// forever — no verified run can ever touch a node/edge/subflow that is gone — and
// permanently occupy the compact pendingGraphChanges context window.
export async function reconcileObsoleteGraphChanges(
  projectRoot: string,
  flows: Flow[],
  graphChanges: GraphChangeRecord[]
): Promise<GraphChangeRecord[]> {
  if (!graphChanges.some((change) => change.status === "pending")) return graphChanges;
  const flowsById = new Map(flows.map((flow) => [flow.id, flow]));
  const now = iso();
  let changed = false;

  const updated = graphChanges.map((change) => {
    if (change.status !== "pending") return change;
    const flow = flowsById.get(change.flowId);
    // Flow gone: every pending record for it (including deletions) is moot.
    if (!flow) {
      changed = true;
      return { ...change, status: "obsolete" as const, resolvedAt: now };
    }
    if (deletionGraphChangeKinds.has(change.kind)) return change;

    const targetsMissing = (): boolean => {
      if (change.kind === "node-created" || change.kind === "node-updated") {
        return change.nodeIds.length > 0 && !change.nodeIds.some((id) => flow.nodes.some((node) => node.id === id));
      }
      if (change.kind === "edge-created" || change.kind === "edge-updated") {
        return change.edgeIds.length > 0 && !change.edgeIds.some((id) => flow.edges.some((edge) => edge.id === id));
      }
      if (change.kind === "subflow-created" || change.kind === "subflow-updated" || change.kind === "node-subflow-linked") {
        return change.subflowIds.length > 0 && !change.subflowIds.some((id) => flow.subflows.some((subflow) => subflow.id === id));
      }
      if (change.kind === "group-created" || change.kind === "group-updated") {
        return change.groupIds.length > 0 && !change.groupIds.some((id) => flow.groups.some((group) => group.id === id));
      }
      return false;
    };

    if (!targetsMissing()) return change;
    changed = true;
    return { ...change, status: "obsolete" as const, resolvedAt: now };
  });

  if (changed) await writeGraphChanges(projectRoot, updated);
  return updated;
}

const GRAPH_CHANGE_RETENTION_MS: Record<GraphChangeRetention, number | null> = {
  "1day": 24 * 60 * 60 * 1000,
  "1week": 7 * 24 * 60 * 60 * 1000,
  "2weeks": 14 * 24 * 60 * 60 * 1000,
  "1month": 30 * 24 * 60 * 60 * 1000,
  "3months": 90 * 24 * 60 * 60 * 1000,
  never: null
};

// Fold resolved (implemented/obsolete) ledger records older than the retention
// window into the cold archive and drop them from the hot JSONL that loadProject
// reads in full. Pending records are always kept regardless of age. Returns the
// records that remain hot.
export async function compactGraphChangeLedger(
  projectRoot: string,
  records: GraphChangeRecord[],
  retention: GraphChangeRetention
): Promise<GraphChangeRecord[]> {
  const maxAgeMs = GRAPH_CHANGE_RETENTION_MS[retention];
  if (maxAgeMs === null) return records;
  const cutoff = Date.now() - maxAgeMs;
  const kept: GraphChangeRecord[] = [];
  const archived: GraphChangeRecord[] = [];
  for (const record of records) {
    const resolvedTime = record.resolvedAt ? Date.parse(record.resolvedAt) : NaN;
    const isResolved = record.status === "implemented" || record.status === "obsolete";
    if (isResolved && Number.isFinite(resolvedTime) && resolvedTime < cutoff) {
      archived.push(record);
    } else {
      kept.push(record);
    }
  }
  if (!archived.length) return records;
  for (const record of archived) {
    await appendJsonLine(projectStatePath(projectRoot, GRAPH_CHANGES_ARCHIVE_FILE), record);
  }
  await writeGraphChanges(projectRoot, kept);
  return kept;
}

const orphanableRunStatuses = new Set<Run["status"]>(["preparing", "running", "planning", "coding", "debugging", "verifying"]);
const orphanedRunGraceMs = 30_000;

function latestRunActivityMs(run: Run): number {
  const timestamps = [
    run.startedAt,
    run.createdAt,
    ...run.logs.map((line) => line.at)
  ];
  return Math.max(...timestamps
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value)));
}

// Runs this process has already re-queued after a restart, so an orphan that
// stays unclaimed (e.g. another instance holds the lane lease) is not re-logged
// and re-kicked on every project load.
const restartResumedRunIds = new Set<string>();

// The status the queue dispatcher can restart an orphaned run from using only
// persisted state (phase progress, implementation checkpoints, approvals).
// `running` commands are re-executed only for verification — finite CI-style
// commands that are safe to repeat; arbitrary run/profile commands are not
// re-run unprompted. `preparing` cannot resume: its input exists only in the
// memory of the process that died.
function restartResumeStatus(run: Run): Run["status"] | null {
  if (run.status === "planning" || run.status === "coding" || run.status === "debugging" || run.status === "verifying") return run.status;
  if (run.status === "running" && run.phase === "verifying") return "verifying";
  return null;
}

export async function reconcileOrphanedInProgressRuns(projectRoot: string, runs: Run[]): Promise<Run[]> {
  const queueIsActive = activeProjectQueues.has(normalizeForCompare(projectRoot));
  if (queueIsActive) return runs;

  let changed = false;
  let resumedAny = false;
  const reconciled: Run[] = [];
  for (const run of runs) {
    const latestActivity = latestRunActivityMs(run);
    const recentlyActive = Number.isFinite(latestActivity) && Date.now() - latestActivity < orphanedRunGraceMs;
    if (!orphanableRunStatuses.has(run.status) || activeProcesses.has(run.id) || recentlyActive) {
      reconciled.push(run);
      continue;
    }

    const resumeStatus = restartResumeStatus(run);
    if (resumeStatus) {
      if (restartResumedRunIds.has(run.id)) {
        reconciled.push(run);
        continue;
      }
      restartResumedRunIds.add(run.id);
      changed = true;
      resumedAny = true;
      const resumed = runSchema.parse({
        ...run,
        status: resumeStatus,
        logs: [
          ...run.logs,
          {
            at: iso(),
            stream: "system",
            text: "Resuming run from its last persisted phase after ArchiCode restarted."
          }
        ]
      });
      await writeRun(projectRoot, resumed);
      reconciled.push(resumed);
      continue;
    }

    changed = true;
    const abandoned = runSchema.parse({
      ...run,
      status: "cancelled",
      phase: "complete",
      // The in-memory transition map is cold right after a restart, so record
      // the stopped phase explicitly for the abandoned run.
      stoppedAtPhase: run.stoppedAtPhase ?? (run.phase !== "complete" ? run.phase : undefined),
      queueRemovedAt: run.queueRemovedAt ?? iso(),
      logs: [
        ...run.logs,
        {
          at: iso(),
          stream: "system",
          text: "Run marked abandoned because ArchiCode restarted without an attached process."
        }
      ],
      runInstructions: "Run was abandoned after app restart. Start a new run if needed.",
      completedAt: run.completedAt ?? iso()
    });
    await writeRun(projectRoot, abandoned);
    reconciled.push(abandoned);
  }

  if (resumedAny) void scheduleNextQueuedJob(projectRoot);
  return changed ? reconciled : runs;
}

async function finalizeTerminalRun(projectRoot: string, run: Run, fallbackInstructions: string): Promise<Run> {
  const bundle = await loadProject(projectRoot).catch(() => null);
  const verificationFailures = run.command ? [] : failedVerificationCommands(run);
  const dependencyBlocked = hasDependencyInstallBlocker(verificationFailures);
  let status: Run["status"] = run.status === "succeeded" && verificationFailures.length ? "failed" : run.status;
  const policyGateLogs: Run["logs"] = [];
  let policyGateSummary = "";
  if (status === "succeeded" && run.sourceDiffArtifactIds.length > 0 && bundle && hasEnforcedArchitecturePolicies(bundle)) {
    try {
      const policyResult = await refreshArchitecturePolicyEvaluation(projectRoot, bundle);
      const hasRunBaseline = run.policyBaselineViolationIds !== undefined;
      const blockingViolations = hasRunBaseline
        ? blockingArchitecturePolicyViolationsSinceBaseline(policyResult.evaluation, run.policyBaselineViolationIds ?? [])
        : [];
      if (!hasRunBaseline) {
        policyGateLogs.push({
          at: iso(),
          stream: "system",
          text: "Architecture policy baseline established. Existing violations were recorded but did not fail this run."
        });
      } else if (blockingViolations.length) {
        status = "failed";
        policyGateSummary = `Architecture policy verification failed with ${blockingViolations.length} newly introduced enforced violation${blockingViolations.length === 1 ? "" : "s"}: ${blockingViolations.slice(0, 4).map((violation) => `${violation.policyTitle} at ${violation.source.path}${violation.source.line ? `:${violation.source.line}` : ""}`).join(", ")}.`;
        policyGateLogs.push({ at: iso(), stream: "stderr", text: policyGateSummary });
      } else {
        policyGateLogs.push({ at: iso(), stream: "system", text: "Deterministic architecture policy verification passed with no new enforced violations." });
      }
    } catch (error) {
      policyGateLogs.push({
        at: iso(),
        stream: "stderr",
        text: `Architecture policy verification could not complete and did not block the run: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
  const commands = await inferProjectCommands(projectRoot, bundle);
  const dependencyRecoveryText = dependencyBlocked ? await dependencyRecoveryInstruction(projectRoot, verificationFailures) : "";
  const summaryParts = [
    fallbackInstructions,
    verificationFailures.length
      ? `Verification failed: ${verificationFailures.map((result) => `\`${result.command}\``).join(", ")}.`
      : status === "succeeded"
        ? "Run completed without detected verification failures."
        : "",
    dependencyRecoveryText,
    policyGateSummary,
    commands.run ? "Preview with Run App when needed; runtime launch is separate from verification." : "",
    run.sourceDiffArtifactIds.length ? `Source diff artifact: ${run.sourceDiffArtifactIds.join(", ")}.` : ""
  ].filter(Boolean);
  const instructions = summaryParts.join(" ");
  const terminalLabel = status === "succeeded" ? "Final handoff" : "Final status";
  let finalized = runSchema.parse({
    ...run,
    status,
    phase: "complete",
    todos: run.todos.map((todo) => status === "succeeded"
      ? { ...todo, status: "done" }
      : todo.status === "done"
        ? todo
        : { ...todo, status: "blocked" }),
    logs: [
      ...run.logs,
      ...policyGateLogs,
      { at: iso(), stream: status === "succeeded" ? "system" : "stderr", text: `${terminalLabel}: ${instructions}` }
    ],
    runInstructions: instructions,
    completedAt: run.completedAt ?? iso()
  });

  // On a verified build, run and judge the affected nodes' acceptance checks
  // first, then reload so updateRunNodeOutcome's gate sees the fresh statuses.
  let outcomeBundle = bundle;
  if (status === "succeeded" && verificationFailures.length === 0 && bundle) {
    const checkLogs = await verifyRunAcceptanceChecks(projectRoot, bundle, finalized).catch((error) => ([{
      at: iso(),
      stream: "stderr" as const,
      text: `Acceptance-check verification failed: ${error instanceof Error ? error.message : String(error)}`
    }]));
    if (checkLogs.length) {
      finalized = runSchema.parse({ ...finalized, logs: [...finalized.logs, ...checkLogs] });
      await writeRun(projectRoot, finalized);
      outcomeBundle = await loadProject(projectRoot).catch(() => bundle);
    }
  }
  await updateRunNodeOutcome(projectRoot, outcomeBundle, finalized, verificationFailures.length > 0);
  await writeRunCompletionNote(projectRoot, bundle, finalized, instructions);
  await writeLlmHandoffNotes(projectRoot, bundle, finalized, instructions);
  return finalized;
}

function isWriteCapableProvider(provider: ProjectSettings["providers"][number] | undefined): boolean {
  return (provider?.kind === "codex-local" || provider?.kind === "claude-local" || provider?.kind === "opencode-local" || provider?.kind === "antigravity-local" || provider?.kind === "grok-local" || provider?.kind === "kimi-local") && provider.localSandbox !== "read-only";
}

function requiresProviderLaunchApproval(provider: ProjectSettings["providers"][number] | undefined): boolean {
  return false;
}

export function commandsAutoApproved(settings: ProjectSettings, risk: Run["risk"] = "low", command?: string): boolean {
  if (!settings.autoApproveShellCommands) return false;
  if (risk === "high") return false;
  // An unrecognized binary at medium risk is the case the classifier cannot
  // reason about, so it prompts once instead of running silently. Approval then
  // persists through the existing reusable shell-policy path.
  if (risk === "medium" && command !== undefined && !isKnownBinary(command)) return false;
  return true;
}

function isCodeCapableProvider(provider: ProjectSettings["providers"][number] | undefined): boolean {
  return Boolean(provider && provider.kind !== "offline-manual");
}

function providerCommand(provider: ProjectSettings["providers"][number] | undefined): string | null {
  if (!provider || (provider.kind !== "codex-local" && provider.kind !== "claude-local" && provider.kind !== "opencode-local" && provider.kind !== "antigravity-local" && provider.kind !== "grok-local" && provider.kind !== "kimi-local")) return null;
  return provider.localCommand?.trim() || (provider.kind === "claude-local" ? "claude" : provider.kind === "opencode-local" ? "opencode" : provider.kind === "antigravity-local" ? "agy" : provider.kind === "grok-local" ? "grok" : provider.kind === "kimi-local" ? "kimi" : "codex");
}

export async function writeRunPlanArtifact(
  projectRoot: string,
  input: {
    runId: string;
    flowId: string;
    nodeId?: string;
    promptSummary: string;
    providerId: string;
    plannedCommands: string[];
    plannedAllowedRoots: string[];
    scope?: FilesystemScopeEvaluation | null;
  }
): Promise<Artifact> {
  const artifact: Artifact = artifactSchema.parse({
    id: id("plan"),
    type: "plan",
    title: input.promptSummary.length > 72 ? `${input.promptSummary.slice(0, 71)}...` : input.promptSummary,
    path: `.archicode/artifacts/${input.runId}-plan.json`,
    nodeId: input.nodeId,
    runId: input.runId,
    summary: input.promptSummary,
    promptSummary: input.promptSummary,
    createdAt: iso()
  });
  const plan = {
    ...artifact,
    plan: {
      intent: input.promptSummary,
      scope: {
        flowId: input.flowId,
        nodeId: input.nodeId,
        providerId: input.providerId
      },
      assumptions: [
        "Every change run starts with a planning phase before coding.",
        "Planning review is optional unless project settings or blocking questions require it.",
        "Source changes review is separate and optional unless project settings require it."
      ],
      intendedFiles: [],
      commandsNeeded: input.plannedCommands,
      risks: input.scope?.violations ?? [],
      testsExpected: input.plannedCommands.filter((command) => /\b(test|build|check|verify)\b/i.test(command)),
      rollbackNotes: "Use the source diff artifact and project version control, if available, to review or revert changed files.",
      allowedRoots: input.plannedAllowedRoots
    }
  };
  await writeJson(path.join(projectRoot, artifact.path), plan);
  return artifact;
}

async function writeProviderPlanOutput(projectRoot: string, run: Run, output: string): Promise<void> {
  const planArtifactId = run.planArtifactIds[0];
  if (!planArtifactId) return;
  const artifactPath = path.join(projectRoot, `.archicode/artifacts/${run.id}-plan.json`);
  const raw = await readJson<Record<string, unknown>>(artifactPath, {});
  const providerSummary = compactSummary(output);
  await writeJson(artifactPath, {
    ...raw,
    title: typeof raw.title === "string" && raw.title.trim()
      ? raw.title
      : run.promptSummary.length > 72 ? `${run.promptSummary.slice(0, 71)}...` : run.promptSummary,
    summary: providerSummary,
    promptSummary: typeof raw.promptSummary === "string" && raw.promptSummary.trim() ? raw.promptSummary : run.promptSummary,
    providerSummary,
    text: output,
    planOutputAt: iso()
  });
}

export async function collectSourceSnapshot(projectRoot: string): Promise<SourceSnapshot> {
  const snapshot: SourceSnapshot = new Map();
  async function walk(dirPath: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".gitignore" && !SOURCE_DIFF_IGNORE_DIRS.has(entry.name)) {
        // Keep ordinary dotfiles out of generated source diffs unless explicitly useful.
        continue;
      }
      if (SOURCE_DIFF_IGNORE_DIRS.has(entry.name)) continue;
      const absolute = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStats = await stat(absolute);
      if (fileStats.size > SOURCE_DIFF_MAX_FILE_BYTES) continue;
      const bytes = await readFile(absolute);
      if (bytes.includes(0)) continue;
      const relative = path.relative(projectRoot, absolute).replace(/\\/g, "/");
      snapshot.set(relative, bytes.toString("utf8"));
    }
  }
  await walk(projectRoot);
  return snapshot;
}

export function buildUnifiedSourceDiff(before: SourceSnapshot, after: SourceSnapshot): string {
  const fileNames = [...new Set([...before.keys(), ...after.keys()])].sort();
  const chunks: string[] = [];
  for (const fileName of fileNames) {
    const oldText = before.get(fileName);
    const newText = after.get(fileName);
    if (oldText === newText) continue;
    chunks.push(`diff --git a/${fileName} b/${fileName}`);
    chunks.push(`--- ${oldText === undefined ? "/dev/null" : `a/${fileName}`}`);
    chunks.push(`+++ ${newText === undefined ? "/dev/null" : `b/${fileName}`}`);
    chunks.push("@@");
    if (isGeneratedLockfilePath(fileName)) {
      chunks.push(`@@ ${oldText === undefined ? "added" : newText === undefined ? "deleted" : "changed"} generated lockfile omitted from source diff context @@`);
      continue;
    }
    if (oldText !== undefined) {
      for (const line of oldText.split(/\r?\n/)) chunks.push(`-${line}`);
    }
    if (newText !== undefined) {
      for (const line of newText.split(/\r?\n/)) chunks.push(`+${line}`);
    }
  }
  return chunks.join("\n");
}

function isGeneratedLockfilePath(fileName: string): boolean {
  return GENERATED_LOCKFILE_PATHS.some((pattern) => pattern.test(fileName));
}

export async function writeSourceDiffArtifact(projectRoot: string, run: Run, diff: string, options: { suffix?: string; title?: string } = {}): Promise<Artifact | null> {
  if (!diff.trim()) return null;
  const suffix = options.suffix ? `-${options.suffix.replace(/[^a-z0-9-]/gi, "-")}` : "";
  const artifact: Artifact = artifactSchema.parse({
    id: id("diff"),
    type: "diff",
    title: options.title ?? `Source diff ${run.id}`,
    path: `.archicode/artifacts/${run.id}-source-diff${suffix}.json`,
    nodeId: run.nodeId,
    runId: run.id,
    summary: `${diff.split(/^diff --git /m).length - 1} changed files`,
    sizeBytes: Buffer.byteLength(diff, "utf8"),
    createdAt: iso()
  });
  await writeJson(path.join(projectRoot, artifact.path), {
    ...artifact,
    diff
  });
  return artifact;
}

function implementationStateForRun(run: Run): RunImplementationState {
  const tasks = run.implementation?.tasks ?? [];
  return {
    currentBatch: run.implementation?.currentBatch ?? 0,
    maxBatches: run.implementation?.maxBatches ?? implementationBatchBudget(tasks, concreteRunEffort(run)),
    currentTaskId: run.implementation?.currentTaskId,
    tasks,
    fallbackReason: run.implementation?.fallbackReason,
    needsMoreWork: run.implementation?.needsMoreWork,
    needsReplan: run.implementation?.needsReplan,
    summary: run.implementation?.summary,
    checkpoints: run.implementation?.checkpoints ?? []
  };
}

const RUN_MEMORY_SUMMARY_LIMIT = 1400;
const RUN_MEMORY_LIST_LIMIT = 16;
const RUN_MEMORY_TODO_LIMIT = 16;

function boundedRunMemoryText(text: string | undefined, limit = 220): string | undefined {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact;
}

function boundedRunMemoryList(values: Array<string | undefined>, limit = RUN_MEMORY_LIST_LIMIT): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const compact = boundedRunMemoryText(value);
    if (!compact || seen.has(compact)) continue;
    seen.add(compact);
    out.push(compact);
  }
  return out.slice(-limit);
}

function currentRunMemoryTask(implementation: RunImplementationState | undefined): string | undefined {
  if (!implementation) return undefined;
  const task = currentImplementationTask(implementation);
  return boundedRunMemoryText(task ? `${task.title}${task.summary ? ` — ${task.summary}` : ""}` : undefined, 260);
}

function runMemoryTodos(run: Run, implementation: RunImplementationState | undefined): RunMemoryCard["todos"] {
  const source = implementation?.tasks.length
    ? implementation.tasks.map((task) => ({
        title: task.title,
        status: task.status,
        notes: task.summary
      }))
    : run.todos.map((todo) => ({
        title: todo.text,
        status: todo.status,
        notes: todo.kind
      }));
  return source.slice(0, RUN_MEMORY_TODO_LIMIT).map((todo) => ({
    title: boundedRunMemoryText(todo.title, 180) ?? "Untitled task",
    status: todo.status,
    notes: boundedRunMemoryText(todo.notes, 180)
  }));
}

function runMemoryFromRun(run: Run, extra: {
  phaseNote?: string;
  completedWork?: string[];
  touchedFiles?: string[];
  failedAttempts?: string[];
  verification?: string[];
  decisions?: string[];
  constraints?: string[];
  openQuestions?: string[];
  artifactIds?: string[];
  nextStep?: string;
} = {}): RunMemoryCard {
  const implementation = run.implementation;
  const existing = run.runMemory;
  const checkpointSummaries = implementation?.checkpoints.map((checkpoint) =>
    checkpoint.summary ? `Batch ${checkpoint.batchNumber}: ${checkpoint.summary}` : undefined
  ) ?? [];
  const failedCheckpoints = implementation?.checkpoints
    .filter((checkpoint) => checkpoint.status === "failed" || checkpoint.verification?.passed === false)
    .map((checkpoint) => checkpoint.summary ? `Batch ${checkpoint.batchNumber}: ${checkpoint.summary}` : `Batch ${checkpoint.batchNumber} failed`) ?? [];
  const verificationEntries = [
    ...(existing?.verification ?? []),
    ...(implementation?.checkpoints.flatMap((checkpoint) =>
      checkpoint.verification ? [`Batch ${checkpoint.batchNumber}: ${checkpoint.verification.summary}`] : []
    ) ?? []),
    run.lastVerification ? `${run.lastVerification.command}: exit ${run.lastVerification.exitCode ?? "unknown"}` : undefined,
    ...(extra.verification ?? [])
  ];
  const summaryParts = [
    existing?.summary,
    extra.phaseNote,
    implementation?.summary,
    run.runInstructions
  ].filter(Boolean).join(" ");
  return {
    summary: boundedRunMemoryText(summaryParts, RUN_MEMORY_SUMMARY_LIMIT) ?? "",
    goal: boundedRunMemoryText(existing?.goal || run.promptSummary, 300) ?? run.promptSummary,
    currentPhase: run.phase,
    currentTask: currentRunMemoryTask(implementation),
    todos: runMemoryTodos(run, implementation),
    completedWork: boundedRunMemoryList([
      ...(existing?.completedWork ?? []),
      ...checkpointSummaries,
      ...(extra.completedWork ?? [])
    ]),
    decisions: boundedRunMemoryList([
      ...(existing?.decisions ?? []),
      ...(extra.decisions ?? [])
    ]),
    constraints: boundedRunMemoryList([
      ...(existing?.constraints ?? []),
      run.guidance?.text ? `Guidance: ${run.guidance.text}` : undefined,
      ...(extra.constraints ?? [])
    ]),
    touchedFiles: boundedRunMemoryList([
      ...(existing?.touchedFiles ?? []),
      ...run.sourceDiffArtifactIds.map((artifactId) => `source diff artifact ${artifactId}`),
      ...(extra.touchedFiles ?? [])
    ]),
    failedAttempts: boundedRunMemoryList([
      ...(existing?.failedAttempts ?? []),
      ...failedCheckpoints,
      ...(extra.failedAttempts ?? [])
    ]),
    verification: boundedRunMemoryList(verificationEntries),
    openQuestions: boundedRunMemoryList([
      ...(existing?.openQuestions ?? []),
      ...(implementation?.needsReplan?.suggestedQuestions ?? []),
      ...(extra.openQuestions ?? [])
    ]),
    artifactIds: boundedRunMemoryList([
      ...(existing?.artifactIds ?? []),
      ...run.contextArtifacts,
      ...run.planArtifactIds,
      ...run.sourceDiffArtifactIds,
      ...(extra.artifactIds ?? [])
    ]),
    nextStep: boundedRunMemoryText(extra.nextStep ?? run.runInstructions, 260),
    updatedAt: iso()
  };
}

function concreteRunEffort(run: Pick<Run, "effort">): Exclude<RunEffort, "auto"> {
  return run.effort === "fast" ? "fast" : "high";
}

function clampImplementationTaskBudget(value: number | undefined, effort: Exclude<RunEffort, "auto">): number {
  const maxPerTask = effort === "fast" ? FAST_IMPLEMENTATION_MAX_BATCHES_PER_TASK : HIGH_IMPLEMENTATION_MAX_BATCHES_PER_TASK;
  if (!Number.isFinite(value) || !value) return 1;
  return Math.min(maxPerTask, Math.max(1, Math.floor(value)));
}

function implementationBatchBudget(tasks: RunImplementationTask[], effort: Exclude<RunEffort, "auto"> = "high"): number {
  if (!tasks.length) return effort === "fast" ? FAST_IMPLEMENTATION_TOTAL_BATCH_LIMIT : IMPLEMENTATION_FALLBACK_BATCH_BUDGET;
  const total = tasks.reduce((sum, task) => sum + clampImplementationTaskBudget(task.batchBudget, effort), 0);
  const totalLimit = effort === "fast" ? FAST_IMPLEMENTATION_TOTAL_BATCH_LIMIT : HIGH_IMPLEMENTATION_TOTAL_BATCH_LIMIT;
  return Math.min(totalLimit, Math.max(1, total));
}

function implementationDynamicBatchLimit(run: Pick<Run, "effort">): number {
  return concreteRunEffort(run) === "fast" ? FAST_IMPLEMENTATION_DYNAMIC_TOTAL_BATCH_LIMIT : HIGH_IMPLEMENTATION_TOTAL_BATCH_LIMIT;
}

function isNoScopeRun(run: Pick<Run, "scope">): boolean {
  return run.scope?.kind === "no-scope";
}

function noScopeImplementationState(run: Run): RunImplementationState {
  const existing = run.implementation;
  if (existing?.tasks.length) return {
    ...implementationStateForRun(run),
    maxBatches: Math.min(existing.maxBatches, FAST_IMPLEMENTATION_TOTAL_BATCH_LIMIT)
  };
  return {
    currentBatch: existing?.currentBatch ?? 0,
    maxBatches: FAST_IMPLEMENTATION_TOTAL_BATCH_LIMIT,
    currentTaskId: existing?.currentTaskId,
    tasks: [{
      id: "task-1",
      title: run.scope?.label?.trim() || "Apply quick source edit",
      summary: run.promptSummary,
      batchBudget: 1,
      status: "todo"
    }],
    needsMoreWork: existing?.needsMoreWork,
    needsReplan: existing?.needsReplan,
    summary: existing?.summary,
    checkpoints: existing?.checkpoints ?? []
  };
}

function implementationTasksFromProposal(patchProposal: PersistedPatchProposal | null, effort: Exclude<RunEffort, "auto"> = "high"): RunImplementationTask[] {
  const tasks = patchProposal?.implementationTasks ?? [];
  const parsedTasks = tasks
    .map((task, index) => ({
      id: task.id?.trim() || `task-${index + 1}`,
      title: task.title.trim(),
      summary: task.summary?.trim() || undefined,
      verificationCommand: task.verificationCommand?.trim() || undefined,
      lightVerificationCommand: task.lightVerificationCommand?.trim() || undefined,
      batchBudget: clampImplementationTaskBudget(task.batchBudget, effort),
      status: "todo" as const
    }))
    .filter((task) => task.title);
  return effort === "fast" ? compactFastImplementationTasks(parsedTasks) : parsedTasks;
}

function compactFastImplementationTasks(tasks: RunImplementationTask[]): RunImplementationTask[] {
  if (tasks.length <= FAST_IMPLEMENTATION_TOTAL_BATCH_LIMIT) return tasks.map((task) => ({
    ...task,
    batchBudget: clampImplementationTaskBudget(task.batchBudget, "fast")
  }));
  const verificationCommand = tasks.find((task) => task.verificationCommand && !isBuildVerificationCommand(task.verificationCommand))?.verificationCommand ??
    tasks.find((task) => task.verificationCommand)?.verificationCommand;
  const lightVerificationCommand = tasks.find((task) => task.lightVerificationCommand)?.lightVerificationCommand;
  return [{
    id: "task-fast-1",
    title: "Implement requested scope",
    summary: tasks.map((task) => `${task.title}${task.summary ? `: ${task.summary}` : ""}`).join(" "),
    verificationCommand,
    lightVerificationCommand,
    batchBudget: 1,
    status: "todo"
  }];
}

function defaultImplementationTasks(run: Run): RunImplementationTask[] {
  return [{
    id: "task-1",
    title: run.nodeId ? "Implement selected node" : "Implement requested change",
    summary: run.promptSummary,
    batchBudget: concreteRunEffort(run) === "fast" ? 1 : 2,
    status: "todo"
  }];
}

const IMPLEMENTATION_TASK_FALLBACK_REASON = "Planning produced no explicit task split after refinement; coding is using one generic task derived from the run request.";

const PLAN_ASK_QUESTIONS_PATTERN = /^\s*Decision:\s*ask[_\s-]?questions/im;
const PLAN_REQUIRED_SECTIONS = ["goal", "approach", "verification"] as const;

function planTextHasSection(output: string, section: string): boolean {
  return new RegExp(`(^|\\n)\\s*#{0,3}\\s*${section}\\b`, "i").test(output) ||
    new RegExp(`\\b${section}\\b\\s*:`, "i").test(output);
}

// Deterministic, no-LLM plan quality check. Returns concrete findings that
// drive an in-phase refine turn; empty findings means the plan is good enough
// to proceed. A deliberate question-gate stop is always treated as clean.
function validatePlanQuality(input: {
  run: Run;
  output: string;
  proposal: PersistedPatchProposal | null;
  scopeNodeTitles: string[];
  hasVerifiableScripts: boolean;
  mcpToolCalls: Run["mcpToolCalls"];
  isApiProvider: boolean;
}): { clean: boolean; findings: string[] } {
  const { run, output, proposal, scopeNodeTitles, hasVerifiableScripts, mcpToolCalls, isApiProvider } = input;
  if (PLAN_ASK_QUESTIONS_PATTERN.test(output)) return { clean: true, findings: [] };

  const findings: string[] = [];
  const tasks = proposal?.implementationTasks ?? [];
  const prompt = run.promptSummary.trim();

  // Orchestration: a real task split, not the effective generic single-task fallback.
  const onlyGenericTask = tasks.length === 0 ||
    (tasks.length === 1 && (!tasks[0].summary?.trim() || tasks[0].summary.trim() === prompt));
  if (onlyGenericTask) {
    findings.push("No real implementation task split: return ordered, self-contained implementationTasks, each with a concrete summary distinct from the run request.");
  }

  // Each task in a multi-task plan needs a real, distinct summary.
  const shallowTasks = tasks.filter((task) => {
    const summary = task.summary?.trim() ?? "";
    return !summary || summary === prompt;
  });
  if (tasks.length > 1 && shallowTasks.length) {
    findings.push(`${shallowTasks.length} task(s) lack a concrete summary distinct from the run request; describe what each task changes.`);
  }

  // Ordering: a test-authoring task must not precede the implementation it verifies.
  const isTestTask = (task: { title: string; summary?: string }) => /\b(test|spec)\b/i.test(`${task.title} ${task.summary ?? ""}`);
  const firstTestIndex = tasks.findIndex(isTestTask);
  const firstNonTestIndex = tasks.findIndex((task) => !isTestTask(task));
  if (firstTestIndex >= 0 && firstNonTestIndex >= 0 && firstTestIndex < firstNonTestIndex) {
    findings.push("Task ordering inversion: a test-authoring task is scheduled before the implementation it verifies; reorder so implementation precedes its tests.");
  }

  // Coverage (soft heuristic): a multi-node scope should be reflected in task text.
  if (scopeNodeTitles.length > 1 && tasks.length) {
    const haystack = tasks.map((task) => `${task.title} ${task.summary ?? ""}`).join(" \n ").toLowerCase();
    const uncovered = scopeNodeTitles.filter((title) => title.trim() && !haystack.includes(title.trim().toLowerCase()));
    if (uncovered.length && (uncovered.length > scopeNodeTitles.length / 2 || tasks.length < Math.ceil(scopeNodeTitles.length / 2))) {
      findings.push(`Plan may not cover all in-scope nodes (${uncovered.slice(0, 6).join(", ")}); ensure every in-scope node maps to at least one task.`);
    }
  }

  // Verification: name a finite check when the project clearly supports one.
  const hasTaskVerification = tasks.some((task) => task.verificationCommand?.trim() || task.lightVerificationCommand?.trim());
  const proseHasVerification = planTextHasSection(output, "verification") || /verification\s*(plan|command)/i.test(output);
  if (hasVerifiableScripts && !hasTaskVerification && !proseHasVerification) {
    findings.push("No verification named: add a task verificationCommand/lightVerificationCommand or a Verification section describing the finite check to run.");
  }

  // Inspection (API providers only): local CLI providers inspect in their own
  // harness, invisible to our tool transcript, so this is advisory there.
  if (isApiProvider) {
    const inspected = mcpToolCalls.some((call) =>
      /read_file/i.test(call.toolName) ||
      /manage_rules/i.test(call.toolName) ||
      /list_violations/i.test(call.argumentsJson ?? ""));
    if (!inspected) {
      findings.push("Plan authored without inspecting project source: call read_file on the target files (and list_violations) before finalizing the task split.");
    }
  }

  // Presentation: the user-facing plan must read as a concrete implementation plan.
  const missingSections = PLAN_REQUIRED_SECTIONS.filter((section) => !planTextHasSection(output, section));
  if (missingSections.length) {
    findings.push(`User-facing plan is missing section(s): ${missingSections.join(", ")}. Write a concrete Goal / Approach / Verification (and Risks / Key Assumptions) plan for the user.`);
  }

  return { clean: findings.length === 0, findings };
}

// Best-effort detection of a finite verification command the plan could name.
// Conservative and stack-aware: only JS/TS projects expose package scripts, so
// non-JS stacks return false and never trigger a spurious verification finding.
async function projectHasVerifiableScripts(projectRoot: string): Promise<boolean> {
  const packageJson = await readJson<{ scripts?: Record<string, string> } | null>(path.join(projectRoot, "package.json"), null);
  const scripts = packageJson?.scripts ?? {};
  return ["test", "typecheck", "check", "lint", "build"].some((name) => Boolean(scripts[name]?.trim()));
}

function inScopeNodeTitles(bundle: ProjectBundle, run: Run): string[] {
  const nodeIds = run.scope?.kind === "nodes" ? run.scope.nodeIds : [];
  if (!nodeIds.length) return [];
  const wanted = new Set(nodeIds);
  const titles: string[] = [];
  for (const flow of bundle.flows) {
    for (const node of flow.nodes) {
      if (wanted.has(node.id) && node.title.trim()) titles.push(node.title.trim());
    }
  }
  return titles;
}

function initializeImplementationState(run: Run, patchProposal: PersistedPatchProposal | null): RunImplementationState {
  if (isNoScopeRun(run)) return noScopeImplementationState(run);
  const existing = run.implementation;
  if (existing?.tasks.length) return implementationStateForRun(run);
  const effort = concreteRunEffort(run);
  const tasks = implementationTasksFromProposal(patchProposal, effort);
  const plannedTasks = tasks.length ? tasks : defaultImplementationTasks(run);
  return {
    currentBatch: existing?.currentBatch ?? 0,
    maxBatches: implementationBatchBudget(plannedTasks, effort),
    currentTaskId: existing?.currentTaskId,
    tasks: plannedTasks,
    fallbackReason: existing?.fallbackReason ?? (tasks.length ? undefined : IMPLEMENTATION_TASK_FALLBACK_REASON),
    needsMoreWork: existing?.needsMoreWork,
    needsReplan: existing?.needsReplan,
    summary: existing?.summary,
    checkpoints: existing?.checkpoints ?? []
  };
}

function resolveAutoImplementationEffort(run: Run, patchProposal: PersistedPatchProposal | null): Exclude<RunEffort, "auto"> {
  if (run.effort !== "auto") return concreteRunEffort(run);
  if (patchProposal?.implementationEffort) return patchProposal.implementationEffort;
  const taskCount = patchProposal?.implementationTasks?.length ?? 0;
  if (run.scope?.kind === "no-scope") return "fast";
  if (run.scope?.kind === "nodes" && (run.scope.nodeIds.length || 0) <= 1 && taskCount <= 3) return "fast";
  if (taskCount > 0 && taskCount <= 2) return "fast";
  return "high";
}

function currentImplementationTask(implementation: RunImplementationState): RunImplementationTask | null {
  return implementation.tasks.find((task) => task.id === implementation.currentTaskId && task.status !== "done" && task.status !== "blocked") ??
    implementation.tasks.find((task) => task.status === "doing") ??
    implementation.tasks.find((task) => task.status === "todo") ??
    null;
}

function implementationCheckpointCountForTask(implementation: RunImplementationState, taskId: string | undefined): number {
  if (!taskId) return 0;
  return implementation.checkpoints.filter((checkpoint) => checkpoint.taskId === taskId).length;
}

function continuationAdvancesToNextTask(
  implementation: RunImplementationState,
  task: RunImplementationTask | null,
  continuationRequested: boolean
): boolean {
  if (!continuationRequested || !task?.id) return false;
  const hasQueuedFollowUpTask = implementation.tasks.some((candidate) => candidate.id !== task.id && candidate.status === "todo");
  if (!hasQueuedFollowUpTask) return false;
  const plannedBudget = Math.max(1, task.batchBudget ?? 1);
  const consumedBatches = implementationCheckpointCountForTask(implementation, task.id) + 1;
  return consumedBatches >= plannedBudget;
}

function nextImplementationBatchLimit(run: Pick<Run, "effort">, implementation: RunImplementationState): number {
  return Math.min(implementation.maxBatches + 1, implementationDynamicBatchLimit(run));
}

function implementationBatchExtensionReason(input: {
  continuationRequested: boolean;
  failedVerification: boolean;
  hasRemainingTasks: boolean;
}): string {
  if (input.failedVerification) {
    return "Targeted verification failed; extended the dynamic batch budget";
  }
  if (input.continuationRequested) {
    return "Implementation requested another source batch; extended the dynamic batch budget";
  }
  if (input.hasRemainingTasks) {
    return "Implementation still has planned tasks; extended the dynamic batch budget";
  }
  return "Implementation needs another source batch; extended the dynamic batch budget";
}

function implementationBatchLimitMessage(
  implementation: RunImplementationState | undefined,
  verification: RunImplementationCheckpoint["verification"] | undefined,
  fallbackBudget: number
): string {
  const budget = implementation?.maxBatches ?? fallbackBudget;
  if (verification && !verification.passed) {
    return `Implementation reached its dynamic batch budget of ${budget} while targeted verification still fails: ${verification.command}. Retry or debug with the latest verification log.`;
  }
  return `Implementation reached its dynamic batch budget of ${budget} while source work remains. Retry or replan with the latest checkpoint context.`;
}

function setImplementationTaskStatus(
  implementation: RunImplementationState,
  taskId: string | undefined,
  status: RunImplementationTask["status"]
): RunImplementationState {
  if (!taskId) return implementation;
  return {
    ...implementation,
    currentTaskId: status === "done" ? undefined : taskId,
    tasks: implementation.tasks.map((task) => task.id === taskId ? { ...task, status } : task)
  };
}

function completeImplementationSnapshot(implementation: RunImplementationState | undefined): RunImplementationState | undefined {
  if (!implementation) return undefined;
  return {
    ...implementation,
    currentTaskId: undefined,
    needsMoreWork: false,
    tasks: implementation.tasks.map((task) => task.status === "blocked" ? task : { ...task, status: "done" })
  };
}

const emptyHandoffRetryGuidance = [
  "RETRY NOTICE: your previous response for this batch contained no usable propose-source-file operations and did not signal completion.",
  "You must now do exactly one of the following:",
  "1. Return an archicodePatch with concrete propose-source-file operations that implement the current task, or",
  "2. If the current task is already fully implemented, return an archicodePatch with runSummary.implementationStatus set to \"complete\" and an empty operations array; ArchiCode performs authoritative verification afterward.",
  "Do not return prose or explanation without one of these two structured outputs."
].join(" ");

function planRefineGuidance(findings: string[]): string {
  return [
    "PLAN REFINEMENT: your previous draft plan has quality gaps. Address every point below, then return an improved archicodePatch that keeps the same planning JSON contract.",
    ...findings.map((finding, index) => `${index + 1}. ${finding}`),
    "Inspect any target files you have not yet read (read_file) and check policy findings (list_violations) before finalizing.",
    "Keep the user-facing plan concrete and project-specific, and return ordered, self-contained implementationTasks with real per-task summaries."
  ].join(" ");
}

function sourceAttributionRetryGuidance(error: string): string {
  return [
    "SOURCE ATTRIBUTION REPAIR: the previous source handoff was rejected before any files were applied.",
    error,
    "Resubmit the same source operations with a non-empty nodeIds array on every file. Use only IDs listed in sourceAttribution.allowedNodes in the run context; include multiple IDs only when the file directly supports multiple nodes. Do not omit attribution."
  ].join(" ");
}

function implementationBatchPromptSummary(run: Run, phase: "coding" | "debugging", batchNumber: number, maxBatches: number): string {
  if (phase === "debugging") return run.promptSummary;
  return [
    run.promptSummary,
    `Implementation batch ${batchNumber}/${maxBatches}.`,
    concreteRunEffort(run) === "fast"
      ? "Fast effort: prefer one cohesive source pass, avoid unnecessary extra planning or verification loops, and keep changes focused."
      : "High effort: use the planned source slices for well-orchestrated long-horizon work, but still avoid unnecessary extra batches for small or low-risk work.",
    "If you cannot edit files directly, return archicodePatch.runSummary.implementationStatus as complete, continue, or blocked. If you can edit directly, return a concise prose summary only."
  ].join(" ");
}

function planningPromptSummaryForRun(run: Run): string {
  if (run.effort === "auto") {
    return [
      run.promptSummary,
      "Implementation effort is auto: during planning choose archicodePatch.runSummary.implementationEffort as \"fast\" for quick, localized, low-risk work or \"high\" for broader, riskier, multi-system, ambiguous, or long-horizon work."
    ].join(" ");
  }
  const effortText = run.effort === "fast"
    ? "Implementation effort is fast: plan the smallest useful number of source tasks, ideally one cohesive implementation pass for small work."
    : "Implementation effort is high: plan clear source tasks with realistic per-task batch budgets for complex or long-horizon work.";
  return [run.promptSummary, effortText].join(" ");
}

function implementationContextForBatch(context: string, implementation: RunImplementationState, batchNumber: number, runMemory?: RunMemoryCard): string {
  const checkpoints = implementation.checkpoints.map((checkpoint) => ({
    batchNumber: checkpoint.batchNumber,
    taskId: checkpoint.taskId,
    phase: checkpoint.phase,
    status: checkpoint.status,
    summary: checkpoint.summary,
    sourceDiffArtifactId: checkpoint.sourceDiffArtifactId,
    verification: checkpoint.verification
  }));
  const task = currentImplementationTask(implementation);
  return [
    context,
    "",
    "## Implementation Loop State",
    JSON.stringify({
      currentBatch: batchNumber,
      maxBatches: implementation.maxBatches,
      currentTask: task,
      tasks: implementation.tasks,
      runMemory,
      priorCheckpoints: checkpoints,
      priorSummary: implementation.summary,
      instruction: "Implement only the current task. If targeted verification failed in the previous checkpoint, repair that task before moving on. If direct file edits are not available, set implementationStatus to complete when the final requested source slice is submitted, continue only when this same task has another concrete source-file slice, or blocked with needsReplan when the plan is insufficient. Do not request another batch merely to wait for application, dependency installation, or verification; ArchiCode owns those steps."
    }, null, 2)
  ].join("\n");
}

function implementationContinuationRequested(phase: "coding" | "debugging", patchProposal: PersistedPatchProposal | null, diffArtifact: Artifact | null): boolean {
  return phase === "coding" && Boolean(diffArtifact) && patchProposal?.implementationStatus === "continue";
}

function implementationCheckpointSummary(patchProposal: PersistedPatchProposal | null, output: string, diffArtifact: Artifact | null): string {
  return [
    patchProposal?.summary || compactSummary(output),
    patchProposal?.implementationNotes,
    patchProposal?.nextSourceSlice ? `Next source slice: ${patchProposal.nextSourceSlice}` : "",
    diffArtifact?.summary ? `Diff: ${diffArtifact.summary}.` : ""
  ].filter(Boolean).join(" ");
}

async function writeImplementationCheckpointArtifact(
  projectRoot: string,
  run: Run,
  batchNumber: number,
  output: string,
  patchProposal: PersistedPatchProposal | null,
  diffArtifact: Artifact | null
): Promise<Artifact> {
  const summary = implementationCheckpointSummary(patchProposal, output, diffArtifact);
  const artifact: Artifact = artifactSchema.parse({
    id: id("artifact"),
    type: "generated-file",
    title: `Implementation batch ${batchNumber} for ${run.id}`,
    path: `.archicode/artifacts/${run.id}-implementation-batch-${batchNumber}.json`,
    nodeId: run.nodeId,
    runId: run.id,
    summary,
    sizeBytes: Buffer.byteLength(output, "utf8"),
    createdAt: iso()
  });
  await writeJson(path.join(projectRoot, artifact.path), {
    ...artifact,
    batchNumber,
    providerOutput: output,
    patchProposalArtifactId: patchProposal?.artifact.id,
    sourceDiffArtifactId: diffArtifact?.id,
    runSummary: {
      implementationStatus: patchProposal?.implementationStatus,
      notes: patchProposal?.implementationNotes,
      nextSourceSlice: patchProposal?.nextSourceSlice,
      needsReplan: patchProposal?.needsReplan,
      replanReason: patchProposal?.replanReason,
      suggestedQuestions: patchProposal?.suggestedQuestions ?? []
    },
    warnings: patchProposal?.warnings ?? [],
    quarantinedOperations: patchProposal?.quarantinedOperations ?? []
  });
  return artifact;
}

async function targetedVerificationCommand(projectRoot: string, bundle: ProjectBundle, task: RunImplementationTask | null): Promise<string | null> {
  const packageJson = await readJson<{ scripts?: Record<string, string> } | null>(path.join(projectRoot, "package.json"), null);
  const scripts = packageJson?.scripts ?? {};
  const hasPnpmLock = await exists(path.join(projectRoot, "pnpm-lock.yaml"));
  const hasYarnLock = await exists(path.join(projectRoot, "yarn.lock"));
  const hasBunLock = await exists(path.join(projectRoot, "bun.lockb"));
  const packageManager = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : hasBunLock ? "bun" : "npm";
  // Whole-project typecheck derived from the build script (e.g. `vue-tsc -b`).
  // The final build type-checks config files (vite.config.ts, project
  // references) that a narrower model-chosen light command can miss, so we run
  // it alongside per batch to catch those errors at their source instead of
  // only at the terminal build. Empty for stacks without a derivable typecheck.
  const buildTypecheckCommand = lightVerificationCommandFromBuildScript(packageManager, scripts.build);

  const withBuildTypecheck = async (command: string): Promise<string> => {
    const normalized = await normalizeVerificationCommandForProject(projectRoot, command);
    if (!buildTypecheckCommand || commandsCoverSameTypecheck(normalized, buildTypecheckCommand)) {
      return prependInstallCommandIfNeeded(projectRoot, normalized);
    }
    const normalizedBuildTypecheck = await normalizeVerificationCommandForProject(projectRoot, buildTypecheckCommand);
    return prependInstallCommandIfNeeded(projectRoot, `${normalizedBuildTypecheck} && ${normalized}`);
  };

  const taskLightCommand = task?.lightVerificationCommand?.trim();
  if (taskLightCommand && isFiniteVerificationCommand(taskLightCommand) && !isBuildVerificationCommand(taskLightCommand)) {
    return withBuildTypecheck(taskLightCommand);
  }
  const taskCommand = task?.verificationCommand?.trim();
  if (taskCommand && isFiniteVerificationCommand(taskCommand) && !isBuildVerificationCommand(taskCommand)) {
    return withBuildTypecheck(taskCommand);
  }
  for (const scriptName of ["test", "typecheck", "check", "lint"] as const) {
    const command = finitePackageVerificationCommand(packageManager, scriptName, scripts[scriptName]);
    if (command) return withBuildTypecheck(command);
  }
  if (buildTypecheckCommand) {
    return prependInstallCommandIfNeeded(projectRoot, await normalizeVerificationCommandForProject(projectRoot, buildTypecheckCommand));
  }
  const commands = await inferProjectCommands(projectRoot, bundle);
  const command = commands.verify.find((item) => isFiniteVerificationCommand(item) && !isBuildVerificationCommand(item));
  return command ? prependInstallCommandIfNeeded(projectRoot, await normalizeVerificationCommandForProject(projectRoot, command)) : null;
}

// True when a command already performs the same whole-project typecheck the
// build-derived command would, so we don't run the type checker twice.
function commandsCoverSameTypecheck(command: string, buildTypecheckCommand: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  const target = normalize(command);
  if (target.includes(normalize(buildTypecheckCommand))) return true;
  // A build-mode typecheck (tsc/vue-tsc -b|--build) already covers project
  // references (app + node configs), so another build-mode check is redundant.
  const buildTool = /\b(vue-tsc|tsc|svelte-check|astro)\b/.exec(buildTypecheckCommand)?.[1];
  return Boolean(buildTool) && new RegExp(`\\b${buildTool}\\b[^&|]*(?:\\s-b\\b|--build\\b)`).test(target);
}

function lightVerificationCommandFromBuildScript(packageManager: string, buildScript: string | undefined): string {
  if (!buildScript) return "";
  const segment = buildScript.split(/\s*(?:&&|\|\||;)\s*/).find((part) => /\b(?:vue-tsc|tsc|svelte-check|astro\s+check)\b/.test(part));
  if (!segment || isRuntimeOrWatchCommand(segment)) return "";
  const [tool, ...args] = segment.trim().split(/\s+/);
  if (!tool) return "";
  if (packageManager === "npm") return `npm exec ${tool}${args.length ? ` -- ${args.join(" ")}` : ""}`;
  if (packageManager === "yarn") return `yarn ${segment}`;
  if (packageManager === "bun") return `bun x ${segment}`;
  return `${packageManager} exec ${segment}`;
}

async function writeImplementationVerificationLogArtifact(
  projectRoot: string,
  run: Run,
  batchNumber: number,
  command: string,
  output: string,
  exitCode: number | null
): Promise<Artifact> {
  const artifact: Artifact = artifactSchema.parse({
    id: id("artifact"),
    type: "log",
    title: `Implementation batch ${batchNumber} verification for ${run.id}`,
    path: `.archicode/artifacts/${run.id}-implementation-batch-${batchNumber}-verification-log.json`,
    nodeId: run.nodeId,
    runId: run.id,
    summary: `Targeted verification ${exitCode === 0 ? "passed" : "failed"}: ${command}`,
    sizeBytes: Buffer.byteLength(output, "utf8"),
    createdAt: iso()
  });
  await writeJson(path.join(projectRoot, artifact.path), {
    ...artifact,
    command,
    exitCode,
    text: output
  });
  return artifact;
}

async function runTargetedImplementationVerification(
  projectRoot: string,
  run: Run,
  batchNumber: number,
  task: RunImplementationTask | null
): Promise<RunImplementationCheckpoint["verification"] | undefined> {
  const bundle = await loadProject(projectRoot);
  const command = await targetedVerificationCommand(projectRoot, bundle, task);
  if (!command) return undefined;
  if (!isFiniteVerificationCommand(command)) return undefined;
  const scope = await evaluateFilesystemScope(projectRoot, bundle.project.settings, command, projectRoot, classifyCommandRisk(command));
  if (!scope.allowed) {
    return {
      command,
      exitCode: null,
      passed: false,
      summary: `Targeted verification skipped by filesystem scope: ${scope.violations.join(" ") || "not allowed"}`
    };
  }

  const beforeVerification = await collectSourceSnapshot(projectRoot);
  const env = buildSubprocessEnv(process.env, { CI: "true" });
  const child = spawn(command, {
    cwd: projectRoot,
    shell: true,
    env,
    detached: process.platform !== "win32"
  });
  activeProcesses.set(run.id, child);
  let output = "";
  const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    output += `[${stream}] ${chunk.toString()}`;
    if (output.length > 60_000) output = output.slice(output.length - 60_000);
  };
  child.stdout.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timeout);
  activeProcesses.delete(run.id);
  const afterVerification = await collectSourceSnapshot(projectRoot);
  await recordVerificationGeneratedArtifacts(projectRoot, run.id, command, beforeVerification, afterVerification).catch(() => undefined);
  if (await runWasCancelled(projectRoot, run.id)) return undefined;
  const text = output.trim() || "(no output)";
  const artifact = await writeImplementationVerificationLogArtifact(projectRoot, run, batchNumber, command, text, exitCode);
  return {
    command,
    exitCode,
    passed: exitCode === 0,
    summary: exitCode === 0
      ? `Targeted verification passed: ${command}`
      : `Targeted verification failed: ${command}`,
    logArtifactId: artifact.id
  };
}

async function implementationMappingsFromDiffArtifact(projectRoot: string, artifact: Artifact, nodeIds: string[]): Promise<ImplementationFileMapping[]> {
  if (!nodeIds.length) return [];
  const value = await readJson<Record<string, unknown> | null>(path.join(projectRoot, artifact.path), null);
  const diff = typeof value?.diff === "string" ? value.diff : "";
  if (!diff) return [];
  const matches = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  return matches.flatMap((match, index) => {
    const filePath = match[2];
    if (
      filePath === ".gitignore" ||
      AGENT_INSTRUCTION_FILE_CANDIDATES.includes(filePath as AgentInstructionFilePath) ||
      /(^|\/)readme(?:\.[^/]+)?$/i.test(filePath) ||
      isGeneratedLockfilePath(filePath)
    ) return [];
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? diff.length;
    const chunk = diff.slice(start, end);
    const action: ImplementationFileMapping["action"] = /^\+\+\+ \/dev\/null$/m.test(chunk) ? "delete" : "replace";
    return nodeIds.map((nodeId) => ({ nodeId, path: filePath, action }));
  });
}

async function changedPathsFromDiffArtifact(projectRoot: string, artifact: Artifact): Promise<string[]> {
  const value = await readJson<Record<string, unknown> | null>(path.join(projectRoot, artifact.path), null);
  const diff = typeof value?.diff === "string" ? value.diff : "";
  if (!diff) return [];
  return [...new Set([...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]).filter(Boolean))];
}

function nodeClaimsChangedPath(node: Flow["nodes"][number], changedPath: string): boolean {
  return node.implementationScope?.claims.some((claim) => {
    const claimPath = claim.path.replace(/^\.\//, "").replace(/\/$/, "");
    const normalizedPath = changedPath.replace(/^\.\//, "");
    return claim.kind === "directory"
      ? normalizedPath === claimPath || normalizedPath.startsWith(`${claimPath}/`)
      : normalizedPath === claimPath;
  }) ?? false;
}

function fallbackRunNodeIdsForFlow(run: Run, flow: Flow): string[] {
  if (run.scope?.kind === "no-scope") return [];
  if (run.affectedNodeIds.length) return run.affectedNodeIds.filter((nodeId) => flow.nodes.some((node) => node.id === nodeId));
  if (run.nodeId && flow.nodes.some((node) => node.id === run.nodeId)) return [run.nodeId];
  if (run.scope?.kind === "nodes") return run.scope.nodeIds.filter((nodeId) => flow.nodes.some((node) => node.id === nodeId));
  if (run.scope?.kind === "flow") return run.scope.flowId === flow.id ? workingNodesForFlow(flow).map((node) => node.id) : [];
  if (run.scope?.kind === "project") return workingNodesForFlow(flow).map((node) => node.id);
  return flow.id === run.flowId ? workingNodesForFlow(flow).map((node) => node.id) : [];
}

export async function markRunNodesWithDiff(
  projectRoot: string,
  run: Run,
  artifact: Artifact,
  options: { inferImplementationScopeFromDiff?: boolean } = {}
): Promise<void> {
  let effectiveRun = await readRun(projectRoot, run.id).catch(() => run);
  const initiallyScopedNodeIds = effectiveRun.scope?.kind === "nodes"
    ? effectiveRun.scope.nodeIds
    : effectiveRun.nodeId
      ? [effectiveRun.nodeId]
      : [];
  if (options.inferImplementationScopeFromDiff) {
    await persistImplementationFileMappings(
      projectRoot,
      effectiveRun.id,
      initiallyScopedNodeIds.length
        ? await implementationMappingsFromDiffArtifact(projectRoot, artifact, initiallyScopedNodeIds)
        : []
    );
  }

  const bundle = await loadProject(projectRoot);
  effectiveRun = bundle.runs.find((item) => item.id === run.id) ?? effectiveRun;
  const changedPaths = await changedPathsFromDiffArtifact(projectRoot, artifact);
  const targetFlows = effectiveRun.scope?.kind === "project"
    ? bundle.flows.filter((flow) => !flow.ignored)
    : bundle.flows.filter((flow) => flow.id === effectiveRun.flowId);
  const coveredNodeIds: string[] = [];
  for (const flow of targetFlows) {
    const claimedNodeIds = flow.nodes
      .filter((node) => !node.ignored && changedPaths.some((changedPath) => nodeClaimsChangedPath(node, changedPath)))
      .map((node) => node.id);
    const runMappedNodeIds = flow.nodes
      .filter((node) => node.implementationScope?.updatedByRunId === effectiveRun.id)
      .map((node) => node.id);
    const nodeIds = new Set([
      ...claimedNodeIds,
      ...runMappedNodeIds,
      ...(!claimedNodeIds.length && !runMappedNodeIds.length ? fallbackRunNodeIdsForFlow(effectiveRun, flow) : [])
    ]);
    if (!nodeIds.size) continue;
    coveredNodeIds.push(...nodeIds);
    const nodes = flow.nodes.map((node) => {
      if (!nodeIds.has(node.id)) return node;
      const flags = new Set(node.flags);
      flags.add("has-diff");
      flags.add("modified-not-built");
      const stage = isProductionApproved(node)
        ? node.stage
        : ["planned", "plan-approved", "working", "draft-rejected"].includes(node.stage)
          ? "draft"
          : node.stage;
      return {
        ...node,
        stage,
        flags: [...flags],
        attachments: node.attachments.some((item) => item.id === artifact.id) ? node.attachments : [...node.attachments, artifact],
        updatedAt: iso()
      };
    });
    await writeJson(projectStatePath(projectRoot, "flows", `${flow.id}.json`), flowSchema.parse({ ...flow, nodes, updatedAt: iso() }));
  }
  if (coveredNodeIds.length) {
    const latest = await readRun(projectRoot, effectiveRun.id).catch(() => effectiveRun);
    await writeRun(projectRoot, runSchema.parse({
      ...latest,
      affectedNodeIds: uniqueIds([...latest.affectedNodeIds, ...coveredNodeIds])
    }));
  }
}

type RuntimeSetupPlan = {
  command: string;
  cwd: string;
  relativeCwd: string;
  profileLabel: string;
};

async function runtimeSetupPlansForBuild(projectRoot: string, settings: ProjectSettings): Promise<RuntimeSetupPlan[]> {
  const seen = new Set<string>();
  const plans: RuntimeSetupPlan[] = [];
  for (const profile of settings.runTargetProfiles) {
    const command = profile.setupCommand?.trim();
    if (!command) continue;
    const cwdInfo = await resolveProfileCwd(projectRoot, profile.cwd);
    const key = `${normalizeForCompare(cwdInfo.cwd)}\0${command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    plans.push({
      command,
      cwd: cwdInfo.cwd,
      relativeCwd: cwdInfo.relativeCwd,
      profileLabel: profile.label
    });
  }
  return plans;
}

async function applyBuildSetupCommands(projectRoot: string, run: Run, settings: ProjectSettings): Promise<Run | null> {
  const plans = await runtimeSetupPlansForBuild(projectRoot, settings);
  if (!plans.length) return run;
  const env = {
    ...process.env,
    ...Object.fromEntries(run.env.map((item) => [item.name, item.value ?? ""]))
  };
  let current = run;
  for (const plan of plans) {
    const risk = classifyCommandRisk(plan.command);
    const scope = await evaluateFilesystemScope(projectRoot, settings, plan.command, plan.cwd, risk);
    if (!scope.allowed) {
      const failed = runSchema.parse({
        ...current,
        status: "failed",
        phase: "complete",
        filesystemScope: {
          policy: scope.policy,
          cwd: scope.cwd,
          allowedRoots: scope.allowedRoots,
          violations: scope.violations
        },
        permission: {
          decision: "denied",
          reason: `Setup command filesystem scope denied: ${scope.violations.join(" ")}`
        },
        todos: current.todos.map((todo) => ({ ...todo, status: "blocked" })),
        logs: [
          ...current.logs,
          { at: iso(), stream: "system", text: `Blocked setup command for ${plan.profileLabel}: ${scope.violations.join(" ")}` }
        ],
        runInstructions: `Blocked setup command for ${plan.profileLabel}: ${scope.violations.join(" ")}`,
        completedAt: iso()
      });
      await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, failed, failed.runInstructions ?? "Setup command blocked."));
      return null;
    }

    const logs: Run["logs"] = [
      { at: iso(), stream: "system", text: `Running setup command before build for ${plan.profileLabel} (${plan.relativeCwd || "."}): ${plan.command}` }
    ];
    const exitCode = await runManagedPreflightCommand(
      plan.command,
      plan.cwd,
      (stream, text) => logs.push({ at: iso(), stream, text }),
      env
    );
    logs.push({ at: iso(), stream: exitCode === 0 ? "system" : "stderr", text: `Setup command exited with code ${exitCode ?? "unknown"}.` });
    current = runSchema.parse({
      ...current,
      logs: [...current.logs, ...logs]
    });
    await writeRun(projectRoot, current);
    if (exitCode !== 0) {
      const failed = runSchema.parse({
        ...current,
        status: "failed",
        phase: "complete",
        todos: current.todos.map((todo) => ({ ...todo, status: "blocked" })),
        runInstructions: `Setup command failed before build: \`${plan.command}\`. Open the run log, fix setup output, then retry Build.`,
        completedAt: iso()
      });
      await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, failed, failed.runInstructions ?? "Setup command failed."));
      return null;
    }
  }
  return current;
}

async function executeProfileStep(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ exitCode: number | null; output: string; logs: Run["logs"]; timedOut: boolean }> {
  const logs: Run["logs"] = [];
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      logs.push({ at: iso(), stream: "stderr", text: `Step timed out: ${command}` });
      resolve({ exitCode: null, output, logs, timedOut: true });
    }, timeoutMs);
    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      logs.push({ at: iso(), stream, text });
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logs.push({ at: iso(), stream: "stderr", text: error.message });
      resolve({ exitCode: null, output, logs, timedOut: false });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, output, logs, timedOut: false });
    });
  });
}

async function failRunProfile(projectRoot: string, run: Run, logs: Run["logs"], instructions: string): Promise<void> {
  const logArtifact = await persistRunLogArtifact(projectRoot, runSchema.parse({ ...run, logs: [...run.logs, ...logs] }));
  const failed = runSchema.parse({
    ...run,
    status: "failed",
    phase: "complete",
    todos: run.todos.map((todo) => ({ ...todo, status: "blocked" })),
    logs: [
      ...run.logs,
      ...logs,
      { at: iso(), stream: "system", text: `Log artifact: ${logArtifact.path}` }
    ],
    runInstructions: instructions,
    completedAt: iso()
  });
  await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, failed, instructions));
}

async function waitForRunProfileTarget(
  projectRoot: string,
  runId: string,
  profile: ProjectSettings["runTargetProfiles"][number],
  targetId: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ ready: boolean; current: Run; runTargetId?: string }> {
  if (!profile.waitCommand) {
    return { ready: true, current: await readRun(projectRoot, runId), runTargetId: targetId };
  }

  const waitCommand = fillRunProfilePlaceholders(profile.waitCommand, targetId);
  const readyPattern = compileRunProfilePattern(profile.readyPattern, targetId);
  const notReadyPattern = compileRunProfilePattern(profile.notReadyPattern, targetId);
  const deadline = Date.now() + profile.timeoutSeconds * 1000;
  let ready = false;
  let runTargetId: string | undefined;
  let current = await appendRunLogEntries(projectRoot, runId, [
    { at: iso(), stream: "system", text: `Waiting for run target: ${waitCommand}` }
  ]);

  while (Date.now() < deadline && !ready) {
    const waited = await executeProfileStep(waitCommand, cwd, env, 10000);
    current = await appendRunLogEntries(projectRoot, runId, waited.logs);
    const outputReady = waited.exitCode === 0 &&
      (!notReadyPattern || !notReadyPattern.test(waited.output)) &&
      (!readyPattern || readyPattern.test(waited.output));
    if (outputReady) {
      runTargetId = extractReadyTargetId(waited.output, profile.readyTargetPattern, targetId) ?? targetId;
      ready = true;
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (ready) {
    current = await appendRunLogEntries(projectRoot, runId, [
      { at: iso(), stream: "system", text: runTargetId ? `Run target is ready: ${runTargetId}` : "Run target is ready." }
    ]);
  }

  return { ready, current, runTargetId };
}

async function runProfileDiagnostics(
  projectRoot: string,
  runId: string,
  commands: string[],
  targetId: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string
): Promise<Run> {
  let current = await appendRunLogEntries(projectRoot, runId, [
    { at: iso(), stream: "system", text: label }
  ]);
  for (const template of commands) {
    const command = fillRunProfilePlaceholders(template, targetId);
    current = await appendRunLogEntries(projectRoot, runId, [
      { at: iso(), stream: "system", text: `Run target check: ${command}` }
    ]);
    const result = await executeProfileStep(command, cwd, env, 20000);
    current = await appendRunLogEntries(projectRoot, runId, [
      ...result.logs,
      { at: iso(), stream: result.exitCode === 0 ? "system" : "stderr", text: `Run target check exited with code ${result.exitCode ?? "unknown"}.` }
    ]);
  }
  return current;
}

async function executeRunProfile(projectRoot: string, run: Run): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const profile = bundle.project.settings.runTargetProfiles.find((item) => item.id === run.runProfileId);
  if (!profile) {
    await failRunProfile(projectRoot, run, [{ at: iso(), stream: "stderr", text: `Run profile ${run.runProfileId ?? "unknown"} was not found.` }], "Run profile is missing from project settings.");
    return;
  }

  const env = {
    ...process.env,
    ...Object.fromEntries(run.env.map((item) => [item.name, item.value ?? ""]))
  };
  const cwd = run.cwd || projectRoot;
  let current = await appendRunLogEntries(projectRoot, run.id, [
    { at: iso(), stream: "system", text: `Run profile started: ${profile.label}` }
  ]);
  let targetId = run.runTargetId ?? profile.defaultTargetId;
  let runTargetId: string | undefined;

  if (profile.discoverCommand) {
    const discoverCommand = fillRunProfilePlaceholders(profile.discoverCommand, targetId);
    current = await appendRunLogEntries(projectRoot, run.id, [
      { at: iso(), stream: "system", text: `Discovering run targets: ${discoverCommand}` }
    ]);
    const discovered = await executeProfileStep(discoverCommand, cwd, env, 20000);
    current = await appendRunLogEntries(projectRoot, run.id, [
      ...discovered.logs,
      { at: iso(), stream: "system", text: `Target discovery exited with code ${discovered.exitCode ?? "unknown"}.` }
    ]);
    if (discovered.exitCode !== 0) {
      await failRunProfile(projectRoot, current, [], `Run target discovery failed for profile "${profile.label}".`);
      return;
    }
    const targets = parseRunTargets(discovered.output, profile.targetPattern);
    const selected = chooseRunTarget(targets, run.runTargetId, profile.defaultTargetId, profile.targetPreferencePattern);
    targetId = selected?.id ?? targetId;
    if (selected) {
      current = await appendRunLogEntries(projectRoot, run.id, [
        { at: iso(), stream: "system", text: `Selected run target: ${selected.label} (${selected.id})` }
      ]);
    }
    if (profile.targetRequired && !targetId) {
      await failRunProfile(projectRoot, current, [], `Run blocked: profile "${profile.label}" did not discover a usable target.`);
      return;
    }
  }

  if (profile.launchCommand) {
    const launchCommand = fillRunProfilePlaceholders(profile.launchCommand, targetId, runTargetId);
    current = await appendRunLogEntries(projectRoot, run.id, [
      { at: iso(), stream: "system", text: `Launching run target: ${launchCommand}` }
    ]);
    const launched = await executeProfileStep(launchCommand, cwd, env, 30000);
    current = await appendRunLogEntries(projectRoot, run.id, [
      ...launched.logs,
      { at: iso(), stream: "system", text: `Target launch exited with code ${launched.exitCode ?? "unknown"}.` }
    ]);
    if (launched.exitCode !== 0) {
      await failRunProfile(projectRoot, current, [], `Run blocked: target launch failed for profile "${profile.label}".`);
      return;
    }
  }

  if (profile.waitCommand) {
    const waited = await waitForRunProfileTarget(projectRoot, run.id, profile, targetId, cwd, env);
    current = waited.current;
    let ready = waited.ready;
    runTargetId = waited.runTargetId ?? runTargetId;
    if (!ready) {
      if (profile.diagnosticCommands.length) {
        current = await runProfileDiagnostics(projectRoot, run.id, profile.diagnosticCommands, targetId, cwd, env, "Run target was not ready. Collecting diagnostics.");
      }
      if (profile.recoveryCommands.length) {
        current = await runProfileDiagnostics(projectRoot, run.id, profile.recoveryCommands, targetId, cwd, env, "Attempting run target recovery.");
      }
      if (profile.retryAfterRecovery && (profile.diagnosticCommands.length || profile.recoveryCommands.length)) {
        const retry = await waitForRunProfileTarget(projectRoot, run.id, profile, targetId, cwd, env);
        current = retry.current;
        ready = retry.ready;
        runTargetId = retry.runTargetId ?? runTargetId;
      }
      if (!ready) {
        if (profile.diagnosticCommands.length) {
          current = await runProfileDiagnostics(projectRoot, run.id, profile.diagnosticCommands, targetId, cwd, env, "Final run target diagnostics after recovery failed.");
        }
        await failRunProfile(projectRoot, current, [], `Run blocked: target was not ready after diagnostics and recovery for profile "${profile.label}".`);
        return;
      }
    }
  }

  const command = fillRunProfilePlaceholders(profile.runCommand, targetId, runTargetId);
  current = runSchema.parse({
    ...await readRun(projectRoot, run.id),
    command,
    runTargetId: runTargetId ?? targetId,
    status: "running",
    phase: "coding",
    todos: current.todos.map((todo) => todo.status === "done" ? todo : { ...todo, status: "doing" }),
    logs: [...(await readRun(projectRoot, run.id)).logs, { at: iso(), stream: "system", text: `Starting app: ${command}` }]
  });
  await writeRun(projectRoot, current);

  const child = spawn(command, {
    cwd,
    shell: true,
    env
  });
  activeProcesses.set(run.id, child);

  const append = async (stream: "stdout" | "stderr", text: string): Promise<void> => {
    await appendRunLogEntries(projectRoot, run.id, [{ at: iso(), stream, text }]);
  };
  child.stdout.on("data", (chunk: Buffer) => void append("stdout", chunk.toString()).catch(() => undefined));
  child.stderr.on("data", (chunk: Buffer) => void append("stderr", chunk.toString()).catch(() => undefined));

  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  activeProcesses.delete(run.id);
  await flushRunLogAppends(run.id);
  const latest = await readRun(projectRoot, run.id);
  if (latest.status === "cancelled") return;

  const completedLogs: Run["logs"] = [
    ...latest.logs,
    { at: iso(), stream: "system", text: `Run app command exited with code ${exitCode ?? "unknown"}.` }
  ];
  const status: Run["status"] = exitCode === 0 ? "succeeded" : "failed";
  const instructions = exitCode === 0
    ? `Run App completed with profile "${profile.label}".`
    : `Run App failed with profile "${profile.label}". Open the run log and check runtime/device output.`;
  const logArtifact = await persistRunLogArtifact(projectRoot, runSchema.parse({ ...latest, logs: completedLogs }));
  const completed = runSchema.parse({
    ...latest,
    status,
    phase: "complete",
    todos: latest.todos.map((todo) => ({ ...todo, status: status === "succeeded" ? "done" : "blocked" })),
    logs: [...completedLogs, { at: iso(), stream: "system", text: `Log artifact: ${logArtifact.path}` }],
    runInstructions: instructions,
    completedAt: iso()
  });
  await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, completed, instructions));
}

type StartAgentRunInput = {
  projectRoot: string;
  flowId: string;
  nodeId?: string;
  providerId: string;
  purpose?: Run["purpose"];
  effort?: RunEffort;
  promptSummary: string;
  command?: string;
  cwd?: string;
  env?: { name: string; value?: string }[];
  allowShell?: boolean;
  reusableApproval?: boolean;
  retryOf?: string;
  guidance?: Partial<RunGuidance>;
  scope?: RunScope;
};

async function prepareStartedAgentRun(input: StartAgentRunInput, runId: string): Promise<void> {
  let run = await readRun(input.projectRoot, runId).catch(() => null);
  if (!run || run.status === "cancelled") return;
  const bundle = await loadProject(input.projectRoot);
  const provider = bundle.project.settings.providers.find((item) => item.id === input.providerId);
  if (!provider) {
    await writeRun(input.projectRoot, runSchema.parse({
      ...run,
      status: "failed",
      phase: "complete",
      todos: run.todos.map((todo) => ({ ...todo, status: todo.status === "done" ? "done" : "blocked" })),
      logs: [...run.logs, { at: iso(), stream: "stderr", text: `Provider ${input.providerId} was not found. Choose a configured provider before running.` }],
      runInstructions: `Provider ${input.providerId} was not found. Choose a configured provider before running.`,
      completedAt: iso()
    }));
    return;
  }

  try {
    const command = input.command?.trim();
    const cwd = input.cwd?.trim() || input.projectRoot;
    const risk = command ? classifyCommandRisk(command) : "low";
    const scope = command ? await evaluateFilesystemScope(input.projectRoot, bundle.project.settings, command, cwd, risk) : null;
    const reusablePolicy = command ? commandAllowedBySettings(bundle.project.settings, command, cwd) : null;
    const scopeDenied = Boolean(scope && !scope.allowed);
    const needsPermission = Boolean(command && !scopeDenied && !reusablePolicy && !input.allowShell && !commandsAutoApproved(bundle.project.settings, risk, command));
    const guidance = normalizeGuidance(input.guidance);
    const runScope = input.scope ? runScopeSchema.parse(input.scope) : undefined;
    const noScope = runScope?.kind === "no-scope" && !command;
    const context = await buildContext(input.projectRoot, input.flowId, input.nodeId, noScope ? undefined : input.providerId, input.scope);
    const plannedCommands = [
      ...new Set([
        ...(command ? [command] : []),
        ...(providerCommand(provider) ? [providerCommand(provider) as string] : []),
        ...(bundle.project.settings.defaultBuildCommand.trim() ? [bundle.project.settings.defaultBuildCommand.trim()] : [])
      ])
    ];
    const plannedAllowedRoots = [input.projectRoot, ...bundle.project.settings.filesystem.allowedRoots];
    const planArtifact = await writeRunPlanArtifact(input.projectRoot, {
      runId,
      flowId: input.flowId,
      nodeId: input.nodeId,
      promptSummary: input.promptSummary,
      providerId: input.providerId,
      plannedCommands,
      plannedAllowedRoots,
      scope
    });
    const reusablePolicyId = reusablePolicy?.id ?? (input.reusableApproval && command ? id("policy") : undefined);
    run = await readRun(input.projectRoot, runId).catch(() => run);
    if (!run || run.status === "cancelled") return;
    const preparedRun = runSchema.parse({
      ...run,
      status: scopeDenied ? "failed" : needsPermission ? "needs-permission" : command ? "queued" : noScope ? "coding" : "planning",
      phase: scopeDenied ? "complete" : command || noScope ? "coding" : "planning",
      command,
      cwd,
      risk,
      filesystemScope: scope ? {
        policy: scope.policy,
        cwd: scope.cwd,
        allowedRoots: scope.allowedRoots,
        violations: scope.violations
      } : undefined,
      permission: {
        decision: command ? (scopeDenied ? "denied" : needsPermission ? "pending" : "allowed") : "allowed",
        reusablePolicyId,
        reason: command
          ? scopeDenied
            ? `Filesystem scope denied: ${scope?.violations.join(" ")}`
            : needsPermission
              ? `Command risk is ${risk}; approval is required.`
              : reusablePolicy
                ? `Allowed by reusable policy ${reusablePolicy.id}.`
                : "Allowed for this run."
          : noScope
            ? "No-scope run is allowed to start directly in coding."
            : "No shell command requested."
      },
      contextSummary: context.summary,
      contextArtifacts: [...context.artifacts.map((artifact) => artifact.id), planArtifact.id],
      planArtifactIds: [planArtifact.id],
      implementation: noScope ? noScopeImplementationState(run) : run.implementation,
      runMemory: runMemoryFromRun(runSchema.parse({
        ...run,
        contextSummary: context.summary,
        contextArtifacts: [...context.artifacts.map((artifact) => artifact.id), planArtifact.id],
        planArtifactIds: [planArtifact.id],
        implementation: noScope ? noScopeImplementationState(run) : run.implementation
      }), {
        phaseNote: "Run context prepared and plan artifact created.",
        artifactIds: [...context.artifacts.map((artifact) => artifact.id), planArtifact.id],
        nextStep: command ? `Execute ${command}` : noScope ? "Start coding from no-scope source edit." : "Start planning phase."
      }),
      plannedCommands,
      plannedAllowedRoots,
      todos: [
        { id: id("todo"), text: "Collect relevant JSON project context", status: "done" },
        { id: id("todo"), text: "Create mandatory run plan", status: "done" },
        { id: id("todo"), text: command ? `Execute ${command}` : noScope ? "Apply no-scope source edit" : "Planning phase before coding", kind: command || noScope ? undefined : "planning-phase" as const, status: needsPermission || scopeDenied ? "blocked" : "doing" },
        ...(noScope || command ? [] : [{ id: id("todo"), text: "Coding phase only after planning is complete", kind: "coding-phase" as const, status: "todo" as const }])
      ],
      logs: [
        ...run.logs,
        { at: iso(), stream: "system", text: `Prepared ${noScope ? "lightweight no-scope " : ""}context (${context.text.length} characters).` },
        { at: iso(), stream: "system", text: `Plan artifact: ${planArtifact.path}` },
        {
          at: iso(),
          stream: scopeDenied ? "stderr" : "system",
          text: scopeDenied
            ? `Blocked by filesystem scope: ${scope?.violations.join(" ")}`
            : needsPermission
              ? "Waiting for shell permission."
              : noScope
                ? "No-scope run prepared; coding will start directly."
                : "Queued."
        }
      ],
      runInstructions: scopeDenied
        ? `Run blocked by filesystem scope: ${scope?.violations.join(" ")}`
        : needsPermission
          ? "Approve the command to start this run."
          : noScope
            ? "No-scope implementation is ready to start."
            : undefined,
      completedAt: scopeDenied ? iso() : undefined
    });
    await writeRun(input.projectRoot, scopeDenied ? await finalizeTerminalRun(input.projectRoot, preparedRun, preparedRun.runInstructions ?? "Run blocked.") : preparedRun);

    if (input.reusableApproval && command && reusablePolicyId && !reusablePolicy) {
      await addReusableShellPolicy(input.projectRoot, {
        id: reusablePolicyId,
        command,
        cwd,
        env: input.env ?? [],
        risk,
        filesystemPolicy: bundle.project.settings.filesystem.policy,
        allowedRoots: bundle.project.settings.filesystem.allowedRoots,
        reusable: true,
        createdAt: iso()
      });
    }

    if (!needsPermission && !scopeDenied) {
      const guidanceText = await guidanceEvidenceText(input.projectRoot, preparedRun, guidance);
      const webContext = await harnessWebContext(bundle.project.settings.webSearch.enabled, input.promptSummary, guidance?.text);
      queuedContextTextByRun.set(preparedRun.id, [
        context.text,
        guidanceText ? `## ${guidanceContextHeading(guidance, "Run Guidance")}\n\n${guidanceText}` : "",
        webContext
      ].filter(Boolean).join("\n\n"));
      void scheduleNextQueuedJob(input.projectRoot);
    }
  } catch (error) {
    const latest = await readRun(input.projectRoot, runId).catch(() => run);
    if (!latest || latest.status === "cancelled") return;
    const message = error instanceof Error ? error.message : String(error);
    const failed = runSchema.parse({
      ...latest,
      status: "failed",
      phase: "complete",
      todos: latest.todos.map((todo) => ({ ...todo, status: todo.status === "done" ? "done" : "blocked" })),
      logs: [...latest.logs, { at: iso(), stream: "stderr", text: message }],
      runInstructions: `Preparing run context failed: ${compactSummary(message)}`,
      completedAt: iso()
    });
    await writeRun(input.projectRoot, await finalizeTerminalRun(input.projectRoot, failed, failed.runInstructions ?? "Preparing run context failed."));
  }
}

export async function startAgentRun(input: StartAgentRunInput): Promise<{ bundle: ProjectBundle; runId: string }> {
  return withRunCreationLock(input.projectRoot, () => startAgentRunUnlocked(input));
}

async function startAgentRunUnlocked(input: StartAgentRunInput): Promise<{ bundle: ProjectBundle; runId: string }> {
  const bundle = await loadProject(input.projectRoot);
  assertNoActiveRunLane(bundle, "starting another run");
  const provider = bundle.project.settings.providers.find((item) => item.id === input.providerId);
  if (!provider) {
    throw new Error(`Provider ${input.providerId} was not found. Choose a configured provider before running.`);
  }
  const command = input.command?.trim();
  const cwd = input.cwd?.trim() || input.projectRoot;
  const risk = command ? classifyCommandRisk(command) : "low";
  const scope = command ? await evaluateFilesystemScope(input.projectRoot, bundle.project.settings, command, cwd, risk) : null;
  const reusablePolicy = command ? commandAllowedBySettings(bundle.project.settings, command, cwd) : null;
  const scopeDenied = Boolean(scope && !scope.allowed);
  const needsPermission = Boolean(command && !scopeDenied && !reusablePolicy && !input.allowShell && !commandsAutoApproved(bundle.project.settings, risk, command));
  const guidance = normalizeGuidance(input.guidance);
  const runScope = input.scope ? runScopeSchema.parse(input.scope) : undefined;
  const runId = id("run");
  const plannedCommands = [
    ...new Set([
      ...(command ? [command] : []),
      ...(providerCommand(provider) ? [providerCommand(provider) as string] : []),
      ...(bundle.project.settings.defaultBuildCommand.trim() ? [bundle.project.settings.defaultBuildCommand.trim()] : [])
    ])
  ];
  const plannedAllowedRoots = [input.projectRoot, ...bundle.project.settings.filesystem.allowedRoots];
  const reusablePolicyId = reusablePolicy?.id ?? (input.reusableApproval && command ? id("policy") : undefined);

  const run: Run = runSchema.parse({
    id: runId,
    flowId: input.flowId,
    nodeId: input.nodeId,
    providerId: input.providerId,
    status: scopeDenied ? "failed" : needsPermission ? "needs-permission" : "preparing",
    phase: scopeDenied ? "complete" : needsPermission ? "coding" : "planning",
    purpose: input.purpose ?? "implement",
    effort: input.effort ?? "high",
    promptSummary: input.promptSummary,
    command,
    cwd,
    env: input.env ?? [],
    risk,
    filesystemScope: scope ? {
      policy: scope.policy,
      cwd: scope.cwd,
      allowedRoots: scope.allowedRoots,
      violations: scope.violations
    } : undefined,
    webSearch: {
      decision: bundle.project.settings.webSearch.enabled ? "allowed" : "denied",
      reason: bundle.project.settings.webSearch.enabled
        ? "Web search is enabled in project settings for this run."
        : "Web search is disabled in project settings."
    },
    retryOf: input.retryOf,
    guidance,
    scope: runScope,
    permission: {
      decision: command ? (scopeDenied ? "denied" : needsPermission ? "pending" : "allowed") : "allowed",
      reusablePolicyId,
      reason: command
        ? scopeDenied
          ? `Filesystem scope denied: ${scope?.violations.join(" ")}`
          : needsPermission
          ? `Command risk is ${risk}; approval is required.`
          : reusablePolicy
            ? `Allowed by reusable policy ${reusablePolicy.id}.`
            : "Allowed for this run."
        : "No shell command requested."
    },
    contextArtifacts: [],
    planArtifactIds: [],
    policyBaselineViolationIds: architecturePolicyBaselineViolationIds(bundle),
    affectedNodeIds: runScope?.kind === "no-scope" ? [] : runScope?.kind === "nodes" && runScope.nodeIds.length ? runScope.nodeIds : input.nodeId ? [input.nodeId] : [],
    plannedCommands,
    plannedAllowedRoots,
    todos: [
      { id: id("todo"), text: "Prepare run context", status: scopeDenied || needsPermission ? "blocked" : "doing" },
      { id: id("todo"), text: command ? `Execute ${command}` : runScope?.kind === "no-scope" ? "Apply no-scope source edit" : "Planning phase before coding", kind: command || runScope?.kind === "no-scope" ? undefined : "planning-phase" as const, status: scopeDenied || needsPermission ? "blocked" : "todo" },
      ...(command || runScope?.kind === "no-scope" ? [] : [{ id: id("todo"), text: "Coding phase only after planning is complete", kind: "coding-phase" as const, status: "todo" as const }])
    ],
    logs: [
      { at: iso(), stream: "system", text: scopeDenied ? "Run blocked before context preparation." : needsPermission ? "Waiting for shell permission. Context will be prepared before execution." : `Preparing run context and plan artifact... ${gaiaAgent.title} owns this implementation run.` },
      ...(guidance?.text || guidance?.evidence.length ? [{ at: iso(), stream: "system" as const, text: guidanceAttachedLog(guidance, "run") }] : []),
      ...(scopeDenied ? [{ at: iso(), stream: "stderr" as const, text: `Blocked by filesystem scope: ${scope?.violations.join(" ")}` }] : [])
    ],
    runInstructions: scopeDenied
      ? `Run blocked by filesystem scope: ${scope?.violations.join(" ")}`
      : needsPermission
        ? "Approve the command to start this run."
        : "Preparing context before this run starts.",
    completedAt: scopeDenied ? iso() : undefined,
    createdAt: iso()
  });

  await writeRun(input.projectRoot, scopeDenied ? await finalizeTerminalRun(input.projectRoot, run, run.runInstructions ?? "Run blocked.") : run);
  if (!scopeDenied && !needsPermission) void prepareStartedAgentRun(input, run.id);

  return { bundle: await loadProject(input.projectRoot), runId: run.id };
}

export async function startRunProfile(input: {
  projectRoot: string;
  flowId: string;
  providerId: string;
  profileId: string;
  targetId?: string;
  allowShell?: boolean;
  reusableApproval?: boolean;
}): Promise<{ bundle: ProjectBundle; runId: string }> {
  return withRunCreationLock(input.projectRoot, () => startRunProfileUnlocked(input));
}

async function startRunProfileUnlocked(input: {
  projectRoot: string;
  flowId: string;
  providerId: string;
  profileId: string;
  targetId?: string;
  allowShell?: boolean;
  reusableApproval?: boolean;
}): Promise<{ bundle: ProjectBundle; runId: string }> {
  const bundle = await loadProject(input.projectRoot);
  assertNoActiveRunLane(bundle, "starting another run profile");
  const provider = bundle.project.settings.providers.find((item) => item.id === input.providerId);
  const profile = bundle.project.settings.runTargetProfiles.find((item) => item.id === input.profileId);
  if (!provider) {
    throw new Error(`Provider ${input.providerId} was not found. Choose a configured provider before running.`);
  }
  if (!profile) {
    throw new Error(`Run target ${input.profileId} was not found. Configure run targets in Settings.`);
  }

  const commands = runProfileLaunchCommands(profile);
  const cwdInfo = await resolveProfileCwd(input.projectRoot, profile.cwd);
  const reusablePolicy = commandAllowedBySettings(bundle.project.settings, profile.runCommand, cwdInfo.cwd);
  const risk = profileRisk(profile);
  const needsPermission = Boolean(!reusablePolicy && !input.allowShell && !commandsAutoApproved(bundle.project.settings, risk ?? "low", profile.runCommand));
  const primaryCommand = profile.runCommand;
  const scope = await evaluateFilesystemScope(input.projectRoot, bundle.project.settings, primaryCommand, cwdInfo.cwd, risk ?? "low");
  const scopeDenied = !scope.allowed;
  const context = await buildContext(input.projectRoot, input.flowId, undefined, input.providerId);
  const runId = id("run");
  const planArtifact = await writeRunPlanArtifact(input.projectRoot, {
    runId,
    flowId: input.flowId,
    promptSummary: `Run app profile: ${profile.label}`,
    providerId: input.providerId,
    plannedCommands: commands,
    plannedAllowedRoots: [input.projectRoot, ...bundle.project.settings.filesystem.allowedRoots],
    scope
  });
  const reusablePolicyId = input.reusableApproval ? id("policy") : undefined;

  const run = runSchema.parse({
    id: runId,
    flowId: input.flowId,
    providerId: input.providerId,
    status: scopeDenied ? "failed" : needsPermission ? "needs-permission" : "queued",
    phase: scopeDenied ? "complete" : "coding",
    promptSummary: `Run app profile: ${profile.label}`,
    command: profile.runCommand,
    runProfileId: profile.id,
    runTargetId: input.targetId,
    cwd: cwdInfo.cwd,
    risk,
    filesystemScope: {
      policy: scope.policy,
      cwd: scope.cwd,
      allowedRoots: scope.allowedRoots,
      violations: scope.violations
    },
    permission: {
      decision: scopeDenied ? "denied" : needsPermission ? "pending" : "allowed",
      reusablePolicyId,
      reason: scopeDenied
        ? `Filesystem scope denied: ${scope.violations.join(" ")}`
        : needsPermission
          ? `Run profile "${profile.label}" needs approval before it can launch targets or run app commands.`
          : reusablePolicy
            ? `Allowed by reusable policy ${reusablePolicy.id}.`
            : "Allowed for this run profile."
    },
    contextSummary: context.summary,
    contextArtifacts: [...context.artifacts.map((artifact) => artifact.id), planArtifact.id],
    planArtifactIds: [planArtifact.id],
    affectedNodeIds: [],
    plannedCommands: commands,
    plannedAllowedRoots: [cwdInfo.cwd, input.projectRoot, ...bundle.project.settings.filesystem.allowedRoots],
    todos: [
      { id: id("todo"), text: "Collect relevant JSON project context", status: "done" },
      { id: id("todo"), text: "Create run profile plan", status: "done" },
      { id: id("todo"), text: `Run ${profile.label}`, status: needsPermission || scopeDenied ? "blocked" : "doing" }
    ],
    logs: [
      { at: iso(), stream: "system", text: `Prepared context (${context.text.length} characters).` },
      { at: iso(), stream: "system", text: `Plan artifact: ${planArtifact.path}` },
      { at: iso(), stream: "system", text: scopeDenied ? `Blocked by filesystem scope: ${scope.violations.join(" ")}` : needsPermission ? "Waiting for run profile approval." : "Queued." }
    ],
    createdAt: iso()
  });

  await writeRun(input.projectRoot, scopeDenied ? await finalizeTerminalRun(input.projectRoot, run, run.permission.reason ?? "Run profile blocked.") : run);
  if (input.reusableApproval && reusablePolicyId && !reusablePolicy) {
    await addReusableShellPolicy(input.projectRoot, {
      id: reusablePolicyId,
      command: profile.runCommand,
      cwd: cwdInfo.cwd,
      env: [],
      risk: risk ?? "low",
      filesystemPolicy: bundle.project.settings.filesystem.policy,
      allowedRoots: bundle.project.settings.filesystem.allowedRoots,
      reusable: true,
      createdAt: iso()
    });
  }
  if (!needsPermission && !scopeDenied) {
    void scheduleNextQueuedJob(input.projectRoot);
  }
  return { bundle: await loadProject(input.projectRoot), runId: run.id };
}

async function resolvePendingSourceReview(
  projectRoot: string,
  run: Run,
  decision: "accepted" | "rejected",
  reason: string
): Promise<ProjectBundle> {
  const pending = run.sourceReview;
  if (!pending) return loadProject(projectRoot);
  const proposalView = (await listPatchProposals(projectRoot))
    .find((item) => item.artifact.id === pending.proposalArtifactId);
  const proposal = proposalView ? llmPatchProposalSchema.parse(proposalView.proposal) : null;
  const previousReview = proposalView?.review;
  const resultByIndex = new Map(previousReview?.results.map((result) => [result.operationIndex, result]) ?? []);
  const decisionByIndex = new Map(previousReview?.decisions.map((item) => [item.operationIndex, item]) ?? []);
  const before = await collectSourceSnapshot(projectRoot);
  const resolutionLogs: Run["logs"] = [];
  const appliedMappings: ImplementationFileMapping[] = [];

  for (const operationIndex of pending.operationIndexes) {
    const operation = proposal?.operations[operationIndex];
    if (!operation || operation.kind !== "propose-source-file" || operation.action !== "delete") {
      resultByIndex.set(operationIndex, {
        operationIndex,
        status: "failed",
        message: "Pending source deletion was not found in its proposal."
      });
      continue;
    }
    decisionByIndex.set(operationIndex, { operationIndex, decision, reason });
    if (decision === "rejected") {
      resultByIndex.set(operationIndex, { operationIndex, status: "rejected", message: reason });
      resolutionLogs.push({ at: iso(), stream: "system", text: `Deletion rejected for ${operation.path}; coding will continue without deleting it.` });
      continue;
    }
    const result = await applyProposedSourceFileOperation(projectRoot, operation, true, run.id);
    resultByIndex.set(operationIndex, { operationIndex, status: result.status, message: result.message });
    resolutionLogs.push({
      at: iso(),
      stream: result.status === "applied" ? "system" : "stderr",
      text: result.status === "applied"
        ? `Approved deletion applied: ${operation.path}.`
        : `Approved deletion could not be applied safely: ${operation.path}. ${result.message}`
    });
    if (result.status === "applied") {
      appliedMappings.push(...sourceFileProposalNodeIds(operation)
        .map((nodeId) => ({ nodeId, path: operation.path, action: "delete" as const })));
    }
  }

  if (proposalView) {
    const review = patchReviewRecordSchema.parse({
      proposalArtifactId: proposalView.artifact.id,
      runId: run.id,
      reviewedAt: iso(),
      decisions: [...decisionByIndex.values()].sort((a, b) => a.operationIndex - b.operationIndex),
      results: [...resultByIndex.values()].sort((a, b) => a.operationIndex - b.operationIndex)
    });
    await writeJson(projectStatePath(projectRoot, "reviews", `${proposalView.artifact.id}.json`), review);
    await updatePatchArtifactStatus(projectRoot, proposalView.artifact.path, review.results);
  }
  if (appliedMappings.length) await persistImplementationFileMappings(projectRoot, run.id, appliedMappings);

  const after = await collectSourceSnapshot(projectRoot);
  const diffArtifact = decision === "accepted"
    ? await writeSourceDiffArtifact(projectRoot, run, buildUnifiedSourceDiff(before, after), {
        suffix: `source-review-${pending.batchNumber}`,
        title: `Approved source deletion for ${run.id}`
      })
    : null;
  if (diffArtifact) await markRunNodesWithDiff(projectRoot, run, diffArtifact);

  const latest = await readRun(projectRoot, run.id).catch(() => run);
  const decisionSummary = decision === "accepted"
    ? `User approved deletion of ${pending.paths.join(", ")}.`
    : `User rejected deletion of ${pending.paths.join(", ")}; do not retry those deletions unless the user explicitly changes direction.`;
  const implementation = latest.implementation ? {
    ...latest.implementation,
    maxBatches: Math.max(latest.implementation.maxBatches, latest.implementation.currentBatch + 1),
    needsMoreWork: true,
    summary: [latest.implementation.summary, decisionSummary].filter(Boolean).join(" ")
  } : undefined;
  const pendingPaths = new Set(pending.paths);
  const sourceDeletionDecisions = [
    ...(latest.sourceDeletionDecisions ?? []).filter((item) => !pendingPaths.has(item.path)),
    ...pending.paths.map((itemPath) => ({
      path: itemPath,
      decision,
      reason,
      decidedAt: iso()
    }))
  ];
  const resumed = runSchema.parse({
    ...latest,
    status: pending.resumePhase,
    phase: pending.resumePhase,
    sourceReview: undefined,
    sourceDeletionDecisions,
    permission: {
      decision: "allowed",
      reason: decision === "accepted"
        ? "Source deletion approved; coding resumed."
        : "Source deletion rejected; coding resumed without it."
    },
    implementation,
    sourceDiffArtifactIds: diffArtifact
      ? uniqueIds([...latest.sourceDiffArtifactIds, diffArtifact.id])
      : latest.sourceDiffArtifactIds,
    contextArtifacts: diffArtifact
      ? uniqueIds([...latest.contextArtifacts, diffArtifact.id])
      : latest.contextArtifacts,
    todos: latest.todos.map((todo) => todo.kind === "coding-phase" ? { ...todo, status: "doing" as const } : todo),
    logs: [...latest.logs, ...resolutionLogs, { at: iso(), stream: "system", text: `${decisionSummary} Resuming the same run.` }],
    runInstructions: decisionSummary,
    completedAt: undefined
  });
  await writeRun(projectRoot, resumed);
  void scheduleNextQueuedJob(projectRoot);
  return loadProject(projectRoot);
}

export async function approveRun(input: {
  projectRoot: string;
  runId: string;
  reusableApproval?: boolean;
}): Promise<ProjectBundle> {
  const run = await readRun(input.projectRoot, input.runId);
  if (run.status === "needs-permission" && run.sourceReview) {
    return resolvePendingSourceReview(input.projectRoot, run, "accepted", "Approved from the source deletion permission prompt.");
  }
  if (run.status === "awaiting-plan-review") {
    const bundle = await loadProject(input.projectRoot);
    const openQuestions = bundle.project.settings.stopOnUnansweredQuestions
      ? scopeOpenQuestions(bundle, run.flowId, run.nodeId)
      : [];
    if (openQuestions.length) {
      await writeRun(input.projectRoot, runSchema.parse({
        ...run,
        logs: [
          ...run.logs,
          { at: iso(), stream: "system", text: `Approval blocked until ${openQuestions.length} open question(s) are answered.` }
        ],
        runInstructions: "Answer unresolved node questions before resuming this run."
      }));
      return loadProject(input.projectRoot);
    }
  }
  const pendingToolCall = run.mcp?.pendingToolCall;
  const command = run.command ?? run.plannedCommands[0];
  const policyId = input.reusableApproval && command ? id("policy") : undefined;
  const reusablePolicyProject = input.reusableApproval && command ? (await loadProject(input.projectRoot)).project : undefined;
  const nextStatus: Run["status"] = run.status === "awaiting-plan-review"
    ? "coding"
    : run.status === "awaiting-code-review"
      ? "verifying"
      : run.status === "needs-permission" && run.phase === "planning"
        ? "planning"
      : run.status === "needs-permission" && run.phase === "coding" && !run.command
        ? "coding"
        : run.status === "needs-permission" && run.phase === "debugging"
          ? "debugging"
      : run.status === "needs-permission" && run.phase === "verifying"
        ? "verifying"
        : "queued";
  const nextPhase = nextStatus === "coding"
    ? "coding"
    : nextStatus === "debugging"
      ? "debugging"
    : nextStatus === "verifying"
      ? "verifying"
      : nextStatus === "planning"
        ? "planning"
        : run.phase;
  let approvedToolResult: string | undefined;
  if (pendingToolCall) {
    const bundle = await loadProject(input.projectRoot);
    const internalTools = archicodeInternalTools(bundle.project.settings);
    const firstPartyTools = [...internalTools, ...runSubagentTools(bundle.project.settings)];
    const firstPartyNames = new Set(firstPartyTools.map((tool) => tool.providerToolName));
    const mcpTools = [...firstPartyTools, ...providerMcpTools(bundle.project.settings).filter((tool) => !firstPartyNames.has(tool.providerToolName))];
    try {
      approvedToolResult = await executeRunMcpTool(input.projectRoot, run.id, bundle.project.settings, mcpTools, {
        providerToolName: pendingToolCall.providerToolName,
        argumentsJson: pendingToolCall.argumentsJson ?? "{}"
      }, { approvedByUser: true });
    } catch (error) {
      if (!(error instanceof RunConsoleApprovalPending)) {
        approvedToolResult = `Tool execution failed after approval: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  const approvedMcpServerIds = run.mcp?.pendingServerIds.length
    ? [...new Set([...(run.mcp.approvedServerIds ?? []), ...run.mcp.pendingServerIds])]
    : run.mcp?.approvedServerIds ?? [];
  // Re-read after executing the approved tool call so its call records and
  // logs survive; building from the pre-execution snapshot would erase them.
  const runAfterTool = pendingToolCall ? await readRun(input.projectRoot, input.runId).catch(() => run) : run;
  const chainedPendingToolCall = runAfterTool.status === "needs-permission" ? runAfterTool.mcp?.pendingToolCall : undefined;
  if (pendingToolCall && chainedPendingToolCall && (
    chainedPendingToolCall.providerToolName !== pendingToolCall.providerToolName
    || chainedPendingToolCall.argumentsJson !== pendingToolCall.argumentsJson
  )) {
    // Preserve a new setup approval discovered by the just-approved Delphi
    // audit. Rebuilding from the original approval snapshot would otherwise
    // clear this chained card and lose the provider continuation.
    return loadProject(input.projectRoot);
  }
  const approved = runSchema.parse({
    ...runAfterTool,
    status: nextStatus,
    phase: nextPhase,
    permission: {
      decision: "allowed",
      reusablePolicyId: policyId ?? run.permission.reusablePolicyId,
      grantedFor: run.status === "needs-permission" && run.phase === "coding"
        ? "coding-command" as const
        : run.status === "needs-permission" && run.phase === "debugging"
        ? "debugging-command" as const
        : run.status === "needs-permission" && run.phase === "verifying"
          ? "verification-command" as const
          : run.permission.grantedFor,
      reason: input.reusableApproval && command
        ? "Approved and saved as a reusable policy."
        : pendingToolCall
          ? `Approved MCP tool call for this run: ${pendingToolCall.serverLabel} / ${pendingToolCall.toolName}.`
          : run.mcp?.pendingServerIds.length
            ? `Approved MCP server access for this run: ${run.mcp.pendingServerIds.join(", ")}.`
        : run.status === "needs-permission" && run.phase === "coding"
          ? "Approved coding command for this run."
          : run.status === "needs-permission" && run.phase === "debugging"
            ? "Approved debugging command for this run."
            : run.status === "needs-permission" && run.phase === "verifying"
              ? "Approved verification command for this run."
              : run.status === "awaiting-plan-review"
                ? "Planning review approved; coding command still requires policy if it is not trusted."
                : run.status === "awaiting-code-review"
                  ? "Source changes review approved."
                  : "Approved for this run."
            },
    mcp: run.mcp ? {
      ...run.mcp,
      decision: "allowed",
      approvedServerIds: approvedMcpServerIds,
      deniedServerIds: pendingToolCall
        ? (run.mcp.deniedServerIds ?? []).filter((serverId) => serverId !== pendingToolCall.serverId)
        : run.mcp.deniedServerIds ?? [],
      pendingServerIds: [],
      pendingToolCall: undefined,
      continuation: run.mcp.continuation ? {
        ...run.mcp.continuation,
        resume: pendingToolCall
          ? {
              decision: "approved",
              serverId: pendingToolCall.serverId,
              serverLabel: pendingToolCall.serverLabel,
              toolName: pendingToolCall.toolName,
              providerToolName: pendingToolCall.providerToolName,
              argumentsJson: pendingToolCall.argumentsJson,
              intent: pendingToolCall.intent,
              resultText: approvedToolResult
            }
          : run.mcp.continuation.resume
      } : undefined
    } : undefined,
    reviewDecisions: [
      ...run.reviewDecisions,
      ...(run.status === "awaiting-plan-review"
        ? [{ kind: "planning" as const, decision: "accepted" as const, decidedAt: iso(), reason: "Approved from run console." }]
        : []),
      ...(run.status === "awaiting-code-review"
        ? [{ kind: "code" as const, decision: "accepted" as const, decidedAt: iso(), reason: "Approved from run console." }]
        : []),
      ...(run.status === "needs-permission" && run.phase === "debugging"
        ? [{ kind: "debugging" as const, decision: "accepted" as const, decidedAt: iso(), reason: "Approved from run console." }]
        : [])
    ],
    logs: [...runAfterTool.logs, { at: iso(), stream: "system", text: pendingToolCall
      ? `MCP tool approval granted for ${pendingToolCall.serverLabel} / ${pendingToolCall.toolName}. Resuming the same run.`
      : run.status.startsWith("awaiting")
        ? "Review approved."
        : "Permission approved." }]
  });
  await writeRun(input.projectRoot, approved);
  if (reusablePolicyProject && command) {
    await writeReusableShellPolicy(input.projectRoot, reusablePolicyProject, {
      id: policyId ?? id("policy"),
      command,
      cwd: run.cwd,
      env: run.env,
      risk: run.risk ?? classifyCommandRisk(command),
      filesystemPolicy: reusablePolicyProject.settings.filesystem.policy,
      allowedRoots: reusablePolicyProject.settings.filesystem.allowedRoots,
      reusable: true,
      createdAt: iso()
    });
  }
  void scheduleNextQueuedJob(input.projectRoot);
  return loadProject(input.projectRoot);
}

export async function cancelRun(projectRoot: string, runId: string): Promise<ProjectBundle> {
  pendingTerminalCancellationRunIds.add(runId);
  abortActiveRunWork(runId);
  terminateActiveRunProcess(runId);
  const run = await readRun(projectRoot, runId);
  if (isTerminalRunStatus(run.status)) return loadProject(projectRoot);
  const cancelled = runSchema.parse({
    ...run,
    status: "cancelled",
    phase: "complete",
    permission: run.status === "needs-permission"
      ? {
          decision: "denied",
          reason: "Permission denied by the user."
        }
      : run.permission,
    logs: [...run.logs, { at: iso(), stream: "system", text: "Run cancelled." }],
    runInstructions: "Run cancelled before completion.",
    completedAt: iso()
  });
  await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, cancelled, cancelled.runInstructions ?? "Run cancelled before completion."));
  void scheduleNextQueuedJob(projectRoot);
  return loadProject(projectRoot);
}

export async function rejectRun(projectRoot: string, runId: string, reason = "Rejected from run console."): Promise<ProjectBundle> {
  const run = await readRun(projectRoot, runId);
  if (run.status === "needs-permission" && run.sourceReview) {
    return resolvePendingSourceReview(projectRoot, run, "rejected", reason.trim() || "Rejected from the source deletion permission prompt.");
  }
  if (run.status === "needs-permission" && run.mcp?.pendingToolCall) {
    const pendingToolCall = run.mcp.pendingToolCall;
    const nextStatus: Run["status"] = run.phase === "planning"
      ? "planning"
      : run.phase === "debugging"
        ? "debugging"
        : run.phase === "verifying"
          ? "verifying"
          : "coding";
    const resumed = runSchema.parse({
      ...run,
      status: nextStatus,
      phase: run.phase,
      permission: {
        ...run.permission,
        decision: run.permission.decision === "pending" ? "allowed" : run.permission.decision,
        reason: `Denied MCP tool call for this run: ${pendingToolCall.serverLabel} / ${pendingToolCall.toolName}. Continuing without it.`
      },
      mcp: {
        ...run.mcp,
        decision: "denied",
        approvedServerIds: run.mcp.approvedServerIds ?? [],
        deniedServerIds: [...new Set([...(run.mcp.deniedServerIds ?? []), pendingToolCall.serverId])],
        pendingServerIds: [],
        pendingToolCall: undefined,
        continuation: run.mcp.continuation ? {
          ...run.mcp.continuation,
          resume: {
            decision: "denied",
            serverId: pendingToolCall.serverId,
            serverLabel: pendingToolCall.serverLabel,
            toolName: pendingToolCall.toolName,
            providerToolName: pendingToolCall.providerToolName,
            argumentsJson: pendingToolCall.argumentsJson,
            intent: pendingToolCall.intent,
            deniedReason: reason.trim() || "Denied for this run."
          }
        } : undefined,
        reason: `Denied MCP tool call for this run: ${pendingToolCall.serverLabel} / ${pendingToolCall.toolName}.`
      },
      logs: [
        ...run.logs,
        { at: iso(), stream: "system", text: `MCP tool approval denied for ${pendingToolCall.serverLabel} / ${pendingToolCall.toolName}. Resuming the same run without that tool.` }
      ]
    });
    await writeRun(projectRoot, resumed);
    void scheduleNextQueuedJob(projectRoot);
    return loadProject(projectRoot);
  }

  pendingTerminalCancellationRunIds.add(runId);
  abortActiveRunWork(runId);
  terminateActiveRunProcess(runId);
  if (isTerminalRunStatus(run.status)) return loadProject(projectRoot);
  const reviewReason = reason.trim() || "Rejected from run console.";

  const reviewDecision = run.status === "awaiting-plan-review"
    ? [{ kind: "planning" as const, decision: "rejected" as const, decidedAt: iso(), reason: reviewReason }]
    : run.status === "awaiting-code-review"
      ? [{ kind: "code" as const, decision: "rejected" as const, decidedAt: iso(), reason: reviewReason }]
      : [];
  const deniedPermission = run.status === "needs-permission";
  const message = run.status === "awaiting-plan-review"
    ? `Plan rejected by the user: ${reviewReason}`
    : run.status === "awaiting-code-review"
      ? `Code rejected by the user: ${reviewReason}`
      : deniedPermission
        ? `Approval denied by the user: ${reviewReason}`
        : `Run rejected by the user: ${reviewReason}`;

  const cancelled = runSchema.parse({
    ...run,
    status: "cancelled",
    phase: "complete",
    permission: deniedPermission
      ? {
        decision: "denied",
        reason: reviewReason
      }
      : run.permission,
    reviewDecisions: [...run.reviewDecisions, ...reviewDecision],
    logs: [...run.logs, { at: iso(), stream: "system", text: message }],
    runInstructions: message,
    completedAt: iso()
  });
  await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, cancelled, message));
  void scheduleNextQueuedJob(projectRoot);
  return loadProject(projectRoot);
}

export async function dismissRunError(projectRoot: string, runId: string): Promise<ProjectBundle> {
  const run = await readRun(projectRoot, runId);
  if (run.status !== "failed" && run.status !== "cancelled") return loadProject(projectRoot);
  if (run.errorDismissedAt) return loadProject(projectRoot);

  await writeRun(projectRoot, runSchema.parse({
    ...run,
    errorDismissedAt: iso(),
    logs: [...run.logs, { at: iso(), stream: "system", text: "Run error dismissed." }]
  }));
  return loadProject(projectRoot);
}

export async function removeRunFromQueue(projectRoot: string, runId: string): Promise<ProjectBundle> {
  const run = await readRun(projectRoot, runId);
  if (isActiveTerminalRun(run) && !run.queueRemovedAt) {
    await writeRun(projectRoot, runSchema.parse({
      ...run,
      queueRemovedAt: iso(),
      logs: [...run.logs, { at: iso(), stream: "system", text: "Run removed from queue." }]
    }));
  }
  return loadProject(projectRoot);
}

function isActiveTerminalRun(run: Run): boolean {
  return ["succeeded", "failed", "cancelled"].includes(run.status);
}

export function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeGuidance(guidance?: Partial<RunGuidance>): RunGuidance | undefined {
  if (!guidance) return undefined;
  const text = guidance.text?.trim() ?? "";
  const evidence = [...new Set(guidance.evidence ?? [])] as RunEvidenceKind[];
  const runtimeServiceId = guidance.runtimeServiceId?.trim();
  const source = guidance.source === "research-agent" ? "research-agent" : "user";
  if (!text && !evidence.length && !runtimeServiceId) return undefined;
  return { text, evidence, runtimeServiceId, source };
}

function guidanceAuthorLabel(guidance?: RunGuidance): string {
  return guidance?.source === "research-agent" ? "Research agent" : "User";
}

function guidanceContextHeading(guidance: RunGuidance | undefined, fallback: string): string {
  return guidance?.source === "research-agent" ? `Research Agent ${fallback}` : `User-Selected ${fallback}`;
}

function guidanceAttachedLog(guidance: RunGuidance | undefined, label: string): string {
  return `${guidanceAuthorLabel(guidance)} ${label} guidance was attached.`;
}

function latestRunErrorText(run: Run): string {
  const latestError = [...run.logs].reverse().find((line) => line.stream === "stderr" && line.text.trim());
  return latestError?.text.trim() || run.runInstructions || "";
}

async function artifactTextById(projectRoot: string, artifactId: string): Promise<string> {
  const artifacts = await readJsonDirectory<Artifact>(projectStatePath(projectRoot, "artifacts"));
  const artifact = artifacts.find((item) => artifactSchema.safeParse(item).success && item.id === artifactId);
  if (!artifact?.path) return "";
  try {
    return await readArtifactText(projectRoot, artifact.path);
  } catch {
    return "";
  }
}

function runtimeLogTextForGuidance(projectRoot: string, guidance: RunGuidance | undefined): string {
  const normalizedRoot = normalizeForCompare(projectRoot);
  const services = [...activeRuntimeServices.values()]
    .map((entry) => entry.service)
    .filter((service) => normalizeForCompare(service.projectRoot) === normalizedRoot);
  const selected = guidance?.runtimeServiceId
    ? services.find((service) => service.id === guidance.runtimeServiceId)
    : services.find((service) => service.status === "failed" || service.status === "stale") ?? services[0];
  if (!selected) return "";
  return [
    `Runtime service: ${selected.label}`,
    `Status: ${selected.status}`,
    `Command: ${selected.command}`,
    selected.url ? `URL: ${selected.url}` : "",
    "Recent runtime logs:",
    selected.logs.slice(-80).map((line) => `[${line.stream}] ${line.text}`).join("\n")
  ].filter(Boolean).join("\n");
}

async function nodeNoteEvidence(projectRoot: string, run: Run): Promise<string> {
  if (!run.nodeId) return "";
  const notes = await readNotes(projectRoot);
  const matching = notes
    .flatMap((note) => {
      const parsed = noteSchema.safeParse(note);
      return parsed.success && parsed.data.flowId === run.flowId && parsed.data.nodeId === run.nodeId && !parsed.data.resolved ? [parsed.data] : [];
    })
    .slice(-20);
  if (!matching.length) return "";
  return [
    "Selected node notes:",
    ...matching.map((note) => `- ${note.kind}/${note.category}/${note.priority}: ${note.body}`)
  ].join("\n");
}

async function guidanceEvidenceText(projectRoot: string, run: Run, guidance?: RunGuidance): Promise<string> {
  if (!guidance) return "";
  const sections: string[] = [];
  if (guidance.text.trim()) {
    sections.push([`${guidanceAuthorLabel(guidance)} guidance:`, guidance.text.trim()].join("\n"));
  }
  if (guidance.evidence.includes("last-error")) {
    const text = latestRunErrorText(run);
    if (text) sections.push(["Selected last error:", text].join("\n"));
  }
  if (guidance.evidence.includes("trace-tail")) {
    sections.push([
      "Selected trace tail:",
      run.logs.slice(-40).map((line) => `[${line.stream}] ${line.text}`).join("\n")
    ].join("\n"));
  }
  if (guidance.evidence.includes("latest-diff")) {
    const diffId = run.sourceDiffArtifactIds[run.sourceDiffArtifactIds.length - 1];
    const diffText = diffId ? await artifactTextById(projectRoot, diffId) : "";
    if (diffText) sections.push(["Selected latest diff:", diffText.slice(0, 20000)].join("\n"));
  }
  if (guidance.evidence.includes("runtime-log")) {
    const runtimeText = runtimeLogTextForGuidance(projectRoot, guidance);
    if (runtimeText) sections.push(runtimeText);
  }
  if (guidance.evidence.includes("node-notes")) {
    const notes = await nodeNoteEvidence(projectRoot, run);
    if (notes) sections.push(notes);
  }
  return sections.join("\n\n");
}

function runHasVerificationApproval(run: Run): boolean {
  return run.permission.decision === "allowed" &&
    (run.phase === "verifying" ||
      run.logs.some((line) => /Permission approved|Approved verification command|Verification phase started|Waiting for approval to verify/i.test(line.text)));
}

function runAcceptedReview(run: Run, kind: "planning" | "code"): boolean {
  return run.reviewDecisions.some((decision) => decision.kind === kind && decision.decision === "accepted");
}

async function retryResumeSourceRun(projectRoot: string, run: Run): Promise<Run> {
  if (!run.retryOf || run.sourceDiffArtifactIds.length) return run;
  const parent = await readRun(projectRoot, run.retryOf).catch(() => null);
  if (!parent?.sourceDiffArtifactIds.length) return run;
  return runSchema.parse({
    ...run,
    sourceDiffArtifactIds: parent.sourceDiffArtifactIds,
    planArtifactIds: uniqueIds([...run.planArtifactIds, ...parent.planArtifactIds]),
    contextArtifacts: uniqueIds([...run.contextArtifacts, ...parent.contextArtifacts, ...parent.sourceDiffArtifactIds]),
    affectedNodeIds: uniqueIds([...run.affectedNodeIds, ...parent.affectedNodeIds]),
    reviewDecisions: run.reviewDecisions.length ? run.reviewDecisions : parent.reviewDecisions
  });
}

type RetryResumePhase = "plan-review" | "code-review" | "verification" | "debugging" | "coding" | "planning" | "replan" | "fresh";

function runHasLog(run: Run, pattern: RegExp): boolean {
  return run.logs.some((line) => pattern.test(line.text));
}

function runStoppedAtPhase(run: Run, phase: RunPhase): boolean {
  return run.stoppedAtPhase === phase || run.phase === phase || run.status === phase || (run.status === "needs-permission" && run.phase === phase);
}

function inferRetryResumePhase(run: Run): RetryResumePhase {
  if (runStoppedAtPhase(run, "needs-replan")) return "replan";
  if (runStoppedAtPhase(run, "awaiting-plan-review")) return "plan-review";
  if (runStoppedAtPhase(run, "awaiting-code-review")) return "code-review";
  const classification = classifyRunFailure(run);
  if (classification) {
    if (classification.code === "requirements-blocked") return "replan";
    if (classification.code === "invalid-source-proposal" || classification.code === "implementation-incomplete") {
      return run.stoppedAtPhase === "debugging" ? "debugging" : "coding";
    }
    if (classification.code === "tool-schema-invalid" || classification.code === "artifact-read-failed" || classification.code === "preflight-path-mismatch") {
      if (runStoppedAtPhase(run, "verifying") || runHasVerificationLifecycleMarker(run) || Boolean(run.command?.trim())) return "verification";
      if (runStoppedAtPhase(run, "coding") || runHasLog(run, /Coding phase started|API coding phase started/i)) return "coding";
    }
    if (
      classification.code === "verification-blocked-approval" ||
      classification.code === "dependency-sync-needed" ||
      classification.code === "build-command-failed" ||
      classification.code === "test-command-failed" ||
      classification.code === "runtime-command-failed"
    ) {
      return "verification";
    }
  }
  if (runStoppedAtPhase(run, "verifying") || runHasVerificationLifecycleMarker(run)) return "verification";
  if (run.sourceDiffArtifactIds.length) {
    return runAcceptedReview(run, "code") || run.command ? "verification" : "code-review";
  }
  if (runStoppedAtPhase(run, "debugging") || runHasLog(run, /Debugging phase started/i)) return "debugging";
  if (runStoppedAtPhase(run, "coding") || runHasLog(run, /Coding phase started|API coding phase started/i)) return "coding";
  if (runStoppedAtPhase(run, "planning") || runHasLog(run, /Planning phase started/i)) return "planning";
  if (run.planArtifactIds.length && !runAcceptedReview(run, "planning")) return "plan-review";
  if (run.command) return "verification";
  return "fresh";
}

async function runArtifactsExist(projectRoot: string, artifactIds: string[]): Promise<boolean> {
  const artifacts = await readJsonDirectory<Artifact>(projectStatePath(projectRoot, "artifacts"));
  for (const artifactId of artifactIds) {
    const artifact = artifacts.find((item) => artifactSchema.safeParse(item).success && item.id === artifactId);
    if (!artifact?.path || !(await exists(path.join(projectRoot, artifact.path)))) return false;
  }
  return true;
}

function retryContextText(contextText: string, run: Run, resumePhase: Run["phase"], guidanceText = "", guidance?: RunGuidance): string {
  const recentLogs = run.logs.slice(-20).map((line) => `[${line.stream}] ${line.text}`).join("\n");
  return [
    contextText,
    "",
    "## Retry Resume Context",
    "",
    `Previous run: ${run.id}`,
    `Resume phase: ${resumePhase}`,
    `Previous status: ${run.status}`,
    `Previous phase: ${run.phase}`,
    `Previous prompt: ${run.promptSummary}`,
    run.command ? `Previous command: ${run.command}` : "",
    run.planArtifactIds.length ? `Previous plan artifacts: ${run.planArtifactIds.join(", ")}` : "",
    run.sourceDiffArtifactIds.length ? `Previous source diff artifacts: ${run.sourceDiffArtifactIds.join(", ")}` : "",
    run.affectedNodeIds.length ? `Affected nodes: ${run.affectedNodeIds.join(", ")}` : "",
    run.runMemory ? ["", "Run memory card:", JSON.stringify(run.runMemory, null, 2)].join("\n") : "",
    "",
    "Recent previous run logs:",
    recentLogs || "(none)",
    guidanceText ? ["", `## ${guidanceContextHeading(guidance, "Retry Evidence")}`, "", guidanceText].join("\n") : ""
  ].filter(Boolean).join("\n");
}

// Shared constructor for in-place retry/resume runs. Starts from the parent
// run so a new Run field is inherited by default instead of being silently
// dropped by a per-constructor rebuild, then clears the per-attempt state
// every retry must reset. Anything phase-specific belongs in the caller's
// overrides.
function buildRetryRun(run: Run, overrides: Partial<Run>): Run {
  return runSchema.parse({
    ...run,
    // Per-attempt bookkeeping that must never leak into a new attempt.
    stoppedAtPhase: undefined,
    lastVerification: undefined,
    origin: undefined,
    mcpToolCalls: [],
    sourceReview: undefined,
    filesystemScope: undefined,
    runInstructions: undefined,
    queueRemovedAt: undefined,
    errorDismissedAt: undefined,
    completedAt: undefined,
    startedAt: undefined,
    createdAt: run.createdAt,
    ...overrides
  });
}

async function startVerificationRetry(projectRoot: string, run: Run, guidance?: RunGuidance): Promise<{ bundle: ProjectBundle; runId: string } | null> {
  const bundle = await loadProject(projectRoot);
  const inferredCommand = (await inferredVerificationCommand(projectRoot, bundle)).trim();
  let command = (inferredCommand || run.command?.trim() || "").trim();
  const classification = classifyRunFailure(run);
  if (classification?.code === "dependency-sync-needed" && command) {
    const dependencyPlan = await dependencyInstallPlanForCommand(projectRoot, command);
    if (dependencyPlan.installCommand && !commandAlreadyIncludesSetup(command, dependencyPlan.installCommand)) {
      command = `${dependencyPlan.installCommand} && ${command}`;
    }
  }
  if (!command) return null;
  if (run.sourceDiffArtifactIds.length && !(await runArtifactsExist(projectRoot, run.sourceDiffArtifactIds))) return null;

  const cwd = run.cwd?.trim() || projectRoot;
  const risk = run.risk ?? classifyCommandRisk(command);
  const scope = await evaluateFilesystemScope(projectRoot, bundle.project.settings, command, cwd, risk);
  const reusablePolicy = commandAllowedBySettings(bundle.project.settings, command, cwd);
  const approved = Boolean(reusablePolicy) || runHasVerificationApproval(run) || commandsAutoApproved(bundle.project.settings, risk, command);
  const needsPermission = !scope.allowed ? false : !approved;
  const context = await buildContext(projectRoot, run.flowId, run.nodeId, run.providerId, run.scope);
  const retryRunId = run.id;
  const planArtifact = await writeRunPlanArtifact(projectRoot, {
    runId: retryRunId,
    flowId: run.flowId,
    nodeId: run.nodeId,
    promptSummary: `Resume verification for ${run.promptSummary}`,
    providerId: run.providerId,
    plannedCommands: [command],
    plannedAllowedRoots: [projectRoot, ...bundle.project.settings.filesystem.allowedRoots],
    scope
  });
  const createdAt = iso();
  const retry = buildRetryRun(run, {
    status: !scope.allowed ? "failed" : needsPermission ? "needs-permission" : "verifying",
    phase: !scope.allowed ? "complete" : "verifying",
    command,
    cwd,
    risk,
    filesystemScope: {
      policy: scope.policy,
      cwd: scope.cwd,
      allowedRoots: scope.allowedRoots,
      violations: scope.violations
    },
    guidance,
    implementation: undefined,
    permission: {
      decision: !scope.allowed ? "denied" : needsPermission ? "pending" : "allowed",
      reusablePolicyId: reusablePolicy?.id ?? run.permission.reusablePolicyId,
      grantedFor: !scope.allowed || needsPermission ? undefined : "verification-command",
      reason: !scope.allowed
        ? `Filesystem scope denied: ${scope.violations.join(" ")}`
        : needsPermission
          ? `Verification command "${command}" needs approval before retry can resume.`
          : reusablePolicy
            ? `Resume allowed by reusable policy ${reusablePolicy.id}.`
            : "Approved verification command for retry."
    },
    contextSummary: context.summary,
    contextArtifacts: uniqueIds([...context.artifacts.map((artifact) => artifact.id), planArtifact.id, ...run.contextArtifacts, ...run.planArtifactIds, ...run.sourceDiffArtifactIds]),
    planArtifactIds: uniqueIds([planArtifact.id, ...run.planArtifactIds]),
    plannedCommands: uniqueIds([command, ...run.plannedCommands]),
    plannedAllowedRoots: uniqueIds([projectRoot, ...bundle.project.settings.filesystem.allowedRoots, ...run.plannedAllowedRoots]),
    todos: [
      { id: id("todo"), text: "Load previous run context and artifacts", status: "done" },
      { id: id("todo"), text: "Reuse completed planning and coding output", status: "done" },
      { id: id("todo"), text: `Verify with ${command}`, status: !scope.allowed || needsPermission ? "blocked" : "doing" }
    ],
    logs: [
      ...run.logs,
      { at: createdAt, stream: "system", text: "Retrying this run from verification using prior plan, diff, context, and review state." },
      ...(guidance?.text || guidance?.evidence.length ? [{ at: createdAt, stream: "system" as const, text: guidanceAttachedLog(guidance, "retry") }] : []),
      { at: createdAt, stream: "system", text: `Prepared context (${context.text.length} characters) and inherited ${run.contextArtifacts.length + run.sourceDiffArtifactIds.length + run.planArtifactIds.length} previous artifact reference(s).` },
      { at: createdAt, stream: "system", text: !scope.allowed ? `Blocked by filesystem scope: ${scope.violations.join(" ")}` : needsPermission ? `Waiting for approval to verify with: ${command}` : `Verification resume queued: ${command}` }
    ],
    runInstructions: needsPermission
      ? "Approve the inherited verification command to resume this retry."
      : !scope.allowed
        ? `Verification retry blocked by filesystem scope: ${scope.violations.join(" ")}`
        : "Retry will resume verification in this run.",
    completedAt: !scope.allowed ? createdAt : undefined,
    startedAt: createdAt
  });

  await writeRun(projectRoot, !scope.allowed ? await finalizeTerminalRun(projectRoot, retry, retry.runInstructions ?? "Verification retry blocked.") : retry);
  if (!needsPermission && scope.allowed) void scheduleNextQueuedJob(projectRoot);
  return { bundle: await loadProject(projectRoot), runId: run.id };
}

async function startPlanReviewRetry(projectRoot: string, run: Run, guidance?: RunGuidance): Promise<{ bundle: ProjectBundle; runId: string } | null> {
  if (!run.planArtifactIds.length || !(await runArtifactsExist(projectRoot, run.planArtifactIds))) return null;
  const bundle = await loadProject(projectRoot);
  const context = await buildContext(projectRoot, run.flowId, run.nodeId, run.providerId, run.scope);
  const retryRunId = run.id;
  const planArtifact = await writeRunPlanArtifact(projectRoot, {
    runId: retryRunId,
    flowId: run.flowId,
    nodeId: run.nodeId,
    promptSummary: `Resume plan review for ${run.promptSummary}`,
    providerId: run.providerId,
    plannedCommands: run.plannedCommands,
    plannedAllowedRoots: [projectRoot, ...bundle.project.settings.filesystem.allowedRoots]
  });
  const createdAt = iso();
  const retry = buildRetryRun(run, {
    status: "awaiting-plan-review",
    phase: "awaiting-plan-review",
    guidance,
    // Plan review restarts before coding: prior diffs and implementation
    // progress must not survive, or later resume inference would treat this
    // run as already-coded.
    sourceDiffArtifactIds: [],
    implementation: undefined,
    permission: { decision: "allowed", reason: "Resuming plan review in this run." },
    contextSummary: context.summary,
    contextArtifacts: uniqueIds([...context.artifacts.map((artifact) => artifact.id), planArtifact.id, ...run.contextArtifacts, ...run.planArtifactIds]),
    planArtifactIds: uniqueIds([planArtifact.id, ...run.planArtifactIds]),
    plannedAllowedRoots: uniqueIds([projectRoot, ...bundle.project.settings.filesystem.allowedRoots, ...run.plannedAllowedRoots]),
    reviewDecisions: run.reviewDecisions.filter((decision) => decision.kind !== "planning"),
    todos: [
      { id: id("todo"), text: "Load previous plan and context", status: "done" },
      { id: id("todo"), text: "Review inherited plan", status: "doing" },
      { id: id("todo"), text: "Code after plan approval", status: "todo" }
    ],
    logs: [
      ...run.logs,
      { at: createdAt, stream: "system", text: `Retrying this run from plan review with inherited plan artifact(s): ${run.planArtifactIds.join(", ")}.` },
      ...(guidance?.text || guidance?.evidence.length ? [{ at: createdAt, stream: "system" as const, text: guidanceAttachedLog(guidance, "retry") }] : []),
      { at: createdAt, stream: "system", text: `Prepared context (${context.text.length} characters) and inherited prior plan artifacts.` }
    ],
    runInstructions: "Review the inherited plan, then resume to continue into coding.",
    startedAt: createdAt
  });
  await writeRun(projectRoot, retry);
  return { bundle: await loadProject(projectRoot), runId: run.id };
}

async function startCodeReviewRetry(projectRoot: string, run: Run, guidance?: RunGuidance): Promise<{ bundle: ProjectBundle; runId: string } | null> {
  if (!run.sourceDiffArtifactIds.length || !(await runArtifactsExist(projectRoot, run.sourceDiffArtifactIds))) return null;
  const bundle = await loadProject(projectRoot);
  const command = await inferredVerificationCommand(projectRoot, bundle);
  const context = await buildContext(projectRoot, run.flowId, run.nodeId, run.providerId, run.scope);
  const retryRunId = run.id;
  const planArtifact = await writeRunPlanArtifact(projectRoot, {
    runId: retryRunId,
    flowId: run.flowId,
    nodeId: run.nodeId,
    promptSummary: `Resume code review for ${run.promptSummary}`,
    providerId: run.providerId,
    plannedCommands: command ? [command] : [],
    plannedAllowedRoots: [projectRoot, ...bundle.project.settings.filesystem.allowedRoots]
  });
  const createdAt = iso();
  const retry = buildRetryRun(run, {
    status: "awaiting-code-review",
    phase: "awaiting-code-review",
    command: command || run.command,
    guidance,
    implementation: undefined,
    permission: { decision: "allowed", reason: "Resuming code review in this run." },
    contextSummary: context.summary,
    contextArtifacts: uniqueIds([...context.artifacts.map((artifact) => artifact.id), planArtifact.id, ...run.contextArtifacts, ...run.planArtifactIds, ...run.sourceDiffArtifactIds]),
    planArtifactIds: uniqueIds([planArtifact.id, ...run.planArtifactIds]),
    plannedCommands: uniqueIds([...(command ? [command] : []), ...run.plannedCommands]),
    plannedAllowedRoots: uniqueIds([projectRoot, ...bundle.project.settings.filesystem.allowedRoots, ...run.plannedAllowedRoots]),
    reviewDecisions: run.reviewDecisions.filter((decision) => decision.kind !== "code"),
    todos: [
      { id: id("todo"), text: "Load previous run context and source diff", status: "done" },
      { id: id("todo"), text: "Review inherited source changes", status: "doing" },
      { id: id("todo"), text: "Verify after code review approval", status: "todo" }
    ],
    logs: [
      ...run.logs,
      { at: createdAt, stream: "system", text: `Retrying this run from code review with inherited source diff artifact(s): ${run.sourceDiffArtifactIds.join(", ")}.` },
      ...(guidance?.text || guidance?.evidence.length ? [{ at: createdAt, stream: "system" as const, text: guidanceAttachedLog(guidance, "retry") }] : []),
      { at: createdAt, stream: "system", text: `Prepared context (${context.text.length} characters) and inherited prior run artifacts.` }
    ],
    runInstructions: "Review the inherited source diff, then approve to continue verification.",
    startedAt: createdAt
  });
  await writeRun(projectRoot, retry);
  return { bundle: await loadProject(projectRoot), runId: run.id };
}

async function startReplanRetry(projectRoot: string, run: Run, guidance?: RunGuidance): Promise<{ bundle: ProjectBundle; runId: string }> {
  const bundle = await loadProject(projectRoot);
  const context = await buildContext(projectRoot, run.flowId, run.nodeId, run.providerId, run.scope);
  const provider = bundle.project.settings.providers.find((item) => item.id === run.providerId);
  const command = providerCommand(provider);
  const retryRunId = run.id;
  const replanReason = run.implementation?.needsReplan?.reason ?? run.runInstructions ?? "Coding reported that the plan is not sufficient to continue safely.";
  const planArtifact = await writeRunPlanArtifact(projectRoot, {
    runId: retryRunId,
    flowId: run.flowId,
    nodeId: run.nodeId,
    promptSummary: `Replan for ${run.promptSummary}`,
    providerId: run.providerId,
    plannedCommands: uniqueIds([...(command ? [command] : []), ...run.plannedCommands]),
    plannedAllowedRoots: [projectRoot, ...bundle.project.settings.filesystem.allowedRoots]
  });
  const createdAt = iso();
  const retry = buildRetryRun(run, {
    status: "planning",
    phase: "planning",
    risk: undefined,
    guidance,
    implementation: undefined,
    permission: { decision: "allowed", reason: "Replanning from coding blocker in this run." },
    contextSummary: context.summary,
    contextArtifacts: uniqueIds([...context.artifacts.map((artifact) => artifact.id), planArtifact.id, ...run.contextArtifacts, ...run.planArtifactIds, ...run.sourceDiffArtifactIds]),
    planArtifactIds: uniqueIds([planArtifact.id, ...run.planArtifactIds]),
    plannedCommands: uniqueIds([...(command ? [command] : []), ...run.plannedCommands]),
    plannedAllowedRoots: uniqueIds([projectRoot, ...bundle.project.settings.filesystem.allowedRoots, ...run.plannedAllowedRoots]),
    reviewDecisions: run.reviewDecisions.filter((decision) => decision.kind !== "planning"),
    todos: [
      { id: id("todo"), text: "Load coding blocker and checkpoints", status: "done" },
      { id: id("todo"), text: "Replan implementation tasks", status: "doing" },
      { id: id("todo"), text: "Resume coding from updated plan", status: "todo" }
    ],
    logs: [
      ...run.logs,
      { at: createdAt, stream: "system", text: `Retrying this run from planning after coding blocker: ${replanReason}` },
      ...(run.implementation?.needsReplan?.suggestedQuestions.length
        ? [{ at: createdAt, stream: "system" as const, text: `Suggested replan questions: ${run.implementation.needsReplan.suggestedQuestions.join(" | ")}` }]
        : []),
      ...(guidance?.text || guidance?.evidence.length ? [{ at: createdAt, stream: "system" as const, text: guidanceAttachedLog(guidance, "replan") }] : []),
      { at: createdAt, stream: "system", text: `Prepared context (${context.text.length} characters) and inherited implementation checkpoints.` }
    ],
    runInstructions: "Planning will revise the implementation task split before coding resumes.",
    startedAt: createdAt
  });
  await writeRun(projectRoot, retry);
  const guidanceText = await guidanceEvidenceText(projectRoot, run, guidance);
  const replanContext = [
    retryContextText(context.text, run, "planning", guidanceText, guidance),
    "",
    "## Coding Blocker Replan Request",
    replanReason,
    run.implementation?.needsReplan?.suggestedQuestions.length
      ? `Suggested questions: ${run.implementation.needsReplan.suggestedQuestions.join(" | ")}`
      : "",
    run.implementation?.checkpoints.length
      ? `Implementation checkpoints: ${JSON.stringify(run.implementation.checkpoints, null, 2)}`
      : ""
  ].filter(Boolean).join("\n");
  queuedContextTextByRun.set(retryRunId, replanContext);
  void scheduleNextQueuedJob(projectRoot);
  return { bundle: await loadProject(projectRoot), runId: run.id };
}

async function startCodingRetry(projectRoot: string, run: Run, guidance?: RunGuidance): Promise<{ bundle: ProjectBundle; runId: string } | null> {
  if (!run.planArtifactIds.length || !(await runArtifactsExist(projectRoot, run.planArtifactIds))) return null;
  const bundle = await loadProject(projectRoot);
  const context = await buildContext(projectRoot, run.flowId, run.nodeId, run.providerId, run.scope);
  const provider = bundle.project.settings.providers.find((item) => item.id === run.providerId);
  const command = providerCommand(provider);
  const retryRunId = run.id;
  const planArtifact = await writeRunPlanArtifact(projectRoot, {
    runId: retryRunId,
    flowId: run.flowId,
    nodeId: run.nodeId,
    promptSummary: `Resume coding for ${run.promptSummary}`,
    providerId: run.providerId,
    plannedCommands: uniqueIds([...(command ? [command] : []), ...run.plannedCommands]),
    plannedAllowedRoots: [projectRoot, ...bundle.project.settings.filesystem.allowedRoots]
  });
  const createdAt = iso();
  const resumedImplementation = run.implementation ? {
    ...run.implementation,
    maxBatches: Math.max(
      run.implementation.maxBatches,
      run.implementation.currentBatch + Math.max(1, run.implementation.tasks
        .filter((task) => task.status === "todo" || task.status === "doing")
        .reduce((sum, task) => sum + clampImplementationTaskBudget(task.batchBudget, concreteRunEffort(run)), 0))
    ),
    needsMoreWork: undefined,
    needsReplan: undefined
  } : undefined;
  const retry = buildRetryRun(run, {
    status: "coding",
    phase: "coding",
    // Coding restarts provider-driven: the previous attempt's shell command,
    // risk, and diffs must not carry into the new attempt.
    command: undefined,
    risk: undefined,
    sourceDiffArtifactIds: [],
    guidance,
    implementation: resumedImplementation,
    permission: { decision: "allowed", reason: "Resuming coding from completed plan in this run." },
    contextSummary: context.summary,
    contextArtifacts: uniqueIds([...context.artifacts.map((artifact) => artifact.id), planArtifact.id, ...run.contextArtifacts, ...run.planArtifactIds]),
    planArtifactIds: uniqueIds([planArtifact.id, ...run.planArtifactIds]),
    plannedCommands: uniqueIds([...(command ? [command] : []), ...run.plannedCommands]),
    plannedAllowedRoots: uniqueIds([projectRoot, ...bundle.project.settings.filesystem.allowedRoots, ...run.plannedAllowedRoots]),
    todos: [
      { id: id("todo"), text: "Load previous run plan and context", status: "done" },
      { id: id("todo"), text: "Resume coding from prior plan", status: "doing" },
      { id: id("todo"), text: "Verify resumed work", status: "todo" }
    ],
    logs: [
      ...run.logs,
      { at: createdAt, stream: "system", text: "Retrying this run from coding using the previous plan and recent run logs." },
      ...(guidance?.text || guidance?.evidence.length ? [{ at: createdAt, stream: "system" as const, text: guidanceAttachedLog(guidance, "retry") }] : []),
      { at: createdAt, stream: "system", text: `Prepared context (${context.text.length} characters) and inherited prior plan/context artifacts.` }
    ],
    runInstructions: "Coding retry is resuming from the previous plan and run context.",
    startedAt: createdAt
  });
  await writeRun(projectRoot, retry);
  const guidanceText = await guidanceEvidenceText(projectRoot, run, guidance);
  const webContext = await harnessWebContext(bundle.project.settings.webSearch.enabled, run.promptSummary, guidance?.text);
  queuedContextTextByRun.set(retryRunId, [retryContextText(context.text, run, "coding", guidanceText, guidance), webContext].filter(Boolean).join("\n\n"));
  void scheduleNextQueuedJob(projectRoot);
  return { bundle: await loadProject(projectRoot), runId: run.id };
}

async function startRunProfileRetry(projectRoot: string, run: Run): Promise<{ bundle: ProjectBundle; runId: string }> {
  const bundle = await loadProject(projectRoot);
  const provider = bundle.project.settings.providers.find((item) => item.id === run.providerId);
  const profile = bundle.project.settings.runTargetProfiles.find((item) => item.id === run.runProfileId);
  if (!provider) {
    throw new Error(`Provider ${run.providerId} was not found. Choose a configured provider before running.`);
  }
  if (!profile) {
    throw new Error(`Run target ${run.runProfileId} was not found. Configure run targets in Settings.`);
  }

  const commands = runProfileLaunchCommands(profile);
  const cwdInfo = await resolveProfileCwd(projectRoot, profile.cwd);
  const reusablePolicy = commandAllowedBySettings(bundle.project.settings, profile.runCommand, cwdInfo.cwd);
  const risk = profileRisk(profile);
  const needsPermission = Boolean(!reusablePolicy && run.permission.decision !== "allowed" && !commandsAutoApproved(bundle.project.settings, risk ?? "low", profile.runCommand));
  const scope = await evaluateFilesystemScope(projectRoot, bundle.project.settings, profile.runCommand, cwdInfo.cwd, risk ?? "low");
  const scopeDenied = !scope.allowed;
  const context = await buildContext(projectRoot, run.flowId, undefined, run.providerId);
  const planArtifact = await writeRunPlanArtifact(projectRoot, {
    runId: run.id,
    flowId: run.flowId,
    promptSummary: run.promptSummary,
    providerId: run.providerId,
    plannedCommands: commands,
    plannedAllowedRoots: [projectRoot, ...bundle.project.settings.filesystem.allowedRoots],
    scope
  });
  const createdAt = iso();
  const retry = buildRetryRun(run, {
    status: scopeDenied ? "failed" : needsPermission ? "needs-permission" : "queued",
    phase: scopeDenied ? "complete" : "coding",
    command: profile.runCommand,
    runProfileId: profile.id,
    runTargetId: run.runTargetId,
    cwd: cwdInfo.cwd,
    risk,
    filesystemScope: {
      policy: scope.policy,
      cwd: scope.cwd,
      allowedRoots: scope.allowedRoots,
      violations: scope.violations
    },
    permission: {
      decision: scopeDenied ? "denied" : needsPermission ? "pending" : "allowed",
      reusablePolicyId: reusablePolicy?.id ?? run.permission.reusablePolicyId,
      reason: scopeDenied
        ? `Filesystem scope denied: ${scope.violations.join(" ")}`
        : needsPermission
          ? `Run profile "${profile.label}" needs approval before retry can resume.`
          : reusablePolicy
            ? `Allowed by reusable policy ${reusablePolicy.id}.`
            : "Allowed to retry this run profile."
    },
    contextSummary: context.summary,
    contextArtifacts: uniqueIds([...run.contextArtifacts, ...context.artifacts.map((artifact) => artifact.id), planArtifact.id]),
    planArtifactIds: uniqueIds([planArtifact.id, ...run.planArtifactIds]),
    plannedCommands: uniqueIds([...commands, ...run.plannedCommands]),
    plannedAllowedRoots: uniqueIds([cwdInfo.cwd, projectRoot, ...bundle.project.settings.filesystem.allowedRoots, ...run.plannedAllowedRoots]),
    todos: [
      { id: id("todo"), text: "Refresh run profile context", status: "done" },
      { id: id("todo"), text: `Run ${profile.label}`, status: needsPermission || scopeDenied ? "blocked" : "doing" }
    ],
    logs: [
      ...run.logs,
      { at: createdAt, stream: "system", text: "Retrying this run profile in the same queue entry." },
      { at: createdAt, stream: "system", text: `Prepared context (${context.text.length} characters).` },
      { at: createdAt, stream: "system", text: `Plan artifact: ${planArtifact.path}` },
      { at: createdAt, stream: "system", text: scopeDenied ? `Blocked by filesystem scope: ${scope.violations.join(" ")}` : needsPermission ? "Waiting for run profile approval." : "Queued." }
    ],
    runInstructions: scopeDenied
      ? `Run profile retry blocked by filesystem scope: ${scope.violations.join(" ")}`
      : needsPermission
        ? "Approve the run profile command to retry this run."
        : "Retry queued in the same run.",
    completedAt: scopeDenied ? createdAt : undefined
  });

  await writeRun(projectRoot, scopeDenied ? await finalizeTerminalRun(projectRoot, retry, retry.runInstructions ?? "Run profile retry blocked.") : retry);
  if (!needsPermission && !scopeDenied) void scheduleNextQueuedJob(projectRoot);
  return { bundle: await loadProject(projectRoot), runId: run.id };
}

async function startFreshRetry(projectRoot: string, run: Run, guidance?: RunGuidance): Promise<{ bundle: ProjectBundle; runId: string }> {
  const bundle = await loadProject(projectRoot);
  const provider = bundle.project.settings.providers.find((item) => item.id === run.providerId);
  if (!provider) {
    throw new Error(`Provider ${run.providerId} was not found. Choose a configured provider before running.`);
  }
  const command = run.command?.trim();
  const cwd = run.cwd?.trim() || projectRoot;
  const risk = command ? run.risk ?? classifyCommandRisk(command) : "low";
  const scope = command ? await evaluateFilesystemScope(projectRoot, bundle.project.settings, command, cwd, risk) : null;
  const reusablePolicy = command ? commandAllowedBySettings(bundle.project.settings, command, cwd) : null;
  const scopeDenied = Boolean(scope && !scope.allowed);
  const needsPermission = Boolean(command && !scopeDenied && !reusablePolicy && run.permission.decision !== "allowed" && !commandsAutoApproved(bundle.project.settings, risk, command));
  const context = await buildContext(projectRoot, run.flowId, run.nodeId, run.providerId, run.scope);
  const plannedCommands = uniqueIds([
    ...(command ? [command] : []),
    ...(providerCommand(provider) ? [providerCommand(provider) as string] : []),
    ...(bundle.project.settings.defaultBuildCommand.trim() ? [bundle.project.settings.defaultBuildCommand.trim()] : []),
    ...run.plannedCommands
  ]);
  const plannedAllowedRoots = uniqueIds([projectRoot, ...bundle.project.settings.filesystem.allowedRoots, ...run.plannedAllowedRoots]);
  const planArtifact = await writeRunPlanArtifact(projectRoot, {
    runId: run.id,
    flowId: run.flowId,
    nodeId: run.nodeId,
    promptSummary: run.promptSummary,
    providerId: run.providerId,
    plannedCommands,
    plannedAllowedRoots,
    scope
  });
  const createdAt = iso();
  const retry = buildRetryRun(run, {
    status: scopeDenied ? "failed" : needsPermission ? "needs-permission" : command ? "queued" : "planning",
    phase: scopeDenied ? "complete" : needsPermission ? "coding" : "planning",
    command,
    cwd,
    risk,
    filesystemScope: scope ? {
      policy: scope.policy,
      cwd: scope.cwd,
      allowedRoots: scope.allowedRoots,
      violations: scope.violations
    } : undefined,
    webSearch: {
      decision: bundle.project.settings.webSearch.enabled ? "allowed" : "denied",
      reason: bundle.project.settings.webSearch.enabled
        ? "Web search is enabled in project settings for this run."
        : "Web search is disabled in project settings."
    },
    guidance,
    permission: {
      decision: command ? (scopeDenied ? "denied" : needsPermission ? "pending" : "allowed") : "allowed",
      reusablePolicyId: reusablePolicy?.id ?? run.permission.reusablePolicyId,
      reason: command
        ? scopeDenied
          ? `Filesystem scope denied: ${scope?.violations.join(" ")}`
          : needsPermission
            ? `Command risk is ${risk}; approval is required to retry.`
            : reusablePolicy
              ? `Allowed by reusable policy ${reusablePolicy.id}.`
              : "Allowed to retry this run."
        : "Retrying this run from planning."
    },
    contextSummary: context.summary,
    contextArtifacts: uniqueIds([...run.contextArtifacts, ...context.artifacts.map((artifact) => artifact.id), planArtifact.id]),
    planArtifactIds: uniqueIds([planArtifact.id, ...run.planArtifactIds]),
    affectedNodeIds: run.affectedNodeIds.length ? run.affectedNodeIds : run.nodeId ? [run.nodeId] : [],
    plannedCommands,
    plannedAllowedRoots,
    todos: [
      { id: id("todo"), text: "Refresh relevant JSON project context", status: "done" },
      { id: id("todo"), text: "Create retry plan", status: "done" },
      { id: id("todo"), text: command ? `Execute ${command}` : "Planning phase before coding", kind: command ? undefined : "planning-phase" as const, status: needsPermission || scopeDenied ? "blocked" : "doing" },
      { id: id("todo"), text: "Continue from the failed phase", status: "todo" }
    ],
    logs: [
      ...run.logs,
      { at: createdAt, stream: "system", text: "Retrying this run in the same queue entry." },
      ...(guidance?.text || guidance?.evidence.length ? [{ at: createdAt, stream: "system" as const, text: guidanceAttachedLog(guidance, "retry") }] : []),
      { at: createdAt, stream: "system", text: `Prepared context (${context.text.length} characters).` },
      { at: createdAt, stream: "system", text: `Plan artifact: ${planArtifact.path}` },
      { at: createdAt, stream: "system", text: scopeDenied ? `Blocked by filesystem scope: ${scope?.violations.join(" ")}` : needsPermission ? "Waiting for shell permission." : "Queued." }
    ],
    runInstructions: scopeDenied
      ? `Retry blocked by filesystem scope: ${scope?.violations.join(" ")}`
      : needsPermission
        ? "Approve the command to retry this run."
        : command
          ? "Retry queued in the same run."
          : "Retry will resume planning in this run.",
    completedAt: scopeDenied ? createdAt : undefined
  });

  await writeRun(projectRoot, scopeDenied ? await finalizeTerminalRun(projectRoot, retry, retry.runInstructions ?? "Retry blocked.") : retry);
  if (!needsPermission && !scopeDenied) {
    const guidanceText = await guidanceEvidenceText(projectRoot, run, guidance);
    const webContext = await harnessWebContext(bundle.project.settings.webSearch.enabled, run.promptSummary, guidance?.text);
    queuedContextTextByRun.set(run.id, [
      context.text,
      guidanceText ? `## ${guidanceContextHeading(guidance, "Retry Guidance")}\n\n${guidanceText}` : "",
      webContext
    ].filter(Boolean).join("\n\n"));
    void scheduleNextQueuedJob(projectRoot);
  }
  return { bundle: await loadProject(projectRoot), runId: run.id };
}

export async function retryRun(projectRoot: string, runId: string, guidanceInput?: Partial<RunGuidance>): Promise<{ bundle: ProjectBundle; runId: string }> {
  pendingTerminalCancellationRunIds.delete(runId);
  const requestedRun = await readRun(projectRoot, runId);
  const run = await retryResumeSourceRun(projectRoot, requestedRun);
  assertNoActiveRunLane(await loadProject(projectRoot), "retrying or resuming another run", run.id);
  const guidance = normalizeGuidance(guidanceInput);
  if (run.runProfileId) {
    return startRunProfileRetry(projectRoot, run);
  }
  const resumePhase = inferRetryResumePhase(run);
  if (resumePhase === "replan") {
    return startReplanRetry(projectRoot, run, guidance);
  }
  if (resumePhase === "plan-review") {
    const retry = await startPlanReviewRetry(projectRoot, run, guidance);
    if (retry) return retry;
  }
  if (resumePhase === "code-review") {
    const retry = await startCodeReviewRetry(projectRoot, run, guidance);
    if (retry) return retry;
  }
  if (resumePhase === "verification") {
    const retry = await startVerificationRetry(projectRoot, run, guidance);
    if (retry) return retry;
  }
  if (resumePhase === "debugging") {
    return startDebuggingRun(projectRoot, run.id, guidance);
  }
  if (resumePhase === "coding") {
    const retry = await startCodingRetry(projectRoot, run, guidance);
    if (retry) return retry;
  }
  return startFreshRetry(projectRoot, run, guidance);
}

export async function startDebuggingRun(
  projectRoot: string,
  runId: string,
  guidanceInput?: Partial<RunGuidance>,
  options: { origin?: Run["origin"] } = {}
): Promise<{ bundle: ProjectBundle; runId: string }> {
  return withRunCreationLock(projectRoot, () => startDebuggingRunUnlocked(projectRoot, runId, guidanceInput, options));
}

async function startDebuggingRunUnlocked(
  projectRoot: string,
  runId: string,
  guidanceInput?: Partial<RunGuidance>,
  options: { origin?: Run["origin"] } = {}
): Promise<{ bundle: ProjectBundle; runId: string }> {
  const failedRun = await readRun(projectRoot, runId);
  const debugEligible = failedRun.status === "failed" || (failedRun.status === "cancelled" && failedRun.stoppedAtPhase === "debugging");
  if (!debugEligible) {
    throw new Error(`Run ${failedRun.id} is ${failedRun.status}; ${pandoraAgent.name} can only start from a failed run or resume a cancelled debugging phase.`);
  }
  const guidance = normalizeGuidance(guidanceInput);
  const bundle = await loadProject(projectRoot);
  assertNoActiveRunLane(bundle, "debugging another run");
  const provider = bundle.project.settings.providers.find((item) => item.id === failedRun.providerId);
  if (!isCodeCapableProvider(provider)) {
    throw new Error("Debugging requires an LLM provider that can produce source changes or repair proposals.");
  }

  const context = await buildContext(projectRoot, failedRun.flowId, failedRun.nodeId, failedRun.providerId, failedRun.scope);
  const debugRunId = id("run");
  const planArtifact = await writeRunPlanArtifact(projectRoot, {
    runId: debugRunId,
    flowId: failedRun.flowId,
    nodeId: failedRun.nodeId,
    promptSummary: `Debug failed run ${failedRun.id}: ${failedRun.promptSummary}`,
    providerId: failedRun.providerId,
    plannedCommands: [
      ...(providerCommand(provider) ? [providerCommand(provider) as string] : []),
      ...(bundle.project.settings.defaultBuildCommand.trim() ? [bundle.project.settings.defaultBuildCommand.trim()] : [])
    ],
    plannedAllowedRoots: [projectRoot, ...bundle.project.settings.filesystem.allowedRoots]
  });
  const run: Run = runSchema.parse({
    id: debugRunId,
    flowId: failedRun.flowId,
    nodeId: failedRun.nodeId,
    providerId: failedRun.providerId,
    status: "debugging",
    phase: "debugging",
    origin: options.origin,
    promptSummary: `Debug failed run ${failedRun.id}: ${failedRun.promptSummary}`,
    retryOf: failedRun.id,
    guidance,
    scope: failedRun.scope,
    permission: {
      decision: "allowed",
      reason: "Debugging run uses provider/source-file proposal policy; direct write providers still request command approval if needed."
    },
    contextSummary: context.summary,
    contextArtifacts: [...context.artifacts.map((artifact) => artifact.id), planArtifact.id, ...failedRun.contextArtifacts, ...failedRun.sourceDiffArtifactIds],
    planArtifactIds: [planArtifact.id],
    sourceDiffArtifactIds: failedRun.sourceDiffArtifactIds,
    policyBaselineViolationIds: failedRun.policyBaselineViolationIds ?? architecturePolicyBaselineViolationIds(bundle),
    affectedNodeIds: failedRun.affectedNodeIds,
    plannedCommands: [
      ...(providerCommand(provider) ? [providerCommand(provider) as string] : []),
      ...(bundle.project.settings.defaultBuildCommand.trim() ? [bundle.project.settings.defaultBuildCommand.trim()] : [])
    ],
    plannedAllowedRoots: [projectRoot, ...bundle.project.settings.filesystem.allowedRoots],
    todos: [
      { id: id("todo"), text: "Inspect failed run logs, diffs, and affected nodes", status: "doing" },
      { id: id("todo"), text: "Produce minimal repair patch or focused question", status: "todo" },
      { id: id("todo"), text: "Verify repair with configured command", status: "todo" }
    ],
    logs: [
      { at: iso(), stream: "system", text: `Debugging failed run ${failedRun.id}.` },
      ...(guidance?.text || guidance?.evidence.length ? [{ at: iso(), stream: "system" as const, text: guidanceAttachedLog(guidance, "debug") }] : []),
      { at: iso(), stream: "system", text: failedRun.logs.slice(-12).map((line) => `[${line.stream}] ${line.text}`).join("\n") }
    ],
    runInstructions: `${pandoraAgent.name} uses low-temperature/high-reasoning defaults and should make the smallest repair before verification.`,
    createdAt: iso(),
    startedAt: iso()
  });
  await writeRun(projectRoot, run);
  const guidanceText = await guidanceEvidenceText(projectRoot, failedRun, guidance);
  const webContext = await harnessWebContext(bundle.project.settings.webSearch.enabled, failedRun.promptSummary, guidance?.text);
  queuedContextTextByRun.set(run.id, [
    context.text,
    guidanceText ? `## ${guidanceContextHeading(guidance, "Debug Evidence")}\n\n${guidanceText}` : "",
    webContext
  ].filter(Boolean).join("\n\n"));
  void scheduleNextQueuedJob(projectRoot);
  return { bundle: await loadProject(projectRoot), runId: run.id };
}

export async function startRuntimeDebugRun(input: {
  projectRoot: string;
  serviceId: string;
  flowId?: string;
  providerId: string;
  guidance?: Partial<RunGuidance>;
}): Promise<{ bundle: ProjectBundle; runId: string }> {
  return withRunCreationLock(input.projectRoot, () => startRuntimeDebugRunUnlocked(input));
}

async function startRuntimeDebugRunUnlocked(input: {
  projectRoot: string;
  serviceId: string;
  flowId?: string;
  providerId: string;
  guidance?: Partial<RunGuidance>;
}): Promise<{ bundle: ProjectBundle; runId: string }> {
  const bundle = await loadProject(input.projectRoot);
  assertNoActiveRunLane(bundle, "debugging runtime output");
  const service = [...activeRuntimeServices.values()]
    .map((entry) => entry.service)
    .find((item) => item.id === input.serviceId && normalizeForCompare(item.projectRoot) === normalizeForCompare(input.projectRoot));
  if (!service) throw new Error("Runtime service was not found.");
  const provider = bundle.project.settings.providers.find((item) => item.id === input.providerId);
  if (!isCodeCapableProvider(provider)) {
    throw new Error("Runtime debugging requires an enabled provider that can produce source changes or repair proposals.");
  }
  const flowId = input.flowId ?? bundle.project.activeFlowId;
  const guidance = normalizeGuidance({
    ...input.guidance,
    runtimeServiceId: service.id,
    evidence: [...new Set([...(input.guidance?.evidence ?? []), "runtime-log" as const])]
  });
  const context = await buildContext(input.projectRoot, flowId, undefined, input.providerId);
  const runId = id("run");
  const planArtifact = await writeRunPlanArtifact(input.projectRoot, {
    runId,
    flowId,
    promptSummary: `Debug runtime output: ${service.label}`,
    providerId: input.providerId,
    plannedCommands: [
      ...(providerCommand(provider) ? [providerCommand(provider) as string] : []),
      service.command,
      ...(bundle.project.settings.defaultBuildCommand.trim() ? [bundle.project.settings.defaultBuildCommand.trim()] : [])
    ],
    plannedAllowedRoots: [input.projectRoot, ...bundle.project.settings.filesystem.allowedRoots]
  });
  const runtimeText = runtimeLogTextForGuidance(input.projectRoot, guidance);
  const userEvidence = await guidanceEvidenceText(input.projectRoot, runSchema.parse({
    id: runId,
    flowId,
    providerId: input.providerId,
    status: "debugging",
    phase: "debugging",
    promptSummary: `Debug runtime output: ${service.label}`,
    permission: { decision: "allowed" },
    logs: service.logs.slice(-80),
    createdAt: iso()
  }), guidance);
  const run = runSchema.parse({
    id: runId,
    flowId,
    providerId: input.providerId,
    status: "debugging",
    phase: "debugging",
    promptSummary: `Debug runtime output: ${service.label}`,
    runProfileId: service.profileId,
    guidance,
    scope: { kind: "flow", flowId, nodeIds: [], label: service.label },
    permission: {
      decision: "allowed",
      reason: "Runtime debug uses rolling service logs, run profile details, and selected user guidance."
    },
    contextSummary: context.summary,
    contextArtifacts: [...context.artifacts.map((artifact) => artifact.id), planArtifact.id],
    planArtifactIds: [planArtifact.id],
    policyBaselineViolationIds: architecturePolicyBaselineViolationIds(bundle),
    plannedCommands: [
      ...(providerCommand(provider) ? [providerCommand(provider) as string] : []),
      service.command,
      ...(bundle.project.settings.defaultBuildCommand.trim() ? [bundle.project.settings.defaultBuildCommand.trim()] : [])
    ],
    plannedAllowedRoots: [input.projectRoot, ...bundle.project.settings.filesystem.allowedRoots],
    todos: [
      { id: id("todo"), text: "Inspect runtime service logs and profile", status: "doing" },
      { id: id("todo"), text: "Produce minimal repair patch or focused question", status: "todo" },
      { id: id("todo"), text: "Verify repair with configured command", status: "todo" }
    ],
    logs: [
      { at: iso(), stream: "system", text: `Debugging runtime service ${service.label}.` },
      ...(guidance?.text || guidance?.evidence.length ? [{ at: iso(), stream: "system" as const, text: guidanceAttachedLog(guidance, "runtime debug") }] : []),
      { at: iso(), stream: "system", text: runtimeText || "Runtime service has no captured output yet." }
    ],
    runInstructions: `${pandoraAgent.name} fixes the smallest cause visible in service logs and avoids unrelated feature work.`,
    createdAt: iso(),
    startedAt: iso()
  });
  await writeRun(input.projectRoot, run);
  const webContext = await harnessWebContext(bundle.project.settings.webSearch.enabled, service.command, guidance?.text);
  queuedContextTextByRun.set(run.id, [
    context.text,
    "## Runtime Debug Context",
    runtimeText,
    userEvidence ? ["## User-Selected Runtime Debug Evidence", userEvidence].join("\n\n") : "",
    webContext
  ].filter(Boolean).join("\n\n"));
  void scheduleNextQueuedJob(input.projectRoot);
  return { bundle: await loadProject(input.projectRoot), runId: run.id };
}

export async function reportBug(input: {
  projectRoot: string;
  flowId?: string;
  nodeId?: string;
  title: string;
  description: string;
  priority?: DebugIncident["priority"];
  artifactIds?: string[];
  filePaths?: string[];
}): Promise<ProjectBundle> {
  const bundle = await loadProject(input.projectRoot);
  const flowId = input.flowId || bundle.project.activeFlowId;
  const title = input.title.trim();
  const description = input.description.trim();
  if (!title) throw new Error("Bug report needs a title.");
  if (!description) throw new Error("Bug report needs a description.");
  const imageArtifacts = await createImageArtifacts(input.projectRoot, input.filePaths ?? [], {
    nodeId: input.nodeId,
    summary: "Image attached to a bug report."
  });
  const incident = debugIncidentSchema.parse({
    id: id("incident"),
    source: "manual-report",
    title,
    description,
    priority: input.priority ?? "normal",
    status: "open",
    flowId,
    nodeId: input.nodeId,
    artifactIds: [...(input.artifactIds ?? []), ...imageArtifacts.map((artifact) => artifact.id)],
    createdAt: iso(),
    updatedAt: iso()
  });
  await writeJson(projectStatePath(input.projectRoot, "incidents", `${incident.id}.json`), incident);
  await touchProject(input.projectRoot);
  return loadProject(input.projectRoot);
}

export async function updateBugIncident(input: {
  projectRoot: string;
  incidentId: string;
  patch: Partial<Pick<DebugIncident, "title" | "description" | "priority" | "status">>;
}): Promise<ProjectBundle> {
  const bundle = await loadProject(input.projectRoot);
  const incident = bundle.incidents.find((item) => item.id === input.incidentId);
  if (!incident) throw new Error(`Bug report ${input.incidentId} was not found.`);
  const updated = debugIncidentSchema.parse({
    ...incident,
    ...input.patch,
    title: input.patch.title === undefined ? incident.title : input.patch.title.trim(),
    description: input.patch.description === undefined ? incident.description : input.patch.description.trim(),
    updatedAt: iso()
  });
  if (!updated.title) throw new Error("Bug report needs a title.");
  if (!updated.description) throw new Error("Bug report needs a description.");
  await writeJson(projectStatePath(input.projectRoot, "incidents", `${updated.id}.json`), updated);
  await touchProject(input.projectRoot);
  return loadProject(input.projectRoot);
}

type DebugIncidentInput = Pick<DebugIncident, "source" | "title" | "description" | "priority" | "flowId" | "nodeId" | "noteId" | "runId" | "runtimeServiceId" | "artifactIds">;

function collectOpenDebugIncidents(bundle: ProjectBundle, runtimeServices: RuntimeService[], flowId?: string, incidentIds?: string[]): DebugIncidentInput[] {
  const inRequestedFlow = (candidateFlowId?: string): boolean => !flowId || !candidateFlowId || candidateFlowId === flowId;
  const selectedIncidentIds = incidentIds?.length ? new Set(incidentIds) : null;
  const manualIncidents = bundle.incidents
    .filter((incident) => incident.status === "open" && inRequestedFlow(incident.flowId) && (!selectedIncidentIds || selectedIncidentIds.has(incident.id)))
    .map((incident): DebugIncidentInput => ({
      source: incident.source,
      title: incident.title,
      description: incident.description,
      priority: incident.priority,
      flowId: incident.flowId,
      nodeId: incident.nodeId,
      noteId: incident.noteId,
      runId: incident.runId,
      runtimeServiceId: incident.runtimeServiceId,
      artifactIds: incident.artifactIds
    }));
  const noteIncidents = bundle.notes
    .filter((note) => note.category === "bug" && !note.resolved && inRequestedFlow(note.flowId))
    .map((note): DebugIncidentInput => ({
      source: "note",
      title: `Bug note on ${bundle.flows.flatMap((flow) => flow.nodes).find((node) => node.id === note.nodeId)?.title ?? note.nodeId}`,
      description: note.body,
      priority: note.priority,
      flowId: note.flowId,
      nodeId: note.nodeId,
      noteId: note.id,
      artifactIds: note.attachmentIds
    }));
  const failedRunIncidents = bundle.runs
    .filter((run) => run.status === "failed" && !run.queueRemovedAt && !run.errorDismissedAt && inRequestedFlow(run.flowId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-5)
    .map((run): DebugIncidentInput => ({
      source: "failed-run",
      title: `Failed run: ${run.promptSummary}`,
      description: run.logs.slice(-16).map((line) => `[${line.stream}] ${line.text}`).join("\n"),
      priority: "high",
      flowId: run.flowId,
      nodeId: run.nodeId,
      runId: run.id,
      artifactIds: [...run.contextArtifacts, ...run.planArtifactIds, ...run.sourceDiffArtifactIds]
    }));
  const runtimeIncidents = runtimeServices
    .filter((service) => service.status === "failed" || service.status === "stale")
    .map((service): DebugIncidentInput => ({
      source: "runtime-service",
      title: `Runtime ${service.status}: ${service.label}`,
      description: [
        `Command: ${service.command}`,
        `cwd: ${service.relativeCwd || "."}`,
        ...service.logs.slice(-16).map((line) => `[${line.stream}] ${line.text}`)
      ].join("\n"),
      priority: "high",
      runtimeServiceId: service.id,
      artifactIds: []
    }));
  return selectedIncidentIds ? manualIncidents : [...manualIncidents, ...noteIncidents, ...failedRunIncidents, ...runtimeIncidents];
}

function debugIncidentContextText(incidents: DebugIncidentInput[]): string {
  return incidents.map((incident, index) => [
    `## ${index + 1}. ${incident.title}`,
    `source: ${incident.source}`,
    `priority: ${incident.priority}`,
    incident.flowId ? `flowId: ${incident.flowId}` : undefined,
    incident.nodeId ? `nodeId: ${incident.nodeId}` : undefined,
    incident.noteId ? `noteId: ${incident.noteId}` : undefined,
    incident.runId ? `runId: ${incident.runId}` : undefined,
    incident.runtimeServiceId ? `runtimeServiceId: ${incident.runtimeServiceId}` : undefined,
    incident.artifactIds.length ? `artifactIds: ${incident.artifactIds.join(", ")}` : undefined,
    "",
    incident.description
  ].filter((line): line is string => line !== undefined).join("\n")).join("\n\n");
}

export async function startIncidentDebugRun(input: {
  projectRoot: string;
  flowId?: string;
  providerId: string;
  incidentIds?: string[];
  guidance?: Partial<RunGuidance>;
}): Promise<{ bundle: ProjectBundle; runId: string }> {
  return withRunCreationLock(input.projectRoot, () => startIncidentDebugRunUnlocked(input));
}

async function startIncidentDebugRunUnlocked(input: {
  projectRoot: string;
  flowId?: string;
  providerId: string;
  incidentIds?: string[];
  guidance?: Partial<RunGuidance>;
}): Promise<{ bundle: ProjectBundle; runId: string }> {
  const bundle = await loadProject(input.projectRoot);
  assertNoActiveRunLane(bundle, `starting ${pandoraAgent.name}`);
  const provider = bundle.project.settings.providers.find((item) => item.id === input.providerId);
  if (!isCodeCapableProvider(provider)) {
    throw new Error(`${pandoraAgent.title} requires an enabled provider that can produce source changes or repair proposals.`);
  }
  const runtimeServices = await listRuntimeServices(input.projectRoot);
  const flowId = input.flowId || bundle.project.activeFlowId;
  const incidents = collectOpenDebugIncidents(bundle, runtimeServices, flowId, input.incidentIds);
  if (!incidents.length) {
    throw new Error("No open bug reports, bug notes, failed runs, or failed runtime services were found to debug.");
  }
  const context = await buildContext(input.projectRoot, flowId, undefined, input.providerId);
  const incidentText = debugIncidentContextText(incidents);
  const guidance = normalizeGuidance(input.guidance);
  const debugRunId = id("run");
  const planArtifact = await writeRunPlanArtifact(input.projectRoot, {
    runId: debugRunId,
    flowId,
    promptSummary: "Debug open flagged bugs and failed incidents",
    providerId: input.providerId,
    plannedCommands: [
      ...(providerCommand(provider) ? [providerCommand(provider) as string] : []),
      ...(bundle.project.settings.defaultBuildCommand.trim() ? [bundle.project.settings.defaultBuildCommand.trim()] : [])
    ],
    plannedAllowedRoots: [input.projectRoot, ...bundle.project.settings.filesystem.allowedRoots]
  });
  const affectedNodeIds = [...new Set(incidents.map((incident) => incident.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId)))];
  const run = runSchema.parse({
    id: debugRunId,
    flowId,
    providerId: input.providerId,
    status: "debugging",
    phase: "debugging",
    promptSummary: "Debug open flagged bugs and failed incidents",
    guidance,
    scope: affectedNodeIds.length
      ? { kind: "nodes", flowId, nodeIds: affectedNodeIds, label: "Open debug incidents" }
      : { kind: "flow", flowId, nodeIds: [], label: "Open debug incidents" },
    permission: {
      decision: "allowed",
      reason: `${pandoraAgent.name} uses explicit bug reports, bug notes, failed run logs, and failed runtime services as incident context.`
    },
    contextSummary: context.summary,
    contextArtifacts: [...context.artifacts.map((artifact) => artifact.id), planArtifact.id, ...new Set(incidents.flatMap((incident) => incident.artifactIds))],
    planArtifactIds: [planArtifact.id],
    sourceDiffArtifactIds: [],
    policyBaselineViolationIds: architecturePolicyBaselineViolationIds(bundle),
    affectedNodeIds,
    plannedCommands: [
      ...(providerCommand(provider) ? [providerCommand(provider) as string] : []),
      ...(bundle.project.settings.defaultBuildCommand.trim() ? [bundle.project.settings.defaultBuildCommand.trim()] : [])
    ],
    plannedAllowedRoots: [input.projectRoot, ...bundle.project.settings.filesystem.allowedRoots],
    todos: [
      { id: id("todo"), text: "Triage open bug reports, bug notes, failed runs, and failed runtime services", status: "doing" },
      { id: id("todo"), text: "Make the smallest repair that addresses the incidents", status: "todo" },
      { id: id("todo"), text: "Verify fixes with the configured build/test command", status: "todo" }
    ],
    logs: [
      { at: iso(), stream: "system", text: `AI Debug started with ${incidents.length} open incident${incidents.length === 1 ? "" : "s"}. ${pandoraAgent.title} owns this recovery run.` },
      ...(guidance?.text || guidance?.evidence.length ? [{ at: iso(), stream: "system" as const, text: guidanceAttachedLog(guidance, "incident debug") }] : []),
      { at: iso(), stream: "system", text: incidentText }
    ],
    runInstructions: `${pandoraAgent.name} fixes flagged bugs and regressions only. Avoid feature work unless required to resolve an incident.`,
    createdAt: iso(),
    startedAt: iso()
  });
  await writeRun(input.projectRoot, run);
  const guidanceText = await guidanceEvidenceText(input.projectRoot, run, guidance);
  const webContext = await harnessWebContext(bundle.project.settings.webSearch.enabled, run.promptSummary, guidance?.text);
  queuedContextTextByRun.set(run.id, [
    context.text,
    "# Open Debug Incidents",
    incidentText,
    guidanceText ? `## ${guidanceContextHeading(guidance, "Incident Debug Guidance")}\n\n${guidanceText}` : "",
    webContext,
    "# Debug Instructions",
    "Fix open bugs and regressions only. Do not implement unrelated features. Prefer minimal patches. Verify with configured build/test commands when possible."
  ].filter(Boolean).join("\n\n"));
  void scheduleNextQueuedJob(input.projectRoot);
  return { bundle: await loadProject(input.projectRoot), runId: run.id };
}

async function addReusableShellPolicy(projectRoot: string, policy: ProjectSettings["shellPolicies"][number]): Promise<void> {
  const project = (await loadProject(projectRoot)).project;
  await writeReusableShellPolicy(projectRoot, project, policy);
}

async function writeReusableShellPolicy(projectRoot: string, project: Project, policy: ProjectSettings["shellPolicies"][number]): Promise<void> {
  const policies = project.settings.shellPolicies.filter((item) => item.id !== policy.id);
  await writeProjectFiles(projectRoot, projectSchema.parse({
    ...project,
    settings: {
      ...project.settings,
      shellPolicies: [...policies, policy]
    },
    updatedAt: iso()
  }));
}

async function runQueuedJob(projectRoot: string, runId: string, contextText?: string): Promise<void> {
  let run = await readRun(projectRoot, runId);
  if (run.status === "cancelled") return;
  if (run.status === "planning") {
    await completePlanningRun(projectRoot, run, contextText);
    return;
  }
  if (run.status === "coding") {
    await completeCodingRun(projectRoot, run, contextText);
    return;
  }
  if (run.status === "debugging") {
    await completeCodingRun(projectRoot, run, contextText);
    return;
  }
  if (run.status === "verifying") {
    await completeVerificationRun(projectRoot, run);
    return;
  }
  run = runSchema.parse({
    ...run,
    status: "running",
    phase: run.command
      ? run.phase === "verifying" || isVerificationCommand(run.command)
        ? "verifying"
        : "coding"
      : run.phase,
    todos: run.todos.map((todo) => todo.status === "todo" ? { ...todo, status: "doing" } : todo),
    logs: [...run.logs, { at: iso(), stream: "system", text: "Run started." }],
    startedAt: run.startedAt ?? iso()
  });
  await writeRun(projectRoot, run);

  if (run.runProfileId) {
    await executeRunProfile(projectRoot, run);
    return;
  }

  if (run.command) {
    await executeCommandStreaming(projectRoot, run);
    return;
  }

  const context = contextText ?? (await buildContext(projectRoot, run.flowId, run.nodeId, run.providerId, run.scope)).text;
  await completeProviderRun(projectRoot, run, (await loadProject(projectRoot)).project.settings.providers.find((provider) => provider.id === run.providerId), context);
  const completed = await readRun(projectRoot, run.id);
  publishRunUpdateEvent(projectRoot, completed);
}

type QueueLease = {
  pid: number;
  token: string;
  acquiredAt: string;
  renewedAt: string;
};

function queueLeasePath(projectRoot: string): string {
  return projectStatePath(projectRoot, "runtime", "queue-lease.json");
}

// The lane cycles (release + re-acquire) after every queued job, so a live
// holder refreshes renewedAt far more often than this. Exceeding it means the
// recorded pid almost certainly belongs to a recycled, unrelated process.
const QUEUE_LEASE_HARD_TTL_MS = 6 * 60 * 60 * 1000;
const QUEUE_LEASE_HEARTBEAT_MS = 30_000;

// A lease held by a live process is never stolen within the hard TTL, even
// with an old timestamp (a busy event loop must not cause another instance to
// double-run commands). A dead pid releases the lane implicitly.
function queueLeaseHeldByOtherLiveProcess(lease: QueueLease): boolean {
  if (lease.pid === process.pid) return false;
  const renewedAt = Date.parse(lease.renewedAt);
  if (Number.isFinite(renewedAt) && Date.now() - renewedAt > QUEUE_LEASE_HARD_TTL_MS) return false;
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The project run lane is guarded on disk so a second ArchiCode instance (or a
// future CLI) opening the same project refuses the lane instead of
// double-running queued jobs. Exclusive file creation is the mutex.
async function acquireQueueLease(projectRoot: string): Promise<string | null> {
  const leasePath = queueLeasePath(projectRoot);
  await mkdir(path.dirname(leasePath), { recursive: true });
  const token = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lease: QueueLease = { pid: process.pid, token, acquiredAt: iso(), renewedAt: iso() };
    try {
      await writeFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`, { flag: "wx" });
      return token;
    } catch {
      const existing = await readJson<QueueLease | null>(leasePath, null);
      if (existing && typeof existing.pid === "number") {
        if (existing.pid === process.pid && existing.token === token) return token;
        if (queueLeaseHeldByOtherLiveProcess(existing)) return null;
      }
      await rm(leasePath, { force: true }).catch(() => undefined);
    }
  }
  return null;
}

async function renewQueueLease(projectRoot: string, token: string): Promise<void> {
  const existing = await readJson<QueueLease | null>(queueLeasePath(projectRoot), null);
  if (existing?.pid !== process.pid || existing.token !== token) return;
  await writeJson(queueLeasePath(projectRoot), { ...existing, renewedAt: iso() });
}

async function releaseQueueLease(projectRoot: string, token: string): Promise<void> {
  const existing = await readJson<QueueLease | null>(queueLeasePath(projectRoot), null);
  if (existing?.pid !== process.pid || existing.token !== token) return;
  await rm(queueLeasePath(projectRoot), { force: true }).catch(() => undefined);
}

// Backstop for a phase handler throwing outside its own error handling: record
// the failure on the run so the lane can move on, instead of the rejection
// escaping to a void caller and wedging the run in an in-progress status.
async function failRunFromQueueError(projectRoot: string, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await flushRunLogAppends(runId);
    const latest = await readRun(projectRoot, runId);
    if (latest.status === "cancelled" || latest.status === "succeeded" || latest.status === "failed") return;
    const instructions = `Run failed with an unexpected harness error: ${compactSummary(message)}. Retry the run, or report a bug if it persists.`;
    const failed = runSchema.parse({
      ...latest,
      status: "failed",
      phase: "complete",
      todos: latest.todos.map((todo) => ({ ...todo, status: todo.status === "done" ? "done" : "blocked" })),
      logs: [...latest.logs, { at: iso(), stream: "stderr", text: `Unexpected harness error: ${message}` }],
      runInstructions: instructions,
      completedAt: latest.completedAt ?? iso()
    });
    await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, failed, instructions));
  } catch {
    // Recording the failure must never break the queue loop itself.
  }
}

async function scheduleNextQueuedJob(projectRoot: string): Promise<void> {
  const queueKey = normalizeForCompare(projectRoot);
  if (activeProjectQueues.has(queueKey)) return;

  activeProjectQueues.add(queueKey);
  let claimedRun = false;
  let leaseToken: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    leaseToken = await acquireQueueLease(projectRoot);
    if (!leaseToken) return;
    heartbeat = setInterval(() => {
      if (leaseToken) void renewQueueLease(projectRoot, leaseToken).catch(() => undefined);
    }, QUEUE_LEASE_HEARTBEAT_MS);
    heartbeat.unref?.();
    const runs = await readJsonDirectory<Run>(projectStatePath(projectRoot, "runs"));
    const nextRun = runs
      .flatMap((run) => {
        const parsed = runSchema.safeParse(run);
        return parsed.success ? [parsed.data] : [];
      })
      .filter((run) =>
        !pendingTerminalCancellationRunIds.has(run.id) &&
        (run.status === "queued" || run.status === "planning" || run.status === "coding" || run.status === "debugging" || run.status === "verifying")
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

    if (!nextRun) return;

    claimedRun = true;
    await renewQueueLease(projectRoot, leaseToken).catch(() => undefined);
    const contextText = queuedContextTextByRun.get(nextRun.id);
    queuedContextTextByRun.delete(nextRun.id);
    try {
      await runQueuedJob(projectRoot, nextRun.id, contextText);
    } catch (error) {
      await failRunFromQueueError(projectRoot, nextRun.id, error);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (leaseToken) await releaseQueueLease(projectRoot, leaseToken).catch(() => undefined);
    activeProjectQueues.delete(queueKey);
    if (claimedRun) void scheduleNextQueuedJob(projectRoot);
  }
}

function providerUsesArchicodeMcp(provider: ProjectSettings["providers"][number] | undefined): boolean {
  return provider?.kind === "openai-compatible" ||
    provider?.kind === "anthropic-compatible" ||
    provider?.kind === "codex-local" ||
    provider?.kind === "claude-local";
}

function isLocalProviderKind(kind: ProjectSettings["providers"][number]["kind"] | undefined): kind is "codex-local" | "claude-local" | "opencode-local" | "antigravity-local" | "grok-local" | "kimi-local" {
  return kind === "codex-local" || kind === "claude-local" || kind === "opencode-local" || kind === "antigravity-local" || kind === "grok-local" || kind === "kimi-local";
}

type LocalProviderMcpApprovalRequest = {
  serverId: string;
  serverLabel: string;
  toolName: string;
  providerToolName: string;
  argumentsJson?: string;
  intent?: string;
  originalOutput: string;
};

type LocalProviderSubagentRequest = {
  agent: "sherlock" | "picasso" | "delphi";
  input: Record<string, unknown>;
};

function readBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function collectJsonCandidates(output: string, key: string): string[] {
  const candidates = new Set<string>();
  const fenced = output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fenced) {
    const value = match[1]?.trim();
    if (value) candidates.add(value);
  }
  const keyIndex = output.indexOf(`"${key}"`);
  if (keyIndex >= 0) {
    const outerStart = output.lastIndexOf("{", keyIndex);
    const innerStart = output.indexOf("{", keyIndex + key.length + 2);
    const outer = outerStart >= 0 ? readBalancedObject(output, outerStart) : null;
    const inner = innerStart >= 0 ? readBalancedObject(output, innerStart) : null;
    if (outer) candidates.add(outer);
    if (inner) candidates.add(inner);
  }
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") continue;
    const object = readBalancedObject(output, index);
    if (object && object.includes(key)) candidates.add(object);
  }
  return [...candidates];
}

function extractLocalProviderMcpApprovalRequest(
  output: string,
  settings: ProjectSettings
): LocalProviderMcpApprovalRequest | null {
  const tools = providerMcpTools(settings);
  const candidates = collectJsonCandidates(output, "archicodeMcpRequest");
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const requestRecord = "archicodeMcpRequest" in (parsed as Record<string, unknown>)
        ? (parsed as Record<string, unknown>).archicodeMcpRequest
        : parsed;
      if (!requestRecord || typeof requestRecord !== "object") continue;
      const request = requestRecord as Record<string, unknown>;
      const serverId = typeof request.serverId === "string" ? request.serverId.trim() : "";
      const toolName = typeof request.toolName === "string" ? request.toolName.trim() : "";
      if (!serverId || !toolName) continue;
      const tool = tools.find((item) => item.serverId === serverId && item.toolName === toolName);
      const server = settings.mcp.servers.find((item) => item.id === serverId);
      if (!tool || !server || !server.enabled || server.trusted) continue;
      const args = request.arguments;
      const argumentsJson = args === undefined
        ? undefined
        : typeof args === "string"
          ? args
          : JSON.stringify(args);
      return {
        serverId,
        serverLabel: server.label,
        toolName,
        providerToolName: tool.providerToolName,
        argumentsJson,
        intent: typeof request.intent === "string" ? request.intent.trim() : undefined,
        originalOutput: output.trim()
      };
    } catch {
      // Ignore malformed JSON candidates and keep scanning.
    }
  }
  return null;
}

export function extractLocalProviderSubagentRequest(output: string): LocalProviderSubagentRequest | null {
  for (const candidate of collectJsonCandidates(output, "archicodeSubagentRequest")) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const outer = parsed as Record<string, unknown>;
      const value = outer.archicodeSubagentRequest ?? outer;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const request = value as Record<string, unknown>;
      if (request.agent !== "sherlock" && request.agent !== "picasso" && request.agent !== "delphi") continue;
      const input = request.input && typeof request.input === "object" && !Array.isArray(request.input)
        ? request.input as Record<string, unknown>
        : {};
      if (typeof input.objective !== "string" || !input.objective.trim()) continue;
      return { agent: request.agent, input };
    } catch {
      // Keep scanning candidates.
    }
  }
  return null;
}

function localProviderMcpPrompt(run: Run, settings: ProjectSettings, provider: ProjectSettings["providers"][number] | undefined): string {
  if (!isLocalProviderKind(provider?.kind)) return "";
  const enabledServers = settings.mcp.servers.filter((server) => server.enabled);
  if (!enabledServers.length) return "No external MCP servers are enabled for this run.";
  const approved = new Set(run.mcp?.approvedServerIds ?? []);
  const denied = new Set(run.mcp?.deniedServerIds ?? []);
  const lines = [
    "External MCP discovery for this run:",
    "Enabled servers stay visible to you for discovery. Trusted means auto-approved execution. Ask means pause and request approval on the exact tool call instead of pretending the server is unavailable."
  ];
  for (const server of enabledServers) {
    const mode = server.trusted || approved.has(server.id)
      ? "allow"
      : denied.has(server.id)
        ? "ask-denied-this-run"
        : "ask";
    lines.push(`- ${server.id} (${server.label}) [${mode}]: ${server.tools.length ? server.tools.map((tool) => tool.name).join(", ") : "no discovered tools yet"}`);
  }
  if (enabledServers.some((server) => !server.trusted && !approved.has(server.id))) {
    lines.push("When you need an Ask-mode MCP tool, stop and return exactly one JSON object with this shape: { \"archicodeMcpRequest\": { \"serverId\": \"context7\", \"toolName\": \"resolve-library-id\", \"arguments\": { ... }, \"intent\": \"one short sentence explaining why the tool is needed now\" } }.");
    lines.push("Do not mix that JSON object with prose. Use only listed enabled server ids and tool names. After approval or denial, ArchiCode will resume you in the same run with the result or denial reason.");
  }
  return lines.join("\n");
}

/**
 * Continuation text for a run resuming after a tool approval decision. Shared
 * by every provider kind: local CLI replays with its original output attached,
 * API providers replay the phase with the decision and result in the prompt.
 */
function runMcpResumePrompt(run: Run): string {
  const resume = run.mcp?.continuation?.resume;
  if (!resume) return "";
  const lines: string[] = [];
  lines.push("Continuation state for this same run:");
  if (resume.decision === "approved") {
    lines.push(`- Approved MCP tool call: ${resume.serverLabel} / ${resume.toolName}`);
    lines.push(`- Arguments JSON: ${resume.argumentsJson ?? "{}"}`);
    if (resume.resultText?.trim()) lines.push(`- Tool result:\n${resume.resultText.trim().slice(0, 12000)}`);
    lines.push("The user approved this call and it already executed. Continue from that exact point using the tool result. Do not re-request the same tool call.");
  } else {
    lines.push(`- Denied MCP tool call: ${resume.serverLabel} / ${resume.toolName}`);
    lines.push(`- Denial reason: ${resume.deniedReason ?? "Denied for this run."}`);
    lines.push("Continue the same run knowing that tool call is unavailable. Do not re-request the same denied call unless the user changes settings or explicitly tells you to retry.");
  }
  if (run.mcp?.continuation?.originalOutput.trim()) {
    lines.push("Your previous approval-turn output was:");
    lines.push(run.mcp.continuation.originalOutput.trim().slice(0, 12000));
  }
  return lines.join("\n");
}

function localProviderSubagentPrompt(settings: ProjectSettings, provider: ProjectSettings["providers"][number] | undefined): string {
  if (!isLocalProviderKind(provider?.kind)) return "";
  const agents = [
    ...(settings.agentTools.subagents?.sherlockResearch ?? true ? ["sherlock"] : []),
    ...(settings.agentTools.subagents?.graphReconciliation ?? true ? ["picasso"] : []),
    ...(settings.agentTools.subagents?.delphiTesting ?? true ? ["delphi"] : [])
  ];
  if (!agents.length) return "Long-work subagents are disabled for this project.";
  return [
    "Fresh-context delegation for this run:",
    `Available subagents: ${agents.join(", ")}.`,
    "Use delegation only for substantial work whose investigation trail would otherwise pollute this run's context. Do not delegate simple reads or routine edits.",
    "To delegate, stop the current response and return exactly one JSON object with this shape: { \"archicodeSubagentRequest\": { \"agent\": \"sherlock\" | \"picasso\" | \"delphi\", \"input\": { \"objective\": string, ... } } }.",
    "Sherlock input may also include mode (codebase/online/topic/mixed), scope, codePaths, and evidenceRequirements. Sherlock is read-only.",
    "Picasso input may also include mode (assess/design/refine/reconcile), scope, evidenceSummary, constraints, and detailLevel. Assess is read-only; Picasso's graph changes are proposal-only and always require review.",
    "Delphi input may also include mode (plan/audit/retest), visualInspection (none/capture/pixel), scope, codePaths, platforms, observation (visible/headless plus evidence preference), an explicit target (profileId/deviceId/baseUrl or a localhost appiumServerUrl plus existing appiumSessionId), target launch (never/if-needed), cleanup (stop-if-started/keep-running), acceptanceCriteria, and advisory command ideas. Set visualInspection explicitly: pixel only for requested model inspection of appearance/layout, capture for human-review screenshots, otherwise none. Give Delphi the goal and boundaries, not a command sequence or retry plan. Default to visible observation for interactive audits. Use launch if-needed when Delphi should start an existing Run App profile or emulator after approval. Missing supported adapters are downloaded only after user approval into ArchiCode's managed cache; Delphi never installs dependencies silently or into the project.",
    "Do not mix the request JSON with prose. ArchiCode will run the subagent and resume this same phase with a compact artifact-backed result. Do not request another subagent from inside a subagent result."
  ].join("\n");
}

/**
 * Thrown when a console command needs the user's manual approval mid-phase.
 * The run is already persisted as needs-permission with the pending tool call
 * when this propagates; phase error handlers must return quietly instead of
 * marking the run failed. Approve/Reject in the run console resumes the phase.
 */
export class RunConsoleApprovalPending extends Error {
  constructor(command: string) {
    super(`Waiting for user approval to run console command: ${command}`);
    this.name = "RunConsoleApprovalPending";
  }
}

function consoleCommandFromArguments(argumentsJson: string): string {
  try {
    const args = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
    return typeof args.command === "string" ? args.command.trim() : "";
  } catch {
    return "";
  }
}

async function pauseRunForConsoleApproval(
  projectRoot: string,
  runId: string,
  callId: string,
  input: { providerToolName: string; argumentsJson: string },
  command: string,
  risk: ShellCommandRisk
): Promise<void> {
  const latest = await readRun(projectRoot, runId);
  const at = iso();
  await writeRun(projectRoot, runSchema.parse({
    ...latest,
    status: "needs-permission",
    permission: {
      ...latest.permission,
      decision: "pending",
      reason: `The provider wants to run a ${risk}-risk console command: ${command}`
    },
    mcp: {
      decision: "pending",
      approvedServerIds: latest.mcp?.approvedServerIds ?? [],
      deniedServerIds: latest.mcp?.deniedServerIds ?? [],
      pendingServerIds: ["archicode-internal-tools"],
      pendingToolCall: {
        serverId: "archicode-internal-tools",
        serverLabel: "ArchiCode Tools",
        toolName: "run_command",
        providerToolName: input.providerToolName,
        argumentsJson: input.argumentsJson,
        intent: `Execute console command (${risk} risk): ${command}`,
        phase: latest.phase
      },
      continuation: {
        providerKind: "api",
        originalOutput: ""
      },
      reason: `Waiting for approval to run console command: ${command}`
    },
    mcpToolCalls: latest.mcpToolCalls.map((call) => call.id === callId
      ? { ...call, status: "approval-required", resultSummary: `Waiting for user approval to run: ${command}`, completedAt: at }
      : call),
    logs: [...latest.logs, { at, stream: "system", text: `Waiting for console command approval: ${command}` }]
  }));
}

async function pauseRunForDelphiSetupApproval(
  projectRoot: string,
  runId: string,
  callId: string,
  input: { providerToolName: string; argumentsJson: string },
  continuation?: { providerKind: "codex-local" | "claude-local" | "opencode-local" | "antigravity-local" | "grok-local" | "kimi-local" | "api"; originalOutput: string }
): Promise<void> {
  const latest = await readRun(projectRoot, runId);
  const setup = runDelphiSetupInputSchema.parse(JSON.parse(input.argumentsJson || "{}"));
  const at = iso();
  const summary = [
    `Managed adapters: ${setup.adapters.map((adapter) => adapter === "playwright" ? "Playwright" : "Appium").join(", ")}.`,
    setup.adapters.includes("playwright") ? `Browsers: ${setup.playwrightBrowsers.join(", ")}.` : "",
    setup.adapters.includes("appium") && setup.appiumDrivers.length ? `Drivers: ${setup.appiumDrivers.join(", ")}.` : ""
  ].filter(Boolean).join(" ");
  const hasExistingCall = latest.mcpToolCalls.some((call) => call.id === callId);
  const approvalCall: Run["mcpToolCalls"][number] = {
    id: callId,
    serverId: "archicode-subagents",
    serverLabel: "Subagents",
    toolName: "setup_delphi_managed_tools",
    argumentsJson: input.argumentsJson,
    status: "approval-required",
    resultSummary: `Waiting for managed Delphi setup approval. ${summary}`,
    startedAt: at,
    completedAt: at
  };
  await writeRun(projectRoot, runSchema.parse({
    ...latest,
    status: "needs-permission",
    permission: {
      ...latest.permission,
      decision: "pending",
      reason: `Delphi wants to download managed test tooling. ${summary}`
    },
    mcp: {
      decision: "pending",
      approvedServerIds: latest.mcp?.approvedServerIds ?? [],
      deniedServerIds: latest.mcp?.deniedServerIds ?? [],
      pendingServerIds: ["archicode-subagents"],
      pendingToolCall: {
        serverId: "archicode-subagents",
        serverLabel: "Subagents",
        toolName: "setup_delphi_managed_tools",
        providerToolName: input.providerToolName,
        argumentsJson: input.argumentsJson,
        intent: `Install missing Delphi components in ArchiCode's managed cache. ${summary}`,
        phase: latest.phase
      },
      continuation: {
        providerKind: continuation?.providerKind ?? "api",
        originalOutput: continuation?.originalOutput ?? ""
      },
      reason: `Waiting for approval to install managed Delphi tooling. ${summary}`
    },
    mcpToolCalls: hasExistingCall
      ? latest.mcpToolCalls.map((call) => call.id === callId
          ? { ...call, status: "approval-required", resultSummary: approvalCall.resultSummary, completedAt: at }
          : call)
      : [...latest.mcpToolCalls, approvalCall],
    logs: [...latest.logs, { at, stream: "system", text: `Waiting for managed Delphi setup approval. ${summary}` }]
  }));
}

async function pauseRunForDelphiAuditApproval(
  projectRoot: string,
  runId: string,
  callId: string,
  input: { providerToolName: string; argumentsJson: string },
  plan?: NonNullable<Awaited<ReturnType<typeof planDelphiRuntimeLaunch>>>,
  continuation?: { providerKind: "codex-local" | "claude-local" | "opencode-local" | "antigravity-local" | "grok-local" | "kimi-local" | "api"; originalOutput: string }
): Promise<void> {
  const latest = await readRun(projectRoot, runId);
  const delphiArgs = delphiTestingInputSchema.parse(JSON.parse(input.argumentsJson || "{}"));
  const at = iso();
  const summary = [
    delphiArgs.mode === "setup" && delphiArgs.setup
      ? `Managed setup before audit: ${delphiArgs.setup.adapters.join(", ")}${delphiArgs.setup.adapters.includes("playwright") ? ` (${delphiArgs.setup.playwrightBrowsers.join(", ")})` : ""}.`
      : "",
    "Verification capability: Delphi may choose relevant bounded project-local checks; every chosen action is dynamically safety-checked. Dependency setup, deployment, and source edits remain outside this audit.",
    delphiArgs.commands.length ? `Caller-suggested checks: ${delphiArgs.commands.join(" | ")}.` : "",
    delphiArgs.target?.baseUrl ? `Approved browser origin: ${new URL(delphiArgs.target.baseUrl).origin}.` : "",
    `Observation: ${delphiArgs.observation.mode}${delphiArgs.observation.capture === "none" ? "" : ` with ${delphiArgs.observation.capture} evidence capture`}.`,
    plan ? `Run App profile: ${plan.profileLabel} (${plan.profileId}).` : "",
    plan?.targetId ? `Target: ${plan.targetId}.` : "",
    plan?.occupiedPorts.length
      ? `Pre-existing port conflict: ${plan.occupiedPorts.join(", ")}. Delphi will not use or stop those listeners; ${plan.allowsReportedLocalFallback ? "it may use a localhost fallback URL reported by the exact approved runtime process" : "the audit will stop and ask for cleanup if the approved runtime cannot start"}.`
      : "",
    plan?.commands.length ? `Lifecycle commands: ${plan.commands.join(" | ")}.` : "",
    plan?.cleanupCommands.length ? `Owned-target cleanup: ${plan.cleanupCommands.join(" | ")}.` : ""
  ].filter(Boolean).join(" ");
  const hasExistingCall = latest.mcpToolCalls.some((call) => call.id === callId);
  const approvalCall: Run["mcpToolCalls"][number] = {
    id: callId,
    serverId: "archicode-subagents",
    serverLabel: "Subagents",
    toolName: "spawn_delphi",
    argumentsJson: input.argumentsJson,
    status: "approval-required",
    resultSummary: `Waiting for Delphi audit approval. ${summary}`,
    startedAt: at,
    completedAt: at
  };
  await writeRun(projectRoot, runSchema.parse({
    ...latest,
    status: "needs-permission",
    permission: {
      ...latest.permission,
      decision: "pending",
      reason: `${plan?.requiresLaunch ? "Delphi wants to start a runtime target and run the bounded audit." : "Delphi wants to run a bounded project verification audit."} ${summary}`
    },
    mcp: {
      decision: "pending",
      approvedServerIds: latest.mcp?.approvedServerIds ?? [],
      deniedServerIds: latest.mcp?.deniedServerIds ?? [],
      pendingServerIds: ["archicode-subagents"],
      pendingToolCall: {
        serverId: "archicode-subagents",
        serverLabel: "Subagents",
        toolName: "spawn_delphi",
        providerToolName: input.providerToolName,
        argumentsJson: input.argumentsJson,
        intent: `${plan?.requiresLaunch ? "Start the selected Run App target, " : ""}Grant Delphi the bounded project-verification capability${plan?.requiresLaunch ? ", and clean up only Delphi-owned processes" : ""}. ${summary}`,
        phase: latest.phase
      },
      continuation: {
        providerKind: continuation?.providerKind ?? "api",
        originalOutput: continuation?.originalOutput ?? ""
      },
      reason: `Waiting for Delphi audit approval. ${summary}`
    },
    mcpToolCalls: hasExistingCall
      ? latest.mcpToolCalls.map((call) => call.id === callId
          ? { ...call, argumentsJson: input.argumentsJson, status: "approval-required", resultSummary: approvalCall.resultSummary, completedAt: at }
          : call)
      : [...latest.mcpToolCalls, approvalCall],
    logs: [...latest.logs, { at, stream: "system", text: `Waiting for Delphi audit approval. ${summary}` }]
  }));
}

async function pinDelphiTestingCommands(projectRoot: string, rawArgs: unknown): Promise<DelphiTestingInput> {
  const args = delphiTestingInputSchema.parse(rawArgs);
  const { inspectDelphiTestEnvironment, pinDelphiRuntimeTarget } = await import("../testing/toolchains");
  const environment = await inspectDelphiTestEnvironment(projectRoot, args);
  return pinDelphiRuntimeTarget(args, environment);
}

function prepareDelphiManagedPreflightFromEnvironment(
  args: DelphiTestingInput,
  environment: { toolchains: Array<{ adapter: string; status: string; installPlan?: { scope: string } }> }
): DelphiTestingInput {
  if (args.mode === "plan" || args.mode === "setup") return args;
  const adapters = Array.from(new Set(environment.toolchains.flatMap((toolchain) =>
    toolchain.status === "missing"
      && (toolchain.adapter === "playwright" || toolchain.adapter === "appium")
      && toolchain.installPlan?.scope === "managed-cache"
      ? [toolchain.adapter]
      : []
  )));
  if (!adapters.length) return args;
  return delphiTestingInputSchema.parse({
    ...args,
    mode: "setup",
    setup: {
      adapters,
      playwrightBrowsers: ["chromium"],
      appiumDrivers: [
        ...(args.platforms.includes("android") ? ["uiautomator2" as const] : []),
        ...(args.platforms.includes("ios") ? ["xcuitest" as const] : [])
      ],
      resumeMode: args.mode === "retest" ? "retest" : "audit"
    }
  });
}

async function prepareDelphiApprovalArguments(projectRoot: string, rawArgs: unknown): Promise<DelphiTestingInput> {
  const args = delphiTestingInputSchema.parse(rawArgs);
  const { inspectDelphiTestEnvironment, pinDelphiRuntimeTarget } = await import("../testing/toolchains");
  const environment = await inspectDelphiTestEnvironment(projectRoot, args);
  return prepareDelphiManagedPreflightFromEnvironment(pinDelphiRuntimeTarget(args, environment), environment);
}

async function executeRunMcpTool(
  projectRoot: string,
  runId: string,
  settings: ProjectSettings,
  mcpTools: ProviderMcpTool[],
  input: { providerToolName: string; argumentsJson: string },
  execOptions?: { approvedByUser?: boolean }
): Promise<string> {
  const normalized = normalizeProjectToolArguments(projectRoot, input.providerToolName, input.argumentsJson);
  let effectiveInput = normalized.changed ? { ...input, argumentsJson: normalized.argumentsJson } : input;
  const startedAt = iso();
  const started = await readRun(projectRoot, runId);
  const tool = mcpTools.find((item) => item.providerToolName === input.providerToolName);
  const callId = id("mcp-call");
  await writeRun(projectRoot, runSchema.parse({
    ...started,
    mcpToolCalls: [
      ...started.mcpToolCalls,
      {
        id: callId,
        serverId: tool?.serverId ?? "unknown",
        serverLabel: tool?.serverLabel,
        toolName: tool?.toolName ?? input.providerToolName,
        argumentsJson: effectiveInput.argumentsJson,
        status: "started",
        startedAt
      }
    ],
    logs: [
      ...started.logs,
      ...(normalized.changed
        ? [{ at: startedAt, stream: "system" as const, text: `Normalized absolute project path arguments for ${tool?.toolName ?? input.providerToolName} before execution.` }]
        : []),
      { at: startedAt, stream: "system", text: `${isArchicodeInternalTool(input.providerToolName) ? "ArchiCode tool" : "MCP tool"} started: ${tool?.serverLabel ?? "unknown"} / ${tool?.toolName ?? input.providerToolName}` }
    ]
  }));
  try {
    if (effectiveInput.providerToolName === RUN_SPAWN_DELPHI_TOOL && !execOptions?.approvedByUser) {
      const delphiArgs = await prepareDelphiApprovalArguments(projectRoot, JSON.parse(effectiveInput.argumentsJson || "{}"));
      effectiveInput = { ...effectiveInput, argumentsJson: JSON.stringify(delphiArgs) };
      const launchPlan = await planDelphiRuntimeLaunch(projectRoot, delphiArgs);
      if (delphiArgs.mode !== "plan") {
        await pauseRunForDelphiAuditApproval(projectRoot, runId, callId, effectiveInput, launchPlan);
        throw new RunConsoleApprovalPending("Delphi audit");
      }
    }
    if (effectiveInput.providerToolName === RUN_SETUP_DELPHI_TOOL && !execOptions?.approvedByUser) {
      await pauseRunForDelphiSetupApproval(projectRoot, runId, callId, effectiveInput);
      throw new RunConsoleApprovalPending("Delphi managed-tool setup");
    }
    const output = isRunSubagentTool(input.providerToolName)
      ? await executeRunSubagentTool(projectRoot, runId, settings, effectiveInput)
      : isArchicodeInternalTool(input.providerToolName)
      ? await callArchicodeInternalTool({
          projectRoot,
          settings,
          loadProject: () => loadProject(projectRoot),
          readArtifactText: (artifactPath) => readArtifactText(projectRoot, artifactPath),
          runConsoleCommand: (args) => runInternalConsoleCommand(projectRoot, settings, args, { approvalGranted: execOptions?.approvedByUser })
        }, effectiveInput)
      : await callMcpTool(settings, effectiveInput);
    const resultText = output.resultText;
    if (input.providerToolName === RUN_SPAWN_DELPHI_TOOL) {
      try {
        const compact = JSON.parse(resultText) as {
          status?: unknown;
          managedSetup?: { adapters?: unknown; playwrightBrowsers?: unknown; appiumDrivers?: unknown };
        };
        const setup = runDelphiSetupInputSchema.safeParse(compact.managedSetup);
        if (compact.status === "needs-setup" && setup.success && setup.data.adapters.length) {
          const continuation = started.mcp?.continuation;
          await pauseRunForDelphiSetupApproval(projectRoot, runId, callId, {
            providerToolName: RUN_SETUP_DELPHI_TOOL,
            argumentsJson: JSON.stringify(setup.data)
          }, continuation ? {
            providerKind: continuation.providerKind,
            originalOutput: continuation.originalOutput
          } : undefined);
          throw new RunConsoleApprovalPending("Delphi managed-tool setup");
        }
      } catch (error) {
        if (error instanceof RunConsoleApprovalPending) throw error;
        // A malformed compact result is recorded normally; it is not allowed
        // to synthesize or silently execute a setup request.
      }
    }
    // A gated console command pauses the run for the user's decision instead of
    // handing the model a dead-end "approval-required" receipt. Local CLI
    // providers keep the receipt: their transport cannot pause mid-invocation.
    if (input.providerToolName === "archicode_console_run_command" && resultText.includes("\"approval-required\"")) {
      const parsed = JSON.parse(resultText) as { status?: string; command?: string; risk?: string };
      const providerKind = settings.providers.find((item) => item.id === started.providerId)?.kind;
      if (parsed.status === "approval-required" && !isLocalProviderKind(providerKind)) {
        const command = parsed.command ?? consoleCommandFromArguments(effectiveInput.argumentsJson);
        await pauseRunForConsoleApproval(projectRoot, runId, callId, effectiveInput, command, (parsed.risk as ShellCommandRisk) ?? "high");
        throw new RunConsoleApprovalPending(command);
      }
    }
    const latest = await readRun(projectRoot, runId);
    await writeRun(projectRoot, runSchema.parse({
      ...latest,
      mcpToolCalls: latest.mcpToolCalls.map((call) => call.id === callId
        ? {
            ...call,
            serverId: output.serverId,
            serverLabel: output.serverLabel,
            toolName: output.toolName,
            status: "succeeded",
            resultSummary: resultText.slice(0, 1000),
            completedAt: iso()
          }
        : call),
      logs: [...latest.logs, { at: iso(), stream: "system", text: `${output.serverId === "archicode-internal-tools" ? "ArchiCode tool" : "MCP tool"} succeeded: ${output.serverLabel} / ${output.toolName}` }]
    }));
    return resultText;
  } catch (error) {
    // The pause path already persisted the run and its call record.
    if (error instanceof RunConsoleApprovalPending) throw error;
    const latest = await readRun(projectRoot, runId);
    const message = error instanceof Error ? error.message : String(error);
    await writeRun(projectRoot, runSchema.parse({
      ...latest,
      mcpToolCalls: latest.mcpToolCalls.map((call) => call.id === callId
        ? { ...call, status: "failed", error: message, completedAt: iso() }
        : call),
      logs: [
        ...latest.logs,
        { at: iso(), stream: "stderr", text: `${isArchicodeInternalTool(input.providerToolName) ? "ArchiCode tool" : "MCP tool"} failed: ${message}` },
        ...(isRepairableProjectToolError(input.providerToolName, error)
          ? [{ at: iso(), stream: "system" as const, text: `${isArchicodeInternalTool(input.providerToolName) ? "ArchiCode tool" : "MCP tool"} returned repair guidance to the provider for another attempt.` }]
          : [])
      ]
    }));
    if (isRepairableProjectToolError(input.providerToolName, error)) {
      return repairableProjectToolResult(input.providerToolName, error);
    }
    throw error;
  }
}

const RUN_SPAWN_SHERLOCK_TOOL = "archicode_spawn_sherlock";
const RUN_SPAWN_PICASSO_TOOL = "archicode_spawn_picasso";
const RUN_SPAWN_DELPHI_TOOL = "archicode_spawn_delphi";
const RUN_SETUP_DELPHI_TOOL = "archicode_setup_delphi_managed_tools";
const runDelphiSetupInputSchema = z.object({
  adapters: z.array(z.enum(["playwright", "appium"])).min(1),
  playwrightBrowsers: z.array(z.enum(["chromium", "firefox", "webkit"])).default(["chromium"]),
  appiumDrivers: z.array(z.enum(["uiautomator2", "xcuitest"])).default([])
});

function isRunSubagentTool(providerToolName: string): boolean {
  return providerToolName === RUN_SPAWN_SHERLOCK_TOOL || providerToolName === RUN_SPAWN_PICASSO_TOOL || providerToolName === RUN_SPAWN_DELPHI_TOOL || providerToolName === RUN_SETUP_DELPHI_TOOL;
}

export function runSubagentTools(settings: ProjectSettings): ProviderMcpTool[] {
  const tools: ProviderMcpTool[] = [];
  if (settings.agentTools.subagents?.sherlockResearch ?? true) {
    tools.push({
      providerToolName: RUN_SPAWN_SHERLOCK_TOOL,
      serverId: "archicode-subagents",
      serverLabel: "Subagents",
      toolName: "spawn_sherlock",
      description: "Delegate a substantial read-only codebase, online, or topic investigation to Sherlock in a fresh context. Returns a compact artifact-backed evidence dossier. Do not use for simple lookups.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: {
          objective: { type: "string" },
          mode: { type: "string", enum: ["codebase", "online", "topic", "mixed"] },
          scope: { type: "string" },
          codePaths: { type: "array", items: { type: "string" } },
          evidenceRequirements: { type: "array", items: { type: "string" } }
        }
      }
    });
  }
  if (settings.agentTools.subagents?.graphReconciliation ?? true) {
    tools.push({
      providerToolName: RUN_SPAWN_PICASSO_TOOL,
      serverId: "archicode-subagents",
      serverLabel: "Subagents",
      toolName: "spawn_picasso",
      description: "Delegate substantial graph design, refinement, or reconciliation to Picasso in a fresh context. Picasso is proposal-only; its graph operations always require review.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: {
          objective: { type: "string" },
          mode: { type: "string", enum: ["assess", "design", "refine", "reconcile"] },
          scope: {
            type: "object",
            additionalProperties: false,
            properties: {
              flowId: { type: "string" },
              nodeIds: { type: "array", items: { type: "string" } }
            }
          },
          evidenceSummary: { type: "string" },
          constraints: { type: "array", items: { type: "string" } },
          detailLevel: { type: "string", enum: ["focused", "detailed", "exhaustive"] }
        }
      }
    });
  }
  if (settings.agentTools.subagents?.delphiTesting ?? true) {
    tools.push({
      providerToolName: RUN_SPAWN_DELPHI_TOOL,
      serverId: "archicode-subagents",
      serverLabel: "Subagents",
      toolName: "spawn_delphi",
      description: "Delegate a bounded test, visual, runtime, or emulator audit to Delphi in a fresh context. Delphi can approval-gated start an explicit Run App target, wait for readiness, test it, and stop only what it started. It never installs dependencies silently and returns an artifact-backed report.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: {
          objective: { type: "string" },
          mode: { type: "string", enum: ["plan", "audit", "retest"] },
          visualInspection: { type: "string", enum: ["none", "capture", "pixel"], description: "Explicit visual coverage contract; never infer this from objective wording." },
          scope: { type: "string" },
          codePaths: { type: "array", items: { type: "string" } },
          platforms: { type: "array", items: { type: "string", enum: ["web", "electron", "flutter", "android", "ios", "generic"] } },
          observation: {
            type: "object",
            additionalProperties: false,
            properties: {
              mode: { type: "string", enum: ["visible", "headless"] },
              capture: { type: "string", enum: ["key-steps", "final", "none"] }
            }
          },
          target: {
            type: "object",
            additionalProperties: false,
            properties: {
              profileId: { type: "string" },
              deviceId: { type: "string" },
              baseUrl: { type: "string" },
              appiumServerUrl: { type: "string" },
              appiumSessionId: { type: "string" },
              launch: { type: "string", enum: ["never", "if-needed"] },
              cleanup: { type: "string", enum: ["stop-if-started", "keep-running"] }
            }
          },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          commands: { type: "array", maxItems: 20, items: { type: "string" }, description: "Optional advisory check ideas, not an authorization list." }
        }
      }
    });
    tools.push({
      providerToolName: RUN_SETUP_DELPHI_TOOL,
      serverId: "archicode-subagents",
      serverLabel: "Subagents",
      toolName: "setup_delphi_managed_tools",
      description: "Request approval to install missing Delphi Playwright/Appium components in ArchiCode's managed cache, never in the project. Delphi's normal audit preflight does this automatically when required; use this explicit tool only to prepare tooling without immediately running an audit. The exact setup pauses the run for user approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["adapters"],
        properties: {
          adapters: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: ["playwright", "appium"] } },
          playwrightBrowsers: { type: "array", uniqueItems: true, items: { type: "string", enum: ["chromium", "firefox", "webkit"] } },
          appiumDrivers: { type: "array", uniqueItems: true, items: { type: "string", enum: ["uiautomator2", "xcuitest"] } }
        }
      }
    });
  }
  return tools;
}

function runPhaseForSubagent(run: Run): LlmPhase {
  if (run.phase === "coding" || run.phase === "debugging" || run.phase === "planning") return run.phase;
  return "planning";
}

export async function executeRunSubagentTool(
  projectRoot: string,
  runId: string,
  settings: ProjectSettings,
  input: { providerToolName: string; argumentsJson: string }
): Promise<{ serverId: string; serverLabel: string; toolName: string; resultText: string }> {
  let args = input.argumentsJson.trim() ? JSON.parse(input.argumentsJson) as Record<string, unknown> : {};
  const run = await readRun(projectRoot, runId);
  if (input.providerToolName === RUN_SETUP_DELPHI_TOOL) {
    if (!(settings.agentTools.subagents?.delphiTesting ?? true)) throw new Error("Delphi is disabled in project settings.");
    const setup = runDelphiSetupInputSchema.parse(args);
    const results: Awaited<ReturnType<typeof installDelphiManagedTool>>[] = [];
    for (const adapter of setup.adapters) {
      results.push(await installDelphiManagedTool(projectRoot, {
        adapter,
        playwrightBrowsers: adapter === "playwright" ? setup.playwrightBrowsers : undefined,
        appiumDrivers: adapter === "appium" ? setup.appiumDrivers : undefined
      }, {
        signal: activeRunAbortControllers.get(runId)?.signal,
        onProgress: (message) => queueRunLogAppend(projectRoot, runId, "system", `Delphi setup: ${message}`)
      }));
    }
    await flushRunLogAppends(runId);
    const artifact: Artifact = artifactSchema.parse({
      id: id("artifact"),
      type: "generated-file",
      title: `Delphi managed-tool setup for ${runId}`,
      path: `.archicode/artifacts/${runId}-delphi-managed-setup-${Date.now()}.json`,
      runId,
      summary: `Installed managed Delphi adapter${results.length === 1 ? "" : "s"}: ${results.map((result) => `${result.adapter} ${result.version ?? ""}`.trim()).join(", ")}.`,
      createdAt: iso()
    });
    await writeJson(path.join(projectRoot, artifact.path), { ...artifact, setup, results });
    const latest = await readRun(projectRoot, runId);
    await writeRun(projectRoot, runSchema.parse({
      ...latest,
      contextArtifacts: Array.from(new Set([...latest.contextArtifacts, artifact.id])),
      logs: [...latest.logs, { at: iso(), stream: "system", text: `${artifact.summary} Report: ${artifact.path}` }]
    }));
    return {
      serverId: "archicode-subagents",
      serverLabel: "Subagents",
      toolName: "setup_delphi_managed_tools",
      resultText: JSON.stringify({
        status: "completed",
        installed: results.map((result) => ({ adapter: result.adapter, version: result.version, browsersPath: result.browsersPath })),
        reportArtifact: { id: artifact.id, path: artifact.path },
        next: "Call Delphi again with the original audit objective and target."
      })
    };
  }
  const bundle = await loadProject(projectRoot);
  const provider = bundle.project.settings.providers.find((item) => item.id === run.providerId);
  if (!provider) throw new Error(`Provider ${run.providerId} was not found for the subagent.`);
  const kind = input.providerToolName === RUN_SPAWN_SHERLOCK_TOOL ? "sherlock-research"
    : input.providerToolName === RUN_SPAWN_DELPHI_TOOL ? "delphi-testing"
      : "graph-reconciliation";
  const displayName = kind === "sherlock-research" ? "Sherlock" : kind === "delphi-testing" ? "Delphi" : "Picasso";
  queueRunLogAppend(projectRoot, runId, "system", `${displayName} subagent started in a fresh context.`);
  let runtimeLease: DelphiRuntimeLease | undefined;
  let runtimeStopped = false;
  let cleanupError: string | undefined;
  const delphiSetupResults: Awaited<ReturnType<typeof installDelphiManagedTool>>[] = [];
  const delphiObservedArtifacts: Array<{ id: string; label: string; path: string; mediaType: string }> = [];
  if (kind === "delphi-testing") {
    let delphiArgs: DelphiTestingInput = delphiTestingInputSchema.parse(args);
    delphiArgs = await pinDelphiTestingCommands(projectRoot, delphiArgs);
    if (delphiArgs.mode === "setup") {
      if (!delphiArgs.setup) throw new Error("The Delphi audit preflight is missing its managed setup plan.");
      for (const adapter of delphiArgs.setup.adapters) {
        delphiSetupResults.push(await installDelphiManagedTool(projectRoot, {
          adapter,
          playwrightBrowsers: adapter === "playwright" ? delphiArgs.setup.playwrightBrowsers : undefined,
          appiumDrivers: adapter === "appium" ? delphiArgs.setup.appiumDrivers : undefined
        }, {
          signal: activeRunAbortControllers.get(runId)?.signal,
          onProgress: (message) => queueRunLogAppend(projectRoot, runId, "system", `Delphi setup: ${message}`)
        }));
      }
      delphiArgs = delphiTestingInputSchema.parse({
        ...delphiArgs,
        mode: delphiArgs.setup.resumeMode,
        setup: undefined
      });
    }
    if (delphiArgs.mode !== "plan") {
      runtimeLease = await acquireDelphiRuntimeTarget(projectRoot, delphiArgs, {
        signal: activeRunAbortControllers.get(runId)?.signal,
        onProgress: (message) => queueRunLogAppend(projectRoot, runId, "system", `Delphi: ${message}`)
      });
      if (runtimeLease) {
        delphiArgs = delphiTestingInputSchema.parse({
          ...delphiArgs,
          target: {
            ...delphiArgs.target,
            baseUrl: delphiArgs.target?.baseUrl ?? runtimeLease.service.url,
            deviceId: runtimeLease.service.runTargetId ?? runtimeLease.service.targetId ?? delphiArgs.target?.deviceId
          }
        });
      }
    }
    args = delphiArgs as unknown as Record<string, unknown>;
  }
  const result = await executeMicroRun(
      projectRoot,
      kind,
      args,
      await hydrateProviderForUse(provider),
      bundle,
      {
        signal: activeRunAbortControllers.get(runId)?.signal,
        runConsoleCommand: kind === "delphi-testing" || kind === "sherlock-research"
          ? (commandArgs) => {
              return runInternalConsoleCommand(projectRoot, settings, commandArgs, {
                authorization: {
                  actor: kind === "delphi-testing" ? "delphi" : "sherlock",
                  capabilities: kind === "delphi-testing"
                    ? ["inspect-project", "verify-project"]
                    : ["inspect-project"]
                },
                maxTimeoutMs: 10 * 60_000,
                signal: activeRunAbortControllers.get(runId)?.signal
              });
            }
          : undefined,
        onProgress: (message) => queueRunLogAppend(projectRoot, runId, "system", `${displayName}: ${message}`),
        onArtifact: kind === "delphi-testing" ? (artifact) => {
          if (!delphiObservedArtifacts.some((entry) => entry.id === artifact.id)) delphiObservedArtifacts.push(artifact);
          queueRunLogAppend(projectRoot, runId, "system", `Delphi observation: ${artifact.label} (${artifact.path})`);
        } : undefined
      }
    ).finally(async () => {
      if (kind !== "delphi-testing") return;
      try {
        runtimeStopped = await releaseDelphiRuntimeTarget(
          projectRoot,
          runtimeLease,
          delphiTestingInputSchema.parse(args),
          (message) => queueRunLogAppend(projectRoot, runId, "system", `Delphi: ${message}`)
        );
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
        queueRunLogAppend(projectRoot, runId, "stderr", `Delphi target cleanup failed: ${cleanupError}`);
      }
    });
  await flushRunLogAppends(runId);
  if (result.usage) await persistRunUsage(projectRoot, runId, runPhaseForSubagent(run), [result.usage]);

  const artifact: Artifact = artifactSchema.parse({
    id: id("artifact"),
    type: "generated-file",
    title: `${displayName} report for ${runId}`,
    path: `.archicode/artifacts/${runId}-${kind}-${result.id}.json`,
    runId,
    summary: result.status === "failed" ? result.error : `${displayName} completed its isolated assignment.`,
    createdAt: iso()
  });
  await writeJson(path.join(projectRoot, artifact.path), {
    ...artifact,
    runtime: runtimeLease ? {
      profileId: runtimeLease.plan.profileId,
      serviceId: runtimeLease.service.id,
      targetId: runtimeLease.service.targetId,
      runTargetId: runtimeLease.service.runTargetId,
      url: runtimeLease.service.url,
      startedByDelphi: runtimeLease.startedByDelphi,
      stoppedAfterAudit: runtimeStopped,
      cleanupError
    } : undefined,
    managedSetup: delphiSetupResults,
    observedArtifacts: delphiObservedArtifacts,
    microRun: result
  });

  let reviewArtifact: Artifact | undefined;
  if (kind === "graph-reconciliation" && result.status !== "failed") {
    const output = result.output as PicassoGraphOutput | undefined;
    const changeSet = output?.graphChangeSet as { summary?: unknown; operations?: unknown } | undefined;
    if (changeSet && typeof changeSet.summary === "string" && Array.isArray(changeSet.operations) && changeSet.operations.length) {
      const validatedChangeSet = researchGraphChangeSetSchema.omit({ id: true, createdAt: true }).safeParse({
        summary: changeSet.summary,
        operations: changeSet.operations
      });
      if (!validatedChangeSet.success) {
        throw new Error(`Picasso returned an invalid graph-only proposal: ${validatedChangeSet.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join(" | ")}`);
      }
      const disallowedOperation = validatedChangeSet.data.operations.find((operation) => !REVIEWABLE_GRAPH_OPERATION_KINDS.has(operation.kind));
      if (disallowedOperation) {
        throw new Error(`Picasso may only propose graph operations, but returned ${disallowedOperation.kind}.`);
      }
      const proposal = await persistAndMaybeApplyPatchProposal(projectRoot, runId, JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          runId,
          summary: validatedChangeSet.data.summary,
          operations: validatedChangeSet.data.operations.map((operation) => ({
            kind: "propose-graph-operation",
            operation
          }))
        }
      }), {
        phase: "planning",
        forceManualReview: true,
        artifactSuffix: `picasso-${result.id}`
      });
      reviewArtifact = proposal?.artifact;
    }
  }

  const latest = await readRun(projectRoot, runId);
  await writeRun(projectRoot, runSchema.parse({
    ...latest,
    contextArtifacts: Array.from(new Set([
      ...latest.contextArtifacts,
      artifact.id,
      ...(reviewArtifact ? [reviewArtifact.id] : [])
    ])),
    logs: [
      ...latest.logs,
      {
        at: iso(),
        stream: result.status === "failed" || cleanupError ? "stderr" : "system",
        text: cleanupError
          ? `${displayName} completed its audit but failed to clean up its owned runtime target: ${cleanupError}. Full report: ${artifact.path}`
          : `${displayName} ${result.status === "failed" ? "failed" : "completed"}. Full report: ${artifact.path}${reviewArtifact ? `; graph proposal awaiting review: ${reviewArtifact.path}` : ""}`
      }
    ]
  }));
  if (result.status === "failed") throw new Error(result.error ?? `${displayName} failed.`);
  if (cleanupError) throw new Error(`Delphi completed its audit but could not clean up its owned runtime target: ${cleanupError}. Full report: ${artifact.path}`);

  const compact = kind === "sherlock-research"
    ? (() => {
        const output = result.output as SherlockResearchOutput;
        return {
          agent: "Sherlock",
          summary: output.summary,
          findingCount: output.findings.length,
          openQuestions: output.openQuestions,
          reportArtifact: { id: artifact.id, path: artifact.path }
        };
      })()
    : kind === "delphi-testing"
      ? (() => {
          const output = result.output as DelphiTestingOutput;
          return {
            agent: "Delphi",
            status: output.status,
            verdict: output.verdict,
            summary: output.summary,
            checkCount: output.checks.length,
            findingCount: output.findings.length,
            blockers: output.blockers,
            runtime: runtimeLease ? {
              profileId: runtimeLease.plan.profileId,
              serviceId: runtimeLease.service.id,
              targetId: runtimeLease.service.targetId,
              runTargetId: runtimeLease.service.runTargetId,
              url: runtimeLease.service.url,
              startedByDelphi: runtimeLease.startedByDelphi,
              stoppedAfterAudit: runtimeStopped,
              cleanupError
            } : undefined,
            managedSetup: {
              adapters: Array.from(new Set(output.toolchains.flatMap((toolchain) =>
                toolchain.status === "missing"
                  && (toolchain.adapter === "playwright" || toolchain.adapter === "appium")
                  && toolchain.installPlan?.scope === "managed-cache"
                  ? [toolchain.adapter]
                  : []
              ))),
              playwrightBrowsers: ["chromium"],
              appiumDrivers: [
                ...(args.platforms instanceof Array && args.platforms.includes("android") ? ["uiautomator2"] : []),
                ...(args.platforms instanceof Array && args.platforms.includes("ios") ? ["xcuitest"] : [])
              ]
            },
            recommendedNextSteps: output.recommendedNextSteps,
            reportArtifact: { id: artifact.id, path: artifact.path }
          };
        })()
      : (() => {
        const output = result.output as PicassoGraphOutput;
        const changeSet = output.graphChangeSet as { operations?: unknown[] } | undefined;
        return {
          agent: "Picasso",
          summary: output.designReport,
          operationCount: changeSet?.operations?.length ?? 0,
          openQuestions: output.openQuestions,
          reportArtifact: { id: artifact.id, path: artifact.path },
          reviewArtifact: reviewArtifact ? { id: reviewArtifact.id, path: reviewArtifact.path } : undefined
        };
      })();
  return {
    serverId: "archicode-subagents",
    serverLabel: "Subagents",
    toolName: input.providerToolName === RUN_SPAWN_SHERLOCK_TOOL ? "spawn_sherlock" : input.providerToolName === RUN_SPAWN_DELPHI_TOOL ? "spawn_delphi" : "spawn_picasso",
    resultText: JSON.stringify(compact)
  };
}

export async function runInternalConsoleCommand(projectRoot: string, settings: ProjectSettings, args: Record<string, unknown>, options?: { approvalGranted?: boolean; authorization?: AgentCommandAuthorization; maxTimeoutMs?: number; signal?: AbortSignal }): Promise<InternalConsoleCommandResult> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) throw new Error("command is required.");
  const rawCwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
  const resolvedProjectRoot = path.resolve(projectRoot);
  const cwd = path.isAbsolute(rawCwd)
    ? path.resolve(rawCwd)
    : path.resolve(resolvedProjectRoot, rawCwd || ".");
  const relativeCwd = path.relative(resolvedProjectRoot, cwd).split(path.sep).join("/");
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) throw new Error("Console tool cwd escapes the project root.");
  const safety = await assessAgentCommandSafety({
    projectRoot,
    settings,
    command,
    cwd,
    authorization: options?.authorization ?? {
      actor: "other-subagent",
      exactCommandApproved: options?.approvalGranted
    }
  });
  const risk = safety.risk;
  if (safety.decision === "denied") {
    return {
      command,
      cwd: relativeCwd || ".",
      risk,
      status: "denied",
      message: safety.reason
    };
  }
  if (safety.decision === "redirect") {
    return {
      command,
      cwd: relativeCwd || ".",
      risk,
      status: "redirected",
      message: safety.reason
    };
  }
  if (safety.decision === "approval-required") {
    return {
      command,
      cwd: relativeCwd || ".",
      risk,
      status: "approval-required",
      message: safety.reason
    };
  }
  const maximumTimeoutMs = Math.min(10 * 60_000, Math.max(1_000, options?.maxTimeoutMs ?? 60_000));
  const timeoutMs = Math.min(maximumTimeoutMs, Math.max(1_000, typeof args.timeoutMs === "number" ? Math.floor(args.timeoutMs) : maximumTimeoutMs));
  if (options?.signal?.aborted) {
    return { command, cwd: relativeCwd || ".", risk, status: "failed", exitCode: null, message: "Command cancelled before it started." };
  }
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: buildSubprocessEnv(process.env, { CI: "true" })
    });
    let stdout = "";
    let stderr = "";
    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (stream === "stdout") {
        stdout += chunk.toString();
        if (stdout.length > 30_000) stdout = stdout.slice(-30_000);
      } else {
        stderr += chunk.toString();
        if (stderr.length > 30_000) stderr = stderr.slice(-30_000);
      }
    };
    const timeout = setTimeout(() => {
      stderr += `${stderr.endsWith("\n") || !stderr ? "" : "\n"}Command timed out after ${timeoutMs}ms.`;
      child.kill("SIGTERM");
    }, timeoutMs);
    const abort = (): void => {
      stderr += `${stderr.endsWith("\n") || !stderr ? "" : "\n"}Command cancelled.`;
      child.kill("SIGTERM");
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", abort);
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.on("error", (error) => {
      cleanup();
      resolve({ command, cwd: relativeCwd || ".", risk, status: "failed", exitCode: null, stdout, stderr: stderr || error.message });
    });
    child.on("close", (exitCode) => {
      cleanup();
      resolve({ command, cwd: relativeCwd || ".", risk, status: exitCode === 0 ? "succeeded" : "failed", exitCode, stdout, stderr });
    });
  });
}

function sourceHandoffTools(): ProviderMcpTool[] {
  return [
    {
      providerToolName: SOURCE_FILE_HANDOFF_TOOL,
      serverId: "archicode-source-handoff",
      serverLabel: "Source Handoff",
      toolName: "submit_source_file",
      description: "Stage exactly one complete project source file proposal. Call this tool once per file; you may issue many file calls in the same response. A malformed or semantically stale call receives targeted repair guidance without discarding accepted files. After the first submission, do not call other tools because staged files are not on disk yet; finish the batch.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "action", "nodeIds"],
        properties: {
          path: { type: "string", minLength: 1, description: "Project-relative file path." },
          action: { type: "string", enum: ["create", "replace", "delete"] },
          content: { type: "string", description: "Complete final file content for create/replace. Omit for delete." },
          baseSha256: { type: "string", description: "Current sha256 returned by read_file when replacing an existing file." },
          nodeId: { type: "string", description: "Legacy single-node form; prefer nodeIds." },
          nodeIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 }, description: "One or more IDs from sourceAttribution.allowedNodes that this file change implements or supports." },
          reason: { type: "string" },
          testIntent: { type: "string" }
        }
      }
    },
    {
      providerToolName: SOURCE_BATCH_FINISH_TOOL,
      serverId: "archicode-source-handoff",
      serverLabel: "Source Handoff",
      toolName: "finish_source_batch",
      description: "Finish the current staged source batch. Call exactly once in the same response after all file calls. Use complete after the final source slice; ArchiCode applies files, installs dependencies, and verifies afterward. Use continue only when concrete source files remain, never merely to wait for apply/build/test/verification.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["implementationStatus", "summary"],
        properties: {
          implementationStatus: { type: "string", enum: ["complete", "continue", "blocked"] },
          summary: { type: "string", minLength: 1 },
          notes: { type: "string" },
          verificationNotes: { type: "string" },
          nextSourceSlice: { type: "string" },
          needsReplan: { type: "boolean" },
          replanReason: { type: "string" },
          suggestedQuestions: { type: "array", items: { type: "string" } }
        }
      }
    }
  ];
}

function isSourceHandoffTool(providerToolName: string): boolean {
  return providerToolName === SOURCE_FILE_HANDOFF_TOOL || providerToolName === SOURCE_BATCH_FINISH_TOOL;
}

function beginSourceToolBatch(runId: string, batchNumber: number, sourceSnapshot: SourceSnapshot): void {
  stagedSourceToolBatches.set(runId, {
    batchNumber,
    sourceSnapshot: new Map(sourceSnapshot),
    sourceSubmissionStarted: false,
    operations: new Map(),
    repairs: new Map(),
    toolCalls: []
  });
}

function clearSourceToolBatch(runId: string): void {
  stagedSourceToolBatches.delete(runId);
}

function prepareSourceToolBatch(runId: string, calls: Array<{ providerToolName: string }>): void {
  const batch = stagedSourceToolBatches.get(runId);
  if (!batch) return;
  if (calls.some((call) => call.providerToolName === SOURCE_FILE_HANDOFF_TOOL)) {
    batch.sourceSubmissionStarted = true;
  }
}

function normalizeSourceHandoffPath(filePath: string): string | null {
  const normalized = filePath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(filePath)) return null;
  if (normalized.split("/").some((part) => part === ".." || part === "")) return null;
  return normalized;
}

function sourceHandoffSemanticCheck(
  batch: StagedSourceToolBatch,
  proposed: SourceFileProposal
): { success: true; operation: SourceFileProposal; repairMethod?: string } | { success: false; path: string; error: string; currentSha256?: string } {
  const normalizedPath = normalizeSourceHandoffPath(proposed.path);
  if (!normalizedPath) {
    return { success: false, path: proposed.path, error: "path must be a clean project-relative path without traversal" };
  }
  let operation: SourceFileProposal = { ...proposed, path: normalizedPath };
  const currentContent = batch.sourceSnapshot.get(normalizedPath);
  const proposedContent = operation.content === undefined ? undefined : proposedSourceContent(operation.content);
  if (operation.action === "replace" && currentContent === undefined) {
    operation = { ...operation, action: "create", baseSha256: undefined };
    return { success: true, operation, repairMethod: "missing-replace-to-create" };
  }
  if (operation.action === "create" && currentContent !== undefined && proposedContent !== currentContent) {
    return {
      success: false,
      path: normalizedPath,
      error: "create targets an existing file; resend it as replace using the current baseSha256",
      currentSha256: createHash("sha256").update(currentContent).digest("hex")
    };
  }
  if (operation.action === "replace" && currentContent !== undefined && proposedContent !== currentContent) {
    const currentSha256 = createHash("sha256").update(currentContent).digest("hex");
    if (operation.baseSha256 !== currentSha256) {
      return {
        success: false,
        path: normalizedPath,
        error: operation.baseSha256
          ? "replace baseSha256 does not match the current file"
          : "replace is missing the current file's baseSha256",
        currentSha256
      };
    }
  }
  return { success: true, operation };
}

function appendStagedToolCall(
  batch: StagedSourceToolBatch,
  input: {
    providerToolName: string;
    serverId: string;
    serverLabel?: string;
    toolName: string;
    argumentsJson?: string;
    accepted: boolean;
    resultSummary: string;
    error?: string;
  }
): void {
  const at = iso();
  batch.toolCalls.push({
    id: id("mcp-call"),
    serverId: input.serverId,
    serverLabel: input.serverLabel,
    toolName: input.toolName,
    argumentsJson: input.argumentsJson,
    status: input.accepted ? "succeeded" : "failed",
    resultSummary: input.resultSummary,
    error: input.error,
    startedAt: at,
    completedAt: at
  });
}

function deferredToolReceipt(
  runId: string,
  tools: ProviderMcpTool[],
  input: { providerToolName: string; argumentsJson: string }
): string | null {
  const batch = stagedSourceToolBatches.get(runId);
  if (!batch?.sourceSubmissionStarted) return null;
  const tool = tools.find((item) => item.providerToolName === input.providerToolName);
  const error = `Deferred ${tool?.toolName ?? input.providerToolName}: source files are staged but not on disk. Finish the source batch now; ArchiCode will apply files and run authoritative verification.`;
  const at = iso();
  batch.toolCalls.push({
    id: id("mcp-call"),
    serverId: tool?.serverId ?? "unknown",
    serverLabel: tool?.serverLabel,
    toolName: tool?.toolName ?? input.providerToolName,
    argumentsJson: input.argumentsJson,
    status: "deferred",
    resultSummary: error,
    startedAt: at,
    completedAt: at
  });
  return JSON.stringify({
    accepted: false,
    deferredForSourceHandoff: true,
    error,
    instruction: `Call ${SOURCE_BATCH_FINISH_TOOL} now. Do not run tools against staged files.`
  });
}

function executeSourceHandoffTool(runId: string, input: { providerToolName: string; argumentsJson: string }): string {
  const batch = stagedSourceToolBatches.get(runId);
  if (!batch) {
    return JSON.stringify({
      accepted: false,
      error: "No source handoff batch is active. Return the normal phase handoff instead."
    });
  }

  if (input.providerToolName === SOURCE_FILE_HANDOFF_TOOL) {
    batch.sourceSubmissionStarted = true;
    const parsed = parseSourceFileToolArguments(input.argumentsJson);
    if (!parsed.success) {
      const pathLabel = parsed.pathHint || "this file";
      const receipt = {
        accepted: false,
        path: parsed.pathHint,
        error: parsed.error,
        instruction: `Resend only ${pathLabel} with ${SOURCE_FILE_HANDOFF_TOOL}. Previously accepted files remain staged, then call ${SOURCE_BATCH_FINISH_TOOL} again.`
      };
      appendStagedToolCall(batch, {
        providerToolName: input.providerToolName,
        serverId: "archicode-source-handoff",
        serverLabel: "Source Handoff",
        toolName: "submit_source_file",
        argumentsJson: JSON.stringify({ path: parsed.pathHint, rawArgumentChars: input.argumentsJson.length }),
        accepted: false,
        resultSummary: `Rejected malformed source handoff${parsed.pathHint ? ` for ${parsed.pathHint}` : ""}.`,
        error: parsed.error
      });
      return JSON.stringify(receipt);
    }
    const requestedAction = parsed.operation.action;
    const semantic = sourceHandoffSemanticCheck(batch, parsed.operation);
    if (!semantic.success) {
      const receipt = {
        accepted: false,
        path: semantic.path,
        requestedAction,
        error: semantic.error,
        currentSha256: semantic.currentSha256,
        instruction: `Resend only ${semantic.path} with ${SOURCE_FILE_HANDOFF_TOOL}${semantic.currentSha256 ? ` using baseSha256 ${semantic.currentSha256}` : ""}. Previously accepted files remain staged, then call ${SOURCE_BATCH_FINISH_TOOL} again.`
      };
      appendStagedToolCall(batch, {
        providerToolName: input.providerToolName,
        serverId: "archicode-source-handoff",
        serverLabel: "Source Handoff",
        toolName: "submit_source_file",
        argumentsJson: JSON.stringify({
          path: semantic.path,
          requestedAction,
          contentChars: parsed.operation.content?.length ?? 0,
          baseSha256Provided: Boolean(parsed.operation.baseSha256),
          parseRepairMethod: parsed.repairedBy
        }),
        accepted: false,
        resultSummary: `Rejected ${requestedAction} for ${semantic.path}: ${semantic.error}.`,
        error: semantic.error
      });
      return JSON.stringify(receipt);
    }
    const repairMethod = [parsed.repairedBy, semantic.repairMethod].filter(Boolean).join("+") || undefined;
    const replacedStagedProposal = batch.operations.has(semantic.operation.path);
    batch.operations.set(semantic.operation.path, semantic.operation);
    if (repairMethod) batch.repairs.set(semantic.operation.path, repairMethod);
    else batch.repairs.delete(semantic.operation.path);
    const receipt = {
      accepted: true,
      path: semantic.operation.path,
      requestedAction,
      action: semantic.operation.action,
      repaired: Boolean(repairMethod),
      repairMethod,
      replacedStagedProposal,
      stagedFileCount: batch.operations.size
    };
    appendStagedToolCall(batch, {
      providerToolName: input.providerToolName,
      serverId: "archicode-source-handoff",
      serverLabel: "Source Handoff",
      toolName: "submit_source_file",
      argumentsJson: JSON.stringify({
        path: semantic.operation.path,
        requestedAction,
        action: semantic.operation.action,
        contentChars: semantic.operation.content?.length ?? 0,
        baseSha256Provided: Boolean(semantic.operation.baseSha256),
        nodeIds: sourceFileProposalNodeIds(semantic.operation),
        repairMethod
      }),
      accepted: true,
      resultSummary: `Accepted ${semantic.operation.action} for ${semantic.operation.path}${repairMethod ? ` after ${repairMethod}` : ""}; ${batch.operations.size} file(s) staged.`
    });
    return JSON.stringify(receipt);
  }

  const parsed = parseSourceBatchFinishArguments(input.argumentsJson);
  if (!parsed.success) {
    const receipt = {
      accepted: false,
      error: parsed.error,
      instruction: `Resend only ${SOURCE_BATCH_FINISH_TOOL}; previously accepted files remain staged.`
    };
    appendStagedToolCall(batch, {
      providerToolName: input.providerToolName,
      serverId: "archicode-source-handoff",
      serverLabel: "Source Handoff",
      toolName: "finish_source_batch",
      argumentsJson: JSON.stringify({ rawArgumentChars: input.argumentsJson.length }),
      accepted: false,
      resultSummary: "Rejected malformed source batch finish metadata.",
      error: parsed.error
    });
    return JSON.stringify(receipt);
  }
  batch.finish = parsed.finish;
  const receipt = {
    accepted: true,
    finished: true,
    repaired: Boolean(parsed.repairedBy),
    repairMethod: parsed.repairedBy,
    implementationStatus: parsed.finish.implementationStatus,
    stagedFileCount: batch.operations.size
  };
  appendStagedToolCall(batch, {
    providerToolName: input.providerToolName,
    serverId: "archicode-source-handoff",
    serverLabel: "Source Handoff",
    toolName: "finish_source_batch",
    argumentsJson: JSON.stringify({
      implementationStatus: parsed.finish.implementationStatus,
      stagedFileCount: batch.operations.size,
      repairMethod: parsed.repairedBy
    }),
    accepted: true,
    resultSummary: `Finished source batch with ${batch.operations.size} file(s), status ${parsed.finish.implementationStatus}${parsed.repairedBy ? ` after ${parsed.repairedBy}` : ""}.`
  });
  return JSON.stringify(receipt);
}

function sourceToolBatchCompletesProviderTurn(calls: Array<{ providerToolName: string; result: string }>): boolean {
  if (!calls.length) return false;
  if (!calls.some((call) => call.providerToolName === SOURCE_BATCH_FINISH_TOOL)) return false;
  return calls.every((call) => {
    try {
      const receipt = JSON.parse(call.result) as { accepted?: unknown; deferredForSourceHandoff?: unknown };
      return isSourceHandoffTool(call.providerToolName)
        ? receipt.accepted === true
        : receipt.deferredForSourceHandoff === true;
    } catch {
      return false;
    }
  });
}

function consumeSourceToolBatch(runId: string, batchNumber: number): { proposal: LlmPatchProposal | null; repairedFiles: string[]; toolCalls: Run["mcpToolCalls"] } | null {
  const batch = stagedSourceToolBatches.get(runId);
  stagedSourceToolBatches.delete(runId);
  if (!batch || batch.batchNumber !== batchNumber) return null;
  return {
    proposal: batch.finish ? sourceHandoffPatch(runId, [...batch.operations.values()], batch.finish) : null,
    repairedFiles: [...batch.repairs.entries()].map(([filePath, method]) => `${filePath} (${method})`),
    toolCalls: batch.toolCalls
  };
}

async function persistSourceHandoffToolCalls(projectRoot: string, runId: string, toolCalls: Run["mcpToolCalls"]): Promise<void> {
  if (!toolCalls.length) return;
  const latest = await readRun(projectRoot, runId);
  await writeRun(projectRoot, runSchema.parse({
    ...latest,
    mcpToolCalls: [...latest.mcpToolCalls, ...toolCalls]
  }));
}

async function providerOptionsForRun(projectRoot: string, run: Run, settings: ProjectSettings, provider?: ProjectSettings["providers"][number]): Promise<{
  selectedSkillsPrompt: string;
  imageAttachments: ProviderImageAttachment[];
  mcpTools: ProviderMcpTool[];
  mcpServers: ProjectSettings["mcp"]["servers"];
  callMcpTool: (input: { providerToolName: string; argumentsJson: string }) => Promise<string>;
  structuredSourceHandoff: boolean;
  prepareToolBatch?: ProviderCallOptions["prepareToolBatch"];
  shouldCompleteToolBatch?: ProviderCallOptions["shouldCompleteToolBatch"];
}> {
  const selectedSkills = await selectedSkillsPrompt(projectRoot, settings);
  const internalTools = archicodeInternalTools(settings);
  const localProvider = provider?.kind === "codex-local" || provider?.kind === "claude-local" || provider?.kind === "opencode-local" || provider?.kind === "antigravity-local" || provider?.kind === "grok-local" || provider?.kind === "kimi-local";
  const structuredSourceHandoff = !localProvider && (run.phase === "coding" || run.phase === "debugging");
  const sourceTools = structuredSourceHandoff ? sourceHandoffTools() : [];
  const subagentTools = localProvider ? [] : runSubagentTools(settings);
  const bundle = await loadProject(projectRoot);
  const internalNames = new Set(internalTools.map((tool) => tool.providerToolName));
  const externalMcpTools = providerMcpTools(settings).filter((tool) => !internalNames.has(tool.providerToolName));
  const mcpTools = [...sourceTools, ...internalTools, ...subagentTools, ...externalMcpTools];
  const approvedExternalServers = new Set(run.mcp?.approvedServerIds ?? []);
  const allowedExternalServers = settings.mcp.servers
    .filter((server) => server.enabled && (server.trusted || approvedExternalServers.has(server.id)))
    .map((server) => approvedExternalServers.has(server.id) && !server.trusted
      ? { ...server, trusted: true, defaultToolsApprovalMode: server.defaultToolsApprovalMode ?? "approve" }
      : server);
  const internalServer = provider?.kind === "codex-local" || provider?.kind === "claude-local"
    ? await createArchicodeInternalMcpServer(projectRoot, settings)
    : null;
  const internalToolPrompt = internalTools.length
      ? [
        "Built-in ArchiCode tools are available during this run. Use them before guessing about files, runs, artifacts, safe finite commands, or current web pages.",
        ...(run.phase === "planning" ? ["Before finalizing the plan, call archicode_project_manage_rules with action list_violations for the target flow/nodes. Account for current policy findings that the work could affect; if the cached evaluation is stale or unavailable, state that verification will refresh it. The rules tool is read-only during runs."] : []),
        "Node/note attachments are exposed as metadata in context. Read attachment artifacts only when their contents or visual details are relevant to the current implementation/debugging task.",
        "Do not use the console tool to start dev servers, watch processes, previews, simulators, emulators, or long-running runtimes; use Run App for runtime launch.",
        ...(structuredSourceHandoff ? ["Source handoff boundary: finish all discovery before archicode_submit_source_file. Once source staging starts, other tools are deferred until ArchiCode applies the batch; host verification runs afterward."] : []),
        `Available built-in tools: ${[...sourceTools, ...internalTools, ...subagentTools].map((tool) => tool.providerToolName).join(", ")}.`
      ].join("\n")
    : "Built-in ArchiCode run tools are disabled in project settings.";
  const localMcpPrompt = localProviderMcpPrompt(run, settings, provider);
  const localSubagentPrompt = localProviderSubagentPrompt(settings, provider);
  const mcpResumePrompt = runMcpResumePrompt(run);
  return {
    selectedSkillsPrompt: [selectedSkills, internalToolPrompt, localMcpPrompt, mcpResumePrompt, localSubagentPrompt].filter((part) => part.trim()).join("\n\n"),
    imageAttachments: runImageAttachments(projectRoot, bundle, run),
    mcpTools,
    mcpServers: internalServer ? [internalServer, ...allowedExternalServers] : allowedExternalServers,
    callMcpTool: (input) => {
      if (isSourceHandoffTool(input.providerToolName)) return Promise.resolve(executeSourceHandoffTool(run.id, input));
      const deferred = deferredToolReceipt(run.id, mcpTools, input);
      return deferred === null
        ? executeRunMcpTool(projectRoot, run.id, settings, mcpTools, input)
        : Promise.resolve(deferred);
    },
    structuredSourceHandoff,
    prepareToolBatch: structuredSourceHandoff ? (calls) => prepareSourceToolBatch(run.id, calls) : undefined,
    shouldCompleteToolBatch: structuredSourceHandoff ? sourceToolBatchCompletesProviderTurn : undefined
  };
}

export async function callProviderForRun(
  projectRoot: string,
  runId: string,
  provider: ProjectSettings["providers"][number],
  contextText: string,
  promptSummary: string,
  options: ProviderCallOptions
): Promise<string> {
  options = { cacheSessionId: runId, ...options };
  if (!isLocalProviderKind(provider.kind)) {
    return callProvider(provider, contextText, promptSummary, options);
  }
  let delegatedContext = contextText;
  const delegationLoopDetector = createConsecutiveToolCallLoopDetector();
  while (true) {
    const output = await callProvider(provider, delegatedContext, promptSummary, options);
    const request = extractLocalProviderSubagentRequest(output);
    if (!request) return output;
    const duplicateWarning = delegationLoopDetector.record(`spawn_${request.agent}`, JSON.stringify(request.input));
    if (duplicateWarning) {
      delegatedContext = [
        delegatedContext,
        "",
        duplicateWarning,
        "The identical delegation already completed and its result is present above. Do not spawn it again. Use that evidence, choose a different useful action, or finish the phase."
      ].join("\n");
      continue;
    }
    const settings = (await loadProject(projectRoot)).project.settings;
    const enabled = request.agent === "sherlock"
      ? (settings.agentTools.subagents?.sherlockResearch ?? true)
      : request.agent === "delphi"
        ? (settings.agentTools.subagents?.delphiTesting ?? true)
        : (settings.agentTools.subagents?.graphReconciliation ?? true);
    const displayName = request.agent === "sherlock" ? "Sherlock" : request.agent === "delphi" ? "Delphi" : "Picasso";
    if (!enabled) throw new Error(`${displayName} is disabled in project settings.`);
    let subagentInput: unknown = request.input;
    if (request.agent === "delphi") {
      const delphiArgs = await prepareDelphiApprovalArguments(projectRoot, request.input);
      subagentInput = delphiArgs;
      const launchPlan = await planDelphiRuntimeLaunch(projectRoot, delphiArgs);
      if (delphiArgs.mode !== "plan") {
        await pauseRunForDelphiAuditApproval(projectRoot, runId, id("mcp-call"), {
          providerToolName: RUN_SPAWN_DELPHI_TOOL,
          argumentsJson: JSON.stringify(delphiArgs)
        }, launchPlan, {
          providerKind: provider.kind,
          originalOutput: output.trim()
        });
        throw new RunConsoleApprovalPending("Delphi audit");
      }
    }
    const result = await executeRunSubagentTool(projectRoot, runId, settings, {
      providerToolName: request.agent === "sherlock" ? RUN_SPAWN_SHERLOCK_TOOL : request.agent === "delphi" ? RUN_SPAWN_DELPHI_TOOL : RUN_SPAWN_PICASSO_TOOL,
      argumentsJson: JSON.stringify(subagentInput)
    });
    delegatedContext = [
      contextText,
      "",
      "## Completed Fresh-Context Delegation",
      `${displayName} completed the requested isolated work.`,
      `Compact result: ${result.resultText}`,
      "Continue the original phase now. Use the compact result and its artifact reference; do not repeat the investigation or request the same delegation again."
    ].join("\n");
  }
}

async function writeMcpTranscriptArtifact(projectRoot: string, run: Run): Promise<Artifact | null> {
  if (!run.mcpToolCalls.length) return null;
  const artifact: Artifact = {
    id: id("artifact"),
    type: "log",
    title: `MCP tool transcript for ${run.id}`,
    path: `.archicode/artifacts/${run.id}-mcp-tools.json`,
    runId: run.id,
    summary: `${run.mcpToolCalls.length} MCP tool call${run.mcpToolCalls.length === 1 ? "" : "s"}`,
    sizeBytes: Buffer.byteLength(JSON.stringify(run.mcpToolCalls), "utf8"),
    createdAt: iso()
  };
  await writeJson(path.join(projectRoot, artifact.path), {
    ...artifact,
    toolCalls: run.mcpToolCalls
  });
  return artifact;
}

async function maybePauseForLocalProviderMcpApproval(
  projectRoot: string,
  runId: string,
  provider: ProjectSettings["providers"][number] | undefined,
  settings: ProjectSettings,
  output: string
): Promise<boolean> {
  if (!isLocalProviderKind(provider?.kind)) return false;
  const request = extractLocalProviderMcpApprovalRequest(output, settings);
  if (!request) return false;
  const latest = await readRun(projectRoot, runId);
  if ((latest.mcp?.deniedServerIds ?? []).includes(request.serverId)) {
    throw new Error(`The provider requested ${request.serverLabel} / ${request.toolName} again after it was denied for this run.`);
  }
  const startedAt = iso();
  await writeRun(projectRoot, runSchema.parse({
    ...latest,
    status: "needs-permission",
    phase: latest.phase,
    permission: {
      ...latest.permission,
      decision: "pending",
      reason: request.intent?.trim()
        ? `${request.serverLabel} wants to run ${request.toolName}: ${request.intent.trim()}`
        : `${request.serverLabel} wants to run ${request.toolName}.`
    },
    mcp: {
      decision: "pending",
      approvedServerIds: latest.mcp?.approvedServerIds ?? [],
      deniedServerIds: latest.mcp?.deniedServerIds ?? [],
      pendingServerIds: [request.serverId],
      pendingToolCall: {
        serverId: request.serverId,
        serverLabel: request.serverLabel,
        toolName: request.toolName,
        providerToolName: request.providerToolName,
        argumentsJson: request.argumentsJson,
        intent: request.intent,
        phase: latest.phase
      },
      continuation: {
        providerKind: provider.kind,
        originalOutput: request.originalOutput
      },
      reason: request.intent?.trim()
        ? `Waiting for approval to run ${request.serverLabel} / ${request.toolName}: ${request.intent.trim()}`
        : `Waiting for approval to run ${request.serverLabel} / ${request.toolName}.`
    },
    mcpToolCalls: [
      ...latest.mcpToolCalls,
      {
        id: id("mcp-call"),
        serverId: request.serverId,
        serverLabel: request.serverLabel,
        toolName: request.toolName,
        argumentsJson: request.argumentsJson,
        status: "approval-required",
        resultSummary: request.intent?.trim() ? request.intent.trim() : "Waiting for user approval.",
        startedAt
      }
    ],
    logs: [
      ...latest.logs,
      { at: startedAt, stream: "system", text: request.intent?.trim()
        ? `Waiting for MCP tool approval: ${request.serverLabel} / ${request.toolName} (${request.intent.trim()})`
        : `Waiting for MCP tool approval: ${request.serverLabel} / ${request.toolName}` }
    ]
  }));
  return true;
}

async function consumeRunMcpContinuation(projectRoot: string, runId: string): Promise<void> {
  const latest = await readRun(projectRoot, runId).catch(() => null);
  if (!latest?.mcp?.continuation?.resume) return;
  await writeRun(projectRoot, runSchema.parse({
    ...latest,
    mcp: {
      ...latest.mcp,
      continuation: undefined
    }
  }));
}

async function completePlanningRun(projectRoot: string, run: Run, contextText?: string): Promise<void> {
  let planningRun = runSchema.parse({
    ...run,
    status: "planning",
    phase: "planning",
    todos: run.todos.map((todo) => todo.kind === "planning-phase" || todo.text.includes("Planning phase") ? { ...todo, status: "doing" } : todo),
    logs: [...run.logs, { at: iso(), stream: "system", text: `Planning phase started. ${gaiaAgent.title} owns this implementation run.` }],
    startedAt: run.startedAt ?? iso()
  });
  await writeRun(projectRoot, planningRun);

  const bundle = await loadProject(projectRoot);
  const provider = bundle.project.settings.providers.find((item) => item.id === run.providerId);
  if (!provider) {
    throw new Error(`Provider ${run.providerId} was not found. Choose a configured provider before running.`);
  }
  const context = contextText ?? (await buildContext(projectRoot, run.flowId, run.nodeId, run.providerId, run.scope)).text;
  planningRun = await readRun(projectRoot, planningRun.id).catch(() => planningRun);
  const providerCapabilities = await providerOptionsForRun(projectRoot, planningRun, bundle.project.settings, provider);
  await consumeRunMcpContinuation(projectRoot, run.id);
  const runnableProvider = await hydrateProviderForUse(provider);
  const abortController = beginRunAbortScope(run.id);

  try {
    if (await runWasCancelled(projectRoot, run.id)) return;
    let planningUsage: LlmUsage | undefined;
    let output = await callProviderForRun(projectRoot, run.id, runnableProvider, context, planningPromptSummaryForRun(run), {
      projectRoot,
      webSearchEnabled: nativeWebSearchEnabled(bundle.project.settings),
      phase: "planning",
      signal: abortController.signal,
      onProgress: createProviderProgressLogger(projectRoot, run.id),
      onUsage: (usage) => { planningUsage = usage; },
      ...providerCapabilities
    });
    await flushRunLogAppends(run.id);
    if (planningUsage) await persistRunUsage(projectRoot, run.id, "planning", [planningUsage]);
    if (await runWasCancelled(projectRoot, run.id)) return;
    if (await maybePauseForLocalProviderMcpApproval(projectRoot, run.id, provider, bundle.project.settings, output)) return;
    await writeProviderPlanOutput(projectRoot, run, output);
    if (await runWasCancelled(projectRoot, run.id)) return;
    let patchProposal = await persistAndMaybeApplyPatchProposal(projectRoot, run.id, output, {
      allowSourceFileAutoApply: false,
      phase: "planning"
    });
    if (await runWasCancelled(projectRoot, run.id)) return;

    // In-phase self-refinement (high effort only; fast stays one-shot). Gaia
    // re-plans in the same phase against deterministic findings. The run always
    // proceeds with the best draft — a plan never fails here.
    const refineEffort = resolveAutoImplementationEffort(await readRun(projectRoot, run.id).catch(() => run), patchProposal);
    if (refineEffort === "high") {
      const isApiProvider = !isLocalProviderKind(provider.kind);
      const hasVerifiableScripts = await projectHasVerifiableScripts(projectRoot);
      for (let pass = 1; pass <= PLAN_REFINE_CAP; pass += 1) {
        if (await runWasCancelled(projectRoot, run.id)) return;
        const refineBundle = await loadProject(projectRoot);
        const currentRun = await readRun(projectRoot, run.id).catch(() => run);
        const report = validatePlanQuality({
          run: currentRun,
          output,
          proposal: patchProposal,
          scopeNodeTitles: inScopeNodeTitles(refineBundle, currentRun),
          hasVerifiableScripts,
          mcpToolCalls: currentRun.mcpToolCalls,
          isApiProvider
        });
        if (report.clean) break;
        queueRunLogAppend(projectRoot, run.id, "system", `Planning refine pass ${pass}/${PLAN_REFINE_CAP}: ${report.findings.length} plan gap(s) found; ${gaiaAgent.name} is improving the plan. ${report.findings.join(" ")}`);
        const refineContext = [context, "", planRefineGuidance(report.findings)].join("\n");
        let refineUsage: LlmUsage | undefined;
        output = await callProviderForRun(projectRoot, run.id, runnableProvider, refineContext, planningPromptSummaryForRun(run), {
          projectRoot,
          webSearchEnabled: nativeWebSearchEnabled(bundle.project.settings),
          phase: "planning",
          signal: abortController.signal,
          onProgress: createProviderProgressLogger(projectRoot, run.id),
          onUsage: (usage) => { refineUsage = usage; },
          ...providerCapabilities
        });
        await flushRunLogAppends(run.id);
        if (refineUsage) await persistRunUsage(projectRoot, run.id, "planning", [refineUsage]);
        if (await runWasCancelled(projectRoot, run.id)) return;
        if (await maybePauseForLocalProviderMcpApproval(projectRoot, run.id, provider, bundle.project.settings, output)) return;
        await writeProviderPlanOutput(projectRoot, run, output);
        if (await runWasCancelled(projectRoot, run.id)) return;
        patchProposal = await persistAndMaybeApplyPatchProposal(projectRoot, run.id, output, {
          allowSourceFileAutoApply: false,
          phase: "planning"
        });
      }
    }
    if (await runWasCancelled(projectRoot, run.id)) return;
    const nextBundle = await loadProject(projectRoot);
    const openQuestions = scopeOpenQuestions(nextBundle, run.flowId, run.nodeId);
    const mustReviewPlan = nextBundle.project.settings.planningReviewMode === "manual";
    const canCode = isCodeCapableProvider(provider);
    const nextStatus: Run["status"] = mustReviewPlan
      ? "awaiting-plan-review"
      : canCode
        ? "coding"
        : "succeeded";
    const nextPhase = nextStatus === "coding"
      ? "coding"
      : nextStatus === "awaiting-plan-review"
        ? "awaiting-plan-review"
        : "complete";
    const latestPlanningRun = await readRun(projectRoot, run.id);
    if (latestPlanningRun.status === "cancelled") return;
    const mcpArtifact = await writeMcpTranscriptArtifact(projectRoot, latestPlanningRun);
    if (await runWasCancelled(projectRoot, run.id)) return;
    const resolvedEffort = resolveAutoImplementationEffort(latestPlanningRun, patchProposal);
    const effortResolvedRun = runSchema.parse({ ...latestPlanningRun, effort: resolvedEffort });
    const implementation = canCode ? initializeImplementationState(effortResolvedRun, patchProposal) : latestPlanningRun.implementation;
    const plannedRunMemory = runMemoryFromRun(runSchema.parse({
      ...latestPlanningRun,
      effort: resolvedEffort,
      implementation
    }), {
      phaseNote: patchProposal?.summary
        ? `Planning completed: ${patchProposal.summary}`
        : "Planning completed.",
      decisions: [
        `Implementation effort: ${resolvedEffort}`,
        ...(patchProposal?.implementationTasks?.length ? [`Planned ${patchProposal.implementationTasks.length} implementation task(s).`] : [])
      ],
      nextStep: canCode ? "Continue into coding with the planned implementation tasks." : "Planning completed; coding is unavailable for this provider."
    });
    planningRun = runSchema.parse({
      ...latestPlanningRun,
      effort: resolvedEffort,
      status: nextStatus,
      phase: nextPhase,
      implementation,
      runMemory: plannedRunMemory,
      todos: latestPlanningRun.todos.map((todo) => {
        if (todo.kind === "planning-phase" || todo.text.includes("Planning phase")) return { ...todo, status: "done" };
        if (todo.kind === "coding-phase" || todo.text.includes("Coding phase")) return { ...todo, status: nextStatus === "coding" ? "doing" : nextStatus === "succeeded" ? "blocked" : "todo" };
        return todo;
      }),
      logs: [
        ...latestPlanningRun.logs,
        { at: iso(), stream: "system", text: output },
        ...(mcpArtifact ? [{ at: iso(), stream: "system" as const, text: `MCP transcript artifact: ${mcpArtifact.path}` }] : []),
        patchProposal
          ? {
              at: iso(),
              stream: "system",
              text: patchProposal.hasSourceFileOperations
                ? "Planning returned source-file proposals; held for review so coding can produce an implementation diff."
                : patchProposal.pendingReview
                  ? "Planning produced pending graph proposals."
                  : "Planning graph bookkeeping was recorded."
            }
          : { at: iso(), stream: "system", text: "Planning completed without graph patch proposals." },
        ...(latestPlanningRun.effort === "auto"
          ? [{ at: iso(), stream: "system" as const, text: `Auto implementation effort resolved to ${resolvedEffort}.` }]
          : []),
        ...(mustReviewPlan && openQuestions.length
          ? [{ at: iso(), stream: "system" as const, text: `Planning found ${openQuestions.length} open question(s); coding is paused.` }]
          : []),
        ...(!canCode && !mustReviewPlan
          ? [{ at: iso(), stream: "system" as const, text: "Provider is planning/proposal only; no coding phase was started." }]
          : []),
        // Surface the generic-fallback case instead of silently pretending a
        // task split existed: coding still proceeds, just from one broad task.
        ...(canCode && !isNoScopeRun(latestPlanningRun) && implementation?.fallbackReason
          ? [{ at: iso(), stream: "system" as const, text: implementation.fallbackReason }]
          : [])
      ],
      contextArtifacts: mcpArtifact ? [...latestPlanningRun.contextArtifacts, mcpArtifact.id] : latestPlanningRun.contextArtifacts,
      runInstructions: mustReviewPlan
        ? "Review the plan, answer unresolved node questions, then resume the run to continue into coding."
        : canCode
          ? "Planning completed. Coding will start automatically with the configured provider."
          : "Planning completed. Enable Codex Local, OpenAI-compatible, or Anthropic-compatible provider to let ArchiCode code from this plan.",
      completedAt: nextStatus === "succeeded" ? iso() : undefined
    });
    if (await runWasCancelled(projectRoot, run.id)) return;
    await writeRun(projectRoot, nextStatus === "succeeded"
      ? await finalizeTerminalRun(projectRoot, planningRun, planningRun.runInstructions ?? "Planning completed.")
      : planningRun);
    if (nextStatus === "coding") void scheduleNextQueuedJob(projectRoot);
  } catch (error) {
    await flushRunLogAppends(run.id);
    // The run is already persisted as needs-permission; the approval decision resumes it.
    if (error instanceof RunConsoleApprovalPending) return;
    if (await runWasCancelled(projectRoot, run.id)) return;
    const latestPlanningRun = await readRun(projectRoot, run.id).catch(() => planningRun);
    if (latestPlanningRun.status === "cancelled") return;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const quotaOrRateLimit = /insufficient_quota|exceeded your current quota|quota exceeded|billing details|rate limit|429/i.test(errorMessage);
    const instructions = quotaOrRateLimit
      ? `Provider quota or rate limit blocked planning: ${compactSummary(errorMessage)}`
      : "Planning failed. Check provider settings, context, and permissions, then retry.";
    const failed = runSchema.parse({
      ...latestPlanningRun,
      status: "failed",
      phase: "complete",
      todos: latestPlanningRun.todos.map((todo) => ({ ...todo, status: todo.status === "done" ? "done" : "blocked" })),
      logs: [...latestPlanningRun.logs, { at: iso(), stream: "stderr", text: errorMessage }],
      runInstructions: instructions,
      completedAt: iso()
    });
    await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, failed, failed.runInstructions ?? "Planning failed."));
  } finally {
    endRunAbortScope(run.id, abortController);
  }
}

async function completeCodingRun(projectRoot: string, run: Run, contextText?: string): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const provider = bundle.project.settings.providers.find((item) => item.id === run.providerId);
  const command = providerCommand(provider);
  const providerPhase = run.phase === "debugging" || run.status === "debugging" ? "debugging" : "coding";
  const directWrite = isWriteCapableProvider(provider);
  const providerLaunchNeedsApproval = requiresProviderLaunchApproval(provider);
  if (!isCodeCapableProvider(provider)) {
    const failed = runSchema.parse({
      ...run,
      status: "failed",
      phase: "complete",
      logs: [...run.logs, { at: iso(), stream: "stderr", text: "Coding requires an LLM provider. Manual/offline can plan and record artifacts, but cannot generate source changes." }],
      runInstructions: "Enable Codex Local, OpenAI-compatible, or Anthropic-compatible provider before retrying this coding run.",
      completedAt: iso()
    });
    await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, failed, failed.runInstructions ?? "Coding requires an LLM provider."));
    return;
  }

  const reusablePolicy = command ? commandAllowedBySettings(bundle.project.settings, command, projectRoot) : null;
  const codingCommandApproved = run.permission.decision === "allowed" &&
    (Boolean(run.permission.reusablePolicyId) ||
      run.permission.grantedFor === "coding-command" ||
      run.permission.grantedFor === "debugging-command" ||
      // Legacy fallback for runs persisted before grantedFor existed.
      run.permission.reason?.includes("coding command") ||
      run.permission.reason?.includes("debugging command"));
  if (directWrite && providerLaunchNeedsApproval && command && !reusablePolicy && !codingCommandApproved) {
    await writeRun(projectRoot, runSchema.parse({
      ...run,
      status: "needs-permission",
      phase: providerPhase,
      plannedCommands: [...new Set([...run.plannedCommands, command])],
      permission: {
        decision: "pending",
        reason: `Coding provider command "${command}" needs approval or a trusted command allowlist entry.`
      },
      logs: [...run.logs, { at: iso(), stream: "system", text: `Waiting for approval to run coding provider command: ${command}` }]
    }));
    return;
  }

  const before = await collectSourceSnapshot(projectRoot);
  const abortController = beginRunAbortScope(run.id);
  let codingRun = runSchema.parse({
    ...run,
    status: providerPhase,
    phase: providerPhase,
    permission: {
      ...run.permission,
      decision: "allowed",
      reason: reusablePolicy
        ? `Allowed by reusable policy ${reusablePolicy.id}.`
        : directWrite
          ? `${provider?.kind === "claude-local" ? "Claude Code CLI" : provider?.kind === "opencode-local" ? "OpenCode CLI" : provider?.kind === "antigravity-local" ? "Antigravity CLI" : provider?.kind === "grok-local" ? "Grok Build CLI" : provider?.kind === "kimi-local" ? "Kimi Code CLI" : "Codex Local CLI"} provider launch allowed by ${codexLocalSandboxDisplayLabel(provider?.localSandbox)}.`
        : "API provider coding is applied through source-file handoffs."
    },
    logs: [...run.logs, { at: iso(), stream: "system", text: providerPhase === "debugging"
      ? `Debugging phase started. ${pandoraAgent.title} owns this repair run.`
      : directWrite
        ? `Coding phase started. ${gaiaAgent.title} owns this implementation run.`
        : `API coding phase started; ${gaiaAgent.name} must return source-file proposals for ArchiCode to apply.` }]
  });
  await writeRun(projectRoot, codingRun);

  try {
    if (await runWasCancelled(projectRoot, run.id)) return;
    const context = contextText ?? (await buildContext(projectRoot, run.flowId, run.nodeId, run.providerId, run.scope)).text;
    codingRun = await readRun(projectRoot, codingRun.id).catch(() => codingRun);
    if (codingRun.status === "cancelled") return;
    const providerCapabilities = await providerOptionsForRun(projectRoot, codingRun, bundle.project.settings, provider);
    await consumeRunMcpContinuation(projectRoot, run.id);
    const runnableProvider = await hydrateProviderForUse(provider!);
    let implementation = implementationStateForRun(codingRun);
    let beforeBatch = before;
    let lastProviderHadValidSourceProposal = false;
    let lastProviderHadInvalidPatchProposal = false;
    let lastProviderBlockedSourceProposal = false;
    let reachedBatchLimitWithMoreWork = false;
    let batchLimitVerification: RunImplementationCheckpoint["verification"] | undefined;
    let needsReplan = false;
    // Set when the provider returns a valid no-op handoff explicitly signalling
    // completion, so the loop finishes successfully instead of treating the
    // empty batch as a failed/invalid handoff.
    let implementationReportedComplete = false;
    const batchDiffArtifacts: Artifact[] = [];
    const createdManagerialFiles = new Set<string>();

    for (let batchNumber = implementation.currentBatch + 1; batchNumber <= implementation.maxBatches; batchNumber += 1) {
      if (await runWasCancelled(projectRoot, run.id)) return;
      const startedAt = iso();
      const selectedTask = currentImplementationTask(implementation);
      if (selectedTask) implementation = setImplementationTaskStatus(implementation, selectedTask.id, "doing");
      const activeTask = currentImplementationTask(implementation);
      const latestBeforeBatch = await readRun(projectRoot, run.id).catch(() => codingRun);
      if (latestBeforeBatch.status === "cancelled") return;
      codingRun = runSchema.parse({
        ...latestBeforeBatch,
        implementation: {
          ...implementation,
          currentBatch: batchNumber,
          needsMoreWork: undefined
        },
        logs: [
          ...latestBeforeBatch.logs,
          {
            at: startedAt,
            stream: "system",
            text: providerPhase === "debugging"
              ? "Debugging repair batch started."
              : `Implementation batch ${batchNumber}/${implementation.maxBatches} started${activeTask ? ` for ${activeTask.title}` : ""}.`
          }
        ]
      });
      await writeRun(projectRoot, codingRun);
      if (await runWasCancelled(projectRoot, run.id)) return;

      // Retry a genuinely empty/invalid handoff (no usable operations AND no
      // completion signal) with tighter guidance before giving up, so a single
      // malformed provider turn doesn't end the whole run. A valid no-op
      // completion or any produced work exits the loop immediately.
      let output!: string;
      let patchProposal!: Awaited<ReturnType<typeof persistAndMaybeApplyPatchProposal>>;
      let afterProvider!: Awaited<ReturnType<typeof collectSourceSnapshot>>;
      let providerDiff!: string;
      const maxHandoffAttempts = 2;
      let handoffRetryGuidance = emptyHandoffRetryGuidance;
      for (let handoffAttempt = 1; handoffAttempt <= maxHandoffAttempts; handoffAttempt += 1) {
        const latestMemoryRun = await readRun(projectRoot, run.id).catch(() => codingRun);
        const baseBatchContext = implementationContextForBatch(context, implementation, batchNumber, latestMemoryRun.runMemory);
        const batchContext = handoffAttempt === 1 ? baseBatchContext : `${baseBatchContext}\n\n${handoffRetryGuidance}`;
        let batchUsage: LlmUsage | undefined;
        if (providerCapabilities.structuredSourceHandoff) beginSourceToolBatch(run.id, batchNumber, beforeBatch);
        try {
          output = await callProviderForRun(projectRoot, run.id, runnableProvider, batchContext, implementationBatchPromptSummary(run, providerPhase, batchNumber, implementation.maxBatches), {
            projectRoot,
            webSearchEnabled: nativeWebSearchEnabled(bundle.project.settings),
            phase: providerPhase,
            signal: abortController.signal,
            onProgress: createProviderProgressLogger(projectRoot, run.id),
            onUsage: (usage) => { batchUsage = usage; },
            ...providerCapabilities
          });
        } catch (error) {
          clearSourceToolBatch(run.id);
          throw error;
        }
        if (providerCapabilities.structuredSourceHandoff) {
          const stagedHandoff = consumeSourceToolBatch(run.id, batchNumber);
          if (stagedHandoff) {
            await persistSourceHandoffToolCalls(projectRoot, run.id, stagedHandoff.toolCalls);
            if (stagedHandoff.proposal) {
              output = JSON.stringify({ archicodePatch: stagedHandoff.proposal });
              queueRunLogAppend(
                projectRoot,
                run.id,
                "system",
                `Structured source handoff staged ${stagedHandoff.proposal.operations.length} file proposal(s) in one provider turn${stagedHandoff.repairedFiles.length ? `; deterministically repaired ${stagedHandoff.repairedFiles.join(", ")}` : ""}. Lightweight per-file metadata was recorded in the MCP transcript.`
              );
            }
          }
        }
        await flushRunLogAppends(run.id);
        if (batchUsage) await persistRunUsage(projectRoot, run.id, providerPhase, [batchUsage]);
        if (await runWasCancelled(projectRoot, run.id)) return;
        if (await maybePauseForLocalProviderMcpApproval(projectRoot, run.id, provider, bundle.project.settings, output)) return;
        patchProposal = await persistAndMaybeApplyPatchProposal(projectRoot, run.id, output, {
          phase: providerPhase,
          artifactSuffix: batchNumber === 1 ? undefined : `batch-${batchNumber}`
        });
        if (patchProposal?.validationError && /attribution|nodeIds|node id/i.test(patchProposal.validationError)) {
          handoffRetryGuidance = sourceAttributionRetryGuidance(patchProposal.validationError);
        }
        if (await runWasCancelled(projectRoot, run.id)) return;
        afterProvider = await collectSourceSnapshot(projectRoot);
        const directDeletionProposal = directWrite
          ? await restoreDirectDeletionsRequiringPermission(
              projectRoot,
              await readRun(projectRoot, run.id).catch(() => codingRun),
              beforeBatch,
              afterProvider,
              providerPhase,
              batchNumber
            )
          : null;
        if (directDeletionProposal) {
          patchProposal = {
            ...directDeletionProposal,
            implementationStatus: patchProposal?.implementationStatus,
            implementationNotes: patchProposal?.implementationNotes,
            nextSourceSlice: patchProposal?.nextSourceSlice
          };
          afterProvider = await collectSourceSnapshot(projectRoot);
        }
        await recordRunCreatedFiles(projectRoot, run.id, beforeBatch, afterProvider).catch(() => undefined);
        providerDiff = buildUnifiedSourceDiff(beforeBatch, afterProvider);
        const declaredComplete = Boolean(patchProposal?.valid) && patchProposal?.implementationStatus === "complete";
        const producedWork = providerDiff.trim().length > 0 || Boolean(patchProposal?.pendingSourceOperationIndexes?.length);
        const emptyHandoff = providerPhase === "coding" && !declaredComplete && !producedWork;
        if (!emptyHandoff || handoffAttempt >= maxHandoffAttempts) break;
        const retryLatest = await readRun(projectRoot, run.id).catch(() => codingRun);
        if (retryLatest.status === "cancelled") return;
        codingRun = runSchema.parse({
          ...retryLatest,
          logs: [
            ...retryLatest.logs,
            { at: iso(), stream: "stderr", text: `Implementation batch ${batchNumber} returned no usable source changes and no completion signal; retrying with tighter guidance (attempt ${handoffAttempt + 1}/${maxHandoffAttempts}).` }
          ]
        });
        await writeRun(projectRoot, codingRun);
      }
      const batchManagerialFiles = providerDiff.trim()
        ? await ensureManagerialProjectFiles(projectRoot, bundle)
        : [];
      for (const filePath of batchManagerialFiles) createdManagerialFiles.add(filePath);
      const after = batchManagerialFiles.length ? await collectSourceSnapshot(projectRoot) : afterProvider;
      const diff = buildUnifiedSourceDiff(beforeBatch, after);
      const diffArtifact = await writeSourceDiffArtifact(projectRoot, run, diff, {
        suffix: batchNumber === 1 ? undefined : `batch-${batchNumber}`,
        title: batchNumber === 1 ? `Source diff ${run.id}` : `Source diff ${run.id} batch ${batchNumber}`
      });
      if (diffArtifact) {
        batchDiffArtifacts.push(diffArtifact);
        await markRunNodesWithDiff(projectRoot, run, diffArtifact, {
          inferImplementationScopeFromDiff: !patchProposal?.hasSourceFileOperations
        });
      }
      const continuationRequested = implementationContinuationRequested(providerPhase, patchProposal, diffArtifact);
      const continuationMovesToNextTask = continuationAdvancesToNextTask(implementation, activeTask, continuationRequested);
      const sourceReviewPending = Boolean(patchProposal?.pendingSourceOperationIndexes?.length);
      const verification = diffArtifact && !sourceReviewPending && (!continuationRequested || continuationMovesToNextTask)
        ? await runTargetedImplementationVerification(projectRoot, run, batchNumber, activeTask)
        : undefined;
      if (await runWasCancelled(projectRoot, run.id)) return;
      const outputArtifact = await writeImplementationCheckpointArtifact(projectRoot, run, batchNumber, output, patchProposal, diffArtifact);
      if (await runWasCancelled(projectRoot, run.id)) return;
      const replanRequested = Boolean(patchProposal?.needsReplan || (patchProposal?.implementationStatus === "blocked" && patchProposal.replanReason));
      const checkpoint: RunImplementationCheckpoint = {
        id: id("checkpoint"),
        phase: providerPhase,
        batchNumber,
        taskId: activeTask?.id,
        status: verification && !verification.passed ? "failed" : diffArtifact ? "changed" : patchProposal && !patchProposal.valid ? "failed" : "no-changes",
        summary: implementationCheckpointSummary(patchProposal, output, diffArtifact),
        outputArtifactId: outputArtifact.id,
        sourceDiffArtifactId: diffArtifact?.id,
        verification,
        warnings: patchProposal?.warnings ?? [],
        quarantinedOperationsCount: patchProposal?.quarantinedOperations?.length ?? 0,
        startedAt,
        completedAt: iso()
      };
      const sameTaskNeedsMoreWork = (continuationRequested && !continuationMovesToNextTask) || Boolean(verification && !verification.passed);
      // A valid handoff with no source operations that explicitly signals
      // completion means the assigned work is already done (e.g. the model
      // implemented it in an earlier batch). Trust it — the final build
      // verification backstops a premature claim — rather than failing.
      const activeTaskCompleteNoOps = (providerPhase === "coding" || providerPhase === "debugging")
        && Boolean(patchProposal?.valid)
        && !diffArtifact
        && !patchProposal?.sourceOperationsBlocked
        && !sourceReviewPending
        && patchProposal?.implementationStatus === "complete";
      if (replanRequested) {
        needsReplan = true;
        implementation = {
          ...implementation,
          needsReplan: {
            reason: patchProposal?.replanReason || patchProposal?.implementationNotes || "Coding found that the plan is not sufficient to continue safely.",
            suggestedQuestions: patchProposal?.suggestedQuestions ?? []
          }
        };
        if (activeTask) implementation = setImplementationTaskStatus(implementation, activeTask.id, "blocked");
      } else if (activeTask && diffArtifact && !sameTaskNeedsMoreWork && !sourceReviewPending) {
        implementation = setImplementationTaskStatus(implementation, activeTask.id, "done");
      } else if (activeTaskCompleteNoOps) {
        // Mark the active plus any remaining planned tasks done so already-built
        // tasks are not re-assigned in later batches, and record the completion
        // signal for finalization.
        if (activeTask) implementation = setImplementationTaskStatus(implementation, activeTask.id, "done");
        implementation = completeImplementationSnapshot(implementation) ?? implementation;
        implementationReportedComplete = true;
      }
      const hasRemainingTasks = implementation.tasks.some((task) => task.status === "todo" || task.status === "doing");
      const shouldContinue = providerPhase === "coding" && !needsReplan && Boolean(diffArtifact) && (sameTaskNeedsMoreWork || hasRemainingTasks);
      implementation = {
        ...implementation,
        currentBatch: batchNumber,
        needsMoreWork: shouldContinue,
        summary: checkpoint.summary,
        checkpoints: [...implementation.checkpoints, checkpoint]
      };
      lastProviderHadValidSourceProposal = Boolean(patchProposal?.valid && patchProposal.hasSourceFileOperations);
      lastProviderHadInvalidPatchProposal = Boolean(patchProposal && !patchProposal.valid);
      lastProviderBlockedSourceProposal = !diffArtifact && lastProviderHadInvalidPatchProposal;

      const latestAfterBatch = await readRun(projectRoot, run.id).catch(() => codingRun);
      if (latestAfterBatch.status === "cancelled") return;
      const nextSourceDiffArtifactIds = diffArtifact ? [...latestAfterBatch.sourceDiffArtifactIds, diffArtifact.id] : latestAfterBatch.sourceDiffArtifactIds;
      const nextContextArtifacts = [
        ...latestAfterBatch.contextArtifacts,
        outputArtifact.id,
        ...(diffArtifact ? [diffArtifact.id] : [])
      ];
      const nextLastVerification = verification
        ? { command: verification.command, exitCode: verification.exitCode ?? undefined, at: iso() }
        : latestAfterBatch.lastVerification;
      const nextRunMemory = runMemoryFromRun(runSchema.parse({
        ...latestAfterBatch,
        implementation,
        lastVerification: nextLastVerification,
        sourceDiffArtifactIds: nextSourceDiffArtifactIds,
        contextArtifacts: nextContextArtifacts
      }), {
        phaseNote: `${providerPhase === "debugging" ? "Debugging" : "Implementation"} batch ${batchNumber} ${checkpoint.status}.`,
        completedWork: checkpoint.summary ? [checkpoint.summary] : [],
        touchedFiles: diffArtifact ? [`source diff artifact ${diffArtifact.id}`] : [],
        failedAttempts: checkpoint.status === "failed" ? [checkpoint.summary ?? `Batch ${batchNumber} failed`] : [],
        verification: verification ? [verification.summary] : [],
        artifactIds: [outputArtifact.id, ...(diffArtifact ? [diffArtifact.id] : [])],
        nextStep: needsReplan
          ? "Return to planning because coding reported a planning gap."
          : shouldContinue
            ? "Continue with the next implementation batch."
            : "Finish coding and move toward review or verification."
      });
      codingRun = runSchema.parse({
        ...latestAfterBatch,
        implementation,
        runMemory: nextRunMemory,
        lastVerification: nextLastVerification,
        sourceDiffArtifactIds: nextSourceDiffArtifactIds,
        contextArtifacts: nextContextArtifacts,
        logs: [
          ...latestAfterBatch.logs,
          { at: iso(), stream: "system", text: output },
          ...(patchProposal
            ? patchProposal.valid
              ? [{ at: iso(), stream: "system" as const, text: `Implementation batch ${batchNumber} produced source-file proposal output.` }]
              : [{ at: iso(), stream: "stderr" as const, text: `Implementation batch ${batchNumber} returned an invalid or unsupported coding handoff.` }]
            : []),
          ...(patchProposal?.warnings?.map((text) => ({ at: iso(), stream: "system" as const, text })) ?? []),
          ...(verification
            ? [{
                at: iso(),
                stream: verification.passed ? "system" as const : "stderr" as const,
                text: `${verification.summary}${verification.logArtifactId ? ` (log artifact: ${verification.logArtifactId})` : ""}`
              }]
            : diffArtifact
              ? [{
                  at: iso(),
                  stream: "system" as const,
                  text: continuationRequested
                    ? "Light verification deferred until the current implementation task finishes."
                    : activeTask?.verificationCommand && isBuildVerificationCommand(activeTask.verificationCommand)
                      ? `Full build verification deferred to final verification: ${activeTask.verificationCommand}`
                      : "No light verification command was available for this implementation batch."
                }]
              : []),
          diffArtifact
            ? { at: iso(), stream: "system" as const, text: `Source diff artifact: ${diffArtifact.path}` }
            : {
                at: iso(),
                stream: lastProviderBlockedSourceProposal ? "stderr" as const : "system" as const,
                text: lastProviderBlockedSourceProposal
                  ? "Provider returned source changes in an invalid proposal that ArchiCode could not use."
                  : lastProviderHadValidSourceProposal
                    ? "Provider returned source-file proposals, but they did not produce a source diff."
                    : "Implementation batch produced no source file changes."
              },
          { at: iso(), stream: "system" as const, text: `Implementation checkpoint artifact: ${outputArtifact.path}` }
        ]
      });
      await writeRun(projectRoot, codingRun);

      if (sourceReviewPending && patchProposal) {
        const pendingPaths = patchProposal.pendingSourcePaths ?? [];
        const paused = runSchema.parse({
          ...codingRun,
          status: "needs-permission",
          phase: providerPhase,
          sourceReview: {
            proposalArtifactId: patchProposal.artifact.id,
            operationIndexes: patchProposal.pendingSourceOperationIndexes!,
            paths: pendingPaths,
            resumePhase: providerPhase,
            batchNumber,
            taskId: activeTask?.id
          },
          permission: {
            decision: "pending",
            reason: `Source deletion requires permission: ${pendingPaths.join(", ")}`
          },
          implementation: {
            ...implementation,
            needsMoreWork: true
          },
          todos: codingRun.todos.map((todo) => todo.kind === "coding-phase" ? { ...todo, status: "blocked" as const } : todo),
          logs: [
            ...codingRun.logs,
            { at: iso(), stream: "system", text: `Paused for explicit permission to delete: ${pendingPaths.join(", ")}. Safe coding changes from this batch remain applied.` }
          ],
          runInstructions: `Approve or reject deletion of ${pendingPaths.join(", ")}. The run will continue coding either way.`
        });
        await writeRun(projectRoot, paused);
        return;
      }

      if (!diffArtifact || needsReplan) break;
      if (!shouldContinue) break;
      if (batchNumber >= implementation.maxBatches) {
        const failedVerification = Boolean(verification && !verification.passed);
        const extendedMaxBatches = nextImplementationBatchLimit(run, implementation);
        if (extendedMaxBatches > implementation.maxBatches) {
          const extensionReason = implementationBatchExtensionReason({
            continuationRequested: continuationRequested && !continuationMovesToNextTask,
            failedVerification,
            hasRemainingTasks
          });
          implementation = {
            ...implementation,
            maxBatches: extendedMaxBatches
          };
          const latestExtendedRun = await readRun(projectRoot, run.id).catch(() => codingRun);
          if (latestExtendedRun.status === "cancelled") return;
          codingRun = runSchema.parse({
            ...latestExtendedRun,
            implementation,
            logs: [
              ...latestExtendedRun.logs,
              {
                at: iso(),
                stream: "system",
                text: `${extensionReason} to ${extendedMaxBatches} batch(es).`
              }
            ]
          });
          await writeRun(projectRoot, codingRun);
          beforeBatch = await collectSourceSnapshot(projectRoot);
          continue;
        }
        batchLimitVerification = failedVerification ? verification : undefined;
        reachedBatchLimitWithMoreWork = true;
        break;
      }
      beforeBatch = await collectSourceSnapshot(projectRoot);
    }

    const validSourceProposal = lastProviderHadValidSourceProposal;
    const invalidPatchProposal = lastProviderHadInvalidPatchProposal;
    const diffArtifact = batchDiffArtifacts.length ? batchDiffArtifacts[batchDiffArtifacts.length - 1] : null;
    const shouldReviewCode = bundle.project.settings.codeReviewMode === "manual" && batchDiffArtifacts.length > 0;
    const noSourceChanges = batchDiffArtifacts.length === 0;
    const blockedSourceProposal = noSourceChanges && lastProviderBlockedSourceProposal;
    let commandBundle = await loadProject(projectRoot);
    const reconciliationLogs: Run["logs"] = [];
    if (batchDiffArtifacts.length && !isNoScopeRun(run)) {
      try {
        if (await runWasCancelled(projectRoot, run.id)) return;
        const reconciliation = await reconcileRuntimeProfilesWithLlm(projectRoot, run.providerId, "post-implementation", `${run.id}-runtime-reconcile`, abortController.signal);
        commandBundle = reconciliation.bundle;
        reconciliationLogs.push({
          at: iso(),
          stream: "system",
          text: reconciliation.proposal
            ? `Runtime profile reconciliation applied/proposed: ${reconciliation.proposal.artifact.path}`
            : reconciliation.skippedReason ?? "Runtime profile reconciliation completed without profile changes."
        });
        if (reconciliation.repairSummary) {
          reconciliationLogs.push({
            at: iso(),
            stream: "system",
            text: reconciliation.repairSummary
          });
        }
      } catch (error) {
        commandBundle = await refreshInferredProjectCommands(projectRoot);
        reconciliationLogs.push({
          at: iso(),
          stream: "stderr",
          text: `Runtime profile LLM reconciliation failed; continued with deterministic inference. ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
    const buildCommand = await inferredVerificationCommand(projectRoot, commandBundle);
    const latestCodingRun = await readRun(projectRoot, run.id);
    if (latestCodingRun.status === "cancelled") return;
    const mcpArtifact = await writeMcpTranscriptArtifact(projectRoot, latestCodingRun);
    if (await runWasCancelled(projectRoot, run.id)) return;
    const verificationOnlyNoSourceChanges = noSourceChanges &&
      (latestCodingRun.purpose ?? "implement") === "build-discovery" &&
      Boolean(buildCommand) &&
      !blockedSourceProposal &&
      !invalidPatchProposal &&
      !validSourceProposal;
    const implementationHasOpenTasks = latestCodingRun.implementation?.tasks.some((task) => task.status === "todo" || task.status === "doing") ?? false;
    const codingStoppedWithOpenTasks = !noSourceChanges && implementationHasOpenTasks && !needsReplan && !reachedBatchLimitWithMoreWork;
    // A provider-signalled completion is a success, not an empty-output failure,
    // even when this run produced no diff of its own (e.g. the work already
    // existed). The full build verification below is the backstop.
    const completedByReportedSignal = implementationReportedComplete && !needsReplan && !reachedBatchLimitWithMoreWork;
    const noSourceChangesFailure = noSourceChanges && !completedByReportedSignal;
    const codingCompletesSuccessfully = !shouldReviewCode && !buildCommand && !needsReplan && !noSourceChangesFailure && !reachedBatchLimitWithMoreWork && !codingStoppedWithOpenTasks;
    const batchLimitMessage = implementationBatchLimitMessage(
      latestCodingRun.implementation,
      batchLimitVerification,
      implementationBatchBudget(latestCodingRun.implementation?.tasks ?? [])
    );
    codingRun = runSchema.parse({
      ...latestCodingRun,
      status: needsReplan ? "needs-replan" : verificationOnlyNoSourceChanges ? "verifying" : noSourceChangesFailure || reachedBatchLimitWithMoreWork || codingStoppedWithOpenTasks ? "failed" : shouldReviewCode ? "awaiting-code-review" : buildCommand ? "verifying" : "succeeded",
      phase: needsReplan ? "needs-replan" : verificationOnlyNoSourceChanges ? "verifying" : noSourceChangesFailure || reachedBatchLimitWithMoreWork || codingStoppedWithOpenTasks ? "complete" : shouldReviewCode ? "awaiting-code-review" : buildCommand ? "verifying" : "complete",
      implementation: codingCompletesSuccessfully ? completeImplementationSnapshot(latestCodingRun.implementation) : latestCodingRun.implementation,
      contextArtifacts: [
        ...latestCodingRun.contextArtifacts,
        ...(mcpArtifact ? [mcpArtifact.id] : [])
      ],
      todos: needsReplan || (noSourceChangesFailure && !verificationOnlyNoSourceChanges) || reachedBatchLimitWithMoreWork || codingStoppedWithOpenTasks
        ? latestCodingRun.todos.map((todo) => ({ ...todo, status: todo.status === "done" ? "done" : "blocked" }))
        : latestCodingRun.todos,
      logs: [
        ...latestCodingRun.logs,
        ...(mcpArtifact ? [{ at: iso(), stream: "system" as const, text: `MCP transcript artifact: ${mcpArtifact.path}` }] : []),
        needsReplan
          ? { at: iso(), stream: "stderr", text: `Implementation needs replanning: ${latestCodingRun.implementation?.needsReplan?.reason ?? "Coding reported a planning gap."}` }
          : reachedBatchLimitWithMoreWork
          ? { at: iso(), stream: "stderr", text: batchLimitVerification && !batchLimitVerification.passed
            ? `Implementation stopped after the dynamic batch budget; targeted verification still fails: ${batchLimitVerification.command}.`
            : `Implementation stopped after the dynamic batch budget of ${latestCodingRun.implementation?.maxBatches ?? implementationBatchBudget(latestCodingRun.implementation?.tasks ?? [])} batch(es); source work remains.` }
          : codingStoppedWithOpenTasks
            ? { at: iso(), stream: "stderr", text: "Implementation stopped before all implementation tasks completed." }
          : diffArtifact
            ? { at: iso(), stream: "system", text: `Implementation completed after ${latestCodingRun.implementation?.currentBatch ?? batchDiffArtifacts.length} batch(es).` }
          : verificationOnlyNoSourceChanges
            ? { at: iso(), stream: "system", text: `No source or configuration changes were needed. Verification will run: ${buildCommand}` }
          : completedByReportedSignal
            ? { at: iso(), stream: "system", text: "Provider reported the implementation is complete with no further source changes needed." }
          : noSourceChanges
            ? {
                at: iso(),
                stream: "stderr",
                text: blockedSourceProposal
                  ? "Provider returned source changes in an invalid proposal that ArchiCode could not use."
                  : invalidPatchProposal
                    ? "Provider returned an invalid source/graph proposal that ArchiCode could not use."
                    : validSourceProposal
                      ? "Provider returned source-file proposals, but they did not produce a source diff."
                      : "Coding produced no source file changes."
              }
            : { at: iso(), stream: "system", text: "Coding produced a pending proposal for review." },
        ...(createdManagerialFiles.size
          ? [{ at: iso(), stream: "system" as const, text: `Created missing project handoff files: ${[...createdManagerialFiles].join(", ")}` }]
          : []),
        ...reconciliationLogs
      ],
      runInstructions: needsReplan
        ? `Implementation needs replanning: ${latestCodingRun.implementation?.needsReplan?.reason ?? "Coding reported a planning gap."}`
        : reachedBatchLimitWithMoreWork
        ? batchLimitMessage
        : codingStoppedWithOpenTasks
        ? "Implementation stopped before all planned source tasks completed. Retry with the latest checkpoint context."
        : verificationOnlyNoSourceChanges
        ? `Build target discovery completed without source changes. Verification will run: ${buildCommand}`
        : completedByReportedSignal
        ? buildCommand
          ? `Implementation reported complete with no further source changes needed. Verification will run: ${buildCommand}`
          : "Implementation reported complete with no further source changes needed."
        : noSourceChanges
          ? blockedSourceProposal
          ? "Provider returned source changes that ArchiCode could not safely use. Open the invalid proposal artifact or retry with guidance so the provider returns valid source-file operations."
          : "Coding did not produce source changes. Check the Trace tab for provider output and ensure Codex Local uses a write-capable sandbox or the provider returns source-file proposals."
        : shouldReviewCode
        ? "Review the generated source changes, then approve the run to continue verification."
        : buildCommand
          ? `${providerPhase === "debugging" ? "Debugging" : "Coding"} completed. Verification will run: ${buildCommand}`
          : `${providerPhase === "debugging" ? "Debugging" : "Coding"} completed. Configure a project build command to verify changes automatically.`,
      completedAt: (noSourceChangesFailure && !verificationOnlyNoSourceChanges) || reachedBatchLimitWithMoreWork || codingStoppedWithOpenTasks || codingCompletesSuccessfully ? iso() : undefined
    });
    if (await runWasCancelled(projectRoot, run.id)) return;
    await writeRun(projectRoot, (noSourceChangesFailure && !verificationOnlyNoSourceChanges) || reachedBatchLimitWithMoreWork || codingStoppedWithOpenTasks || codingCompletesSuccessfully
      ? await finalizeTerminalRun(projectRoot, codingRun, codingRun.runInstructions ?? "Coding completed.")
      : codingRun);
    if (!needsReplan && (!noSourceChangesFailure || verificationOnlyNoSourceChanges) && !reachedBatchLimitWithMoreWork && !codingStoppedWithOpenTasks && !shouldReviewCode && buildCommand) void scheduleNextQueuedJob(projectRoot);
  } catch (error) {
    await flushRunLogAppends(run.id);
    // The run is already persisted as needs-permission; the approval decision resumes it.
    if (error instanceof RunConsoleApprovalPending) return;
    if (await runWasCancelled(projectRoot, run.id)) return;
    const latestCodingRun = await readRun(projectRoot, run.id).catch(() => codingRun);
    if (latestCodingRun.status === "cancelled") return;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const quotaOrRateLimit = /insufficient_quota|exceeded your current quota|quota exceeded|billing details|rate limit|429/i.test(errorMessage);
    const instructions = quotaOrRateLimit
      ? `Provider quota or rate limit blocked ${providerPhase === "debugging" ? "debugging" : "coding"}: ${compactSummary(errorMessage)}`
      : `${providerPhase === "debugging" ? "Debugging" : "Coding"} failed. Review provider output, source diff state, and command permissions before retrying.`;
    const failed = runSchema.parse({
      ...latestCodingRun,
      status: "failed",
      phase: "complete",
      todos: latestCodingRun.todos.map((todo) => ({ ...todo, status: todo.status === "done" ? "done" : "blocked" })),
      logs: [...latestCodingRun.logs, { at: iso(), stream: "stderr", text: errorMessage }],
      runInstructions: instructions,
      completedAt: iso()
    });
    await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, failed, failed.runInstructions ?? "Coding failed."));
  } finally {
    endRunAbortScope(run.id, abortController);
  }
}

async function completeVerificationRun(projectRoot: string, run: Run): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const buildCommand = await inferredVerificationCommand(projectRoot, bundle);
  if (!buildCommand) {
    const completed = runSchema.parse({
      ...run,
      status: "succeeded",
      phase: "complete",
      implementation: completeImplementationSnapshot(run.implementation),
      runInstructions: "No verification command is configured; coding completed without automatic verification.",
      completedAt: iso()
    });
    await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, completed, completed.runInstructions ?? "Coding completed without automatic verification."));
    return;
  }

  const scope = await evaluateFilesystemScope(projectRoot, bundle.project.settings, buildCommand, projectRoot, classifyCommandRisk(buildCommand));
  const reusablePolicy = commandAllowedBySettings(bundle.project.settings, buildCommand, projectRoot);
  if (!scope.allowed) {
    const failed = runSchema.parse({
      ...run,
      status: "failed",
      phase: "complete",
      filesystemScope: {
        policy: scope.policy,
        cwd: scope.cwd,
        allowedRoots: scope.allowedRoots,
        violations: scope.violations
      },
      permission: {
        decision: "denied",
        reason: `Verification blocked by filesystem scope: ${scope.violations.join(" ")}`
      },
      logs: [...run.logs, { at: iso(), stream: "system", text: `Verification blocked by filesystem scope: ${scope.violations.join(" ")}` }],
      runInstructions: `Verification blocked by filesystem scope: ${scope.violations.join(" ")}`,
      completedAt: iso()
    });
    await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, failed, failed.runInstructions ?? "Verification blocked by filesystem scope."));
    return;
  }

  const verificationCommandApproved = run.permission.decision === "allowed" &&
    (run.phase === "verifying" ||
      Boolean(run.permission.reusablePolicyId) ||
      run.permission.grantedFor === "verification-command" ||
      // Legacy fallback for runs persisted before grantedFor existed.
      run.permission.reason?.includes("verification command"));
  if (!reusablePolicy && !verificationCommandApproved && !commandsAutoApproved(bundle.project.settings, classifyCommandRisk(buildCommand), buildCommand)) {
    await writeRun(projectRoot, runSchema.parse({
      ...run,
      status: "needs-permission",
      phase: "verifying",
      command: buildCommand,
      cwd: projectRoot,
      risk: classifyCommandRisk(buildCommand),
      filesystemScope: {
        policy: scope.policy,
        cwd: scope.cwd,
        allowedRoots: scope.allowedRoots,
        violations: []
      },
      permission: {
        decision: "pending",
        reason: `Verification command "${buildCommand}" needs approval or a trusted command allowlist entry.`
      },
      logs: [...run.logs, { at: iso(), stream: "system", text: `Waiting for approval to verify with: ${buildCommand}` }]
    }));
    return;
  }

  await executeCommandStreaming(projectRoot, runSchema.parse({
    ...run,
    status: "running",
    phase: "verifying",
    command: buildCommand,
    cwd: projectRoot,
    risk: classifyCommandRisk(buildCommand),
    permission: {
      decision: "allowed",
      reason: reusablePolicy ? `Allowed by reusable policy ${reusablePolicy.id}.` : run.permission.reason ?? "Approved for verification."
    },
    logs: [...run.logs, { at: iso(), stream: "system", text: `Verification phase started: ${buildCommand}` }]
  }));
}

type AutoVerificationDebugDecision = {
  shouldStart: boolean;
  attempt: number;
  maxAttempts: number;
  reason: string;
};

function isAutomaticVerificationDebugRun(run: Run): boolean {
  // Legacy fallback: runs persisted before the origin field carried the marker
  // only in their guidance text.
  return run.origin === "auto-verification-debug" || Boolean(run.guidance?.text.includes("Automatic verification debug"));
}

async function countAutomaticVerificationDebugAttempts(projectRoot: string, run: Run): Promise<number> {
  let count = run.automaticVerificationDebugAttempts ?? 0;
  let current: Run | null = run;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isAutomaticVerificationDebugRun(current)) count += 1;
    current = current.retryOf ? await readRun(projectRoot, current.retryOf).catch(() => null) : null;
  }
  return count;
}

async function autoVerificationDebugDecision(
  projectRoot: string,
  run: Run,
  bundle: ProjectBundle,
  exitCode: number | null
): Promise<AutoVerificationDebugDecision> {
  if (exitCode === 0) {
    return { shouldStart: false, attempt: 0, maxAttempts: AUTO_VERIFICATION_DEBUG_MAX_ATTEMPTS, reason: "verification succeeded" };
  }
  if (run.phase !== "verifying") {
    return { shouldStart: false, attempt: 0, maxAttempts: AUTO_VERIFICATION_DEBUG_MAX_ATTEMPTS, reason: "run is not in verification phase" };
  }
  if (!run.sourceDiffArtifactIds.length) {
    return { shouldStart: false, attempt: 0, maxAttempts: AUTO_VERIFICATION_DEBUG_MAX_ATTEMPTS, reason: "no source diff is available to repair" };
  }
  const active = activeRunLane((await loadProject(projectRoot)).runs, run.id);
  if (active) {
    return {
      shouldStart: false,
      attempt: 0,
      maxAttempts: AUTO_VERIFICATION_DEBUG_MAX_ATTEMPTS,
      reason: `active run ${active.id} is already in progress`
    };
  }
  const provider = bundle.project.settings.providers.find((item) => item.id === run.providerId);
  if (!isCodeCapableProvider(provider)) {
    return { shouldStart: false, attempt: 0, maxAttempts: AUTO_VERIFICATION_DEBUG_MAX_ATTEMPTS, reason: "provider cannot produce source repairs" };
  }
  const completedAttempts = await countAutomaticVerificationDebugAttempts(projectRoot, run);
  if (completedAttempts >= AUTO_VERIFICATION_DEBUG_MAX_ATTEMPTS) {
    return {
      shouldStart: false,
      attempt: completedAttempts,
      maxAttempts: AUTO_VERIFICATION_DEBUG_MAX_ATTEMPTS,
      reason: "automatic verification debug limit reached"
    };
  }
  return {
    shouldStart: true,
    attempt: completedAttempts + 1,
    maxAttempts: AUTO_VERIFICATION_DEBUG_MAX_ATTEMPTS,
    reason: "verification failed after source changes"
  };
}

async function continueAutomaticVerificationDebugRun(
  projectRoot: string,
  run: Run,
  decision: AutoVerificationDebugDecision
): Promise<void> {
  try {
    const bundle = await loadProject(projectRoot);
    const guidance = normalizeGuidance({
      text: [
        `Automatic verification debug pass ${decision.attempt}/${decision.maxAttempts}.`,
        "Fix the failing verification with the smallest source-file repair.",
        "Use the selected last error, trace tail, and latest source diff as primary evidence."
      ].join(" "),
      evidence: ["last-error", "trace-tail", "latest-diff"]
    });
    const context = await buildContext(projectRoot, run.flowId, run.nodeId, run.providerId, run.scope);
    const guidanceText = await guidanceEvidenceText(projectRoot, run, guidance);
    const webContext = await harnessWebContext(bundle.project.settings.webSearch.enabled, run.promptSummary, guidance?.text);
    const continuing = runSchema.parse({
      ...run,
      status: "debugging",
      phase: "debugging",
      automaticVerificationDebugAttempts: decision.attempt,
      guidance,
      implementation: undefined,
      sourceReview: undefined,
      completedAt: undefined,
      stoppedAtPhase: undefined,
      contextSummary: context.summary,
      contextArtifacts: [...run.contextArtifacts, ...context.artifacts.map((artifact) => artifact.id)],
      todos: [
        { id: id("todo"), text: "Inspect the failed verification logs and source diff", status: "doing" },
        { id: id("todo"), text: "Produce the smallest repair", status: "todo" },
        { id: id("todo"), text: "Re-run verification", status: "todo" }
      ],
      logs: [
        ...run.logs,
        { at: iso(), stream: "system", text: `Automatic debug pass ${decision.attempt}/${decision.maxAttempts} continuing in this run after verification failure.` },
        ...(guidance ? [{ at: iso(), stream: "system" as const, text: guidanceAttachedLog(guidance, "automatic debug") }] : [])
      ],
      runInstructions: "Automatic recovery is continuing in this run. Make the smallest repair, then verify it."
    });
    await writeRun(projectRoot, continuing);
    queuedContextTextByRun.set(run.id, [
      context.text,
      guidanceText ? `## ${guidanceContextHeading(guidance, "Automatic Debug Evidence")}\n\n${guidanceText}` : "",
      webContext
    ].filter(Boolean).join("\n\n"));
    void scheduleNextQueuedJob(projectRoot);
  } catch (error) {
    const latest = await readRun(projectRoot, run.id).catch(() => run);
    await writeRun(projectRoot, runSchema.parse({
      ...latest,
      logs: [
        ...latest.logs,
        {
          at: iso(),
          stream: "stderr",
          text: `Automatic verification debug could not continue: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    }));
  }
}

async function executeCommandStreaming(projectRoot: string, run: Run): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const normalizedCommand = run.command && (run.phase === "verifying" || isVerificationCommand(run.command))
    ? await normalizeVerificationCommandForProject(projectRoot, run.command)
    : run.command;
  const normalizedRun = normalizedCommand && normalizedCommand !== run.command
    ? runSchema.parse({
        ...run,
        command: normalizedCommand,
        logs: [...run.logs, { at: iso(), stream: "system", text: `Verification command refreshed from ${run.command} to ${normalizedCommand}.` }]
      })
    : run;
  if (normalizedRun.phase === "verifying" && normalizedRun.command && !isFiniteVerificationCommand(normalizedRun.command)) {
    const failed = runSchema.parse({
      ...normalizedRun,
      status: "failed",
      phase: "complete",
      todos: normalizedRun.todos.map((todo) => ({ ...todo, status: "blocked" })),
      logs: [
        ...normalizedRun.logs,
        {
          at: iso(),
          stream: "stderr",
          text: `Verification command rejected because it appears to start a runtime/watch process: ${normalizedRun.command}`
        }
      ],
      runInstructions: "Verification command rejected because it would start an app/runtime/watch process. Use Run App for runtime launch and configure a finite build/test/check command for verification.",
      completedAt: iso()
    });
    await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, failed, failed.runInstructions ?? "Verification command rejected."));
    return;
  }
  const scope = await evaluateFilesystemScope(
    projectRoot,
    bundle.project.settings,
    normalizedRun.command ?? "",
    normalizedRun.cwd || projectRoot,
    normalizedRun.risk ?? classifyCommandRisk(normalizedRun.command ?? "")
  );
  if (!scope.allowed) {
    const failed = runSchema.parse({
      ...normalizedRun,
      status: "failed",
      phase: "complete",
      filesystemScope: {
        policy: scope.policy,
        cwd: scope.cwd,
        allowedRoots: scope.allowedRoots,
        violations: scope.violations
      },
      permission: {
        decision: "denied",
        reason: `Filesystem scope denied: ${scope.violations.join(" ")}`
      },
      todos: normalizedRun.todos.map((todo) => ({ ...todo, status: "blocked" })),
      logs: [...normalizedRun.logs, { at: iso(), stream: "system", text: `Blocked by filesystem scope: ${scope.violations.join(" ")}` }],
      runInstructions: `Blocked by filesystem scope: ${scope.violations.join(" ")}`,
      completedAt: iso()
    });
    await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, failed, failed.runInstructions ?? "Blocked by filesystem scope."));
    return;
  }

  let commandRun = normalizedRun;
  const isDefaultBuildCommand = (normalizedRun.command ?? "") === bundle.project.settings.defaultBuildCommand.trim();
  const alreadyReconciled = normalizedRun.logs.some((line) => /runtime profile reconciliation/i.test(line.text));
  if (isDefaultBuildCommand && !alreadyReconciled) {
    const reconciliationLogs: Run["logs"] = [];
    try {
      const reconciliation = await reconcileRuntimeProfilesWithLlm(projectRoot, commandRun.providerId, "pre-build", `${commandRun.id}-runtime-reconcile`);
      const latestBuildCommand = reconciliation.bundle.project.settings.defaultBuildCommand.trim();
      const effectiveCommand = latestBuildCommand || commandRun.command;
      reconciliationLogs.push({
        at: iso(),
        stream: "system",
        text: reconciliation.proposal
          ? `Pre-build runtime profile reconciliation applied/proposed: ${reconciliation.proposal.artifact.path}`
          : reconciliation.skippedReason ?? "Pre-build runtime profile reconciliation completed without profile changes."
      });
      if (reconciliation.repairSummary) {
        reconciliationLogs.push({
          at: iso(),
          stream: "system",
          text: reconciliation.repairSummary
        });
      }
      commandRun = runSchema.parse({
        ...commandRun,
        command: effectiveCommand,
        logs: [
          ...commandRun.logs,
          ...reconciliationLogs,
          ...(effectiveCommand && effectiveCommand !== commandRun.command
            ? [{ at: iso(), stream: "system" as const, text: `Build command refreshed from ${commandRun.command} to ${effectiveCommand}.` }]
            : [])
        ]
      });
    } catch (error) {
      commandRun = runSchema.parse({
        ...commandRun,
        logs: [
          ...commandRun.logs,
          {
            at: iso(),
            stream: "stderr",
            text: `Pre-build runtime profile LLM reconciliation failed; continuing with ${commandRun.command}. ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      });
    }
    await writeRun(projectRoot, commandRun);
  }

  if (isDefaultBuildCommand) {
    const setupBundle = await loadProject(projectRoot);
    const setupRun = await applyBuildSetupCommands(projectRoot, commandRun, setupBundle.project.settings);
    if (!setupRun) return;
    commandRun = setupRun;
  }
  await writeRun(projectRoot, commandRun);

  const env = buildSubprocessEnv(process.env, {
    ...(commandRun.phase === "verifying" ? { CI: "true" } : {}),
    ...Object.fromEntries(commandRun.env.map((item) => [item.name, item.value ?? ""]))
  });
  const append = async (stream: "stdout" | "stderr" | "system", text: string): Promise<void> => {
    await appendRunLogEntries(projectRoot, commandRun.id, [{ at: iso(), stream, text }]);
  };
  const beforeVerification = commandRun.phase === "verifying"
    ? await collectSourceSnapshot(projectRoot)
    : null;

  // Run the command once and capture its combined output so a failure can be
  // classified as transient (environmental) or deterministic.
  const runCommandOnce = async (): Promise<{ exitCode: number | null; output: string }> => {
    const child = spawn(commandRun.command ?? "", {
      cwd: commandRun.cwd || projectRoot,
      shell: true,
      env,
      detached: process.platform !== "win32"
    });
    activeProcesses.set(commandRun.id, child);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      void append("stdout", text).catch(() => undefined);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      void append("stderr", text).catch(() => undefined);
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });
    activeProcesses.delete(commandRun.id);
    return { exitCode: code, output };
  };

  let { exitCode, output: commandOutput } = await runCommandOnce();
  // Transient-failure retry (verification only): re-run the same command once
  // when the failure looks environmental, so a flaky network/registry/lock
  // failure doesn't escalate to a debug pass. Deterministic compile/test
  // failures don't match and escalate exactly as before.
  let transientRetries = 0;
  while (
    exitCode !== null && exitCode !== 0 &&
    commandRun.phase === "verifying" &&
    transientRetries < MAX_TRANSIENT_VERIFICATION_RETRIES &&
    isTransientVerificationFailure(commandOutput)
  ) {
    const preRetry = await readRun(projectRoot, commandRun.id).catch(() => null);
    if (preRetry?.status === "cancelled") return;
    transientRetries += 1;
    await append("system", `Verification command failed with an apparent transient/environmental error; retrying (attempt ${transientRetries + 1} of ${MAX_TRANSIENT_VERIFICATION_RETRIES + 1}) after a short backoff before escalating to a debug pass.`);
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_VERIFICATION_RETRY_BACKOFF_MS));
    ({ exitCode, output: commandOutput } = await runCommandOnce());
  }

  if (beforeVerification && commandRun.command) {
    const afterVerification = await collectSourceSnapshot(projectRoot);
    await recordVerificationGeneratedArtifacts(
      projectRoot,
      commandRun.id,
      commandRun.command,
      beforeVerification,
      afterVerification
    ).catch(() => undefined);
  }

  await flushRunLogAppends(commandRun.id);
  const latest = await readRun(projectRoot, commandRun.id);
  if (latest.status === "cancelled") return;

  const completedLogs: Run["logs"] = [
    ...latest.logs,
    { at: iso(), stream: "system", text: `Command exited with code ${exitCode ?? "unknown"}.` }
  ];
  const completedStatus: Run["status"] = exitCode === 0 ? "succeeded" : "failed";
  const autoDebug = await autoVerificationDebugDecision(projectRoot, latest, bundle, exitCode);
  const completedInstructions = exitCode === 0
    ? `Verification completed with \`${commandRun.command}\`.`
    : autoDebug.shouldStart
      ? `Verification command failed: \`${commandRun.command}\`. Automatic debug pass ${autoDebug.attempt}/${autoDebug.maxAttempts} will continue in this run to inspect the failure and propose a repair.`
      : `Verification command failed: \`${commandRun.command}\`. Open the run log, address stderr output, then retry the run.`;

  const logArtifact = await persistRunLogArtifact(projectRoot, runSchema.parse({ ...latest, logs: completedLogs }));
  const completed = runSchema.parse({
    ...latest,
    status: completedStatus,
    phase: "complete",
    lastVerification: { command: commandRun.command ?? "", exitCode: exitCode ?? undefined, at: iso() },
    todos: latest.todos.map((todo) => ({ ...todo, status: completedStatus === "succeeded" ? "done" : "blocked" })),
    logs: [
      ...completedLogs,
      { at: iso(), stream: "system", text: `Log artifact: ${logArtifact.path}` },
      ...(autoDebug.shouldStart
        ? [{
            at: iso(),
            stream: "system" as const,
            text: `Automatic debug pass ${autoDebug.attempt}/${autoDebug.maxAttempts} continuing in this run after verification failure.`
          }]
        : exitCode === 0 || autoDebug.reason === "verification succeeded"
          ? []
          : [{
              at: iso(),
              stream: "system" as const,
              text: `Automatic debug not queued: ${autoDebug.reason}.`
            }])
    ],
    runInstructions: completedInstructions,
    completedAt: iso()
  });
  const finalized = await finalizeTerminalRun(projectRoot, completed, completed.runInstructions ?? "Command completed.");
  await writeRun(projectRoot, finalized);
  if (autoDebug.shouldStart) {
    await continueAutomaticVerificationDebugRun(projectRoot, finalized, autoDebug);
  }
}

async function persistRunLogArtifact(projectRoot: string, run: Run): Promise<Artifact> {
  const text = run.logs.map((line) => `[${line.at}] ${line.stream}: ${line.text}`).join("\n");
  const artifact: Artifact = {
    id: id("artifact"),
    type: "log",
    title: `Run log ${run.id}`,
    path: `.archicode/artifacts/${run.id}-log.json`,
    runId: run.id,
    summary: `${run.logs.length} log entries`,
    sizeBytes: Buffer.byteLength(text, "utf8"),
    createdAt: iso()
  };
  await writeJson(path.join(projectRoot, artifact.path), {
    ...artifact,
    text
  });
  return artifact;
}

export async function runAgent(input: {
  projectRoot: string;
  flowId: string;
  nodeId?: string;
  providerId: string;
  effort?: RunEffort;
  promptSummary: string;
  command?: string;
  allowShell?: boolean;
  scope?: RunScope;
}): Promise<ProjectBundle> {
  const bundle = await loadProject(input.projectRoot);
  const command = input.command?.trim();
  const risk = command ? classifyCommandRisk(command) : "low";
  const reusablePolicy = command ? commandAllowedBySettings(bundle.project.settings, command, input.projectRoot) : null;
  const commandIsAllowed = Boolean(reusablePolicy);
  const needsPermission = Boolean(command && !commandIsAllowed && !input.allowShell && !commandsAutoApproved(bundle.project.settings, risk, command));
  const context = await buildContext(input.projectRoot, input.flowId, input.nodeId, input.providerId, input.scope);

  const run: Run = runSchema.parse({
    id: id("run"),
    flowId: input.flowId,
    nodeId: input.nodeId,
    providerId: input.providerId,
    status: needsPermission ? "needs-permission" : "running",
    effort: input.effort ?? "high",
    promptSummary: input.promptSummary,
    command,
    risk,
    scope: input.scope ? runScopeSchema.parse(input.scope) : undefined,
    permission: {
      decision: command ? (needsPermission ? "pending" : "allowed") : "allowed",
      reason: command ? "Shell access is permission-gated and persisted with the run." : "No shell command requested."
    },
    contextSummary: context.summary,
    contextArtifacts: context.artifacts.map((artifact) => artifact.id),
    policyBaselineViolationIds: architecturePolicyBaselineViolationIds(bundle),
    todos: [
      { id: id("todo"), text: "Collect relevant JSON project context", status: "done" },
      { id: id("todo"), text: command ? `Execute ${command}` : "Produce offline harness guidance", status: needsPermission ? "blocked" : "doing" }
    ],
    logs: [
      { at: iso(), stream: "system", text: `Prepared context (${context.text.length} characters).` },
      { at: iso(), stream: "system", text: needsPermission ? "Waiting for shell permission." : "Run started." }
    ],
    createdAt: iso(),
    startedAt: needsPermission ? undefined : iso()
  });

  await writeRun(input.projectRoot, run);

  if (needsPermission) return loadProject(input.projectRoot);
  if (!command) {
    await completeProviderRun(input.projectRoot, run, bundle.project.settings.providers.find((provider) => provider.id === input.providerId), context.text);
    return loadProject(input.projectRoot);
  }

  await executeCommand(input.projectRoot, run, command);
  return loadProject(input.projectRoot);
}

async function completeProviderRun(
  projectRoot: string,
  run: Run,
  provider: Project["settings"]["providers"][number] | undefined,
  contextText: string
): Promise<void> {
  const abortController = beginRunAbortScope(run.id);
  try {
    const bundle = await loadProject(projectRoot);
    const buildCommand = bundle.project.settings.defaultBuildCommand.trim();
    if (!provider) {
      throw new Error(`Provider ${run.providerId} was not found. Choose a configured provider before running.`);
    }
    const latestRun = await readRun(projectRoot, run.id).catch(() => run);
    if (latestRun.status === "cancelled") return;
    const providerCapabilities = await providerOptionsForRun(projectRoot, latestRun, bundle.project.settings, provider);
    await consumeRunMcpContinuation(projectRoot, run.id);
    const runnableProvider = await hydrateProviderForUse(provider);
    let providerRunUsage: LlmUsage | undefined;
    const output = await callProviderForRun(projectRoot, run.id, runnableProvider, contextText, run.promptSummary, {
      projectRoot,
      webSearchEnabled: nativeWebSearchEnabled(bundle.project.settings),
      signal: abortController.signal,
      onUsage: (usage) => { providerRunUsage = usage; },
      ...providerCapabilities
    });
    if (providerRunUsage) await persistRunUsage(projectRoot, run.id, "planning", [providerRunUsage]);
    if (await runWasCancelled(projectRoot, run.id)) return;
    if (await maybePauseForLocalProviderMcpApproval(projectRoot, run.id, provider, bundle.project.settings, output)) return;
    const patchProposal = await persistAndMaybeApplyPatchProposal(projectRoot, run.id, output);
    if (await runWasCancelled(projectRoot, run.id)) return;
    const latestProviderRun = await readRun(projectRoot, run.id).catch(() => run);
    if (latestProviderRun.status === "cancelled") return;
    const mcpArtifact = await writeMcpTranscriptArtifact(projectRoot, latestProviderRun);
    if (await runWasCancelled(projectRoot, run.id)) return;
    const patchInstruction = patchProposal
      ? patchProposal.pendingReview
        ? "Review the pending graph patch proposal before applying model-managed project changes."
        : patchProposal.autoApplied
          ? "Agent graph updates were applied automatically and logged as a change artifact."
          : "Agent graph changes were logged as an artifact."
      : "Review the run log and resolve any LLM questions as node notes.";

    const completed: Run = {
      ...latestProviderRun,
      status: "succeeded",
      phase: "complete",
      todos: latestProviderRun.todos.map((todo) => ({ ...todo, status: "done" })),
      logs: [
        ...latestProviderRun.logs,
        { at: iso(), stream: "system", text: output },
        ...(mcpArtifact ? [{ at: iso(), stream: "system" as const, text: `MCP transcript artifact: ${mcpArtifact.path}` }] : [])
      ],
      contextArtifacts: mcpArtifact ? [...latestProviderRun.contextArtifacts, mcpArtifact.id] : latestProviderRun.contextArtifacts,
      runInstructions: patchProposal
        ? buildCommand
          ? `${patchInstruction} Verify the actual project with: ${buildCommand}`
          : `${patchInstruction} Set or discover the project verification command if needed.`
        : buildCommand
          ? `${patchInstruction} Then verify the actual project with: ${buildCommand}`
          : `${patchInstruction} Add a project-specific verification command once it is known.`,
      completedAt: iso()
    };
    await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, runSchema.parse(completed), completed.runInstructions ?? "Provider run completed."));
  } catch (error) {
    // The run is already persisted as needs-permission; the approval decision resumes it.
    if (error instanceof RunConsoleApprovalPending) return;
    if (await runWasCancelled(projectRoot, run.id)) return;
    const failed: Run = {
      ...run,
      status: "failed",
      phase: "complete",
      todos: run.todos.map((todo) => ({ ...todo, status: "blocked" })),
      logs: [
        ...run.logs,
        { at: iso(), stream: "stderr", text: error instanceof Error ? error.message : String(error) }
      ],
      runInstructions: "Provider execution failed. Check provider settings and API key, then rerun the node agent.",
      completedAt: iso()
    };
    await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, runSchema.parse(failed), failed.runInstructions ?? "Provider execution failed."));
  } finally {
    endRunAbortScope(run.id, abortController);
  }
}

export async function persistAndMaybeApplyPatchProposal(
  projectRoot: string,
  runId: string,
  output: string,
  options: { allowSourceFileAutoApply?: boolean; phase?: RunPhase; artifactSuffix?: string; forceManualReview?: boolean } = {}
): Promise<PersistedPatchProposal | null> {
  const extraction = extractArchicodePatch(output, runId, { phase: options.phase });
  const artifactSuffix = options.artifactSuffix ? `-${options.artifactSuffix.replace(/[^a-z0-9-]/gi, "-")}` : "";
  if (!extraction.proposal) {
    if (!extraction.errors.length || !looksLikePatchHandoff(output)) return null;
    const artifact: Artifact = {
      id: id("artifact"),
      type: "generated-file",
      title: `Unusable provider handoff for ${runId}`,
      path: `.archicode/artifacts/${runId}-invalid-patch-proposal${artifactSuffix}.json`,
      runId,
      status: "pending-review",
      summary: "ArchiCode could not safely use the provider's proposed changes.",
      createdAt: iso()
    };
    await writeJson(path.join(projectRoot, artifact.path), {
      ...artifact,
      archicodePatch: {
        invalid: true,
        errors: extraction.errors,
        quarantinedOperations: extraction.quarantinedOperations,
        warnings: extraction.warnings
      },
      rawProviderOutput: output,
      error: extraction.errors.join(" | "),
      recovery: "Retry handoff by rerunning with guidance or ask the provider to return valid ArchiCode operations."
    });
    return {
      artifact,
      mode: "manual",
      autoApplied: false,
      pendingReview: true,
      hasSourceFileOperations: false,
      valid: false,
      summary: undefined,
      warnings: extraction.warnings,
      quarantinedOperations: extraction.quarantinedOperations,
      validationError: extraction.errors.join(" | ")
    };
  }

  try {
    const bundle = await loadProject(projectRoot);
    const settings = bundle.project.settings;
    const proposal = llmPatchProposalSchema.parse(extraction.proposal);
    if (settings.buildTargetsLocked && proposal.operations.some((operation) => operation.kind === "propose-run-profile")) {
      throw new Error("Build targets are locked in Project Settings. The provider must use the configured targets without proposing replacements.");
    }
    const hasSourceProposals = hasSourceFileOperations(proposal);
    if (hasSourceProposals && (options.phase === "coding" || options.phase === "debugging")) {
      const attributionRun = await readRun(projectRoot, runId).catch(() => null);
      const attributionFlows = attributionRun?.scope?.kind === "project" || !attributionRun
        ? bundle.flows
        : bundle.flows.filter((flow) => flow.id === attributionRun.flowId);
      const allowedNodes = attributionFlows.flatMap((flow) => flow.ignored ? [] : flow.nodes
        .filter((node) => !node.ignored && !isSubflowIgnored(flow, node.subflowId))
        .map((node) => ({ flowId: flow.id, nodeId: node.id, title: node.title })));
      const allowedIds = new Set(allowedNodes.map((node) => node.nodeId));
      for (const operation of proposal.operations) {
        if (operation.kind !== "propose-source-file") continue;
        const nodeIds = sourceFileProposalNodeIds(operation);
        if (!nodeIds.length) {
          throw new Error(`Source attribution is required for ${operation.path}: include nodeIds with at least one ID from sourceAttribution.allowedNodes.`);
        }
        const invalidIds = nodeIds.filter((nodeId) => !allowedIds.has(nodeId));
        if (invalidIds.length) {
          const allowedSummary = allowedNodes.slice(0, 80).map((node) => `${node.nodeId} (${node.title})`).join(", ");
          throw new Error(`Source attribution for ${operation.path} contains unknown nodeIds: ${invalidIds.join(", ")}. Allowed node IDs: ${allowedSummary}.`);
        }
      }
    }
    const allowSourceFileAutoApply = options.allowSourceFileAutoApply !== false;
    const sourceProposalsAreActionable = allowSourceFileAutoApply && options.phase !== "planning";
    const planningGraphReview = options.phase === "planning" && settings.planningReviewMode === "manual";
    const hasOnlyUnactionableSourceProposals = hasSourceProposals &&
      !sourceProposalsAreActionable &&
      proposal.operations.every((operation) => operation.kind === "propose-source-file");
    const manualReview = Boolean(options.forceManualReview) || (planningGraphReview &&
      hasManualGraphReviewOperations(proposal) &&
      !hasOnlyProjectFileOperations(proposal) &&
      !hasOnlyUnactionableSourceProposals);
    const artifact: Artifact = {
      id: id("artifact"),
      type: "generated-file",
      title: hasSourceProposals
        ? `Source proposal for ${runId}`
        : hasStructuralProposalOperations(proposal)
          ? `Planning proposal for ${runId}`
          : `LLM patch proposal for ${runId}`,
      path: `.archicode/artifacts/${runId}-patch-proposal${artifactSuffix}.json`,
      runId,
      status: manualReview ? "pending-review" : undefined,
      summary: proposal.summary,
      createdAt: iso()
    };
    await writeJson(path.join(projectRoot, artifact.path), {
      ...artifact,
      archicodePatch: proposal,
      codingHandoff: {
        quarantinedOperations: extraction.quarantinedOperations,
        warnings: extraction.warnings
      }
    });
    if (manualReview) {
      return {
        artifact,
      mode: options.forceManualReview ? "manual" : settings.patchReviewMode,
      autoApplied: false,
      pendingReview: true,
      hasSourceFileOperations: hasSourceProposals,
      valid: true,
      summary: proposal.summary,
      implementationStatus: proposal.runSummary?.implementationStatus,
      implementationNotes: proposal.runSummary?.notes ?? proposal.runSummary?.verificationNotes,
      nextSourceSlice: proposal.runSummary?.nextSourceSlice,
      needsReplan: proposal.runSummary?.needsReplan,
      replanReason: proposal.runSummary?.replanReason,
      suggestedQuestions: proposal.runSummary?.suggestedQuestions,
      implementationEffort: proposal.runSummary?.implementationEffort,
      implementationTasks: proposal.runSummary?.implementationTasks,
      warnings: extraction.warnings,
      quarantinedOperations: extraction.quarantinedOperations
    };
    }

    const currentRun = await readRun(projectRoot, runId).catch(() => null);
    const rejectedDeletionPaths = new Set((currentRun?.sourceDeletionDecisions ?? [])
      .filter((item) => item.decision === "rejected")
      .map((item) => item.path));
    const previouslyRejectedDeletionIndexes = new Set<number>();
    const sourceDeletionSafety = await Promise.all(proposal.operations.map(async (operation, operationIndex) => {
      if (operation.kind !== "propose-source-file" || operation.action !== "delete" || !sourceProposalsAreActionable) return null;
      const safety = await evaluateSourceFileSafety(projectRoot, operation, { runId });
      const normalizedPath = safety.normalizedPath ?? operation.path;
      if (rejectedDeletionPaths.has(normalizedPath)) {
        previouslyRejectedDeletionIndexes.add(operationIndex);
        return null;
      }
      return safety.safe && safety.requiresReview
        ? { operationIndex, path: normalizedPath }
        : null;
    }));
    const pendingSourceDeletions = sourceDeletionSafety.filter((item): item is { operationIndex: number; path: string } => Boolean(item));
    const decisions = await autoPatchDecisions(projectRoot, proposal, {
      allowReviewRequiredSourceFiles: hasSourceProposals && sourceProposalsAreActionable,
      rejectSourceFileOperations: hasSourceProposals && !sourceProposalsAreActionable,
      rejectPlanningQuestions: options.phase === "planning" && settings.planningReviewMode !== "manual",
      runId
    });
    await applyPatchProposal(projectRoot, artifact.id, decisions, { recordSourceDiff: false });
    if (pendingSourceDeletions.length) {
      const rawArtifact = await readJson<Record<string, unknown>>(path.join(projectRoot, artifact.path), {});
      await writeJson(path.join(projectRoot, artifact.path), { ...rawArtifact, status: "pending-review" });
    }
    const proposals = await listPatchProposals(projectRoot);
    const appliedProposal = proposals.find((item) => item.artifact.id === artifact.id);
    const appliedArtifact = appliedProposal?.artifact ?? artifact;
    const sourceOperationIndexes = new Set(proposal.operations.flatMap((operation, operationIndex) =>
      operation.kind === "propose-source-file" ? [operationIndex] : []));
    const pendingIndexes = new Set(pendingSourceDeletions.map((item) => item.operationIndex));
    const sourceOperationsBlocked = Boolean(appliedProposal?.review?.results.some((result) =>
      sourceOperationIndexes.has(result.operationIndex) &&
      !pendingIndexes.has(result.operationIndex) &&
      !previouslyRejectedDeletionIndexes.has(result.operationIndex) &&
      (result.status === "failed" || result.status === "rejected")));
    return {
      artifact: appliedArtifact,
      mode: "auto",
      autoApplied: true,
      pendingReview: pendingSourceDeletions.length > 0,
      pendingSourceOperationIndexes: pendingSourceDeletions.map((item) => item.operationIndex),
      pendingSourcePaths: pendingSourceDeletions.map((item) => item.path),
      sourceOperationsBlocked,
      hasSourceFileOperations: hasSourceProposals,
      valid: true,
      summary: proposal.summary,
      implementationStatus: proposal.runSummary?.implementationStatus,
      implementationNotes: proposal.runSummary?.notes ?? proposal.runSummary?.verificationNotes,
      nextSourceSlice: proposal.runSummary?.nextSourceSlice,
      needsReplan: proposal.runSummary?.needsReplan,
      replanReason: proposal.runSummary?.replanReason,
      suggestedQuestions: proposal.runSummary?.suggestedQuestions,
      implementationEffort: proposal.runSummary?.implementationEffort,
      implementationTasks: proposal.runSummary?.implementationTasks,
      warnings: extraction.warnings,
      quarantinedOperations: extraction.quarantinedOperations
    };
  } catch (error) {
    const artifact: Artifact = {
      id: id("artifact"),
      type: "generated-file",
      title: `Unusable provider handoff for ${runId}`,
      path: `.archicode/artifacts/${runId}-invalid-patch-proposal${artifactSuffix}.json`,
      runId,
      status: "pending-review",
      summary: "ArchiCode could not safely use the provider's proposed changes.",
      createdAt: iso()
    };
    await writeJson(path.join(projectRoot, artifact.path), {
      ...artifact,
      archicodePatch: extraction.proposal,
      codingHandoff: {
        quarantinedOperations: extraction.quarantinedOperations,
        warnings: extraction.warnings
      },
      rawProviderOutput: output,
      error: error instanceof Error ? error.message : String(error),
      recovery: "Retry handoff by rerunning with guidance or ask the provider to return valid ArchiCode operations."
    });
    return {
      artifact,
      mode: "manual",
      autoApplied: false,
      pendingReview: true,
      hasSourceFileOperations: false,
      valid: false,
      summary: undefined,
      warnings: extraction.warnings,
      quarantinedOperations: extraction.quarantinedOperations,
      validationError: error instanceof Error ? error.message : String(error)
    };
  }
}

export function looksLikePatchHandoff(output: string): boolean {
  return output.includes("archicodePatch") ||
    (output.includes("\"schemaVersion\"") && output.includes("\"operations\"")) ||
    output.includes("\"propose-source-file\"");
}

async function completeOfflineRun(projectRoot: string, run: Run): Promise<void> {
  const completed: Run = {
    ...run,
    status: "succeeded",
    phase: "complete",
    todos: run.todos.map((todo) => ({ ...todo, status: "done" })),
    logs: [
      ...run.logs,
      { at: iso(), stream: "system", text: "Offline/manual provider completed. Review notes and node state remain user-controlled." }
    ],
    runInstructions: "Review the generated run record and resolve any LLM questions as node notes. Configure a project build command only when users or agents need a concrete verification command.",
    completedAt: iso()
  };
  await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, runSchema.parse(completed), completed.runInstructions ?? "Offline/manual provider completed."));
}

async function executeCommand(projectRoot: string, run: Run, command: string): Promise<void> {
  let effectiveCommand = command;
  let commandRun = run;
  const initialBundle = await loadProject(projectRoot);
  if (command === initialBundle.project.settings.defaultBuildCommand.trim()) {
    const reconciliationLogs: Run["logs"] = [];
    try {
      const reconciliation = await reconcileRuntimeProfilesWithLlm(projectRoot, run.providerId, "pre-build", `${run.id}-runtime-reconcile`);
      const latestBuildCommand = reconciliation.bundle.project.settings.defaultBuildCommand.trim();
      effectiveCommand = latestBuildCommand || command;
      reconciliationLogs.push({
        at: iso(),
        stream: "system",
        text: reconciliation.proposal
          ? `Pre-build runtime profile reconciliation applied/proposed: ${reconciliation.proposal.artifact.path}`
          : reconciliation.skippedReason ?? "Pre-build runtime profile reconciliation completed without profile changes."
      });
      if (reconciliation.repairSummary) {
        reconciliationLogs.push({
          at: iso(),
          stream: "system",
          text: reconciliation.repairSummary
        });
      }
    } catch (error) {
      reconciliationLogs.push({
        at: iso(),
        stream: "stderr",
        text: `Pre-build runtime profile LLM reconciliation failed; continuing with ${command}. ${error instanceof Error ? error.message : String(error)}`
      });
    }
    commandRun = runSchema.parse({
      ...run,
      command: effectiveCommand,
      logs: [
        ...run.logs,
        ...reconciliationLogs,
        ...(effectiveCommand !== command
          ? [{ at: iso(), stream: "system" as const, text: `Build command refreshed from ${command} to ${effectiveCommand}.` }]
          : [])
      ]
    });
    await writeRun(projectRoot, commandRun);
  }

  if (command === initialBundle.project.settings.defaultBuildCommand.trim()) {
    const setupBundle = await loadProject(projectRoot);
    const setupRun = await applyBuildSetupCommands(projectRoot, commandRun, setupBundle.project.settings);
    if (!setupRun) return;
    commandRun = setupRun;
  }

  const scopeBundle = await loadProject(projectRoot);
  const scope = await evaluateFilesystemScope(
    projectRoot,
    scopeBundle.project.settings,
    effectiveCommand,
    commandRun.cwd || projectRoot,
    commandRun.risk ?? classifyCommandRisk(effectiveCommand)
  );
  if (!scope.allowed) {
    const failed = runSchema.parse({
      ...commandRun,
      status: "failed",
      phase: "complete",
      filesystemScope: {
        policy: scope.policy,
        cwd: scope.cwd,
        allowedRoots: scope.allowedRoots,
        violations: scope.violations
      },
      permission: {
        decision: "denied",
        reason: `Filesystem scope denied: ${scope.violations.join(" ")}`
      },
      todos: commandRun.todos.map((todo) => ({ ...todo, status: "blocked" })),
      logs: [...commandRun.logs, { at: iso(), stream: "system", text: `Blocked by filesystem scope: ${scope.violations.join(" ")}` }],
      runInstructions: `Blocked by filesystem scope: ${scope.violations.join(" ")}`,
      completedAt: iso()
    });
    await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, failed, failed.runInstructions ?? "Blocked by filesystem scope."));
    return;
  }

  const child = spawn(effectiveCommand, {
    cwd: projectRoot,
    shell: true,
    env: buildSubprocessEnv(process.env)
  });

  const logs = [...commandRun.logs];
  const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    logs.push({ at: iso(), stream, text: chunk.toString() });
  };

  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

  const completed: Run = {
    ...commandRun,
    status: exitCode === 0 ? "succeeded" : "failed",
    phase: "complete",
    lastVerification: { command: effectiveCommand, exitCode: exitCode ?? undefined, at: iso() },
    implementation: exitCode === 0 ? completeImplementationSnapshot(commandRun.implementation) : commandRun.implementation,
    todos: commandRun.todos.map((todo) => ({ ...todo, status: exitCode === 0 ? "done" : "blocked" })),
    logs: [
      ...logs,
      { at: iso(), stream: "system", text: `Command exited with code ${exitCode ?? "unknown"}.` }
    ],
    runInstructions: exitCode === 0
      ? `Command completed: \`${effectiveCommand}\`.`
      : `Command failed: \`${effectiveCommand}\`. Open the run log, address stderr output, then rerun the command from ArchiCode.`,
    completedAt: iso()
  };

  await writeRun(projectRoot, await finalizeTerminalRun(projectRoot, runSchema.parse(completed), completed.runInstructions ?? "Command completed."));
}
