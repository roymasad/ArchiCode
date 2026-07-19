import type { GraphHistoryVersion } from "@shared/graphHistory";
import type { PresentationNodeMutation } from "@shared/schema";
import type { ArchicodeState, PresentationHistoryEntry, StoreGet, StoreSet } from "./types";

const PRESENTATION_HISTORY_LIMIT = 50;
const BLOCKING_RUN_STATUSES = new Set([
  "preparing", "queued", "needs-permission", "running", "planning", "awaiting-plan-review",
  "coding", "awaiting-code-review", "debugging", "needs-replan", "verifying"
]);

function hasActiveRun(bundle: ArchicodeState["bundle"]): boolean {
  return Boolean(bundle?.runs.some((run) => BLOCKING_RUN_STATUSES.has(run.status)));
}

function editingLockedMessage(): string {
  return "Graph editing is locked while a run is active or waiting for review.";
}

function reversePresentationMutation(mutation: PresentationNodeMutation): PresentationNodeMutation {
  if (mutation.field === "position") {
    return { ...mutation, expected: mutation.value, value: mutation.expected };
  }
  if (mutation.field === "size") {
    return { ...mutation, expected: mutation.value, value: mutation.expected };
  }
  return { ...mutation, expected: mutation.value, value: mutation.expected };
}

function isInvalidatedHistoryMessage(message: string | undefined): boolean {
  return Boolean(message && !message.startsWith("Presentation history is unavailable while a run"));
}

function appendGraphHistory(current: GraphHistoryVersion[], incoming: GraphHistoryVersion[]): GraphHistoryVersion[] {
  const merged = current.map((version) => ({ ...version, commits: [...version.commits] }));
  for (const version of incoming) {
    const previous = merged.at(-1);
    if (previous?.graphVersion === version.graphVersion) {
      previous.commits.push(...version.commits);
      continue;
    }
    merged.push({
      ...version,
      commits: [...version.commits],
      versionNumber: version.versionNumber ?? (previous?.versionNumber ? previous.versionNumber - 1 : undefined)
    });
  }
  return merged;
}

export const createHistorySlice = (set: StoreSet, get: StoreGet): Pick<ArchicodeState,
  "toggleGraphHistory" | "refreshGraphHistory" | "loadMoreGraphHistory" | "inspectHistoricalGraph" | "exitHistoricalInspection" |
  "applyPresentationAction" | "undoPresentationAction" | "redoPresentationAction" | "clearPresentationHistory"
> => ({
  applyPresentationAction: async (label, flowId, mutations) => {
    const effectiveMutations = mutations.filter((mutation) =>
      JSON.stringify(mutation.expected) !== JSON.stringify(mutation.value));
    const state = get();
    if (!effectiveMutations.length) return true;
    if (state.presentationHistoryBusy || state.historicalInspection) return false;
    if (hasActiveRun(state.bundle)) {
      set({ error: editingLockedMessage() });
      return false;
    }
    const entry: PresentationHistoryEntry = {
      id: `presentation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      projectRoot: state.rootPath,
      flowId,
      label,
      mutations: effectiveMutations
    };
    if (!window.archicode?.applyPresentationPatch) return false;
    set({ presentationHistoryBusy: true, error: null });
    try {
      const result = await window.archicode.applyPresentationPatch(state.rootPath, { flowId, mutations: effectiveMutations });
      if (result.status === "conflict") {
        set({ bundle: result.bundle, error: result.message ?? "The presentation action conflicted with a newer graph change." });
        return false;
      }
      set((current) => ({
        bundle: result.bundle,
        presentationUndoStack: [...current.presentationUndoStack, entry].slice(-PRESENTATION_HISTORY_LIMIT),
        presentationRedoStack: [],
        error: null
      }));
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ presentationHistoryBusy: false });
    }
  },

  undoPresentationAction: async () => {
    const state = get();
    const entry = state.presentationUndoStack.at(-1);
    if (!entry) {
      state.showDirectUndoNotice();
      return;
    }
    if (state.presentationHistoryBusy || state.historicalInspection) return;
    if (hasActiveRun(state.bundle)) {
      set({ error: editingLockedMessage() });
      return;
    }
    if (entry.projectRoot !== state.rootPath || !window.archicode?.applyPresentationPatch) {
      get().clearPresentationHistory();
      return;
    }
    set({ presentationHistoryBusy: true, error: null });
    try {
      const result = await window.archicode.applyPresentationPatch(state.rootPath, {
        flowId: entry.flowId,
        mutations: entry.mutations.map(reversePresentationMutation)
      });
      if (result.status === "conflict") {
        set((current) => ({
          bundle: result.bundle,
          presentationUndoStack: isInvalidatedHistoryMessage(result.message)
            ? current.presentationUndoStack.slice(0, -1)
            : current.presentationUndoStack,
          error: result.message ?? `Cannot undo ${entry.label.toLocaleLowerCase()} because the canvas changed.`
        }));
        return;
      }
      set((current) => ({
        bundle: result.bundle,
        presentationUndoStack: current.presentationUndoStack.slice(0, -1),
        presentationRedoStack: [...current.presentationRedoStack, entry].slice(-PRESENTATION_HISTORY_LIMIT),
        error: null
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ presentationHistoryBusy: false });
    }
  },

  redoPresentationAction: async () => {
    const state = get();
    const entry = state.presentationRedoStack.at(-1);
    if (!entry || state.presentationHistoryBusy || state.historicalInspection) return;
    if (hasActiveRun(state.bundle)) {
      set({ error: editingLockedMessage() });
      return;
    }
    if (entry.projectRoot !== state.rootPath || !window.archicode?.applyPresentationPatch) {
      get().clearPresentationHistory();
      return;
    }
    set({ presentationHistoryBusy: true, error: null });
    try {
      const result = await window.archicode.applyPresentationPatch(state.rootPath, {
        flowId: entry.flowId,
        mutations: entry.mutations
      });
      if (result.status === "conflict") {
        set((current) => ({
          bundle: result.bundle,
          presentationRedoStack: isInvalidatedHistoryMessage(result.message)
            ? current.presentationRedoStack.slice(0, -1)
            : current.presentationRedoStack,
          error: result.message ?? `Cannot redo ${entry.label.toLocaleLowerCase()} because the canvas changed.`
        }));
        return;
      }
      set((current) => ({
        bundle: result.bundle,
        presentationUndoStack: [...current.presentationUndoStack, entry].slice(-PRESENTATION_HISTORY_LIMIT),
        presentationRedoStack: current.presentationRedoStack.slice(0, -1),
        error: null
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ presentationHistoryBusy: false });
    }
  },

  clearPresentationHistory: () => set({
    presentationUndoStack: [],
    presentationRedoStack: [],
    presentationHistoryBusy: false
  }),

  toggleGraphHistory: () => {
    const nextOpen = !get().graphHistoryOpen;
    set({ graphHistoryOpen: nextOpen });
    if (nextOpen && !get().graphHistory.length) void get().refreshGraphHistory();
  },

  refreshGraphHistory: async () => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode?.listGraphHistory) return;
    set({ graphHistoryLoading: true, error: null });
    try {
      const page = await window.archicode.listGraphHistory(rootPath, { limit: 20 });
      set({
        graphHistory: page.versions,
        graphHistoryCursor: page.nextCursor,
        graphHistoryHasMore: page.hasMore
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ graphHistoryLoading: false });
    }
  },

  loadMoreGraphHistory: async () => {
    const { rootPath, graphHistoryCursor, graphHistoryHasMore, graphHistoryLoading } = get();
    if (!rootPath || !graphHistoryCursor || !graphHistoryHasMore || graphHistoryLoading || !window.archicode?.listGraphHistory) return;
    set({ graphHistoryLoading: true, error: null });
    try {
      const page = await window.archicode.listGraphHistory(rootPath, { cursor: graphHistoryCursor, limit: 20 });
      set((current) => ({
        graphHistory: appendGraphHistory(current.graphHistory, page.versions),
        graphHistoryCursor: page.nextCursor,
        graphHistoryHasMore: page.hasMore
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ graphHistoryLoading: false });
    }
  },

  inspectHistoricalGraph: async (commit) => {
    const { rootPath, bundle, historicalInspection } = get();
    if (!rootPath || !bundle || !window.archicode?.loadHistoricalGraph) return;
    set({ graphHistoryLoading: true, error: null });
    try {
      const historical = await window.archicode.loadHistoricalGraph(rootPath, commit);
      const currentBundle = historicalInspection?.currentBundle ?? bundle;
      const { activeFlowId, activeSubflowId, canvasViewport, canvasViewportCenter } = get();
      const preferredFlowId = historical.bundle.flows.some((flow) => flow.id === activeFlowId)
        ? activeFlowId
        : historical.bundle.flows.some((flow) => flow.id === historical.bundle.project.activeFlowId)
          ? historical.bundle.project.activeFlowId
          : historical.bundle.flows[0]?.id ?? null;
      const preferredFlow = historical.bundle.flows.find((flow) => flow.id === preferredFlowId);
      const preferredSubflowId = activeSubflowId && preferredFlow?.subflows.some((subflow) => subflow.id === activeSubflowId)
        ? activeSubflowId
        : null;
      const sameCanvasScope = preferredFlowId === activeFlowId && preferredSubflowId === activeSubflowId;
      set({
        bundle: historical.bundle,
        historicalInspection: { entry: historical.entry, currentBundle },
        activeFlowId: preferredFlowId,
        activeSubflowId: preferredSubflowId,
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedEdgeId: null,
        presentationUndoStack: [],
        presentationRedoStack: [],
        workbenchView: "graph",
        fileBrowser: null,
        selectedFilePath: null,
        filePreviewRequest: null,
        filePreview: null,
        fileDiff: null,
        canvasViewport: sameCanvasScope ? canvasViewport : null,
        canvasViewportCenter: sameCanvasScope ? canvasViewportCenter : null
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ graphHistoryLoading: false });
    }
  },

  exitHistoricalInspection: async () => {
    const inspection = get().historicalInspection;
    if (!inspection) return;
    set({ graphHistoryLoading: true, error: null });
    try {
      const bundle = window.archicode
        ? await window.archicode.loadProject(get().rootPath)
        : inspection.currentBundle;
      const { activeFlowId: currentFlowId, activeSubflowId, canvasViewport, canvasViewportCenter } = get();
      const activeFlowId = bundle.flows.some((flow) => flow.id === currentFlowId)
        ? currentFlowId
        : bundle.project.activeFlowId;
      const activeFlow = bundle.flows.find((flow) => flow.id === activeFlowId);
      const nextSubflowId = activeSubflowId && activeFlow?.subflows.some((subflow) => subflow.id === activeSubflowId)
        ? activeSubflowId
        : null;
      const sameCanvasScope = activeFlowId === currentFlowId && nextSubflowId === activeSubflowId;
      set({
        bundle,
        historicalInspection: null,
        activeFlowId,
        activeSubflowId: nextSubflowId,
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedEdgeId: null,
        presentationUndoStack: [],
        presentationRedoStack: [],
        canvasViewport: sameCanvasScope ? canvasViewport : null,
        canvasViewportCenter: sameCanvasScope ? canvasViewportCenter : null,
        fileBrowser: null,
        selectedFilePath: null,
        filePreviewRequest: null,
        filePreview: null,
        fileDiff: null,
        workbenchView: "graph"
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ graphHistoryLoading: false });
    }
  }
});
