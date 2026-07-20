import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFileDependencyGraph } from "../src/main/importer/fileGraph";
import { refreshProjectGraphEvidence } from "../src/main/importer/evidenceRefresh";
import { buildCodeKnowledgeSnapshot, codeKnowledgeSnapshotNeedsRefresh, readCodeKnowledgeSnapshot, writeCodeKnowledgeSnapshot } from "../src/main/importer/knowledgeSnapshot";
import { parseFiles } from "../src/main/importer/parsers";
import { scanRepository } from "../src/main/importer/scanner";
import { ensureFixtureProject } from "../src/main/storage/projectStore";
import { codeKnowledgeImpact, queryCodeKnowledgeSnapshot, shortestCodeKnowledgePath } from "../src/shared/codeKnowledge";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("local code knowledge snapshot", () => {
  it("preserves file dependencies, symbols, uniquely resolved calls, and local persistence", async () => {
    const projectRoot = path.resolve(process.cwd(), "fixtures/importer/ts-app");
    const scan = await scanRepository(projectRoot);
    const parsed = await parseFiles(projectRoot, scan.files);
    const fileGraph = await buildFileDependencyGraph(projectRoot, scan, parsed);
    const snapshot = buildCodeKnowledgeSnapshot({ scan, parsed, fileGraph, source: "codebase-import" });

    expect(snapshot.stats.files).toBe(4);
    expect(snapshot.stats.symbols).toBeGreaterThanOrEqual(4);
    expect(snapshot.stats.dependencies).toBe(fileGraph.edges.length);
    expect(snapshot.stats.calls).toBeGreaterThan(0);
    expect(snapshot.stats.truncated).toBe(false);
    const dependencyPairs = new Set(snapshot.edges.filter((edge) => edge.kind === "dependency").map((edge) => {
      const source = snapshot.nodes.find((node) => node.id === edge.source)?.path;
      const target = snapshot.nodes.find((node) => node.id === edge.target)?.path;
      return `${source} -> ${target}`;
    }));
    for (const edge of fileGraph.edges) expect(dependencyPairs).toContain(`${edge.from} -> ${edge.to}`);

    const boot = snapshot.nodes.find((node) => node.kind === "symbol" && node.label === "boot");
    const startFile = snapshot.nodes.find((node) => node.kind === "file" && node.path === "src/index.ts");
    expect(boot && startFile).toBeTruthy();
    expect(shortestCodeKnowledgePath(snapshot, startFile!.id, boot!.id)).not.toBeNull();
    expect(codeKnowledgeImpact(snapshot, boot!.id)).toContain(startFile!.id);
    expect(queryCodeKnowledgeSnapshot(snapshot, { action: "search", query: "boot", maxResults: 5 })).toMatchObject({ action: "search", limit: 5 });
    expect(queryCodeKnowledgeSnapshot(snapshot, { action: "neighbors", source: "src/index.ts", maxResults: 5, maxDepth: 1 })).toMatchObject({ action: "neighbors", bounded: true, limit: 5 });
    expect(queryCodeKnowledgeSnapshot(snapshot, { action: "path", source: "src/index.ts", target: "boot" })).toMatchObject({ action: "path", found: true, bounded: true });
    expect(queryCodeKnowledgeSnapshot(snapshot, { action: "impact", source: "boot", maxResults: 5 })).toMatchObject({ action: "impact", bounded: true, limit: 5 });

    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-code-knowledge-"));
    roots.push(root);
    await writeCodeKnowledgeSnapshot(root, snapshot);
    expect(await readCodeKnowledgeSnapshot(root)).toEqual(snapshot);
  }, 30_000);

  it("enforces the local rendering/storage node cap", () => {
    const files = Array.from({ length: 7000 }, (_, index) => ({ relPath: `src/f${index}.ts`, ext: ".ts", sizeBytes: 1, language: "typescript" as const }));
    const snapshot = buildCodeKnowledgeSnapshot({
      scan: { files, truncated: false, stats: { totalFiles: files.length, byLanguage: { typescript: files.length } } },
      parsed: [],
      fileGraph: { edges: [], externalsByFile: new Map(), unresolved: [], resolutionRate: 1 },
      source: "evidence-refresh"
    });
    expect(snapshot.nodes).toHaveLength(6000);
    expect(snapshot.stats.availableNodes).toBe(7000);
    expect(snapshot.stats.truncated).toBe(true);
    const bounded = queryCodeKnowledgeSnapshot(snapshot, { action: "search", query: "f", maxResults: 500 }) as { nodes: unknown[]; limit: number };
    expect(bounded.limit).toBe(40);
    expect(bounded.nodes).toHaveLength(40);
  });

  it("detects changed source snapshots without reading them into model context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-code-freshness-"));
    roots.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
    const generatedAtMs = Date.now() + 1000;
    const snapshot = buildCodeKnowledgeSnapshot({
      scan: { files: [{ relPath: "src/a.ts", ext: ".ts", sizeBytes: 20, language: "typescript" }], truncated: false, stats: { totalFiles: 1, byLanguage: { typescript: 1 } } },
      parsed: [],
      fileGraph: { edges: [], externalsByFile: new Map(), unresolved: [], resolutionRate: 1 },
      source: "evidence-refresh",
      generatedAt: new Date(generatedAtMs).toISOString()
    });
    expect(await codeKnowledgeSnapshotNeedsRefresh(root, snapshot)).toBe(false);
    const changedAt = new Date(generatedAtMs + 5000);
    await utimes(path.join(root, "src/a.ts"), changedAt, changedAt);
    expect(await codeKnowledgeSnapshotNeedsRefresh(root, snapshot)).toBe(true);
  });

  it("refreshes Code Knowledge without rewriting architecture flows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-code-only-refresh-"));
    roots.push(root);
    await ensureFixtureProject(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/main.ts"), "export const ready = true;\n", "utf8");
    const flowPath = path.join(root, ".archicode", "flows", "flow-main.json");
    const before = await readFile(flowPath, "utf8");

    const result = await refreshProjectGraphEvidence(root, {
      refreshCodeKnowledge: true,
      refreshCodeKnowledgeOnly: true
    });

    expect(result.refreshedEdges).toBe(0);
    expect((await readCodeKnowledgeSnapshot(root))?.stats.files).toBeGreaterThan(0);
    expect(await readFile(flowPath, "utf8")).toBe(before);
  }, 30_000);
});
