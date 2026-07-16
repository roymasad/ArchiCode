import { nodeVisualShapeSchema, type CodebaseMappingGranularity } from "../../shared/schema";
import pLimit from "p-limit";
import { humanizeSegment, slugForClusterPath } from "./aggregate";
import { architectureLensEdgeSchema, architectureLensNodeSchema, architectureLensPlanSchema, architectureNodeSchema, architectureSpecSchema, lensPlanQualityIssues, sanitizedLensPlans, transformArchitecture, type ArchitectureSpec } from "./organize";
import { compareArchitectureCandidates } from "./quality";
import type { LensCompilationDiagnostics } from "./lensFlows";
import type { ContentInventory } from "./inventory";
import type {
  CodebaseImportDetail,
  CodebaseImportProviderCallOptions,
  CodebaseImportLevels,
  FileDependencyGraph,
  ArchitectureLensPlan,
  ImportAnnotationCluster,
  ImportAnnotations,
  ModuleGraph,
  ParsedFile,
  RepoScan
} from "./types";

type MapperInput = {
  projectRoot: string;
  moduleGraph: ModuleGraph;
  scan: RepoScan;
  parsed: ParsedFile[];
  fileGraph: FileDependencyGraph;
  inventory: ContentInventory;
  levels: CodebaseImportLevels;
  detail: CodebaseImportDetail;
  granularity: CodebaseMappingGranularity;
  codebaseHints: string[];
  callProvider: (prompt: string, options?: CodebaseImportProviderCallOptions) => Promise<string>;
  onProgress?: (label: string, detail?: string) => void;
};

export type ImportArchitectureValidationDiagnostics = {
  attempts: number;
  architectureNodesRetained: number;
  architectureNodesDropped: number;
  lensIdsRetained: ArchitectureLensPlan["id"][];
  missingLensIds: ArchitectureLensPlan["id"][];
  lensNodesDropped: number;
  lensEdgesDropped: number;
  invalidOptionalFieldsIgnored: number;
  providerConfidenceFieldsIgnored: number;
  repairKind?: "architecture" | "lenses";
  canonicalRefinements?: string[];
  issues: string[];
};

type MapperResult = {
  annotations: ImportAnnotations | null;
  analysis: string;
  lensPlans?: ArchitectureLensPlan[];
  degraded?: string;
  /** Present when the LLM successfully organized a functional hierarchy; replaces the folder-based graph. */
  organizedGraph?: ModuleGraph;
  /** False when only project/lens content was salvaged onto the deterministic hierarchy. */
  allowHierarchicalRefinement?: boolean;
  diagnostics?: ImportArchitectureValidationDiagnostics;
};

const MAX_ATOM_FILES = 800;
const MAX_GROUND_TRUTH_CHARS = 180_000;
const MAX_REPAIR_GROUND_TRUTH_CHARS = 72_000;

const GRANULARITY_PITCH: Record<CodebaseMappingGranularity, string> = {
  system: "big-picture systems: describe business purpose and system boundaries, not code details",
  module: "modules and packages: describe each module's responsibility and its role in the product",
  component: "components inside modules: describe concrete responsibilities, key abstractions, and collaborators",
  file: "individual files: describe what each file implements and why it exists"
};

function groundTruthJson(input: MapperInput, options: { repair?: boolean } = {}): string {
  const codeFiles = input.parsed.filter((file) => !file.parseError);
  const parsedPaths = new Set(input.parsed.map((file) => file.relPath));
  const scanByPath = new Map(input.scan.files.map((file) => [file.relPath, file]));
  const degree = new Map<string, number>();
  for (const edge of input.fileGraph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + (edge.occurrences ?? 1));
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + (edge.occurrences ?? 1));
  }
  const entrypoints = new Set(input.inventory.entrypoints);
  const rankedCodeFiles = [...codeFiles].sort((a, b) => {
    const score = (file: ParsedFile): number => (degree.get(file.relPath) ?? 0) + (entrypoints.has(file.relPath) ? 100 : 0) + (scanByPath.get(file.relPath)?.role === "production" ? 10 : 0);
    return score(b) - score(a) || b.loc - a.loc;
  });
  const atoms = rankedCodeFiles.slice(0, MAX_ATOM_FILES).map((file) => ({
    p: file.relPath,
    loc: file.loc,
    role: scanByPath.get(file.relPath)?.role,
    sym: file.symbols.slice(0, 8),
    semantic: (file.semanticSymbols ?? []).slice(0, 12).map((symbol) => ({ name: symbol.name, kind: symbol.kind, parent: symbol.parentName }))
  }));
  const otherFiles = input.scan.files.filter((file) => !(file.detectedLanguage ?? file.language)).map((file) => file.relPath);
  const structuralFallbackFiles = input.scan.files
    .filter((file) => file.detectedLanguage && !parsedPaths.has(file.relPath))
    .slice(0, MAX_ATOM_FILES)
    .map((file) => ({ p: file.relPath, language: file.detectedLanguage, role: file.role, bytes: file.sizeBytes }));
  const dirEdges = [...input.moduleGraph.edges].sort((a, b) => (b.occurrences ?? b.importCount) - (a.occurrences ?? a.importCount)).slice(0, 160).map((edge) => ({
    from: input.moduleGraph.clusters.find((cluster) => cluster.id === edge.source)?.path ?? edge.source,
    to: input.moduleGraph.clusters.find((cluster) => cluster.id === edge.target)?.path ?? edge.target,
    imports: edge.importCount,
    occurrences: edge.occurrences,
    kinds: edge.kinds,
    relations: edge.relationKinds,
    importedNames: edge.importedNames,
    evidence: edge.evidence?.slice(0, 4)
  }));
  const groundTruth = {
    files: atoms,
    filesTruncated: codeFiles.length > atoms.length,
    structuralFallbackFiles,
    structuralFallbackTruncated: (input.scan.stats.structuralFallbackFiles ?? 0) > structuralFallbackFiles.length,
    fileCount: input.scan.stats.totalFiles,
    otherFiles: otherFiles.length <= 120 ? otherFiles : otherFiles.slice(0, 120),
    directoryImportEdges: dirEdges,
    catalogs: input.inventory.catalogs.map((catalog) => ({
      file: catalog.file,
      itemRefFormat: `${catalog.file}::<key> or ${catalog.file}::*`,
      items: catalog.items.map((item) => ({ key: item.key, title: item.title, note: item.note }))
    })),
    routes: input.inventory.routes,
    interactions: input.inventory.interactions,
    entrypoints: input.inventory.entrypoints,
    dependencyInsights: input.moduleGraph.insights,
    architectureLenses: (input.moduleGraph.projections ?? []).map((projection) => ({
      id: projection.id,
      title: projection.title,
      question: projection.question,
      confidence: projection.confidence,
      evidenceBasis: projection.evidenceBasis,
      candidatePaths: projection.clusterIds
        .map((clusterId) => input.moduleGraph.clusters.find((cluster) => cluster.id === clusterId)?.path)
        .filter(Boolean)
        .slice(0, 40)
    })),
    semanticRelationships: (input.moduleGraph.semanticLinks ?? []).slice(0, 160),
    architectureCandidates: input.moduleGraph.clusters.map((cluster) => ({
      id: cluster.id,
      path: cluster.path,
      level: cluster.tier,
      role: cluster.role,
      boundary: cluster.boundary,
      community: cluster.communityId,
      centrality: cluster.metrics?.centrality,
      entrypointReachable: cluster.metrics?.entrypointReachable,
      routes: cluster.routes,
      interactions: cluster.interactions,
      topFiles: cluster.topFiles,
      symbols: cluster.symbols
    })),
    architectureDocuments: input.inventory.architectureDocuments ?? [],
    behavioralEvidenceHotspots: input.inventory.evidenceHotspots ?? [],
    behavioralContracts: input.inventory.behavioralContracts ?? [],
    folderGroupingHint: input.moduleGraph.clusters
      .filter((cluster) => !cluster.catalogItem && !cluster.catalogRef)
      .map((cluster) => ({ path: cluster.path, level: cluster.tier, fileCount: cluster.files.length }))
  };
  const full = JSON.stringify(groundTruth);
  const budget = options.repair ? MAX_REPAIR_GROUND_TRUTH_CHARS : MAX_GROUND_TRUTH_CHARS;
  if (!options.repair && full.length <= budget) return full;

  const interactionIndex = new Map((groundTruth.interactions ?? []).map((interaction, index) => [
    `${interaction.file}\0${interaction.kind}\0${interaction.target}\0${interaction.method ?? ""}`,
    index
  ]));
  const compact: Record<string, unknown> = {
    ...groundTruth,
    promptBudget: {
      maxChars: budget,
      originalChars: full.length,
      compacted: true,
      omittedSectionsRepresentTruncationNotAbsence: true
    },
    files: groundTruth.files.slice(0, options.repair ? 280 : 600),
    filesTruncated: groundTruth.filesTruncated || groundTruth.files.length > (options.repair ? 280 : 600),
    structuralFallbackFiles: groundTruth.structuralFallbackFiles.slice(0, options.repair ? 60 : 180),
    directoryImportEdges: groundTruth.directoryImportEdges.slice(0, options.repair ? 90 : 160),
    architectureCandidates: groundTruth.architectureCandidates.slice(0, options.repair ? 80 : 180).map((candidate) => ({
      ...candidate,
      interactions: undefined,
      interactionRefs: (candidate.interactions ?? []).flatMap((interaction) => {
        const index = interactionIndex.get(`${interaction.file}\0${interaction.kind}\0${interaction.target}\0${interaction.method ?? ""}`);
        return index === undefined ? [] : [index];
      }),
      topFiles: candidate.topFiles.slice(0, 5),
      symbols: candidate.symbols.slice(0, options.repair ? 6 : 12)
    })),
    semanticRelationships: options.repair ? [] : groundTruth.semanticRelationships.slice(0, 80),
    folderGroupingHint: groundTruth.folderGroupingHint.slice(0, options.repair ? 80 : 180),
    architectureDocuments: options.repair ? groundTruth.architectureDocuments.slice(0, 6) : groundTruth.architectureDocuments,
    behavioralEvidenceHotspots: groundTruth.behavioralEvidenceHotspots.slice(0, options.repair ? 14 : 24),
    behavioralContracts: groundTruth.behavioralContracts.slice(0, options.repair ? 20 : 40)
  };
  let serialized = JSON.stringify(compact);
  const shrinkArray = (key: string, floor: number): boolean => {
    const value = compact[key];
    if (!Array.isArray(value) || value.length <= floor) return false;
    compact[key] = value.slice(0, Math.max(floor, Math.floor(value.length * 0.65)));
    return true;
  };
  while (serialized.length > budget) {
    const changed = shrinkArray("files", 60)
      || shrinkArray("architectureCandidates", 24)
      || shrinkArray("directoryImportEdges", 30)
      || shrinkArray("behavioralEvidenceHotspots", 8)
      || shrinkArray("behavioralContracts", 8)
      || shrinkArray("structuralFallbackFiles", 20)
      || shrinkArray("architectureDocuments", 2)
      || shrinkArray("semanticRelationships", 0)
      || shrinkArray("folderGroupingHint", 24)
      || shrinkArray("otherFiles", 20);
    if (!changed) break;
    serialized = JSON.stringify(compact);
  }
  return serialized;
}

function organizePrompt(input: MapperInput): string {
  const totalLevels = Number(input.levels);
  return [
    "You are the architect for a visual map of an existing repository. Deterministic analysis already extracted the ground truth below: every code file (with its exported symbols), real import relationships between directories, detected catalogs/registries with their items, and entrypoints.",
    "Design an ENGINEERING ARCHITECTURE ATLAS of this product as a hierarchy of named nodes. Group by what things do and mean — systems, product capabilities, user journeys, runtime/integration paths, data ownership, infrastructure, modules, and components — not by mirroring folder nesting. The folder grouping is provided only as a hint.",
    "The importer will persist one evidence-backed code-structure hierarchy plus separate first-class perspective flows for the supplied architectureLenses. Every repeated code subject in those flows is joined back to the same canonical evidence identity. Your job is to organize and name the evidence subjects well enough that each derived flow is useful; do not duplicate subjects inside this hierarchy or pretend every repository contains every kind of flow.",
    "",
    "Hard rules:",
    `- The hierarchy is at most ${totalLevels} level${totalLevels === 1 ? "" : "s"} deep (root nodes have parentId null).`,
    "- Every node claims its files via \"members\": directory prefixes ending in \"/\" (preferred) and/or exact file paths. Deeper/more exact claims win. Together the architecture should cover the whole repository; unclaimed files will be auto-assigned.",
    "- Do NOT invent files, directories, or dependencies. Edges between nodes are derived automatically from real import statements of the files you assign; you cannot create edges.",
    "- semanticRelationships are meaning-based discovery hints only. Use them to notice possible functional affinity, but never let them override file membership, exported symbols, real imports, routes, entrypoints, or dependency insights, and never treat them as proof of a dependency.",
    "- Make root subjects read as system/deployable boundaries, then organize coherent responsibility drill-downs. The importer derives independent product/UX, runtime/integration, data, infrastructure, module/component, and dependency-health flows from the same subjects. Never manufacture a cloud, database, UX, or runtime subject merely to fill a category.",
    "- Canonical boundary integrity: never combine code that executes in different processes/trust zones or combines an external-facing server/worker/IPC boundary with browser/mobile UI state merely because it shares a package, feature, or request path. Give independently deployable/runtime responsibilities separate canonical subjects; keep shared utilities beneath the boundary that owns them.",
    "- Each parent with children must open into a coherent engineering question, not a miscellaneous folder dump. Its children should collectively explain a capability, deployable boundary, or implementation decomposition; cross-cutting request paths and data lifecycles will be assembled as separate perspective flows.",
    "- Catalog items are real product content: place them with \"catalogItems\" refs (\"<file>::*\" for all of a catalog's items, or individual \"<file>::<key>\" refs) under the node that owns that content. Give catalog-owning nodes meaningful names.",
    `- Write at the level of ${GRANULARITY_PITCH[input.granularity]}.`,
    "- The \"description\" field is the node's source of truth for coding agents. Scale its depth to the complexity of what the node covers. For complex nodes write 3-8 sentences packed with anchored facts from the ground truth — concrete file paths, exported symbols, responsibilities, data flow, invariants, and how it collaborates with its neighbors. Distinguish direct observations (files, symbols, routes, imports, runtime contracts) from architectural interpretation; do not present inferred intent as proven behavior. Simple nodes can stay at 1-2 sentences. Never pad with generic filler and never use vague briefing language (\"such as\", \"etc\", \"various\", \"and more\").",
    "- acceptanceCriteria: 2-4 concrete verifiable checks per node. techStack: real technologies visible in that node's files.",
    `- visual.shape ∈ {${nodeVisualShapeSchema.options.join(", ")}}; use shape semantics (database = data/storage, document = docs/content, hexagon = services/entrypoints, note = catalogs). visual.backgroundColor is #RRGGBB; encode functional domains with consistent colors.`,
    "- groupName: optional visual grouping label shared by related sibling nodes.",
    "- Nested nodes become drill-down detail flows automatically: a parent node with children can be opened to reveal them. Every detail flow should tell a useful engineering story at that zoom (responsibilities and their meaningful relationships), while simple nodes stay flat.",
    "- Zoom coherence: a child's title must never restate its parent's (no \"Progress & Export\" parent containing \"Progress & Export Services\"); opening a node must reveal distinctly named parts. Sibling titles must be distinguishable at a glance — never two siblings whose names differ only by one abstract word.",
    "- Layering: UI dialogs, prompts, and widgets belong with the feature they serve, never inside persistence, configuration, or platform-service nodes.",
    "- Also author lens-specific mental models in lenses. These are not alternate code graphs: each interpretive node must cite real evidenceMembers (exact repository files or directory prefixes) that resolve back to canonical code subjects. contextOnly is allowed only for actors or explanatory boundary notes.",
    "- Treat behavioralEvidenceHotspots as routed evidence: use route/UI/state snippets for journeys, human-facing rules and domain vocabulary for Product Capabilities, runtime contracts for Runtime/Infrastructure, and state/schema/read-write snippets for Data. They supplement—not override—file membership and observed relationships.",
    "- behavioralContracts with evidenceMode=declared come from prompts, policies, prose rules, or configured dialogue. They prove that the repository declares an intended behavior, but do NOT prove a database write, durable persistence, submitted order, registered rating, completed payment, deployed resource, external side effect, embedded catalog, or other implementation outcome.",
    "- Claim durable storage or completed external effects only when ground truth contains a concrete matching sink/channel such as a database/repository/schema/migration, shared write, matching HTTP/IPC/event operation, or catalog item. A generic application store/state module is transient unless stronger evidence proves otherwise.",
    "- Return a lenses object for every supplied architectureLenses entry whose id is functional, user-journey, data, or infrastructure. The importer requested only lenses for which deterministic evidence was detected.",
    "- Product Capabilities must be written as user/business value (what the product lets someone accomplish), not folders, screens, providers, widgets, or technical layers. A capability may anchor to files across several folders.",
    "- Product coverage must include each distinct user-visible/domain outcome evidenced by routes, UI actions, catalogs, long human-facing rules/prompts, or state actions. Do not reduce the product to its transport mechanism when domain behavior is present.",
    "- User Journeys must be ordered actor/trigger/step/decision/outcome flows. Arrows describe what happens next, never generic imports or dependencies.",
    "- Data must distinguish owners, transient application state, durable stores, entities, reads/writes, transformations, migrations, and synchronization. Do not include UI/localization merely because it depends on a data-bearing module. If no durable sink exists, describe runtime state honestly instead of inventing persistence.",
    "- Infrastructure must connect source/build automation to deployable artifacts, hosting/runtime targets, managed resources, and external boundaries when repository declarations prove them. Do not invent live cloud state.",
    "- Omit a data or infrastructure lens when the repository evidence does not support one. Keep each emitted lens to 3-12 high-value nodes and use concrete verb-phrase edges.",
    "- edgeLabels: optional labels for dependencies you expect between your nodes (referencing your node ids); labels for edges that don't materialize are dropped. Every label must be a complete verb phrase — never end on a preposition or conjunction.",
    input.codebaseHints.length ? `Detected stack hints: ${input.codebaseHints.join(", ")}.` : "",
    "",
    "The immutable deterministic ground truth is supplied separately as cacheable stable context. Treat it as part of this request.",
    "",
    "Respond with ONLY this JSON envelope:",
    "```json",
    JSON.stringify({
      archicodeImport: {
        analysis: "2-4 sentences: what this codebase is and how it is organized.",
        projectNode: { title: "Product name", description: "…", techStack: ["…"], acceptanceCriteria: ["…"], visual: { shape: "hexagon" } },
        architecture: [
          { id: "core-domain", parentId: null, title: "<functional area name>", type: "system", description: "…", techStack: ["…"], acceptanceCriteria: ["…"], visual: { backgroundColor: "#4f83cc", shape: "rounded" }, groupName: "<optional group>", members: ["<dir>/"], catalogItems: [] },
          { id: "content-catalog", parentId: "core-domain", title: "<catalog name>", type: "catalog", description: "…", techStack: ["…"], acceptanceCriteria: ["…"], visual: { shape: "note" }, members: ["<file>"], catalogItems: ["<file>::*"] }
        ],
        lenses: [
          {
            id: "functional",
            nodes: [
              { id: "create-work", title: "Create and Manage Work", type: "capability", description: "The user-facing outcome grounded in the cited implementation.", evidenceMembers: ["src/features/work/"], groupName: "Core Product" },
              { id: "share-work", title: "Share Work", type: "capability", description: "The sharing outcome grounded in its cited implementation.", evidenceMembers: ["src/features/sharing/"] },
              { id: "track-progress", title: "Track Progress", type: "capability", description: "The progress outcome grounded in its cited implementation.", evidenceMembers: ["src/features/progress/"] }
            ],
            edges: [{ source: "create-work", target: "share-work", label: "makes work available to share" }]
          },
          {
            id: "user-journey",
            nodes: [
              { id: "person", title: "Person", type: "actor", description: "The product user who initiates the observed route.", evidenceMembers: [], contextOnly: true },
              { id: "start-work", title: "Starts Work", type: "journey-step", description: "The first source-observed interaction step.", evidenceMembers: ["src/features/work/start.ts"] }
            ],
            edges: [{ source: "person", target: "start-work", label: "starts the journey by" }]
          }
        ],
        edgeLabels: [{ source: "core-domain", target: "content-catalog", label: "…" }],
        summary: "One-line description of the map."
      }
    }, null, 2),
    "```"
  ].filter((line) => line !== "").join("\n");
}

function canonicalRuntimeBoundaryRefinement(spec: ArchitectureSpec, input: MapperInput): { spec: ArchitectureSpec; refinements: string[] } {
  const transformed = transformArchitecture({
    spec,
    scan: input.scan,
    parsed: input.parsed,
    fileGraph: input.fileGraph,
    inventory: input.inventory,
    levels: input.levels,
    detail: input.detail,
    granularity: input.granularity,
    semanticLinks: input.moduleGraph.semanticLinks
  });
  if (!transformed) return { spec, refinements: [] };
  const boundaryFiles = new Set(input.inventory.interactions
    .filter((interaction) => ["http-route", "ipc-handle", "platform-host"].includes(interaction.kind) && (interaction.confidence ?? 1) >= 0.9)
    .map((interaction) => interaction.file));
  const clientResponsibility = /(?:^|\/)(?:ui|view|views|screen|screens|page|pages|component|components|widget|widgets|store|stores|state)(?:\/|\.)/i;
  const refinements: string[] = [];
  let architecture = [...spec.architecture];
  const usedIds = new Set(architecture.map((node) => node.id));
  for (const cluster of transformed.moduleGraph.clusters) {
    const ownedFiles = cluster.ownedFiles ?? [];
    const ownedBoundaryFiles = ownedFiles.filter((file) => boundaryFiles.has(file));
    const ownedClientFiles = ownedFiles.filter((file) => clientResponsibility.test(file));
    if (!ownedBoundaryFiles.length || !ownedClientFiles.length) continue;
    const nodeIndex = architecture.findIndex((node) => `cluster-${slugForClusterPath(node.id).replace(/^cluster-/, "")}` === cluster.id);
    if (nodeIndex < 0) continue;
    const original = architecture[nodeIndex];
    const boundaryFileSet = new Set(ownedBoundaryFiles);
    let splitId = `${original.id}-runtime-boundary`;
    let suffix = 2;
    while (usedIds.has(splitId)) splitId = `${original.id}-runtime-boundary-${suffix++}`;
    usedIds.add(splitId);
    const interactions = input.inventory.interactions.filter((interaction) => boundaryFileSet.has(interaction.file));
    const observedContracts = [...new Set(interactions.map((interaction) => `${interaction.kind}:${interaction.target}`))].slice(0, 8);
    const boundaryStem = ownedBoundaryFiles.length === 1
      ? ownedBoundaryFiles[0].split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Request"
      : "Request";
    architecture[nodeIndex] = {
      ...original,
      members: original.members.filter((member) => !boundaryFileSet.has(member.replace(/^\.\//, "")))
    };
    architecture.push(architectureNodeSchema.parse({
      id: splitId,
      parentId: original.parentId ?? null,
      title: `${humanizeSegment(boundaryStem)} Runtime Boundary`,
      type: "system",
      description: `${ownedBoundaryFiles.join(", ")} implement an independently evidenced runtime/trust boundary (${observedContracts.join(", ") || "request handling"}). It is kept separate from client UI or application-state code even when both responsibilities share a package or feature path.`,
      techStack: [],
      acceptanceCriteria: observedContracts.slice(0, 4).map((contract) => `${contract} remains implemented by this runtime boundary.`),
      visual: { shape: "hexagon" },
      groupName: original.groupName,
      members: ownedBoundaryFiles,
      catalogItems: []
    }));
    refinements.push(`Split ${ownedBoundaryFiles.join(", ")} from client responsibility files ${ownedClientFiles.join(", ")} in ${original.title}; independently evidenced runtime/trust boundaries cannot share one canonical subject.`);
  }
  return refinements.length
    ? { spec: architectureSpecSchema.parse({ ...spec, architecture }), refinements }
    : { spec, refinements };
}

function extractEnvelope(raw: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/g) ?? [];
  for (const block of fenced) {
    candidates.push(block.replace(/```(?:json)?\s*/, "").replace(/```\s*$/, ""));
  }
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const envelope = (parsed.archicodeImport ?? parsed) as Record<string, unknown>;
      if (envelope && typeof envelope === "object" && ["projectNode", "architecture", "lenses", "clusters"].some((key) => key in envelope)) return envelope;
    } catch {
      continue;
    }
  }
  return null;
}

type ParsedArchitectureResponse = {
  spec: ArchitectureSpec | null;
  diagnostics: ImportArchitectureValidationDiagnostics;
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textArray(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, limit)
    : [];
}

function projectNodeFromEnvelope(envelope: Record<string, unknown>): ArchitectureSpec["projectNode"] {
  const project = objectRecord(envelope.projectNode) ?? {};
  const visual = objectRecord(project.visual);
  return {
    title: typeof project.title === "string" ? project.title.trim() : "",
    description: typeof project.description === "string" ? project.description.trim() : "",
    techStack: textArray(project.techStack, 20),
    acceptanceCriteria: textArray(project.acceptanceCriteria, 12),
    ...(visual ? { visual: {
      ...(typeof visual.backgroundColor === "string" ? { backgroundColor: visual.backgroundColor } : {}),
      ...(typeof visual.shape === "string" ? { shape: visual.shape } : {})
    } } : {})
  };
}

function architectureScore(spec: ArchitectureSpec): number {
  return spec.architecture.reduce((score, node) => score
    + 4
    + Math.min(4, node.members.length)
    + (node.description.trim().length >= 40 ? 2 : 0)
    + (node.parentId ? 1 : 0), 0);
}

function lensScore(plan: ArchitectureLensPlan): number {
  return plan.nodes.length * 4 + plan.edges.length * 2 + plan.nodes.filter((node) => node.contextOnly).length;
}

function mergeArchitectureSpecs(primary: ArchitectureSpec, repair: ArchitectureSpec): ArchitectureSpec {
  const architectureOwner = architectureScore(repair) > architectureScore(primary) ? repair : primary;
  const accepted = [...sanitizedLensPlans(primary), ...sanitizedLensPlans(repair)];
  const bestLens = new Map<ArchitectureLensPlan["id"], ArchitectureLensPlan>();
  for (const lens of accepted) {
    const current = bestLens.get(lens.id);
    if (!current || lensScore(lens) > lensScore(current)) bestLens.set(lens.id, lens);
  }
  const projectOwner = (repair.projectNode.description.length + repair.projectNode.techStack.length * 12)
    > (primary.projectNode.description.length + primary.projectNode.techStack.length * 12) ? repair : primary;
  const edgeLabels = new Map<string, ArchitectureSpec["edgeLabels"][number]>();
  for (const edge of [...architectureOwner.edgeLabels, ...(architectureOwner === primary ? repair.edgeLabels : primary.edgeLabels)]) {
    edgeLabels.set(`${edge.source}\0${edge.target}`, edge);
  }
  return architectureSpecSchema.parse({
    ...architectureOwner,
    analysis: architectureOwner.analysis || projectOwner.analysis,
    projectNode: projectOwner.projectNode,
    lenses: [...bestLens.values()],
    edgeLabels: [...edgeLabels.values()],
    summary: architectureOwner.summary || projectOwner.summary
  });
}

export function parseArchitectureResponse(raw: string, requiredLensIds: ArchitectureLensPlan["id"][] = []): ParsedArchitectureResponse {
  const envelope = extractEnvelope(raw);
  const emptyDiagnostics: ImportArchitectureValidationDiagnostics = {
    attempts: 1,
    architectureNodesRetained: 0,
    architectureNodesDropped: 0,
    lensIdsRetained: [],
    missingLensIds: [...requiredLensIds],
    lensNodesDropped: 0,
    lensEdgesDropped: 0,
    invalidOptionalFieldsIgnored: 0,
    providerConfidenceFieldsIgnored: 0,
    issues: []
  };
  if (!envelope) return { spec: null, diagnostics: { ...emptyDiagnostics, issues: ["Response did not contain a parseable archicodeImport JSON object."] } };

  let invalidOptionalFieldsIgnored = 0;
  const rawArchitecture = Array.isArray(envelope.architecture) ? envelope.architecture : [];
  const architecture = rawArchitecture.slice(0, 96).flatMap((candidate) => {
    const value = objectRecord(candidate);
    if (!value || typeof value.id !== "string" || !value.id.trim() || typeof value.title !== "string" || !value.title.trim()) return [];
    const strings = (field: string, limit: number): string[] => {
      const raw = value[field];
      if (raw === undefined) return [];
      if (!Array.isArray(raw)) {
        invalidOptionalFieldsIgnored += 1;
        return [];
      }
      const retained = raw.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, limit);
      invalidOptionalFieldsIgnored += raw.length - retained.length;
      return retained;
    };
    const visual = objectRecord(value.visual);
    if (value.visual !== undefined && !visual) invalidOptionalFieldsIgnored += 1;
    const parentId = value.parentId === null || typeof value.parentId === "string" ? value.parentId : undefined;
    if (value.parentId !== undefined && parentId === undefined) invalidOptionalFieldsIgnored += 1;
    const parsed = architectureNodeSchema.safeParse({
      id: value.id.trim(),
      parentId,
      title: value.title.trim(),
      type: typeof value.type === "string" ? value.type.trim() : "",
      description: typeof value.description === "string" ? value.description.trim() : "",
      techStack: strings("techStack", 20),
      acceptanceCriteria: strings("acceptanceCriteria", 12),
      ...(visual ? { visual: {
        ...(typeof visual.backgroundColor === "string" ? { backgroundColor: visual.backgroundColor } : {}),
        ...(typeof visual.shape === "string" ? { shape: visual.shape } : {})
      } } : {}),
      ...(typeof value.groupName === "string" && value.groupName.trim() ? { groupName: value.groupName.trim() } : {}),
      members: strings("members", 120),
      catalogItems: strings("catalogItems", 120)
    });
    return parsed.success ? [parsed.data] : [];
  });
  const rawLenses = Array.isArray(envelope.lenses) ? envelope.lenses : [];
  let lensNodesDropped = 0;
  let lensEdgesDropped = 0;
  let providerConfidenceFieldsIgnored = 0;
  const lenses = rawLenses.slice(0, 8).flatMap((candidate) => {
    const value = objectRecord(candidate);
    if (!value) return [];
    const id = value?.id;
    if (id !== "functional" && id !== "user-journey" && id !== "data" && id !== "infrastructure") return [];
    const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
    const nodes = rawNodes.slice(0, 16).flatMap((node) => {
      const nodeValue = objectRecord(node);
      if (!nodeValue) return [];
      const evidenceMembers = textArray(nodeValue.evidenceMembers, 24);
      if (nodeValue.evidenceMembers !== undefined) {
        invalidOptionalFieldsIgnored += Array.isArray(nodeValue.evidenceMembers)
          ? nodeValue.evidenceMembers.length - evidenceMembers.length
          : 1;
      }
      const parsed = architectureLensNodeSchema.safeParse({
        id: nodeValue.id,
        title: nodeValue.title,
        type: nodeValue.type,
        description: nodeValue.description,
        evidenceMembers,
        ...(typeof nodeValue.groupName === "string" && nodeValue.groupName.trim() ? { groupName: nodeValue.groupName.trim() } : {}),
        ...(typeof nodeValue.contextOnly === "boolean" ? { contextOnly: nodeValue.contextOnly } : {})
      });
      return parsed.success ? [parsed.data] : [];
    });
    lensNodesDropped += rawNodes.length - nodes.length;
    const rawEdges = Array.isArray(value.edges) ? value.edges : [];
    providerConfidenceFieldsIgnored += rawEdges.filter((edge) => Boolean(objectRecord(edge)) && "confidence" in (objectRecord(edge) as Record<string, unknown>)).length;
    const edges = rawEdges.slice(0, 32).flatMap((edge) => {
      const parsed = architectureLensEdgeSchema.safeParse(edge);
      return parsed.success ? [parsed.data] : [];
    });
    lensEdgesDropped += rawEdges.length - edges.length;
    const parsed = architectureLensPlanSchema.safeParse({ id, nodes, edges });
    return parsed.success ? [parsed.data] : [];
  });
  const rawEdgeLabels = Array.isArray(envelope.edgeLabels) ? envelope.edgeLabels : [];
  const edgeLabels = rawEdgeLabels.slice(0, 240).flatMap((candidate) => {
    const value = objectRecord(candidate);
    if (!value || typeof value.source !== "string" || typeof value.target !== "string" || typeof value.label !== "string") return [];
    return [{ source: value.source, target: value.target, label: value.label }];
  });
  const spec = architectureSpecSchema.parse({
    analysis: typeof envelope.analysis === "string" ? envelope.analysis : "",
    projectNode: projectNodeFromEnvelope(envelope),
    architecture,
    lenses,
    edgeLabels,
    subflowNames: textArray(envelope.subflowNames, 8),
    summary: typeof envelope.summary === "string" ? envelope.summary : ""
  });
  const acceptedPlans = sanitizedLensPlans(spec);
  const acceptedIds = new Set(acceptedPlans.map((lens) => lens.id));
  const issues: string[] = [];
  if (architecture.length < 2) issues.push(`Functional hierarchy retained ${architecture.length}/2 required architecture nodes.`);
  if (rawArchitecture.length > architecture.length) issues.push(`Dropped ${rawArchitecture.length - architecture.length} invalid architecture node${rawArchitecture.length - architecture.length === 1 ? "" : "s"}.`);
  if (lensNodesDropped) issues.push(`Dropped ${lensNodesDropped} invalid lens node${lensNodesDropped === 1 ? "" : "s"}.`);
  if (lensEdgesDropped) issues.push(`Dropped ${lensEdgesDropped} invalid lens relationship${lensEdgesDropped === 1 ? "" : "s"}.`);
  if (invalidOptionalFieldsIgnored) issues.push(`Ignored ${invalidOptionalFieldsIgnored} invalid optional field value${invalidOptionalFieldsIgnored === 1 ? "" : "s"} while retaining their valid parent sections.`);
  if (providerConfidenceFieldsIgnored) issues.push(`Ignored ${providerConfidenceFieldsIgnored} provider confidence value${providerConfidenceFieldsIgnored === 1 ? "" : "s"}; ArchiCode derives relationship confidence from evidence provenance.`);
  for (const lens of spec.lenses) {
    if (acceptedIds.has(lens.id)) continue;
    const qualityIssues = lensPlanQualityIssues(lens as ArchitectureLensPlan);
    if (qualityIssues.length) issues.push(`${lens.id} lens ${qualityIssues.join("; ")}.`);
  }
  const missingLensIds = requiredLensIds.filter((id) => !acceptedIds.has(id));
  if (missingLensIds.length) issues.push(`Missing useful lens plans: ${missingLensIds.join(", ")}.`);
  return {
    spec,
    diagnostics: {
      attempts: 1,
      architectureNodesRetained: architecture.length,
      architectureNodesDropped: Math.max(0, rawArchitecture.length - architecture.length),
      lensIdsRetained: acceptedPlans.map((lens) => lens.id),
      missingLensIds,
      lensNodesDropped,
      lensEdgesDropped,
      invalidOptionalFieldsIgnored,
      providerConfidenceFieldsIgnored,
      issues
    }
  };
}

function parseJsonCandidates(raw: string): Record<string, unknown>[] {
  const candidates: string[] = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/g) ?? [];
  for (const block of fenced) candidates.push(block.replace(/```(?:json)?\s*/, "").replace(/```\s*$/, ""));
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));
  return candidates.flatMap((candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

/** Label only the exact edges that survived hierarchy projection and density reduction. */
export async function requestDerivedEdgeLabels(input: {
  moduleGraph: ModuleGraph;
  existingLabels?: ImportAnnotations["edgeLabels"];
  /** Nodes renamed after the original labels were authored. */
  changedClusterIds?: string[];
  callProvider: (prompt: string, options?: CodebaseImportProviderCallOptions) => Promise<string>;
}): Promise<{ edgeLabels: ImportAnnotations["edgeLabels"]; degraded?: string }> {
  const clusterById = new Map(input.moduleGraph.clusters.map((cluster) => [cluster.id, cluster]));
  const existingByPair = new Map((input.existingLabels ?? []).map((edge) => [`${edge.source} ${edge.target}`, edge.label]));
  const changedClusterIds = new Set(input.changedClusterIds ?? []);
  const usefulExistingLabel = (value: string | undefined): boolean => Boolean(value
    && value.trim().length >= 3
    && !/^(?:imports?|dependency|depends? on|uses?|calls?|connects? to)(?:\s*\(\d+\))?$/i.test(value.trim()));
  const rankedEdges = [...input.moduleGraph.edges]
    .filter((edge) => changedClusterIds.has(edge.source)
      || changedClusterIds.has(edge.target)
      || !usefulExistingLabel(existingByPair.get(`${edge.source} ${edge.target}`)))
    .sort((left, right) => (right.occurrences ?? right.importCount) - (left.occurrences ?? left.importCount))
    .slice(0, 120);
  if (!rankedEdges.length) return { edgeLabels: [] };
  const stableContext = [
    "Immutable finalized edges requiring labels:",
    JSON.stringify(rankedEdges.map((edge) => ({
      source: edge.source,
      sourceTitle: clusterById.get(edge.source)?.title ?? edge.source,
      target: edge.target,
      targetTitle: clusterById.get(edge.target)?.title ?? edge.target,
      bidirectional: edge.bidirectional || undefined,
      relations: edge.relationKinds,
      importedNames: edge.importedNames,
      samples: edge.sampleImports.slice(0, 3),
      evidence: edge.evidence?.slice(0, 6)
    })))
  ].join("\n");
  const prompt = [
    "You are labeling the finalized visible edges of an architecture graph. Every edge below is derived from code evidence and already survived scope projection and readability filtering.",
    "Return a concise, directional verb phrase for every edge (normally 2-8 words). Explain what the source gets from or does with the target. Prefer concrete behavior over generic words like dependency, imports, uses, or calls. Do not add counts and do not invent edges.",
    "Every label must read as a complete phrase on its own: never end on a preposition or conjunction (write \"loads validated reports\", NOT \"loads validated reports from\").",
    "Runtime evidence is authoritative: preserve the HTTP/IPC mechanism or describe the concrete contract. Imported names and samples are grounding evidence, not text that must be copied verbatim.",
    "",
    "Finalized edges: supplied as cacheable stable context.",
    "Return ONLY this JSON envelope:",
    JSON.stringify({ archicodeEdgeLabels: { edgeLabels: [{ source: "cluster-source", target: "cluster-target", label: "loads validated reports" }] } }, null, 2)
  ].join("\n");
  const raw = await input.callProvider(prompt, { stableContext });
  const allowedPairs = new Set(rankedEdges.map((edge) => `${edge.source} ${edge.target}`));
  for (const parsed of parseJsonCandidates(raw)) {
    const envelope = parsed.archicodeEdgeLabels && typeof parsed.archicodeEdgeLabels === "object"
      ? parsed.archicodeEdgeLabels as Record<string, unknown>
      : parsed;
    if (!Array.isArray(envelope.edgeLabels)) continue;
    const seen = new Set<string>();
    const edgeLabels = envelope.edgeLabels.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const { source, target, label } = candidate as Record<string, unknown>;
      if (typeof source !== "string" || typeof target !== "string" || typeof label !== "string") return [];
      const key = `${source} ${target}`;
      const normalized = label.trim().replace(/\s+/g, " ").slice(0, 120);
      if (!allowedPairs.has(key) || seen.has(key) || !normalized) return [];
      seen.add(key);
      return [{ source, target, label: normalized }];
    });
    if (edgeLabels.length) {
      const missing = rankedEdges.length - edgeLabels.length;
      return {
        edgeLabels,
        degraded: missing ? `Finalized-edge labeling covered ${edgeLabels.length}/${rankedEdges.length} displayed relationships; evidence-based labels were retained for the rest.` : undefined
      };
    }
  }
  return { edgeLabels: [], degraded: "Finalized-edge labeling returned no usable exact edge labels; evidence-based labels were retained." };
}

/**
 * Refine visible deep nodes that were added deterministically after the first architecture
 * response. One focused call per substantial top-level area prevents large-repo evidence
 * starvation while preserving every existing strong annotation.
 */
export async function requestHierarchicalAnnotations(input: {
  moduleGraph: ModuleGraph;
  annotations: ImportAnnotations;
  callProvider: (prompt: string, options?: CodebaseImportProviderCallOptions) => Promise<string>;
  beforeArea?: (title: string, index: number, total: number) => void;
  assertNotCancelled?: () => void;
}): Promise<{ clusters: ImportAnnotationCluster[]; degraded?: string }> {
  const byId = new Map(input.moduleGraph.clusters.map((cluster) => [cluster.id, cluster]));
  const existingById = new Map(input.annotations.clusters.map((cluster) => [cluster.id, cluster]));
  const topAncestor = (clusterId: string) => {
    let current = byId.get(clusterId);
    while (current?.parentClusterId && byId.has(current.parentClusterId)) current = byId.get(current.parentClusterId);
    return current;
  };
  const missingByArea = new Map<string, typeof input.moduleGraph.clusters>();
  for (const cluster of input.moduleGraph.clusters) {
    if (cluster.tier < 2 || existingById.has(cluster.id)) continue;
    const area = topAncestor(cluster.id);
    if (!area) continue;
    missingByArea.set(area.id, [...(missingByArea.get(area.id) ?? []), cluster]);
  }
  const areas = [...missingByArea.entries()]
    .filter(([, clusters]) => clusters.length >= 3)
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, 8);
  const stableContext = [
    "Immutable global hierarchy and relationship context shared by every subsystem refinement:",
    JSON.stringify({
      clusters: input.moduleGraph.clusters.slice(0, 600).map((cluster) => ({ id: cluster.id, parentClusterId: cluster.parentClusterId, path: cluster.path, title: existingById.get(cluster.id)?.title || cluster.title })),
      edges: input.moduleGraph.edges.slice(0, 800).map((edge) => ({ source: edge.source, target: edge.target, relations: edge.relationKinds, importedNames: edge.importedNames }))
    })
  ].join("\n");
  const limit = pLimit(2);
  const areaResults = await Promise.all(areas.map(([areaId, allTargets], areaIndex) => limit(async (): Promise<{ clusters: ImportAnnotationCluster[]; note?: string }> => {
    input.assertNotCancelled?.();
    const area = byId.get(areaId) as NonNullable<ReturnType<typeof topAncestor>>;
    const targets = allTargets.slice(0, 60);
    input.beforeArea?.(existingById.get(areaId)?.title || area.title, areaIndex, areas.length);
    const targetIds = new Set(targets.map((cluster) => cluster.id));
    const titleFor = (clusterId: string): string => existingById.get(clusterId)?.title || byId.get(clusterId)?.title || clusterId;
    const prompt = [
      "You are refining one subsystem of an existing architecture map. The hierarchy, memberships, and edges are fixed code-derived ground truth.",
      "Rename and describe ONLY the target deep nodes below. These nodes were added deterministically after the system-level architecture pass and currently have folder-like names or mechanical descriptions.",
      "Give each node a functional, concrete title and a grounded description. For multi-file nodes write 2-5 sentences explaining responsibility, key files/symbols, data flow, and collaborators. For single files write 1-3 precise sentences. Never invent behavior, files, or edges.",
      "Avoid folder-only titles like Helpers, Model, Screens, Widgets, Src, Lib, or Test. Acceptance criteria must be verifiable. Use only technologies shown in evidence.",
      "Titles must decompose, not echo: never give a node a title that mostly repeats its parent's title (parent \"Persistence & Sync\" must not contain \"Persistence & Sync Services\"). Sibling titles must be clearly distinguishable from each other.",
      "",
      `Subsystem: ${existingById.get(areaId)?.title || area.title}`,
      `Subsystem description: ${existingById.get(areaId)?.description || area.path}`,
      "Targets and full local evidence:",
      "```json",
      JSON.stringify(targets.map((cluster) => ({
        id: cluster.id,
        currentTitle: cluster.title,
        parent: cluster.parentClusterId ? { id: cluster.parentClusterId, title: titleFor(cluster.parentClusterId) } : undefined,
        path: cluster.path,
        unit: cluster.unit,
        fileCount: cluster.files.length,
        files: [...new Set([...(cluster.topFiles ?? []), ...(cluster.ownedFiles ?? []), ...cluster.files])].slice(0, 16),
        languages: cluster.languages,
        symbols: cluster.symbols.slice(0, 16),
        symbolRefs: cluster.symbolRefs?.slice(0, 16),
        externalDeps: cluster.externalDeps,
        routes: cluster.routes,
        interactions: cluster.interactions,
        relationships: input.moduleGraph.edges
          .filter((edge) => edge.source === cluster.id || edge.target === cluster.id)
          .slice(0, 16)
          .map((edge) => ({
            direction: edge.source === cluster.id ? "outgoing" : "incoming",
            neighbor: titleFor(edge.source === cluster.id ? edge.target : edge.source),
            importedNames: edge.importedNames,
            relations: edge.relationKinds,
            evidence: edge.evidence?.slice(0, 4)
          }))
      }))),
      "```",
      "Return every target you can ground confidently. Do not return subsystem or non-target IDs.",
      "Return ONLY this JSON envelope:",
      JSON.stringify({ archicodeHierarchy: { clusters: [{ id: "cluster-exact-id", title: "Functional responsibility", type: "component", description: "Grounded description.", techStack: ["Dart"], acceptanceCriteria: ["Concrete check"] }] } }, null, 2)
    ].join("\n");
    let raw: string;
    const controller = new AbortController();
    const cancellationTimer = input.assertNotCancelled ? setInterval(() => {
      try {
        input.assertNotCancelled?.();
      } catch {
        controller.abort();
      }
    }, 250) : undefined;
    try {
      raw = await input.callProvider(prompt, { signal: controller.signal, stableContext });
    } catch (error) {
      input.assertNotCancelled?.();
      return { clusters: [], note: `${existingById.get(areaId)?.title || area.title}: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      if (cancellationTimer) clearInterval(cancellationTimer);
    }
    input.assertNotCancelled?.();
    let accepted: ImportAnnotationCluster[] = [];
    for (const parsed of parseJsonCandidates(raw)) {
      const envelope = parsed.archicodeHierarchy && typeof parsed.archicodeHierarchy === "object"
        ? parsed.archicodeHierarchy as Record<string, unknown>
        : parsed;
      if (!Array.isArray(envelope.clusters)) continue;
      const seen = new Set<string>();
      accepted = envelope.clusters.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const value = candidate as Record<string, unknown>;
        if (typeof value.id !== "string" || !targetIds.has(value.id) || seen.has(value.id)) return [];
        const title = typeof value.title === "string" ? value.title.trim() : "";
        const description = typeof value.description === "string" ? value.description.trim() : "";
        if (!title || description.length < 40) return [];
        const cluster = byId.get(value.id);
        if (!cluster) return [];
        seen.add(value.id);
        return [{
          id: value.id,
          title: title.slice(0, 100),
          type: typeof value.type === "string" && value.type.trim() ? value.type.trim().slice(0, 40) : cluster.unit,
          description,
          techStack: Array.isArray(value.techStack) ? value.techStack.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, 6) : [],
          acceptanceCriteria: Array.isArray(value.acceptanceCriteria) ? value.acceptanceCriteria.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, 4) : []
        }];
      });
      if (accepted.length) break;
    }
    return {
      clusters: accepted,
      ...(accepted.length < targets.length ? { note: `${existingById.get(areaId)?.title || area.title}: refined ${accepted.length}/${targets.length} visible deep nodes.` } : {})
    };
  })));
  const synthesized = areaResults.flatMap((result) => result.clusters);
  const notes = areaResults.flatMap((result) => result.note ? [result.note] : []);
  return {
    clusters: synthesized,
    degraded: notes.length ? `Hierarchical synthesis was partial. ${notes.join(" ")}` : undefined
  };
}

export async function requestImportAnnotations(input: MapperInput): Promise<MapperResult> {
  const prompt = organizePrompt(input);
  const stableContext = [
    "Immutable deterministic repository ground truth for architecture generation:",
    groundTruthJson(input)
  ].join("\n");
  const availableLensIds = new Set(input.moduleGraph.projections?.map((projection) => projection.id) ?? []);
  const requiredLensIds: ArchitectureLensPlan["id"][] = (["functional", "user-journey", "data", "infrastructure"] as const)
    .filter((id) => availableLensIds.has(id));
  const first = parseArchitectureResponse(await input.callProvider(prompt, { stableContext }), requiredLensIds);
  input.onProgress?.(
    "Validating functional architecture response",
    `${first.diagnostics.architectureNodesRetained} hierarchy nodes and ${first.diagnostics.lensIdsRetained.length}/${requiredLensIds.length} requested lenses retained. Invalid optional pieces are discarded independently.`
  );
  let spec = first.spec;
  let canonicalRefinements: string[] = [];
  if (spec && spec.architecture.length >= 2) {
    const refined = canonicalRuntimeBoundaryRefinement(spec, input);
    spec = refined.spec;
    canonicalRefinements = refined.refinements;
  }
  let second: ParsedArchitectureResponse | undefined;
  let repairKind: ImportArchitectureValidationDiagnostics["repairKind"];
  const hierarchyUsable = Boolean(spec && spec.architecture.length >= 2);
  if (!hierarchyUsable) {
    repairKind = "architecture";
    const repairDetail = first.diagnostics.issues.join(" ") || "No usable hierarchy nodes were retained.";
    input.onProgress?.("Repairing functional architecture only", `${repairDetail} One targeted repair will run; already-valid sections stay retained locally.`);
    const repairPrompt = first.spec
      ? [
          "archicodeArchitectureRepair",
          "Repair only the rejected canonical hierarchy of a reverse-engineered architecture atlas using the immutable repository evidence supplied as stable context.",
          "Keep process/trust boundaries separate, cover every repository file through evidence members, and never invent dependencies.",
          "The previous response's functional hierarchy had these exact validation problems:",
          ...first.diagnostics.issues.map((issue) => `- ${issue}`),
          "Return ONLY an archicodeImport envelope containing corrected projectNode, architecture, edgeLabels, analysis, and summary. Do not return lenses; the importer retained every valid lens from the previous response. Every architecture node requires id, parentId, title, description, members, techStack, and acceptanceCriteria. Do not return relationship confidence values."
        ].join("\n")
      : [
          "archicodeArchitectureRepair",
          "The previous response was not parseable, so no section could be retained.",
          "Using the compact immutable repository evidence supplied as stable context, return one complete corrected archicodeImport JSON envelope.",
          "It must contain projectNode, at least two architecture nodes with evidence-backed members, and lenses for every detected lens requested in the stable evidence. Keep process/trust boundaries separate and do not invent files, dependencies, or deployment state. Do not return relationship confidence values."
        ].join("\n");
    const repairStableContext = first.spec
      ? stableContext
      : ["Compact immutable repository ground truth for a format-recovery attempt:", groundTruthJson(input, { repair: true })].join("\n");
    second = parseArchitectureResponse(await input.callProvider(repairPrompt, { stableContext: repairStableContext }), requiredLensIds);
  } else if (first.diagnostics.missingLensIds.length) {
    repairKind = "lenses";
    input.onProgress?.(
      "Repairing incomplete architecture lenses",
      `Only ${first.diagnostics.missingLensIds.join(", ")} will be requested again; the accepted hierarchy and lenses stay retained.`
    );
    const repairPrompt = [
      "archicodeLensRepair",
      "Repair only missing architecture lenses using the immutable repository evidence supplied as stable context.",
      `The hierarchy is already valid. Return ONLY an archicodeImport envelope with a lenses array for these missing or low-quality lenses: ${first.diagnostics.missingLensIds.join(", ")}.`,
      "Do not return projectNode, architecture, edgeLabels, or already accepted lenses. Do not return relationship confidence values.",
      "Each returned lens must pass the original semantic rules and remain grounded in evidenceMembers. If repository evidence truly cannot support a requested lens, omit it instead of inventing one."
    ].join("\n");
    second = parseArchitectureResponse(await input.callProvider(repairPrompt, { stableContext }), first.diagnostics.missingLensIds);
  }
  if (second?.spec) spec = spec ? mergeArchitectureSpecs(spec, second.spec) : second.spec;
  if (spec && spec.architecture.length >= 2) {
    const refined = canonicalRuntimeBoundaryRefinement(spec, input);
    spec = refined.spec;
    canonicalRefinements = [...new Set([...canonicalRefinements, ...refined.refinements])];
  }

  const finalParsed = spec
    ? parseArchitectureResponse(JSON.stringify({ archicodeImport: spec }), requiredLensIds)
    : first;
  const diagnostics: ImportArchitectureValidationDiagnostics = {
    ...finalParsed.diagnostics,
    attempts: second ? 2 : 1,
    ...(repairKind ? { repairKind } : {}),
    ...(canonicalRefinements.length ? { canonicalRefinements } : {}),
    architectureNodesDropped: first.diagnostics.architectureNodesDropped + (second?.diagnostics.architectureNodesDropped ?? 0),
    lensNodesDropped: first.diagnostics.lensNodesDropped + (second?.diagnostics.lensNodesDropped ?? 0),
    lensEdgesDropped: first.diagnostics.lensEdgesDropped + (second?.diagnostics.lensEdgesDropped ?? 0),
    invalidOptionalFieldsIgnored: first.diagnostics.invalidOptionalFieldsIgnored + (second?.diagnostics.invalidOptionalFieldsIgnored ?? 0),
    providerConfidenceFieldsIgnored: first.diagnostics.providerConfidenceFieldsIgnored + (second?.diagnostics.providerConfidenceFieldsIgnored ?? 0),
    issues: [...new Set([
      ...finalParsed.diagnostics.issues,
      ...(first.diagnostics.providerConfidenceFieldsIgnored || second?.diagnostics.providerConfidenceFieldsIgnored
        ? [`Ignored ${(first.diagnostics.providerConfidenceFieldsIgnored + (second?.diagnostics.providerConfidenceFieldsIgnored ?? 0))} provider relationship confidence value(s); confidence was derived from evidence provenance.`]
        : [])
    ])]
  };
  input.onProgress?.(
    "Functional architecture validation complete",
    `${diagnostics.architectureNodesRetained} hierarchy nodes and ${diagnostics.lensIdsRetained.length}/${requiredLensIds.length} requested lenses retained after ${diagnostics.attempts} provider call${diagnostics.attempts === 1 ? "" : "s"}.`
  );

  if (spec) {
    const lensPlans = sanitizedLensPlans(spec);
    const transformed = transformArchitecture({
      spec,
      scan: input.scan,
      parsed: input.parsed,
      fileGraph: input.fileGraph,
      inventory: input.inventory,
      levels: input.levels,
      detail: input.detail,
      granularity: input.granularity,
      semanticLinks: input.moduleGraph.semanticLinks
    });
    if (transformed) {
      const comparison = compareArchitectureCandidates(input.moduleGraph, transformed.moduleGraph, input.scan);
      if (!comparison.accepted) {
        const note = `Provider hierarchy was rejected because it regressed deterministic architecture contracts (${comparison.reasons.join("; ")}). The canonical deterministic hierarchy and every valid provider lens were retained without regenerating the response.`;
        return {
          annotations: minimalAnnotations(spec),
          analysis: spec.analysis,
          lensPlans,
          allowHierarchicalRefinement: false,
          diagnostics,
          degraded: [note, ...transformed.notes].filter(Boolean).join(" ")
        };
      }
      const sanitized = sanitizeAnnotations(transformed.annotations, transformed.moduleGraph);
      return {
        annotations: sanitized,
        analysis: spec.analysis,
        lensPlans,
        organizedGraph: transformed.moduleGraph,
        allowHierarchicalRefinement: true,
        diagnostics,
        degraded: transformed.notes.length ? transformed.notes.join(" ") : undefined
      };
    }
    return {
      annotations: minimalAnnotations(spec),
      analysis: spec.analysis,
      lensPlans,
      allowHierarchicalRefinement: false,
      diagnostics,
      degraded: `The provider hierarchy could not be projected safely, so ArchiCode retained its valid project content and ${lensPlans.length} useful lens plan${lensPlans.length === 1 ? "" : "s"} on the deterministic hierarchy without another full response.`
    };
  }
  return {
    annotations: null,
    analysis: "",
    allowHierarchicalRefinement: false,
    diagnostics,
    degraded: "The provider did not return a usable architecture envelope after one targeted repair; deterministic names and summaries were used."
  };
}

export type CompiledLensRepairResult = {
  lensPlans: ArchitectureLensPlan[];
  requestedLensIds: ArchitectureLensPlan["id"][];
  replacementLensIds: ArchitectureLensPlan["id"][];
  diagnostics: ImportArchitectureValidationDiagnostics;
  degraded?: string;
};

/**
 * One bounded repair for lens plans that failed after real evidence resolution.
 * The hierarchy and already healthy lenses are deliberately absent from the
 * editable response surface, so this call cannot create a second source of truth.
 */
export async function requestCompiledLensRepairs(input: MapperInput & {
  lensPlans: ArchitectureLensPlan[];
  failures: LensCompilationDiagnostics[];
}): Promise<CompiledLensRepairResult> {
  const requestedLensIds = [...new Set(input.failures.map((failure) => failure.lensId))];
  const currentById = new Map(input.lensPlans.map((plan) => [plan.id, plan]));
  const stableContext = [
    "Immutable deterministic repository evidence for a targeted compiled architecture-lens repair:",
    groundTruthJson(input)
  ].join("\n");
  const prompt = [
    "archicodeCompiledLensRepair",
    "You are repairing only the failed perspective lenses of a reverse-engineered architecture atlas.",
    "The canonical evidence hierarchy and every healthy lens are already accepted and MUST NOT be returned or changed.",
    "The prior plans passed JSON-level checks but failed after evidence paths were resolved, unsupported nodes were dropped, types were canonicalized, and generic relationships were filtered.",
    "Return truthful human-scale flows that a skilled engineer or architect would use. Do not invent repository implementation or deployment state.",
    "Every non-context node needs at least one exact repository file or directory in evidenceMembers. Only a user-journey actor/context note may set contextOnly=true.",
    "Natural-language prompts and policies prove declared behavior only. Do not turn them into durable storage, a completed external action, or an embedded dataset unless the deterministic evidence contains a matching sink, channel, or catalog.",
    "Use these canonical semantic roles (synonyms will be normalized):",
    "- functional: capability",
    "- user-journey: actor, trigger, journey-step, decision, outcome",
    "- data: data-owner, data-entity, data-state, data-store, data-transform, data-sync, migration (data-state is transient/in-memory; data-store requires a concrete durable sink)",
    "- infrastructure: delivery-automation, build-artifact, deployable, hosting, managed-resource, external-boundary",
    "Relationships must have specific directional verb phrases. Keep the flow connected; do not submit isolated inventory items.",
    "Exact post-compilation failures:",
    JSON.stringify(input.failures.map((failure) => ({
      lensId: failure.lensId,
      issues: failure.issues,
      proposedNodes: failure.proposedNodes,
      resolvedNodes: failure.resolvedNodes,
      proposedEdges: failure.proposedEdges,
      emittedEdges: failure.emittedEdges,
      droppedNodes: failure.droppedNodes,
      droppedEdges: failure.droppedEdges,
      normalizedTypes: failure.normalizedTypes,
      previousPlan: currentById.get(failure.lensId) ?? null
    }))),
    "Return ONLY an archicodeImport JSON object with a lenses array containing exactly the requested repaired lenses.",
    `Requested lens ids: ${requestedLensIds.join(", ")}.`,
    "Do not return projectNode, architecture, edgeLabels, analysis, summary, relationship confidence, or healthy lenses.",
    "If repository evidence cannot support a requested lens, omit it instead of fabricating one.",
    "Required envelope shape:",
    JSON.stringify({ archicodeImport: { lenses: [{ id: requestedLensIds[0] ?? "functional", nodes: [{ id: "stable-local-id", title: "Human title", type: "canonical-role", description: "Grounded responsibility", evidenceMembers: ["exact/repository/path"] }], edges: [{ source: "stable-local-id", target: "another-local-id", label: "specific directional relationship" }] }] } }, null, 2)
  ].join("\n\n");
  input.onProgress?.(
    "Repairing compiled architecture lenses",
    `${requestedLensIds.join(", ")} failed after evidence resolution. One targeted repair call will run; the hierarchy and healthy lenses remain unchanged.`
  );
  const parsed = parseArchitectureResponse(await input.callProvider(prompt, { stableContext }), requestedLensIds);
  const replacements = parsed.spec
    ? sanitizedLensPlans(parsed.spec).filter((plan) => requestedLensIds.includes(plan.id))
    : [];
  const replacementsById = new Map(replacements.map((plan) => [plan.id, plan]));
  const lensPlans = input.lensPlans
    .filter((plan) => !replacementsById.has(plan.id))
    .concat(replacements);
  const replacementLensIds = replacements.map((plan) => plan.id);
  return {
    lensPlans,
    requestedLensIds,
    replacementLensIds,
    diagnostics: parsed.diagnostics,
    ...(replacementLensIds.length < requestedLensIds.length ? {
      degraded: `Targeted compiled-lens repair returned ${replacementLensIds.length}/${requestedLensIds.length} usable replacement lens plan${replacementLensIds.length === 1 ? "" : "s"}; unresolved lenses will use explicit deterministic fallbacks.`
    } : {})
  };
}

function minimalAnnotations(spec: ArchitectureSpec): ImportAnnotations {
  return {
    projectNode: spec.projectNode,
    clusters: [],
    groups: [],
    edgeLabels: [],
    subflowNames: spec.subflowNames,
    summary: spec.summary
  };
}

/** Drop invalid pieces so the emitter's deterministic fallbacks take over for exactly those pieces. */
function sanitizeAnnotations(annotations: ImportAnnotations, graph: ModuleGraph): ImportAnnotations {
  const clusterIds = new Set(graph.clusters.map((cluster) => cluster.id));
  const tierById = new Map(graph.clusters.map((cluster) => [cluster.id, cluster.tier]));
  const colorPattern = /^#[0-9a-fA-F]{6}$/;
  const seen = new Set<string>();
  const clusters = annotations.clusters.filter((cluster) => {
    if (!clusterIds.has(cluster.id) || seen.has(cluster.id)) return false;
    seen.add(cluster.id);
    return true;
  }).map((cluster) => ({
    ...cluster,
    mergeInto: cluster.mergeInto && clusterIds.has(cluster.mergeInto) && tierById.get(cluster.mergeInto) === tierById.get(cluster.id)
      ? cluster.mergeInto
      : undefined,
    visual: cluster.visual
      ? {
          backgroundColor: cluster.visual.backgroundColor && colorPattern.test(cluster.visual.backgroundColor) ? cluster.visual.backgroundColor : undefined,
          shape: cluster.visual.shape && nodeVisualShapeSchema.safeParse(cluster.visual.shape).success ? cluster.visual.shape : undefined
        }
      : undefined
  }));
  const groups = annotations.groups
    .map((group) => ({
      ...group,
      color: group.color && colorPattern.test(group.color) ? group.color : undefined,
      memberClusterIds: group.memberClusterIds.filter((memberId) => clusterIds.has(memberId))
    }))
    .filter((group) => group.name.trim() && group.memberClusterIds.length);
  const edgePairs = new Set(graph.edges.map((edge) => `${edge.source} ${edge.target}`));
  const edgeLabels = annotations.edgeLabels.filter((edgeLabel) => edgePairs.has(`${edgeLabel.source} ${edgeLabel.target}`));
  return { ...annotations, clusters, groups, edgeLabels };
}
