import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { SupportedLanguage } from "./types";

const require = createRequire(import.meta.url);

let initialized: Promise<void> | null = null;
const languageCache = new Map<SupportedLanguage, Promise<Language>>();

async function grammarBytes(language: SupportedLanguage): Promise<Buffer> {
  const filename = `tree-sitter-${language}.wasm`;
  if (language === "dart" || language === "zig") {
    const candidates = [
      typeof process.resourcesPath === "string" ? path.join(process.resourcesPath, "tree-sitter-wasms", filename) : null,
      path.join(process.cwd(), "resources", "tree-sitter-wasms", filename)
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      const bytes = await readFile(candidate).catch(() => null);
      if (bytes) return bytes;
    }
    throw new Error(`Bundled grammar unavailable: ${filename}`);
  }
  return readFile(require.resolve(`tree-sitter-wasms/out/${filename}`));
}

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    initialized = Parser.init({
      locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm")
    });
  }
  await initialized;
}

export async function loadLanguage(language: SupportedLanguage): Promise<Language> {
  await ensureInitialized();
  let cached = languageCache.get(language);
  if (!cached) {
    cached = (async () => {
      const bytes = await grammarBytes(language);
      return Language.load(bytes);
    })();
    languageCache.set(language, cached);
  }
  return cached;
}

export async function createParserFor(language: SupportedLanguage): Promise<Parser> {
  const grammar = await loadLanguage(language);
  const parser = new Parser();
  parser.setLanguage(grammar);
  return parser;
}

/** Verifies the web-tree-sitter runtime and one grammar load; used to fail soft to heuristics. */
export async function treeSitterAvailable(): Promise<boolean> {
  try {
    await loadLanguage("javascript");
    return true;
  } catch {
    return false;
  }
}
