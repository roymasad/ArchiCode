import { describe, expect, it } from "vitest";
import {
  parseSourceBatchFinishArguments,
  parseSourceFileToolArguments,
  sourceHandoffPatch
} from "../src/shared/sourceHandoff";

describe("structured source handoff repair", () => {
  it("parses a valid one-file tool payload without repair", () => {
    const result = parseSourceFileToolArguments(JSON.stringify({
      path: "src/main.ts",
      action: "create",
      content: "export const ready = true;\n",
      nodeId: "node-app"
    }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.repairedBy).toBeUndefined();
    expect(result.operation).toMatchObject({
      kind: "propose-source-file",
      path: "src/main.ts",
      action: "create",
      content: "export const ready = true;\n"
    });
  });

  it("repairs the unescaped nested JSON-string failure produced by DeepSeek", () => {
    const malformed = String.raw`{"path":"package.json","action":"create","content":"{\n  "name": "flowforge-website",\n  "private": true,\n  "scripts": {\n    "build": "vue-tsc --noEmit && vite build"\n  }\n}\n","nodeId":"node-architecture","reason":"Create the package manifest.","testIntent":"Run npm run build."}`;
    const result = parseSourceFileToolArguments(malformed);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.repairedBy).toBe("content-quote-repair");
    expect(result.operation.path).toBe("package.json");
    expect(result.operation.nodeId).toBe("node-architecture");
    expect(result.operation.content).toBe([
      "{",
      "  \"name\": \"flowforge-website\",",
      "  \"private\": true,",
      "  \"scripts\": {",
      "    \"build\": \"vue-tsc --noEmit && vite build\"",
      "  }",
      "}",
      ""
    ].join("\n"));
  });

  it("uses generic deterministic repair for ordinary missing commas", () => {
    const result = parseSourceFileToolArguments(
      `{"path":"src/main.ts" "action":"create","content":"export const ready = true;\\n","nodeIds":["node-app"]}`
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.repairedBy).toBe("jsonrepair");
    expect(result.operation.content).toBe("export const ready = true;\n");
  });

  it("rejects source handoffs that omit graph-node attribution", () => {
    const result = parseSourceFileToolArguments(JSON.stringify({
      path: "src/main.ts",
      action: "create",
      content: "export const ready = true;\n"
    }));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("nodeIds is required");
  });

  it("rejects ambiguous payloads that remain outside the source tool schema", () => {
    const result = parseSourceFileToolArguments(
      `{"path":"src/main.ts","action":"create","content":"ok","unexpected":{"broken":]}}`
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.pathHint).toBe("src/main.ts");
    expect(result.error).toContain("Deterministic repair failed");
  });

  it("repairs finish metadata and synthesizes the existing validated patch contract", () => {
    const finishResult = parseSourceBatchFinishArguments(
      `{"implementationStatus":"continue" "summary":"Created the runnable shell.","nextSourceSlice":"Add route views."}`
    );

    expect(finishResult.success).toBe(true);
    if (!finishResult.success) return;
    expect(finishResult.repairedBy).toBe("jsonrepair");
    const patch = sourceHandoffPatch("run-test", [{
      kind: "propose-source-file",
      path: "src/main.ts",
      action: "create",
      content: "export const ready = true;\n"
    }], finishResult.finish);
    expect(patch.runId).toBe("run-test");
    expect(patch.runSummary?.implementationStatus).toBe("continue");
    expect(patch.operations).toHaveLength(1);
  });

  it("normalizes a verification-only continuation because the host verifies after applying files", () => {
    const finishResult = parseSourceBatchFinishArguments(JSON.stringify({
      implementationStatus: "continue",
      summary: "All requested source files are staged.",
      nextSourceSlice: "Verify the build after applying staged files, then update node stages."
    }));

    expect(finishResult.success).toBe(true);
    if (!finishResult.success) return;
    expect(finishResult.repairedBy).toBe("verification-only-continuation");
    expect(finishResult.finish.implementationStatus).toBe("complete");
    expect(finishResult.finish.nextSourceSlice).toBeUndefined();
    expect(finishResult.finish.verificationNotes).toContain("applied and verified by the host");
  });

  it("preserves continue when another concrete source-file slice remains", () => {
    const finishResult = parseSourceBatchFinishArguments(JSON.stringify({
      implementationStatus: "continue",
      summary: "Created the runnable shell.",
      nextSourceSlice: "Create src/views/AboutView.vue and src/views/ContactView.vue."
    }));

    expect(finishResult.success).toBe(true);
    if (!finishResult.success) return;
    expect(finishResult.repairedBy).toBeUndefined();
    expect(finishResult.finish.implementationStatus).toBe("continue");
  });
});
