import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectBundle } from "../src/shared/schema";
import {
  readStoredGraphLocation,
  storeGraphLocation
} from "../src/renderer/src/store/graphLocation";

function bundleWithGraph(): ProjectBundle {
  return {
    project: { activeFlowId: "flow-default" },
    flows: [
      { id: "flow-default", subflows: [] },
      { id: "flow-last", subflows: [{ id: "subflow-last" }] }
    ]
  } as ProjectBundle;
}

function installLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear()
  });
  return values;
}

afterEach(() => vi.unstubAllGlobals());

describe("project graph location preferences", () => {
  it("restores the last valid flow and subflow for a project", () => {
    installLocalStorage();
    storeGraphLocation("/projects/example", "flow-last", "subflow-last");

    expect(readStoredGraphLocation("/projects/example", bundleWithGraph())).toEqual({
      activeFlowId: "flow-last",
      activeSubflowId: "subflow-last"
    });
  });

  it("falls back safely when a saved graph location was deleted", () => {
    const values = installLocalStorage();
    values.set("archicode-graph-location:/projects/example", JSON.stringify({
      activeFlowId: "flow-deleted",
      activeSubflowId: "subflow-deleted"
    }));

    expect(readStoredGraphLocation("/projects/example", bundleWithGraph())).toEqual({
      activeFlowId: "flow-default",
      activeSubflowId: null
    });
  });
});
