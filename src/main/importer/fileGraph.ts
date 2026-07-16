import { CodebaseImportCancelledError, type FileDependencyGraph, type FileEdge, type FileImport, type ParsedFile, type RepoScan, type SupportedLanguage } from "./types";
import { buildJsResolverContext, resolveJsImport } from "./resolvers/js";
import { buildPythonResolverContext, resolvePythonImport } from "./resolvers/python";
import { buildGoResolverContext, resolveGoImport } from "./resolvers/go";
import { buildRustResolverContext, resolveRustImport } from "./resolvers/rust";
import { buildPhpResolverContext, resolvePhpImport } from "./resolvers/php";
import { buildClikeResolverContext, resolveClikeInclude } from "./resolvers/clike";
import { buildCsharpResolverContext, resolveCsharpUsing, type CsharpResolverContext } from "./resolvers/csharp";
import { buildGenericResolverContext, resolveGenericImport, type GenericResolverContext } from "./resolvers/generic";

export type ImportResolution =
  | { kind: "file"; relPath: string }
  | { kind: "external"; packageName: string }
  | null;

type LanguageResolver = {
  languages: SupportedLanguage[];
  prepare: (projectRoot: string, scan: RepoScan, parsed: ParsedFile[]) => Promise<unknown> | unknown;
  resolve: (context: unknown, fromFile: string, fileImport: FileImport) => ImportResolution;
  extraEdges?: (context: unknown) => FileEdge[];
};

const RESOLVERS: LanguageResolver[] = [
  {
    languages: ["javascript", "typescript", "tsx", "vue"],
    prepare: (projectRoot, scan) => buildJsResolverContext(projectRoot, scan.files.map((file) => file.relPath)),
    resolve: (context, fromFile, fileImport) =>
      resolveJsImport(context as Awaited<ReturnType<typeof buildJsResolverContext>>, fromFile, fileImport.specifier)
  },
  {
    languages: ["python"],
    prepare: (_projectRoot, scan) => buildPythonResolverContext(scan.files.map((file) => file.relPath)),
    resolve: (context, fromFile, fileImport) =>
      resolvePythonImport(context as ReturnType<typeof buildPythonResolverContext>, fromFile, fileImport.specifier)
  },
  {
    languages: ["go"],
    prepare: (projectRoot, scan) => buildGoResolverContext(projectRoot, scan.files.map((file) => file.relPath)),
    resolve: (context, _fromFile, fileImport) =>
      resolveGoImport(context as Awaited<ReturnType<typeof buildGoResolverContext>>, fileImport.specifier)
  },
  {
    languages: ["rust"],
    prepare: (projectRoot, scan) => buildRustResolverContext(projectRoot, scan.files.map((file) => file.relPath)),
    resolve: (context, fromFile, fileImport) =>
      resolveRustImport(context as Awaited<ReturnType<typeof buildRustResolverContext>>, fromFile, fileImport.specifier, fileImport.kind)
  },
  {
    languages: ["php"],
    prepare: (projectRoot, scan) => buildPhpResolverContext(projectRoot, scan.files.map((file) => file.relPath)),
    resolve: (context, fromFile, fileImport) =>
      resolvePhpImport(context as Awaited<ReturnType<typeof buildPhpResolverContext>>, fromFile, fileImport.specifier, fileImport.kind)
  },
  {
    languages: ["c", "cpp", "objc"],
    prepare: (_projectRoot, scan) => buildClikeResolverContext(scan.files.map((file) => file.relPath)),
    resolve: (context, fromFile, fileImport) =>
      resolveClikeInclude(context as ReturnType<typeof buildClikeResolverContext>, fromFile, fileImport.specifier)
  },
  {
    languages: ["c_sharp"],
    prepare: (projectRoot, scan, parsed) => buildCsharpResolverContext(projectRoot, scan.files.map((file) => file.relPath), parsed),
    resolve: (context, fromFile, fileImport) =>
      resolveCsharpUsing(context as CsharpResolverContext, fromFile, fileImport.specifier),
    extraEdges: (context) => (context as CsharpResolverContext).projectReferenceEdges
  },
  {
    languages: ["dart", "java", "kotlin", "swift", "ruby", "scala", "lua", "elixir", "solidity", "zig", "bash"],
    prepare: (projectRoot, scan, parsed) => buildGenericResolverContext(projectRoot, scan, parsed),
    resolve: (context, fromFile, fileImport) => {
      // Each file is routed here only for one of the configured generic languages.
      return resolveGenericImport(context as GenericResolverContext, pathLanguage(fromFile), fromFile, fileImport);
    }
  }
];

function pathLanguage(file: string): SupportedLanguage {
  const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
  if (extension === ".dart") return "dart";
  if (extension === ".java") return "java";
  if (extension === ".kt" || extension === ".kts") return "kotlin";
  if (extension === ".swift") return "swift";
  if (extension === ".rb" || extension === ".rake") return "ruby";
  if (extension === ".scala" || extension === ".sc") return "scala";
  if (extension === ".lua") return "lua";
  if (extension === ".sol") return "solidity";
  if (extension === ".zig") return "zig";
  if (extension === ".sh" || extension === ".bash" || extension === ".zsh") return "bash";
  return "elixir";
}

export async function buildFileDependencyGraph(
  projectRoot: string,
  scan: RepoScan,
  parsed: ParsedFile[],
  options: { onProgress?: (done: number, total: number) => void; shouldCancel?: () => boolean } = {}
): Promise<FileDependencyGraph> {
  const resolverByLanguage = new Map<SupportedLanguage, { resolver: LanguageResolver; context: unknown }>();
  const activeLanguages = new Set(parsed.map((file) => file.language));
  const activeResolvers = RESOLVERS.filter((resolver) => resolver.languages.some((language) => activeLanguages.has(language)));
  const preparedContexts = await Promise.all(activeResolvers.map(async (resolver) => ({
    resolver,
    context: await resolver.prepare(projectRoot, scan, parsed)
  })));
  for (const { resolver, context } of preparedContexts) {
    for (const language of resolver.languages) {
      resolverByLanguage.set(language, { resolver, context });
    }
  }

  const edgeByKey = new Map<string, FileEdge>();
  const edges: FileDependencyGraph["edges"] = [];
  const externalsByFile = new Map<string, string[]>();
  const unresolved: FileDependencyGraph["unresolved"] = [];
  let resolvedInternal = 0;
  let done = 0;

  const addEdge = (from: string, to: string, fileImport?: FileImport): void => {
    if (from === to) return;
    const key = `${from} ${to}`;
    const existing = edgeByKey.get(key);
    if (existing) {
      existing.occurrences = (existing.occurrences ?? 1) + 1;
      if (fileImport && !existing.kinds?.includes(fileImport.kind)) existing.kinds?.push(fileImport.kind);
      if (fileImport) existing.importedNames = [...new Set([...(existing.importedNames ?? []), ...(fileImport.importedNames ?? [])])].slice(0, 30);
      if (fileImport && (existing.evidence?.length ?? 0) < 6) existing.evidence?.push({ line: fileImport.line, specifier: fileImport.specifier });
      return;
    }
    const edge: FileEdge = {
      from,
      to,
      kinds: fileImport ? [fileImport.kind] : [],
      importedNames: fileImport?.importedNames ?? [],
      evidence: fileImport ? [{ line: fileImport.line, specifier: fileImport.specifier }] : [],
      occurrences: 1,
      confidence: fileImport ? 1 : 0.95,
      relationKinds: fileImport
        ? [
            fileImport.kind === "dynamic" ? "runtime-load"
              : fileImport.kind === "reexport" ? "reexports"
                : fileImport.typeOnly ? "type-only"
                  : "dependency"
          ]
        : ["project-reference"]
    };
    edgeByKey.set(key, edge);
    edges.push(edge);
  };

  for (const file of parsed) {
    if (options.shouldCancel?.()) throw new CodebaseImportCancelledError();
    const entry = resolverByLanguage.get(file.language);
    done += 1;
    if (!entry) continue;
    for (const fileImport of file.imports) {
      const resolution = entry.resolver.resolve(entry.context, file.relPath, fileImport);
      if (!resolution) {
        unresolved.push({ from: file.relPath, specifier: fileImport.specifier });
        continue;
      }
      if (resolution.kind === "external") {
        const list = externalsByFile.get(file.relPath) ?? [];
        if (!list.includes(resolution.packageName)) list.push(resolution.packageName);
        externalsByFile.set(file.relPath, list);
        continue;
      }
      resolvedInternal += 1;
      addEdge(file.relPath, resolution.relPath, fileImport);
      const edge = edgeByKey.get(`${file.relPath} ${resolution.relPath}`);
      if (edge && !fileImport.typeOnly) {
        const callSites = file.callSites ?? [];
        const matchedCallEvidence = fileImport.bindings?.length
          ? fileImport.bindings.flatMap((binding) => callSites.flatMap((site) => {
            const matches = binding.namespace ? site.receiver === binding.local : !site.receiver && site.callee === binding.local;
            if (!matches) return [];
            return [{
              site,
              importedName: binding.namespace ? site.callee : binding.imported === "default" ? site.callee : binding.imported,
              localName: site.receiver ? `${site.receiver}.${site.callee}` : site.callee
            }];
          }))
          : callSites.filter((site) => !site.receiver && fileImport.importedNames?.includes(site.callee)).map((site) => ({ site, importedName: site.callee, localName: site.callee }));
        const matchedCalls = matchedCallEvidence.map((item) => item.site);
        if (matchedCalls.length && !edge.relationKinds?.includes("calls")) edge.relationKinds?.push("calls");
        edge.evidence ??= [];
        edge.callEvidence ??= [];
        for (const match of matchedCallEvidence) {
          const call = match.site;
          if (edge.evidence.length >= 10) break;
          const fact = `${call.kind === "construct" ? "constructs" : "calls"}:${call.receiver ? `${call.receiver}.` : ""}${call.callee}`;
          if (!edge.evidence.some((item) => item.line === call.line && item.specifier === fact)) edge.evidence.push({ line: call.line, specifier: fact });
          if (!edge.callEvidence.some((item) => item.line === call.line && item.importedName === match.importedName && item.localName === match.localName)) {
            edge.callEvidence.push({ line: call.line, importedName: match.importedName, localName: match.localName, kind: call.kind });
          }
        }
      }
    }
    if (done % 500 === 0) options.onProgress?.(done, parsed.length);
  }

  for (const { resolver, context } of preparedContexts) {
    for (const edge of resolver.extraEdges?.(context) ?? []) {
      addEdge(edge.from, edge.to);
    }
  }

  const attempted = resolvedInternal + unresolved.length;
  return {
    edges,
    externalsByFile,
    unresolved,
    resolutionRate: attempted ? resolvedInternal / attempted : 1,
    relationsAttempted: attempted
  };
}
