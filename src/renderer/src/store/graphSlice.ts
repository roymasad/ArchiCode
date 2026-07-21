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
  PresentationNodeMutation,
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
import { storeGraphLocation } from "./graphLocation";

export const createGraphSlice = (set: StoreSet, get: StoreGet): Pick<ArchicodeState, "selectNode" | "selectNodes" | "toggleNodeSelection" | "selectEdge" | "setActiveFlow" | "setActiveSubflow" | "setSearchQuery" | "saveFlow" | "createFlow" | "createSubflow" | "renameSubflow" | "toggleSubflowIgnored" | "reparentSubflow" | "deleteSubflow" | "setNodeLinkedSubflow" | "setCanvasViewport" | "setCanvasViewportCenter" | "navigateToGraphTarget" | "applyResearchCanvasAction" | "clearGraphNavigationRequest" | "addNode" | "copySelectedNode" | "cutSelectedNode" | "pasteNode" | "duplicateSelectedNode" | "deleteSelectedNode" | "addEdge" | "rememberEdgeLabel" | "updateSelectedEdge" | "updateSelectedEdgePatch" | "deleteSelectedEdge" | "autoLayout" | "updateNode" | "showGraphChangeSetPreview" | "hideGraphChangeSetPreview"> => ({
  selectNode: (nodeId) => set((state) => state.selectedNodeId === nodeId && state.selectedEdgeId === null && state.selectedNodeIds.length === (nodeId ? 1 : 0) && (!nodeId || state.selectedNodeIds[0] === nodeId)
    ? state
    : { selectedNodeId: nodeId, selectedNodeIds: nodeId ? [nodeId] : [], selectedEdgeId: null }),
  selectNodes: (nodeIds, primaryNodeId) => set((state) => {
    const nextNodeIds = uniqueNodeIds(nodeIds);
    const nextPrimaryNodeId = primaryNodeId && nextNodeIds.includes(primaryNodeId)
      ? primaryNodeId
      : nextNodeIds[nextNodeIds.length - 1] ?? null;
    if (
      state.selectedEdgeId === null &&
      state.selectedNodeId === nextPrimaryNodeId &&
      state.selectedNodeIds.length === nextNodeIds.length &&
      state.selectedNodeIds.every((nodeId, index) => nodeId === nextNodeIds[index])
    ) {
      return state;
    }
    return { selectedNodeId: nextPrimaryNodeId, selectedNodeIds: nextNodeIds, selectedEdgeId: null };
  }),
  toggleNodeSelection: (nodeId) => set((state) => {
    const currentlySelected = state.selectedNodeIds.length ? state.selectedNodeIds : state.selectedNodeId ? [state.selectedNodeId] : [];
    const nextNodeIds = currentlySelected.includes(nodeId)
      ? currentlySelected.filter((item) => item !== nodeId)
      : [...currentlySelected, nodeId];
    return {
      selectedNodeId: nextNodeIds[nextNodeIds.length - 1] ?? null,
      selectedNodeIds: nextNodeIds,
      selectedEdgeId: null
    };
  }),
  selectEdge: (edgeId) => set((state) => state.selectedEdgeId === edgeId && state.selectedNodeId === null && state.selectedNodeIds.length === 0
    ? state
    : { selectedEdgeId: edgeId, selectedNodeId: null, selectedNodeIds: [] }),
  setActiveFlow: (activeFlowId) => {
    const { rootPath } = get();
    storeGraphLocation(rootPath, activeFlowId, null);
    set({
      activeFlowId,
      activeSubflowId: null,
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedEdgeId: null,
      searchQuery: "",
      canvasViewport: rootPath ? readStoredViewport(rootPath, activeFlowId, null) : null,
      canvasViewportCenter: null,
      lastAddNodePosition: null,
      lastAddNodeScope: null,
      presentationUndoStack: [],
      presentationRedoStack: []
    });
  },
  setActiveSubflow: (activeSubflowId) => {
    const { rootPath, activeFlowId } = get();
    storeGraphLocation(rootPath, activeFlowId, activeSubflowId);
    set({
      activeSubflowId,
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedEdgeId: null,
      canvasViewport: rootPath ? readStoredViewport(rootPath, activeFlowId, activeSubflowId) : null,
      canvasViewportCenter: null,
      lastAddNodePosition: null,
      lastAddNodeScope: null,
      presentationUndoStack: [],
      presentationRedoStack: []
    });
  },
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  saveFlow: async (flow) => {
    const { rootPath, bundle: currentBundle, historicalInspection } = get();
    if (historicalInspection) {
      set({ error: "Historical graph inspection is read-only. Return to the current graph to make changes." });
      return null;
    }
    if (hasActiveRun(currentBundle)) {
      set({ error: editingLockedMessage() });
      return null;
    }
    if (!window.archicode) {
      const upsertFlow = (flows: Flow[]) => flows.some((item) => item.id === flow.id)
        ? flows.map((item) => item.id === flow.id ? flow : item)
        : [...flows, flow];
      const nextBundle = currentBundle
        ? { ...currentBundle, flows: upsertFlow(currentBundle.flows) }
        : createFallbackBundle(rootPath);
      set((state) => ({
        bundle: state.bundle ? { ...state.bundle, flows: upsertFlow(state.bundle.flows) } : nextBundle,
        error: null
      }));
      return nextBundle;
    }
    try {
      const bundle = await window.archicode.saveFlow(rootPath, flow);
      set({ bundle, error: null });
      return bundle;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  createFlow: async () => {
    const { bundle, saveFlow } = get();
    if (!bundle || hasActiveRun(bundle)) {
      if (bundle && hasActiveRun(bundle)) set({ error: editingLockedMessage() });
      return;
    }
    const flow: Flow = {
      id: uid("flow"),
      name: `Flow ${bundle.flows.length + 1}`,
      description: "",
      ignored: false,
      nodes: [],
      edges: [],
      subflows: [],
      groups: [],
      updatedAt: now()
    };
    const saved = await saveFlow(flow);
    if (!saved) return;
    storeGraphLocation(get().rootPath, flow.id, null);
    set({
      activeFlowId: flow.id,
      activeSubflowId: null,
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedEdgeId: null,
      searchQuery: "",
      canvasViewport: null,
      canvasViewportCenter: null,
      lastAddNodePosition: null,
      lastAddNodeScope: null
    });
  },

  createSubflow: async () => {
    const { bundle, activeFlowId, activeSubflowId, saveFlow } = get();
    if (hasActiveRun(bundle)) {
      set({ error: editingLockedMessage() });
      return;
    }
    const flow = getActiveFlow(bundle, activeFlowId);
    if (!flow) return;
    const subflow = {
      id: uid("subflow"),
      name: `Subflow ${flow.subflows.length + 1}`,
      ignored: false,
      parentSubflowId: activeSubflowId ?? undefined
    };
    await saveFlow({
      ...flow,
      subflows: [...flow.subflows, subflow],
      updatedAt: now()
    });
    storeGraphLocation(get().rootPath, flow.id, subflow.id);
    set({ activeSubflowId: subflow.id, selectedNodeId: null, selectedNodeIds: [], selectedEdgeId: null, canvasViewport: null, canvasViewportCenter: null });
  },

  renameSubflow: async (subflowId, name) => {
    const { bundle, activeFlowId, saveFlow } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    const trimmedName = name.trim();
    if (!flow || !trimmedName) return;
    const subflow = flow.subflows.find((item) => item.id === subflowId);
    if (!subflow || subflow.name === trimmedName) return;
    await saveFlow({
      ...flow,
      subflows: flow.subflows.map((item) => item.id === subflowId ? { ...item, name: trimmedName } : item),
      updatedAt: now()
    });
  },

  toggleSubflowIgnored: async (subflowId) => {
    const { bundle, activeFlowId, saveFlow } = get();
    if (hasActiveRun(bundle)) {
      set({ error: editingLockedMessage() });
      return;
    }
    const flow = getActiveFlow(bundle, activeFlowId);
    const subflow = flow?.subflows.find((item) => item.id === subflowId);
    if (!flow || !subflow) return;
    await saveFlow({
      ...flow,
      subflows: flow.subflows.map((item) => item.id === subflowId ? { ...item, ignored: !item.ignored } : item),
      updatedAt: now()
    });
  },

  reparentSubflow: async (subflowId, parentSubflowId) => {
    const { bundle, activeFlowId, saveFlow } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    if (!flow) return;
    await saveFlow(reparentSubflowInFlow(flow, subflowId, parentSubflowId));
  },

  deleteSubflow: async (subflowId) => {
    const { rootPath, bundle, activeFlowId, activeSubflowId, saveFlow } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    if (!flow) return;
    const subflow = flow.subflows.find((item) => item.id === subflowId);
    if (!subflow) return;
    await saveFlow(deleteSubflowFromFlow(flow, subflowId));
    if (activeSubflowId === subflowId) {
      const nextSubflowId = subflow.parentSubflowId ?? null;
      storeGraphLocation(rootPath, flow.id, nextSubflowId);
      set({
        activeSubflowId: nextSubflowId,
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedEdgeId: null,
        canvasViewport: rootPath ? readStoredViewport(rootPath, flow.id, nextSubflowId) : null,
        canvasViewportCenter: null
      });
    }
  },

  setNodeLinkedSubflow: async (nodeId, subflowId) => {
    const { bundle, activeFlowId, saveFlow } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    if (!flow || !flow.nodes.some((node) => node.id === nodeId)) return;
    await saveFlow(linkNodeToSubflow(flow, nodeId, subflowId));
  },

  setCanvasViewport: (viewport) => {
    const { rootPath, activeFlowId, activeSubflowId } = get();
    if (rootPath && viewport) {
      localStorage.setItem(projectScopedUiKey(rootPath, "viewport", activeFlowId, activeSubflowId), JSON.stringify(viewport));
    }
    set({ canvasViewport: viewport });
  },
  setCanvasViewportCenter: (position) => set({ canvasViewportCenter: position }),

  applyResearchCanvasAction: (action) => {
    const requestId = nextGraphNavigationRequestId();
    set((state) => {
      const flow = state.bundle?.flows.find((item) => item.id === action.flowId);
      if (!flow) return state;
      const requestedNodes = action.nodeIds.flatMap((nodeId) => {
        const node = flow.nodes.find((item) => item.id === nodeId);
        return node ? [node] : [];
      });
      const groupNodes = action.groupIds.flatMap((groupId) => flow.nodes.filter((node) => node.groupId === groupId));
      const targetNodes = [...new Map([...requestedNodes, ...groupNodes].map((node) => [node.id, node])).values()];
      const inferredLayers = new Set(targetNodes.map((node) => node.subflowId ?? null));
      const targetSubflowId = action.subflowId !== undefined
        ? action.subflowId
        : inferredLayers.size === 1
          ? [...inferredLayers][0]
          : state.activeFlowId === flow.id
            ? state.activeSubflowId
            : null;
      if (targetSubflowId !== null && !flow.subflows.some((subflow) => subflow.id === targetSubflowId)) return state;
      const targetNodeIds = uniqueNodeIds(targetNodes
        .filter((node) => (node.subflowId ?? null) === targetSubflowId)
        .map((node) => node.id));
      const sameLayer = state.activeFlowId === flow.id && state.activeSubflowId === targetSubflowId;
      const preservedNodeIds = sameLayer
        ? uniqueNodeIds((state.selectedNodeIds.length ? state.selectedNodeIds : state.selectedNodeId ? [state.selectedNodeId] : [])
          .filter((nodeId) => flow.nodes.some((node) => node.id === nodeId && (node.subflowId ?? null) === targetSubflowId)))
        : [];
      const selectedNodeIds = action.selection === "preserve"
        ? preservedNodeIds
        : action.selection === "clear"
          ? []
          : targetNodeIds;
      storeGraphLocation(state.rootPath, flow.id, targetSubflowId);
      return {
        workbenchView: "graph" as const,
        activeFlowId: flow.id,
        activeSubflowId: targetSubflowId,
        selectedNodeId: selectedNodeIds[selectedNodeIds.length - 1] ?? null,
        selectedNodeIds,
        selectedEdgeId: null,
        searchQuery: "",
        canvasViewport: sameLayer
          ? state.canvasViewport
          : state.rootPath ? readStoredViewport(state.rootPath, flow.id, targetSubflowId) : null,
        canvasViewportCenter: null,
        graphNavigationRequest: {
          kind: "canvas" as const,
          requestId,
          flowId: flow.id,
          subflowId: targetSubflowId,
          nodeIds: targetNodeIds,
          viewport: action.viewport
        }
      };
    });
  },

  navigateToGraphTarget: (target) => {
    const requestId = nextGraphNavigationRequestId();
    set((state) => {
      if (target.kind === "project") {
        return {
          workbenchView: "graph" as const,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          graphNavigationRequest: { ...target, requestId }
        };
      }
      const flow = state.bundle?.flows.find((item) => item.id === target.flowId);
      if (!flow) return state;
      if (target.kind === "flow") {
        storeGraphLocation(state.rootPath, target.flowId, null);
        return {
          workbenchView: "graph" as const,
          activeFlowId: target.flowId,
          activeSubflowId: null,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          searchQuery: "",
          canvasViewport: state.rootPath ? readStoredViewport(state.rootPath, target.flowId, null) : null,
          canvasViewportCenter: null,
          graphNavigationRequest: { ...target, requestId }
        };
      }
      if (target.kind === "subflow") {
        if (!flow.subflows.some((item) => item.id === target.subflowId)) return state;
        storeGraphLocation(state.rootPath, target.flowId, target.subflowId);
        return {
          workbenchView: "graph" as const,
          activeFlowId: target.flowId,
          activeSubflowId: target.subflowId,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          searchQuery: "",
          canvasViewport: state.rootPath ? readStoredViewport(state.rootPath, target.flowId, target.subflowId) : null,
          canvasViewportCenter: null,
          graphNavigationRequest: { ...target, requestId }
        };
      }
      const node = flow.nodes.find((item) => item.id === target.nodeId);
      if (!node) return state;
      storeGraphLocation(state.rootPath, target.flowId, node.subflowId ?? null);
      return {
        workbenchView: "graph" as const,
        activeFlowId: target.flowId,
        activeSubflowId: node.subflowId ?? null,
        selectedNodeId: target.nodeId,
        selectedNodeIds: [target.nodeId],
        selectedEdgeId: null,
        searchQuery: "",
        canvasViewport: state.rootPath ? readStoredViewport(state.rootPath, target.flowId, node.subflowId ?? null) : null,
        canvasViewportCenter: null,
        graphNavigationRequest: { ...target, requestId }
      };
    });
  },

  clearGraphNavigationRequest: (requestId) => set((state) => (
    state.graphNavigationRequest?.requestId === requestId ? { graphNavigationRequest: null } : state
  )),

  addNode: async (kind = "component", options) => {
    const { bundle, activeFlowId, activeSubflowId, saveFlow, selectNode, canvasViewportCenter } = get();
    if (hasActiveRun(bundle)) {
      set({ error: editingLockedMessage() });
      return;
    }
    const flow = getActiveFlow(bundle, activeFlowId);
    if (!flow) return;
    const nodeType = kind.trim() || "component";
    const center = options?.position ?? canvasViewportCenter;
    const half = defaultNodeHalfSize;
    const cascadeStep = { x: 18, y: 18 };
    const scopeSubflowId = activeSubflowId ?? null;
    const scopeKey = `${activeFlowId ?? ""}:${scopeSubflowId}`;
    const base = center
      ? { x: center.x - half.x, y: center.y - half.y }
      : { x: 120 + flow.nodes.length * 36, y: 120 + flow.nodes.length * 28 };
    const baseOccupied = flow.nodes.some(
      (existing) =>
        (existing.subflowId ?? null) === scopeSubflowId &&
        Math.abs(existing.position.x - base.x) < 1 &&
        Math.abs(existing.position.y - base.y) < 1
    );
    const lastScope = get().lastAddNodeScope;
    const lastPosition = get().lastAddNodePosition;
    let position: { x: number; y: number };
    if (lastScope !== scopeKey || !baseOccupied || !lastPosition) {
      position = base;
    } else {
      position = { x: lastPosition.x + cascadeStep.x, y: lastPosition.y + cascadeStep.y };
    }
    set({ lastAddNodePosition: position, lastAddNodeScope: scopeKey });
    const node: ArchicodeNode = {
      id: uid("node"),
      type: nodeType,
      title: `New ${nodeType}`,
      description: "Describe the intent, behavior, constraints, and success criteria for this node.",
      stage: "planned" satisfies NodeStage,
      ignored: false,
      flags: ["changed"],
      locked: false,
      visual: {},
      position,
      subflowId: activeSubflowId ?? undefined,
      customProperties: {},
      techStack: [],
      acceptanceCriteria: [],
      acceptanceChecks: [],
      attachments: [],
      todos: [],
      updatedAt: now()
    };
    const nextFlow = { ...flow, nodes: [...flow.nodes, node], updatedAt: now() };
    if (get().bundle) {
      set((state) => ({
        bundle: {
          ...state.bundle!,
          flows: state.bundle!.flows.map((item) => (item.id === flow.id ? nextFlow : item))
        },
        error: null
      }));
    }
    await saveFlow(nextFlow);
    selectNode(node.id);
  },

  copySelectedNode: () => {
    const { bundle, activeFlowId, selectedNodeId, selectedNodeIds } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    const selectedIds = uniqueNodeIds(selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : []);
    if (!flow || selectedIds.length === 0) return;
    const selectedIdSet = new Set(selectedIds);
    const nodes = flow.nodes.filter((item) => selectedIdSet.has(item.id));
    if (nodes.length === 0) return;
    const edges = flow.edges.filter((edge) => selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target));
    set({ nodeClipboard: { nodes, edges }, error: null });
  },

  cutSelectedNode: async () => {
    const { bundle, activeFlowId, selectedNodeId, selectedNodeIds, saveFlow, selectNode } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    const selectedIds = uniqueNodeIds(selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : []);
    if (!flow || selectedIds.length === 0) return;
    const selectedIdSet = new Set(selectedIds);
    const nodes = flow.nodes.filter((item) => selectedIdSet.has(item.id));
    if (nodes.length === 0) return;
    const lockedNodes = nodes.filter((item) => item.locked);
    if (lockedNodes.length) {
      const title = lockedNodes.length === 1 ? `"${lockedNodes[0].title}" is` : `${lockedNodes.length} selected nodes are`;
      set({ error: `${title} approved and locked. Create revisions before cutting.` });
      return;
    }
    const edges = flow.edges.filter((edge) => selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target));
    set({ nodeClipboard: { nodes, edges }, error: null });
    await saveFlow({
      ...flow,
      nodes: flow.nodes.filter((item) => !selectedIdSet.has(item.id)),
      edges: flow.edges.filter((edge) => !selectedIdSet.has(edge.source) && !selectedIdSet.has(edge.target)),
      updatedAt: now()
    });
    selectNode(null);
  },

  pasteNode: async () => {
    const { bundle, activeFlowId, activeSubflowId, nodeClipboard, saveFlow, selectNodes } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    if (!flow || !nodeClipboard) return;
    const idMap = new Map<string, string>();
    const nodes = nodeClipboard.nodes.map((source, index) => {
      const node = duplicateNode(source, flow.nodes.length + index, {
        subflowId: activeSubflowId ?? source.subflowId,
        position: {
          x: source.position.x + 64,
          y: source.position.y + 64
        }
      });
      idMap.set(source.id, node.id);
      return node;
    });
    const edges: FlowEdge[] = nodeClipboard.edges.flatMap((edge) => {
      const source = idMap.get(edge.source);
      const target = idMap.get(edge.target);
      if (!source || !target) return [];
      return {
        ...edge,
        id: uid("edge"),
        source,
        target
      };
    });
    await saveFlow({
      ...flow,
      nodes: [...flow.nodes, ...nodes],
      edges: [...flow.edges, ...edges],
      updatedAt: now()
    });
    selectNodes(nodes.map((node) => node.id), nodes[nodes.length - 1]?.id ?? null);
  },

  duplicateSelectedNode: async () => {
    const { bundle, activeFlowId, activeSubflowId, selectedNodeId, selectedNodeIds, saveFlow, selectNodes } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    const selectedIds = uniqueNodeIds(selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : []);
    if (!flow || selectedIds.length === 0) return;
    const selectedIdSet = new Set(selectedIds);
    const sources = flow.nodes.filter((item) => selectedIdSet.has(item.id));
    if (sources.length === 0) return;
    const idMap = new Map<string, string>();
    const nodes = sources.map((source, index) => {
      const node = duplicateNode(source, flow.nodes.length + index, { subflowId: activeSubflowId ?? source.subflowId });
      idMap.set(source.id, node.id);
      return node;
    });
    const edges: FlowEdge[] = flow.edges.flatMap((edge) => {
      const source = idMap.get(edge.source);
      const target = idMap.get(edge.target);
      if (!source || !target) return [];
      return {
        ...edge,
        id: uid("edge"),
        source,
        target
      };
    });
    await saveFlow({
      ...flow,
      nodes: [...flow.nodes, ...nodes],
      edges: [...flow.edges, ...edges],
      updatedAt: now()
    });
    selectNodes(nodes.map((node) => node.id), nodes[nodes.length - 1]?.id ?? null);
  },

  deleteSelectedNode: async () => {
    const { bundle, activeFlowId, selectedNodeId, selectedNodeIds, saveFlow, selectNode } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    const selectedIds = uniqueNodeIds(selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : []);
    if (!flow || selectedIds.length === 0) return;
    const selectedIdSet = new Set(selectedIds);
    const lockedNodes = flow.nodes.filter((item) => selectedIdSet.has(item.id) && item.locked);
    if (lockedNodes.length) {
      const title = lockedNodes.length === 1 ? `"${lockedNodes[0].title}" is` : `${lockedNodes.length} selected nodes are`;
      set({ error: `${title} approved and locked. Create revisions before deleting.` });
      return;
    }
    await saveFlow({
      ...flow,
      nodes: flow.nodes.filter((item) => !selectedIdSet.has(item.id)),
      edges: flow.edges.filter((edge) => !selectedIdSet.has(edge.source) && !selectedIdSet.has(edge.target)),
      updatedAt: now()
    });
    selectNode(null);
  },

  addEdge: async (targetId) => {
    const { bundle, activeFlowId, selectedNodeId, saveFlow, rememberEdgeLabel } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    if (!flow || !selectedNodeId || selectedNodeId === targetId) return;
    if (flow.edges.some((edge) => edge.source === selectedNodeId && edge.target === targetId)) return;
    const label = "relates";
    await saveFlow({
      ...flow,
      edges: [...flow.edges, { id: uid("edge"), source: selectedNodeId, target: targetId, label }],
      updatedAt: now()
    });
    void rememberEdgeLabel(label);
  },

  rememberEdgeLabel: async (label) => {
    const { rootPath, bundle } = get();
    const nextHistory = appendEdgeLabelHistory(bundle?.project.settings.edgeLabelHistory, label);
    if (
      !bundle ||
      (
        nextHistory.length === bundle.project.settings.edgeLabelHistory.length &&
        nextHistory.every((item, index) => item === bundle.project.settings.edgeLabelHistory[index])
      )
    ) return;
    const nextSettings = {
      ...bundle.project.settings,
      edgeLabelHistory: nextHistory
    };
    if (!window.archicode) {
      set((state) => ({
        bundle: state.bundle ? { ...state.bundle, project: { ...state.bundle.project, settings: nextSettings } } : createFallbackBundle(rootPath),
        error: null
      }));
      return;
    }
    try {
      const nextBundle = await window.archicode.updateProjectSettings(rootPath, nextSettings);
      set({ bundle: nextBundle, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  updateSelectedEdge: async (label) => {
    const { bundle, activeFlowId, selectedEdgeId, saveFlow } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    if (!flow || !selectedEdgeId) return;
    await saveFlow({
      ...flow,
      edges: flow.edges.map((edge) => edge.id === selectedEdgeId ? { ...edge, label } : edge),
      updatedAt: now()
    });
  },

  updateSelectedEdgePatch: async (patch) => {
    const { bundle, activeFlowId, selectedEdgeId, saveFlow } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    if (!flow || !selectedEdgeId) return;
    await saveFlow({
      ...flow,
      edges: flow.edges.map((edge) => edge.id === selectedEdgeId ? { ...edge, ...patch } : edge),
      updatedAt: now()
    });
  },

  deleteSelectedEdge: async () => {
    const { bundle, activeFlowId, selectedEdgeId, saveFlow } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    if (!flow || !selectedEdgeId) return;
    await saveFlow({
      ...flow,
      edges: flow.edges.filter((edge) => edge.id !== selectedEdgeId),
      updatedAt: now()
    });
    set({ selectedEdgeId: null });
  },

  autoLayout: async () => {
    const { bundle, activeFlowId, activeSubflowId, applyPresentationAction } = get();
    const flow = getActiveFlow(bundle, activeFlowId);
    if (!flow) return;
    const nextFlow = autoLayoutFlow(flow, activeSubflowId);
    const nextNodesById = new Map(nextFlow.nodes.map((node) => [node.id, node]));
    const mutations: PresentationNodeMutation[] = flow.nodes.flatMap((node) => {
      const next = nextNodesById.get(node.id);
      if (!next || JSON.stringify(next.position) === JSON.stringify(node.position)) return [];
      return [{ nodeId: node.id, field: "position", expected: node.position, value: next.position }];
    });
    await applyPresentationAction("Auto-layout canvas", flow.id, mutations);
  },

  updateNode: async (patch, actor = "user") => {
    if (get().historicalInspection) {
      set({ error: "Historical graph inspection is read-only. Return to the current graph to make changes." });
      return;
    }
    const { rootPath, activeFlowId, bundle } = get();
    if (!activeFlowId) return;
    if (actor === "user" && hasActiveRun(bundle)) {
      set({ error: editingLockedMessage() });
      return;
    }
    try {
      if (!window.archicode) {
        set((state) => {
          if (!state.bundle) return state;
          const flow = state.bundle.flows.find((item) => item.id === activeFlowId);
          const node = flow?.nodes.find((item) => item.id === patch.id);
          if (!flow || !node) return state;
          const updated = applyNodePatch(node, patch, actor);
          return {
            bundle: {
              ...state.bundle,
              flows: state.bundle.flows.map((item) => item.id === flow.id
                ? { ...item, nodes: item.nodes.map((candidate) => candidate.id === updated.id ? updated : candidate) }
                : item)
            },
            error: null
          };
        });
        return;
      }
      const bundle = await window.archicode.updateNode(rootPath, activeFlowId, patch, actor);
      set({ bundle, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  showGraphChangeSetPreview: (sessionId, messageId, changeSetId, operations) => {
    set({ graphPreview: { sessionId, messageId, changeSetId, operations } });
  },
  hideGraphChangeSetPreview: () => set({ graphPreview: null })

});
