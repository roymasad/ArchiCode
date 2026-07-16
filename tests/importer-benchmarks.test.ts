import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFileDependencyGraph } from "../src/main/importer/fileGraph";
import { buildContentInventory } from "../src/main/importer/inventory";
import { parseFiles } from "../src/main/importer/parsers";
import { scanRepository } from "../src/main/importer/scanner";
import { buildCodeKnowledgeSnapshot } from "../src/main/importer/knowledgeSnapshot";

const FIXTURES = path.resolve(process.cwd(), "fixtures", "importer");

type GoldenBenchmark = {
  fixture: string;
  entrypoint?: string;
  edges: Array<[string, string]>;
  namedEdge?: { from: string; to: string; importedName: string };
  relationEdge?: { from: string; to: string; relation: string };
};

const GOLDENS: GoldenBenchmark[] = [
  {
    fixture: "ts-app",
    entrypoint: "src/index.ts",
    edges: [["src/app/index.ts", "src/app/util.ts"], ["src/index.ts", "src/app/index.ts"], ["src/index.ts", "src/app/util.ts"]],
    namedEdge: { from: "src/index.ts", to: "src/app/index.ts", importedName: "boot" }
  },
  {
    fixture: "py-app",
    entrypoint: "main.py",
    edges: [["main.py", "pkg/core.py"], ["main.py", "pkg/util.py"], ["pkg/core.py", "pkg/util.py"]],
    namedEdge: { from: "main.py", to: "pkg/util.py", importedName: "helper" }
  },
  {
    fixture: "go-app",
    entrypoint: "main.go",
    edges: [["main.go", "internal/svc/svc.go"], ["internal/svc/svc.go", "internal/store/store.go"]]
  },
  {
    fixture: "rust-app",
    entrypoint: "src/main.rs",
    edges: [["src/main.rs", "src/svc.rs"], ["src/main.rs", "src/store.rs"], ["src/svc.rs", "src/store.rs"]]
  },
  {
    fixture: "cpp-app",
    edges: [["src/main.cpp", "include/demo/engine.h"], ["src/engine.cpp", "include/demo/engine.h"], ["src/engine.cpp", "src/util.h"]]
  },
  {
    fixture: "csharp-app",
    edges: [["App/Program.cs", "Lib/Helper.cs"], ["App/App.csproj", "Lib/Lib.csproj"]],
    relationEdge: { from: "App/App.csproj", to: "Lib/Lib.csproj", relation: "project-reference" }
  },
  {
    fixture: "php-app",
    entrypoint: "public/index.php",
    edges: [["public/index.php", "src/bootstrap.php"], ["public/index.php", "src/Service/Mailer.php"], ["src/Service/Mailer.php", "src/Util/Log.php"]]
  },
  {
    fixture: "flat-app",
    entrypoint: "src/ui/App.ts",
    edges: [["src/ui/App.ts", "src/scenes/registry.ts"], ["src/scenes/registry.ts", "src/engine/draw.ts"], ["src/engine/draw.ts", "src/engine/palette.ts"]],
    namedEdge: { from: "src/ui/App.ts", to: "src/scenes/registry.ts", importedName: "scenes" }
  }
];

describe("labeled importer benchmark suite", () => {
  for (const golden of GOLDENS) {
    it(`preserves the ${golden.fixture} architecture answer key`, async () => {
      const root = path.join(FIXTURES, golden.fixture);
      const scan = await scanRepository(root);
      const parsed = await parseFiles(root, scan.files);
      const graph = await buildFileDependencyGraph(root, scan, parsed);
      const inventory = await buildContentInventory(root, scan);
      const snapshot = buildCodeKnowledgeSnapshot({ scan, parsed, fileGraph: graph, source: "codebase-import" });
      const pairs = new Set(graph.edges.map((edge) => `${edge.from} -> ${edge.to}`));

      expect(scan.truncated).toBe(false);
      expect(graph.resolutionRate).toBe(1);
      for (const [from, to] of golden.edges) expect(pairs).toContain(`${from} -> ${to}`);
      const snapshotPairs = new Set(snapshot.edges.filter((edge) => edge.kind === "dependency").map((edge) => {
        const source = snapshot.nodes.find((node) => node.id === edge.source)?.path;
        const target = snapshot.nodes.find((node) => node.id === edge.target)?.path;
        return `${source} -> ${target}`;
      }));
      for (const [from, to] of golden.edges) expect(snapshotPairs).toContain(`${from} -> ${to}`);
      expect(snapshot.stats.resolutionRate).toBe(graph.resolutionRate);
      if (golden.entrypoint) expect(inventory.entrypoints).toContain(golden.entrypoint);
      if (golden.namedEdge) {
        const edge = graph.edges.find((candidate) => candidate.from === golden.namedEdge?.from && candidate.to === golden.namedEdge?.to);
        expect(edge?.importedNames).toContain(golden.namedEdge.importedName);
      }
      if (golden.relationEdge) {
        const edge = graph.edges.find((candidate) => candidate.from === golden.relationEdge?.from && candidate.to === golden.relationEdge?.to);
        expect(edge?.relationKinds).toContain(golden.relationEdge.relation);
      }
    }, 30_000);
  }
});
