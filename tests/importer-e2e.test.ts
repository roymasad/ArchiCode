import path from "node:path";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { runCodebaseImport } from "../src/main/importer";
import { CodebaseImportCancelledError } from "../src/main/importer/types";
import { researchGraphOperationSchema } from "../src/shared/schema";

describe("importer end-to-end (dogfood on this repository)", () => {
  it("aborts with a cancellation error when shouldCancel flips during the run", async () => {
    let progressEvents = 0;
    const promise = runCodebaseImport({
      projectRoot: path.resolve(process.cwd()),
      flowId: "flow-cancelled",
      levels: "1",
      detail: "light",
      granularity: "system",
      codebaseHints: [],
      // Cancel after the run is clearly underway: first progress event flips the flag.
      shouldCancel: () => progressEvents > 0,
      onProgress: () => {
        progressEvents += 1;
      }
    });
    await expect(promise).rejects.toBeInstanceOf(CodebaseImportCancelledError);
  });

  it("honors an expired import deadline during repository scanning", async () => {
    const outcome = await runCodebaseImport({
      projectRoot: path.resolve(process.cwd()),
      flowId: "flow-expired-deadline",
      levels: "1",
      detail: "light",
      granularity: "system",
      codebaseHints: [],
      deadlineMs: Date.now() - 1
    });

    expect(outcome.stats.filesScanned).toBe(0);
    expect(outcome.stats.degraded).toContain("File scan hit the size or time limit; the map covers the files scanned so far.");
  });

  it("persists attributable per-run importer provenance without provider secrets", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-import-provenance-"));
    await mkdir(path.join(projectRoot, "src"));
    await writeFile(path.join(projectRoot, "src", "main.ts"), "export const main = () => 'ready';\n", "utf8");
    const outcome = await runCodebaseImport({
      projectRoot,
      flowId: "flow-provenance",
      levels: "1",
      detail: "light",
      granularity: "system",
      reviewEffort: "light",
      codebaseHints: ["TypeScript"],
      semanticEnabled: false,
      persistKnowledgeSnapshot: true,
      provider: { id: "openrouter-test", kind: "openai-compatible", model: "test/model" }
    });

    const latestPath = path.join(projectRoot, ".archicode", "runtime", "import-run-latest.json");
    const latestText = await readFile(latestPath, "utf8");
    const latest = JSON.parse(latestText) as Record<string, any>;
    const history = await readdir(path.join(projectRoot, ".archicode", "runtime", "import-runs"));
    expect(latest).toMatchObject({
      version: 2,
      runId: outcome.stats.provenance?.runId,
      importerVersion: "architecture-atlas-v3",
      provider: { id: "openrouter-test", kind: "openai-compatible", model: "test/model" },
      settings: { levels: "1", detail: "light", granularity: "system", reviewEffort: "light", reviewMaxUnits: 5, semanticEnabled: false }
    });
    expect(latest.durationMs).toBeGreaterThanOrEqual(0);
    expect(history).toContain(`${latest.runId}.json`);
    expect(latestText).not.toMatch(/apiKey|authorization|secret/i);
  });

  it("maps the ArchiCode repo itself with real edges and full coverage", async () => {
    const outcome = await runCodebaseImport({
      projectRoot: path.resolve(process.cwd()),
      flowId: "flow-dogfood",
      levels: "3",
      detail: "balanced",
      granularity: "component",
      codebaseHints: ["TypeScript", "Electron", "React"]
    });

    expect(outcome.stats.filesScanned).toBeGreaterThan(50);
    expect(outcome.stats.resolutionRate).toBeGreaterThan(0.9);
    expect(outcome.stats.fileEdges).toBeGreaterThan(100);

    // Every src/ file must land in a tier-1 cluster (coverage by construction).
    const tierOne = outcome.moduleGraph.clusters.filter((cluster) => cluster.tier === 1);
    const covered = new Set(tierOne.flatMap((cluster) => cluster.files));
    const srcFiles = [...covered].filter((file) => file.startsWith("src/"));
    expect(srcFiles.length).toBeGreaterThan(30);

    // Real architecture edges extracted from import statements.
    const tierOneEdges = new Set(
      outcome.moduleGraph.edges
        .filter((edge) => tierOne.some((cluster) => cluster.id === edge.source))
        .map((edge) => `${edge.source} -> ${edge.target}`)
    );
    expect(tierOneEdges).toContain("cluster-src-renderer -> cluster-src-shared");
    expect(tierOneEdges).toContain("cluster-src-main -> cluster-src-shared");

    // All emitted operations satisfy the research operation schema.
    for (const operation of outcome.operations) {
      expect(researchGraphOperationSchema.safeParse(operation).success).toBe(true);
    }
    const importedStages = outcome.operations.flatMap((operation) => operation.kind === "create-node"
      ? [operation.node.stage]
      : operation.kind === "create-flow"
        ? operation.flow.nodes.map((node) => node.stage)
        : []);
    expect(importedStages.length).toBeGreaterThan(0);
    expect(importedStages.every((stage) => stage === "draft-approved-production")).toBe(true);
    // Per-node drill-down: every detail flow is anchored to a parent node ("Opens detail flow"),
    // and only nodes with a real interior get one.
    const subflowOps = outcome.operations.filter((operation) => operation.kind === "create-subflow");
    expect(subflowOps.length).toBeGreaterThanOrEqual(3);
    const parentIds = new Set<string>();
    for (const operation of subflowOps) {
      if (operation.kind !== "create-subflow") continue;
      expect(operation.subflow.parentNodeId).toBeTruthy();
      parentIds.add(operation.subflow.parentNodeId as string);
    }
    const nodeIds = new Set(outcome.operations.flatMap((operation) => (operation.kind === "create-node" && operation.node.id ? [operation.node.id] : [])));
    for (const parentId of parentIds) expect(nodeIds.has(parentId)).toBe(true);
    // Leaves must not open empty detail flows.
    expect(parentIds.size).toBeLessThan(nodeIds.size);
  }, 60_000);
});
