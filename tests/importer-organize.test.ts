import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepository } from "../src/main/importer/scanner";
import { parseFiles } from "../src/main/importer/parsers";
import { buildFileDependencyGraph } from "../src/main/importer/fileGraph";
import { buildContentInventory } from "../src/main/importer/inventory";
import { buildModuleGraph } from "../src/main/importer/aggregate";
import { architectureSpecSchema, lensPlanQualityIssues, sanitizedLensPlans, transformArchitecture } from "../src/main/importer/organize";
import { runCodebaseImport } from "../src/main/importer";
import { parseArchitectureResponse, requestDerivedEdgeLabels, requestHierarchicalAnnotations, requestImportAnnotations } from "../src/main/importer/mapper";
import { prepareModuleGraphForEmission } from "../src/main/importer/emit";
import type { ContentInventory } from "../src/main/importer/inventory";
import type { FileDependencyGraph, ParsedFile, RepoScan, SupportedLanguage } from "../src/main/importer/types";

const FLAT_APP = path.resolve(process.cwd(), "fixtures", "importer", "flat-app");

async function flatAppInputs() {
  const scan = await scanRepository(FLAT_APP);
  const parsed = await parseFiles(FLAT_APP, scan.files);
  const fileGraph = await buildFileDependencyGraph(FLAT_APP, scan, parsed);
  const inventory = await buildContentInventory(FLAT_APP, scan);
  return { scan, parsed, fileGraph, inventory };
}

function syntheticInputs(
  files: Array<{ path: string; role?: RepoScan["files"][number]["role"]; language?: SupportedLanguage }>,
  edges: Array<[string, string]> = []
) {
  const scan: RepoScan = {
    files: files.map((file) => ({
      relPath: file.path,
      ext: path.extname(file.path),
      sizeBytes: 100,
      language: file.language ?? (file.path.endsWith(".dart") ? "dart" : "typescript"),
      role: file.role ?? "production"
    })),
    truncated: false,
    stats: { totalFiles: files.length, byLanguage: {} }
  };
  const parsed: ParsedFile[] = scan.files.map((file) => ({ relPath: file.relPath, language: file.language ?? "typescript", imports: [], declaredNamespaces: [], symbols: [], exportCount: 0, loc: 10 }));
  const fileGraph: FileDependencyGraph = {
    edges: edges.map(([from, to]) => ({ from, to, occurrences: 1, relationKinds: ["dependency"] })),
    externalsByFile: new Map(), unresolved: [], resolutionRate: 1
  };
  const inventory: ContentInventory = { catalogs: [], routes: [], interactions: [], entrypoints: [] };
  return { scan, parsed, fileGraph, inventory };
}

describe("symbol and catalog extraction", () => {
  it("extracts exported symbols per file", async () => {
    const { parsed } = await flatAppInputs();
    const bySymbolFile = new Map(parsed.map((file) => [file.relPath, file.symbols]));
    expect(bySymbolFile.get("src/engine/draw.ts")).toContain("createDrawApi");
    expect(bySymbolFile.get("src/engine/palette.ts")).toEqual(expect.arrayContaining(["palette", "paletteColor"]));
    expect(bySymbolFile.get("src/scenes/registry.ts")).toContain("scenes");
    expect(bySymbolFile.get("src/ui/App.ts")).toContain("App");
    expect(parsed.find((file) => file.relPath === "src/engine/draw.ts")?.symbolRefs).toContainEqual({ name: "createDrawApi", kind: "function" });
  });

  it("detects call-pattern catalogs with keys, titles, and notes", async () => {
    const { inventory } = await flatAppInputs();
    expect(inventory.catalogs).toHaveLength(1);
    const catalog = inventory.catalogs[0];
    expect(catalog.file).toBe("src/scenes/registry.ts");
    expect(catalog.items.map((item) => item.key)).toEqual(["alpha", "cyber", "delta", "omega"]);
    expect(catalog.items[0].title).toBe("Alpha Beams");
    expect(catalog.items[0].note).toContain("Radial alpha beam");
  });
});

describe("flat-directory component fallback", () => {
  it("splits flat directories into per-file components at component granularity", async () => {
    const inputs = await flatAppInputs();
    const graph = buildModuleGraph({ ...inputs, levels: "3", detail: "balanced", granularity: "component" });
    // Multi-file flat dirs split into per-file components; single-file dirs stay whole.
    const tierTwoPaths = graph.clusters.filter((cluster) => cluster.tier === 2 && !cluster.catalogItem && !cluster.catalogRef).map((cluster) => cluster.path);
    expect(tierTwoPaths).toEqual(expect.arrayContaining(["src/engine/draw.ts", "src/engine/palette.ts"]));
    // Catalog items land on the deepest tier under the registry component.
    const items = graph.clusters.filter((cluster) => cluster.catalogItem);
    expect(items.map((item) => item.title)).toEqual(["Alpha Beams", "Cyber Storm", "Delta Waves", "Omega Drift"]);
    expect(items.every((item) => item.tier === 3)).toBe(true);
    // Per-file components produce real file-level edges at tier 2.
    const tierTwoEdges = graph.edges.filter((edge) => graph.clusters.find((cluster) => cluster.id === edge.source)?.tier === 2);
    expect(tierTwoEdges.some((edge) => edge.source.includes("draw") && edge.target.includes("palette"))).toBe(true);
  });
});

describe("LLM-organized architecture transform", () => {
  it("deepens production structure before mirrored tests and preserves backend hub edges", () => {
    const mobileFiles = [
      ...["a", "b"].map((name) => ({ path: `lib/helpers/${name}.dart` })),
      ...["a", "b"].map((name) => ({ path: `lib/model/${name}.dart` })),
      ...["a", "b"].map((name) => ({ path: `lib/screens/${name}.dart` })),
      { path: "test/helpers/a_test.dart", role: "test" as const },
      { path: "test/screens/a_test.dart", role: "test" as const }
    ];
    const backendFiles = ["config", "db", "prompt", "report-notifications", "revenuecat", "server"].map((name) => ({ path: `backend/src/${name}.ts` }));
    const inputs = syntheticInputs(
      [...mobileFiles, ...backendFiles, { path: "backend/test/server.test.ts", role: "test" }],
      backendFiles.filter((file) => !file.path.endsWith("server.ts")).map((file) => ["backend/src/server.ts", file.path] as [string, string])
    );
    const spec = architectureSpecSchema.parse({
      projectNode: { title: "Product", description: "Product." },
      architecture: [
        { id: "mobile", title: "Mobile Product", members: ["lib/", "test/"] },
        { id: "backend", title: "Backend Service", members: ["backend/"] }
      ]
    });
    const result = transformArchitecture({ ...inputs, spec, levels: "3", detail: "balanced", granularity: "component" });
    expect(result).not.toBeNull();
    const graph = result!.moduleGraph;
    const mobileChildren = graph.clusters.filter((cluster) => cluster.parentClusterId === "cluster-mobile");
    expect(mobileChildren.map((cluster) => cluster.title)).toEqual(expect.arrayContaining(["Helpers", "Model", "Screens", "Verification Support"]));
    expect(mobileChildren.map((cluster) => cluster.title)).not.toEqual(expect.arrayContaining(["Lib", "Test"]));

    const prepared = prepareModuleGraphForEmission(graph, result!.annotations);
    const backendChildren = prepared.clusters.filter((cluster) => cluster.parentClusterId === "cluster-backend");
    expect(backendChildren.length).toBeGreaterThanOrEqual(5);
    const server = backendChildren.find((cluster) => cluster.path.endsWith("server.ts"));
    expect(server).toBeDefined();
    expect(prepared.edges.filter((edge) => edge.source === server?.id).length).toBeGreaterThanOrEqual(4);
  });

  it("caps generated vendored detail below the primary application budget", () => {
    const files = ["lib", "packages/vendor_plugin"].flatMap((root) =>
      Array.from({ length: 36 }, (_, index) => ({ path: `${root}/feature-${index % 6}/file-${index}.ts` }))
    );
    const inputs = syntheticInputs(files);
    const spec = architectureSpecSchema.parse({
      projectNode: { title: "Product", description: "Product." },
      architecture: [
        { id: "app", title: "Primary Application", members: ["lib/"] },
        { id: "vendor", title: "Vendored Plugin", members: ["packages/vendor_plugin/"] }
      ]
    });
    const result = transformArchitecture({ ...inputs, spec, levels: "3", detail: "balanced", granularity: "component" });
    expect(result).not.toBeNull();
    const graph = result!.moduleGraph;
    const descendants = (rootId: string) => {
      const ids = new Set([rootId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const cluster of graph.clusters) if (cluster.parentClusterId && ids.has(cluster.parentClusterId) && !ids.has(cluster.id)) {
          ids.add(cluster.id);
          changed = true;
        }
      }
      return ids.size - 1;
    };
    expect(descendants("cluster-app")).toBeGreaterThan(descendants("cluster-vendor"));
    expect(descendants("cluster-vendor")).toBeLessThanOrEqual(18);
  });

  it("does not merge an evidenced runtime boundary away when enforcing a light scope budget", () => {
    const files = ["server.js", ...Array.from({ length: 11 }, (_, index) => `src/area-${index}.ts`)];
    const inputs = syntheticInputs(files.map((file) => ({ path: file })));
    inputs.inventory.entrypoints = ["server.js"];
    inputs.inventory.interactions = [{ file: "server.js", kind: "http-route", target: "/session", method: "POST", confidence: 0.99 }];
    const spec = architectureSpecSchema.parse({
      projectNode: { title: "Budget Fixture" },
      architecture: files.map((file, index) => ({
        id: index === 0 ? "server-boundary" : `area-${index}`,
        title: index === 0 ? "Server Boundary" : `Area ${index}`,
        type: "system",
        description: `Owns ${file}.`,
        members: [file]
      }))
    });
    const transformed = transformArchitecture({ ...inputs, spec, levels: "1", detail: "light", granularity: "system" });
    expect(transformed?.moduleGraph.clusters.filter((cluster) => cluster.tier === 1).length).toBeLessThanOrEqual(10);
    expect(transformed?.moduleGraph.clusters.some((cluster) => cluster.title === "Server Boundary" && cluster.ownedFiles?.includes("server.js"))).toBe(true);
  });

  it("derives tiers, coverage, and edges from a functional hierarchy", async () => {
    const inputs = await flatAppInputs();
    const spec = architectureSpecSchema.parse({
      analysis: "A tiny scene engine.",
      projectNode: { title: "FlatApp", description: "FlatApp renders catalogued scenes.", techStack: ["TypeScript"], acceptanceCriteria: ["Scenes render"] },
      architecture: [
        { id: "presentation", parentId: null, title: "Presentation", type: "system", description: "Presentation owns the UI shell.", members: ["src/ui/"], groupName: "Frontend" },
        { id: "content", parentId: null, title: "Scene Content", type: "system", description: "Scene Content owns the scene registry and its entries.", members: ["src/scenes/"], catalogItems: ["src/scenes/registry.ts::*"] },
        { id: "engine", parentId: null, title: "Engine", type: "system", description: "Engine owns drawing primitives.", members: ["src/engine/"] },
        { id: "palette", parentId: "engine", title: "Palette", type: "component", description: "Palette owns the color tables.", members: ["src/engine/palette.ts"] }
      ],
      edgeLabels: [
        { source: "content", target: "engine", label: "draws with" },
        { source: "engine", target: "presentation", label: "made up dependency" }
      ],
      subflowNames: ["Components", "Details"],
      summary: "Functional map."
    });
    const result = transformArchitecture({ ...inputs, spec, levels: "3", detail: "balanced", granularity: "component" });
    expect(result).not.toBeNull();
    const graph = result!.moduleGraph;

    // Functional grouping honored: palette nested under engine despite flat folders.
    const palette = graph.clusters.find((cluster) => cluster.id === "cluster-palette");
    expect(palette?.tier).toBe(2);
    expect(palette?.parentClusterId).toBe("cluster-engine");
    // Exact file claim beats the engine/ prefix claim.
    expect(palette?.files).toEqual(["src/engine/palette.ts"]);

    // Coverage: every code file owned somewhere.
    const tierOneFiles = graph.clusters.filter((cluster) => cluster.tier === 1).flatMap((cluster) => cluster.files);
    for (const file of ["src/ui/App.ts", "src/scenes/registry.ts", "src/engine/draw.ts", "src/engine/palette.ts"]) {
      expect(tierOneFiles).toContain(file);
    }

    // Catalog items claimed into Scene Content as child nodes.
    const items = graph.clusters.filter((cluster) => cluster.catalogItem);
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.parentClusterId === "cluster-content")).toBe(true);

    // Edges derived from real imports only: content -> engine exists, engine -> presentation does not.
    const pairs = new Set(graph.edges.map((edge) => `${edge.source} ${edge.target}`));
    expect(pairs).toContain("cluster-content cluster-engine");
    expect(pairs).not.toContain("cluster-engine cluster-presentation");
    // The invented edge label was dropped; the real one survived.
    expect(result!.annotations.edgeLabels).toEqual([{ source: "cluster-content", target: "cluster-engine", label: "draws with" }]);
  });

  it("auto-assigns unclaimed files and rejects specs with too few usable nodes", async () => {
    const inputs = await flatAppInputs();
    const spec = architectureSpecSchema.parse({
      analysis: "",
      projectNode: { title: "X", description: "X." },
      architecture: [
        { id: "only-ui", parentId: null, title: "UI", type: "system", description: "UI.", members: ["src/ui/"] },
        { id: "rest", parentId: null, title: "Everything Else", type: "system", description: "Rest.", members: ["src/engine/"] }
      ],
      subflowNames: ["Components", "Details"]
    });
    const result = transformArchitecture({ ...inputs, spec, levels: "3", detail: "balanced", granularity: "component" });
    expect(result).not.toBeNull();
    const allFiles = result!.moduleGraph.clusters.flatMap((cluster) => cluster.files);
    expect(allFiles).toContain("src/scenes/registry.ts");
    expect(result!.notes.join(" ")).toContain("auto-assigned");
    // Unclaimed catalog still placed deterministically — no blindspots.
    expect(result!.moduleGraph.clusters.some((cluster) => cluster.catalogItem)).toBe(true);

    const tooFew = architectureSpecSchema.parse({
      analysis: "",
      projectNode: { title: "X", description: "X." },
      architecture: [{ id: "solo", parentId: null, title: "Solo", type: "system", description: "Solo.", members: ["src/"] }],
      subflowNames: []
    });
    expect(transformArchitecture({ ...inputs, spec: tooFew, levels: "1", detail: "balanced", granularity: "system" })).toBeNull();
  });
});

describe("organize mode end-to-end with a mock provider", () => {
  it("salvages valid architecture and lens sections while ignoring provider-authored confidence", () => {
    const parsed = parseArchitectureResponse(JSON.stringify({ archicodeImport: {
      projectNode: { title: "Product", description: "Grounded product." },
      architecture: [
        { id: "app", title: "Application", members: ["src/"], techStack: "TypeScript" },
        { id: "content", title: "Content", members: ["content/"] },
        { id: 42, title: "Invalid", members: ["src/invalid"] }
      ],
      lenses: [{
        id: "functional",
        nodes: [
          { id: "create", title: "Create Work", type: "capability", description: "Creates work.", evidenceMembers: ["src/create.ts"] },
          { id: "share", title: "Share Work", type: "capability", description: "Shares work.", evidenceMembers: ["src/share.ts"] },
          { id: "track", title: "Track Progress", type: "capability", description: "Tracks progress.", evidenceMembers: ["src/track.ts"] }
        ],
        edges: [
          { source: "create", target: "share", label: "makes work available", confidence: 0.99 },
          { source: "share", target: "track", label: 42 }
        ]
      }]
    } }), ["functional"]);

    expect(parsed.spec?.architecture.map((node) => node.id)).toEqual(["app", "content"]);
    expect(parsed.diagnostics.architectureNodesDropped).toBe(1);
    expect(parsed.diagnostics.invalidOptionalFieldsIgnored).toBe(1);
    expect(parsed.diagnostics.lensEdgesDropped).toBe(1);
    expect(parsed.diagnostics.providerConfidenceFieldsIgnored).toBe(1);
    expect(parsed.diagnostics.lensIdsRetained).toEqual(["functional"]);
    expect((parsed.spec?.lenses[0].edges[0] as Record<string, unknown>).confidence).toBeUndefined();
  });

  it("rejects plumbing-shaped lenses with technology-neutral semantic gates", () => {
    const technical = architectureSpecSchema.parse({
      projectNode: { title: "Product" },
      architecture: [],
      lenses: [{
        id: "functional",
        nodes: [
          { id: "screen", title: "Screen", type: "widget", description: "Screen.", evidenceMembers: ["src/screen.ts"] },
          { id: "provider", title: "Provider", type: "service", description: "Provider.", evidenceMembers: ["src/provider.ts"] },
          { id: "model", title: "Model", type: "module", description: "Model.", evidenceMembers: ["src/model.ts"] }
        ],
        edges: [{ source: "screen", target: "provider", label: "uses" }, { source: "provider", target: "model", label: "loads" }]
      }]
    });
    expect(lensPlanQualityIssues(technical.lenses[0])).toContain("is dominated by technical layers instead of product capabilities");
    expect(sanitizedLensPlans(technical)).toEqual([]);
  });

  it("repairs only missing lenses once and retains the accepted hierarchy", async () => {
    const inputs = await flatAppInputs();
    const moduleGraph = buildModuleGraph({
      ...inputs,
      levels: "3",
      detail: "balanced",
      granularity: "component",
      semanticLinks: []
    });
    const hierarchy = {
      analysis: "A scene demo app.",
      projectNode: { title: "FlatApp", description: "FlatApp renders catalogued scenes." },
      architecture: [
        { id: "frontend", title: "Frontend Shell", type: "system", description: "Owns the visible application shell.", members: ["src/ui/"] },
        { id: "scene-system", title: "Scene System", type: "system", description: "Owns scene selection and rendering.", members: ["src/scenes/", "src/engine/"] }
      ]
    };
    const lenses = [
      {
        id: "functional",
        nodes: [
          { id: "choose", title: "Choose a Scene", type: "capability", description: "Chooses registered content.", evidenceMembers: ["src/scenes/registry.ts"] },
          { id: "render", title: "Render a Scene", type: "capability", description: "Renders selected content.", evidenceMembers: ["src/engine/draw.ts"] },
          { id: "view", title: "View the Result", type: "capability", description: "Displays rendered output.", evidenceMembers: ["src/ui/App.ts"] }
        ],
        edges: [{ source: "choose", target: "render", label: "selects content for" }, { source: "render", target: "view", label: "presents output as" }]
      },
      {
        id: "user-journey",
        nodes: [
          { id: "viewer", title: "Viewer", type: "actor", description: "Person using the app.", evidenceMembers: [], contextOnly: true },
          { id: "choose", title: "Chooses a Scene", type: "journey-step", description: "Chooses registered content.", evidenceMembers: ["src/scenes/registry.ts"] },
          { id: "view", title: "Sees the Scene", type: "outcome", description: "Views the rendered output.", evidenceMembers: ["src/ui/App.ts"] }
        ],
        edges: [{ source: "viewer", target: "choose", label: "starts by" }, { source: "choose", target: "view", label: "continues to" }]
      },
      {
        id: "data",
        nodes: [
          { id: "catalog", title: "Scene Catalog", type: "entity", description: "Owns scene records.", evidenceMembers: ["src/scenes/registry.ts"] },
          { id: "registry", title: "Registry Store", type: "store", description: "Stores registered scenes.", evidenceMembers: ["src/scenes/registry.ts"] },
          { id: "renderer", title: "Scene Projection", type: "transform", description: "Transforms a scene into output.", evidenceMembers: ["src/engine/draw.ts"] }
        ],
        edges: [{ source: "catalog", target: "registry", label: "is stored in" }, { source: "registry", target: "renderer", label: "feeds" }]
      },
      {
        id: "infrastructure",
        nodes: [
          { id: "build", title: "Application Build", type: "build", description: "Builds the app.", evidenceMembers: ["src/ui/App.ts"] },
          { id: "bundle", title: "Application Bundle", type: "artifact", description: "Contains the application.", evidenceMembers: ["src/ui/App.ts"] },
          { id: "runtime", title: "Browser Runtime", type: "runtime", description: "Runs the application.", evidenceMembers: ["src/ui/App.ts"] }
        ],
        edges: [{ source: "build", target: "bundle", label: "produces" }, { source: "bundle", target: "runtime", label: "runs in" }]
      }
    ];
    const prompts: string[] = [];
    const stableContexts: string[] = [];
    const result = await requestImportAnnotations({
      projectRoot: FLAT_APP,
      ...inputs,
      moduleGraph,
      levels: "3",
      detail: "balanced",
      granularity: "component",
      codebaseHints: [],
      callProvider: async (prompt, options) => {
        prompts.push(prompt);
        stableContexts.push(options?.stableContext ?? "");
        return JSON.stringify({ archicodeImport: prompt.includes("with a lenses array for these missing") ? { lenses } : hierarchy });
      }
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Do not return projectNode, architecture, edgeLabels");
    expect(stableContexts.every((context) => context.includes("Immutable deterministic repository ground truth"))).toBe(true);
    expect(stableContexts[0]).toBe(stableContexts[1]);
    expect(result.diagnostics).toMatchObject({ attempts: 2, repairKind: "lenses", architectureNodesRetained: 2, missingLensIds: [] });
    expect(result.organizedGraph?.clusters.map((cluster) => cluster.title)).toEqual(expect.arrayContaining(["Frontend Shell", "Scene System"]));
  });

  it("splits a proven server/trust boundary from client application state before lenses compile", async () => {
    const inputs = syntheticInputs([
      { path: "server.js" },
      { path: "src/stores/session.ts" },
      { path: "src/ui/App.ts" },
      { path: "src/services/transport.ts" }
    ], [["src/ui/App.ts", "src/stores/session.ts"], ["src/stores/session.ts", "src/services/transport.ts"]]);
    inputs.inventory.entrypoints = ["server.js", "src/ui/App.ts"];
    inputs.inventory.routes = [{ file: "server.js", route: "/session", method: "POST", line: 4 }];
    inputs.inventory.interactions = [
      { file: "server.js", kind: "http-route", target: "/session", method: "POST", line: 4, confidence: 0.99 },
      { file: "src/services/transport.ts", kind: "http-call", target: "/session", method: "POST", line: 8, confidence: 0.98 }
    ];
    const moduleGraph = buildModuleGraph({ ...inputs, levels: "2", detail: "light", granularity: "system" });
    const response = JSON.stringify({ archicodeImport: {
      projectNode: { title: "Session Product", description: "A client and request boundary." },
      architecture: [
        { id: "client-and-server", title: "Session Coordination", type: "system", description: "Coordinates client state and requests.", members: ["server.js", "src/stores/session.ts"] },
        { id: "client-interface", title: "Client Interface", type: "system", description: "Owns the user interface and transport.", members: ["src/ui/", "src/services/"] }
      ]
    } });
    const result = await requestImportAnnotations({
      projectRoot: "/tmp/synthetic-runtime-boundary",
      ...inputs,
      moduleGraph,
      levels: "2",
      detail: "light",
      granularity: "system",
      codebaseHints: [],
      callProvider: async () => response
    });

    const owners = result.organizedGraph?.clusters.filter((cluster) => (cluster.ownedFiles ?? []).length) ?? [];
    const serverOwner = owners.find((cluster) => cluster.ownedFiles?.includes("server.js"));
    const stateOwner = owners.find((cluster) => cluster.ownedFiles?.includes("src/stores/session.ts"));
    expect(serverOwner?.id).not.toBe(stateOwner?.id);
    expect(serverOwner?.title).toBe("Server Runtime Boundary");
    expect(result.diagnostics?.canonicalRefinements?.join(" ")).toContain("runtime/trust boundaries cannot share one canonical subject");
  });

  it("uses the provider's functional hierarchy for emitted operations", async () => {
    const canned = JSON.stringify({
      archicodeImport: {
        analysis: "A scene demo app.",
        projectNode: { title: "FlatApp", description: "FlatApp renders catalogued scenes on a canvas.", techStack: ["TypeScript"], acceptanceCriteria: ["Scenes render"], visual: { shape: "hexagon" } },
        architecture: [
          { id: "frontend", parentId: null, title: "Frontend Shell", type: "system", description: "Frontend Shell owns the app entry UI.", techStack: ["TypeScript"], acceptanceCriteria: ["App mounts"], members: ["src/ui/"], visual: { backgroundColor: "#4f83cc", shape: "rounded" } },
          { id: "scene-system", parentId: null, title: "Scene System", type: "system", description: "Scene System owns the registry and rendering engine.", techStack: ["TypeScript"], acceptanceCriteria: ["Scenes registered"], members: ["src/scenes/", "src/engine/"], catalogItems: ["src/scenes/registry.ts::*"] }
        ],
        lenses: [
          {
            id: "functional",
            nodes: [
              { id: "browse-scenes", title: "Browse Scenes", type: "capability", description: "People choose from the registered scene catalog.", evidenceMembers: ["src/scenes/registry.ts"] },
              { id: "render-scenes", title: "Render Scenes", type: "capability", description: "The product renders the selected visual scene.", evidenceMembers: ["src/engine/draw.ts", "src/engine/palette.ts"] },
              { id: "view-canvas", title: "View Canvas", type: "capability", description: "People view the rendered scene in the application canvas.", evidenceMembers: ["src/ui/App.ts"] }
            ],
            edges: [
              { source: "browse-scenes", target: "render-scenes", label: "selects content to render" },
              { source: "render-scenes", target: "view-canvas", label: "presents the rendered output" }
            ]
          },
          {
            id: "user-journey",
            nodes: [
              { id: "viewer", title: "Viewer", type: "actor", description: "The person viewing a scene.", evidenceMembers: [], contextOnly: true },
              { id: "choose-scene", title: "Chooses Scene", type: "journey-step", description: "The viewer selects a registered scene.", evidenceMembers: ["src/scenes/registry.ts"] },
              { id: "see-scene", title: "Sees Rendered Scene", type: "outcome", description: "The canvas presents the rendered result.", evidenceMembers: ["src/ui/App.ts", "src/engine/draw.ts"] }
            ],
            edges: [
              { source: "viewer", target: "choose-scene", label: "starts by choosing" },
              { source: "choose-scene", target: "see-scene", label: "renders the selected scene as" }
            ]
          }
        ],
        edgeLabels: [{ source: "frontend", target: "scene-system", label: "loads registered scenes" }],
        subflowNames: ["Components", "Details"],
        summary: "Functional map of FlatApp."
      }
    });
    const prompts: string[] = [];
    const outcome = await runCodebaseImport({
      projectRoot: FLAT_APP,
      flowId: "flow-x",
      levels: "3",
      detail: "balanced",
      granularity: "component",
      codebaseHints: [],
      reviewEnabled: false,
      callProvider: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes("archicodeEdgeLabels")) {
          return JSON.stringify({ archicodeEdgeLabels: { edgeLabels: [{ source: "cluster-frontend", target: "cluster-scene-system", label: "renders registered scenes" }] } });
        }
        return canned;
      }
    });
    const nodeOps = outcome.operations.filter((operation) => operation.kind === "create-node");
    const titles = nodeOps.map((operation) => (operation.kind === "create-node" ? operation.node.title : ""));
    expect(titles).toContain("Frontend Shell");
    expect(titles).toContain("Scene System");
    expect(titles).toEqual(expect.arrayContaining(["Alpha Beams", "Cyber Storm", "Delta Waves", "Omega Drift"]));
    const edgeOps = outcome.operations.filter((operation) => operation.kind === "create-edge");
    expect(edgeOps.some((operation) => operation.kind === "create-edge" && operation.edge.label === "loads registered scenes")).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("Finalized edges:"))).toBe(false);
    const product = outcome.operations.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "product-capabilities");
    expect(product?.kind === "create-flow" ? product.flow.nodes.filter((node) => node.type === "capability").map((node) => node.title) : [])
      .toEqual(["Browse Scenes", "Render Scenes", "View Canvas"]);
    if (product?.kind === "create-flow") expect(product.flow.edges.every((edge) => edge.evidence?.verification === "ambiguous")).toBe(true);
    const providerPurposes = outcome.stats.architectureProvider?.calls.map((call) => call.purpose) ?? [];
    expect(providerPurposes).toEqual(expect.arrayContaining(["architecture-generation"]));
    expect(providerPurposes).not.toContain("final-edge-labeling");
    expect(providerPurposes).not.toContain("architecture-repair");
    expect(providerPurposes).not.toContain("lens-repair");
    expect(outcome.stats.architectureProvider?.validation).toMatchObject({ attempts: 1, missingLensIds: [] });
  });

  it("repairs only a lens that fails after evidence compilation and leaves healthy lenses unchanged", async () => {
    const initial = {
      analysis: "A scene demo app.",
      projectNode: { title: "FlatApp", description: "FlatApp renders catalogued scenes.", techStack: ["TypeScript"] },
      architecture: [
        { id: "frontend", title: "Frontend Shell", type: "system", description: "Owns the application display surface.", members: ["src/ui/"] },
        { id: "scene-system", title: "Scene System", type: "system", description: "Owns scene registration and rendering.", members: ["src/scenes/", "src/engine/"] }
      ],
      lenses: [
        {
          id: "functional",
          nodes: [
            { id: "choose", title: "Choose a Scene", type: "capability", description: "People choose registered content.", evidenceMembers: ["src/scenes/registry.ts"] },
            { id: "render", title: "Render a Scene", type: "capability", description: "The product renders selected content.", evidenceMembers: ["src/engine/draw.ts"] },
            { id: "view", title: "View the Result", type: "capability", description: "People view the rendered result.", evidenceMembers: ["src/ui/App.ts"] }
          ],
          edges: [
            { source: "choose", target: "render", label: "selects content for rendering" },
            { source: "render", target: "view", label: "presents the rendered result" }
          ]
        },
        {
          id: "user-journey",
          nodes: [
            { id: "viewer", title: "Viewer", type: "actor", description: "Person using the app.", evidenceMembers: [], contextOnly: true },
            { id: "choose", title: "Chooses a Scene", type: "journey-step", description: "Chooses registered content.", evidenceMembers: ["src/scenes/registry.ts"] },
            { id: "outcome", title: "Sees the Scene", type: "outcome", description: "Views the rendered scene.", evidenceMembers: ["src/does-not-exist.ts"] }
          ],
          edges: [
            { source: "viewer", target: "choose", label: "starts by choosing" },
            { source: "choose", target: "outcome", label: "continues to the result" }
          ]
        }
      ],
      edgeLabels: [],
      summary: "Functional map."
    };
    const repairedJourney = {
      id: "user-journey",
      nodes: [
        { id: "viewer", title: "Viewer", type: "actor", description: "Person using the app.", evidenceMembers: [], contextOnly: true },
        { id: "choose", title: "Chooses a Scene", type: "journey-step", description: "Chooses registered content.", evidenceMembers: ["src/scenes/registry.ts"] },
        { id: "outcome", title: "Sees the Scene", type: "outcome", description: "Views the rendered scene.", evidenceMembers: ["src/ui/App.ts", "src/engine/draw.ts"] }
      ],
      edges: [
        { source: "viewer", target: "choose", label: "starts by choosing" },
        { source: "choose", target: "outcome", label: "renders the selected scene as" }
      ]
    };
    const prompts: string[] = [];
    const outcome = await runCodebaseImport({
      projectRoot: FLAT_APP,
      flowId: "flow-compiled-repair",
      levels: "3",
      detail: "balanced",
      granularity: "component",
      codebaseHints: [],
      reviewEnabled: false,
      callProvider: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes("archicodeCompiledLensRepair")) return JSON.stringify({ archicodeImport: { lenses: [repairedJourney] } });
        if (prompt.includes("archicodeHierarchy")) return JSON.stringify({ archicodeHierarchy: { clusters: [] } });
        if (prompt.includes("Finalized edges:")) return JSON.stringify({ archicodeEdgeLabels: { edgeLabels: [] } });
        return JSON.stringify({ archicodeImport: initial });
      }
    });

    expect(prompts.filter((prompt) => prompt.includes("archicodeCompiledLensRepair"))).toHaveLength(1);
    expect(outcome.stats.architectureProvider?.calls.filter((call) => call.purpose === "lens-repair")).toHaveLength(1);
    expect(outcome.stats.architectureProvider?.compiledLensRepair).toMatchObject({ requestedLensIds: ["user-journey"], replacementLensIds: ["user-journey"] });
    expect(outcome.stats.architectureProvider?.lensCompilation).toEqual(expect.arrayContaining([
      expect.objectContaining({ lensId: "functional", status: "compiled", repairAttempted: false, fallbackUsed: false }),
      expect.objectContaining({ lensId: "user-journey", status: "compiled", repairAttempted: true, fallbackUsed: false })
    ]));
    const journey = outcome.operations.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "user-journeys");
    expect(journey?.kind === "create-flow" ? journey.flow.nodes.map((node) => node.type) : []).toEqual(expect.arrayContaining(["actor", "journey-step", "outcome"]));
    expect(outcome.stats.degraded.some((note) => note.includes("user-journey lens used an explicit deterministic fallback"))).toBe(false);
  });

  it("accepts only exact finalized edge pairs from the labeling pass", async () => {
    const moduleGraph = {
      levels: "1" as const,
      granularity: "system" as const,
      entrypoints: [],
      clusters: [
        { id: "cluster-a", path: "a", title: "Client", unit: "area" as const, tier: 1, files: ["a.ts"], loc: 1, languages: ["typescript"], topFiles: ["a.ts"], externalDeps: [], docTitles: [], symbols: [] },
        { id: "cluster-b", path: "b", title: "API", unit: "area" as const, tier: 1, files: ["b.ts"], loc: 1, languages: ["typescript"], topFiles: ["b.ts"], externalDeps: [], docTitles: [], symbols: [] }
      ],
      edges: [{ source: "cluster-a", target: "cluster-b", importCount: 1, sampleImports: ["a.ts → b.ts"], importedNames: ["fetchReport"] }]
    };
    let stableContext = "";
    const result = await requestDerivedEdgeLabels({
      moduleGraph,
      callProvider: async (_prompt, options) => {
        stableContext = options?.stableContext ?? "";
        return JSON.stringify({ archicodeEdgeLabels: { edgeLabels: [
        { source: "cluster-a", target: "cluster-b", label: "fetches reports from" },
        { source: "cluster-b", target: "cluster-a", label: "invented reverse" }
        ] } });
      }
    });
    expect(result.edgeLabels).toEqual([{ source: "cluster-a", target: "cluster-b", label: "fetches reports from" }]);
    expect(stableContext).toContain("fetchReport");
  });

  it("skips finalized-edge provider work when every visible edge already has a useful label", async () => {
    const moduleGraph = {
      levels: "1" as const,
      granularity: "system" as const,
      entrypoints: [],
      clusters: [
        { id: "cluster-a", path: "a", title: "Client", unit: "area" as const, tier: 1, files: ["a.ts"], loc: 1, languages: ["typescript"], topFiles: ["a.ts"], externalDeps: [], docTitles: [], symbols: [] },
        { id: "cluster-b", path: "b", title: "API", unit: "area" as const, tier: 1, files: ["b.ts"], loc: 1, languages: ["typescript"], topFiles: ["b.ts"], externalDeps: [], docTitles: [], symbols: [] }
      ],
      edges: [{ source: "cluster-a", target: "cluster-b", importCount: 1, sampleImports: ["a.ts → b.ts"] }]
    };
    let called = false;
    const result = await requestDerivedEdgeLabels({
      moduleGraph,
      existingLabels: [{ source: "cluster-a", target: "cluster-b", label: "fetches session metadata" }],
      callProvider: async () => {
        called = true;
        return "";
      }
    });
    expect(called).toBe(false);
    expect(result.edgeLabels).toEqual([]);
  });

  it("refreshes a useful edge label when hierarchical refinement renamed an endpoint", async () => {
    const moduleGraph = {
      levels: "1" as const,
      granularity: "system" as const,
      entrypoints: [],
      clusters: [
        { id: "cluster-a", path: "a", title: "Renamed Client", unit: "area" as const, tier: 1, files: ["a.ts"], loc: 1, languages: ["typescript"], topFiles: ["a.ts"], externalDeps: [], docTitles: [], symbols: [] },
        { id: "cluster-b", path: "b", title: "API", unit: "area" as const, tier: 1, files: ["b.ts"], loc: 1, languages: ["typescript"], topFiles: ["b.ts"], externalDeps: [], docTitles: [], symbols: [] }
      ],
      edges: [{ source: "cluster-a", target: "cluster-b", importCount: 1, sampleImports: ["a.ts → b.ts"] }]
    };
    let calls = 0;
    const result = await requestDerivedEdgeLabels({
      moduleGraph,
      existingLabels: [{ source: "cluster-a", target: "cluster-b", label: "fetches session metadata" }],
      changedClusterIds: ["cluster-a"],
      callProvider: async () => {
        calls += 1;
        return JSON.stringify({ archicodeEdgeLabels: { edgeLabels: [{ source: "cluster-a", target: "cluster-b", label: "loads renamed account sessions" }] } });
      }
    });
    expect(calls).toBe(1);
    expect(result.edgeLabels).toEqual([{ source: "cluster-a", target: "cluster-b", label: "loads renamed account sessions" }]);
  });

  it("refines only visible unannotated deep nodes within each top-level area", async () => {
    const children = ["helpers", "model", "screens"].map((name) => ({
      id: `cluster-app-${name}`,
      path: `lib/${name}`,
      title: name,
      unit: "component" as const,
      tier: 2,
      parentClusterId: "cluster-app",
      files: [`lib/${name}/main.dart`],
      loc: 10,
      languages: ["dart"],
      topFiles: [`lib/${name}/main.dart`],
      externalDeps: [],
      docTitles: [],
      symbols: [`${name}Symbol`]
    }));
    const moduleGraph = {
      levels: "2" as const,
      granularity: "component" as const,
      entrypoints: [],
      clusters: [
        { id: "cluster-app", path: "lib", title: "App", unit: "area" as const, tier: 1, files: children.flatMap((child) => child.files), loc: 30, languages: ["dart"], topFiles: ["lib/main.dart"], externalDeps: [], docTitles: [], symbols: [] },
        ...children
      ],
      edges: [{ source: "cluster-app-screens", target: "cluster-app-helpers", importCount: 1, sampleImports: ["screen → helper"] }]
    };
    const annotations = {
      projectNode: { title: "Demo", description: "Demo product.", techStack: ["Dart"], acceptanceCriteria: [] },
      clusters: [{ id: "cluster-app", title: "Mobile Product", type: "system", description: "Mobile Product owns the application.", techStack: ["Dart"], acceptanceCriteria: [] }],
      groups: [], edgeLabels: [], subflowNames: [], summary: "Demo"
    };
    const prompts: string[] = [];
    const result = await requestHierarchicalAnnotations({
      moduleGraph,
      annotations,
      callProvider: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({ archicodeHierarchy: { clusters: [
          { id: "cluster-app-helpers", title: "Habit Rules", type: "service", description: "Habit Rules coordinates concrete domain calculations from the helper source and exposes them to application screens.", techStack: ["Dart"], acceptanceCriteria: ["Rules remain callable from screens"] },
          { id: "cluster-invented", title: "Invented", description: "This invented node must never be accepted by exact identifier validation." }
        ] } });
      }
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("cluster-app-helpers");
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].title).toBe("Habit Rules");
  });

  it("refines independent top-level areas concurrently and merges results in deterministic area order", async () => {
    const roots = ["app", "backend"];
    const clusters = roots.flatMap((root) => [
      { id: `cluster-${root}`, path: root, title: root, unit: "area" as const, tier: 1, files: [1, 2, 3].map((index) => `${root}/${index}.ts`), loc: 3, languages: ["typescript"], topFiles: [`${root}/1.ts`], externalDeps: [], docTitles: [], symbols: [] },
      ...[1, 2, 3].map((index) => ({ id: `cluster-${root}-${index}`, path: `${root}/${index}.ts`, title: `${root} ${index}`, unit: "component" as const, tier: 2, parentClusterId: `cluster-${root}`, files: [`${root}/${index}.ts`], loc: 1, languages: ["typescript"], topFiles: [`${root}/${index}.ts`], externalDeps: [], docTitles: [], symbols: [`${root}${index}`] }))
    ]);
    let active = 0;
    let maxActive = 0;
    const result = await requestHierarchicalAnnotations({
      moduleGraph: { levels: "2", granularity: "component", entrypoints: [], clusters, edges: [] },
      annotations: {
        projectNode: { title: "Demo", description: "Demo.", techStack: [], acceptanceCriteria: [] },
        clusters: roots.map((root) => ({ id: `cluster-${root}`, title: root, type: "system", description: `${root} root`, techStack: [], acceptanceCriteria: [] })),
        groups: [], edgeLabels: [], subflowNames: [], summary: ""
      },
      callProvider: async (prompt) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const root = prompt.includes("Subsystem: app") ? "app" : "backend";
        await new Promise((resolve) => setTimeout(resolve, root === "app" ? 35 : 5));
        active -= 1;
        return JSON.stringify({ archicodeHierarchy: { clusters: [{
          id: `cluster-${root}-1`, title: `${root} responsibility`, type: "component",
          description: `${root} responsibility owns a grounded implementation concern with enough concrete detail to pass validation.`,
          techStack: ["TypeScript"], acceptanceCriteria: []
        }] } });
      }
    });

    expect(maxActive).toBe(2);
    expect(result.clusters.map((cluster) => cluster.id)).toEqual(["cluster-app-1", "cluster-backend-1"]);
  });
});

describe("zoom coherence deepening rules", () => {
  it("never explodes config/docs-only clusters into per-file children", () => {
    const configFiles = [".gitignore", ".gitattributes", "analysis_options.yaml", "netlify.toml", "shorebird.yaml", "devtools_options.yaml"]
      .map((name) => ({ path: name, role: "config" as const, language: "typescript" as const }));
    const productFiles = ["a", "b", "c", "d", "e"].map((name) => ({ path: `src/app/${name}.ts` }));
    const inputs = syntheticInputs([...configFiles, ...productFiles]);
    const spec = architectureSpecSchema.parse({
      projectNode: { title: "Product", description: "Product." },
      architecture: [
        { id: "app", title: "Application", members: ["src/"] },
        { id: "repo-config", title: "Repository Configuration", members: configFiles.map((file) => file.path) }
      ]
    });
    const result = transformArchitecture({ ...inputs, spec, levels: "3", detail: "balanced", granularity: "component" });
    expect(result).not.toBeNull();
    const configChildren = result!.moduleGraph.clusters.filter((cluster) => cluster.parentClusterId === "cluster-repo-config");
    expect(configChildren).toEqual([]);
  });

  it("guarantees a minimal split for substantial product features even after the root budget is spent", () => {
    // Many sibling features so greedy expansion exhausts the per-root generated budget.
    const featureNames = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
    const files = featureNames.flatMap((feature) =>
      ["one", "two", "three", "four", "five", "six"].map((name) => ({ path: `lib/${feature}/screens/${name}.dart` }))
    ).concat(featureNames.flatMap((feature) =>
      ["m1", "m2", "m3"].map((name) => ({ path: `lib/${feature}/models/${name}.dart` }))
    ));
    const inputs = syntheticInputs(files);
    const spec = architectureSpecSchema.parse({
      projectNode: { title: "Product", description: "Product." },
      architecture: [
        { id: "root-app", title: "Mobile App", members: ["lib/"] },
        ...featureNames.map((feature) => ({ id: `feat-${feature}`, parentId: "root-app", title: `Feature ${feature}`, members: [`lib/${feature}/`] }))
      ]
    });
    const result = transformArchitecture({ ...inputs, spec, levels: "3", detail: "balanced", granularity: "component" });
    expect(result).not.toBeNull();
    const flatFeatures = featureNames.filter((feature) =>
      !result!.moduleGraph.clusters.some((cluster) => cluster.parentClusterId === `cluster-feat-${feature}`)
    );
    expect(flatFeatures).toEqual([]);
  });
});
