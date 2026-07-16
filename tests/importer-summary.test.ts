import { describe, expect, it } from "vitest";
import { buildImportSummarySections, countActionableReviewConcerns, estimateImportAccuracy, importSummaryStatus, summarizeImportProviderCalls } from "../src/main/importer/importSummary";

describe("import completion summary", () => {
  it("deduplicates and separates safeguards, genuine limitations, rejected suggestions, and notes", () => {
    const sections = buildImportSummarySections({
      safeguards: ["Semantic truth safeguards reframed 2 unsupported provider-authored claims."],
      degraded: [
        "3 source files use languages without a native parser; hierarchy and generic literals are covered structurally, while symbol and call fidelity is lower.",
        "The provider hierarchy could not be projected safely, so ArchiCode retained its valid project content and deterministic hierarchy without another full response.",
        "Anomaly-driven review selected 5/21 possible partitions; deterministic architecture contracts protect unselected areas.",
        "6 review questions remain unresolved and were not converted into graph truth."
      ],
      qualityWarnings: [
        "3 source files use structural fallback because no native parser is available."
      ],
      review: {
        limitations: [
          "Anomaly-driven review selected 5/21 possible partitions; deterministic architecture contracts protect unselected areas.",
          "6 review questions remain unresolved and were not converted into graph truth."
        ],
        unresolved: [
          "evidence-1: The evidence flow does not contain nodes for Components and Src, which are listed as canonical subjects, but cannot be corrected with the available edit operations for this review unit.",
          "product-part-1: Feedback parsing is not directly visible in the supplied source excerpt; it cannot be verified from the provided evidence alone.",
          "runtime-part-1: The /__open-in-editor request targets Vite's built-in dev server middleware and was left as a documented anomaly.",
          "runtime-part-1: Edge verification remains unresolved despite clear source evidence. This is likely a false negative in the static resolver.",
          "journey-part-1: No source-supplied evidence suggests a missing conceptual step or code subject. The existing inferred edges suffice.",
          "global-consistency: provider review could not produce a valid safe patch (Citation path was not included in raw source supplied to this review partition.)"
        ]
      }
    });

    expect(sections.correctionsAndSafeguards).toHaveLength(2);
    expect(sections.correctionsAndSafeguards.join(" ")).toContain("source code did not prove");
    expect(sections.correctionsAndSafeguards.join(" ")).toContain("validated structure");
    expect(sections.limitations).toEqual([
      "3 source files use languages without a native parser; hierarchy and generic literals are covered structurally, while symbol and call fidelity is lower.",
      "runtime-part-1: Edge verification remains unresolved despite clear source evidence. This is likely a false negative in the static resolver."
    ]);
    expect(sections.rejectedReviewSuggestions).toHaveLength(3);
    expect(sections.informationalNotes).toHaveLength(2);
    expect(Object.values(sections).flat().join(" ")).not.toContain("No source-supplied evidence suggests");
    expect(countActionableReviewConcerns([
      "evidence-1: cannot be corrected with the available edit operations for this review unit.",
      "runtime-part-1: The request targets Vite's built-in dev server middleware and was left as a documented anomaly.",
      "journey-part-1: No source-supplied evidence suggests a missing conceptual step. Existing edges suffice.",
      "global: provider review could not produce a valid safe patch."
    ])).toBe(2);
  });

  it("counts architecture, review, retry, failed, rejected, and runtime-setup calls separately", () => {
    const summary = summarizeImportProviderCalls({
      architectureCalls: [
        { status: "succeeded" },
        { status: "failed" },
        { status: "succeeded" }
      ],
      review: {
        unitResults: [{ providerAttempts: 1 }, { providerAttempts: 2 }, { providerAttempts: 2 }],
        failedProviderAttempts: 1,
        rejectedBatches: 3
      },
      runtimeSetup: { total: 2, retries: 1, failed: 0, rejected: 1 }
    });

    expect(summary).toEqual({
      total: 10,
      architecture: 3,
      review: 5,
      runtimeSetup: 2,
      retries: 3,
      failed: 2,
      rejected: 4
    });
  });

  it("estimates accuracy from deterministic evidence and applies review-effort ceilings", () => {
    const quality = {
      sourceCoverage: 1,
      uniqueClusterIds: true,
      typedEdgeRate: 1,
      entrypointCoverage: 1,
      parserCoverage: 0.9,
      structuralFallbackFiles: 3,
      projectionCount: 7,
      perspectiveCoverage: [
        { id: "system", subjects: 3, relations: 2, confidence: "high" as const },
        { id: "functional", subjects: 5, relations: 4, confidence: "medium" as const },
        { id: "code", subjects: 6, relations: 5, confidence: "high" as const }
      ],
      cycleCount: 0,
      architectureFitnessScore: 100,
      architectureCriticalIssues: 0,
      warnings: []
    };
    const common = {
      quality,
      resolutionRate: 1,
      review: { reviewedUnits: 5, selectedUnits: 5, possibleUnits: 21, status: "partial" as const },
      operationsApplied: 120,
      operationsFailed: 0
    };
    const light = estimateImportAccuracy({ ...common, reviewEffort: "light" });
    const deep = estimateImportAccuracy({ ...common, reviewEffort: "deep" });

    expect(light).toMatchObject({ score: 85, label: "Good" });
    expect(deep.score).toBeGreaterThan(light.score);
    expect(deep.explanation).toContain("not a guarantee");
    expect(light.recommendation).toContain("verify critical implementation details");
    expect(light.factors).toContainEqual({ label: "Review depth ceiling", value: "Light · 85% max" });
  });

  it("reserves the attention state for unrecovered failures", () => {
    expect(importSummaryStatus({
      errors: [],
      operationsFailed: 0,
      reviewStatus: "partial",
      limitations: []
    })).toBe("complete");
    expect(importSummaryStatus({
      errors: [],
      operationsFailed: 0,
      reviewStatus: "partial",
      limitations: ["One concrete source limitation remains."]
    })).toBe("complete");
    expect(importSummaryStatus({
      errors: ["Runtime target reconciliation failed."],
      operationsFailed: 0,
      reviewStatus: "complete",
      limitations: []
    })).toBe("partial");
    expect(importSummaryStatus({
      errors: [],
      operationsFailed: 1,
      reviewStatus: "complete",
      limitations: []
    })).toBe("partial");
    expect(importSummaryStatus({
      errors: [],
      operationsFailed: 0,
      reviewStatus: "failed",
      limitations: []
    })).toBe("partial");
  });
});
