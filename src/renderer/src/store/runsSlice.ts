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
import { pandoraAgent } from "@shared/agentIdentities";
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

function sameRuntimeServices(left: RuntimeService[], right: RuntimeService[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  // Runtime-service collections are small IPC snapshots. Comparing the full
  // serialized shape prevents idle polls from publishing equivalent arrays
  // without accidentally ignoring a newly added user-visible field.
  return JSON.stringify(left) === JSON.stringify(right);
}

export const createRunsSlice = (set: StoreSet, get: StoreGet): Pick<ArchicodeState, "selectRun" | "handleRunUpdated" | "authorAcceptanceTests" | "authorAcceptanceTestsForFlow" | "enhanceNodeField" | "clearAcceptanceTests" | "runAcceptanceChecks" | "runAgent" | "runProfile" | "refreshRuntimeServices" | "stopRuntimeService" | "restartRuntimeService" | "continueQuestionBlockedRun" | "dismissQuestionCheck" | "approveRun" | "cancelRun" | "rejectRun" | "dismissRunError" | "removeRunFromQueue" | "retryRun" | "retryRunWithGuidance" | "startDebuggingRun" | "startRuntimeDebugRun" | "reportBug" | "updateBugIncident" | "startIncidentDebugRun"> => ({
  selectRun: (selectedRunId) => set({ selectedRunId }),
  handleRunUpdated: (payload) => {
    const current = get();
    if (!current.bundle || payload.projectRoot !== current.rootPath) return;
    const previous = current.bundle.runs.find((run) => run.id === payload.run.id);
    const knownArtifactIds = new Set([...current.bundle.artifacts, ...current.bundle.summaries].map((artifact) => artifact.id));
    const previousArtifactIds = new Set(previous ? runArtifactIds(previous) : []);
    const nextArtifactIds = runArtifactIds(payload.run);
    const shouldRefreshArtifacts = Boolean(window.archicode) && nextArtifactIds.some((artifactId) =>
      !knownArtifactIds.has(artifactId) || !previousArtifactIds.has(artifactId)
    );
    const shouldRefreshProject = shouldRefreshArtifacts || (Boolean(window.archicode) && shouldRefreshQuestionsForRun(previous, payload.run));
    if (
      (payload.run.status === "awaiting-plan-review" || payload.run.status === "awaiting-code-review") &&
      previous?.status !== payload.run.status
    ) {
      notifyReviewRequired(current.bundle, payload.run);
    }
    set((state) => {
      if (!state.bundle || payload.projectRoot !== state.rootPath) return state;
      const runs = state.bundle.runs.some((run) => run.id === payload.run.id)
        ? state.bundle.runs.map((run) => run.id === payload.run.id ? payload.run : run)
        : [...state.bundle.runs, payload.run];
      return {
        bundle: {
          ...state.bundle,
          runs
        },
        selectedRunId: state.selectedRunId ?? payload.run.id
      };
    });
    if (shouldRefreshProject) {
      void (async () => {
        if (!window.archicode) return;
        const [bundle, patchProposals] = await Promise.all([
          window.archicode.loadProject(payload.projectRoot),
          window.archicode.listPatchProposals(payload.projectRoot)
        ]);
        set((state) => {
          if (state.rootPath !== payload.projectRoot || !state.bundle) return state;
          const currentRuns = new Map(state.bundle.runs.map((run) => [run.id, run]));
          const refreshedRunIds = new Set(bundle.runs.map((run) => run.id));
          const mergedRuns = [
            ...bundle.runs.map((run) => {
              const currentRun = currentRuns.get(run.id);
              return currentRun && currentRun.logs.length > run.logs.length ? currentRun : run;
            }),
            ...state.bundle.runs.filter((run) => !refreshedRunIds.has(run.id))
          ];
          return { bundle: { ...bundle, runs: mergedRuns }, patchProposals };
        });
      })().catch((error: unknown) => {
        set((state) => state.rootPath === payload.projectRoot
          ? { error: error instanceof Error ? error.message : String(error) }
          : state);
      });
    }
  },
  authorAcceptanceTests: async (nodeId) => {
    const { rootPath, activeFlowId, bundle } = get();
    if (!activeFlowId || !window.archicode) return;
    if (hasActiveRun(bundle)) {
      set({ error: editingLockedMessage() });
      return;
    }
    const providerId = bundle?.project.settings.providers.find((provider) => provider.enabled)?.id;
    set((state) => ({ busyTestNodeIds: [...new Set([...state.busyTestNodeIds, nodeId])] }));
    try {
      const next = await window.archicode.authorAcceptanceTests(rootPath, activeFlowId, nodeId, providerId);
      set({ bundle: next, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set((state) => ({ busyTestNodeIds: state.busyTestNodeIds.filter((id) => id !== nodeId) }));
    }
  },

  authorAcceptanceTestsForFlow: async () => {
    const { rootPath, activeFlowId, bundle } = get();
    if (!activeFlowId || !window.archicode) return;
    if (hasActiveRun(bundle)) {
      set({ error: editingLockedMessage() });
      return;
    }
    const providerId = bundle?.project.settings.providers.find((provider) => provider.enabled)?.id;
    const eligibleNodeIds = (bundle?.flows.find((flow) => flow.id === activeFlowId)?.nodes ?? [])
      .filter((node) => !node.ignored && node.acceptanceCriteria.some((text) => text.trim()))
      .map((node) => node.id);
    set((state) => ({ busyTestNodeIds: [...new Set([...state.busyTestNodeIds, ...eligibleNodeIds])] }));
    try {
      const next = await window.archicode.authorAcceptanceTestsForFlow(rootPath, activeFlowId, providerId);
      set({ bundle: next, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set((state) => ({ busyTestNodeIds: state.busyTestNodeIds.filter((id) => !eligibleNodeIds.includes(id)) }));
    }
  },

  enhanceNodeField: async (nodeId, field) => {
    const { rootPath, activeFlowId, bundle } = get();
    if (!activeFlowId || !window.archicode?.enhanceNodeField) return null;
    if (hasActiveRun(bundle)) {
      set({ error: editingLockedMessage() });
      return null;
    }
    const providerId = bundle?.project.settings.providers.find((provider) => provider.enabled)?.id;
    try {
      const suggestion = await window.archicode.enhanceNodeField(rootPath, activeFlowId, nodeId, field, providerId);
      set({ error: null });
      return suggestion;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  clearAcceptanceTests: async (nodeId) => {
    const { rootPath, activeFlowId, bundle } = get();
    if (!activeFlowId || !window.archicode?.clearAcceptanceTests) return;
    if (hasActiveRun(bundle)) {
      set({ error: editingLockedMessage() });
      return;
    }
    set((state) => ({ busyTestNodeIds: [...new Set([...state.busyTestNodeIds, nodeId])] }));
    try {
      const next = await window.archicode.clearAcceptanceTests(rootPath, activeFlowId, nodeId);
      set({ bundle: next, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set((state) => ({ busyTestNodeIds: state.busyTestNodeIds.filter((id) => id !== nodeId) }));
    }
  },

  runAcceptanceChecks: async (nodeId) => {
    const { rootPath, activeFlowId, bundle } = get();
    if (!activeFlowId || !window.archicode) return;
    if (hasActiveRun(bundle)) {
      set({ error: editingLockedMessage() });
      return;
    }
    set((state) => ({ busyTestNodeIds: [...new Set([...state.busyTestNodeIds, nodeId])] }));
    try {
      const next = await window.archicode.runAcceptanceChecks(rootPath, activeFlowId, nodeId);
      set({ bundle: next, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set((state) => ({ busyTestNodeIds: state.busyTestNodeIds.filter((id) => id !== nodeId) }));
    }
  },

  runAgent: async (input) => {
    const { rootPath, activeFlowId, activeSubflowId, bundle } = get();
    if (!activeFlowId || !bundle) return;
    const activeFlow = getActiveFlow(bundle, activeFlowId);
    if (activeFlow?.ignored) {
      set({ error: `Flow "${activeFlow.name}" is ignored and outside the agent working set. Restore it before running AI work.` });
      return;
    }
    const activeSubflow = activeSubflowId ? activeFlow?.subflows.find((subflow) => subflow.id === activeSubflowId) : null;
    if (activeFlow && activeSubflow && isSubflowIgnored(activeFlow, activeSubflow.id)) {
      set({ error: `Subflow "${activeSubflow.name}" is ignored and outside the agent working set. Restore it before running AI work.` });
      return;
    }
    const targetNode = input.nodeId ? activeFlow?.nodes.find((node) => node.id === input.nodeId) : null;
    if (targetNode && (targetNode.ignored || (activeFlow && isSubflowIgnored(activeFlow, targetNode.subflowId)))) {
      set({ error: `Node "${targetNode.title}" is ignored and outside the agent working set. Restore it before running AI work.` });
      return;
    }
    const scopedNodeIds = input.scope?.kind === "nodes" ? input.scope.nodeIds : [];
    const ignoredScopedNode = scopedNodeIds
      .map((nodeId) => activeFlow?.nodes.find((node) => node.id === nodeId))
      .find((node) => node?.ignored || (activeFlow && isSubflowIgnored(activeFlow, node?.subflowId)));
    if (ignoredScopedNode) {
      set({ error: `Node "${ignoredScopedNode.title}" is ignored and outside the agent working set. Restore it before running AI work.` });
      return;
    }
    if (!input.skipQuestionCheck && isBuildLikeAgentRun(input)) {
      const questions = getOpenQuestionsForScope(bundle, activeFlowId, input.nodeId, activeSubflowId);
      if (questions.length) {
        const questionNodeId = questions[0]?.nodeId ?? get().selectedNodeId;
        set({ buildQuestionCheck: { input, questions }, selectedNodeId: questionNodeId, selectedNodeIds: selectedNodeIdsFor(questionNodeId), error: null });
        return;
      }
    }
    const providerId = bundle.project.settings.providers.find((provider) => provider.enabled)?.id;
    if (!providerId) {
      set({ error: "Choose a provider in Settings before running build/code actions." });
      return;
    }
    const runKey = runInputKey(activeFlowId, input);
    const duplicateRun = bundle.runs.find((run) => isRunBlockingNewChange(run) && isSameRunRequest(run, activeFlowId, input));
    if (get().pendingRunKeys.includes(runKey) || duplicateRun) {
      set({
        selectedRunId: duplicateRun?.id ?? get().selectedRunId,
        error: null
      });
      return;
    }
    if (!window.archicode) {
      const run: Run = {
        id: uid("run"),
        flowId: activeFlowId,
        nodeId: input.nodeId,
        providerId,
        status: "succeeded",
        phase: "complete",
        effort: input.effort ?? "high",
        promptSummary: input.promptSummary,
        command: input.command,
        cwd: input.cwd,
        env: input.env ?? [],
        permission: {
          decision: input.command ? "allowed" : "allowed",
          reason: "Browser preview run is simulated in memory."
        },
        contextArtifacts: [],
        planArtifactIds: [],
        sourceDiffArtifactIds: [],
        affectedNodeIds: input.nodeId ? [input.nodeId] : [],
        plannedCommands: input.command ? [input.command] : [],
        plannedAllowedRoots: [rootPath],
        mcpToolCalls: [],
        reviewDecisions: [],
        todos: [{ id: uid("todo"), text: "Simulate browser preview run", status: "done" }],
        logs: [{ at: now(), stream: "system", text: "Browser preview has no Electron shell or provider bridge. Run completed in memory." }],
        runInstructions: "Open the Electron app for real shell execution and JSON persistence.",
        createdAt: now(),
        startedAt: now(),
        completedAt: now()
      };
      const artifact: Artifact = {
        id: uid("artifact"),
        type: "instructions",
        title: "Browser preview run instructions",
        path: "memory://browser-preview-run",
        runId: run.id,
        nodeId: input.nodeId,
        createdAt: now()
      };
      set({ bundle: { ...bundle, runs: [...bundle.runs, run], artifacts: [...bundle.artifacts, artifact] }, shellPrompt: null, error: null });
      return;
    }
    const optimisticRun = createOptimisticRun(activeFlowId, providerId, input);
    set((state) => ({
      bundle: state.bundle ? { ...state.bundle, runs: [...state.bundle.runs, optimisticRun] } : state.bundle,
      selectedRunId: optimisticRun.id,
      pendingRunKeys: [...state.pendingRunKeys, runKey],
      shellPrompt: null,
      error: null
    }));
    try {
      const result = await window.archicode.startAgentRun({
        projectRoot: rootPath,
        flowId: activeFlowId,
        providerId,
        ...input
      });
      const patchProposals = await window.archicode.listPatchProposals(rootPath);
      set((state) => ({
        bundle: result.bundle,
        patchProposals,
        selectedRunId: result.runId,
        pendingRunKeys: state.pendingRunKeys.filter((key) => key !== runKey),
        shellPrompt: null,
        buildQuestionCheck: null,
        error: null
      }));
    } catch (error) {
      set((state) => ({
        bundle: state.bundle
          ? { ...state.bundle, runs: state.bundle.runs.filter((run) => run.id !== optimisticRun.id) }
          : state.bundle,
        selectedRunId: state.selectedRunId === optimisticRun.id ? null : state.selectedRunId,
        pendingRunKeys: state.pendingRunKeys.filter((key) => key !== runKey),
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  },

  runProfile: async (input) => {
    const { rootPath, bundle } = get();
    if (!bundle) return;
    if (!window.archicode) {
      set({ error: "Runtime services are available in the Electron app." });
      return;
    }
    try {
      const runtimeServices = await window.archicode.startRuntimeService({
        projectRoot: rootPath,
        ...input
      });
      set({ runtimeServices, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  refreshRuntimeServices: async () => {
    const { rootPath } = get();
    if (!window.archicode || !rootPath) return;
    const runtimeServices = await window.archicode.listRuntimeServices(rootPath);
    set((state) => sameRuntimeServices(state.runtimeServices, runtimeServices)
      ? state
      : { runtimeServices });
  },

  stopRuntimeService: async (serviceId) => {
    const { rootPath } = get();
    if (!window.archicode || !rootPath) return;
    const runtimeServices = await window.archicode.stopRuntimeService(rootPath, serviceId);
    set({ runtimeServices, error: null });
  },

  restartRuntimeService: async (serviceId) => {
    const { rootPath } = get();
    if (!window.archicode || !rootPath) return;
    const runtimeServices = await window.archicode.restartRuntimeService(rootPath, serviceId);
    set({ runtimeServices, error: null });
  },

  continueQuestionBlockedRun: async () => {
    const pending = get().buildQuestionCheck;
    if (!pending) return;
    set({ buildQuestionCheck: null });
    await get().runAgent({ ...pending.input, skipQuestionCheck: true });
  },

  dismissQuestionCheck: () => set({ buildQuestionCheck: null }),

  approveRun: async (runId, reusableApproval = false) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Run approval is available in the Electron app." });
      return;
    }
    const bundle = await window.archicode.approveRun({ projectRoot: rootPath, runId, reusableApproval });
    set({ bundle, selectedRunId: runId, error: null });
  },

  cancelRun: async (runId) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Run cancellation is available in the Electron app." });
      return;
    }
    const bundle = await window.archicode.cancelRun(rootPath, runId);
    set({ bundle, selectedRunId: runId, error: null });
  },

  rejectRun: async (runId, reason) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Run rejection is available in the Electron app." });
      return;
    }
    const bundle = await window.archicode.rejectRun(rootPath, runId, reason);
    set({ bundle, selectedRunId: runId, error: null });
  },

  dismissRunError: async (runId) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Run error dismissal is available in the Electron app." });
      return;
    }
    const bundle = await window.archicode.dismissRunError(rootPath, runId);
    set({ bundle, selectedRunId: runId, error: null });
  },

  removeRunFromQueue: async (runId) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Queue removal is available in the Electron app." });
      return;
    }
    const bundle = await window.archicode.removeRunFromQueue(rootPath, runId);
    set({ bundle, selectedRunId: null, error: null });
  },

  retryRun: async (runId) => {
    await get().retryRunWithGuidance(runId);
  },

  retryRunWithGuidance: async (runId, guidance) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Run retry is available in the Electron app." });
      return;
    }
    const result = await window.archicode.retryRun(rootPath, runId, guidance);
    set({ bundle: result.bundle, selectedRunId: result.runId, error: null });
  },

  startDebuggingRun: async (runId, guidance) => {
    const { rootPath } = get();
    if (!window.archicode) {
      set({ error: "Debugging runs are available in the Electron app." });
      return;
    }
    const result = await window.archicode.startDebuggingRun(rootPath, runId, guidance);
    set({ bundle: result.bundle, selectedRunId: result.runId, error: null });
  },

  startRuntimeDebugRun: async (serviceId, guidance) => {
    const { rootPath, activeFlowId, bundle } = get();
    const providerId = bundle?.project.settings.providers.find((provider) => provider.enabled)?.id;
    if (!rootPath || !providerId) {
      set({ error: "Choose a provider in Settings before debugging runtime output." });
      return;
    }
    if (!window.archicode?.startRuntimeDebugRun) {
      set({ error: "Runtime debugging is available in the Electron app." });
      return;
    }
    const result = await window.archicode.startRuntimeDebugRun({
      projectRoot: rootPath,
      serviceId,
      flowId: activeFlowId ?? bundle?.project.activeFlowId,
      providerId,
      guidance
    });
    set({ bundle: result.bundle, selectedRunId: result.runId, error: null });
  },

  reportBug: async (input) => {
    const { rootPath, activeFlowId, selectedNodeId } = get();
    if (!rootPath || !activeFlowId) return;
    if (!window.archicode) {
      set({ error: "Bug reports are available in the Electron app." });
      return;
    }
    try {
      const bundle = await window.archicode.reportBug({
        projectRoot: rootPath,
        flowId: activeFlowId,
        nodeId: input.nodeId ?? selectedNodeId ?? undefined,
        title: input.title,
        description: input.description,
        priority: input.priority,
        artifactIds: input.artifactIds,
        filePaths: input.filePaths
      });
      set({ bundle, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  updateBugIncident: async (incidentId, patch) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode?.updateBugIncident) return;
    try {
      const bundle = await window.archicode.updateBugIncident({ projectRoot: rootPath, incidentId, patch });
      set({ bundle, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  startIncidentDebugRun: async (incidentIds) => {
    const { rootPath, activeFlowId, bundle } = get();
    if (!rootPath || !activeFlowId || !bundle) return;
    const providerId = bundle.project.settings.providers.find((provider) => provider.enabled)?.id;
    if (!providerId) {
      set({ error: `Choose a provider in Settings before running ${pandoraAgent.title}.` });
      return;
    }
    if (!window.archicode) {
      set({ error: `${pandoraAgent.title} is available in the Electron app.` });
      return;
    }
    try {
      const result = await window.archicode.startIncidentDebugRun({
        projectRoot: rootPath,
        flowId: activeFlowId,
        providerId,
        incidentIds
      });
      const patchProposals = await window.archicode.listPatchProposals(rootPath);
      set({ bundle: result.bundle, patchProposals, selectedRunId: result.runId, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

});
