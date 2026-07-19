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

import type { ArchicodeState } from "./types";
import { createProjectSlice } from "./projectSlice";
import { createGraphSlice } from "./graphSlice";
import { createRunsSlice } from "./runsSlice";
import { createGitFilesSlice } from "./gitFilesSlice";
import { createCapabilitiesSlice } from "./capabilitiesSlice";
import { createResearchSlice } from "./researchSlice";
import { createNotesSlice } from "./notesSlice";
import { createUiSlice } from "./uiSlice";
import { createHistorySlice } from "./historySlice";
import { guardHistoricalMutations } from "./historicalGuard";

export * from "./types";
export { getActiveFlow, getSelectedNode, getSelectedEdge, defaultResearchScope, normalizeComposerSegments } from "./helpers";
import { getInitialTheme, getInitialUiScale, readStoredWorkbenchView, readStoredViewport, createFallbackBundle, isVisualQaPreview } from "./helpers";

export const useArchicodeStore = create<ArchicodeState>((set, get) => {
  const state: ArchicodeState = {
  rootPath: "",
  bundle: null,
  activeFlowId: null,
  selectedNodeId: null,
  selectedNodeIds: [],
  selectedEdgeId: null,
  selectedRunId: null,
  activeSubflowId: null,
  searchQuery: "",
  nodeClipboard: null,
  loading: true,
  error: null,
  appNotice: null,
  shellPrompt: null,
  buildQuestionCheck: null,
  codebaseOnboarding: null,
  projectSettingsRequest: null,
  pendingRunKeys: [],
  runtimeServices: [],
  patchProposals: [],
  providerHealth: {},
  recentProjects: [],
  projectSkills: [],
  mcpServers: [],
  mcpRegistryEntries: [],
  mcpRegistryNextCursor: null,
  mcpRegistryCount: 0,
  capabilityBusy: false,
  researchPanelOpen: false,
  researchSessions: [],
  selectedResearchSessionId: null,
  researchScope: null,
  busyTestNodeIds: [],
  researchBusy: false,
  researchBusySessionIds: [],
  researchQueuedMessages: {},
  researchPendingAttachmentPaths: {},
  researchStreamStates: {},
  researchSubagentActivity: {},
  researchChatActivity: {},
  researchDraft: [],
  researchComposerFocusNonce: 0,
  theme: getInitialTheme(),
  uiScale: getInitialUiScale(),
  keybindings: { ...DEFAULT_BINDINGS },
  keybindingsLoaded: false,
  keybindingsBusy: false,
  globalSpeechSettings: null,
  globalTtsSettings: null,
  canvasViewport: null,
  canvasViewportCenter: null,
  lastAddNodePosition: null,
  lastAddNodeScope: null,
  graphNavigationRequest: null,
  projectReloadNonce: 0,
  workbenchView: "graph",
  gitStatus: null,
  gitLogs: [],
  gitBusy: false,
  graphHistory: [],
  graphHistoryOpen: false,
  graphHistoryLoading: false,
  graphHistoryCursor: null,
  graphHistoryHasMore: false,
  presentationUndoStack: [],
  presentationRedoStack: [],
  presentationHistoryBusy: false,
  historicalInspection: null,
  fileBrowser: null,
  selectedFilePath: null,
  filePreviewRequest: null,
  filePreview: null,
  fileDiff: null,
  fileBusy: false,

  ...createProjectSlice(set, get),
  ...createGraphSlice(set, get),
  ...createRunsSlice(set, get),
  ...createGitFilesSlice(set, get),
  ...createCapabilitiesSlice(set, get),
  ...createResearchSlice(set, get),
  ...createNotesSlice(set, get),
  ...createUiSlice(set, get),
    ...createHistorySlice(set, get),
  };
  return guardHistoricalMutations(state, set, get);
});
