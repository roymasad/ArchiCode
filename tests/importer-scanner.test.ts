import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepository, languageForFile } from "../src/main/importer/scanner";
import { languageForSemanticSource } from "../src/main/importer/sourceLanguages";

async function makeRepo(structure: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "importer-scan-"));
  for (const [relPath, content] of Object.entries(structure)) {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return root;
}

describe("importer scanner", () => {
  it("respects stacked .gitignore files at every level", async () => {
    const root = await makeRepo({
      ".gitignore": "generated/\n*.log\n",
      "src/.gitignore": "local-only.ts\n",
      "src/app.ts": "export {}",
      "src/local-only.ts": "export {}",
      "generated/out.ts": "export {}",
      "notes.log": "x",
      "keep.ts": "export {}"
    });
    const scan = await scanRepository(root);
    const paths = scan.files.map((file) => file.relPath);
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("keep.ts");
    expect(paths).not.toContain("src/local-only.ts");
    expect(paths).not.toContain("generated/out.ts");
    expect(paths).not.toContain("notes.log");
  });

  it("skips hardcoded dependency directories and symlinks", async () => {
    const root = await makeRepo({
      "node_modules/dep/index.js": "module.exports = 1",
      "vendor/lib.php": "<?php",
      ".next/server/app.js": "generated",
      ".dart_tool/flutter_build/app.dart": "generated",
      "Pods/Library/Pod.swift": "generated",
      "cmake-build-debug/generated.cpp": "generated",
      "target/classes/App.class": "generated",
      "artifacts/output/source.ts": "generated",
      "packages/core/index.ts": "export const retainedMonorepoSource = true",
      "src/real.ts": "export {}"
    });
    await symlink(path.join(root, "src"), path.join(root, "linked"));
    const scan = await scanRepository(root);
    const paths = scan.files.map((file) => file.relPath);
    expect(paths).toEqual(["packages/core/index.ts", "src/real.ts"]);
  });

  it("detects languages by extension", () => {
    expect(languageForFile("a/b.tsx")).toBe("tsx");
    expect(languageForFile("a/b.py")).toBe("python");
    expect(languageForFile("a/b.rs")).toBe("rust");
    expect(languageForFile("a/b.cs")).toBe("c_sharp");
    expect(languageForFile("a/b.hpp")).toBe("cpp");
    expect(languageForFile("a/b.md")).toBeNull();
  });

  it("records real file sizes so unparsed languages can still be ranked", async () => {
    const root = await makeRepo({
      "lib/big_screen.dart": "x".repeat(5_000),
      "lib/small_helper.dart": "x".repeat(100)
    });
    const scan = await scanRepository(root);
    const sizes = new Map(scan.files.map((file) => [file.relPath, file.sizeBytes]));
    expect(sizes.get("lib/big_screen.dart")).toBe(5_000);
    expect(sizes.get("lib/small_helper.dart")).toBe(100);
  });

  it("recognizes a broad set of semantic source languages without admitting ordinary text or generated assets", () => {
    expect(languageForSemanticSource("app/MainActivity.kt")).toBe("kotlin");
    expect(languageForSemanticSource("ios/AppDelegate.swift")).toBe("swift");
    expect(languageForSemanticSource("lib/main.dart")).toBe("dart");
    expect(languageForSemanticSource("src/Page.vue")).toBe("vue");
    expect(languageForSemanticSource("contracts/Token.sol")).toBe("solidity");
    expect(languageForSemanticSource("infra/main.tf")).toBe("hcl");
    expect(languageForSemanticSource("shader/main.wgsl")).toBe("wgsl");
    expect(languageForSemanticSource("Dockerfile")).toBe("dockerfile");
    expect(languageForSemanticSource("README.md")).toBeNull();
    expect(languageForSemanticSource("fixtures/users.csv")).toBeNull();
    expect(languageForSemanticSource("package.json")).toBeNull();
    expect(languageForSemanticSource("bundle.min.js")).toBeNull();
    expect(languageForSemanticSource("generated.g.ts")).toBeNull();
  });
});
