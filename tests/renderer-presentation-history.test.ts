import { afterEach, describe, expect, it, vi } from "vitest";
import { createSeedProject } from "../src/shared/fixtures";
import type { ArchicodeState, StoreGet, StoreSet } from "../src/renderer/src/store/types";
import { createHistorySlice } from "../src/renderer/src/store/historySlice";
import type { GraphHistoryEntry, GraphHistoryPage } from "../src/shared/graphHistory";

afterEach(() => vi.unstubAllGlobals());

describe("renderer presentation history", () => {
  it("undoes and redoes inverse fields without changing selection or viewport", async () => {
    const seed = createSeedProject("/tmp/presentation-renderer");
    const node = seed.flow.nodes[0]!;
    const bundle = {
      project: seed.project,
      flows: [seed.flow],
      notes: [],
      runs: [],
      artifacts: [],
      patchReviews: [],
      graphChanges: [],
      validationErrors: [],
      rootPath: seed.project.rootPath
    } as unknown as ArchicodeState["bundle"];
    const requests: unknown[] = [];
    vi.stubGlobal("window", {
      archicode: {
        applyPresentationPatch: vi.fn(async (_rootPath: string, request: unknown) => {
          requests.push(request);
          return { status: "applied" as const, bundle };
        })
      }
    });

    let state = {
      rootPath: seed.project.rootPath,
      bundle,
      activeFlowId: seed.flow.id,
      activeSubflowId: null,
      selectedNodeId: node.id,
      selectedNodeIds: [node.id],
      selectedEdgeId: null,
      canvasViewport: { x: 11, y: 22, zoom: 1.4 },
      canvasViewportCenter: { x: 400, y: 300 },
      presentationUndoStack: [],
      presentationRedoStack: [],
      presentationHistoryBusy: false,
      historicalInspection: null,
      error: null,
      showDirectUndoNotice: vi.fn()
    } as unknown as ArchicodeState;
    const set: StoreSet = (partial) => {
      const patch = typeof partial === "function" ? partial(state) : partial;
      state = { ...state, ...patch };
    };
    const get: StoreGet = () => state;
    Object.assign(state, createHistorySlice(set, get));
    const selectionBefore = state.selectedNodeIds;
    const viewportBefore = state.canvasViewport;
    const moved = { x: node.position.x + 90, y: node.position.y + 40 };

    await state.applyPresentationAction("Move node", seed.flow.id, [{
      nodeId: node.id,
      field: "position",
      expected: node.position,
      value: moved
    }]);
    await state.undoPresentationAction();
    await state.redoPresentationAction();

    expect(requests).toEqual([
      { flowId: seed.flow.id, mutations: [{ nodeId: node.id, field: "position", expected: node.position, value: moved }] },
      { flowId: seed.flow.id, mutations: [{ nodeId: node.id, field: "position", expected: moved, value: node.position }] },
      { flowId: seed.flow.id, mutations: [{ nodeId: node.id, field: "position", expected: node.position, value: moved }] }
    ]);
    expect(state.selectedNodeIds).toBe(selectionBefore);
    expect(state.selectedNodeId).toBe(node.id);
    expect(state.canvasViewport).toBe(viewportBefore);
    expect(state.canvasViewportCenter).toEqual({ x: 400, y: 300 });
  });

  it("merges a graph version that spans lazy history pages without renumbering it", async () => {
    const graphA = `sha256:${"a".repeat(64)}`;
    const graphB = `sha256:${"b".repeat(64)}`;
    const entry = (commit: string, graphVersion: string): GraphHistoryEntry => ({
      commit,
      shortCommit: commit.slice(0, 7),
      subject: commit,
      author: "History Test",
      committedAt: "2026-07-20T00:00:00.000Z",
      graphVersion,
      flowCount: 1,
      nodeCount: 2,
      edgeCount: 1
    });
    const firstEntries = Array.from({ length: 20 }, (_, index) => entry(`a-${index}`, graphA));
    const boundaryEntry = entry("a-older", graphA);
    const olderEntry = entry("b-older", graphB);
    const pages: GraphHistoryPage[] = [
      {
        versions: [{ graphVersion: graphA, commits: firstEntries, latest: firstEntries[0]!, versionNumber: 2 }],
        nextCursor: firstEntries.at(-1)!.commit,
        hasMore: true,
        newestVersionNumber: 2
      },
      {
        versions: [
          { graphVersion: graphA, commits: [boundaryEntry], latest: boundaryEntry },
          { graphVersion: graphB, commits: [olderEntry], latest: olderEntry }
        ],
        nextCursor: null,
        hasMore: false,
        newestVersionNumber: null
      }
    ];
    vi.stubGlobal("window", { archicode: { listGraphHistory: vi.fn(async () => pages.shift()!) } });

    let state = {
      rootPath: "/tmp/history-pages",
      graphHistory: [],
      graphHistoryCursor: null,
      graphHistoryHasMore: false,
      graphHistoryLoading: false,
      error: null
    } as unknown as ArchicodeState;
    const set: StoreSet = (partial) => {
      const statePatch = typeof partial === "function" ? partial(state) : partial;
      state = { ...state, ...statePatch };
    };
    const get: StoreGet = () => state;
    Object.assign(state, createHistorySlice(set, get));

    await state.refreshGraphHistory();
    await state.loadMoreGraphHistory();

    expect(state.graphHistory).toHaveLength(2);
    expect(state.graphHistory[0]?.commits).toHaveLength(21);
    expect(state.graphHistory.map((version) => version.versionNumber)).toEqual([2, 1]);
    expect(state.graphHistoryHasMore).toBe(false);
  });
});
