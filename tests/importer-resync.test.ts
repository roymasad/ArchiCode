import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCodebaseImport } from "../src/main/importer";
import { createResyncBaseline, graphEntityFingerprint, readResyncBaseline, writeResyncBaseline } from "../src/main/importer/resyncBaseline";
import { runCodebaseResync } from "../src/main/importer/resync";
import { readResyncReports } from "../src/main/importer/resyncReports";
import { ensureEmptyCodebaseProject, loadProject, saveFlow, saveFlows } from "../src/main/storage/projectStore";
import { enrichImportedNodes, materializeCodebaseMapOperations } from "../src/main/research";
import type { ArchicodeNode, Flow, ProjectBundle } from "../src/shared/schema";

const roots: string[] = [];

async function writeSource(root: string, relativePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), contents, "utf8");
}

async function createImportedProject(files: Record<string, string>): Promise<{ root: string; bundle: ProjectBundle }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "archicode-resync-"));
  roots.push(root);
  await Promise.all(Object.entries(files).map(([relativePath, contents]) => writeSource(root, relativePath, contents)));
  const seed = await ensureEmptyCodebaseProject(root);
  const outcome = await runCodebaseImport({
    projectRoot: root,
    flowId: seed.project.activeFlowId,
    levels: "4",
    detail: "deep",
    reviewEffort: "light",
    granularity: "file",
    codebaseHints: [],
    semanticEnabled: false,
    persistKnowledgeSnapshot: false,
    reviewEnabled: false
  });
  const materialized = materializeCodebaseMapOperations(seed, outcome.operations);
  await saveFlows(root, materialized.flows.map((flow) => enrichImportedNodes(flow, [])));
  const bundle = await loadProject(root);
  const baseline = await createResyncBaseline({
    projectRoot: root,
    bundle,
    analysis: outcome.analysisSnapshot,
    settings: { levels: "4", detail: "deep", reviewEffort: "light", granularity: "file" },
    importerFlowIds: outcome.flowIds
  });
  await writeResyncBaseline(root, baseline);
  return { root, bundle };
}

function nodeForPath(bundle: ProjectBundle, relativePath: string): { flow: Flow; node: ArchicodeNode } {
  const candidates = bundle.flows.flatMap((flow) => flow.nodes.flatMap((node) =>
    node.implementationScope?.claims.some((claim) => claim.path === relativePath)
      ? [{ flow, node }]
      : []));
  const match = candidates.sort((left, right) => (left.node.implementationScope?.claims.length ?? 0) - (right.node.implementationScope?.claims.length ?? 0))[0];
  if (!match) throw new Error(`No imported node claims ${relativePath}.`);
  return match;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("incremental codebase resync", () => {
  it("does not mutate or regenerate the graph when repository fingerprints are unchanged", async () => {
    const { root } = await createImportedProject({
      "src/a.ts": "export const a = () => 'a';\n",
      "src/b.ts": "import { a } from './a';\nexport const b = () => a();\n"
    });
    const beforeBundle = await loadProject(root);
    const beforeFiles = await Promise.all(beforeBundle.flows.map((flow) => readFile(path.join(root, ".archicode", "flows", `${flow.id}.json`), "utf8")));
    let providerCalls = 0;

    const result = await runCodebaseResync({
      projectRoot: root,
      callProvider: async () => {
        providerCalls += 1;
        return "{}";
      }
    });

    const afterFiles = await Promise.all(beforeBundle.flows.map((flow) => readFile(path.join(root, ".archicode", "flows", `${flow.id}.json`), "utf8")));
    expect(result.report.status).toBe("up-to-date");
    expect(result.report.patch.changedFlowIds).toEqual([]);
    expect(providerCalls).toBe(0);
    expect(afterFiles).toEqual(beforeFiles);
    expect(result.bundle.flows).toEqual(beforeBundle.flows);
  });

  it("updates only the affected node metadata and leaves out-of-cone entities byte-equivalent", async () => {
    const { root, bundle } = await createImportedProject({
      "alpha/a.ts": "export const a = () => 'a';\n",
      "beta/b.ts": "export const b = () => 'b';\n"
    });
    const affected = nodeForPath(bundle, "alpha/a.ts");
    const unrelated = nodeForPath(bundle, "beta/b.ts");
    const unrelatedBefore = structuredClone(unrelated.node);
    await writeSource(root, "alpha/a.ts", "export const a = () => 'changed';\nexport const added = 1;\n");

    const result = await runCodebaseResync({ projectRoot: root });
    const updatedFlow = result.bundle.flows.find((flow) => flow.id === affected.flow.id) as Flow;
    const updatedAffected = updatedFlow.nodes.find((node) => node.id === affected.node.id);
    const updatedUnrelated = result.bundle.flows.find((flow) => flow.id === unrelated.flow.id)?.nodes.find((node) => node.id === unrelated.node.id);

    expect(result.report.patch.nodesUpdated).toBeGreaterThan(0);
    expect(updatedAffected?.id).toBe(affected.node.id);
    expect(graphEntityFingerprint("node", updatedAffected)).not.toBe(graphEntityFingerprint("node", affected.node));
    expect(updatedUnrelated).toEqual(unrelatedBefore);
  });

  it("resyncs only selected flows and preserves pending code checkpoints for flows omitted from scope", async () => {
    const { root, bundle } = await createImportedProject({
      "src/shared.ts": "export const shared = () => 'v1';\n"
    });
    const flowsWithEvidence = bundle.flows.filter((flow) => flow.nodes.some((node) =>
      node.implementationScope?.claims.some((claim) => claim.path === "src/shared.ts")));
    expect(flowsWithEvidence.length).toBeGreaterThanOrEqual(2);
    const firstFlow = flowsWithEvidence[0];
    const secondFlow = flowsWithEvidence[1];
    const secondBefore = structuredClone(secondFlow);
    await writeSource(root, "src/shared.ts", "export const shared = () => 'v2';\nexport const added = true;\n");

    const firstResult = await runCodebaseResync({
      projectRoot: root,
      scope: { kind: "flows", flowIds: [firstFlow.id] }
    });
    const firstAfter = structuredClone(firstResult.bundle.flows.find((flow) => flow.id === firstFlow.id));

    expect(firstResult.report.scope).toEqual({ kind: "flows", flowIds: [firstFlow.id] });
    expect(firstResult.report.patch.changedFlowIds.every((flowId) => flowId === firstFlow.id)).toBe(true);
    expect(firstResult.bundle.flows.find((flow) => flow.id === secondFlow.id)).toEqual(secondBefore);
    expect((await readResyncBaseline(root))?.flowFileCheckpoints?.[secondFlow.id]?.["src/shared.ts"]?.contentHash).toBeTruthy();

    const secondResult = await runCodebaseResync({
      projectRoot: root,
      scope: { kind: "flows", flowIds: [secondFlow.id] }
    });

    expect(secondResult.report.delta.modified).toContain("src/shared.ts");
    expect(secondResult.report.patch.changedFlowIds.every((flowId) => flowId === secondFlow.id)).toBe(true);
    expect(secondResult.bundle.flows.find((flow) => flow.id === firstFlow.id)).toEqual(firstAfter);
    expect(secondResult.bundle.flows.find((flow) => flow.id === secondFlow.id)).not.toEqual(secondBefore);
  });

  it("recognizes a file rename, preserves graph entity IDs, and updates evidence paths", async () => {
    const { root, bundle } = await createImportedProject({ "src/original.ts": "export const original = 1;\n" });
    const original = nodeForPath(bundle, "src/original.ts");
    await rename(path.join(root, "src/original.ts"), path.join(root, "src/renamed.ts"));

    const result = await runCodebaseResync({ projectRoot: root });
    const node = result.bundle.flows.find((flow) => flow.id === original.flow.id)?.nodes.find((candidate) => candidate.id === original.node.id);

    expect(result.report.delta.renamed).toEqual([{ from: "src/original.ts", to: "src/renamed.ts" }]);
    expect(node?.id).toBe(original.node.id);
    expect(node?.implementationScope?.claims.some((claim) => claim.path === "src/renamed.ts")).toBe(true);
    expect(node?.implementationScope?.claims.some((claim) => claim.path === "src/original.ts")).toBe(false);
  });

  it("uses symbol fingerprints to preserve identity when a renamed file was also edited", async () => {
    const { root, bundle } = await createImportedProject({ "src/original.ts": "export function stableName() { return 1; }\n" });
    const original = nodeForPath(bundle, "src/original.ts");
    await rename(path.join(root, "src/original.ts"), path.join(root, "src/renamed.ts"));
    await writeSource(root, "src/renamed.ts", "export function stableName() { return 2; }\n");

    const result = await runCodebaseResync({ projectRoot: root });
    const node = result.bundle.flows.find((flow) => flow.id === original.flow.id)?.nodes.find((candidate) => candidate.id === original.node.id);

    expect(result.report.delta.renamed).toEqual([{ from: "src/original.ts", to: "src/renamed.ts" }]);
    expect(node?.id).toBe(original.node.id);
    expect(node?.implementationScope?.claims.some((claim) => claim.path === "src/renamed.ts")).toBe(true);
  });

  it("adds only new evidence-backed entities and preserves existing nodes when a file is added", async () => {
    const { root, bundle } = await createImportedProject({ "alpha/a.ts": "export const a = 1;\n" });
    const existing = nodeForPath(bundle, "alpha/a.ts");
    const existingBefore = structuredClone(existing.node);
    await writeSource(root, "beta/b.ts", "export const b = 2;\n");

    const result = await runCodebaseResync({ projectRoot: root });
    const existingAfter = result.bundle.flows.find((flow) => flow.id === existing.flow.id)?.nodes.find((node) => node.id === existing.node.id);
    const addedNodes = result.bundle.flows.flatMap((flow) => flow.nodes.filter((node) => node.implementationScope?.claims.some((claim) => claim.path === "beta/b.ts")));

    expect(result.report.delta.added).toEqual(["beta/b.ts"]);
    expect(result.report.patch.nodesAdded).toBeGreaterThan(0);
    expect(addedNodes.length).toBeGreaterThan(0);
    expect(existingAfter).toEqual(existingBefore);
  });

  it("preserves a user-edited imported node and reports a code conflict", async () => {
    const { root, bundle } = await createImportedProject({ "src/feature.ts": "export const feature = 'v1';\n" });
    const target = nodeForPath(bundle, "src/feature.ts");
    const userTitle = "My carefully edited architecture wording";
    await saveFlow(root, { ...target.flow, nodes: target.flow.nodes.map((node) => node.id === target.node.id ? { ...node, title: userTitle, customProperties: { ...node.customProperties, Owner: "User team" } } : node) });
    await writeSource(root, "src/feature.ts", "export const feature = 'v2';\n");

    const result = await runCodebaseResync({ projectRoot: root });
    const node = result.bundle.flows.find((flow) => flow.id === target.flow.id)?.nodes.find((candidate) => candidate.id === target.node.id);

    expect(result.report.status).toBe("review-required");
    expect(result.report.patch.conflicts.some((conflict) => conflict.entityId === target.node.id)).toBe(true);
    expect(node?.title).toBe(userTitle);
    expect(node?.customProperties.Owner).toBe("User team");
  });

  it("deletes safely owned code-derived nodes but preserves edited deleted-code nodes for review", async () => {
    const safe = await createImportedProject({
      "keep/keep.ts": "export const keep = 1;\n",
      "remove/remove.ts": "export const remove = 1;\n"
    });
    const safeTarget = nodeForPath(safe.bundle, "remove/remove.ts");
    await unlink(path.join(safe.root, "remove/remove.ts"));
    const safeResult = await runCodebaseResync({ projectRoot: safe.root });
    expect(safeResult.bundle.flows.find((flow) => flow.id === safeTarget.flow.id)?.nodes.some((node) => node.id === safeTarget.node.id)).toBe(false);
    expect(safeResult.report.patch.nodesRemoved).toBeGreaterThan(0);

    const ambiguous = await createImportedProject({
      "keep/keep.ts": "export const keep = 1;\n",
      "remove/remove.ts": "export const remove = 1;\n"
    });
    const ambiguousTarget = nodeForPath(ambiguous.bundle, "remove/remove.ts");
    await saveFlow(ambiguous.root, { ...ambiguousTarget.flow, nodes: ambiguousTarget.flow.nodes.map((node) => node.id === ambiguousTarget.node.id ? { ...node, description: `${node.description} User decision: retain this conceptual boundary.` } : node) });
    await unlink(path.join(ambiguous.root, "remove/remove.ts"));
    const ambiguousResult = await runCodebaseResync({ projectRoot: ambiguous.root });
    expect(ambiguousResult.bundle.flows.find((flow) => flow.id === ambiguousTarget.flow.id)?.nodes.some((node) => node.id === ambiguousTarget.node.id)).toBe(true);
    expect(ambiguousResult.report.patch.conflicts.some((conflict) => conflict.entityId === ambiguousTarget.node.id)).toBe(true);
  });

  it("rejects hallucinated provider patches while deterministic safe changes continue", async () => {
    const { root, bundle } = await createImportedProject({
      "user/feature.ts": "export const feature = 'v1';\n",
      "safe/worker.ts": "export const worker = 'v1';\n"
    });
    const target = nodeForPath(bundle, "user/feature.ts");
    const safeTarget = nodeForPath(bundle, "safe/worker.ts");
    await saveFlow(root, { ...target.flow, nodes: target.flow.nodes.map((node) => node.id === target.node.id ? { ...node, title: "User title" } : node) });
    await writeSource(root, "user/feature.ts", "export const feature = 'v2';\n");
    await writeSource(root, "safe/worker.ts", "export const worker = 'v2';\nexport const extra = true;\n");

    const result = await runCodebaseResync({
      projectRoot: root,
      callProvider: async () => JSON.stringify({ changes: [{ flowId: target.flow.id, nodeId: "hallucinated-node", description: "Invented database", reason: "guess", citations: ["does/not/exist.ts"] }] })
    });

    expect(result.report.patch.rejectedSuggestions.length).toBeGreaterThan(0);
    expect(result.report.patch.nodesUpdated).toBeGreaterThan(0);
    expect(result.bundle.flows.find((flow) => flow.id === target.flow.id)?.nodes.find((node) => node.id === target.node.id)?.title).toBe("User title");
    expect(graphEntityFingerprint("node", result.bundle.flows.find((flow) => flow.id === safeTarget.flow.id)?.nodes.find((node) => node.id === safeTarget.node.id))).not.toBe(graphEntityFingerprint("node", safeTarget.node));
  });

  it("rolls back graph, baseline, and reports when atomic persistence fails", async () => {
    const { root } = await createImportedProject({ "src/a.ts": "export const a = 1;\n" });
    await writeSource(root, "src/a.ts", "export const a = 2;\n");
    const graphPath = path.join(root, ".archicode", "flows", "flow-main.json");
    const baselinePath = path.join(root, ".archicode", "runtime", "resync-baseline.json");
    const graphBefore = await readFile(graphPath, "utf8");
    const baselineBefore = await readFile(baselinePath, "utf8");

    await expect(runCodebaseResync({
      projectRoot: root,
      beforePersistReplace: (_relativePath, index) => {
        if (index === 1) throw new Error("simulated persistence failure");
      }
    })).rejects.toThrow("simulated persistence failure");

    expect(await readFile(graphPath, "utf8")).toBe(graphBefore);
    expect(await readFile(baselinePath, "utf8")).toBe(baselineBefore);
    expect(await readResyncReports(root)).toEqual([]);
  });

  it("cancels during atomic persistence without advancing graph or baseline", async () => {
    const { root } = await createImportedProject({ "src/a.ts": "export const a = 1;\n" });
    await writeSource(root, "src/a.ts", "export const a = 2;\n");
    const graphPath = path.join(root, ".archicode", "flows", "flow-main.json");
    const graphBefore = await readFile(graphPath, "utf8");
    const baselineBefore = await readResyncBaseline(root);
    let cancelled = false;

    await expect(runCodebaseResync({
      projectRoot: root,
      shouldCancel: () => cancelled,
      beforePersistReplace: () => {
        cancelled = true;
      }
    })).rejects.toThrow("Codebase resync was cancelled");

    expect(await readFile(graphPath, "utf8")).toBe(graphBefore);
    expect(await readResyncBaseline(root)).toEqual(baselineBefore);
  });

  it.each(["baseline", "scan", "compare", "impact", "parse", "reconcile", "validate", "persist"] as const)("cancels cleanly during the %s phase", async (phase) => {
    const { root } = await createImportedProject({ "src/a.ts": "export const a = 1;\n" });
    await writeSource(root, "src/a.ts", "export const a = 2;\n");
    const graphPath = path.join(root, ".archicode", "flows", "flow-main.json");
    const graphBefore = await readFile(graphPath, "utf8");
    const baselineBefore = await readResyncBaseline(root);
    let cancelled = false;

    await expect(runCodebaseResync({
      projectRoot: root,
      shouldCancel: () => cancelled,
      onProgress: (progress) => {
        if (progress.phase === phase) cancelled = true;
      }
    })).rejects.toThrow("Codebase resync was cancelled");

    expect(await readFile(graphPath, "utf8")).toBe(graphBefore);
    expect(await readResyncBaseline(root)).toEqual(baselineBefore);
  });

  it("cancels an in-flight affected-scope provider review without committing", async () => {
    const { root, bundle } = await createImportedProject({ "src/a.ts": "export const a = 1;\n" });
    const target = nodeForPath(bundle, "src/a.ts");
    await saveFlow(root, { ...target.flow, nodes: target.flow.nodes.map((node) => node.id === target.node.id ? { ...node, title: "User wording" } : node) });
    await writeSource(root, "src/a.ts", "export const a = 2;\n");
    const graphPath = path.join(root, ".archicode", "flows", "flow-main.json");
    const graphBefore = await readFile(graphPath, "utf8");
    const baselineBefore = await readResyncBaseline(root);
    let cancelled = false;

    await expect(runCodebaseResync({
      projectRoot: root,
      shouldCancel: () => cancelled,
      onProgress: (progress) => {
        if (progress.phase === "review") cancelled = true;
      },
      callProvider: (_prompt, options) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("{}"), 2_000);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("provider aborted"));
        }, { once: true });
      })
    })).rejects.toThrow("Codebase resync was cancelled");

    expect(await readFile(graphPath, "utf8")).toBe(graphBefore);
    expect(await readResyncBaseline(root)).toEqual(baselineBefore);
  });

  it("keeps user-created flows untouched and persists distinct reports across reloads", async () => {
    const { root } = await createImportedProject({ "src/a.ts": "export const a = 1;\n" });
    const userFlow: Flow = {
      id: "flow-user-notes",
      name: "User architecture notes",
      description: "Conceptual intent that is not a direct code claim.",
      ignored: false,
      nodes: [{
        id: "node-user-note",
        type: "note",
        title: "Keep this intent",
        description: "This is deliberately user-authored.",
        stage: "planned",
        ignored: false,
        flags: [],
        locked: false,
        visual: { shape: "note" },
        position: { x: 40, y: 50 },
        techStack: [],
        acceptanceCriteria: [],
        acceptanceChecks: [],
        customProperties: { Owner: "Architecture team" },
        attachments: [],
        todos: [],
        updatedAt: ""
      }],
      edges: [],
      subflows: [],
      groups: [],
      updatedAt: ""
    };
    await saveFlow(root, userFlow);
    const first = await runCodebaseResync({ projectRoot: root });
    const second = await runCodebaseResync({ projectRoot: root });
    const reloaded = await loadProject(root);
    const reports = await readResyncReports(root);
    const baseline = await readResyncBaseline(root);

    expect(reloaded.flows.find((flow) => flow.id === userFlow.id)).toEqual(userFlow);
    expect(Object.values(baseline?.entities ?? {}).filter((entity) => entity.flowId === userFlow.id).every((entity) => entity.origin === "user")).toBe(true);
    expect(reports.map((report) => report.reportId)).toEqual(expect.arrayContaining([first.report.reportId, second.report.reportId]));
    expect(new Set(reports.map((report) => report.reportId)).size).toBe(2);
  });

  it.each([
    ["TypeScript parser", { "src/main.ts": "export const main = () => 1;\n" }],
    ["Python parser", { "src/main.py": "def main():\n    return 1\n" }],
    ["structural fallback", { "src/main.exotic": "service Main { route '/ready' }\n" }]
  ])("keeps the core resync path stack agnostic for %s", async (_label, files) => {
    const { root } = await createImportedProject(files);
    const result = await runCodebaseResync({ projectRoot: root });
    expect(result.report.status).toBe("up-to-date");
    expect(result.report.patch.changedFlowIds).toEqual([]);
  });
});
