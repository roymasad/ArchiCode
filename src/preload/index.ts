import { clipboard, contextBridge, ipcRenderer, webFrame } from "electron";
import type { Note, DebugIncident, Flow, LlmPatchProposal, NodePatch, PatchOperationDecision, Project, ProjectBundle, ProjectSettings, ProjectMemoryNote, Artifact, PatchReviewRecord, Run, RunEffort, RunGuidance, RunScope, RuntimeService, ResearchChatScope, ResearchChatSession, ResearchGraphChangeDecision, ResearchGraphChangeResult, ResearchMessageNodeReference } from "../shared/schema";
import type { SpeechModelId, SpeechSettings, TtsModelId, TtsSettings, TtsVoiceId } from "../shared/schema";
import type { TtsModelDownloadProgress, TtsModelStatus, TtsRuntimeStatus, TtsSpeechStreamChunk, TtsSpeechStreamResult, TtsSynthesisResult } from "../main/tts";
import type {
  CreateProjectSkillInput,
  McpImportSource,
  McpRefreshResult,
  McpRegistryInstallInput,
  McpRegistryInstallResult,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpServerView,
  ProjectSkill
} from "../shared/capabilities";
import type { GitOperationResult, GitStatus, ProjectFileBrowserData, ProjectFileDiff, ProjectFileText } from "../shared/projectTools";
import type { GraphHistoryVersion, GraphNodeHistory, HistoricalGraphBundle } from "../shared/graphHistory";
import type { GlobalResearchPersonality, GlobalResearchVerbosity } from "../shared/researchPersonality";
import type { AppUpdateStatus } from "../main/updater";
import type { ExternalMcpHostStatus } from "../main/mcpHost";
import type { SemanticCodeLineContext, SemanticIndexProgress, SemanticIndexStatus, SemanticModelPreferenceId, SemanticNodeContext } from "../main/semanticIndex";
import type { GraphEvidenceRefreshProgress, GraphEvidenceRefreshResult } from "../main/importer/evidenceRefresh";
import type { CodeKnowledgeSnapshot } from "../shared/codeKnowledge";
import type { ProjectMaintenanceStatus } from "../shared/projectMaintenance";
import type { ResyncProgress, ResyncReport, ResyncResult, ResyncScope } from "../main/importer/resyncTypes";
export type { ResyncProgress, ResyncReport, ResyncResult, ResyncScope } from "../main/importer/resyncTypes";

export type ProviderHealthResult = {
  providerId: string;
  ok: boolean;
  status: "ready" | "missing-key" | "failed";
  checkedAt: string;
  message: string;
  detectedContextWindowTokens?: number;
  contextWindowSource?: string;
  availableModels?: string[];
  detectedModelCapabilities?: ProjectSettings["providers"][number]["detectedModelCapabilities"];
  modelListSource?: string;
  detectedOpenAiEndpointMode?: "responses" | "chat-completions";
};

export type PatchProposalView = {
  artifact: Artifact;
  proposal: LlmPatchProposal | unknown;
  review: PatchReviewRecord | null;
  validationErrors: string[];
};

export type OpenProjectFolderResult = {
  bundle: ProjectBundle;
  initializedMetadata: boolean;
  codebaseHints: string[];
};

export type RecentProjectEntry = {
  rootPath: string;
  name: string;
};

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
    levels: "1" | "2" | "3" | "4";
    detail: "light" | "balanced" | "deep";
    reviewEffort: "light" | "balanced" | "deep" | "ultra";
    granularity: "system" | "module" | "component" | "file";
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
    reportedUnresolvedCount?: number;
    reviewedSourceFiles?: number;
    totalReviewSourceFiles?: number;
  };
  providerCalls: {
    total: number;
    failed: number;
    /** Optional on summaries produced before detailed provider accounting was added. */
    architecture?: number;
    review?: number;
    runtimeSetup?: number;
    retries?: number;
    rejected?: number;
  };
  phaseTimings: Array<{ phase: string; label: string; durationMs: number }>;
  accuracyEstimate: {
    score: number;
    label: "High" | "Good" | "Moderate" | "Limited";
    explanation: string;
    recommendation: string;
    factors: Array<{ label: string; value: string }>;
  };
  report?: {
    correctionsAndSafeguards: string[];
    limitations: string[];
    rejectedReviewSuggestions: string[];
    informationalNotes: string[];
  };
  /** Legacy limitations array retained for summaries produced by older app builds. */
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

export type ConsoleOutputPayload = {
  sessionId: string;
  stream: "data" | "system";
  text: string;
  exitCode?: number | null;
  signal?: number | null;
};

export type ResearchChatTokenPayload = {
  projectRoot: string;
  sessionId: string;
  text: string;
  kind?: "answer" | "thinking";
  reset?: boolean;
};

export type ResearchChatActivityPayload = {
  projectRoot: string;
  sessionId: string;
  message: string;
  status?: "running" | "completed" | "failed";
};

export type ResearchChatSessionUpdatedPayload = {
  projectRoot: string;
  session: ResearchChatSession;
};

export type ResearchSubagentProgressPayload = {
  projectRoot: string;
  sessionId: string;
  runId: string;
  kind: "merge-resolution" | "graph-reconciliation" | "test-authoring" | "sherlock-research" | "delphi-testing";
  title: string;
  message: string;
  status?: "running" | "completed" | "blocked" | "failed";
  artifact?: { id: string; label: string; path: string; mediaType: string };
  observationAnalysis?: { artifactId: string; status: "started" | "completed" | "failed" };
};

export type ExternalProjectUpdatePayload = {
  projectRoot: string;
  source: "mcp" | "knowledge-refresh";
  action: string;
  refreshedEdges?: number;
  unresolvedEdges?: number;
  policyViolations?: number;
};

export type AgentMemoryFile = {
  path: string;
  text: string;
  exists: boolean;
};

export type AgentInstructionFile = AgentMemoryFile;

export type AgentInstructionFileSummary = {
  path: string;
  exists: boolean;
  preferred: boolean;
};

export type DrawioImportRequest = {
  flowId: string;
  subflowId?: string | null;
  mode: "replace" | "append";
};

export type SpeechModelStatus = {
  id: SpeechModelId;
  label: string;
  modelId: string;
  url: string;
  approximateSize: string;
  path: string;
  downloaded: boolean;
  sizeBytes?: number;
};

export type SpeechRuntimeStatus = {
  runtimeAvailable: boolean;
  runtimePath?: string;
  runtimeError?: string;
  selectedModelId: SpeechModelId;
  models: SpeechModelStatus[];
};

export type SpeechModelDownloadProgress = {
  modelId: SpeechModelId;
  receivedBytes: number;
  totalBytes?: number;
};

export type SpeechTranscriptionResult = {
  text: string;
  modelId: SpeechModelId;
  durationMs: number;
};

const api = {
  setZoomFactor: (factor: number): void => {
    if (!Number.isFinite(factor)) return;
    webFrame.setZoomFactor(Math.min(1.25, Math.max(0.75, factor)));
  },
  appVersion: (): Promise<string> => ipcRenderer.invoke("archicode:app-version"),
  defaultRoot: (): Promise<string | null> => ipcRenderer.invoke("archicode:default-root"),
  listRecentProjects: (): Promise<RecentProjectEntry[]> => ipcRenderer.invoke("archicode:list-recent-projects"),
  checkForUpdates: (): Promise<AppUpdateStatus> => ipcRenderer.invoke("archicode:check-for-updates"),
  getGlobalProviders: (): Promise<ProjectSettings["providers"]> => ipcRenderer.invoke("archicode:get-global-providers"),
  getGlobalResearchPersonality: (): Promise<GlobalResearchPersonality> => ipcRenderer.invoke("archicode:get-global-research-personality"),
  getGlobalResearchVerbosity: (): Promise<GlobalResearchVerbosity> => ipcRenderer.invoke("archicode:get-global-research-verbosity"),
  getGlobalProviderSecretStatus: (): Promise<Record<string, boolean>> => ipcRenderer.invoke("archicode:get-global-provider-secret-status"),
  getWebSearchSecretStatus: (): Promise<Record<"brave", boolean>> => ipcRenderer.invoke("archicode:get-web-search-secret-status"),
  saveGlobalProviders: (providers: ProjectSettings["providers"], options?: { preserveMissingSecrets?: boolean; includeSecrets?: boolean }): Promise<ProjectSettings["providers"]> =>
    ipcRenderer.invoke("archicode:save-global-providers", providers, options),
  saveWebSearchSecrets: (secrets: { braveApiKey?: string }, options?: { preserveMissingSecrets?: boolean }): Promise<Record<"brave", boolean>> =>
    ipcRenderer.invoke("archicode:save-web-search-secrets", secrets, options),
  saveGlobalResearchPersonality: (personality: GlobalResearchPersonality): Promise<GlobalResearchPersonality> =>
    ipcRenderer.invoke("archicode:save-global-research-personality", personality),
  saveGlobalResearchVerbosity: (verbosity: GlobalResearchVerbosity): Promise<GlobalResearchVerbosity> =>
    ipcRenderer.invoke("archicode:save-global-research-verbosity", verbosity),
  getGlobalSpeechSettings: (): Promise<SpeechSettings> => ipcRenderer.invoke("archicode:get-global-speech-settings"),
  saveGlobalSpeechSettings: (settings: SpeechSettings): Promise<SpeechSettings> =>
    ipcRenderer.invoke("archicode:save-global-speech-settings", settings),
  getGlobalTtsSettings: (): Promise<TtsSettings> => ipcRenderer.invoke("archicode:get-global-tts-settings"),
  saveGlobalTtsSettings: (settings: TtsSettings): Promise<TtsSettings> =>
    ipcRenderer.invoke("archicode:save-global-tts-settings", settings),
  getKeybindings: (): Promise<Record<string, { key: string; cmd?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }>> =>
    ipcRenderer.invoke("archicode:get-keybindings"),
  saveKeybindings: (bindings: Record<string, { key: string; cmd?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }>): Promise<Record<string, { key: string; cmd?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }>> =>
    ipcRenderer.invoke("archicode:save-keybindings", bindings),
  getGitAttributesStatus: (projectRoot: string): Promise<"enabled" | "missing" | "conflicting"> =>
    ipcRenderer.invoke("archicode:get-git-attributes-status", projectRoot),
  enableGitAttributes: (projectRoot: string): Promise<"enabled" | "conflicting"> =>
    ipcRenderer.invoke("archicode:enable-git-attributes", projectRoot),
  ensureProject: (projectRoot: string): Promise<ProjectBundle> => ipcRenderer.invoke("archicode:ensure-project", projectRoot),
  loadProject: (projectRoot: string): Promise<ProjectBundle> => ipcRenderer.invoke("archicode:load-project", projectRoot),
  openProjectFolder: (): Promise<OpenProjectFolderResult | null> => ipcRenderer.invoke("archicode:open-project-folder"),
  cloneGitRepository: (remoteUrl: string): Promise<OpenProjectFolderResult | null> =>
    ipcRenderer.invoke("archicode:clone-git-repository", remoteUrl),
  openRecentProject: (projectRoot: string): Promise<OpenProjectFolderResult> => ipcRenderer.invoke("archicode:open-recent-project", projectRoot),
  revealProjectFolder: (projectRoot: string): Promise<boolean> => ipcRenderer.invoke("archicode:reveal-project-folder", projectRoot),
  openProjectPath: (projectRoot: string, relativePath: string): Promise<boolean> =>
    ipcRenderer.invoke("archicode:open-project-path", projectRoot, relativePath),
  openProjectFile: (projectRoot: string, relativePath: string): Promise<boolean> =>
    ipcRenderer.invoke("archicode:open-project-file", projectRoot, relativePath),
  openProjectFileWithApp: (projectRoot: string, relativePath: string): Promise<boolean> =>
    ipcRenderer.invoke("archicode:open-project-file-with-app", projectRoot, relativePath),
  maximizeWindow: (): Promise<boolean> => ipcRenderer.invoke("archicode:maximize-window"),
  openProjectInVsCode: (projectRoot: string): Promise<boolean> => ipcRenderer.invoke("archicode:open-project-in-vscode", projectRoot),
  openExternalUrl: (url: string): Promise<boolean> => ipcRenderer.invoke("archicode:open-external-url", url),
  copyTextToClipboard: (text: string): boolean => {
    clipboard.writeText(text);
    return true;
  },
  showSystemNotification: (input: { title: string; body?: string }): Promise<boolean> =>
    ipcRenderer.invoke("archicode:show-system-notification", input),
  pickImageFiles: (): Promise<string[]> => ipcRenderer.invoke("archicode:pick-image-files"),
  pickResearchAttachmentFiles: (includeImages = true): Promise<string[]> => ipcRenderer.invoke("archicode:pick-research-attachment-files", includeImages),
  pickReferenceFiles: (): Promise<string[]> => ipcRenderer.invoke("archicode:pick-reference-files"),
  createProject: (templateId: string): Promise<ProjectBundle | null> => ipcRenderer.invoke("archicode:create-project", templateId),
  saveFlow: (projectRoot: string, flow: Flow): Promise<ProjectBundle> => ipcRenderer.invoke("archicode:save-flow", projectRoot, flow),
  importFlow: (projectRoot: string): Promise<ProjectBundle | null> => ipcRenderer.invoke("archicode:import-flow", projectRoot),
  importDrawioFlow: (projectRoot: string, options: DrawioImportRequest): Promise<ProjectBundle | null> =>
    ipcRenderer.invoke("archicode:import-drawio-flow", projectRoot, options),
  exportFlow: (projectRoot: string, flowId: string): Promise<boolean> => ipcRenderer.invoke("archicode:export-flow", projectRoot, flowId),
  exportDrawioFlow: (projectRoot: string, flowId: string, subflowId?: string | null): Promise<boolean> =>
    ipcRenderer.invoke("archicode:export-drawio-flow", projectRoot, flowId, subflowId ?? null),
  exportProjectBundle: (projectRoot: string): Promise<boolean> => ipcRenderer.invoke("archicode:export-project-bundle", projectRoot),
  exportProjectDocument: (projectRoot: string, flowIds: string[], format: "pdf" | "html"): Promise<boolean> =>
    ipcRenderer.invoke("archicode:export-project-document", projectRoot, flowIds, format),
  repairProject: (projectRoot: string): Promise<ProjectBundle> => ipcRenderer.invoke("archicode:repair-project", projectRoot),
  deleteProjectState: (projectRoot: string): Promise<boolean> => ipcRenderer.invoke("archicode:delete-project-state", projectRoot),
  addNote: (
    projectRoot: string,
    note: Omit<Note, "id" | "createdAt" | "attachmentIds" | "category" | "priority" | "pinned"> &
      Partial<Pick<Note, "category" | "priority" | "pinned">> & { attachmentIds?: string[] }
  ): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:add-note", projectRoot, note),
  updateNoteResolved: (projectRoot: string, noteId: string, resolved: boolean): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:update-note-resolved", projectRoot, noteId, resolved),
  updateNotePinned: (projectRoot: string, noteId: string, pinned: boolean): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:update-note-pinned", projectRoot, noteId, pinned),
  deleteNote: (projectRoot: string, noteId: string): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:delete-note", projectRoot, noteId),
  purgeResolvedNotes: (projectRoot: string, scope?: { flowId?: string; nodeId?: string }): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:purge-resolved-notes", projectRoot, scope ?? {}),
  purgeSystemNotes: (projectRoot: string, scope?: { flowId?: string; nodeId?: string }): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:purge-system-notes", projectRoot, scope ?? {}),
  attachNodeReferences: (projectRoot: string, flowId: string, nodeId: string, noteId?: string): Promise<ProjectBundle | null> =>
    ipcRenderer.invoke("archicode:attach-node-references", projectRoot, flowId, nodeId, noteId),
  attachNodeReferenceFiles: (projectRoot: string, flowId: string, nodeId: string, noteId: string | undefined, filePaths: string[]): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:attach-node-reference-files", projectRoot, flowId, nodeId, noteId, filePaths),
  updateNode: (projectRoot: string, flowId: string, patch: NodePatch, actor: "user" | "llm"): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:update-node", projectRoot, flowId, patch, actor),
  authorAcceptanceTests: (projectRoot: string, flowId: string, nodeId: string, providerId?: string): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:author-acceptance-tests", projectRoot, flowId, nodeId, providerId),
  authorAcceptanceTestsForFlow: (projectRoot: string, flowId: string, providerId?: string): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:author-acceptance-tests-flow", projectRoot, flowId, providerId),
  clearAcceptanceTests: (projectRoot: string, flowId: string, nodeId: string): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:clear-acceptance-tests", projectRoot, flowId, nodeId),
  enhanceNodeField: (projectRoot: string, flowId: string, nodeId: string, field: "description" | "acceptanceCriteria", providerId?: string): Promise<string> =>
    ipcRenderer.invoke("archicode:enhance-node-field", projectRoot, flowId, nodeId, field, providerId),
  runAcceptanceChecks: (projectRoot: string, flowId: string, nodeId: string): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:run-acceptance-checks", projectRoot, flowId, nodeId),
  updateProjectDetails: (projectRoot: string, patch: Pick<Project, "name">): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:update-project-details", projectRoot, patch),
  updateProjectSettings: (projectRoot: string, settings: ProjectSettings): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:update-project-settings", projectRoot, settings),
  getSemanticIndexStatus: (projectRoot: string): Promise<SemanticIndexStatus> =>
    ipcRenderer.invoke("archicode:get-semantic-index-status", projectRoot),
  getProjectMaintenanceStatus: (projectRoot: string): Promise<ProjectMaintenanceStatus> =>
    ipcRenderer.invoke("archicode:get-project-maintenance-status", projectRoot),
  retryProjectMaintenance: (projectRoot: string): Promise<ProjectMaintenanceStatus> =>
    ipcRenderer.invoke("archicode:retry-project-maintenance", projectRoot),
  dismissProjectMaintenanceWarning: (projectRoot: string): Promise<ProjectMaintenanceStatus> =>
    ipcRenderer.invoke("archicode:dismiss-project-maintenance-warning", projectRoot),
  reportProjectSourceDrift: (projectRoot: string, changedPaths?: string[]): Promise<ProjectMaintenanceStatus> =>
    ipcRenderer.invoke("archicode:report-project-source-drift", projectRoot, changedPaths),
  getSemanticModelPreference: (): Promise<SemanticModelPreferenceId> =>
    ipcRenderer.invoke("archicode:get-semantic-model-preference"),
  setSemanticModelPreference: (preference: SemanticModelPreferenceId, projectRoot?: string): Promise<SemanticModelPreferenceId> =>
    ipcRenderer.invoke("archicode:set-semantic-model-preference", preference, projectRoot),
  getNodeSemanticContext: (projectRoot: string, flowId: string, nodeId: string, refresh = false): Promise<SemanticNodeContext> =>
    ipcRenderer.invoke("archicode:get-node-semantic-context", projectRoot, flowId, nodeId, refresh),
  getSemanticCodeLineContext: (projectRoot: string, relativePath: string, lineNumber: number): Promise<SemanticCodeLineContext> =>
    ipcRenderer.invoke("archicode:get-semantic-code-line-context", projectRoot, relativePath, lineNumber),
  getSemanticCodeFileContexts: (projectRoot: string, relativePath: string): Promise<SemanticCodeLineContext[]> =>
    ipcRenderer.invoke("archicode:get-semantic-code-file-contexts", projectRoot, relativePath),
  rebuildSemanticIndex: (projectRoot: string): Promise<SemanticIndexStatus> =>
    ipcRenderer.invoke("archicode:rebuild-semantic-index", projectRoot),
  clearSemanticIndex: (projectRoot: string): Promise<SemanticIndexStatus> =>
    ipcRenderer.invoke("archicode:clear-semantic-index", projectRoot),
  getExternalMcpHostStatus: (projectRoot: string): Promise<ExternalMcpHostStatus> =>
    ipcRenderer.invoke("archicode:get-external-mcp-host-status", projectRoot),
  regenerateExternalMcpHostToken: (projectRoot: string): Promise<ExternalMcpHostStatus> =>
    ipcRenderer.invoke("archicode:regenerate-external-mcp-host-token", projectRoot),
  getSpeechStatus: (modelId?: SpeechModelId): Promise<SpeechRuntimeStatus> =>
    ipcRenderer.invoke("archicode:get-speech-status", modelId),
  downloadSpeechModel: (modelId: SpeechModelId): Promise<SpeechModelStatus> =>
    ipcRenderer.invoke("archicode:download-speech-model", modelId),
  deleteSpeechModel: (modelId: SpeechModelId): Promise<SpeechModelStatus> =>
    ipcRenderer.invoke("archicode:delete-speech-model", modelId),
  transcribeSpeech: (input: {
    audio: ArrayBuffer;
    modelId?: SpeechModelId;
    language?: string;
    translateToEnglish?: boolean;
    threads?: number;
  }): Promise<SpeechTranscriptionResult> => ipcRenderer.invoke("archicode:transcribe-speech", input),
  getTtsStatus: (modelId?: TtsModelId): Promise<TtsRuntimeStatus> =>
    ipcRenderer.invoke("archicode:get-tts-status", modelId),
  downloadTtsModel: (modelId: TtsModelId, voiceId?: TtsVoiceId): Promise<TtsModelStatus> =>
    ipcRenderer.invoke("archicode:download-tts-model", modelId, voiceId),
  deleteTtsModel: (modelId: TtsModelId): Promise<TtsModelStatus> =>
    ipcRenderer.invoke("archicode:delete-tts-model", modelId),
  warmTtsModel: (modelId: TtsModelId, voiceId?: TtsVoiceId): Promise<TtsModelStatus> =>
    ipcRenderer.invoke("archicode:warm-tts-model", modelId, voiceId),
  synthesizeSpeech: (input: {
    text: string;
    modelId?: TtsModelId;
    voiceId?: TtsVoiceId;
    speed?: number;
  }): Promise<TtsSynthesisResult> => ipcRenderer.invoke("archicode:synthesize-speech", input),
  streamSpeech: async (input: {
    debugStartedAtMs?: number;
    text: string;
    modelId?: TtsModelId;
    singleSegment?: boolean;
    voiceId?: TtsVoiceId;
    speed?: number;
  }, onChunk: (chunk: TtsSpeechStreamChunk) => void): Promise<TtsSpeechStreamResult> => {
    const streamId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const channel = "archicode:tts-speech-stream-chunk";
    const handler = (_event: Electron.IpcRendererEvent, chunk: TtsSpeechStreamChunk & { streamId?: string }) => {
      if (chunk.streamId !== streamId) return;
      const { streamId: _streamId, ...payload } = chunk;
      onChunk(payload);
    };
    ipcRenderer.on(channel, handler);
    try {
      return await ipcRenderer.invoke("archicode:stream-speech", { ...input, streamId });
    } finally {
      ipcRenderer.removeListener(channel, handler);
    }
  },
  writeTtsDebugLog: (input: {
    events: Array<Record<string, unknown>>;
    logId: string;
    messageId?: string | null;
    playbackRunId?: number | null;
    sessionId?: string | null;
  }): Promise<{ path: string }> => ipcRenderer.invoke("archicode:write-tts-debug-log", input),
  listAgentInstructionFiles: (projectRoot: string): Promise<AgentInstructionFileSummary[]> =>
    ipcRenderer.invoke("archicode:list-agent-instruction-files", projectRoot),
  readAgentInstructionFile: (projectRoot: string, filePath?: string): Promise<AgentInstructionFile> =>
    ipcRenderer.invoke("archicode:read-agent-instruction-file", projectRoot, filePath),
  writeAgentInstructionFile: (projectRoot: string, filePath: string, text: string): Promise<AgentInstructionFile> =>
    ipcRenderer.invoke("archicode:write-agent-instruction-file", projectRoot, filePath, text),
  readAgentMemory: (projectRoot: string): Promise<AgentMemoryFile> =>
    ipcRenderer.invoke("archicode:read-agent-memory", projectRoot),
  writeAgentMemory: (projectRoot: string, text: string): Promise<AgentMemoryFile> =>
    ipcRenderer.invoke("archicode:write-agent-memory", projectRoot, text),
  checkProvider: (projectRoot: string, providerId: string): Promise<ProviderHealthResult> =>
    ipcRenderer.invoke("archicode:check-provider", projectRoot, providerId),
  checkGlobalProvider: (providerId: string): Promise<ProviderHealthResult> =>
    ipcRenderer.invoke("archicode:check-global-provider", providerId),
  listProjectSkills: (projectRoot: string): Promise<ProjectSkill[]> =>
    ipcRenderer.invoke("archicode:list-project-skills", projectRoot),
  createProjectSkill: (projectRoot: string, input: CreateProjectSkillInput): Promise<ProjectSkill[]> =>
    ipcRenderer.invoke("archicode:create-project-skill", projectRoot, input),
  listMcpServers: (projectRoot: string): Promise<McpServerView[]> =>
    ipcRenderer.invoke("archicode:list-mcp-servers", projectRoot),
  searchMcpRegistry: (input: McpRegistrySearchInput): Promise<McpRegistrySearchResult> =>
    ipcRenderer.invoke("archicode:search-mcp-registry", input),
  installMcpRegistryServer: (projectRoot: string, input: McpRegistryInstallInput): Promise<McpRegistryInstallResult> =>
    ipcRenderer.invoke("archicode:install-mcp-registry-server", projectRoot, input),
  importMcpServers: (projectRoot: string, source: McpImportSource): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:import-mcp-servers", projectRoot, source),
  updateMcpServer: (projectRoot: string, server: McpServerView): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:update-mcp-server", projectRoot, server),
  refreshMcpServerCapabilities: (projectRoot: string, serverId: string): Promise<McpRefreshResult> =>
    ipcRenderer.invoke("archicode:refresh-mcp-server-capabilities", projectRoot, serverId),
  listPatchProposals: (projectRoot: string): Promise<PatchProposalView[]> =>
    ipcRenderer.invoke("archicode:list-patch-proposals", projectRoot),
  readArtifactText: (projectRoot: string, artifactPath: string): Promise<string> =>
    ipcRenderer.invoke("archicode:read-artifact-text", projectRoot, artifactPath),
  readArtifactDataUrl: (projectRoot: string, artifactPath: string): Promise<string> =>
    ipcRenderer.invoke("archicode:read-artifact-data-url", projectRoot, artifactPath),
  listProjectMemoryNotes: (projectRoot: string, options?: { includeArchived?: boolean; scope?: ResearchChatScope }): Promise<ProjectMemoryNote[]> =>
    ipcRenderer.invoke("archicode:list-project-memory-notes", projectRoot, options),
  updateProjectMemoryNote: (projectRoot: string, noteId: string, input: {
    expectedRevision: number;
    title?: string;
    body?: string;
    scope?: ResearchChatScope;
    pinned?: boolean;
    status?: ProjectMemoryNote["status"];
  }): Promise<ProjectMemoryNote> => ipcRenderer.invoke("archicode:update-project-memory-note", projectRoot, noteId, input),
  listChatArtifacts: (projectRoot: string, chatId: string): Promise<Artifact[]> =>
    ipcRenderer.invoke("archicode:list-chat-artifacts", projectRoot, chatId),
  readChatArtifact: (projectRoot: string, chatId: string, artifactId: string): Promise<{ artifact: Artifact; text: string }> =>
    ipcRenderer.invoke("archicode:read-chat-artifact", projectRoot, chatId, artifactId),
  getGitStatus: (projectRoot: string): Promise<GitStatus> =>
    ipcRenderer.invoke("archicode:get-git-status", projectRoot),
  listGraphHistory: (projectRoot: string): Promise<GraphHistoryVersion[]> =>
    ipcRenderer.invoke("archicode:list-graph-history", projectRoot),
  loadHistoricalGraph: (projectRoot: string, commit: string): Promise<HistoricalGraphBundle> =>
    ipcRenderer.invoke("archicode:load-historical-graph", projectRoot, commit),
  listHistoricalProjectFiles: (projectRoot: string, commit: string): Promise<ProjectFileBrowserData> =>
    ipcRenderer.invoke("archicode:list-historical-project-files", projectRoot, commit),
  readHistoricalProjectFile: (projectRoot: string, commit: string, relativePath: string): Promise<ProjectFileText> =>
    ipcRenderer.invoke("archicode:read-historical-project-file", projectRoot, commit, relativePath),
  getGraphNodeHistory: (projectRoot: string, commit: string, flowId: string, nodeId: string): Promise<GraphNodeHistory> =>
    ipcRenderer.invoke("archicode:get-graph-node-history", projectRoot, commit, flowId, nodeId),
  gitInit: (projectRoot: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke("archicode:git-init", projectRoot),
  gitPull: (projectRoot: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke("archicode:git-pull", projectRoot),
  gitPush: (projectRoot: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke("archicode:git-push", projectRoot),
  gitDiscardChanges: (projectRoot: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke("archicode:git-discard-changes", projectRoot),
  gitStashChanges: (projectRoot: string, message?: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke("archicode:git-stash-changes", projectRoot, message),
  gitPopStash: (projectRoot: string, stashRef: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke("archicode:git-pop-stash", projectRoot, stashRef),
  gitSwitchBranch: (projectRoot: string, branch: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke("archicode:git-switch-branch", projectRoot, branch),
  gitCreateBranch: (projectRoot: string, branch: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke("archicode:git-create-branch", projectRoot, branch),
  gitCommit: (projectRoot: string, message: string, files: string[]): Promise<GitOperationResult> =>
    ipcRenderer.invoke("archicode:git-commit", projectRoot, message, files),
  generateGitCommitMessage: (projectRoot: string, files: string[], providerId?: string): Promise<string> =>
    ipcRenderer.invoke("archicode:generate-git-commit-message", projectRoot, files, providerId),
  listProjectFiles: (projectRoot: string): Promise<ProjectFileBrowserData> =>
    ipcRenderer.invoke("archicode:list-project-files", projectRoot),
  readProjectFile: (projectRoot: string, relativePath: string): Promise<ProjectFileText> =>
    ipcRenderer.invoke("archicode:read-project-file", projectRoot, relativePath),
  readProjectFileDiff: (projectRoot: string, relativePath: string): Promise<ProjectFileDiff> =>
    ipcRenderer.invoke("archicode:read-project-file-diff", projectRoot, relativePath),
  applyPatchProposal: (projectRoot: string, proposalArtifactId: string, decisions: PatchOperationDecision[]): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:apply-patch-proposal", projectRoot, proposalArtifactId, decisions),
  startAgentRun: (input: {
    projectRoot: string;
    flowId: string;
    nodeId?: string;
    providerId: string;
    purpose?: "implement" | "build-discovery" | "run-discovery";
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
  }): Promise<{ bundle: ProjectBundle; runId: string }> => ipcRenderer.invoke("archicode:start-agent-run", input),
  startRunProfile: (input: {
    projectRoot: string;
    flowId: string;
    providerId: string;
    profileId: string;
    targetId?: string;
    allowShell?: boolean;
    reusableApproval?: boolean;
  }): Promise<{ bundle: ProjectBundle; runId: string }> => ipcRenderer.invoke("archicode:start-run-profile", input),
  listRuntimeServices: (projectRoot: string): Promise<RuntimeService[]> =>
    ipcRenderer.invoke("archicode:list-runtime-services", projectRoot),
  startRuntimeService: (input: {
    projectRoot: string;
    profileId?: string;
    command?: string;
    label?: string;
    cwd?: string;
    targetId?: string;
  }): Promise<RuntimeService[]> => ipcRenderer.invoke("archicode:start-runtime-service", input),
  stopRuntimeService: (projectRoot: string, serviceId: string): Promise<RuntimeService[]> =>
    ipcRenderer.invoke("archicode:stop-runtime-service", projectRoot, serviceId),
  restartRuntimeService: (projectRoot: string, serviceId: string): Promise<RuntimeService[]> =>
    ipcRenderer.invoke("archicode:restart-runtime-service", projectRoot, serviceId),
  approveRun: (input: { projectRoot: string; runId: string; reusableApproval?: boolean }): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:approve-run", input),
  cancelRun: (projectRoot: string, runId: string): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:cancel-run", projectRoot, runId),
  rejectRun: (projectRoot: string, runId: string, reason?: string): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:reject-run", projectRoot, runId, reason),
  dismissRunError: (projectRoot: string, runId: string): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:dismiss-run-error", projectRoot, runId),
  removeRunFromQueue: (projectRoot: string, runId: string): Promise<ProjectBundle> =>
    ipcRenderer.invoke("archicode:remove-run-from-queue", projectRoot, runId),
  retryRun: (projectRoot: string, runId: string, guidance?: Partial<RunGuidance>): Promise<{ bundle: ProjectBundle; runId: string }> =>
    ipcRenderer.invoke("archicode:retry-run", projectRoot, runId, guidance),
  startDebuggingRun: (projectRoot: string, runId: string, guidance?: Partial<RunGuidance>): Promise<{ bundle: ProjectBundle; runId: string }> =>
    ipcRenderer.invoke("archicode:start-debugging-run", projectRoot, runId, guidance),
  startRuntimeDebugRun: (input: {
    projectRoot: string;
    serviceId: string;
    flowId?: string;
    providerId: string;
    guidance?: Partial<RunGuidance>;
  }): Promise<{ bundle: ProjectBundle; runId: string }> => ipcRenderer.invoke("archicode:start-runtime-debug-run", input),
  reportBug: (input: {
    projectRoot: string;
    flowId?: string;
    nodeId?: string;
    title: string;
    description: string;
    priority?: DebugIncident["priority"];
    artifactIds?: string[];
    filePaths?: string[];
  }): Promise<ProjectBundle> => ipcRenderer.invoke("archicode:report-bug", input),
  updateBugIncident: (input: {
    projectRoot: string;
    incidentId: string;
    patch: Partial<Pick<DebugIncident, "title" | "description" | "priority" | "status">>;
  }): Promise<ProjectBundle> => ipcRenderer.invoke("archicode:update-bug-incident", input),
  startIncidentDebugRun: (input: {
    projectRoot: string;
    flowId?: string;
    providerId: string;
    incidentIds?: string[];
    guidance?: Partial<RunGuidance>;
  }): Promise<{ bundle: ProjectBundle; runId: string }> => ipcRenderer.invoke("archicode:start-incident-debug-run", input),
  startConsole: (projectRoot: string, size?: { cols?: number; rows?: number }): Promise<{ sessionId: string; cwd: string; shell: string }> =>
    ipcRenderer.invoke("archicode:start-console", projectRoot, size),
  writeConsole: (sessionId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke("archicode:write-console", sessionId, text),
  resizeConsole: (sessionId: string, size: { cols?: number; rows?: number }): Promise<boolean> =>
    ipcRenderer.invoke("archicode:resize-console", sessionId, size),
  stopConsole: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke("archicode:stop-console", sessionId),
  listResearchChats: (projectRoot: string): Promise<ResearchChatSession[]> =>
    ipcRenderer.invoke("archicode:list-research-chats", projectRoot),
  createResearchChat: (input: {
    projectRoot: string;
    scope: ResearchChatScope;
    title?: string;
    providerId?: string;
    modelId?: string;
  }): Promise<ResearchChatSession> => ipcRenderer.invoke("archicode:create-research-chat", input),
  forkResearchChat: (input: {
    projectRoot: string;
    sessionId: string;
    uptoMessageId: string;
  }): Promise<ResearchChatSession> => ipcRenderer.invoke("archicode:fork-research-chat", input),
  renameResearchChat: (projectRoot: string, sessionId: string, title: string): Promise<ResearchChatSession> =>
    ipcRenderer.invoke("archicode:rename-research-chat", projectRoot, sessionId, title),
  archiveResearchChat: (projectRoot: string, sessionId: string): Promise<ResearchChatSession> =>
    ipcRenderer.invoke("archicode:archive-research-chat", projectRoot, sessionId),
  updateResearchChatAutoApproval: (input: {
    projectRoot: string;
    sessionId: string;
    autoApproveGraphChanges: ResearchChatSession["autoApproveGraphChanges"];
  }): Promise<ResearchChatSession> => ipcRenderer.invoke("archicode:update-research-chat-auto-approval", input),
  sendResearchChatMessage: (input: {
    projectRoot: string;
    sessionId: string;
    content: string;
    providerId?: string;
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
    optimisticUserMessageId?: string;
    optimisticAssistantMessageId?: string;
  }): Promise<ResearchChatSession> => ipcRenderer.invoke("archicode:send-research-chat-message", input),
  cancelResearchChatMessage: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke("archicode:cancel-research-chat-message", sessionId),
  summarizeResearchChat: (input: {
    projectRoot: string;
    sessionId: string;
    providerId?: string;
  }): Promise<ResearchChatSession> => ipcRenderer.invoke("archicode:summarize-research-chat", input),
  applyResearchGraphChangeSet: (input: {
    projectRoot: string;
    sessionId: string;
    messageId: string;
    changeSetId: string;
    decisions: ResearchGraphChangeDecision[];
    retryReviewed?: boolean;
  }): Promise<{ session: ResearchChatSession; bundle: ProjectBundle; results: ResearchGraphChangeResult[] }> =>
    ipcRenderer.invoke("archicode:apply-research-graph-change-set", input),
  respondToSubagentRun: (input: {
    projectRoot: string;
    sessionId: string;
    messageId: string;
    runId: string;
    decision: "approved" | "rejected";
    resolutionStrategy?: string;
    runtimeTargetProfileIds?: string[];
  }): Promise<ResearchChatSession> => ipcRenderer.invoke("archicode:respond-subagent-run", input),
  mapExistingCodebase: (input: {
    projectRoot: string;
    providerId?: string;
    levels: "1" | "2" | "3" | "4";
    detail: "light" | "balanced" | "deep";
    reviewEffort?: "light" | "balanced" | "deep" | "ultra";
    granularity?: "system" | "module" | "component" | "file";
    codebaseHints?: string[];
  }): Promise<CodebaseMappingResult> => ipcRenderer.invoke("archicode:map-existing-codebase", input),
  getInitialCodebaseImportReport: (projectRoot: string): Promise<CodebaseMappingSummary | null> =>
    ipcRenderer.invoke("archicode:get-initial-codebase-import-report", projectRoot),
  resyncCodebase: (input: { projectRoot: string; providerId?: string; scope?: ResyncScope }): Promise<ResyncResult> =>
    ipcRenderer.invoke("archicode:resync-codebase", input),
  cancelCodebaseResync: (projectRoot: string): Promise<boolean> =>
    ipcRenderer.invoke("archicode:cancel-codebase-resync", projectRoot),
  getLatestResyncReport: (projectRoot: string): Promise<ResyncReport | null> =>
    ipcRenderer.invoke("archicode:get-latest-resync-report", projectRoot),
  listResyncReports: (projectRoot: string): Promise<ResyncReport[]> =>
    ipcRenderer.invoke("archicode:list-resync-reports", projectRoot),
  cancelCodebaseMapping: (projectRoot: string): Promise<boolean> => ipcRenderer.invoke("archicode:cancel-codebase-mapping", projectRoot),
  refreshGraphEvidence: (projectRoot: string, flowId?: string): Promise<GraphEvidenceRefreshResult> =>
    ipcRenderer.invoke("archicode:refresh-graph-evidence", projectRoot, flowId),
  getCodeKnowledgeSnapshot: (projectRoot: string): Promise<CodeKnowledgeSnapshot | null> =>
    ipcRenderer.invoke("archicode:get-code-knowledge-snapshot", projectRoot),
  onConsoleOutput: (handler: (payload: ConsoleOutputPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ConsoleOutputPayload) => handler(payload);
    ipcRenderer.on("archicode:console-output", listener);
    return () => ipcRenderer.removeListener("archicode:console-output", listener);
  },
  onRunUpdated: (handler: (payload: { projectRoot: string; run: Run }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { projectRoot: string; run: Run }) => handler(payload);
    ipcRenderer.on("archicode:run-updated", listener);
    return () => ipcRenderer.removeListener("archicode:run-updated", listener);
  },
  onExternalProjectUpdated: (handler: (payload: ExternalProjectUpdatePayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ExternalProjectUpdatePayload) => handler(payload);
    ipcRenderer.on("archicode:external-project-updated", listener);
    return () => ipcRenderer.removeListener("archicode:external-project-updated", listener);
  },
  onDirectUndoRequested: (handler: () => void): (() => void) => {
    const listener = () => handler();
    ipcRenderer.on("archicode:direct-undo-requested", listener);
    return () => ipcRenderer.removeListener("archicode:direct-undo-requested", listener);
  },
  onCodebaseMappingProgress: (handler: (payload: CodebaseMappingProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CodebaseMappingProgress) => handler(payload);
    ipcRenderer.on("archicode:codebase-mapping-progress", listener);
    return () => ipcRenderer.removeListener("archicode:codebase-mapping-progress", listener);
  },
  onCodebaseResyncProgress: (handler: (payload: ResyncProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ResyncProgress) => handler(payload);
    ipcRenderer.on("archicode:codebase-resync-progress", listener);
    return () => ipcRenderer.removeListener("archicode:codebase-resync-progress", listener);
  },
  onGraphEvidenceRefreshProgress: (handler: (payload: GraphEvidenceRefreshProgress & { projectRoot: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: GraphEvidenceRefreshProgress & { projectRoot: string }) => handler(payload);
    ipcRenderer.on("archicode:graph-evidence-refresh-progress", listener);
    return () => ipcRenderer.removeListener("archicode:graph-evidence-refresh-progress", listener);
  },
  onResearchChatToken: (handler: (payload: ResearchChatTokenPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ResearchChatTokenPayload) => handler(payload);
    ipcRenderer.on("archicode:research-chat-token", listener);
    return () => ipcRenderer.removeListener("archicode:research-chat-token", listener);
  },
  onResearchChatActivity: (handler: (payload: ResearchChatActivityPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ResearchChatActivityPayload) => handler(payload);
    ipcRenderer.on("archicode:research-chat-activity", listener);
    return () => ipcRenderer.removeListener("archicode:research-chat-activity", listener);
  },
  onResearchChatSessionUpdated: (handler: (payload: ResearchChatSessionUpdatedPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ResearchChatSessionUpdatedPayload) => handler(payload);
    ipcRenderer.on("archicode:research-chat-session-updated", listener);
    return () => ipcRenderer.removeListener("archicode:research-chat-session-updated", listener);
  },
  onResearchSubagentProgress: (handler: (payload: ResearchSubagentProgressPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ResearchSubagentProgressPayload) => handler(payload);
    ipcRenderer.on("archicode:research-subagent-progress", listener);
    return () => ipcRenderer.removeListener("archicode:research-subagent-progress", listener);
  },
  onSpeechModelDownloadProgress: (handler: (payload: SpeechModelDownloadProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SpeechModelDownloadProgress) => handler(payload);
    ipcRenderer.on("archicode:speech-model-download-progress", listener);
    return () => ipcRenderer.removeListener("archicode:speech-model-download-progress", listener);
  },
  onTtsModelDownloadProgress: (handler: (payload: TtsModelDownloadProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TtsModelDownloadProgress) => handler(payload);
    ipcRenderer.on("archicode:tts-model-download-progress", listener);
    return () => ipcRenderer.removeListener("archicode:tts-model-download-progress", listener);
  },
  onSemanticIndexProgress: (handler: (payload: SemanticIndexProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SemanticIndexProgress) => handler(payload);
    ipcRenderer.on("archicode:semantic-index-progress", listener);
    return () => ipcRenderer.removeListener("archicode:semantic-index-progress", listener);
  },
  onProjectMaintenanceUpdated: (handler: (payload: ProjectMaintenanceStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProjectMaintenanceStatus) => handler(payload);
    ipcRenderer.on("archicode:project-maintenance-updated", listener);
    return () => ipcRenderer.removeListener("archicode:project-maintenance-updated", listener);
  },
  runAgent: (input: {
    projectRoot: string;
    flowId: string;
    nodeId?: string;
    providerId: string;
    promptSummary: string;
    command?: string;
    allowShell?: boolean;
    scope?: RunScope;
  }): Promise<ProjectBundle> => ipcRenderer.invoke("archicode:run-agent", input)
};

contextBridge.exposeInMainWorld("archicode", api);

export type ArchicodeApi = typeof api;
