import type { ImportQualityReport } from "./quality";

export type ImportSummarySections = {
  correctionsAndSafeguards: string[];
  limitations: string[];
  rejectedReviewSuggestions: string[];
  informationalNotes: string[];
};

export type ImportAccuracyEstimate = {
  score: number;
  label: "High" | "Good" | "Moderate" | "Limited";
  explanation: string;
  recommendation: string;
  factors: Array<{ label: string; value: string }>;
};

export type ImportProviderCallSummary = {
  /** Every architecture and review invocation, including retries. */
  total: number;
  /** Architecture generation, organization, lens repair, and finalization calls. */
  architecture: number;
  /** Every review invocation, including retry attempts. */
  review: number;
  /** Post-import runtime-profile reconciliation invocations. */
  runtimeSetup: number;
  /** Review invocations after the first attempt for a partition. */
  retries: number;
  /** Provider invocations that threw, timed out, or were aborted before a response. */
  failed: number;
  /** Responses or edit batches rejected by deterministic review validation. */
  rejected: number;
};

type ArchitectureProviderCall = { status: "succeeded" | "failed" };

function normalizedMessage(message: string): string {
  return message.trim().replace(/\s+/g, " ");
}

function semanticKey(message: string): string {
  const normalized = normalizedMessage(message).toLowerCase();
  const parserFallback = normalized.match(/^(\d+) source files? .*(?:native parser|structural fallback)/);
  if (parserFallback) return `parser-fallback:${parserFallback[1]}`;
  if (/review questions? remains? unresolved/.test(normalized)) return "review-unresolved-summary";
  return normalized.replace(/[.;]+$/g, "");
}

function dedupeMessages(messages: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of messages) {
    const message = normalizedMessage(candidate);
    if (!message) continue;
    const key = semanticKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(message);
  }
  return result;
}

function isNoIssueReviewNote(message: string): boolean {
  return [
    /no source(?:-supplied)? evidence suggests? (?:a )?missing/i,
    /no (?:conceptual step|code subject|structural change|graph change).*(?:missing|required|needed)/i,
    /existing (?:inferred )?(?:edges|relationships|nodes).*(?:suffice|are sufficient)/i,
    /(?:flow|lens|graph).*(?:is|was) (?:already )?(?:truthful|coherent|complete).*(?:no|without) (?:missing|changes?)/i
  ].some((pattern) => pattern.test(message));
}

function isSafeguard(message: string): boolean {
  return [
    /(?:provider|model).*(?:was|were )?rejected.*(?:deterministic|canonical|retained|regress)/i,
    /(?:proposal|response|hierarchy|organization|merge).*(?:was|were )?rejected.*(?:retained|regress|contract)/i,
    /regressed? (?:deterministic )?architecture contracts?.*(?:retained|without regenerating)/i,
    /provider hierarchy could not be projected safely.*(?:retained|deterministic hierarchy)/i
  ].some((pattern) => pattern.test(message));
}

function userFacingSafeguard(message: string): string {
  const reframedClaims = message.match(/semantic truth safeguards reframed (\d+) (?:unsupported )?provider-authored (?:lens )?claims?/i);
  if (reframedClaims) {
    const count = Number(reframedClaims[1]);
    return `Removed or softened ${count} graph claim${count === 1 ? "" : "s"} that the source code did not prove.`;
  }
  if (/data lens was scoped to runtime state because no concrete durable persistence sink was observed/i.test(message)) {
    return "Kept the data flow focused on in-memory state because no database or durable storage was found in the repository.";
  }
  if (/provider hierarchy (?:was rejected|could not be projected safely)/i.test(message)) {
    return "Replaced an unsafe model-generated structure with ArchiCode's validated structure while retaining the content that passed verification.";
  }
  return message;
}

function isReviewSelectionNote(message: string): boolean {
  return /(?:anomaly-driven )?review selected \d+\/\d+ (?:possible )?partitions/i.test(message);
}

function isAggregateUnresolvedSummary(message: string): boolean {
  return /\d+ review questions? remains? unresolved and (?:was|were) not converted into graph truth/i.test(message);
}

function isInformationalReviewNote(message: string): boolean {
  return isReviewSelectionNote(message)
    || /built-in dev(?:elopment)? server|dev server middleware/i.test(message)
    || /left as a documented anomaly/i.test(message);
}

function isRejectedReviewSuggestion(message: string): boolean {
  return [
    /provider review could not produce a valid safe patch/i,
    /citation path was not included in raw source supplied/i,
    /cannot be corrected with (?:the )?available edit operations/i,
    /cannot add .* because .* edit envelope/i,
    /not directly visible in the supplied source excerpt/i,
    /cannot be verified from the provided evidence alone/i,
    /listed as canonical subjects.*(?:review unit|partition)/i
  ].some((pattern) => pattern.test(message));
}

/**
 * Turns importer diagnostics into user-facing categories. Review observations
 * that explicitly report "nothing is missing" are omitted: they are successful
 * checks, not limitations the user needs to investigate.
 */
export function buildImportSummarySections(input: {
  safeguards?: string[];
  degraded: string[];
  qualityWarnings?: string[];
  review?: { limitations: string[]; unresolved: string[] };
}): ImportSummarySections {
  const rawSafeguards = dedupeMessages(input.safeguards ?? []);
  const sections: ImportSummarySections = {
    correctionsAndSafeguards: rawSafeguards.map(userFacingSafeguard),
    limitations: [],
    rejectedReviewSuggestions: [],
    informationalNotes: []
  };
  const safeguardKeys = new Set(rawSafeguards.map(semanticKey));
  const messages = dedupeMessages([
    ...input.degraded,
    ...(input.qualityWarnings ?? []),
    ...(input.review?.limitations ?? []),
    ...(input.review?.unresolved ?? [])
  ]);

  for (const message of messages) {
    if (safeguardKeys.has(semanticKey(message))) continue;
    if (isNoIssueReviewNote(message) || isAggregateUnresolvedSummary(message)) continue;
    if (isSafeguard(message)) sections.correctionsAndSafeguards.push(userFacingSafeguard(message));
    else if (isRejectedReviewSuggestion(message)) sections.rejectedReviewSuggestions.push(message);
    else if (isInformationalReviewNote(message)) sections.informationalNotes.push(message);
    else sections.limitations.push(message);
  }

  return sections;
}

/** Counts only unresolved review concerns that still merit user attention. */
export function countActionableReviewConcerns(unresolved: string[]): number {
  return dedupeMessages(unresolved).filter((message) =>
    !isNoIssueReviewNote(message)
    && !isInformationalReviewNote(message)
    && !isAggregateUnresolvedSummary(message)
  ).length;
}

/**
 * A budget-limited review and retained analysis notes are expected and do not
 * make a usable generated map a partial import. Only unrecovered errors, failed
 * graph writes, or a failed reviewer require an attention state.
 */
export function importSummaryStatus(input: {
  errors: string[];
  operationsFailed: number;
  reviewStatus?: "running" | "complete" | "partial" | "failed";
  limitations: string[];
}): "complete" | "partial" {
  return input.errors.length > 0
    || input.operationsFailed > 0
    || input.reviewStatus === "failed"
    ? "partial"
    : "complete";
}

function unitInterval(value: number | undefined, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value as number));
}

/**
 * Produces a conservative evidence-based accuracy estimate. Provider-authored
 * confidence is intentionally excluded. Review effort places an uncertainty
 * ceiling on the result so a Light review cannot imply near-perfect certainty.
 */
export function estimateImportAccuracy(input: {
  quality?: ImportQualityReport;
  resolutionRate: number;
  reviewEffort: "light" | "balanced" | "deep" | "ultra";
  review?: {
    reviewedUnits: number;
    selectedUnits: number;
    possibleUnits: number;
    status: "running" | "complete" | "partial" | "failed";
  };
  operationsApplied: number;
  operationsFailed: number;
}): ImportAccuracyEstimate {
  const quality = input.quality;
  const corePerspectiveIds = new Set(["system", "functional", "code"]);
  const populatedCorePerspectives = quality?.perspectiveCoverage
    .filter((perspective) => corePerspectiveIds.has(perspective.id) && perspective.subjects > 0).length ?? 0;
  const corePerspectiveCoverage = populatedCorePerspectives / corePerspectiveIds.size;
  const reviewCompletion = input.review
    ? unitInterval(input.review.reviewedUnits / Math.max(1, input.review.selectedUnits))
    : 0;
  const reviewBreadth = input.review
    ? unitInterval(input.review.selectedUnits / Math.max(1, input.review.possibleUnits))
    : 0;
  const operationSuccess = unitInterval(
    input.operationsApplied / Math.max(1, input.operationsApplied + input.operationsFailed),
    input.operationsFailed ? 0 : 1
  );
  const rawScore = 100 * (
    (0.15 * unitInterval(quality?.sourceCoverage, 0.5))
    + (0.10 * unitInterval(quality?.parserCoverage, 0.5))
    + (0.10 * unitInterval(input.resolutionRate))
    + (0.10 * unitInterval(quality?.typedEdgeRate, 0.5))
    + (0.10 * unitInterval(quality?.entrypointCoverage, 0.5))
    + (0.20 * unitInterval((quality?.architectureFitnessScore ?? 50) / 100))
    + (0.10 * unitInterval(corePerspectiveCoverage))
    + (0.10 * reviewCompletion * (0.75 + (0.25 * reviewBreadth)))
    + (0.05 * operationSuccess)
  );
  const effortCeiling = { light: 85, balanced: 90, deep: 95, ultra: 97 }[input.reviewEffort];
  const failedReviewPenalty = input.review?.status === "failed" ? 15 : 0;
  const score = Math.max(0, Math.min(effortCeiling, Math.round(rawScore - failedReviewPenalty)));
  const label: ImportAccuracyEstimate["label"] = score >= 90
    ? "High"
    : score >= 75
      ? "Good"
      : score >= 60
        ? "Moderate"
        : "Limited";
  return {
    score,
    label,
    explanation: "Estimated from repository evidence coverage, parser and import resolution, architecture contracts, completed review checks, and successful graph writes. It is not a guarantee.",
    recommendation: label === "High"
      ? "Suitable for architecture exploration and planning; still verify production-critical decisions against source."
      : label === "Good"
        ? "Suitable for architecture exploration; verify critical implementation details against source."
        : label === "Moderate"
          ? "Use a deeper review or verify important flows before relying on the map for implementation decisions."
          : "Rerun with broader review settings or a stronger provider before relying on the map.",
    factors: [
      { label: "Source coverage", value: `${Math.round(unitInterval(quality?.sourceCoverage, 0.5) * 100)}%` },
      { label: "Native parser coverage", value: `${Math.round(unitInterval(quality?.parserCoverage, 0.5) * 100)}%` },
      { label: "Imports resolved", value: `${Math.round(unitInterval(input.resolutionRate) * 100)}%` },
      { label: "Architecture contracts", value: `${Math.round(unitInterval((quality?.architectureFitnessScore ?? 50) / 100) * 100)}%` },
      { label: "Selected review checks", value: input.review ? `${input.review.reviewedUnits}/${input.review.selectedUnits}` : "Not run" },
      { label: "Review depth ceiling", value: `${input.reviewEffort[0].toUpperCase()}${input.reviewEffort.slice(1)} · ${effortCeiling}% max` }
    ]
  };
}

export function summarizeImportProviderCalls(input: {
  architectureCalls?: ArchitectureProviderCall[];
  review?: {
    unitResults: Array<{ providerAttempts: number }>;
    rejectedBatches: number;
    failedProviderAttempts: number;
  };
  runtimeSetup?: { total: number; retries: number; failed: number; rejected: number };
}): ImportProviderCallSummary {
  const architectureCalls = input.architectureCalls ?? [];
  const reviewAttempts = input.review?.unitResults.reduce((sum, unit) => sum + unit.providerAttempts, 0) ?? 0;
  const retries = input.review?.unitResults.reduce((sum, unit) => sum + Math.max(0, unit.providerAttempts - 1), 0) ?? 0;
  const failedArchitectureCalls = architectureCalls.filter((call) => call.status === "failed").length;
  const failedReviewCalls = input.review?.failedProviderAttempts ?? 0;
  const runtimeSetup = input.runtimeSetup ?? { total: 0, retries: 0, failed: 0, rejected: 0 };
  return {
    total: architectureCalls.length + reviewAttempts + runtimeSetup.total,
    architecture: architectureCalls.length,
    review: reviewAttempts,
    runtimeSetup: runtimeSetup.total,
    retries: retries + runtimeSetup.retries,
    failed: failedArchitectureCalls + failedReviewCalls + runtimeSetup.failed,
    rejected: (input.review?.rejectedBatches ?? 0) + runtimeSetup.rejected
  };
}
