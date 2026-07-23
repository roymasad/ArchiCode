import { t } from "@renderer/i18n";
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

export const createCapabilitiesSlice = (set: StoreSet, get: StoreGet): Pick<ArchicodeState, "checkProvider" | "refreshCapabilities" | "createProjectSkill" | "searchMcpRegistry" | "installMcpRegistryServer" | "importMcpServers" | "updateMcpServer" | "refreshMcpServerCapabilities"> => ({
  checkProvider: async (providerId) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set((state) => ({
        providerHealth: {
          ...state.providerHealth,
          [providerId]: {
            providerId,
            ok: true,
            status: "ready",
            checkedAt: now(),
            message: t("Browser preview provider check is simulated.")
          }
        }
      }));
      return;
    }
    const health = await window.archicode.checkProvider(rootPath, providerId);
    const bundle = health.detectedContextWindowTokens || health.availableModels?.length ? await window.archicode.loadProject(rootPath) : get().bundle;
    set((state) => ({
      bundle,
      providerHealth: { ...state.providerHealth, [providerId]: health },
      error: null
    }));
  },

  refreshCapabilities: async () => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode) return;
    set({ capabilityBusy: true });
    try {
      const [projectSkills, mcpServers] = await Promise.all([
        window.archicode.listProjectSkills(rootPath),
        window.archicode.listMcpServers(rootPath)
      ]);
      set({ projectSkills, mcpServers, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ capabilityBusy: false });
    }
  },

  createProjectSkill: async (input) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode) return;
    set({ capabilityBusy: true });
    try {
      const projectSkills = await window.archicode.createProjectSkill(rootPath, input);
      set({ projectSkills, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ capabilityBusy: false });
    }
  },

  searchMcpRegistry: async (input, options) => {
    if (!window.archicode) return null;
    set({
      capabilityBusy: true,
      error: null,
      ...(options?.append ? {} : { mcpRegistryEntries: [], mcpRegistryNextCursor: null, mcpRegistryCount: 0 })
    });
    try {
      const result = await window.archicode.searchMcpRegistry(input);
      const currentEntries = options?.append ? get().mcpRegistryEntries : [];
      const currentCount = options?.append ? get().mcpRegistryCount : 0;
      const entriesById = new Map(currentEntries.map((entry) => [entry.id, entry]));
      for (const entry of result.entries) entriesById.set(entry.id, entry);
      set({
        mcpRegistryEntries: [...entriesById.values()],
        mcpRegistryNextCursor: result.nextCursor ?? null,
        mcpRegistryCount: currentCount + result.count,
        error: null
      });
      return result;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      set({ capabilityBusy: false });
    }
  },

  installMcpRegistryServer: async (input) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode) return null;
    set({ capabilityBusy: true });
    try {
      const result = await window.archicode.installMcpRegistryServer(rootPath, input);
      const bundle = await window.archicode.loadProject(rootPath);
      const mcpServers = await window.archicode.listMcpServers(rootPath);
      set({ bundle, mcpServers, error: result.refresh?.ok === false ? result.refresh.message : null });
      return result;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      set({ capabilityBusy: false });
    }
  },

  importMcpServers: async (source) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode) return;
    set({ capabilityBusy: true });
    try {
      const bundle = await window.archicode.importMcpServers(rootPath, source);
      const mcpServers = await window.archicode.listMcpServers(rootPath);
      set({ bundle, mcpServers, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ capabilityBusy: false });
    }
  },

  updateMcpServer: async (server) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode) return;
    set({ capabilityBusy: true });
    try {
      const bundle = await window.archicode.updateMcpServer(rootPath, server);
      const mcpServers = await window.archicode.listMcpServers(rootPath);
      set({ bundle, mcpServers, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ capabilityBusy: false });
    }
  },

  refreshMcpServerCapabilities: async (serverId) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode) return null;
    set({ capabilityBusy: true });
    try {
      const result = await window.archicode.refreshMcpServerCapabilities(rootPath, serverId);
      const bundle = await window.archicode.loadProject(rootPath);
      const mcpServers = await window.archicode.listMcpServers(rootPath);
      set({ bundle, mcpServers, error: result.ok ? null : result.message });
      return result;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      set({ capabilityBusy: false });
    }
  },

});
