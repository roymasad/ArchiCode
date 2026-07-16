import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContentInventory } from "../src/main/importer/inventory";
import { scanRepository } from "../src/main/importer/scanner";
import type { FileDependencyGraph, RepoScan } from "../src/main/importer/types";

async function makeRepo(structure: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "importer-inventory-"));
  for (const [relPath, content] of Object.entries(structure)) {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return root;
}

describe("importer content inventory", () => {
  it("detects Dart, Kotlin, and nested-service entrypoints while skipping tests", async () => {
    const root = await makeRepo({
      "lib/main.dart": "void main() {}",
      "backend/pro-ai-service/src/server.ts": "export {};",
      "android/app/MainActivity.kt": "fun main() {}",
      "test/main.dart": "void main() {}",
      "too/deep/for/the/limit/main.ts": "export {};"
    });
    const scan = await scanRepository(root);
    const inventory = await buildContentInventory(root, scan);
    expect(inventory.entrypoints).toContain("lib/main.dart");
    expect(inventory.entrypoints).toContain("backend/pro-ai-service/src/server.ts");
    expect(inventory.entrypoints).not.toContain("test/main.dart");
    expect(inventory.entrypoints).not.toContain("too/deep/for/the/limit/main.ts");
  });

  it("does not mistake HTTP protocol constants for product catalogs", async () => {
    const root = await makeRepo({
      "src/feedback-config.ts": [
        'gateway("GET", "Content-Type")',
        'gateway("POST", "Authorization")',
        'gateway("OPTIONS", "Access-Control-Allow-Origin")',
        'gateway("DELETE", "application/json")'
      ].join("\n")
    });
    const inventory = await buildContentInventory(root, await scanRepository(root));
    expect(inventory.catalogs).toEqual([]);
  });

  it("keeps unsupported parser languages in the structural and generic-evidence fallback", async () => {
    const root = await makeRepo({
      "src/pages/feedback.astro": "---\nconst response = await fetch('https://api.example.com/feedback');\n---\n<h1>Feedback</h1>",
      "infra/main.tf": "resource \"example_service\" \"main\" {}"
    });
    const scan = await scanRepository(root);
    const astro = scan.files.find((file) => file.relPath.endsWith("feedback.astro"));
    expect(astro?.language).toBeNull();
    expect(astro?.detectedLanguage).toBe("astro");
    expect(scan.stats.structuralFallbackFiles).toBe(2);
    const inventory = await buildContentInventory(root, scan);
    expect(inventory.interactions).toContainEqual(expect.objectContaining({
      file: "src/pages/feedback.astro",
      kind: "http-call",
      target: "https://api.example.com/feedback"
    }));
  });

  it("captures bounded README and deployment declarations for big-picture architecture synthesis", async () => {
    const root = await makeRepo({
      "README.md": "# Product\nUsers plan work and track completed outcomes.",
      ".github/workflows/deploy.yml": "steps:\n  - run: npm test\n  - run: scp dist/app server:/srv/app",
      "netlify.toml": "[build]\ncommand = 'npm run build'\npublish = 'dist'",
      "src/index.ts": "export const start = true;"
    });
    const inventory = await buildContentInventory(root, await scanRepository(root));
    expect(inventory.architectureDocuments).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "README.md", excerpt: expect.stringContaining("track completed outcomes") }),
      expect.objectContaining({ file: ".github/workflows/deploy.yml", excerpt: expect.stringContaining("scp dist/app") }),
      expect.objectContaining({ file: "netlify.toml", excerpt: expect.stringContaining("publish") })
    ]));
  });

  it("extracts bounded language-neutral behavioral hotspots for architecture lenses", async () => {
    const root = await makeRepo({
      "server.js": [
        "const app = createServer();",
        "app.post('/session', async (request, response) => {",
        "  const policy = `The assistant must confirm the selected menu item,",
        "  explain unavailable choices, and request approval before placing the order.",
        "  Always recap the order before confirming the workflow outcome.`;",
        "  response.send(await createSession(policy));",
        "});"
      ].join("\n"),
      "src/stores/session.ts": "export function connectSession() { return startWorkflow(); }"
    });
    const inventory = await buildContentInventory(root, await scanRepository(root));
    const serverHotspots = inventory.evidenceHotspots?.filter((hotspot) => hotspot.file === "server.js") ?? [];
    expect(serverHotspots.flatMap((hotspot) => hotspot.categories)).toEqual(expect.arrayContaining(["runtime-boundary", "business-rule"]));
    expect(serverHotspots.map((hotspot) => hotspot.excerpt).join(" ")).toContain("confirm the selected menu item");
    expect(inventory.evidenceHotspots?.length).toBeLessThanOrEqual(24);
    expect(inventory.behavioralContracts?.map((contract) => contract.title).join(" ")).toContain("Confirm the selected menu item");
  });

  it("preserves ordered journey evidence without promoting implementation syntax to product behavior", async () => {
    const root = await makeRepo({
      "server.js": [
        "const policy = `Rules:",
        "- Ask the user about preferences and allergies",
        "- Note the order details and keep a tally",
        "(assistant) -> welcome the user",
        "(assistant) -> show the menu",
        "Condition: when the user confirms the order",
        "(assistant) -> send the confirmed order`;"
      ].join("\n"),
      "src/view.ts": [
        "const sessionActive = true;",
        "sessionActive.value = newState === 'connected';",
        "console.log('user session started');",
        "const template = `<div class=\"menu\">show menu</div>`;"
      ].join("\n")
    });
    const inventory = await buildContentInventory(root, await scanRepository(root));
    const contracts = inventory.behavioralContracts ?? [];
    expect(contracts.every((contract) => contract.evidenceMode === "declared")).toBe(true);
    expect(contracts.filter((contract) => contract.kind === "journey-step").map((contract) => contract.sequence)).toEqual([4, 5, 7]);
    expect(contracts.some((contract) => contract.kind === "decision" && contract.line === 6)).toBe(true);
    expect(contracts.some((contract) => contract.file === "src/view.ts")).toBe(false);
  });

  it("detects literal runtime routes and calls across common stacks", async () => {
    const root = await makeRepo({
      "flask/app.py": "@app.route('/orders', methods=['POST'])\ndef create_order(): pass\nrequests.get('https://menu.example.com/items')",
      "django/urls.py": "urlpatterns = [path('feedback/', views.feedback)]",
      "rails/routes.rb": "get '/menu', to: 'menu#index'\nresources :orders",
      "laravel/routes.php": "Route::post('/checkout', [CheckoutController::class, 'store']);",
      "go/main.go": "http.HandleFunc(\"/health\", health)\nr.Get(\"/tables\", listTables)"
    });
    const inventory = await buildContentInventory(root, await scanRepository(root));
    expect(inventory.interactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "flask/app.py", kind: "http-route", target: "/orders", method: "POST" }),
      expect.objectContaining({ file: "flask/app.py", kind: "http-call", target: "https://menu.example.com/items", method: "GET" }),
      expect.objectContaining({ file: "django/urls.py", kind: "http-route", target: "/feedback/" }),
      expect.objectContaining({ file: "rails/routes.rb", kind: "http-route", target: "/menu", method: "GET" }),
      expect.objectContaining({ file: "rails/routes.rb", kind: "http-route", target: "/orders" }),
      expect.objectContaining({ file: "laravel/routes.php", kind: "http-route", target: "/checkout", method: "POST" }),
      expect.objectContaining({ file: "go/main.go", kind: "http-route", target: "/health" }),
      expect.objectContaining({ file: "go/main.go", kind: "http-route", target: "/tables", method: "GET" })
    ]));
  });

  it("prioritizes dependency-significant late-alphabet files within the bounded inventory", async () => {
    const filler = Array.from({ length: 500 }, (_, index) => ({
      relPath: `aaa/file-${String(index).padStart(3, "0")}.ts`, ext: ".ts", sizeBytes: 10, language: "typescript" as const, detectedLanguage: "typescript", role: "production" as const
    }));
    const interesting = { relPath: "zzz/runtime/worker.ts", ext: ".ts", sizeBytes: 120, language: "typescript" as const, detectedLanguage: "typescript", role: "production" as const };
    const scan: RepoScan = { files: [...filler, interesting], truncated: false, stats: { totalFiles: 501, byLanguage: { typescript: 501 } } };
    const fileGraph: FileDependencyGraph = {
      edges: [{ from: interesting.relPath, to: filler[0].relPath, occurrences: 80, importedNames: [], evidence: [], relationKinds: ["dependency"] }],
      externalsByFile: new Map(), unresolved: [], resolutionRate: 1
    };
    const inventory = await buildContentInventory("/virtual", scan, {
      fileGraph,
      sourceReader: {
        hits: 0,
        misses: 0,
        read: async (relPath) => Buffer.from(relPath === interesting.relPath ? "fetch('https://late.example.com/runtime')" : "export {}")
      }
    });
    expect(inventory.coverage).toMatchObject({ eligibleFiles: 501, inspectedFiles: 480, excludedFiles: 21, strategy: "priority-diverse" });
    expect(inventory.interactions).toContainEqual(expect.objectContaining({ file: interesting.relPath, target: "https://late.example.com/runtime" }));
  });
});
