import {
  Activity,
  Bug,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  FileText,
  Hammer,
  HelpCircle,
  History,
  LayoutGrid,
  Moon,
  MoreHorizontal,
  MessageSquare,
  Play,
  RefreshCw,
  Save,
  Search,
  SearchCheck,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  UploadCloud,
  Upload,
  ImagePlus,
  Loader2,
  Mic,
  Plus,
  PlugZap,
  Volume2,
  Wrench,
  Square,
  X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { defaultPhaseModelPolicies, defaultSubagentModelPolicies, runTargetProfileSchema, type DebugIncident, type LlmPhase, type PhaseModelPolicy, type ProjectSettings, type RunEffort, type RunScope, type RuntimeService, type SpeechSettings, type SubagentModelProfile, type TtsSettings } from "@shared/schema";
import { gaiaAgent, pandoraAgent } from "@shared/agentIdentities";
import { deriveContextBudgetPlan } from "@shared/contextBudget";
import { isSubflowIgnored } from "@shared/graph";
import { providerHasCompletedCapabilityCheck, providerImageInputSupportStatus, providerModelOutputTokenLimit } from "@shared/providerCapabilities";
import { researchPersonalities, type GlobalResearchPersonality, type GlobalResearchVerbosity } from "@shared/researchPersonality";
import { runtimeInsight } from "@shared/runtimeInsights";
import { stripAnsiEscapes } from "@shared/terminalText";
import { useArchicodeStore, type ProjectSettingsTab } from "../store/useArchicodeStore";
import { runFailureMessage } from "../utils/runErrors";
import { isRunBlockingNewChange } from "../utils/runStatus";
import { canvasBackgroundOptions } from "../utils/canvasBackgrounds";
import { buildLogicReviewPrompt, type LogicReviewTarget } from "../utils/logicReview";
import {
  changeProviderCompatibility,
  codexLocalCommandAccessHint,
  codexLocalSandboxOptions,
  createProviderProfile,
  duplicateProviderProfile,
  mergeProviderCapabilityMetadata,
  normalizeProviderModelSelections,
  outputVerbosityOptions,
  providerApiKeyValue,
  providersNeedingAutoCheckOnSave,
  providerKindOptions,
  removeProviderProfile,
  type ProviderKind
} from "../utils/providerProfiles";
import { PROVIDER_DEFAULT_MODEL_VALUE } from "../utils/researchModels";
import { PatchReviewPanel } from "./PatchReviewPanel";
import { HelpPage } from "./HelpPage";
import { GitPanel } from "./GitPanel";
import { GraphHistoryBar } from "./GraphHistoryBar";
import { ModelCombobox } from "./ModelCombobox";
import { ShortcutsSettingsTab } from "./ShortcutsSettingsTab";
import { ResyncCodebaseDialog } from "./ResyncCodebaseDialog";
import {
  Badge,
  Button,
  DialogContent,
  DialogRoot,
  Field,
  IconButton,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Select,
  Switch,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
  TextArea,
  TextInput,
  Tooltip,
  Toolbar
} from "./ui";


import { RuntimeUrlLinks, contextBudgetSourceLabel, contextLabel, defaultSpeechSettings, defaultTtsSettings, encodeWav, formatBytes, formatTokenCount, isMacRuntime, mcpRegistryCategoryLabel, mcpRegistryCategoryOptions, mcpRegistryInitials, mcpRegistrySortOptions, modelHint, modelOptionLabel, modelOptionsForProvider, normalizeSpeechLanguage, openAiEndpointHint, openAiEndpointLabel, openRuntimeUrl, projectSettingsTabs, providerCheckHint, providerDescription, providerSupportsImages, renderRuntimeInsightDetail, renderRuntimeTextWithLinks, runtimeCwdLabel, runtimeUrls, selectedModelImageHint, speechLanguageOptions, mergeAudioChunks } from "./projectToolbarShared";

const subagentProfiles: SubagentModelProfile[] = ["picasso", "sherlock", "solomon", "delphi"];
const subagentProfileLabels: Record<SubagentModelProfile, string> = {
  picasso: "Picasso — Graph design",
  sherlock: "Sherlock — Research",
  solomon: "Solomon — Merge resolution",
  delphi: "Delphi — Test & runtime"
};
const subagentProfileDescriptions: Record<SubagentModelProfile, string> = {
  picasso: "Used for substantial graph design, graph assessment, and reconciliation proposals. Picasso never applies graph changes directly.",
  sherlock: "Used for isolated, read-only project, codebase, topic, and web investigations that return a compact evidence dossier.",
  solomon: "Used to investigate and resolve Git merge conflicts in an isolated merge-resolution run.",
  delphi: "Used for isolated test, visual, runtime, and emulator audits with approved target launch/cleanup, structured evidence, and bounded retries."
};
const phaseProfileDescriptions: Record<LlmPhase, string> = {
  planning: `${gaiaAgent.name} uses this to understand implementation scope and prepare the plan before implementation begins.`,
  coding: `${gaiaAgent.name} uses this while creating and updating project source files.`,
  debugging: `${pandoraAgent.name} uses this to investigate failures and prepare focused source repairs.`,
  review: "Used to review build and runtime results, logs, and implementation outcomes.",
  verifying: "Used for final verification decisions after implementation or debugging work.",
  summarizing: "Used to compact long run and chat context into a smaller durable summary.",
  brainstorming: "Used by the main Archi Research chat. A chat-specific model selection overrides this model choice for that chat."
};

const phaseProfileGroups: Array<{
  id: "archi" | "gaia" | "pandora" | "system";
  title: string;
  description: string;
  profiles: Array<{ phase: LlmPhase; label: string }>;
}> = [
  {
    id: "archi",
    title: "Archi — Research Chat",
    description: "The main chat agent. A model selected inside an individual chat overrides this default for that chat.",
    profiles: [{ phase: "brainstorming", label: "Chat" }]
  },
  {
    id: "gaia",
    title: gaiaAgent.title,
    description: "Planning and implementation remain independently configurable phases of the same AI Implement agent.",
    profiles: [
      { phase: "planning", label: "Planning" },
      { phase: "coding", label: "Implementation / Coding" }
    ]
  },
  {
    id: "pandora",
    title: pandoraAgent.title,
    description: "The AI Debug agent for focused failure investigation, repair, and recovery.",
    profiles: [{ phase: "debugging", label: "Debugging" }]
  },
  {
    id: "system",
    title: "System tasks",
    description: "Supporting model calls that are not standalone agents.",
    profiles: [
      { phase: "review", label: "Build/runtime review" },
      { phase: "verifying", label: "Verification" },
      { phase: "summarizing", label: "Context summary" }
    ]
  }
];

export function ProjectToolbar({
  onResetLayout,
  onRestoreRightSidebar,
  onToggleResearchPanel,
  researchPanelActive,
  rightSidebarCollapsed
}: {
  onResetLayout?: () => void;
  onRestoreRightSidebar?: () => void;
  onToggleResearchPanel?: () => void;
  researchPanelActive?: boolean;
  rightSidebarCollapsed?: boolean;
}) {
  const {
    bundle,
    rootPath,
    activeFlowId,
    selectedNodeId,
    selectedNodeIds,
    reload,
    runAgent,
    runProfile,
    reportBug,
    updateBugIncident,
    startIncidentDebugRun,
    startRuntimeDebugRun,
    startScopedResearchChat,
    runtimeServices,
    stopRuntimeService,
    restartRuntimeService,
    refreshRuntimeServices,
    updateProjectDetails,
    updateSettings,
    checkProvider,
    providerHealth,
    projectSkills,
    mcpServers,
    mcpRegistryEntries,
    mcpRegistryNextCursor,
    mcpRegistryCount,
    capabilityBusy,
    refreshCapabilities,
    createProjectSkill,
    searchMcpRegistry,
    installMcpRegistryServer,
    refreshMcpServerCapabilities,
    theme,
    uiScale,
    toggleTheme,
    setUiScale,
    autoLayout,
    importFlow,
    importDrawioFlow,
    exportActiveFlow,
    exportActiveDrawioFlow,
    exportProjectBundle,
    exportProjectDocument,
    repairProject,
    openInitialCodebaseImportReport,
    deleteProjectState,
    purgeResolvedNotes,
    projectSettingsRequest,
    clearProjectSettingsRequest,
    workbenchView,
    setWorkbenchView,
    openProjectInVsCode,
    globalSpeechSettings,
    globalTtsSettings,
    updateGlobalSpeechSettings,
    updateGlobalTtsSettings
  } = useArchicodeStore(useShallow((state) => ({
    bundle: state.bundle,
    rootPath: state.rootPath,
    activeFlowId: state.activeFlowId,
    selectedNodeId: state.selectedNodeId,
    selectedNodeIds: state.selectedNodeIds,
    reload: state.reload,
    runAgent: state.runAgent,
    runProfile: state.runProfile,
    reportBug: state.reportBug,
    updateBugIncident: state.updateBugIncident,
    startIncidentDebugRun: state.startIncidentDebugRun,
    startRuntimeDebugRun: state.startRuntimeDebugRun,
    startScopedResearchChat: state.startScopedResearchChat,
    runtimeServices: state.runtimeServices,
    stopRuntimeService: state.stopRuntimeService,
    restartRuntimeService: state.restartRuntimeService,
    refreshRuntimeServices: state.refreshRuntimeServices,
    updateProjectDetails: state.updateProjectDetails,
    updateSettings: state.updateSettings,
    checkProvider: state.checkProvider,
    providerHealth: state.providerHealth,
    projectSkills: state.projectSkills,
    mcpServers: state.mcpServers,
    mcpRegistryEntries: state.mcpRegistryEntries,
    mcpRegistryNextCursor: state.mcpRegistryNextCursor,
    mcpRegistryCount: state.mcpRegistryCount,
    capabilityBusy: state.capabilityBusy,
    refreshCapabilities: state.refreshCapabilities,
    createProjectSkill: state.createProjectSkill,
    searchMcpRegistry: state.searchMcpRegistry,
    installMcpRegistryServer: state.installMcpRegistryServer,
    refreshMcpServerCapabilities: state.refreshMcpServerCapabilities,
    theme: state.theme,
    uiScale: state.uiScale,
    toggleTheme: state.toggleTheme,
    setUiScale: state.setUiScale,
    autoLayout: state.autoLayout,
    importFlow: state.importFlow,
    importDrawioFlow: state.importDrawioFlow,
    exportActiveFlow: state.exportActiveFlow,
    exportActiveDrawioFlow: state.exportActiveDrawioFlow,
    exportProjectBundle: state.exportProjectBundle,
    exportProjectDocument: state.exportProjectDocument,
    repairProject: state.repairProject,
    openInitialCodebaseImportReport: state.openInitialCodebaseImportReport,
    deleteProjectState: state.deleteProjectState,
    purgeResolvedNotes: state.purgeResolvedNotes,
    projectSettingsRequest: state.projectSettingsRequest,
    clearProjectSettingsRequest: state.clearProjectSettingsRequest,
    workbenchView: state.workbenchView,
    setWorkbenchView: state.setWorkbenchView,
    openProjectInVsCode: state.openProjectInVsCode,
    globalSpeechSettings: state.globalSpeechSettings,
    globalTtsSettings: state.globalTtsSettings,
    updateGlobalSpeechSettings: state.updateGlobalSpeechSettings,
    updateGlobalTtsSettings: state.updateGlobalTtsSettings
  })));
  const [detailsDraft, setDetailsDraft] = useState({ name: "" });
  const [draft, setDraft] = useState<ProjectSettings | null>(null);
  const [speechDraft, setSpeechDraft] = useState<SpeechSettings>(defaultSpeechSettings);
  const [ttsDraft, setTtsDraft] = useState<TtsSettings>(defaultTtsSettings);
  const [globalResearchPersonality, setGlobalResearchPersonality] = useState<GlobalResearchPersonality>("default");
  const [globalResearchVerbosity, setGlobalResearchVerbosity] = useState<GlobalResearchVerbosity>("default");
  const [runProfilesDraft, setRunProfilesDraft] = useState("[]");
  const [runProfilesError, setRunProfilesError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("general");
  const [implementationEffort, setImplementationEffort] = useState<RunEffort>("auto");
  const [pendingImplementScope, setPendingImplementScope] = useState<RunScope | null>(null);
  const [cleanLayoutConfirmOpen, setCleanLayoutConfirmOpen] = useState(false);
  const [exportDocumentFormat, setExportDocumentFormat] = useState<"pdf" | "html" | null>(null);
  const [selectedExportFlowIds, setSelectedExportFlowIds] = useState<string[]>([]);
  const [exportDocumentBusy, setExportDocumentBusy] = useState(false);
  const [resyncCodebaseOpen, setResyncCodebaseOpen] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const [runtimePanelOpen, setRuntimePanelOpen] = useState(true);
  const [selectedRuntimeLogId, setSelectedRuntimeLogId] = useState<string | null>(null);
  const [runtimeDebugGuidance, setRuntimeDebugGuidance] = useState("");
  const [reportBugOpen, setReportBugOpen] = useState(false);
  const [logicReviewOpen, setLogicReviewOpen] = useState(false);
  const [bugReviewOpen, setBugReviewOpen] = useState(false);
  const [removeBugIncidentId, setRemoveBugIncidentId] = useState<string | null>(null);
  const [selectedBugIds, setSelectedBugIds] = useState<string[]>([]);
  const [bugEdits, setBugEdits] = useState<Record<string, Pick<DebugIncident, "title" | "description" | "priority">>>({});
  const [bugDraft, setBugDraft] = useState({ title: "", description: "", priority: "normal", filePaths: [] as string[] });
  const [skillDraft, setSkillDraft] = useState({ id: "", title: "", description: "", whenToUse: "", instructions: "" });
  const [mcpDraft, setMcpDraft] = useState({ id: "", label: "", transport: "stdio", command: "", args: "", url: "" });
  const [mcpJsonImport, setMcpJsonImport] = useState("");
  const [mcpRegistryQuery, setMcpRegistryQuery] = useState("");
  const [mcpRegistryActiveQuery, setMcpRegistryActiveQuery] = useState("");
  const [mcpRegistryMode, setMcpRegistryMode] = useState<"browse" | "search">("browse");
  const [mcpRegistryCategory, setMcpRegistryCategory] = useState("all");
  const [mcpRegistrySort, setMcpRegistrySort] = useState("registry");
  const [mcpRegistryNotice, setMcpRegistryNotice] = useState<string | null>(null);
  const [mcpRegistryLoading, setMcpRegistryLoading] = useState(false);
  const [mcpRegistryHasStarted, setMcpRegistryHasStarted] = useState(false);
  const [mcpRegistryInstallingId, setMcpRegistryInstallingId] = useState<string | null>(null);
  const [failedMcpIconIds, setFailedMcpIconIds] = useState<Set<string>>(() => new Set());
  const [skillsCollapsed, setSkillsCollapsed] = useState(false);
  const [mcpCollapsed, setMcpCollapsed] = useState(false);
  const [agentInstructionFiles, setAgentInstructionFiles] = useState<Array<{ path: string; exists: boolean; preferred: boolean }>>([]);
  const [agentInstructions, setAgentInstructions] = useState({ path: "AGENTS.md", text: "", exists: false, loadedForRoot: "" });
  const [agentInstructionsDirty, setAgentInstructionsDirty] = useState(false);
  const [agentInstructionsError, setAgentInstructionsError] = useState<string | null>(null);
  const [visibleApiKeyIds, setVisibleApiKeyIds] = useState<Set<string>>(() => new Set());
  const [savedApiKeyIds, setSavedApiKeyIds] = useState<Set<string>>(() => new Set());
  const [visibleBraveApiKey, setVisibleBraveApiKey] = useState(false);
  const [savedWebSearchSecrets, setSavedWebSearchSecrets] = useState<Record<"brave", boolean>>({ brave: false });
  const [webSearchSecretsDraft, setWebSearchSecretsDraft] = useState<{ braveApiKey: string }>({ braveApiKey: "" });
  const [pendingProviderRevealId, setPendingProviderRevealId] = useState<string | null>(null);
  const [pendingModelCheckIds, setPendingModelCheckIds] = useState<Set<string>>(() => new Set());
  const [settingsSaveBusy, setSettingsSaveBusy] = useState(false);
  const [speechStatus, setSpeechStatus] = useState<Awaited<ReturnType<typeof window.archicode.getSpeechStatus>> | null>(null);
  const [speechSetupNotice, setSpeechSetupNotice] = useState<string | null>(null);
  const [speechSetupError, setSpeechSetupError] = useState<string | null>(null);
  const [speechSetupProgress, setSpeechSetupProgress] = useState<string | null>(null);
  const [speechDownloadingModelId, setSpeechDownloadingModelId] = useState<SpeechSettings["modelId"] | null>(null);
  const [speechDeletingModelId, setSpeechDeletingModelId] = useState<SpeechSettings["modelId"] | null>(null);
  const [speechTestRecording, setSpeechTestRecording] = useState(false);
  const [speechTestBusy, setSpeechTestBusy] = useState(false);
  const [speechTestTranscript, setSpeechTestTranscript] = useState<string | null>(null);
  const [ttsStatus, setTtsStatus] = useState<Awaited<ReturnType<typeof window.archicode.getTtsStatus>> | null>(null);
  const [ttsSetupNotice, setTtsSetupNotice] = useState<string | null>(null);
  const [ttsSetupError, setTtsSetupError] = useState<string | null>(null);
  const [ttsSetupProgress, setTtsSetupProgress] = useState<string | null>(null);
  const [ttsDownloadingModelId, setTtsDownloadingModelId] = useState<TtsSettings["modelId"] | null>(null);
  const [ttsDeletingModelId, setTtsDeletingModelId] = useState<TtsSettings["modelId"] | null>(null);
  const [ttsTestBusy, setTtsTestBusy] = useState(false);
  const [externalMcpHostStatus, setExternalMcpHostStatus] = useState<Awaited<ReturnType<typeof window.archicode.getExternalMcpHostStatus>> | null>(null);
  const [externalMcpHostNotice, setExternalMcpHostNotice] = useState<string | null>(null);
  const [externalMcpHostBusy, setExternalMcpHostBusy] = useState(false);
  const [semanticIndexStatus, setSemanticIndexStatus] = useState<Awaited<ReturnType<typeof window.archicode.getSemanticIndexStatus>> | null>(null);
  const [semanticIndexNotice, setSemanticIndexNotice] = useState<string | null>(null);
  const [semanticIndexProgress, setSemanticIndexProgress] = useState<string | null>(null);
  const [semanticIndexBusy, setSemanticIndexBusy] = useState(false);
  const [semanticModelPreference, setSemanticModelPreference] = useState<"bge-small-en-v1.5" | "minilm-l6-v2">("bge-small-en-v1.5");
  const [semanticModelSwitching, setSemanticModelSwitching] = useState(false);
  const toolbarActionsRef = useRef<HTMLDivElement | null>(null);
  const draftProjectRootRef = useRef<string | null>(null);
  const speechStreamRef = useRef<MediaStream | null>(null);
  const speechAudioContextRef = useRef<AudioContext | null>(null);
  const speechSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const speechProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const speechChunksRef = useRef<Float32Array[]>([]);
  const speechSampleRateRef = useRef(44100);
  const ttsTestAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsTestAudioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (bundle) {
      const nextProjectRoot = rootPath ?? null;
      const projectChanged = draftProjectRootRef.current !== nextProjectRoot;
      if (settingsOpen && !projectChanged) return;
      draftProjectRootRef.current = nextProjectRoot;
      setDetailsDraft({ name: bundle.project.name });
      setDraft(bundle.project.settings);
      setRunProfilesDraft(JSON.stringify(bundle.project.settings.runTargetProfiles, null, 2));
      setRunProfilesError(null);
      setWebSearchSecretsDraft({ braveApiKey: "" });
      setVisibleBraveApiKey(false);
    }
  }, [bundle, rootPath, settingsOpen]);

  useEffect(() => {
    if (!projectSettingsRequest) return;
    if (projectSettingsRequest.tab !== "shortcuts" && !bundle) return;
    setSettingsTab(projectSettingsRequest.tab);
    setSettingsOpen(true);
    clearProjectSettingsRequest(projectSettingsRequest.nonce);
  }, [bundle, clearProjectSettingsRequest, projectSettingsRequest]);

  useEffect(() => {
    if (settingsOpen) return;
    setMcpRegistryQuery("");
    setMcpRegistryActiveQuery("");
    setMcpRegistryMode("browse");
    setMcpRegistryHasStarted(false);
    setMcpRegistryNotice(null);
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    if (!window.archicode?.getGlobalResearchPersonality || !window.archicode?.getGlobalResearchVerbosity) return;
    let cancelled = false;
    void (async () => {
      const [nextPersonality, nextVerbosity] = await Promise.all([
        window.archicode.getGlobalResearchPersonality(),
        window.archicode.getGlobalResearchVerbosity()
      ]);
      if (!cancelled) {
        setGlobalResearchPersonality(nextPersonality);
        setGlobalResearchVerbosity(nextVerbosity);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    setSpeechDraft(globalSpeechSettings ?? defaultSpeechSettings);
    setTtsDraft(globalTtsSettings ?? defaultTtsSettings);
  }, [settingsOpen, globalSpeechSettings, globalTtsSettings]);

  useEffect(() => {
    const handleOpenProjectSettings = (event: Event) => {
      const requestedTab = (event as CustomEvent<{ tab?: ProjectSettingsTab }>).detail?.tab ?? "general";
      if (!projectSettingsTabs.has(requestedTab)) return;
      setSettingsTab(requestedTab);
      setSettingsOpen(true);
    };
    window.addEventListener("archicode:open-project-settings", handleOpenProjectSettings);
    return () => window.removeEventListener("archicode:open-project-settings", handleOpenProjectSettings);
  }, []);

  useEffect(() => {
    const handleOpenCodebaseResync = () => setResyncCodebaseOpen(true);
    window.addEventListener("archicode:open-codebase-resync", handleOpenCodebaseResync);
    return () => window.removeEventListener("archicode:open-codebase-resync", handleOpenCodebaseResync);
  }, []);

  useEffect(() => {
    const toggleRuntimePanel = () => {
      setRuntimePanelOpen((open) => !open);
    };
    window.addEventListener("archicode:toggle-runtime-panel", toggleRuntimePanel);
    return () => window.removeEventListener("archicode:toggle-runtime-panel", toggleRuntimePanel);
  }, []);

  useEffect(() => {
    if (!bundle) return;
    const refreshVisibleRuntimeServices = () => {
      if (document.visibilityState !== "hidden") void refreshRuntimeServices();
    };
    const timer = window.setInterval(() => {
      refreshVisibleRuntimeServices();
    }, 2000);
    document.addEventListener("visibilitychange", refreshVisibleRuntimeServices);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisibleRuntimeServices);
    };
  }, [bundle, refreshRuntimeServices]);

  useEffect(() => {
    if (settingsOpen && bundle) void refreshCapabilities();
  }, [settingsOpen, bundle, refreshCapabilities]);

  useEffect(() => {
    if (!settingsOpen) return;
    const updateScrollableSettingsPanels = () => {
      const panels = Array.from(document.querySelectorAll<HTMLElement>(".settings-modal .settings-tab-content"));
      for (const panel of panels) {
        const panelScrollable = panel.scrollHeight > panel.clientHeight + 1;
        panel.dataset.scrollable = panelScrollable ? "true" : "false";
      }
    };

    const frame = window.requestAnimationFrame(updateScrollableSettingsPanels);
    const resizeObserver = new ResizeObserver(updateScrollableSettingsPanels);
    const mutationObserver = new MutationObserver(updateScrollableSettingsPanels);
    const root = document.querySelector<HTMLElement>(".settings-modal");
    if (root) {
      resizeObserver.observe(root);
      root.querySelectorAll<HTMLElement>(".settings-tab-content").forEach((element) => {
        resizeObserver.observe(element);
      });
      mutationObserver.observe(root, { childList: true, subtree: true });
    }
    window.addEventListener("resize", updateScrollableSettingsPanels);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", updateScrollableSettingsPanels);
    };
  }, [
    settingsOpen,
    settingsTab,
    draft,
    mcpCollapsed,
    skillsCollapsed,
    mcpRegistryEntries.length,
    mcpRegistryLoading,
    mcpRegistryHasStarted
  ]);

  const refreshSavedApiKeyStatus = useCallback(async (): Promise<Set<string>> => {
    if (!window.archicode?.getGlobalProviderSecretStatus) {
      const next = new Set<string>();
      setSavedApiKeyIds(next);
      return next;
    }
    const status = await window.archicode.getGlobalProviderSecretStatus();
    const next = new Set(Object.entries(status).filter(([, saved]) => saved).map(([providerId]) => providerId));
    setSavedApiKeyIds(next);
    return next;
  }, []);

  const refreshWebSearchSecretStatus = useCallback(async (): Promise<Record<"brave", boolean>> => {
    if (!window.archicode?.getWebSearchSecretStatus) {
      const next = { brave: false };
      setSavedWebSearchSecrets(next);
      return next;
    }
    const status = await window.archicode.getWebSearchSecretStatus();
    setSavedWebSearchSecrets(status);
    return status;
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    void refreshSavedApiKeyStatus();
    void refreshWebSearchSecretStatus();
  }, [refreshSavedApiKeyStatus, refreshWebSearchSecretStatus, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen || !rootPath || settingsTab !== "agent-memory") return;
    let cancelled = false;
    void (async () => {
      try {
        const files = await window.archicode.listAgentInstructionFiles(rootPath);
        const selectedPath = files.find((file) => file.preferred)?.path ?? "AGENTS.md";
        const instructions = await window.archicode.readAgentInstructionFile(rootPath, selectedPath);
        if (cancelled) return;
        setAgentInstructionFiles(files);
        setAgentInstructions({ ...instructions, loadedForRoot: rootPath });
        setAgentInstructionsDirty(false);
        setAgentInstructionsError(null);
      } catch (error) {
        if (!cancelled) setAgentInstructionsError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, rootPath, settingsTab]);

  const enabledProvider = draft?.providers.find((provider) => provider.enabled);
  const activeProviderHealth = enabledProvider ? providerHealth[enabledProvider.id] : null;
  const buildCommand = bundle?.project.settings.defaultBuildCommand.trim() ?? "";
  const runCommand = bundle?.project.settings.defaultRunCommand.trim() ?? "";
  const runProfiles = bundle?.project.settings.runTargetProfiles ?? [];
  const projectRuns = bundle?.runs ?? [];
  const visibleRuntimeServices = runtimeServices.filter((service) => service.status !== "stopped");
  const runningRuntimeCount = visibleRuntimeServices.filter((service) => service.status === "running" || service.status === "starting").length;
  const resolvedNoteCount = bundle?.notes.filter((note) => note.resolved).length ?? 0;
  const openBugReports = bundle?.incidents.filter((incident) => incident.status === "open" && (!activeFlowId || !incident.flowId || incident.flowId === activeFlowId)) ?? [];
  const debugSignalCount = (bundle?.incidents.filter((incident) => incident.status === "open").length ?? 0) +
    (bundle?.notes.filter((note) => note.category === "bug" && !note.resolved).length ?? 0) +
    projectRuns.filter((run) => !run.queueRemovedAt && Boolean(runFailureMessage(run, projectRuns))).length +
    runtimeServices.filter((service) => service.status === "failed" || service.status === "stale").length;
  const selectedRuntimeLogService = runtimeServices.find((service) => service.id === selectedRuntimeLogId) ?? null;
  const contextBudgetPlan = draft ? deriveContextBudgetPlan(draft) : null;
  const showMacKeychainNote = isMacRuntime();
  const runChangeBlocked = Boolean(bundle?.runs.some(isRunBlockingNewChange));
  const activeFlow = bundle
    ? bundle.flows.find((flow) => flow.id === activeFlowId) ?? bundle.flows.find((flow) => flow.id === bundle.project.activeFlowId) ?? bundle.flows[0] ?? null
    : null;
  const selectedImplementNodeIds = Array.from(new Set(selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : []))
    .filter((nodeId) => activeFlow?.nodes.some((node) => node.id === nodeId && !node.ignored && !isSubflowIgnored(activeFlow, node.subflowId)));
  const selectedImplementNodeLabel = selectedImplementNodeIds.length === 1
    ? activeFlow?.nodes.find((node) => node.id === selectedImplementNodeIds[0])?.title ?? "selected node"
    : `${selectedImplementNodeIds.length} selected nodes`;
  const aiImplementPrompt = (scopePhrase: string) => buildCommand
    ? `Plan from ${scopePhrase} using node stages, flags, diffs, notes, artifacts, edges, and acceptance criteria. If required info is missing, abort coding and ask clarification questions as node notes. If sufficient, code, add or update meaningful tests only when the existing stack or risk warrants it, and let ArchiCode verify with: ${buildCommand}. If tests cannot be added or run, explain why and mark affected nodes as needing attention.`
    : `Plan from ${scopePhrase} using node stages, flags, diffs, notes, artifacts, edges, and acceptance criteria. If required info is missing, abort coding and ask clarification questions as node notes. If sufficient, code, add or update meaningful tests only when the existing stack or risk warrants it, and identify the correct verification command if needed. If tests cannot be added or run, explain why and mark affected nodes as needing attention.`;
  const implementationEffortLabel = implementationEffort === "auto"
    ? "Auto"
    : implementationEffort === "fast"
      ? "Fast"
      : "High";
  const implementScopePhrase = (scope: RunScope) => scope.kind === "project"
    ? "the whole project"
    : scope.kind === "flow"
      ? `flow "${activeFlow?.name ?? "current flow"}"`
      : `selected node scope "${selectedImplementNodeLabel}"`;
  const startAiImplement = (scope: RunScope) => {
    const scopePhrase = implementScopePhrase(scope);
    void runAgent({
      nodeId: scope.kind === "nodes" ? selectedImplementNodeIds[0] : undefined,
      scope,
      effort: implementationEffort,
      promptSummary: aiImplementPrompt(scopePhrase)
    });
  };
  const startBuildRun = () => runAgent(buildCommand
      ? {
        purpose: "build-discovery",
        promptSummary: `Run project build command: ${buildCommand}`,
        effort: "fast",
        command: buildCommand
      }
    : {
        purpose: "build-discovery",
        effort: "fast",
        promptSummary: "Detect the project's finite build/test verification target, create or update ArchiCode build/run configuration if needed, then actually build or run that finite verification command and troubleshoot setup issues until it passes or a concrete blocker is reported. Do not start dev, watch, serve, preview, simulator, or emulator processes; Run App owns runtime launch."
      });
  const startRunAppDiscovery = () => runAgent({
    purpose: "run-discovery",
    promptSummary: "Detect the app runtime target and create or update an ArchiCode Run App profile for this project. Do not start long-running dev, watch, serve, preview, simulator, or emulator processes in this AI run; leave the profile ready for the next Run App launch."
  });
  const startLogicReview = (target: LogicReviewTarget) => {
    if (!bundle) return;
    const scope = target.kind === "flow"
      ? activeFlow
        ? { type: "flow" as const, flowId: activeFlow.id }
        : null
      : { type: "project" as const, projectId: bundle.project.id };
    if (!scope) return;
    setLogicReviewOpen(false);
    void startScopedResearchChat(scope, buildLogicReviewPrompt(target));
  };
  async function submitBugReport(): Promise<void> {
    if (!bugDraft.title.trim() || !bugDraft.description.trim()) return;
    await reportBug({
      title: bugDraft.title.trim(),
      description: bugDraft.description.trim(),
      priority: bugDraft.priority as "low" | "normal" | "high" | "urgent",
      filePaths: bugDraft.filePaths
    });
    setBugDraft({ title: "", description: "", priority: "normal", filePaths: [] });
    setReportBugOpen(false);
  }
  const openBugReview = () => {
    setSelectedBugIds(openBugReports.map((incident) => incident.id));
    setBugEdits(Object.fromEntries(openBugReports.map((incident) => [incident.id, {
      title: incident.title,
      description: incident.description,
      priority: incident.priority
    }])));
    setBugReviewOpen(true);
  };
  const saveBugEdit = async (incidentId: string) => {
    const edit = bugEdits[incidentId];
    if (!edit?.title.trim() || !edit.description.trim()) return;
    await updateBugIncident(incidentId, {
      title: edit.title.trim(),
      description: edit.description.trim(),
      priority: edit.priority
    });
  };
  const fixSelectedBugReports = async () => {
    const incidentIds = [...selectedBugIds];
    for (const incidentId of incidentIds) await saveBugEdit(incidentId);
    setBugReviewOpen(false);
    await startIncidentDebugRun(incidentIds);
  };
  const providerStatusTitle = `Settings - Provider : ${enabledProvider?.label ?? "None"}`;
  const providerStatusOk = Boolean(enabledProvider && activeProviderHealth?.ok !== false);
  const providerStatusClass = providerStatusOk ? "is-ok" : "is-bad";
  const implementTooltip = runChangeBlocked
    ? `${gaiaAgent.title}. A run is already active or waiting for review.`
    : buildCommand
      ? `${gaiaAgent.title}. Choose Project, Flow, or Nodes scope, then plan, code, test, and verify with: ${buildCommand}`
      : `${gaiaAgent.title}. Choose Project, Flow, or Nodes scope, then plan, code, and identify the right tests/verification.`;
  const buildTooltip = buildCommand
    ? `Run configured build command: ${buildCommand}`
    : "Ask AI to detect the build or verification target and troubleshoot setup.";
  const debugTooltip = runChangeBlocked
    ? `${pandoraAgent.title}. AI Debug is unavailable while another AI run is active or waiting for review.`
    : debugSignalCount
      ? `${pandoraAgent.title}. Review flow logic, or debug ${debugSignalCount} flagged bug/failure signal${debugSignalCount === 1 ? "" : "s"}.`
      : `${pandoraAgent.title}. Review flow logic in chat, report a bug, or wait for a failed run/runtime before starting AI Debug.`;
  const runTooltip = runProfiles.length
    ? "Choose a runtime profile to start as an independent service."
    : runCommand
      ? `Run configured app command: ${runCommand}`
      : "Ask AI to detect or create a Run App target.";
  const aiRunTooltip = runChangeBlocked
    ? "A run is already active or waiting for review."
    : "Choose Build or a Run App target.";

  useEffect(() => {
    if (!visibleRuntimeServices.length) setRuntimePanelOpen(true);
  }, [visibleRuntimeServices.length]);

  const updateDraft = (patch: Partial<ProjectSettings>) => {
    setDraft((current) => current ? { ...current, ...patch } : current);
  };

  const selectSpeechModel = useCallback((modelId: SpeechSettings["modelId"]) => {
    setSpeechDraft((current) => ({
      ...current,
      modelId,
      language: modelId === "base.en" ? "english" : normalizeSpeechLanguage(current.language),
      translateToEnglish: modelId === "base.en" ? false : current.translateToEnglish
    }));
  }, []);

  const refreshSpeechStatus = useCallback(async (modelId?: SpeechSettings["modelId"]) => {
    try {
      const status = await window.archicode.getSpeechStatus(modelId ?? speechDraft.modelId ?? "base");
      setSpeechStatus(status);
      setSpeechSetupError(null);
      return status;
    } catch (error) {
      setSpeechSetupError(error instanceof Error ? error.message : "Could not read speech runtime status.");
      return null;
    }
  }, [speechDraft.modelId]);

  const stopSpeechSetupCapture = useCallback(async () => {
    speechProcessorRef.current?.disconnect();
    speechSourceRef.current?.disconnect();
    speechStreamRef.current?.getTracks().forEach((track) => track.stop());
    const audioContext = speechAudioContextRef.current;
    speechProcessorRef.current = null;
    speechSourceRef.current = null;
    speechStreamRef.current = null;
    speechAudioContextRef.current = null;
    setSpeechTestRecording(false);
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close();
    }
  }, []);

  const updateSpeechModelStatus = useCallback((modelStatus: Awaited<ReturnType<typeof window.archicode.downloadSpeechModel>>) => {
    setSpeechStatus((current) => current ? {
      ...current,
      models: current.models.map((model) => model.id === modelStatus.id ? modelStatus : model)
    } : current);
  }, []);

  const downloadSpeechSetupModel = useCallback(async (modelId: SpeechSettings["modelId"]) => {
    const model = speechStatus?.models.find((item) => item.id === modelId);
    setSpeechDownloadingModelId(modelId);
    setSpeechSetupError(null);
    setSpeechSetupNotice(null);
    setSpeechSetupProgress(`Downloading ${model?.label ?? modelId}...`);
    try {
      const modelStatus = await window.archicode.downloadSpeechModel(modelId);
      updateSpeechModelStatus(modelStatus);
      setSpeechSetupProgress(null);
      setSpeechSetupNotice(`${model?.label ?? modelId} is ready.`);
    } catch (error) {
      setSpeechSetupError(error instanceof Error ? error.message : "Could not download the speech model.");
    } finally {
      setSpeechDownloadingModelId(null);
    }
  }, [refreshSpeechStatus, speechStatus?.models, updateSpeechModelStatus]);

  const deleteSpeechSetupModel = useCallback(async (modelId: SpeechSettings["modelId"]) => {
    const model = speechStatus?.models.find((item) => item.id === modelId);
    if (!model?.downloaded) return;
    if (!window.confirm(`Delete downloaded speech model "${model.label}" from this device?`)) return;
    setSpeechDeletingModelId(modelId);
    setSpeechSetupError(null);
    setSpeechSetupNotice(null);
    setSpeechSetupProgress(null);
    try {
      const modelStatus = await window.archicode.deleteSpeechModel(modelId);
      updateSpeechModelStatus(modelStatus);
      setSpeechSetupNotice(`${model.label} was deleted.`);
    } catch (error) {
      setSpeechSetupError(error instanceof Error ? error.message : "Could not delete the speech model.");
    } finally {
      setSpeechDeletingModelId(null);
    }
  }, [speechDraft.modelId, refreshSpeechStatus, speechStatus?.models, updateSpeechModelStatus]);

  const startSpeechSetupTest = useCallback(async () => {
    if (!speechDraft.enabled) {
      setSpeechSetupError("Voice input is disabled.");
      return;
    }
    const status = speechStatus ?? await refreshSpeechStatus(speechDraft.modelId);
    const model = status?.models.find((item) => item.id === speechDraft.modelId);
    if (!status?.runtimeAvailable) {
      setSpeechSetupError(status?.runtimeError ?? "Speech runtime is unavailable.");
      return;
    }
    if (!model?.downloaded) {
      setSpeechSetupError("Download the active speech model before testing.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setSpeechSetupError("Microphone capture is not available in this runtime.");
      return;
    }

    try {
      setSpeechSetupError(null);
      setSpeechSetupNotice("Recording test audio...");
      setSpeechSetupProgress(null);
      setSpeechTestTranscript(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      const AudioContextConstructor = window.AudioContext;
      const audioContext = new AudioContextConstructor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      speechChunksRef.current = [];
      speechSampleRateRef.current = audioContext.sampleRate;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        event.outputBuffer.getChannelData(0).fill(0);
        speechChunksRef.current.push(new Float32Array(input));
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      speechStreamRef.current = stream;
      speechAudioContextRef.current = audioContext;
      speechSourceRef.current = source;
      speechProcessorRef.current = processor;
      if (audioContext.state === "suspended") await audioContext.resume();
      setSpeechTestRecording(true);
    } catch (error) {
      await stopSpeechSetupCapture();
      setSpeechSetupNotice(null);
      setSpeechSetupError(error instanceof Error ? error.message : "Could not start microphone capture.");
    }
  }, [speechDraft.enabled, speechDraft.modelId, refreshSpeechStatus, speechStatus, stopSpeechSetupCapture]);

  const stopSpeechSetupTest = useCallback(async () => {
    const chunks = speechChunksRef.current;
    const sampleRate = speechSampleRateRef.current;
    await stopSpeechSetupCapture();
    if (!chunks.length) {
      setSpeechSetupNotice(null);
      setSpeechSetupError("No microphone audio was captured.");
      return;
    }

    setSpeechTestBusy(true);
    setSpeechSetupError(null);
    setSpeechSetupNotice(null);
    setSpeechSetupProgress("Transcribing test audio...");
    try {
      const audio = encodeWav(chunks, sampleRate);
      const result = await window.archicode.transcribeSpeech({
        audio,
        modelId: speechDraft.modelId,
        language: speechDraft.language,
        translateToEnglish: speechDraft.translateToEnglish,
        threads: speechDraft.threads
      });
      setSpeechTestTranscript(result.text || "(No speech detected.)");
      setSpeechSetupProgress(null);
      setSpeechSetupNotice(`Transcribed in ${(result.durationMs / 1000).toFixed(1)}s.`);
    } catch (error) {
      setSpeechSetupProgress(null);
      setSpeechSetupError(error instanceof Error ? error.message : "Could not transcribe test audio.");
    } finally {
      setSpeechTestBusy(false);
      speechChunksRef.current = [];
    }
  }, [speechDraft, stopSpeechSetupCapture]);

  const runSpeechSetupTest = useCallback(async () => {
    if (speechTestRecording) {
      await stopSpeechSetupTest();
      return;
    }
    await startSpeechSetupTest();
  }, [speechTestRecording, startSpeechSetupTest, stopSpeechSetupTest]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "advanced") return;
    void refreshSpeechStatus(speechDraft.modelId);
  }, [speechDraft.modelId, refreshSpeechStatus, settingsOpen, settingsTab]);

  useEffect(() => {
    if (!settingsOpen || !window.archicode?.onSpeechModelDownloadProgress) return;
    return window.archicode.onSpeechModelDownloadProgress((progress) => {
      if (speechDownloadingModelId && progress.modelId !== speechDownloadingModelId) return;
      const total = progress.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : "";
      setSpeechSetupProgress(`Downloading ${formatBytes(progress.receivedBytes)}${total}`);
    });
  }, [settingsOpen, speechDownloadingModelId]);

  useEffect(() => {
    if (settingsOpen) return;
    void stopSpeechSetupCapture();
  }, [settingsOpen, stopSpeechSetupCapture]);

  useEffect(() => () => {
    void stopSpeechSetupCapture();
  }, [stopSpeechSetupCapture]);

  const stopTtsTestAudio = useCallback(() => {
    ttsTestAudioRef.current?.pause();
    ttsTestAudioRef.current = null;
    if (ttsTestAudioUrlRef.current) {
      URL.revokeObjectURL(ttsTestAudioUrlRef.current);
      ttsTestAudioUrlRef.current = null;
    }
  }, []);

  const refreshTtsStatus = useCallback(async (modelId?: TtsSettings["modelId"]) => {
    try {
      const status = await window.archicode.getTtsStatus(modelId ?? ttsDraft.modelId ?? "kokoro-82m");
      setTtsStatus(status);
      setTtsSetupError(null);
      return status;
    } catch (error) {
      setTtsSetupError(error instanceof Error ? error.message : "Could not read text-to-speech runtime status.");
      return null;
    }
  }, [ttsDraft.modelId]);

  const updateTtsModelStatus = useCallback((modelStatus: Awaited<ReturnType<typeof window.archicode.downloadTtsModel>>) => {
    setTtsStatus((current) => current ? {
      ...current,
      models: current.models.map((model) => model.id === modelStatus.id ? modelStatus : model)
    } : current);
  }, []);

  const downloadTtsSetupModel = useCallback(async (modelId: TtsSettings["modelId"]) => {
    const model = ttsStatus?.models.find((item) => item.id === modelId);
    setTtsDownloadingModelId(modelId);
    setTtsSetupError(null);
    setTtsSetupNotice(null);
    setTtsSetupProgress(`Downloading ${model?.label ?? modelId}...`);
    try {
      const modelStatus = await window.archicode.downloadTtsModel(modelId, ttsDraft.voiceId);
      updateTtsModelStatus(modelStatus);
      setTtsSetupProgress(null);
      setTtsSetupNotice(`${model?.label ?? modelId} is ready.`);
    } catch (error) {
      setTtsSetupError(error instanceof Error ? error.message : "Could not download the text-to-speech model.");
    } finally {
      setTtsDownloadingModelId(null);
    }
  }, [ttsDraft.voiceId, ttsStatus?.models, updateTtsModelStatus]);

  const deleteTtsSetupModel = useCallback(async (modelId: TtsSettings["modelId"]) => {
    const model = ttsStatus?.models.find((item) => item.id === modelId);
    if (!model?.downloaded) return;
    if (!window.confirm(`Delete downloaded text-to-speech model "${model.label}" from this device?`)) return;
    stopTtsTestAudio();
    setTtsDeletingModelId(modelId);
    setTtsSetupError(null);
    setTtsSetupNotice(null);
    setTtsSetupProgress(null);
    try {
      const modelStatus = await window.archicode.deleteTtsModel(modelId);
      updateTtsModelStatus(modelStatus);
      setTtsSetupNotice(`${model.label} was deleted.`);
    } catch (error) {
      setTtsSetupError(error instanceof Error ? error.message : "Could not delete the text-to-speech model.");
    } finally {
      setTtsDeletingModelId(null);
    }
  }, [stopTtsTestAudio, ttsStatus?.models, updateTtsModelStatus]);

  const playTtsSetupTest = useCallback(async () => {
    if (!ttsDraft.enabled) {
      setTtsSetupError("Voice output is disabled.");
      return;
    }
    const status = ttsStatus ?? await refreshTtsStatus(ttsDraft.modelId);
    const model = status?.models.find((item) => item.id === ttsDraft.modelId);
    if (!status?.runtimeAvailable) {
      setTtsSetupError(status?.runtimeError ?? "Text-to-speech runtime is unavailable.");
      return;
    }
    if (!model?.downloaded) {
      setTtsSetupError("Download the active text-to-speech model before testing.");
      return;
    }

    stopTtsTestAudio();
    setTtsTestBusy(true);
    setTtsSetupError(null);
    setTtsSetupNotice(null);
    setTtsSetupProgress("Generating test audio...");
    try {
      const result = await window.archicode.synthesizeSpeech({
        text: "Voice output is ready for ArchiCode research chat.",
        modelId: ttsDraft.modelId,
        voiceId: ttsDraft.voiceId,
        speed: ttsDraft.speed
      });
      const blob = new Blob([result.audio], { type: result.mimeType });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      ttsTestAudioRef.current = audio;
      ttsTestAudioUrlRef.current = url;
      audio.onended = stopTtsTestAudio;
      audio.onerror = () => {
        stopTtsTestAudio();
        setTtsSetupError("Could not play generated test audio.");
      };
      await audio.play();
      setTtsSetupProgress(null);
      setTtsSetupNotice(`Generated ${(result.durationMs / 1000).toFixed(1)}s of audio in ${(result.generationMs / 1000).toFixed(1)}s.`);
    } catch (error) {
      stopTtsTestAudio();
      setTtsSetupProgress(null);
      setTtsSetupError(error instanceof Error ? error.message : "Could not generate test audio.");
    } finally {
      setTtsTestBusy(false);
    }
  }, [ttsDraft, refreshTtsStatus, stopTtsTestAudio, ttsStatus]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "advanced") return;
    void refreshTtsStatus(ttsDraft.modelId);
  }, [ttsDraft.modelId, refreshTtsStatus, settingsOpen, settingsTab]);

  const refreshExternalMcpHostStatus = useCallback(async () => {
    if (!rootPath || !window.archicode?.getExternalMcpHostStatus) {
      setExternalMcpHostStatus(null);
      return null;
    }
    const status = await window.archicode.getExternalMcpHostStatus(rootPath);
    setExternalMcpHostStatus(status);
    return status;
  }, [rootPath]);

  const refreshSemanticIndexStatus = useCallback(async () => {
    if (!rootPath || !window.archicode?.getSemanticIndexStatus) {
      setSemanticIndexStatus(null);
      return null;
    }
    try {
      const status = await window.archicode.getSemanticIndexStatus(rootPath);
      setSemanticIndexStatus(status);
      return status;
    } catch (error) {
      setSemanticIndexNotice(error instanceof Error ? error.message : "Could not read semantic index status.");
      return null;
    }
  }, [rootPath]);

  const rebuildSemanticIndex = useCallback(async () => {
    if (!rootPath || !window.archicode?.rebuildSemanticIndex) return;
    setSemanticIndexBusy(true);
    setSemanticIndexNotice(null);
    setSemanticIndexProgress("Scanning graph and code…");
    try {
      const status = await window.archicode.rebuildSemanticIndex(rootPath);
      setSemanticIndexStatus(status);
      setSemanticIndexNotice(status.state === "ready" ? `Semantic index rebuilt with ${status.indexedItems.toLocaleString()} items.` : status.message);
    } catch (error) {
      setSemanticIndexNotice(error instanceof Error ? error.message : "Could not rebuild the semantic index.");
    } finally {
      setSemanticIndexBusy(false);
      setSemanticIndexProgress(null);
    }
  }, [rootPath]);

  const clearSemanticIndexCache = useCallback(async () => {
    if (!rootPath || !window.archicode?.clearSemanticIndex) return;
    setSemanticIndexBusy(true);
    setSemanticIndexNotice(null);
    try {
      const status = await window.archicode.clearSemanticIndex(rootPath);
      setSemanticIndexStatus(status);
      setSemanticIndexNotice("Local semantic cache cleared.");
    } catch (error) {
      setSemanticIndexNotice(error instanceof Error ? error.message : "Could not clear the semantic cache.");
    } finally {
      setSemanticIndexBusy(false);
    }
  }, [rootPath]);

  const switchSemanticModel = useCallback(async (preference: "bge-small-en-v1.5" | "minilm-l6-v2") => {
    if (!window.archicode?.setSemanticModelPreference || preference === semanticModelPreference) return;
    const previous = semanticModelPreference;
    setSemanticModelPreference(preference);
    setSemanticModelSwitching(true);
    setSemanticIndexNotice(null);
    setSemanticIndexProgress("Switching model and rebuilding the local index…");
    try {
      await window.archicode.setSemanticModelPreference(preference, rootPath ?? undefined);
      setSemanticIndexNotice("Embedding model changed. The local semantic index is rebuilding automatically.");
      await refreshSemanticIndexStatus();
    } catch (error) {
      setSemanticModelPreference(previous);
      setSemanticIndexNotice(error instanceof Error ? error.message : "Could not switch the semantic model.");
    } finally {
      setSemanticModelSwitching(false);
    }
  }, [refreshSemanticIndexStatus, rootPath, semanticModelPreference]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "advanced") return;
    void refreshSemanticIndexStatus();
    if (window.archicode?.getSemanticModelPreference) {
      void window.archicode.getSemanticModelPreference().then(setSemanticModelPreference).catch(() => undefined);
    }
  }, [refreshSemanticIndexStatus, settingsOpen, settingsTab]);

  useEffect(() => {
    if (!settingsOpen || !window.archicode?.onSemanticIndexProgress) return;
    return window.archicode.onSemanticIndexProgress((progress) => {
      if (progress.projectRoot && progress.projectRoot !== rootPath) return;
      setSemanticIndexProgress(progress.phase === "ready" ? null : progress.message);
      if (progress.phase === "ready" || progress.phase === "error") void refreshSemanticIndexStatus();
    });
  }, [refreshSemanticIndexStatus, rootPath, semanticIndexBusy, settingsOpen]);

  useEffect(() => {
    if (!semanticIndexBusy && semanticIndexStatus?.state !== "indexing") setSemanticIndexProgress(null);
  }, [semanticIndexBusy, semanticIndexStatus?.state]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "advanced") return;
    void refreshExternalMcpHostStatus();
  }, [refreshExternalMcpHostStatus, settingsOpen, settingsTab]);

  const copyExternalMcpText = (text: string, label: string) => {
    window.archicode.copyTextToClipboard(text);
    setExternalMcpHostNotice(`${label} copied.`);
  };

  const regenerateExternalMcpHostToken = async () => {
    if (!rootPath || !window.archicode?.regenerateExternalMcpHostToken) return;
    setExternalMcpHostBusy(true);
    try {
      const status = await window.archicode.regenerateExternalMcpHostToken(rootPath);
      setExternalMcpHostStatus(status);
      setExternalMcpHostNotice("Hosted MCP token regenerated.");
    } finally {
      setExternalMcpHostBusy(false);
    }
  };

  useEffect(() => {
    if (!settingsOpen || !window.archicode?.onTtsModelDownloadProgress) return;
    return window.archicode.onTtsModelDownloadProgress((progress) => {
      if (ttsDownloadingModelId && progress.modelId !== ttsDownloadingModelId) return;
      const total = progress.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : "";
      setTtsSetupProgress(`Downloading ${formatBytes(progress.receivedBytes)}${total}`);
    });
  }, [settingsOpen, ttsDownloadingModelId]);

  useEffect(() => () => {
    stopTtsTestAudio();
  }, [stopTtsTestAudio]);

  const updateProvider = (providerId: string, patch: Partial<ProjectSettings["providers"][number]>) => {
    updateDraft({
      providers: draft?.providers.map((provider) => provider.id === providerId ? { ...provider, ...patch } : provider) ?? []
    });
  };

  const addProviderProfile = (kind: ProviderKind = "openai-compatible") => {
    if (!draft) return;
    const provider = createProviderProfile(draft.providers, kind);
    setPendingProviderRevealId(provider.id);
    updateDraft({ providers: [...draft.providers, provider] });
  };

  const duplicateProvider = (providerId: string) => {
    if (!draft) return;
    const source = draft.providers.find((provider) => provider.id === providerId);
    if (!source) return;
    const duplicate = duplicateProviderProfile(draft.providers, source);
    setPendingProviderRevealId(duplicate.id);
    updateDraft({ providers: [...draft.providers, duplicate] });
  };

  const removeProvider = (providerId: string) => {
    if (!draft) return;
    updateDraft({ providers: removeProviderProfile(draft.providers, providerId) });
  };

  const changeProviderKind = (providerId: string, kind: ProviderKind) => {
    if (!draft) return;
    updateDraft({
      providers: draft.providers.map((provider) => provider.id === providerId
        ? changeProviderCompatibility(provider, kind)
        : provider)
    });
    setVisibleApiKeyIds((current) => {
      if (!current.has(providerId)) return current;
      const next = new Set(current);
      next.delete(providerId);
      return next;
    });
    setPendingModelCheckIds((current) => {
      if (!current.has(providerId)) return current;
      const next = new Set(current);
      next.delete(providerId);
      return next;
    });
  };

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "providers" || !draft || !pendingProviderRevealId) return;
    if (!draft.providers.some((provider) => provider.id === pendingProviderRevealId)) return;
    const frame = window.requestAnimationFrame(() => {
      const providerCard = document.querySelector<HTMLElement>(`[data-provider-card="${pendingProviderRevealId}"]`);
      const nameInput = document.querySelector<HTMLInputElement>(`input[data-provider-name-input="${pendingProviderRevealId}"]`);
      providerCard?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      nameInput?.focus();
      nameInput?.select();
      setPendingProviderRevealId((current) => current === pendingProviderRevealId ? null : current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draft, pendingProviderRevealId, settingsOpen, settingsTab]);

  useEffect(() => {
    if (!draft) return;
    const nextProviders = draft.providers.map(normalizeProviderModelSelections);
    if (JSON.stringify(nextProviders) !== JSON.stringify(draft.providers)) {
      updateDraft({ providers: nextProviders });
    }
  }, [draft]);

  const refreshCheckedProviderDraft = async (providerId: string) => {
    if (!window.archicode?.getGlobalProviders) return;
    const checkedProviders = await window.archicode.getGlobalProviders();
    const checkedProvider = checkedProviders.find((provider) => provider.id === providerId);
    if (!checkedProvider) return;
    setDraft((current) => current
      ? { ...current, providers: mergeProviderCapabilityMetadata(current.providers, checkedProvider) }
      : current);
  };

  const checkDraftProvider = async (providerId: string) => {
    if (draft && window.archicode?.saveGlobalProviders) {
      await window.archicode.saveGlobalProviders(draft.providers, { preserveMissingSecrets: true, includeSecrets: false });
      await refreshSavedApiKeyStatus();
    }
    await checkProvider(providerId);
    await refreshCheckedProviderDraft(providerId);
  };

  const renderProviderModelField = (provider: ProjectSettings["providers"][number], placeholder: string) => {
    const options = modelOptionsForProvider(provider);
    const currentModel = provider.model ?? "";
    const discoveredOptions = provider.detectedAvailableModels.length
      ? options
      : [currentModel, ...options];
    const selectOptions = Array.from(new Set(discoveredOptions.filter(Boolean))).map((model) => ({
      value: model,
      label: modelOptionLabel(provider, model)
    }));
    return (
      <Field label="Model" hint={modelHint(provider)}>
        <ModelCombobox
          value={currentModel}
          placeholder={placeholder}
          options={selectOptions}
          catalogMode={provider.detectedAvailableModels.length > 0}
          onValueChange={(value) => updateProvider(provider.id, { model: value || undefined })}
        />
        <small>{selectedModelImageHint(provider)}</small>
      </Field>
    );
  };

  const renderOutputVerbosityField = (provider: ProjectSettings["providers"][number]) => {
    if (provider.kind !== "openai-compatible" && provider.kind !== "codex-local") return null;
    const isCodexLocal = provider.kind === "codex-local";
    return (
      <Field
        label="Output verbosity"
        hint={isCodexLocal
          ? "Overrides Codex model_verbosity for each ArchiCode invocation without changing Codex files."
          : "Sent as text.verbosity for GPT-5.6 Responses API requests. Other models and Chat Completions are unchanged."}
      >
        <Select
          value={provider.outputVerbosity ?? "default"}
          onValueChange={(value) => updateProvider(provider.id, {
            outputVerbosity: value === "default"
              ? undefined
              : value as NonNullable<ProjectSettings["providers"][number]["outputVerbosity"]>
          })}
          options={outputVerbosityOptions}
        />
      </Field>
    );
  };

  useEffect(() => {
    if (!settingsOpen || !draft || !rootPath || !pendingModelCheckIds.size) return;
    const candidates = draft.providers.filter((provider) =>
      pendingModelCheckIds.has(provider.id) &&
      (provider.kind === "openai-compatible" || provider.kind === "anthropic-compatible") &&
      providerApiKeyValue(provider).trim().length >= 20
    );
    if (!candidates.length) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (window.archicode?.saveGlobalProviders) {
          await window.archicode.saveGlobalProviders(draft.providers, { preserveMissingSecrets: true, includeSecrets: false });
          await refreshSavedApiKeyStatus();
        }
        for (const provider of candidates) {
          await checkProvider(provider.id);
          await refreshCheckedProviderDraft(provider.id);
        }
        setPendingModelCheckIds((current) => {
          const next = new Set(current);
          for (const provider of candidates) next.delete(provider.id);
          return next;
        });
      })();
    }, 450);
    return () => window.clearTimeout(timer);
  }, [checkProvider, draft, pendingModelCheckIds, rootPath, settingsOpen]);

  const checkForUpdates = async () => {
    if (!window.archicode?.checkForUpdates) {
      setUpdateNotice("Update checks are available in the packaged Electron app.");
      return;
    }
    const result = await window.archicode.checkForUpdates();
    setUpdateNotice(result.message);
  };

  const openProjectDocumentExport = (format: "pdf" | "html") => {
    setSelectedExportFlowIds(bundle?.flows.map((flow) => flow.id) ?? []);
    setExportDocumentFormat(format);
  };

  const confirmProjectDocumentExport = async () => {
    if (!exportDocumentFormat || !selectedExportFlowIds.length) return;
    setExportDocumentBusy(true);
    const exported = await exportProjectDocument(selectedExportFlowIds, exportDocumentFormat);
    setExportDocumentBusy(false);
    if (exported) setExportDocumentFormat(null);
  };

  const updateProviderPhasePolicy = (
    providerId: string,
    phase: LlmPhase,
    patch: Partial<ProjectSettings["providers"][number]["phaseModelPolicies"][LlmPhase]>
  ) => {
    const provider = draft?.providers.find((item) => item.id === providerId);
    if (!provider) return;
    updateProvider(providerId, {
      phaseModelPolicies: {
        ...(provider.phaseModelPolicies ?? defaultPhaseModelPolicies),
        [phase]: {
          ...(provider.phaseModelPolicies?.[phase] ?? defaultPhaseModelPolicies[phase]),
          ...patch
        }
      }
    });
  };

  const updateProviderSubagentPolicy = (
    providerId: string,
    profile: SubagentModelProfile,
    patch: Partial<PhaseModelPolicy>
  ) => {
    const provider = draft?.providers.find((item) => item.id === providerId);
    if (!provider) return;
    updateProvider(providerId, {
      subagentModelPolicies: {
        ...(provider.subagentModelPolicies ?? defaultSubagentModelPolicies),
        [profile]: {
          ...(provider.subagentModelPolicies?.[profile] ?? defaultSubagentModelPolicies[profile]),
          ...patch
        }
      }
    });
  };

  const profileModelOptions = (
    provider: ProjectSettings["providers"][number],
    policy: PhaseModelPolicy
  ) => {
    const providerModel = provider.model?.trim();
    const values = [policy.modelOverride?.trim(), providerModel, ...modelOptionsForProvider(provider)].filter(Boolean) as string[];
    return [
      {
        value: PROVIDER_DEFAULT_MODEL_VALUE,
        label: providerModel ? `Default · ${providerModel}` : "Default"
      },
      ...Array.from(new Set(values)).map((model) => ({
        value: model,
        label: modelOptionLabel(provider, model)
      }))
    ];
  };

  const profileOutputLimitHint = (
    provider: ProjectSettings["providers"][number],
    policy: PhaseModelPolicy
  ): string => {
    const phaseCeiling = policy.maxOutputTokens;
    if (provider.kind === "codex-local" || provider.kind === "claude-local" || provider.kind === "opencode-local" || provider.kind === "antigravity-local") {
      return phaseCeiling
        ? `Advisory ceiling: ${formatTokenCount(phaseCeiling)}. The local CLI controls its effective output limit.`
        : "The local CLI controls its effective output limit.";
    }
    if (provider.kind === "offline-manual") return "No model output is generated by this provider.";
    const modelMaximum = providerModelOutputTokenLimit(provider, policy.modelOverride);
    if (!modelMaximum) {
      return phaseCeiling
        ? `Effective ceiling: up to ${formatTokenCount(phaseCeiling)}. Model maximum unknown.`
        : "Provider default. Model maximum unknown.";
    }
    const effective = phaseCeiling ? Math.min(phaseCeiling, modelMaximum) : modelMaximum;
    return `Effective ceiling: ${formatTokenCount(effective)} · Model maximum: ${formatTokenCount(modelMaximum)} (provider metadata).`;
  };

  const renderModelPolicyCard = (
    key: string,
    title: string,
    description: string,
    policy: PhaseModelPolicy,
    onChange: (patch: Partial<PhaseModelPolicy>) => void
  ) => enabledProvider ? (
    <article key={key} className="provider-card" data-llm-profile={key}>
      <div className="provider-card-head">
        <span className="llm-profile-card-title">
          <span className="llm-profile-card-heading">
            <strong>{title}</strong>
            <Tooltip content={description}>
              <span className="llm-profile-card-help" role="img" tabIndex={0} aria-label={`About ${title}`}>
                <HelpCircle size={14} />
              </span>
            </Tooltip>
          </span>
        </span>
        <Badge tone={policy.reasoningMode === "high" ? "accent" : "neutral"}>{policy.reasoningMode} reasoning</Badge>
      </div>
      <div className="settings-two-col">
        <Field label="Temperature">
          <TextInput
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={policy.temperature ?? ""}
            onChange={(event) => onChange({
              temperature: event.target.value === "" ? undefined : Number(event.target.value)
            })}
          />
        </Field>
        <Field label="Reasoning">
          <Select
            value={policy.reasoningMode}
            onValueChange={(value) => onChange({ reasoningMode: value as PhaseModelPolicy["reasoningMode"] })}
            options={[
              { value: "off", label: "off" },
              { value: "low", label: "low" },
              { value: "medium", label: "medium" },
              { value: "high", label: "high" }
            ]}
          />
        </Field>
        <Field label="Max output" hint={profileOutputLimitHint(enabledProvider, policy)}>
          <TextInput
            type="number"
            min={256}
            value={policy.maxOutputTokens ?? ""}
            onChange={(event) => onChange({
              maxOutputTokens: event.target.value === "" ? undefined : Number(event.target.value)
            })}
          />
        </Field>
        <Field
          label="Model override"
          hint={`Stored for ${enabledProvider.label}. Provider default inherits its current model${enabledProvider.model?.trim() ? ` (${enabledProvider.model.trim()})` : ""}.`}
        >
          <ModelCombobox
            value={policy.modelOverride?.trim() || PROVIDER_DEFAULT_MODEL_VALUE}
            placeholder="Provider default"
            options={profileModelOptions(enabledProvider, policy)}
            catalogMode
            onValueChange={(value) => onChange({
              modelOverride: value === PROVIDER_DEFAULT_MODEL_VALUE ? undefined : value
            })}
          />
        </Field>
      </div>
    </article>
  ) : null;

  const toggleSkill = (skillId: string, enabled: boolean) => {
    if (!draft) return;
    const current = new Set(draft.skills.enabledSkillIds);
    if (enabled) current.add(skillId);
    else current.delete(skillId);
    updateDraft({ skills: { ...draft.skills, enabledSkillIds: [...current] } });
  };

  const updateMcpDraftServer = (serverId: string, patch: Partial<ProjectSettings["mcp"]["servers"][number]>) => {
    if (!draft) return;
    updateDraft({
      mcp: {
        ...draft.mcp,
        servers: draft.mcp.servers.map((server) => server.id === serverId ? { ...server, ...patch } : server)
      }
    });
  };

  const addMcpDraftServer = () => {
    if (!draft || !mcpDraft.id.trim() || !mcpDraft.label.trim()) return;
    const args = mcpDraft.args.split("\n").map((item) => item.trim()).filter(Boolean);
    const server: ProjectSettings["mcp"]["servers"][number] = {
      id: mcpDraft.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, ""),
      label: mcpDraft.label.trim(),
      transport: mcpDraft.transport as ProjectSettings["mcp"]["servers"][number]["transport"],
      command: mcpDraft.transport === "stdio" ? mcpDraft.command.trim() : undefined,
      args,
      env: [],
      headers: [],
      url: mcpDraft.transport === "streamable-http" ? mcpDraft.url.trim() : undefined,
      enabled: false,
      trusted: false,
      source: "project",
      tools: [],
      resources: [],
      prompts: []
    };
    updateDraft({
      mcp: {
        ...draft.mcp,
        servers: [...draft.mcp.servers.filter((item) => item.id !== server.id), server]
      }
    });
    setMcpDraft({ id: "", label: "", transport: "stdio", command: "", args: "", url: "" });
  };

  const refreshDraftMcpServer = async (serverId: string) => {
    const result = await refreshMcpServerCapabilities(serverId);
    if (!result || !draft) return;
    updateMcpDraftServer(serverId, result.server);
  };

  const mcpKeyValuesToText = (items: { name: string; value?: string }[]) =>
    items.map((item) => `${item.name}=${item.value ?? ""}`).join("\n");

  const mcpTextToKeyValues = (text: string) =>
    text.split("\n").map((line) => {
      const index = line.indexOf("=");
      const name = (index >= 0 ? line.slice(0, index) : line).trim();
      const value = index >= 0 ? line.slice(index + 1) : "";
      return name ? { name, value } : null;
    }).filter((item): item is { name: string; value: string } => Boolean(item));

  const runMcpRegistryRequest = async (
    input: Parameters<typeof searchMcpRegistry>[0],
    options?: Parameters<typeof searchMcpRegistry>[1]
  ) => {
    setMcpRegistryHasStarted(true);
    setMcpRegistryLoading(true);
    setMcpRegistryNotice(null);
    const result = await searchMcpRegistry(input, options);
    if (!result) setMcpRegistryNotice("MCP registry request failed. Try browsing again or choose another filter.");
    setMcpRegistryLoading(false);
    return result;
  };

  const searchRegistryServers = async () => {
    setMcpRegistryMode("search");
    setMcpRegistryActiveQuery(mcpRegistryQuery);
    await runMcpRegistryRequest({ query: mcpRegistryQuery, category: mcpRegistryCategory, sort: mcpRegistrySort, limit: 24 });
  };

  const browseRegistryServers = async () => {
    setMcpRegistryMode("browse");
    setMcpRegistryQuery("");
    setMcpRegistryActiveQuery("");
    await runMcpRegistryRequest({ query: "", category: mcpRegistryCategory, sort: mcpRegistrySort, limit: 24 });
  };

  const loadMoreRegistryServers = async () => {
    if (!mcpRegistryNextCursor) return;
    await runMcpRegistryRequest({
      query: mcpRegistryMode === "search" ? mcpRegistryActiveQuery : "",
      category: mcpRegistryCategory,
      sort: mcpRegistrySort,
      cursor: mcpRegistryNextCursor,
      limit: 24
    }, { append: true });
  };

  const refreshRegistryForControls = async (category: string, sort: string) => {
    if (!mcpRegistryHasStarted) return;
    await runMcpRegistryRequest({
      query: mcpRegistryMode === "search" ? mcpRegistryActiveQuery : "",
      category,
      sort,
      limit: 24
    });
  };

  const updateMcpRegistryCategory = (category: string) => {
    setMcpRegistryCategory(category);
    void refreshRegistryForControls(category, mcpRegistrySort);
  };

  const updateMcpRegistrySort = (sort: string) => {
    setMcpRegistrySort(sort);
    void refreshRegistryForControls(mcpRegistryCategory, sort);
  };

  const installRegistryServer = async (entry: (typeof mcpRegistryEntries)[number]) => {
    const hasRequiredSecrets = Boolean(entry.install?.secrets.some((secret) => secret.required));
    setMcpRegistryInstallingId(entry.id);
    const result = await installMcpRegistryServer({
      entry,
      enabled: !hasRequiredSecrets,
      trusted: !hasRequiredSecrets,
      refresh: !hasRequiredSecrets
    });
    setMcpRegistryInstallingId(null);
    if (!result) return;
    setMcpRegistryNotice(result.message);
    const installedServer = result.refresh?.server ?? result.server;
    setDraft((current) => current ? {
      ...current,
      mcp: {
        ...current.mcp,
        servers: current.mcp.servers.some((server) => server.id === installedServer.id)
          ? current.mcp.servers.map((server) => server.id === installedServer.id ? installedServer : server)
          : [...current.mcp.servers, installedServer]
      }
    } : current);
  };

  const scrollToolbarHorizontally = (event: WheelEvent<HTMLDivElement>) => {
    const target = toolbarActionsRef.current;
    if (!target || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const maxScrollLeft = target.scrollWidth - target.clientWidth;
    if (maxScrollLeft <= 0) return;
    const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, target.scrollLeft + event.deltaY));
    if (nextScrollLeft === target.scrollLeft) return;
    event.preventDefault();
    target.scrollLeft = nextScrollLeft;
  };

  const renderContextWindowField = (provider: ProjectSettings["providers"][number]) => (
    <Field
      label="Context window"
      hint={provider.detectedContextWindowTokens
        ? `Auto detected: ${formatTokenCount(provider.detectedContextWindowTokens)} tokens. Enter a value only to override.`
        : "Auto uses detected model metadata or conservative known-model defaults. Suggestions are editable because provider catalogs change."}
    >
      <TextInput
        type="number"
        min={1000}
        value={provider.contextWindowTokens ?? ""}
        placeholder={provider.detectedContextWindowTokens ? `${provider.detectedContextWindowTokens}` : "Auto"}
        onChange={(event) => updateProvider(provider.id, {
          contextWindowTokens: event.target.value ? Number(event.target.value) : undefined
        })}
      />
    </Field>
  );

  const activeSpeechModel = speechStatus?.models.find((model) => model.id === speechDraft.modelId) ?? null;
  const speechTestDisabled = !speechDraft.enabled || !activeSpeechModel?.downloaded || speechTestBusy || Boolean(speechDownloadingModelId) || Boolean(speechDeletingModelId);
  const activeTtsModel = ttsStatus?.models.find((model) => model.id === ttsDraft.modelId) ?? null;
  const activeTtsVoice = ttsStatus?.voices.find((voice) => voice.id === ttsDraft.voiceId) ?? null;
  const ttsVoiceOptions = (ttsStatus?.voices.length ? ttsStatus.voices : [{ id: "af_heart", label: "Heart" }]).map((voice) => ({
    value: voice.id,
    label: voice.label
  }));
  const ttsTestDisabled = !ttsDraft.enabled || !activeTtsModel?.downloaded || ttsTestBusy || Boolean(ttsDownloadingModelId) || Boolean(ttsDeletingModelId);
  const localEnvironment = draft?.localEnvironment ?? {
    operatingSystem: "unknown",
    agentShell: "",
    projectRoot: rootPath ?? bundle?.project.rootPath ?? ""
  };
  const updateLocalEnvironment = (patch: Partial<NonNullable<ProjectSettings["localEnvironment"]>>) => {
    updateDraft({
      localEnvironment: {
        ...localEnvironment,
        ...patch
      }
    });
  };

  return (
    <>
      <header className={rightSidebarCollapsed ? "project-toolbar has-right-sidebar-restore" : "project-toolbar"} aria-label="Project toolbar">
        <Toolbar ref={toolbarActionsRef} className="toolbar-actions" onWheel={scrollToolbarHorizontally}>
          <div className="toolbar-status-group">
            <GraphHistoryBar inline />
            <IconButton
              className={`toolbar-provider-status ${providerStatusClass}`}
              title={providerStatusTitle}
              onClick={() => {
                setSettingsTab("providers");
                setSettingsOpen(true);
              }}
              disabled={!bundle}
            >
              <Settings size={16} />
            </IconButton>
            <HelpPage
              trigger={(
                <IconButton title="Open ArchiCode help">
                  <HelpCircle size={16} />
                </IconButton>
              )}
            />
          </div>

          <div className="toolbar-primary-actions" aria-label="Implementation actions">
            <PatchReviewPanel />
            <MenuRoot>
              <Tooltip content={implementTooltip}>
                <span className="toolbar-tooltip-target">
                  <MenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      aria-label="AI Implement scope"
                      disabled={!bundle || runChangeBlocked}
                    >
                      <Sparkles size={16} />
                      <span>AI Implement</span>
                      <ChevronDown size={14} />
                    </Button>
                  </MenuTrigger>
                </span>
              </Tooltip>
              <MenuContent align="start" className="ai-implement-menu-content">
                <MenuLabel>1-AI EFFORT</MenuLabel>
                <MenuItem
                  tooltip="Planning chooses Fast or High based on the requested scope, risk, and expected implementation horizon."
                  onSelect={(event) => {
                    event.preventDefault();
                    setImplementationEffort("auto");
                  }}
                >
                  {implementationEffort === "auto" ? <Check size={15} /> : <span className="menu-item-spacer" />} <em>Auto</em>
                </MenuItem>
                <MenuItem
                  tooltip="Fewer implementation batches and lighter verification for small, low-risk, or localized work."
                  onSelect={(event) => {
                    event.preventDefault();
                    setImplementationEffort("fast");
                  }}
                >
                  {implementationEffort === "fast" ? <Check size={15} /> : <span className="menu-item-spacer" />} <em>Fast</em>
                </MenuItem>
                <MenuItem
                  tooltip="More orchestration for broad, risky, multi-system, or long-horizon implementation work."
                  onSelect={(event) => {
                    event.preventDefault();
                    setImplementationEffort("high");
                  }}
                >
                  {implementationEffort === "high" ? <Check size={15} /> : <span className="menu-item-spacer" />} <em>High</em>
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>2-IMPLEMENT SCOPE</MenuLabel>
                <MenuItem
                  tooltip="Focus the run on the whole project. The agent can update source and graph state wherever the project-level task requires it."
                  onSelect={() => setPendingImplementScope({ kind: "project", flowId: activeFlow?.id, nodeIds: [], label: "Project" })}
                >
                  <LayoutGrid size={15} /> Project
                </MenuItem>
                <MenuItem
                  tooltip="Focus the run on the current flow. The agent may inspect other flows for references, but should keep edits centered on this flow."
                  onSelect={() => setPendingImplementScope({ kind: "flow", flowId: activeFlow?.id, nodeIds: [], label: activeFlow?.name ?? "Flow" })}
                >
                  <ChevronRight size={15} /> Flow
                </MenuItem>
                <MenuItem
                  disabled={!selectedImplementNodeIds.length}
                  tooltip={selectedImplementNodeIds.length
                    ? "Focus the run on the selected node or nodes. The agent may inspect other graph context, but should keep edits centered on this selection."
                    : "Select one or more nodes to run AI Implement with node scope."}
                  onSelect={() => selectedImplementNodeIds.length
                    ? setPendingImplementScope({ kind: "nodes", flowId: activeFlow?.id, nodeIds: selectedImplementNodeIds, label: selectedImplementNodeLabel })
                    : undefined}
                >
                  <Square size={15} /> Nodes
                </MenuItem>
              </MenuContent>
            </MenuRoot>
            <MenuRoot>
              <Tooltip content={aiRunTooltip}>
                <span className="toolbar-tooltip-target">
                  <MenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      aria-label="AI Run"
                      disabled={!bundle || runChangeBlocked}
                    >
                      <Play size={16} />
                      <span>AI Run</span>
                      <ChevronDown size={14} />
                    </Button>
                  </MenuTrigger>
                </span>
              </Tooltip>
              <MenuContent>
                <MenuLabel>BUILD APP</MenuLabel>
                <MenuItem tooltip={buildTooltip} onSelect={() => void startBuildRun()}>
                  <Hammer size={15} /> Build
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>Run App</MenuLabel>
                {runProfiles.length ? (
                  runProfiles.map((profile) => (
                    <MenuItem key={profile.id} tooltip={profile.runCommand} onSelect={() => void runProfile({ profileId: profile.id })}>
                      <Play size={15} /> {profile.label} · {runtimeCwdLabel(profile.cwd)}
                    </MenuItem>
                  ))
                ) : (
                  <MenuItem tooltip={runTooltip} onSelect={() => void startRunAppDiscovery()}>
                    <Play size={15} /> Detect Run App target
                  </MenuItem>
                )}
              </MenuContent>
            </MenuRoot>
            <MenuRoot>
              <Tooltip content={debugTooltip}>
                <span className="toolbar-tooltip-target">
                  <MenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      aria-label="AI Debug"
                      disabled={!bundle || runChangeBlocked}
                    >
                      <Bug size={16} />
                      <span>AI Debug</span>
                      <ChevronDown size={14} />
                    </Button>
                  </MenuTrigger>
                </span>
              </Tooltip>
              <MenuContent>
                <MenuLabel>Review</MenuLabel>
                <MenuItem
                  tooltip="Ask the chat agent to find contradictions, missing information, and illogical nodes, edges, or flow boundaries."
                  onSelect={() => setLogicReviewOpen(true)}
                >
                  <SearchCheck size={15} /> Review flow logic…
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>Debug</MenuLabel>
                <MenuItem
                  tooltip={openBugReports.length
                    ? "Review, edit, select, or resolve reported bugs before asking Pandora to fix them."
                    : "No open bug reports found."}
                  disabled={!openBugReports.length}
                  onSelect={openBugReview}
                >
                  <Bug size={15} /> Review reported bugs{openBugReports.length ? ` (${openBugReports.length})` : ""}
                </MenuItem>
                <MenuItem
                  tooltip="Create a project bug report for Pandora to pick up."
                  onSelect={() => setReportBugOpen(true)}
                >
                  <MessageSquare size={15} /> Report Bug
                </MenuItem>
              </MenuContent>
            </MenuRoot>
          </div>

          <div className="toolbar-utility-actions">
            {visibleRuntimeServices.length ? (
              <IconButton
                className={`toolbar-runtime-toggle ${runtimePanelOpen ? "is-active" : ""}`}
                title={runtimePanelOpen ? `Hide runtime services (${runningRuntimeCount} running)` : `Show runtime services (${runningRuntimeCount} running)`}
                aria-pressed={runtimePanelOpen}
                onClick={() => setRuntimePanelOpen((open) => !open)}
              >
                <Activity size={16} />
                <span className="toolbar-runtime-count">{runningRuntimeCount}</span>
              </IconButton>
            ) : null}
            <IconButton
              className={workbenchView === "files" ? "toolbar-view-toggle is-active" : "toolbar-view-toggle"}
              title={workbenchView === "files" ? "Show graph canvas" : "Browse project files"}
              aria-pressed={workbenchView === "files"}
              onClick={() => setWorkbenchView(workbenchView === "files" ? "graph" : "files")}
              disabled={!bundle}
            >
              <FileCode2 size={16} />
            </IconButton>
            <GitPanel />
            <IconButton
              data-testid="research-button"
              className="toolbar-research-toggle"
              aria-pressed={researchPanelActive ?? false}
              title={researchPanelActive ? "Show properties" : "Open scoped research chat"}
              onClick={() => {
                onToggleResearchPanel?.();
              }}
              disabled={!bundle}
            >
              <MessageSquare size={16} />
            </IconButton>
            <MenuRoot>
              <MenuTrigger asChild>
                <IconButton title="More project actions">
                  <MoreHorizontal size={16} />
                </IconButton>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Graph</MenuLabel>
                <MenuItem
                  tooltip="Rearrange the visible nodes in this flow or subflow. This only changes canvas positions."
                  onSelect={() => setCleanLayoutConfirmOpen(true)}
                >
                  <LayoutGrid size={15} /> Clean layout
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>Codebase</MenuLabel>
                <MenuItem
                  tooltip="Incrementally verify repository changes and apply the smallest safe patch to the existing map."
                  onSelect={() => setResyncCodebaseOpen(true)}
                >
                  <RefreshCw size={15} /> Resync codebase
                </MenuItem>
                <MenuItem
                  tooltip="Reopen the report from this project's one-time initial codebase import."
                  onSelect={() => void openInitialCodebaseImportReport()}
                >
                  <History size={15} /> Initial import report
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>Project</MenuLabel>
                <MenuItem
                  tooltip="Reload ArchiCode's project JSON from disk, useful after external edits or stale state."
                  onSelect={() => void reload()}
                >
                  <RefreshCw size={15} /> Reload JSON
                </MenuItem>
                <MenuSub>
                  <MenuSubTrigger>
                    <UploadCloud size={15} /> Import
                  </MenuSubTrigger>
                  <MenuSubContent>
                    <MenuItem
                      tooltip="Choose a draw.io / diagrams.net XML file and append one selected page to the current flow or subflow."
                      onSelect={() => void importDrawioFlow("append")}
                    >
                      <UploadCloud size={15} /> Import draw.io append
                    </MenuItem>
                    <MenuItem
                      tooltip="Choose a draw.io / diagrams.net XML file and replace only the currently visible flow or subflow scope."
                      onSelect={() => void importDrawioFlow("replace")}
                    >
                      <UploadCloud size={15} /> Import draw.io replace
                    </MenuItem>
                  </MenuSubContent>
                </MenuSub>
                <MenuSub>
                  <MenuSubTrigger>
                    <Download size={15} /> Export
                  </MenuSubTrigger>
                  <MenuSubContent>
                    <MenuItem
                      tooltip="Save the current flow or subflow scope as a draw.io / diagrams.net XML file."
                      onSelect={() => void exportActiveDrawioFlow()}
                    >
                      <Download size={15} /> Export draw.io XML
                    </MenuItem>
                    <MenuItem
                      tooltip="Save the full loaded ArchiCode metadata bundle as one JSON file."
                      onSelect={() => void exportProjectBundle()}
                    >
                      <Download size={15} /> Export project JSON
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      tooltip="Choose one or more flows and export them as a printable PDF document."
                      onSelect={() => openProjectDocumentExport("pdf")}
                    >
                      <FileText size={15} /> Export PDF
                    </MenuItem>
                    <MenuItem
                      tooltip="Choose one or more flows and export them as a standalone HTML document."
                      onSelect={() => openProjectDocumentExport("html")}
                    >
                      <FileCode2 size={15} /> Export HTML
                    </MenuItem>
                  </MenuSubContent>
                </MenuSub>
                {/*
                <MenuItem
                  tooltip="Back up and rewrite ArchiCode project JSON using the current schema defaults."
                  onSelect={() => void repairProject()}
                >
                  <Wrench size={15} /> Repair project JSON
                </MenuItem>
                */}
                <MenuSeparator />
                <MenuLabel>App</MenuLabel>
                <MenuItem
                  disabled={!bundle}
                  tooltip="Open the current project folder in Visual Studio Code when VS Code is installed."
                  onSelect={() => void openProjectInVsCode()}
                >
                  <FileCode2 size={15} /> Open in VS Code
                </MenuItem>
                <MenuItem
                  tooltip={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
                  onSelect={toggleTheme}
                >
                  {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
                  {theme === "light" ? "Dark theme" : "Light theme"}
                </MenuItem>
                <MenuItem
                  disabled={!onResetLayout}
                  tooltip="Restore the default panel sizes, docking, selected workbench view, activity tab, and canvas viewport."
                  onSelect={() => onResetLayout?.()}
                >
                  <LayoutGrid size={15} /> Reset layout
                </MenuItem>
                <MenuItem
                  tooltip="Prepared for future GitHub release checks. Currently reports whether update metadata is configured."
                  onSelect={() => void checkForUpdates()}
                >
                  <UploadCloud size={15} /> Check for updates
                </MenuItem>
              </MenuContent>
            </MenuRoot>
          </div>
        </Toolbar>
        {rightSidebarCollapsed ? (
          <IconButton
            className="toolbar-right-sidebar-restore"
            title="Show right sidebar"
            onClick={onRestoreRightSidebar}
            disabled={!bundle || !onRestoreRightSidebar}
          >
            <ChevronLeft size={16} />
          </IconButton>
        ) : null}
      </header>

      {updateNotice ? (
        <div className="toolbar-notice" role="status">
          <span>{updateNotice}</span>
          <button type="button" onClick={() => setUpdateNotice(null)}>Dismiss</button>
        </div>
      ) : null}

      {bundle && visibleRuntimeServices.length && runtimePanelOpen ? (
        <section className="runtime-panel" aria-label="Runtime services">
          <div className="runtime-panel-header">
            <b>Runtime</b>
            <small>{runningRuntimeCount} running</small>
          </div>
          <div className="runtime-service-grid">
            {visibleRuntimeServices.map((service) => {
              const running = service.status === "running" || service.status === "starting";
              const latestLog = service.logs.at(-1);
              const urls = runtimeUrls(service);
              const insight = runtimeInsight(service);
              return (
                <article key={service.id} className={`runtime-service runtime-service-${service.status}`}>
                  <div className="runtime-service-main">
                    <b>{service.label}</b>
                    <span>{service.status}</span>
                    <span>{service.kind} · {runtimeCwdLabel(service.relativeCwd)}</span>
                  </div>
                  <div className="runtime-service-meta" title={service.command}>
                    <span>{service.command}</span>
                    {service.pid ? <span>pid {service.pid}</span> : null}
                    <RuntimeUrlLinks urls={urls} />
                    {service.ports.length ? <span>ports {service.ports.join(", ")}</span> : null}
                  </div>
                  <div className={`runtime-insight runtime-insight-${insight.tone}`}>
                    <b>{insight.label}</b>
                    {renderRuntimeInsightDetail(service, insight.label, insight.detail)}
                  </div>
                  {latestLog ? (
                    <button
                      type="button"
                      className="runtime-service-log"
                      title="Open full runtime logs"
                      onClick={() => setSelectedRuntimeLogId(service.id)}
                    >
                      [{latestLog.stream}] {renderRuntimeTextWithLinks(latestLog.text.trim())}
                    </button>
                  ) : null}
                  <div className="runtime-service-actions">
                    <Button type="button" size="sm" onClick={() => setSelectedRuntimeLogId(service.id)}>
                      <Activity size={14} />
                      <span>Logs</span>
                    </Button>
                    <Button type="button" size="sm" onClick={() => void restartRuntimeService(service.id)}>
                      <RefreshCw size={14} />
                      <span>Restart</span>
                    </Button>
                    <Button type="button" size="sm" onClick={() => void stopRuntimeService(service.id)} disabled={!running}>
                      <X size={14} />
                      <span>Stop</span>
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <DialogRoot open={cleanLayoutConfirmOpen} onOpenChange={setCleanLayoutConfirmOpen}>
        <DialogContent
          title="Clean this layout?"
          description="Rearrange all nodes in the current flow into a grid."
        >
          <div className="confirm-summary">
            <div className="confirm-summary-grid">
              <span><b>Effect</b>Every node in this flow will be repositioned into a clean grid.</span>
              <span><b>Warning</b>Existing node positions will be overwritten. You can undo this layout change with Cmd/Ctrl+Z.</span>
            </div>
          </div>
          <div className="dialog-actions">
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setCleanLayoutConfirmOpen(false);
                void autoLayout();
              }}
            >
              <LayoutGrid size={15} />
              <span>Clean layout</span>
            </Button>
            <Button type="button" onClick={() => setCleanLayoutConfirmOpen(false)}>Cancel</Button>
          </div>
        </DialogContent>
      </DialogRoot>

      <DialogRoot open={logicReviewOpen} onOpenChange={setLogicReviewOpen}>
        <DialogContent
          title="Review flow logic"
          description="Choose how much of the graph the chat agent should check for contradictions, missing information, and connections that do not make sense."
        >
          <div className="confirm-summary">
            <div className="confirm-summary-grid">
              <span><b>Current flow</b>Review “{activeFlow?.name ?? "Current flow"}” and its linked detail flows in a new flow-scoped chat.</span>
              <span><b>All project flows</b>Review every flow together, including duplicated responsibilities, conflicting assumptions, and unclear cross-flow handoffs.</span>
            </div>
            <p className="confirm-note">This starts a read-only chat review. It will not edit the graph, change source files, or queue a run.</p>
          </div>
          <div className="scoped-action-block">
            <span className="scoped-action-label">Choose a review scope</span>
            <div className="action-grid">
              <Button
                type="button"
                variant="primary"
                disabled={!activeFlow}
                onClick={() => activeFlow && startLogicReview({ kind: "flow", name: activeFlow.name })}
              >
                <ChevronRight size={15} />
                <span>Current flow</span>
              </Button>
              <Button
                type="button"
                onClick={() => bundle && startLogicReview({ kind: "project", name: bundle.project.name })}
              >
                <LayoutGrid size={15} />
                <span>All project flows</span>
              </Button>
            </div>
          </div>
          <div className="dialog-actions">
            <Button type="button" onClick={() => setLogicReviewOpen(false)}>Cancel</Button>
          </div>
        </DialogContent>
      </DialogRoot>

      <DialogRoot open={Boolean(exportDocumentFormat)} onOpenChange={(open) => {
        if (!open && !exportDocumentBusy) setExportDocumentFormat(null);
      }}>
        {exportDocumentFormat ? (
          <DialogContent
            className="project-export-dialog"
            title={`Export ${exportDocumentFormat.toUpperCase()}`}
            description="Choose the flows to include. All flows are selected by default for a project-scope export."
          >
            <div className="project-export-toolbar">
              <div>
                <Badge tone={selectedExportFlowIds.length === (bundle?.flows.length ?? 0) ? "accent" : "neutral"}>
                  {selectedExportFlowIds.length === (bundle?.flows.length ?? 0) ? "Project scope" : "Custom scope"}
                </Badge>
                <span>{selectedExportFlowIds.length} of {bundle?.flows.length ?? 0} flows selected</span>
              </div>
              <div className="action-row compact">
                <Button
                  type="button"
                  size="sm"
                  disabled={exportDocumentBusy || !bundle?.flows.length}
                  onClick={() => setSelectedExportFlowIds(bundle?.flows.map((flow) => flow.id) ?? [])}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={exportDocumentBusy || !selectedExportFlowIds.length}
                  onClick={() => setSelectedExportFlowIds([])}
                >
                  Deselect all
                </Button>
              </div>
            </div>
            <div className="project-export-flow-list">
              {bundle?.flows.map((flow) => {
                const selected = selectedExportFlowIds.includes(flow.id);
                return (
                  <label className={`project-export-flow${selected ? " is-selected" : ""}`} key={flow.id}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={exportDocumentBusy}
                      onChange={(event) => setSelectedExportFlowIds((current) => event.target.checked
                        ? [...new Set([...current, flow.id])]
                        : current.filter((flowId) => flowId !== flow.id))}
                    />
                    <span>
                      <strong>{flow.name}</strong>
                      <small>{flow.nodes.length} nodes · {flow.edges.length} connections{flow.ignored ? " · Ignored" : ""}</small>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="dialog-actions">
              <Button
                type="button"
                variant="primary"
                disabled={exportDocumentBusy || !selectedExportFlowIds.length}
                onClick={() => void confirmProjectDocumentExport()}
              >
                {exportDocumentBusy ? <Loader2 className="spin" size={15} /> : <Download size={15} />}
                Export {exportDocumentFormat.toUpperCase()} ({selectedExportFlowIds.length})
              </Button>
              <Button type="button" disabled={exportDocumentBusy} onClick={() => setExportDocumentFormat(null)}>Cancel</Button>
            </div>
          </DialogContent>
        ) : null}
      </DialogRoot>

      <DialogRoot open={Boolean(pendingImplementScope)} onOpenChange={(open) => {
        if (!open) setPendingImplementScope(null);
      }}>
        {pendingImplementScope ? (
          <DialogContent
            title="Start AI Implement with Gaia?"
            description={`${gaiaAgent.title} will take the selected implementation scope and effort.`}
          >
            <div className="confirm-summary">
              <div className="confirm-badges">
                <Badge tone="accent">Scope: {pendingImplementScope.kind === "project" ? "Project" : pendingImplementScope.kind === "flow" ? "Flow" : "Nodes"}</Badge>
                <Badge tone="neutral">Effort: {implementationEffortLabel}</Badge>
              </div>
              <div className="confirm-summary-grid">
                <span><b>Target</b>{implementScopePhrase(pendingImplementScope)}</span>
                <span><b>What happens</b>A new run is added to the queue, planning starts first, and follow-up approvals or questions appear in Runs if needed.</span>
              </div>
              <p className="confirm-note">
                {pendingImplementScope.kind === "project"
                  ? "Use this when the work may touch multiple flows, modules, or graph areas."
                  : pendingImplementScope.kind === "flow"
                    ? "Use this when the work should stay centered on the current flow, with only related supporting changes outside it."
                    : "Use this when the work should stay centered on the selected node set, while still allowing the agent to inspect nearby context."}
              </p>
            </div>
            <div className="dialog-actions">
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  startAiImplement(pendingImplementScope);
                  setPendingImplementScope(null);
                }}
              >
                <Sparkles size={15} />
                <span>Start Run</span>
              </Button>
              <Button type="button" onClick={() => setPendingImplementScope(null)}>Cancel</Button>
            </div>
          </DialogContent>
        ) : null}
      </DialogRoot>

      <DialogRoot open={Boolean(selectedRuntimeLogService)} onOpenChange={(open) => {
        if (!open) setSelectedRuntimeLogId(null);
        if (!open) setRuntimeDebugGuidance("");
      }}>
        {selectedRuntimeLogService ? (
          <DialogContent
            title={`${selectedRuntimeLogService.label} Runtime Logs`}
            description={`${selectedRuntimeLogService.status} · ${selectedRuntimeLogService.command}`}
            className="runtime-log-dialog"
          >
            <div className="runtime-log-summary">
              <span>{runtimeCwdLabel(selectedRuntimeLogService.relativeCwd)}</span>
              {selectedRuntimeLogService.pid ? <span>pid {selectedRuntimeLogService.pid}</span> : null}
              <RuntimeUrlLinks urls={runtimeUrls(selectedRuntimeLogService)} />
            </div>
            {(() => {
              const insight = runtimeInsight(selectedRuntimeLogService);
              return (
                <div className={`runtime-insight runtime-insight-${insight.tone}`}>
                  <b>{insight.label}</b>
                  {renderRuntimeInsightDetail(selectedRuntimeLogService, insight.label, insight.detail)}
                </div>
              );
            })()}
            <div className="runtime-log-view" role="log" aria-label={`${selectedRuntimeLogService.label} runtime output`}>
              {selectedRuntimeLogService.logs.length ? selectedRuntimeLogService.logs.map((line, index) => (
                <div key={`${line.at}-${index}`} className={`runtime-log-line runtime-log-${line.stream}`}>
                  <span className="runtime-log-stream">[{line.stream}]</span>
                  <span className="runtime-log-text">{renderRuntimeTextWithLinks(line.text.trimEnd())}</span>
                </div>
              )) : (
                <p>No runtime output captured yet.</p>
              )}
            </div>
            <TextArea
              rows={3}
              value={runtimeDebugGuidance}
              placeholder="Optional guidance for Pandora"
              onChange={(event) => setRuntimeDebugGuidance(event.target.value)}
            />
            <div className="dialog-actions">
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  void startRuntimeDebugRun(selectedRuntimeLogService.id, {
                    text: runtimeDebugGuidance,
                    evidence: ["runtime-log", "trace-tail"]
                  });
                  setSelectedRuntimeLogId(null);
                }}
              >
                <Bug size={15} />
                <span>Debug This Output</span>
              </Button>
              <Button type="button" onClick={() => setSelectedRuntimeLogId(null)}>Close</Button>
            </div>
          </DialogContent>
        ) : null}
      </DialogRoot>

      <DialogRoot open={bugReviewOpen} onOpenChange={setBugReviewOpen}>
        <DialogContent
          title="Review Bug Reports"
          description="Edit the reports, choose exactly which bugs to fix, or resolve reports that no longer need work."
          className="bug-review-dialog"
        >
          <div className="bug-review-toolbar">
            <span>{selectedBugIds.length} of {openBugReports.length} selected</span>
            <div className="action-row compact">
              <Button type="button" size="sm" onClick={() => setSelectedBugIds(openBugReports.map((incident) => incident.id))}>Select all</Button>
              <Button type="button" size="sm" onClick={() => setSelectedBugIds([])}>Clear</Button>
            </div>
          </div>
          <div className="bug-review-list">
            {openBugReports.map((incident) => {
              const edit = bugEdits[incident.id] ?? incident;
              const selected = selectedBugIds.includes(incident.id);
              return (
                <section className={`bug-review-card${selected ? " is-selected" : ""}`} key={incident.id}>
                  <label className="bug-review-select">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => setSelectedBugIds((current) => event.target.checked
                        ? [...new Set([...current, incident.id])]
                        : current.filter((id) => id !== incident.id))}
                    />
                    <span>Include in next fix run</span>
                    <Badge tone={incident.priority === "urgent" || incident.priority === "high" ? "danger" : "neutral"}>{incident.priority}</Badge>
                  </label>
                  <div className="form-grid bug-review-fields">
                    <Field label="Title">
                      <TextInput
                        value={edit.title}
                        onChange={(event) => setBugEdits((current) => ({ ...current, [incident.id]: { ...edit, title: event.target.value } }))}
                      />
                    </Field>
                    <Field label="Description">
                      <TextArea
                        rows={4}
                        value={edit.description}
                        onChange={(event) => setBugEdits((current) => ({ ...current, [incident.id]: { ...edit, description: event.target.value } }))}
                      />
                    </Field>
                    <Field label="Priority">
                      <Select
                        value={edit.priority}
                        onValueChange={(priority) => setBugEdits((current) => ({
                          ...current,
                          [incident.id]: { ...edit, priority: priority as DebugIncident["priority"] }
                        }))}
                        options={[
                          { value: "low", label: "Low" },
                          { value: "normal", label: "Normal" },
                          { value: "high", label: "High" },
                          { value: "urgent", label: "Urgent" }
                        ]}
                      />
                    </Field>
                  </div>
                  <div className="action-row compact">
                    <Tooltip content="Save this report's edited title, description, and priority without starting Pandora.">
                      <Button type="button" size="sm" variant="primary" onClick={() => void saveBugEdit(incident.id)}>
                        <Save size={14} /> Update
                      </Button>
                    </Tooltip>
                    <Tooltip content="Remove this report from the open bug list. This does not run Pandora or delete project files.">
                      <Button type="button" size="sm" variant="danger" onClick={() => setRemoveBugIncidentId(incident.id)}>
                        <Trash2 size={14} /> Remove
                      </Button>
                    </Tooltip>
                  </div>
                </section>
              );
            })}
          </div>
          <div className="dialog-actions">
            <Button
              type="button"
              variant="primary"
              disabled={!selectedBugIds.length || runChangeBlocked}
              onClick={() => void fixSelectedBugReports()}
            >
              <Bug size={16} /> Fix selected ({selectedBugIds.length})
            </Button>
            <Button type="button" onClick={() => setBugReviewOpen(false)}>Close</Button>
          </div>
        </DialogContent>
      </DialogRoot>

      <DialogRoot open={Boolean(removeBugIncidentId)} onOpenChange={(open) => {
        if (!open) setRemoveBugIncidentId(null);
      }}>
        <DialogContent
          title="Remove this bug report?"
          description="It will be removed from the open bug list and excluded from future fix runs."
        >
          <div className="confirm-summary">
            <div className="confirm-summary-grid">
              <span><b>Report</b>{openBugReports.find((incident) => incident.id === removeBugIncidentId)?.title ?? "Selected bug report"}</span>
              <span><b>Effect</b>Pandora will not start, and no project source files will be changed.</span>
            </div>
          </div>
          <div className="dialog-actions">
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                const incidentId = removeBugIncidentId;
                if (!incidentId) return;
                setSelectedBugIds((current) => current.filter((id) => id !== incidentId));
                setRemoveBugIncidentId(null);
                void updateBugIncident(incidentId, { status: "resolved" });
              }}
            >
              <Trash2 size={15} /> Remove report
            </Button>
            <Button type="button" onClick={() => setRemoveBugIncidentId(null)}>Cancel</Button>
          </div>
        </DialogContent>
      </DialogRoot>

      <DialogRoot open={reportBugOpen} onOpenChange={setReportBugOpen}>
        <DialogContent
          title="Report Bug"
          description="Create an open bug incident for Pandora — Debug & Recovery."
        >
          <div className="form-grid">
            <Field label="Title">
              <TextInput
                value={bugDraft.title}
                placeholder="Todo count fails after refresh"
                onChange={(event) => setBugDraft((current) => ({ ...current, title: event.target.value }))}
              />
            </Field>
            <Field label="Priority">
              <Select
                value={bugDraft.priority}
                onValueChange={(priority) => setBugDraft((current) => ({ ...current, priority }))}
                options={[
                  { value: "low", label: "Low" },
                  { value: "normal", label: "Normal" },
                  { value: "high", label: "High" },
                  { value: "urgent", label: "Urgent" }
                ]}
              />
            </Field>
            <Field label="Description" hint="Include what you expected, what happened, and how to reproduce it.">
              <TextArea
                value={bugDraft.description}
                rows={5}
                placeholder="After adding a todo, refreshing the page shows an internal server error."
                onChange={(event) => setBugDraft((current) => ({ ...current, description: event.target.value }))}
              />
            </Field>
            {providerSupportsImages(enabledProvider) ? (
              <Field label="Images" hint="Attach screenshots for image-capable providers.">
                <div className="attachment-picker-row">
                  <Button
                    type="button"
                    onClick={async () => {
                      const filePaths = await window.archicode?.pickImageFiles?.();
                      if (filePaths?.length) {
                        setBugDraft((current) => ({
                          ...current,
                          filePaths: [...new Set([...current.filePaths, ...filePaths])]
                        }));
                      }
                    }}
                  >
                    <ImagePlus size={16} />
                    <span>Add Images</span>
                  </Button>
                  {bugDraft.filePaths.length ? <span>{bugDraft.filePaths.length} selected</span> : null}
                </div>
              </Field>
            ) : null}
          </div>
          <div className="action-row">
            <Button
              type="button"
              variant="primary"
              disabled={!bugDraft.title.trim() || !bugDraft.description.trim()}
              onClick={() => void submitBugReport()}
            >
              <Bug size={16} />
              <span>Report Bug</span>
            </Button>
            <Button type="button" onClick={() => setReportBugOpen(false)}>
              <span>Cancel</span>
            </Button>
          </div>
        </DialogContent>
      </DialogRoot>

      <DialogRoot open={settingsOpen} onOpenChange={setSettingsOpen}>
        {draft || settingsTab === "shortcuts" ? (
          <DialogContent
            title={draft ? "Project Settings" : "App Settings"}
            description={draft
              ? "Provider, command, context, web search, and permission settings. Context is assembled automatically from the loaded project model."
              : "App-global preferences that apply across every project."}
            className="settings-modal"
            draggable
            resizable
          >
            <TabsRoot value={settingsTab} onValueChange={setSettingsTab} className="settings-tabs">
              <TabsList className="ui-tabs-list">
                {draft ? <TabsTrigger value="general">General</TabsTrigger> : null}
                <TabsTrigger value="shortcuts">Shortcuts</TabsTrigger>
                {draft ? (
                  <>
                    <TabsTrigger value="providers">LLM Providers</TabsTrigger>
                    <TabsTrigger value="commands">Build Targets</TabsTrigger>
                    <TabsTrigger value="agent-memory">Agent Instructions</TabsTrigger>
                    <TabsTrigger value="security">Security</TabsTrigger>
                    <TabsTrigger value="context">Context</TabsTrigger>
                    <TabsTrigger value="policy">LLM Profiles</TabsTrigger>
                    <TabsTrigger value="capabilities">MCP Skills</TabsTrigger>
                    <TabsTrigger value="advanced">Advanced</TabsTrigger>
                  </>
                ) : null}
              </TabsList>

              {draft ? (
                <>
              <TabsContent value="general" className="settings-tab-content narrow">
                <Field label="Project name" hint="Shown in the sidebar, exported bundles, context, and run handoffs.">
                  <TextInput
                    value={detailsDraft.name}
                    onChange={(event) => setDetailsDraft({ name: event.target.value })}
                  />
                </Field>
                <Switch
                  checked={draft.autoFocusSelectedNode}
                  onCheckedChange={(checked) => updateDraft({ autoFocusSelectedNode: checked })}
                  label="Center canvas on selected node"
                />
                <small>When enabled, selecting a node from the canvas or sidebar pans and zooms the canvas to that node.</small>
                <Switch
                  checked={draft.notifications.jobFinished}
                  onCheckedChange={(checked) => updateDraft({
                    notifications: {
                      ...draft.notifications,
                      jobFinished: checked
                    }
                  })}
                  label="Show system notifications when jobs finish"
                />
                <Switch
                  checked={draft.notifications.reviewRequired}
                  onCheckedChange={(checked) => updateDraft({
                    notifications: {
                      ...draft.notifications,
                      reviewRequired: checked
                    }
                  })}
                  label="Show system notifications when reviews need attention"
                />
                <Field label="UI scale" hint="App-local display zoom for text and controls. Stored on this machine, not in project files.">
                  <Select
                    value={String(uiScale)}
                    onValueChange={(value) => setUiScale(Number(value) as typeof uiScale)}
                    options={[
                      { value: "75", label: "75%" },
                      { value: "100", label: "100%" },
                      { value: "125", label: "125%" }
                    ]}
                  />
                </Field>
                <Field label="Archi personality" hint="Choose how Archi Research chat speaks in new and resumed chats. Stored on this machine across all projects.">
                  <Select
                    value={globalResearchPersonality}
                    onValueChange={(value) => setGlobalResearchPersonality(value as GlobalResearchPersonality)}
                    options={researchPersonalities.map((personality) => ({
                      value: personality.id,
                      label: personality.label
                    }))}
                    contentClassName="ui-select-content-personality"
                    showScrollIndicator
                  />
                </Field>
                <Field label="Verbosity" hint="Choose whether Research chat uses the normal concise prompt or the extra warm, chatty, verbose response-style directive. Stored on this machine across all projects.">
                  <Select
                    value={globalResearchVerbosity}
                    onValueChange={(value) => setGlobalResearchVerbosity(value as GlobalResearchVerbosity)}
                    options={[
                      { value: "default", label: "Default" },
                      { value: "chatty", label: "Chatty" }
                    ]}
                  />
                </Field>
                <Field label="Canvas background" hint="Choose the graph surface color. Neutral gray is the default because it stays readable in light and dark themes.">
                  <div className="canvas-background-grid">
                    {canvasBackgroundOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={draft.canvasBackground === option.value ? "is-active" : ""}
                        aria-label={`Use ${option.label} canvas background`}
                        title={option.description}
                        onClick={() => updateDraft({ canvasBackground: option.value })}
                      >
                        <span className="canvas-background-swatch" style={{ backgroundColor: option.swatch }} />
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Canvas edges" hint="Keep the current routed edges or switch to curved edges across the graph.">
                  <Select
                    value={draft.canvasEdgeStyle}
                    onValueChange={(value) => updateDraft({
                      canvasEdgeStyle: value as ProjectSettings["canvasEdgeStyle"]
                    })}
                    options={[
                      { value: "current", label: "Current routed edges" },
                      { value: "curved", label: "Curved edges" }
                    ]}
                  />
                </Field>
              </TabsContent>

              <TabsContent value="providers" className="settings-tab-content provider-settings-tab">
                <div className="provider-settings-intro">
                  <p className="settings-note">Provider cards are saved on this computer and reused across projects. The enabled card supplies the default model for chat and build agents unless a chat selection or LLM Profile overrides it.</p>
                  {showMacKeychainNote ? (
                    <details className="settings-keychain-disclosure">
                      <summary><ShieldCheck size={13} /> macOS Keychain</summary>
                      <span>API keys are stored in Keychain. Saving or using a saved key may ask you to allow ArchiCode to access it.</span>
                    </details>
                  ) : null}
                </div>
                <div className="provider-profile-toolbar">
                  <Button type="button" size="sm" onClick={() => addProviderProfile()}>
                    <Plus size={14} />
                    <span>New Provider</span>
                  </Button>
                </div>
                <div className="provider-editor-list">
                  {draft.providers.map((provider) => (
                    <article
                      key={provider.id}
                      data-provider-card={provider.id}
                      className={provider.enabled ? "provider-card enabled" : "provider-card"}
                    >
                      <div className="provider-card-head">
                        <div className="provider-card-title">
                          <label className="radio-row">
                            <input
                              type="radio"
                              checked={provider.enabled}
                              onChange={() => updateDraft({
                                providers: draft.providers.map((item) => ({ ...item, enabled: item.id === provider.id }))
                              })}
                            />
                            <span>{provider.label}</span>
                          </label>
                          <small>{provider.id}</small>
                        </div>
                        <div className="provider-card-actions">
                          <Tooltip content={providerCheckHint(provider.kind)}>
                            <span>
                              <Button type="button" size="sm" onClick={() => void checkDraftProvider(provider.id)}>
                                <Activity size={14} />
                                <span>Check</span>
                              </Button>
                            </span>
                          </Tooltip>
                          <IconButton type="button" title="Duplicate provider profile" onClick={() => duplicateProvider(provider.id)}>
                            <Copy size={16} />
                          </IconButton>
                          <IconButton
                            type="button"
                            title="Delete provider profile"
                            onClick={() => removeProvider(provider.id)}
                          >
                            <Trash2 size={16} />
                          </IconButton>
                        </div>
                      </div>
                      <Field label="Profile name">
                        <TextInput
                          data-provider-name-input={provider.id}
                          value={provider.label}
                          onChange={(event) => updateProvider(provider.id, { label: event.target.value })}
                        />
                      </Field>
                      <Field label="LLM Provider Source">
                        <Select
                          value={provider.kind}
                          onValueChange={(value) => changeProviderKind(provider.id, value as ProviderKind)}
                          options={providerKindOptions}
                        />
                      </Field>
                      <small>{providerDescription(provider.kind)}</small>
                      {providerHealth[provider.id] ? (
                        <small className={providerHealth[provider.id].ok ? "health-ok" : "health-bad"}>
                          {providerHealth[provider.id].status}: {providerHealth[provider.id].message}
                        </small>
                      ) : null}
                      {provider.kind === "offline-manual" ? (
                        <small>This is a non-AI offline mode for using ArchiCode as a living diagram, run ledger, artifact browser, and permissioned command shell. It cannot plan or code with an LLM until another provider is selected.</small>
                      ) : provider.kind === "codex-local" || provider.kind === "claude-local" || provider.kind === "opencode-local" || provider.kind === "antigravity-local" ? (
                        <>
                          {renderProviderModelField(provider, provider.kind === "codex-local" ? "configured Codex default" : provider.kind === "claude-local" ? "configured Claude default" : provider.kind === "opencode-local" ? "provider/model" : "configured agy default")}
                          {provider.kind === "codex-local" ? renderOutputVerbosityField(provider) : null}
                          {renderContextWindowField(provider)}
                          <Field label="Local command">
                            <TextInput
                              value={provider.localCommand ?? (provider.kind === "codex-local" ? "codex" : provider.kind === "claude-local" ? "claude" : provider.kind === "opencode-local" ? "opencode" : "agy")}
                              placeholder={provider.kind === "codex-local" ? "codex" : provider.kind === "claude-local" ? "claude" : provider.kind === "opencode-local" ? "opencode" : "agy"}
                              onChange={(event) => updateProvider(provider.id, { localCommand: event.target.value || undefined })}
                            />
                          </Field>
                          <Field label={provider.kind === "opencode-local" || provider.kind === "antigravity-local" ? "Agent" : provider.kind === "codex-local" ? "Profile" : "Settings override"}>
                            <TextInput
                              value={provider.localProfile ?? ""}
                              placeholder={provider.kind === "codex-local" ? "optional Codex profile" : provider.kind === "claude-local" ? "optional Claude settings profile" : provider.kind === "opencode-local" ? "optional OpenCode agent" : "optional Antigravity agent"}
                              onChange={(event) => updateProvider(provider.id, { localProfile: event.target.value || undefined })}
                            />
                          </Field>
                          <Field label={`${provider.kind === "codex-local" ? "Codex" : provider.kind === "claude-local" ? "Claude" : provider.kind === "opencode-local" ? "OpenCode" : "Antigravity"} command access`}>
                            <Select
                              value={provider.localSandbox ?? "read-only"}
                              onValueChange={(value) => updateProvider(provider.id, {
                                localSandbox: value as ProjectSettings["providers"][number]["localSandbox"]
                              })}
                              options={codexLocalSandboxOptions}
                            />
                          </Field>
                          <small>{provider.kind === "codex-local"
                            ? codexLocalCommandAccessHint
                            : provider.kind === "claude-local"
                              ? "Claude Code uses permission modes instead of a true filesystem sandbox. ArchiCode maps these access levels to read-only planning, auto-accepted workspace edits, or full bypass mode."
                              : provider.kind === "opencode-local"
                                ? "OpenCode runs once per request. Write-capable build phases add --auto; use OpenCode permissions/config for finer-grained tool restrictions."
                                : "Antigravity uses plan+sandbox for read-only phases, accept-edits+sandbox for workspace writes, and bypasses permissions only in full-access mode."}</small>
                          {provider.kind === "antigravity-local" ? (
                            <small>Antigravity always runs through one-shot <code>agy --print</code> calls; ArchiCode owns conversation continuity.</small>
                          ) : (
                            <>
                              <Switch
                                checked={Boolean(provider.ephemeral)}
                                onCheckedChange={(checked) => updateProvider(provider.id, { ephemeral: checked })}
                                label={provider.kind === "codex-local" ? "Use throwaway Codex sessions" : provider.kind === "claude-local" ? "Disable Claude session persistence" : "Delete OpenCode sessions after each call"}
                              />
                              <small>{provider.kind === "codex-local"
                                ? <>Adds <code>--ephemeral</code> for local Codex runs. ArchiCode still saves runs and artifacts, but Codex should not reuse or save its own CLI session state.</>
                                : provider.kind === "claude-local"
                                  ? <>Adds <code>--no-session-persistence</code> for local Claude runs. ArchiCode still saves runs and artifacts, but Claude should not reuse or save its own CLI session state.</>
                                  : <>Runs <code>opencode session delete</code> after the one-shot response. ArchiCode still saves its own runs and artifacts.</>}</small>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          {renderProviderModelField(provider, provider.kind === "anthropic-compatible" ? "claude-sonnet-4-6" : "gpt-5.5")}
                          {provider.kind === "openai-compatible" ? renderOutputVerbosityField(provider) : null}
                          {renderContextWindowField(provider)}
                          <Field label="Base URL">
                            <TextInput
                              value={provider.baseUrl ?? ""}
                              placeholder={provider.kind === "anthropic-compatible" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
                              onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value || undefined })}
                            />
                          </Field>
                          {provider.kind === "openai-compatible" ? (
                            <Field label="Endpoint" hint={openAiEndpointHint(provider)}>
                              <Select
                                value={provider.openAiEndpointMode ?? "auto"}
                                onValueChange={(value) => updateProvider(provider.id, {
                                  openAiEndpointMode: value as ProjectSettings["providers"][number]["openAiEndpointMode"],
                                  detectedOpenAiEndpointMode: undefined
                                })}
                                options={[
                                  {
                                    value: "auto",
                                    label: provider.detectedOpenAiEndpointMode
                                      ? `Auto (${openAiEndpointLabel(provider.detectedOpenAiEndpointMode)})`
                                      : "Auto (recommended)"
                                  },
                                  { value: "responses", label: "Responses API" },
                                  { value: "chat-completions", label: "Chat Completions" }
                                ]}
                              />
                            </Field>
                          ) : null}
                          <Field label="API key" hint="Saved locally on this computer and hidden from project JSON.">
                            <div className="secret-input-row">
                              <TextInput
                                type={visibleApiKeyIds.has(provider.id) ? "text" : "password"}
                                value={providerApiKeyValue(provider)}
                                placeholder={savedApiKeyIds.has(provider.id)
                                  ? "Saved API key (hidden)"
                                  : provider.kind === "anthropic-compatible" ? "Paste Anthropic API key" : "Paste OpenAI API key"}
                                autoComplete="off"
                                spellCheck={false}
                                onPaste={() => setPendingModelCheckIds((current) => new Set(current).add(provider.id))}
                                onChange={(event) => updateProvider(provider.id, {
                                  apiKey: event.target.value || undefined,
                                  apiKeyEnv: undefined
                                })}
                              />
                              <IconButton
                                type="button"
                                title={visibleApiKeyIds.has(provider.id) ? "Hide API key" : "Show API key"}
                                onClick={() => setVisibleApiKeyIds((current) => {
                                  const next = new Set(current);
                                  if (next.has(provider.id)) next.delete(provider.id);
                                  else next.add(provider.id);
                                  return next;
                                })}
                              >
                                {visibleApiKeyIds.has(provider.id) ? <EyeOff size={18} /> : <Eye size={18} />}
                              </IconButton>
                            </div>
                            {savedApiKeyIds.has(provider.id) && !providerApiKeyValue(provider) ? (
                              <small>Saved key will be used. Paste a new key here to replace it.</small>
                            ) : null}
                          </Field>
                        </>
                      )}
                    </article>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="commands" className="settings-tab-content build-targets-tab">
                <Switch
                  checked={draft.buildTargetsLocked}
                  onCheckedChange={(buildTargetsLocked) => updateDraft({ buildTargetsLocked })}
                  label="Lock build targets"
                  tooltip="Prevents AI Build, Run, Debug, command inference, and runtime-profile reconciliation from changing the configured build command or run targets. You can still edit them manually here."
                />
                <Field label="Project build command" hint="Used by the toolbar Build button and by AI runs when they verify generated changes.">
                  <TextInput value={draft.defaultBuildCommand} onChange={(event) => updateDraft({ defaultBuildCommand: event.target.value })} />
                </Field>
                <Field label="Run targets" hint="Editable JSON run target profiles. Targets can discover, launch, wait for, diagnose, recover, and run app commands for single-target and multi-target projects.">
                  <TextArea
                    value={runProfilesDraft}
                    rows={Math.max(8, draft.runTargetProfiles.length * 8)}
                    onChange={(event) => {
                      const value = event.target.value;
                      setRunProfilesDraft(value);
                      try {
                        const parsed = JSON.parse(value) as unknown;
                        if (!Array.isArray(parsed)) throw new Error("Run targets must be a JSON array.");
                        const runTargetProfiles = parsed.map((profile) => runTargetProfileSchema.parse(profile));
                        updateDraft({ runTargetProfiles });
                        setRunProfilesError(null);
                      } catch (error) {
                        setRunProfilesError(error instanceof Error ? error.message : String(error));
                      }
                    }}
                  />
                  {runProfilesError ? <small className="settings-validation-error">{runProfilesError}</small> : null}
                </Field>
              </TabsContent>

              <TabsContent value="agent-memory" className="settings-tab-content narrow">
                <p className="settings-note settings-agent-instructions-note">
                  ArchiCode loads every existing instruction file into both Chat and Build context, regardless of the selected LLM provider. Put shared guidance in <code>AGENTS.md</code>, and avoid repeating or contradicting rules across files.
                </p>
                <Field
                  label="Agent instructions"
                  hint={`${agentInstructions.exists ? "Editing" : "Will create"} ${agentInstructions.path}. The selector chooses which real project file to edit; it does not control which files agents receive.`}
                >
                  <Select
                    value={agentInstructions.path}
                    onValueChange={(filePath) => {
                      if (!rootPath || filePath === agentInstructions.path) return;
                      if (agentInstructionsDirty) {
                        setAgentInstructionsError("Save or cancel unsaved changes before switching instruction files.");
                        return;
                      }
                      void (async () => {
                        try {
                          const instructions = await window.archicode.readAgentInstructionFile(rootPath, filePath);
                          setAgentInstructions({ ...instructions, loadedForRoot: rootPath });
                          setAgentInstructionsDirty(false);
                          setAgentInstructionsError(null);
                        } catch (error) {
                          setAgentInstructionsError(error instanceof Error ? error.message : String(error));
                        }
                      })();
                    }}
                    options={agentInstructionFiles.map((file) => ({
                      value: file.path,
                      label: `${file.path} ${file.exists ? "(exists)" : "(will create)"}${file.preferred ? " (default)" : ""}`
                    }))}
                  />
                  <TextArea
                    value={agentInstructions.text}
                    rows={18}
                    placeholder={[
                      "# Project Agent Instructions",
                      "",
                      "- Keep changes aligned with this target project's graph and requirements.",
                      "- Add this project's technology and repository conventions here."
                    ].join("\n")}
                    onChange={(event) => {
                      setAgentInstructions((current) => ({ ...current, text: event.target.value }));
                      setAgentInstructionsDirty(true);
                      setAgentInstructionsError(null);
                    }}
                  />
                  <small>{agentInstructionsDirty ? "Unsaved changes" : agentInstructions.exists ? `${agentInstructions.path} loaded` : `${agentInstructions.path} does not exist yet`}</small>
                  {agentInstructionsError ? <small className="settings-validation-error">{agentInstructionsError}</small> : null}
                </Field>
              </TabsContent>

              <TabsContent value="security" className="settings-tab-content narrow">
                <section className="settings-security-group">
                  <div className="settings-security-group-head">
                    <strong>Permission gates</strong>
                    <small>Choose where runs pause for human approval.</small>
                  </div>
                  <Switch
                    checked={draft.webSearch.enabled}
                    onCheckedChange={(checked) => updateDraft({
                      webSearch: {
                        ...draft.webSearch,
                        enabled: checked,
                        persistSearchArtifacts: true
                      }
                    })}
                    label="Allow LLM providers to search online when needed"
                    tooltip="Allows enabled LLM providers and ArchiCode web tools to use online search when a run needs current external information. Search summaries and citations are always saved as artifacts."
                  />
                  <Field label="Web search backend" hint="Choose whether web search comes from the active model/provider or from ArchiCode's internal Brave Search tool.">
                    <Select
                      value={draft.webSearch.provider}
                      onValueChange={(value) => updateDraft({
                        webSearch: {
                          ...draft.webSearch,
                          provider: value as ProjectSettings["webSearch"]["provider"]
                        }
                      })}
                      options={[
                        { value: "native", label: "Native provider search" },
                        { value: "brave", label: "Brave via ArchiCode" }
                      ]}
                    />
                  </Field>
                  <small>{draft.webSearch.provider === "native"
                    ? "Use provider-native web search when the selected model/endpoint supports it. Models without native search stay web-disabled except for direct URL fetches and any separately configured MCP tools."
                    : "Use ArchiCode's built-in Brave Search tool so any provider can search through the same backend."}</small>
                  {draft.webSearch.provider === "brave" ? (
                    <>
                      {showMacKeychainNote ? (
                        <p className="settings-note settings-keychain-note">On macOS, Brave API keys are stored in Keychain. Saving or using a saved key may ask you to allow ArchiCode to access it.</p>
                      ) : null}
                      <Field label="Brave Search API key" hint="Saved locally on this computer and hidden from project JSON.">
                        <div className="secret-input-row">
                          <TextInput
                            type={visibleBraveApiKey ? "text" : "password"}
                            value={webSearchSecretsDraft.braveApiKey}
                            placeholder={savedWebSearchSecrets.brave
                              ? "Saved Brave API key (hidden)"
                              : "Paste Brave Search API key"}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) => setWebSearchSecretsDraft({ braveApiKey: event.target.value })}
                          />
                          <IconButton
                            type="button"
                            title={visibleBraveApiKey ? "Hide Brave API key" : "Show Brave API key"}
                            onClick={() => setVisibleBraveApiKey((current) => !current)}
                          >
                            {visibleBraveApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
                          </IconButton>
                        </div>
                        {savedWebSearchSecrets.brave && !webSearchSecretsDraft.braveApiKey ? (
                          <small>Saved key will be used. Paste a new key here to replace it.</small>
                        ) : null}
                      </Field>
                    </>
                  ) : null}
                  <Switch
                    checked={draft.autoApproveShellCommands}
                    onCheckedChange={(checked) => updateDraft({ autoApproveShellCommands: checked })}
                    label="Auto-approve commands allowed by filesystem policy"
                    tooltip="Applies to implementation/build/debug shell commands such as setup, verification, run-target, and finite console commands. Planning review, source-change review, and Research chat approvals use separate toggles. High-risk commands still pause for manual approval even when this is enabled."
                  />
                  <Switch
                    checked={draft.planningReviewMode === "manual"}
                    onCheckedChange={(checked) => updateDraft({ planningReviewMode: checked ? "manual" : "auto" })}
                    label="Review plans before coding"
                    tooltip="When enabled, Gaia's AI Implement run pauses after planning so you can approve or reject the plan before any coding phase starts."
                  />
                  <Switch
                    checked={draft.codeReviewMode === "manual"}
                    onCheckedChange={(checked) => updateDraft({ codeReviewMode: checked ? "manual" : "auto-apply" })}
                    label="Review source changes before verification"
                    tooltip="When enabled, generated source diffs wait for your review before ArchiCode continues to verification."
                  />
                  <Switch
                    checked={draft.filesystem.blockOutsideProjectPaths}
                    onCheckedChange={(checked) => updateDraft({
                      filesystem: {
                        ...draft.filesystem,
                        blockOutsideProjectPaths: checked
                      }
                    })}
                    label="Block command paths outside project and allowed roots"
                    tooltip="When enabled, commands that reference paths outside the project root or additional allowed roots are blocked before execution."
                  />
                  <Switch
                    checked={draft.stopOnUnansweredQuestions}
                    onCheckedChange={(checked) => updateDraft({ stopOnUnansweredQuestions: checked })}
                    label="Require answers before manual plan approval"
                    tooltip="When enabled, manual plan approval is blocked until open planning questions are answered or dismissed. Turn it off to approve a plan while skipping those questions."
                  />
                  <Switch
                    checked={draft.purgeResolvedNotesOnApproval}
                    onCheckedChange={(checked) => updateDraft({ purgeResolvedNotesOnApproval: checked })}
                    label="Purge resolved node notes when a node is approved"
                    tooltip="Automatically deletes resolved node notes after approving a node, keeping only open notes and active questions."
                  />
                  <Switch
                    checked={draft.researchAutoApproveGraphChanges.includeDestructive}
                    onCheckedChange={(checked) => updateDraft({
                      researchAutoApproveGraphChanges: {
                        ...draft.researchAutoApproveGraphChanges,
                        includeDestructive: checked
                      }
                    })}
                    label="Chat auto-approval also includes destructive actions"
                    tooltip="When Chat auto-approve is enabled, it also applies graph deletions without showing a review card."
                  />
                  <Field label="Graph change history retention" hint="Resolved graph-change records older than this are moved to a cold archive file and dropped from the hot ledger. Pending changes are always kept.">
                    <Select
                      value={draft.graphChangeRetention}
                      onValueChange={(value) => updateDraft({ graphChangeRetention: value as typeof draft.graphChangeRetention })}
                      options={[
                        { value: "1day", label: "1 day" },
                        { value: "1week", label: "1 week" },
                        { value: "2weeks", label: "2 weeks" },
                        { value: "1month", label: "1 month" },
                        { value: "3months", label: "3 months" },
                        { value: "never", label: "Never (keep all)" }
                      ]}
                    />
                  </Field>
                  <Field label="Trusted command allowlist" hint="Commands listed here are treated as approved when filesystem checks pass. Put one exact command per line.">
                    <TextArea
                      value={draft.allowedShellCommands.join("\n")}
                      rows={5}
                      onChange={(event) => updateDraft({
                        allowedShellCommands: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean)
                      })}
                    />
                  </Field>
                </section>

                <section className="settings-security-group">
                  <div className="settings-security-group-head">
                    <strong>Agent tool permissions</strong>
                    <small>Choose which built-in ArchiCode tools run agents may use.</small>
                  </div>
                  <Switch
                    checked={draft.agentTools.projectFiles}
                    onCheckedChange={(checked) => updateDraft({
                      agentTools: {
                        ...draft.agentTools,
                        projectFiles: checked
                      }
                    })}
                    label="Allow run agents to list, search, and read project files"
                    tooltip="Lets implementation runs use built-in tools to list, search, and read files inside the project before making decisions."
                  />
                  <Switch
                    checked={draft.agentTools.runArtifacts}
                    onCheckedChange={(checked) => updateDraft({
                      agentTools: {
                        ...draft.agentTools,
                        runArtifacts: checked
                      }
                    })}
                    label="Allow run agents to inspect runs and artifacts"
                    tooltip="Lets implementation runs inspect previous run records, plans, diffs, logs, and saved artifacts for context."
                  />
                  <Switch
                    checked={draft.agentTools.console}
                    onCheckedChange={(checked) => updateDraft({
                      agentTools: {
                        ...draft.agentTools,
                        console: checked
                      }
                    })}
                    label="Allow run agents to execute safe finite console commands"
                    tooltip="Lets implementation runs execute bounded commands through ArchiCode's console guard when command approval and filesystem policy allow it."
                  />
                  <Switch
                    checked={draft.agentTools.subagents?.mergeConflictResolution ?? true}
                    onCheckedChange={(checked) => updateDraft({
                      agentTools: {
                        ...draft.agentTools,
                        subagents: {
                          ...draft.agentTools.subagents,
                          mergeConflictResolution: checked,
                          graphReconciliation: draft.agentTools.subagents?.graphReconciliation ?? true,
                          sherlockResearch: draft.agentTools.subagents?.sherlockResearch ?? true,
                          delphiTesting: draft.agentTools.subagents?.delphiTesting ?? true
                        }
                      }
                    })}
                    label="Allow Solomon — Merge Arbiter"
                    tooltip="Lets Research chat ask approval to run Solomon for git merge conflicts. Solomon reads conflicted files, writes the approved resolution, and verifies it."
                  />
                  <Switch
                    checked={draft.agentTools.subagents?.graphReconciliation ?? true}
                    onCheckedChange={(checked) => updateDraft({
                      agentTools: {
                        ...draft.agentTools,
                        subagents: {
                          ...draft.agentTools.subagents,
                          mergeConflictResolution: draft.agentTools.subagents?.mergeConflictResolution ?? true,
                          graphReconciliation: checked,
                          sherlockResearch: draft.agentTools.subagents?.sherlockResearch ?? true,
                          delphiTesting: draft.agentTools.subagents?.delphiTesting ?? true
                        }
                      }
                    })}
                    label="Allow Picasso — Graph Architect"
                    tooltip="Lets chat and run agents delegate read-only graph assessment plus detailed graph design, refinement, and reconciliation. Picasso never applies changes directly; proposed changes require review and may follow a successful Solomon run."
                  />
                  <Switch
                    checked={draft.agentTools.subagents?.sherlockResearch ?? true}
                    onCheckedChange={(checked) => updateDraft({
                      agentTools: {
                        ...draft.agentTools,
                        subagents: {
                          ...draft.agentTools.subagents,
                          mergeConflictResolution: draft.agentTools.subagents?.mergeConflictResolution ?? true,
                          graphReconciliation: draft.agentTools.subagents?.graphReconciliation ?? true,
                          sherlockResearch: checked,
                          delphiTesting: draft.agentTools.subagents?.delphiTesting ?? true
                        }
                      }
                    })}
                    label="Allow Sherlock — Research Detective"
                    tooltip="Lets chat and run agents delegate substantial read-only codebase, online, or topic research to an isolated evidence-focused subagent."
                  />
                  <Switch
                    checked={draft.agentTools.subagents?.delphiTesting ?? true}
                    onCheckedChange={(checked) => updateDraft({
                      agentTools: {
                        ...draft.agentTools,
                        subagents: {
                          ...draft.agentTools.subagents,
                          mergeConflictResolution: draft.agentTools.subagents?.mergeConflictResolution ?? true,
                          graphReconciliation: draft.agentTools.subagents?.graphReconciliation ?? true,
                          sherlockResearch: draft.agentTools.subagents?.sherlockResearch ?? true,
                          delphiTesting: checked
                        }
                      }
                    })}
                    label="Allow Delphi — Test & Runtime Oracle"
                    tooltip="Lets chat and build/debug runs delegate bounded test, visual, runtime, and emulator audits. Delphi can approval-gated start an existing Run App profile, wait for it, and stop only what it started; missing tools use a separate setup card."
                  />
                </section>

                <section className="settings-security-group">
                  <div className="settings-security-group-head">
                    <strong>Filesystem gates</strong>
                    <small>Limit where ArchiCode-run commands can work.</small>
                  </div>
                <Field label="Filesystem policy" hint="Controls ArchiCode-run commands, not the Codex Local provider sandbox. Project-write allows the project root and additional allowed roots.">
                  <Select
                    value={draft.filesystem.policy}
                    onValueChange={(value) => updateDraft({
                      filesystem: {
                        ...draft.filesystem,
                        policy: value as ProjectSettings["filesystem"]["policy"]
                      }
                    })}
                    options={[
                      { value: "read-only", label: "read-only" },
                      { value: "project-write", label: "project-write" },
                      { value: "full-access", label: "full-access" }
                    ]}
                  />
                </Field>
                <Field label="Additional allowed roots" hint="Project root is always allowed. Full-access disables root checks and should be temporary.">
                  <TextArea
                    rows={5}
                    value={draft.filesystem.allowedRoots.join("\n")}
                    placeholder="Optional absolute paths, one per line"
                    onChange={(event) => updateDraft({
                      filesystem: {
                        ...draft.filesystem,
                        allowedRoots: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean)
                      }
                    })}
                  />
                </Field>
                <div className="policy-list">
                  {draft.shellPolicies.length === 0 ? <small>No reusable command approvals saved yet.</small> : null}
                  {draft.shellPolicies.map((policy) => (
                    <article key={policy.id}>
                      <strong>{policy.command}</strong>
                      <span>{policy.risk} risk{policy.cwd ? ` · ${policy.cwd}` : ""}</span>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => updateDraft({ shellPolicies: draft.shellPolicies.filter((item) => item.id !== policy.id) })}
                      >
                        <X size={14} />
                        <span>Remove</span>
                      </Button>
                    </article>
                  ))}
                </div>
                </section>
              </TabsContent>

              <TabsContent value="context" className="settings-tab-content narrow">
                {contextBudgetPlan ? (
                  <section className="context-budget-card">
                    <div>
                      <strong>Automatic model budget</strong>
                      <span>{contextBudgetPlan.providerLabel} · {contextBudgetPlan.modelLabel}</span>
                    </div>
                    <dl>
                      <div>
                        <dt>Window</dt>
                        <dd>{formatTokenCount(contextBudgetPlan.modelContextTokens)} · {contextBudgetSourceLabel(contextBudgetPlan.source)}</dd>
                      </div>
                      <div>
                        <dt>Usable context</dt>
                        <dd>{formatTokenCount(contextBudgetPlan.usableContextTokens)}</dd>
                      </div>
                      <div>
                        <dt>Compact at</dt>
                        <dd>{formatTokenCount(contextBudgetPlan.compactionThreshold)}</dd>
                      </div>
                      <div>
                        <dt>Response reserve</dt>
                        <dd>{formatTokenCount(contextBudgetPlan.responseReserveTokens)}</dd>
                      </div>
                      <div>
                        <dt>Summary reserve</dt>
                        <dd>{formatTokenCount(contextBudgetPlan.summaryReserveTokens)}</dd>
                      </div>
                      <div>
                        <dt>Artifacts / runs</dt>
                        <dd>{contextBudgetPlan.artifactLimit} / {contextBudgetPlan.recentRunLimit}</dd>
                      </div>
                    </dl>
                    <small>ArchiCode adjusts compaction and context selection from the active provider/model. Unknown custom models use conservative limits.</small>
                  </section>
                ) : null}
                <div className="switch-grid">
                  {(["includeNotes", "includeArtifacts", "includeRuns", "includeSummaries", "includeLockedNodes"] as const).map((key) => (
                    <Switch
                      key={key}
                      checked={draft.contextBuilder[key]}
                      onCheckedChange={(checked) => updateDraft({
                        contextBuilder: {
                          ...draft.contextBuilder,
                          [key]: checked
                        }
                      })}
                      label={contextLabel(key)}
                    />
                  ))}
                </div>
                <Switch
                  checked={draft.contextBudgetMode === "manual"}
                  onCheckedChange={(checked) => updateDraft({ contextBudgetMode: checked ? "manual" : "auto" })}
                  label="Use manual context limits"
                />
                {draft.contextBudgetMode === "manual" ? (
                  <div className="settings-two-col">
                    <Field label="Recent run limit">
                      <TextInput
                        type="number"
                        min={0}
                        max={50}
                        value={draft.contextBuilder.recentRunLimit}
                        onChange={(event) => updateDraft({
                          contextBuilder: { ...draft.contextBuilder, recentRunLimit: Number(event.target.value) }
                        })}
                      />
                    </Field>
                    <Field label="Artifact limit">
                      <TextInput
                        type="number"
                        min={0}
                        max={100}
                        value={draft.contextBuilder.artifactLimit}
                        onChange={(event) => updateDraft({
                          contextBuilder: { ...draft.contextBuilder, artifactLimit: Number(event.target.value) }
                        })}
                      />
                    </Field>
                    <Field label="Compaction threshold">
                      <TextInput
                        type="number"
                        min={1000}
                        value={draft.compactionThreshold}
                        onChange={(event) => updateDraft({ compactionThreshold: Number(event.target.value) })}
                      />
                    </Field>
                    <Field label="Token budget">
                      <TextInput
                        type="number"
                        min={1000}
                        value={draft.contextTokenBudget}
                        onChange={(event) => updateDraft({ contextTokenBudget: Number(event.target.value) })}
                      />
                    </Field>
                  </div>
                ) : null}
              </TabsContent>

              <TabsContent value="policy" className="settings-tab-content">
                {enabledProvider ? (
                  <>
                    <p className="settings-note llm-profile-provider-note">
                      Editing profiles for <strong>{enabledProvider.label}</strong>. Model choices are remembered separately for each provider card.
                    </p>
                    <div className="provider-editor-list llm-profile-list">
                      {phaseProfileGroups.map((group) => (
                        <section key={group.id} className="llm-profile-group" data-llm-profile-group={group.id}>
                          <div className="llm-profile-section-heading">
                            <strong>{group.title}</strong>
                            <small>{group.description}</small>
                          </div>
                          <div className="llm-profile-group-grid">
                            {group.profiles.map(({ phase, label }) => renderModelPolicyCard(
                              phase,
                              label,
                              phaseProfileDescriptions[phase],
                              enabledProvider.phaseModelPolicies?.[phase] ?? defaultPhaseModelPolicies[phase],
                              (patch) => updateProviderPhasePolicy(enabledProvider.id, phase, patch)
                            ))}
                          </div>
                        </section>
                      ))}
                      <section className="llm-profile-group" data-llm-profile-group="specialists">
                        <div className="llm-profile-section-heading">
                          <strong>Specialist agents</strong>
                          <small>Independent profiles; Default inherits the selected provider model, including a chat-specific model when spawned from that chat.</small>
                        </div>
                        <div className="llm-profile-group-grid">
                          {subagentProfiles.map((profile) => renderModelPolicyCard(
                            `subagent-${profile}`,
                            subagentProfileLabels[profile],
                            subagentProfileDescriptions[profile],
                            enabledProvider.subagentModelPolicies?.[profile] ?? defaultSubagentModelPolicies[profile],
                            (patch) => updateProviderSubagentPolicy(enabledProvider.id, profile, patch)
                          ))}
                        </div>
                      </section>
                    </div>
                  </>
                ) : (
                  <small>Select an LLM provider to edit phase policies.</small>
                )}
              </TabsContent>

              <TabsContent value="capabilities" className="settings-tab-content capabilities-tab">
                <section className="provider-card capability-panel capability-panel-skills">
                  <button
                    type="button"
                    className="provider-card-head capability-panel-toggle"
                    aria-expanded={!skillsCollapsed}
                    onClick={() => setSkillsCollapsed((collapsed) => !collapsed)}
                  >
                    <span>
                      {skillsCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                      <strong>Project Skills</strong>
                    </span>
                    <Badge tone="neutral">{projectSkills.length} found</Badge>
                  </button>
                  {!skillsCollapsed ? (
                    <div className="capability-panel-body">
                  <small>Project-local skills live in <code>.archicode/skills</code> and are injected into agent and research prompts when enabled.</small>
                  <div className="policy-list">
                    {projectSkills.length === 0 ? <small>No project skills created yet.</small> : null}
                    {projectSkills.map((skill) => {
                      const enabled = draft.skills.enabledSkillIds.includes(skill.id);
                      return (
                        <article key={skill.id}>
                          <strong>{skill.title}</strong>
                          <span>{skill.id}{skill.description ? ` · ${skill.description}` : ""}</span>
                          <Switch
                            checked={enabled}
                            onCheckedChange={(checked) => toggleSkill(skill.id, checked)}
                            label={enabled ? "Enabled" : "Disabled"}
                          />
                        </article>
                      );
                    })}
                  </div>
                  <div className="settings-two-col">
                    <Field label="Skill id">
                      <TextInput
                        value={skillDraft.id}
                        placeholder="react-ui-review"
                        onChange={(event) => setSkillDraft((current) => ({ ...current, id: event.target.value }))}
                      />
                    </Field>
                    <Field label="Title">
                      <TextInput
                        value={skillDraft.title}
                        placeholder="React UI Review"
                        onChange={(event) => setSkillDraft((current) => ({ ...current, title: event.target.value }))}
                      />
                    </Field>
                  </div>
                  <Field label="Description">
                    <TextInput
                      value={skillDraft.description}
                      placeholder="Guidance for React UI implementation work."
                      onChange={(event) => setSkillDraft((current) => ({ ...current, description: event.target.value }))}
                    />
                  </Field>
                  <Field label="When to use">
                    <TextArea
                      rows={3}
                      value={skillDraft.whenToUse}
                      onChange={(event) => setSkillDraft((current) => ({ ...current, whenToUse: event.target.value }))}
                    />
                  </Field>
                  <Field label="Instructions">
                    <TextArea
                      rows={5}
                      value={skillDraft.instructions}
                      onChange={(event) => setSkillDraft((current) => ({ ...current, instructions: event.target.value }))}
                    />
                  </Field>
                  <Button
                    type="button"
                    disabled={!skillDraft.id.trim() || !skillDraft.title.trim() || capabilityBusy}
                    onClick={async () => {
                      await createProjectSkill(skillDraft);
                      setSkillDraft({ id: "", title: "", description: "", whenToUse: "", instructions: "" });
                    }}
                  >
                    <Plus size={16} />
                    <span>Create Skill</span>
                  </Button>
                    </div>
                  ) : null}
                </section>

                <section className="provider-card capability-panel capability-panel-mcp">
                  <button
                    type="button"
                    className="provider-card-head capability-panel-toggle"
                    aria-expanded={!mcpCollapsed}
                    onClick={() => setMcpCollapsed((collapsed) => !collapsed)}
                  >
                    <span>
                      {mcpCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                      <strong>MCP Servers</strong>
                    </span>
                    <Badge tone="neutral">{draft.mcp.servers.filter((server) => server.enabled).length} enabled</Badge>
                  </button>
                  {!mcpCollapsed ? (
                    <div className="capability-panel-body">
                  <small>Enabled MCP servers stay discoverable to API and local providers during agent runs. Trusted means auto-approved execution; Ask means pause on the exact tool call in the run card before continuing.</small>
                  <div className="mcp-marketplace">
                    <div className="provider-card-head">
                      <strong>Marketplace</strong>
                      <Badge tone="neutral">{mcpRegistryEntries.length ? `${mcpRegistryEntries.length} found` : "Registry"}</Badge>
                    </div>
                    <div className="mcp-marketplace-sections">
                      <div className="mcp-marketplace-section">
                        <div>
                          <strong>Browse Registry</strong>
                          <small>Load the registry catalog page-by-page.</small>
                        </div>
                        <Button type="button" disabled={mcpRegistryLoading} onClick={() => void browseRegistryServers()}>
                          <LayoutGrid size={16} />
                          <span>Browse</span>
                        </Button>
                      </div>
                      <form
                        className="mcp-marketplace-section mcp-marketplace-search"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void searchRegistryServers();
                        }}
                      >
                        <div>
                          <strong>Search Registry</strong>
                          <small>Find servers by name, package, or description.</small>
                        </div>
                        <TextInput
                          value={mcpRegistryQuery}
                          placeholder="Search MCP registry"
                          onChange={(event) => setMcpRegistryQuery(event.target.value)}
                        />
                        <Button type="submit" disabled={mcpRegistryLoading}>
                          <Search size={16} />
                          <span>Search</span>
                        </Button>
                      </form>
                    </div>
                    {mcpRegistryNotice ? <small>{mcpRegistryNotice}</small> : null}
                    {mcpRegistryHasStarted || mcpRegistryLoading || mcpRegistryNotice ? (
                      <div className="mcp-marketplace-result-shell">
                        <div className="mcp-marketplace-results-head">
                          <strong>{mcpRegistryMode === "browse" ? "Browse Results" : "Search Results"}</strong>
                          <small>
                            {mcpRegistryLoading ? "Loading..." : `${mcpRegistryEntries.length} loaded`}
                            {mcpRegistryMode === "search" && mcpRegistryActiveQuery ? ` for "${mcpRegistryActiveQuery}"` : ""}
                            {mcpRegistryCount ? ` · ${mcpRegistryCount} checked` : ""}
                          </small>
                        </div>
                        <div className="mcp-marketplace-controls">
                          <Field label="Category">
                            <Select
                              value={mcpRegistryCategory}
                              onValueChange={updateMcpRegistryCategory}
                              options={mcpRegistryCategoryOptions}
                            />
                          </Field>
                          <Field label="Sort">
                            <Select
                              value={mcpRegistrySort}
                              onValueChange={updateMcpRegistrySort}
                              options={mcpRegistrySortOptions}
                            />
                          </Field>
                        </div>
                        <div className="mcp-marketplace-results">
                          {mcpRegistryLoading ? (
                            <div className="mcp-marketplace-loading">
                              <RefreshCw size={15} />
                              <span>Loading MCP registry servers...</span>
                            </div>
                          ) : null}
                          {!mcpRegistryLoading && mcpRegistryEntries.length === 0 ? (
                            <small>
                              {mcpRegistryMode === "search" ? "No registry servers matched this search yet." : "No registry servers matched this filter yet."}
                            </small>
                          ) : null}
                          {mcpRegistryEntries.map((entry) => {
                            const requiredSecrets = entry.install?.secrets.filter((secret) => secret.required).map((secret) => secret.name) ?? [];
                            const alreadyInstalled = draft.mcp.servers.some((server) => server.id === entry.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, ""));
                            return (
                              <article key={entry.id}>
                                <span className="mcp-marketplace-icon" aria-hidden="true">
                                  {entry.iconUrl && !failedMcpIconIds.has(entry.id) ? (
                                    <img
                                      src={entry.iconUrl}
                                      alt=""
                                      loading="lazy"
                                      referrerPolicy="no-referrer"
                                      onError={() => setFailedMcpIconIds((current) => new Set(current).add(entry.id))}
                                    />
                                  ) : mcpRegistryInitials(entry.title, entry.name)}
                                </span>
                                <div>
                                  <strong>{entry.title}</strong>
                                  <span>{entry.name}{entry.version ? ` · ${entry.version}` : ""}</span>
                                  {entry.description ? <small>{entry.description}</small> : null}
                                  <small>
                                    {entry.packageSummary}
                                    {entry.install?.runtime ? ` · ${entry.install.runtime}${entry.install.runtimeAvailable ? "" : " missing"}` : ""}
                                    {requiredSecrets.length ? ` · needs ${requiredSecrets.join(", ")}` : ""}
                                  </small>
                                  {entry.repositoryUrl || entry.websiteUrl ? (
                                    <div className="mcp-marketplace-links">
                                      {entry.repositoryUrl ? (
                                        <a
                                          href={entry.repositoryUrl}
                                          onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            openRuntimeUrl(entry.repositoryUrl!);
                                          }}
                                        >
                                          <ExternalLink size={12} />
                                          <span>Repository</span>
                                        </a>
                                      ) : null}
                                      {entry.websiteUrl ? (
                                        <a
                                          href={entry.websiteUrl}
                                          onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            openRuntimeUrl(entry.websiteUrl!);
                                          }}
                                        >
                                          <ExternalLink size={12} />
                                          <span>Website</span>
                                        </a>
                                      ) : null}
                                    </div>
                                  ) : null}
                                  <div className="mcp-marketplace-tags">
                                    {entry.categories.map((category) => (
                                      <span key={`category-${category}`} className="mcp-marketplace-tag category">{mcpRegistryCategoryLabel(category)}</span>
                                    ))}
                                    {entry.typeTags.map((tag) => (
                                      <span key={`type-${tag}`} className="mcp-marketplace-tag">{tag}</span>
                                    ))}
                                  </div>
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={!entry.installable || mcpRegistryInstallingId === entry.id}
                                  onClick={() => void installRegistryServer(entry)}
                                >
                                  <Download size={14} />
                                  <span>{alreadyInstalled ? "Update" : entry.install?.secrets.some((secret) => secret.required) ? "Install" : "Install & Connect"}</span>
                                </Button>
                                {!entry.installable ? <small>{entry.installMessage}</small> : null}
                              </article>
                            );
                          })}
                        </div>
                        {mcpRegistryNextCursor ? (
                          <Button type="button" size="sm" disabled={mcpRegistryLoading} onClick={() => void loadMoreRegistryServers()}>
                            <RefreshCw size={14} />
                            <span>{mcpRegistryEntries.length === 0 ? "Search Deeper" : "Load More"}</span>
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="action-row">
                    <Button
                      type="button"
                      disabled={!rootPath || capabilityBusy}
                      onClick={async () => {
                        if (!window.archicode || !rootPath) return;
                        const imported = await window.archicode.importMcpServers(rootPath, { kind: "codex-auto" });
                        updateDraft({ mcp: imported.project.settings.mcp });
                        void refreshCapabilities();
                      }}
                    >
                      <PlugZap size={16} />
                      <span>Import Codex Config</span>
                    </Button>
                  </div>
                  <Field label="Import JSON" hint='Paste {"mcpServers": {"name": {"command": "...", "args": []}}}'>
                    <TextArea
                      rows={4}
                      value={mcpJsonImport}
                      onChange={(event) => setMcpJsonImport(event.target.value)}
                    />
                  </Field>
                  <Button
                    type="button"
                    disabled={!mcpJsonImport.trim() || capabilityBusy}
                    onClick={async () => {
                      if (!window.archicode || !rootPath) return;
                      const imported = await window.archicode.importMcpServers(rootPath, { kind: "json", content: mcpJsonImport });
                      updateDraft({ mcp: imported.project.settings.mcp });
                      setMcpJsonImport("");
                      void refreshCapabilities();
                    }}
                  >
                    <Upload size={16} />
                    <span>Import JSON Servers</span>
                  </Button>
                  <div className="settings-two-col">
                    <Field label="Server id">
                      <TextInput value={mcpDraft.id} onChange={(event) => setMcpDraft((current) => ({ ...current, id: event.target.value }))} />
                    </Field>
                    <Field label="Label">
                      <TextInput value={mcpDraft.label} onChange={(event) => setMcpDraft((current) => ({ ...current, label: event.target.value }))} />
                    </Field>
                    <Field label="Transport">
                      <Select
                        value={mcpDraft.transport}
                        onValueChange={(transport) => setMcpDraft((current) => ({ ...current, transport }))}
                        options={[
                          { value: "stdio", label: "stdio" },
                          { value: "streamable-http", label: "Streamable HTTP" }
                        ]}
                      />
                    </Field>
                    {mcpDraft.transport === "stdio" ? (
                      <Field label="Command">
                        <TextInput value={mcpDraft.command} placeholder="npx" onChange={(event) => setMcpDraft((current) => ({ ...current, command: event.target.value }))} />
                      </Field>
                    ) : (
                      <Field label="URL">
                        <TextInput value={mcpDraft.url} placeholder="http://127.0.0.1:3000/mcp" onChange={(event) => setMcpDraft((current) => ({ ...current, url: event.target.value }))} />
                      </Field>
                    )}
                  </div>
                  <Field label="Arguments" hint="One argument per line for stdio servers.">
                    <TextArea rows={3} value={mcpDraft.args} onChange={(event) => setMcpDraft((current) => ({ ...current, args: event.target.value }))} />
                  </Field>
                  <Button type="button" disabled={!mcpDraft.id.trim() || !mcpDraft.label.trim()} onClick={addMcpDraftServer}>
                    <Plus size={16} />
                    <span>Add MCP Server</span>
                  </Button>
                  <div className="policy-list">
                    {draft.mcp.servers.length === 0 ? <small>No MCP servers configured.</small> : null}
                    {draft.mcp.servers.map((server) => {
                      const refreshed = mcpServers.find((item) => item.id === server.id) ?? server;
                      return (
                        <article key={server.id}>
                          <strong>{server.label}</strong>
                          <span>{server.transport} · {server.tools.length || refreshed.tools.length} tools{server.lastError ? ` · ${server.lastError}` : ""}</span>
                          <Switch
                            checked={server.enabled}
                            onCheckedChange={(checked) => updateMcpDraftServer(server.id, { enabled: checked })}
                            label={server.enabled ? "Enabled" : "Disabled"}
                          />
                          <Switch
                            checked={server.trusted}
                            onCheckedChange={(checked) => updateMcpDraftServer(server.id, { trusted: checked })}
                            label={server.trusted ? "Trusted" : "Ask"}
                          />
                          <Button type="button" size="sm" disabled={capabilityBusy} onClick={() => void refreshDraftMcpServer(server.id)}>
                            <RefreshCw size={14} />
                            <span>Refresh</span>
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => updateDraft({
                              mcp: {
                                ...draft.mcp,
                                servers: draft.mcp.servers.filter((item) => item.id !== server.id)
                              }
                            })}
                          >
                            <X size={14} />
                            <span>Remove</span>
                          </Button>
                          {server.env.length ? (
                            <Field label="Environment">
                              <TextArea
                                rows={Math.max(2, server.env.length)}
                                value={mcpKeyValuesToText(server.env)}
                                onChange={(event) => updateMcpDraftServer(server.id, { env: mcpTextToKeyValues(event.target.value) })}
                              />
                            </Field>
                          ) : null}
                          {server.headers.length ? (
                            <Field label="HTTP Headers">
                              <TextArea
                                rows={Math.max(2, server.headers.length)}
                                value={mcpKeyValuesToText(server.headers)}
                                onChange={(event) => updateMcpDraftServer(server.id, { headers: mcpTextToKeyValues(event.target.value) })}
                              />
                            </Field>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                    </div>
                  ) : null}
                </section>
              </TabsContent>

              <TabsContent value="advanced" className="settings-tab-content narrow">
                <section className="speech-settings-panel">
                  <div className="speech-settings-head">
                    <div>
                      <strong>Local Agent Environment</strong>
                      <small>Machine-local hints passed to LLM agents so they use the right shell and project folder.</small>
                    </div>
                    <Badge tone="neutral">Local</Badge>
                  </div>
                  <div className="settings-two-col">
                    <Field label="Operating system" hint="Detected by the desktop app and stored only in this project's local ArchiCode state.">
                      <TextInput readOnly value={localEnvironment.operatingSystem} />
                    </Field>
                    <Field label="Agent shell" hint="Tell LLM agents which console shell to assume for commands and examples.">
                      <TextInput
                        value={localEnvironment.agentShell}
                        placeholder="powershell.exe"
                        onChange={(event) => updateLocalEnvironment({ agentShell: event.target.value })}
                      />
                    </Field>
                  </div>
                  <Field label="Project folder" hint="The absolute folder loaded on this machine. This is not written to shareable project.json.">
                    <TextInput readOnly value={localEnvironment.projectRoot || rootPath || bundle?.project.rootPath || ""} />
                  </Field>
                </section>
                <section className="speech-settings-panel">
                  <div className="speech-settings-head">
                    <div>
                      <strong>Semantic Index</strong>
                      <small>Local meaning-based retrieval for codebase imports, research chat, and AI build context.</small>
                    </div>
                    <Badge tone={semanticIndexStatus?.state === "ready" ? "success" : semanticIndexStatus?.state === "error" || semanticIndexStatus?.state === "unavailable" || semanticIndexStatus?.state === "partial" || semanticIndexStatus?.state === "stale" || semanticIndexStatus?.state === "graph-only" ? "warning" : "neutral"}>
                      {semanticIndexStatus?.state === "ready" ? "Ready" : semanticIndexStatus?.state === "graph-only" ? "Graph only" : semanticIndexStatus?.state === "indexing" ? "Indexing" : semanticIndexStatus?.state === "empty" ? "Empty" : semanticIndexStatus?.state === "disabled" ? "Off" : semanticIndexStatus?.state === "partial" ? "Partial" : semanticIndexStatus?.state === "stale" ? "Stale" : semanticIndexStatus?.state === "unavailable" ? "Unavailable" : semanticIndexStatus?.state === "error" ? "Error" : "Checking"}
                    </Badge>
                  </div>
                  <Switch
                    checked={draft.semanticIndex.enabled}
                    onCheckedChange={(enabled) => updateDraft({ semanticIndex: { ...draft.semanticIndex, enabled } })}
                    label="Use local semantic indexing"
                    tooltip="Uses the bundled CPU embedding model to improve functional grouping and retrieve related graph context. The disposable index stays outside Git."
                  />
                  <div className="settings-two-col">
                    <Field label="Model" hint="Both models are bundled. Changing this machine-local preference clears incompatible vectors and rebuilds the active project's index.">
                      <Select
                        value={semanticModelPreference}
                        onValueChange={(value) => void switchSemanticModel(value as "bge-small-en-v1.5" | "minilm-l6-v2")}
                        disabled={semanticModelSwitching}
                        options={[
                          { value: "bge-small-en-v1.5", label: "BGE Small · Higher quality (Default)" },
                          { value: "minilm-l6-v2", label: "MiniLM · Faster" }
                        ]}
                      />
                    </Field>
                    <Field label="Indexed items" hint="Graph records, file summaries, and token-safe source chunks in this machine-local cache.">
                      <TextInput readOnly value={(semanticIndexStatus?.indexedItems ?? 0).toLocaleString()} />
                    </Field>
                    <Field label="Graph records" hint="Architecture nodes, notes, and rules available for graph-to-graph semantic context.">
                      <TextInput readOnly value={(semanticIndexStatus?.graphItems ?? 0).toLocaleString()} />
                    </Field>
                    <Field label="Code records" hint="File summaries and source chunks available for Possible semantic matches.">
                      <TextInput readOnly value={(semanticIndexStatus?.codeItems ?? 0).toLocaleString()} />
                    </Field>
                    <Field label="Cache size" hint="Stored in ArchiCode application data, never in the project repository.">
                      <TextInput readOnly value={formatBytes(semanticIndexStatus?.cacheSizeBytes ?? 0)} />
                    </Field>
                    <Field label="Last updated">
                      <TextInput readOnly value={semanticIndexStatus?.updatedAt ? new Date(semanticIndexStatus.updatedAt).toLocaleString() : "Not built yet"} />
                    </Field>
                    <Field label="Code coverage" hint="Every eligible source file must be covered before the index reports Ready.">
                      <TextInput readOnly value={semanticIndexStatus?.coverage ? `${semanticIndexStatus.coverage.indexedFiles.toLocaleString()} / ${semanticIndexStatus.coverage.eligibleFiles.toLocaleString()} files` : "Not measured yet"} />
                    </Field>
                    <Field label="Source chunks" hint="Tokenizer-safe chunks spanning the full eligible source, grouped by functions, classes, methods, and components.">
                      <TextInput readOnly value={(semanticIndexStatus?.coverage?.chunks ?? 0).toLocaleString()} />
                    </Field>
                    <Field label="Components indexed" hint="Function, class, method, component, interface, type, and related symbol spans detected across the repository.">
                      <TextInput readOnly value={(semanticIndexStatus?.coverage?.symbols ?? 0).toLocaleString()} />
                    </Field>
                    <Field label="Source lines covered">
                      <TextInput readOnly value={semanticIndexStatus?.coverage ? `${semanticIndexStatus.coverage.indexedSourceLines.toLocaleString()} / ${semanticIndexStatus.coverage.sourceLines.toLocaleString()}` : "Not measured yet"} />
                    </Field>
                  </div>
                  <div>
                    <Field label="Related nodes per AI context" hint="Explicit scope and real graph neighbors always take priority.">
                      <TextInput
                        type="number"
                        min={0}
                        max={12}
                        value={draft.semanticIndex.maxRelatedNodes}
                        onChange={(event) => updateDraft({ semanticIndex: { ...draft.semanticIndex, maxRelatedNodes: Math.min(12, Math.max(0, Number(event.target.value) || 0)) } })}
                      />
                    </Field>
                  </div>
                  <div className="action-row">
                    <Button type="button" size="sm" disabled={semanticIndexBusy || !draft.semanticIndex.enabled} onClick={() => void rebuildSemanticIndex()}>
                      {semanticIndexBusy ? <Loader2 size={14} className="is-spinning" /> : <BrainCircuit size={14} />}
                      <span>Rebuild Code Index</span>
                    </Button>
                    <Button type="button" size="sm" disabled={semanticIndexBusy || !(semanticIndexStatus?.indexedItems ?? 0)} onClick={() => void clearSemanticIndexCache()}>
                      <Trash2 size={14} />
                      <span>Clear Cache</span>
                    </Button>
                    <Button type="button" size="sm" disabled={semanticIndexBusy} onClick={() => void refreshSemanticIndexStatus()}>
                      <RefreshCw size={14} />
                      <span>Refresh Status</span>
                    </Button>
                  </div>
                  <small>{semanticIndexProgress ?? semanticIndexStatus?.message ?? "Checking semantic index health…"}</small>
                  {semanticIndexStatus?.error ? <small className="settings-validation-error">{semanticIndexStatus.error}</small> : null}
                  {semanticIndexNotice ? <small className="speech-setup-status">{semanticIndexNotice}</small> : null}
                  <small>Save settings after changing the toggle. Import and AI features fall back to structural context if this service is unavailable.</small>
                </section>
                <section className="speech-settings-panel">
                  <div className="speech-settings-head">
                    <div>
                      <strong>Hosted MCP</strong>
                      <small>Local Streamable HTTP endpoint for external Codex and Claude Code clients.</small>
                    </div>
                    <Badge tone={externalMcpHostStatus?.running ? "success" : draft.externalMcpHost.enabled ? "warning" : "neutral"}>
                      {externalMcpHostStatus?.running ? "Running" : draft.externalMcpHost.enabled ? "Save to start" : "Off"}
                    </Badge>
                  </div>
                  <Switch
                    checked={draft.externalMcpHost.enabled}
                    onCheckedChange={(checked) => updateDraft({
                      externalMcpHost: {
                        ...draft.externalMcpHost,
                        enabled: checked
                      }
                    })}
                    label="Host ArchiCode MCP on localhost"
                    tooltip="Starts a local MCP endpoint after saving settings. External clients with the token can read and apply validated graph changes."
                  />
                  <div className="settings-two-col">
                    <Field label="Endpoint" hint="The hosted MCP path is bound to 127.0.0.1 only.">
                      <TextInput readOnly value={externalMcpHostStatus?.endpoint ?? `http://${draft.externalMcpHost.host}:${draft.externalMcpHost.port}/mcp`} />
                    </Field>
                    <Field label="Port" hint="Use another port if the default is already in use.">
                      <TextInput
                        type="number"
                        min={1024}
                        max={65535}
                        value={draft.externalMcpHost.port}
                        onChange={(event) => updateDraft({
                          externalMcpHost: {
                            ...draft.externalMcpHost,
                            port: Math.min(65535, Math.max(1024, Number(event.target.value) || 37373))
                          }
                        })}
                      />
                    </Field>
                  </div>
                  <Switch
                    checked={draft.externalMcpHost.requireToken}
                    onCheckedChange={(checked) => updateDraft({
                      externalMcpHost: {
                        ...draft.externalMcpHost,
                        requireToken: checked
                      }
                    })}
                    label="Require bearer token"
                    tooltip="Protects the write-capable local endpoint from other local processes that do not have the generated token."
                  />
                  {draft.externalMcpHost.requireToken ? (
                    <Field label="Bearer token" hint="Stored only in this project's local ArchiCode state. Regenerating restarts the hosted endpoint if it is running.">
                      <TextInput readOnly type="password" value={externalMcpHostStatus?.token ?? ""} />
                    </Field>
                  ) : null}
                  <div className="settings-copy-note">
                    <strong>Codex app setup</strong>
                    <small>Use Settings - MCP servers - Connect to a custom MCP.</small>
                    <small>Paste the URL above, leave bearer token env var empty, then add direct headers.</small>
                    <small><code>Authorization</code> = bearer token, <code>default_tools_approval_mode</code> = <code>auto</code>.</small>
                  </div>
                  <div className="action-row">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void refreshExternalMcpHostStatus()}
                    >
                      <RefreshCw size={14} />
                      <span>Refresh</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!externalMcpHostStatus?.endpoint}
                      onClick={() => copyExternalMcpText(externalMcpHostStatus?.endpoint ?? "", "Endpoint")}
                    >
                      <Copy size={14} />
                      <span>Copy URL</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!externalMcpHostStatus?.token}
                      onClick={() => copyExternalMcpText(externalMcpHostStatus?.token ?? "", "Token")}
                    >
                      <Copy size={14} />
                      <span>Copy Token</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!externalMcpHostStatus?.codexConfig}
                      onClick={() => copyExternalMcpText(externalMcpHostStatus?.codexConfig ?? "", "Codex app setup")}
                    >
                      <Copy size={14} />
                      <span>Copy Codex App Setup</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!externalMcpHostStatus?.claudeConfig}
                      onClick={() => copyExternalMcpText(externalMcpHostStatus?.claudeConfig ?? "", "Claude config")}
                    >
                      <Copy size={14} />
                      <span>Copy Claude Config</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={externalMcpHostBusy}
                      onClick={() => void regenerateExternalMcpHostToken()}
                    >
                      {externalMcpHostBusy ? <Loader2 size={14} className="is-spinning" /> : <ShieldCheck size={14} />}
                      <span>Regenerate Token</span>
                    </Button>
                  </div>
                  <small>
                    Write mode: direct validated apply. External clients can change graph data when hosting is enabled and they have the token.
                  </small>
                  {externalMcpHostStatus?.error ? <small className="settings-validation-error">{externalMcpHostStatus.error}</small> : null}
                  {externalMcpHostNotice ? <small className="speech-setup-status">{externalMcpHostNotice}</small> : null}
                </section>
                <section className="speech-settings-panel">
                  <div className="speech-settings-head">
                    <div>
                      <strong>Voice input (STT)</strong>
                      <small>Local speech-to-text uses a downloadable Transformers.js Whisper base model.</small>
                    </div>
                    {speechStatus?.runtimeAvailable ? (
                      <Badge tone="success">Ready</Badge>
                    ) : (
                      <Badge tone="warning">Setup needed</Badge>
                    )}
                  </div>
                  <Switch
                    checked={speechDraft.enabled}
                    onCheckedChange={(checked) => setSpeechDraft({
                      ...speechDraft,
                      enabled: checked
                    })}
                    label="Enable voice input"
                    tooltip="Shows the microphone action in scoped research chat and allows local speech transcription."
                  />
                  <div className="settings-two-col">
                    <Field label="Active speech model" hint="Choose the model used by chat voice input and the setup test.">
                      <Select
                        value={speechDraft.modelId}
                        onValueChange={(value) => selectSpeechModel(value as SpeechSettings["modelId"])}
                        options={[
                          { value: "base", label: "Multilingual base" },
                          { value: "base.en", label: "English optimized base" }
                        ]}
                      />
                    </Field>
                    <Field label="Speech language" hint="Transformers.js Whisper does not auto-detect language yet; choose the spoken language for multilingual input.">
                      <Select
                        value={speechDraft.modelId === "base.en" ? "english" : normalizeSpeechLanguage(speechDraft.language)}
                        onValueChange={(value) => setSpeechDraft({
                          ...speechDraft,
                          language: speechDraft.modelId === "base.en" ? "english" : value
                        })}
                        options={speechLanguageOptions}
                      />
                    </Field>
                  </div>
                  <Switch
                    checked={speechDraft.modelId !== "base.en" && speechDraft.translateToEnglish}
                    onCheckedChange={(checked) => setSpeechDraft({
                      ...speechDraft,
                      translateToEnglish: speechDraft.modelId === "base.en" ? false : checked
                    })}
                    label="Translate multilingual speech to English"
                    tooltip="For the multilingual base model, asks Whisper to return English text from non-English speech."
                  />
                  <div className="speech-model-list">
                    {(speechStatus?.models ?? []).map((model) => {
                      const isActive = model.id === speechDraft.modelId;
                      const isDownloading = speechDownloadingModelId === model.id;
                      const isDeleting = speechDeletingModelId === model.id;
                      return (
                        <article
                          key={model.id}
                          className={isActive ? "speech-model-row is-active" : "speech-model-row"}
                          role="button"
                          tabIndex={0}
                          aria-pressed={isActive}
                          onClick={() => selectSpeechModel(model.id)}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            selectSpeechModel(model.id);
                          }}
                        >
                          <div className="speech-model-meta">
                            <strong>{model.id === "base" ? "Multilingual base" : "English optimized base"}</strong>
                            <small>{model.label} · {model.approximateSize}{model.sizeBytes ? ` · ${formatBytes(model.sizeBytes)} on disk` : ""}</small>
                          </div>
                          <Badge tone={model.downloaded ? "success" : "neutral"}>{model.downloaded ? "Downloaded" : "Not downloaded"}</Badge>
                          <Button
                            type="button"
                            size="sm"
                            variant={model.downloaded ? "danger" : "secondary"}
                            disabled={Boolean(speechDownloadingModelId) || Boolean(speechDeletingModelId)}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (model.downloaded) void deleteSpeechSetupModel(model.id);
                              else void downloadSpeechSetupModel(model.id);
                            }}
                          >
                            {isDownloading || isDeleting ? (
                              <Loader2 size={14} className="is-spinning" />
                            ) : model.downloaded ? (
                              <Trash2 size={14} />
                            ) : (
                              <Download size={14} />
                            )}
                            <span>{isDeleting ? "Deleting" : model.downloaded ? "Delete" : "Download"}</span>
                          </Button>
                        </article>
                      );
                    })}
                  </div>
                  <div className="speech-test-actions">
                    <Button
                      type="button"
                      variant={speechTestRecording ? "danger" : "primary"}
                      disabled={speechTestDisabled && !speechTestRecording}
                      onClick={() => void runSpeechSetupTest()}
                    >
                      {speechTestBusy ? <Loader2 size={16} className="is-spinning" /> : speechTestRecording ? <Square size={16} /> : <Mic size={16} />}
                      <span>{speechTestRecording ? "Stop and transcribe" : "Record test"}</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void refreshSpeechStatus(speechDraft.modelId)}
                    >
                      <RefreshCw size={14} />
                      <span>Refresh</span>
                    </Button>
                    <small>
                      {activeSpeechModel?.downloaded
                        ? `${activeSpeechModel.label} is ready for testing.`
                        : "Download the active model before testing."}
                    </small>
                  </div>
                  {speechSetupProgress || speechSetupNotice || speechSetupError ? (
                    <small className={speechSetupError ? "speech-setup-status has-error" : "speech-setup-status"}>
                      {speechSetupError ?? speechSetupProgress ?? speechSetupNotice}
                    </small>
                  ) : null}
                  {speechTestTranscript ? (
                    <div className="speech-test-result">
                      <strong>Test transcript</strong>
                      <p>{speechTestTranscript}</p>
                    </div>
                  ) : null}
                </section>
                <section className="speech-settings-panel">
                  <div className="speech-settings-head">
                    <div>
                      <strong>Voice output (TTS)</strong>
                      <small>Local text-to-speech uses a downloadable Transformers.js Kokoro 82M q8 model.</small>
                    </div>
                    {ttsStatus?.runtimeAvailable ? (
                      <Badge tone="success">Ready</Badge>
                    ) : (
                      <Badge tone="warning">Setup needed</Badge>
                    )}
                  </div>
                  <Switch
                    checked={ttsDraft.enabled}
                    onCheckedChange={(checked) => setTtsDraft({
                      ...ttsDraft,
                      enabled: checked
                    })}
                    label="Enable voice output"
                    tooltip="Shows speaker actions on assistant messages and allows local text-to-speech playback."
                  />
                  <div className="settings-two-col">
                    <Field label="Active TTS model" hint="Choose the model used by assistant message playback and the setup test.">
                      <Select
                        value={ttsDraft.modelId}
                        onValueChange={(value) => setTtsDraft({
                          ...ttsDraft,
                          modelId: value as TtsSettings["modelId"]
                        })}
                        options={(ttsStatus?.models.length ? ttsStatus.models : [
                          { id: "kokoro-82m", label: "Kokoro 82M q8" }
                        ]).map((model) => ({ value: model.id, label: model.label }))}
                      />
                    </Field>
                    <Field label="Voice" hint={activeTtsVoice ? activeTtsVoice.description : "Choose the voice used for assistant playback."}>
                      <Select
                        value={ttsDraft.voiceId}
                        onValueChange={(value) => setTtsDraft({
                          ...ttsDraft,
                          voiceId: value as TtsSettings["voiceId"]
                        })}
                        options={ttsVoiceOptions}
                      />
                    </Field>
                  </div>
                  <div className="settings-two-col">
                    <Field label="Speech speed" hint="Use 1.0 for natural speed; Kokoro supports a small speed adjustment range.">
                      <TextInput
                        type="number"
                        min={0.8}
                        max={1.2}
                        step={0.05}
                        value={ttsDraft.speed}
                        onChange={(event) => setTtsDraft({
                          ...ttsDraft,
                          speed: Math.min(1.2, Math.max(0.8, Number(event.target.value) || 1))
                        })}
                      />
                    </Field>
                    <Switch
                      checked={ttsDraft.autoplay}
                      onCheckedChange={(checked) => setTtsDraft({
                        ...ttsDraft,
                        autoplay: checked
                      })}
                      label="Autoplay assistant replies"
                      tooltip="Automatically reads new assistant messages aloud after they finish generating."
                    />
                  </div>
                  <div className="speech-model-list">
                    {(ttsStatus?.models ?? []).map((model) => {
                      const isActive = model.id === ttsDraft.modelId;
                      const isDownloading = ttsDownloadingModelId === model.id;
                      const isDeleting = ttsDeletingModelId === model.id;
                      return (
                        <article
                          key={model.id}
                          className={isActive ? "speech-model-row is-active" : "speech-model-row"}
                          role="button"
                          tabIndex={0}
                          aria-pressed={isActive}
                          onClick={() => setTtsDraft({ ...ttsDraft, modelId: model.id })}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            setTtsDraft({ ...ttsDraft, modelId: model.id });
                          }}
                        >
                          <div className="speech-model-meta">
                            <strong>{model.label}</strong>
                            <small>{model.modelId} · {model.approximateSize}{model.sizeBytes ? ` · ${formatBytes(model.sizeBytes)} on disk` : ""}</small>
                          </div>
                          <Badge tone={model.downloaded ? "success" : "neutral"}>{model.downloaded ? "Downloaded" : "Not downloaded"}</Badge>
                          <Button
                            type="button"
                            size="sm"
                            variant={model.downloaded ? "danger" : "secondary"}
                            disabled={Boolean(ttsDownloadingModelId) || Boolean(ttsDeletingModelId)}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (model.downloaded) void deleteTtsSetupModel(model.id);
                              else void downloadTtsSetupModel(model.id);
                            }}
                          >
                            {isDownloading || isDeleting ? (
                              <Loader2 size={14} className="is-spinning" />
                            ) : model.downloaded ? (
                              <Trash2 size={14} />
                            ) : (
                              <Download size={14} />
                            )}
                            <span>{isDeleting ? "Deleting" : model.downloaded ? "Delete" : "Download"}</span>
                          </Button>
                        </article>
                      );
                    })}
                  </div>
                  <div className="speech-test-actions">
                    <Button
                      type="button"
                      variant="primary"
                      disabled={ttsTestDisabled}
                      onClick={() => void playTtsSetupTest()}
                    >
                      {ttsTestBusy ? <Loader2 size={16} className="is-spinning" /> : <Volume2 size={16} />}
                      <span>Play test</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void refreshTtsStatus(ttsDraft.modelId)}
                    >
                      <RefreshCw size={14} />
                      <span>Refresh</span>
                    </Button>
                    <small>
                      {activeTtsModel?.downloaded
                        ? `${activeTtsModel.label} is ready for ${activeTtsVoice?.label ?? ttsDraft.voiceId}.`
                        : "Download the active model before testing."}
                    </small>
                  </div>
                  {ttsSetupProgress || ttsSetupNotice || ttsSetupError ? (
                    <small className={ttsSetupError ? "speech-setup-status has-error" : "speech-setup-status"}>
                      {ttsSetupError ?? ttsSetupProgress ?? ttsSetupNotice}
                    </small>
                  ) : null}
                </section>
                <section className="settings-maintenance-row">
                  <div>
                    <strong>Purge resolved notes</strong>
                    <small>Deletes resolved node notes from this project. Open notes remain available to users and agents.</small>
                  </div>
                  <Tooltip content="Deletes all resolved notes from this project after confirmation. Open notes are kept.">
                    <span className="toolbar-tooltip-target">
                      <Button
                        type="button"
                        variant="danger"
                        disabled={resolvedNoteCount === 0}
                        onClick={() => {
                          const suffix = resolvedNoteCount === 1 ? "" : "s";
                          if (window.confirm(`Purge ${resolvedNoteCount} resolved note${suffix} from this project?`)) {
                            void purgeResolvedNotes();
                          }
                        }}
                      >
                        <Trash2 size={16} />
                        <span>Purge resolved</span>
                      </Button>
                    </span>
                  </Tooltip>
                </section>
                <section className="danger-zone">
                  <div>
                    <strong>Remove this project from ArchiCode</strong>
                    <small>ArchiCode will forget its saved information for this project, including the project map, nodes and flows, notes, run records, chat history, and ArchiCode settings. Your source code and regular project files will stay untouched. Opening this folder in ArchiCode later will require importing it again to rebuild the map.</small>
                  </div>
                  <Tooltip content="Removes ArchiCode's saved project information, but not your source files. Reopening this folder in ArchiCode will require a new import.">
                    <span className="toolbar-tooltip-target">
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => {
                          void (async () => {
                            if (await deleteProjectState()) setSettingsOpen(false);
                          })();
                        }}
                      >
                        <Trash2 size={16} />
                        <span>Remove from ArchiCode</span>
                      </Button>
                    </span>
                  </Tooltip>
                </section>
</TabsContent>
                </>
              ) : null}
            <ShortcutsSettingsTab />
          </TabsRoot>

          {draft && (
            <div className="dialog-actions">
              <Button type="button" onClick={() => setSettingsOpen(false)}>
                <X size={16} />
                <span>Cancel</span>
              </Button>
              <Button
                variant="primary"
                type="button"
                onClick={() => {
                  void (async () => {
                    setSettingsSaveBusy(true);
                    try {
                      const providerIdsToCheck = new Set(
                        draft
                          ? providersNeedingAutoCheckOnSave(
                            draft.providers,
                            bundle?.project.settings.providers ?? [],
                            savedApiKeyIds
                          ).map((provider) => provider.id)
                          : []
                      );
                      if (detailsDraft.name.trim() !== bundle?.project.name) {
                        await updateProjectDetails({ name: detailsDraft.name });
                      }
                      await window.archicode.saveGlobalResearchPersonality(globalResearchPersonality);
                      await window.archicode.saveGlobalResearchVerbosity(globalResearchVerbosity);
                      await updateGlobalSpeechSettings(speechDraft);
                      await updateGlobalTtsSettings(ttsDraft);
                      if (window.archicode?.saveWebSearchSecrets) {
                        await window.archicode.saveWebSearchSecrets(webSearchSecretsDraft, { preserveMissingSecrets: true });
                        await refreshWebSearchSecretStatus();
                      }
                      await updateSettings(draft);
                      await refreshSavedApiKeyStatus();
                      for (const provider of draft.providers.filter((item) => providerIdsToCheck.has(item.id))) {
                        await checkProvider(provider.id);
                      }
                      if (agentInstructionsDirty && rootPath) {
                        const instructions = await window.archicode.writeAgentInstructionFile(rootPath, agentInstructions.path, agentInstructions.text);
                        const files = await window.archicode.listAgentInstructionFiles(rootPath);
                        setAgentInstructionFiles(files);
                        setAgentInstructions({ ...instructions, loadedForRoot: rootPath });
                        setAgentInstructionsDirty(false);
                      }
                      setSettingsOpen(false);
                    } catch (error) {
                      setAgentInstructionsError(error instanceof Error ? error.message : String(error));
                    } finally {
                      setSettingsSaveBusy(false);
                    }
                  })();
                }}
                disabled={settingsSaveBusy || !detailsDraft.name.trim() || Boolean(runProfilesError)}
              >
                {settingsSaveBusy ? <Loader2 size={16} className="is-spinning" /> : <Save size={16} />}
                <span>{settingsSaveBusy ? "Saving..." : "Save"}</span>
              </Button>
            </div>
          )}
          </DialogContent>
                ) : (
                  <small>Choose a provider before editing phase policy.</small>
                )}
      </DialogRoot>
      <ResyncCodebaseDialog open={resyncCodebaseOpen} onOpenChange={setResyncCodebaseOpen} />
    </>
  );
}
