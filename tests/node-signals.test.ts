import { describe, expect, it } from "vitest";
import type { ProjectBundle } from "../src/shared/schema";
import { getNodeSignalCounts, nodePolicyViolationTooltip } from "../src/renderer/src/utils/nodeSignals";

describe("node signal counts", () => {
  it("uses the detailed architecture-issue guidance for policy badges", () => {
    expect(nodePolicyViolationTooltip(1)).toBe("1 deterministic architecture violation. Open the architecture issues button for details.");
    expect(nodePolicyViolationTooltip(2)).toBe("2 deterministic architecture violations. Open the architecture issues button for details.");
  });

  it("counts pinned notes only in the current flow when node identities are reused", () => {
    const note = {
      kind: "user-note" as const,
      author: "user" as const,
      body: "Durable context",
      category: "note" as const,
      priority: "normal" as const,
      attachmentIds: [],
      resolved: false,
      pinned: true,
      createdAt: "2026-07-13T00:00:00.000Z"
    };
    const bundle = {
      notes: [
        { ...note, id: "note-a", flowId: "flow-a", nodeId: "shared-node" },
        { ...note, id: "note-b", flowId: "flow-b", nodeId: "shared-node" }
      ],
      artifacts: []
    } as unknown as ProjectBundle;

    expect(getNodeSignalCounts(bundle, "shared-node", "flow-a").pinnedNotes).toBe(1);
    expect(getNodeSignalCounts(bundle, "shared-node").pinnedNotes).toBe(2);
  });
});
