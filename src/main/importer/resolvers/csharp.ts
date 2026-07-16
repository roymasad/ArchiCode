import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FileEdge, ParsedFile } from "../types";

export type CsharpResolverContext = {
  namespaceToFile: Map<string, string>;
  namespacePrefixes: string[];
  projectReferenceEdges: FileEdge[];
};

export type CsharpResolution =
  | { kind: "file"; relPath: string }
  | { kind: "external"; packageName: string }
  | null;

const EXTERNAL_NAMESPACE_ROOTS = new Set(["System", "Microsoft", "Windows", "Newtonsoft", "NUnit", "Xunit", "Moq"]);

export async function buildCsharpResolverContext(
  projectRoot: string,
  filePaths: string[],
  parsed: ParsedFile[]
): Promise<CsharpResolverContext> {
  const namespaceToFile = new Map<string, string>();
  for (const file of [...parsed].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    if (file.language !== "c_sharp") continue;
    for (const namespace of file.declaredNamespaces) {
      if (!namespaceToFile.has(namespace)) namespaceToFile.set(namespace, file.relPath);
    }
  }

  const projectReferenceEdges: FileEdge[] = [];
  const csprojFiles = filePaths.filter((filePath) => filePath.endsWith(".csproj"));
  const csprojSet = new Set(csprojFiles);
  await Promise.all(csprojFiles.map(async (csproj) => {
    const text = await readFile(path.join(projectRoot, csproj), "utf8").catch(() => null);
    if (!text) return;
    for (const match of text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(csproj), match[1].replace(/\\/g, "/")));
      if (csprojSet.has(target)) projectReferenceEdges.push({ from: csproj, to: target });
    }
  }));

  return {
    namespaceToFile,
    namespacePrefixes: [...namespaceToFile.keys()].sort((a, b) => b.length - a.length),
    projectReferenceEdges
  };
}

export function resolveCsharpUsing(context: CsharpResolverContext, fromFile: string, specifier: string): CsharpResolution {
  const spec = specifier.trim();
  if (!spec) return null;

  const exact = context.namespaceToFile.get(spec);
  if (exact && exact !== fromFile) return { kind: "file", relPath: exact };
  // A using of a parent namespace maps to the first file in the deepest matching child namespace.
  for (const declared of context.namespacePrefixes) {
    if (declared.startsWith(`${spec}.`) || spec.startsWith(`${declared}.`)) {
      const file = context.namespaceToFile.get(declared);
      if (file && file !== fromFile) return { kind: "file", relPath: file };
    }
  }
  if (EXTERNAL_NAMESPACE_ROOTS.has(spec.split(".")[0])) return { kind: "external", packageName: spec.split(".")[0] };
  return { kind: "external", packageName: spec.split(".")[0] };
}
