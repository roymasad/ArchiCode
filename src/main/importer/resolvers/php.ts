import { readFile } from "node:fs/promises";
import path from "node:path";

export type PhpResolverContext = {
  fileSet: Set<string>;
  psr4: Array<{ prefix: string; dir: string }>;
};

export type PhpResolution =
  | { kind: "file"; relPath: string }
  | { kind: "external"; packageName: string }
  | null;

export async function buildPhpResolverContext(projectRoot: string, filePaths: string[]): Promise<PhpResolverContext> {
  const fileSet = new Set(filePaths);
  const psr4: Array<{ prefix: string; dir: string }> = [];
  const composerText = await readFile(path.join(projectRoot, "composer.json"), "utf8").catch(() => null);
  if (composerText) {
    try {
      const composer = JSON.parse(composerText) as Record<string, unknown>;
      for (const section of ["autoload", "autoload-dev"]) {
        const autoload = composer[section] as Record<string, unknown> | undefined;
        for (const key of ["psr-4", "psr-0"]) {
          const mapping = autoload?.[key] as Record<string, unknown> | undefined;
          if (!mapping) continue;
          for (const [prefix, dir] of Object.entries(mapping)) {
            const target = Array.isArray(dir) ? dir[0] : dir;
            if (typeof target !== "string") continue;
            psr4.push({ prefix: prefix.replace(/\\+$/, ""), dir: target.replace(/\/+$/, "") });
          }
        }
      }
    } catch {
      // composer.json unreadable: fall back to convention roots below.
    }
  }
  psr4.sort((a, b) => b.prefix.length - a.prefix.length);
  return { fileSet, psr4 };
}

function probePhpNamespace(fileSet: Set<string>, baseDir: string, namespaceRest: string): string | null {
  const segments = namespaceRest.split("\\").filter(Boolean);
  for (let take = segments.length; take >= 1; take -= 1) {
    const candidate = path.posix.join(baseDir, ...segments.slice(0, take)) + ".php";
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

export function resolvePhpImport(context: PhpResolverContext, fromFile: string, specifier: string, kind: string): PhpResolution {
  const spec = specifier.trim();
  if (!spec) return null;

  if (kind === "require") {
    const cleaned = spec.replace(/^\/+/, "");
    const relative = path.posix.join(path.posix.dirname(fromFile), cleaned);
    if (context.fileSet.has(relative)) return { kind: "file", relPath: relative };
    if (context.fileSet.has(cleaned)) return { kind: "file", relPath: cleaned };
    return null;
  }

  const namespacePath = spec.replace(/^\\/, "");
  for (const entry of context.psr4) {
    if (entry.prefix && !namespacePath.startsWith(`${entry.prefix}\\`) && namespacePath !== entry.prefix) continue;
    const rest = entry.prefix ? namespacePath.slice(entry.prefix.length).replace(/^\\/, "") : namespacePath;
    const resolved = probePhpNamespace(context.fileSet, entry.dir, rest || namespacePath.split("\\").pop() || "");
    if (resolved) return { kind: "file", relPath: resolved };
  }
  for (const root of ["", "src", "app", "lib"]) {
    const resolved = probePhpNamespace(context.fileSet, root, namespacePath);
    if (resolved) return { kind: "file", relPath: resolved };
  }
  return { kind: "external", packageName: namespacePath.split("\\")[0] };
}
