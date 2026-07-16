import { describe, expect, it } from "vitest";
import {
  RESEARCH_SCRATCHPAD_MAX_CODE_CHARS,
  RESEARCH_SCRATCHPAD_MAX_CONSOLE_CHARS,
  RESEARCH_SCRATCHPAD_MEMORY_BYTES,
  RESEARCH_SCRATCHPAD_STACK_BYTES,
  RESEARCH_SCRATCHPAD_TIMEOUT_MS,
  runResearchJavaScript
} from "../src/main/research/scratchpad";
import {
  callResearchProjectFileTool,
  isResearchProjectFileTool,
  researchProjectFileTools
} from "../src/main/research/inspectionTools";

describe("Research JavaScript scratchpad", () => {
  it("executes ordinary JavaScript for calculations and helper functions", async () => {
    const result = await runResearchJavaScript(`
      const compound = (principal, rate, years) => principal * (1 + rate) ** years;
      const values = [2, 4, 6, 8];
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      ({ compound: Number(compound(1000, 0.05, 10).toFixed(2)), mean });
    `);

    expect(result).toMatchObject({
      language: "JavaScript",
      engine: "QuickJS WebAssembly",
      resultType: "object",
      result: { compound: 1628.89, mean: 5 },
      truncated: false,
      limits: {
        timeoutMs: 10_000,
        memoryBytes: 64 * 1024 * 1024,
        stackBytes: 2 * 1024 * 1024,
        maxCodeChars: 32_000,
        maxOutputChars: 32_000,
        maxConsoleChars: 32_000
      }
    });
    expect(RESEARCH_SCRATCHPAD_TIMEOUT_MS).toBe(10_000);
    expect(RESEARCH_SCRATCHPAD_MEMORY_BYTES).toBe(64 * 1024 * 1024);
    expect(RESEARCH_SCRATCHPAD_STACK_BYTES).toBe(2 * 1024 * 1024);
    expect(RESEARCH_SCRATCHPAD_MAX_CODE_CHARS).toBe(32_000);
    expect(RESEARCH_SCRATCHPAD_MAX_CONSOLE_CHARS).toBe(32_000);
    expect(result.note).toContain("No project files");
  });

  it("supports standard control flow, objects, recursion, and bounded console output", async () => {
    const result = await runResearchJavaScript(`
      function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1); }
      const squares = [];
      for (let value = 1; value <= 5; value += 1) squares.push(value ** 2);
      console.log("squares", squares);
      console.warn({ factorial: factorial(10) });
      ({ factorial: factorial(10), squares, last: squares.at(-1) });
    `);

    expect(result.result).toEqual({
      factorial: 3_628_800,
      squares: [1, 4, 9, 16, 25],
      last: 25
    });
    expect(result.console).toEqual([
      { level: "log", text: "squares [1,4,9,16,25]" },
      { level: "warn", text: '{"factorial":3628800}' }
    ]);
  });

  it("uses a fresh isolated runtime with no Node, file, package, or network globals", async () => {
    const first = await runResearchJavaScript(`globalThis.replState = 42; typeof process;`);
    const second = await runResearchJavaScript(`({
      state: typeof replState,
      process: typeof process,
      require: typeof require,
      fetch: typeof fetch,
      window: typeof window
    });`);

    expect(first.result).toBe("undefined");
    expect(second.result).toEqual({
      state: "undefined",
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      window: "undefined"
    });
    await expect(runResearchJavaScript(`require("node:fs")`)).rejects.toThrow(/require.*is not defined/);
    await expect(runResearchJavaScript(`import fs from "node:fs"`)).rejects.toThrow(/SyntaxError/);
  });

  it("enforces memory, source, and output limits", async () => {
    await expect(runResearchJavaScript("new Array(10_000_000).fill(1)" )).rejects.toThrow(/memory/i);
    await expect(runResearchJavaScript("x".repeat(RESEARCH_SCRATCHPAD_MAX_CODE_CHARS + 1))).rejects.toThrow(/character limit/);

    const largeResult = await runResearchJavaScript(`"x".repeat(70_000)`);
    expect(largeResult.truncated).toBe(true);
    expect(largeResult.result).toMatchObject({ note: expect.stringContaining("truncated") });
  });

  it("is exposed to Research as the standard JavaScript scratchpad tool", async () => {
    const tool = researchProjectFileTools().find((item) => item.providerToolName === "archicode_scratchpad_repl");
    expect(tool).toMatchObject({
      serverId: "archicode-scratchpad",
      serverLabel: "Ephemeral Scratchpad",
      toolName: "scratchpad_repl"
    });
    expect(tool?.description).toContain("standard JavaScript");
    expect(tool?.description).toContain("separate 32,000-character limits");
    expect(tool?.description).toContain("10-second limit");
    expect(tool?.description).not.toContain("64 MiB");
    expect(tool?.description).not.toContain("2 MiB");
    expect(tool?.description).not.toContain("expression language");
    expect(isResearchProjectFileTool("archicode_scratchpad_repl")).toBe(true);

    const called = await callResearchProjectFileTool("/unused/project/root", {
      providerToolName: "archicode_scratchpad_repl",
      argumentsJson: JSON.stringify({
        code: "const area = (radius) => Math.PI * radius ** 2; Number(area(3).toFixed(4));"
      })
    });
    expect(called.serverId).toBe("archicode-scratchpad");
    expect(called.serverLabel).toBe("Ephemeral Scratchpad");
    expect(JSON.parse(called.resultText)).toMatchObject({
      language: "JavaScript",
      engine: "QuickJS WebAssembly",
      result: 28.2743
    });
  });
});
