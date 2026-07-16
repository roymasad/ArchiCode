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

export const createNotesSlice = (set: StoreSet, get: StoreGet): Pick<ArchicodeState, "refreshPatchProposals" | "applyPatchProposal" | "addNote" | "updateNoteResolved" | "updateNotePinned" | "deleteNote" | "purgeResolvedNotes" | "purgeSystemNotes" | "attachNodeReferences" | "attachNodeReferenceFiles"> => ({
  refreshPatchProposals: async () => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ patchProposals: [], error: "Patch review is available in Electron with persisted project JSON." });
      return;
    }
    const patchProposals = await window.archicode.listPatchProposals(rootPath);
    set({ patchProposals, error: null });
  },

  applyPatchProposal: async (proposalArtifactId, decisions) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Patch application requires Electron project persistence." });
      return;
    }
    try {
      const bundle = await window.archicode.applyPatchProposal(rootPath, proposalArtifactId, decisions);
      const patchProposals = await window.archicode.listPatchProposals(rootPath);
      set({
        bundle,
        patchProposals,
        activeFlowId: bundle.project.activeFlowId,
        error: null
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  addNote: async (input) => {
    const { rootPath } = get();
    if (!window.archicode) {
      let nextBundle: ProjectBundle | undefined;
      set((state) => {
        if (!state.bundle) return state;
        const note: Note = {
          ...input,
          category: input.category ?? "note",
          priority: input.priority ?? "normal",
          attachmentIds: input.attachmentIds ?? [],
          pinned: input.pinned ?? false,
          id: uid("note"),
          createdAt: now()
        };
        nextBundle = { ...state.bundle, notes: [...state.bundle.notes, note] };
        return { bundle: nextBundle, error: null };
      });
      return nextBundle;
    }
    const bundle = await window.archicode.addNote(rootPath, input);
    set({ bundle, error: null });
    return bundle;
  },

  updateNoteResolved: async (noteId, resolved) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set((state) => ({
        bundle: state.bundle
          ? {
              ...state.bundle,
              notes: state.bundle.notes.map((note) => note.id === noteId ? { ...note, resolved } : note)
            }
          : createFallbackBundle(rootPath),
        error: null
      }));
      return;
    }
    const bundle = await window.archicode.updateNoteResolved(rootPath, noteId, resolved);
    set({ bundle, error: null });
  },

  updateNotePinned: async (noteId, pinned) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set((state) => ({
        bundle: state.bundle
          ? {
              ...state.bundle,
              notes: state.bundle.notes.map((note) => note.id === noteId ? { ...note, pinned } : note)
            }
          : createFallbackBundle(rootPath),
        error: null
      }));
      return;
    }
    const bundle = await window.archicode.updateNotePinned(rootPath, noteId, pinned);
    set({ bundle, error: null });
  },

  deleteNote: async (noteId) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set((state) => ({
        bundle: state.bundle
          ? {
              ...state.bundle,
              notes: state.bundle.notes.filter((note) => note.id !== noteId)
            }
          : createFallbackBundle(rootPath),
        error: null
      }));
      return;
    }
    const bundle = await window.archicode.deleteNote(rootPath, noteId);
    set({ bundle, error: null });
  },

  purgeResolvedNotes: async (scope = {}) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set((state) => ({
        bundle: state.bundle
          ? {
              ...state.bundle,
	              notes: state.bundle.notes.filter((note) =>
	                !note.resolved ||
	                note.pinned ||
	                Boolean(scope.flowId && note.flowId !== scope.flowId) ||
	                Boolean(scope.nodeId && note.nodeId !== scope.nodeId)
	              )
            }
          : createFallbackBundle(rootPath),
        error: null
      }));
      return;
    }
    const bundle = await window.archicode.purgeResolvedNotes(rootPath, scope);
    set({ bundle, error: null });
  },

  purgeSystemNotes: async (scope = {}) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set((state) => ({
        bundle: state.bundle
          ? {
              ...state.bundle,
              notes: state.bundle.notes.filter((note) => {
                const inScope = (!scope.flowId || note.flowId === scope.flowId) && (!scope.nodeId || note.nodeId === scope.nodeId);
                const systemGenerated = note.kind === "system-note" || note.author === "system";
                return !(inScope && systemGenerated && !note.pinned);
              })
            }
          : createFallbackBundle(rootPath),
        error: null
      }));
      return;
    }
    const bundle = await window.archicode.purgeSystemNotes(rootPath, scope);
    set({ bundle, error: null });
  },

  attachNodeReferences: async (nodeId, noteId) => {
    const { rootPath, activeFlowId } = get();
    if (!activeFlowId) return;
    if (!window.archicode) {
      set({ error: "Reference attachments are available in the Electron app." });
      return;
    }
    const bundle = await window.archicode.attachNodeReferences(rootPath, activeFlowId, nodeId, noteId);
    if (bundle) set({ bundle, error: null });
  },

  attachNodeReferenceFiles: async (nodeId, noteId, filePaths) => {
    const { rootPath, activeFlowId } = get();
    if (!activeFlowId || !filePaths.length) return;
    if (!window.archicode?.attachNodeReferenceFiles) {
      set({ error: "Reference attachments are available in the Electron app." });
      return;
    }
    const bundle = await window.archicode.attachNodeReferenceFiles(rootPath, activeFlowId, nodeId, noteId, filePaths);
    set({ bundle, error: null });
  },

});
