import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildModuleGraph } from "../src/main/importer/aggregate";
import { emitImportOperations, subjectRefForCluster } from "../src/main/importer/emit";
import { emitArchitectureAtlasOperations } from "../src/main/importer/atlas";
import { buildFileDependencyGraph } from "../src/main/importer/fileGraph";
import { buildContentInventory } from "../src/main/importer/inventory";
import { enrichModuleGraph } from "../src/main/importer/insights";
import { layoutScopeByDependencyDepth } from "../src/main/importer/layout";
import { parseFiles } from "../src/main/importer/parsers";
import { compareArchitectureCandidates, evaluateImportQuality } from "../src/main/importer/quality";
import { roleForFile, scanRepository } from "../src/main/importer/scanner";
import type { FileDependencyGraph, ModuleGraph, ParsedFile, RepoScan } from "../src/main/importer/types";
import type { Flow } from "../src/shared/schema";

const FIXTURES = path.resolve(process.cwd(), "fixtures", "importer");

describe("importer architecture quality", () => {
  it("classifies production and support files before clustering", () => {
    expect(roleForFile("src/main.ts")).toBe("production");
    expect(roleForFile("src/main.test.ts")).toBe("test");
    expect(roleForFile("fixtures/demo/input.ts")).toBe("fixture");
    expect(roleForFile("docs/architecture.md")).toBe("docs");
    expect(roleForFile("scripts/release.ts")).toBe("tooling");
    expect(roleForFile("package-lock.json")).toBe("config");
  });

  it("retains typed import, symbol, call, and source-line evidence", async () => {
    const root = path.join(FIXTURES, "ts-app");
    const scan = await scanRepository(root);
    const parsed = await parseFiles(root, scan.files);
    const graph = await buildFileDependencyGraph(root, scan, parsed);
    const edge = graph.edges.find((candidate) => candidate.from === "src/index.ts" && candidate.to === "src/app/index.ts");
    expect(edge?.kinds).toContain("static");
    expect(edge?.importedNames).toContain("boot");
    expect(edge?.relationKinds).toContain("calls");
    expect(edge?.evidence?.[0].line).toBe(1);
    expect(edge?.confidence).toBe(1);
  });

  it("keeps deterministic IDs unique when normalized path slugs collide", () => {
    const files = ["foo-bar/a.ts", "foo_bar/b.ts"];
    const scan: RepoScan = {
      files: files.map((relPath) => ({ relPath, ext: ".ts", sizeBytes: 0, language: "typescript", role: "production" })),
      truncated: false,
      stats: { totalFiles: files.length, byLanguage: { typescript: files.length } }
    };
    const parsed: ParsedFile[] = files.map((relPath) => ({ relPath, language: "typescript", imports: [], declaredNamespaces: [], symbols: [], exportCount: 0, loc: 1 }));
    const fileGraph: FileDependencyGraph = { edges: [], externalsByFile: new Map(), unresolved: [], resolutionRate: 1 };
    const graph = buildModuleGraph({ scan, parsed, fileGraph, levels: "1", detail: "balanced", granularity: "system" });
    expect(new Set(graph.clusters.map((cluster) => cluster.id)).size).toBe(graph.clusters.length);
  });

  it("benchmarks coverage, typed edges, entrypoints, and all mental-map projections", async () => {
    const root = path.join(FIXTURES, "flat-app");
    const scan = await scanRepository(root);
    const parsed = await parseFiles(root, scan.files);
    const fileGraph = await buildFileDependencyGraph(root, scan, parsed);
    const inventory = await buildContentInventory(root, scan);
    const graph = buildModuleGraph({ scan, parsed, fileGraph, inventory, levels: "3", detail: "balanced", granularity: "component" });
    const quality = evaluateImportQuality(graph, scan);
    expect(quality.sourceCoverage).toBe(1);
    expect(quality.uniqueClusterIds).toBe(true);
    expect(quality.typedEdgeRate).toBe(1);
    expect(quality.entrypointCoverage).toBe(1);
    expect(quality.projectionCount).toBeGreaterThanOrEqual(5);
    expect(graph.projections?.map((projection) => projection.id)).toEqual(expect.arrayContaining([
      "system",
      "functional",
      "user-journey",
      "runtime",
      "code",
      "dependency-health"
    ]));
    expect(graph.projections?.every((projection) => projection.question && projection.evidenceBasis.length)).toBe(true);
    expect(quality.warnings).toEqual([]);
  });

  it("derives UX, runtime, data, and infrastructure lenses without duplicating the canonical graph", () => {
    const scan: RepoScan = {
      files: [
        { relPath: "src/ui/screens/Home.tsx", ext: ".tsx", sizeBytes: 100, language: "tsx", role: "production" },
        { relPath: "src/data/UserRepository.ts", ext: ".ts", sizeBytes: 100, language: "typescript", role: "production" },
        { relPath: "infra/terraform/main.tf", ext: ".tf", sizeBytes: 100, language: null, role: "config" }
      ],
      truncated: false,
      stats: { totalFiles: 3, byLanguage: { tsx: 1, typescript: 1 } }
    };
    const graph: ModuleGraph = {
      levels: "1",
      granularity: "component",
      entrypoints: ["src/ui/screens/Home.tsx"],
      clusters: [
        { id: "cluster-ui", path: "src/ui", title: "User Workspace", unit: "area", tier: 1, files: ["src/ui/screens/Home.tsx"], loc: 20, languages: ["tsx"], topFiles: ["src/ui/screens/Home.tsx"], externalDeps: [], docTitles: [], symbols: ["Home"], routes: ["/home"] },
        { id: "cluster-data", path: "src/data", title: "User Data Store", unit: "area", tier: 1, files: ["src/data/UserRepository.ts"], loc: 20, languages: ["typescript"], topFiles: ["src/data/UserRepository.ts"], externalDeps: ["sqlite"], docTitles: [], symbols: ["UserRepository"] },
        { id: "cluster-infra", path: "infra/terraform", title: "Cloud Deployment", unit: "area", tier: 1, files: ["infra/terraform/main.tf"], loc: 0, languages: [], topFiles: ["infra/terraform/main.tf"], externalDeps: [], docTitles: [], symbols: [] }
      ],
      edges: [
        { source: "cluster-ui", target: "cluster-data", importCount: 1, sampleImports: ["../data/UserRepository"], relationKinds: ["calls"] },
        { source: "cluster-infra", target: "cluster-data", importCount: 1, sampleImports: ["database"] }
      ]
    };

    const enriched = enrichModuleGraph(graph, scan);
    const projections = new Map(enriched.projections?.map((projection) => [projection.id, projection]));
    expect(projections.get("user-journey")?.clusterIds).toEqual(expect.arrayContaining(["cluster-ui", "cluster-data"]));
    expect(projections.get("runtime")?.clusterIds).toEqual(expect.arrayContaining(["cluster-ui", "cluster-data"]));
    expect(projections.get("data")?.clusterIds).toContain("cluster-data");
    expect(projections.get("infrastructure")?.clusterIds).toContain("cluster-infra");
    expect(enriched.clusters).toHaveLength(graph.clusters.length);
  });

  it("keeps System Context at human-scale boundaries when a provider emits many roots", () => {
    const files = Array.from({ length: 9 }, (_, index) => `areas/area-${index}/main.ts`);
    const scan: RepoScan = {
      files: files.map((relPath) => ({ relPath, ext: ".ts", sizeBytes: 100, language: "typescript", role: "production" })),
      truncated: false,
      stats: { totalFiles: files.length, byLanguage: { typescript: files.length } }
    };
    const graph: ModuleGraph = {
      levels: "1",
      granularity: "system",
      entrypoints: [files[0], files[1]],
      clusters: files.map((file, index) => ({
        id: `cluster-${index}`,
        path: path.posix.dirname(file),
        title: `Area ${index}`,
        unit: "area",
        tier: 1,
        files: [file],
        ownedFiles: [file],
        loc: 10,
        languages: ["typescript"],
        topFiles: [file],
        externalDeps: [],
        docTitles: [],
        symbols: [`area${index}`],
        role: "production",
        ...(index === 2 ? { interactions: [{ kind: "http-route", target: "/api", file, method: "GET", confidence: 0.99 }] } : {})
      })),
      edges: files.slice(1).map((_file, index) => ({ source: `cluster-${index}`, target: `cluster-${index + 1}`, importCount: 1, sampleImports: ["next"], relationKinds: ["calls"] }))
    };
    const enriched = enrichModuleGraph(graph, scan);
    const system = enriched.projections?.find((projection) => projection.id === "system");
    expect(system?.clusterIds.length).toBeLessThanOrEqual(6);
    expect(system?.clusterIds).toEqual(expect.arrayContaining(["cluster-0", "cluster-1", "cluster-2"]));
  });

  it("rejects a provider hierarchy that loses a detected entrypoint from System Context", () => {
    const scan: RepoScan = {
      files: [
        { relPath: "lib/main.dart", ext: ".dart", sizeBytes: 20, language: "dart", role: "production" },
        { relPath: "lib/database_helper.dart", ext: ".dart", sizeBytes: 20, language: "dart", role: "production" }
      ],
      truncated: false,
      stats: { totalFiles: 2, byLanguage: { dart: 2 } }
    };
    const clusters: ModuleGraph["clusters"] = [
      { id: "cluster-app", path: "lib", title: "Mobile App", unit: "area", tier: 1, files: ["lib/main.dart"], loc: 1, languages: ["dart"], topFiles: ["lib/main.dart"], externalDeps: [], docTitles: [], symbols: ["main"], role: "production" },
      { id: "cluster-db", path: "lib/database_helper.dart", title: "Database Helper", unit: "area", tier: 1, files: ["lib/database_helper.dart"], loc: 1, languages: ["dart"], topFiles: ["lib/database_helper.dart"], externalDeps: ["sqlite"], docTitles: [], symbols: ["DatabaseHelper"], role: "production" }
    ];
    const base: ModuleGraph = {
      levels: "1", granularity: "system", entrypoints: ["lib/main.dart"], clusters, edges: [],
      projections: [
        { id: "system", title: "System Context", question: "?", description: "", evidenceBasis: [], confidence: "high", clusterIds: ["cluster-app", "cluster-db"], edgePairs: [] },
        { id: "functional", title: "Product Capabilities", question: "?", description: "", evidenceBasis: [], confidence: "medium", clusterIds: ["cluster-app"], edgePairs: [] },
        { id: "data", title: "Data", question: "?", description: "", evidenceBasis: [], confidence: "medium", clusterIds: ["cluster-db"], edgePairs: [] },
        { id: "code", title: "Modules & Components", question: "?", description: "", evidenceBasis: [], confidence: "high", clusterIds: ["cluster-app", "cluster-db"], edgePairs: [] }
      ]
    };
    const candidate = structuredClone(base);
    const system = candidate.projections?.find((projection) => projection.id === "system");
    if (system) system.clusterIds = ["cluster-db"];
    const result = compareArchitectureCandidates(base, candidate, scan);
    expect(result.accepted).toBe(false);
    expect(result.reasons.join(" ")).toContain("entrypoints");
  });

  it("rejects provider candidates that duplicate one canonical subject inside a lens", () => {
    const scan: RepoScan = {
      files: [{ relPath: "src/app.ts", ext: ".ts", sizeBytes: 10, language: "typescript" }],
      truncated: false,
      stats: { totalFiles: 1, byLanguage: { typescript: 1 } }
    };
    const cluster = { id: "cluster-app", path: "src/app.ts", title: "App", unit: "component" as const, tier: 1, files: ["src/app.ts"], loc: 1, languages: ["typescript"], topFiles: ["src/app.ts"], externalDeps: [], docTitles: [], symbols: [] };
    const baseline: ModuleGraph = {
      levels: "1",
      granularity: "component",
      entrypoints: ["src/app.ts"],
      clusters: [cluster],
      edges: [],
      projections: [
        { id: "system", title: "System Context", question: "?", description: "", evidenceBasis: [], confidence: "high", clusterIds: [cluster.id], edgePairs: [] },
        { id: "functional", title: "Product Capabilities", question: "?", description: "", evidenceBasis: [], confidence: "medium", clusterIds: [cluster.id], edgePairs: [] },
        { id: "code", title: "Modules & Components", question: "?", description: "", evidenceBasis: [], confidence: "high", clusterIds: [cluster.id], edgePairs: [] }
      ]
    };
    const duplicate = { ...cluster, id: "cluster-app-copy", title: "App Copy" };
    const candidate = structuredClone(baseline);
    candidate.clusters.push(duplicate);
    candidate.projections?.find((projection) => projection.id === "code")?.clusterIds.push(duplicate.id);

    const result = compareArchitectureCandidates(baseline, candidate, scan);
    expect(result.accepted).toBe(false);
    expect(result.reasons.join(" ")).toContain("depicts canonical subject");
  });

  it("keeps empty organizational parents distinct from their file-owning children", () => {
    const parent = { id: "cluster-parent", path: "src/feature", title: "Feature", unit: "module" as const, tier: 1, files: ["src/feature/index.ts"], ownedFiles: [], loc: 1, languages: ["typescript"], topFiles: ["src/feature/index.ts"], externalDeps: [], docTitles: [], symbols: [] };
    const child = { ...parent, id: "cluster-child", path: "src/feature/index.ts", title: "Feature Entry", unit: "component" as const, tier: 2, parentClusterId: parent.id, ownedFiles: ["src/feature/index.ts"] };
    expect(subjectRefForCluster(parent).id).not.toBe(subjectRefForCluster(child).id);
  });

  it("collapses duplicate canonical subjects within a perspective and removes alias self-edges", () => {
    const graph: ModuleGraph = {
      levels: "1",
      granularity: "component",
      entrypoints: [],
      clusters: [
        { id: "cluster-a", path: "src/shared.ts", title: "Shared", unit: "component", tier: 1, files: ["src/shared.ts"], loc: 1, languages: ["typescript"], topFiles: ["src/shared.ts"], externalDeps: [], docTitles: [], symbols: [] },
        { id: "cluster-b", path: "src/shared.ts", title: "Shared Alias", unit: "component", tier: 1, files: ["src/shared.ts"], loc: 1, languages: ["typescript"], topFiles: ["src/shared.ts"], externalDeps: [], docTitles: [], symbols: [] }
      ],
      edges: [{ source: "cluster-a", target: "cluster-b", importCount: 1, sampleImports: ["./shared"] }],
      projections: [{ id: "runtime", title: "Runtime", question: "What runs?", description: "Runtime.", evidenceBasis: ["calls"], confidence: "medium", clusterIds: ["cluster-a", "cluster-b"], subjectEvidence: [{ clusterId: "cluster-a", signals: ["entrypoint"] }, { clusterId: "cluster-b", signals: ["runtime call"] }], edgePairs: [{ source: "cluster-a", target: "cluster-b" }] }]
    };
    const atlas = emitArchitectureAtlasOperations({ baseFlowId: "flow-main", moduleGraph: graph, annotations: null, projectName: "demo", codebaseHints: [], checkedAt: "2026-07-13T00:00:00.000Z" });
    const runtime = atlas.operations.find((operation) => operation.kind === "create-flow");
    expect(runtime?.kind).toBe("create-flow");
    if (runtime?.kind === "create-flow") {
      const subjects = runtime.flow.nodes.filter((node) => node.id !== "node-project");
      expect(subjects).toHaveLength(1);
      expect(runtime.flow.edges).toHaveLength(0);
      expect(subjects[0].customProperties?.["Included because"]).toContain("entrypoint");
      expect(subjects[0].customProperties?.["Included because"]).toContain("runtime call");
    }
  });

  it("emits first-class perspective flows joined by stable subject references", () => {
    const graph: ModuleGraph = {
      levels: "1",
      granularity: "component",
      entrypoints: ["src/app.ts"],
      clusters: [
        { id: "cluster-app", path: "src/app.ts", title: "Application", unit: "component", tier: 1, files: ["src/app.ts"], ownedFiles: ["src/app.ts"], loc: 20, languages: ["typescript"], topFiles: ["src/app.ts"], externalDeps: [], docTitles: [], symbols: ["App"], interactions: [{ kind: "http-call", target: "https://api.example.com/v1/items", file: "src/app.ts", method: "GET", line: 8, confidence: 0.98 }, { kind: "http-call", target: "https://helpful.internal/", file: "src/app.ts", method: "POST", line: 9, confidence: 0.98 }] },
        { id: "cluster-store", path: "src/storage/db.ts", title: "Item Store", unit: "component", tier: 1, files: ["src/storage/db.ts"], ownedFiles: ["src/storage/db.ts"], loc: 15, languages: ["typescript"], topFiles: ["src/storage/db.ts"], externalDeps: ["sqlite"], docTitles: [], symbols: ["ItemStore"] }
      ],
      edges: [{ source: "cluster-app", target: "cluster-store", importCount: 1, sampleImports: ["./storage/db"], confidence: 1, relationKinds: ["calls"] }],
      projections: [
        { id: "system", title: "System Context", question: "What are the boundaries?", description: "System boundary view.", evidenceBasis: ["hierarchy"], confidence: "high", clusterIds: ["cluster-app", "cluster-store"], edgePairs: [{ source: "cluster-app", target: "cluster-store" }] },
        { id: "runtime", title: "Runtime & Integration Flows", question: "What calls what?", description: "Runtime view.", evidenceBasis: ["HTTP literals"], confidence: "medium", clusterIds: ["cluster-app", "cluster-store"], edgePairs: [{ source: "cluster-app", target: "cluster-store" }] }
      ]
    };
    const atlas = emitArchitectureAtlasOperations({
      baseFlowId: "flow-main",
      moduleGraph: graph,
      annotations: null,
      projectName: "demo",
      codebaseHints: ["TypeScript"],
      checkedAt: "2026-07-13T00:00:00.000Z"
    });
    const evidenceNode = atlas.operations.find((operation) => operation.kind === "create-node" && operation.node.id === "node-app");
    const runtimeFlow = atlas.operations.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "runtime-integrations");
    expect(runtimeFlow && runtimeFlow.kind === "create-flow" ? runtimeFlow.flow.perspective?.question : "").toBe("What calls what?");
    const runtimeApp = runtimeFlow && runtimeFlow.kind === "create-flow" ? runtimeFlow.flow.nodes.find((node) => node.id === "node-app") : undefined;
    expect(runtimeApp?.subjectRef).toEqual(evidenceNode && evidenceNode.kind === "create-node" ? evidenceNode.node.subjectRef : undefined);
    expect(runtimeFlow && runtimeFlow.kind === "create-flow" ? runtimeFlow.flow.nodes.find((node) => node.subjectRef?.id === "external:api.example.com") : undefined).toBeTruthy();
    expect(runtimeFlow && runtimeFlow.kind === "create-flow" ? runtimeFlow.flow.nodes.find((node) => node.subjectRef?.id === "external:helpful.internal") : undefined).toBeFalsy();
    expect(atlas.flowIds).toEqual(["flow-main", "flow-main--system-context", "flow-main--runtime-integrations"]);
  });

  it("keeps merged provider subjects identical across evidence and perspective flows", () => {
    const graph: ModuleGraph = {
      levels: "1",
      granularity: "module",
      entrypoints: [],
      clusters: [
        { id: "cluster-a", path: "src/a", title: "A", unit: "area", tier: 1, files: ["src/a.ts"], loc: 1, languages: ["typescript"], topFiles: ["src/a.ts"], externalDeps: [], docTitles: [], symbols: [] },
        { id: "cluster-b", path: "src/b", title: "B", unit: "area", tier: 1, files: ["src/b.ts"], loc: 1, languages: ["typescript"], topFiles: ["src/b.ts"], externalDeps: [], docTitles: [], symbols: [] }
      ],
      edges: [],
      projections: [{ id: "system", title: "System Context", question: "What exists?", description: "Boundaries.", evidenceBasis: ["files"], confidence: "high", clusterIds: ["cluster-a", "cluster-b"], edgePairs: [] }]
    };
    const atlas = emitArchitectureAtlasOperations({
      baseFlowId: "flow-main",
      moduleGraph: graph,
      annotations: {
        projectNode: { title: "Demo", description: "Demo.", techStack: [], acceptanceCriteria: [] },
        clusters: [
          { id: "cluster-a", title: "Combined", type: "system", description: "Combined responsibility.", techStack: [], acceptanceCriteria: [] },
          { id: "cluster-b", title: "B", type: "system", description: "Merged responsibility.", techStack: [], acceptanceCriteria: [], mergeInto: "cluster-a" }
        ],
        groups: [], edgeLabels: [], subflowNames: [], summary: ""
      },
      projectName: "demo",
      codebaseHints: [],
      checkedAt: "2026-07-13T00:00:00.000Z"
    });
    const canonical = atlas.operations.find((operation) => operation.kind === "create-node" && operation.node.id === "node-a");
    const view = atlas.operations.find((operation) => operation.kind === "create-flow");
    expect(atlas.operations.some((operation) => operation.kind === "create-node" && operation.node.id === "node-b")).toBe(false);
    expect(view && view.kind === "create-flow" ? view.flow.nodes.some((node) => node.id === "node-b") : true).toBe(false);
    expect(view && view.kind === "create-flow" ? view.flow.nodes.find((node) => node.id === "node-a")?.subjectRef : undefined)
      .toEqual(canonical && canonical.kind === "create-node" ? canonical.node.subjectRef : undefined);
  });

  it("uses direct file claims for cross-directory functional scopes", () => {
    const graph: ModuleGraph = {
      levels: "2",
      granularity: "component",
      entrypoints: [],
      clusters: [
        { id: "cluster-feature", path: "src/ui", title: "Feature", unit: "area", tier: 1, files: ["src/ui/a.ts", "src/api/a.ts"], ownedFiles: ["src/ui/a.ts", "src/api/a.ts"], loc: 2, languages: ["typescript"], topFiles: ["src/ui/a.ts"], externalDeps: [], docTitles: [], symbols: [] },
        { id: "cluster-detail", path: "src/api/a.ts", title: "Detail", unit: "file", tier: 2, parentClusterId: "cluster-feature", files: ["src/api/a.ts"], ownedFiles: ["src/api/a.ts"], loc: 1, languages: ["typescript"], topFiles: ["src/api/a.ts"], externalDeps: [], docTitles: [], symbols: [] }
      ],
      edges: []
    };
    const operations = emitImportOperations({ flowId: "flow", moduleGraph: graph, annotations: null, projectName: "x", codebaseHints: [], checkedAt: "2026-07-11T00:00:00.000Z" });
    const feature = operations.find((operation) => operation.kind === "create-node" && operation.node.id === "node-feature");
    expect(feature && feature.kind === "create-node" ? feature.node.implementationScope?.claims : []).toEqual([
      { relation: "cover", kind: "file", path: "src/ui/a.ts" },
      { relation: "cover", kind: "file", path: "src/api/a.ts" }
    ]);
  });

  it("emits grounded capability concepts while keeping the module lens hierarchical", () => {
    const children: ModuleGraph["clusters"] = [
      { id: "cluster-create", path: "src/create.ts", title: "Create Screen", unit: "component", tier: 2, parentClusterId: "cluster-app", files: ["src/create.ts"], ownedFiles: ["src/create.ts"], loc: 10, languages: ["typescript"], topFiles: ["src/create.ts"], externalDeps: [], docTitles: [], symbols: ["createWork"] },
      { id: "cluster-share", path: "src/share.ts", title: "Share Service", unit: "component", tier: 2, parentClusterId: "cluster-app", files: ["src/share.ts"], ownedFiles: ["src/share.ts"], loc: 10, languages: ["typescript"], topFiles: ["src/share.ts"], externalDeps: [], docTitles: [], symbols: ["shareWork"] },
      { id: "cluster-progress", path: "src/progress.ts", title: "Progress Provider", unit: "component", tier: 2, parentClusterId: "cluster-app", files: ["src/progress.ts"], ownedFiles: ["src/progress.ts"], loc: 10, languages: ["typescript"], topFiles: ["src/progress.ts"], externalDeps: [], docTitles: [], symbols: ["trackProgress"] }
    ];
    const root: ModuleGraph["clusters"][number] = {
      id: "cluster-app", path: "src", title: "Application", unit: "area", tier: 1,
      files: children.flatMap((cluster) => cluster.files), ownedFiles: [], loc: 30, languages: ["typescript"],
      topFiles: ["src/create.ts"], externalDeps: [], docTitles: [], symbols: []
    };
    const graph: ModuleGraph = {
      levels: "2", granularity: "component", entrypoints: ["src/create.ts"], clusters: [root, ...children],
      edges: [
        { source: "cluster-create", target: "cluster-share", importCount: 1, sampleImports: ["create → share"], importedNames: ["shareWork"], relationKinds: ["calls"] },
        { source: "cluster-share", target: "cluster-progress", importCount: 1, sampleImports: ["share → progress"], importedNames: ["trackProgress"], relationKinds: ["calls"] }
      ],
      projections: [
        { id: "functional", title: "Product Capabilities", question: "What does it do?", description: "Capabilities.", evidenceBasis: ["symbols"], confidence: "medium", clusterIds: children.map((cluster) => cluster.id), edgePairs: [] },
        { id: "code", title: "Modules & Components", question: "How is it decomposed?", description: "Modules.", evidenceBasis: ["files"], confidence: "high", clusterIds: [root.id, ...children.map((cluster) => cluster.id)], edgePairs: [{ source: "cluster-create", target: "cluster-share" }, { source: "cluster-share", target: "cluster-progress" }] }
      ]
    };
    const atlas = emitArchitectureAtlasOperations({
      baseFlowId: "flow-main", moduleGraph: graph, annotations: null, projectName: "demo", codebaseHints: ["TypeScript"], checkedAt: "2026-07-13T00:00:00.000Z",
      lensPlans: [{
        id: "functional",
        nodes: [
          { id: "create", title: "Create Work", type: "capability", description: "People create a new unit of work.", evidenceMembers: ["src/create.ts"] },
          { id: "share", title: "Share Work", type: "capability", description: "People share completed work.", evidenceMembers: ["src/share.ts"] },
          { id: "progress", title: "Track Progress", type: "capability", description: "People see progress over time.", evidenceMembers: ["src/progress.ts"] }
        ],
        edges: [
          { source: "create", target: "share", label: "makes work available to share" },
          { source: "share", target: "progress", label: "records the completed outcome" }
        ]
      }]
    });
    const product = atlas.operations.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "product-capabilities");
    expect(product?.kind).toBe("create-flow");
    if (product?.kind === "create-flow") {
      const capabilityNodes = product.flow.nodes.filter((node) => node.id !== "node-project");
      expect(capabilityNodes.map((node) => node.title)).toEqual(["Create Work", "Share Work", "Track Progress"]);
      expect(capabilityNodes.every((node) => node.type === "capability" && node.subjectRef?.kind === "concept")).toBe(true);
      expect(capabilityNodes.every((node) => !node.implementationScope && node.customProperties["Canonical code anchors"].startsWith("code:"))).toBe(true);
      expect(product.flow.edges.every((edge) => edge.evidence?.relationKinds.includes("capability-flow"))).toBe(true);
    }
    const modules = atlas.operations.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "modules-components");
    expect(modules?.kind).toBe("create-flow");
    if (modules?.kind === "create-flow") {
      expect(modules.flow.subflows).toHaveLength(1);
      expect(modules.flow.nodes.find((node) => node.id === "node-create")?.subflowId).toBe(modules.flow.subflows[0].id);
    }
  });

  it("builds evidence-bounded Product and ordered Journey fallbacks from behavioral contracts", () => {
    const cluster: ModuleGraph["clusters"][number] = {
      id: "cluster-server", path: "server.js", title: "Server", unit: "area", tier: 1,
      files: ["server.js"], ownedFiles: ["server.js"], loc: 80, languages: ["javascript"],
      topFiles: ["server.js"], externalDeps: [], docTitles: [], symbols: []
    };
    const contracts = [
      { file: "server.js", line: 20, text: "Welcome the user and ask about preferences and allergies", title: "Welcome user and collect preferences", terms: ["welcome", "preferences", "allergies"], sequence: 20 },
      { file: "server.js", line: 30, text: "Show the menu and make recommendations", title: "Show menu and recommend dishes", terms: ["menu", "recommend", "dishes"], sequence: 30 },
      { file: "server.js", line: 40, text: "Capture the order and request confirmation", title: "Capture and confirm order", terms: ["capture", "confirm", "order"], sequence: 40 },
      { file: "server.js", line: 50, text: "Collect a satisfaction rating and feedback", title: "Collect rating and feedback", terms: ["rating", "feedback", "collect"], sequence: 50 }
    ];
    const graph: ModuleGraph = {
      levels: "1", granularity: "system", entrypoints: ["server.js"], clusters: [cluster], edges: [], behavioralContracts: contracts,
      projections: [
        { id: "functional", title: "Product Capabilities", question: "What does it do?", description: "Capabilities.", evidenceBasis: ["behavior"], confidence: "medium", clusterIds: [cluster.id], edgePairs: [], behavioralContracts: contracts },
        { id: "user-journey", title: "User Journeys & UX", question: "What happens next?", description: "Journey.", evidenceBasis: ["behavior"], confidence: "exploratory", clusterIds: [cluster.id], edgePairs: [], behavioralContracts: contracts }
      ]
    };
    const atlas = emitArchitectureAtlasOperations({ baseFlowId: "flow-main", moduleGraph: graph, annotations: null, projectName: "demo", codebaseHints: [], checkedAt: "2026-07-14T00:00:00.000Z", expectLensPlans: true });
    const product = atlas.operations.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "product-capabilities");
    const journey = atlas.operations.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "user-journeys");
    expect(product?.kind === "create-flow" ? product.flow.nodes.map((node) => node.title) : []).toEqual(expect.arrayContaining(["Show menu and recommend dishes", "Capture and confirm order", "Collect rating and feedback"]));
    expect(product?.kind === "create-flow" ? product.flow.nodes.filter((node) => node.id !== "node-project").every((node) => node.flags.length === 0 && node.subjectRef?.kind === "concept") : false).toBe(true);
    expect(journey?.kind === "create-flow" ? journey.flow.nodes.some((node) => node.type === "actor") : false).toBe(true);
    expect(journey?.kind === "create-flow" ? journey.flow.nodes.some((node) => node.type === "outcome") : false).toBe(true);
    expect(journey?.kind === "create-flow" ? journey.flow.edges.every((edge) => edge.evidence?.relationKinds.includes("user-flow")) : false).toBe(true);
  });

  it("keeps real app and runtime boundaries in System Context ahead of nested indexes and development helpers", () => {
    const files = ["server.js", "src/main.ts", "src/router/index.ts", "src/components/Welcome.ts", "src/services/Realtime.ts"];
    const scan: RepoScan = {
      files: files.map((relPath) => ({ relPath, ext: path.extname(relPath), sizeBytes: 10, language: "typescript", role: "production" })),
      truncated: false,
      stats: { totalFiles: files.length, byLanguage: { typescript: files.length } }
    };
    const cluster = (id: string, clusterPath: string, ownedFiles: string[], interactions: ModuleGraph["clusters"][number]["interactions"] = []): ModuleGraph["clusters"][number] => ({
      id, path: clusterPath, title: clusterPath, unit: "area", tier: 1, files: ownedFiles, ownedFiles,
      loc: 10, languages: ["typescript"], topFiles: ownedFiles, externalDeps: [], docTitles: [], symbols: [], interactions
    });
    const graph: ModuleGraph = {
      levels: "1",
      granularity: "system",
      entrypoints: ["server.js", "src/main.ts", "src/router/index.ts"],
      clusters: [
        cluster("cluster-root", "(root)", ["server.js"], [{ file: "server.js", kind: "http-route", target: "/session", method: "POST" }]),
        cluster("cluster-src", "src", ["src/main.ts"]),
        cluster("cluster-router", "src/router", ["src/router/index.ts"]),
        cluster("cluster-components", "src/components", ["src/components/Welcome.ts"], [{ file: "src/components/Welcome.ts", kind: "http-call", target: "/__open-in-editor?file=README.md" }]),
        cluster("cluster-support", "(support)", ["src/services/Realtime.ts"], [{ file: "src/services/Realtime.ts", kind: "http-call", target: "https://provider.example/realtime", method: "POST" }])
      ],
      edges: [{ source: "cluster-support", target: "cluster-root", importCount: 1, kinds: ["dynamic"], relationKinds: ["http"], sampleImports: [] }]
    };
    const enriched = enrichModuleGraph(graph, scan);
    expect(enriched.projections?.find((projection) => projection.id === "system")?.clusterIds).toEqual([
      "cluster-root", "cluster-src", "cluster-support"
    ]);
  });

  it("normalizes semantic role synonyms before validating the emitted data flow", () => {
    const files = ["src/model.ts", "src/store.ts", "src/project.ts", "src/backup.ts"];
    const clusters: ModuleGraph["clusters"] = files.map((file, index) => ({
      id: `cluster-${index + 1}`,
      path: file,
      title: path.basename(file),
      unit: "component",
      tier: 1,
      files: [file],
      ownedFiles: [file],
      loc: 10,
      languages: ["typescript"],
      topFiles: [file],
      externalDeps: index === 1 ? ["prisma"] : [],
      docTitles: [],
      symbols: []
    }));
    const graph: ModuleGraph = {
      levels: "1",
      granularity: "component",
      entrypoints: [],
      clusters,
      edges: [],
      projections: [{
        id: "data",
        title: "Data Ownership & Persistence",
        question: "How does data move?",
        description: "Data flow.",
        evidenceBasis: ["storage"],
        confidence: "medium",
        clusterIds: clusters.map((cluster) => cluster.id),
        edgePairs: []
      }]
    };
    const atlas = emitArchitectureAtlasOperations({
      baseFlowId: "flow-main",
      moduleGraph: graph,
      annotations: null,
      projectName: "demo",
      codebaseHints: [],
      checkedAt: "2026-07-13T00:00:00.000Z",
      expectLensPlans: true,
      lensPlans: [{
        id: "data",
        nodes: [
          { id: "entity", title: "Account Record", type: "model", description: "Represents an account.", evidenceMembers: [files[0]] },
          { id: "store", title: "Account Database", type: "database", description: "Persists accounts.", evidenceMembers: [files[1]] },
          { id: "projection", title: "Account Projection", type: "projection", description: "Derives the displayed account.", evidenceMembers: [files[2]] },
          { id: "backup", title: "Account Backup", type: "backup transfer", description: "Transfers account history.", evidenceMembers: [files[3]] }
        ],
        edges: [
          { source: "entity", target: "store", label: "is persisted by" },
          { source: "store", target: "projection", label: "feeds the displayed projection" },
          { source: "store", target: "backup", label: "exports history to" }
        ]
      }]
    });

    expect(atlas.lensDiagnostics).toEqual([expect.objectContaining({ status: "compiled", fallbackUsed: false, emittedNodes: 4, emittedEdges: 3 })]);
    const flow = atlas.operations.find((operation) => operation.kind === "create-flow");
    expect(flow?.kind === "create-flow" ? flow.flow.nodes.filter((node) => node.id !== "node-project").map((node) => node.type) : [])
      .toEqual(["data-entity", "data-store", "data-transform", "data-sync"]);
  });

  it("rejects a raw journey that loses its outcome during evidence resolution instead of silently accepting it", () => {
    const graph: ModuleGraph = {
      levels: "1",
      granularity: "component",
      entrypoints: ["src/start.ts"],
      clusters: [
        { id: "cluster-start", path: "src/start.ts", title: "Start", unit: "component", tier: 1, files: ["src/start.ts"], ownedFiles: ["src/start.ts"], loc: 10, languages: ["typescript"], topFiles: ["src/start.ts"], externalDeps: [], docTitles: [], symbols: [] },
        { id: "cluster-screen", path: "src/screen.ts", title: "Screen", unit: "component", tier: 1, files: ["src/screen.ts"], ownedFiles: ["src/screen.ts"], loc: 10, languages: ["typescript"], topFiles: ["src/screen.ts"], externalDeps: [], docTitles: [], symbols: [] }
      ],
      edges: [{ source: "cluster-start", target: "cluster-screen", importCount: 1, sampleImports: ["start → screen"], relationKinds: ["calls"] }],
      projections: [{ id: "user-journey", title: "User Journeys & UX", question: "What does the user do?", description: "Journey.", evidenceBasis: ["routes"], confidence: "exploratory", clusterIds: ["cluster-start", "cluster-screen"], edgePairs: [{ source: "cluster-start", target: "cluster-screen" }] }]
    };
    const atlas = emitArchitectureAtlasOperations({
      baseFlowId: "flow-main",
      moduleGraph: graph,
      annotations: null,
      projectName: "demo",
      codebaseHints: [],
      checkedAt: "2026-07-13T00:00:00.000Z",
      expectLensPlans: true,
      lensPlans: [{
        id: "user-journey",
        nodes: [
          { id: "person", title: "Person", type: "actor", description: "Uses the product.", evidenceMembers: [], contextOnly: true },
          { id: "start", title: "Starts", type: "journey-step", description: "Starts the task.", evidenceMembers: ["src/start.ts"] },
          { id: "outcome", title: "Completes", type: "outcome", description: "Completes the task.", evidenceMembers: ["src/missing.ts"] }
        ],
        edges: [
          { source: "person", target: "start", label: "starts by" },
          { source: "start", target: "outcome", label: "finishes with" }
        ]
      }]
    });

    expect(atlas.lensDiagnostics[0]).toMatchObject({ status: "rejected", fallbackUsed: true, resolvedNodes: 2, emittedEdges: 1 });
    expect(atlas.lensDiagnostics[0].droppedNodes).toContainEqual({ id: "outcome", reason: "no evidenceMembers resolved to canonical code subjects" });
    expect(atlas.lensDiagnostics[0].issues).toContain("the compiled journey has no outcome");
    const flow = atlas.operations.find((operation) => operation.kind === "create-flow");
    expect(flow?.kind === "create-flow" ? flow.flow.perspective?.limitations.join(" ") : "").toContain("explicitly degraded fallback");
  });

  it("collapses near-identical overlapping runtime subjects without changing canonical evidence", () => {
    const common = ["server", "config", "client", "report", "billing", "prompt", "database", "notifications"].map((name) => `service/${name}.ts`);
    const graph: ModuleGraph = {
      levels: "1", granularity: "module", entrypoints: [],
      clusters: [
        { id: "cluster-system", path: "service", title: "Backend System", unit: "area", tier: 1, files: [...common, "service/.env.example"], ownedFiles: [...common, "service/.env.example"], loc: 10, languages: ["typescript"], topFiles: [common[0]], externalDeps: [], docTitles: [], symbols: [] },
        { id: "cluster-runtime", path: "service", title: "Backend Runtime", unit: "module", tier: 1, files: [...common, "service/runtime.ts"], ownedFiles: [...common, "service/runtime.ts"], loc: 10, languages: ["typescript"], topFiles: [common[0]], externalDeps: [], docTitles: [], symbols: [] }
      ],
      edges: [],
      projections: [{ id: "runtime", title: "Runtime", question: "What runs?", description: "Runtime.", evidenceBasis: ["entrypoints"], confidence: "medium", clusterIds: ["cluster-system", "cluster-runtime"], edgePairs: [] }]
    };
    const atlas = emitArchitectureAtlasOperations({ baseFlowId: "flow-main", moduleGraph: graph, annotations: null, projectName: "demo", codebaseHints: [], checkedAt: "2026-07-13T00:00:00.000Z" });
    const runtime = atlas.operations.find((operation) => operation.kind === "create-flow");
    expect(runtime?.kind === "create-flow" ? runtime.flow.nodes.filter((node) => node.id !== "node-project") : []).toHaveLength(1);
    expect(atlas.operations.filter((operation) => operation.kind === "create-node" && operation.flowId === "flow-main")).toHaveLength(3);
  });

  it("places cyclic nodes in the same dependency column", () => {
    const flow = {
      nodes: [
        { id: "a", title: "A", position: { x: 0, y: 0 } },
        { id: "b", title: "B", position: { x: 0, y: 0 } },
        { id: "c", title: "C", position: { x: 0, y: 0 } }
      ],
      edges: [
        { id: "ab", source: "a", target: "b" },
        { id: "ba", source: "b", target: "a" },
        { id: "bc", source: "b", target: "c" }
      ],
      subflows: []
    } as unknown as Flow;
    const laidOut = layoutScopeByDependencyDepth(flow, null);
    expect(laidOut.nodes.find((node) => node.id === "a")?.position.x).toBe(laidOut.nodes.find((node) => node.id === "b")?.position.x);
    expect(laidOut.nodes.find((node) => node.id === "c")?.position.x).toBeGreaterThan(laidOut.nodes.find((node) => node.id === "b")?.position.x ?? 0);
  });

  it("lays out dense cyclic scopes in group-contiguous multi-column sections", () => {
    const nodes = Array.from({ length: 6 }, (_, index) => ({
      id: `n${index}`,
      title: `Node ${index}`,
      groupId: index < 2 ? "group-a" : index < 5 ? "group-b" : undefined,
      position: { x: 0, y: 0 }
    }));
    const flow = {
      nodes,
      edges: nodes.flatMap((node, index) => [
        { id: `forward-${index}`, source: node.id, target: nodes[(index + 1) % nodes.length].id },
        { id: `back-${index}`, source: nodes[(index + 1) % nodes.length].id, target: node.id }
      ]),
      subflows: [],
      groups: [{ id: "group-a", name: "A" }, { id: "group-b", name: "B" }]
    } as unknown as Flow;
    const laidOut = layoutScopeByDependencyDepth(flow, null);
    expect(new Set(laidOut.nodes.map((node) => node.position.x)).size).toBeGreaterThan(1);
    const aBottom = Math.max(...laidOut.nodes.filter((node) => node.groupId === "group-a").map((node) => node.position.y));
    const bTop = Math.min(...laidOut.nodes.filter((node) => node.groupId === "group-b").map((node) => node.position.y));
    expect(bTop - aBottom).toBeGreaterThanOrEqual(280);
  });

  it("falls back to group-contiguous sections when dependency layout makes group boxes collide", () => {
    const flow = {
      nodes: [
        { id: "a", title: "A", groupId: "group-a", position: { x: 0, y: 0 } },
        { id: "b", title: "B", groupId: "group-b", position: { x: 0, y: 0 } },
        { id: "c", title: "C", groupId: "group-b", position: { x: 0, y: 0 } },
        { id: "d", title: "D", groupId: "group-a", position: { x: 0, y: 0 } }
      ],
      edges: [
        { id: "ab", source: "a", target: "b" },
        { id: "bc", source: "b", target: "c" },
        { id: "cd", source: "c", target: "d" }
      ],
      subflows: [],
      groups: [{ id: "group-a", name: "A" }, { id: "group-b", name: "B" }]
    } as unknown as Flow;
    const laidOut = layoutScopeByDependencyDepth(flow, null);
    const aBottom = Math.max(...laidOut.nodes.filter((node) => node.groupId === "group-a").map((node) => node.position.y));
    const bTop = Math.min(...laidOut.nodes.filter((node) => node.groupId === "group-b").map((node) => node.position.y));
    expect(bTop - aBottom).toBeGreaterThanOrEqual(280);
  });
});
