import path from "node:path";
import type { FileRole, GraphProjection, ModuleCluster, ModuleGraph, RepoScan } from "./types";
import { clusterHasDurablePersistenceEvidence } from "./semanticTruth";

function isSystemEntrypoint(file: string, cluster: ModuleCluster): boolean {
  const basename = path.posix.basename(file).toLowerCase();
  if (!/^index\.[^.]+$/.test(basename)) return true;
  if (file.split("/").length <= 2) return true;
  const boundaryPath = cluster.boundary?.path;
  return Boolean(boundaryPath && boundaryPath !== "." && (file === boundaryPath || file.startsWith(`${boundaryPath}/`)));
}

function isArchitecturalBoundaryInteraction(interaction: NonNullable<ModuleCluster["interactions"]>[number]): boolean {
  if (!["http-route", "http-call", "http-url", "ipc-handle", "ipc-send", "platform-host"].includes(interaction.kind)) return false;
  // Framework development helpers are observable network calls, but they are
  // not a product process/trust boundary and should not displace one.
  return !/(?:^|\/)(?:__|@vite)|open-in-editor/i.test(interaction.target);
}

function repositoryBoundaries(scan: RepoScan): Array<{ kind: string; path: string; manifest: string }> {
  const manifestKinds: Record<string, string> = {
    "package.json": "javascript-package",
    "cargo.toml": "rust-crate",
    "go.mod": "go-module",
    "composer.json": "php-package",
    "pubspec.yaml": "dart-package",
    "pyproject.toml": "python-package",
    "pom.xml": "maven-module",
    "build.gradle": "gradle-module",
    "build.gradle.kts": "gradle-module",
    "package.swift": "swift-package",
    "wrangler.toml": "cloudflare-worker",
    "serverless.yml": "serverless-service",
    "serverless.yaml": "serverless-service"
  };
  const boundaries: Array<{ kind: string; path: string; manifest: string }> = [];
  for (const file of scan.files) {
    const name = file.relPath.split("/").pop()?.toLowerCase() ?? "";
    const kind = manifestKinds[name] ?? (name.endsWith(".csproj") ? "dotnet-project" : undefined);
    if (!kind) continue;
    const boundaryPath = file.relPath.includes("/") ? file.relPath.slice(0, file.relPath.lastIndexOf("/")) : ".";
    boundaries.push({ kind, path: boundaryPath, manifest: file.relPath });
  }
  return boundaries.sort((a, b) => b.path.length - a.path.length || a.manifest.localeCompare(b.manifest));
}

function dependencyCommunities(graph: ModuleGraph): string[][] {
  const byTier = new Map<number, string[]>();
  for (const cluster of graph.clusters) {
    const list = byTier.get(cluster.tier) ?? [];
    list.push(cluster.id);
    byTier.set(cluster.tier, list);
  }
  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const source = adjacency.get(edge.source) ?? new Set<string>();
    const target = adjacency.get(edge.target) ?? new Set<string>();
    source.add(edge.target);
    target.add(edge.source);
    adjacency.set(edge.source, source);
    adjacency.set(edge.target, target);
  }
  const communities: string[][] = [];
  for (const ids of byTier.values()) {
    const allowed = new Set(ids);
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      const members: string[] = [];
      const queue = [id];
      seen.add(id);
      while (queue.length) {
        const current = queue.shift() as string;
        members.push(current);
        for (const neighbor of adjacency.get(current) ?? []) {
          if (!allowed.has(neighbor) || seen.has(neighbor)) continue;
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
      if (members.length > 1) communities.push(members.sort());
    }
  }
  return communities;
}

function dominantRole(cluster: ModuleCluster, roleByFile: Map<string, FileRole>): ModuleCluster["role"] {
  const counts = new Map<FileRole, number>();
  for (const file of cluster.files) {
    const role = roleByFile.get(file) ?? "production";
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return cluster.catalogItem || cluster.catalogRef ? "config" : "mixed";
  return ranked.length > 1 && ranked[0][1] === ranked[1][1] ? "mixed" : ranked[0][0];
}

function stronglyConnectedComponents(graph: ModuleGraph): string[][] {
  const nodeIds = new Set(graph.clusters.map((cluster) => cluster.id));
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (nodeId: string): void => {
    indices.set(nodeId, index);
    lowlinks.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    onStack.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId) as number, lowlinks.get(target) as number));
      } else if (onStack.has(target)) {
        lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId) as number, indices.get(target) as number));
      }
    }
    if (lowlinks.get(nodeId) !== indices.get(nodeId)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
      if (member === nodeId) break;
    }
    if (component.length > 1) components.push(component.sort());
  };
  for (const nodeId of nodeIds) if (!indices.has(nodeId)) visit(nodeId);
  return components;
}

function projection(
  id: GraphProjection["id"],
  title: string,
  question: string,
  description: string,
  evidenceBasis: string[],
  confidence: GraphProjection["confidence"],
  clusterIds: string[],
  graph: ModuleGraph,
  edgeFilter: (edge: ModuleGraph["edges"][number]) => boolean = () => true
): GraphProjection {
  const uniqueClusterIds = [...new Set(clusterIds)];
  const included = new Set(uniqueClusterIds);
  return {
    id,
    title,
    question,
    description,
    evidenceBasis,
    confidence,
    clusterIds: uniqueClusterIds,
    edgePairs: graph.edges.filter((edge) => included.has(edge.source) && included.has(edge.target) && edgeFilter(edge)).map(({ source, target }) => ({ source, target }))
  };
}

function clusterSearchText(cluster: ModuleCluster): string {
  return [
    cluster.path,
    cluster.title,
    ...cluster.files,
    ...cluster.symbols,
    ...cluster.externalDeps,
    ...(cluster.routes ?? []),
    ...(cluster.interactions ?? []).flatMap((interaction) => [interaction.kind, interaction.target, interaction.reference ?? ""])
  ].join(" ").toLowerCase();
}

function relatedProductionClusters(seedIds: Set<string>, graph: ModuleGraph, clusters: ModuleCluster[]): string[] {
  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const related = new Set(seedIds);
  for (const edge of graph.edges) {
    const touchesSeed = seedIds.has(edge.source) || seedIds.has(edge.target);
    if (!touchesSeed) continue;
    const neighborId = seedIds.has(edge.source) ? edge.target : edge.source;
    const neighbor = byId.get(neighborId);
    if (neighbor && ["production", "migration", "mixed"].includes(neighbor.role ?? "mixed")) related.add(neighborId);
  }
  return [...related];
}

function hasRoleForArchitecture(cluster: ModuleCluster): boolean {
  return !["test", "fixture", "generated", "asset", "docs", "tooling"].includes(cluster.role ?? "mixed");
}

function deepestMatches(ids: Set<string>, clusters: ModuleCluster[]): Set<string> {
  const result = new Set(ids);
  for (const cluster of clusters) {
    if (cluster.parentClusterId && ids.has(cluster.id)) result.delete(cluster.parentClusterId);
  }
  return result;
}

function connectedArchitectureSubjects(
  seeds: Set<string>,
  graph: ModuleGraph,
  clusters: ModuleCluster[],
  edgeFilter: (edge: ModuleGraph["edges"][number]) => boolean = () => true
): string[] {
  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const result = new Set(seeds);
  for (const edge of graph.edges) {
    if (!edgeFilter(edge)) continue;
    const neighborId = seeds.has(edge.source) ? edge.target : seeds.has(edge.target) ? edge.source : null;
    if (!neighborId) continue;
    const neighbor = byId.get(neighborId);
    if (neighbor && hasRoleForArchitecture(neighbor)) result.add(neighborId);
  }
  return [...result];
}

function subjectEvidence(
  ids: string[],
  clusters: ModuleCluster[],
  signalsFor: (cluster: ModuleCluster) => string[]
): Array<{ clusterId: string; signals: string[] }> {
  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  return ids.flatMap((clusterId) => {
    const cluster = byId.get(clusterId);
    if (!cluster) return [];
    const signals = signalsFor(cluster).filter(Boolean);
    return [{ clusterId, signals: signals.length ? signals : ["connected evidence-bearing collaborator"] }];
  });
}

/** Add deterministic architectural signals without changing cluster membership. */
export function enrichModuleGraph(graph: ModuleGraph, scan: RepoScan): ModuleGraph {
  const roleByFile = new Map(scan.files.map((file) => [file.relPath, file.role ?? "production"] as const));
  const entrypoints = new Set(graph.entrypoints);
  const reachableClusters = new Set(graph.clusters.filter((cluster) => cluster.files.some((file) => entrypoints.has(file))).map((cluster) => cluster.id));
  const clusterAdjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = clusterAdjacency.get(edge.source) ?? [];
    list.push(edge.target);
    clusterAdjacency.set(edge.source, list);
  }
  const queue = [...reachableClusters];
  while (queue.length) {
    const clusterId = queue.shift() as string;
    for (const target of clusterAdjacency.get(clusterId) ?? []) {
      if (reachableClusters.has(target)) continue;
      reachableClusters.add(target);
      queue.push(target);
    }
  }

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of graph.edges) {
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + (edge.occurrences ?? edge.importCount));
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + (edge.occurrences ?? edge.importCount));
  }
  const maxDegree = Math.max(1, ...graph.clusters.map((cluster) => (incoming.get(cluster.id) ?? 0) + (outgoing.get(cluster.id) ?? 0)));
  const cycles = stronglyConnectedComponents(graph);
  const communities = dependencyCommunities(graph);
  const communityByCluster = new Map<string, string>();
  communities.forEach((members, index) => members.forEach((member) => communityByCluster.set(member, `community-${index + 1}`)));
  const cyclicIds = new Set(cycles.flat());
  const boundaries = repositoryBoundaries(scan);
  const clusters = graph.clusters.map((cluster): ModuleCluster => ({
    ...cluster,
    role: dominantRole(cluster, roleByFile),
    communityId: communityByCluster.get(cluster.id),
    boundary: boundaries.find((boundary) => boundary.path === "." || cluster.files.some((file) => file === boundary.path || file.startsWith(`${boundary.path}/`))),
    metrics: {
      incoming: incoming.get(cluster.id) ?? 0,
      outgoing: outgoing.get(cluster.id) ?? 0,
      centrality: ((incoming.get(cluster.id) ?? 0) + (outgoing.get(cluster.id) ?? 0)) / maxDegree,
      entrypointReachable: reachableClusters.has(cluster.id),
      cyclic: cyclicIds.has(cluster.id)
    }
  }));
  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const rootFor = (cluster: ModuleCluster): string => {
    let current = cluster;
    while (current.parentClusterId && byId.has(current.parentClusterId)) current = byId.get(current.parentClusterId) as ModuleCluster;
    return current.id;
  };
  const boundaryEdges = graph.edges
    .filter((edge) => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      return source && target && rootFor(source) !== rootFor(target);
    })
    .map(({ source, target }) => ({ source, target }));
  const hubs = clusters.filter((cluster) => (cluster.metrics?.centrality ?? 0) >= 0.6).map((cluster) => cluster.id);
  const roleCounts: Partial<Record<FileRole, number>> = {};
  for (const file of scan.files) roleCounts[file.role ?? "production"] = (roleCounts[file.role ?? "production"] ?? 0) + 1;

  const withMetrics: ModuleGraph = {
    ...graph,
    clusters,
    insights: { stronglyConnectedComponents: cycles, dependencyCommunities: communities, hubs, boundaryEdges, repositoryBoundaries: boundaries, roleCounts }
  };
  const rootsContainingEntrypoints = new Set(clusters.filter((cluster) => cluster.tier === 1
    && cluster.files.some((file) => entrypoints.has(file)))
    .map((cluster) => cluster.id));
  const tierOne = clusters.filter((cluster) => cluster.tier === 1
    && !cluster.path.startsWith(".")
    && !cluster.path.startsWith("(")
    && (rootsContainingEntrypoints.has(cluster.id)
      || ["production", "migration", "mixed"].includes(cluster.role ?? "mixed")
      || (cluster.languages.length > 0 && !["test", "fixture", "generated", "docs", "tooling"].includes(cluster.role ?? "mixed"))))
    .map((cluster) => cluster.id);
  // System Context is a process/trust/deployable boundary view, not a duplicate
  // of every top-level functional area. When a provider emits many roots, retain
  // the roots with entrypoints and observed runtime contracts, then use
  // dependency centrality only as a deterministic tie-breaker.
  const systemScore = (clusterId: string): number => {
    const cluster = byId.get(clusterId);
    if (!cluster) return 0;
    const interactions = (cluster.interactions ?? []).filter(isArchitecturalBoundaryInteraction);
    return (cluster.files.some((file) => entrypoints.has(file) && isSystemEntrypoint(file, cluster)) ? 1_000 : 0)
      + (interactions.some((interaction) => ["http-route", "ipc-handle", "platform-host"].includes(interaction.kind)) ? 800 : 0)
      + (interactions.some((interaction) => ["http-call", "http-url", "ipc-send"].includes(interaction.kind)) ? 650 : 0)
      + Math.round((cluster.metrics?.centrality ?? 0) * 100)
      + (cluster.role === "production" ? 25 : 0);
  };
  const systemPool = clusters.filter((cluster) => cluster.tier === 1
    && !["test", "fixture", "generated", "asset", "docs", "tooling"].includes(cluster.role ?? "mixed"))
    .map((cluster) => cluster.id);
  const evidencedSystemBoundaries = systemPool.filter((clusterId) => {
    const cluster = byId.get(clusterId);
    return Boolean(cluster && (cluster.files.some((file) => entrypoints.has(file) && isSystemEntrypoint(file, cluster))
      || cluster.interactions?.some(isArchitecturalBoundaryInteraction)));
  });
  const systemCandidates = evidencedSystemBoundaries.length >= 2
    ? evidencedSystemBoundaries
    : [...new Set([...evidencedSystemBoundaries, ...systemPool, ...tierOne])];
  const system = systemCandidates
    .sort((leftId, rightId) => systemScore(rightId) - systemScore(leftId) || leftId.localeCompare(rightId))
    .slice(0, 6);
  const functionalSupportPath = /(?:^|\/)(?:l10n|locales?|models?|providers?|constants?|config|types?|tests?|ios|android|gradle|assets?|packages)(?:\/|$)/i;
  const functionalEligible = (cluster: ModuleCluster): boolean =>
    ["production", "migration", "mixed"].includes(cluster.role ?? "mixed")
    && !cluster.path.startsWith(".")
    && !functionalSupportPath.test(cluster.path);
  const functional: string[] = [];
  for (const root of clusters.filter((cluster) => cluster.tier === 1)) {
    const meaningfulChildren = clusters.filter((cluster) => cluster.parentClusterId === root.id
      && cluster.tier === 2
      && functionalEligible(cluster)
      && (cluster.files.length >= 2
        || cluster.files.some((file) => entrypoints.has(file))
        || Boolean(cluster.routes?.length)
        || Boolean(cluster.interactions?.length)
        || Boolean(cluster.catalogRef)));
    if (meaningfulChildren.length) functional.push(...meaningfulChildren.map((cluster) => cluster.id));
    else if (functionalEligible(root)) functional.push(root.id);
  }
  // Modules & Components is a navigable decomposition, not a flat leaf dump.
  // Keep the first two implementation tiers so roots open into focused subflows;
  // the canonical evidence flow retains deeper/file-level detail.
  const codeTier = Math.min(2, Number(graph.levels));
  const code = clusters
    .filter((cluster) => cluster.tier <= codeTier
      && !cluster.catalogItem && !cluster.catalogRef
      && !["asset", "generated", "fixture", "docs"].includes(cluster.role ?? "mixed"))
    .map((cluster) => cluster.id);
  const runtimeRelations = new Set(["calls", "runtime-load", "ipc", "http", "hosts", "shared-data"]);
  const runtimeSeeds = deepestMatches(new Set(clusters
    .filter((cluster) => hasRoleForArchitecture(cluster)
      && (cluster.files.some((file) => entrypoints.has(file))
        || Boolean(cluster.routes?.length)
        || Boolean(cluster.interactions?.some((interaction) => interaction.kind !== "event-publish" && interaction.kind !== "event-subscribe"))))
    .map((cluster) => cluster.id)), clusters);
  for (const edge of graph.edges) {
    if ((edge.relationKinds ?? []).some((kind) => runtimeRelations.has(kind)) || (edge.kinds ?? []).includes("dynamic")) {
      runtimeSeeds.add(edge.source);
      runtimeSeeds.add(edge.target);
    }
  }
  const runtime = [...runtimeSeeds].filter((id) => {
    const cluster = byId.get(id);
    return Boolean(cluster && hasRoleForArchitecture(cluster));
  });
  const uxPattern = /\b(ui|ux|frontend|client|screen|page|view|widget|route|router|navigation|dialog|modal|form|presenter|controller)\b/i;
  const uxSeeds = deepestMatches(new Set(clusters
    .filter((cluster) => hasRoleForArchitecture(cluster) && (Boolean(cluster.routes?.length) || uxPattern.test(clusterSearchText(cluster))))
    .map((cluster) => cluster.id)), clusters);
  const userJourneyRelations = new Set(["calls", "runtime-load", "ipc", "http", "hosts", "shared-data"]);
  const userJourney = connectedArchitectureSubjects(uxSeeds, withMetrics, clusters, (edge) =>
    (edge.relationKinds ?? []).some((kind) => userJourneyRelations.has(kind)) || (edge.kinds ?? []).includes("dynamic")
  );
  // Deliberately avoid generic terms such as "data" and "model". They routinely tag
  // static media, view models, and test data as persistence architecture.
  const dataPattern = /(?:^|[\/_\-.])(db|database|storage|stores?|state|repositories|persistence|entities|schemas?|migrations?|cache)(?:[\/_\-.]|$)|\b(database|storage|repository|persistence|schema|migration|sqlite|postgres|mysql|mongodb?|redis|prisma|sequelize|typeorm|coredata|firestore|dynamodb|realm|pinia|redux|mobx)\b/i;
  const dataSeeds = deepestMatches(new Set(clusters
    .filter((cluster) => hasRoleForArchitecture(cluster) && (cluster.role === "migration" || dataPattern.test(clusterSearchText(cluster))))
    .map((cluster) => cluster.id)), clusters);
  const durableDataSeeds = new Set([...dataSeeds].filter((clusterId) => {
    const cluster = byId.get(clusterId);
    return Boolean(cluster && clusterHasDurablePersistenceEvidence(cluster));
  }));
  const hasDurableData = durableDataSeeds.size > 0;
  const dataOperationPattern = /\b(read|write|save|load|query|insert|update|delete|persist|hydrate|sync|cache|repository|store|database|transaction|migration)\w*/i;
  const meaningfulDataEdge = (edge: ModuleGraph["edges"][number]): boolean =>
    (edge.relationKinds ?? []).includes("shared-data")
    || dataOperationPattern.test([...(edge.importedNames ?? []), ...(edge.evidence ?? []).map((item) => item.specifier)].join(" "));
  const data = connectedArchitectureSubjects(dataSeeds, withMetrics, clusters, (edge) =>
    (dataSeeds.has(edge.source) || dataSeeds.has(edge.target)) && meaningfulDataEdge(edge)
  );
  const infrastructurePattern = /(?:^|[\/_\-.])(infra|infrastructure|deploy|deployment|docker|kubernetes|k8s|helm|terraform|pulumi|cloudformation|serverless|wrangler|cloudflare|nginx|gateway|ci|cd)(?:[\/_\-.]|$)|\b(aws|azure|gcp|firebase|vercel|netlify|load.?balancer)\b/i;
  const infrastructureSeeds = deepestMatches(new Set(clusters
    .filter((cluster) => !["test", "fixture", "generated", "asset", "docs"].includes(cluster.role ?? "mixed")
      && infrastructurePattern.test(clusterSearchText(cluster)))
    .map((cluster) => cluster.id)), clusters);
  const infrastructure = connectedArchitectureSubjects(infrastructureSeeds, withMetrics, clusters, (edge) => infrastructureSeeds.has(edge.source) || infrastructureSeeds.has(edge.target));
  const health = [...new Set([...cyclicIds, ...hubs])];
  const projections = [
    projection("system", "System Context", "What are the major systems and boundaries?", "Top-level process, trust, deployable, and repository boundaries; internal functional areas remain in their dedicated lenses.", ["entrypoints", "runtime and trust boundaries", "repository manifests", "top-level hierarchy"], "high", system, withMetrics),
    projection("functional", "Product Capabilities", "What does the product do, and where are those responsibilities owned?", "Production responsibilities with support-only material de-emphasized.", ["production file roles", "functional clustering", "symbols", "source-observed behavioral contracts"], "medium", functional, withMetrics),
    ...(userJourney.length ? [projection("user-journey", "User Journeys & UX", "How do user-facing routes and interactions traverse the system?", "Route- and UI-bearing components with their direct production collaborators. This is code-observed interaction structure, not a claimed product specification.", ["routes", "UI symbols and paths", "direct dependencies", "ordered source-observed behavioral contracts"], "exploratory", userJourney, withMetrics)] : []),
    ...(runtime.length ? [projection("runtime", "Runtime & Integration Flows", "What executes, calls, hosts, or communicates at runtime?", "Entrypoints and evidence-bearing runtime relationships such as calls, dynamic loads, IPC, HTTP, and platform hosting.", ["entrypoints", "runtime relation kinds", "routes and interactions"], "medium", runtime, withMetrics, (edge) => (edge.relationKinds ?? []).some((kind) => runtimeRelations.has(kind)) || (edge.kinds ?? []).includes("dynamic"))] : []),
    ...(data.length ? [projection(
      "data",
      hasDurableData ? "Data Ownership & Persistence" : "Data Ownership & Runtime State",
      hasDurableData ? "Where is data owned, transformed, stored, and migrated?" : "Where is runtime data owned, transformed, and passed through the system?",
      hasDurableData
        ? "Persistence-bearing components and evidence-backed read, write, synchronization, and migration collaborators."
        : "Evidence-backed transient state, data concepts, transformations, and movement. No durable persistence sink was observed in this repository.",
      hasDurableData
        ? ["storage and schema signals", "migrations", "named data operations and shared-data contracts"]
        : ["application-state signals", "named data operations", "no durable persistence sink observed"],
      "medium",
      data,
      withMetrics,
      (edge) => (dataSeeds.has(edge.source) || dataSeeds.has(edge.target)) && meaningfulDataEdge(edge)
    )] : []),
    ...(infrastructure.length ? [projection("infrastructure", "Cloud & Infrastructure", "How is the system deployed, hosted, and connected to managed infrastructure?", "Deployment, cloud, container, gateway, and delivery components detected in the repository.", ["infrastructure paths and symbols", "cloud dependencies", "deployment configuration"], "medium", infrastructure, withMetrics, (edge) => infrastructureSeeds.has(edge.source) || infrastructureSeeds.has(edge.target))] : []),
    projection("code", "Modules & Components", "How is the implementation decomposed?", "Top-level implementation areas with module/component drill-downs and their static dependencies.", ["hierarchical file membership", "symbols", "static imports"], "high", code, withMetrics),
    projection("dependency-health", "Dependency Health", "Where are coupling, hubs, and cycles likely to make change risky?", "High-coupling hubs and cyclic dependency groups; an engineering risk lens, not a defect claim.", ["dependency centrality", "strongly connected components"], "high", health, withMetrics)
  ];
  for (const item of projections) {
    if (item.id === "functional" || item.id === "user-journey" || item.id === "data") item.behavioralContracts = graph.behavioralContracts ?? [];
  }
  for (const item of projections) {
    item.subjectEvidence = subjectEvidence(item.clusterIds, clusters, (cluster) => {
      if (item.id === "system") return [cluster.boundary ? `repository boundary: ${cluster.boundary.manifest}` : "top-level code boundary"];
      if (item.id === "functional") return [`${cluster.role ?? "mixed"} responsibility`, cluster.symbols.length ? `${cluster.symbols.length} exported symbols` : "file ownership"];
      if (item.id === "user-journey") return [uxSeeds.has(cluster.id) ? (cluster.routes?.length ? `routes: ${cluster.routes.join(", ")}` : "UI or interaction signal") : "direct user-journey collaborator", cluster.interactions?.length ? `${cluster.interactions.length} runtime interactions` : ""];
      if (item.id === "runtime") return [cluster.files.some((file) => entrypoints.has(file)) ? "entrypoint" : "", cluster.interactions?.length ? `${cluster.interactions.length} runtime interactions` : "runtime contract endpoint"];
      if (item.id === "data") return [dataSeeds.has(cluster.id)
        ? (cluster.role === "migration" ? "migration" : clusterHasDurablePersistenceEvidence(cluster) ? "durable storage/schema signal" : "transient application-state signal")
        : hasDurableData ? "direct persistence collaborator" : "direct runtime-state collaborator"];
      if (item.id === "infrastructure") return [infrastructureSeeds.has(cluster.id) ? (cluster.boundary ? `manifest: ${cluster.boundary.manifest}` : "deployment/infrastructure signal") : "direct infrastructure collaborator"];
      if (item.id === "dependency-health") return [cluster.metrics?.cyclic ? "dependency cycle member" : "", (cluster.metrics?.centrality ?? 0) >= 0.6 ? `high centrality ${(cluster.metrics?.centrality ?? 0).toFixed(2)}` : ""];
      return [`${cluster.files.length} owned files`, cluster.symbols.length ? `${cluster.symbols.length} exported symbols` : "static dependency evidence"];
    });
  }
  withMetrics.projections = projections;
  return withMetrics;
}
