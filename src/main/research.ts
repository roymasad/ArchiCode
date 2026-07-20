import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { gaiaAgent, pandoraAgent } from "../shared/agentIdentities";
import { authorAcceptanceTestsScoped, runNodeAcceptanceChecks } from "./storage/acceptanceChecks";
import { createAttachmentArtifacts, createImageArtifacts, imageAttachmentsForNodeNotes, mediaTypeForFile, textAttachmentsForNodeNotes, uniqueProviderImageAttachments, uniqueProviderTextAttachments } from "./storage/artifacts";
import { reconcileRuntimeProfilesWithLlm, refreshInferredProjectCommands } from "./storage/commandInference";
import { recordGraphChange } from "./storage/ledgers";
import { addNote, deleteNote, updateNoteResolved } from "./storage/notes";
import { readArtifactText } from "./storage/patches";
import { hydrateProviderForUse, loadProject, saveFlow, saveFlows, updateNode, updateProjectMetadata, updateProjectSettings } from "./storage/projectStore";
import { retryRun, runInternalConsoleCommand, startAgentRun, startDebuggingRun, startIncidentDebugRun, startRunProfile, startRuntimeDebugRun } from "./storage/runEngine";
import { listRuntimeServices } from "./storage/runtimeServices";
import { callResearchProvider, inferModelCapabilityProfile, isExplicitDelphiAuditRequest, resolvePhaseModelPolicy, type Provider, type ProviderTokenKind, type ResearchProviderContinuation } from "./providers";
import { selectedSkillsPrompt } from "./skills";
import { callMcpTool, providerMcpTools, type ProviderMcpTool } from "./mcp";
import {
  ARCHICODE_RESEARCH_RULES_SERVER_ID,
  ARCHICODE_RESEARCH_RULES_TOOL_NAME,
  archicodeInternalTools,
  archicodeResearchRulesTool,
  callArchicodeInternalTool,
  describeResearchRulesMutation,
  isArchicodeInternalTool,
  researchRulesToolRequiresApproval
} from "./internalTools";
import { refreshArchitecturePolicyEvaluation } from "./policies/architecturePolicies";
import { isSupportedTextDocumentMediaType } from "./documentText";
import { investigationToolProgressMessage } from "./microRunAgents/readOnlyTools";
import {
  applyNodePatch,
  archicodeNodeSchema,
  noteCategorySchema,
  noteKindSchema,
  flowEdgeSchema,
  flowGroupSchema,
  flowSchema,
  flowSubflowSchema,
  isNoteActiveForModelContext,
  isProductionApproved,
  issuePrioritySchema,
  nodeFlagSchema,
  nodeStageSchema,
  nodeVisualShapeSchema,
  researchChatScopeSchema,
  researchChatSessionSchema,
  researchCanvasActionSchema,
  researchGraphChangeSetSchema,
  researchGraphOperationSchema,
  researchMemoryDeltaSchema,
  researchMemorySchema,
  researchGraphChangeDecisionSchema,
  runPhaseSchema,
  runStatusSchema,
  runTargetProfileSchema,
  type Artifact,
  type ArchicodeNode,
  type CodebaseMappingGranularity,
  type Note,
  type Flow,
  type FlowEdge,
  type FlowGroup,
  type FlowSubflow,
  type NodePatch,
  type ProjectBundle,
  type ProjectSettings,
  type ResearchChatMessage,
  type ResearchCanvasAction,
  type ResearchMemory,
  type ResearchMemoryDelta,
  type ResearchOrchestration,
  type ResearchChatScope,
  type ResearchChatSession,
  type ResearchGraphChangeDecision,
  type ResearchGraphChangeResult,
  type ResearchGraphOperation,
  type ResearchMessageNodeReference,
  type RunGuidance,
  type Run,
  type LlmUsage
} from "../shared/schema";
import { autoLayoutFlow, deleteSubflowFromFlow, isSubflowIgnored, linkNodeToSubflow, normalizeEvidenceFlow, workingNodesForFlow } from "../shared/graph";
import { researchChangeSetCategory, type ResearchChangeSetCategory } from "../shared/researchChangeSetSemantics";
import { runCodebaseImport } from "./importer";
import { CodebaseImportCancelledError, type CodebaseImportInput } from "./importer/types";
import { layoutImportedFlow, layoutScopeByDependencyDepth } from "./importer/layout";
import { importedProjectMetadata } from "./importer/projectMetadata";
import { buildImportSummarySections, countActionableReviewConcerns, estimateImportAccuracy, importSummaryStatus, summarizeImportProviderCalls, type ImportAccuracyEstimate, type ImportSummarySections } from "./importer/importSummary";
import { writeInitialCodebaseImportReport } from "./importer/importReports";
import { createResyncBaseline, writeResyncBaseline } from "./importer/resyncBaseline";
import { runCodebaseResync } from "./importer/resync";
import type { ResyncProgress, ResyncResult, ResyncScope } from "./importer/resyncTypes";
import { extractArchicodeResearch } from "../shared/researchExtraction";
import { parseGlobalResearchPersonality, parseGlobalResearchVerbosity, pickRandomResearchThinkingPhrase, researchPersonalityPrompt, type GlobalResearchPersonality, type GlobalResearchVerbosity } from "../shared/researchPersonality";
import { deriveResearchChatContextPlan, estimateTextTokens } from "../shared/contextBudget";
import { mergeReasoningReplayStates } from "../shared/llmPricing";
import { providerImageInputSupportStatus, type ProviderImageInputSupportStatus } from "../shared/providerCapabilities";
import { compactImplementationScope, implementationScopeAdvisory, semanticRetrievalAdvisory } from "../shared/implementationScope";
import { archicodeCapabilityDigest, archicodeCapabilityVersion, archicodeCurrentProjectOptions } from "../shared/appCapabilities";
import { readProjectConventions } from "./projectConventions";
import { isRepairableProjectToolError, normalizeProjectToolArguments, repairableProjectToolResult } from "../shared/toolRepair";
import { executeMicroRun, getConflictedFiles, commitStagedResolution, resolveMicroRunProvider, type MicroRunResult } from "./microRuns";
import { registerAllMicroRunAgents } from "./microRunAgents";
import type {
  MergeResolutionInput,
  MergeResolutionOutput,
  GraphReconciliationInput,
  GraphReconciliationOutput,
  PicassoGraphOutput,
  SherlockResearchInput,
  SherlockResearchOutput,
  DelphiTestingInput,
  DelphiTestingOutput,
  SubagentRun
} from "../shared/schema";
import { delphiTestingInputSchema } from "../shared/schema";
import { searchSemanticIndex, semanticRelatedNodeIds } from "./semanticIndex";
import {
  type ResearchChangeSet,
  type ResearchOperation,
  applyResearchOperation,
  collectResearchChangeSetValidationErrors,
  createNodeHasExplicitPlacement,
  findFlow,
  formatResearchChangeSetValidationErrors,
  isNoopResearchUpdateNode,
  normalizeResearchAgentRunNodeIds,
  normalizeResearchQueueProviders,
  normalizeResearchSubflowFlowIds,
  shouldAutoApproveResearchChangeSet
} from "./research/graphOps";

import {
  RESEARCH_CHAT_HISTORY_DEFAULT_CHARS,
  RESEARCH_CHAT_HISTORY_DEFAULT_MESSAGES,
  RESEARCH_CHAT_HISTORY_MAX_CHARS,
  RESEARCH_CHAT_HISTORY_MAX_MESSAGES,
  RESEARCH_CHAT_HISTORY_SERVER_ID,
  RESEARCH_CHAT_HISTORY_TOOL,
  RESEARCH_PREVIOUS_CHATS_SERVER_ID,
  RESEARCH_CONTEXT_EXPANSION_TOOL,
  RESEARCH_CONTEXT_SERVER_ID,
  buildResearchGraphLayoutToolResult,
  callResearchProjectFileTool,
  isResearchChangeSetTool,
  isResearchCanvasControlTool,
  isResearchChatHistoryTool,
  isResearchPreviousChatsTool,
  isResearchContextExpansionTool,
  isResearchGraphLayoutTool,
  isResearchMemoryTool,
  isResearchProjectFileTool,
  isResearchSinkTool,
  isResearchSpawnGraphReconciliationTool,
  isResearchSpawnMergeTool,
  isResearchSpawnDelphiTool,
  isResearchSpawnSherlockTool,
  microRunHumanSummary,
  microRunResultText,
  researchChatHistoryTool,
  researchPreviousChatsTool,
  researchContextExpansionTool,
  researchGraphLayoutTool,
  researchProjectFileAccessContext,
  researchProjectFileTools,
  researchSinkTools,
  researchSubagentTools
} from "./research/inspectionTools";

import {
  applyResearchPromptBudget,
  attachResearchContextLedger,
  buildCompactResearchContext,
  buildExpandedResearchContextToolResult,
  buildResearchChatHistoryToolResult,
  buildResearchPreviousChatsToolResult,
  buildResearchContext,
  buildResearchContextLedger,
  chooseResearchContextMode,
  activeResearchGraphLockRuns
} from "./research/contextAssembly";
import {
  applyHostObservedResearchMemory,
  applyResearchTurnMemory,
  buildResearchTurnChangeSet,
  compactResearchMemoryIfNeeded,
  formatResearchMemoryForPrompt,
  formatResearchOrchestrationForPrompt,
  checkpointResearchGoal,
  reviewResearchChangeSetTodo,
  startResearchGoal,
  trackResearchChangeSetTodo
} from "./research/memoryFold";
import { fetchResearchWebPages } from "./research/webFetch";
import { listResearchChats, markSubagentRunSettled, persistResearchSession, readChatsForMutation, transitionSubagentRun, withResearchSessionLock } from "./research/chatStore";
import { deriveResearchTurnKind, researchTurnPolicy } from "./research/turnPolicy";
import { compatibleDelphiRuntimeProfiles, inspectDelphiTestEnvironment, pinDelphiRuntimeTarget } from "./testing/toolchains";
import { createChatArtifact } from "./storage/researchKnowledge";
import { delphiAdapterCacheRoot, installDelphiManagedTool } from "./testing/toolCache";
import { acquireDelphiRuntimeTarget, planDelphiRuntimeLaunch, releaseDelphiRuntimeTarget, type DelphiRuntimeLease } from "./testing/runtimeLifecycle";


// Register all micro-run agents on module load
registerAllMicroRunAgents();

export function effectiveDelphiModelPreflight(provider: Provider): {
  modelId: string;
  imageInputSupport: ProviderImageInputSupportStatus;
  capabilitySource: "detected" | "heuristic";
} {
  const delphiProvider = resolveMicroRunProvider(provider, "delphi-testing");
  const modelPolicy = resolvePhaseModelPolicy(delphiProvider, "brainstorming");
  const modelId = modelPolicy.modelOverride ?? delphiProvider.model ?? "unknown";
  const capability = providerImageInputSupportStatus(delphiProvider, modelPolicy.modelOverride);
  return {
    modelId,
    imageInputSupport: capability.status,
    capabilitySource: capability.source
  };
}

function delphiVisionPreflightText(preflight: ReturnType<typeof effectiveDelphiModelPreflight>): string {
  if (preflight.imageInputSupport === "supported") {
    return `Effective Delphi model ${preflight.modelId} supports image input (${preflight.capabilitySource} capability). For explicit visual, layout, or responsive inspection, Delphi must inspect pixels from selected captures before it can pass that portion of the audit.`;
  }
  if (preflight.imageInputSupport === "unsupported") {
    return `Effective Delphi model ${preflight.modelId} does not support image input (${preflight.capabilitySource} capability). Delphi can still inspect the requested page with functional/DOM assertions and capture screenshots for the user, but it cannot pass pixel-level visual, layout, or responsive inspection.`;
  }
  return `Image-input support for effective Delphi model ${preflight.modelId} is unknown (${preflight.capabilitySource} capability). Treat screenshots as user-review evidence only and do not promise pixel-level visual inspection unless capability detection is refreshed first.`;
}

let globalResearchPersonalityResolver: (() => GlobalResearchPersonality | Promise<GlobalResearchPersonality>) | null = null;
let globalResearchVerbosityResolver: (() => GlobalResearchVerbosity | Promise<GlobalResearchVerbosity>) | null = null;

function mergeResearchUsage(current: LlmUsage | undefined, next: LlmUsage): LlmUsage {
  if (!current) return next;
  return {
    ...current,
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    thinkingTokens: (current.thinkingTokens ?? 0) + (next.thinkingTokens ?? 0) || undefined,
    cacheReadTokens: (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0) || undefined,
    cacheCreationTokens: (current.cacheCreationTokens ?? 0) + (next.cacheCreationTokens ?? 0) || undefined,
    reasoningReplayState: mergeReasoningReplayStates([current.reasoningReplayState, next.reasoningReplayState]),
    calls: current.calls + next.calls,
    costUsd: current.costUsd !== undefined || next.costUsd !== undefined
      ? (current.costUsd ?? 0) + (next.costUsd ?? 0)
      : undefined,
    estimated: current.estimated || next.estimated || undefined,
    unavailable: current.unavailable || next.unavailable || undefined
  };
}

function researchGoalAwaitingApproval(
  orchestration: ResearchOrchestration,
  approval: { id?: string; label: string },
  updatedAt = iso()
): ResearchOrchestration {
  const goal = orchestration.goal;
  if (!goal || goal.status === "completed" || goal.status === "cancelled") return orchestration;
  return {
    ...orchestration,
    goal: {
      ...goal,
      status: "awaiting-approval",
      checkpointSummary: `Waiting for user review: ${approval.label}`,
      waitingFor: [{ kind: "approval", id: approval.id, label: approval.label }],
      steps: goal.steps.map((step) => step.id === goal.currentStepId
        ? { ...step, status: "awaiting-approval", updatedAt }
        : step),
      updatedAt
    },
    updatedAt
  };
}

function researchGoalIsUnfinished(session: ResearchChatSession): boolean {
  const status = session.orchestration.goal?.status;
  return status === "active" || status === "awaiting-approval" || status === "waiting" || status === "blocked";
}

export function setGlobalResearchPersonalityResolver(
  resolver: (() => GlobalResearchPersonality | Promise<GlobalResearchPersonality>) | null
): void {
  globalResearchPersonalityResolver = resolver;
}

export function setGlobalResearchVerbosityResolver(
  resolver: (() => GlobalResearchVerbosity | Promise<GlobalResearchVerbosity>) | null
): void {
  globalResearchVerbosityResolver = resolver;
}

async function activeResearchPersonalityPrompt(): Promise<string> {
  const personality = parseGlobalResearchPersonality(
    globalResearchPersonalityResolver ? await globalResearchPersonalityResolver() : undefined
  );
  return researchPersonalityPrompt(personality);
}

async function activeResearchVerbosity(): Promise<GlobalResearchVerbosity> {
  return parseGlobalResearchVerbosity(
    globalResearchVerbosityResolver ? await globalResearchVerbosityResolver() : undefined
  );
}

export type ResearchFetchedWebPage = {
  url: string;
  status: number;
  title?: string;
  contentType?: string;
  text?: string;
  error?: string;
};

export type ResearchContextMode = "compact" | "full";
export type ResearchContextLifecycleTier = "full" | "compact" | "compressed" | "minimal-resumable";

export type ResearchContextSection = {
  label: string;
  tokens: number;
  detail?: string;
};

class ResearchMcpApprovalRequired extends Error {
  constructor(
    readonly request: {
      serverId: string;
      serverLabel: string;
      toolName: string;
      providerToolName: string;
      argumentsJson: string;
    }
  ) {
    super(`MCP approval required: ${request.serverLabel} wants to run ${request.toolName}.`);
  }
}

// Persisted provider state can be large; above this it is dropped so the turn
// replays (cheaply, thanks to prompt caching) instead of bloating the store.
const MAX_PROVIDER_CONTINUATION_CHARS = 200_000;

function extractProviderContinuation(error: ResearchMcpApprovalRequired): ResearchProviderContinuation | undefined {
  const continuation = (error as { providerContinuation?: ResearchProviderContinuation }).providerContinuation;
  if (!continuation) return undefined;
  try {
    if (JSON.stringify(continuation).length > MAX_PROVIDER_CONTINUATION_CHARS) return undefined;
  } catch {
    return undefined;
  }
  return continuation;
}

function nativeWebSearchEnabled(settings: ProjectSettings): boolean {
  return settings.webSearch.enabled && (settings.webSearch.provider ?? "native") === "native";
}

function sameToolArguments(left: string, right: string): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(left || "{}"), JSON.parse(right || "{}"));
  } catch {
    return left === right;
  }
}

async function executeResearchToolCall(
  projectRoot: string,
  settings: ProjectSettings,
  input: { providerToolName: string; argumentsJson: string },
  options: { ruleMutationApproved?: boolean; agentActionApproved?: boolean } = {}
): Promise<{ serverId: string; serverLabel: string; toolName: string; resultText: string }> {
  if (isArchicodeInternalTool(input.providerToolName)) {
    const isRulesTool = input.providerToolName === ARCHICODE_RESEARCH_RULES_TOOL_NAME;
    const isRuleMutation = isRulesTool && researchRulesToolRequiresApproval(input.argumentsJson);
    if (isRuleMutation && !options.ruleMutationApproved) {
      const ruleTool = archicodeResearchRulesTool();
      throw new ResearchMcpApprovalRequired({
        serverId: ruleTool.serverId,
        serverLabel: ruleTool.serverLabel,
        toolName: ruleTool.toolName,
        providerToolName: ruleTool.providerToolName,
        argumentsJson: input.argumentsJson
      });
    }
    const result = await callArchicodeInternalTool({
      projectRoot,
      settings,
      loadProject: () => loadProject(projectRoot),
      readArtifactText: (artifactPath) => readArtifactText(projectRoot, artifactPath),
      runConsoleCommand: (args) => runInternalConsoleCommand(projectRoot, settings, args, {
        authorization: {
          actor: "parent-chat",
          exactCommandApproved: options.agentActionApproved
        }
      }),
      ...(isRulesTool ? {
        researchRules: {
          updateProjectSettings: (nextSettings: ProjectSettings) => updateProjectSettings(projectRoot, nextSettings),
          updateNodeRuleIds: (flowId: string, nodeId: string, ruleIds: string[]) =>
            updateNode(projectRoot, flowId, { id: nodeId, ruleIds }, "llm")
        }
      } : {})
    }, input);
    if (input.providerToolName === "archicode_console_run_command") {
      const parsed = JSON.parse(result.resultText) as { status?: string };
      if (parsed.status === "approval-required") {
        throw new ResearchMcpApprovalRequired({
          serverId: result.serverId,
          serverLabel: result.serverLabel,
          toolName: result.toolName,
          providerToolName: input.providerToolName,
          argumentsJson: input.argumentsJson
        });
      }
    }
    if (isRuleMutation) {
      await refreshArchitecturePolicyEvaluation(projectRoot, await loadProject(projectRoot));
    }
    return result;
  }
  return callMcpTool(settings, input);
}

export type CodebaseMappingResult = {
  bundle: ProjectBundle;
  applied: number;
  failed: number;
  message: string;
  summary: CodebaseMappingSummary;
};

export type CodebaseMappingSummary = {
  reportId: string;
  status: "complete" | "partial";
  completedAt: string;
  durationMs: number;
  provider: { label: string; kind: string; model?: string };
  settings: {
    levels: CodebaseMappingLevel;
    detail: CodebaseMappingDetail;
    reviewEffort: "light" | "balanced" | "deep" | "ultra";
    granularity: CodebaseMappingGranularity;
  };
  files: { scanned: number; parsed: number; importLinks: number; resolutionRate: number };
  graph: {
    flows: number;
    perspectiveFlows: number;
    nodes: number;
    relationships: number;
    operationsApplied: number;
    operationsFailed: number;
  };
  review?: {
    status: "running" | "complete" | "partial" | "failed";
    reviewedUnits: number;
    selectedUnits: number;
    possibleUnits: number;
    appliedEdits: number;
    rejectedBatches: number;
    unresolvedCount: number;
    reportedUnresolvedCount: number;
    reviewedSourceFiles: number;
    totalReviewSourceFiles: number;
  };
  providerCalls: {
    total: number;
    failed: number;
    architecture: number;
    review: number;
    runtimeSetup: number;
    retries: number;
    rejected: number;
  };
  phaseTimings: Array<{ phase: string; label: string; durationMs: number }>;
  accuracyEstimate: ImportAccuracyEstimate;
  report: ImportSummarySections;
  /** Kept for older renderer/preload consumers; contains genuine limitations only. */
  warnings: string[];
  errors: string[];
};

export type CodebaseMappingProgress = {
  projectRoot: string;
  step: number;
  totalSteps: number;
  label: string;
  detail?: string;
  phase?: string;
  itemsDone?: number;
  itemsTotal?: number;
};

type ResearchCreatedNodeLayoutHints = Map<string, Set<string>>;

type CodebaseMappingLevel = "1" | "2" | "3" | "4";
type CodebaseMappingDetail = "light" | "balanced" | "deep";

export function iso(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function visibleResearchAnswer(answer: string): string {
  const trimmed = answer.trim();
  const withoutTrailingSummary = trimmed.replace(/(?:\n+\s*|\s+)Summary:\s*[\s\S]*$/i, "").trim();
  const visible = withoutTrailingSummary || trimmed;
  // Some OpenAI-compatible gateways/models repeat the complete assistant text
  // on a later tool-loop round. Collapse only an exact adjacent duplicate;
  // ordinary repeated sentences and intentional emphasis remain untouched.
  if (visible.length % 2 === 0) {
    const midpoint = visible.length / 2;
    if (visible.slice(0, midpoint) === visible.slice(midpoint)) return visible.slice(0, midpoint).trim();
  }
  return visible;
}

function isInternalOutcomeBookkeepingNarration(answer: string): boolean {
  const normalized = answer.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 900) return false;
  return /\b(?:need to|let me|now i (?:need to|will)) (?:make|update|record|checkpoint)\b.{0,100}\b(?:memory|goal|checkpoint)\b/i.test(normalized)
    || /\b(?:goal )?checkpoint (?:is|has been) recorded\b.{0,160}\b(?:memory|decision|update)\b/i.test(normalized);
}

function hostOutcomeReportFromContinuation(content: string): string | undefined {
  const match = content.match(/The approved Delphi audit finished\.\s*([\s\S]*?)(?:\n\nThe host outcome above is the complete evidence packet|$)/i);
  const report = match?.[1]?.trim();
  return report ? `Delphi audit finished.\n\n${report}` : undefined;
}

function claimsPreparedGraphReviewCard(answer: string): boolean {
  const normalized = answer.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized.includes("review card")) return false;
  if (
    /\bno (?:valid )?(?:graph )?review card\b/.test(normalized) ||
    /\b(?:did not|didn't|could not|couldn't|cannot|can't|was not|wasn't|is not|isn't)\s+(?:prepare|create|submit|produce|generate)\b/.test(normalized) ||
    /\b(?:graph )?review card (?:was|is|has) not\b/.test(normalized)
  ) return false;
  return (
    /\b(?:prepared|created|submitted|produced|generated)\b.{0,100}\b(?:graph )?review card\b/.test(normalized) ||
    /\b(?:graph )?review card\b.{0,100}\b(?:has been|was|is) (?:prepared|created|submitted|produced|generated|ready|available)\b/.test(normalized) ||
    /\b(?:here is|here's)\b.{0,100}\b(?:graph )?review card\b/.test(normalized)
  );
}

export function validateResearchCanvasAction(
  bundle: ProjectBundle,
  input: unknown,
  currentCanvas: { activeFlowId?: string | null; activeSubflowId?: string | null } = {}
): ResearchCanvasAction {
  const action = researchCanvasActionSchema.parse(input);
  const flow = bundle.flows.find((item) => item.id === action.flowId);
  if (!flow) throw new Error(`Canvas flow ${action.flowId} was not found.`);

  const requestedNodes = action.nodeIds.map((nodeId) => {
    const node = flow.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`Canvas node ${nodeId} was not found in flow ${flow.id}.`);
    return node;
  });
  const groupNodes = action.groupIds.flatMap((groupId) => {
    if (!flow.groups.some((group) => group.id === groupId)) {
      throw new Error(`Canvas group ${groupId} was not found in flow ${flow.id}.`);
    }
    return flow.nodes.filter((node) => node.groupId === groupId);
  });
  const targetNodes = [...new Map([...requestedNodes, ...groupNodes].map((node) => [node.id, node])).values()];
  const targetLayers = new Set(targetNodes.map((node) => node.subflowId ?? null));
  let subflowId = action.subflowId;
  if (subflowId === undefined) {
    if (targetLayers.size > 1) {
      throw new Error("Canvas targets span multiple detail-flow layers. Focus one visible layer at a time.");
    }
    subflowId = targetLayers.size === 1
      ? [...targetLayers][0]
      : currentCanvas.activeFlowId === flow.id
        ? currentCanvas.activeSubflowId ?? null
        : null;
  }
  if (subflowId !== null && !flow.subflows.some((subflow) => subflow.id === subflowId)) {
    throw new Error(`Canvas detail flow ${subflowId} was not found in flow ${flow.id}.`);
  }
  const outsideLayer = requestedNodes.find((node) => (node.subflowId ?? null) !== subflowId);
  if (outsideLayer) {
    throw new Error(`Canvas node ${outsideLayer.id} is not visible in the requested detail-flow layer.`);
  }
  const visibleGroupNodeCount = groupNodes.filter((node) => (node.subflowId ?? null) === subflowId).length;
  if (action.groupIds.length && !visibleGroupNodeCount) {
    throw new Error("The requested canvas groups have no nodes in the requested detail-flow layer.");
  }

  return { ...action, subflowId };
}

type SendResearchChatMessageInput = {
  projectRoot: string;
  sessionId: string;
  content: string;
  providerId?: string;
  /** Explicit model for this chat turn. Null clears a prior per-chat selection. */
  modelId?: string | null;
  filePaths?: string[];
  approvedMcpServerIds?: string[];
  rejectedMcpServerIds?: string[];
  referencedNodeIds?: ResearchMessageNodeReference[];
  selectedNodeIds?: string[];
  activeFlowId?: string | null;
  activeSubflowId?: string | null;
  resumeApprovalMessageId?: string;
  retryAssistantMessageId?: string;
  internalContinuation?: boolean;
  /** The host already supplied the complete external outcome evidence packet. */
  outcomeEvidenceProvided?: boolean;
  optimisticUserMessageId?: string;
  optimisticAssistantMessageId?: string;
  onToken?: (text: string, kind?: ProviderTokenKind) => void;
  onTokenReset?: () => void;
  onActivity?: (message: string, status?: "running" | "completed" | "failed") => void;
  onSubagentProgress?: (payload: {
    runId: string;
    kind: SubagentRun["kind"];
    title: string;
    message: string;
    status?: "running" | "completed" | "blocked" | "failed";
  }) => void;
};

function researchProviderWithModel(provider: Provider, modelId?: string): Provider {
  const selectedModelId = modelId?.trim();
  if (!selectedModelId) return provider;
  return {
    ...provider,
    model: selectedModelId,
    phaseModelPolicies: {
      ...provider.phaseModelPolicies,
      brainstorming: {
        ...provider.phaseModelPolicies.brainstorming,
        modelOverride: selectedModelId
      }
    }
  };
}

// Keyed by research chat session id so a stop button can cancel the one
// in-flight turn for that session without affecting other sessions.
const activeResearchTurnControllers = new Map<string, AbortController>();

function isResearchCancellationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /\bcancelled\b|\baborted\b/i.test(error.message);
}

function researchLoopGuardFailure(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:Consecutive identical (?:tool-call|invalid final-answer)|Repeated final-answer validation) loop detected/i.test(message)
    ? message
    : undefined;
}

/**
 * Persists honest terminal states for runs a turn abandoned mid-flight: a
 * "running" run has no live operation once its turn ended. When the user
 * explicitly stops the parent turn, approval cards created by that unfinished
 * turn are rejected too; a later user request can create a fresh card.
 */
function settleAbandonedSubagentRuns(
  runs: NonNullable<ResearchChatMessage["subagentRuns"]>,
  settledAt: string,
  options: { rejectAwaitingApprovals?: boolean } = {}
): NonNullable<ResearchChatMessage["subagentRuns"]> {
  return runs.map((run) => run.status === "running"
    ? transitionSubagentRun(run, "failed", { error: run.error ?? "The turn ended before this subagent finished; no result was recorded." }, settledAt)
    : options.rejectAwaitingApprovals && run.status === "awaiting-approval"
      ? transitionSubagentRun(run, "rejected", { resultSummary: run.resultSummary ?? "Cancelled with the stopped parent turn before approval." }, settledAt)
      : run);
}

/** Aborts the in-flight research turn for a session, if any. Returns whether one was cancelled. */
export function cancelResearchChatMessage(sessionId: string): boolean {
  const controller = activeResearchTurnControllers.get(sessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export async function sendResearchChatMessage(input: SendResearchChatMessageInput): Promise<ResearchChatSession> {
  const controller = new AbortController();
  activeResearchTurnControllers.set(input.sessionId, controller);
  let result: ResearchChatSession;
  try {
    // Serialize turns per session so a concurrent operation cannot clobber this
    // turn's messages with a stale whole-session snapshot.
    result = await withResearchSessionLock(input.projectRoot, input.sessionId, () =>
      sendResearchChatMessageTurn({ ...input, signal: controller.signal }));
  } finally {
    if (activeResearchTurnControllers.get(input.sessionId) === controller) {
      activeResearchTurnControllers.delete(input.sessionId);
    }
  }
  return result;
}

const terminalResearchWakeRunStatuses = new Set<Run["status"]>(["succeeded", "failed", "cancelled"]);

/** Resume chats that explicitly checkpointed a wait on this exact run. */
export async function resumeResearchGoalsForRunUpdate(projectRoot: string, run: Run): Promise<ResearchChatSession[]> {
  if (!terminalResearchWakeRunStatuses.has(run.status)) return [];
  const store = await readChatsForMutation(projectRoot);
  const candidateIds = store.sessions
    .filter((session) => session.orchestration.goal?.status === "waiting")
    .filter((session) => session.orchestration.goal?.waitingFor.some((reference) => reference.kind === "run" && reference.id === run.id))
    .map((session) => session.id);
  const results: ResearchChatSession[] = [];
  for (const sessionId of candidateIds) {
    const activated = await withResearchSessionLock(projectRoot, sessionId, async () => {
      const latestStore = await readChatsForMutation(projectRoot);
      const session = latestStore.sessions.find((item) => item.id === sessionId);
      const goal = session?.orchestration.goal;
      if (!session || !goal || goal.status !== "waiting" || !goal.waitingFor.some((reference) => reference.kind === "run" && reference.id === run.id)) {
        return undefined;
      }
      const updatedAt = iso();
      const updatedSession = researchChatSessionSchema.parse({
        ...session,
        orchestration: {
          ...session.orchestration,
          goal: {
            ...goal,
            status: "active",
            checkpointSummary: `Run ${run.id} reached ${run.status}; Archi resumed the goal.`,
            waitingFor: goal.waitingFor.filter((reference) => !(reference.kind === "run" && reference.id === run.id)),
            steps: goal.steps.map((step) => step.id === goal.currentStepId && step.status === "waiting"
              ? { ...step, status: "doing", updatedAt }
              : step),
            updatedAt
          },
          updatedAt
        },
        updatedAt
      });
      await persistResearchSession(projectRoot, updatedSession);
      return updatedSession;
    });
    if (!activated) continue;
    try {
      results.push(await sendResearchChatMessage({
        projectRoot,
        sessionId,
        providerId: activated.providerId,
        internalContinuation: true,
        content: [
          "HOST DURABLE-GOAL RUN EVENT.",
          `The exact run ${run.id} reached terminal status ${run.status}.`,
          `Run objective: ${run.promptSummary}`,
          run.lastVerification ? `Last verification: ${run.lastVerification.command} (exit ${run.lastVerification.exitCode ?? "unknown"}).` : "",
          run.logs.length ? `Latest run log: ${run.logs.slice(-3).map((entry) => `[${entry.stream}] ${entry.text}`).join("\n").slice(0, 4_000)}` : "",
          "Inspect the run evidence if needed, continue any remaining useful work, and return the self-contained result. The host owns the persisted goal checkpoint."
        ].filter(Boolean).join("\n")
      }));
    } catch {
      results.push(activated);
    }
  }
  return results;
}

async function sendResearchChatMessageTurn(input: SendResearchChatMessageInput & { signal?: AbortSignal }): Promise<ResearchChatSession> {
  let content = input.content.trim();
  if (!content) throw new Error("Research chat message cannot be empty.");

  const store = await readChatsForMutation(input.projectRoot);
  const session = store.sessions.find((item) => item.id === input.sessionId);
  if (!session) throw new Error(`Research chat ${input.sessionId} was not found.`);
  const pendingApproval = session.messages.find((message) => message.mcpApprovalRequest);
  if (pendingApproval && input.resumeApprovalMessageId !== pendingApproval.id) {
    throw new Error("Resolve the pending MCP approval before sending another message in this chat.");
  }
  const bundle = await loadProject(input.projectRoot);
  const providerId = input.providerId ?? bundle.project.settings.providers.find((provider) => provider.enabled)?.id ?? session.providerId;
  const configuredProvider = bundle.project.settings.providers.find((item) => item.id === providerId);
  if (!configuredProvider) throw new Error("Choose a provider in Settings before using Research.");
  const selectedModelId = input.modelId === null
    ? undefined
    : input.modelId?.trim() || (session.modelId === null ? undefined : session.modelId?.trim()) || undefined;
  const provider = researchProviderWithModel(configuredProvider, selectedModelId);
  const profile = inferModelCapabilityProfile(provider, selectedModelId);
  const approvalMessageIndex = input.resumeApprovalMessageId
    ? session.messages.findIndex((message) => message.id === input.resumeApprovalMessageId && Boolean(message.mcpApprovalRequest))
    : -1;
  const approvalMessage = approvalMessageIndex >= 0 ? session.messages[approvalMessageIndex] : undefined;
  const approvalRequest = approvalMessage?.mcpApprovalRequest;
  const internalContinuation = Boolean(input.internalContinuation || approvalRequest?.internalContinuation);
  const turnKind = deriveResearchTurnKind({
    internalContinuation,
    outcomeEvidenceProvided: input.outcomeEvidenceProvided,
    approvalResume: Boolean(approvalRequest)
  });
  const turnPolicy = researchTurnPolicy(turnKind);
  const retryMessageIndex = input.retryAssistantMessageId
    ? session.messages.findIndex((message) => message.id === input.retryAssistantMessageId)
    : -1;
  const retryMessage = retryMessageIndex >= 0 ? session.messages[retryMessageIndex] : undefined;
  if (input.resumeApprovalMessageId && !approvalRequest) throw new Error("MCP approval request was not found.");
  if (input.retryAssistantMessageId) {
    if (!retryMessage || retryMessage.role !== "assistant" || !retryMessage.error) {
      throw new Error("Research retry target was not found.");
    }
    if (retryMessageIndex !== session.messages.length - 1) {
      throw new Error("Only the latest failed research response can be retried.");
    }
  }
  const previousUserMessage = approvalMessageIndex > 0
    ? session.messages.slice(0, approvalMessageIndex).reverse().find((message) => message.role === "user")
    : retryMessageIndex > 0
      ? session.messages.slice(0, retryMessageIndex).reverse().find((message) => message.role === "user")
      : undefined;
  if (input.retryAssistantMessageId && !previousUserMessage) {
    throw new Error("Research retry source message was not found.");
  }
  const retryAttachmentArtifacts = input.retryAssistantMessageId
    ? previousUserMessage?.attachmentIds.flatMap((attachmentId) => {
        const artifact = bundle.artifacts.find((item) => item.id === attachmentId);
        return artifact ? [artifact] : [];
      }) ?? []
    : [];
  const messageFilePaths = internalContinuation ? [] : approvalRequest?.filePaths ?? input.filePaths ?? [];
  const messageHasImagePaths = messageFilePaths.some((filePath) => mediaTypeForFile(filePath).startsWith("image/")) ||
    retryAttachmentArtifacts.some((artifact) => artifact.mediaType?.startsWith("image/"));
  if (messageHasImagePaths && !profile.supportsImageInput) {
    throw new Error(`${provider.label} does not advertise image input support for research image attachments.`);
  }
  if (approvalRequest) content = approvalRequest.originalContent.trim();
  const attachmentArtifacts = approvalRequest || internalContinuation
    ? []
    : input.retryAssistantMessageId
      ? retryAttachmentArtifacts
    : await createAttachmentArtifacts(input.projectRoot, messageFilePaths, {
        summary: "Attachment uploaded with a research chat message."
      });

  const userMessage: ResearchChatMessage = internalContinuation
    ? {
        id: id("msg"),
        role: "system",
        content,
        createdAt: iso(),
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: []
      }
    : approvalRequest && previousUserMessage
    ? previousUserMessage
    : {
        id: input.optimisticUserMessageId ?? id("msg"),
        role: "user",
        content,
        createdAt: iso(),
        attachmentIds: attachmentArtifacts.map((artifact) => artifact.id),
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: []
      };
  const baseMessages = approvalRequest
    ? session.messages.filter((message) => message.id !== approvalMessage?.id)
    : internalContinuation
      ? session.messages
      : input.retryAssistantMessageId
        ? session.messages.filter((message) => message.id !== retryMessage?.id)
        : [...session.messages, userMessage];
  let nextSession = researchChatSessionSchema.parse({
    ...session,
    title: session.messages.length || internalContinuation ? session.title : titleFromMessage(content),
    providerId,
    modelId: input.modelId === null || (input.modelId === undefined && session.modelId === null)
      ? null
      : selectedModelId,
    webEnabled: bundle.project.settings.webSearch.enabled,
    messages: baseMessages,
    updatedAt: iso()
  });
  const pendingAssistantMessage: ResearchChatMessage = {
    id: input.optimisticAssistantMessageId ?? id("research-waiting"),
    role: "assistant",
    content: pickRandomResearchThinkingPhrase(),
    createdAt: iso(),
    attachmentIds: [],
    webUsed: bundle.project.settings.webSearch.enabled,
    mcpToolCalls: [],
    subagentRuns: []
  };
  const persistPendingSession = (sessionToPersist: ResearchChatSession): ResearchChatSession =>
    researchChatSessionSchema.parse({
      ...sessionToPersist,
      messages: [...sessionToPersist.messages, pendingAssistantMessage],
      updatedAt: iso()
    });
  await persistResearchSession(input.projectRoot, persistPendingSession(nextSession));

  const researchContextPlan = deriveResearchChatContextPlan({
    ...bundle.project.settings,
    providers: bundle.project.settings.providers.map((item) => item.id === provider.id
      ? { ...provider, enabled: true }
      : { ...item, enabled: false })
  });
  nextSession = await compactResearchMemoryIfNeeded(input.projectRoot, provider, nextSession, researchContextPlan);
  if (nextSession.id === session.id) {
    await persistResearchSession(input.projectRoot, persistPendingSession(nextSession));
  }

  const approvedMcpServerIds = new Set(input.approvedMcpServerIds ?? []);
  const rejectedMcpServerIds = new Set(input.rejectedMcpServerIds ?? []);
  const referencedNodeIds = (input.referencedNodeIds ?? []).filter((reference) => reference && reference.flowId && reference.nodeId);
  const selectedNodeIds = (input.selectedNodeIds ?? []).filter((id): id is string => typeof id === "string" && id.length > 0);
  let semanticRelatedIds: string[] = [];
  let semanticCodeMatches: Array<{ ref: string; score: number; preview: string; metadata?: Record<string, string> }> = [];
  if (turnPolicy.includeExternalRetrieval && bundle.project.settings.semanticIndex.enabled && content.trim()) {
    try {
      semanticRelatedIds = (await semanticRelatedNodeIds(input.projectRoot, bundle, content, bundle.project.settings.semanticIndex.maxRelatedNodes))
        .filter((result) => nextSession.scope.type === "project" || result.flowId === nextSession.scope.flowId)
        .map((result) => result.nodeId)
        .filter((nodeId) => !selectedNodeIds.includes(nodeId));
      semanticCodeMatches = (await searchSemanticIndex(input.projectRoot, content, {
        kinds: ["code-file"],
        limit: bundle.project.settings.semanticIndex.maxRelatedNodes,
        minScore: 0.38
      })).map((match) => ({ ref: match.ref, score: match.score, preview: match.preview, metadata: match.metadata }));
    } catch {
      semanticRelatedIds = [];
      semanticCodeMatches = [];
    }
  }
  const fetchedWebPages = turnPolicy.includeExternalRetrieval && bundle.project.settings.webSearch.enabled ? await fetchResearchWebPages(content) : [];
  const contextMode = chooseResearchContextMode({
    approvalRequest: Boolean(approvalRequest),
    retry: Boolean(input.retryAssistantMessageId),
    internalContinuation,
    scopeType: nextSession.scope.type,
    referencedNodeCount: referencedNodeIds.length,
    attachmentCount: attachmentArtifacts.length + messageFilePaths.length
  });
  const rawStructuralContext = !turnPolicy.includeProjectContext
    ? "{}"
    : contextMode === "full"
      ? await buildResearchContext(input.projectRoot, bundle, nextSession.scope, fetchedWebPages, approvedMcpServerIds, rejectedMcpServerIds, referencedNodeIds, selectedNodeIds, semanticRelatedIds)
      : await buildCompactResearchContext(input.projectRoot, bundle, nextSession.scope, fetchedWebPages, approvedMcpServerIds, rejectedMcpServerIds, selectedNodeIds, semanticRelatedIds);
  const structuralContext = !turnPolicy.includeProjectContext
    ? omitChatArtifactReadToolsFromContext(rawStructuralContext)
    : rawStructuralContext;
  const context = semanticCodeMatches.length
    ? `${structuralContext}\n\nLocal semantic code retrieval policy:\n${JSON.stringify(semanticRetrievalAdvisory, null, 2)}\nCandidates:\n${JSON.stringify(semanticCodeMatches.map((match) => ({ path: match.ref, score: Number(match.score.toFixed(3)), symbol: match.metadata?.symbol, startLine: match.metadata?.startLine ? Number(match.metadata.startLine) : undefined, endLine: match.metadata?.endLine ? Number(match.metadata.endLine) : undefined, preview: match.preview })), null, 2)}`
    : structuralContext;
  const messageImageInputs = [
    ...attachmentArtifacts.filter((artifact) => artifact.mediaType?.startsWith("image/")).map((artifact) => ({
      title: artifact.title,
      path: path.join(input.projectRoot, artifact.path),
      mediaType: artifact.mediaType ?? "application/octet-stream",
      source: "message" as const,
      sourceLabel: "current user message"
    })),
    ...(approvalRequest ? messageFilePaths.filter((filePath) => mediaTypeForFile(filePath).startsWith("image/")).map((filePath) => ({
      title: path.basename(filePath),
      path: filePath,
      mediaType: mediaTypeForFile(filePath),
      source: "message" as const,
      sourceLabel: "current user message"
    })) : [])
  ];
  const messageTextInputs = [
    ...attachmentArtifacts.filter((artifact) => artifact.mediaType && isResearchTextAttachmentMediaType(artifact.mediaType)).map((artifact) => ({
      title: artifact.title,
      path: path.join(input.projectRoot, artifact.path),
      mediaType: artifact.mediaType ?? "text/plain",
      source: "message" as const,
      sourceLabel: "current user message"
    })),
    ...(approvalRequest ? messageFilePaths.filter((filePath) => isResearchTextAttachmentMediaType(mediaTypeForFile(filePath))).map((filePath) => ({
      title: path.basename(filePath),
      path: filePath,
      mediaType: mediaTypeForFile(filePath),
      source: "message" as const,
      sourceLabel: "current user message"
    })) : [])
  ];
  const noteAttachmentScopes = researchNoteAttachmentScopes(nextSession.scope, referencedNodeIds);
  const scopedNoteImages = messageImageInputs.length > 0
    ? []
    : uniqueProviderImageAttachments(noteAttachmentScopes.flatMap((scope) =>
        imageAttachmentsForNodeNotes(input.projectRoot, bundle, scope)
      )).slice(0, 6);
  const scopedNoteTexts = messageImageInputs.length > 0 || messageTextInputs.length > 0
    ? []
    : uniqueProviderTextAttachments(noteAttachmentScopes.flatMap((scope) =>
        textAttachmentsForNodeNotes(input.projectRoot, bundle, scope)
      )).slice(0, 8);
  const skillsPrompt = turnPolicy.includeSelectedSkills ? await selectedSkillsPrompt(input.projectRoot, bundle.project.settings) : "";
  const researchMcpServers = bundle.project.settings.mcp.servers
    .filter((server) => server.enabled)
    .map((server) => approvedMcpServerIds.has(server.id) && !server.trusted
      ? { ...server, trusted: true, defaultToolsApprovalMode: server.defaultToolsApprovalMode ?? "approve" }
      : server);
  const researchMcpSettings = {
    ...bundle.project.settings,
    mcp: {
      ...bundle.project.settings.mcp,
      servers: researchMcpServers
    }
  };
  const directProvider = provider.kind === "openai-compatible" ||
    provider.kind === "anthropic-compatible" ||
    provider.kind === "codex-local" ||
    provider.kind === "claude-local" ||
    provider.kind === "opencode-local" ||
    provider.kind === "antigravity-local";
  const toolVisibleMcpSettings = {
    ...researchMcpSettings,
    mcp: {
      ...researchMcpSettings.mcp,
      servers: researchMcpSettings.mcp.servers.filter((server) => !rejectedMcpServerIds.has(server.id))
    }
  };
  const internalResearchWebTools = archicodeInternalTools(bundle.project.settings)
    .filter((tool) => tool.providerToolName.startsWith("archicode_web_"));
  const internalResearchConsoleTools = archicodeInternalTools(bundle.project.settings)
    .filter((tool) => tool.providerToolName === "archicode_console_run_command");
  const rulesApprovalRejected = approvalRequest?.providerToolName === ARCHICODE_RESEARCH_RULES_TOOL_NAME &&
    approvalRequest.serverIds.some((serverId) => rejectedMcpServerIds.has(serverId));
  const internalResearchRuleTools = rulesApprovalRejected ? [] : [archicodeResearchRulesTool()];
  const subagentSettings = bundle.project.settings.agentTools?.subagents;
  const mergeResolutionToolEnabled = subagentSettings?.mergeConflictResolution ?? true;
  const graphReconciliationToolEnabled = subagentSettings?.graphReconciliation ?? true;
  const sherlockResearchToolEnabled = subagentSettings?.sherlockResearch ?? true;
  const delphiTestingToolEnabled = subagentSettings?.delphiTesting ?? true;
  const delphiModelPreflight = effectiveDelphiModelPreflight(provider);
  const subagentTools = researchSubagentTools({ mergeResolutionToolEnabled, graphReconciliationToolEnabled, sherlockResearchToolEnabled, delphiTestingToolEnabled });
  // Goal state and the decision to leave memory unchanged are host-owned.
  // The optional memory tool only adds semantic detail the host cannot infer.
  const sinkTools = researchSinkTools();
  const researchMcpTools = [
    ...researchProjectFileTools(),
    researchContextExpansionTool(),
    researchGraphLayoutTool(),
    researchChatHistoryTool(),
    researchPreviousChatsTool(),
    ...subagentTools,
    ...internalResearchRuleTools,
    ...internalResearchWebTools,
    ...internalResearchConsoleTools,
    ...(directProvider ? [...sinkTools, ...providerMcpTools(toolVisibleMcpSettings)] : [])
  ];
  const mcpToolCalls: NonNullable<ResearchChatMessage["mcpToolCalls"]> = [];
  const subagentRuns: NonNullable<ResearchChatMessage["subagentRuns"]> = [];
  const publishSubagentProgress = (
    runId: string,
    kind: SubagentRun["kind"],
    title: string,
    message: string,
    status: "running" | "completed" | "blocked" | "failed" = "running"
  ): void => input.onSubagentProgress?.({ runId, kind, title, message, status });
  const transitionInMemorySubagentRun = (
    runId: string,
    status: SubagentRun["status"],
    patch: Parameters<typeof transitionSubagentRun>[2] = {}
  ): SubagentRun | undefined => {
    const runIndex = subagentRuns.findIndex((run) => run.id === runId);
    if (runIndex < 0) return undefined;
    const nextRun = transitionSubagentRun(subagentRuns[runIndex]!, status, patch);
    subagentRuns[runIndex] = nextRun;
    return nextRun;
  };
  // Structured output captured from the native sink-tool calls (API providers).
  let capturedChangeSet: unknown;
  let capturedCanvasAction: ResearchCanvasAction | undefined;
  let capturedMemoryDelta: unknown;
  let capturedOrchestration = nextSession.orchestration;
  let hostGoalCheckpointed = false;
  let approvedRuleMutationConsumed = false;
  const consumeExactRuleMutationApproval = (toolInput: { providerToolName: string; argumentsJson: string }): boolean => {
    if (approvedRuleMutationConsumed || !approvalRequest || rulesApprovalRejected) return false;
    if (!approvedMcpServerIds.has(ARCHICODE_RESEARCH_RULES_SERVER_ID)) return false;
    if (approvalRequest.providerToolName !== ARCHICODE_RESEARCH_RULES_TOOL_NAME || toolInput.providerToolName !== ARCHICODE_RESEARCH_RULES_TOOL_NAME) return false;
    if (!sameToolArguments(approvalRequest.argumentsJson ?? "{}", toolInput.argumentsJson)) return false;
    approvedRuleMutationConsumed = true;
    return true;
  };

  const activeGraphLockRunsNow = async (): Promise<ProjectBundle["runs"]> =>
    activeResearchGraphLockRuns(await loadProject(input.projectRoot));

  const runPicassoGraphPass = async (argumentsJson: string): Promise<string> => {
    if (!graphReconciliationToolEnabled) {
      return "Picasso is disabled by project settings.";
    }
    const runId = id("subagent-run");
    const runCreatedAt = iso();
    try {
      const args = JSON.parse(argumentsJson || "{}") as GraphReconciliationInput;
      const assessmentOnly = args.mode === "assess";
      const title = args.objective?.trim()
        ? `${assessmentOnly ? "Assess graph" : "Design graph update"}: ${args.objective.trim().slice(0, 100)}`
        : `Reconcile the graph${args.resolvedFiles?.length ? ` with ${args.resolvedFiles.join(", ")}` : ""}`;
      subagentRuns.push({
        id: runId,
        kind: "graph-reconciliation",
        status: "running",
        title,
        argumentsJson,
        progress: [],
        createdAt: runCreatedAt,
        updatedAt: runCreatedAt
      });
      publishSubagentProgress(runId, "graph-reconciliation", title, assessmentOnly
        ? "Picasso is assessing the assigned graph scope."
        : "Picasso is preparing a fresh graph-design pass.");
      const result = await executeMicroRun(
        input.projectRoot,
        "graph-reconciliation",
        args,
        await hydrateProviderForUse(provider),
        bundle,
        {
          // Stopping the parent turn must also stop this inline subagent, not
          // leave it burning provider calls whose result would be discarded.
          signal: input.signal,
          onProgress: (message) => {
            console.log(`[graph-reconciliation] ${message}`);
            const run = subagentRuns.find((entry) => entry.id === runId);
            if (run) {
              run.progress.push(message);
              run.updatedAt = iso();
            }
            publishSubagentProgress(runId, "graph-reconciliation", title, message);
          }
        }
      );
      // Feed Picasso's proposal directly into the normal review-card pipeline;
      // the parent provider does not need to notice and re-propose it.
      if (result.status !== "failed") {
        const output = result.output as PicassoGraphOutput | undefined;
        if (Array.isArray(output?.graphChangeSet?.operations) && output.graphChangeSet.operations.length > 0) {
          capturedChangeSet = output.graphChangeSet;
        }
      }
      const run = transitionInMemorySubagentRun(runId, result.status === "failed" ? "failed" : "completed", {
        resultSummary: microRunHumanSummary(result),
        error: result.status === "failed" ? result.error : undefined,
        usage: result.usage,
        diagnostics: result.diagnostics
      });
      if (run) {
        publishSubagentProgress(runId, "graph-reconciliation", title, run.resultSummary ?? "Picasso completed.", run.status === "failed" ? "failed" : "completed");
        input.onActivity?.(
          run.status === "failed"
            ? "Picasso could not complete the graph pass. Archi is reviewing the failure and deciding the next safe step."
            : assessmentOnly
              ? "Picasso completed the graph assessment. Archi is preparing the findings below."
              : "Picasso completed. Archi is reviewing the graph proposal and preparing the response below.",
          "running"
        );
      }
      return microRunResultText(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const run = transitionInMemorySubagentRun(runId, "failed", { error: errorMessage });
      if (run) {
        publishSubagentProgress(runId, "graph-reconciliation", run.title, errorMessage, "failed");
      } else {
        subagentRuns.push({
          id: runId,
          kind: "graph-reconciliation",
          status: "failed",
          title: "Reconcile the graph",
          argumentsJson,
          progress: [],
          error: errorMessage,
          createdAt: runCreatedAt,
          updatedAt: iso()
        });
        publishSubagentProgress(runId, "graph-reconciliation", "Reconcile the graph", errorMessage, "failed");
      }
      return `Graph reconciliation failed: ${errorMessage}`;
    }
  };

  // Resume: if the approval carried provider continuation state, run the just
  // approved tool now (it is trusted after approval) and continue the exchange
  // instead of re-generating the pre-approval work. Falls back to full replay
  // if anything is missing or the tool fails.
  let resumeContinuation: (ResearchProviderContinuation & { approvedResult: string }) | undefined;
  const approvalWasRejected = Boolean(approvalRequest?.serverIds.some((serverId) => rejectedMcpServerIds.has(serverId)));
  const providerContinuation = approvalRequest?.providerContinuation;
  if (providerContinuation && !approvalWasRejected) {
    try {
      const pending = providerContinuation.pendingToolCall;
      const toolResult = await executeResearchToolCall(input.projectRoot, researchMcpSettings, {
        providerToolName: pending.providerToolName,
        argumentsJson: pending.argumentsJson
      }, {
        ruleMutationApproved: consumeExactRuleMutationApproval(pending),
        agentActionApproved: pending.providerToolName === "archicode_console_run_command"
      });
      const resultText = toolResult.resultText;
      mcpToolCalls.push({
        serverId: toolResult.serverId,
        serverLabel: toolResult.serverLabel,
        toolName: toolResult.toolName,
        argumentsJson: pending.argumentsJson,
        status: "succeeded",
        resultSummary: resultText.slice(0, 1000),
        createdAt: iso()
      });
      resumeContinuation = { ...providerContinuation, approvedResult: resultText };
    } catch {
      // Continuation could not be resumed; fall back to a full replay.
      resumeContinuation = undefined;
    }
  }

  const personalityPrompt = await activeResearchPersonalityPrompt();
  const researchVerbosity = await activeResearchVerbosity();
  // Tracks answer text as it streams so a user-initiated stop can persist
  // whatever the model already said instead of discarding it.
  let streamedAnswerSoFar = "";
  // Aggregated LLM usage/cost for this assistant turn (incl. its tool loop).
  let capturedUsage: LlmUsage | undefined;
  const recordObservedTurnGoalCheckpoint = (): void => {
    const goal = capturedOrchestration.goal;
    if (!goal || hostGoalCheckpointed || goal.status === "completed" || goal.status === "cancelled" || input.signal?.aborted) return;
    if (subagentRuns.some((run) => run.status === "awaiting-approval")) return;
    const observedRuns = subagentRuns.filter((run) => run.status === "completed" || run.status === "blocked" || run.status === "failed");
    // A resumed parent trajectory is itself the task boundary: the shared
    // runtime does not return a final answer until the model has finished its
    // useful tool work or reached a real pause/blocker. Do not require a
    // provider bookkeeping tool merely to close the host-visible goal.
    if (!observedRuns.length && !internalContinuation) return;
    const failures = observedRuns.filter((run) => run.status === "failed" || run.status === "blocked");
    const preservesObservedBlocker = observedRuns.length === 0 && goal.status === "blocked";
    const evidence = observedRuns.length
      ? observedRuns.map((run) => `${run.kind} subagent ${run.id} finished with status ${run.status}.`)
      : preservesObservedBlocker
        ? ["The parent reported the persisted blocker without claiming new execution evidence."]
        : ["Archi completed the resumed parent trajectory and returned its user-facing result."];
    const blockers = failures.length
      ? failures.map((run) => run.error ?? run.resultSummary ?? `${run.title} did not complete.`)
      : preservesObservedBlocker
        ? goal.blockers
        : [];
    const summary = (observedRuns.length
      ? observedRuns.map((run) => `${run.title}: ${run.resultSummary ?? run.error ?? run.status}`).join(" ")
      : preservesObservedBlocker
        ? goal.checkpointSummary || blockers.join(" ") || "The objective remains blocked after the parent report."
        : "The resumed parent trajectory completed and delivered its result.").slice(0, 1_000);
    try {
      capturedOrchestration = checkpointResearchGoal(capturedOrchestration, {
        status: failures.length || preservesObservedBlocker ? "blocked" : "completed",
        summary: summary || "Observed subagent work finished.",
        currentStepId: failures.length || preservesObservedBlocker ? goal.currentStepId ?? null : null,
        stepUpdates: (failures.length || preservesObservedBlocker
          ? goal.steps.filter((step) => step.id === goal.currentStepId)
          : goal.steps).map((step) => ({
          id: step.id,
          status: failures.length || preservesObservedBlocker ? "blocked" : "done",
          notes: summary || undefined,
          evidence
        })),
        evidence,
        blockers,
        waitingFor: []
      }, iso());
      hostGoalCheckpointed = true;
    } catch {
      // Keep the last valid goal state if an old/custom goal shape cannot
      // accept this mechanical checkpoint. No provider repair call is made.
    }
  };
  const explicitDelphiDelegationRequired = turnPolicy.enforceExplicitDelphiDelegation && !resumeContinuation && isExplicitDelphiAuditRequest(content) &&
    researchMcpTools.some((tool) => isResearchSpawnDelphiTool(tool.providerToolName));
  const existingGoalStatus = capturedOrchestration.goal?.status;
  if (explicitDelphiDelegationRequired && (!existingGoalStatus || existingGoalStatus === "completed" || existingGoalStatus === "cancelled")) {
    capturedOrchestration = startResearchGoal(capturedOrchestration, {
      objective: "Run the requested test/runtime audit and report evidence-backed findings.",
      successCriteria: [
        "Finite build and test checks complete with recorded evidence",
        "The requested live target is started or reused and directly audited when supported",
        "The user receives concrete findings, blockers, and coverage limits"
      ],
      steps: [
        { id: "prepare-audit", title: "Prepare the reviewed Delphi audit and runtime lifecycle" },
        { id: "run-audit", title: "Run finite checks and direct target observation" },
        { id: "report-findings", title: "Report evidence-backed findings and remaining blockers" }
      ],
      summary: "Preparing Delphi with the project's reviewed runtime and test configuration."
    }, iso());
  }
  const budgetedPrompt = applyResearchPromptBudget({
    modelContextTokens: researchContextPlan.modelContextTokens,
    contextMode,
    scopeContext: context,
    bundle,
    scope: nextSession.scope,
    selectedNodeIds,
    messages: nextSession.messages,
    researchMessageLimit: researchContextPlan.recentMessageLimit,
    researchHistoryTokenBudget: researchContextPlan.historyTokenBudget,
    sessionSummary: nextSession.summary,
    researchMemory: formatResearchMemoryForPrompt(nextSession.memory),
    researchOrchestration: formatResearchOrchestrationForPrompt(capturedOrchestration),
    selectedSkillsPrompt: skillsPrompt,
    tools: researchMcpTools,
    imageAttachments: messageImageInputs.length + scopedNoteImages.length,
    textAttachments: messageTextInputs.length + scopedNoteTexts.length,
    currentMessage: content
  });
  const contextLedger = buildResearchContextLedger({
    contextMode: budgetedPrompt.contextMode,
    contextLifecycleTier: budgetedPrompt.contextLifecycleTier,
    scopeContext: budgetedPrompt.scopeContext,
    messages: nextSession.messages,
    researchMessageLimit: budgetedPrompt.researchMessageLimit,
    researchHistoryTokenBudget: budgetedPrompt.researchHistoryTokenBudget,
    sessionSummary: nextSession.summary,
    researchMemory: formatResearchMemoryForPrompt(nextSession.memory),
    researchOrchestration: formatResearchOrchestrationForPrompt(capturedOrchestration),
    selectedSkillsPrompt: skillsPrompt,
    tools: budgetedPrompt.tools,
    imageAttachments: messageImageInputs.length + scopedNoteImages.length,
    textAttachments: messageTextInputs.length + scopedNoteTexts.length,
    currentMessage: content,
    budgetNotes: budgetedPrompt.budgetNotes
  });
  const graphLockRunsAtTurnStart = activeResearchGraphLockRuns(bundle);
  const currentTurnDirective = turnKind === "outcome-finalization" ? [
    "SUBAGENT OUTCOME:",
    "The host message contains the persisted result of the delegated work. Treat it as authoritative evidence for what ran and what did not.",
    "Own the next decision: synthesize the result, use another available tool or subagent only when it materially advances the user's original objective, and otherwise give the user the final report. Do not repeat already-completed work or invent unsupported coverage.",
    "A partial or blocked audit is a valid outcome. Clearly separate verified results, failures, unverified coverage, and the concrete next action. Goal and memory state are folded by the host; do not narrate bookkeeping."
  ].join("\n") : [
    "CURRENT LIVE CANVAS STATE:",
    JSON.stringify({
      activeFlowId: input.activeFlowId ?? bundle.project.activeFlowId ?? null,
      activeSubflowId: input.activeSubflowId ?? null,
      selectedNodeIds
    }),
    "This is transient UI state, not graph scope or permission. If and only if the user explicitly asks to select/focus graph items, switch the visible flow/detail flow, pan, center, or zoom, you must use archicode_control_canvas (or canvasAction on the local JSON path) in this turn. Prose cannot move the canvas, so never say the action is happening or will happen unless the same response contains the action. Canvas actions are reversible UI-only actions and do not need a graph review card.",
    "Own the investigation and tool trajectory for this user request. Continue while useful work is available; finish only with a supported answer, a visible approval pause, or a concrete blocker.",
    delphiTestingToolEnabled
      ? `DELPHI MODEL PREFLIGHT: ${delphiVisionPreflightText(delphiModelPreflight)} When the user names a specific page, route, screen, or flow, preserve that exact target in spawn_delphi's objective and acceptance criteria instead of broadening it to a generic project audit.`
      : "",
    explicitDelphiDelegationRequired
      ? "EXPLICIT TEST OBJECTIVE: The user asked for executable test or runtime-audit work. Own the investigation and choose useful preliminary actions yourself, but do not finish or claim coverage until you have delegated the executable audit to archicode_spawn_delphi. Put the full requested scope and acceptance criteria in that delegation."
      : "",
    "Goal progress and Research memory are host-observed state. Do not spend tool calls updating or narrating them.",
    "PROJECT KNOWLEDGE: Session research memory above keeps this chat coherent. Separately, use archicode_project_remember_note only for small important knowledge that should be available to future chats in this project. Use archicode_chat_create_artifact for large reports, raw research, detailed plans, comparisons, or working journals that belong to this chat. Do not duplicate ordinary conversation into either surface.",
    "GRAPH LAYOUT: For exact planning-graph node positions, sizes, spacing, or collision checks, call archicode_read_graph_layout. It reads the current loaded project graph directly. Do not inspect, list, search, or read persisted .archicode flow JSON files to recover canvas geometry.",
    "JAVASCRIPT SCRATCHPAD: Use archicode_scratchpad_repl when arithmetic, statistics, data shaping, or a small helper function would make the answer more reliable. Write standard JavaScript. Each call uses a fresh isolated runtime with no Node.js globals, project files, packages, imports, network APIs, or persistent state.",
    graphLockRunsAtTurnStart.length
      ? `2. GRAPH PERSISTENCE LOCK: Active run${graphLockRunsAtTurnStart.length === 1 ? "" : "s"} ${graphLockRunsAtTurnStart.map((run) => `${run.id} (${run.status})`).join(", ")} currently own project graph truth. You may discuss, clarify, design, call Picasso, and prepare a pending review card normally, but the card cannot be auto-approved or applied until the lock clears. Never claim a graph edit was persisted during this run.`
      : graphReconciliationToolEnabled
        ? "2. GRAPH: Decide semantic complexity from the complete request and history. Direct graph operations are allowed only for a simple quick bounded edit with obvious operations and no design synthesis. Any substantial task—especially specification/attachment decomposition, several nodes or flows, populated subflows, coordinated relationships or acceptance criteria, broad refinement, architecture, or reconciliation—requires Picasso. If the preceding conversation proposed such a scope and you understand the current reply as confirmation, call archicode_spawn_picasso now with that exact scope. Do not submit the complex change set directly and do not merely say it is queued. Graph edges cannot cross top-level flows: never instruct Picasso to create or prefer cross-flow edges. Preserve those dependencies as descriptions, acceptance criteria, or node-scoped notes, while allowing Picasso to connect every generated node with meaningful intra-flow topology."
        : "2. GRAPH: Picasso is unavailable. Direct graph operations remain limited to simple quick bounded edits; do not bypass the missing graph architect for substantial work.",
    "TRUTHFUL COMPLETION: Never promise a future tool action. Statements that work is queued, being prepared, or ready require the corresponding successful tool call in this same turn."
  ].join("\n");
  try {
    let output = await callResearchProvider(await hydrateProviderForUse(provider), content, {
      projectRoot: input.projectRoot,
      signal: input.signal,
      cacheSessionId: nextSession.id,
      webSearchEnabled: nativeWebSearchEnabled(bundle.project.settings),
      scopeContext: budgetedPrompt.scopeContext,
      sessionSummary: nextSession.summary,
      researchMemory: formatResearchMemoryForPrompt(nextSession.memory),
      researchOrchestration: formatResearchOrchestrationForPrompt(capturedOrchestration),
      currentTurnDirective,
      messages: turnPolicy.includeConversationHistory ? nextSession.messages : [],
      researchMessageLimit: budgetedPrompt.researchMessageLimit,
      researchHistoryTokenBudget: budgetedPrompt.researchHistoryTokenBudget,
      researchPersonalityPrompt: personalityPrompt,
      researchVerbosity,
      selectedSkillsPrompt: skillsPrompt,
      researchStructuredToolsEnabled: directProvider,
      mergeResolutionSubagentEnabled: budgetedPrompt.tools.some((tool) => isResearchSpawnMergeTool(tool.providerToolName)),
      graphReconciliationSubagentEnabled: budgetedPrompt.tools.some((tool) => isResearchSpawnGraphReconciliationTool(tool.providerToolName)),
      sherlockResearchSubagentEnabled: budgetedPrompt.tools.some((tool) => isResearchSpawnSherlockTool(tool.providerToolName)),
      delphiTestingSubagentEnabled: budgetedPrompt.tools.some((tool) => isResearchSpawnDelphiTool(tool.providerToolName)),
      onUsage: (usage) => {
        capturedUsage = attachResearchContextLedger(usage, contextLedger);
      },
      onToken: (text, kind) => {
        if (kind !== "thinking") streamedAnswerSoFar += text;
        input.onToken?.(text, kind);
      },
      onTokenReset: () => {
        streamedAnswerSoFar = "";
        input.onTokenReset?.();
      },
      mcpTools: budgetedPrompt.tools,
      mcpServers: researchMcpSettings.mcp.servers,
      isTerminalTool: (providerToolName) =>
        budgetedPrompt.tools.some((tool) => tool.providerToolName === providerToolName) && isResearchSinkTool(providerToolName),
      terminalToolCompletesTurn: (providerToolName) =>
        isResearchChangeSetTool(providerToolName) || isResearchCanvasControlTool(providerToolName),
      validateFinalAnswer: (candidateText) => {
        const candidate = extractArchicodeResearch(candidateText).response;
        const validChangeSet = buildResearchTurnChangeSet(capturedChangeSet, candidate?.changeSet, bundle);
        const failedPicasso = subagentRuns.some((run) => run.kind === "graph-reconciliation" && run.status === "failed");
        if (explicitDelphiDelegationRequired && !subagentRuns.some((run) => run.kind === "delphi-testing")) {
          return [
            "The user explicitly requested executable test/runtime-audit work, but this trajectory has not delegated that work to Delphi.",
            "Continue this same trajectory and call archicode_spawn_delphi with the requested scope and acceptance criteria. You may use other tools when useful, but source inspection or CLI metadata alone cannot complete the executable audit."
          ].join("\n\n");
        }
        if (!failedPicasso && !validChangeSet && claimsPreparedGraphReviewCard(candidate?.answer ?? candidateText)) {
          return [
            "Your answer says a graph review card was prepared, but no valid graph change-set sink call exists in this trajectory.",
            "Continue in this same trajectory: call archicode_propose_graph_change_set with the supported operations if the evidence is sufficient, or answer honestly that no card was created. Do not claim a card exists without the tool result."
          ].join("\n\n");
        }
        if (turnKind === "outcome-finalization" && isInternalOutcomeBookkeepingNarration(visibleResearchAnswer(candidate?.answer ?? candidateText))) {
          return "The host already owns goal and memory bookkeeping. Return the self-contained user-facing evidence report now; do not narrate internal state updates.";
        }
        return undefined;
      },
      isApprovalError: (error) => error instanceof ResearchMcpApprovalRequired,
      resumeContinuation,
      callMcpTool: async (toolInput) => {
        const tool = budgetedPrompt.tools.find((item) => item.providerToolName === toolInput.providerToolName);
        if (!tool) {
          const availableToolNames = budgetedPrompt.tools.map((item) => item.providerToolName).sort();
          const message = `Unknown Research tool "${toolInput.providerToolName}". No tool was executed.`;
          mcpToolCalls.push({
            serverId: "unknown",
            toolName: toolInput.providerToolName,
            argumentsJson: toolInput.argumentsJson,
            status: "failed",
            error: message,
            createdAt: iso()
          });
          return JSON.stringify({
            status: "invalid-tool-name",
            requestedToolName: toolInput.providerToolName,
            message: "No tool ran. Use one exact providerToolName from availableTools, or choose another approach.",
            availableTools: availableToolNames
          }, null, 2);
        }
        // Internal sink tools carry structured output back to the caller; they
        // never execute, need no approval, and are not recorded as MCP calls.
        if (isResearchChangeSetTool(toolInput.providerToolName)) {
          try {
            capturedChangeSet = JSON.parse(toolInput.argumentsJson || "{}");
          } catch {
            capturedChangeSet = undefined;
          }
          return "Graph change set captured for review.";
        }
        if (isResearchCanvasControlTool(toolInput.providerToolName)) {
          try {
            capturedCanvasAction = validateResearchCanvasAction(
              bundle,
              JSON.parse(toolInput.argumentsJson || "{}"),
              { activeFlowId: input.activeFlowId, activeSubflowId: input.activeSubflowId }
            );
            return "Canvas action captured and will be applied when this response finishes.";
          } catch (error) {
            capturedCanvasAction = undefined;
            return `Canvas action rejected: ${error instanceof Error ? error.message : String(error)} Correct the target and try the canvas tool again.`;
          }
        }
        if (isResearchMemoryTool(toolInput.providerToolName)) {
          try {
            capturedMemoryDelta = JSON.parse(toolInput.argumentsJson || "{}");
          } catch {
            capturedMemoryDelta = undefined;
          }
          return "Optional semantic memory delta captured; the host will validate and fold it.";
        }
        if (rulesApprovalRejected && toolInput.providerToolName === ARCHICODE_RESEARCH_RULES_TOOL_NAME) {
          mcpToolCalls.push({
            serverId: ARCHICODE_RESEARCH_RULES_SERVER_ID,
            serverLabel: "ArchiCode Rules",
            toolName: "manage_rules",
            argumentsJson: toolInput.argumentsJson,
            status: "failed",
            error: "The user rejected this rule change.",
            createdAt: iso()
          });
          return "The user rejected this exact rule change. Nothing was changed. Do not submit it again unless the user explicitly asks for it later.";
        }
        if (isResearchContextExpansionTool(toolInput.providerToolName)) {
          input.onActivity?.("Loading fuller project context for the parent investigation.", "running");
          const resultText = await buildExpandedResearchContextToolResult(
            input.projectRoot,
            bundle,
            nextSession.scope,
            fetchedWebPages,
            approvedMcpServerIds,
            rejectedMcpServerIds,
            referencedNodeIds,
            selectedNodeIds,
            toolInput.argumentsJson
          );
          mcpToolCalls.push({
            serverId: RESEARCH_CONTEXT_SERVER_ID,
            serverLabel: "Research Context",
            toolName: "read_context",
            argumentsJson: toolInput.argumentsJson,
            status: "succeeded",
            resultSummary: resultText.slice(0, 1000),
            createdAt: iso()
          });
          return resultText;
        }
        if (isResearchGraphLayoutTool(toolInput.providerToolName)) {
          input.onActivity?.("Reading current planning-graph layout.", "running");
          try {
            const resultText = buildResearchGraphLayoutToolResult(bundle, toolInput.argumentsJson, {
              activeFlowId: input.activeFlowId,
              activeSubflowId: input.activeSubflowId,
              sessionScope: nextSession.scope
            });
            mcpToolCalls.push({
              serverId: RESEARCH_CONTEXT_SERVER_ID,
              serverLabel: "Research Context",
              toolName: "read_graph_layout",
              argumentsJson: toolInput.argumentsJson,
              status: "succeeded",
              resultSummary: resultText.slice(0, 1000),
              createdAt: iso()
            });
            return resultText;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            mcpToolCalls.push({
              serverId: RESEARCH_CONTEXT_SERVER_ID,
              serverLabel: "Research Context",
              toolName: "read_graph_layout",
              argumentsJson: toolInput.argumentsJson,
              status: "failed",
              error: message,
              createdAt: iso()
            });
            return `Graph layout inspection failed: ${message} Correct the filters and call archicode_read_graph_layout again.`;
          }
        }
        if (isResearchChatHistoryTool(toolInput.providerToolName)) {
          input.onActivity?.("Reviewing older chat history for continuity.", "running");
          let resultText = buildResearchChatHistoryToolResult(
            nextSession.messages,
            researchContextPlan.recentMessageLimit,
            toolInput.argumentsJson
          );
          const currentHistory = JSON.parse(resultText) as { searchableMessages?: number };
          if (currentHistory.searchableMessages === 0) {
            let requested: { maxMessages?: number; maxChars?: number } = {};
            try {
              requested = JSON.parse(toolInput.argumentsJson || "{}") as typeof requested;
            } catch {
              requested = {};
            }
            const previousChats = JSON.parse(buildResearchPreviousChatsToolResult(
              await listResearchChats(input.projectRoot),
              nextSession.id,
              JSON.stringify({
                sort: "recent",
                maxResults: Math.min(requested.maxMessages ?? RESEARCH_CHAT_HISTORY_DEFAULT_MESSAGES, 8),
                maxChars: requested.maxChars ?? RESEARCH_CHAT_HISTORY_DEFAULT_CHARS
              })
            ));
            resultText = JSON.stringify({
              ...currentHistory,
              crossChatFallback: {
                reason: "The currently open chat has no earlier messages, so recent previous chats from this project are included.",
                ...previousChats
              }
            }, null, 2);
          }
          mcpToolCalls.push({
            serverId: RESEARCH_CHAT_HISTORY_SERVER_ID,
            serverLabel: "Chat History",
            toolName: "read_chat_history",
            argumentsJson: toolInput.argumentsJson,
            status: "succeeded",
            resultSummary: resultText.slice(0, 1000),
            createdAt: iso()
          });
          return resultText;
        }
        if (isResearchPreviousChatsTool(toolInput.providerToolName)) {
          input.onActivity?.("Searching previous chats in this project.", "running");
          const resultText = buildResearchPreviousChatsToolResult(
            await listResearchChats(input.projectRoot),
            nextSession.id,
            toolInput.argumentsJson
          );
          mcpToolCalls.push({
            serverId: RESEARCH_PREVIOUS_CHATS_SERVER_ID,
            serverLabel: "Previous Chats",
            toolName: "search_previous_chats",
            argumentsJson: toolInput.argumentsJson,
            status: "succeeded",
            resultSummary: resultText.slice(0, 1000),
            createdAt: iso()
          });
          return resultText;
        }
        // Merge resolution writes real repo files, so it never executes inline:
        // it always creates an awaiting-approval activity card and waits for an
        // explicit user decision via respondToSubagentRun.
        if (isResearchSpawnMergeTool(toolInput.providerToolName)) {
          if (!mergeResolutionToolEnabled) {
            return "Solomon is disabled by project settings.";
          }
          const args = JSON.parse(toolInput.argumentsJson || "{}") as MergeResolutionInput;
          const runCreatedAt = iso();
          subagentRuns.push({
            id: id("subagent-run"),
            kind: "merge-resolution",
            status: "awaiting-approval",
            title: `Resolve merge conflicts in ${args.conflictedFiles.join(", ")}`,
            argumentsJson: toolInput.argumentsJson,
            proposedResolutionStrategy: args.resolutionStrategy,
            progress: [],
            createdAt: runCreatedAt,
            updatedAt: runCreatedAt
          });
          return `A merge-conflict resolution proposal is now awaiting the user's approval in the chat UI (conflicted files: ${args.conflictedFiles.join(", ")}${args.resolutionStrategy ? `; your proposed strategy: ${args.resolutionStrategy}` : ""}). Do not call this tool again for these files and do not claim it has run or succeeded. Tell the user you've prepared the proposal and are waiting for them to approve (or adjust) the resolution strategy in the UI.`;
        }
        // Delphi may execute project verification and launch an explicitly
        // selected Run App target, so Research never runs it inline. The card
        // grants a bounded capability; chosen actions remain safety-checked.
        if (isResearchSpawnDelphiTool(toolInput.providerToolName)) {
          if (!delphiTestingToolEnabled) return "Delphi is disabled by project settings.";
          const alreadyScheduled = subagentRuns.find((run) => run.kind === "delphi-testing" && (run.status === "awaiting-approval" || run.status === "running"));
          if (alreadyScheduled) {
            return `A Delphi audit is already scheduled in this turn as ${alreadyScheduled.id}. Do not call archicode_spawn_delphi again; finish this turn so the host can run that one audit.`;
          }
          let rawArgs: unknown;
          try {
            rawArgs = JSON.parse(toolInput.argumentsJson || "{}");
          } catch {
            return "REPAIRABLE_TOOL_ERROR: archicode_spawn_delphi arguments were not valid JSON. No audit was created. Correct the JSON object and call archicode_spawn_delphi again.";
          }
          const parsedArgs = delphiTestingInputSchema.safeParse(rawArgs);
          if (!parsedArgs.success) {
            const details = parsedArgs.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ");
            return [
              "REPAIRABLE_TOOL_ERROR: archicode_spawn_delphi arguments did not match the Delphi request schema. No audit was created.",
              details,
              "Use platforms only from web, electron, flutter, android, ios, generic. Put a Run App profile id in target.profileId, not platforms. commands, when supplied, are advisory check suggestions rather than an authorization list. Correct the payload and call archicode_spawn_delphi again."
            ].join(" ");
          }
          const args = parsedArgs.data;
          const environment = await inspectDelphiTestEnvironment(input.projectRoot, args);
          const compatibleRuntimeProfiles = compatibleDelphiRuntimeProfiles(args, environment);
          const approvedArgs = pinDelphiRuntimeTarget(args, environment);
          // If a supported managed adapter is required, ask for setup before
          // launching an audit that could only perform partial CLI coverage.
          // The approved setup card resumes this same capability-scoped audit afterward.
          const preflightSetup = delphiManagedSetupInput(approvedArgs, environment);
          const runnableArgs = preflightSetup ?? approvedArgs;
          let runtimePlan: Awaited<ReturnType<typeof planDelphiRuntimeLaunch>>;
          try {
            runtimePlan = await planDelphiRuntimeLaunch(input.projectRoot, approvedArgs);
          } catch (error) {
            return `Delphi could not prepare the requested runtime target: ${error instanceof Error ? error.message : String(error)} Ask the user to choose a valid Run App profile/target before retrying.`;
          }
          const runCreatedAt = iso();
          const commandSummary = environment.discoveredCommands.length
            ? ` Delphi may choose relevant finite project checks from ${environment.discoveredCommands.length} discovered script/check option${environment.discoveredCommands.length === 1 ? "" : "s"}; every chosen action remains dynamically safety-checked.`
            : " No project script/check was discovered; Delphi can still use applicable direct runtime adapters and report concrete coverage limitations.";
          const definitionSummary = "";
          const omittedCommandSummary = "";
          const adapterSummary = environment.toolchains.map((toolchain) => `${toolchain.adapter}: ${toolchain.status}`).join(", ");
          const visionSummary = `Vision preflight: ${delphiVisionPreflightText(delphiModelPreflight)}`;
          const targetParts = approvedArgs.target ? [
            approvedArgs.target.profileId ? `Run App profile ${approvedArgs.target.profileId}` : "",
            approvedArgs.target.baseUrl,
            approvedArgs.target.deviceId ? `device ${approvedArgs.target.deviceId}` : "",
            approvedArgs.target.appiumServerUrl && approvedArgs.target.appiumSessionId
              ? `Appium session ${approvedArgs.target.appiumSessionId} at ${approvedArgs.target.appiumServerUrl}`
              : ""
          ].filter(Boolean) : [];
          const targetSummary = targetParts.length
            ? ` Explicit target: ${targetParts.join("; ")}.`
            : compatibleRuntimeProfiles.length > 1
              ? ` Choose one or more compatible Run App targets: ${compatibleRuntimeProfiles.map((profile) => profile.label).join(", ")}.`
              : " No live runtime/device target was supplied, so Delphi cannot claim direct UI or emulator coverage.";
          const runtimeSummary = runtimePlan?.requiresLaunch
            ? [
                ` Approved target lifecycle for ${runtimePlan.profileLabel}: ${runtimePlan.commands.join(" | ")}.${runtimePlan.cleanupCommands.length && approvedArgs.target?.cleanup === "stop-if-started" ? ` Owned-target cleanup: ${runtimePlan.cleanupCommands.join(" | ")}.` : ""}`,
                runtimePlan.occupiedPorts.length
                  ? ` Configured port${runtimePlan.occupiedPorts.length === 1 ? "" : "s"} ${runtimePlan.occupiedPorts.join(", ")} already belong to another listener. Delphi will neither test nor stop that listener; ${runtimePlan.allowsReportedLocalFallback ? "this approval allows a localhost fallback URL reported by the exact launched runtime process" : "the audit will stop and ask before any cleanup"}.`
                  : ""
              ].join("")
            : runtimePlan?.existingServiceId
              ? ` Delphi will reuse the already-running ${runtimePlan.profileLabel} service ${runtimePlan.existingServiceId}.`
              : "";
          subagentRuns.push({
            id: id("subagent-run"),
            kind: "delphi-testing",
            status: "awaiting-approval",
            title: `${preflightSetup ? "Set up & audit" : "Audit"}: ${args.objective.slice(0, 100)}`,
            argumentsJson: JSON.stringify(runnableArgs),
            runtimeTargetSelection: compatibleRuntimeProfiles.length > 1 ? {
              options: compatibleRuntimeProfiles.map((profile) => ({
                profileId: profile.id,
                label: profile.label,
                kind: profile.kind,
                targetRequired: profile.targetRequired,
                defaultTargetId: profile.defaultTargetId
              })),
              minSelections: 1,
              allowMultiple: true
            } : undefined,
            approvedRuntimeCommands: runtimePlan?.commands ?? [],
            approvedRuntimeCleanupCommands: runtimePlan?.cleanupCommands ?? [],
            imageInputSupport: delphiModelPreflight.imageInputSupport,
            reviewReason: [
              preflightSetup
                ? `Delphi needs ${preflightSetup.setup!.adapters.join(" and ")} for the requested direct UI coverage. Approval installs it only in ArchiCode's managed cache${preflightSetup.setup!.adapters.includes("playwright") ? ` and downloads ${preflightSetup.setup!.playwrightBrowsers.join(", ")}` : ""}, then automatically resumes this same audit.`
                : `Delphi will inspect the project and ${args.mode === "plan" ? "prepare a non-executing audit plan" : "run existing finite tests and approved direct adapter actions"}.`,
              commandSummary,
              definitionSummary,
              omittedCommandSummary,
              targetSummary,
              runtimeSummary,
              visionSummary,
              approvedArgs.observation.mode === "visible" ? "Observation: visible target windows with captured evidence." : "Observation: headless with captured evidence.",
              adapterSummary ? `Adapter preflight: ${adapterSummary}.` : "",
              "No project dependency or source file will be changed."
            ].filter(Boolean).join(" "),
            progress: [],
            createdAt: runCreatedAt,
            updatedAt: runCreatedAt
          });
          return preflightSetup
            ? "A combined Delphi managed-tool setup and test/runtime audit is awaiting the user's approval in the chat UI. Do not call Delphi again for this objective and do not claim anything ran. Approval installs the listed isolated tooling and automatically resumes the same audit."
            : compatibleRuntimeProfiles.length > 1
              ? "A Delphi test/runtime audit is awaiting the user's target selection in the chat UI. The user may choose one or several compatible Run App targets; do not choose for them or call Delphi again."
              : "A Delphi test/runtime audit is awaiting the user's approval in the chat UI. Do not call Delphi again for this objective and do not claim that tests ran. Tell the user the audit is ready for review.";
        }
        // Graph reconciliation only proposes graph edits (already gated by the
        // existing change-set review card), so a standalone call can run inline.
        if (isResearchSpawnGraphReconciliationTool(toolInput.providerToolName)) {
          return runPicassoGraphPass(toolInput.argumentsJson);
        }
        if (isResearchSpawnSherlockTool(toolInput.providerToolName)) {
          if (!sherlockResearchToolEnabled) return "Sherlock is disabled by project settings.";
          const runId = id("subagent-run");
          const runCreatedAt = iso();
          try {
            const args = JSON.parse(toolInput.argumentsJson || "{}") as SherlockResearchInput;
            const title = `Investigate: ${args.objective.slice(0, 100)}`;
            subagentRuns.push({
              id: runId,
              kind: "sherlock-research",
              status: "running",
              title,
              argumentsJson: toolInput.argumentsJson,
              progress: [],
              createdAt: runCreatedAt,
              updatedAt: runCreatedAt
            });
            publishSubagentProgress(runId, "sherlock-research", title, "Sherlock is preparing a fresh investigation.");
            const result = await executeMicroRun(
              input.projectRoot,
              "sherlock-research",
              args,
              await hydrateProviderForUse(provider),
              bundle,
              {
                // Stopping the parent turn must also stop this inline
                // subagent, not leave it burning discarded provider calls.
                signal: input.signal,
                runConsoleCommand: (commandArgs) => runInternalConsoleCommand(input.projectRoot, bundle.project.settings, commandArgs, {
                  authorization: {
                    actor: "sherlock",
                    capabilities: ["inspect-project"]
                  },
                  maxTimeoutMs: 10 * 60_000,
                  signal: input.signal
                }),
                onProgress: (message) => {
                  const run = subagentRuns.find((entry) => entry.id === runId);
                  if (run) {
                    run.progress.push(message);
                    run.updatedAt = iso();
                  }
                  publishSubagentProgress(runId, "sherlock-research", title, message);
                }
              }
            );
            const sherlockOutput = result.output as SherlockResearchOutput | undefined;
            const sherlockRunStatus: SubagentRun["status"] = result.status === "failed"
              ? "failed"
              : sherlockOutput?.status === "blocked"
                ? "blocked"
                : "completed";
            const run = transitionInMemorySubagentRun(runId, sherlockRunStatus, {
              resultSummary: microRunHumanSummary(result),
              error: result.status === "failed" ? result.error : undefined,
              usage: result.usage,
              diagnostics: result.diagnostics
            });
            if (run) {
              publishSubagentProgress(
                runId,
                "sherlock-research",
                title,
                run.resultSummary ?? (run.status === "blocked" ? "Sherlock was blocked." : "Sherlock completed."),
                run.status === "failed" ? "failed" : run.status === "blocked" ? "blocked" : "completed"
              );
              input.onActivity?.(
                run.status === "failed" || run.status === "blocked"
                  ? "Sherlock could not complete the investigation. Archi is taking over with the available project tools."
                  : "Sherlock completed. Archi is reviewing the evidence and continuing the investigation below.",
                "running"
              );
            }
            return microRunResultText(result);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const run = transitionInMemorySubagentRun(runId, "failed", { error: errorMessage });
            if (run) {
              publishSubagentProgress(runId, "sherlock-research", run.title, errorMessage, "failed");
            }
            return `Sherlock failed: ${errorMessage}`;
          }
        }
        try {
          let activityArgs: Record<string, unknown> = {};
          try {
            activityArgs = JSON.parse(toolInput.argumentsJson || "{}") as Record<string, unknown>;
          } catch {
            activityArgs = {};
          }
          if (turnKind === "outcome-finalization" && requestsRedundantOutcomeArtifactRead(toolInput.providerToolName, activityArgs)) {
            return "The host already supplied the complete Delphi outcome evidence packet. Do not rescan .archicode artifacts; continue from the supplied checks, findings, blockers, and runtime summary. Normal source-file inspection remains available when genuinely needed.";
          }
          if (approvalWasRejected
            && approvalRequest?.providerToolName === toolInput.providerToolName
            && toolInput.providerToolName === "archicode_console_run_command"
            && sameToolArguments(approvalRequest.argumentsJson ?? "{}", toolInput.argumentsJson)) {
            return JSON.stringify({
              status: "rejected",
              message: "The user rejected this exact command. Choose another safe way to advance the same goal; do not repeat it unless the user explicitly requests it later."
            });
          }
          input.onActivity?.(investigationToolProgressMessage(toolInput.providerToolName, activityArgs), "running");
          const isProjectFileTool = isResearchProjectFileTool(toolInput.providerToolName);
          const server = tool ? researchMcpSettings.mcp.servers.find((item) => item.id === tool.serverId) : undefined;
          if (!isProjectFileTool && server && !server.trusted) {
            throw new ResearchMcpApprovalRequired({
              serverId: server.id,
              serverLabel: server.label,
              toolName: tool?.toolName ?? toolInput.providerToolName,
              providerToolName: toolInput.providerToolName,
              argumentsJson: toolInput.argumentsJson
            });
          }
          const result = isProjectFileTool
            ? await callResearchProjectFileTool(input.projectRoot, toolInput, {
                sessionId: nextSession.id,
                sessionScope: nextSession.scope
              })
            : await executeResearchToolCall(input.projectRoot, researchMcpSettings, toolInput, {
                ruleMutationApproved: consumeExactRuleMutationApproval(toolInput)
              });
          const resultText = result.resultText;
          mcpToolCalls.push({
            serverId: result.serverId,
            serverLabel: result.serverLabel,
            toolName: result.toolName,
            argumentsJson: toolInput.argumentsJson,
            status: "succeeded",
            resultSummary: resultText.slice(0, 1000),
            createdAt: iso()
          });
          return resultText;
        } catch (error) {
          if (error instanceof ResearchMcpApprovalRequired) throw error;
          mcpToolCalls.push({
            serverId: tool?.serverId ?? "unknown",
            serverLabel: tool?.serverLabel,
            toolName: tool?.toolName ?? toolInput.providerToolName,
            argumentsJson: toolInput.argumentsJson,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            createdAt: iso()
          });
          if (isRepairableProjectToolError(toolInput.providerToolName, error)) {
            return repairableProjectToolResult(toolInput.providerToolName, error);
          }
          throw error;
        }
      },
      imageAttachments: [
        ...messageImageInputs,
        ...scopedNoteImages.map((image) => ({
          ...image,
          source: "context" as const,
          sourceLabel: "scoped graph note"
        }))
      ],
      textAttachments: [
        ...messageTextInputs,
        ...scopedNoteTexts.map((attachment) => ({
          ...attachment,
          source: "context" as const,
          sourceLabel: "scoped graph note"
        }))
      ]
    });
    let extracted = extractArchicodeResearch(output);
    let parsed = extracted.response;
    let changeSet = buildResearchTurnChangeSet(capturedChangeSet, parsed?.changeSet, bundle);
    const failedPicasso = subagentRuns.find((run) => run.kind === "graph-reconciliation" && run.status === "failed");
    recordObservedTurnGoalCheckpoint();
    if (subagentRuns.length || mcpToolCalls.length) {
      input.onActivity?.("Archi finished reviewing the collected evidence and is preparing the final answer.", "completed");
    }
    // Prefer structured output captured from native sink-tool calls; fall back
    // to the legacy text envelope for codex/offline providers.
    let canvasAction = capturedCanvasAction;
    if (!canvasAction && parsed?.canvasAction) {
      try {
        canvasAction = validateResearchCanvasAction(bundle, parsed.canvasAction, {
          activeFlowId: input.activeFlowId,
          activeSubflowId: input.activeSubflowId
        });
      } catch {
        canvasAction = undefined;
      }
    }
    let visibleAnswer = failedPicasso && !changeSet
      ? [
          "Picasso could not prepare a valid graph change set, so no review card was created.",
          failedPicasso.error || failedPicasso.resultSummary || "The graph-design subagent failed validation.",
          "Nothing was applied. You can retry the same request after correcting the proposal contract."
        ].join("\n\n")
      : visibleResearchAnswer(parsed?.answer ?? output);
    if (turnKind === "outcome-finalization" && isInternalOutcomeBookkeepingNarration(visibleAnswer)) {
      visibleAnswer = hostOutcomeReportFromContinuation(content) ?? "Delphi finished, but the parent provider did not produce a usable user-facing report. Review the Delphi card above for the recorded checks and coverage limits.";
    }
    const graphLockRunsAfterTurn = await activeGraphLockRunsNow();
    if (changeSet && graphLockRunsAfterTurn.length) {
      visibleAnswer = [
        visibleAnswer,
        `This review card is prepared for later, but it cannot be applied while active run${graphLockRunsAfterTurn.length === 1 ? "" : "s"} ${graphLockRunsAfterTurn.map((run) => `${run.id} (${run.status})`).join(", ")} ${graphLockRunsAfterTurn.length === 1 ? "is" : "are"} in progress or waiting for review. This card does not change current graph truth; Apply unlocks after the run finishes or is cancelled.`
      ].filter(Boolean).join("\n\n");
    }
    const assistantCreatedAt = iso();
    const assistantMessage: ResearchChatMessage = {
      id: id("msg"),
      role: "assistant",
      content: visibleAnswer,
      createdAt: assistantCreatedAt,
      attachmentIds: [],
      webUsed: bundle.project.settings.webSearch.enabled,
      mcpToolCalls,
      subagentRuns,
      usage: capturedUsage,
      canvasAction,
      changeSet
    };
    const approvalSubagent = subagentRuns.find((run) => run.status === "awaiting-approval");
    const turnOrchestration = changeSet
      ? researchGoalAwaitingApproval(capturedOrchestration, { id: changeSet.id, label: changeSet.summary }, assistantCreatedAt)
      : approvalSubagent
        ? researchGoalAwaitingApproval(capturedOrchestration, { id: approvalSubagent.id, label: approvalSubagent.title }, assistantCreatedAt)
        : capturedOrchestration;
    nextSession = researchChatSessionSchema.parse({
      ...nextSession,
      summary: compactSummary(nextSession.summary, failedPicasso && !changeSet ? undefined : parsed?.summary, assistantMessage.content),
      memory: nextSession.memory,
      orchestration: changeSet
        ? trackResearchChangeSetTodo(turnOrchestration, changeSet, assistantMessage.id, assistantCreatedAt)
        : turnOrchestration,
      messages: [...nextSession.messages, assistantMessage],
      updatedAt: iso()
    });
    nextSession = applyResearchTurnMemory(nextSession, capturedMemoryDelta, {
      userMessage,
      assistantMessage
    });
    nextSession = applyHostObservedResearchMemory(nextSession, {
      userMessage,
      assistantMessage
    });
    if (changeSet && !graphLockRunsAfterTurn.length && shouldAutoApproveResearchChangeSet(bundle.project.settings.researchAutoApproveGraphChanges, changeSet)) {
      try {
        nextSession = (await reviewResearchGraphChangeSet({
          projectRoot: input.projectRoot,
          session: nextSession,
          messageId: assistantMessage.id,
          changeSetId: changeSet.id,
          decisions: changeSet.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const })),
          resultPrefix: "Auto-approved graph changes"
        })).session;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.startsWith("Graph editing is locked while active run")) throw error;
        const lockNotice = "A project run became active before auto-approval, so this review card remains pending and the graph was not changed.";
        nextSession = researchChatSessionSchema.parse({
          ...nextSession,
          messages: nextSession.messages.map((message) => message.id === assistantMessage.id
            ? { ...message, content: [message.content, lockNotice].filter(Boolean).join("\n\n") }
            : message),
          updatedAt: iso()
        });
      }
    }
  } catch (error) {
    if (error instanceof ResearchMcpApprovalRequired) {
      capturedOrchestration = researchGoalAwaitingApproval(capturedOrchestration, {
        id: error.request.providerToolName,
        label: `${error.request.serverLabel}: ${error.request.toolName}`
      });
      const assistantMessage: ResearchChatMessage = {
        id: id("msg"),
        role: "assistant",
        content: error.request.providerToolName === ARCHICODE_RESEARCH_RULES_TOOL_NAME
          ? `Rule change requires approval: ${describeResearchRulesMutation(error.request.argumentsJson)}. Nothing has been changed yet.`
          : `MCP approval required: ${error.request.serverLabel} wants to run ${error.request.toolName}.`,
        createdAt: iso(),
        attachmentIds: [],
        webUsed: bundle.project.settings.webSearch.enabled,
        mcpToolCalls: [{
          serverId: error.request.serverId,
          serverLabel: error.request.serverLabel,
          toolName: error.request.toolName,
          argumentsJson: error.request.argumentsJson,
          status: "approval-required",
          resultSummary: "Waiting for user approval.",
          createdAt: iso()
        }],
        mcpApprovalRequest: {
          serverIds: [error.request.serverId],
          serverLabels: [error.request.serverLabel],
          toolName: error.request.toolName,
          providerToolName: error.request.providerToolName,
          argumentsJson: error.request.argumentsJson,
          originalContent: content,
          filePaths: messageFilePaths,
          internalContinuation,
          providerContinuation: extractProviderContinuation(error)
        },
        subagentRuns: [],
        usage: capturedUsage
      };
      nextSession = researchChatSessionSchema.parse({
        ...nextSession,
        orchestration: capturedOrchestration,
        messages: [...nextSession.messages, assistantMessage],
        updatedAt: iso()
      });
      await persistResearchSession(input.projectRoot, nextSession);
      return nextSession;
    }
    if (isResearchCancellationError(error)) {
      const stoppedAt = iso();
      const assistantMessage: ResearchChatMessage = {
        id: id("msg"),
        role: "assistant",
        content: streamedAnswerSoFar.trim() || "Stopped.",
        createdAt: stoppedAt,
        attachmentIds: [],
        webUsed: bundle.project.settings.webSearch.enabled,
        mcpToolCalls,
        subagentRuns: settleAbandonedSubagentRuns(subagentRuns, stoppedAt, { rejectAwaitingApprovals: true }),
        usage: capturedUsage
      };
      nextSession = researchChatSessionSchema.parse({
        ...nextSession,
        orchestration: capturedOrchestration,
        messages: [...nextSession.messages, assistantMessage],
        updatedAt: iso()
      });
      await persistResearchSession(input.projectRoot, nextSession);
      return nextSession;
    }
    const loopGuardFailure = researchLoopGuardFailure(error);
    const failedPicassoRun = subagentRuns.find((run) => run.kind === "graph-reconciliation" && run.status === "failed");
    const assistantMessage: ResearchChatMessage = {
      id: id("msg"),
      role: "assistant",
      content: failedPicassoRun
        ? [
            "Picasso could not prepare a valid graph change set, so no review card was created.",
            failedPicassoRun.error || failedPicassoRun.resultSummary || "The graph-design subagent failed validation.",
            "Nothing was applied. Review the reported contract failure before trying a revised graph-design objective."
          ].join("\n\n")
        : loopGuardFailure
        ? `ArchiCode stopped a no-progress agent loop. ${loopGuardFailure} No additional tool action was executed after the guard fired.`
        : provider.kind === "codex-local"
        ? "Codex Local failed. Check that the Codex CLI/app bridge is installed, signed in, and reachable from the Local command setting, then try again."
        : provider.kind === "claude-local"
          ? "Claude Code Local failed. Check that the Claude Code CLI is installed, signed in, and reachable from the Local command setting, then try again."
          : provider.kind === "opencode-local"
            ? "OpenCode Local failed. Check that the OpenCode CLI is installed, authenticated, has configured models, and is reachable from the Local command setting, then try again."
            : provider.kind === "antigravity-local"
              ? "Antigravity Local failed. Check that agy is installed, signed in, trusts the project workspace, and is reachable from the Local command setting, then try again."
          : "Research provider failed. Check provider settings, API keys, web capability, or rate limits, then try again.",
      createdAt: iso(),
      attachmentIds: [],
      webUsed: bundle.project.settings.webSearch.enabled,
      mcpToolCalls,
      subagentRuns: settleAbandonedSubagentRuns(subagentRuns, iso()),
      usage: capturedUsage,
      error: error instanceof Error ? error.message : String(error)
    };
    nextSession = researchChatSessionSchema.parse({
      ...nextSession,
      orchestration: capturedOrchestration,
      messages: [...nextSession.messages, assistantMessage],
      updatedAt: iso()
    });
  }

  await persistResearchSession(input.projectRoot, nextSession);
  return nextSession;
}

function researchNoteAttachmentScopes(
  scope: ResearchChatScope,
  referencedNodes: ResearchMessageNodeReference[]
): Array<{ flowId: string; nodeIds: string[] }> {
  const nodeIdsByFlow = new Map<string, Set<string>>();
  const include = (flowId: string, nodeId: string) => {
    const nodeIds = nodeIdsByFlow.get(flowId) ?? new Set<string>();
    nodeIds.add(nodeId);
    nodeIdsByFlow.set(flowId, nodeIds);
  };
  if (scope.type === "node") include(scope.flowId, scope.nodeId);
  for (const reference of referencedNodes) include(reference.flowId, reference.nodeId);
  return [...nodeIdsByFlow.entries()].map(([flowId, nodeIds]) => ({ flowId, nodeIds: [...nodeIds] }));
}

export function isResearchTextAttachmentMediaType(mediaType: string): boolean {
  return isSupportedTextDocumentMediaType(mediaType);
}

function researchMessageRoleLabel(role: ResearchChatMessage["role"]): string {
  if (role === "assistant") return "AI Assistant";
  if (role === "user") return "User";
  return "System";
}

function researchChatTranscript(session: ResearchChatSession): string {
  return [
    `Chat title: ${session.title}`,
    `Created: ${session.createdAt}`,
    `Updated: ${session.updatedAt}`,
    "",
    ...session.messages.map((message, index) => [
      `## Message ${index + 1}: ${researchMessageRoleLabel(message.role)}`,
      `Created: ${message.createdAt}`,
      message.attachmentIds.length ? `Attachments: ${message.attachmentIds.join(", ")}` : "",
      "",
      message.content.trim() || "(empty)"
    ].filter(Boolean).join("\n"))
  ].join("\n\n");
}

export async function summarizeResearchChat(input: {
  projectRoot: string;
  sessionId: string;
  providerId?: string;
}): Promise<ResearchChatSession> {
  return withResearchSessionLock(input.projectRoot, input.sessionId, () => summarizeResearchChatTurn(input));
}

async function summarizeResearchChatTurn(input: {
  projectRoot: string;
  sessionId: string;
  providerId?: string;
}): Promise<ResearchChatSession> {
  const store = await readChatsForMutation(input.projectRoot);
  const session = store.sessions.find((item) => item.id === input.sessionId);
  if (!session) throw new Error(`Research chat ${input.sessionId} was not found.`);
  if (!session.messages.length) throw new Error("Research chat has no messages to summarize.");

  const bundle = await loadProject(input.projectRoot);
  const providerId = input.providerId ?? bundle.project.settings.providers.find((provider) => provider.enabled)?.id ?? session.providerId;
  const configuredProvider = bundle.project.settings.providers.find((item) => item.id === providerId);
  if (!configuredProvider) throw new Error("Choose a provider in Settings before summarizing Research.");
  const provider = researchProviderWithModel(configuredProvider, session.modelId ?? undefined);
  const personalityPrompt = await activeResearchPersonalityPrompt();

  const transcript = researchChatTranscript(session);
  const prompt = [
    "Summarize only the chat transcript in the provided context.",
    "Do not use ArchiCode graph context, project state, files, node metadata, web results, or prior chats.",
    "Do not infer product scope from anything outside this transcript.",
    "Write a useful handoff-style summary with: key points, decisions, unresolved questions, and next actions.",
    "If the transcript is short or trivial, say that plainly instead of adding unrelated project details.",
    "Do not include planning boilerplate such as Decision, Assumptions, or proceed."
  ].join(" ");

  let content = "";
  try {
    const output = await callResearchProvider(await hydrateProviderForUse(provider), prompt, {
      webSearchEnabled: false,
      scopeContext: [
        "Transcript-only summary mode.",
        "The following text is the complete and only source material for this summary.",
        "",
        transcript.slice(0, 50000)
      ].join("\n"),
      sessionSummary: "",
      messages: [],
      imageAttachments: [],
      researchPersonalityPrompt: personalityPrompt,
      selectedSkillsPrompt: "",
      mcpTools: [],
      mcpServers: []
    });
    const extracted = extractArchicodeResearch(output);
    content = extracted.response?.answer ?? output;
  } catch (error) {
    content = [
      "Chat summary failed.",
      error instanceof Error ? error.message : String(error)
    ].join("\n\n");
  }

  const summaryMessage: ResearchChatMessage = {
    id: id("msg"),
    role: "assistant",
    content: content.trim() || "No summary was produced.",
    createdAt: iso(),
    attachmentIds: [],
    webUsed: false,
    mcpToolCalls: [],
    subagentRuns: []
  };
  const updatedSession = researchChatSessionSchema.parse({
    ...session,
    providerId,
    summary: summaryMessage.content,
    memory: researchMemorySchema.parse({
      ...session.memory,
      summary: summaryMessage.content.slice(0, 6000),
      lastUpdateError: undefined,
      updatedAt: iso()
    }),
    messages: [...session.messages, summaryMessage],
    updatedAt: iso()
  });
  await persistResearchSession(input.projectRoot, updatedSession);
  return updatedSession;
}

export async function applyResearchGraphChangeSet(input: {
  projectRoot: string;
  sessionId: string;
  messageId: string;
  changeSetId: string;
  decisions: ResearchGraphChangeDecision[];
  retryReviewed?: boolean;
}): Promise<{ session: ResearchChatSession; bundle: ProjectBundle; results: ResearchGraphChangeResult[] }> {
  // Serialize the review+persist against any concurrent turn on the same
  // session. The follow-up continuation send runs OUTSIDE this lock because it
  // acquires the same session lock itself.
  const result = await withResearchSessionLock(input.projectRoot, input.sessionId, async () => {
    const store = await readChatsForMutation(input.projectRoot);
    const session = store.sessions.find((item) => item.id === input.sessionId);
    const message = session?.messages.find((item) => item.id === input.messageId);
    const changeSet = message?.changeSet;
    if (!session || !message || !changeSet || changeSet.id !== input.changeSetId) {
      throw new Error("Research change set was not found.");
    }
    const retryableFailedReview = input.retryReviewed && isRetryableFailedResearchReview(session, input.messageId, changeSet.operations.length);
    if (changeSet.reviewedAt && !retryableFailedReview) {
      throw new Error("Research change set was already reviewed.");
    }
    const reviewResult = await reviewResearchGraphChangeSet({
      projectRoot: input.projectRoot,
      session,
      messageId: input.messageId,
      changeSetId: input.changeSetId,
      decisions: input.decisions,
      resultPrefix: researchChangeSetReviewPrefix(changeSet, Boolean(input.retryReviewed)),
      allowReviewedRetry: retryableFailedReview
    });
    await persistResearchSession(input.projectRoot, reviewResult.session);
    return { reviewResult, message, changeSet, session };
  });
  const { reviewResult: reviewOutcome, message, changeSet, session } = result;
  const reviewReturn = { session: reviewOutcome.session, bundle: reviewOutcome.bundle, results: reviewOutcome.results };
  const hasUnblockedSubflowWork = shouldContinueAfterResearchReview(changeSet, reviewOutcome.results);
  const hasRejectedOperations = reviewOutcome.results.some((result) => result.status === "rejected");
  const hasUnfinishedGoal = researchGoalIsUnfinished(reviewOutcome.session);
  if (!hasUnblockedSubflowWork && !hasRejectedOperations && !hasUnfinishedGoal) {
    const reported = await appendAssistantReportMessage(
      input.projectRoot,
      session.id,
      researchChangeSetResultReport(changeSet, reviewOutcome.results, reviewOutcome.bundle)
    ).catch(() => reviewOutcome.session);
    return { ...reviewReturn, session: reported, bundle: await loadProject(input.projectRoot) };
  }
  try {
    const continued = await sendResearchChatMessage({
      projectRoot: input.projectRoot,
      sessionId: session.id,
      content: researchChangeSetContinuationPrompt(message, changeSet, reviewOutcome.results, hasUnblockedSubflowWork, hasUnfinishedGoal),
      providerId: session.providerId,
      internalContinuation: true
    });
    return { ...reviewReturn, session: continued, bundle: await loadProject(input.projectRoot) };
  } catch {
    const reported = await appendAssistantReportMessage(
      input.projectRoot,
      session.id,
      researchChangeSetResultReport(changeSet, reviewOutcome.results, reviewOutcome.bundle)
    ).catch(() => reviewOutcome.session);
    return { ...reviewReturn, session: reported, bundle: await loadProject(input.projectRoot) };
  }
}

function researchChangeSetReviewPrefix(changeSet: ResearchChangeSet, retry: boolean): string {
  const category = researchChangeSetCategory(changeSet.operations);
  if (category === "queue") return retry ? "Queue submission retry reviewed" : "Queue submission reviewed";
  if (category === "graph") return retry ? "Graph changes retry reviewed" : "Graph changes reviewed";
  return retry ? "Changes retry reviewed" : "Changes reviewed";
}

function researchChangeSetReportHeading(category: ResearchChangeSetCategory): string {
  if (category === "queue") return "Queue submission complete";
  if (category === "graph") return "Graph review complete";
  return "Change review complete";
}

function isRetryableFailedResearchReview(session: ResearchChatSession, messageId: string, operationCount: number): boolean {
  const messageIndex = session.messages.findIndex((message) => message.id === messageId);
  if (messageIndex < 0) return false;
  let latest: { applied: number; rejected: number; failed: number } | null = null;
  for (const message of session.messages.slice(messageIndex + 1)) {
    if (message.changeSet) break;
    if (message.role !== "system") continue;
    const match = message.content.trim().match(/^(?:Graph changes reviewed|Graph changes retry reviewed|Auto-approved graph changes|Queue submission reviewed|Queue submission retry reviewed|Changes reviewed|Changes retry reviewed):\s+(\d+)\s+(?:applied|queued),\s+(\d+)\s+rejected,\s+(\d+)\s+failed\./);
    if (match) latest = { applied: Number(match[1]), rejected: Number(match[2]), failed: Number(match[3]) };
  }
  return Boolean(latest && latest.applied === 0 && latest.rejected === 0 && latest.failed === operationCount);
}

function graphReviewNodeTitleMap(bundle: ProjectBundle, changeSet: ResearchChangeSet): Map<string, string> {
  const titles = new Map<string, string>();
  for (const flow of bundle.flows) {
    for (const node of flow.nodes) titles.set(node.id, node.title);
  }
  for (const operation of changeSet.operations) {
    if (operation.kind === "create-node" && operation.node.id) {
      titles.set(operation.node.id, operation.node.title);
    }
  }
  return titles;
}

function graphReviewNodeLabel(nodeId: string | undefined, titles: Map<string, string>): string {
  if (!nodeId) return "unscoped";
  return titles.get(nodeId) ?? nodeId;
}

function researchChangeSetResultReport(changeSet: ResearchChangeSet, results: ResearchGraphChangeResult[], bundle: ProjectBundle): string {
  const applied = results.filter((result) => result.status === "applied").length;
  const rejected = results.filter((result) => result.status === "rejected").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const nodeTitles = graphReviewNodeTitleMap(bundle, changeSet);
  const category = researchChangeSetCategory(changeSet.operations);
  const lines = [
    `${researchChangeSetReportHeading(category)} for "${changeSet.summary}".`,
    `${applied} ${category === "queue" ? "queued" : "applied"}, ${rejected} rejected, ${failed} failed.`
  ];

  for (const result of results) {
    const operation = changeSet.operations[result.operationIndex];
    const detail = operation ? researchChangeSetOperationDetail(operation, nodeTitles) : `operation ${result.operationIndex}`;
    const queued = category === "queue" && result.status === "applied";
    const statusLabel = queued ? "Queued" : capitalizeStatus(result.status);
    const presentedDetail = queued ? detail.replace(/^Queued\s+/, "") : detail;
    lines.push(`${statusLabel}: ${presentedDetail}${result.message ? ` (${result.message})` : ""}`);
    if (operation?.kind === "add-note" && operation.note.kind === "system-note" && !operation.note.pinned) {
      lines.push("Note: this was added as an unpinned system note, so the default Relevant notes filter may hide it. Use All notes or pin it if you want it to stay visible there.");
    }
  }

  return lines.join("\n\n");
}

function capitalizeStatus(status: ResearchGraphChangeResult["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function researchChangeSetOperationDetail(operation: ResearchChangeSet["operations"][number], nodeTitles: Map<string, string>): string {
  if (operation.kind === "add-note") {
    const pinned = operation.note.pinned ? "pinned" : "unpinned";
    const kind = operation.note.kind.replace("-", " ");
    const body = operation.note.body.trim();
    return `Added ${pinned} ${kind} on ${graphReviewNodeLabel(operation.note.nodeId, nodeTitles)}${body ? `: "${body.slice(0, 180)}${body.length > 180 ? "..." : ""}"` : ""}.`;
  }
  if (operation.kind === "update-node") return `Updated node ${graphReviewNodeLabel(operation.patch.id, nodeTitles)}.`;
  if (operation.kind === "update-project") return "Updated project metadata.";
  if (operation.kind === "create-flow") return `Created flow ${operation.flow.name}.`;
  if (operation.kind === "update-flow") return `Updated flow ${operation.flowId}.`;
  if (operation.kind === "update-edge") return `Updated edge ${operation.edgeId}.`;
  if (operation.kind === "resolve-note") return `${operation.resolved ? "Resolved" : "Reopened"} note ${operation.noteId}.`;
  if (operation.kind === "delete-note") return `Deleted note ${operation.noteId}.`;
  if (operation.kind === "create-node") {
    return operation.node.subflowId
      ? `Created node ${operation.node.title} in subflow ${operation.node.subflowId}.`
      : `Created node ${operation.node.title} on the root flow.`;
  }
  if (operation.kind === "create-edge") {
    return `Created edge ${graphReviewNodeLabel(operation.edge.source, nodeTitles)} -> ${graphReviewNodeLabel(operation.edge.target, nodeTitles)}.`;
  }
  if (operation.kind === "create-subflow") return `Created detail flow ${operation.subflow.id}.`;
  if (operation.kind === "create-group") return `Created group ${operation.group.name}.`;
  if (operation.kind === "update-group") return `Updated group ${operation.groupId}.`;
  if (operation.kind === "update-subflow") return `Updated detail flow ${operation.subflowId}.`;
  if (operation.kind === "link-node-subflow") return `${operation.subflowId ? "Linked" : "Cleared"} detail flow for ${graphReviewNodeLabel(operation.nodeId, nodeTitles)}.`;
  if (operation.kind === "propose-run-profile") return `${operation.mode === "replace" ? "Replaced" : "Created"} run target ${operation.profile.label}.`;
  if (operation.kind === "start-agent-run") {
    return operation.nodeId
      ? `Queued AI Implement for ${graphReviewNodeLabel(operation.nodeId, nodeTitles)}. Agent: ${gaiaAgent.title}.`
      : `Queued AI Implement for ${operation.flowId}. Agent: ${gaiaAgent.title}.`;
  }
  if (operation.kind === "start-run-profile") return `Queued run target ${operation.profileId}.`;
  if (operation.kind === "stop-runtime-service") return `Stopped runtime service ${operation.serviceId}.`;
  if (operation.kind === "restart-runtime-service") return `Restarted runtime service ${operation.serviceId}.`;
  if (operation.kind === "retry-run") return `Queued retry for ${operation.runId}.`;
  if (operation.kind === "start-debugging-run") return `Queued AI Debug for ${operation.runId}. Agent: ${pandoraAgent.title}.`;
  if (operation.kind === "author-acceptance-tests") {
    return operation.nodeId
      ? `Queued acceptance-test regeneration for ${graphReviewNodeLabel(operation.nodeId, nodeTitles)}.`
      : `Queued acceptance-test regeneration for flow ${operation.flowId}.`;
  }
  if (operation.kind === "run-acceptance-checks") return `Queued acceptance checks for ${graphReviewNodeLabel(operation.nodeId, nodeTitles)}.`;
  if (operation.kind === "start-runtime-debug-run") return `Queued runtime debug for ${operation.serviceId}.`;
  if (operation.kind === "start-incident-debug-run") return operation.flowId ? `Queued incident debug for ${operation.flowId}.` : "Queued incident debug.";
  if (operation.kind === "delete-node") return `Deleted node ${graphReviewNodeLabel(operation.nodeId, nodeTitles)}.`;
  if (operation.kind === "delete-edge") return `Deleted edge ${operation.edgeId}.`;
  if (operation.kind === "delete-subflow") return `Deleted detail flow ${operation.subflowId}.`;
  if (operation.kind === "delete-group") return `Deleted group ${operation.groupId}.`;
  return "Applied graph operation.";
}

function shouldContinueAfterResearchReview(changeSet: ResearchChangeSet, results: ResearchGraphChangeResult[]): boolean {
  const appliedOperationIndexes = new Set(results
    .filter((result) => result.status === "applied")
    .map((result) => result.operationIndex));
  return changeSet.operations.some((operation, index) =>
    appliedOperationIndexes.has(index) &&
    (operation.kind === "create-subflow" || operation.kind === "update-subflow" || operation.kind === "link-node-subflow")
  );
}

function researchChangeSetContinuationPrompt(
  message: ResearchChatMessage,
  changeSet: ResearchChangeSet,
  results: ResearchGraphChangeResult[],
  hasUnblockedSubflowWork: boolean,
  hasUnfinishedGoal: boolean
): string {
  const category = researchChangeSetCategory(changeSet.operations);
  const reviewLabel = category === "queue"
    ? "Queue submission review"
    : category === "graph"
      ? "Graph review"
      : "Change review";
  const resultSummary = results
    .map((result) => `operation ${result.operationIndex}: ${result.status}${result.message ? ` (${result.message})` : ""}`)
    .join("; ");
  const operationSummary = changeSet.operations
    .map((operation, index) => `${index}: ${operation.kind}`)
    .join(", ");
  const failedCount = results.filter((result) => result.status === "failed").length;
  const rejectedCount = results.filter((result) => result.status === "rejected").length;
  const appliedCount = results.filter((result) => result.status === "applied").length;
  const outcomeInstruction = category === "queue"
    ? failedCount > 0
      ? "Some queue actions failed. Explain plainly what could not be queued and why, then propose a concrete retry or correction. Do not call this a graph review or claim the run was queued successfully."
      : rejectedCount > 0 && appliedCount === 0
        ? "The user rejected all proposed queue actions. Briefly acknowledge that nothing was queued, ask what they want changed about the submission, and do not call this a graph review."
        : rejectedCount > 0
          ? "Some queue actions were submitted and some were rejected. Briefly distinguish what was queued from what was not, then ask what they want changed. Do not call this a graph review."
          : null
    : failedCount > 0
      ? `Some operations failed to apply (see their result messages above). Explain plainly what failed and why, and propose a concrete fix or retry before offering next steps. Do not suggest queueing ${gaiaAgent.name} through AI Implement while the graph does not yet reflect the intended change, and do not claim the change is fully in place.`
      : rejectedCount > 0 && appliedCount === 0
        ? "The user rejected all proposed operations. Briefly acknowledge that, ask why the proposal did not look right, and ask what they'd like to change about it instead of offering to implement or continue with work that was not applied."
        : rejectedCount > 0
          ? "Some operations were applied and some were rejected. Briefly note which parts landed and which did not, ask why the rejected parts were not right, and check what they'd like to change next."
          : null;
  const nextStepInstruction = hasUnfinishedGoal
    ? "A persisted durable goal is still unfinished. Treat this review result as a checkpoint, reactivate or adapt the relevant step, and continue the next safe unblocked work now. If the accepted action queued a build/run, inspect the resulting exact run id and checkpoint waiting for that named run instead of declaring the goal complete. If the user rejected or an operation failed, adapt the plan or record a concrete blocker; never resubmit the identical rejected action."
    : category === "queue"
    ? "The requested queue submission is complete. Do not return another changeSet unless the user asks for another action. Briefly confirm what was queued and stop."
    : hasUnblockedSubflowWork
      ? "Continue any remaining orchestration work that was already approved or clearly unblocked by this review. If the approved direction needs another graph review card, briefly explain the next step and return the next archicodeResearch changeSet."
      : `There is no further orchestration work already unblocked by this review, so do not return another changeSet unless the user asks for one. Instead, briefly and concisely ask the user what they'd like to do next: keep editing the graph further, queue this work with ${gaiaAgent.name} through AI Implement now that the graph reflects it, or just keep discussing/refining the decision.`;
  return [
    `${reviewLabel} was just completed for your previous proposed change set.`,
    `Reviewed changeSet: ${changeSet.summary}.`,
    `Operations: ${operationSummary}.`,
    `Results: ${resultSummary}.`,
    `Previous assistant message: ${message.content}`,
    "Check the per-operation results above before deciding what to say: distinguish applied, rejected, and failed operations rather than assuming the whole change set succeeded.",
    ...(outcomeInstruction ? [outcomeInstruction] : [nextStepInstruction]),
    "Do not ask the user to approve the same already-applied work again."
  ].join("\n");
}

type GraphStalenessSignal = {
  shouldAsk: boolean;
  reason: string;
  nodeIds: string[];
};

function pathNeedles(filePath: string): string[] {
  const normalized = filePath.split(path.sep).join("/");
  const base = path.basename(normalized);
  const withoutExt = base.replace(/\.[^.]+$/, "");
  return Array.from(new Set([normalized, base, withoutExt].filter((item) => item.length >= 3)));
}

function nodeGraphSearchText(node: ArchicodeNode): string {
  return JSON.stringify({
    id: node.id,
    title: node.title,
    description: node.description,
    acceptanceCriteria: node.acceptanceCriteria,
    customProperties: node.customProperties,
    techStack: node.techStack,
    ruleIds: node.ruleIds
  }).toLowerCase();
}

function detectGraphStalenessSignal(bundle: ProjectBundle, resolvedFiles: string[]): GraphStalenessSignal {
  const matches: Array<{ nodeId: string; nodeTitle: string; filePath: string }> = [];
  for (const flow of bundle.flows) {
    for (const node of flow.nodes) {
      const text = nodeGraphSearchText(node);
      for (const filePath of resolvedFiles) {
        if (pathNeedles(filePath).some((needle) => text.includes(needle.toLowerCase()))) {
          matches.push({ nodeId: node.id, nodeTitle: node.title, filePath });
          break;
        }
      }
    }
  }

  if (!matches.length) {
    return {
      shouldAsk: false,
      nodeIds: [],
      reason: "No graph nodes mention the resolved files, so ArchiCode did not detect a likely stale graph relationship."
    };
  }

  const fileList = Array.from(new Set(matches.map((match) => match.filePath))).join(", ");
  const nodeList = matches.slice(0, 4).map((match) => `${match.nodeTitle || match.nodeId} (${match.nodeId})`).join(", ");
  const more = matches.length > 4 ? ` and ${matches.length - 4} more` : "";
  return {
    shouldAsk: true,
    nodeIds: Array.from(new Set(matches.map((match) => match.nodeId))),
    reason: `The resolved file${resolvedFiles.length === 1 ? "" : "s"} ${fileList} appear in graph node context for ${nodeList}${more}. The merge may have changed behavior those nodes describe, so the graph could now be stale.`
  };
}

async function appendAssistantReportMessage(
  projectRoot: string,
  sessionId: string,
  content: string
): Promise<ResearchChatSession> {
  return withResearchSessionLock(projectRoot, sessionId, async () => {
    const store = await readChatsForMutation(projectRoot);
    const session = store.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("Research chat session was not found.");
    const message: ResearchChatMessage = {
      id: id("msg"),
      role: "assistant",
      content,
      createdAt: iso(),
      attachmentIds: [],
      webUsed: false,
      mcpToolCalls: [],
      subagentRuns: []
    };
    const updatedSession = researchChatSessionSchema.parse({
      ...session,
      messages: [...session.messages, message],
      updatedAt: iso()
    });
    await persistResearchSession(projectRoot, updatedSession);
    return updatedSession;
  });
}

async function recordObservedSubagentOutcome(
  projectRoot: string,
  sessionId: string,
  outcome: {
    kind: SubagentRun["kind"];
    runId: string;
    status: "completed" | "failed" | "blocked";
    summary: string;
  }
): Promise<ResearchChatSession> {
  return withResearchSessionLock(projectRoot, sessionId, async () => {
    const store = await readChatsForMutation(projectRoot);
    const session = store.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("Research chat session was not found.");
    const updatedAt = iso();
    const evidence = `${outcome.kind} subagent ${outcome.runId} finished with status ${outcome.status}.`;
    const goal = session.orchestration.goal;
    let orchestration = session.orchestration;
    if (goal && goal.status !== "completed" && goal.status !== "cancelled" && !goal.completionEvidence.includes(evidence)) {
      const currentStep = goal.steps.find((step) => step.id === goal.currentStepId);
      const nextOpenStep = outcome.status === "completed"
        ? goal.steps.find((step) => step.id !== currentStep?.id && step.status === "open")
        : undefined;
      const blocked = outcome.status === "failed" || outcome.status === "blocked";
      orchestration = checkpointResearchGoal(orchestration, {
        status: blocked ? "blocked" : "continue",
        summary: outcome.summary,
        currentStepId: nextOpenStep?.id ?? currentStep?.id ?? null,
        stepUpdates: [
          ...(currentStep ? [{
            id: currentStep.id,
            status: blocked ? "blocked" as const : "done" as const,
            notes: outcome.summary,
            evidence: [evidence]
          }] : []),
          ...(nextOpenStep ? [{ id: nextOpenStep.id, status: "doing" as const, evidence: [] }] : [])
        ],
        evidence: [evidence],
        blockers: blocked ? [outcome.summary] : [],
        waitingFor: []
      }, updatedAt);
    }

    const sourceMessage = session.messages.find((message) => message.subagentRuns.some((run) => run.id === outcome.runId));
    const existingRunRef = session.memory.runRefs.find((runRef) => runRef.runId === outcome.runId);
    const runRef = {
      ...(existingRunRef ?? { id: id("research-run-ref"), createdAt: updatedAt }),
      runId: outcome.runId,
      title: outcome.kind,
      status: outcome.status,
      note: outcome.summary,
      sourceMessageIds: [...new Set([...(existingRunRef?.sourceMessageIds ?? []), ...(sourceMessage ? [sourceMessage.id] : [])])],
      updatedAt
    };
    const memory = researchMemorySchema.parse({
      ...session.memory,
      runRefs: existingRunRef
        ? session.memory.runRefs.map((entry) => entry.id === existingRunRef.id ? runRef : entry)
        : [...session.memory.runRefs, runRef],
      lastUpdateError: undefined,
      updatedAt
    });
    const updatedSession = researchChatSessionSchema.parse({
      ...session,
      memory,
      orchestration,
      updatedAt
    });
    await persistResearchSession(projectRoot, updatedSession);
    return updatedSession;
  });
}

async function recordObservedApprovalPause(projectRoot: string, sessionId: string): Promise<ResearchChatSession> {
  return withResearchSessionLock(projectRoot, sessionId, async () => {
    const store = await readChatsForMutation(projectRoot);
    const session = store.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("Research chat session was not found.");
    const pendingRun = [...session.messages].reverse().flatMap((message) => [...message.subagentRuns].reverse())
      .find((run) => run.status === "awaiting-approval");
    const pendingChangeSet = [...session.messages].reverse().find((message) => message.changeSet && !message.changeSet.reviewedAt)?.changeSet;
    const approval = pendingRun
      ? { id: pendingRun.id, label: pendingRun.title }
      : pendingChangeSet
        ? { id: pendingChangeSet.id, label: pendingChangeSet.summary }
        : undefined;
    if (!approval) return session;
    const updatedSession = researchChatSessionSchema.parse({
      ...session,
      orchestration: researchGoalAwaitingApproval(session.orchestration, approval),
      updatedAt: iso()
    });
    await persistResearchSession(projectRoot, updatedSession);
    return updatedSession;
  });
}

function researchSessionHasPendingReview(session: ResearchChatSession): boolean {
  const lastMessage = session.messages.at(-1);
  return session.messages.some((message) =>
    message.subagentRuns.some((run) => run.status === "awaiting-approval") ||
    Boolean(message.changeSet && !message.changeSet.reviewedAt)) ||
    Boolean(lastMessage?.mcpApprovalRequest);
}

async function continueResearchGoalAfterOutcome(
  projectRoot: string,
  session: ResearchChatSession,
  outcomePrompt: string,
  fallbackReport: string,
  options: {
    pauseForNewApproval?: boolean;
    outcomeEvidenceProvided?: boolean;
    outcomeKind?: SubagentRun["kind"];
    outcomeRunId?: string;
    outcomeStatus?: "completed" | "failed" | "blocked";
    onActivity?: SendResearchChatMessageInput["onActivity"];
    onSubagentProgress?: SendResearchChatMessageInput["onSubagentProgress"];
  } = {}
): Promise<ResearchChatSession> {
  let observedSession = session;
  if (options.outcomeKind && options.outcomeRunId && options.outcomeStatus) {
    observedSession = await recordObservedSubagentOutcome(projectRoot, session.id, {
      kind: options.outcomeKind,
      runId: options.outcomeRunId,
      status: options.outcomeStatus,
      summary: fallbackReport.slice(0, 1_000)
    }).catch(() => observedSession);
  }
  if (options.pauseForNewApproval) {
    observedSession = await recordObservedApprovalPause(projectRoot, session.id).catch(() => observedSession);
  }
  if (!researchGoalIsUnfinished(observedSession) || options.pauseForNewApproval) {
    const reported = await appendAssistantReportMessage(projectRoot, observedSession.id, fallbackReport).catch(() => observedSession);
    const reconciled = await reconcileResearchOutcomeReportState(projectRoot, reported, options).catch(() => reported);
    options.onActivity?.("The final report is ready in chat.", "completed");
    return reconciled;
  }
  try {
    options.onActivity?.(
      options.outcomeKind === "delphi-testing"
        ? "Delphi finished. Archi is reviewing the evidence and preparing the final report."
        : "The subagent finished. Archi is reviewing the outcome and preparing the next response.",
      "running"
    );
    const reported = await sendResearchChatMessage({
      projectRoot,
      sessionId: observedSession.id,
      providerId: observedSession.providerId,
      internalContinuation: true,
      outcomeEvidenceProvided: options.outcomeEvidenceProvided,
      onActivity: options.onActivity,
      onSubagentProgress: options.onSubagentProgress,
      content: [
        "HOST DURABLE-GOAL EXTERNAL-OUTCOME RESUME.",
        outcomePrompt,
        options.outcomeEvidenceProvided
          ? "The host outcome above is the complete evidence packet for this event. Use it directly. Do not list or read chat artifacts merely to restate it, and do not expose internal artifact paths to the user."
          : "",
        "The host has already recorded this outcome against the persisted goal. Continue the next useful unblocked step now and finish with a self-contained user-facing result. Do not repeat a rejected action unchanged."
      ].join("\n\n")
    });
    if (researchSessionHasPendingReview(reported)) {
      options.onActivity?.("Archi prepared the next review card and is waiting for your decision.", "completed");
      return reported;
    }
    const reconciled = await reconcileResearchOutcomeReportState(projectRoot, reported, options);
    options.onActivity?.("The final report is ready in chat.", "completed");
    return reconciled;
  } catch {
    const reported = await appendAssistantReportMessage(projectRoot, observedSession.id, fallbackReport).catch(() => observedSession);
    const reconciled = await reconcileResearchOutcomeReportState(projectRoot, reported, options).catch(() => reported);
    options.onActivity?.("The final report is ready in chat.", "completed");
    return reconciled;
  }
}

function isPrematureReportDeliveryEvidence(value: string): boolean {
  return /(?:user-facing|final) report (?:was |has been )?(?:delivered|shared|reported)|(?:delivered|shared) (?:the )?(?:final )?report (?:to|with) the user/i.test(value);
}

function omitChatArtifactReadToolsFromContext(context: string): string {
  try {
    const parsed = JSON.parse(context) as { projectFiles?: { tools?: Array<{ name?: string }> } };
    if (!parsed.projectFiles?.tools) return context;
    parsed.projectFiles.tools = parsed.projectFiles.tools.filter((tool) =>
      tool.name !== "archicode_chat_list_artifacts" && tool.name !== "archicode_chat_read_artifact");
    return JSON.stringify(parsed, null, 2);
  } catch {
    return context;
  }
}

export function requestsRedundantOutcomeArtifactRead(providerToolName: string, args: Record<string, unknown>): boolean {
  if (providerToolName === "archicode_project_read_artifact") return true;
  const requestedPath = providerToolName === "archicode_project_list_files" || providerToolName === "archicode_project_search_files"
    ? args.directory
    : providerToolName === "archicode_project_read_file"
      ? args.path
      : undefined;
  return typeof requestedPath === "string" && /(?:^|\/)\.archicode\/artifacts(?:\/|$)/i.test(requestedPath.trim().replaceAll("\\", "/"));
}

function removeStaleDelphiSummaryLines(summary: string): string {
  return summary
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((part) => !(/delphi/i.test(part) && /(?:awaiting|pending|not (?:yet )?run|blocked)/i.test(part)))
    .join(" ")
    .trim();
}

export async function reconcileResearchOutcomeReportState(
  projectRoot: string,
  reportedSession: ResearchChatSession,
  options: {
    outcomeKind?: SubagentRun["kind"];
    outcomeRunId?: string;
    outcomeStatus?: "completed" | "failed" | "blocked";
  }
): Promise<ResearchChatSession> {
  return withResearchSessionLock(projectRoot, reportedSession.id, async () => {
    const store = await readChatsForMutation(projectRoot);
    const latest = store.sessions.find((item) => item.id === reportedSession.id) ?? reportedSession;
    if (researchSessionHasPendingReview(latest)) return latest;
    const reportMessage = [...latest.messages].reverse().find((message) => message.role === "assistant");
    if (!reportMessage) return latest;
    const updatedAt = iso();
    const persistedEvidence = `Final evidence-backed report persisted in chat message ${reportMessage.id}.`;
    const goal = latest.orchestration.goal;
    const isDelphi = options.outcomeKind === "delphi-testing";
    const delphiBlocked = options.outcomeStatus === "failed" || options.outcomeStatus === "blocked";
    const hostFinalizedGoal = isDelphi && goal && goal.status !== "completed" && goal.status !== "cancelled"
      ? checkpointResearchGoal(latest.orchestration, {
          status: delphiBlocked ? "blocked" : "completed",
          summary: delphiBlocked
            ? `Delphi finished with unresolved coverage or an execution blocker. ${persistedEvidence}`
            : `Delphi audit and final report completed. ${persistedEvidence}`,
          currentStepId: delphiBlocked ? goal.currentStepId ?? null : null,
          stepUpdates: goal.steps.map((step) => ({
            id: step.id,
            status: delphiBlocked && step.id !== "report-findings" ? "blocked" as const : "done" as const,
            evidence: [persistedEvidence]
          })),
          evidence: [persistedEvidence],
          blockers: delphiBlocked ? ["Delphi left requested coverage unresolved; see the persisted final report."] : [],
          waitingFor: []
        }, updatedAt).goal
      : goal;
    const reconciledGoal = hostFinalizedGoal?.status === "completed"
      ? {
          ...hostFinalizedGoal,
          checkpointSummary: `Goal completed. ${persistedEvidence}`,
          completionEvidence: [...new Set([
            ...hostFinalizedGoal.completionEvidence.filter((entry) => !isPrematureReportDeliveryEvidence(entry)),
            persistedEvidence
          ])],
          steps: hostFinalizedGoal.steps.map((step) => ({
            ...step,
            evidence: step.evidence.filter((entry) => !isPrematureReportDeliveryEvidence(entry))
          })),
          updatedAt
        }
      : hostFinalizedGoal;
    const delphiMemoryMatch = (value: string | undefined): boolean => /delphi|test(?:ing)?\s*(?:\/|and)?\s*runtime audit/i.test(value ?? "");
    const delphiOutcomeStatus = options.outcomeStatus ?? "completed";
    const delphiSummaryLine = `Delphi audit finished with status ${delphiOutcomeStatus}; its final evidence-backed report is persisted in this chat.`;
    const retainedDelphiSummary = removeStaleDelphiSummaryLines(latest.memory.summary);
    const memory = isDelphi
      ? researchMemorySchema.parse({
          ...latest.memory,
          summary: retainedDelphiSummary.includes(delphiSummaryLine)
            ? retainedDelphiSummary
            : [retainedDelphiSummary, delphiSummaryLine].filter(Boolean).join("\n"),
          todos: latest.memory.todos.map((todo) => delphiMemoryMatch(`${todo.title} ${todo.notes ?? ""}`) && todo.status !== "cancelled"
            ? { ...todo, status: delphiBlocked ? "blocked" : "done", notes: delphiBlocked ? "Delphi audit finished with unresolved coverage; final report persisted in chat." : "Delphi audit completed; final report persisted in chat.", updatedAt }
            : todo),
          runRefs: latest.memory.runRefs.map((runRef) => (
            runRef.runId === options.outcomeRunId || runRef.runId === "delphi-testing" || delphiMemoryMatch(`${runRef.title ?? ""} ${runRef.note ?? ""}`)
          ) ? { ...runRef, status: delphiOutcomeStatus, note: "Audit finished; final report persisted in chat.", updatedAt } : runRef),
          lastUpdateError: undefined,
          updatedAt
        })
      : latest.memory;
    const updatedSession = researchChatSessionSchema.parse({
      ...latest,
      memory,
      orchestration: {
        ...latest.orchestration,
        goal: reconciledGoal,
        updatedAt: reconciledGoal === goal ? latest.orchestration.updatedAt : updatedAt
      },
      updatedAt
    });
    await persistResearchSession(projectRoot, updatedSession);
    return updatedSession;
  });
}

function mergeApprovalReport(
  mergeResult: MicroRunResult,
  commitOutcome: { committed: boolean; message?: string; reason?: string },
  reconciliationRun: SubagentRun | undefined,
  stalenessSignal: GraphStalenessSignal | undefined,
  graphReconciliationEnabled: boolean
): string {
  const mergeOutput = mergeResult.output as MergeResolutionOutput | undefined;
  if (mergeResult.status === "failed") {
    return `Merge resolution failed: ${mergeResult.error ?? "unknown error"}. I left the repo as-is for review.`;
  }

  const lines = [
    `Merge resolution finished for ${(mergeOutput?.resolvedFiles?.length ? mergeOutput.resolvedFiles : ["the conflicted files"]).join(", ")}.`,
    mergeOutput?.summary ? `Summary: ${mergeOutput.summary}` : undefined,
    `Verification: ${mergeOutput?.verificationPassed ? "passed" : "did not pass or was inconclusive"}.`,
    commitOutcome.committed
      ? "Git: committed the resolved merge."
      : `Git: not committed. ${commitOutcome.reason ?? "Review the staged resolution before committing."}`
  ].filter(Boolean) as string[];

  if (mergeResult.status === "needs-clarification" && mergeResult.clarificationQuestion) {
    lines.push(`Open question: ${mergeResult.clarificationQuestion}`);
  }

  if (!graphReconciliationEnabled) {
    lines.push("Picasso is disabled in project settings, so I did not check for graph drift.");
  } else if (reconciliationRun && stalenessSignal?.shouldAsk) {
    lines.push(`Possible graph drift detected: ${stalenessSignal.reason}`);
    lines.push("I added a Picasso — Graph Architect card for your approval instead of running it automatically.");
  } else {
    lines.push(stalenessSignal?.reason ?? "I did not detect a likely stale graph relationship, so I did not ask to run graph reconciliation.");
  }

  return lines.join("\n\n");
}

function graphReconciliationReport(
  result: MicroRunResult,
  changeSet: ResearchChangeSet | undefined
): string {
  if (result.status === "failed") {
    return `Graph reconciliation failed: ${result.error ?? "unknown error"}.`;
  }
  const output = result.output as GraphReconciliationOutput | undefined;
  const lines = [
    "Graph reconciliation finished.",
    output?.reconciliationReport,
    changeSet
      ? `It proposed ${changeSet.operations.length} graph update${changeSet.operations.length === 1 ? "" : "s"} for review: ${changeSet.summary}`
      : "It did not find discrepancies that need a graph change-set card."
  ].filter(Boolean) as string[];
  if (result.status === "needs-clarification" && result.clarificationQuestion) {
    lines.push(`Open question: ${result.clarificationQuestion}`);
  }
  return lines.join("\n\n");
}

export function delphiAuditReport(result: MicroRunResult, reportSaved = false, setupPrepared = false): string {
  const output = result.output as DelphiTestingOutput | undefined;
  const visuallyAnalyzedCount = result.diagnostics?.visuallyAnalyzedArtifactIds?.length ?? 0;
  const timedOut = result.failureKind === "timeout";
  if (result.status === "failed" && !output) {
    return timedOut
      ? `Delphi's audit timed out before it could return a final report: ${result.error ?? "the provider stopped responding"}.`
      : `Delphi's audit failed to complete: ${result.error ?? "unknown error"}.`;
  }
  const lines = [
    result.status === "failed"
      ? timedOut
        ? `Delphi timed out before returning its final report. Host-observed partial evidence was preserved: ${result.error ?? "the provider stopped responding"}.`
        : `One or more Delphi target audits failed to complete: ${result.error ?? "unknown error"}.`
      : "",
    `${result.status === "failed" ? "Partial audit verdict" : "Delphi finished with verdict"}: ${output?.verdict ?? "unknown"}.`,
    output?.summary,
    output?.checks.length ? `${output.checks.length} check${output.checks.length === 1 ? " was" : "s were"} recorded.` : "No executable checks were recorded.",
    output?.findings.length ? `${output.findings.length} finding${output.findings.length === 1 ? "" : "s"} require attention.` : "No structured defects were reported.",
    output?.artifacts.length
      ? visuallyAnalyzedCount > 0
        ? `The selected vision-capable model inspected pixels from ${visuallyAnalyzedCount} captured screenshot${visuallyAnalyzedCount === 1 ? "" : "s"}.`
        : "Screenshots were captured for the user's review; the selected model did not inspect their pixels."
      : "",
    output?.status === "needs-setup" ? "Required test tooling is not installed. Delphi returned an approval-required setup plan; nothing was installed automatically." : ""
  ].filter(Boolean) as string[];
  for (const [index, finding] of (output?.findings ?? []).slice(0, 8).entries()) {
    const reproduction = finding.reproductionSteps.length
      ? ` Reproduce: ${finding.reproductionSteps.slice(0, 3).join("; ")}`
      : "";
    const evidence = finding.evidence.length
      ? ` Evidence: ${finding.evidence.slice(0, 3).join("; ")}`
      : "";
    lines.push(`Finding ${index + 1} [${finding.severity}/${finding.category}] ${finding.title}: ${finding.detail}${reproduction}${evidence}`.slice(0, 4_000));
  }
  for (const toolchain of output?.toolchains ?? []) {
    if (toolchain.status !== "missing" || !toolchain.installPlan) continue;
    const packages = toolchain.installPlan.packages.length ? ` Packages/components: ${toolchain.installPlan.packages.join(", ")}.` : "";
    const actions = toolchain.installPlan.actions.length ? ` ${toolchain.installPlan.actions.join(" ")}` : "";
    lines.push(`Setup needed for ${toolchain.adapter} (${toolchain.installPlan.scope}; separate approval required).${packages}${actions}`);
  }
  if (output?.blockers.length) lines.push(`Blockers: ${output.blockers.join("; ")}`);
  if (output?.recommendedNextSteps.length) lines.push(`Next: ${output.recommendedNextSteps.join("; ")}`);
  if (reportSaved) lines.push("A detailed structured report was saved in this chat's artifacts.");
  if (setupPrepared) lines.push("A separate Delphi setup card is ready for approval. Approving it installs only the listed adapter components in ArchiCode's managed cache, then resumes this audit.");
  return lines.join("\n\n");
}

function delphiManagedSetupInput(
  args: DelphiTestingInput,
  environment: Pick<Awaited<ReturnType<typeof inspectDelphiTestEnvironment>>, "toolchains">,
  output?: DelphiTestingOutput
): DelphiTestingInput | undefined {
  if (args.mode === "plan" || args.mode === "setup") return undefined;
  const adapters = [...environment.toolchains, ...(output?.toolchains ?? [])].flatMap((toolchain) =>
    toolchain.status === "missing" && (toolchain.adapter === "playwright" || toolchain.adapter === "appium") && toolchain.installPlan?.scope === "managed-cache"
      ? [toolchain.adapter]
      : []
  );
  if (!adapters.length) return undefined;
  return delphiTestingInputSchema.parse({
    ...args,
    mode: "setup",
    setup: {
      adapters: Array.from(new Set(adapters)),
      playwrightBrowsers: ["chromium"],
      appiumDrivers: [
        ...(args.platforms.includes("android") ? ["uiautomator2" as const] : []),
        ...(args.platforms.includes("ios") ? ["xcuitest" as const] : [])
      ],
      resumeMode: args.mode === "retest" ? "retest" : "audit"
    }
  });
}

function locateSubagentRun(
  session: ResearchChatSession,
  messageId: string,
  runId: string
): { messageIndex: number; message: ResearchChatMessage | undefined; runIndex: number } {
  const messageIndex = session.messages.findIndex((message) => message.id === messageId);
  const message = messageIndex >= 0 ? session.messages[messageIndex] : undefined;
  const runIndex = message?.subagentRuns.findIndex((run) => run.id === runId) ?? -1;
  return { messageIndex, message, runIndex };
}

function subagentApprovalContinuationPrompt(
  mergeResult: MicroRunResult,
  commitOutcome: { committed: boolean; message?: string; reason?: string },
  reconciliationRun: SubagentRun | undefined,
  reconciliationOutput: GraphReconciliationOutput | undefined
): string {
  const mergeOutput = mergeResult.output as MergeResolutionOutput | undefined;
  const lines = [
    "The user approved the merge-conflict resolution proposal, and it has now actually run. This is a factual report of what happened, not something for you to re-propose or re-run.",
    mergeResult.status === "failed"
      ? `Merge resolution FAILED: ${mergeResult.error ?? "unknown error"}. Explain what went wrong and suggest next steps; do not claim conflicts were resolved.`
      : `Merge resolution completed. Summary: ${mergeOutput?.summary ?? "no summary"}. Verification passed: ${String(mergeOutput?.verificationPassed ?? "unknown")}.`,
    mergeResult.status === "failed"
      ? ""
      : commitOutcome.committed
        ? "The resolution was committed to git as the final step of this merge — tell the user the merge is fully finished, no manual commit needed."
        : `The resolution was NOT committed (${commitOutcome.reason ?? "reason unknown"}) — tell the user the files are staged but the merge is not finished, and they'll need to review and commit it themselves.`,
    mergeResult.status === "needs-clarification" && mergeResult.clarificationQuestion
      ? `The subagent had to proceed without answering this open question, so surface it to the user verbatim and explain the assumption it made: ${mergeResult.clarificationQuestion}`
      : ""
  ];
  if (reconciliationRun) {
    lines.push(
      reconciliationRun.status === "failed"
        ? `Graph reconciliation FAILED: ${reconciliationRun.error ?? "unknown error"}.`
        : reconciliationOutput?.graphChangeSet
          ? `Graph reconciliation completed and proposed graph updates, already prepared as a change-set review card for the user below (do not re-propose it yourself via archicode_propose_graph_change_set) — summary: ${reconciliationOutput.graphChangeSet.summary}.`
          : `Graph reconciliation completed with no discrepancies found: ${reconciliationOutput?.reconciliationReport ?? "the graph is already in sync."}`
    );
  } else {
    lines.push("Graph reconciliation did not run (disabled by project settings, or skipped because merge resolution failed).");
  }
  lines.push("Report this outcome plainly to the user in your own voice.");
  return lines.filter(Boolean).join("\n");
}

/**
 * Approves or rejects a merge-resolution subagent run that is awaiting user
 * confirmation. On approval, actually executes the merge-resolution microrun
 * (which was deliberately NOT run inline when the model called the tool,
 * since it writes real repo files), then auto-chains graph reconciliation on
 * success, then posts a synthetic internalContinuation turn so the assistant
 * narrates the outcome in its own voice — mirroring applyResearchGraphChangeSet.
 */
type RespondToSubagentRunInput = {
  projectRoot: string;
  sessionId: string;
  messageId: string;
  runId: string;
  decision: "approved" | "rejected";
  resolutionStrategy?: string;
  runtimeTargetProfileIds?: string[];
  onProgress?: (payload: {
    runId: string;
    kind: SubagentRun["kind"];
    title: string;
    message: string;
    status?: "running" | "completed" | "blocked" | "failed";
    artifact?: { id: string; label: string; path: string; mediaType: string };
    observationAnalysis?: { artifactId: string; status: "started" | "completed" | "failed" };
  }) => void;
  onActivity?: SendResearchChatMessageInput["onActivity"];
};

/** Persists an honest failed state when an approval flow threw after marking its run running. */
async function persistInterruptedSubagentRun(input: RespondToSubagentRunInput, error: unknown): Promise<void> {
  await withResearchSessionLock(input.projectRoot, input.sessionId, async () => {
    const store = await readChatsForMutation(input.projectRoot);
    const session = store.sessions.find((item) => item.id === input.sessionId);
    if (!session) return;
    const { messageIndex, message, runIndex } = locateSubagentRun(session, input.messageId, input.runId);
    if (!message || runIndex < 0 || message.subagentRuns[runIndex]!.status !== "running") return;
    const failedRun = transitionSubagentRun(message.subagentRuns[runIndex]!, "failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    const updatedSession = researchChatSessionSchema.parse({
      ...session,
      messages: session.messages.map((entry, index) => index === messageIndex
        ? { ...message, subagentRuns: message.subagentRuns.map((run, index2) => index2 === runIndex ? failedRun : run) }
        : entry),
      updatedAt: iso()
    });
    await persistResearchSession(input.projectRoot, updatedSession);
  });
}

export async function respondToSubagentRun(input: RespondToSubagentRunInput): Promise<ResearchChatSession> {
  // The live registry lets stale-"running" reconciliation distinguish this
  // in-flight approval from a card orphaned by a crash or restart, and the
  // catch guarantees no failure path can leave the card running forever.
  try {
    return await executeSubagentRunDecision(input);
  } catch (error) {
    if (input.decision === "approved") await persistInterruptedSubagentRun(input, error).catch(() => undefined);
    throw error;
  } finally {
    markSubagentRunSettled(input.runId);
  }
}

async function executeSubagentRunDecision(input: RespondToSubagentRunInput): Promise<ResearchChatSession> {
  const { session: startedSession, run: startedRun } = await withResearchSessionLock(input.projectRoot, input.sessionId, async () => {
    const store = await readChatsForMutation(input.projectRoot);
    const session = store.sessions.find((item) => item.id === input.sessionId);
    if (!session) throw new Error("Research chat session was not found.");
    const { messageIndex, message, runIndex } = locateSubagentRun(session, input.messageId, input.runId);
    if (!message || runIndex < 0) throw new Error("Subagent run was not found.");
    const run = message.subagentRuns[runIndex];
    if (run.status !== "awaiting-approval") throw new Error("This subagent run is no longer awaiting approval.");

    const selectedRuntimeTargetProfileIds = [...new Set((input.runtimeTargetProfileIds ?? []).map((profileId) => profileId.trim()).filter(Boolean))];
    if (input.decision === "approved" && run.runtimeTargetSelection) {
      const allowed = new Set(run.runtimeTargetSelection.options.map((option) => option.profileId));
      if (selectedRuntimeTargetProfileIds.length < run.runtimeTargetSelection.minSelections) {
        throw new Error("Choose at least one Run App target for Delphi.");
      }
      const unknown = selectedRuntimeTargetProfileIds.filter((profileId) => !allowed.has(profileId));
      if (unknown.length) throw new Error(`Unknown Delphi Run App target selection: ${unknown.join(", ")}.`);
      if (!run.runtimeTargetSelection.allowMultiple && selectedRuntimeTargetProfileIds.length > 1) {
        throw new Error("This Delphi audit accepts only one Run App target.");
      }
    }

    const updatedRun = input.decision === "rejected"
      ? transitionSubagentRun(run, "rejected")
      : transitionSubagentRun(run, "running", {
          proposedResolutionStrategy: input.resolutionStrategy ?? run.proposedResolutionStrategy,
          selectedRuntimeTargetProfileIds: run.runtimeTargetSelection ? selectedRuntimeTargetProfileIds : run.selectedRuntimeTargetProfileIds
        });
    const updatedMessage: ResearchChatMessage = {
      ...message,
      subagentRuns: message.subagentRuns.map((entry, index) => index === runIndex ? updatedRun : entry)
    };
    const updatedMessages = session.messages.map((entry, index) => index === messageIndex ? updatedMessage : entry);
    const updatedSession = researchChatSessionSchema.parse({ ...session, messages: updatedMessages, updatedAt: iso() });
    await persistResearchSession(input.projectRoot, updatedSession);
    return { session: updatedSession, run: updatedRun };
  });

  if (input.decision === "rejected") {
    const parsedArgs = JSON.parse(startedRun.argumentsJson || "{}") as { conflictedFiles?: string[]; resolvedFiles?: string[] };
    const files = parsedArgs.conflictedFiles ?? parsedArgs.resolvedFiles ?? [];
    const action = startedRun.kind === "merge-resolution" ? "merge resolution"
      : startedRun.kind === "delphi-testing" ? "Delphi audit"
        : "graph reconciliation";
    const report = `Cancelled the ${action} proposal${files.length ? ` for ${files.join(", ")}` : ""}. I did not run that subagent.`;
    return continueResearchGoalAfterOutcome(
      input.projectRoot,
      startedSession,
      `The user rejected the proposed ${action}. Nothing in that proposal ran.`,
      report
    );
  }

  // Approved: actually run the requested microrun now, outside the session lock.
  const bundle = await loadProject(input.projectRoot);
  const providerId = startedSession.providerId ?? bundle.project.settings.providers.find((provider) => provider.enabled)?.id;
  const configuredProvider = bundle.project.settings.providers.find((item) => item.id === providerId);
  if (!configuredProvider) throw new Error("Choose a provider in Settings before using Research.");
  const provider = researchProviderWithModel(configuredProvider, startedSession.modelId ?? undefined);
  const hydratedProvider = await hydrateProviderForUse(provider);

  if (startedRun.kind === "delphi-testing") {
    let args = delphiTestingInputSchema.parse(JSON.parse(startedRun.argumentsJson || "{}"));
    const setupResults: Awaited<ReturnType<typeof installDelphiManagedTool>>[] = [];
    const observedArtifacts: Array<{ id: string; label: string; path: string; mediaType: string }> = [];
    const visuallyAnalyzedArtifactIds = new Set(startedRun.diagnostics?.visuallyAnalyzedArtifactIds ?? []);
    let evidencePersistence = Promise.resolve();
    const persistLiveEvidence = (): Promise<void> => {
      const artifactsSnapshot = [...observedArtifacts];
      const analyzedSnapshot = [...visuallyAnalyzedArtifactIds];
      evidencePersistence = evidencePersistence.then(async () => {
        await withResearchSessionLock(input.projectRoot, input.sessionId, async () => {
          const store = await readChatsForMutation(input.projectRoot);
          const session = store.sessions.find((item) => item.id === input.sessionId);
          if (!session) return;
          const { messageIndex, message, runIndex } = locateSubagentRun(session, input.messageId, input.runId);
          if (!message || runIndex < 0 || message.subagentRuns[runIndex]!.status !== "running") return;
          const currentRun = message.subagentRuns[runIndex]!;
          const artifacts = Array.from(new Map([
            ...(currentRun.artifacts ?? []),
            ...artifactsSnapshot
          ].map((artifact) => [artifact.id, artifact])).values());
          const analyzedIds = Array.from(new Set([
            ...(currentRun.diagnostics?.visuallyAnalyzedArtifactIds ?? []),
            ...analyzedSnapshot
          ]));
          const updatedRun = transitionSubagentRun(currentRun, "running", {
            artifacts,
            diagnostics: {
              ...currentRun.diagnostics,
              visuallyAnalyzedArtifactIds: analyzedIds
            }
          });
          const updatedMessage: ResearchChatMessage = {
            ...message,
            subagentRuns: message.subagentRuns.map((run, index) => index === runIndex ? updatedRun : run)
          };
          const updatedSession = researchChatSessionSchema.parse({
            ...session,
            messages: session.messages.map((entry, index) => index === messageIndex ? updatedMessage : entry),
            updatedAt: iso()
          });
          await persistResearchSession(input.projectRoot, updatedSession);
        });
      }).catch((error) => {
        console.warn(`[delphi-testing] Could not persist live evidence state: ${error instanceof Error ? error.message : String(error)}`);
      });
      return evidencePersistence;
    };
    const observeArtifact = (artifact: { id: string; label: string; path: string; mediaType: string }): void => {
      if (!observedArtifacts.some((entry) => entry.id === artifact.id)) observedArtifacts.push(artifact);
      input.onProgress?.({
        runId: input.runId,
        kind: "delphi-testing",
        title: startedRun.title,
        message: `Captured ${artifact.label}`,
        status: "running",
        artifact
      });
      void persistLiveEvidence();
    };
    if (args.mode === "setup") {
      if (!args.setup) throw new Error("The Delphi setup proposal is missing its adapter plan.");
      try {
        for (const adapter of args.setup.adapters) {
          setupResults.push(await installDelphiManagedTool(input.projectRoot, {
            adapter,
            playwrightBrowsers: adapter === "playwright" ? args.setup.playwrightBrowsers : undefined,
            appiumDrivers: adapter === "appium" ? args.setup.appiumDrivers : undefined
          }, {
            onProgress: (message) => input.onProgress?.({ runId: input.runId, kind: "delphi-testing", title: startedRun.title, message, status: "running" })
          }));
        }
        args = delphiTestingInputSchema.parse({
          ...args,
          mode: args.setup.resumeMode,
          setup: undefined
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        input.onProgress?.({ runId: input.runId, kind: "delphi-testing", title: startedRun.title, message, status: "failed" });
        const failedSession = await withResearchSessionLock(input.projectRoot, input.sessionId, async () => {
          const store = await readChatsForMutation(input.projectRoot);
          const session = store.sessions.find((item) => item.id === input.sessionId);
          if (!session) throw new Error("Research chat session was not found.");
          const { messageIndex, message: chatMessage, runIndex } = locateSubagentRun(session, input.messageId, input.runId);
          if (!chatMessage || runIndex < 0) throw new Error("Subagent run was not found.");
          const failedRun = transitionSubagentRun(chatMessage.subagentRuns[runIndex]!, "failed", {
            resultSummary: `Delphi setup failed: ${message}`.slice(0, 1000),
            error: message
          });
          const updatedMessage: ResearchChatMessage = {
            ...chatMessage,
            subagentRuns: chatMessage.subagentRuns.map((entry, index) => index === runIndex ? failedRun : entry)
          };
          const updatedSession = researchChatSessionSchema.parse({
            ...session,
            messages: session.messages.map((entry, index) => index === messageIndex ? updatedMessage : entry),
            updatedAt: iso()
          });
          await persistResearchSession(input.projectRoot, updatedSession);
          return updatedSession;
        });
        const report = `Delphi's approved managed-tool setup failed: ${message}\n\nNo project dependency or source file was changed. You can retry the setup card after addressing the reported network/tooling issue.`;
        return continueResearchGoalAfterOutcome(
          input.projectRoot,
          failedSession,
          `Delphi's approved managed-tool setup failed without changing project dependencies or source files. Failure: ${message}`,
          report,
          {
            outcomeKind: "delphi-testing",
            outcomeRunId: input.runId,
            outcomeStatus: "failed",
            onActivity: input.onActivity,
            onSubagentProgress: ({ runId, kind, title, message: progressMessage, status }) => input.onProgress?.({ runId, kind, title, message: progressMessage, status })
          }
        );
      }
    }
    const selectedProfileIds = startedRun.selectedRuntimeTargetProfileIds?.length
      ? startedRun.selectedRuntimeTargetProfileIds
      : args.target?.profileId
        ? [args.target.profileId]
        : [];
    const selectedOptions = new Map((startedRun.runtimeTargetSelection?.options ?? []).map((option) => [option.profileId, option]));
    const platformForRuntimeKind = (kind: string | undefined): DelphiTestingInput["platforms"][number] | undefined => {
      const normalized = kind?.toLowerCase();
      if (normalized === "web" || normalized === "browser") return "web";
      if (normalized === "electron" || normalized === "desktop") return "electron";
      if (normalized === "flutter") return "flutter";
      if (normalized === "android") return "android";
      if (normalized === "ios") return "ios";
      return undefined;
    };
    type DelphiTargetAudit = {
      profileId?: string;
      label: string;
      args: DelphiTestingInput;
      lease?: DelphiRuntimeLease;
      stopped: boolean;
      result?: MicroRunResult;
    };
    const targetAudits: DelphiTargetAudit[] = (selectedProfileIds.length ? selectedProfileIds : [undefined]).map((profileId) => ({
      profileId,
      label: profileId ? selectedOptions.get(profileId)?.label ?? profileId : "Project checks",
      args: profileId
        ? delphiTestingInputSchema.parse({
            ...args,
            platforms: Array.from(new Set([
              ...args.platforms,
              platformForRuntimeKind(selectedOptions.get(profileId)?.kind)
            ].filter((platform): platform is DelphiTestingInput["platforms"][number] => Boolean(platform)))),
            target: { ...args.target, profileId, launch: "if-needed" }
          })
        : args,
      stopped: false
    }));
    let auditResult: MicroRunResult;
    try {
      // Start every selected runtime before auditing any of them. This keeps
      // combinations such as API + frontend alive together for the full pass.
      if (args.mode !== "plan") {
        for (const targetAudit of targetAudits) {
          try {
            targetAudit.lease = await acquireDelphiRuntimeTarget(input.projectRoot, targetAudit.args, {
              onProgress: (message) => input.onProgress?.({ runId: input.runId, kind: "delphi-testing", title: startedRun.title, message: `[${targetAudit.label}] ${message}`, status: "running" })
            });
            if (targetAudit.lease) {
              targetAudit.args = delphiTestingInputSchema.parse({
                ...targetAudit.args,
                target: {
                  ...targetAudit.args.target,
                  baseUrl: targetAudit.args.target?.baseUrl ?? targetAudit.lease.service.url,
                  deviceId: targetAudit.lease.service.runTargetId ?? targetAudit.lease.service.targetId ?? targetAudit.args.target?.deviceId
                }
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            targetAudit.result = { id: id("micro"), kind: "delphi-testing", status: "failed", error: message, createdAt: iso(), completedAt: iso() };
          }
        }
      }

      for (const targetAudit of targetAudits) {
        if (targetAudit.result) continue;
        const auditArgs: DelphiTestingInput = targetAudit.args;
        try {
          targetAudit.result = await executeMicroRun(
            input.projectRoot,
            "delphi-testing",
            { ...auditArgs, objective: `${auditArgs.objective} [Target: ${targetAudit.label}]` },
            hydratedProvider,
            bundle,
            {
              runConsoleCommand: (commandArgs) => {
                return runInternalConsoleCommand(input.projectRoot, bundle.project.settings, commandArgs, {
                  authorization: {
                    actor: "delphi",
                    capabilities: ["inspect-project", "verify-project"]
                  },
                  maxTimeoutMs: 10 * 60_000
                });
              },
              onProgress: (message) => input.onProgress?.({ runId: input.runId, kind: "delphi-testing", title: startedRun.title, message: `[${targetAudit.label}] ${message}`, status: "running" }),
              onArtifact: observeArtifact,
              onObservationAnalysis: async (event) => {
                input.onProgress?.({
                  runId: input.runId,
                  kind: "delphi-testing",
                  title: startedRun.title,
                  message: "",
                  status: "running",
                  observationAnalysis: { artifactId: event.artifact.id, status: event.status }
                });
                if (event.status === "completed") {
                  visuallyAnalyzedArtifactIds.add(event.artifact.id);
                  await persistLiveEvidence();
                }
              }
            }
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          targetAudit.result = { id: id("micro"), kind: "delphi-testing", status: "failed", error: message, createdAt: iso(), completedAt: iso() };
        }
      }
    } finally {
      for (const targetAudit of [...targetAudits].reverse()) {
        try {
          targetAudit.stopped = await releaseDelphiRuntimeTarget(
            input.projectRoot,
            targetAudit.lease,
            targetAudit.args,
            (message) => input.onProgress?.({ runId: input.runId, kind: "delphi-testing", title: startedRun.title, message: `[${targetAudit.label}] ${message}`, status: "running" })
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          targetAudit.result = {
            ...(targetAudit.result ?? { id: id("micro"), kind: "delphi-testing", createdAt: iso(), completedAt: iso() }),
            status: "failed",
            error: `Audit completed, but Delphi could not clean up its owned runtime target: ${message}`
          };
        }
      }
    }
    await evidencePersistence;
    const completedTargetResults = targetAudits.map((targetAudit) => ({
      ...targetAudit,
      result: targetAudit.result ?? { id: id("micro"), kind: "delphi-testing" as const, status: "failed" as const, error: "Delphi did not return a target result.", createdAt: iso(), completedAt: iso() }
    }));
    const outputs = completedTargetResults.flatMap((targetAudit) => targetAudit.result.output
      ? [{ label: targetAudit.label, output: targetAudit.result.output as DelphiTestingOutput }]
      : []);
    const executionFailures = completedTargetResults.filter((targetAudit) => targetAudit.result.status === "failed");
    const aggregateFailureKind = executionFailures.some((targetAudit) => targetAudit.result.failureKind === "timeout")
      ? "timeout" as const
      : executionFailures.length
        ? "error" as const
        : undefined;
    const aggregateOutput: DelphiTestingOutput = {
      status: outputs.some(({ output }) => output.status === "needs-setup") ? "needs-setup"
        : executionFailures.length || outputs.some(({ output }) => output.status === "blocked") ? "blocked"
          : "completed",
      verdict: outputs.some(({ output }) => output.verdict === "failed") ? "failed"
        : executionFailures.length || outputs.some(({ output }) => output.verdict === "blocked" || output.verdict === "not-run") ? "blocked"
          : outputs.length && outputs.every(({ output }) => output.verdict === "passed") ? "passed"
            : "not-run",
      summary: completedTargetResults.map((targetAudit) => {
        const output = targetAudit.result.output as DelphiTestingOutput | undefined;
        return `${targetAudit.label}: ${output?.summary ?? targetAudit.result.error ?? "No result."}`;
      }).join(" "),
      attempts: outputs.reduce((sum, entry) => sum + entry.output.attempts, 0),
      checks: outputs.flatMap(({ label, output }) => output.checks.map((check) => ({ ...check, name: `[${label}] ${check.name}` }))),
      findings: outputs.flatMap(({ label, output }) => output.findings.map((finding) => ({ ...finding, title: `[${label}] ${finding.title}` }))),
      toolchains: outputs.flatMap(({ output }) => output.toolchains),
      artifacts: outputs.flatMap(({ output }) => output.artifacts),
      blockers: [
        ...executionFailures.map((targetAudit) => `${targetAudit.label}: ${targetAudit.result.error ?? "execution failed"}`),
        ...outputs.flatMap(({ label, output }) => output.blockers.map((blocker) => `${label}: ${blocker}`))
      ],
      recommendedNextSteps: outputs.flatMap(({ label, output }) => output.recommendedNextSteps.map((step) => `${label}: ${step}`))
    };
    const aggregateUsage = completedTargetResults.reduce<LlmUsage | undefined>((usage, targetAudit) =>
      targetAudit.result.usage ? mergeResearchUsage(usage, targetAudit.result.usage) : usage, undefined);
    const targetDiagnostics = completedTargetResults.flatMap((targetAudit) => targetAudit.result.diagnostics ? [targetAudit.result.diagnostics] : []);
    const aggregateDiagnostics: MicroRunResult["diagnostics"] = targetDiagnostics.length ? {
      responsePreview: targetDiagnostics.map((diagnostic) => diagnostic.responsePreview).filter(Boolean).join("\n\n").slice(0, 4_000) || undefined,
      responseRedacted: targetDiagnostics.some((diagnostic) => diagnostic.responseRedacted) || undefined,
      responseTruncated: targetDiagnostics.some((diagnostic) => diagnostic.responseTruncated) || undefined,
      repairAttempted: targetDiagnostics.some((diagnostic) => diagnostic.repairAttempted) || undefined,
      validationErrors: Array.from(new Set(targetDiagnostics.flatMap((diagnostic) => diagnostic.validationErrors ?? []))) || undefined,
      toolCallNames: Array.from(new Set(targetDiagnostics.flatMap((diagnostic) => diagnostic.toolCallNames ?? []))),
      toolRejections: targetDiagnostics.flatMap((diagnostic) => diagnostic.toolRejections ?? []).slice(-8),
      visuallyAnalyzedArtifactIds: Array.from(new Set(targetDiagnostics.flatMap((diagnostic) => diagnostic.visuallyAnalyzedArtifactIds ?? [])))
    } : undefined;
    auditResult = {
      id: id("micro"),
      kind: "delphi-testing",
      status: executionFailures.length ? "failed" : "completed",
      output: aggregateOutput,
      error: executionFailures.length ? executionFailures.map((targetAudit) => `${targetAudit.label}: ${targetAudit.result.error ?? "execution failed"}`).join("; ") : undefined,
      failureKind: aggregateFailureKind,
      usage: aggregateUsage,
      diagnostics: aggregateDiagnostics,
      createdAt: completedTargetResults[0]?.result.createdAt ?? iso(),
      completedAt: iso()
    };
    input.onProgress?.({
      runId: input.runId,
      kind: "delphi-testing",
      title: startedRun.title,
      message: "",
      status: auditResult.status === "failed" ? "failed" : "completed"
    });
    input.onActivity?.("Delphi finished this pass. Archi is processing its evidence and next step.", "running");
    const reportArtifact = await createChatArtifact(input.projectRoot, input.sessionId, {
      title: `Delphi audit — ${args.objective.slice(0, 120)}`,
      content: JSON.stringify({
        managedSetup: setupResults,
        targets: completedTargetResults.map((targetAudit) => ({
          profileId: targetAudit.profileId,
          label: targetAudit.label,
          runtime: targetAudit.lease ? {
            serviceId: targetAudit.lease.service.id,
            targetId: targetAudit.lease.service.targetId,
            runTargetId: targetAudit.lease.service.runTargetId,
            url: targetAudit.lease.service.url,
            startedByDelphi: targetAudit.lease.startedByDelphi,
            stoppedAfterAudit: targetAudit.stopped
          } : undefined,
          microRun: targetAudit.result
        })),
        aggregate: auditResult
      }, null, 2),
      format: "json",
      summary: auditResult.status === "failed" ? auditResult.error : (auditResult.output as DelphiTestingOutput | undefined)?.summary
    }).catch(() => undefined);
    const auditOutput = auditResult.output as DelphiTestingOutput | undefined;
    const persistedAuditStatus: SubagentRun["status"] = auditResult.status === "failed"
      ? "failed"
      : auditOutput?.status === "blocked"
        ? "blocked"
        : "completed";
    const runtimeSummary = completedTargetResults.flatMap((targetAudit) => targetAudit.lease ? [
      `Runtime ${targetAudit.lease.startedByDelphi ? "started by Delphi" : "reused"}: ${targetAudit.lease.plan.profileLabel}${targetAudit.lease.service.runTargetId ? ` (${targetAudit.lease.service.runTargetId})` : ""}${targetAudit.lease.service.url ? ` at ${targetAudit.lease.service.url}` : ""}.${targetAudit.stopped ? " Delphi stopped its owned runtime/target after the audit." : " The runtime remains available."}`
    ] : []).join("\n");
    const setupInput = auditResult.status === "failed" || setupResults.length
      ? undefined
      : delphiManagedSetupInput(args, { toolchains: auditOutput?.toolchains ?? [] }, auditOutput);
    const setupRun: SubagentRun | undefined = setupInput ? {
      id: id("subagent-run"),
      kind: "delphi-testing",
      status: "awaiting-approval",
      title: `Set up Delphi adapters for: ${args.objective.slice(0, 80)}`,
      argumentsJson: JSON.stringify(setupInput),
      runtimeTargetSelection: startedRun.runtimeTargetSelection,
      selectedRuntimeTargetProfileIds: startedRun.selectedRuntimeTargetProfileIds,
      imageInputSupport: startedRun.imageInputSupport,
      reviewReason: [
        `Install ${setupInput.setup!.adapters.join(" and ")} only in ArchiCode's managed tool cache.`,
        setupInput.setup!.adapters.map((adapter) => `${adapter}: ${delphiAdapterCacheRoot(input.projectRoot, adapter)}`).join("; "),
        setupInput.setup!.adapters.includes("playwright") ? `Download Playwright browser engines: ${setupInput.setup!.playwrightBrowsers.join(", ")}.` : "",
        setupInput.setup!.adapters.includes("appium") && setupInput.setup!.appiumDrivers.length ? `Install Appium drivers: ${setupInput.setup!.appiumDrivers.join(", ")}.` : "",
        setupInput.target?.launch === "if-needed" ? "After setup, Delphi will run the same previously approved Run App target lifecycle before resuming the audit." : "",
        "This does not add project dependencies or edit source files. After setup, Delphi will resume the audit automatically."
      ].filter(Boolean).join(" "),
      progress: [],
      createdAt: iso(),
      updatedAt: iso()
    } : undefined;
    const finalSession = await withResearchSessionLock(input.projectRoot, input.sessionId, async () => {
      const store = await readChatsForMutation(input.projectRoot);
      const session = store.sessions.find((item) => item.id === input.sessionId);
      if (!session) throw new Error("Research chat session was not found.");
      const { messageIndex, message, runIndex } = locateSubagentRun(session, input.messageId, input.runId);
      if (!message || runIndex < 0) throw new Error("Subagent run was not found.");
      const completedRun = transitionSubagentRun(message.subagentRuns[runIndex]!, persistedAuditStatus, {
        resultSummary: `${setupResults.length ? `Managed setup completed for ${setupResults.map((result) => `${result.adapter} ${result.version ?? ""}`.trim()).join(", ")}. ` : ""}${runtimeSummary ? `${runtimeSummary} ` : ""}${microRunHumanSummary(auditResult)}${reportArtifact ? " Detailed report saved in this chat's artifacts." : ""}`,
        error: auditResult.status === "failed" ? auditResult.error : undefined,
        failureKind: auditResult.status === "failed" ? auditResult.failureKind ?? "error" : undefined,
        usage: auditResult.usage,
        diagnostics: auditResult.diagnostics,
        artifacts: observedArtifacts
      });
      const nextRuns = message.subagentRuns.map((entry, index) => index === runIndex ? completedRun : entry);
      if (setupRun) nextRuns.push(setupRun);
      const updatedMessage: ResearchChatMessage = {
        ...message,
        subagentRuns: nextRuns
      };
      const updatedSession = researchChatSessionSchema.parse({
        ...session,
        messages: session.messages.map((entry, index) => index === messageIndex ? updatedMessage : entry),
        updatedAt: iso()
      });
      await persistResearchSession(input.projectRoot, updatedSession);
      return updatedSession;
    });
    const report = [runtimeSummary, delphiAuditReport(auditResult, Boolean(reportArtifact), Boolean(setupRun))].filter(Boolean).join("\n\n");
    return continueResearchGoalAfterOutcome(
      input.projectRoot,
      finalSession,
      `The approved Delphi audit finished.\n\n${report}`,
      report,
      {
        pauseForNewApproval: Boolean(setupRun),
        outcomeEvidenceProvided: true,
        outcomeKind: setupRun ? undefined : "delphi-testing",
        outcomeRunId: input.runId,
        outcomeStatus: persistedAuditStatus === "blocked" ? "blocked" : persistedAuditStatus === "failed" ? "failed" : "completed",
        onActivity: input.onActivity,
        onSubagentProgress: ({ runId, kind, title, message, status }) => input.onProgress?.({ runId, kind, title, message, status })
      }
    );
  }

  if (startedRun.kind === "graph-reconciliation") {
    const args = JSON.parse(startedRun.argumentsJson || "{}") as GraphReconciliationInput;
    const reconciliationResult = await executeMicroRun(
      input.projectRoot,
      "graph-reconciliation",
      args,
      hydratedProvider,
      bundle,
      {
        onProgress: (message) => input.onProgress?.({ runId: input.runId, kind: "graph-reconciliation", title: startedRun.title, message, status: "running" })
      }
    );
    input.onProgress?.({
      runId: input.runId,
      kind: "graph-reconciliation",
      title: startedRun.title,
      message: "",
      status: reconciliationResult.status === "failed" ? "failed" : "completed"
    });

    let finalChangeSet: ResearchChangeSet | undefined;
    const finalSession = await withResearchSessionLock(input.projectRoot, input.sessionId, async () => {
      const store = await readChatsForMutation(input.projectRoot);
      const session = store.sessions.find((item) => item.id === input.sessionId);
      if (!session) throw new Error("Research chat session was not found.");
      const { messageIndex, message, runIndex } = locateSubagentRun(session, input.messageId, input.runId);
      if (!message || runIndex < 0) throw new Error("Subagent run was not found.");
      const output = reconciliationResult.output as GraphReconciliationOutput | undefined;
      finalChangeSet = reconciliationResult.status !== "failed" && output?.graphChangeSet
        ? buildResearchTurnChangeSet(output.graphChangeSet, undefined, bundle)
        : undefined;
      const reconciliationRun = transitionSubagentRun(message.subagentRuns[runIndex]!, reconciliationResult.status === "failed" ? "failed" : "completed", {
        resultSummary: microRunHumanSummary(reconciliationResult),
        error: reconciliationResult.status === "failed" ? reconciliationResult.error : undefined,
        usage: reconciliationResult.usage,
        diagnostics: reconciliationResult.diagnostics
      });
      const updatedMessage: ResearchChatMessage = {
        ...message,
        subagentRuns: message.subagentRuns.map((entry, index) => index === runIndex ? reconciliationRun : entry),
        changeSet: finalChangeSet ?? message.changeSet
      };
      const updatedMessages = session.messages.map((entry, index) => index === messageIndex ? updatedMessage : entry);
      const updatedSession = researchChatSessionSchema.parse({
        ...session,
        memory: session.memory,
        orchestration: finalChangeSet
          ? trackResearchChangeSetTodo(session.orchestration, finalChangeSet, updatedMessage.id, iso())
          : session.orchestration,
        messages: updatedMessages,
        updatedAt: iso()
      });
      await persistResearchSession(input.projectRoot, updatedSession);
      return updatedSession;
    });

    const report = graphReconciliationReport(reconciliationResult, finalChangeSet);
    return continueResearchGoalAfterOutcome(
      input.projectRoot,
      finalSession,
      `The approved graph reconciliation finished.\n\n${report}`,
      report,
      {
        pauseForNewApproval: Boolean(finalChangeSet),
        outcomeKind: "graph-reconciliation",
        outcomeRunId: input.runId,
        outcomeStatus: reconciliationResult.status === "failed" ? "failed" : "completed",
        onActivity: input.onActivity,
        onSubagentProgress: ({ runId, kind, title, message, status }) => input.onProgress?.({ runId, kind, title, message, status })
      }
    );
  }

  const args = JSON.parse(startedRun.argumentsJson || "{}") as MergeResolutionInput;
  const mergeResult = await executeMicroRun(
    input.projectRoot,
    "merge-resolution",
    { ...args, resolutionStrategy: input.resolutionStrategy ?? args.resolutionStrategy },
    hydratedProvider,
    bundle,
    {
      runConsoleCommand: (commandArgs) => runInternalConsoleCommand(input.projectRoot, bundle.project.settings, commandArgs, {
        authorization: {
          actor: "solomon",
          capabilities: ["inspect-project", "verify-project"]
        },
        maxTimeoutMs: 10 * 60_000
      }),
      onProgress: (message) => input.onProgress?.({ runId: input.runId, kind: "merge-resolution", title: startedRun.title, message, status: "running" })
    }
  );
  // Merge resolution finished; mark it done so the UI stops showing it as
  // running while graph reconciliation (the sequential next step) runs.
  input.onProgress?.({
    runId: input.runId,
    kind: "merge-resolution",
    title: startedRun.title,
    message: "",
    status: mergeResult.status === "failed" ? "failed" : "completed"
  });

  // Finish the merge by committing the already-staged resolution. Only ever
  // commits a verified-good state; leaves it uncommitted (for manual review)
  // if verification failed or any conflict marker is still unresolved.
  let mergeCommitOutcome: { committed: boolean; message?: string; reason?: string } = { committed: false };
  if (mergeResult.status !== "failed") {
    const mergeOutputForCommit = mergeResult.output as MergeResolutionOutput | undefined;
    if (mergeOutputForCommit?.verificationPassed) {
      const remainingConflicts = await getConflictedFiles(input.projectRoot);
      if (remainingConflicts.length === 0) {
        const resolvedList = mergeOutputForCommit.resolvedFiles.join(", ") || args.conflictedFiles.join(", ");
        const commitMessage = `Resolve merge conflict in ${resolvedList}\n\n${mergeOutputForCommit.summary}`;
        const commitResult = await commitStagedResolution(input.projectRoot, commitMessage);
        mergeCommitOutcome = commitResult.exitCode === 0
          ? { committed: true, message: commitMessage }
          : { committed: false, reason: (commitResult.stderr || commitResult.stdout || "git commit failed").trim() };
      } else {
        mergeCommitOutcome = { committed: false, reason: `${remainingConflicts.length} file(s) still have unresolved conflict markers.` };
      }
    } else {
      mergeCommitOutcome = { committed: false, reason: "verification did not pass, so the resolution was left uncommitted for manual review." };
    }
  }

  const subagentSettings = bundle.project.settings.agentTools?.subagents;
  const graphReconciliationEnabled = subagentSettings?.graphReconciliation ?? true;

  let reconciliationRun: SubagentRun | undefined;
  let stalenessSignal: GraphStalenessSignal | undefined;
  if (mergeResult.status !== "failed" && graphReconciliationEnabled) {
    const mergeOutput = mergeResult.output as MergeResolutionOutput | undefined;
    const resolvedFiles = mergeOutput?.resolvedFiles?.length ? mergeOutput.resolvedFiles : args.conflictedFiles;
    stalenessSignal = detectGraphStalenessSignal(bundle, resolvedFiles);
    const reconciliationArgs: GraphReconciliationInput = {
      mode: "reconcile",
      constraints: [],
      detailLevel: "detailed",
      resolvedFiles,
      resolutionSummary: mergeOutput?.summary ?? "Merge conflicts resolved.",
      verificationResult: mergeOutput?.verificationOutput || (mergeOutput?.verificationPassed ? "Verification passed." : "Verification status unknown.")
    };
    if (stalenessSignal.shouldAsk) {
      const reconciliationCreatedAt = iso();
      reconciliationRun = {
        id: id("subagent-run"),
        kind: "graph-reconciliation",
        status: "awaiting-approval",
        title: `Reconcile the graph with ${reconciliationArgs.resolvedFiles.join(", ")}`,
        argumentsJson: JSON.stringify(reconciliationArgs),
        reviewReason: stalenessSignal.reason,
        progress: [],
        createdAt: reconciliationCreatedAt,
        updatedAt: reconciliationCreatedAt
      };
    }
  }

  const finalReconciliationRun = reconciliationRun;
  const finalSession = await withResearchSessionLock(input.projectRoot, input.sessionId, async () => {
    const store = await readChatsForMutation(input.projectRoot);
    const session = store.sessions.find((item) => item.id === input.sessionId);
    if (!session) throw new Error("Research chat session was not found.");
    const { messageIndex, message, runIndex } = locateSubagentRun(session, input.messageId, input.runId);
    if (!message || runIndex < 0) throw new Error("Subagent run was not found.");
    const commitNote = mergeCommitOutcome.committed
      ? "\n\nCommitted the resolution."
      : mergeResult.status === "failed" ? "" : `\n\nNot committed: ${mergeCommitOutcome.reason}`;
    const mergeRun = transitionSubagentRun(message.subagentRuns[runIndex]!, mergeResult.status === "failed" ? "failed" : "completed", {
      resultSummary: `${microRunHumanSummary(mergeResult)}${commitNote}`,
      error: mergeResult.status === "failed" ? mergeResult.error : undefined,
      usage: mergeResult.usage,
      diagnostics: mergeResult.diagnostics
    });
    const nextRuns = message.subagentRuns.map((entry, index) => index === runIndex ? mergeRun : entry);
    if (finalReconciliationRun) nextRuns.push(finalReconciliationRun);
    const updatedMessage: ResearchChatMessage = { ...message, subagentRuns: nextRuns, changeSet: message.changeSet };
    const updatedMessages = session.messages.map((entry, index) => index === messageIndex ? updatedMessage : entry);
    const updatedSession = researchChatSessionSchema.parse({
      ...session,
      messages: updatedMessages,
      updatedAt: iso()
    });
    await persistResearchSession(input.projectRoot, updatedSession);
    return updatedSession;
  });

  const report = mergeApprovalReport(mergeResult, mergeCommitOutcome, finalReconciliationRun, stalenessSignal, graphReconciliationEnabled);
  return continueResearchGoalAfterOutcome(
    input.projectRoot,
    finalSession,
    `The approved merge-resolution work finished.\n\n${report}`,
    report,
    {
      pauseForNewApproval: Boolean(finalReconciliationRun),
      outcomeKind: "merge-resolution",
      outcomeRunId: input.runId,
      outcomeStatus: mergeResult.status === "failed" ? "failed" : "completed",
      onActivity: input.onActivity,
      onSubagentProgress: ({ runId, kind, title, message, status }) => input.onProgress?.({ runId, kind, title, message, status })
    }
  );
}

async function reviewResearchGraphChangeSet(input: {
  projectRoot: string;
  session: ResearchChatSession;
  messageId: string;
  changeSetId: string;
  decisions: ResearchGraphChangeDecision[];
  resultPrefix: string;
  allowReviewedRetry?: boolean;
}): Promise<{ session: ResearchChatSession; bundle: ProjectBundle; results: ResearchGraphChangeResult[] }> {
  const parsedDecisions = input.decisions.map((decision) => researchGraphChangeDecisionSchema.parse(decision));
  const accepted = new Map(parsedDecisions.map((decision) => [decision.operationIndex, decision]));
  const message = input.session.messages.find((item) => item.id === input.messageId);
  const changeSet = message?.changeSet;
  if (!message || !changeSet || changeSet.id !== input.changeSetId) {
    throw new Error("Research change set was not found.");
  }
  if (changeSet.reviewedAt && !input.allowReviewedRetry) {
    throw new Error("Research change set was already reviewed.");
  }
  const validationBundle = await loadProject(input.projectRoot);
  const capturedAcceptedOperationEntries = changeSet.operations
    .map((operation, operationIndex) => ({ operation, operationIndex }))
    .filter(({ operationIndex }) => accepted.get(operationIndex)?.decision === "accepted");
  const normalizedAcceptedOperations = normalizeResearchAgentRunNodeIds(
    validationBundle,
    capturedAcceptedOperationEntries.map(({ operation }) => operation)
  );
  const acceptedOperationEntries = capturedAcceptedOperationEntries.map((entry, index) => ({
    ...entry,
    operation: normalizedAcceptedOperations[index]!
  }));
  const graphLockRuns = activeResearchGraphLockRuns(validationBundle);
  if (acceptedOperationEntries.length && graphLockRuns.length) {
    const category = researchChangeSetCategory(changeSet.operations);
    const action = category === "queue" ? "Queue submission" : category === "graph" ? "Graph editing" : "Research changes";
    const nextStep = category === "queue" ? "submitting more queued work" : category === "graph" ? "applying Research graph changes" : "applying this Research change set";
    throw new Error(`${action} is locked while active run${graphLockRuns.length === 1 ? "" : "s"} ${graphLockRuns.map((run) => `${run.id} (${run.status})`).join(", ")} ${graphLockRuns.length === 1 ? "is" : "are"} in progress or waiting for review. Finish or cancel the active run before ${nextStep}.`);
  }
  const redundantUpdateOperationIndexes = acceptedOperationEntries.length > 1
    ? new Set(acceptedOperationEntries
      .filter(({ operation }) => isNoopResearchUpdateNode(validationBundle, operation))
      .map(({ operationIndex }) => operationIndex))
    : new Set<number>();
  const validatedOperationEntries = acceptedOperationEntries
    .filter(({ operationIndex }) => !redundantUpdateOperationIndexes.has(operationIndex));
  // The card preserves presentation order, while the apply transaction uses a
  // stable dependency order. This is a harness-level repair: a create-flow or
  // create-subflow is persisted before operations that reference it without
  // asking Picasso to regenerate already completed batches.
  const orderedValidatedOperationEntries = orderCodebaseMapOperations(validatedOperationEntries.map(({ operation }) => operation))
    .map(({ operationIndex }) => validatedOperationEntries[operationIndex]!);
  const acceptedOperations = orderedValidatedOperationEntries.map(({ operation }) => operation);
  const createdNodeLayoutHints: ResearchCreatedNodeLayoutHints = new Map();
  const validationErrors = collectResearchChangeSetValidationErrors(validationBundle, input.session.scope, acceptedOperations)
    .map((error) => ({
      ...error,
      operationIndex: error.operationIndex === undefined
        ? undefined
        : orderedValidatedOperationEntries[error.operationIndex]?.operationIndex
    }));
  const validationFailure = validationErrors.length ? formatResearchChangeSetValidationErrors(validationErrors) : null;
  const invalidOperationNumbers = [...new Set(validationErrors
    .map((error) => error.operationIndex)
    .filter((operationIndex): operationIndex is number => operationIndex !== undefined)
    .map((operationIndex) => operationIndex + 1))];
  const resultsByOperationIndex = new Map<number, ResearchGraphChangeResult>();
  for (const [operationIndex] of changeSet.operations.entries()) {
    const decision = accepted.get(operationIndex);
    if (!decision || decision.decision === "rejected") {
      resultsByOperationIndex.set(operationIndex, { operationIndex, status: "rejected", message: decision?.reason ?? "Rejected or left unapplied by the user." });
      continue;
    }
    if (redundantUpdateOperationIndexes.has(operationIndex)) {
      resultsByOperationIndex.set(operationIndex, { operationIndex, status: "applied", message: "Already up to date; no persisted change was required." });
      continue;
    }
    if (validationFailure) {
      const operationErrors = validationErrors.filter((error) => error.operationIndex === operationIndex);
      const message = operationErrors.length
        ? operationErrors.map((error) => error.message).join(" ")
        : invalidOperationNumbers.length
          ? `Not applied because accepted graph changes are transactional and operation${invalidOperationNumbers.length === 1 ? "" : "s"} ${invalidOperationNumbers.join(", ")} failed validation.`
          : validationFailure;
      resultsByOperationIndex.set(operationIndex, { operationIndex, status: "failed", message });
    }
  }
  const recordCreatedNodeForLayout = (operation: ResearchOperation): void => {
    if (operation.kind !== "create-node" || createNodeHasExplicitPlacement(operation.node)) return;
    const created = createdNodeLayoutHints.get(operation.flowId) ?? new Set<string>();
    if (operation.node.id) created.add(operation.node.id);
    createdNodeLayoutHints.set(operation.flowId, created);
  };
  if (!validationFailure) for (const { operationIndex, operation } of orderedValidatedOperationEntries) {
    try {
      const message = await applyResearchOperation(input.projectRoot, operation);
      resultsByOperationIndex.set(operationIndex, { operationIndex, status: "applied", message: message ?? "Applied successfully." });
      recordCreatedNodeForLayout(operation);
    } catch (error) {
      resultsByOperationIndex.set(operationIndex, { operationIndex, status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }

  // A fresh-state retry recovers from transient persistence races and from a
  // dependency whose first write failed while later operations observed the
  // missing item. It is intentionally bounded to one pass and excludes agent
  // runs or other actions that could duplicate external side effects.
  const retryEntries = validationFailure ? [] : orderedValidatedOperationEntries.filter(({ operationIndex, operation }) =>
    resultsByOperationIndex.get(operationIndex)?.status === "failed" && isBoundedGraphMutationRetry(operation));
  if (retryEntries.length) {
    const retryBundle = await loadProject(input.projectRoot);
    const retryValidationErrors = collectResearchChangeSetValidationErrors(
      retryBundle,
      input.session.scope,
      retryEntries.map(({ operation }) => operation)
    );
    if (!retryValidationErrors.length) {
      for (const { operationIndex, operation } of retryEntries) {
        try {
          const message = await applyResearchOperation(input.projectRoot, operation);
          resultsByOperationIndex.set(operationIndex, {
            operationIndex,
            status: "applied",
            message: `${message ?? "Applied successfully."} Recovered on one bounded automatic retry.`
          });
          recordCreatedNodeForLayout(operation);
        } catch (error) {
          resultsByOperationIndex.set(operationIndex, { operationIndex, status: "failed", message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
  const results = changeSet.operations.map((_operation, operationIndex) => resultsByOperationIndex.get(operationIndex) ?? ({
    operationIndex,
    status: "failed" as const,
    message: "Operation did not reach the bounded apply transaction."
  }));
  if (createdNodeLayoutHints.size) {
    await layoutResearchCreatedNodes(input.projectRoot, createdNodeLayoutHints);
  }

  const reviewedAt = iso();
  const resultCategory = researchChangeSetCategory(changeSet.operations);
  const resultMessage: ResearchChatMessage = {
    id: id("msg"),
    role: "system",
    content: `${input.resultPrefix}: ${results.filter((result) => result.status === "applied").length} ${resultCategory === "queue" ? "queued" : "applied"}, ${results.filter((result) => result.status === "rejected").length} rejected, ${results.filter((result) => result.status === "failed").length} failed.`,
    createdAt: reviewedAt,
    attachmentIds: [],
    webUsed: false,
    mcpToolCalls: [],
    subagentRuns: []
  };
  const updatedSession = researchChatSessionSchema.parse({
    ...input.session,
    orchestration: reviewResearchChangeSetTodo(input.session.orchestration, changeSet, results, reviewedAt),
    messages: [
      ...input.session.messages.map((item) => item.id === message.id
        ? { ...item, changeSet: item.changeSet ? { ...item.changeSet, reviewedAt } : item.changeSet }
        : item),
      resultMessage
    ],
    updatedAt: reviewedAt
  });
  return { session: updatedSession, bundle: await loadProject(input.projectRoot), results };
}

function isBoundedGraphMutationRetry(operation: ResearchOperation): boolean {
  return operation.kind !== "start-agent-run" &&
    operation.kind !== "start-run-profile" &&
    operation.kind !== "stop-runtime-service" &&
    operation.kind !== "restart-runtime-service" &&
    operation.kind !== "retry-run" &&
    operation.kind !== "start-debugging-run" &&
    operation.kind !== "author-acceptance-tests" &&
    operation.kind !== "run-acceptance-checks" &&
    operation.kind !== "start-runtime-debug-run" &&
    operation.kind !== "start-incident-debug-run";
}

export async function layoutResearchCreatedNodes(projectRoot: string, createdNodeLayoutHints: ResearchCreatedNodeLayoutHints): Promise<void> {
  if (!createdNodeLayoutHints.size) return;
  const bundle = await loadProject(projectRoot);
  for (const [flowId, createdNodeIds] of createdNodeLayoutHints.entries()) {
    if (!createdNodeIds.size) continue;
    const flow = bundle.flows.find((item) => item.id === flowId);
    if (!flow) continue;
    const laidOut = placeCreatedResearchNodes(flow, createdNodeIds);
    if (laidOut !== flow) {
      await saveFlow(projectRoot, laidOut);
    }
  }
}

function placeCreatedResearchNodes(flow: Flow, createdNodeIds: Set<string>): Flow {
  const scopedSubflowIds = new Set<string | null>();
  for (const node of flow.nodes) {
    if (createdNodeIds.has(node.id)) scopedSubflowIds.add(node.subflowId ?? null);
  }
  if (!scopedSubflowIds.size) return flow;

  let nextFlow = flow;
  for (const subflowId of scopedSubflowIds) {
    nextFlow = placeCreatedResearchNodesInScope(nextFlow, createdNodeIds, subflowId);
  }
  return nextFlow;
}

function placeCreatedResearchNodesInScope(flow: Flow, createdNodeIds: Set<string>, subflowId: string | null): Flow {
  const scopedNodes = flow.nodes.filter((node) => (node.subflowId ?? null) === subflowId);
  const createdNodes = scopedNodes.filter((node) => createdNodeIds.has(node.id));
  if (!createdNodes.length) return flow;

  const existingNodes = scopedNodes.filter((node) => !createdNodeIds.has(node.id));
  const scopedIds = new Set(scopedNodes.map((node) => node.id));
  const scopedEdges = flow.edges.filter((edge) => scopedIds.has(edge.source) && scopedIds.has(edge.target));
  const createdIds = new Set(createdNodes.map((node) => node.id));
  if (!existingNodes.length && scopedEdges.length) {
    // A wholly generated canvas can use the importer's full SCC-aware,
    // dependency-depth layout without disturbing any user-positioned nodes.
    return layoutScopeByDependencyDepth(flow, subflowId);
  }
  const xGap = 330;
  const yGap = 220;
  const fallbackX = 80;
  const fallbackY = 80;
  const byId = new Map(scopedNodes.map((node) => [node.id, node]));
  const positioned = new Map<string, { x: number; y: number }>();
  const anchorIds = new Set<string>();
  const createdParents = new Map<string, Set<string>>();
  const desiredAnchorY = new Map<string, number[]>();

  for (const edge of scopedEdges) {
    const sourceCreated = createdIds.has(edge.source);
    const targetCreated = createdIds.has(edge.target);
    if (sourceCreated && targetCreated) {
      const parents = createdParents.get(edge.target) ?? new Set<string>();
      parents.add(edge.source);
      createdParents.set(edge.target, parents);
    }
    if (sourceCreated === targetCreated) continue;
    const createdId = sourceCreated ? edge.source : edge.target;
    const anchorId = sourceCreated ? edge.target : edge.source;
    anchorIds.add(anchorId);
    const values = desiredAnchorY.get(createdId) ?? [];
    values.push(byId.get(anchorId)?.position.y ?? fallbackY);
    desiredAnchorY.set(createdId, values);
  }

  const anchorNodes = [...anchorIds].map((id) => byId.get(id)).filter((node): node is ArchicodeNode => Boolean(node));
  const scopeNodesForBounds = existingNodes.length ? existingNodes : anchorNodes;
  const baseX = scopeNodesForBounds.length
    ? Math.max(...scopeNodesForBounds.map((node) => node.position.x)) + xGap
    : fallbackX;
  const baselineY = anchorNodes.length
    ? average(anchorNodes.map((node) => node.position.y))
    : existingNodes.length
      ? average(existingNodes.map((node) => node.position.y))
      : fallbackY;
  const hasCreatedNodeEdges = scopedEdges.some((edge) => createdIds.has(edge.source) || createdIds.has(edge.target));
  if (!hasCreatedNodeEdges && createdNodes.length > 1) {
    // A missing topology should not collapse every generated node into one
    // depth-zero column. Picasso normally supplies semantic edges; this grid is
    // the safe visual fallback for older or deliberately disconnected cards.
    const sorted = [...createdNodes].sort((left, right) => left.title.localeCompare(right.title));
    const columnCount = Math.max(2, Math.ceil(Math.sqrt(sorted.length)));
    const rowCount = Math.ceil(sorted.length / columnCount);
    const startY = Math.max(fallbackY, baselineY - ((rowCount - 1) * yGap) / 2);
    sorted.forEach((node, index) => {
      positioned.set(node.id, {
        x: baseX + (index % columnCount) * xGap,
        y: startY + Math.floor(index / columnCount) * yGap
      });
    });
  } else {
    const depthMemo = new Map<string, number>();
    const depthForNode = (nodeId: string, stack: Set<string> = new Set()): number => {
      const cached = depthMemo.get(nodeId);
      if (cached !== undefined) return cached;
      if (stack.has(nodeId)) return 0;
      stack.add(nodeId);
      const parents = [...(createdParents.get(nodeId) ?? [])];
      const depth = parents.length ? 1 + Math.max(...parents.map((parentId) => depthForNode(parentId, stack))) : 0;
      stack.delete(nodeId);
      depthMemo.set(nodeId, depth);
      return depth;
    };

    const columns = new Map<number, ArchicodeNode[]>();
    for (const node of createdNodes) {
      const depth = depthForNode(node.id);
      const column = columns.get(depth) ?? [];
      column.push(node);
      columns.set(depth, column);
    }

    const sortedDepths = [...columns.keys()].sort((left, right) => left - right);
    for (const depth of sortedDepths) {
      const columnNodes = columns.get(depth) ?? [];
      const ranked = columnNodes
        .map((node) => {
          const explicitYTargets = desiredAnchorY.get(node.id) ?? [];
          const parentTargets = [...(createdParents.get(node.id) ?? [])]
            .map((parentId) => positioned.get(parentId)?.y)
            .filter((value): value is number => typeof value === "number");
          const targets = [...explicitYTargets, ...parentTargets];
          return {
            node,
            desiredY: targets.length ? average(targets) : baselineY
          };
        })
        .sort((left, right) => left.desiredY === right.desiredY
          ? left.node.title.localeCompare(right.node.title)
          : left.desiredY - right.desiredY);
      const columnCenterY = average(ranked.map((item) => item.desiredY));
      const startY = columnCenterY - ((ranked.length - 1) * yGap) / 2;
      ranked.forEach((item, index) => {
        positioned.set(item.node.id, {
          x: baseX + depth * xGap,
          y: startY + index * yGap
        });
      });
    }
  }

  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const nextPosition = positioned.get(node.id);
      if (!nextPosition) return node;
      return {
        ...node,
        position: nextPosition,
        updatedAt: stampForGraphMutation()
      };
    }),
    updatedAt: iso()
  };
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stampForGraphMutation(): string {
  return new Date().toISOString();
}

export type CodebaseMappingInput = {
  projectRoot: string;
  providerId?: string;
  levels: CodebaseMappingLevel;
  detail: CodebaseMappingDetail;
  reviewEffort?: "light" | "balanced" | "deep" | "ultra";
  granularity?: CodebaseMappingGranularity;
  codebaseHints?: string[];
  onProgress?: (progress: CodebaseMappingProgress) => void;
  shouldCancel?: () => boolean;
};

export async function mapExistingCodebase(input: CodebaseMappingInput): Promise<CodebaseMappingResult> {
  return mapExistingCodebaseHybrid(input);
}

export type ResyncExistingCodebaseInput = {
  projectRoot: string;
  providerId?: string;
  scope?: ResyncScope;
  onProgress?: (progress: ResyncProgress) => void;
  shouldCancel?: () => boolean;
};

export async function resyncExistingCodebase(input: ResyncExistingCodebaseInput): Promise<ResyncResult> {
  const bundle = await loadProject(input.projectRoot);
  const providerId = input.providerId ?? bundle.project.settings.providers.find((provider) => provider.enabled)?.id;
  const provider = bundle.project.settings.providers.find((candidate) => candidate.id === providerId);
  const hydratedProvider = provider && provider.kind !== "offline-manual" ? await hydrateProviderForUse(provider) : null;
  return runCodebaseResync({
    projectRoot: input.projectRoot,
    scope: input.scope,
    shouldCancel: input.shouldCancel,
    onProgress: input.onProgress,
    provider: provider ? {
      label: provider.label,
      kind: provider.kind,
      ...(hydratedProvider?.model?.trim() ? { model: hydratedProvider.model.trim() } : {})
    } : null,
    ...(hydratedProvider ? {
      callProvider: (() => {
        const cacheSessionId = id("resync-session");
        return (prompt: string, callOptions?: { signal?: AbortSignal; onActivity?: () => void; stableContext?: string }) => callResearchProvider(hydratedProvider, prompt, {
          projectRoot: input.projectRoot,
          signal: callOptions?.signal,
          cacheSessionId,
          onToken: () => callOptions?.onActivity?.(),
          webSearchEnabled: false,
          scopeContext: callOptions?.stableContext ?? "",
          sessionSummary: "",
          messages: [],
          imageAttachments: []
        });
      })()
    } : {})
  });
}

/**
 * Generic research operations intentionally reject nodes that are born approved.
 * Imported nodes describe an implementation that already exists, but they still pass
 * through that safety boundary in a temporary draft state. The importer promotes them
 * only after every operation has applied and the persisted flows are normalized.
 */
export function prepareCodebaseImportOperationForApplication(operation: ResearchOperation): ResearchOperation {
  if (operation.kind === "create-node") {
    return { ...operation, node: { ...operation.node, stage: "draft" } };
  }
  if (operation.kind === "create-flow") {
    return {
      ...operation,
      flow: {
        ...operation.flow,
        nodes: operation.flow.nodes.map((node) => ({ ...node, stage: "draft" }))
      }
    };
  }
  return operation;
}

/**
 * Apply importer-only graph operations to one in-memory snapshot. Unlike generic
 * research changes, this is atomic and writes each affected flow only once.
 */
export function materializeCodebaseMapOperations(bundle: ProjectBundle, operations: ResearchOperation[]): { flows: Flow[]; operationIndexes: number[] } {
  const byId = new Map(bundle.flows.map((flow) => [flow.id, structuredClone(flow)]));
  const changedIds: string[] = [];
  const markChanged = (flowId: string): void => {
    if (!changedIds.includes(flowId)) changedIds.push(flowId);
  };
  const flowFor = (flowId: string): Flow => {
    const flow = byId.get(flowId);
    if (!flow) throw new Error(`Flow ${flowId} was not found.`);
    return flow;
  };
  const ordered = orderCodebaseMapOperations(operations);
  for (const { operation: original } of ordered) {
    const operation = prepareCodebaseImportOperationForApplication(original);
    if (operation.kind === "create-flow") {
      if (byId.has(operation.flow.id)) throw new Error(`Flow ${operation.flow.id} already exists.`);
      const flow = flowSchema.parse(operation.flow);
      byId.set(flow.id, flow);
      markChanged(flow.id);
      continue;
    }
    if (operation.kind === "update-flow") {
      const flow = flowFor(operation.flowId);
      const name = operation.patch.name === undefined ? flow.name : operation.patch.name.trim();
      if (!name) throw new Error("Flow name cannot be empty.");
      byId.set(flow.id, flowSchema.parse({
        ...flow,
        name,
        description: operation.patch.description === undefined ? flow.description : operation.patch.description.trim(),
        perspective: operation.patch.perspective ?? flow.perspective,
        updatedAt: iso()
      }));
      markChanged(flow.id);
      continue;
    }
    if (operation.kind === "create-group") {
      const flow = flowFor(operation.flowId);
      const group = flowGroupSchema.parse({ ...operation.group, id: operation.group.id ?? id("group") });
      if (flow.groups.some((item) => item.id === group.id)) throw new Error(`Group ${group.id} already exists.`);
      flow.groups.push(group);
      markChanged(flow.id);
      continue;
    }
    if (operation.kind === "create-subflow") {
      const flow = flowFor(operation.flowId);
      const subflow = flowSubflowSchema.parse({ ...operation.subflow, id: operation.subflow.id ?? id("subflow") });
      if (flow.subflows.some((item) => item.id === subflow.id)) throw new Error(`Subflow ${subflow.id} already exists.`);
      if (subflow.parentNodeId && !flow.nodes.some((node) => node.id === subflow.parentNodeId)) throw new Error(`Parent node ${subflow.parentNodeId} was not found.`);
      if (subflow.parentSubflowId && !flow.subflows.some((item) => item.id === subflow.parentSubflowId)) throw new Error(`Parent subflow ${subflow.parentSubflowId} was not found.`);
      flow.subflows.push(subflow);
      markChanged(flow.id);
      continue;
    }
    if (operation.kind === "create-node") {
      const flow = flowFor(operation.flowId);
      const nodeId = operation.node.id ?? id("node");
      if (flow.nodes.some((node) => node.id === nodeId)) throw new Error(`Node ${nodeId} already exists.`);
      if (operation.node.subflowId && !flow.subflows.some((subflow) => subflow.id === operation.node.subflowId)) throw new Error(`Subflow ${operation.node.subflowId} was not found.`);
      if (operation.node.groupId && !flow.groups.some((group) => group.id === operation.node.groupId)) throw new Error(`Group ${operation.node.groupId} was not found.`);
      const node = archicodeNodeSchema.parse({
        ...operation.node,
        id: nodeId,
        position: operation.node.position && "x" in operation.node.position ? operation.node.position : { x: 120 + flow.nodes.length * 36, y: 120 + flow.nodes.length * 28 },
        flags: [...new Set([...(operation.node.flags ?? []), "changed"])],
        ...(operation.node.implementationScope ? { implementationScope: { ...operation.node.implementationScope, checkedAt: iso() } } : {}),
        updatedAt: iso()
      });
      flow.nodes.push(node);
      markChanged(flow.id);
      continue;
    }
    if (operation.kind === "create-edge") {
      const flow = flowFor(operation.flowId);
      if (!flow.nodes.some((node) => node.id === operation.edge.source)) throw new Error(`Source node ${operation.edge.source} was not found.`);
      if (!flow.nodes.some((node) => node.id === operation.edge.target)) throw new Error(`Target node ${operation.edge.target} was not found.`);
      if (operation.edge.source === operation.edge.target) throw new Error("Research edge cannot connect a node to itself.");
      const edge = flowEdgeSchema.parse({ ...operation.edge, id: operation.edge.id ?? id("edge") });
      if (flow.edges.some((item) => item.id === edge.id)) throw new Error(`Edge ${edge.id} already exists.`);
      if (flow.edges.some((item) => item.source === edge.source && item.target === edge.target)) throw new Error(`Edge ${edge.source} -> ${edge.target} already exists.`);
      flow.edges.push(edge);
      markChanged(flow.id);
      continue;
    }
    throw new Error(`Unsupported codebase-import batch operation: ${operation.kind}`);
  }
  return {
    flows: changedIds.map((flowId) => flowSchema.parse({ ...flowFor(flowId), updatedAt: iso() })),
    operationIndexes: ordered.map((item) => item.operationIndex)
  };
}

async function mapExistingCodebaseHybrid(input: CodebaseMappingInput): Promise<CodebaseMappingResult> {
  const mappingStartedAtMs = Date.now();
  const totalSteps = 10;
  const emitProgress = (step: number, label: string, detail?: string, extra?: Partial<CodebaseMappingProgress>): void => {
    input.onProgress?.({ projectRoot: input.projectRoot, step, totalSteps, label, detail, ...extra });
  };
  try {
    emitProgress(1, "Inspecting project files", "Scanning the repository and reading real import statements.");
    const bundle = await loadProject(input.projectRoot);
    const providerId = input.providerId ?? bundle.project.settings.providers.find((provider) => provider.enabled)?.id;
    const provider = bundle.project.settings.providers.find((item) => item.id === providerId);
    if (!provider || provider.kind === "offline-manual") {
      throw new Error("Choose an LLM provider before mapping an existing codebase.");
    }
    const flow = bundle.flows.find((item) => item.id === bundle.project.activeFlowId) ?? bundle.flows[0];
    if (!flow) throw new Error("The project does not have a flow to map.");

    const hydratedProvider = await hydrateProviderForUse(provider);
    const importCacheSessionId = id("import-session");
    const callProvider: NonNullable<CodebaseImportInput["callProvider"]> = (prompt, callOptions) => callResearchProvider(hydratedProvider, prompt, {
      projectRoot: input.projectRoot,
      signal: callOptions?.signal,
      cacheSessionId: importCacheSessionId,
      onToken: () => callOptions?.onActivity?.(),
      webSearchEnabled: false,
      scopeContext: callOptions?.stableContext ?? "",
      sessionSummary: "",
      messages: [],
      imageAttachments: []
    });

    const stepForPhase: Record<string, number> = { scan: 1, parse: 2, semantic: 3, resolve: 3, cluster: 4, annotate: 5, emit: 6, review: 7, verify: 8 };
    const labelDetail = (progress: { phase?: string; detail?: string; itemsDone?: number; itemsTotal?: number }): string | undefined =>
      progress.detail ?? (progress.itemsDone !== undefined && progress.itemsTotal !== undefined
        ? `${progress.itemsDone.toLocaleString()} / ${progress.itemsTotal.toLocaleString()} ${progress.phase === "semantic" ? "semantic items" : "files"}`
        : progress.itemsDone !== undefined
          ? `${progress.itemsDone.toLocaleString()} files`
          : undefined);
    const outcome = await runCodebaseImport({
      projectRoot: input.projectRoot,
      flowId: flow.id,
      provider: {
        id: hydratedProvider.id,
        kind: hydratedProvider.kind,
        ...(hydratedProvider.model?.trim() ? { model: hydratedProvider.model.trim() } : {})
      },
      levels: input.levels,
      detail: input.detail,
      reviewEffort: input.reviewEffort ?? "balanced",
      granularity: input.granularity ?? "module",
      codebaseHints: input.codebaseHints ?? [],
      semanticEnabled: bundle.project.settings.semanticIndex.enabled,
      persistKnowledgeSnapshot: true,
      callProvider,
      shouldCancel: input.shouldCancel,
      onProgress: (progress) => emitProgress(stepForPhase[progress.phase] ?? 5, progress.label, labelDetail(progress), {
        phase: progress.phase,
        itemsDone: progress.itemsDone,
        itemsTotal: progress.itemsTotal
      })
    });

    if (input.shouldCancel?.()) throw new CodebaseImportCancelledError();
    const emittedNodeCount = outcome.operations.reduce((count, operation) => count
      + (operation.kind === "create-node" ? 1 : operation.kind === "create-flow" ? operation.flow.nodes.length : 0), 0);
    const emittedEdgeCount = outcome.operations.reduce((count, operation) => count
      + (operation.kind === "create-edge" ? 1 : operation.kind === "create-flow" ? operation.flow.edges.length : 0), 0);
    emitProgress(
      9,
      "Applying graph changes",
      `Writing ${outcome.flowIds.length} flows with ${emittedNodeCount.toLocaleString()} nodes and ${emittedEdgeCount.toLocaleString()} evidence-backed relationships.`
    );
    const bundleBeforeApply = await loadProject(input.projectRoot);
    const materialized = materializeCodebaseMapOperations(bundleBeforeApply, outcome.operations);
    // Import records describe architecture that already exists in source. Keep
    // them as implemented history rather than exposing them as work waiting to
    // be built after the importer has accepted the transaction.
    let bundleAfterApply = await saveFlows(input.projectRoot, materialized.flows, {
      recordGraphChanges: true,
      actor: "accepted-research",
      graphChangeStatus: "implemented"
    });
    const appliedIndexSet = new Set(materialized.operationIndexes);
    const results: ResearchGraphChangeResult[] = outcome.operations.map((_operation, operationIndex) => ({
      operationIndex,
      status: appliedIndexSet.has(operationIndex) ? "applied" : "failed",
      message: appliedIndexSet.has(operationIndex) ? "Applied successfully in the atomic import transaction." : "Operation was not included in the import transaction."
    }));
    const applied = results.filter((result) => result.status === "applied").length;
    const failed = results.filter((result) => result.status === "failed").length;
    const appliedIndexes = new Set(results.filter((result) => result.status === "applied").map((result) => result.operationIndex));
    const appliedNodeCount = outcome.operations.reduce((count, operation, index) => !appliedIndexes.has(index) ? count : count
      + (operation.kind === "create-node" ? 1 : operation.kind === "create-flow" ? operation.flow.nodes.length : 0), 0);
    const appliedEdgeCount = outcome.operations.reduce((count, operation, index) => !appliedIndexes.has(index) ? count : count
      + (operation.kind === "create-edge" ? 1 : operation.kind === "create-flow" ? operation.flow.edges.length : 0), 0);
    const appliedPerspectiveFlowCount = outcome.operations.filter((operation, index) => appliedIndexes.has(index) && operation.kind === "create-flow").length;
    if (!applied) {
      throw new Error(`Codebase map did not apply cleanly. ${results.filter((result) => result.status === "failed").map((result) => result.message).join(" ")}`.trim());
    }
    if (failed) {
      const failureSummary = [...new Set(results.filter((result) => result.status === "failed").map((result) => result.message))].slice(0, 5).join(" ");
      throw new Error(`Codebase map stopped before layout because ${failed} graph operation${failed === 1 ? "" : "s"} failed to apply. ${failureSummary}`.trim());
    }

    const persistedFlowIds = new Set(bundleAfterApply.flows.map((item) => item.id));
    const missingFlowIds = outcome.flowIds.filter((flowId) => !persistedFlowIds.has(flowId));
    if (missingFlowIds.length) {
      throw new Error(`Codebase map stopped before layout because generated flow${missingFlowIds.length === 1 ? "" : "s"} ${missingFlowIds.join(", ")} ${missingFlowIds.length === 1 ? "was" : "were"} not persisted.`);
    }

    emitProgress(9, "Laying out imported map", `Arranging ${applied} applied graph change${applied === 1 ? "" : "s"} by dependency order.`);
    const normalizedFlows = outcome.flowIds.map((generatedFlowId) => {
      const flow = findFlow(bundleAfterApply, generatedFlowId);
      const enriched = enrichImportedNodes(pruneEmptyImportedSubflows(flow), (input.codebaseHints ?? []).length ? input.codebaseHints ?? [] : bundleAfterApply.project.settings.stackAssumptions);
      return normalizeEvidenceFlow(layoutImportedFlow(enriched));
    });
    bundleAfterApply = await saveFlows(input.projectRoot, normalizedFlows);

    // The empty onboarding workspace starts with generic fixture metadata. Once
    // repository analysis has produced an evidence-backed project node, replace
    // that placeholder so future agents are not told this is an Electron/React
    // project when the imported repository uses another stack.
    const importedEvidenceFlow = normalizedFlows.find((generatedFlow) => generatedFlow.id === flow.id);
    if (importedEvidenceFlow) bundleAfterApply = await updateProjectMetadata(input.projectRoot, importedProjectMetadata(input.projectRoot, importedEvidenceFlow));

    emitProgress(10, "Refreshing run targets", "Running deterministic runtime target detection and provider reconciliation.");
    let finalBundle: ProjectBundle;
    let runtimeTargetNote = "";
    let runtimeTargetError: string | null = null;
    const runtimeSetupProviderCalls = { total: 0, retries: 0, failed: 0, rejected: 0 };
    try {
      const reconciliation = await reconcileRuntimeProfilesWithLlm(
        input.projectRoot,
        provider.id,
        "codebase-import",
        `codebase-import-${Date.now().toString(36)}`,
        undefined,
        (event) => {
          if (event.kind === "rejected") {
            runtimeSetupProviderCalls.rejected += 1;
            return;
          }
          runtimeSetupProviderCalls.total += 1;
          if (event.retry) runtimeSetupProviderCalls.retries += 1;
          if (event.kind === "failed") runtimeSetupProviderCalls.failed += 1;
        }
      );
      finalBundle = reconciliation.bundle;
      runtimeTargetNote = reconciliation.proposal
        ? " Runtime target updates were applied."
        : reconciliation.skippedReason
          ? ` ${reconciliation.skippedReason}`
          : " Runtime targets are up to date.";
    } catch (error) {
      finalBundle = await refreshInferredProjectCommands(input.projectRoot);
      runtimeTargetError = error instanceof Error ? error.message : String(error);
      runtimeTargetNote = ` Runtime target reconciliation failed; deterministic targets were refreshed. ${runtimeTargetError}`;
    }

    const statsText = `Mapped ${outcome.stats.filesScanned.toLocaleString()} files and ${outcome.stats.fileEdges.toLocaleString()} real import links (${Math.round(outcome.stats.resolutionRate * 100)}% resolved).`;
    const qualityText = outcome.stats.quality
      ? ` Coverage ${Math.round(outcome.stats.quality.sourceCoverage * 100)}%; ${outcome.perspectiveFlowIds.length} architecture perspective flow${outcome.perspectiveFlowIds.length === 1 ? "" : "s"}; ${outcome.stats.quality.cycleCount} dependency cycle${outcome.stats.quality.cycleCount === 1 ? "" : "s"}.`
      : "";
    const degradedText = outcome.stats.degraded.length ? ` ${outcome.stats.degraded.join(" ")}` : "";
    const reviewText = outcome.stats.review
      ? ` Agentic review inspected ${outcome.stats.review.reviewedUnits}/${outcome.stats.review.totalUnits} partitions and safely applied ${outcome.stats.review.appliedEdits} grounded edit${outcome.stats.review.appliedEdits === 1 ? "" : "s"}.`
      : "";
    const failedText = failed ? ` ${failed} operation${failed === 1 ? "" : "s"} failed to apply.` : "";
    const message = `Created one evidence flow and ${appliedPerspectiveFlowCount} architecture perspective flow${appliedPerspectiveFlowCount === 1 ? "" : "s"} with ${appliedNodeCount.toLocaleString()} nodes and ${appliedEdgeCount.toLocaleString()} relationships. ${statsText}${qualityText}${reviewText}${failedText}${degradedText}${runtimeTargetNote}`;
    const failedProviderCalls = outcome.stats.architectureProvider?.calls.filter((call) => call.status === "failed") ?? [];
    const errors = [
      ...failedProviderCalls.map((call) => `${call.purpose}: ${call.error ?? "Provider call failed."}`),
      ...(runtimeTargetError ? [`Runtime target reconciliation: ${runtimeTargetError}`] : []),
      ...(failed ? [`${failed} graph operation${failed === 1 ? "" : "s"} failed to apply.`] : [])
    ];
    const report = buildImportSummarySections({
      safeguards: outcome.stats.safeguards,
      degraded: outcome.stats.degraded,
      qualityWarnings: outcome.stats.quality?.warnings,
      review: outcome.stats.review
    });
    const providerCalls = summarizeImportProviderCalls({
      architectureCalls: outcome.stats.architectureProvider?.calls,
      review: outcome.stats.review,
      runtimeSetup: runtimeSetupProviderCalls
    });
    const summary: CodebaseMappingSummary = {
      reportId: outcome.stats.provenance?.runId ?? `import-report-${Date.now().toString(36)}`,
      status: importSummaryStatus({
        errors,
        operationsFailed: failed,
        reviewStatus: outcome.stats.review?.status,
        limitations: report.limitations
      }),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - mappingStartedAtMs,
      provider: {
        label: provider.label,
        kind: provider.kind,
        ...(hydratedProvider.model?.trim() ? { model: hydratedProvider.model.trim() } : {})
      },
      settings: {
        levels: input.levels,
        detail: input.detail,
        reviewEffort: input.reviewEffort ?? "balanced",
        granularity: input.granularity ?? "module"
      },
      files: {
        scanned: outcome.stats.filesScanned,
        parsed: outcome.stats.filesParsed,
        importLinks: outcome.stats.fileEdges,
        resolutionRate: outcome.stats.resolutionRate
      },
      graph: {
        flows: outcome.flowIds.length,
        perspectiveFlows: appliedPerspectiveFlowCount,
        nodes: appliedNodeCount,
        relationships: appliedEdgeCount,
        operationsApplied: applied,
        operationsFailed: failed
      },
      ...(outcome.stats.review ? {
        review: {
          status: outcome.stats.review.status,
          reviewedUnits: outcome.stats.review.reviewedUnits,
          selectedUnits: outcome.stats.review.totalUnits,
          possibleUnits: outcome.stats.review.totalPlannedUnits,
          appliedEdits: outcome.stats.review.appliedEdits,
          rejectedBatches: outcome.stats.review.rejectedBatches,
          unresolvedCount: countActionableReviewConcerns(outcome.stats.review.unresolved),
          reportedUnresolvedCount: outcome.stats.review.unresolved.length,
          reviewedSourceFiles: outcome.stats.review.reviewedSourceFiles.length,
          totalReviewSourceFiles: outcome.stats.review.totalSourceFiles
        }
      } : {}),
      providerCalls,
      phaseTimings: (outcome.stats.phaseTimings ?? []).map(({ phase, label, durationMs }) => ({ phase, label, durationMs })),
      accuracyEstimate: estimateImportAccuracy({
        quality: outcome.stats.quality,
        resolutionRate: outcome.stats.resolutionRate,
        reviewEffort: input.reviewEffort ?? "balanced",
        review: outcome.stats.review ? {
          reviewedUnits: outcome.stats.review.reviewedUnits,
          selectedUnits: outcome.stats.review.totalUnits,
          possibleUnits: outcome.stats.review.totalPlannedUnits,
          status: outcome.stats.review.status
        } : undefined,
        operationsApplied: applied,
        operationsFailed: failed
      }),
      report,
      warnings: report.limitations,
      errors
    };
    try {
      const baseline = await createResyncBaseline({
        projectRoot: input.projectRoot,
        bundle: finalBundle,
        analysis: outcome.analysisSnapshot,
        settings: {
          levels: input.levels,
          detail: input.detail,
          reviewEffort: input.reviewEffort ?? "balanced",
          granularity: input.granularity ?? "module"
        },
        importerFlowIds: outcome.flowIds
      });
      await writeResyncBaseline(input.projectRoot, baseline);
    } catch (error) {
      summary.errors.push(`Incremental synchronization metadata could not be initialized: ${error instanceof Error ? error.message : String(error)}. The first resync will bootstrap it conservatively.`);
    }
    try {
      await writeInitialCodebaseImportReport(input.projectRoot, summary);
    } catch (error) {
      summary.errors.push(`The initial import report could not be saved for reopening: ${error instanceof Error ? error.message : String(error)}`);
    }
    emitProgress(10, "Import complete", message);
    return { bundle: finalBundle, applied, failed, message, summary };
  } catch (error) {
    if (error instanceof CodebaseImportCancelledError) {
      emitProgress(totalSteps, "Import cancelled", "The codebase import was stopped before completion. Semantic indexing progress was saved and will be reused next time.");
      throw error;
    }
    emitProgress(totalSteps, "Import failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function orderCodebaseMapOperations(operations: ResearchOperation[]): Array<{ operationIndex: number; operation: ResearchOperation }> {
  const pending = operations.map((operation, operationIndex) => ({ operation, operationIndex }));
  const emitted = new Set<number>();
  const createdNodes = new Set<string>();
  const createdSubflows = new Set<string>();
  const ordered: Array<{ operationIndex: number; operation: ResearchOperation }> = [];
  const emitWhere = (predicate: (operation: ResearchOperation) => boolean): boolean => {
    let emittedAny = false;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const item of pending) {
        if (emitted.has(item.operationIndex) || !predicate(item.operation)) continue;
        emitted.add(item.operationIndex);
        ordered.push(item);
        if (item.operation.kind === "create-node" && item.operation.node.id) createdNodes.add(item.operation.node.id);
        if (item.operation.kind === "create-subflow" && item.operation.subflow.id) createdSubflows.add(item.operation.subflow.id);
        progressed = true;
        emittedAny = true;
      }
    }
    return emittedAny;
  };

  emitWhere((operation) => operation.kind === "create-flow");
  emitWhere((operation) => operation.kind === "update-flow");
  emitWhere((operation) => operation.kind === "create-group");
  emitWhere((operation) => operation.kind === "create-node" && !operation.node.subflowId);
  let progressed = true;
  while (progressed) {
    const emittedSubflows = emitWhere((operation) => {
      if (operation.kind !== "create-subflow") return false;
      const parentNodeReady = !operation.subflow.parentNodeId || createdNodes.has(operation.subflow.parentNodeId);
      const parentSubflowReady = !operation.subflow.parentSubflowId || createdSubflows.has(operation.subflow.parentSubflowId);
      return parentNodeReady && parentSubflowReady;
    });
    const emittedNodes = emitWhere((operation) => operation.kind === "create-node" && Boolean(operation.node.subflowId && createdSubflows.has(operation.node.subflowId)));
    progressed = emittedSubflows || emittedNodes;
  }
  emitWhere((operation) => operation.kind === "create-subflow" || operation.kind === "create-node");
  emitWhere((operation) => operation.kind === "create-edge");
  emitWhere((operation) => operation.kind === "add-note" || operation.kind === "update-node");
  emitWhere(() => true);

  return ordered;
}

function pruneEmptyImportedSubflows(flow: Flow): Flow {
  const nodeCounts = new Map<string, number>();
  for (const node of flow.nodes) {
    if (node.subflowId) nodeCounts.set(node.subflowId, (nodeCounts.get(node.subflowId) ?? 0) + 1);
  }
  const keptSubflowIds = new Set(flow.subflows.filter((subflow) => nodeCounts.get(subflow.id)).map((subflow) => subflow.id));
  if (keptSubflowIds.size === flow.subflows.length) return flow;
  return {
    ...flow,
    subflows: flow.subflows
      .filter((subflow) => keptSubflowIds.has(subflow.id))
      .map((subflow) => subflow.parentSubflowId && !keptSubflowIds.has(subflow.parentSubflowId)
        ? { ...subflow, parentSubflowId: undefined }
        : subflow),
    updatedAt: iso()
  };
}

export function enrichImportedNodes(flow: Flow, stackHints: string[]): Flow {
  const normalizedStack = stackHints.filter(Boolean);
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const techStack = node.techStack.length ? node.techStack : inferredTechStackForNode(node, normalizedStack);
      const acceptanceCriteria = node.acceptanceCriteria.length ? node.acceptanceCriteria : inferredAcceptanceCriteriaForNode(node);
      const description = node.description.trim() || inferredDescriptionForNode(node, techStack);
      const stage = "draft-approved-production" as const;
      // `changed` is a temporary safety flag while the importer applies draft
      // graph operations. Imported nodes represent implementation that already
      // exists, so it must not survive the final Production promotion.
      const flags = node.flags.filter((flag) => flag !== "changed");
      if (description === node.description && techStack === node.techStack && acceptanceCriteria === node.acceptanceCriteria && stage === node.stage && flags.length === node.flags.length) return node;
      return {
        ...node,
        description,
        stage,
        flags,
        techStack,
        acceptanceCriteria,
        updatedAt: iso()
      };
    }),
    updatedAt: iso()
  };
}

function inferredDescriptionForNode(node: ArchicodeNode, techStack: string[]): string {
  const stackText = techStack.length ? ` using ${techStack.slice(0, 3).join(", ")}` : "";
  return `${node.title} is a ${node.type} area identified in the existing codebase${stackText}. Review linked source modules before changing its behavior.`;
}

function inferredTechStackForNode(node: ArchicodeNode, stackHints: string[]): string[] {
  const title = `${node.title} ${node.type}`.toLowerCase();
  const inferred = stackHints.filter((hint) => {
    const lower = hint.toLowerCase();
    if (title.includes("ui") || title.includes("renderer") || title.includes("web") || title.includes("site")) {
      return /react|vue|vite|typescript|javascript|css|html/.test(lower);
    }
    if (title.includes("main") || title.includes("electron") || title.includes("process")) {
      return /electron|node|typescript|javascript/.test(lower);
    }
    if (title.includes("data") || title.includes("storage") || title.includes("asset")) {
      return /json|sqlite|prisma|file|filesystem|static/.test(lower);
    }
    return true;
  });
  return Array.from(new Set((inferred.length ? inferred : stackHints).slice(0, 4)));
}

function inferredAcceptanceCriteriaForNode(node: ArchicodeNode): string[] {
  return [
    `${node.title} responsibilities are represented by current source files`,
    `${node.title} relationships and data flow are visible in the map`,
    `Future changes to ${node.title} can be verified against existing project commands`
  ];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function defaultTitleForScope(bundle: ProjectBundle, scope: ResearchChatScope): string {
  if (scope.type === "project") return `Project research: ${bundle.project.name}`;
  const flow = bundle.flows.find((item) => item.id === scope.flowId);
  if (scope.type === "flow") return `Flow research: ${flow?.name ?? scope.flowId}`;
  if (scope.type === "subflow") {
    const subflow = flow?.subflows.find((item) => item.id === scope.subflowId);
    return `Subflow research: ${subflow?.name ?? scope.subflowId}`;
  }
  const node = flow?.nodes.find((item) => item.id === scope.nodeId);
  return `Node research: ${node?.title ?? scope.nodeId}`;
}

function titleFromMessage(content: string): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  return cleaned.length > 56 ? `${cleaned.slice(0, 55)}...` : cleaned || "Research chat";
}

function compactSummary(previous: string, next: string | undefined, answer: string): string {
  if (next?.trim()) return next.trim().slice(0, 5000);
  const merged = [previous, answer.replace(/\s+/g, " ").slice(0, 600)].filter(Boolean).join("\n");
  return merged.slice(-5000);
}
