import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { scanRepository } from "../src/main/importer/scanner";
import { parseFiles } from "../src/main/importer/parsers";
import { buildFileDependencyGraph } from "../src/main/importer/fileGraph";

const FIXTURES = path.resolve(process.cwd(), "fixtures", "importer");

async function graphFor(fixture: string) {
  const projectRoot = path.join(FIXTURES, fixture);
  const scan = await scanRepository(projectRoot);
  const parsed = await parseFiles(projectRoot, scan.files);
  const graph = await buildFileDependencyGraph(projectRoot, scan, parsed);
  return { scan, parsed, graph };
}

function edgeSet(graph: { edges: Array<{ from: string; to: string }> }): Set<string> {
  return new Set(graph.edges.map((edge) => `${edge.from} -> ${edge.to}`));
}

describe("importer resolvers", () => {
  it("resolves JS/TS imported bindings to exact call and construction lines", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "importer-calls-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/service.ts"), "export default class Service {}\nexport function run() {}\n", "utf8");
    await writeFile(path.join(root, "src/api.ts"), "export function load() {}\n", "utf8");
    await writeFile(path.join(root, "src/unused.ts"), "export function idle() {}\n", "utf8");
    await writeFile(path.join(root, "src/main.ts"), [
      "import Service, { run as execute } from './service'",
      "import * as api from './api'",
      "import { idle } from './unused'",
      "execute()",
      "new Service()",
      "api.load()"
    ].join("\n"), "utf8");
    const scan = await scanRepository(root);
    const parsed = await parseFiles(root, scan.files);
    const graph = await buildFileDependencyGraph(root, scan, parsed);
    const service = graph.edges.find((edge) => edge.from === "src/main.ts" && edge.to === "src/service.ts");
    const api = graph.edges.find((edge) => edge.from === "src/main.ts" && edge.to === "src/api.ts");
    const unused = graph.edges.find((edge) => edge.from === "src/main.ts" && edge.to === "src/unused.ts");
    expect(service?.relationKinds).toContain("calls");
    expect(service?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 4, specifier: "calls:execute" }),
      expect.objectContaining({ line: 5, specifier: "constructs:Service" })
    ]));
    expect(api?.relationKinds).toContain("calls");
    expect(api?.evidence).toContainEqual(expect.objectContaining({ line: 6, specifier: "calls:api.load" }));
    expect(unused?.relationKinds).not.toContain("calls");
  });

  it("resolves TS relative imports, barrels, and tsconfig paths", async () => {
    const { graph } = await graphFor("ts-app");
    const edges = edgeSet(graph);
    expect(edges).toContain("src/index.ts -> src/app/index.ts");
    expect(edges).toContain("src/index.ts -> src/app/util.ts");
    expect(edges).toContain("src/app/index.ts -> src/app/util.ts");
    expect(edges).toContain("src/other.ts -> src/app/util.ts");
    expect(graph.externalsByFile.get("src/other.ts")).toContain("react");
    expect(graph.unresolved).toHaveLength(0);
    expect(graph.resolutionRate).toBe(1);
  });

  it("resolves workspace package names in a monorepo", async () => {
    const { graph } = await graphFor("monorepo");
    const edges = edgeSet(graph);
    expect(edges).toContain("packages/app/src/main.ts -> packages/ui/src/index.ts");
    expect(edges).toContain("packages/app/src/main.ts -> packages/ui/src/button.ts");
    expect(edges).toContain("packages/ui/src/index.ts -> packages/ui/src/button.ts");
    expect(graph.unresolved).toHaveLength(0);
  });

  it("resolves Python absolute and relative module imports", async () => {
    const { graph } = await graphFor("py-app");
    const edges = edgeSet(graph);
    expect(edges).toContain("main.py -> pkg/core.py");
    expect(edges).toContain("main.py -> pkg/util.py");
    expect(edges).toContain("pkg/core.py -> pkg/util.py");
    expect(graph.unresolved).toHaveLength(0);
  });

  it("resolves Go module-path imports to package directories", async () => {
    const { graph } = await graphFor("go-app");
    const edges = edgeSet(graph);
    expect(edges).toContain("main.go -> internal/svc/svc.go");
    expect(edges).toContain("internal/svc/svc.go -> internal/store/store.go");
    const mainExternals = graph.externalsByFile.get("main.go") ?? [];
    expect(mainExternals).toContain("fmt");
    expect(graph.unresolved).toHaveLength(0);
  });

  it("resolves Rust mod declarations and crate:: paths", async () => {
    const { graph } = await graphFor("rust-app");
    const edges = edgeSet(graph);
    expect(edges).toContain("src/main.rs -> src/svc.rs");
    expect(edges).toContain("src/main.rs -> src/store.rs");
    expect(edges).toContain("src/svc.rs -> src/store.rs");
    expect(graph.unresolved).toHaveLength(0);
  });

  it("resolves PHP requires and PSR-4 namespaces", async () => {
    const { graph } = await graphFor("php-app");
    const edges = edgeSet(graph);
    expect(edges).toContain("public/index.php -> src/bootstrap.php");
    expect(edges).toContain("public/index.php -> src/Service/Mailer.php");
    expect(edges).toContain("src/Service/Mailer.php -> src/Util/Log.php");
    expect(graph.unresolved).toHaveLength(0);
  });

  it("resolves C/C++ quoted includes via relative and include roots", async () => {
    const { graph } = await graphFor("cpp-app");
    const edges = edgeSet(graph);
    expect(edges).toContain("src/engine.cpp -> include/demo/engine.h");
    expect(edges).toContain("src/engine.cpp -> src/util.h");
    expect(edges).toContain("src/main.cpp -> include/demo/engine.h");
    const mainExternals = graph.externalsByFile.get("src/main.cpp") ?? [];
    expect(mainExternals).toContain("vector");
    expect(graph.unresolved).toHaveLength(0);
  });

  it("resolves C# usings via declared namespaces and csproj references", async () => {
    const { graph } = await graphFor("csharp-app");
    const edges = edgeSet(graph);
    expect(edges).toContain("App/Program.cs -> Lib/Helper.cs");
    expect(edges).toContain("App/App.csproj -> Lib/Lib.csproj");
  });
});
