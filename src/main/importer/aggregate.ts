import path from "node:path";
import type { CodebaseMappingGranularity } from "../../shared/schema";
import type { ContentInventory } from "./inventory";
import type {
  CodebaseImportDetail,
  CodebaseImportLevels,
  FileDependencyGraph,
  ModuleCluster,
  ModuleEdge,
  ModuleGraph,
  ParsedFile,
  RepoScan
} from "./types";
import { enrichModuleGraph } from "./insights";
import { rankClusterSymbolRefs } from "./symbolRanking";

// Only plural/workspace-style roots are assumed to contain independently useful
// top-level systems. Conventional source roots (src/app/lib) stay intact so a
// mobile app or service does not explode into sibling "screens/helpers/models" systems.
const AREA_CONTAINER_DIRS = new Set(["src", "apps", "packages", "services", "tools", "cmd", "internal", "pkg"]);
const PASS_THROUGH_DIRS = new Set(["src", "lib", "app", "source"]);
const ROOT_AREA = "(root)";

const TIER_ONE_BUDGET: Record<CodebaseImportDetail, number> = { light: 8, balanced: 14, deep: 24 };
const CHILDREN_PER_PARENT: Record<CodebaseImportDetail, number> = { light: 4, balanced: 6, deep: 10 };
const GRANULARITY_FLOOR: Record<CodebaseMappingGranularity, number> = { system: 0, module: 1, component: 2, file: 3 };

export function slugForClusterPath(clusterPath: string): string {
  const slug = clusterPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `cluster-${slug || "root"}`;
}

function collisionSafeIds(paths: string[]): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Map<string, string>();
  for (const clusterPath of paths) {
    const base = slugForClusterPath(clusterPath);
    const existingPath = used.get(base);
    if (!existingPath || existingPath === clusterPath) {
      used.set(base, clusterPath);
      ids.set(clusterPath, base);
      continue;
    }
    let hash = 2166136261;
    for (const char of clusterPath) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    ids.set(clusterPath, `${base}-${(hash >>> 0).toString(36)}`);
  }
  return ids;
}

export function humanizeSegment(segment: string): string {
  const base = segment.replace(/\.[a-z0-9]+$/i, "");
  const spaced = base.replace(/[-_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (!spaced) return segment;
  return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}

type ClusterDraft = {
  path: string;
  title: string;
  unitIndex: number;
  tier: number;
  parentPath?: string;
  files: string[];
  isFileCluster: boolean;
};

function topLevelSegment(relPath: string): string {
  const slash = relPath.indexOf("/");
  return slash === -1 ? ROOT_AREA : relPath.slice(0, slash);
}

function subdirectoriesWithFiles(files: string[], basePath: string): Map<string, string[]> {
  const byChild = new Map<string, string[]>();
  const prefix = basePath === ROOT_AREA ? "" : `${basePath}/`;
  for (const file of files) {
    if (prefix && !file.startsWith(prefix)) continue;
    const rest = prefix ? file.slice(prefix.length) : file;
    const slash = rest.indexOf("/");
    if (slash === -1) continue;
    const child = `${prefix}${rest.slice(0, slash)}`;
    const list = byChild.get(child) ?? [];
    list.push(file);
    byChild.set(child, list);
  }
  return byChild;
}

function directFiles(files: string[], basePath: string): string[] {
  const prefix = basePath === ROOT_AREA ? "" : `${basePath}/`;
  return files.filter((file) => {
    if (prefix && !file.startsWith(prefix)) return false;
    const rest = prefix ? file.slice(prefix.length) : file;
    return !rest.includes("/");
  });
}

/** Split a cluster one directory level down, skipping single pass-through dirs like src/. */
function childPartitions(cluster: ClusterDraft): Array<{ path: string; files: string[] }> {
  let basePath = cluster.path;
  let files = cluster.files;
  for (let hops = 0; hops < 3; hops += 1) {
    const children = subdirectoriesWithFiles(files, basePath);
    if (children.size === 1) {
      const [childPath, childFiles] = [...children.entries()][0];
      const segment = childPath.slice(childPath.lastIndexOf("/") + 1);
      if (PASS_THROUGH_DIRS.has(segment) && directFiles(files, basePath).length === 0) {
        basePath = childPath;
        files = childFiles;
        continue;
      }
    }
    return [...children.entries()].map(([childPath, childFiles]) => ({ path: childPath, files: childFiles }));
  }
  return [];
}

function mergeOverflow(
  partitions: Array<{ path: string; files: string[] }>,
  budget: number,
  overflowPath: string,
  overflowTitle: string,
  score: (partition: { path: string; files: string[] }) => number = (partition) => partition.files.length
): Array<{ path: string; files: string[]; title?: string }> {
  if (partitions.length <= budget) return partitions;
  const sorted = [...partitions].sort((a, b) => score(b) - score(a) || b.files.length - a.files.length);
  const kept = sorted.slice(0, Math.max(1, budget - 1));
  const merged = sorted.slice(Math.max(1, budget - 1));
  const overflowFiles = merged.flatMap((partition) => partition.files);
  return [...kept, { path: overflowPath, files: overflowFiles, title: overflowTitle }];
}

function buildAreaPartitions(files: string[]): Array<{ path: string; files: string[] }> {
  const byTop = new Map<string, string[]>();
  for (const file of files) {
    const top = topLevelSegment(file);
    const list = byTop.get(top) ?? [];
    list.push(file);
    byTop.set(top, list);
  }
  const areas: Array<{ path: string; files: string[] }> = [];
  for (const [top, topFiles] of byTop) {
    if (top !== ROOT_AREA && AREA_CONTAINER_DIRS.has(top)) {
      const children = subdirectoriesWithFiles(topFiles, top);
      if (children.size > 1) {
        for (const [childPath, childFiles] of children) {
          areas.push({ path: childPath, files: childFiles });
        }
        const loose = directFiles(topFiles, top);
        if (loose.length) areas.push({ path: top, files: loose });
        continue;
      }
    }
    areas.push({ path: top, files: topFiles });
  }
  return areas;
}

export function buildModuleGraph(input: {
  scan: RepoScan;
  parsed: ParsedFile[];
  fileGraph: FileDependencyGraph;
  levels: CodebaseImportLevels;
  detail: CodebaseImportDetail;
  granularity: CodebaseMappingGranularity;
  inventory?: ContentInventory;
  semanticLinks?: Array<{ source: string; target: string; score: number }>;
}): ModuleGraph {
  const { scan, parsed, fileGraph, levels, detail, granularity } = input;
  const levelCount = Number(levels);
  const floor = GRANULARITY_FLOOR[granularity];
  const locByFile = new Map(parsed.map((file) => [file.relPath, file.loc]));
  const sizeByFile = new Map(scan.files.map((file) => [file.relPath, file.sizeBytes]));
  // Rank by lines when parsed, else by byte size — but source always beats assets/docs
  // (a 500KB image must never outrank a 5KB source file as a "key file").
  const fileRankFactor = (file: string): number => {
    const role = roleByFile.get(file);
    return role === "asset" ? 0.001 : role === "docs" ? 0.01 : roleWeight(file);
  };
  const fileWeight = (file: string): number => ((locByFile.get(file) || 0) * 1000 + (sizeByFile.get(file) ?? 0)) * fileRankFactor(file);
  const allFiles = scan.files.map((file) => file.relPath);
  const entrypoints = new Set(input.inventory?.entrypoints ?? []);
  const roleByFile = new Map(scan.files.map((file) => [file.relPath, file.role ?? "production"] as const));
  const dependencyDegree = new Map<string, number>();
  for (const edge of fileGraph.edges) {
    const weight = edge.occurrences ?? 1;
    dependencyDegree.set(edge.from, (dependencyDegree.get(edge.from) ?? 0) + weight);
    dependencyDegree.set(edge.to, (dependencyDegree.get(edge.to) ?? 0) + weight);
  }
  const semanticDegree = new Map<string, number>();
  for (const link of input.semanticLinks ?? []) {
    semanticDegree.set(link.source, (semanticDegree.get(link.source) ?? 0) + link.score);
    semanticDegree.set(link.target, (semanticDegree.get(link.target) ?? 0) + link.score);
  }
  const roleWeight = (file: string): number => {
    const role = roleByFile.get(file);
    return role === "production" ? 10 : role === "migration" ? 8 : role === "config" ? 0.5 : role === "test" ? 0.05 : 0.01;
  };
  // Entrypoints anchor the architecture: a partition holding one (e.g. a lone main.dart)
  // must decisively survive overflow merging instead of vanishing into "Support & Scripts".
  const partitionScore = (partition: { files: string[] }): number => partition.files.reduce(
    (sum, file) => sum + roleWeight(file) + (dependencyDegree.get(file) ?? 0) + (semanticDegree.get(file) ?? 0) * 3 + (entrypoints.has(file) ? 500 : 0),
    0
  ) * (partition.files.length && partition.files.every((file) => file.startsWith(".")) ? 0.05 : 1);

  const clusters: ClusterDraft[] = [];
  const tierOnePartitions = mergeOverflow(
    buildAreaPartitions(allFiles).sort((a, b) => partitionScore(b) - partitionScore(a)),
    TIER_ONE_BUDGET[detail],
    "(support)",
    "Support & Scripts",
    partitionScore
  );
  for (const partition of tierOnePartitions) {
    clusters.push({
      path: partition.path,
      title: (partition as { title?: string }).title ?? humanizeSegment(partition.path === ROOT_AREA ? "Project Root" : partition.path.split("/").pop() ?? partition.path),
      unitIndex: 0,
      tier: 1,
      files: partition.files,
      isFileCluster: false
    });
  }

  let frontier = clusters.filter((cluster) => cluster.tier === 1);
  for (let tier = 2; tier <= levelCount; tier += 1) {
    const nextFrontier: ClusterDraft[] = [];
    for (const parent of frontier) {
      if (parent.unitIndex >= floor || parent.isFileCluster) continue;
      if (parent.path === "(support)" || parent.path === ROOT_AREA) continue;
      const isFinalTier = tier === levelCount;
      const targetUnitIndex = Math.min(parent.unitIndex + 1, floor);
      const expandToFiles = isFinalTier && granularity === "file";

      let partitions: Array<{ path: string; files: string[]; title?: string }>;
      let partitionedIntoFiles = expandToFiles;
      if (expandToFiles) {
        partitions = parent.files.map((file) => ({ path: file, files: [file] }));
      } else {
        partitions = childPartitions(parent);
        // Flat directories are not a dead end: at component granularity and finer,
        // the files of a flat module ARE its components.
        if (!partitions.length && floor >= 2 && parent.files.length >= 2) {
          partitions = parent.files.map((file) => ({ path: file, files: [file] }));
          partitionedIntoFiles = true;
        }
      }
      if (!partitions.length) continue;
      partitions = mergeOverflow(
        partitions.sort((a, b) => partitionScore(b) - partitionScore(a)),
        CHILDREN_PER_PARENT[detail],
        `${parent.path}/(other)`,
        `${parent.title} · Other`,
        partitionScore
      );
      for (const partition of partitions) {
        nextFrontier.push({
          path: partition.path,
          title: partition.title ?? humanizeSegment(partition.path.split("/").pop() ?? partition.path),
          unitIndex: partitionedIntoFiles ? 3 : targetUnitIndex,
          tier,
          parentPath: parent.path,
          files: partition.files,
          isFileCluster: partitionedIntoFiles
        });
      }
    }
    if (!nextFrontier.length) break;
    clusters.push(...nextFrontier);
    frontier = nextFrontier;
  }

  const externalCounts = (files: string[]): string[] => {
    const counts = new Map<string, number>();
    for (const file of files) {
      for (const external of input.fileGraph.externalsByFile.get(file) ?? []) {
        counts.set(external, (counts.get(external) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name);
  };

  const unitNames: ModuleCluster["unit"][] = ["area", "module", "component", "file"];
  const languageByFile = new Map(scan.files.map((file) => [file.relPath, file.detectedLanguage ?? file.language]));
  const parsedByFile = new Map(parsed.map((file) => [file.relPath, file]));
  const routesByFile = new Map<string, string[]>();
  for (const route of input.inventory?.routes ?? []) {
    const list = routesByFile.get(route.file) ?? [];
    list.push(route.route);
    routesByFile.set(route.file, list);
  }
  const interactionsByFile = new Map<string, NonNullable<ModuleCluster["interactions"]>>();
  for (const interaction of input.inventory?.interactions ?? []) {
    const list = interactionsByFile.get(interaction.file) ?? [];
    list.push(interaction);
    interactionsByFile.set(interaction.file, list);
  }
  const clusterSymbols = (files: string[]): string[] => {
    return [...new Set(clusterSymbolRefs(files).map((symbol) => symbol.name))];
  };
  const clusterSymbolRefs = (files: string[]): NonNullable<ModuleCluster["symbolRefs"]> => {
    return rankClusterSymbolRefs(files, parsedByFile, (file) => (entrypoints.has(file) ? 1_000 : 0) + (dependencyDegree.get(file) ?? 0) * 10 + roleWeight(file));
  };
  const idByPath = collisionSafeIds(clusters.map((cluster) => cluster.path));
  const moduleClusters: ModuleCluster[] = clusters.map((cluster) => ({
    id: idByPath.get(cluster.path) as string,
    path: cluster.path,
    title: cluster.title,
    unit: unitNames[cluster.unitIndex],
    tier: cluster.tier,
    parentClusterId: cluster.parentPath ? idByPath.get(cluster.parentPath) ?? slugForClusterPath(cluster.parentPath) : undefined,
    files: cluster.files,
    loc: cluster.files.reduce((sum, file) => sum + (locByFile.get(file) ?? 0), 0),
    languages: [...new Set(cluster.files.map((file) => languageByFile.get(file)).filter(Boolean))] as string[],
    topFiles: [...cluster.files].sort((a, b) => fileWeight(b) - fileWeight(a)).slice(0, 5),
    externalDeps: externalCounts(cluster.files),
    docTitles: cluster.files.filter((file) => /readme|architecture|contributing|changelog|docs?\//i.test(file)).slice(0, 4).map((file) => path.posix.basename(file)),
    symbols: clusterSymbols(cluster.files),
    symbolRefs: clusterSymbolRefs(cluster.files),
    routes: [...new Set(cluster.files.flatMap((file) => routesByFile.get(file) ?? []))].slice(0, 20),
    interactions: cluster.files.flatMap((file) => interactionsByFile.get(file) ?? []).slice(0, 30)
  }));

  appendCatalogClusters(moduleClusters, input.inventory, levelCount);
  const edges = aggregateEdges(moduleClusters, fileGraph);
  return enrichModuleGraph({
    clusters: moduleClusters,
    edges,
    levels,
    granularity,
    entrypoints: input.inventory?.entrypoints ?? [],
    semanticLinks: input.semanticLinks ?? [],
    behavioralContracts: input.inventory?.behavioralContracts ?? []
  }, scan);
}

/** Deterministic catalog placement: a catalog cluster under the owner of its source file, items one tier deeper when room allows. */
export function appendCatalogClusters(moduleClusters: ModuleCluster[], inventory: ContentInventory | undefined, levelCount: number): void {
  if (!inventory?.catalogs.length || levelCount < 2) return;
  const byId = new Map(moduleClusters.map((cluster) => [cluster.id, cluster]));
  for (const catalog of inventory.catalogs) {
    const owner = moduleClusters
      .filter((cluster) => cluster.files.includes(catalog.file))
      .sort((a, b) => b.tier - a.tier || b.path.length - a.path.length)[0];
    if (!owner) continue;
    let parent = owner;
    while (parent.tier >= levelCount) {
      const next = parent.parentClusterId ? byId.get(parent.parentClusterId) : undefined;
      if (!next) break;
      parent = next;
    }
    if (parent.tier >= levelCount) continue;
    const catalogTier = parent.tier + 1;
    const itemsFitBelowWrapper = catalogTier + 1 <= levelCount;

    let itemParentId = parent.id;
    let itemTier = catalogTier;
    if (itemsFitBelowWrapper) {
      // Room for a catalog wrapper node with the items one level deeper.
      const catalogTitle = `${humanizeSegment(catalog.callee === "entries" ? path.posix.basename(catalog.file) : catalog.callee)} Catalog`;
      const catalogCluster: ModuleCluster = {
        id: slugForClusterPath(`${catalog.file}-${catalog.callee}-catalog`),
        path: `${catalog.file}#${catalog.callee}`,
        title: catalogTitle,
        unit: "component",
        tier: catalogTier,
        parentClusterId: parent.id,
        files: [],
        loc: 0,
        languages: [],
        topFiles: [catalog.file],
        externalDeps: [],
        docTitles: [],
        symbols: [],
        catalogRef: { file: catalog.file, callee: catalog.callee, itemCount: catalog.items.length, itemTitles: catalog.items.map((item) => item.title).slice(0, 12) }
      };
      moduleClusters.push(catalogCluster);
      itemParentId = catalogCluster.id;
      itemTier = catalogTier + 1;
    }
    // The catalogued items are the product content — always emit them at the deepest reachable tier.
    for (const item of catalog.items) {
      moduleClusters.push({
        id: slugForClusterPath(`${catalog.file}-item-${item.key}`),
        path: `${catalog.file}#${item.key}`,
        title: item.title,
        unit: "file",
        tier: itemTier,
        parentClusterId: itemParentId,
        files: [],
        loc: 0,
        languages: [],
        topFiles: [catalog.file],
        externalDeps: [],
        docTitles: [],
        symbols: [],
        catalogItem: { key: item.key, title: item.title, note: item.note, file: catalog.file }
      });
    }
  }
}

export function aggregateEdges(clusters: ModuleCluster[], fileGraph: FileDependencyGraph): ModuleEdge[] {
  const byTier = new Map<number, ModuleCluster[]>();
  for (const cluster of clusters) {
    const list = byTier.get(cluster.tier) ?? [];
    list.push(cluster);
    byTier.set(cluster.tier, list);
  }

  const edges = new Map<string, ModuleEdge>();
  for (const [, tierClusters] of byTier) {
    const clusterByFile = new Map<string, ModuleCluster>();
    for (const cluster of tierClusters) {
      for (const file of cluster.files) clusterByFile.set(file, cluster);
    }
    for (const fileEdge of fileGraph.edges) {
      const source = clusterByFile.get(fileEdge.from);
      const target = clusterByFile.get(fileEdge.to);
      if (!source || !target || source.id === target.id) continue;
      const key = `${source.id} ${target.id}`;
      const existing = edges.get(key);
      if (existing) {
        existing.importCount += 1;
        existing.occurrences = (existing.occurrences ?? existing.importCount - 1) + (fileEdge.occurrences ?? 1);
        existing.kinds = [...new Set([...(existing.kinds ?? []), ...(fileEdge.kinds ?? [])])];
        existing.relationKinds = [...new Set([...(existing.relationKinds ?? []), ...(fileEdge.relationKinds ?? [])])];
        existing.importedNames = [...new Set([...(existing.importedNames ?? []), ...(fileEdge.importedNames ?? [])])].filter((name) => name !== "*").slice(0, 20);
        existing.evidence = [...(existing.evidence ?? []), ...(fileEdge.evidence ?? []).map((item) => ({ from: fileEdge.from, to: fileEdge.to, ...item }))]
          .filter((item, index, all) => all.findIndex((candidate) => candidate.from === item.from && candidate.to === item.to && candidate.line === item.line && candidate.specifier === item.specifier) === index)
          .slice(0, 8);
        existing.confidence = Math.min(existing.confidence ?? 1, fileEdge.confidence ?? 1);
        if (existing.sampleImports.length < 3) existing.sampleImports.push(`${fileEdge.from} → ${fileEdge.to}`);
        continue;
      }
      edges.set(key, {
        source: source.id,
        target: target.id,
        importCount: 1,
        sampleImports: [`${fileEdge.from} → ${fileEdge.to}`],
        kinds: fileEdge.kinds,
        importedNames: (fileEdge.importedNames ?? []).filter((name) => name !== "*").slice(0, 20),
        evidence: (fileEdge.evidence ?? []).map((item) => ({ from: fileEdge.from, to: fileEdge.to, ...item })).slice(0, 8),
        occurrences: fileEdge.occurrences,
        confidence: fileEdge.confidence,
        relationKinds: fileEdge.relationKinds
      });
    }
  }
  return [...edges.values()];
}
