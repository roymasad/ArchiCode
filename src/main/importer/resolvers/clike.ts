import path from "node:path";

export type ClikeResolverContext = {
  fileSet: Set<string>;
  includeRoots: string[];
};

export type ClikeResolution =
  | { kind: "file"; relPath: string }
  | { kind: "external"; packageName: string }
  | null;

export function buildClikeResolverContext(filePaths: string[]): ClikeResolverContext {
  const fileSet = new Set(filePaths);
  const includeRoots = new Set<string>([""]);
  for (const filePath of filePaths) {
    const dir = path.posix.dirname(filePath);
    if (dir === ".") continue;
    const segments = dir.split("/");
    const includeIndex = segments.lastIndexOf("include");
    if (includeIndex !== -1) includeRoots.add(segments.slice(0, includeIndex + 1).join("/"));
    if (segments[0] === "src") includeRoots.add("src");
  }
  return { fileSet, includeRoots: [...includeRoots] };
}

export function resolveClikeInclude(context: ClikeResolverContext, fromFile: string, specifier: string): ClikeResolution {
  const spec = specifier.trim();
  if (!spec) return null;
  if (spec.startsWith("<")) return { kind: "external", packageName: spec.slice(1, -1) };

  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  if (context.fileSet.has(relative)) return { kind: "file", relPath: relative };
  for (const root of context.includeRoots) {
    const candidate = path.posix.normalize(root ? `${root}/${spec}` : spec);
    if (context.fileSet.has(candidate)) return { kind: "file", relPath: candidate };
  }
  return null;
}
