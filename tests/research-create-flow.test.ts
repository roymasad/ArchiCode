import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyResearchOperation, validateResearchChangeSet } from "../src/main/research/graphOps";
import { enrichImportedNodes, materializeCodebaseMapOperations, prepareCodebaseImportOperationForApplication } from "../src/main/research";
import { ensureEmptyCodebaseProject, loadProject, saveFlows } from "../src/main/storage/projectStore";
import type { ResearchGraphOperation } from "../src/shared/schema";

describe("first-class architecture perspective flows", () => {
  it("validates and persists an atomic flow with perspective metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-perspective-flow-"));
    const bundle = await ensureEmptyCodebaseProject(root);
    const operation: ResearchGraphOperation = {
      kind: "create-flow",
      flow: {
        id: "flow-runtime",
        name: "Runtime & Integrations",
        description: "Observed runtime contracts.",
        ignored: false,
        perspective: {
          kind: "runtime-integrations",
          source: "codebase-importer",
          generated: true,
          question: "What communicates at runtime?",
          confidence: "medium",
          evidenceBasis: ["literal channels"],
          limitations: ["Dynamic configuration is not visible."],
          checkedAt: "2026-07-13T00:00:00.000Z",
          coverage: { subjects: 0, relations: 0, observedRelations: 0, inferredRelations: 0 }
        },
        nodes: [],
        edges: [],
        subflows: [],
        groups: [],
        updatedAt: "2026-07-13T00:00:00.000Z"
      }
    };

    expect(() => validateResearchChangeSet(bundle, { type: "project", projectId: bundle.project.id }, [operation])).not.toThrow();
    await applyResearchOperation(root, operation);
    const persisted = (await loadProject(root)).flows.find((flow) => flow.id === "flow-runtime");
    expect(persisted?.perspective?.kind).toBe("runtime-integrations");
    expect(persisted?.perspective?.question).toBe("What communicates at runtime?");
    await expect(applyResearchOperation(root, operation)).rejects.toThrow("already exists");
  });

  it("stages production-approved import operations safely, then promotes persisted imported nodes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-import-stage-"));
    await ensureEmptyCodebaseProject(root);
    const operation: ResearchGraphOperation = {
      kind: "create-flow",
      flow: {
        id: "flow-imported",
        name: "Imported System",
        description: "An existing implemented system.",
        ignored: false,
        nodes: [{
          id: "node-imported",
          type: "system",
          title: "Imported Runtime",
          description: "Observed implementation.",
          stage: "draft-approved-production",
          ignored: false,
          flags: ["changed", "needs-attention"],
          locked: false,
          visual: { shape: "hexagon" },
          position: { x: 0, y: 0 },
          techStack: ["TypeScript"],
          acceptanceCriteria: ["Existing behavior remains represented"],
          acceptanceChecks: [],
          subjectRef: { id: "code:imported", kind: "code", evidenceStatus: "observed" },
          customProperties: {},
          attachments: [],
          todos: [],
          updatedAt: "2026-07-13T00:00:00.000Z"
        }],
        edges: [],
        subflows: [],
        groups: [],
        updatedAt: "2026-07-13T00:00:00.000Z"
      }
    };

    const staged = prepareCodebaseImportOperationForApplication(operation);
    expect(operation.flow.nodes[0].stage).toBe("draft-approved-production");
    expect(staged.kind === "create-flow" && staged.flow.nodes[0].stage).toBe("draft");
    await applyResearchOperation(root, staged);
    const persisted = (await loadProject(root)).flows.find((flow) => flow.id === "flow-imported");
    expect(persisted?.nodes[0].stage).toBe("draft");
    const finalized = enrichImportedNodes(persisted!, []).nodes[0];
    expect(finalized.stage).toBe("draft-approved-production");
    expect(finalized.flags).not.toContain("changed");
    expect(finalized.flags).toContain("needs-attention");
  });

  it("materializes an importer transaction with the same graph shape as sequential application", async () => {
    const sequentialRoot = await mkdtemp(path.join(tmpdir(), "archicode-import-sequential-"));
    const batchRoot = await mkdtemp(path.join(tmpdir(), "archicode-import-batch-"));
    const sequentialBundle = await ensureEmptyCodebaseProject(sequentialRoot);
    const batchBundle = await ensureEmptyCodebaseProject(batchRoot);
    const flowId = sequentialBundle.flows[0].id;
    expect(batchBundle.flows[0].id).toBe(flowId);
    const operations: ResearchGraphOperation[] = [
      { kind: "update-flow", flowId, patch: { name: "Imported Architecture", description: "Evidence-backed codebase map." } },
      { kind: "create-group", flowId, group: { id: "group-runtime", name: "Runtime", color: "#4f46e5" } },
      { kind: "create-node", flowId, node: { id: "node-module", type: "module", title: "Application", description: "Application root.", stage: "draft-approved-production", ignored: false, flags: ["changed"], locked: false, visual: { shape: "rectangle" }, position: { x: 120, y: 120 }, groupId: "group-runtime", techStack: [], acceptanceCriteria: [], acceptanceChecks: [], customProperties: {}, attachments: [], todos: [] } },
      { kind: "create-subflow", flowId, subflow: { id: "subflow-components", name: "Components", ignored: false, parentNodeId: "node-module" } },
      { kind: "create-node", flowId, node: { id: "node-component", type: "component", title: "UI", description: "User interface.", stage: "draft-approved-production", ignored: false, flags: ["changed"], locked: false, visual: { shape: "rectangle" }, position: { x: 360, y: 120 }, subflowId: "subflow-components", groupId: "group-runtime", techStack: [], acceptanceCriteria: [], acceptanceChecks: [], customProperties: {}, attachments: [], todos: [] } },
      { kind: "create-edge", flowId, edge: { id: "edge-module-ui", source: "node-module", target: "node-component", label: "contains" } }
    ];

    for (const operation of operations) {
      await applyResearchOperation(sequentialRoot, prepareCodebaseImportOperationForApplication(operation));
    }
    const materialized = materializeCodebaseMapOperations(batchBundle, operations);
    expect(materialized.operationIndexes).toHaveLength(operations.length);
    await saveFlows(batchRoot, materialized.flows, {
      recordGraphChanges: true,
      actor: "accepted-research",
      graphChangeStatus: "implemented"
    });

    const stripVolatile = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripVolatile);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "updatedAt" && key !== "checkedAt")
        .map(([key, item]) => [key, stripVolatile(item)]));
    };
    const sequential = (await loadProject(sequentialRoot)).flows.find((flow) => flow.id === flowId)!;
    const batched = (await loadProject(batchRoot)).flows.find((flow) => flow.id === flowId)!;
    expect(stripVolatile(batched)).toEqual(stripVolatile(sequential));
    expect(batched.nodes.every((node) => node.stage === "draft")).toBe(true);

    const ledger = (await readFile(path.join(batchRoot, ".archicode", "graph-changes.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { kind: string; status: string; resolvedAt?: string });
    expect(new Set(ledger.map((record) => record.kind))).toEqual(new Set([
      "flow-updated", "group-created", "subflow-created", "node-created", "edge-created"
    ]));
    expect(ledger.every((record) => record.status === "implemented" && record.resolvedAt)).toBe(true);
  });

  it("rejects a dangling importer operation without mutating the source bundle or disk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-import-atomic-failure-"));
    const bundle = await ensureEmptyCodebaseProject(root);
    const flowId = bundle.flows[0].id;
    const beforeBundle = JSON.stringify(bundle);
    const beforeDisk = await readFile(path.join(root, ".archicode", "flows", `${flowId}.json`), "utf8");
    const operations: ResearchGraphOperation[] = [{
      kind: "create-edge",
      flowId,
      edge: { id: "edge-dangling", source: "missing-source", target: "missing-target" }
    }];

    expect(() => materializeCodebaseMapOperations(bundle, operations)).toThrow("Source node missing-source was not found");
    expect(JSON.stringify(bundle)).toBe(beforeBundle);
    expect(await readFile(path.join(root, ".archicode", "flows", `${flowId}.json`), "utf8")).toBe(beforeDisk);
  });
});
