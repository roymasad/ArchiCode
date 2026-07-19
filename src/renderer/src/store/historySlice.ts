import type { ArchicodeState, StoreGet, StoreSet } from "./types";

export const createHistorySlice = (set: StoreSet, get: StoreGet): Pick<ArchicodeState,
  "toggleGraphHistory" | "refreshGraphHistory" | "inspectHistoricalGraph" | "exitHistoricalInspection"
> => ({
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
      const graphHistory = await window.archicode.listGraphHistory(rootPath);
      set({ graphHistory });
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
