import path from "node:path";

export type PythonResolverContext = {
  fileSet: Set<string>;
  roots: string[];
};

export type PythonResolution =
  | { kind: "file"; relPath: string }
  | { kind: "external"; packageName: string }
  | null;

export function buildPythonResolverContext(filePaths: string[]): PythonResolverContext {
  const fileSet = new Set(filePaths);
  const roots = [""];
  if (filePaths.some((filePath) => filePath.startsWith("src/"))) roots.push("src");
  return { fileSet, roots };
}

function probeModule(fileSet: Set<string>, moduleBase: string): string | null {
  if (fileSet.has(`${moduleBase}.py`)) return `${moduleBase}.py`;
  if (fileSet.has(`${moduleBase}/__init__.py`)) return `${moduleBase}/__init__.py`;
  return null;
}

export function resolvePythonImport(context: PythonResolverContext, fromFile: string, specifier: string): PythonResolution {
  const spec = specifier.trim();
  if (!spec) return null;

  const relativeMatch = spec.match(/^(\.+)(.*)$/);
  if (relativeMatch) {
    const dots = relativeMatch[1].length;
    const rest = relativeMatch[2].replace(/^\./, "");
    let base = path.posix.dirname(fromFile);
    for (let hop = 1; hop < dots; hop += 1) base = path.posix.dirname(base);
    if (base === ".") base = "";
    const moduleBase = rest ? path.posix.join(base, ...rest.split(".")) : base;
    const resolved = rest ? probeModule(context.fileSet, moduleBase) : context.fileSet.has(`${base}/__init__.py`) ? `${base}/__init__.py` : null;
    if (resolved) return { kind: "file", relPath: resolved };
    // `from . import sibling` — the imported names are modules next to __init__.py.
    return null;
  }

  const segments = spec.split(".");
  for (const root of context.roots) {
    const moduleBase = path.posix.join(root, ...segments);
    const resolved = probeModule(context.fileSet, moduleBase);
    if (resolved) return { kind: "file", relPath: resolved };
    if (segments.length > 1) {
      const parentBase = path.posix.join(root, ...segments.slice(0, -1));
      const parent = probeModule(context.fileSet, parentBase);
      if (parent) return { kind: "file", relPath: parent };
    }
  }
  return { kind: "external", packageName: segments[0] };
}
