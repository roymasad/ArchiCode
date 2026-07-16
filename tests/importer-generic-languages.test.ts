import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFileDependencyGraph } from "../src/main/importer/fileGraph";
import { parseFiles } from "../src/main/importer/parsers";
import { scanRepository } from "../src/main/importer/scanner";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "archicode-major-languages-"));
  await Promise.all(Object.entries(files).map(async ([relPath, source]) => {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, source, "utf8");
  }));
  return root;
}

async function analyze(files: Record<string, string>) {
  const root = await makeRepo(files);
  const scan = await scanRepository(root);
  const parsed = await parseFiles(root, scan.files);
  const graph = await buildFileDependencyGraph(root, scan, parsed);
  return { scan, parsed, graph };
}

function edgeSet(edges: Array<{ from: string; to: string }>): Set<string> {
  return new Set(edges.map((edge) => `${edge.from} -> ${edge.to}`));
}

describe("config-driven major language support", () => {
  it("parses and resolves Dart package, relative, export, and part relationships", async () => {
    const { parsed, graph } = await analyze({
      "pubspec.yaml": "name: demo_app\n",
      "lib/main.dart": "import 'package:demo_app/core/service.dart';\nimport './local.dart';\nexport 'shared.dart';\npart 'piece.dart';\nvoid main() {}\n",
      "lib/core/service.dart": "class Service {}\n",
      "lib/local.dart": "class Local {}\n",
      "lib/shared.dart": "class Shared {}\n",
      "lib/piece.dart": "part of 'main.dart';\n"
    });
    expect(parsed.find((file) => file.relPath === "lib/core/service.dart")?.symbols).toContain("Service");
    expect(edgeSet(graph.edges)).toEqual(new Set([
      "lib/main.dart -> lib/core/service.dart",
      "lib/main.dart -> lib/local.dart",
      "lib/main.dart -> lib/shared.dart",
      "lib/main.dart -> lib/piece.dart"
    ]));
  });

  it("resolves Java and Kotlin qualified imports through package and symbol identities", async () => {
    const { parsed, graph } = await analyze({
      "java/com/acme/core/Service.java": "package com.acme.core; public class Service {}",
      "java/com/acme/app/App.java": "package com.acme.app; import com.acme.core.Service; public class App {}",
      "kotlin/com/acme/core/Store.kt": "package com.acme.core\nclass Store",
      "kotlin/com/acme/app/Screen.kt": "package com.acme.app\nimport com.acme.core.Store\nclass Screen"
    });
    expect(parsed.find((file) => file.relPath.endsWith("App.java"))?.symbols).toContain("App");
    expect(parsed.find((file) => file.relPath.endsWith("Screen.kt"))?.symbols).toContain("Screen");
    const edges = edgeSet(graph.edges);
    expect(edges).toContain("java/com/acme/app/App.java -> java/com/acme/core/Service.java");
    expect(edges).toContain("kotlin/com/acme/app/Screen.kt -> kotlin/com/acme/core/Store.kt");
  });

  it("resolves Ruby relative requires and Lua module requires", async () => {
    const { parsed, graph } = await analyze({
      "ruby/app.rb": "require_relative 'core/service'\nclass App; end\n",
      "ruby/core/service.rb": "class Service; end\n",
      "lua/main.lua": "local service = require('core.service')\nfunction run() end\n",
      "core/service.lua": "return {}\n"
    });
    expect(parsed.find((file) => file.relPath === "ruby/app.rb")?.symbols).toContain("App");
    expect(parsed.find((file) => file.relPath === "lua/main.lua")?.imports).toEqual(expect.arrayContaining([expect.objectContaining({ specifier: "core.service" })]));
    const edges = edgeSet(graph.edges);
    expect(edges).toContain("ruby/app.rb -> ruby/core/service.rb");
    expect(edges).toContain("lua/main.lua -> core/service.lua");
  });

  it("extracts Swift symbols and records module imports as external boundaries", async () => {
    const { parsed, graph } = await analyze({
      "Sources/App.swift": "import Foundation\nstruct User {}\nclass App { func run() {} }\n"
    });
    const file = parsed[0];
    expect(file.symbols).toEqual(expect.arrayContaining(["User", "App"]));
    expect(graph.externalsByFile.get("Sources/App.swift")).toContain("Foundation");
  });

  it("resolves Scala and Elixir module imports", async () => {
    const { parsed, graph } = await analyze({
      "scala/core/Service.scala": "package demo.core\nclass Service",
      "scala/app/App.scala": "package demo.app\nimport demo.core.Service\nclass App",
      "lib/demo/core/service.ex": "defmodule Demo.Core.Service do\nend\n",
      "lib/demo/app.ex": "defmodule Demo.App do\n alias Demo.Core.Service\n def run do\n  Service.go()\n end\nend\n"
    });
    expect(parsed.find((file) => file.relPath.endsWith("App.scala"))?.symbols).toContain("App");
    const edges = edgeSet(graph.edges);
    expect(edges).toContain("scala/app/App.scala -> scala/core/Service.scala");
    expect(edges).toContain("lib/demo/app.ex -> lib/demo/core/service.ex");
  });

  it("parses Vue script imports and resolves Vue components", async () => {
    const { parsed, graph } = await analyze({
      "src/App.vue": "<script setup lang=\"ts\">\nimport Widget from './Widget.vue'\nconst App = () => Widget\n</script>\n<template><Widget /></template>\n",
      "src/Widget.vue": "<script setup>\nexport const Widget = () => 'ready'\n</script>\n<template>ready</template>\n"
    });
    expect(parsed.find((file) => file.relPath === "src/App.vue")?.parseError).toBeUndefined();
    expect(parsed.find((file) => file.relPath === "src/App.vue")?.imports).toEqual(expect.arrayContaining([expect.objectContaining({ specifier: "./Widget.vue" })]));
    expect(edgeSet(graph.edges)).toContain("src/App.vue -> src/Widget.vue");
  });

  it("parses Objective-C imports and declarations", async () => {
    const { parsed, graph } = await analyze({
      "ios/App.m": "#import <Foundation/Foundation.h>\n#import \"Service.h\"\n@interface App : NSObject\n@end\n@implementation App\n@end\n",
      "ios/Service.h": "void serve(void);\n"
    });
    expect(parsed.find((file) => file.relPath === "ios/App.m")?.symbols).toContain("App");
    expect(edgeSet(graph.edges)).toContain("ios/App.m -> ios/Service.h");
    expect(graph.externalsByFile.get("ios/App.m")).toContain("Foundation/Foundation.h");
  });

  it("parses Solidity contracts and resolves relative imports", async () => {
    const { parsed, graph } = await analyze({
      "contracts/Vault.sol": "pragma solidity ^0.8.20;\nimport { Ownable } from './Ownable.sol';\ncontract Vault is Ownable { function deposit() public {} }\n",
      "contracts/Ownable.sol": "contract Ownable {}\n"
    });
    expect(parsed.find((file) => file.relPath === "contracts/Vault.sol")?.symbols).toContain("Vault");
    expect(edgeSet(graph.edges)).toContain("contracts/Vault.sol -> contracts/Ownable.sol");
  });

  it("parses Zig imports and public declarations", async () => {
    const { parsed, graph } = await analyze({
      "src/main.zig": "const std = @import(\"std\");\nconst service = @import(\"core/service.zig\");\npub const App = struct {};\npub fn main() void { service.go(); }\n",
      "src/core/service.zig": "pub fn go() void {}\n"
    });
    expect(parsed.find((file) => file.relPath === "src/main.zig")?.symbols).toEqual(expect.arrayContaining(["App", "main"]));
    expect(edgeSet(graph.edges)).toContain("src/main.zig -> src/core/service.zig");
    expect(graph.externalsByFile.get("src/main.zig")).toContain("std");
  });

  it("parses shell source relationships and functions", async () => {
    const { parsed, graph } = await analyze({
      "scripts/main.sh": "#!/usr/bin/env bash\nsource ./lib/common.sh\nrun_app() { echo ready; }\n",
      "scripts/lib/common.sh": "common() { echo common; }\n"
    });
    expect(parsed.find((file) => file.relPath === "scripts/main.sh")?.symbols).toContain("run_app");
    expect(edgeSet(graph.edges)).toContain("scripts/main.sh -> scripts/lib/common.sh");
  });
});
