import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FileImport, ParsedFile, RepoScan, SupportedLanguage } from "../types";

export type GenericResolverContext = {
  projectRoot: string;
  fileSet: Set<string>;
  packageRoots: Array<{ name: string; dir: string }>;
  qualifiedToFile: Map<string, string>;
  namespaceToFile: Map<string, string>;
};

export type GenericResolution =
  | { kind: "file"; relPath: string }
  | { kind: "external"; packageName: string }
  | null;

const SOURCE_EXTENSIONS: Partial<Record<SupportedLanguage, string[]>> = {
  dart: [".dart"],
  java: [".java"],
  kotlin: [".kt", ".kts"],
  swift: [".swift"],
  ruby: [".rb"],
  scala: [".scala", ".sc"],
  lua: [".lua"],
  elixir: [".ex", ".exs"],
  solidity: [".sol"],
  zig: [".zig"],
  bash: [".sh", ".bash", ".zsh"]
};

function clean(candidate: string): string {
  return path.posix.normalize(candidate.replace(/\\/g, "/")).replace(/^\.\//, "");
}

function probe(context: GenericResolverContext, candidate: string, language: SupportedLanguage): string | null {
  const normalized = clean(candidate);
  if (!normalized || normalized.startsWith("..")) return null;
  if (context.fileSet.has(normalized)) return normalized;
  for (const extension of SOURCE_EXTENSIONS[language] ?? []) {
    if (context.fileSet.has(`${normalized}${extension}`)) return `${normalized}${extension}`;
  }
  for (const basename of ["index", "init", "mod"]) {
    for (const extension of SOURCE_EXTENSIONS[language] ?? []) {
      if (context.fileSet.has(`${normalized}/${basename}${extension}`)) return `${normalized}/${basename}${extension}`;
    }
  }
  return null;
}

export async function buildGenericResolverContext(projectRoot: string, scan: RepoScan, parsed: ParsedFile[]): Promise<GenericResolverContext> {
  const packageRoots: GenericResolverContext["packageRoots"] = [];
  const pubspecs = scan.files.filter((file) => path.posix.basename(file.relPath) === "pubspec.yaml");
  await Promise.all(pubspecs.map(async (file) => {
    const text = await readFile(path.join(projectRoot, file.relPath), "utf8").catch(() => null);
    const name = text?.match(/^name:\s*([A-Za-z0-9_-]+)/m)?.[1];
    if (name) {
      const dir = path.posix.dirname(file.relPath);
      packageRoots.push({ name, dir: dir === "." ? "" : dir });
    }
  }));

  const qualifiedToFile = new Map<string, string>();
  const namespaceToFile = new Map<string, string>();
  for (const file of [...parsed].sort((left, right) => left.relPath.localeCompare(right.relPath))) {
    for (const namespace of file.declaredNamespaces) {
      if (!namespaceToFile.has(namespace)) namespaceToFile.set(namespace, file.relPath);
      for (const symbol of file.symbols) {
        const qualified = `${namespace}.${symbol}`;
        if (!qualifiedToFile.has(qualified)) qualifiedToFile.set(qualified, file.relPath);
      }
    }
  }
  return { projectRoot, fileSet: new Set(scan.files.map((file) => file.relPath)), packageRoots, qualifiedToFile, namespaceToFile };
}

function resolveNamespace(context: GenericResolverContext, fromFile: string, specifier: string): GenericResolution {
  const normalized = specifier.replace(/\._$|\.\*$|\.[*]$/, "").replace(/\{.*$/, "").replace(/\.$/, "");
  let candidate = normalized;
  while (candidate) {
    const exact = context.qualifiedToFile.get(candidate) ?? context.namespaceToFile.get(candidate);
    if (exact && exact !== fromFile) return { kind: "file", relPath: exact };
    const dot = candidate.lastIndexOf(".");
    if (dot === -1) break;
    candidate = candidate.slice(0, dot);
  }
  return { kind: "external", packageName: normalized.split(".")[0] || specifier };
}

function resolveDart(context: GenericResolverContext, fromFile: string, specifier: string): GenericResolution {
  if (specifier.startsWith("dart:")) return { kind: "external", packageName: specifier };
  if (specifier.startsWith("package:")) {
    const packagePath = specifier.slice("package:".length);
    const slash = packagePath.indexOf("/");
    const packageName = slash === -1 ? packagePath : packagePath.slice(0, slash);
    const rest = slash === -1 ? "" : packagePath.slice(slash + 1);
    const root = context.packageRoots.find((item) => item.name === packageName);
    if (!root) return { kind: "external", packageName };
    const resolved = probe(context, path.posix.join(root.dir, "lib", rest), "dart");
    return resolved ? { kind: "file", relPath: resolved } : null;
  }
  const resolved = probe(context, path.posix.join(path.posix.dirname(fromFile), specifier.split("?")[0]), "dart");
  return resolved ? { kind: "file", relPath: resolved } : null;
}

function resolveRuby(context: GenericResolverContext, fromFile: string, fileImport: FileImport): GenericResolution {
  const specifier = fileImport.specifier.replace(/\.rb$/, "");
  if (fileImport.kind === "include" || specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = probe(context, path.posix.join(path.posix.dirname(fromFile), specifier), "ruby");
    return resolved ? { kind: "file", relPath: resolved } : null;
  }
  for (const root of ["", "lib", "app", "src"]) {
    const resolved = probe(context, path.posix.join(root, specifier), "ruby");
    if (resolved) return { kind: "file", relPath: resolved };
  }
  return { kind: "external", packageName: specifier.split("/")[0] };
}

function resolveLua(context: GenericResolverContext, specifier: string): GenericResolution {
  const modulePath = specifier.replace(/\./g, "/");
  for (const root of ["", "src", "lua", "lib"]) {
    const resolved = probe(context, path.posix.join(root, modulePath), "lua");
    if (resolved) return { kind: "file", relPath: resolved };
  }
  return { kind: "external", packageName: specifier.split(".")[0] };
}

function resolveRelativeSource(context: GenericResolverContext, language: SupportedLanguage, fromFile: string, specifier: string): GenericResolution {
  const resolved = probe(context, path.posix.join(path.posix.dirname(fromFile), specifier), language);
  if (resolved) return { kind: "file", relPath: resolved };
  if (language === "solidity" && !specifier.startsWith(".") && !specifier.startsWith("/")) {
    return { kind: "external", packageName: specifier.split("/")[0] };
  }
  return null;
}

export function resolveGenericImport(
  context: GenericResolverContext,
  language: SupportedLanguage,
  fromFile: string,
  fileImport: FileImport
): GenericResolution {
  const specifier = fileImport.specifier.trim();
  if (!specifier) return null;
  if (language === "dart") return resolveDart(context, fromFile, specifier);
  if (language === "ruby") return resolveRuby(context, fromFile, fileImport);
  if (language === "lua") return resolveLua(context, specifier);
  if (language === "solidity") return resolveRelativeSource(context, language, fromFile, specifier);
  if (language === "zig") {
    if (!specifier.endsWith(".zig")) return { kind: "external", packageName: specifier };
    return resolveRelativeSource(context, language, fromFile, specifier);
  }
  if (language === "bash") return resolveRelativeSource(context, language, fromFile, specifier);
  if (language === "java" || language === "kotlin" || language === "scala" || language === "elixir") {
    return resolveNamespace(context, fromFile, specifier);
  }
  if (language === "swift") return { kind: "external", packageName: specifier.split(".")[0] };
  return null;
}
