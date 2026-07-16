import type { Flow, ProjectBundle } from "../../shared/schema";
import type { CodebaseImportDetail, CodebaseImportLevels, CodebaseImportReviewEffort } from "./types";
import type { ParsedFile } from "./types";
import type { CodebaseMappingGranularity } from "../../shared/schema";

export type ResyncEntityOrigin = "importer" | "resync" | "importer-modified" | "user" | "unknown";

export type ResyncFileFingerprint = {
  path: string;
  contentHash: string;
  sizeBytes: number;
  language: string | null;
  parsedFingerprint: string;
  symbolFingerprint: string;
  relationshipFingerprint: string;
};

/** The repository evidence checkpoint retained for a flow that was not part of a scoped resync. */
export type ResyncFlowFileFingerprint = Pick<ResyncFileFingerprint, "contentHash" | "language" | "symbolFingerprint">;

export type ResyncScope =
  | { kind: "project" }
  | { kind: "flows"; flowIds: string[] };

export type ResyncEntityBaseline = {
  key: string;
  flowId: string;
  kind: "flow" | "node" | "edge" | "subflow" | "group";
  id: string;
  origin: ResyncEntityOrigin;
  lastVerifiedGraphFingerprint: string;
  /** Stricter fingerprint including layout/state, used by conservative deletion policy. */
  lastVerifiedOwnershipFingerprint: string;
  lastObservedGraphFingerprint: string;
  evidenceFingerprint: string;
  evidencePaths: string[];
  subjectId?: string;
};

export type ResyncConflict = {
  id: string;
  category: "user-conflict" | "potential-stale";
  flowId: string;
  entityKind: ResyncEntityBaseline["kind"];
  entityId: string;
  title: string;
  reason: string;
  disappearedEvidence: string[];
};

export type ResyncBaseline = {
  schemaVersion: 1;
  baselineVersion: number;
  baselineId: string;
  importerVersion: string;
  createdAt: string;
  lastSuccessfulSyncAt: string;
  repositoryFingerprint: string;
  settings: {
    levels: CodebaseImportLevels;
    detail: CodebaseImportDetail;
    reviewEffort: CodebaseImportReviewEffort;
    granularity: CodebaseMappingGranularity;
  };
  files: Record<string, ResyncFileFingerprint>;
  /** Compact normalized parser output reused for unchanged files; this is evidence metadata, never a graph. */
  parsedFiles: Record<string, ParsedFile>;
  /**
   * Per-flow overrides against `files`. A missing flow uses the current global
   * file checkpoint; an override preserves pending evidence for a flow omitted
   * from a previous scoped resync.
   */
  flowFileCheckpoints?: Record<string, Record<string, ResyncFlowFileFingerprint>>;
  entities: Record<string, ResyncEntityBaseline>;
  importerFlowIds: string[];
  unresolvedConflicts: ResyncConflict[];
};

export type ResyncCodeDelta = {
  added: string[];
  modified: string[];
  deleted: string[];
  moved: Array<{ from: string; to: string }>;
  renamed: Array<{ from: string; to: string }>;
  unchanged: number;
};

export type ResyncPatchSummary = {
  changedFlowIds: string[];
  verifiedUnchanged: number;
  nodesUpdated: number;
  edgesUpdated: number;
  flowsUpdated: number;
  nodesAdded: number;
  edgesAdded: number;
  flowsAdded: number;
  nodesRemoved: number;
  edgesRemoved: number;
  potentialStale: number;
  staleItems: ResyncConflict[];
  conflicts: ResyncConflict[];
  rejectedSuggestions: string[];
};

export type ResyncAccuracyEstimate = {
  score: number;
  label: "High" | "Good" | "Moderate" | "Limited";
  explanation: string;
  factors: Array<{ label: string; value: string }>;
};

export type ResyncReport = {
  reportId: string;
  status: "synchronized" | "up-to-date" | "review-required";
  completedAt: string;
  durationMs: number;
  provider: { label: string; kind: string; model?: string } | null;
  baselineVersion: number;
  bootstrappedLegacyBaseline: boolean;
  /** Missing only on reports written before scoped resync was introduced. */
  scope?: ResyncScope;
  files: { scanned: number; changed: number; parsed: number; resolutionRate: number };
  delta: ResyncCodeDelta;
  patch: ResyncPatchSummary;
  impact: { paths: string[]; flowIds: string[]; entityKeys: string[] };
  accuracyEstimate: ResyncAccuracyEstimate;
  llmReview: {
    requested: boolean;
    calls: number;
    failedCalls: number;
    affectedEntitiesReviewed: number;
    suggestionsApplied: number;
    suggestionsRejected: number;
  };
  safeguards: string[];
  phaseTimings: Array<{ phase: ResyncProgress["phase"]; label: string; durationMs: number }>;
  technical: string[];
};

export type ResyncProgress = {
  projectRoot: string;
  phase: "baseline" | "scan" | "compare" | "parse" | "impact" | "reconcile" | "review" | "validate" | "persist";
  label: string;
  detail?: string;
  itemsDone?: number;
  itemsTotal?: number;
};

export type ResyncResult = {
  bundle: ProjectBundle;
  report: ResyncReport;
};

export type ResyncTransactionInput = {
  projectRoot: string;
  flows: Flow[];
  baseline: ResyncBaseline;
  report: ResyncReport;
};

export class CodebaseResyncCancelledError extends Error {
  constructor() {
    super("Codebase resync was cancelled.");
    this.name = "CodebaseResyncCancelledError";
  }
}
