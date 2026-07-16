import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reviewArchitectureAtlasOperations, validateReviewedOperations } from "../src/main/importer/reviewer";
import type { RepoScan } from "../src/main/importer/types";
import { codebaseReviewPartitionBudget, flowSchema, type ArchicodeNode, type ResearchGraphOperation } from "../src/shared/schema";

const checkedAt = "2026-07-13T08:00:00.000Z";

function node(id: string, subjectId: string, title: string, sourcePath: string): ArchicodeNode {
  return {
    id,
    type: "module",
    title,
    description: `${title} currently has a deterministic importer description.`,
    stage: "draft",
    ignored: false,
    flags: ["changed"],
    locked: false,
    visual: { shape: "rectangle" },
    position: { x: 100, y: 100 },
    techStack: ["TypeScript"],
    acceptanceCriteria: [`${title} remains covered by source evidence`],
    acceptanceChecks: [],
    subjectRef: { id: subjectId, kind: "code", evidenceStatus: "observed", scopeFingerprint: subjectId.replace("code:", "") },
    implementationScope: {
      source: "codebase-importer",
      analyzerVersion: 1,
      checkedAt,
      claims: [{ relation: "own", kind: "file", path: sourcePath }]
    },
    customProperties: { "Evidence basis": "1 file; 1 symbol", "Interpretation boundary": "Responsibility naming is inferred" },
    attachments: [],
    todos: [],
    updatedAt: checkedAt
  };
}

function projectNode(): ArchicodeNode {
  return {
    id: "node-project",
    type: "project",
    title: "Fixture",
    description: "Fixture project context.",
    stage: "draft",
    ignored: false,
    flags: ["changed"],
    locked: false,
    visual: { shape: "hexagon" },
    position: { x: 0, y: 0 },
    techStack: ["TypeScript"],
    acceptanceCriteria: [],
    acceptanceChecks: [],
    subjectRef: { id: "concept:project:fixture", kind: "concept", evidenceStatus: "context" },
    implementationScope: { source: "codebase-importer", analyzerVersion: 1, checkedAt, claims: [{ relation: "cover", kind: "directory", path: "." }] },
    customProperties: {},
    attachments: [],
    todos: [],
    updatedAt: checkedAt
  };
}

function createNodeOperation(flowId: string, value: ArchicodeNode): ResearchGraphOperation {
  const { position: _position, updatedAt: _updatedAt, ...nodeInput } = value;
  return { kind: "create-node", flowId, node: nodeInput };
}

async function fixture(): Promise<{ projectRoot: string; scan: RepoScan; operations: ResearchGraphOperation[] }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-import-review-"));
  await mkdir(path.join(projectRoot, "src"));
  await writeFile(path.join(projectRoot, "src/core.ts"), "export function loadAccount() { return 'account'; }\n", "utf8");
  await writeFile(path.join(projectRoot, "src/ui.ts"), "import { loadAccount } from './core';\nexport const Screen = () => loadAccount();\n", "utf8");
  const scan: RepoScan = {
    files: [
      { relPath: "src/core.ts", ext: ".ts", sizeBytes: 54, language: "typescript", detectedLanguage: "typescript", role: "production" },
      { relPath: "src/ui.ts", ext: ".ts", sizeBytes: 82, language: "typescript", detectedLanguage: "typescript", role: "production" }
    ],
    truncated: false,
    stats: { totalFiles: 2, byLanguage: { typescript: 2 }, byDetectedLanguage: { typescript: 2 }, structuralFallbackFiles: 0 }
  };
  const core = node("node-core", "code:core", "Core", "src/core.ts");
  const ui = node("node-ui", "code:ui", "UI", "src/ui.ts");
  const perspective = flowSchema.parse({
    id: "flow-base--product-capabilities",
    name: "Product Capabilities",
    description: "What the product does.",
    ignored: false,
    perspective: {
      kind: "product-capabilities",
      source: "codebase-importer",
      generated: true,
      question: "What capabilities does this product implement?",
      confidence: "medium",
      evidenceBasis: ["exported symbols"],
      limitations: ["Static evidence only."],
      checkedAt,
      coverage: { subjects: 2, relations: 0, observedRelations: 0, inferredRelations: 0 }
    },
    nodes: [projectNode(), core, ui],
    edges: [],
    subflows: [],
    groups: [],
    updatedAt: checkedAt
  });
  const operations: ResearchGraphOperation[] = [
    { kind: "update-flow", flowId: "flow-base", patch: { name: "Codebase Structure (Evidence)", description: "Canonical evidence." } },
    createNodeOperation("flow-base", projectNode()),
    createNodeOperation("flow-base", core),
    createNodeOperation("flow-base", ui),
    {
      kind: "create-edge",
      flowId: "flow-base",
      edge: {
        id: "edge-ui-core",
        source: "node-ui",
        target: "node-core",
        label: "imports loadAccount",
        lineStyle: "solid",
        evidence: {
          origin: "extracted",
          confidence: 1,
          relationKinds: ["dependency"],
          locations: [{ path: "src/ui.ts", line: 1, fact: "./core" }],
          analyzerVersion: 1,
          checkedAt,
          verification: "verified",
          freshness: "current"
        }
      }
    },
    { kind: "create-flow", flow: perspective }
  ];
  return { projectRoot, scan, operations };
}

function response(edits: unknown[], findings: string[] = []): string {
  return JSON.stringify({ archicodeImportReview: { summary: "Reviewed.", findings, edits, unresolved: [] } });
}

describe("agentic importer architecture review", () => {
  it("keeps the user-facing review budgets at light 5, balanced 10, deep 15, and ultra 30", () => {
    expect(codebaseReviewPartitionBudget).toEqual({ light: 5, balanced: 10, deep: 15, ultra: 30 });
  });

  it("loops over evidence, perspective, and global units and applies grounded content edits", async () => {
    const input = await fixture();
    const prompts: string[] = [];
    const result = await reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "balanced",
      maxUnits: 20,
      callProvider: async (prompt, options) => {
        prompts.push(prompt);
        expect(options?.stableContext).toContain("Canonical evidence subjects");
        expect(options?.stableContext).toContain("High-value repository evidence");
        if (!prompt.includes("Review unit: evidence-1")) return response([]);
        return response([{
          kind: "update-node",
          flowId: "flow-base",
          nodeId: "node-core",
          patch: {
            title: "Account Loading",
            description: "Account Loading owns loadAccount in src/core.ts and returns the account value consumed by the UI.",
            setProperties: { "Architectural responsibility": "Loads account state" }
          },
          reason: "The exported function gives this module a concrete responsibility.",
          citations: [{ path: "src/core.ts", line: 1, fact: "exports loadAccount" }]
        }], ["The original Core label was too generic."]);
      }
    });

    expect(prompts.length).toBeGreaterThanOrEqual(3);
    expect(result.ledger.status).toBe("complete");
    expect(result.ledger.reviewedSourceFiles).toEqual(expect.arrayContaining(["src/core.ts", "src/ui.ts"]));
    expect(result.ledger.appliedEdits).toBe(1);
    expect(result.ledger.totalPlannedUnits).toBeGreaterThanOrEqual(result.ledger.totalUnits);
    expect(result.ledger.unitResults).toHaveLength(result.ledger.reviewedUnits);
    expect(result.ledger.unitResults.some((unit) => unit.appliedChanges.some((edit) => edit.kind === "update-node"))).toBe(true);
    const coreOperation = result.operations.find((operation) => operation.kind === "create-node" && operation.flowId === "flow-base" && operation.node.id === "node-core");
    expect(coreOperation?.kind).toBe("create-node");
    if (coreOperation?.kind === "create-node") {
      expect(coreOperation.node.title).toBe("Account Loading");
      expect(coreOperation.node.customProperties?.["Architectural responsibility"]).toBe("Loads account state");
      expect(coreOperation.node.customProperties?.["Evidence basis"]).toBe("1 file; 1 symbol");
    }
  });

  it("preflights independent anomalous lens flows concurrently but applies them safely in order", async () => {
    const input = await fixture();
    const product = input.operations.find((operation) => operation.kind === "create-flow");
    if (!product || product.kind !== "create-flow") throw new Error("Expected perspective fixture.");
    const second = structuredClone(product);
    second.flow.id = "flow-base--data-persistence";
    second.flow.name = "Data Ownership & Persistence";
    if (second.flow.perspective) second.flow.perspective.kind = "data-persistence";
    input.operations.push(second);
    let active = 0;
    let maxActive = 0;
    const result = await reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "light",
      maxUnits: 5,
      callProvider: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return response([]);
      }
    });

    expect(maxActive).toBe(2);
    expect(result.ledger.unitResults.filter((unit) => unit.flowId.includes("--"))).toHaveLength(2);
    expect(result.ledger.appliedEdits).toBe(0);
  });

  it("rejects an invalid batch atomically and retains the pre-review graph", async () => {
    const input = await fixture();
    const baselineCore = input.operations.find((operation) => operation.kind === "create-node" && operation.flowId === "flow-base" && operation.node.id === "node-core");
    const result = await reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "light",
      maxUnits: 1,
      callProvider: async () => response([{
        kind: "update-node",
        flowId: "flow-base",
        nodeId: "node-core",
        patch: { title: "Unsupported Rewrite" },
        reason: "Unsupported edit.",
        citations: [{ path: "src/missing.ts", line: 1 }]
      }])
    });

    expect(result.ledger.appliedEdits).toBe(0);
    expect(result.ledger.rejectedBatches).toBe(2);
    expect(result.ledger.unresolved[0]).toContain("could not produce a valid safe patch");
    const reviewedCore = result.operations.find((operation) => operation.kind === "create-node" && operation.flowId === "flow-base" && operation.node.id === "node-core");
    expect(reviewedCore).toEqual(baselineCore);
    const perspective = result.operations.find((operation) => operation.kind === "create-flow");
    if (perspective?.kind === "create-flow") expect(perspective.flow.perspective?.limitations.join(" ")).toContain("remaining claims rely on deterministic importer evidence");
  });

  it("rejects citations to real repository files whose raw source was not supplied to that partition", async () => {
    const input = await fixture();
    for (let index = 0; index < 15; index += 1) {
      const relPath = `src/extra-${String(index).padStart(2, "0")}.ts`;
      const contents = `export const extra${index} = ${index};\n`;
      await writeFile(path.join(input.projectRoot, relPath), contents, "utf8");
      input.scan.files.push({ relPath, ext: ".ts", sizeBytes: Buffer.byteLength(contents), language: "typescript", detectedLanguage: "typescript", role: "production" });
    }
    input.scan.stats.totalFiles = input.scan.files.length;
    input.scan.stats.byLanguage = { typescript: input.scan.files.length };
    input.scan.stats.byDetectedLanguage = { typescript: input.scan.files.length };
    const result = await reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "light",
      maxUnits: 1,
      callProvider: async () => response([{
        kind: "update-node",
        flowId: "flow-base",
        nodeId: "node-core",
        patch: { title: "Unsupported Cross-File Claim" },
        reason: "Attempts to cite a real but unseen source file.",
        citations: [{ path: "src/extra-14.ts", line: 1, fact: "unrelated extra export" }]
      }])
    });

    expect(result.ledger.appliedEdits).toBe(0);
    expect(result.ledger.rejectedBatches).toBe(2);
    expect(result.ledger.unresolved.join(" ")).toContain("was not included in raw source supplied to this review partition");
    expect(result.ledger.citedSourceFiles).not.toContain("src/extra-14.ts");
  });

  it("rejects an invalid generated baseline before making a provider call", async () => {
    const input = await fixture();
    const perspective = input.operations.find((operation) => operation.kind === "create-flow");
    if (!perspective || perspective.kind !== "create-flow") throw new Error("Expected perspective fixture.");
    const duplicate = structuredClone(perspective.flow.nodes.find((item) => item.id === "node-core"));
    if (!duplicate) throw new Error("Expected core node.");
    duplicate.id = "node-core-copy";
    perspective.flow.nodes.push(duplicate);
    let providerCalls = 0;

    await expect(reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "balanced",
      callProvider: async () => {
        providerCalls += 1;
        return response([]);
      }
    })).rejects.toThrow("depicts subject code:core more than once");
    expect(providerCalls).toBe(0);
  });

  it("keeps reviewer-authored relationships inferred even when the same subject pair has an extracted dependency", async () => {
    const input = await fixture();
    const result = await reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "balanced",
      maxUnits: 20,
      callProvider: async (prompt) => prompt.includes("flow-base--product-capabilities-part-1")
        ? response([{
          kind: "include-relationship",
          flowId: "flow-base--product-capabilities",
          sourceSubjectRefId: "code:ui",
          targetSubjectRefId: "code:core",
          label: "loads account details",
          confidence: 0.99,
          reason: "This semantic product-flow claim is inferred from the UI's observed dependency.",
          citations: [{ path: "src/core.ts", line: 1, fact: "exports loadAccount" }, { path: "src/ui.ts", line: 2, fact: "Screen consumes loadAccount" }]
        }])
        : response([])
    });

    const flowOperation = result.operations.find((operation) => operation.kind === "create-flow" && operation.flow.id === "flow-base--product-capabilities");
    expect(flowOperation?.kind).toBe("create-flow");
    if (flowOperation?.kind === "create-flow") {
      expect(flowOperation.flow.edges).toHaveLength(1);
      expect(flowOperation.flow.edges[0].evidence?.origin).toBe("inferred");
      expect(flowOperation.flow.edges[0].evidence?.confidence).toBe(0.6);
      expect(flowOperation.flow.edges[0].evidence?.relationKinds).toEqual(["architecture-review"]);
      expect(flowOperation.flow.edges[0].lineStyle).toBe("dashed");
      expect(flowOperation.flow.edges[0].evidence?.verification).toBe("ambiguous");
      expect(flowOperation.flow.perspective?.coverage).toEqual({ subjects: 2, relations: 1, observedRelations: 0, inferredRelations: 1 });
    }
    expect(result.ledger.citedSourceFiles).toEqual(expect.arrayContaining(["src/core.ts", "src/ui.ts"]));
  });

  it("exposes and applies ordered structural perspective repairs using reusable canonical subjects", async () => {
    const input = await fixture();
    const perspective = input.operations.find((operation) => operation.kind === "create-flow");
    if (!perspective || perspective.kind !== "create-flow") throw new Error("Expected perspective fixture.");
    perspective.flow.nodes = perspective.flow.nodes.filter((item) => item.subjectRef?.id !== "code:ui");
    const prompts: string[] = [];
    const result = await reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "balanced",
      maxUnits: 20,
      callProvider: async (prompt) => {
        prompts.push(prompt);
        if (!prompt.includes("flow-base--product-capabilities-part-1")) return response([]);
        expect(prompt).toContain("availableReusableSubjects");
        expect(prompt).toContain('"subjectRefId":"code:ui"');
        expect(prompt).toContain("Structural perspective repair IS supported");
        return response([
          {
            kind: "include-subject",
            flowId: "flow-base--product-capabilities",
            subjectRefId: "code:ui",
            patch: { title: "Account Screen" },
            reason: "The UI is a canonical implementation subject needed to show the capability consumer.",
            citations: [{ path: "src/ui.ts", line: 2, fact: "Screen consumes loadAccount" }]
          },
          {
            kind: "include-relationship",
            flowId: "flow-base--product-capabilities",
            sourceSubjectRefId: "code:ui",
            targetSubjectRefId: "code:core",
            label: "loads account details from",
            reason: "The screen calls the canonical account-loading subject.",
            citations: [{ path: "src/ui.ts", line: 2, fact: "Screen consumes loadAccount" }]
          }
        ]);
      }
    });

    expect(prompts.some((prompt) => prompt.includes("include-subject"))).toBe(true);
    const reviewed = result.operations.find((operation) => operation.kind === "create-flow" && operation.flow.id === "flow-base--product-capabilities");
    expect(reviewed?.kind).toBe("create-flow");
    if (reviewed?.kind === "create-flow") {
      expect(reviewed.flow.nodes.some((item) => item.subjectRef?.id === "code:ui" && item.title === "Account Screen")).toBe(true);
      expect(reviewed.flow.edges.some((edge) => edge.label === "loads account details from" && edge.evidence?.origin === "inferred")).toBe(true);
      expect(reviewed.flow.perspective?.coverage).toEqual({ subjects: 2, relations: 1, observedRelations: 0, inferredRelations: 1 });
    }
  });

  it("creates an evidence-bounded lens concept without inventing canonical code ownership", async () => {
    const input = await fixture();
    const result = await reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "light",
      maxUnits: 5,
      callProvider: async (prompt) => prompt.includes("flow-base--product-capabilities-part-1")
        ? response([{
          kind: "create-lens-concept",
          flowId: "flow-base--product-capabilities",
          nodeKey: "view-account",
          title: "View Account Details",
          type: "capability",
          description: "A user-visible capability grounded in the Screen call to loadAccount.",
          relationships: [{ direction: "to-concept", subjectRefId: "code:core", label: "is fulfilled by" }],
          reason: "The lens needs a business-facing outcome rather than only code modules.",
          citations: [{ path: "src/ui.ts", line: 2, fact: "Screen calls loadAccount" }]
        }])
        : response([])
    });

    const reviewed = result.operations.find((operation) => operation.kind === "create-flow" && operation.flow.id === "flow-base--product-capabilities");
    expect(reviewed?.kind).toBe("create-flow");
    if (reviewed?.kind === "create-flow") {
      const concept = reviewed.flow.nodes.find((item) => item.title === "View Account Details");
      expect(concept?.subjectRef?.kind).toBe("concept");
      expect(concept?.subjectRef?.evidenceStatus).toBe("inferred");
      expect(concept?.implementationScope).toBeUndefined();
      expect(concept?.stage).toBe("draft-approved-production");
      expect(reviewed.flow.edges.some((edge) => edge.target === concept?.id && edge.evidence?.origin === "inferred")).toBe(true);
    }
  });

  it("routes a high-value behavioral hotspot instead of only the beginning of a large file", async () => {
    const input = await fixture();
    const prefix = "// filler\n".repeat(500);
    const marker = "const productRule = `A user must confirm the account policy before the workflow can continue`;\n";
    const large = `${prefix}${marker}`;
    await writeFile(path.join(input.projectRoot, "src/core.ts"), large, "utf8");
    const core = input.scan.files.find((file) => file.relPath === "src/core.ts");
    if (core) core.sizeBytes = Buffer.byteLength(large);
    let sawMarker = false;
    await reviewArchitectureAtlasOperations({
      ...input,
      inventory: {
        catalogs: [], routes: [], interactions: [], entrypoints: [],
        evidenceHotspots: [
          { file: "src/core.ts", categories: ["runtime-boundary"], line: 1, offset: 0, excerpt: "runtime boundary" },
          { file: "src/core.ts", categories: ["business-rule"], line: 501, offset: Buffer.byteLength(prefix), excerpt: marker.trim() }
        ]
      },
      baseFlowId: "flow-base",
      effort: "light",
      maxUnits: 5,
      callProvider: async (prompt, options) => {
        sawMarker ||= prompt.includes("A user must confirm") || Boolean(options?.stableContext?.includes("A user must confirm"));
        return response([]);
      }
    });
    expect(sawMarker).toBe(true);
  });

  it("retries a reviewer response that falsely claims structural edits are unsupported", async () => {
    const input = await fixture();
    const perspective = input.operations.find((operation) => operation.kind === "create-flow");
    if (!perspective || perspective.kind !== "create-flow") throw new Error("Expected perspective fixture.");
    perspective.flow.nodes = perspective.flow.nodes.filter((item) => item.subjectRef?.id !== "code:ui");
    let perspectiveAttempts = 0;
    const result = await reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "balanced",
      maxUnits: 20,
      callProvider: async (prompt) => {
        if (!prompt.includes("flow-base--product-capabilities-part-1")) return response([]);
        perspectiveAttempts += 1;
        if (perspectiveAttempts === 1) {
          return JSON.stringify({
            archicodeImportReview: {
              summary: "Missing UI.",
              findings: ["The UI subject is missing."],
              edits: [],
              unresolved: ["Cannot add the missing node because the review edit envelope does not support structural operations."]
            }
          });
        }
        expect(prompt).toContain("incorrectly claimed that structural perspective repair is unsupported");
        return response([{
          kind: "include-subject",
          flowId: "flow-base--product-capabilities",
          subjectRefId: "code:ui",
          reason: "The canonical UI subject is required by the capability flow.",
          citations: [{ path: "src/ui.ts", line: 2, fact: "Screen consumes loadAccount" }]
        }]);
      }
    });

    expect(perspectiveAttempts).toBe(2);
    expect(result.ledger.rejectedBatches).toBe(1);
    expect(result.ledger.appliedEdits).toBe(1);
    const reviewed = result.operations.find((operation) => operation.kind === "create-flow" && operation.flow.id === "flow-base--product-capabilities");
    if (reviewed?.kind === "create-flow") expect(reviewed.flow.nodes.some((item) => item.subjectRef?.id === "code:ui")).toBe(true);
  });

  it("continues large source files across multiple review partitions without claiming early file coverage", async () => {
    const input = await fixture();
    const largeSource = `${"export const value = 1;\n".repeat(2_100)}export function finalBehavior() { return value; }\n`;
    await writeFile(path.join(input.projectRoot, "src/core.ts"), largeSource, "utf8");
    const coreScan = input.scan.files.find((file) => file.relPath === "src/core.ts");
    if (coreScan) coreScan.sizeBytes = Buffer.byteLength(largeSource);
    const prompts: string[] = [];
    const result = await reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "deep",
      maxUnits: 40,
      callProvider: async (prompt) => {
        prompts.push(prompt);
        return response([]);
      }
    });

    expect(prompts.filter((prompt) => prompt.includes("Review unit: evidence-")).length).toBeGreaterThan(1);
    expect(result.ledger.reviewedSourceSlices).toHaveLength(result.ledger.totalSourceSlices);
    expect(result.ledger.reviewedSourceFiles).toEqual(expect.arrayContaining(["src/core.ts", "src/ui.ts"]));
    expect(prompts.some((prompt) => prompt.includes("continues in another review partition"))).toBe(true);
  });

  it("aborts an inactive provider attempt and succeeds on the single automatic retry", async () => {
    const input = await fixture();
    let calls = 0;
    const result = await reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "light",
      maxUnits: 1,
      inactivityTimeoutMs: 30,
      partitionTimeoutMs: 250,
      activeGraceMs: 0,
      callProvider: async (_prompt, options) => {
        calls += 1;
        if (calls > 1) return response([]);
        return await new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted stalled attempt")), { once: true });
        });
      }
    });

    expect(calls).toBe(2);
    expect(result.ledger.reviewedUnits).toBe(1);
    expect(result.ledger.failedProviderAttempts).toBe(1);
    expect(result.ledger.unitResults[0].failedProviderAttempts).toBe(1);
    expect(result.ledger.rejectedBatches).toBe(0);
    expect(result.ledger.unresolved).toEqual([]);
  });

  it("continues to later partitions when earlier partitions exhaust their retries", async () => {
    const input = await fixture();
    let calls = 0;
    const result = await reviewArchitectureAtlasOperations({
      ...input,
      baseFlowId: "flow-base",
      effort: "light",
      maxUnits: 4,
      inactivityTimeoutMs: 25,
      partitionTimeoutMs: 200,
      activeGraceMs: 0,
      callProvider: async (_prompt, options) => {
        calls += 1;
        return await new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted stalled attempt")), { once: true });
        });
      }
    });

    expect(calls).toBeGreaterThan(4);
    expect(result.ledger.reviewedUnits).toBe(result.ledger.totalUnits);
    expect(result.ledger.failedProviderAttempts).toBe(calls);
    expect(result.ledger.rejectedBatches).toBe(0);
    expect(result.ledger.unresolved.filter((item) => item.includes("provider review could not produce a valid safe patch"))).toHaveLength(result.ledger.totalUnits);
    expect(result.ledger.limitations.some((item) => /review questions remain unresolved and were not converted into graph truth/.test(item))).toBe(true);
    expect(result.ledger.limitations.some((item) => item.includes("consecutive units"))).toBe(false);
  });

  it("detects changes to stable subject identity and extracted evidence", async () => {
    const input = await fixture();
    const mutated = structuredClone(input.operations);
    const core = mutated.find((operation) => operation.kind === "create-node" && operation.flowId === "flow-base" && operation.node.id === "node-core");
    if (core?.kind === "create-node") core.node.subjectRef = { id: "code:changed", kind: "code", evidenceStatus: "observed" };
    expect(() => validateReviewedOperations(mutated, input.operations, "flow-base", new Set(input.scan.files.map((file) => file.relPath)))).toThrow("changed immutable subject identity");

    const edgeMutated = structuredClone(input.operations);
    const edge = edgeMutated.find((operation) => operation.kind === "create-edge");
    if (edge?.kind === "create-edge" && edge.edge.evidence) edge.edge.evidence.confidence = 0.4;
    expect(() => validateReviewedOperations(edgeMutated, input.operations, "flow-base", new Set(input.scan.files.map((file) => file.relPath)))).toThrow("changed immutable extracted evidence");
  });

  it("rejects synthetic directory claims that do not exist in the repository", async () => {
    const input = await fixture();
    const mutated = structuredClone(input.operations);
    const core = mutated.find((operation) => operation.kind === "create-node" && operation.flowId === "flow-base" && operation.node.id === "node-core");
    if (core?.kind === "create-node" && core.node.implementationScope) {
      core.node.implementationScope.claims = [{ relation: "own", kind: "directory", path: "src/(other)" }];
    }
    expect(() => validateReviewedOperations(mutated, input.operations, "flow-base", new Set(input.scan.files.map((file) => file.relPath)))).toThrow("invalid implementation-scope path");
  });

  it("keeps lens-to-canonical evidence anchors immutable during review", async () => {
    const input = await fixture();
    const mutated = structuredClone(input.operations);
    const perspective = mutated.find((operation) => operation.kind === "create-flow");
    if (perspective?.kind === "create-flow") {
      const core = perspective.flow.nodes.find((node) => node.id === "node-core");
      if (core) core.customProperties["Canonical code anchors"] = "code:invented";
    }
    const baselinePerspective = input.operations.find((operation) => operation.kind === "create-flow");
    if (baselinePerspective?.kind === "create-flow") {
      const core = baselinePerspective.flow.nodes.find((node) => node.id === "node-core");
      if (core) core.customProperties["Canonical code anchors"] = "code:core";
    }
    expect(() => validateReviewedOperations(mutated, input.operations, "flow-base", new Set(input.scan.files.map((file) => file.relPath)))).toThrow("changed protected evidence property");

    const semanticMutated = structuredClone(input.operations);
    const semanticPerspective = semanticMutated.find((operation) => operation.kind === "create-flow");
    if (semanticPerspective?.kind === "create-flow") {
      const core = semanticPerspective.flow.nodes.find((node) => node.id === "node-core");
      if (core) core.customProperties["Claim basis"] = "implemented-durable";
    }
    expect(() => validateReviewedOperations(semanticMutated, input.operations, "flow-base", new Set(input.scan.files.map((file) => file.relPath)))).toThrow("changed protected evidence property");
  });

  it("rejects a reviewer patch that reverses the journey entry through its actor", async () => {
    const input = await fixture();
    const customer = { ...node("node-customer", "concept:journey:customer", "Customer", "src/ui.ts"), type: "actor" };
    const start = { ...node("node-start", "concept:journey:start", "Starts Voice Conversation", "src/ui.ts"), type: "trigger" };
    const journey = flowSchema.parse({
      id: "flow-base--user-journeys",
      name: "User Journeys & UX",
      description: "Ordered customer journey.",
      ignored: false,
      perspective: {
        kind: "user-journeys",
        source: "codebase-importer",
        generated: true,
        question: "What happens next?",
        confidence: "medium",
        evidenceBasis: ["routes", "interaction evidence"],
        limitations: [],
        checkedAt,
        coverage: { subjects: 2, relations: 1, observedRelations: 0, inferredRelations: 1 }
      },
      nodes: [projectNode(), customer, start],
      edges: [{ id: "edge-customer-start", source: customer.id, target: start.id, label: "initiates", lineStyle: "dashed" }],
      subflows: [],
      groups: [],
      updatedAt: checkedAt
    });
    const baseline = [...input.operations, { kind: "create-flow", flow: journey } satisfies ResearchGraphOperation];
    const reviewed = structuredClone(baseline);
    const reviewedJourney = reviewed.find((operation) => operation.kind === "create-flow" && operation.flow.id === journey.id);
    if (!reviewedJourney || reviewedJourney.kind !== "create-flow") throw new Error("Expected journey flow.");
    const landing = { ...node("node-landing", "concept:journey:landing", "Lands on Home Screen", "src/ui.ts"), type: "journey-step" };
    reviewedJourney.flow.nodes.push(landing);
    reviewedJourney.flow.edges.push(
      { id: "edge-start-landing", source: start.id, target: landing.id, label: "presents", lineStyle: "dashed" },
      { id: "edge-landing-customer", source: landing.id, target: customer.id, label: "navigates to", lineStyle: "dashed" }
    );

    expect(() => validateReviewedOperations(reviewed, baseline, "flow-base", new Set(input.scan.files.map((file) => file.relPath))))
      .toThrow("incoming relationship to journey actor Customer");

    const retyped = structuredClone(baseline);
    const retypedJourney = retyped.find((operation) => operation.kind === "create-flow" && operation.flow.id === journey.id);
    if (!retypedJourney || retypedJourney.kind !== "create-flow") throw new Error("Expected journey flow.");
    const retypedStart = retypedJourney.flow.nodes.find((candidate) => candidate.id === start.id);
    if (retypedStart) retypedStart.type = "actor";
    expect(() => validateReviewedOperations(retyped, baseline, "flow-base", new Set(input.scan.files.map((file) => file.relPath))))
      .toThrow("incoming relationship to journey actor Starts Voice Conversation");
  });

  it("rejects non-decision journey cycles while preserving decision loops", async () => {
    const input = await fixture();
    const customer = { ...node("node-customer", "concept:journey:customer", "Customer", "src/ui.ts"), type: "actor" };
    const collect = { ...node("node-collect", "concept:journey:collect", "Collect Order", "src/ui.ts"), type: "journey-step" };
    const confirm = { ...node("node-confirm", "concept:journey:confirm", "Confirm Order", "src/ui.ts"), type: "journey-step" };
    const journey = flowSchema.parse({
      id: "flow-base--user-journeys",
      name: "User Journeys & UX",
      description: "Ordered customer journey.",
      ignored: false,
      perspective: {
        kind: "user-journeys",
        source: "codebase-importer",
        generated: true,
        question: "What happens next?",
        confidence: "medium",
        evidenceBasis: ["interaction evidence"],
        limitations: [],
        checkedAt,
        coverage: { subjects: 3, relations: 2, observedRelations: 0, inferredRelations: 2 }
      },
      nodes: [projectNode(), customer, collect, confirm],
      edges: [
        { id: "edge-customer-collect", source: customer.id, target: collect.id, label: "starts", lineStyle: "dashed" },
        { id: "edge-collect-confirm", source: collect.id, target: confirm.id, label: "asks to confirm", lineStyle: "dashed" }
      ],
      subflows: [],
      groups: [],
      updatedAt: checkedAt
    });
    const baseline = [...input.operations, { kind: "create-flow", flow: journey } satisfies ResearchGraphOperation];
    const knownPaths = new Set(input.scan.files.map((file) => file.relPath));
    expect(() => validateReviewedOperations(baseline, baseline, "flow-base", knownPaths)).not.toThrow();

    const reviewed = structuredClone(baseline);
    const reviewedJourney = reviewed.find((operation) => operation.kind === "create-flow" && operation.flow.id === journey.id);
    if (!reviewedJourney || reviewedJourney.kind !== "create-flow") throw new Error("Expected journey flow.");
    reviewedJourney.flow.edges.push({ id: "edge-confirm-collect", source: confirm.id, target: collect.id, label: "returns to editing", lineStyle: "dashed" });
    expect(() => validateReviewedOperations(reviewed, baseline, "flow-base", knownPaths))
      .toThrow("directed journey cycle without a decision node");

    // A pre-existing provider cycle is outside reviewer patch authority and must
    // not crash the pre-review validation pass.
    expect(() => validateReviewedOperations(reviewed, reviewed, "flow-base", knownPaths)).not.toThrow();

    const decisionBaseline = structuredClone(baseline);
    const decisionReviewed = structuredClone(reviewed);
    for (const operations of [decisionBaseline, decisionReviewed]) {
      const decisionJourney = operations.find((operation) => operation.kind === "create-flow" && operation.flow.id === journey.id);
      if (!decisionJourney || decisionJourney.kind !== "create-flow") throw new Error("Expected journey flow.");
      const decision = decisionJourney.flow.nodes.find((candidate) => candidate.id === confirm.id);
      if (decision) decision.type = "decision";
    }
    expect(() => validateReviewedOperations(decisionReviewed, decisionBaseline, "flow-base", knownPaths)).not.toThrow();
  });
});
