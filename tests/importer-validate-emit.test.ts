import { describe, expect, it } from "vitest";
import { researchGraphOperationSchema } from "../src/shared/schema";
import { emitImportOperations } from "../src/main/importer/emit";
import { validateImportAnnotations } from "../src/main/importer/validate";
import type { ImportAnnotations, ModuleGraph } from "../src/main/importer/types";

const GRAPH: ModuleGraph = {
  levels: "2",
  granularity: "module",
  entrypoints: [],
  clusters: [
    { id: "cluster-src-ui", path: "src/ui", title: "Ui", unit: "area", tier: 1, files: ["src/ui/a.ts"], loc: 100, languages: ["typescript"], topFiles: ["src/ui/a.ts"], externalDeps: ["react"], docTitles: [], symbols: [] },
    { id: "cluster-src-core", path: "src/core", title: "Core", unit: "area", tier: 1, files: ["src/core/b.ts"], loc: 200, languages: ["typescript"], topFiles: ["src/core/b.ts"], externalDeps: [], docTitles: [], symbols: [] },
    { id: "cluster-src-ui-widgets", path: "src/ui/widgets", title: "Widgets", unit: "module", tier: 2, parentClusterId: "cluster-src-ui", files: ["src/ui/widgets/w.ts"], loc: 50, languages: ["typescript"], topFiles: ["src/ui/widgets/w.ts"], externalDeps: [], docTitles: [], symbols: ["Widget", "renderWidget"], symbolRefs: [{ path: "src/ui/widgets/w.ts", name: "Widget", kind: "class" }, { path: "src/ui/widgets/w.ts", name: "renderWidget", kind: "function" }] }
  ],
  edges: [
    { source: "cluster-src-ui", target: "cluster-src-core", importCount: 3, sampleImports: ["src/ui/a.ts → src/core/b.ts"] }
  ]
};

function fullAnnotations(): ImportAnnotations {
  return {
    projectNode: { title: "Demo", description: "Demo owns the whole product surface.", techStack: ["TypeScript"], acceptanceCriteria: ["Map matches repo"], visual: { shape: "hexagon" } },
    clusters: [
      { id: "cluster-src-ui", title: "UI", type: "system", description: "UI renders every screen and widget of the product.", techStack: ["React"], acceptanceCriteria: ["Screens render"], visual: { backgroundColor: "#4f83cc", shape: "rounded" }, groupName: "Frontend" },
      { id: "cluster-src-core", title: "Core", type: "system", description: "Core owns domain logic and persistence for the product.", techStack: ["TypeScript"], acceptanceCriteria: ["Logic tested"] },
      { id: "cluster-src-ui-widgets", title: "Widgets", type: "component", description: "Widgets implements the reusable controls used by every screen.", techStack: ["React"], acceptanceCriteria: ["Controls documented"] }
    ],
    groups: [{ name: "Frontend", color: "#5fa88a", memberClusterIds: ["cluster-src-ui"] }],
    edgeLabels: [{ source: "cluster-src-ui", target: "cluster-src-core", label: "renders state" }],
    subflowNames: ["Modules"],
    summary: "Two-level demo map."
  };
}

describe("import annotation validation", () => {
  it("accepts complete annotations", () => {
    expect(validateImportAnnotations(fullAnnotations(), GRAPH, "2")).toEqual([]);
  });

  it("rejects invented edges, unknown clusters, bad colors, and bad shapes", () => {
    const annotations = fullAnnotations();
    annotations.edgeLabels.push({ source: "cluster-src-core", target: "cluster-src-ui", label: "made up" });
    annotations.clusters.push({ id: "cluster-invented", title: "X", type: "system", description: "Invented cluster description.", techStack: [], acceptanceCriteria: [] });
    annotations.clusters[0].visual = { backgroundColor: "blue", shape: "blob" };
    const errors = validateImportAnnotations(annotations, GRAPH, "2");
    expect(errors.some((error) => error.includes("not a detected dependency"))).toBe(true);
    expect(errors.some((error) => error.includes("unknown cluster id"))).toBe(true);
    expect(errors.some((error) => error.includes("hex color"))).toBe(true);
    expect(errors.some((error) => error.includes("shape"))).toBe(true);
  });

  it("rejects missing annotations and vague language", () => {
    const annotations = fullAnnotations();
    annotations.clusters = annotations.clusters.slice(0, 2);
    annotations.clusters[0].description = "Handles screens such as settings, etc.";
    const errors = validateImportAnnotations(annotations, GRAPH, "2");
    expect(errors.some((error) => error.includes("was not annotated"))).toBe(true);
    expect(errors.some((error) => error.includes("vague briefing language"))).toBe(true);
  });

  it("only allows merges within the same level", () => {
    const annotations = fullAnnotations();
    annotations.clusters[2].mergeInto = "cluster-src-ui";
    const errors = validateImportAnnotations(annotations, GRAPH, "2");
    expect(errors.some((error) => error.includes("same level"))).toBe(true);
  });
});

describe("import operation emission", () => {
  const checkedAt = "2026-07-10T00:00:00.000Z";

  it("emits schema-valid operations with deterministic fallbacks when the LLM is unavailable", () => {
    const operations = emitImportOperations({ flowId: "flow-1", moduleGraph: GRAPH, annotations: null, projectName: "demo", codebaseHints: ["TypeScript"], checkedAt });
    for (const operation of operations) {
      expect(researchGraphOperationSchema.safeParse(operation).success).toBe(true);
    }
    const nodeOps = operations.filter((operation) => operation.kind === "create-node");
    expect(nodeOps.some((operation) => operation.kind === "create-node" && operation.node.id === "node-project")).toBe(true);
    const uiNode = nodeOps.find((operation) => operation.kind === "create-node" && operation.node.id === "node-src-ui");
    expect(uiNode && uiNode.kind === "create-node" ? uiNode.node.description : "").toContain("owns");
    expect(uiNode && uiNode.kind === "create-node" ? uiNode.node.visual.backgroundColor : "").toMatch(/^#[0-9a-f]{6}$/i);
    expect(uiNode && uiNode.kind === "create-node" ? uiNode.node.implementationScope?.claims : []).toEqual([
      { relation: "cover", kind: "directory", path: "src/ui" }
    ]);
    const widgetNode = nodeOps.find((operation) => operation.kind === "create-node" && operation.node.id === "node-src-ui-widgets");
    expect(widgetNode).toBeUndefined();
    const projectNode = nodeOps.find((operation) => operation.kind === "create-node" && operation.node.id === "node-project");
    expect(projectNode && projectNode.kind === "create-node" ? projectNode.node.implementationScope : undefined).toEqual({
      source: "codebase-importer",
      analyzerVersion: 1,
      checkedAt,
      claims: [{ relation: "cover", kind: "directory", path: "." }]
    });
    const subflows = operations.filter((operation) => operation.kind === "create-subflow");
    expect(subflows).toHaveLength(0);
    const edges = operations.filter((operation) => operation.kind === "create-edge");
    expect(edges).toHaveLength(1);
    expect(edges[0].kind === "create-edge" ? edges[0].edge.label : "").toBe("imports (3 files)");
    expect(edges[0].kind === "create-edge" ? edges[0].edge.evidence : undefined).toMatchObject({
      origin: "extracted",
      confidence: 1,
      checkedAt,
      freshness: "current"
    });
  });

  it("orders create-group before member nodes and applies annotation styling", () => {
    const operations = emitImportOperations({ flowId: "flow-1", moduleGraph: GRAPH, annotations: fullAnnotations(), projectName: "demo", codebaseHints: [], checkedAt });
    const groupIndex = operations.findIndex((operation) => operation.kind === "create-group");
    const memberIndex = operations.findIndex((operation) => operation.kind === "create-node" && operation.node.groupId);
    expect(groupIndex).toBeGreaterThanOrEqual(0);
    expect(memberIndex).toBeGreaterThan(groupIndex);
    const uiNode = operations.find((operation) => operation.kind === "create-node" && operation.node.id === "node-src-ui");
    expect(uiNode && uiNode.kind === "create-node" ? uiNode.node.visual : {}).toEqual({ backgroundColor: "#4f83cc", shape: "rounded" });
    const edge = operations.find((operation) => operation.kind === "create-edge");
    expect(edge && edge.kind === "create-edge" ? edge.edge.label : "").toBe("renders state");
    expect(operations.some((operation) => operation.kind === "create-subflow")).toBe(false);
  });

  it("uses preserved symbol and runtime evidence in deterministic edge labels", () => {
    const symbolGraph: ModuleGraph = {
      ...GRAPH,
      edges: [{ ...GRAPH.edges[0], occurrences: 3, importedNames: ["loadProfile", "saveProfile"], relationKinds: ["dependency"] }]
    };
    const symbolEdge = emitImportOperations({ flowId: "flow-1", moduleGraph: symbolGraph, annotations: null, projectName: "demo", codebaseHints: [], checkedAt })
      .find((operation) => operation.kind === "create-edge");
    expect(symbolEdge && symbolEdge.kind === "create-edge" ? symbolEdge.edge.label : "").toBe("imports loadProfile, saveProfile (3)");

    const runtimeGraph: ModuleGraph = {
      ...GRAPH,
      edges: [{ ...GRAPH.edges[0], occurrences: 1, relationKinds: ["http"], evidence: [{ from: "src/ui/a.ts", to: "src/core/b.ts", line: 8, specifier: "http:POST /api/profile" }] }]
    };
    const runtimeEdge = emitImportOperations({ flowId: "flow-1", moduleGraph: runtimeGraph, annotations: null, projectName: "demo", codebaseHints: [], checkedAt })
      .find((operation) => operation.kind === "create-edge");
    expect(runtimeEdge && runtimeEdge.kind === "create-edge" ? runtimeEdge.edge.label : "").toBe("HTTP POST /api/profile (1)");
    expect(runtimeEdge && runtimeEdge.kind === "create-edge" ? runtimeEdge.edge.evidence : undefined).toMatchObject({ origin: "resolved", verification: "unresolved" });
    expect(symbolEdge && symbolEdge.kind === "create-edge" ? symbolEdge.edge.evidence : undefined).toMatchObject({ origin: "extracted", verification: "verified" });
  });

  it("folds merged clusters into their target and drops collapsed edges", () => {
    const annotations = fullAnnotations();
    annotations.clusters.find((cluster) => cluster.id === "cluster-src-core")!.mergeInto = "cluster-src-ui";
    const operations = emitImportOperations({ flowId: "flow-1", moduleGraph: GRAPH, annotations, projectName: "demo", codebaseHints: [], checkedAt });
    const nodeIds = operations.filter((operation) => operation.kind === "create-node").map((operation) => operation.kind === "create-node" ? operation.node.id : "");
    expect(nodeIds).not.toContain("node-src-core");
    expect(operations.filter((operation) => operation.kind === "create-edge")).toHaveLength(0);
  });

  it("suppresses trivial detail flows but retains parents with three meaningful children", () => {
    const graph: ModuleGraph = {
      ...GRAPH,
      clusters: [
        ...GRAPH.clusters.slice(0, 2),
        ...["widgets", "screens", "services"].map((name) => ({
          id: `cluster-src-ui-${name}`,
          path: `src/ui/${name}`,
          title: name,
          unit: "module" as const,
          tier: 2,
          parentClusterId: "cluster-src-ui",
          files: [`src/ui/${name}/index.ts`],
          loc: 10,
          languages: ["typescript"],
          topFiles: [`src/ui/${name}/index.ts`],
          externalDeps: [],
          docTitles: [],
          symbols: []
        }))
      ]
    };
    const operations = emitImportOperations({ flowId: "flow-1", moduleGraph: graph, annotations: null, projectName: "demo", codebaseHints: [], checkedAt });
    const subflow = operations.find((operation) => operation.kind === "create-subflow");
    expect(subflow && subflow.kind === "create-subflow" ? subflow.subflow.parentNodeId : "").toBe("node-src-ui");
    expect(operations.filter((operation) => operation.kind === "create-node" && operation.node.subflowId === "subflow-src-ui")).toHaveLength(3);
  });

  it("retains a substantial two-node flow when both children are meaningful architectural units", () => {
    const graph: ModuleGraph = {
      ...GRAPH,
      clusters: [
        { ...GRAPH.clusters[0], files: ["android/Main.kt", "android/Widget.kt", "ios/App.swift", "ios/Widget.swift", "android/manifest.xml", "ios/project.pbxproj"] },
        GRAPH.clusters[1],
        { id: "cluster-native-hosts", path: "android", title: "Native App Hosts", unit: "module", tier: 2, parentClusterId: "cluster-src-ui", files: ["android/Main.kt", "ios/App.swift"], loc: 2, languages: ["kotlin", "swift"], topFiles: ["android/Main.kt"], externalDeps: [], docTitles: [], symbols: ["MainActivity", "AppDelegate"] },
        { id: "cluster-home-widgets", path: "widgets", title: "Home-Screen Widgets", unit: "module", tier: 2, parentClusterId: "cluster-src-ui", files: ["android/Widget.kt", "ios/Widget.swift"], loc: 2, languages: ["kotlin", "swift"], topFiles: ["android/Widget.kt"], externalDeps: [], docTitles: [], symbols: ["WidgetProvider"] }
      ]
    };
    const operations = emitImportOperations({ flowId: "flow-1", moduleGraph: graph, annotations: null, projectName: "demo", codebaseHints: [], checkedAt });
    expect(operations.some((operation) => operation.kind === "create-subflow" && operation.subflow.parentNodeId === "node-src-ui")).toBe(true);
    expect(operations.filter((operation) => operation.kind === "create-node" && operation.node.subflowId === "subflow-src-ui")).toHaveLength(2);
  });

  it("projects cross-scope evidence to visible ancestors without emitting hidden-scope edges", () => {
    const child = (root: "a" | "b", index: number) => ({
      id: `cluster-${root}-${index}`,
      path: `${root}/${index}.ts`,
      title: `${root}${index}`,
      unit: "component" as const,
      tier: 2,
      parentClusterId: `cluster-${root}`,
      files: [`${root}/${index}.ts`],
      loc: 1,
      languages: ["typescript"],
      topFiles: [`${root}/${index}.ts`],
      externalDeps: [],
      docTitles: [],
      symbols: []
    });
    const graph: ModuleGraph = {
      ...GRAPH,
      clusters: [
        { ...GRAPH.clusters[0], id: "cluster-a", path: "a", title: "A" },
        { ...GRAPH.clusters[1], id: "cluster-b", path: "b", title: "B" },
        ...[1, 2, 3].map((index) => child("a", index)),
        ...[1, 2, 3].map((index) => child("b", index))
      ],
      edges: [
        { source: "cluster-a", target: "cluster-b", importCount: 1, sampleImports: ["a/1.ts → b/1.ts"] },
        { source: "cluster-a-1", target: "cluster-b-1", importCount: 1, sampleImports: ["a/1.ts → b/1.ts"], importedNames: ["sharedContract"] }
      ]
    };
    const operations = emitImportOperations({ flowId: "flow-1", moduleGraph: graph, annotations: null, projectName: "demo", codebaseHints: [], checkedAt });
    const edges = operations.filter((operation) => operation.kind === "create-edge");
    expect(edges).toHaveLength(1);
    expect(edges[0].kind === "create-edge" ? [edges[0].edge.source, edges[0].edge.target] : []).toEqual(["node-a", "node-b"]);
  });

  it("collapses generic reciprocal dependencies and prefers a stronger directional label", () => {
    const reciprocal: ModuleGraph = {
      ...GRAPH,
      edges: [
        { source: "cluster-src-ui", target: "cluster-src-core", importCount: 2, sampleImports: ["ui → core"] },
        { source: "cluster-src-core", target: "cluster-src-ui", importCount: 3, sampleImports: ["core → ui"] }
      ]
    };
    const collapsed = emitImportOperations({ flowId: "flow-1", moduleGraph: reciprocal, annotations: null, projectName: "demo", codebaseHints: [], checkedAt })
      .filter((operation) => operation.kind === "create-edge");
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].kind === "create-edge" ? collapsed[0].edge.bidirectional : false).toBe(true);

    const annotations = fullAnnotations();
    const preferred = emitImportOperations({ flowId: "flow-1", moduleGraph: reciprocal, annotations, projectName: "demo", codebaseHints: [], checkedAt })
      .filter((operation) => operation.kind === "create-edge");
    expect(preferred).toHaveLength(1);
    expect(preferred[0].kind === "create-edge" ? preferred[0].edge.label : "").toBe("renders state");
    expect(preferred[0].kind === "create-edge" ? preferred[0].edge.bidirectional : true).toBeUndefined();
  });

  it("summarizes multiple runtime endpoints as contracts", () => {
    const graph: ModuleGraph = {
      ...GRAPH,
      edges: [{
        ...GRAPH.edges[0],
        occurrences: 4,
        relationKinds: ["http"],
        evidence: [
          { from: "src/ui/a.ts", to: "src/core/b.ts", specifier: "http:GET /api/profile" },
          { from: "src/ui/a.ts", to: "src/core/b.ts", specifier: "http:POST /api/profile" }
        ]
      }]
    };
    const edge = emitImportOperations({ flowId: "flow-1", moduleGraph: graph, annotations: null, projectName: "demo", codebaseHints: [], checkedAt })
      .find((operation) => operation.kind === "create-edge");
    expect(edge && edge.kind === "create-edge" ? edge.edge.label : "").toBe("2 HTTP contracts");
  });
});
