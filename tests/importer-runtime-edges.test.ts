import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFileDependencyGraph } from "../src/main/importer/fileGraph";
import { buildModuleGraph } from "../src/main/importer/aggregate";
import { emitImportOperations } from "../src/main/importer/emit";
import { buildContentInventory, type ContentInventory } from "../src/main/importer/inventory";
import { parseFiles } from "../src/main/importer/parsers";
import { addHighConfidenceRuntimeEdges } from "../src/main/importer/runtimeEdges";
import { scanRepository } from "../src/main/importer/scanner";
import type { FileDependencyGraph } from "../src/main/importer/types";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-edges-"));
  for (const [relPath, source] of Object.entries(files)) {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, source, "utf8");
  }
  return root;
}

describe("high-confidence importer runtime edges", () => {
  it("joins literal IPC channels and HTTP method/path pairs across otherwise disconnected files", async () => {
    const root = await makeRepo({
      "lib/report.dart": "Future<void> send() => http.post(Uri.parse('$baseUrl/api/report'));",
      "backend/server.ts": "app.post('/api/report', async (_req, res) => res.send('ok'));",
      "src/preload/save.ts": "export const save = () => ipcRenderer.invoke('project:save');",
      "src/main/save.ts": "ipcMain.handle('project:save', async () => true);"
    });
    const scan = await scanRepository(root);
    const parsed = await parseFiles(root, scan.files);
    const graph = await buildFileDependencyGraph(root, scan, parsed);
    const inventory = await buildContentInventory(root, scan);
    addHighConfidenceRuntimeEdges(graph, inventory);

    const http = graph.edges.find((edge) => edge.from === "lib/report.dart" && edge.to === "backend/server.ts");
    expect(http?.relationKinds).toContain("http");
    expect(http?.evidence).toContainEqual(expect.objectContaining({ specifier: "http:POST /api/report" }));
    const ipc = graph.edges.find((edge) => edge.from === "src/preload/save.ts" && edge.to === "src/main/save.ts");
    expect(ipc?.relationKinds).toContain("ipc");
    expect(ipc?.confidence).toBe(1);

    const moduleGraph = buildModuleGraph({ scan, parsed, fileGraph: graph, inventory, levels: "1", detail: "deep", granularity: "system" });
    expect(moduleGraph.edges.some((edge) => edge.relationKinds?.includes("http"))).toBe(true);
    expect(moduleGraph.edges.some((edge) => edge.relationKinds?.includes("ipc"))).toBe(true);
    const emittedLabels = emitImportOperations({ flowId: "flow-runtime", moduleGraph, annotations: null, projectName: "runtime-demo", codebaseHints: [], checkedAt: "2026-07-12T00:00:00.000Z" })
      .flatMap((operation) => operation.kind === "create-edge" ? [operation.edge.label] : []);
    expect(emittedLabels).toContain("HTTP POST /api/report (1)");
    expect(emittedLabels).toContain("IPC project:save (1)");
  });

  it("does not infer edges from method mismatches or generic event names", () => {
    const graph: FileDependencyGraph = { edges: [], externalsByFile: new Map(), unresolved: [], resolutionRate: 1 };
    const inventory: ContentInventory = {
      catalogs: [], routes: [], entrypoints: [],
      interactions: [
        { file: "client.ts", kind: "http-call", target: "/items", method: "GET", confidence: 1 },
        { file: "server.ts", kind: "http-route", target: "/items", method: "POST", confidence: 1 },
        { file: "publisher.ts", kind: "event-publish", target: "changed" },
        { file: "subscriber.ts", kind: "event-subscribe", target: "changed" }
      ]
    };
    expect(addHighConfidenceRuntimeEdges(graph, inventory)).toBe(0);
    expect(graph.edges).toEqual([]);
  });

  it("recognizes worker-style pathname dispatch for Flutter-to-worker flows", async () => {
    const root = await makeRepo({
      "lib/report.dart": "Future<void> send() => http.post(Uri.parse('${apiBase}/v1/report'));",
      "worker/index.ts": "if (request.method === 'POST' && url.pathname === '/v1/report') return generateReport(request);"
    });
    const scan = await scanRepository(root);
    const parsed = await parseFiles(root, scan.files);
    const graph = await buildFileDependencyGraph(root, scan, parsed);
    const inventory = await buildContentInventory(root, scan);
    addHighConfidenceRuntimeEdges(graph, inventory);
    expect(graph.edges.find((edge) => edge.from === "lib/report.dart" && edge.to === "worker/index.ts")?.relationKinds).toContain("http");
  });

  it("links endpoint factory references across Dart configuration and HTTP callers", async () => {
    const root = await makeRepo({
      "lib/app_config.dart": "class AppConfig { static Future<Uri> getGenerateReportUri() async { final baseUrl = 'x'; return Uri.parse('$baseUrl/api/reports/generate'); } }",
      "lib/api.dart": "Future<void> send() async { await http.post(await AppConfig.getGenerateReportUri()); }",
      "backend/server.ts": "app.post('/api/reports/generate', handler);"
    });
    const scan = await scanRepository(root);
    const parsed = await parseFiles(root, scan.files);
    const graph = await buildFileDependencyGraph(root, scan, parsed);
    const inventory = await buildContentInventory(root, scan);
    addHighConfidenceRuntimeEdges(graph, inventory);
    expect(graph.edges.find((edge) => edge.from === "lib/api.dart" && edge.to === "backend/server.ts")?.relationKinds).toContain("http");
  });

  it("correlates cross-language channels, shared widget keys, and templated routes", async () => {
    const root = await makeRepo({
      "lib/bridge.dart": "const channel = MethodChannel('com.demo.contacts'); Future<void> load() => channel.invokeMethod('getContacts'); Future<void> sync() => HomeWidget.saveWidgetData<String>('todo_title', 'x');",
      "android/Bridge.kt": "MethodChannel(engine.dartExecutor.binaryMessenger, \"com.demo.contacts\").setMethodCallHandler { call, result -> result.success(null) }; val title = prefs.getString(\"todo_title\", null)",
      "web/client.ts": "export const helpful = (slug: string) => fetch(`/helpful/${slug}`);",
      "worker/server.ts": "app.get('/helpful/:slug', handler);"
    });
    const scan = await scanRepository(root);
    const parsed = await parseFiles(root, scan.files);
    const graph = await buildFileDependencyGraph(root, scan, parsed);
    const inventory = await buildContentInventory(root, scan);
    addHighConfidenceRuntimeEdges(graph, inventory);

    const bridgeEdges = graph.edges.filter((edge) => edge.from === "lib/bridge.dart" && edge.to === "android/Bridge.kt");
    expect(bridgeEdges.some((edge) => edge.relationKinds?.includes("ipc"))).toBe(true);
    expect(bridgeEdges.some((edge) => edge.relationKinds?.includes("shared-data"))).toBe(true);
    expect(graph.edges.find((edge) => edge.from === "web/client.ts" && edge.to === "worker/server.ts")?.relationKinds).toContain("http");
  });
});

describe("platform-host runtime edges", () => {
  it("connects native Flutter shells to the app entrypoint with a hosts edge", async () => {
    const root = await makeRepo({
      "lib/main.dart": "void main() {}",
      "android/app/src/main/kotlin/com/demo/MainActivity.kt": "package com.demo\nimport io.flutter.embedding.android.FlutterActivity\nclass MainActivity : FlutterActivity()",
      "ios/Runner/AppDelegate.swift": "import Flutter\n@main class AppDelegate: FlutterAppDelegate { override func application() -> Bool { GeneratedPluginRegistrant.register(with: self); return true } }"
    });
    const scan = await scanRepository(root);
    const parsed = await parseFiles(root, scan.files);
    const graph = await buildFileDependencyGraph(root, scan, parsed);
    const inventory = await buildContentInventory(root, scan);
    addHighConfidenceRuntimeEdges(graph, inventory);

    const androidHost = graph.edges.find((edge) => edge.from.endsWith("MainActivity.kt") && edge.to === "lib/main.dart");
    expect(androidHost?.relationKinds).toContain("hosts");
    const iosHost = graph.edges.find((edge) => edge.from.endsWith("AppDelegate.swift") && edge.to === "lib/main.dart");
    expect(iosHost?.relationKinds).toContain("hosts");

    const moduleGraph = buildModuleGraph({ scan, parsed, fileGraph: graph, inventory, levels: "1", detail: "deep", granularity: "system" });
    const labels = emitImportOperations({ flowId: "flow-hosts", moduleGraph, annotations: null, projectName: "hosts-demo", codebaseHints: [], checkedAt: "2026-07-13T00:00:00.000Z" })
      .flatMap((operation) => operation.kind === "create-edge" ? [operation.edge.label] : []);
    expect(labels).toContain("hosts the Flutter runtime");
  });
});
