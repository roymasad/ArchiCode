import { describe, expect, it } from "vitest";
import { coherentClusterTitles, lintedEdgeLabel } from "../src/main/importer/coherence";
import type { ModuleCluster } from "../src/main/importer/types";

function cluster(partial: Partial<ModuleCluster> & { id: string; title: string }): ModuleCluster {
  return {
    path: partial.id,
    unit: "component",
    tier: partial.parentClusterId ? 2 : 1,
    files: [],
    loc: 0,
    languages: [],
    topFiles: [],
    externalDeps: [],
    docTitles: [],
    symbols: [],
    ...partial
  };
}

describe("zoom title coherence", () => {
  it("rebuilds a child title that echoes its parent from its distinguishing words", () => {
    const clusters = [
      cluster({ id: "parent", title: "Progress, Rewards & Export" }),
      cluster({ id: "child", title: "Progress Metrics, Rewards & Export Services", parentClusterId: "parent", topFiles: ["lib/helpers/statistics_helper.dart"] })
    ];
    const titles = coherentClusterTitles(clusters, (item) => item.title);
    expect(titles.get("parent")).toBe("Progress, Rewards & Export");
    const child = titles.get("child") as string;
    expect(child.toLowerCase()).not.toContain("progress");
    expect(child.toLowerCase()).not.toContain("rewards");
    expect(child.toLowerCase()).toContain("metrics");
  });

  it("falls back to the dominant file when no distinguishing words remain", () => {
    const clusters = [
      cluster({ id: "parent", title: "Report API & Generation Orchestration" }),
      cluster({ id: "child", title: "Report API Server Orchestration", parentClusterId: "parent", topFiles: ["backend/pro-ai-service/src/server.ts"] })
    ];
    const titles = coherentClusterTitles(clusters, (item) => item.title);
    const child = titles.get("child") as string;
    expect(child).not.toBe("Report API Server Orchestration");
    expect(child.toLowerCase()).toContain("server");
    expect(child.toLowerCase()).not.toContain("report api");
  });

  it("keeps non-echoing children untouched", () => {
    const clusters = [
      cluster({ id: "parent", title: "Mocha Companion" }),
      cluster({ id: "child", title: "Animation Frames", parentClusterId: "parent" })
    ];
    const titles = coherentClusterTitles(clusters, (item) => item.title);
    expect(titles.get("child")).toBe("Animation Frames");
  });

  it("disambiguates a sibling whose title is a subset of another sibling's", () => {
    const clusters = [
      cluster({ id: "parent", title: "Persistence Layer" }),
      cluster({ id: "a", title: "Trial Entitlement State", parentClusterId: "parent", topFiles: ["lib/model/trial_status.dart"] }),
      cluster({ id: "b", title: "Purchase & Trial Entitlement State", parentClusterId: "parent", topFiles: ["lib/providers/purchase_provider.dart"] })
    ];
    const titles = coherentClusterTitles(clusters, (item) => item.title);
    expect(titles.get("a")).toBe("Trial Entitlement State (trial_status.dart)");
    expect(titles.get("b")).toBe("Purchase & Trial Entitlement State");
  });
});

describe("edge label lint", () => {
  it("rejects labels ending mid-thought", () => {
    expect(lintedEdgeLabel("accesses trusted device contacts through")).toBeNull();
    expect(lintedEdgeLabel("renders state from")).toBeNull();
    expect(lintedEdgeLabel("syncs backups to")).toBeNull();
    expect(lintedEdgeLabel("validates and")).toBeNull();
    expect(lintedEdgeLabel("  ")).toBeNull();
  });

  it("keeps complete phrases and trims punctuation", () => {
    expect(lintedEdgeLabel("requests report APIs over HTTP")).toBe("requests report APIs over HTTP");
    expect(lintedEdgeLabel("loads validated reports.")).toBe("loads validated reports");
    expect(lintedEdgeLabel("checks entitlement and reserves usage")).toBe("checks entitlement and reserves usage");
  });
});
