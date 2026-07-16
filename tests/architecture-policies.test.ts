import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { architecturePolicyBaselineViolationIds, blockingArchitecturePolicyViolationsSinceBaseline, blockingNewArchitecturePolicyViolations, evaluateAndStoreArchitecturePolicies, evaluateArchitecturePolicies, matchesArchitecturePathGlob, readArchitecturePolicyEvaluation, refreshGraphArchitecturePolicyEvaluation } from "../src/main/policies/architecturePolicies";
import { createSeedProject } from "../src/shared/fixtures";
import { nodeRuleSchema, projectBundleSchema } from "../src/shared/schema";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function policyBundle() {
  const { project, flow } = createSeedProject("/tmp/architecture-policies");
  const [sourceNode, targetNode] = flow.nodes;
  const checkedFlow = {
    ...flow,
    nodes: [
      {
        ...sourceNode,
        implementationScope: {
          source: "codebase-importer" as const,
          analyzerVersion: 1,
          claims: [{ relation: "own" as const, kind: "directory" as const, path: "src/renderer" }]
        }
      },
      {
        ...targetNode,
        implementationScope: {
          source: "codebase-importer" as const,
          analyzerVersion: 1,
          claims: [{ relation: "own" as const, kind: "directory" as const, path: "src/main" }]
        }
      }
    ]
  };
  return projectBundleSchema.parse({
    rootPath: project.rootPath,
    project: {
      ...project,
      settings: {
        ...project.settings,
        nodeRules: [{
          id: "policy-renderer-main",
          title: "Renderer stays behind preload",
          body: "Use the preload bridge instead of importing main-process modules.",
          kind: "policy",
          status: "active",
          severity: "error",
          enforcement: "enforced",
          constraint: {
            kind: "forbidden-dependency",
            fromPathGlobs: ["src/renderer/**"],
            toPathGlobs: ["src/main/**"]
          },
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z"
        }]
      }
    },
    flows: [checkedFlow],
    notes: [],
    runs: [],
    artifacts: [],
    summaries: []
  });
}

function bundleWithPolicies(constraints: Array<Record<string, unknown>>) {
  const base = policyBundle();
  const createdAt = "2026-07-15T00:00:00.000Z";
  const rules = constraints.map((constraint, index) => ({
    id: `policy-${index}`,
    title: `Policy ${index}`,
    body: `Deterministic policy ${index}.`,
    kind: "policy" as const,
    status: "active" as const,
    severity: "warning" as const,
    enforcement: "advisory" as const,
    constraint,
    createdAt,
    updatedAt: createdAt
  }));
  return projectBundleSchema.parse({
    ...base,
    project: { ...base.project, settings: { ...base.project.settings, nodeRules: rules } },
    flows: base.flows.map((flow, flowIndex) => ({
      ...flow,
      nodes: flow.nodes.map((node, nodeIndex) => ({
        ...node,
        ruleIds: flowIndex === 0 && nodeIndex === 0 ? rules.map((rule) => rule.id) : []
      }))
    }))
  });
}

describe("architecture policies", () => {
  it("matches normalized repository path globs", () => {
    expect(matchesArchitecturePathGlob("src/renderer/App.tsx", "src/renderer/**")).toBe(true);
    expect(matchesArchitecturePathGlob("./src/renderer/views/App.tsx", "src/**/App.tsx")).toBe(true);
    expect(matchesArchitecturePathGlob("src/main/index.ts", "src/renderer/**")).toBe(false);
    expect(matchesArchitecturePathGlob("src/renderer/App.tsx", "src/renderer/*.tsx")).toBe(true);
    expect(matchesArchitecturePathGlob("src/renderer/views/App.tsx", "src/renderer/*.tsx")).toBe(false);
  });

  it("keeps legacy prose rules backward compatible", () => {
    const legacy = nodeRuleSchema.parse({
      id: "legacy-rule",
      title: "Keep changes focused",
      body: "Avoid unrelated edits.",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    });
    expect(legacy).toMatchObject({ id: "legacy-rule", title: "Keep changes focused" });
    expect(legacy.kind).toBeUndefined();
    expect(legacy.status).toBeUndefined();
    expect(legacy.constraint).toBeUndefined();
  });

  it("detects forbidden static dependencies with source evidence and graph assignments", () => {
    const bundle = policyBundle();
    const checkedAt = "2026-07-15T12:00:00.000Z";
    const evaluation = evaluateArchitecturePolicies(bundle, [{
      from: "src/renderer/App.tsx",
      to: "src/main/storage/projectStore.ts",
      kinds: ["static"],
      evidence: [{ line: 12, specifier: "../main/storage/projectStore" }]
    }], checkedAt);

    expect(evaluation.stats).toEqual({ policiesEvaluated: 1, edgesChecked: 1, violations: 1 });
    expect(evaluation.violations[0]).toMatchObject({
      policyId: "policy-renderer-main",
      severity: "error",
      enforcement: "enforced",
      source: { path: "src/renderer/App.tsx", line: 12, flowId: bundle.flows[0].id, nodeId: bundle.flows[0].nodes[0].id },
      target: { path: "src/main/storage/projectStore.ts", flowId: bundle.flows[0].id, nodeId: bundle.flows[0].nodes[1].id },
      checkedAt,
      firstSeenAt: checkedAt
    });
  });

  it("skips derived runtime relationships unless the policy opts into them", () => {
    const bundle = policyBundle();
    const evaluation = evaluateArchitecturePolicies(bundle, [{
      from: "src/renderer/App.tsx",
      to: "src/main/index.ts",
      confidence: 0.95,
      relationKinds: ["ipc"],
      evidence: [{ line: 22, specifier: "archicode:load-project" }]
    }], "2026-07-15T12:00:00.000Z");
    expect(evaluation.violations).toEqual([]);
  });

  it("checks required dependencies, allowed boundaries, and dependency cycles", () => {
    const bundle = bundleWithPolicies([
      { kind: "required-dependency", fromPathGlobs: ["src/features/**"], toPathGlobs: ["src/shared/**"] },
      { kind: "allowed-dependency", fromPathGlobs: ["src/features/**"], allowedPathGlobs: ["src/shared/**"] },
      { kind: "no-cycles", pathGlobs: ["src/cycle/**"] }
    ]);
    const evaluation = evaluateArchitecturePolicies(bundle, [
      { from: "src/features/Good.ts", to: "src/shared/api.ts", evidence: [{ line: 2, specifier: "../shared/api" }] },
      { from: "src/features/Bad.ts", to: "src/main/private.ts", evidence: [{ line: 4, specifier: "../main/private" }] },
      { from: "src/cycle/a.ts", to: "src/cycle/b.ts", evidence: [{ line: 1, specifier: "./b" }] },
      { from: "src/cycle/b.ts", to: "src/cycle/a.ts", evidence: [{ line: 1, specifier: "./a" }] }
    ], "2026-07-15T12:00:00.000Z", null, {
      files: ["src/features/Good.ts", "src/features/Bad.ts", "src/shared/api.ts", "src/main/private.ts", "src/cycle/a.ts", "src/cycle/b.ts"].map((relPath) => ({ relPath, ext: ".ts", sizeBytes: 10, language: "typescript" as const, role: "production" as const }))
    });

    expect(evaluation.violations.filter((violation) => violation.kind === "required-dependency")).toHaveLength(1);
    expect(evaluation.violations.filter((violation) => violation.kind === "allowed-dependency")).toHaveLength(1);
    expect(evaluation.violations.filter((violation) => violation.kind === "no-cycles")).toHaveLength(1);
  });

  it("checks forbidden imports, file conventions, and required companion files", () => {
    const bundle = bundleWithPolicies([
      { kind: "forbidden-import", fromPathGlobs: ["src/**"], importGlobs: ["node:fs"], importedNames: ["readFile"] },
      { kind: "file-convention", pathGlobs: ["src/components/**"], allowedPathGlobs: ["src/components/**"], fileNameStyle: "PascalCase" },
      { kind: "required-companion-file", sourcePathGlobs: ["src/services/**"], companionPathGlobs: ["tests/**/*.test.ts"], match: "same-stem" }
    ]);
    const files = ["src/components/bad-name.ts", "src/services/Payment.ts", "src/services/Missing.ts", "tests/Payment.test.ts"]
      .map((relPath) => ({ relPath, ext: ".ts", sizeBytes: 10, language: "typescript" as const, role: relPath.startsWith("tests/") ? "test" as const : "production" as const }));
    const evaluation = evaluateArchitecturePolicies(bundle, [], "2026-07-15T12:00:00.000Z", null, {
      files,
      parsedFiles: [{
        relPath: "src/services/Payment.ts",
        language: "typescript",
        imports: [{ specifier: "node:fs", kind: "static", importedNames: ["readFile"], line: 3 }],
        declaredNamespaces: [],
        symbols: [],
        exportCount: 0,
        loc: 10
      }]
    });

    expect(evaluation.violations.filter((violation) => violation.kind === "forbidden-import")).toHaveLength(1);
    expect(evaluation.violations.filter((violation) => violation.kind === "file-convention")).toHaveLength(1);
    expect(evaluation.violations.filter((violation) => violation.kind === "required-companion-file").map((violation) => violation.source.path)).toEqual(["src/services/Missing.ts"]);
  });

  it("checks node metadata, required and forbidden relationships, and orphan nodes", () => {
    const base = bundleWithPolicies([
      { kind: "required-node-metadata", scope: "attached", field: "acceptance-criteria" },
      { kind: "node-relationship", scope: "attached", mode: "required", direction: "outgoing", targetNodeTypes: ["database"] },
      { kind: "node-relationship", scope: "attached", mode: "forbidden", direction: "outgoing", targetNodeTypes: ["task"] },
      { kind: "no-orphan-nodes", scope: "attached" }
    ]);
    const [source, target] = base.flows[0].nodes;
    const bundle = projectBundleSchema.parse({
      ...base,
      flows: [{
        ...base.flows[0],
        nodes: [
          { ...source, acceptanceCriteria: [], ruleIds: ["policy-0", "policy-1", "policy-2"] },
          { ...target, type: "task", ruleIds: ["policy-3"] }
        ],
        edges: [{ id: "forbidden-graph-edge", source: source.id, target: target.id, label: "calls" }]
      }]
    });
    const evaluation = evaluateArchitecturePolicies(bundle, [], "2026-07-15T12:00:00.000Z");

    expect(evaluation.violations.filter((violation) => violation.kind === "required-node-metadata")).toHaveLength(1);
    expect(evaluation.violations.filter((violation) => violation.kind === "node-relationship" && !violation.target)).toHaveLength(1);
    expect(evaluation.violations.filter((violation) => violation.kind === "node-relationship" && violation.target)).toHaveLength(1);
    expect(evaluation.violations.filter((violation) => violation.kind === "no-orphan-nodes")).toHaveLength(0);

    const orphanBundle = projectBundleSchema.parse({
      ...bundle,
      flows: [{ ...bundle.flows[0], edges: [], nodes: bundle.flows[0].nodes.map((node) => node.id === target.id ? { ...node, ruleIds: ["policy-3"] } : { ...node, ruleIds: [] }) }]
    });
    expect(evaluateArchitecturePolicies(orphanBundle, [], "2026-07-15T12:00:00.000Z").violations.filter((violation) => violation.kind === "no-orphan-nodes")).toHaveLength(1);
  });

  it("preserves stable violation identity and first-seen time across evaluations", () => {
    const bundle = policyBundle();
    const edge = {
      from: "src/renderer/App.tsx",
      to: "src/main/index.ts",
      evidence: [{ line: 3, specifier: "../main" }]
    };
    const first = evaluateArchitecturePolicies(bundle, [edge], "2026-07-15T12:00:00.000Z");
    const second = evaluateArchitecturePolicies(bundle, [edge], "2026-07-15T12:05:00.000Z", first);
    expect(second.violations[0].id).toBe(first.violations[0].id);
    expect(second.violations[0].firstSeenAt).toBe("2026-07-15T12:00:00.000Z");
    expect(second.violations[0].checkedAt).toBe("2026-07-15T12:05:00.000Z");
  });

  it("blocks only newly introduced enforced errors when a baseline exists", () => {
    const evaluation = evaluateArchitecturePolicies(policyBundle(), [{
      from: "src/renderer/App.tsx",
      to: "src/main/index.ts",
      evidence: [{ line: 7, specifier: "../main" }]
    }], "2026-07-15T12:00:00.000Z");
    const violationId = evaluation.violations[0].id;
    expect(blockingNewArchitecturePolicyViolations({
      evaluation,
      changed: true,
      baselineAvailable: false,
      newViolationIds: [violationId]
    })).toEqual([]);
    expect(blockingNewArchitecturePolicyViolations({
      evaluation,
      changed: true,
      baselineAvailable: true,
      newViolationIds: [violationId]
    }).map((violation) => violation.id)).toEqual([violationId]);
    expect(blockingNewArchitecturePolicyViolations({
      evaluation,
      changed: false,
      baselineAvailable: true,
      newViolationIds: []
    })).toEqual([]);
  });

  it("keeps a run-scoped baseline stable across global evaluation refreshes", () => {
    const evaluation = evaluateArchitecturePolicies(policyBundle(), [{
      from: "src/renderer/App.tsx",
      to: "src/main/index.ts",
      evidence: [{ line: 7, specifier: "../main" }]
    }], "2026-07-15T12:00:00.000Z");
    const violationId = evaluation.violations[0].id;

    expect(blockingArchitecturePolicyViolationsSinceBaseline(evaluation, []).map((violation) => violation.id)).toEqual([violationId]);
    expect(blockingArchitecturePolicyViolationsSinceBaseline(evaluation, [violationId])).toEqual([]);
  });

  it("rejects a cached baseline when the policy definition has changed", () => {
    const bundle = policyBundle();
    const evaluation = evaluateArchitecturePolicies(bundle, [], "2026-07-15T12:00:00.000Z");
    const withEvaluation = projectBundleSchema.parse({ ...bundle, policyEvaluation: evaluation });
    expect(architecturePolicyBaselineViolationIds(withEvaluation)).toEqual([]);

    const changed = projectBundleSchema.parse({
      ...withEvaluation,
      project: {
        ...withEvaluation.project,
        settings: {
          ...withEvaluation.project.settings,
          nodeRules: (withEvaluation.project.settings.nodeRules ?? []).map((rule) => ({ ...rule, enforcement: "advisory" as const }))
        }
      }
    });
    expect(architecturePolicyBaselineViolationIds(changed)).toBeUndefined();
  });

  it("persists derived evaluations and uses the previous violation set as the next baseline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-policy-state-"));
    roots.push(root);
    const base = policyBundle();
    const bundle = projectBundleSchema.parse({ ...base, rootPath: root, project: { ...base.project, rootPath: root } });
    const edge = {
      from: "src/renderer/App.tsx",
      to: "src/main/index.ts",
      evidence: [{ line: 7, specifier: "../main" }]
    };

    const first = await evaluateAndStoreArchitecturePolicies(root, bundle, [edge], "2026-07-15T12:00:00.000Z");
    const second = await evaluateAndStoreArchitecturePolicies(root, bundle, [edge], "2026-07-15T12:05:00.000Z");

    expect(first.baselineAvailable).toBe(false);
    expect(first.newViolationIds).toHaveLength(1);
    expect(second.baselineAvailable).toBe(true);
    expect(second.newViolationIds).toEqual([]);
    expect(second.changed).toBe(false);
    expect((await readArchitecturePolicyEvaluation(root))?.violations[0].firstSeenAt).toBe("2026-07-15T12:00:00.000Z");
  });

  it("re-evaluates graph-only policies after graph edits without rescanning source files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-graph-policy-state-"));
    roots.push(root);
    const base = bundleWithPolicies([{ kind: "required-node-metadata", scope: "attached", field: "acceptance-criteria" }]);
    const initialBundle = projectBundleSchema.parse({
      ...base,
      rootPath: root,
      project: { ...base.project, rootPath: root },
      flows: base.flows.map((flow) => ({ ...flow, nodes: flow.nodes.map((node, index) => index === 0 ? { ...node, acceptanceCriteria: ["Defined"] } : node) }))
    });
    await evaluateAndStoreArchitecturePolicies(root, initialBundle, [], "2026-07-15T12:00:00.000Z");
    const changedBundle = projectBundleSchema.parse({
      ...initialBundle,
      flows: initialBundle.flows.map((flow) => ({ ...flow, nodes: flow.nodes.map((node, index) => index === 0 ? { ...node, acceptanceCriteria: [] } : node) }))
    });

    const result = await refreshGraphArchitecturePolicyEvaluation(root, changedBundle, "2026-07-15T12:01:00.000Z");
    expect(result?.changed).toBe(true);
    expect(result?.evaluation.violations).toHaveLength(1);
    expect(result?.evaluation.violations[0]).toMatchObject({ kind: "required-node-metadata", source: { entityKind: "node" } });
  });
});
