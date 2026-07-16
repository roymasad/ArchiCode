import { describe, expect, it } from "vitest";
import {
  mergeProjectMaintenanceChanges,
  projectMaintenanceChangesBetweenHashes
} from "../src/shared/projectMaintenance";

describe("project maintenance drift facts", () => {
  it("classifies exact added, modified, and deleted source paths", () => {
    const baseline = new Map([
      ["src/deleted.ts", "old-delete"],
      ["src/modified.ts", "old-modified"],
      ["src/stable.ts", "same"]
    ]);
    const current = new Map([
      ["src/added.ts", "new-add"],
      ["src/modified.ts", "new-modified"],
      ["src/stable.ts", "same"]
    ]);

    expect(projectMaintenanceChangesBetweenHashes(baseline, current)).toEqual([
      { path: "src/added.ts", change: "added" },
      { path: "src/deleted.ts", change: "deleted" },
      { path: "src/modified.ts", change: "modified" }
    ]);
  });

  it("merges repeated warning batches without duplicating paths", () => {
    expect(mergeProjectMaintenanceChanges(
      [
        { path: "src/added.ts", change: "added" },
        { path: "src/changed.ts", change: "modified" }
      ],
      [
        { path: "src/added.ts", change: "modified" },
        { path: "src/changed.ts", change: "deleted" }
      ]
    )).toEqual([
      { path: "src/added.ts", change: "added" },
      { path: "src/changed.ts", change: "deleted" }
    ]);
  });
});
