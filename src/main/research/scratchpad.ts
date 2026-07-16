import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule
} from "quickjs-emscripten-core";

export const RESEARCH_SCRATCHPAD_MAX_CODE_CHARS = 32_000;
export const RESEARCH_SCRATCHPAD_TIMEOUT_MS = 10_000;
export const RESEARCH_SCRATCHPAD_MEMORY_BYTES = 64 * 1024 * 1024;
export const RESEARCH_SCRATCHPAD_STACK_BYTES = 2 * 1024 * 1024;
export const RESEARCH_SCRATCHPAD_MAX_OUTPUT_CHARS = 32_000;
export const RESEARCH_SCRATCHPAD_MAX_CONSOLE_CHARS = 32_000;

export type ResearchJavaScriptResult = {
  language: "JavaScript";
  engine: "QuickJS WebAssembly";
  resultType: string;
  result: unknown;
  console: Array<{ level: "debug" | "info" | "log" | "warn" | "error"; text: string }>;
  truncated: boolean;
  limits: {
    timeoutMs: number;
    memoryBytes: number;
    stackBytes: number;
    maxCodeChars: number;
    maxOutputChars: number;
    maxConsoleChars: number;
  };
  note: string;
};

let quickJsModulePromise: Promise<QuickJSWASMModule> | undefined;

function quickJsModule(): Promise<QuickJSWASMModule> {
  quickJsModulePromise ??= newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
  return quickJsModulePromise;
}

const CONSOLE_SETUP = `
(() => {
  const entries = [];
  let totalChars = 0;
  const maxEntries = 100;
  const maxEntryChars = 2_000;
  const maxTotalChars = ${RESEARCH_SCRATCHPAD_MAX_CONSOLE_CHARS};
  const JsonStringify = JSON.stringify;
  const ValueString = String;
  const WeakSetValue = WeakSet;
  const arrayMap = Function.call.bind(Array.prototype.map);
  const arrayJoin = Function.call.bind(Array.prototype.join);
  const format = (value) => {
    if (typeof value === "string") return value;
    if (typeof value === "bigint") return ValueString(value) + "n";
    if (typeof value === "undefined") return "undefined";
    if (typeof value === "function" || typeof value === "symbol") return ValueString(value);
    try {
      const seen = new WeakSetValue();
      const json = JsonStringify(value, (_key, item) => {
        if (typeof item === "bigint") return ValueString(item) + "n";
        if (typeof item === "function" || typeof item === "symbol") return ValueString(item);
        if (item && typeof item === "object") {
          if (seen.has(item)) return "[Circular]";
          seen.add(item);
        }
        return item;
      });
      return json === undefined ? ValueString(value) : json;
    } catch (error) {
      try { return ValueString(value); } catch { return "[Unprintable]"; }
    }
  };
  const write = (level, args) => {
    if (entries.length >= maxEntries || totalChars >= maxTotalChars) return;
    let text = arrayJoin(arrayMap(args, format), " ").slice(0, maxEntryChars);
    text = text.slice(0, Math.max(0, maxTotalChars - totalChars));
    totalChars += text.length;
    entries.push(Object.freeze({ level, text }));
  };
  const consoleValue = Object.freeze({
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    log: (...args) => write("log", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args)
  });
  Object.defineProperty(globalThis, "console", {
    value: consoleValue,
    configurable: false,
    enumerable: false,
    writable: false
  });
  Object.defineProperty(globalThis, "__archicodeReadConsole", {
    value: () => {
      const copy = [];
      for (let index = 0; index < entries.length; index += 1) {
        copy[index] = { level: entries[index].level, text: entries[index].text };
      }
      return copy;
    },
    configurable: false,
    enumerable: false,
    writable: false
  });
})();
`;

function quickJsError(value: unknown): Error {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "JavaScriptError";
    const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
    const stack = typeof record.stack === "string" ? record.stack : "";
    const error = new Error(`${name}: ${message}`);
    if (stack) error.stack = stack;
    return error;
  }
  return new Error(`JavaScriptError: ${String(value)}`);
}

function dumpAndDispose(context: QuickJSContext, handle: QuickJSHandle): unknown {
  try {
    return context.dump(handle);
  } finally {
    handle.dispose();
  }
}

function jsonSafe(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return value;
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 20) return "[Max depth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => jsonSafe(item, seen, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 1_000)) output[key] = jsonSafe(item, seen, depth + 1);
  return output;
}

function boundedResult(value: unknown): { result: unknown; truncated: boolean } {
  const safe = jsonSafe(value);
  const serialized = JSON.stringify(safe);
  if (serialized.length <= RESEARCH_SCRATCHPAD_MAX_OUTPUT_CHARS) return { result: safe, truncated: false };
  return {
    result: {
      preview: serialized.slice(0, RESEARCH_SCRATCHPAD_MAX_OUTPUT_CHARS),
      note: "Result was truncated after serialization. Return a smaller value or summarize it in JavaScript."
    },
    truncated: true
  };
}

export async function runResearchJavaScript(code: string): Promise<ResearchJavaScriptResult> {
  const source = code.trim();
  if (!source) throw new Error("JavaScript code is required.");
  if (source.length > RESEARCH_SCRATCHPAD_MAX_CODE_CHARS) {
    throw new Error(`JavaScript code exceeds the ${RESEARCH_SCRATCHPAD_MAX_CODE_CHARS.toLocaleString()} character limit.`);
  }

  const QuickJS = await quickJsModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(RESEARCH_SCRATCHPAD_MEMORY_BYTES);
  runtime.setMaxStackSize(RESEARCH_SCRATCHPAD_STACK_BYTES);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + RESEARCH_SCRATCHPAD_TIMEOUT_MS));
  const context = runtime.newContext();

  try {
    const setup = context.evalCode(CONSOLE_SETUP, "archicode-console.js", { type: "global" });
    if (setup.error) {
      throw quickJsError(dumpAndDispose(context, setup.error));
    }
    setup.value.dispose();

    const evaluation = context.evalCode(source, "archicode-scratchpad.js", { type: "global" });
    if (evaluation.error) {
      throw quickJsError(dumpAndDispose(context, evaluation.error));
    }
    const resultType = context.typeof(evaluation.value);
    const dumpedResult = dumpAndDispose(context, evaluation.value);

    const readConsole = context.getProp(context.global, "__archicodeReadConsole");
    let consoleResult: ReturnType<QuickJSContext["callFunction"]>;
    try {
      consoleResult = context.callFunction(readConsole, context.undefined);
    } finally {
      readConsole.dispose();
    }
    if (consoleResult.error) {
      throw quickJsError(dumpAndDispose(context, consoleResult.error));
    }
    const dumpedConsole = dumpAndDispose(context, consoleResult.value);
    const consoleEntries = Array.isArray(dumpedConsole)
      ? dumpedConsole.filter((entry): entry is ResearchJavaScriptResult["console"][number] =>
          Boolean(entry) && typeof entry === "object" &&
          ["debug", "info", "log", "warn", "error"].includes((entry as { level?: string }).level ?? "") &&
          typeof (entry as { text?: unknown }).text === "string")
      : [];
    const bounded = boundedResult(dumpedResult);
    return {
      language: "JavaScript",
      engine: "QuickJS WebAssembly",
      resultType,
      result: bounded.result,
      console: consoleEntries,
      truncated: bounded.truncated,
      limits: {
        timeoutMs: RESEARCH_SCRATCHPAD_TIMEOUT_MS,
        memoryBytes: RESEARCH_SCRATCHPAD_MEMORY_BYTES,
        stackBytes: RESEARCH_SCRATCHPAD_STACK_BYTES,
        maxCodeChars: RESEARCH_SCRATCHPAD_MAX_CODE_CHARS,
        maxOutputChars: RESEARCH_SCRATCHPAD_MAX_OUTPUT_CHARS,
        maxConsoleChars: RESEARCH_SCRATCHPAD_MAX_CONSOLE_CHARS
      },
      note: "Fresh isolated JavaScript runtime for this call. No project files, network APIs, Node.js globals, packages, or persistent runtime state are exposed."
    };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
