import { describe, expect, it, vi } from "vitest";
import type { ArchicodeState, StoreGet, StoreSet } from "../src/renderer/src/store/types";
import { guardHistoricalMutations, historicalMutationActions, historicalMutationMessage } from "../src/renderer/src/store/historicalGuard";

describe("historical inspection mutation guard", () => {
  it("blocks every registered mutation while leaving read-only navigation available", async () => {
    const invoked: string[] = [];
    const set = vi.fn() as unknown as StoreSet;
    const state = {
      historicalInspection: { entry: { commit: "abc123" }, currentBundle: {} },
      setActiveFlow: () => invoked.push("setActiveFlow")
    } as unknown as ArchicodeState;
    for (const action of historicalMutationActions) {
      (state as unknown as Record<string, unknown>)[action] = () => invoked.push(action);
    }
    const get = (() => state) as StoreGet;
    guardHistoricalMutations(state, set, get);

    for (const action of historicalMutationActions) {
      await ((state as unknown as Record<string, (...args: unknown[]) => unknown>)[action])();
    }
    state.setActiveFlow("flow-history");

    expect(invoked).toEqual(["setActiveFlow"]);
    expect(set).toHaveBeenCalledTimes(historicalMutationActions.length);
    expect(set).toHaveBeenLastCalledWith({ error: historicalMutationMessage });
  });
});
