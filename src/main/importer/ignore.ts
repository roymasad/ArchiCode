import { readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

export const IMPORT_IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".archicode",
  "node_modules",
  "vendor",
  "out",
  "release",
  "dist",
  "build",
  "target",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".vite",
  ".next",
  ".nuxt",
  ".turbo",
  ".idea",
  ".vscode",
  "bin",
  "obj",
  "deriveddata",
  "pods",
  "bower_components",
  "jspm_packages",
  ".pnpm-store",
  ".yarn",
  ".npm",
  ".bun",
  ".parcel-cache",
  ".webpack",
  ".rollup.cache",
  ".svelte-kit",
  ".angular",
  ".output",
  ".vercel",
  ".serverless",
  ".firebase",
  ".expo",
  "storybook-static",
  ".docusaurus",
  ".gradle",
  ".m2",
  ".ivy2",
  ".build",
  ".swiftpm",
  "carthage",
  "testresults",
  "artifacts",
  ".artifacts",
  ".tox",
  ".nox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".hypothesis",
  ".eggs",
  "site-packages",
  "__pypackages__",
  ".bundle",
  "_build",
  "deps",
  "ebin",
  ".stack-work",
  "dist-newstyle",
  ".bloop",
  ".metals",
  ".scala-build",
  ".dart_tool",
  ".pub-cache",
  ".cxx",
  ".externalnativebuild",
  "library",
  "intermediate",
  "binaries",
  "deriveddatacache",
  "saved",
  "usersettings",
  "memorycaptures",
  ".godot",
  ".import",
  ".nyc_output",
  "htmlcov",
  "tmp",
  "temp",
  "logs",
  "generated",
  "__generated__"
]);

const IMPORT_IGNORE_DIR_PATTERNS = [
  /^cmake-build-/i,
  /^bazel-(bin|out|testlogs|genfiles|.+)$/i,
  /^\.?cache-/i,
  /\.(xcodeproj|xcworkspace)$/i,
  /^xcuserdata$/i
];

export function isImportIgnoredDirectory(name: string): boolean {
  const normalized = name.toLowerCase();
  return IMPORT_IGNORE_DIRS.has(normalized) || IMPORT_IGNORE_DIR_PATTERNS.some((pattern) => pattern.test(name));
}

export type IgnoreLayer = {
  baseRelPath: string;
  matcher: Ignore;
};

export async function loadIgnoreLayer(projectRoot: string, dirRelPath: string): Promise<IgnoreLayer | null> {
  const gitignorePath = path.join(projectRoot, dirRelPath, ".gitignore");
  const text = await readFile(gitignorePath, "utf8").catch(() => null);
  if (text === null) return null;
  const matcher = ignore();
  matcher.add(text);
  return { baseRelPath: dirRelPath, matcher };
}

export function isIgnoredPath(layers: IgnoreLayer[], relPath: string, isDirectory: boolean): boolean {
  const probe = isDirectory ? `${relPath}/` : relPath;
  for (const layer of layers) {
    const base = layer.baseRelPath ? `${layer.baseRelPath}/` : "";
    if (base && !probe.startsWith(base)) continue;
    const scoped = probe.slice(base.length);
    if (!scoped) continue;
    if (layer.matcher.ignores(scoped)) return true;
  }
  return false;
}
