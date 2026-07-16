import { describe, expect, it } from "vitest";
import { buildModuleGraph } from "../src/main/importer/aggregate";
import type { FileDependencyGraph, ParsedFile, RepoScan, ScannedFile } from "../src/main/importer/types";

function scanned(relPath: string): ScannedFile {
  const ext = relPath.slice(relPath.lastIndexOf("."));
  return { relPath, ext, sizeBytes: 0, language: ext === ".ts" ? "typescript" : null };
}

function makeInputs(filePaths: string[], edges: Array<[string, string]>) {
  const scan: RepoScan = {
    files: filePaths.map(scanned),
    truncated: false,
    stats: { totalFiles: filePaths.length, byLanguage: {} }
  };
  const parsed: ParsedFile[] = filePaths
    .filter((filePath) => filePath.endsWith(".ts"))
    .map((relPath) => ({ relPath, language: "typescript", imports: [], declaredNamespaces: [], symbols: [], exportCount: 0, loc: 10 }));
  const fileGraph: FileDependencyGraph = {
    edges: edges.map(([from, to]) => ({ from, to })),
    externalsByFile: new Map(),
    unresolved: [],
    resolutionRate: 1
  };
  return { scan, parsed, fileGraph };
}

const DEEP_REPO = [
  "src/renderer/components/Button.ts",
  "src/renderer/components/Panel.ts",
  "src/renderer/store/state.ts",
  "src/main/ipc/handlers.ts",
  "src/main/storage/files.ts",
  "docs/guide.md"
];

describe("importer aggregation", () => {
  it("creates one tier per level with subflow-compatible parent chains", () => {
    const inputs = makeInputs(DEEP_REPO, [["src/renderer/store/state.ts", "src/main/storage/files.ts"]]);
    const graph = buildModuleGraph({ ...inputs, levels: "3", detail: "balanced", granularity: "component" });
    const tiers = new Set(graph.clusters.map((cluster) => cluster.tier));
    // Level 3 reaches per-file components via the flat-directory fallback.
    expect([...tiers].sort()).toEqual([1, 2, 3]);
    const tierThree = graph.clusters.filter((cluster) => cluster.tier === 3);
    expect(tierThree.every((cluster) => cluster.files.length === 1)).toBe(true);
    // src/renderer and src/main split into areas; docs stays a leaf area.
    const tierOnePaths = graph.clusters.filter((cluster) => cluster.tier === 1).map((cluster) => cluster.path).sort();
    expect(tierOnePaths).toEqual(["docs", "src/main", "src/renderer"]);
    const tierTwo = graph.clusters.filter((cluster) => cluster.tier === 2);
    for (const cluster of tierTwo) {
      expect(cluster.parentClusterId).toBeDefined();
    }
    const tierTwoPaths = tierTwo.map((cluster) => cluster.path).sort();
    expect(tierTwoPaths).toEqual(["src/main/ipc", "src/main/storage", "src/renderer/components", "src/renderer/store"]);
  });

  it("stops splitting at the system granularity floor", () => {
    const inputs = makeInputs(DEEP_REPO, []);
    const graph = buildModuleGraph({ ...inputs, levels: "4", detail: "deep", granularity: "system" });
    expect(graph.clusters.every((cluster) => cluster.tier === 1)).toBe(true);
  });

  it("expands the final tier to files at file granularity", () => {
    const inputs = makeInputs(DEEP_REPO, []);
    const graph = buildModuleGraph({ ...inputs, levels: "2", detail: "deep", granularity: "file" });
    const tierTwo = graph.clusters.filter((cluster) => cluster.tier === 2);
    expect(tierTwo.length).toBeGreaterThan(0);
    expect(tierTwo.every((cluster) => cluster.unit === "file" && cluster.files.length === 1)).toBe(true);
  });

  it("aggregates edge weights from file edges and skips intra-cluster edges", () => {
    const inputs = makeInputs(DEEP_REPO, [
      ["src/renderer/components/Button.ts", "src/main/ipc/handlers.ts"],
      ["src/renderer/store/state.ts", "src/main/storage/files.ts"],
      ["src/renderer/components/Button.ts", "src/renderer/components/Panel.ts"]
    ]);
    inputs.fileGraph.edges[0].importedNames = ["registerHandler"];
    inputs.fileGraph.edges[0].evidence = [{ line: 4, specifier: "../main/ipc/handlers" }];
    inputs.fileGraph.edges[0].relationKinds = ["dependency"];
    const graph = buildModuleGraph({ ...inputs, levels: "1", detail: "balanced", granularity: "system" });
    const edge = graph.edges.find((item) => item.source === "cluster-src-renderer" && item.target === "cluster-src-main");
    expect(edge?.importCount).toBe(2);
    expect(edge?.sampleImports.length).toBeGreaterThan(0);
    expect(edge?.importedNames).toContain("registerHandler");
    expect(edge?.evidence).toContainEqual(expect.objectContaining({ from: "src/renderer/components/Button.ts", line: 4, specifier: "../main/ipc/handlers" }));
    // Button -> Panel is inside src/renderer and must not create a self edge.
    expect(graph.edges.some((item) => item.source === item.target)).toBe(false);
  });

  it("merges overflow areas into a support cluster under light detail", () => {
    const manyTops = Array.from({ length: 14 }, (_, index) => `dir${String(index).padStart(2, "0")}/file.ts`);
    const inputs = makeInputs(manyTops, []);
    const graph = buildModuleGraph({ ...inputs, levels: "1", detail: "light", granularity: "system" });
    const tierOne = graph.clusters.filter((cluster) => cluster.tier === 1);
    expect(tierOne.length).toBeLessThanOrEqual(8);
    const support = tierOne.find((cluster) => cluster.title === "Support & Scripts");
    expect(support).toBeDefined();
    const totalFiles = tierOne.reduce((sum, cluster) => sum + cluster.files.length, 0);
    expect(totalFiles).toBe(manyTops.length);
  });

  it("retains ranked symbols for clusters larger than sixteen files", () => {
    const files = Array.from({ length: 20 }, (_, index) => `src/feature/file-${index}.ts`);
    const inputs = makeInputs(files, files.slice(1).map((file) => ["src/feature/file-0.ts", file] as [string, string]));
    inputs.parsed[0].symbols = ["FeatureCoordinator"];
    inputs.parsed[0].symbolRefs = [{ name: "FeatureCoordinator", kind: "class" }];
    const graph = buildModuleGraph({ ...inputs, levels: "1", detail: "balanced", granularity: "system" });
    const feature = graph.clusters.find((cluster) => cluster.files.includes("src/feature/file-0.ts"));
    expect(feature?.symbols).toContain("FeatureCoordinator");
    expect(feature?.symbolRefs).toContainEqual({ path: "src/feature/file-0.ts", name: "FeatureCoordinator", kind: "class" });
  });
});
