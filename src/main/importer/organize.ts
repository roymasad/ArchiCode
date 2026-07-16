import path from "node:path";
import { z } from "zod";
import { aggregateEdges, appendCatalogClusters, humanizeSegment, slugForClusterPath } from "./aggregate";
import { enrichModuleGraph } from "./insights";
import { rankClusterSymbolRefs } from "./symbolRanking";
import type { ContentInventory } from "./inventory";
import type {
  ArchitectureLensPlan,
  CodebaseImportDetail,
  CodebaseImportLevels,
  FileDependencyGraph,
  ImportAnnotations,
  ModuleCluster,
  ModuleGraph,
  ParsedFile,
  RepoScan
} from "./types";

/**
 * The LLM proposes a *functional* hierarchy (what belongs together conceptually);
 * this module turns that proposal into a ModuleGraph whose membership, coverage,
 * and edges are enforced deterministically — the LLM can group and name, but every
 * node traces to real files/catalog items and every edge to real import statements.
 */

export const architectureNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable().optional(),
  title: z.string().default(""),
  type: z.string().default(""),
  description: z.string().default(""),
  techStack: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  visual: z.object({ backgroundColor: z.string().optional(), shape: z.string().optional() }).optional(),
  groupName: z.string().optional(),
  members: z.array(z.string()).default([]),
  catalogItems: z.array(z.string()).default([])
});

export const architectureLensNodeSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  type: z.string().trim().min(1),
  description: z.string().trim().min(1),
  evidenceMembers: z.array(z.string().trim().min(1)).max(24).default([]),
  groupName: z.string().trim().min(1).optional(),
  contextOnly: z.boolean().optional()
});

export const architectureLensEdgeSchema = z.object({
  source: z.string().trim().min(1),
  target: z.string().trim().min(1),
  label: z.string().trim().min(1)
});

export const architectureLensPlanSchema = z.object({
  id: z.enum(["functional", "user-journey", "data", "infrastructure"]),
  nodes: z.array(architectureLensNodeSchema).max(16).default([]),
  // Confidence is deliberately not provider-authored. Every relationship in this
  // envelope is an architectural interpretation; emission assigns evidence
  // confidence from provenance instead of trusting model self-scoring.
  edges: z.array(architectureLensEdgeSchema).max(32).default([])
});

export const architectureSpecSchema = z.object({
  analysis: z.string().default(""),
  projectNode: z.object({
    title: z.string().default(""),
    description: z.string().default(""),
    techStack: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.string()).default([]),
    visual: z.object({ backgroundColor: z.string().optional(), shape: z.string().optional() }).optional()
  }),
  architecture: z.array(architectureNodeSchema).default([]),
  lenses: z.array(architectureLensPlanSchema).max(4).default([]),
  edgeLabels: z.array(z.object({ source: z.string(), target: z.string(), label: z.string() })).default([]),
  subflowNames: z.array(z.string()).default([]),
  summary: z.string().default("")
});

export type ArchitectureSpec = z.infer<typeof architectureSpecSchema>;

function connectedNodeIds(plan: ArchitectureLensPlan): Set<string> {
  return new Set(plan.edges.flatMap((edge) => [edge.source, edge.target]));
}

/**
 * Technology-neutral shape checks for the human mental model promised by each
 * lens. These never assert repository facts; they only reject plumbing-shaped
 * projections before they are presented as capabilities, journeys, data flows,
 * or infrastructure flows.
 */
export function lensPlanQualityIssues(plan: ArchitectureLensPlan): string[] {
  const issues: string[] = [];
  const types = plan.nodes.map((node) => node.type.toLowerCase());
  const connected = connectedNodeIds(plan);
  const grounded = plan.nodes.filter((node) => node.contextOnly || node.evidenceMembers.length > 0);
  if (plan.nodes.length < 2) issues.push("fewer than two useful nodes");
  if (grounded.length !== plan.nodes.length) issues.push("contains nodes without repository evidence");
  if (plan.edges.length < Math.max(1, plan.nodes.length - 2)) issues.push("does not form a coherent relationship path");
  if (plan.nodes.filter((node) => connected.has(node.id)).length < Math.max(2, plan.nodes.length - 1)) issues.push("leaves too many lens nodes disconnected");

  if (plan.id === "functional") {
    const capabilityCount = types.filter((type) => /capability|outcome|product/.test(type)).length;
    if (capabilityCount < Math.max(2, Math.ceil(plan.nodes.length / 2))) issues.push("is dominated by technical layers instead of product capabilities");
  }
  if (plan.id === "user-journey") {
    const actorCount = plan.nodes.filter((node) => node.contextOnly || /actor|persona|user/.test(node.type.toLowerCase())).length;
    const orderedStepCount = types.filter((type) => /trigger|step|decision|outcome|action|journey/.test(type)).length;
    if (!actorCount) issues.push("has no actor or initiating context");
    if (orderedStepCount < 2) issues.push("does not contain ordered journey steps or outcomes");
  }
  if (plan.id === "data") {
    const roles = new Set<string>();
    for (const type of types) {
      if (/owner|entity|record|model/.test(type)) roles.add("entity");
      if (/state|store|database|repository|ledger/.test(type)) roles.add("store");
      if (/transform|project|derive|validation/.test(type)) roles.add("transform");
      if (/migration|sync|backup|replication/.test(type)) roles.add("movement");
    }
    if (roles.size < 2) issues.push("does not distinguish data owners, stores, transformations, or movement");
  }
  if (plan.id === "infrastructure") {
    const roles = new Set<string>();
    for (const type of types) {
      if (/pipeline|workflow|build|deploy/.test(type)) roles.add("delivery");
      if (/artifact|package|image|bundle/.test(type)) roles.add("artifact");
      if (/runtime|host|service|target|resource/.test(type)) roles.add("runtime");
      if (/external|boundary|managed|provider/.test(type)) roles.add("boundary");
    }
    if (roles.size < 2) issues.push("does not connect delivery, artifacts, runtimes, or external boundaries");
  }
  return issues;
}

export function sanitizedLensPlans(spec: ArchitectureSpec): ArchitectureLensPlan[] {
  const seen = new Set<string>();
  return spec.lenses.flatMap((lens) => {
    if (seen.has(lens.id) || lens.nodes.length < 2) return [];
    const nodeIds = new Set<string>();
    const nodes = lens.nodes.filter((node) => {
      if (nodeIds.has(node.id)) return false;
      nodeIds.add(node.id);
      return node.contextOnly || node.evidenceMembers.length > 0;
    });
    const retainedIds = new Set(nodes.map((node) => node.id));
    if (nodes.length < 2) return [];
    const plan = {
      ...lens,
      nodes,
      edges: lens.edges.filter((edge) => edge.source !== edge.target && retainedIds.has(edge.source) && retainedIds.has(edge.target))
    } as ArchitectureLensPlan;
    if (lensPlanQualityIssues(plan).length) return [];
    seen.add(lens.id);
    return [plan];
  });
}

type WorkNode = {
  id: string;
  parentId: string | null;
  spec: z.infer<typeof architectureNodeSchema>;
  ownedFiles: string[];
  catalogClaims: string[];
  children: WorkNode[];
  tier: number;
};

const SCOPE_BUDGET: Record<CodebaseImportDetail, number> = { light: 10, balanced: 16, deep: 30 };

export function transformArchitecture(input: {
  spec: ArchitectureSpec;
  scan: RepoScan;
  parsed: ParsedFile[];
  fileGraph: FileDependencyGraph;
  inventory: ContentInventory;
  levels: CodebaseImportLevels;
  detail: CodebaseImportDetail;
  granularity: ModuleGraph["granularity"];
  semanticLinks?: ModuleGraph["semanticLinks"];
}): { moduleGraph: ModuleGraph; annotations: ImportAnnotations; notes: string[] } | null {
  const { spec, scan, parsed, fileGraph, inventory, levels, detail } = input;
  const levelCount = Number(levels);
  const notes: string[] = [];
  const allFiles = scan.files.map((file) => file.relPath);
  const fileSet = new Set(allFiles);

  // 1. Sanitize node ids and build the node table.
  const nodes = new Map<string, WorkNode>();
  for (const nodeSpec of spec.architecture) {
    const id = slugForClusterPath(nodeSpec.id).replace(/^cluster-/, "");
    if (!id || nodes.has(id) || !nodeSpec.title.trim()) continue;
    nodes.set(id, { id, parentId: null, spec: nodeSpec, ownedFiles: [], catalogClaims: [], children: [], tier: 1 });
  }
  if (nodes.size < 2) return null;

  // 2. Resolve parents (unknown parent -> root), break cycles, clamp depth to levels.
  for (const node of nodes.values()) {
    const rawParent = node.spec.parentId ? slugForClusterPath(node.spec.parentId).replace(/^cluster-/, "") : null;
    node.parentId = rawParent && nodes.has(rawParent) && rawParent !== node.id ? rawParent : null;
  }
  for (const node of nodes.values()) {
    const seen = new Set<string>([node.id]);
    let current = node.parentId;
    while (current) {
      if (seen.has(current)) {
        node.parentId = null;
        notes.push(`Broke a parent cycle at "${node.id}".`);
        break;
      }
      seen.add(current);
      current = nodes.get(current)?.parentId ?? null;
    }
  }
  const depthOf = (node: WorkNode): number => {
    let depth = 1;
    let current = node.parentId;
    while (current) {
      depth += 1;
      current = nodes.get(current)?.parentId ?? null;
    }
    return depth;
  };
  for (const node of nodes.values()) {
    while (depthOf(node) > levelCount) {
      const parent = nodes.get(node.parentId as string);
      node.parentId = parent?.parentId ?? null;
    }
  }

  // 3. Membership: exact file claims beat longer dir-prefix claims beat shorter ones.
  type Claim = { nodeId: string; prefix: string; exact: boolean };
  const claims: Claim[] = [];
  for (const node of nodes.values()) {
    for (const member of node.spec.members) {
      const clean = member.trim().replace(/^\.\//, "");
      if (!clean) continue;
      if (clean.endsWith("/")) claims.push({ nodeId: node.id, prefix: clean, exact: false });
      else if (fileSet.has(clean)) claims.push({ nodeId: node.id, prefix: clean, exact: true });
      else if ([...fileSet].some((file) => file.startsWith(`${clean}/`))) claims.push({ nodeId: node.id, prefix: `${clean}/`, exact: false });
    }
  }
  const ownerByFile = new Map<string, string>();
  for (const file of allFiles) {
    let best: Claim | null = null;
    for (const claim of claims) {
      const matches = claim.exact ? claim.prefix === file : file.startsWith(claim.prefix);
      if (!matches) continue;
      if (!best || (claim.exact && !best.exact) || (claim.exact === best.exact && claim.prefix.length > best.prefix.length)) {
        best = claim;
      }
    }
    if (best) ownerByFile.set(file, best.nodeId);
  }

  // Unclaimed files: attach to the node whose claimed files share the longest directory prefix.
  const unclaimed = allFiles.filter((file) => !ownerByFile.has(file));
  if (unclaimed.length) {
    const dirOwners = new Map<string, string>();
    for (const [file, owner] of ownerByFile) dirOwners.set(path.posix.dirname(file), owner);
    let fallbackNode: WorkNode | null = null;
    for (const file of unclaimed) {
      let dir = path.posix.dirname(file);
      let assigned = false;
      while (true) {
        const owner = dirOwners.get(dir);
        if (owner) {
          ownerByFile.set(file, owner);
          assigned = true;
          break;
        }
        if (dir === "." || dir === "") break;
        dir = path.posix.dirname(dir);
      }
      if (!assigned) {
        if (!fallbackNode) {
          fallbackNode = {
            id: "unassigned-files",
            parentId: null,
            spec: architectureNodeSchema.parse({ id: "unassigned-files", title: "Other Files", type: "tooling", description: "" }),
            ownedFiles: [],
            catalogClaims: [],
            children: [],
            tier: 1
          };
          nodes.set(fallbackNode.id, fallbackNode);
        }
        ownerByFile.set(file, fallbackNode.id);
      }
    }
    notes.push(`${unclaimed.length} file${unclaimed.length === 1 ? "" : "s"} were not claimed by the architecture and were auto-assigned.`);
  }
  for (const [file, owner] of ownerByFile) nodes.get(owner)?.ownedFiles.push(file);

  // 4. Catalog item claims ("file::key" or "file::*").
  const itemsById = new Map(inventory.catalogs.flatMap((catalog) => catalog.items.map((item) => [item.id, { catalog, item }] as const)));
  const claimedItems = new Set<string>();
  for (const node of nodes.values()) {
    for (const ref of node.spec.catalogItems) {
      if (ref.endsWith("::*")) {
        const file = ref.slice(0, -3);
        for (const [id, entry] of itemsById) {
          if (entry.catalog.file === file && !claimedItems.has(id)) {
            node.catalogClaims.push(id);
            claimedItems.add(id);
          }
        }
      } else if (itemsById.has(ref) && !claimedItems.has(ref)) {
        node.catalogClaims.push(ref);
        claimedItems.add(ref);
      }
    }
  }

  // 5. Drop nodes that own nothing (reparent children), then compute tiers.
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (const node of [...nodes.values()]) {
      const hasChildren = [...nodes.values()].some((candidate) => candidate.parentId === node.id);
      if (!node.ownedFiles.length && !node.catalogClaims.length && !hasChildren) {
        nodes.delete(node.id);
        dropped = true;
      }
    }
  }
  if (nodes.size < 2) return null;
  for (const node of nodes.values()) node.tier = depthOf(node);

  // 6. Scope budgets: merge the smallest siblings beyond the budget.
  const budget = SCOPE_BUDGET[detail];
  const protectedBoundaryFiles = new Set([
    ...inventory.entrypoints,
    ...inventory.interactions
      .filter((interaction) => ["http-route", "ipc-handle", "platform-host"].includes(interaction.kind) && (interaction.confidence ?? 1) >= 0.9)
      .map((interaction) => interaction.file)
  ]);
  const byParent = new Map<string | null, WorkNode[]>();
  for (const node of nodes.values()) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  for (const [parentId, siblings] of byParent) {
    if (siblings.length <= budget) continue;
    const retentionWeight = (node: WorkNode): number => (node.ownedFiles.some((file) => protectedBoundaryFiles.has(file)) ? 10_000 : 0)
      + node.ownedFiles.length
      + node.catalogClaims.length;
    const sorted = [...siblings].sort((a, b) => retentionWeight(b) - retentionWeight(a));
    const overflow = sorted.slice(budget - 1);
    const target = sorted[budget - 1];
    for (const node of overflow) {
      if (node === target) continue;
      target.ownedFiles.push(...node.ownedFiles);
      target.catalogClaims.push(...node.catalogClaims);
      for (const child of [...nodes.values()]) {
        if (child.parentId === node.id) child.parentId = target.id;
      }
      nodes.delete(node.id);
    }
    const parentTitle = parentId ? nodes.get(parentId)?.spec.title ?? "Scope" : "Root";
    target.spec = { ...target.spec, title: `${parentTitle} · Other`, description: "" };
    notes.push(`Merged ${overflow.length - 1} small nodes into "${target.spec.title}" to respect the ${detail} detail budget.`);
    for (const node of nodes.values()) node.tier = depthOf(node);
  }

  // 7. Build ModuleClusters with subtree file sets and derived metadata.
  const subtreeFiles = (node: WorkNode): string[] => {
    const collected = [...node.ownedFiles];
    for (const child of nodes.values()) {
      if (child.parentId === node.id) collected.push(...subtreeFiles(child));
    }
    return collected;
  };
  const languageByFile = new Map(scan.files.map((file) => [file.relPath, file.language]));
  const parsedByFile = new Map(parsed.map((file) => [file.relPath, file]));
  const sizeByFile = new Map(scan.files.map((file) => [file.relPath, file.sizeBytes]));
  const roleByFile = new Map(scan.files.map((file) => [file.relPath, file.role ?? "production"] as const));
  const fileRankFactor = (file: string): number => {
    const role = roleByFile.get(file);
    return role === "asset" ? 0.001 : role === "docs" ? 0.01 : role === "test" ? 1 : role === "config" ? 2 : 5;
  };
  const fileWeight = (file: string): number => ((parsedByFile.get(file)?.loc || 0) * 1000 + (sizeByFile.get(file) ?? 0)) * fileRankFactor(file);
  const dependencyDegree = new Map<string, number>();
  for (const edge of fileGraph.edges) {
    const weight = edge.occurrences ?? 1;
    dependencyDegree.set(edge.from, (dependencyDegree.get(edge.from) ?? 0) + weight);
    dependencyDegree.set(edge.to, (dependencyDegree.get(edge.to) ?? 0) + weight);
  }
  const entrypoints = new Set(inventory.entrypoints);
  const symbolScore = (file: string): number => (entrypoints.has(file) ? 1_000 : 0) + (dependencyDegree.get(file) ?? 0) * 10 + fileRankFactor(file);
  const routesByFile = new Map<string, string[]>();
  for (const route of inventory.routes) {
    const list = routesByFile.get(route.file) ?? [];
    list.push(route.route);
    routesByFile.set(route.file, list);
  }
  const interactionsByFile = new Map<string, NonNullable<ModuleCluster["interactions"]>>();
  for (const interaction of inventory.interactions) {
    const list = interactionsByFile.get(interaction.file) ?? [];
    list.push(interaction);
    interactionsByFile.set(interaction.file, list);
  }
  const clusters: ModuleCluster[] = [];
  const clusterIdFor = (nodeId: string): string => `cluster-${nodeId}`;
  const unitForTier = (tier: number): ModuleCluster["unit"] => (["area", "module", "component", "file"][Math.min(tier - 1, 3)] as ModuleCluster["unit"]);
  for (const node of nodes.values()) {
    const files = [...new Set(subtreeFiles(node))];
    const owned = new Set(node.ownedFiles);
    const externals = new Map<string, number>();
    for (const file of files) {
      for (const dep of fileGraph.externalsByFile.get(file) ?? []) externals.set(dep, (externals.get(dep) ?? 0) + 1);
    }
    const symbolRefs = rankClusterSymbolRefs(files, parsedByFile, (file) => symbolScore(file) + (owned.has(file) ? 10_000 : 0));
    const symbols = [...new Set(symbolRefs.map((symbol) => symbol.name))];
    clusters.push({
      id: clusterIdFor(node.id),
      path: node.ownedFiles[0] ? path.posix.dirname(node.ownedFiles[0]) : `(${node.id})`,
      title: node.spec.title,
      unit: unitForTier(node.tier),
      tier: node.tier,
      parentClusterId: node.parentId ? clusterIdFor(node.parentId) : undefined,
      files,
      ownedFiles: [...node.ownedFiles],
      loc: files.reduce((sum, file) => sum + (parsedByFile.get(file)?.loc ?? 0), 0),
      languages: [...new Set(files.map((file) => languageByFile.get(file)).filter(Boolean))] as string[],
      topFiles: [...files].sort((a, b) => fileWeight(b) - fileWeight(a)).slice(0, 5),
      externalDeps: [...externals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name),
      docTitles: files.filter((file) => /readme|architecture|contributing|changelog|docs?\//i.test(file)).slice(0, 4).map((file) => path.posix.basename(file)),
      symbols,
      symbolRefs,
      routes: [...new Set(files.flatMap((file) => routesByFile.get(file) ?? []))].slice(0, 20),
      interactions: files.flatMap((file) => interactionsByFile.get(file) ?? []).slice(0, 30)
    });
    // Claimed catalog items become child item nodes when a deeper tier exists.
    if (node.catalogClaims.length) {
      const itemTier = Math.min(node.tier + 1, levelCount);
      const itemParent = itemTier > node.tier ? clusterIdFor(node.id) : clusters[clusters.length - 1].parentClusterId ?? clusterIdFor(node.id);
      for (const claimId of node.catalogClaims) {
        const entry = itemsById.get(claimId);
        if (!entry) continue;
        clusters.push({
          id: slugForClusterPath(`${entry.catalog.file}-item-${entry.item.key}`),
          path: `${entry.catalog.file}#${entry.item.key}`,
          title: entry.item.title,
          unit: "file",
          tier: itemTier,
          parentClusterId: itemParent,
          files: [],
          loc: 0,
          languages: [],
          topFiles: [entry.catalog.file],
          externalDeps: [],
          docTitles: [],
          symbols: [],
          catalogItem: { key: entry.item.key, title: entry.item.title, note: entry.item.note, file: entry.catalog.file }
        });
      }
    }
  }

  // If the LLM returned a shallower tree than the user asked for, deepen large leaf
  // nodes into component children deterministically — levels must never come back empty.
  deepenLeafClusters(clusters, { parsedByFile, languageByFile, roleByFile, fileGraph, fileWeight, symbolScore }, levelCount, detail, notes);

  // Catalogs the LLM ignored still get deterministic placement — no blindspots.
  const unplacedInventory: ContentInventory = {
    ...inventory,
    catalogs: inventory.catalogs.filter((catalog) => !catalog.items.some((item) => claimedItems.has(item.id)))
  };
  appendCatalogClusters(clusters, unplacedInventory, levelCount);

  const edges = aggregateEdges(clusters, fileGraph);

  // 8. Annotations from the spec, with edge labels kept only for derived edges.
  const derivedPairs = new Set(edges.map((edge) => `${edge.source} ${edge.target}`));
  const annotations: ImportAnnotations = {
    projectNode: {
      title: spec.projectNode.title,
      description: spec.projectNode.description,
      techStack: spec.projectNode.techStack,
      acceptanceCriteria: spec.projectNode.acceptanceCriteria,
      visual: spec.projectNode.visual
    },
    clusters: [...nodes.values()].map((node) => ({
      id: clusterIdFor(node.id),
      title: node.spec.title,
      type: node.spec.type,
      description: node.spec.description,
      techStack: node.spec.techStack,
      acceptanceCriteria: node.spec.acceptanceCriteria,
      visual: node.spec.visual,
      groupName: node.spec.groupName
    })),
    groups: buildGroups(nodes),
    edgeLabels: spec.edgeLabels
      .map((edgeLabel) => ({
        source: `cluster-${slugForClusterPath(edgeLabel.source).replace(/^cluster-/, "")}`,
        target: `cluster-${slugForClusterPath(edgeLabel.target).replace(/^cluster-/, "")}`,
        label: edgeLabel.label
      }))
      .filter((edgeLabel) => derivedPairs.has(`${edgeLabel.source} ${edgeLabel.target}`)),
    subflowNames: spec.subflowNames.slice(0, levelCount - 1),
    summary: spec.summary
  };
  while (annotations.subflowNames.length < levelCount - 1) {
    annotations.subflowNames.push(["Modules", "Components", "Details"][annotations.subflowNames.length] ?? "Details");
  }
  const maxTier = Math.max(1, ...clusters.map((cluster) => cluster.tier));
  annotations.subflowNames = annotations.subflowNames.slice(0, Math.max(0, maxTier - 1));

  return {
    moduleGraph: enrichModuleGraph({ clusters, edges, levels, granularity: input.granularity, entrypoints: inventory.entrypoints, semanticLinks: input.semanticLinks ?? [] }, scan),
    annotations,
    notes
  };
}

const CHILDREN_PER_PARENT: Record<CodebaseImportDetail, number> = { light: 4, balanced: 6, deep: 10 };
const GENERATED_CHILDREN_PER_ROOT: Record<CodebaseImportDetail, number> = { light: 16, balanced: 36, deep: 60 };
const MIN_FILES_TO_DEEPEN = 5;

/** Group files by the next directory segment under their common prefix; fall back to per-file. */
function partitionFilesByPath(files: string[]): Array<{ key: string; files: string[] }> {
  const dirs = files.map((file) => path.posix.dirname(file));
  let prefix = dirs[0] ?? "";
  for (const dir of dirs) {
    while (prefix && dir !== prefix && !dir.startsWith(`${prefix}/`)) {
      prefix = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    }
  }
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const rest = prefix ? file.slice(prefix.length + 1) : file;
    const slash = rest.indexOf("/");
    if (slash === -1) continue;
    const key = prefix ? `${prefix}/${rest.slice(0, slash)}` : rest.slice(0, slash);
    const list = groups.get(key) ?? [];
    list.push(file);
    groups.set(key, list);
  }
  if (groups.size >= 2) return [...groups.entries()].map(([key, groupFiles]) => ({ key, files: groupFiles }));
  return files.map((file) => ({ key: file, files: [file] }));
}

/** Production structure gets the detail budget before mirrored tests, assets, and config. */
function partitionClusterFiles(
  cluster: ModuleCluster,
  roleByFile: Map<string, RepoScan["files"][number]["role"]>,
  budget: number
): Array<{ key: string; files: string[] }> {
  const production = cluster.files.filter((file) => (roleByFile.get(file) ?? "production") === "production");
  if (production.length >= 3) {
    const primary = partitionFilesByPath(production);
    if (primary.length >= 2) {
      const supporting = cluster.files.filter((file) => !production.includes(file));
      if (supporting.length && primary.length < budget) {
        primary.push({ key: `${cluster.path}/verification-support`, files: supporting });
      }
      return primary;
    }
  }
  return partitionFilesByPath(cluster.files);
}

function deepenLeafClusters(
  clusters: ModuleCluster[],
  meta: {
    parsedByFile: Map<string, ParsedFile>;
    languageByFile: Map<string, ModuleCluster["languages"][number] | null>;
    roleByFile: Map<string, RepoScan["files"][number]["role"]>;
    fileGraph: FileDependencyGraph;
    fileWeight: (file: string) => number;
    symbolScore: (file: string) => number;
  },
  levelCount: number,
  detail: CodebaseImportDetail,
  notes: string[]
): void {
  const budget = CHILDREN_PER_PARENT[detail];
  const generatedByRoot = new Map<string, number>();
  const clusterById = (): Map<string, ModuleCluster> => new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const rootFor = (cluster: ModuleCluster): ModuleCluster => {
    const byId = clusterById();
    let current = cluster;
    while (current.parentClusterId && byId.has(current.parentClusterId)) current = byId.get(current.parentClusterId) as ModuleCluster;
    return current;
  };
  const internalWeight = (cluster: ModuleCluster): number => meta.fileGraph.edges
    .filter((edge) => cluster.files.includes(edge.from) && cluster.files.includes(edge.to))
    .reduce((sum, edge) => sum + (edge.occurrences ?? 1), 0);
  let deepened = 0;
  let frontier = [...clusters];
  while (frontier.length) {
    frontier.sort((left, right) =>
      (right.files.filter((file) => (meta.roleByFile.get(file) ?? "production") === "production").length * 20 + internalWeight(right))
      - (left.files.filter((file) => (meta.roleByFile.get(file) ?? "production") === "production").length * 20 + internalWeight(left))
    );
    const next: ModuleCluster[] = [];
    for (const cluster of frontier) {
      if (cluster.tier >= levelCount || cluster.files.length < MIN_FILES_TO_DEEPEN) continue;
      if (clusters.some((candidate) => candidate.parentClusterId === cluster.id)) continue;
      const productionCount = cluster.files.filter((file) => {
        const role = meta.roleByFile.get(file) ?? "production";
        return role === "production" || role === "migration";
      }).length;
      // Config/docs/asset-only clusters (dotfiles, legal pages, media) stay a single node:
      // exploding them into per-file children adds noise, not architecture.
      if (!productionCount) continue;
      const root = rootFor(cluster);
      const vendorBoundary = /^(packages|vendor|third[_-]?party)(\/|$)/i.test(root.path);
      const rootBudget = vendorBoundary ? Math.max(4, Math.floor(GENERATED_CHILDREN_PER_ROOT[detail] / 2)) : GENERATED_CHILDREN_PER_ROOT[detail];
      const remainingRootBudget = rootBudget - (generatedByRoot.get(root.id) ?? 0);
      // Substantial product features always get at least a minimal split, even when the
      // root budget ran out — a flat headline feature confuses more than a few extra nodes.
      const guaranteedMinimalSplit = !vendorBoundary && productionCount >= MIN_FILES_TO_DEEPEN;
      if (remainingRootBudget < 3 && !guaranteedMinimalSplit) continue;
      let partitions = partitionClusterFiles(cluster, meta.roleByFile, budget);
      if (partitions.length < 2) continue;
      partitions.sort((a, b) => b.files.length - a.files.length);
      const effectiveBudget = Math.max(Math.min(budget, remainingRootBudget), guaranteedMinimalSplit ? 3 : 0);
      if (partitions.length > effectiveBudget) {
        const kept = partitions.slice(0, effectiveBudget - 1);
        const merged = partitions.slice(effectiveBudget - 1);
        kept.push({ key: `${cluster.path}/(other)`, files: merged.flatMap((partition) => partition.files) });
        partitions = kept;
      }
      for (const partition of partitions) {
        const isSingleFile = partition.files.length === 1 && partition.key === partition.files[0];
        const symbolRefs = rankClusterSymbolRefs(partition.files, meta.parsedByFile, meta.symbolScore);
        const child: ModuleCluster = {
          id: uniqueClusterId(clusters, slugForClusterPath(partition.key)),
          path: partition.key,
          title: partition.key.endsWith("/(other)")
            ? `${cluster.title} · Other`
            : humanizeSegment(partition.key.split("/").pop() ?? partition.key),
          unit: isSingleFile ? "file" : "component",
          tier: cluster.tier + 1,
          parentClusterId: cluster.id,
          files: partition.files,
          loc: partition.files.reduce((sum, file) => sum + (meta.parsedByFile.get(file)?.loc ?? 0), 0),
          languages: [...new Set(partition.files.map((file) => meta.languageByFile.get(file)).filter(Boolean))] as string[],
          topFiles: [...partition.files].sort((a, b) => meta.fileWeight(b) - meta.fileWeight(a)).slice(0, 5),
          externalDeps: [],
          docTitles: [],
          symbols: [...new Set(symbolRefs.map((symbol) => symbol.name))],
          symbolRefs
        };
        clusters.push(child);
        next.push(child);
        deepened += 1;
      }
      generatedByRoot.set(root.id, (generatedByRoot.get(root.id) ?? 0) + partitions.length);
    }
    frontier = next;
  }
  if (deepened) notes.push(`Added ${deepened} component node${deepened === 1 ? "" : "s"} beneath large areas the architecture left flat.`);
}

function uniqueClusterId(clusters: ModuleCluster[], candidate: string): string {
  if (!clusters.some((cluster) => cluster.id === candidate)) return candidate;
  let suffix = 2;
  while (clusters.some((cluster) => cluster.id === `${candidate}-${suffix}`)) suffix += 1;
  return `${candidate}-${suffix}`;
}

function buildGroups(nodes: Map<string, WorkNode>): ImportAnnotations["groups"] {
  const groups = new Map<string, { name: string; memberClusterIds: string[]; tier: number }>();
  for (const node of nodes.values()) {
    const name = node.spec.groupName?.trim();
    if (!name) continue;
    const existing = groups.get(name);
    if (existing) {
      if (existing.tier === node.tier) existing.memberClusterIds.push(`cluster-${node.id}`);
      continue;
    }
    groups.set(name, { name, memberClusterIds: [`cluster-${node.id}`], tier: node.tier });
  }
  return [...groups.values()]
    .filter((group) => group.memberClusterIds.length >= 2)
    .map(({ name, memberClusterIds }) => ({ name, memberClusterIds }));
}
