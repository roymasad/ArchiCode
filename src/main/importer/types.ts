import type { CodebaseMappingGranularity, ResearchGraphOperation } from "../../shared/schema";

export type SupportedLanguage =
  | "javascript"
  | "typescript"
  | "tsx"
  | "python"
  | "go"
  | "rust"
  | "php"
  | "c"
  | "cpp"
  | "c_sharp"
  | "dart"
  | "java"
  | "kotlin"
  | "swift"
  | "ruby"
  | "scala"
  | "lua"
  | "elixir"
  | "vue"
  | "objc"
  | "solidity"
  | "zig"
  | "bash";

export type CodebaseImportLevels = "1" | "2" | "3" | "4";
export type CodebaseImportDetail = "light" | "balanced" | "deep";
export type CodebaseImportReviewEffort = "light" | "balanced" | "deep" | "ultra";

export type ScannedFile = {
  relPath: string;
  ext: string;
  sizeBytes: number;
  language: SupportedLanguage | null;
  /** Broader language detection used for structural fallback when no native parser exists. */
  detectedLanguage?: string | null;
  /** Architectural role used to keep support material from dominating primary code maps. */
  role?: FileRole;
};

export type FileRole = "production" | "test" | "generated" | "config" | "docs" | "asset" | "migration" | "fixture" | "tooling";

export type RepoScan = {
  files: ScannedFile[];
  truncated: boolean;
  stats: {
    totalFiles: number;
    byLanguage: Record<string, number>;
    byDetectedLanguage?: Record<string, number>;
    structuralFallbackFiles?: number;
  };
};

export type FileImportKind = "static" | "dynamic" | "reexport" | "require" | "include" | "use" | "mod";
export type CodeRelationKind = "dependency" | "calls" | "type-only" | "runtime-load" | "reexports" | "project-reference" | "ipc" | "http" | "hosts" | "event" | "shared-data";

export type FileImport = {
  specifier: string;
  kind: FileImportKind;
  importedNames?: string[];
  /** JS/TS local bindings retained so call sites can be resolved to the imported module. */
  bindings?: Array<{ imported: string; local: string; namespace?: boolean }>;
  line?: number;
  typeOnly?: boolean;
};

export type CodeSymbolKind = "class" | "component" | "function" | "interface" | "type" | "enum" | "struct" | "trait" | "method" | "symbol";

export type ParsedSymbol = {
  name: string;
  kind: CodeSymbolKind;
};

export type ParsedSemanticSymbol = ParsedSymbol & {
  startLine: number;
  endLine: number;
  parentName?: string;
};

export type ParsedFile = {
  relPath: string;
  language: SupportedLanguage;
  imports: FileImport[];
  declaredNamespaces: string[];
  /** Exported/public top-level symbol names (capped), used to describe what a file contains. */
  symbols: string[];
  /** File-local symbol identities retained for implementation-scope hints. */
  symbolRefs?: ParsedSymbol[];
  /** Complete component-level spans used to assign every source line to its narrowest containing symbol. */
  semanticSymbols?: ParsedSemanticSymbol[];
  calledSymbols?: string[];
  /** Direct JS/TS calls and constructions with their source line. */
  callSites?: Array<{
    callee: string;
    receiver?: string;
    line: number;
    kind: "call" | "construct";
  }>;
  exportCount: number;
  loc: number;
  parseError?: string;
};

export type FileEdge = {
  from: string;
  to: string;
  kinds?: FileImportKind[];
  importedNames?: string[];
  evidence?: Array<{ line?: number; specifier: string }>;
  occurrences?: number;
  confidence?: number;
  relationKinds?: CodeRelationKind[];
  /** Import-binding-resolved JS/TS call sites for symbol-level knowledge edges. */
  callEvidence?: Array<{
    line: number;
    importedName: string;
    localName: string;
    kind: "call" | "construct";
  }>;
};

export type FileDependencyGraph = {
  edges: FileEdge[];
  externalsByFile: Map<string, string[]>;
  unresolved: Array<{ from: string; specifier: string }>;
  resolutionRate: number;
  relationsAttempted?: number;
};

export type ClusterUnit = "area" | "module" | "component" | "file";

export type ModuleCluster = {
  id: string;
  path: string;
  title: string;
  unit: ClusterUnit;
  tier: number;
  parentClusterId?: string;
  files: string[];
  /** Files directly assigned to this node, excluding descendants; present for functional architectures. */
  ownedFiles?: string[];
  loc: number;
  languages: string[];
  topFiles: string[];
  externalDeps: string[];
  docTitles: string[];
  /** Exported symbols contained in this cluster's files (capped). */
  symbols: string[];
  /** Exported/public symbols with their source file retained for compact node hints. */
  symbolRefs?: Array<ParsedSymbol & { path: string }>;
  /** Dominant codebase role and architecture signals computed deterministically. */
  role?: FileRole | "mixed";
  metrics?: {
    incoming: number;
    outgoing: number;
    centrality: number;
    entrypointReachable: boolean;
    cyclic: boolean;
  };
  routes?: string[];
  interactions?: Array<{ kind: string; target: string; file: string; method?: string; reference?: string; line?: number; confidence?: number }>;
  communityId?: string;
  boundary?: { kind: string; path: string; manifest: string };
  /** Set when this cluster represents a detected catalog/registry. */
  catalogRef?: { file: string; callee: string; itemCount: number; itemTitles: string[] };
  /** Set when this cluster represents a single catalogued item. */
  catalogItem?: { key: string; title: string; note?: string; file: string };
};

export type ModuleEdge = {
  source: string;
  target: string;
  importCount: number;
  sampleImports: string[];
  importedNames?: string[];
  evidence?: Array<{ from: string; to: string; line?: number; specifier: string }>;
  kinds?: FileImportKind[];
  occurrences?: number;
  confidence?: number;
  relationKinds?: CodeRelationKind[];
  /** Display hint used when reciprocal low-information dependencies are collapsed. */
  bidirectional?: boolean;
};

export type ArchitectureLensId =
  | "system"
  | "functional"
  | "user-journey"
  | "runtime"
  | "data"
  | "infrastructure"
  | "code"
  | "dependency-health";

export type GraphProjection = {
  id: ArchitectureLensId;
  title: string;
  /** The engineering question this projection is intended to answer. */
  question: string;
  description: string;
  /** Signals used to include nodes; useful when presenting the limits of the reverse-engineered view. */
  evidenceBasis: string[];
  confidence: "high" | "medium" | "exploratory";
  clusterIds: string[];
  /** Per-subject inclusion rationale shown in generated perspective flows. */
  subjectEvidence?: Array<{ clusterId: string; signals: string[] }>;
  edgePairs: Array<{ source: string; target: string }>;
  /** Bounded source-observed product rules used to enforce capability and journey coverage. */
  behavioralContracts?: Array<{
    file: string;
    line: number;
    text: string;
    title: string;
    terms: string[];
    sequence: number;
    /** Outcome/rule evidence for Product, or explicitly ordered evidence for Journey. */
    kind?: "outcome" | "constraint" | "journey-step" | "decision";
    /** Declared prompt/policy behavior is useful product evidence, but is not proof that an effect was implemented. */
    evidenceMode?: "declared";
  }>;
};

/**
 * A lens-specific, human-scale interpretation proposed from repository evidence.
 * These nodes never replace code subjects: evidenceMembers are resolved back to
 * canonical ModuleCluster subjectRefs when the flow is emitted.
 */
export type ArchitectureLensPlan = {
  id: Extract<ArchitectureLensId, "functional" | "user-journey" | "data" | "infrastructure">;
  nodes: Array<{
    id: string;
    title: string;
    type: string;
    description: string;
    evidenceMembers: string[];
    groupName?: string;
    contextOnly?: boolean;
  }>;
  edges: Array<{
    source: string;
    target: string;
    label: string;
  }>;
};

export type ModuleGraphInsights = {
  stronglyConnectedComponents: string[][];
  dependencyCommunities: string[][];
  hubs: string[];
  boundaryEdges: Array<{ source: string; target: string }>;
  repositoryBoundaries: Array<{ kind: string; path: string; manifest: string }>;
  roleCounts: Partial<Record<FileRole, number>>;
};

export type ModuleGraph = {
  clusters: ModuleCluster[];
  edges: ModuleEdge[];
  levels: CodebaseImportLevels;
  granularity: CodebaseMappingGranularity;
  entrypoints: string[];
  projections?: GraphProjection[];
  insights?: ModuleGraphInsights;
  semanticLinks?: Array<{ source: string; target: string; score: number }>;
  behavioralContracts?: NonNullable<GraphProjection["behavioralContracts"]>;
};

export type ImportAnnotationCluster = {
  id: string;
  title: string;
  type: string;
  description: string;
  techStack: string[];
  acceptanceCriteria: string[];
  visual?: { backgroundColor?: string; shape?: string };
  groupName?: string;
  mergeInto?: string;
};

export type ImportAnnotations = {
  projectNode: {
    title: string;
    description: string;
    techStack: string[];
    acceptanceCriteria: string[];
    visual?: { backgroundColor?: string; shape?: string };
  };
  clusters: ImportAnnotationCluster[];
  groups: Array<{ name: string; color?: string; memberClusterIds: string[] }>;
  edgeLabels: Array<{ source: string; target: string; label: string }>;
  subflowNames: string[];
  summary: string;
};

export type CodebaseImportProgress = {
  phase: "scan" | "parse" | "semantic" | "resolve" | "cluster" | "annotate" | "emit" | "review" | "verify";
  label: string;
  detail?: string;
  itemsDone?: number;
  itemsTotal?: number;
};

export type CodebaseImportPhaseTiming = {
  phase: CodebaseImportProgress["phase"];
  label: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export type CodebaseImportProviderCallOptions = {
  /** Cancels the active provider process/request when a review attempt stalls or the import is cancelled. */
  signal?: AbortSignal;
  /** Provider token activity used to distinguish slow active work from a stalled response. */
  onActivity?: () => void;
  /** Large immutable review context placed in the provider's cacheable prefix when supported. */
  stableContext?: string;
};

export type CodebaseImportInput = {
  projectRoot: string;
  flowId: string;
  levels: CodebaseImportLevels;
  detail: CodebaseImportDetail;
  granularity: CodebaseMappingGranularity;
  codebaseHints: string[];
  /** Non-secret provider identity persisted with local import diagnostics. */
  provider?: {
    id: string;
    kind: string;
    model?: string;
  };
  onProgress?: (progress: CodebaseImportProgress) => void;
  callProvider?: (prompt: string, options?: CodebaseImportProviderCallOptions) => Promise<string>;
  deadlineMs?: number;
  semanticEnabled?: boolean;
  /** Persist the detailed local-only code knowledge snapshot for the desktop viewer. */
  persistKnowledgeSnapshot?: boolean;
  /** Run the bounded, partitioned LLM architecture review after deterministic emission. Defaults to true when a provider is available. */
  reviewEnabled?: boolean;
  /** Independent review thoroughness; unlike detail, this controls review coverage rather than graph density. */
  reviewEffort?: CodebaseImportReviewEffort;
  /** Optional review-partition ceiling. Omitted values use the selected review-effort budget. */
  reviewMaxUnits?: number;
  shouldCancel?: () => boolean;
  /** Internal incremental-resync fast path: current scan plus cached parser output for unchanged files. */
  analysisSeed?: {
    scan: RepoScan;
    parsed: ParsedFile[];
  };
};

export class CodebaseImportCancelledError extends Error {
  constructor() {
    super("Codebase import was cancelled.");
    this.name = "CodebaseImportCancelledError";
  }
}

export type CodebaseImportOutcome = {
  operations: ResearchGraphOperation[];
  /** Evidence hierarchy plus every generated perspective flow. */
  flowIds: string[];
  perspectiveFlowIds: string[];
  analysis: string;
  moduleGraph: ModuleGraph;
  /**
   * Normalized deterministic analysis retained in memory so the caller can
   * seed incremental synchronization metadata after the graph transaction.
   * This is never a second graph and is not persisted by the importer.
   */
  analysisSnapshot: {
    scan: RepoScan;
    parsed: ParsedFile[];
    fileGraph: FileDependencyGraph;
  };
  stats: {
    filesScanned: number;
    filesParsed: number;
    fileEdges: number;
    resolutionRate: number;
    degraded: string[];
    /** Deterministic corrections that protected graph truth without degrading the usable result. */
    safeguards?: string[];
    quality?: import("./quality").ImportQualityReport;
    review?: import("./reviewer").ImportReviewLedger;
    phaseTimings?: CodebaseImportPhaseTiming[];
    provenance?: {
      runId: string;
      importerVersion: string;
      startedAt: string;
      completedAt: string;
      durationMs: number;
      provider?: { id: string; kind: string; model?: string };
      settings: {
        levels: CodebaseImportLevels;
        detail: CodebaseImportDetail;
        granularity: CodebaseMappingGranularity;
        reviewEffort: CodebaseImportReviewEffort;
        reviewMaxUnits: number;
        semanticEnabled: boolean;
      };
    };
    architectureProvider?: {
      calls: Array<{
        sequence: number;
        purpose: "architecture-generation" | "architecture-repair" | "lens-repair" | "deep-node-refinement" | "final-edge-labeling";
        startedAt: string;
        completedAt: string;
        durationMs: number;
        status: "succeeded" | "failed";
        responseChars?: number;
        promptChars?: number;
        stableContextChars?: number;
        error?: string;
      }>;
      validation?: import("./mapper").ImportArchitectureValidationDiagnostics;
      lensCompilation?: import("./lensFlows").LensCompilationDiagnostics[];
      compiledLensRepair?: {
        requestedLensIds: ArchitectureLensPlan["id"][];
        replacementLensIds: ArchitectureLensPlan["id"][];
        validation: import("./mapper").ImportArchitectureValidationDiagnostics;
      };
    };
  };
};
