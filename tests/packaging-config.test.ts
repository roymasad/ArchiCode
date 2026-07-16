import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("packaging configuration", () => {
  it("defines package scripts and signing placeholders", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      build: {
        appId: string;
        afterSign: string;
        npmRebuild: boolean;
        extraResources: Array<{ from: string; to: string; filter: string[] }>;
        mac: { hardenedRuntime: boolean; entitlements: string; extendInfo: Record<string, string> };
        win: { target: string[] };
      };
    };
    const entitlements = await readFile("build/entitlements.mac.plist", "utf8");

    expect(packageJson.scripts.dist).toContain("electron-builder");
    expect(packageJson.scripts["visual-qa"]).toContain("visual-qa-main");
    expect(packageJson.dependencies["@huggingface/transformers"]).toBeTruthy();
    expect(packageJson.build.appId).toBe("app.archicode.desktop");
    expect(packageJson.build.afterSign).toBe("scripts/notarize.cjs");
    expect(packageJson.build.npmRebuild).toBe(false);
    expect(packageJson.build.extraResources).toContainEqual({ from: "resources/semantic-model", to: "semantic-model", filter: ["**/*"] });
    expect(packageJson.build.extraResources).toContainEqual({ from: "resources/tree-sitter-wasms", to: "tree-sitter-wasms", filter: ["**/*.wasm"] });
    expect((await stat("resources/tree-sitter-wasms/tree-sitter-dart.wasm")).size).toBeGreaterThan(500_000);
    expect((await stat("resources/tree-sitter-wasms/tree-sitter-zig.wasm")).size).toBeGreaterThan(500_000);
    expect((await stat("resources/semantic-model/BAAI/bge-small-en-v1.5/onnx/model_quantized.onnx")).size).toBeGreaterThan(30_000_000);
    expect((await stat("resources/semantic-model/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx")).size).toBeGreaterThan(20_000_000);
    expect(packageJson.build.mac.hardenedRuntime).toBe(true);
    expect(packageJson.build.mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription).toContain("microphone");
    expect(entitlements).toContain("com.apple.security.device.audio-input");
    expect(packageJson.build.win.target).toContain("nsis");
  });
});
