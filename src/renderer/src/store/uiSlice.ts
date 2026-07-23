import { create } from "zustand";
import type {
  ArchicodeNode,
  Artifact,
  CodeIdeSettings,
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

export const createUiSlice = (set: StoreSet, get: StoreGet): Pick<ArchicodeState, "showDirectUndoNotice" | "dismissAppNotice" | "setTheme" | "toggleTheme" | "setUiScale" | "loadKeybindings" | "setKeybinding" | "resetKeybinding" | "resetAllKeybindings" | "loadGlobalSpeechSettings" | "updateGlobalSpeechSettings" | "loadGlobalTtsSettings" | "updateGlobalTtsSettings" | "loadGlobalVoiceSettings" | "updateGlobalVoiceSettings" | "loadGlobalCodeIdeSettings" | "updateGlobalCodeIdeSettings"> => ({
  showDirectUndoNotice: () => set((state) => state.appNotice?.message === directUndoNotice.message ? state : { appNotice: directUndoNotice }),

  dismissAppNotice: () => set({ appNotice: null }),

  setTheme: (theme) => {
    localStorage.setItem("archicode-theme", theme);
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },

  toggleTheme: () => {
    const next = get().theme === "light" ? "dark" : "light";
    get().setTheme(next);
  },

  setUiScale: (uiScale) => {
    localStorage.setItem("archicode-ui-scale", String(uiScale));
    set({ uiScale });
  },

  loadKeybindings: async () => {
    if (!window.archicode?.getKeybindings || !window.archicode?.saveKeybindings) {
      set({ keybindingsLoaded: true });
      return;
    }
    try {
      set({ keybindingsBusy: true });
      const stored = await window.archicode.getKeybindings();
      const { bindings } = sanitizeStoredBindings(stored);
      await window.archicode.saveKeybindings(bindings as unknown as Record<string, { key: string; cmd?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }>);
      set({ keybindings: bindings, keybindingsLoaded: true });
    } catch (error) {
      console.error("Failed to load keybindings.", error);
      set({ keybindings: { ...DEFAULT_BINDINGS }, keybindingsLoaded: true });
    } finally {
      set({ keybindingsBusy: false });
    }
  },

  setKeybinding: async (id, chord) => {
    if (isReservedAction(id)) return;
    try {
      set({ keybindingsBusy: true });
      const next = { ...get().keybindings, [id]: chord };
      if (window.archicode?.saveKeybindings) {
        await window.archicode.saveKeybindings(next as unknown as Record<string, { key: string; cmd?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }>);
      }
      set({ keybindings: next });
    } catch (error) {
      console.error("Failed to save keybindings.", error);
      set({ keybindings: { ...DEFAULT_BINDINGS, [id]: chord }, keybindingsBusy: false });
    } finally {
      set({ keybindingsBusy: false });
    }
  },

  resetKeybinding: async (id) => {
    if (isReservedAction(id)) return;
    await get().setKeybinding(id, DEFAULT_BINDINGS[id]);
  },

  resetAllKeybindings: async () => {
    try {
      set({ keybindingsBusy: true });
      const next = { ...DEFAULT_BINDINGS };
      if (window.archicode?.saveKeybindings) {
        await window.archicode.saveKeybindings(next as unknown as Record<string, { key: string; cmd?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }>);
      }
      set({ keybindings: next });
    } catch (error) {
      console.error("Failed to reset keybindings.", error);
      set({ keybindings: { ...DEFAULT_BINDINGS }, keybindingsBusy: false });
    } finally {
      set({ keybindingsBusy: false });
    }
  },

  loadGlobalSpeechSettings: async () => {
    if (!window.archicode?.getGlobalSpeechSettings) return;
    try {
      const settings = await window.archicode.getGlobalSpeechSettings();
      set({ globalSpeechSettings: settings });
    } catch (error) {
      console.error("Failed to load speech settings.", error);
    }
  },

  updateGlobalSpeechSettings: async (settings) => {
    set({ globalSpeechSettings: settings });
    if (!window.archicode?.saveGlobalSpeechSettings) return;
    try {
      const saved = await window.archicode.saveGlobalSpeechSettings(settings);
      set({ globalSpeechSettings: saved });
    } catch (error) {
      console.error("Failed to save speech settings.", error);
    }
  },

  loadGlobalTtsSettings: async () => {
    if (!window.archicode?.getGlobalTtsSettings) return;
    try {
      const settings = await window.archicode.getGlobalTtsSettings();
      set({ globalTtsSettings: settings });
    } catch (error) {
      console.error("Failed to load TTS settings.", error);
    }
  },

  updateGlobalTtsSettings: async (settings) => {
    set({ globalTtsSettings: settings });
    if (!window.archicode?.saveGlobalTtsSettings) return;
    try {
      const saved = await window.archicode.saveGlobalTtsSettings(settings);
      set({ globalTtsSettings: saved });
    } catch (error) {
      console.error("Failed to save TTS settings.", error);
    }
  },

  loadGlobalVoiceSettings: async () => {
    if (!window.archicode?.getGlobalVoiceSettings) return;
    try {
      const settings = await window.archicode.getGlobalVoiceSettings();
      set({ globalVoiceSettings: settings });
    } catch (error) {
      console.error("Failed to load voice settings.", error);
    }
  },

  updateGlobalVoiceSettings: async (settings) => {
    set({ globalVoiceSettings: settings });
    if (!window.archicode?.saveGlobalVoiceSettings) return;
    try {
      const saved = await window.archicode.saveGlobalVoiceSettings(settings);
      set({ globalVoiceSettings: saved });
    } catch (error) {
      console.error("Failed to save voice settings.", error);
    }
  },

  loadGlobalCodeIdeSettings: async () => {
    if (!window.archicode?.getGlobalCodeIdeSettings) return;
    try {
      const settings = await window.archicode.getGlobalCodeIdeSettings();
      set({ globalCodeIdeSettings: settings });
    } catch (error) {
      console.error("Failed to load code IDE settings.", error);
    }
  },

  updateGlobalCodeIdeSettings: async (settings) => {
    set({ globalCodeIdeSettings: settings });
    if (!window.archicode?.saveGlobalCodeIdeSettings) return;
    try {
      const saved = await window.archicode.saveGlobalCodeIdeSettings(settings);
      set({ globalCodeIdeSettings: saved });
    } catch (error) {
      console.error("Failed to save code IDE settings.", error);
    }
  }
});
