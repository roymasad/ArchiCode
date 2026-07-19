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

import type { ComposerMention, ComposerSegment, QueuedResearchMessage, ShellPrompt, AgentRunInput, RunGuidanceInput, BuildQuestionCheck, NodeClipboard, CodebaseOnboardingLevel, CodebaseOnboardingDetail, CodebaseOnboardingGranularity, ProjectSettingsTab, WorkbenchView, GitOperationName, CanvasViewport, UiScale, GraphNavigationRequest, FilePreviewRequest, GraphNavigationTarget, CodebaseOnboarding, ProjectSettingsRequest, RunProfileInput, PatchProposalView, AppNotice, ResearchStreamState, LiveSubagentActivity, LiveResearchActivity, ArchicodeState, StoreSet, StoreGet } from "./types";
import { uid, uniqueNodeIds, selectedNodeIdsFor, appendEdgeLabelHistory, directUndoNotice, offerGitAttributesSetup, now, runInputKey, runProfileKey, isSameRunRequest, isSameRunProfileRequest, runArtifactIds, runHasQuestionRefreshSignal, shouldRefreshQuestionsForRun, hasActiveRun, editingLockedMessage, notifyJobFinished, notifyReviewRequired, createOptimisticRun, createOptimisticRunProfile, defaultNodeHalfSize, getInitialTheme, getInitialUiScale, projectUiKey, projectScopedUiKey, readStoredWorkbenchView, readProjectFileBrowserState, isFiniteNumber, readStoredViewport, isVisualQaPreview, createFallbackBundle, createVisualQaResearchSessions, projectScopedResetState, clearProjectStateForBranchChange, reloadProjectStateAfterBranchChange, isBuildLikeAgentRun, getActiveFlow, getSelectedNode, getSelectedEdge, defaultResearchScope, normalizeComposerSegments, addResearchBusySession, removeResearchBusySession, selectedResearchSessionOrFallback, nextGraphNavigationRequestId, nextFilePreviewRequestId } from "./helpers";
import { readStoredGraphLocation, resolveGraphLocation } from "./graphLocation";

export const createProjectSlice = (set: StoreSet, get: StoreGet): Pick<ArchicodeState, "load" | "reload" | "openProjectFolder" | "cloneGitRepository" | "openRecentProject" | "revealProjectFolder" | "openProjectInVsCode" | "createProjectFromTemplate" | "handleExternalProjectUpdated" | "setShellPrompt" | "dismissCodebaseOnboarding" | "openInitialCodebaseImportReport" | "openProjectSettings" | "clearProjectSettingsRequest" | "startCodebaseOnboardingRun" | "cancelCodebaseOnboardingRun" | "importFlow" | "importDrawioFlow" | "exportActiveFlow" | "exportActiveDrawioFlow" | "exportProjectBundle" | "exportProjectDocument" | "repairProject" | "deleteProjectState" | "updateSettings" | "updateProjectDetails"> => ({
  load: async () => {
    try {
      set({ loading: true, error: null });
      if (!window.archicode) {
        if (!isVisualQaPreview()) {
          set({
            rootPath: "",
            bundle: null,
            activeFlowId: null,
            selectedNodeId: null,
            selectedNodeIds: [],
            selectedEdgeId: null,
            selectedRunId: null,
            activeSubflowId: null,
            canvasViewport: null,
            canvasViewportCenter: null,
            gitStatus: null,
            fileBrowser: null,
            selectedFilePath: null,
            filePreviewRequest: null,
            filePreview: null,
            fileDiff: null,
            loading: false
          });
          return;
        }
        const bundle = createFallbackBundle();
        const researchSessions = createVisualQaResearchSessions(bundle.rootPath);
        set({
          rootPath: bundle.rootPath,
          bundle,
          activeFlowId: bundle.project.activeFlowId,
          selectedNodeId: null,
          selectedNodeIds: [],
          researchSessions,
          selectedResearchSessionId: researchSessions[0]?.id ?? null,
          gitStatus: {
            isRepo: true,
            repoRoot: bundle.rootPath,
            currentBranch: "codex/ui-clutter-sweep",
            upstream: "origin/main",
            ahead: 2,
            behind: 0,
            branches: ["main", "codex/ui-clutter-sweep"],
            changes: [
              { path: "src/renderer/src/App.tsx", index: "M", workingTree: "M", additions: 42, deletions: 12 },
              { path: "src/renderer/src/styles/app.css", index: "M", workingTree: "M", additions: 180, deletions: 44 },
              { path: "scripts/visual-qa-main.cjs", index: "M", workingTree: "M", additions: 31, deletions: 18 }
            ],
            recentCommits: [
              {
                hash: "8f2a9d1c6b5e4a3f2d1c0b9a8877665544332211",
                shortHash: "8f2a9d1",
                subject: "Refine visual QA screenshot matrix",
                authorName: "ArchiCode",
                authoredAt: now()
              },
              {
                hash: "4c1d7a0e9b8c6d5f4a3b2c1d0099887766554433",
                shortHash: "4c1d7a0",
                subject: "Reduce renderer panel clutter",
                authorName: "ArchiCode",
                authoredAt: now()
              }
            ],
            stashes: []
          },
          gitLogs: [
            {
              ok: true,
              command: "git status --short",
              stdout: "M src/renderer/src/App.tsx\nM src/renderer/src/styles/app.css\nM scripts/visual-qa-main.cjs",
              stderr: "",
              exitCode: 0,
              at: now()
            }
          ],
          loading: false
        });
        return;
      }
      const rootPath = await window.archicode.defaultRoot();
      const recentProjects = await window.archicode.listRecentProjects();
      if (!rootPath) {
        set({
          rootPath: "",
          bundle: null,
          recentProjects,
          patchProposals: [],
          researchSessions: [],
          selectedResearchSessionId: null,
          researchBusySessionIds: [],
          researchQueuedMessages: {},
          researchBusy: false,
          gitStatus: null,
          fileBrowser: null,
          selectedFilePath: null,
          filePreviewRequest: null,
          filePreview: null,
          fileDiff: null,
          activeFlowId: null,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          selectedRunId: null,
          activeSubflowId: null,
          canvasViewport: null,
          canvasViewportCenter: null,
          loading: false
        });
        return;
      }
      const bundle = await window.archicode.loadProject(rootPath);
      const gitAttributesNotice = await offerGitAttributesSetup(rootPath);
      const patchProposals = await window.archicode.listPatchProposals(rootPath);
      const researchSessions = await window.archicode.listResearchChats(rootPath);
      const runtimeServices = await window.archicode.listRuntimeServices(rootPath);
      const { fileBrowser, gitStatus } = await readProjectFileBrowserState(rootPath);
      const projectSkills = await window.archicode.listProjectSkills(rootPath);
      const mcpServers = await window.archicode.listMcpServers(rootPath);
      const graphLocation = readStoredGraphLocation(rootPath, bundle);
      set((state) => ({
        rootPath,
        bundle,
        recentProjects,
        patchProposals,
        runtimeServices,
        researchSessions,
        // Keep the selected chat only if it belongs to this project's sessions.
        selectedResearchSessionId: selectedResearchSessionOrFallback(state.selectedResearchSessionId, researchSessions),
        researchBusySessionIds: [],
        researchQueuedMessages: {},
        researchBusy: false,
        projectSkills,
        mcpServers,
        gitStatus,
        fileBrowser,
        activeFlowId: graphLocation.activeFlowId,
        activeSubflowId: graphLocation.activeSubflowId,
        selectedNodeId: null,
        selectedNodeIds: [],
        workbenchView: readStoredWorkbenchView(rootPath),
        canvasViewport: readStoredViewport(rootPath, graphLocation.activeFlowId, graphLocation.activeSubflowId),
        canvasViewportCenter: null,
        appNotice: gitAttributesNotice,
        loading: false
      }));
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  reload: async () => {
    const { rootPath, historicalInspection } = get();
    if (historicalInspection) return;
    if (!window.archicode) {
      set((state) => ({ bundle: state.bundle ?? createFallbackBundle(), error: null }));
      return;
    }
    if (!rootPath) return get().load();
    const bundle = await window.archicode.loadProject(rootPath);
    const gitAttributesNotice = await offerGitAttributesSetup(rootPath);
    const recentProjects = await window.archicode.listRecentProjects();
    const patchProposals = await window.archicode.listPatchProposals(rootPath);
    const researchSessions = await window.archicode.listResearchChats(rootPath);
    const runtimeServices = await window.archicode.listRuntimeServices(rootPath);
    const { fileBrowser, gitStatus } = await readProjectFileBrowserState(rootPath);
    const projectSkills = await window.archicode.listProjectSkills(rootPath);
    const mcpServers = await window.archicode.listMcpServers(rootPath);
    const current = get();
    const graphLocation = current.activeFlowId
      ? resolveGraphLocation(bundle, current.activeFlowId, current.activeSubflowId)
      : readStoredGraphLocation(rootPath, bundle);
    const { activeFlowId, activeSubflowId } = graphLocation;
    set({
      bundle,
      recentProjects,
      patchProposals,
      researchSessions,
      researchBusySessionIds: [],
      researchQueuedMessages: {},
      researchBusy: false,
      runtimeServices,
      projectSkills,
      mcpServers,
      gitStatus,
      fileBrowser,
      activeFlowId,
      activeSubflowId,
      workbenchView: readStoredWorkbenchView(rootPath),
      canvasViewport: readStoredViewport(rootPath, activeFlowId, activeSubflowId),
      canvasViewportCenter: null,
      appNotice: gitAttributesNotice,
      presentationUndoStack: [],
      presentationRedoStack: [],
      error: null
    });
  },

  openProjectFolder: async () => {
    if (!window.archicode) {
      set({ error: "Project folder picking is available in the Electron app. Browser preview stays in memory." });
      return;
    }
    const result = await window.archicode.openProjectFolder();
    if (!result) return;
    const { bundle } = result;
    const gitAttributesNotice = await offerGitAttributesSetup(bundle.rootPath);
    const recentProjects = await window.archicode.listRecentProjects();
    const researchSessions = await window.archicode.listResearchChats(bundle.rootPath);
    const { fileBrowser, gitStatus } = await readProjectFileBrowserState(bundle.rootPath);
    const graphLocation = readStoredGraphLocation(bundle.rootPath, bundle);
    set({
      ...projectScopedResetState(),
      rootPath: bundle.rootPath,
      bundle,
      recentProjects,
      patchProposals: await window.archicode.listPatchProposals(bundle.rootPath),
      researchSessions,
      // Drop a chat selection carried over from a previously open project.
      selectedResearchSessionId: selectedResearchSessionOrFallback(null, researchSessions),
      researchBusySessionIds: [],
      researchQueuedMessages: {},
      researchBusy: false,
      // Refresh project-scoped lists so the previous project's data does not leak.
      runtimeServices: await window.archicode.listRuntimeServices(bundle.rootPath),
      projectSkills: await window.archicode.listProjectSkills(bundle.rootPath),
      mcpServers: await window.archicode.listMcpServers(bundle.rootPath),
      gitStatus,
      fileBrowser,
      selectedFilePath: null,
      filePreviewRequest: null,
      filePreview: null,
      fileDiff: null,
      activeFlowId: graphLocation.activeFlowId,
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedEdgeId: null,
      selectedRunId: null,
      activeSubflowId: graphLocation.activeSubflowId,
      canvasViewport: result.initializedMetadata ? null : readStoredViewport(bundle.rootPath, graphLocation.activeFlowId, graphLocation.activeSubflowId),
      canvasViewportCenter: null,
      codebaseOnboarding: result.initializedMetadata
        ? { rootPath: bundle.rootPath, codebaseHints: result.codebaseHints, mapping: null }
        : null,
      appNotice: gitAttributesNotice,
      error: null
    });
  },

  cloneGitRepository: async (remoteUrl) => {
    if (!window.archicode?.cloneGitRepository) {
      set({ error: "Git URL importing is available in the Electron app." });
      return false;
    }
    try {
      const result = await window.archicode.cloneGitRepository(remoteUrl);
      if (!result) return false;
      const { bundle } = result;
      const gitAttributesNotice = await offerGitAttributesSetup(bundle.rootPath);
      const recentProjects = await window.archicode.listRecentProjects();
      const researchSessions = await window.archicode.listResearchChats(bundle.rootPath);
      const { fileBrowser, gitStatus } = await readProjectFileBrowserState(bundle.rootPath);
      const graphLocation = readStoredGraphLocation(bundle.rootPath, bundle);
      set({
        ...projectScopedResetState(),
        rootPath: bundle.rootPath,
        bundle,
        recentProjects,
        patchProposals: await window.archicode.listPatchProposals(bundle.rootPath),
        researchSessions,
        selectedResearchSessionId: selectedResearchSessionOrFallback(null, researchSessions),
        researchBusySessionIds: [],
        researchQueuedMessages: {},
        researchBusy: false,
        runtimeServices: await window.archicode.listRuntimeServices(bundle.rootPath),
        projectSkills: await window.archicode.listProjectSkills(bundle.rootPath),
        mcpServers: await window.archicode.listMcpServers(bundle.rootPath),
        gitStatus,
        fileBrowser,
        activeFlowId: graphLocation.activeFlowId,
        activeSubflowId: graphLocation.activeSubflowId,
        canvasViewport: null,
        canvasViewportCenter: null,
        codebaseOnboarding: result.initializedMetadata
          ? { rootPath: bundle.rootPath, codebaseHints: result.codebaseHints, mapping: null }
          : null,
        appNotice: gitAttributesNotice,
        error: null
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw new Error(message);
    }
  },

  openRecentProject: async (projectRoot) => {
    if (!window.archicode?.openRecentProject) {
      set({ error: "Recent project opening is available in the Electron app." });
      return;
    }
    try {
      const result = await window.archicode.openRecentProject(projectRoot);
      const { bundle } = result;
      const gitAttributesNotice = await offerGitAttributesSetup(bundle.rootPath);
      const recentProjects = await window.archicode.listRecentProjects();
      const researchSessions = await window.archicode.listResearchChats(bundle.rootPath);
      const { fileBrowser, gitStatus } = await readProjectFileBrowserState(bundle.rootPath);
      const graphLocation = readStoredGraphLocation(bundle.rootPath, bundle);
      set({
        ...projectScopedResetState(),
        rootPath: bundle.rootPath,
        bundle,
        recentProjects,
        patchProposals: await window.archicode.listPatchProposals(bundle.rootPath),
        researchSessions,
        // Drop a chat selection carried over from a previously open project.
        selectedResearchSessionId: selectedResearchSessionOrFallback(null, researchSessions),
        researchBusySessionIds: [],
        researchQueuedMessages: {},
        researchBusy: false,
        // Refresh project-scoped lists so the previous project's data does not leak.
        runtimeServices: await window.archicode.listRuntimeServices(bundle.rootPath),
        projectSkills: await window.archicode.listProjectSkills(bundle.rootPath),
        mcpServers: await window.archicode.listMcpServers(bundle.rootPath),
        gitStatus,
        fileBrowser,
        selectedFilePath: null,
        filePreviewRequest: null,
        filePreview: null,
        fileDiff: null,
        activeFlowId: graphLocation.activeFlowId,
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedEdgeId: null,
        selectedRunId: null,
        activeSubflowId: graphLocation.activeSubflowId,
        canvasViewport: result.initializedMetadata ? null : readStoredViewport(bundle.rootPath, graphLocation.activeFlowId, graphLocation.activeSubflowId),
        canvasViewportCenter: null,
        codebaseOnboarding: result.initializedMetadata
          ? { rootPath: bundle.rootPath, codebaseHints: result.codebaseHints, mapping: null }
          : null,
        appNotice: gitAttributesNotice,
        error: null
      });
    } catch (error) {
      const recentProjects = window.archicode?.listRecentProjects ? await window.archicode.listRecentProjects() : get().recentProjects;
      set({
        recentProjects,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  revealProjectFolder: async () => {
    const { rootPath } = get();
    if (!rootPath) return;
    if (!window.archicode?.revealProjectFolder) {
      set({ error: "Opening the project folder is available in the Electron app." });
      return;
    }
    try {
      await window.archicode.revealProjectFolder(rootPath);
      set({ error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  openProjectInVsCode: async () => {
    const { rootPath } = get();
    if (!rootPath) return;
    if (!window.archicode?.openProjectInVsCode) {
      set({ error: "Opening the project in Visual Studio Code is available in the Electron app." });
      return;
    }
    try {
      await window.archicode.openProjectInVsCode(rootPath);
      set({ error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  createProjectFromTemplate: async (templateId) => {
    if (!window.archicode) {
      set({ error: "Project templates are available in the Electron app." });
      return;
    }
    try {
      const bundle = await window.archicode.createProject(templateId);
      if (!bundle) return;
      const recentProjects = await window.archicode.listRecentProjects();
      const researchSessions = await window.archicode.listResearchChats(bundle.rootPath);
      const { fileBrowser, gitStatus } = await readProjectFileBrowserState(bundle.rootPath);
      set({
        ...projectScopedResetState(),
        rootPath: bundle.rootPath,
        bundle,
        recentProjects,
        patchProposals: await window.archicode.listPatchProposals(bundle.rootPath),
        researchSessions,
        // Drop a chat selection carried over from a previously open project.
        selectedResearchSessionId: selectedResearchSessionOrFallback(null, researchSessions),
        researchBusySessionIds: [],
        researchQueuedMessages: {},
        researchBusy: false,
        // Refresh project-scoped lists so the previous project's data does not leak.
        runtimeServices: await window.archicode.listRuntimeServices(bundle.rootPath),
        projectSkills: await window.archicode.listProjectSkills(bundle.rootPath),
        mcpServers: await window.archicode.listMcpServers(bundle.rootPath),
        gitStatus,
        fileBrowser,
        selectedFilePath: null,
        filePreviewRequest: null,
        filePreview: null,
        fileDiff: null,
        activeFlowId: bundle.project.activeFlowId,
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedEdgeId: null,
        selectedRunId: null,
        activeSubflowId: null,
        canvasViewport: null,
        canvasViewportCenter: null,
        codebaseOnboarding: null,
        error: null
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  handleExternalProjectUpdated: (payload) => {
    const current = get();
    if (current.historicalInspection || !current.bundle || payload.projectRoot !== current.rootPath || !window.archicode) return;
    void (async () => {
      const [bundle, patchProposals] = await Promise.all([
        window.archicode.loadProject(payload.projectRoot),
        window.archicode.listPatchProposals(payload.projectRoot)
      ]);
      set((state) => {
        if (state.rootPath !== payload.projectRoot || !state.bundle) return state;
        const activeFlowId = bundle.flows.some((flow) => flow.id === state.activeFlowId)
          ? state.activeFlowId
          : bundle.project.activeFlowId;
        const activeFlow = bundle.flows.find((flow) => flow.id === activeFlowId) ?? bundle.flows[0] ?? null;
        const selectedNodeIds = state.selectedNodeIds.filter((nodeId) =>
          activeFlow?.nodes.some((node) => node.id === nodeId)
        );
        const selectedNodeId = state.selectedNodeId && selectedNodeIds.includes(state.selectedNodeId)
          ? state.selectedNodeId
          : selectedNodeIds[selectedNodeIds.length - 1] ?? null;
        const selectedEdgeId = state.selectedEdgeId && activeFlow?.edges.some((edge) => edge.id === state.selectedEdgeId)
          ? state.selectedEdgeId
          : null;
        const activeSubflowId = state.activeSubflowId && activeFlow?.subflows.some((subflow) => subflow.id === state.activeSubflowId)
          ? state.activeSubflowId
          : null;
        return {
          bundle,
          patchProposals,
          activeFlowId,
          activeSubflowId,
          selectedNodeId,
          selectedNodeIds,
          selectedEdgeId,
          presentationUndoStack: [],
          presentationRedoStack: [],
          error: null
        };
      });
    })().catch((error: unknown) => {
      set((state) => state.rootPath === payload.projectRoot
        ? { error: error instanceof Error ? error.message : String(error) }
        : state);
    });
  },
  setShellPrompt: (shellPrompt) => set({ shellPrompt }),
  dismissCodebaseOnboarding: () => set({ codebaseOnboarding: null }),
  openInitialCodebaseImportReport: async () => {
    const rootPath = get().rootPath;
    if (!window.archicode?.getInitialCodebaseImportReport || !rootPath) return;
    const report = await window.archicode.getInitialCodebaseImportReport(rootPath);
    if (!report) {
      set({ appNotice: { tone: "warning", title: "No saved initial import report", message: "This project does not have a saved report from its initial codebase import." } });
      return;
    }
    set({
      codebaseOnboarding: {
        rootPath,
        codebaseHints: [],
        mapping: {
          status: "Import complete",
          startedAtMs: new Date(report.completedAt).getTime() - report.durationMs,
          completedAtMs: new Date(report.completedAt).getTime(),
          result: report,
          step: 10,
          totalSteps: 10,
          error: null
        }
      }
    });
  },
  openProjectSettings: (tab = "general") => set({ projectSettingsRequest: { tab, nonce: Date.now() } }),
  clearProjectSettingsRequest: (nonce) => set((state) =>
    state.projectSettingsRequest?.nonce === nonce ? { projectSettingsRequest: null } : state
  ),

  startCodebaseOnboardingRun: async ({ levels, detail, reviewEffort, granularity }) => {
    const onboarding = get().codebaseOnboarding;
    const bundle = get().bundle;
    if (!onboarding || !bundle) return;
    if (!window.archicode) {
      set({ error: "Codebase mapping is available in the Electron app." });
      return;
    }
    const providerId = bundle.project.settings.providers.find((provider) => provider.enabled)?.id;
    const disposeProgress = window.archicode.onCodebaseMappingProgress?.((progress) => {
      if (progress.projectRoot !== onboarding.rootPath) return;
      set((state) => ({
        codebaseOnboarding: state.codebaseOnboarding
          ? {
              ...state.codebaseOnboarding,
              mapping: {
                status: progress.label,
                startedAtMs: state.codebaseOnboarding.mapping?.startedAtMs ?? Date.now(),
                detail: progress.detail,
                step: progress.step,
                totalSteps: progress.totalSteps,
                itemsDone: progress.itemsDone,
                itemsTotal: progress.itemsTotal,
                error: null
              }
            }
          : state.codebaseOnboarding
      }));
    });
    set((state) => ({
      codebaseOnboarding: state.codebaseOnboarding
        ? { ...state.codebaseOnboarding, mapping: { status: "Starting codebase import", startedAtMs: Date.now(), detail: "Preparing the selected provider and project folder.", step: 0, totalSteps: 10, error: null } }
        : state.codebaseOnboarding,
      error: null
    }));
    try {
      const result = await window.archicode.mapExistingCodebase({
        projectRoot: onboarding.rootPath,
        providerId,
        levels,
        detail,
        reviewEffort,
        granularity,
        codebaseHints: onboarding.codebaseHints
      });
      notifyJobFinished(bundle, "Codebase map completed", result.message);
      set((state) => ({
        bundle: result.bundle,
        activeFlowId: result.bundle.project.activeFlowId,
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedEdgeId: null,
        activeSubflowId: null,
        canvasViewport: null,
        canvasViewportCenter: null,
        codebaseOnboarding: state.codebaseOnboarding
          ? {
              ...state.codebaseOnboarding,
              mapping: {
                ...(state.codebaseOnboarding.mapping ?? { status: "Import complete", error: null }),
                status: result.summary.status === "complete" ? "Import complete" : "Import completed with issues",
                detail: result.message,
                completedAtMs: Date.now(),
                result: result.summary,
                step: 10,
                totalSteps: 10,
                error: null
              }
            }
          : state.codebaseOnboarding,
        error: null
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Codebase import was cancelled")) {
        set((state) => ({
          codebaseOnboarding: state.codebaseOnboarding
            ? { ...state.codebaseOnboarding, mapping: null }
            : state.codebaseOnboarding,
          error: null
        }));
        return;
      }
      notifyJobFinished(bundle, "Codebase map failed", message);
      set((state) => ({
        codebaseOnboarding: state.codebaseOnboarding
          ? {
              ...state.codebaseOnboarding,
              mapping: {
                ...(state.codebaseOnboarding.mapping ?? { startedAtMs: Date.now() }),
                status: "Mapping failed.",
                completedAtMs: Date.now(),
                error: message
              }
            }
          : state.codebaseOnboarding,
        error: message
      }));
    } finally {
      disposeProgress?.();
    }
  },

  cancelCodebaseOnboardingRun: async () => {
    const onboarding = get().codebaseOnboarding;
    if (!onboarding || !window.archicode?.cancelCodebaseMapping) return;
    set((state) => ({
      codebaseOnboarding: state.codebaseOnboarding?.mapping
        ? {
            ...state.codebaseOnboarding,
            mapping: { ...state.codebaseOnboarding.mapping, status: "Cancelling import…", detail: "Stopping after the current step. Semantic indexing progress is kept for next time." }
          }
        : state.codebaseOnboarding
    }));
    await window.archicode.cancelCodebaseMapping(onboarding.rootPath);
  },

  importFlow: async () => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Flow import is available in the Electron app." });
      return;
    }
    const bundle = await window.archicode.importFlow(rootPath);
    if (!bundle) return;
    set({ bundle, activeFlowId: bundle.project.activeFlowId, activeSubflowId: null, selectedNodeId: null, selectedNodeIds: [], selectedEdgeId: null, presentationUndoStack: [], presentationRedoStack: [], error: null });
  },

  importDrawioFlow: async (mode) => {
    const { rootPath, activeFlowId, activeSubflowId } = get();
    if (!window.archicode || !activeFlowId) {
      set({ error: "draw.io import is available in the Electron app." });
      return;
    }
    const bundle = await window.archicode.importDrawioFlow(rootPath, {
      flowId: activeFlowId,
      subflowId: activeSubflowId,
      mode
    });
    if (!bundle) return;
    const nextFlow = bundle.flows.find((flow) => flow.id === activeFlowId) ?? bundle.flows[0];
    set({
      bundle,
      activeFlowId: nextFlow?.id ?? bundle.project.activeFlowId,
      activeSubflowId,
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedEdgeId: null,
      presentationUndoStack: [],
      presentationRedoStack: [],
      error: null
    });
  },

  exportActiveFlow: async () => {
    const { rootPath, activeFlowId } = get();
    if (!window.archicode || !activeFlowId) {
      set({ error: "Flow export is available in the Electron app." });
      return;
    }
    await window.archicode.exportFlow(rootPath, activeFlowId);
  },

  exportActiveDrawioFlow: async () => {
    const { rootPath, activeFlowId, activeSubflowId } = get();
    if (!window.archicode || !activeFlowId) {
      set({ error: "draw.io export is available in the Electron app." });
      return;
    }
    await window.archicode.exportDrawioFlow(rootPath, activeFlowId, activeSubflowId);
  },

  exportProjectBundle: async () => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Project export is available in the Electron app." });
      return;
    }
    await window.archicode.exportProjectBundle(rootPath);
  },

  exportProjectDocument: async (flowIds, format) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Project document export is available in the Electron app." });
      return false;
    }
    try {
      const exported = await window.archicode.exportProjectDocument(rootPath, flowIds, format);
      set({ error: null });
      return exported;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : `Unable to export project ${format.toUpperCase()}.` });
      return false;
    }
  },

  repairProject: async () => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Project repair is available in the Electron app." });
      return;
    }
    const bundle = await window.archicode.repairProject(rootPath);
    set({ bundle, activeFlowId: bundle.project.activeFlowId, activeSubflowId: null, selectedNodeId: null, selectedNodeIds: [], selectedEdgeId: null, error: null });
  },

  deleteProjectState: async () => {
    const { rootPath } = get();
    if (!rootPath) return false;
    const confirmed = window.confirm(
      `Remove this project from ArchiCode?\n\nArchiCode will forget the project map, nodes and flows, notes, run records, chat history, and ArchiCode settings saved for this folder.\n\nYour source code and regular project files will stay untouched. If you open this folder in ArchiCode again, you'll need to import it again so ArchiCode can rebuild the project map.`
    );
    if (!confirmed) return false;
    if (!window.archicode?.deleteProjectState) {
      set({ rootPath: "", bundle: null, activeFlowId: null, selectedNodeId: null, selectedNodeIds: [], selectedEdgeId: null, canvasViewport: null, canvasViewportCenter: null, error: null });
      return true;
    }
    await window.archicode.deleteProjectState(rootPath);
    set({
      rootPath: "",
      bundle: null,
      activeFlowId: null,
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedEdgeId: null,
      selectedRunId: null,
      activeSubflowId: null,
      searchQuery: "",
      canvasViewport: null,
      canvasViewportCenter: null,
      patchProposals: [],
      providerHealth: {},
      gitStatus: null,
      fileBrowser: null,
      selectedFilePath: null,
      filePreviewRequest: null,
      filePreview: null,
      fileDiff: null,
      error: null
    });
    return true;
  },

  updateSettings: async (settings) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set((state) => ({
        bundle: state.bundle ? { ...state.bundle, project: { ...state.bundle.project, settings } } : createFallbackBundle(rootPath),
        error: null
      }));
      return;
    }
    const bundle = await window.archicode.updateProjectSettings(rootPath, settings);
    set({ bundle, error: null });
  },

  updateProjectDetails: async (patch) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set((state) => ({
        bundle: state.bundle ? { ...state.bundle, project: { ...state.bundle.project, ...patch } } : createFallbackBundle(rootPath),
        error: null
      }));
      return;
    }
    const bundle = await window.archicode.updateProjectDetails(rootPath, patch);
    set({ bundle, error: null });
  },

});
