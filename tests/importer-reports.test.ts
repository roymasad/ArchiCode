import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readInitialCodebaseImportReport, writeInitialCodebaseImportReport } from "../src/main/importer/importReports";
import type { CodebaseMappingSummary } from "../src/main/research";

const temporaryRoots: string[] = [];

function report(reportId: string, completedAt: string): CodebaseMappingSummary {
  return {
    reportId,
    status: "complete",
    completedAt,
    durationMs: 60_000,
    provider: { label: "Test provider", kind: "openai-compatible", model: "test-model" },
    settings: { levels: "1", detail: "light", reviewEffort: "light", granularity: "system" },
    files: { scanned: 20, parsed: 18, importLinks: 12, resolutionRate: 1 },
    graph: { flows: 8, perspectiveFlows: 7, nodes: 50, relationships: 40, operationsApplied: 98, operationsFailed: 0 },
    review: {
      status: "partial",
      reviewedUnits: 5,
      selectedUnits: 5,
      possibleUnits: 20,
      appliedEdits: 4,
      rejectedBatches: 1,
      unresolvedCount: 2,
      reportedUnresolvedCount: 2,
      reviewedSourceFiles: 8,
      totalReviewSourceFiles: 18
    },
    providerCalls: { total: 8, failed: 0, architecture: 3, review: 5, runtimeSetup: 0, retries: 0, rejected: 1 },
    phaseTimings: [{ phase: "scan", label: "Scanning", durationMs: 10 }],
    accuracyEstimate: {
      score: 85,
      label: "Good",
      explanation: "Evidence-based estimate. It is not a guarantee.",
      recommendation: "Suitable for architecture exploration; verify critical implementation details against source.",
      factors: [{ label: "Source coverage", value: "100%" }]
    },
    report: { correctionsAndSafeguards: [], limitations: [], rejectedReviewSuggestions: [], informationalNotes: [] },
    warnings: [],
    errors: []
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persisted initial codebase import report", () => {
  it("returns no report before a project's initial import has completed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-no-initial-import-report-"));
    temporaryRoots.push(root);

    await expect(readInitialCodebaseImportReport(root)).resolves.toBeNull();
  });

  it("retains the one-time initial import report so it can be reopened", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-initial-import-report-"));
    temporaryRoots.push(root);
    const initialReport = report("initial-import", "2026-07-14T10:00:00.000Z");

    await writeInitialCodebaseImportReport(root, initialReport);

    await expect(readInitialCodebaseImportReport(root)).resolves.toEqual(initialReport);
  });
});
