import { readFile } from "node:fs/promises";
import path from "node:path";

export type GoModule = {
  modulePath: string;
  dir: string;
};

export type GoResolverContext = {
  modules: GoModule[];
  firstGoFileByDir: Map<string, string>;
};

export type GoResolution =
  | { kind: "file"; relPath: string }
  | { kind: "external"; packageName: string }
  | null;

async function readGoModule(projectRoot: string, dir: string): Promise<GoModule | null> {
  const text = await readFile(path.join(projectRoot, dir, "go.mod"), "utf8").catch(() => null);
  if (!text) return null;
  const match = text.match(/^module\s+(\S+)/m);
  return match ? { modulePath: match[1], dir } : null;
}

export async function buildGoResolverContext(projectRoot: string, filePaths: string[]): Promise<GoResolverContext> {
  const goModDirs = filePaths
    .filter((filePath) => path.posix.basename(filePath) === "go.mod")
    .map((filePath) => path.posix.dirname(filePath))
    .map((dir) => (dir === "." ? "" : dir));
  const modules = (await Promise.all(goModDirs.map((dir) => readGoModule(projectRoot, dir))))
    .filter((module): module is GoModule => Boolean(module))
    .sort((a, b) => b.modulePath.length - a.modulePath.length);

  const firstGoFileByDir = new Map<string, string>();
  for (const filePath of [...filePaths].sort()) {
    if (!filePath.endsWith(".go") || filePath.endsWith("_test.go")) continue;
    const dir = path.posix.dirname(filePath);
    const key = dir === "." ? "" : dir;
    if (!firstGoFileByDir.has(key)) firstGoFileByDir.set(key, filePath);
  }
  return { modules, firstGoFileByDir };
}

export function resolveGoImport(context: GoResolverContext, specifier: string): GoResolution {
  const spec = specifier.trim();
  if (!spec) return null;
  for (const module of context.modules) {
    if (spec !== module.modulePath && !spec.startsWith(`${module.modulePath}/`)) continue;
    const sub = spec === module.modulePath ? "" : spec.slice(module.modulePath.length + 1);
    const dir = module.dir ? (sub ? `${module.dir}/${sub}` : module.dir) : sub;
    const file = context.firstGoFileByDir.get(dir);
    if (file) return { kind: "file", relPath: file };
    return null;
  }
  return { kind: "external", packageName: spec.split("/").slice(0, 3).join("/") };
}
