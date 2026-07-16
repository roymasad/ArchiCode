import { mkdtemp, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearSemanticIndex,
  cosineSimilarity,
  getSemanticNodeContext,
  getSemanticIndexStatus,
  indexSemanticDocuments,
  searchSemanticIndex,
  semanticIndexNeedsWarmup,
  semanticDocumentsForCode,
  semanticTokenCount,
  setSemanticIndexRoots,
  switchSemanticModelPreference
} from "../src/main/semanticIndex";
import { runCodebaseImport } from "../src/main/importer";
import { scanRepository } from "../src/main/importer/scanner";
import { parseFiles } from "../src/main/importer/parsers";
import { createSeedProject } from "../src/shared/fixtures";
import type { ProjectBundle } from "../src/shared/schema";

describe("local semantic index", () => {
  it("auto-warms only enabled empty or stale local caches", () => {
    const status = (state: "empty" | "stale" | "graph-only" | "ready", enabled = true) => ({ state, enabled } as Parameters<typeof semanticIndexNeedsWarmup>[0]);
    expect(semanticIndexNeedsWarmup(status("empty"))).toBe(true);
    expect(semanticIndexNeedsWarmup(status("stale"))).toBe(true);
    expect(semanticIndexNeedsWarmup(status("graph-only"))).toBe(true);
    expect(semanticIndexNeedsWarmup(status("ready"))).toBe(false);
    expect(semanticIndexNeedsWarmup(status("empty", false))).toBe(false);
  });

  it("computes cosine similarity for normalized vectors", () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBe(1);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
  });

  it("reports changed chunks separately from reused semantic documents", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-reuse-data-"));
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-reuse-project-"));
    setSemanticIndexRoots(dataRoot, path.resolve(process.cwd(), "resources", "semantic-model"));
    const first = [
      { key: "graph-node:a", kind: "graph-node" as const, ref: "a", text: "Stable architecture description." },
      { key: "graph-node:b", kind: "graph-node" as const, ref: "b", text: "Original feature description." }
    ];
    await indexSemanticDocuments(projectRoot, first, { replaceKinds: ["graph-node"] });
    const progress: Array<{ phase: string; reused?: number; documentTotal?: number; message: string }> = [];
    await indexSemanticDocuments(projectRoot, [first[0], { ...first[1], text: "Changed feature description." }], {
      replaceKinds: ["graph-node"],
      onProgress: (event) => progress.push(event)
    });
    const embedding = progress.find((event) => event.phase === "embedding");
    expect(embedding).toMatchObject({ reused: 1, documentTotal: 2 });
    expect(embedding?.message).toContain("changed chunks");
    expect(await getSemanticIndexStatus(projectRoot, true)).toMatchObject({
      state: "graph-only",
      indexedItems: 2,
      graphItems: 2,
      codeItems: 0
    });
  }, 60_000);

  it("indexes, searches, reports health, and clears a project-local cache with the bundled CPU model", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-data-"));
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-project-"));
    setSemanticIndexRoots(dataRoot, path.resolve(process.cwd(), "resources", "semantic-model"));

    await indexSemanticDocuments(projectRoot, [
      { key: "graph-node:billing", kind: "graph-node", ref: "flow:billing", text: "Subscription billing, invoices, payments, refunds, and cancellation lifecycle." },
      { key: "graph-node:canvas", kind: "graph-node", ref: "flow:canvas", text: "Interactive canvas rendering, shapes, colors, zooming, and node layout." },
      { key: "code-file:payments", kind: "code-file", ref: "src/payments.ts", text: "Payment service processes subscription invoices and refunds." }
    ], { replaceKinds: ["graph-node", "code-file"] });

    const results = await searchSemanticIndex(projectRoot, "cancel a paid subscription and issue a refund", { kinds: ["graph-node"], limit: 2, minScore: 0 });
    expect(results[0]?.ref).toBe("flow:billing");
    const status = await getSemanticIndexStatus(projectRoot, true);
    expect(status.state).toBe("ready");
    expect(status.indexedItems).toBe(3);
    expect(status.graphItems).toBe(2);
    expect(status.codeItems).toBe(1);
    expect(status.cacheSizeBytes).toBeGreaterThan(0);

    const cacheDirectory = path.join(dataRoot, "semantic-index", createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 24));
    const manifestPath = path.join(cacheDirectory, "index.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { entries: Array<{ key: string; preview: string }> };
    const billingEntry = manifest.entries.find((entry) => entry.key === "graph-node:billing")!;
    billingEntry.preview = "Externally refreshed billing preview proves the memory cache was invalidated.";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const refreshed = await searchSemanticIndex(projectRoot, "cancel a paid subscription and issue a refund", { kinds: ["graph-node"], limit: 2, minScore: 0 });
    expect(refreshed[0]?.preview).toContain("memory cache was invalidated");

    await clearSemanticIndex(projectRoot);
    expect((await getSemanticIndexStatus(projectRoot, true)).state).toBe("empty");
  }, 60_000);

  it("adds semantic relationships to a real codebase import", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-import-"));
    const projectRoot = path.resolve(process.cwd(), "fixtures", "importer", "flat-app");
    setSemanticIndexRoots(dataRoot, path.resolve(process.cwd(), "resources", "semantic-model"));
    const phases: string[] = [];
    const outcome = await runCodebaseImport({
      projectRoot,
      flowId: "flow-semantic",
      levels: "3",
      detail: "balanced",
      granularity: "component",
      codebaseHints: [],
      semanticEnabled: true,
      onProgress: (progress) => phases.push(progress.phase)
    });
    expect(phases).toContain("semantic");
    expect(outcome.moduleGraph.semanticLinks?.length).toBeGreaterThan(0);
    expect(outcome.stats.degraded.some((message) => message.includes("Semantic indexing was unavailable"))).toBe(false);
  }, 60_000);

  it("exposes current node cache context without returning the node itself", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-node-data-"));
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-node-project-"));
    setSemanticIndexRoots(dataRoot, path.resolve(process.cwd(), "resources", "semantic-model"));
    const { project, flow } = createSeedProject(projectRoot);
    const bundle = { rootPath: projectRoot, project, flows: [flow], notes: [] } as unknown as ProjectBundle;
    const node = flow.nodes[0];

    await indexSemanticDocuments(projectRoot, [{
      key: "code-file:src/example.ts",
      kind: "code-file",
      ref: "src/example.ts",
      text: `${node.title}\n${node.description}\nimplementation service`
    }], { replaceKinds: ["code-file"] });
    const context = await getSemanticNodeContext(projectRoot, bundle, flow.id, node.id);

    expect(context.state).toBe("current");
    expect(context.indexed).toBe(true);
    expect(context.updatedAt).toBeTruthy();
    expect(context.relatedNodes.every((match) => match.nodeId !== node.id)).toBe(true);
    expect(context.relatedCode[0]?.path).toBe("src/example.ts");
  }, 60_000);

  it("covers and retrieves a component located well beyond the old file-prefix limit", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-large-data-"));
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-large-project-"));
    setSemanticIndexRoots(dataRoot, path.resolve(process.cwd(), "resources", "semantic-model"));
    const unrelatedPrefix = Array.from({ length: 180 }, (_, index) => `// canvas layout color shape zoom note ${index}`).join("\n");
    const source = `${unrelatedPrefix}\n\nexport async function issueRefundForCancelledSubscription(invoiceId: string) {\n  const payment = await loadPayment(invoiceId);\n  return payment.refund({ reason: "cancelled subscription" });\n}\n`;
    await writeFile(path.join(projectRoot, "billing.ts"), source, "utf8");
    const scan = await scanRepository(projectRoot);
    const parsed = await parseFiles(projectRoot, scan.files);
    const semanticSet = await semanticDocumentsForCode(projectRoot, scan, parsed);

    expect(source.indexOf("issueRefundForCancelledSubscription")).toBeGreaterThan(5_000);
    expect(semanticSet.coverage.complete).toBe(true);
    expect(semanticSet.coverage.indexedSourceLines).toBe(source.split("\n").length);
    expect(semanticSet.documents.some((document) => document.metadata?.symbol === "issueRefundForCancelledSubscription" && Number(document.metadata.startLine) > 150)).toBe(true);
    const largestBgeDocument = Math.max(...await Promise.all(semanticSet.documents.map((document) => semanticTokenCount(document.text))));
    expect(largestBgeDocument).toBeGreaterThan(128);
    expect(largestBgeDocument).toBeLessThanOrEqual(512);

    await indexSemanticDocuments(projectRoot, semanticSet.documents, { replaceKinds: ["code-file"], coverage: semanticSet.coverage });
    const [result] = await searchSemanticIndex(projectRoot, "refund a payment after cancelling a subscription", { kinds: ["code-file"], limit: 1, minScore: 0 });
    expect(result.ref).toBe("billing.ts");
    expect(result.matches?.some((match) => match.metadata?.symbol === "issueRefundForCancelledSubscription")).toBe(true);
    expect(result.matches?.some((match) => match.metadata?.level === "symbol-pool")).toBe(true);
    expect(result.matches?.some((match) => match.metadata?.level === "file-pool")).toBe(true);
    expect((await getSemanticIndexStatus(projectRoot, true)).coverage?.complete).toBe(true);
  }, 60_000);

  it("includes framework components and stylesheets that do not have tree-sitter parsers", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-framework-data-"));
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-framework-project-"));
    setSemanticIndexRoots(dataRoot, path.resolve(process.cwd(), "resources", "semantic-model"));
    await writeFile(path.join(projectRoot, "AboutPage.vue"), `<template>\n  <main class="about">About the product</main>\n</template>\n<style scoped>\n.about { color: teal; }\n</style>\n`, "utf8");
    await writeFile(path.join(projectRoot, "main.css"), ".page { display: grid; }\n", "utf8");

    const scan = await scanRepository(projectRoot);
    const parsed = await parseFiles(projectRoot, scan.files);
    const semanticSet = await semanticDocumentsForCode(projectRoot, scan, parsed);

    expect(semanticSet.coverage.eligibleFiles).toBe(2);
    expect(semanticSet.coverage.indexedFiles).toBe(2);
    expect(semanticSet.coverage.indexedSourceLines).toBe(9);
    expect(semanticSet.coverage.symbols).toBe(1);
    expect(semanticSet.documents.some((document) => document.ref === "AboutPage.vue" && document.metadata?.symbol === "AboutPage")).toBe(true);
    expect(semanticSet.documents.some((document) => document.ref === "main.css" && document.metadata?.level === "source-chunk")).toBe(true);
  }, 60_000);

  it("switches to the faster MiniLM profile and uses its smaller token window", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-model-switch-"));
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-semantic-model-project-"));
    setSemanticIndexRoots(dataRoot, path.resolve(process.cwd(), "resources", "semantic-model"));
    await writeFile(path.join(projectRoot, "large.ts"), Array.from({ length: 240 }, (_, index) => `export const semanticValue${index} = "billing refund invoice ${index}";`).join("\n"), "utf8");

    await switchSemanticModelPreference("minilm-l6-v2");
    const scan = await scanRepository(projectRoot);
    const parsed = await parseFiles(projectRoot, scan.files);
    const documents = await semanticDocumentsForCode(projectRoot, scan, parsed);
    expect(Math.max(...await Promise.all(documents.documents.map((document) => semanticTokenCount(document.text))))).toBeLessThanOrEqual(128);

    await indexSemanticDocuments(projectRoot, documents.documents, { replaceKinds: ["code-file"], coverage: documents.coverage });
    expect((await getSemanticIndexStatus(projectRoot, true)).modelId).toBe("Xenova/all-MiniLM-L6-v2");
    await switchSemanticModelPreference("bge-small-en-v1.5");
    expect((await getSemanticIndexStatus(projectRoot, true)).state).toBe("empty");
  }, 60_000);
});
