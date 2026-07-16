import { readFile } from "node:fs/promises";
import path from "node:path";

const PROBE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".json"];

export type JsResolution =
  | { kind: "file"; relPath: string }
  | { kind: "external"; packageName: string }
  | null;

export type JsResolverContext = {
  fileSet: Set<string>;
  baseUrl: string | null;
  pathAliases: Array<{ pattern: string; targets: string[] }>;
  workspacePackages: Map<string, string>;
  srcRoot: string | null;
};

function normalizeRelPath(candidate: string): string {
  const normalized = path.posix.normalize(candidate.replace(/\\/g, "/"));
  return normalized === "." ? "" : normalized.replace(/^\.\//, "");
}

function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
}

async function readJsonc(filePath: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(filePath, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function loadTsconfigCompilerOptions(projectRoot: string): Promise<Record<string, unknown>> {
  const root = await readJsonc(path.join(projectRoot, "tsconfig.json"));
  if (!root) return {};
  let merged: Record<string, unknown> = {};
  const extendsPath = typeof root.extends === "string" ? root.extends : null;
  if (extendsPath && (extendsPath.startsWith("./") || extendsPath.startsWith("../"))) {
    const parent = await readJsonc(path.join(projectRoot, extendsPath.endsWith(".json") ? extendsPath : `${extendsPath}.json`));
    if (parent && typeof parent.compilerOptions === "object" && parent.compilerOptions) {
      merged = { ...(parent.compilerOptions as Record<string, unknown>) };
    }
  }
  if (typeof root.compilerOptions === "object" && root.compilerOptions) {
    merged = { ...merged, ...(root.compilerOptions as Record<string, unknown>) };
  }
  return merged;
}

function expandWorkspaceGlobs(patterns: string[], directories: Set<string>): string[] {
  const matched: string[] = [];
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/$/, "");
    if (!clean.includes("*")) {
      matched.push(clean);
      continue;
    }
    const prefix = clean.slice(0, clean.indexOf("*")).replace(/\/$/, "");
    for (const dir of directories) {
      if (!dir.startsWith(`${prefix}/`)) continue;
      const rest = dir.slice(prefix.length + 1);
      if (!rest.includes("/")) matched.push(dir);
    }
  }
  return matched;
}

export async function buildJsResolverContext(projectRoot: string, filePaths: string[]): Promise<JsResolverContext> {
  const fileSet = new Set(filePaths);
  const directories = new Set<string>();
  for (const filePath of filePaths) {
    let dir = path.posix.dirname(filePath);
    while (dir && dir !== ".") {
      directories.add(dir);
      dir = path.posix.dirname(dir);
    }
  }

  const compilerOptions = await loadTsconfigCompilerOptions(projectRoot);
  const baseUrl = typeof compilerOptions.baseUrl === "string" ? normalizeRelPath(compilerOptions.baseUrl) : null;
  const pathAliases: Array<{ pattern: string; targets: string[] }> = [];
  if (typeof compilerOptions.paths === "object" && compilerOptions.paths) {
    for (const [pattern, targets] of Object.entries(compilerOptions.paths as Record<string, unknown>)) {
      if (Array.isArray(targets)) {
        pathAliases.push({ pattern, targets: targets.filter((target): target is string => typeof target === "string") });
      }
    }
  }
  pathAliases.sort((a, b) => b.pattern.length - a.pattern.length);

  const workspacePackages = new Map<string, string>();
  const rootPackage = await readJsonc(path.join(projectRoot, "package.json"));
  const workspacesField = rootPackage?.workspaces;
  const patterns = Array.isArray(workspacesField)
    ? workspacesField.filter((item): item is string => typeof item === "string")
    : workspacesField && typeof workspacesField === "object" && Array.isArray((workspacesField as Record<string, unknown>).packages)
      ? ((workspacesField as Record<string, unknown>).packages as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
  if (patterns.length) {
    const workspaceDirs = expandWorkspaceGlobs(patterns, directories);
    await Promise.all(workspaceDirs.map(async (dir) => {
      const pkg = await readJsonc(path.join(projectRoot, dir, "package.json"));
      if (pkg && typeof pkg.name === "string") workspacePackages.set(pkg.name, dir);
    }));
  }

  const srcRoot = directories.has("src") ? "src" : null;
  return { fileSet, baseUrl, pathAliases, workspacePackages, srcRoot };
}

function probeFile(fileSet: Set<string>, candidate: string): string | null {
  const clean = normalizeRelPath(candidate);
  if (!clean || clean.startsWith("..")) return null;
  if (fileSet.has(clean)) return clean;
  for (const ext of PROBE_EXTENSIONS) {
    if (fileSet.has(clean + ext)) return clean + ext;
  }
  for (const ext of PROBE_EXTENSIONS) {
    if (fileSet.has(`${clean}/index${ext}`)) return `${clean}/index${ext}`;
  }
  return null;
}

function probePackageEntry(fileSet: Set<string>, packageDir: string, subpath: string | null): string | null {
  if (subpath) return probeFile(fileSet, `${packageDir}/${subpath}`);
  return (
    probeFile(fileSet, `${packageDir}/src/index`) ??
    probeFile(fileSet, `${packageDir}/index`) ??
    (fileSet.has(`${packageDir}/package.json`) ? `${packageDir}/package.json` : null)
  );
}

function stripQueryAndExtensionAliases(specifier: string): string {
  const withoutQuery = specifier.split("?")[0];
  return withoutQuery.replace(/\.(js|mjs|cjs)$/, (match) => match);
}

export function resolveJsImport(context: JsResolverContext, fromFile: string, specifier: string): JsResolution {
  const spec = stripQueryAndExtensionAliases(specifier.trim());
  if (!spec || spec.startsWith("node:") || spec.startsWith("data:") || spec.startsWith("virtual:")) {
    return { kind: "external", packageName: spec || specifier };
  }

  if (spec.startsWith("./") || spec.startsWith("../")) {
    const base = path.posix.dirname(fromFile);
    const direct = probeFile(context.fileSet, path.posix.join(base, spec));
    if (direct) return { kind: "file", relPath: direct };
    // TS ESM style: ./foo.js in source actually points at ./foo.ts
    const jsStyle = spec.replace(/\.(js|mjs|cjs)$/, "");
    if (jsStyle !== spec) {
      const retried = probeFile(context.fileSet, path.posix.join(base, jsStyle));
      if (retried) return { kind: "file", relPath: retried };
    }
    return null;
  }

  for (const alias of context.pathAliases) {
    const starIndex = alias.pattern.indexOf("*");
    let remainder: string | null = null;
    if (starIndex === -1) {
      if (spec === alias.pattern) remainder = "";
    } else {
      const prefix = alias.pattern.slice(0, starIndex);
      if (spec.startsWith(prefix)) remainder = spec.slice(prefix.length);
    }
    if (remainder === null) continue;
    for (const target of alias.targets) {
      const substituted = target.includes("*") ? target.replace("*", remainder) : target;
      const baseDir = context.baseUrl ?? "";
      const resolved = probeFile(context.fileSet, path.posix.join(baseDir, substituted));
      if (resolved) return { kind: "file", relPath: resolved };
    }
  }

  if (spec.startsWith("@/") || spec.startsWith("~/")) {
    const root = context.srcRoot ?? "";
    const resolved = probeFile(context.fileSet, path.posix.join(root, spec.slice(2)));
    if (resolved) return { kind: "file", relPath: resolved };
    return null;
  }

  const packageName = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0];
  const workspaceDir = context.workspacePackages.get(packageName);
  if (workspaceDir) {
    const subpath = spec.length > packageName.length ? spec.slice(packageName.length + 1) : null;
    const resolved = probePackageEntry(context.fileSet, workspaceDir, subpath);
    if (resolved) return { kind: "file", relPath: resolved };
    return null;
  }

  if (context.baseUrl) {
    const resolved = probeFile(context.fileSet, path.posix.join(context.baseUrl, spec));
    if (resolved) return { kind: "file", relPath: resolved };
  }

  return { kind: "external", packageName };
}
