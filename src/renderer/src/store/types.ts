import { create } from "zustand";
import type {
  ArchicodeNode,
  Artifact,
  Note,
  DebugIncident,
  Flow,
  FlowEdge,
  LlmPatchProposal,
  NodePatch,
  NodeStage,
  PatchOperationDecision,
  PatchReviewRecord,
  ProjectBundle,
  ProjectSettings,
  ResearchChatScope,
  ResearchChatSession,
  ResearchCanvasAction,
  ResearchCanvasViewportAction,
  ResearchGraphChangeDecision,
  ResearchGraphChangeResult,
  RunGuidance,
  RunEffort,
  RunScope,
  Run,
  RuntimeService,
  SpeechSettings,
  TtsSettings
} from "@shared/schema";
import type {
  GitOperationResult,
  GitStatus,
  ProjectFileBrowserData,
  ProjectFileDiff,
  ProjectFileText
} from "@shared/projectTools";
import type { GraphHistoryEntry, GraphHistoryVersion } from "@shared/graphHistory";
import type { CodebaseMappingSummary } from "../../../preload";
import type {
  CreateProjectSkillInput,
  McpImportSource,
  McpRefreshResult,
  McpRegistryEntry,
  McpRegistryInstallInput,
  McpRegistryInstallResult,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpServerView,
  ProjectSkill
} from "@shared/capabilities";
import type { ExternalProjectUpdatePayload, ProviderHealthResult, RecentProjectEntry } from "../../../preload";
import { applyNodePatch } from "@shared/schema";
import { createSeedProject } from "@shared/fixtures";
import { autoLayoutFlow, deleteSubflowFromFlow, duplicateNode, isSubflowIgnored, linkNodeToSubflow, reparentSubflowInFlow } from "@shared/graph";
import type { ProjectTemplateId } from "@shared/templates";
import { getOpenQuestionsForScope, type OpenQuestionItem } from "../utils/nodeSignals";
import { isRunBlockingNewChange } from "../utils/runStatus";
import { mergeResearchSessionsPreservingOptimistic } from "../utils/researchSessions";
import { isResearchThinkingPhrase, pickRandomResearchThinkingPhrase } from "@shared/researchPersonality";
import type { ResearchMessageNodeReference } from "@shared/schema";
import {
  DEFAULT_BINDINGS,
  isReservedAction,
  sanitizeStoredBindings,
  type ActionId,
  type KeyChord
} from "../utils/keybindings";

import type { StoreApi } from "zustand";

export type ComposerMention = { flowId: string; nodeId: string };
export type ComposerSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; flowId: string; nodeId: string };

export function composerHasContent(segments: ComposerSegment[]): boolean {
  return segments.some((segment) => segment.kind === "mention" || (segment.kind === "text" && segment.text.trim().length > 0));
}

export function composerDraftText(segments: ComposerSegment[], bundle: ProjectBundle | null): string {
  return segments.map((segment) => {
    if (segment.kind === "text") return segment.text;
    if (bundle) {
      const flow = bundle.flows.find((item) => item.id === segment.flowId);
      const node = flow?.nodes.find((item) => item.id === segment.nodeId);
      if (node) return `@${node.title}`;
    }
    return "@(missing node)";
  }).join("");
}

export function serializeComposerDraft(segments: ComposerSegment[], bundle: ProjectBundle | null): {
  message: string;
  referencedNodeIds: ComposerMention[];
  missingCount: number;
} {
  const referencedNodeIds: ComposerMention[] = [];
  let missingCount = 0;
  let message = "";
  for (const segment of segments) {
    if (segment.kind === "text") {
      message += segment.text;
      continue;
    }
    const flow = bundle?.flows.find((item) => item.id === segment.flowId);
    const node = flow?.nodes.find((item) => item.id === segment.nodeId);
    if (node) {
      message += `@${node.title}`;
      referencedNodeIds.push({ flowId: segment.flowId, nodeId: segment.nodeId });
    } else {
      missingCount += 1;
    }
  }
  return { message, referencedNodeIds, missingCount };
}


export type QueuedResearchMessage = {
  id: string;
  content: string;
  filePaths: string[];
  referencedNodeIds: ResearchMessageNodeReference[];
  modelId?: string | null;
  createdAt: string;
};

export type ShellPrompt = {
  command: string;
  cwd?: string;
  env?: { name: string; value?: string }[];
  nodeId?: string;
  promptSummary: string;
} | null;

export type AgentRunInput = {
  nodeId?: string;
  scope?: RunScope;
  purpose?: "implement" | "build-discovery" | "run-discovery";
  effort?: RunEffort;
  promptSummary: string;
  command?: string;
  cwd?: string;
  env?: { name: string; value?: string }[];
  allowShell?: boolean;
  reusableApproval?: boolean;
  skipQuestionCheck?: boolean;
};

export type RunGuidanceInput = Partial<RunGuidance>;

export type BuildQuestionCheck = {
  input: AgentRunInput;
  questions: OpenQuestionItem[];
} | null;

export type NodeClipboard = {
  nodes: ArchicodeNode[];
  edges: FlowEdge[];
};

export type CodebaseOnboardingLevel = "1" | "2" | "3" | "4";
export type CodebaseOnboardingDetail = "light" | "balanced" | "deep";
export type CodebaseOnboardingReviewEffort = "light" | "balanced" | "deep" | "ultra";
export type CodebaseOnboardingGranularity = "system" | "module" | "component" | "file";
export type ProjectSettingsTab =
  | "general"
  | "providers"
  | "commands"
  | "agent-memory"
  | "security"
  | "context"
  | "policy"
  | "capabilities"
  | "advanced"
  | "shortcuts";
export type WorkbenchView = "graph" | "files";
export type GitOperationName = "pull" | "push" | "commit" | "switch";
export type CanvasViewport = { x: number; y: number; zoom: number };
export type UiScale = 75 | 100 | 125;

export type GraphNavigationRequest =
  | { requestId: number; kind: "project" }
  | { requestId: number; kind: "flow"; flowId: string }
  | { requestId: number; kind: "subflow"; flowId: string; subflowId: string }
  | { requestId: number; kind: "node"; flowId: string; nodeId: string }
  | { requestId: number; kind: "canvas"; flowId: string; subflowId: string | null; nodeIds: string[]; viewport: ResearchCanvasViewportAction };

export type FilePreviewRequest = {
  requestId: number;
  path: string;
  preferredTab?: "preview" | "diff";
  lineNumber?: number | null;
  matchText?: string | null;
  searchQuery?: string | null;
};

export type GraphNavigationTarget =
  | { kind: "project" }
  | { kind: "flow"; flowId: string }
  | { kind: "subflow"; flowId: string; subflowId: string }
  | { kind: "node"; flowId: string; nodeId: string };


export type CodebaseOnboarding = {
  rootPath: string;
  codebaseHints: string[];
  mapping: {
    status: string;
    /** Renderer timestamp used for the live elapsed-time indicator. */
    startedAtMs?: number;
    detail?: string;
    step?: number;
    totalSteps?: number;
    itemsDone?: number;
    itemsTotal?: number;
    completedAtMs?: number;
    result?: CodebaseMappingSummary;
    error: string | null;
  } | null;
};

export type ProjectSettingsRequest = {
  tab: ProjectSettingsTab;
  nonce: number;
};

export type RunProfileInput = {
  profileId?: string;
  command?: string;
  label?: string;
  cwd?: string;
  targetId?: string;
  allowShell?: boolean;
  reusableApproval?: boolean;
};

export type PatchProposalView = {
  artifact: Artifact;
  proposal: LlmPatchProposal | unknown;
  review: PatchReviewRecord | null;
  validationErrors: string[];
};

export type AppNotice = {
  tone: "warning";
  title: string;
  message: string;
};

export type ResearchStreamState = {
  kind: "answer" | "thinking";
};

// Ephemeral, in-flight view of a subagent run while respondToSubagentRun is
// executing (the persisted message is not reloaded until the whole op finishes).
// Keyed by messageId so a message can show a live merge card AND a live
// graph-reconciliation card that does not yet exist in the persisted message.
export type LiveSubagentActivity = {
  id: string;
  kind: "merge-resolution" | "graph-reconciliation" | "test-authoring" | "sherlock-research" | "delphi-testing";
  title: string;
  status: "running" | "completed" | "blocked" | "failed";
  lines: string[];
  artifacts: Array<{ id: string; label: string; path: string; mediaType: string }>;
  visuallyAnalyzedArtifactIds: string[];
};

export type LiveResearchActivity = {
  status: "running" | "completed" | "failed";
  lines: string[];
};

export type ArchicodeState = {
  rootPath: string;
  bundle: ProjectBundle | null;
  activeFlowId: string | null;
  selectedNodeId: string | null;
  selectedNodeIds: string[];
  selectedEdgeId: string | null;
  selectedRunId: string | null;
  activeSubflowId: string | null;
  searchQuery: string;
  nodeClipboard: NodeClipboard | null;
  loading: boolean;
  error: string | null;
  appNotice: AppNotice | null;
  shellPrompt: ShellPrompt;
  buildQuestionCheck: BuildQuestionCheck;
  codebaseOnboarding: CodebaseOnboarding | null;
  projectSettingsRequest: ProjectSettingsRequest | null;
  pendingRunKeys: string[];
  runtimeServices: RuntimeService[];
  patchProposals: PatchProposalView[];
  providerHealth: Record<string, ProviderHealthResult>;
  recentProjects: RecentProjectEntry[];
  projectSkills: ProjectSkill[];
  mcpServers: McpServerView[];
  mcpRegistryEntries: McpRegistryEntry[];
  mcpRegistryNextCursor: string | null;
  mcpRegistryCount: number;
  capabilityBusy: boolean;
  researchPanelOpen: boolean;
  researchSessions: ResearchChatSession[];
  selectedResearchSessionId: string | null;
  researchScope: ResearchChatScope | null;
  researchBusy: boolean;
  researchBusySessionIds: string[];
  // Nodes currently authoring/running acceptance tests, for animated progress on
  // their inspector buttons and graph cards while the (blocking) agent runs.
  busyTestNodeIds: string[];
  researchQueuedMessages: Record<string, QueuedResearchMessage[]>;
  // Source paths for attachments on optimistic user messages. Persisted chat
  // messages resolve their attachment labels through bundle.artifacts, but a
  // provider turn can run for minutes before that refreshed bundle is loaded.
  researchPendingAttachmentPaths: Record<string, string[]>;
  researchStreamStates: Record<string, ResearchStreamState>;
  // Live in-flight subagent activity, keyed by messageId → ordered runs.
  // Ephemeral: cleared once the persisted session reflects the final status.
  researchSubagentActivity: Record<string, LiveSubagentActivity[]>;
  // Live parent-agent continuation/tool activity for the same optimistic turn.
  researchChatActivity: Record<string, LiveResearchActivity>;
  researchDraft: ComposerSegment[];
  researchComposerFocusNonce: number;
  theme: "light" | "dark";
  uiScale: UiScale;
  keybindings: Record<ActionId, KeyChord>;
  keybindingsLoaded: boolean;
  keybindingsBusy: boolean;
  globalSpeechSettings: SpeechSettings | null;
  globalTtsSettings: TtsSettings | null;
  canvasViewport: CanvasViewport | null;
  canvasViewportCenter: { x: number; y: number } | null;
  lastAddNodePosition: { x: number; y: number } | null;
  lastAddNodeScope: string | null;
  graphNavigationRequest: GraphNavigationRequest | null;
  projectReloadNonce: number;
  workbenchView: WorkbenchView;
  gitStatus: GitStatus | null;
  gitLogs: GitOperationResult[];
  gitBusy: boolean;
  graphHistory: GraphHistoryVersion[];
  graphHistoryOpen: boolean;
  graphHistoryLoading: boolean;
  historicalInspection: { entry: GraphHistoryEntry; currentBundle: ProjectBundle } | null;
  fileBrowser: ProjectFileBrowserData | null;
  selectedFilePath: string | null;
  filePreviewRequest: FilePreviewRequest | null;
  filePreview: ProjectFileText | null;
  fileDiff: ProjectFileDiff | null;
  fileBusy: boolean;
  load: () => Promise<void>;
  reload: () => Promise<void>;
  openProjectFolder: () => Promise<void>;
  cloneGitRepository: (remoteUrl: string) => Promise<boolean>;
  openRecentProject: (projectRoot: string) => Promise<void>;
  revealProjectFolder: () => Promise<void>;
  openProjectInVsCode: () => Promise<void>;
  createProjectFromTemplate: (templateId: ProjectTemplateId) => Promise<void>;
  selectNode: (nodeId: string | null) => void;
  selectNodes: (nodeIds: string[], primaryNodeId?: string | null) => void;
  toggleNodeSelection: (nodeId: string) => void;
  selectEdge: (edgeId: string | null) => void;
  setActiveFlow: (flowId: string) => void;
  setActiveSubflow: (subflowId: string | null) => void;
  setSearchQuery: (query: string) => void;
  selectRun: (runId: string | null) => void;
  handleRunUpdated: (payload: { projectRoot: string; run: Run }) => void;
  handleExternalProjectUpdated: (payload: ExternalProjectUpdatePayload) => void;
  setShellPrompt: (prompt: ShellPrompt) => void;
  dismissCodebaseOnboarding: () => void;
  openInitialCodebaseImportReport: () => Promise<void>;
  startCodebaseOnboardingRun: (input: { levels: CodebaseOnboardingLevel; detail: CodebaseOnboardingDetail; reviewEffort: CodebaseOnboardingReviewEffort; granularity: CodebaseOnboardingGranularity }) => Promise<void>;
  cancelCodebaseOnboardingRun: () => Promise<void>;
  openProjectSettings: (tab?: ProjectSettingsTab) => void;
  clearProjectSettingsRequest: (nonce: number) => void;
  saveFlow: (flow: Flow) => Promise<ProjectBundle | null>;
  createFlow: () => Promise<void>;
  createSubflow: () => Promise<void>;
  renameSubflow: (subflowId: string, name: string) => Promise<void>;
  toggleSubflowIgnored: (subflowId: string) => Promise<void>;
  reparentSubflow: (subflowId: string, parentSubflowId: string | null) => Promise<void>;
  deleteSubflow: (subflowId: string) => Promise<void>;
  setNodeLinkedSubflow: (nodeId: string, subflowId: string | null) => Promise<void>;
  setCanvasViewport: (viewport: CanvasViewport | null) => void;
  setCanvasViewportCenter: (position: { x: number; y: number } | null) => void;
  navigateToGraphTarget: (target: GraphNavigationTarget) => void;
  applyResearchCanvasAction: (action: ResearchCanvasAction) => void;
  clearGraphNavigationRequest: (requestId: number) => void;
  setWorkbenchView: (view: WorkbenchView) => void;
  refreshGitStatus: () => Promise<void>;
  toggleGraphHistory: () => void;
  refreshGraphHistory: () => Promise<void>;
  inspectHistoricalGraph: (commit: string) => Promise<void>;
  exitHistoricalInspection: () => Promise<void>;
  initializeGitRepository: () => Promise<void>;
  runGitOperation: (operation: "pull" | "push") => Promise<void>;
  discardGitChanges: () => Promise<void>;
  stashGitChanges: (message?: string) => Promise<boolean>;
  popGitStash: (stashRef: string) => Promise<void>;
  commitGitFiles: (message: string, files: string[]) => Promise<void>;
  generateCommitMessage: (files: string[]) => Promise<string | null>;
  switchGitBranch: (branch: string) => Promise<void>;
  createGitBranch: (branch: string) => Promise<void>;
  refreshProjectFiles: () => Promise<void>;
  selectProjectFile: (
    relativePath: string | null,
    options?: { preferredTab?: "preview" | "diff"; lineNumber?: number | null; matchText?: string | null; searchQuery?: string | null }
  ) => Promise<void>;
  addNode: (kind?: string, options?: { position?: { x: number; y: number } }) => Promise<void>;
  copySelectedNode: () => void;
  cutSelectedNode: () => Promise<void>;
  pasteNode: () => Promise<void>;
  duplicateSelectedNode: () => Promise<void>;
  deleteSelectedNode: () => Promise<void>;
  addEdge: (targetId: string) => Promise<void>;
  rememberEdgeLabel: (label: string | null | undefined) => Promise<void>;
  updateSelectedEdge: (label: string) => Promise<void>;
  updateSelectedEdgePatch: (patch: Partial<Omit<FlowEdge, "id">>) => Promise<void>;
  deleteSelectedEdge: () => Promise<void>;
  autoLayout: () => Promise<void>;
  importFlow: () => Promise<void>;
  importDrawioFlow: (mode: "replace" | "append") => Promise<void>;
  exportActiveFlow: () => Promise<void>;
  exportActiveDrawioFlow: () => Promise<void>;
  exportProjectBundle: () => Promise<void>;
  exportProjectDocument: (flowIds: string[], format: "pdf" | "html") => Promise<boolean>;
  repairProject: () => Promise<void>;
  deleteProjectState: () => Promise<boolean>;
  updateNode: (patch: NodePatch, actor?: "user" | "llm") => Promise<void>;
  authorAcceptanceTests: (nodeId: string) => Promise<void>;
  authorAcceptanceTestsForFlow: () => Promise<void>;
  clearAcceptanceTests: (nodeId: string) => Promise<void>;
  runAcceptanceChecks: (nodeId: string) => Promise<void>;
  enhanceNodeField: (nodeId: string, field: "description" | "acceptanceCriteria") => Promise<string | null>;
  updateProjectDetails: (patch: { name: string }) => Promise<void>;
  updateSettings: (settings: ProjectSettings) => Promise<void>;
  checkProvider: (providerId: string) => Promise<void>;
  refreshCapabilities: () => Promise<void>;
  createProjectSkill: (input: CreateProjectSkillInput) => Promise<void>;
  searchMcpRegistry: (input: McpRegistrySearchInput, options?: { append?: boolean }) => Promise<McpRegistrySearchResult | null>;
  installMcpRegistryServer: (input: McpRegistryInstallInput) => Promise<McpRegistryInstallResult | null>;
  importMcpServers: (source: McpImportSource) => Promise<void>;
  updateMcpServer: (server: McpServerView) => Promise<void>;
  refreshMcpServerCapabilities: (serverId: string) => Promise<McpRefreshResult | null>;
  openResearchPanel: (scope?: ResearchChatScope) => Promise<void>;
  closeResearchPanel: () => void;
  setResearchScope: (scope: ResearchChatScope) => void;
  setResearchDraft: (segments: ComposerSegment[]) => void;
  appendResearchDraftMention: (mention: ComposerMention) => void;
  appendResearchDraftText: (text: string) => void;
  clearResearchDraft: () => void;
  requestResearchComposerFocus: () => void;
  handleResearchChatSessionUpdated: (payload: { projectRoot: string; session: ResearchChatSession }) => void;
  refreshResearchChats: () => Promise<void>;
  createResearchChat: (scope?: ResearchChatScope, modelId?: string) => Promise<ResearchChatSession | null>;
  forkResearchMessage: (messageId: string) => Promise<void>;
  startScopedResearchChat: (scope: ResearchChatScope, message: string) => Promise<void>;
  selectResearchChat: (sessionId: string | null) => void;
  archiveResearchChat: (sessionId: string) => Promise<void>;
  updateResearchChatAutoApproval: (autoApproveGraphChanges: ResearchChatSession["autoApproveGraphChanges"]) => Promise<void>;
  sendResearchMessage: (
    content: string,
    filePaths?: string[],
    approvedMcpServerIds?: string[],
    rejectedMcpServerIds?: string[],
    resumeApprovalMessageId?: string,
    referencedNodeIds?: ResearchMessageNodeReference[],
    modelId?: string | null
  ) => Promise<void>;
  retryResearchMessage: (assistantMessageId: string, approvedMcpServerIds?: string[], modelId?: string | null) => Promise<void>;
  stopResearchMessage: (sessionId: string) => Promise<void>;
  dequeueResearchMessage: (sessionId: string, queuedMessageId: string) => void;
  reorderQueuedResearchMessage: (sessionId: string, queuedMessageId: string, direction: "up" | "down") => void;
  summarizeResearchChat: (sessionId: string) => Promise<void>;
  applyResearchGraphChangeSet: (
    sessionId: string,
    messageId: string,
    changeSetId: string,
    decisions: ResearchGraphChangeDecision[],
    retryReviewed?: boolean
  ) => Promise<ResearchGraphChangeResult[]>;
  respondToSubagentRun: (
    sessionId: string,
    messageId: string,
    runId: string,
    decision: "approved" | "rejected",
    resolutionStrategy?: string,
    runtimeTargetProfileIds?: string[]
  ) => Promise<void>;
  refreshPatchProposals: () => Promise<void>;
  applyPatchProposal: (proposalArtifactId: string, decisions: PatchOperationDecision[]) => Promise<void>;
  addNote: (
    input: Omit<Note, "id" | "createdAt" | "attachmentIds" | "category" | "priority" | "pinned"> &
      Partial<Pick<Note, "category" | "priority" | "pinned">> & { attachmentIds?: string[] }
  ) => Promise<ProjectBundle | void>;
  updateNoteResolved: (noteId: string, resolved: boolean) => Promise<void>;
  updateNotePinned: (noteId: string, pinned: boolean) => Promise<void>;
  deleteNote: (noteId: string) => Promise<void>;
  purgeResolvedNotes: (scope?: { flowId?: string; nodeId?: string }) => Promise<void>;
  purgeSystemNotes: (scope?: { flowId?: string; nodeId?: string }) => Promise<void>;
  attachNodeReferences: (nodeId: string, noteId?: string) => Promise<void>;
  attachNodeReferenceFiles: (nodeId: string, noteId: string | undefined, filePaths: string[]) => Promise<void>;
  runAgent: (input: AgentRunInput) => Promise<void>;
  runProfile: (input: RunProfileInput) => Promise<void>;
  refreshRuntimeServices: () => Promise<void>;
  stopRuntimeService: (serviceId: string) => Promise<void>;
  restartRuntimeService: (serviceId: string) => Promise<void>;
  continueQuestionBlockedRun: () => Promise<void>;
  dismissQuestionCheck: () => void;
  approveRun: (runId: string, reusableApproval?: boolean) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  rejectRun: (runId: string, reason?: string) => Promise<void>;
  dismissRunError: (runId: string) => Promise<void>;
  removeRunFromQueue: (runId: string) => Promise<void>;
  retryRun: (runId: string) => Promise<void>;
  retryRunWithGuidance: (runId: string, guidance?: RunGuidanceInput) => Promise<void>;
  startDebuggingRun: (runId: string, guidance?: RunGuidanceInput) => Promise<void>;
  startRuntimeDebugRun: (serviceId: string, guidance?: RunGuidanceInput) => Promise<void>;
  reportBug: (input: { title: string; description: string; priority?: DebugIncident["priority"]; nodeId?: string; artifactIds?: string[]; filePaths?: string[] }) => Promise<void>;
  updateBugIncident: (incidentId: string, patch: Partial<Pick<DebugIncident, "title" | "description" | "priority" | "status">>) => Promise<void>;
  startIncidentDebugRun: (incidentIds?: string[]) => Promise<void>;
  showDirectUndoNotice: () => void;
  dismissAppNotice: () => void;
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;
  setUiScale: (scale: UiScale) => void;
  loadKeybindings: () => Promise<void>;
  setKeybinding: (id: ActionId, chord: KeyChord) => Promise<void>;
  resetKeybinding: (id: ActionId) => Promise<void>;
  resetAllKeybindings: () => Promise<void>;
  loadGlobalSpeechSettings: () => Promise<void>;
  updateGlobalSpeechSettings: (settings: SpeechSettings) => Promise<void>;
  loadGlobalTtsSettings: () => Promise<void>;
  updateGlobalTtsSettings: (settings: TtsSettings) => Promise<void>;
};

export type StoreSet = StoreApi<ArchicodeState>["setState"];
export type StoreGet = StoreApi<ArchicodeState>["getState"];
