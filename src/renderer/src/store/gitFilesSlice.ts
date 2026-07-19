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
import { uid, uniqueNodeIds, selectedNodeIdsFor, appendEdgeLabelHistory, directUndoNotice, offerGitAttributesSetup, now, runInputKey, runProfileKey, isSameRunRequest, isSameRunProfileRequest, runArtifactIds, runHasQuestionRefreshSignal, shouldRefreshQuestionsForRun, hasActiveRun, editingLockedMessage, notifyJobFinished, notifyReviewRequired, createOptimisticRun, createOptimisticRunProfile, defaultNodeHalfSize, getInitialTheme, getInitialUiScale, projectUiKey, projectScopedUiKey, readStoredWorkbenchView, readProjectFileBrowserState, isFiniteNumber, readStoredViewport, isVisualQaPreview, createFallbackBundle, projectScopedResetState, clearProjectStateForBranchChange, reloadProjectStateAfterBranchChange, isBuildLikeAgentRun, getActiveFlow, getSelectedNode, getSelectedEdge, defaultResearchScope, normalizeComposerSegments, addResearchBusySession, removeResearchBusySession, selectedResearchSessionOrFallback, nextGraphNavigationRequestId, nextFilePreviewRequestId } from "./helpers";

export const createGitFilesSlice = (set: StoreSet, get: StoreGet): Pick<ArchicodeState, "setWorkbenchView" | "refreshGitStatus" | "initializeGitRepository" | "runGitOperation" | "discardGitChanges" | "stashGitChanges" | "popGitStash" | "commitGitFiles" | "generateCommitMessage" | "switchGitBranch" | "createGitBranch" | "refreshProjectFiles" | "selectProjectFile"> => ({
  setWorkbenchView: (workbenchView) => {
    const { rootPath } = get();
    if (rootPath) localStorage.setItem(projectUiKey(rootPath, "workbench"), workbenchView);
    set({ workbenchView });
    if (workbenchView === "files" && !get().fileBrowser) void get().refreshProjectFiles();
  },

  refreshGitStatus: async () => {
    const { rootPath } = get();
    if (!rootPath) return;
    if (!window.archicode) {
      set({
        gitStatus: {
          isRepo: false,
          ahead: 0,
          behind: 0,
          branches: [],
          changes: [],
          recentCommits: [],
          stashes: [],
          message: "Git is available in the Electron app."
        }
      });
      return;
    }
    try {
      const gitStatus = await window.archicode.getGitStatus(rootPath);
      set({ gitStatus, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  initializeGitRepository: async () => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode?.gitInit) {
      set({ error: "Restart ArchiCode to load local Git initialization in this app window, or run git init in your terminal." });
      return;
    }
    set({ gitBusy: true, error: null });
    try {
      const result = await window.archicode.gitInit(rootPath);
      set((state) => ({ gitLogs: [result, ...state.gitLogs].slice(0, 20), error: result.ok ? null : result.stderr || result.stdout }));
      await get().refreshProjectFiles();
      await get().refreshGitStatus();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ gitBusy: false });
    }
  },

  runGitOperation: async (operation) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode) {
      set({ error: "Git operations are available in the Electron app." });
      return;
    }
    set({ gitBusy: true, error: null });
    try {
      const result = operation === "pull"
        ? await window.archicode.gitPull(rootPath)
        : await window.archicode.gitPush(rootPath);
      const gitLogs = [result, ...get().gitLogs].slice(0, 20);
      set({ gitLogs, error: result.ok ? null : result.stderr || result.stdout });
      if (operation === "pull" && result.ok) {
        const projectReloadNonce = get().projectReloadNonce + 1;
        set(clearProjectStateForBranchChange(rootPath, gitLogs, projectReloadNonce));
        set(await reloadProjectStateAfterBranchChange(rootPath, gitLogs, projectReloadNonce));
      } else {
        await get().refreshProjectFiles();
        await get().refreshGitStatus();
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ gitBusy: false });
    }
  },

  discardGitChanges: async () => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode?.gitDiscardChanges) {
      set({ error: "Git discard is available in the Electron app." });
      return;
    }
    set({ gitBusy: true, error: null });
    try {
      const result = await window.archicode.gitDiscardChanges(rootPath);
      set((state) => ({ gitLogs: [result, ...state.gitLogs].slice(0, 20), error: result.ok ? null : result.stderr || result.stdout }));
      await get().refreshProjectFiles();
      await get().refreshGitStatus();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ gitBusy: false });
    }
  },

  stashGitChanges: async (message) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode?.gitStashChanges) {
      set({ error: "Restart ArchiCode to load Git stash support in this app window." });
      return false;
    }
    set({ gitBusy: true, error: null });
    try {
      const result = await window.archicode.gitStashChanges(rootPath, message);
      set((state) => ({ gitLogs: [result, ...state.gitLogs].slice(0, 20), error: result.ok ? null : result.stderr || result.stdout }));
      await get().refreshProjectFiles();
      await get().refreshGitStatus();
      return result.ok;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ gitBusy: false });
    }
  },

  popGitStash: async (stashRef) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode?.gitPopStash) {
      set({ error: "Restart ArchiCode to load Git stash pop support in this app window." });
      return;
    }
    set({ gitBusy: true, error: null });
    try {
      const result = await window.archicode.gitPopStash(rootPath, stashRef);
      const gitLogs = [result, ...get().gitLogs].slice(0, 20);
      set({ gitLogs, error: result.ok ? null : result.stderr || result.stdout });
      if (result.ok) {
        const projectReloadNonce = get().projectReloadNonce + 1;
        set(clearProjectStateForBranchChange(rootPath, gitLogs, projectReloadNonce));
        set(await reloadProjectStateAfterBranchChange(rootPath, gitLogs, projectReloadNonce));
      } else {
        await get().refreshProjectFiles();
        await get().refreshGitStatus();
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ gitBusy: false });
    }
  },

  commitGitFiles: async (message, files) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode) {
      set({ error: "Git commits are available in the Electron app." });
      return;
    }
    set({ gitBusy: true, error: null });
    try {
      const result = await window.archicode.gitCommit(rootPath, message, files);
      set((state) => ({ gitLogs: [result, ...state.gitLogs].slice(0, 20), error: result.ok ? null : result.stderr || result.stdout }));
      await get().refreshProjectFiles();
      await get().refreshGitStatus();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ gitBusy: false });
    }
  },

  generateCommitMessage: async (files) => {
    const { rootPath, bundle } = get();
    if (!rootPath || !window.archicode?.generateGitCommitMessage) return null;
    const providerId = bundle?.project.settings.providers.find((provider) => provider.enabled)?.id;
    try {
      const message = await window.archicode.generateGitCommitMessage(rootPath, files, providerId);
      set({ error: null });
      return message;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  switchGitBranch: async (branch) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode) {
      set({ error: "Git branch switching is available in the Electron app." });
      return;
    }
    set({ gitBusy: true, error: null });
    try {
      const result = await window.archicode.gitSwitchBranch(rootPath, branch);
      const gitLogs = [result, ...get().gitLogs].slice(0, 20);
      set({ gitLogs, error: result.ok ? null : result.stderr || result.stdout });
      if (result.ok) {
        const projectReloadNonce = get().projectReloadNonce + 1;
        set(clearProjectStateForBranchChange(rootPath, gitLogs, projectReloadNonce));
        set(await reloadProjectStateAfterBranchChange(rootPath, gitLogs, projectReloadNonce));
      } else {
        await get().refreshProjectFiles();
        await get().refreshGitStatus();
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ gitBusy: false });
    }
  },

  createGitBranch: async (branch) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode?.gitCreateBranch) {
      set({ error: "Git branch creation is available in the Electron app." });
      return;
    }
    set({ gitBusy: true, error: null });
    try {
      const result = await window.archicode.gitCreateBranch(rootPath, branch);
      const gitLogs = [result, ...get().gitLogs].slice(0, 20);
      set({ gitLogs, error: result.ok ? null : result.stderr || result.stdout });
      if (result.ok) {
        const projectReloadNonce = get().projectReloadNonce + 1;
        set(clearProjectStateForBranchChange(rootPath, gitLogs, projectReloadNonce));
        set(await reloadProjectStateAfterBranchChange(rootPath, gitLogs, projectReloadNonce));
      } else {
        await get().refreshProjectFiles();
        await get().refreshGitStatus();
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ gitBusy: false });
    }
  },

  refreshProjectFiles: async () => {
    const { rootPath, historicalInspection } = get();
    if (!rootPath) return;
    if (!window.archicode) {
      set({ error: "File browsing is available in the Electron app." });
      return;
    }
    set({ fileBusy: true });
    try {
      const fileBrowser = historicalInspection && window.archicode.listHistoricalProjectFiles
        ? await window.archicode.listHistoricalProjectFiles(rootPath, historicalInspection.entry.commit)
        : await window.archicode.listProjectFiles(rootPath);
      set({ fileBrowser, gitStatus: historicalInspection ? get().gitStatus : fileBrowser.gitStatus, error: null });
      const selected = get().selectedFilePath;
      if (selected) await get().selectProjectFile(selected);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ fileBusy: false });
    }
  },

  selectProjectFile: async (selectedFilePath, options) => {
    const { rootPath, historicalInspection } = get();
    if (rootPath && !historicalInspection) {
      const storageKey = projectUiKey(rootPath, "last-file-preview");
      if (selectedFilePath) localStorage.setItem(storageKey, selectedFilePath);
      else localStorage.removeItem(storageKey);
    }
    const filePreviewRequest = selectedFilePath ? {
      requestId: nextFilePreviewRequestId(),
      path: selectedFilePath,
      preferredTab: options?.preferredTab,
      lineNumber: options?.lineNumber ?? null,
      matchText: options?.matchText?.trim() || null,
      searchQuery: options?.searchQuery?.trim() || null
    } : null;
    set({ selectedFilePath, filePreviewRequest, filePreview: null, fileDiff: null, ...(historicalInspection ? { workbenchView: "files" as const } : {}) });
    if (!selectedFilePath || !rootPath) return;
    if (!window.archicode) {
      set({ error: "File preview is available in the Electron app." });
      return;
    }
    set({ fileBusy: true });
    try {
      if (historicalInspection) {
        if (!window.archicode.readHistoricalProjectFile) throw new Error("Restart ArchiCode to inspect historical source files.");
        const filePreview = await window.archicode.readHistoricalProjectFile(rootPath, historicalInspection.entry.commit, selectedFilePath);
        set({ filePreview, fileDiff: { path: selectedFilePath, diff: "" }, error: null });
        return;
      }
      const fileDiff = await window.archicode.readProjectFileDiff(rootPath, selectedFilePath)
        .catch((): ProjectFileDiff => ({ path: selectedFilePath, diff: "" }));
      const filePreview = await window.archicode.readProjectFile(rootPath, selectedFilePath)
        .catch((): ProjectFileText | null => fileDiff.diff || options?.preferredTab === "diff" ? {
          path: selectedFilePath,
          content: "",
          size: 0,
          language: "text",
          truncated: false,
          binary: false
        } : null);
      if (!filePreview) throw new Error(`File not found: ${selectedFilePath}`);
      set({ filePreview, fileDiff, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ fileBusy: false });
    }
  },

});
