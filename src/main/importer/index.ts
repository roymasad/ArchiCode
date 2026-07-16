import path from "node:path";
import { codebaseReviewPartitionBudget } from "../../shared/schema";
import { buildModuleGraph } from "./aggregate";
import { buildContentInventory } from "./inventory";
import { prepareModuleGraphForEmission } from "./emit";
import { emitArchitectureAtlasOperations } from "./atlas";
import { buildFileDependencyGraph } from "./fileGraph";
import { parseFiles } from "./parsers";
import { scanRepository } from "./scanner";
import { CodebaseImportCancelledError, type ArchitectureLensPlan, type CodebaseImportInput, type CodebaseImportOutcome, type CodebaseImportPhaseTiming, type ImportAnnotations } from "./types";
import { requestCompiledLensRepairs, requestDerivedEdgeLabels, requestHierarchicalAnnotations, requestImportAnnotations, type ImportArchitectureValidationDiagnostics } from "./mapper";
import { enforceSemanticTruthOnAtlasOperations, semanticTruthSafeguardsForOperations, type LensCompilationDiagnostics } from "./lensFlows";
import { compareArchitectureCandidates, evaluateImportQuality } from "./quality";
import { indexSemanticDocuments, semanticDocumentsForCode, semanticLinksForDocuments } from "../semanticIndex";
import { addHighConfidenceRuntimeEdges } from "./runtimeEdges";
import { buildCodeKnowledgeSnapshot, writeCodeKnowledgeSnapshot } from "./knowledgeSnapshot";
import { rememberGraphEvidenceForFlows } from "../storage/graphEvidenceLocalState";
import { reviewArchitectureAtlasOperations, validateReviewedOperations, type ImportReviewLedger } from "./reviewer";
import { projectStatePath, writeJson } from "../storage/persistence";
import { createImportSourceReader } from "./sourceCache";

const IMPORTER_VERSION = "architecture-atlas-v3";

export async function runCodebaseImport(input: CodebaseImportInput): Promise<CodebaseImportOutcome> {
  const importStartedAtMs = Date.now();
  const importStartedAt = new Date(importStartedAtMs).toISOString();
  const importRunId = `import-${importStartedAt.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const deadlineMs = input.deadlineMs;
  const shouldCancel = input.shouldCancel ?? (() => false);
  const assertNotCancelled = (): void => {
    if (shouldCancel()) throw new CodebaseImportCancelledError();
  };
  const degraded: string[] = [];
  const progressSink = input.onProgress ?? (() => undefined);
  const phaseTimings: CodebaseImportPhaseTiming[] = [];
  const architectureProviderCalls: Array<{
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
  }> = [];
  let architectureProviderSequence = 0;
  let activePhase: { phase: CodebaseImportPhaseTiming["phase"]; label: string; startedAt: string; startedAtMs: number } | undefined;
  const emitProgress = (progress: Parameters<NonNullable<CodebaseImportInput["onProgress"]>>[0]): void => {
    const now = Date.now();
    if (!activePhase || activePhase.phase !== progress.phase) {
      if (activePhase) phaseTimings.push({
        phase: activePhase.phase,
        label: activePhase.label,
        startedAt: activePhase.startedAt,
        completedAt: new Date(now).toISOString(),
        durationMs: now - activePhase.startedAtMs
      });
      activePhase = { phase: progress.phase, label: progress.label, startedAt: new Date(now).toISOString(), startedAtMs: now };
    } else {
      activePhase.label = progress.label;
    }
    progressSink(progress);
  };

  emitProgress({ phase: "scan", label: "Scanning repository files" });
  const scan = input.analysisSeed?.scan ?? await scanRepository(input.projectRoot, {
    onProgress: (scanned) => emitProgress({ phase: "scan", label: "Scanning repository files", itemsDone: scanned }),
    deadlineMs,
    shouldCancel
  });
  if (scan.truncated) degraded.push("File scan hit the size or time limit; the map covers the files scanned so far.");
  const structuralFallbackFiles = scan.stats.structuralFallbackFiles ?? 0;
  const structuralFallbackLimitation = structuralFallbackFiles
    ? `${structuralFallbackFiles} source files use languages without a native parser; hierarchy and generic literals are covered structurally, while symbol and call fidelity is lower.`
    : null;
  if (structuralFallbackLimitation) degraded.push(structuralFallbackLimitation);
  assertNotCancelled();

  const sourceReader = createImportSourceReader(input.projectRoot);
  emitProgress({ phase: "parse", label: "Parsing source files", itemsTotal: scan.files.filter((file) => file.language).length });
  const parsed = input.analysisSeed?.parsed ?? await parseFiles(input.projectRoot, scan.files, {
    onProgress: (done, total) => emitProgress({ phase: "parse", label: "Parsing source files", itemsDone: done, itemsTotal: total }),
    deadlineMs,
    shouldCancel,
    sourceReader
  });
  assertNotCancelled();
  const parseSkipped = parsed.filter((file) => file.parseError?.startsWith("Skipped: import time budget")).length;
  if (parseSkipped) {
    const parsedCount = parsed.length - parseSkipped;
    degraded.push(`Parsed ${Math.round((parsedCount / Math.max(1, parsed.length)) * 100)}% of source files within the time budget.`);
  }

  let semanticLinks: Array<{ source: string; target: string; score: number }> = [];
  if (input.semanticEnabled) {
    emitProgress({ phase: "semantic", label: "Building the local semantic map" });
    try {
      const semanticSet = await semanticDocumentsForCode(input.projectRoot, scan, parsed, { sourceReader });
      assertNotCancelled();
      await indexSemanticDocuments(input.projectRoot, semanticSet.documents, {
        replaceKinds: ["code-file"],
        coverage: semanticSet.coverage,
        cancelled: shouldCancel,
        onProgress: (progress) => emitProgress({
          phase: "semantic",
          label: progress.message,
          detail: progress.reused !== undefined && progress.documentTotal !== undefined
            ? `${(progress.phase === "embedding" || progress.phase === "loading-model" ? progress.completed : progress.documentTotal - progress.reused).toLocaleString()} / ${(progress.documentTotal - progress.reused).toLocaleString()} changed chunks · ${progress.reused.toLocaleString()} reused · ${semanticSet.coverage.eligibleFiles.toLocaleString()} source files covered`
            : undefined,
          itemsDone: progress.completed,
          itemsTotal: progress.total
        })
      });
      semanticLinks = await semanticLinksForDocuments(input.projectRoot, semanticSet.documents.map((document) => document.key));
      if (!semanticSet.coverage.complete) degraded.push(`Semantic coverage is incomplete: ${semanticSet.coverage.indexedFiles}/${semanticSet.coverage.eligibleFiles} eligible files indexed.`);
    } catch (error) {
      if (shouldCancel()) throw new CodebaseImportCancelledError();
      degraded.push(`Semantic indexing was unavailable (${error instanceof Error ? error.message : String(error)}); structural analysis was used.`);
    }
  }
  assertNotCancelled();

  emitProgress({ phase: "resolve", label: "Resolving import statements" });
  const fileGraph = await buildFileDependencyGraph(input.projectRoot, scan, parsed, {
    onProgress: (done, total) => emitProgress({ phase: "resolve", label: "Resolving import statements", itemsDone: done, itemsTotal: total }),
    shouldCancel
  });
  assertNotCancelled();
  if (fileGraph.resolutionRate < 0.85 && fileGraph.unresolved.length > 5) {
    degraded.push(`Map built from ${Math.round(fileGraph.resolutionRate * 100)}% resolved internal imports (${fileGraph.unresolved.length} unresolved).`);
  }

  emitProgress({ phase: "cluster", label: "Clustering files into modules" });
  // Rank the bounded behavioral inventory with the resolved dependency graph.
  // Parsed source bytes are already in the per-import cache, so this adds no
  // second disk pass while avoiding alphabetical large-repository blind spots.
  const inventory = await buildContentInventory(input.projectRoot, scan, { sourceReader, fileGraph });
  if (inventory.coverage?.excludedFiles) {
    degraded.push(`Behavioral inventory inspected ${inventory.coverage.inspectedFiles}/${inventory.coverage.eligibleFiles} eligible source files using priority-and-directory-diverse sampling; ${inventory.coverage.excludedFiles} lower-priority files were excluded from bounded behavioral extraction.`);
  }
  addHighConfidenceRuntimeEdges(fileGraph, inventory);
  const moduleGraph = buildModuleGraph({
    scan,
    parsed,
    fileGraph,
    levels: input.levels,
    detail: input.detail,
    granularity: input.granularity,
    inventory,
    semanticLinks
  });

  let annotations: ImportAnnotations | null = null;
  let lensPlans: ArchitectureLensPlan[] = [];
  let analysis = "";
  let finalGraph = moduleGraph;
  let allowHierarchicalRefinement = true;
  let architectureValidation: ImportArchitectureValidationDiagnostics | undefined;
  let lensCompilation: LensCompilationDiagnostics[] = [];
  let compiledLensRepair: {
    requestedLensIds: ArchitectureLensPlan["id"][];
    replacementLensIds: ArchitectureLensPlan["id"][];
    validation: ImportArchitectureValidationDiagnostics;
  } | undefined;
  let callArchitectureProvider: CodebaseImportInput["callProvider"];
  if (input.callProvider) {
    callArchitectureProvider = async (prompt, options) => {
      const sequence = ++architectureProviderSequence;
      const purpose = prompt.includes("archicodeCompiledLensRepair")
        ? "lens-repair" as const
        : prompt.includes("archicodeArchitectureRepair")
          ? "architecture-repair" as const
        : prompt.includes("archicodeLensRepair")
          ? "lens-repair" as const
        : prompt.includes("archicodeEdgeLabels")
        ? "final-edge-labeling" as const
        : prompt.includes("archicodeHierarchy")
          ? "deep-node-refinement" as const
          : prompt.includes("with a lenses array for these missing")
            ? "lens-repair" as const
            : prompt.includes("previous response")
              ? "architecture-repair" as const
              : "architecture-generation" as const;
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      try {
        const response = await input.callProvider!(prompt, options);
        const completedAtMs = Date.now();
        architectureProviderCalls.push({
          sequence,
          purpose,
          startedAt,
          completedAt: new Date(completedAtMs).toISOString(),
          durationMs: completedAtMs - startedAtMs,
          status: "succeeded",
          responseChars: response.length,
          promptChars: prompt.length,
          stableContextChars: options?.stableContext?.length ?? 0
        });
        return response;
      } catch (error) {
        const completedAtMs = Date.now();
        architectureProviderCalls.push({
          sequence,
          purpose,
          startedAt,
          completedAt: new Date(completedAtMs).toISOString(),
          durationMs: completedAtMs - startedAtMs,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          promptChars: prompt.length,
          stableContextChars: options?.stableContext?.length ?? 0
        });
        throw error;
      }
    };
    emitProgress({ phase: "annotate", label: "Designing the functional architecture with the provider" });
    try {
      const result = await requestImportAnnotations({
        projectRoot: input.projectRoot,
        moduleGraph,
        scan,
        parsed,
        fileGraph,
        inventory,
        levels: input.levels,
        detail: input.detail,
        granularity: input.granularity,
        codebaseHints: input.codebaseHints,
        callProvider: callArchitectureProvider,
        onProgress: (label, detail) => emitProgress({ phase: "annotate", label, detail })
      });
      annotations = result.annotations;
      lensPlans = result.lensPlans ?? [];
      analysis = result.analysis;
      allowHierarchicalRefinement = result.allowHierarchicalRefinement !== false;
      architectureValidation = result.diagnostics;
      if (result.organizedGraph) {
        const organizedComparison = compareArchitectureCandidates(moduleGraph, result.organizedGraph, scan);
        if (organizedComparison.accepted) finalGraph = result.organizedGraph;
        else {
          annotations = annotations ? { ...annotations, clusters: [], groups: [], edgeLabels: [] } : null;
          allowHierarchicalRefinement = false;
          degraded.push(`Provider architecture organization was rejected because it regressed architecture contracts (${organizedComparison.reasons.join("; ")}); the deterministic architecture was retained.`);
        }
      }
      if (result.degraded) degraded.push(result.degraded);
    } catch (error) {
      if (error instanceof CodebaseImportCancelledError || shouldCancel()) throw new CodebaseImportCancelledError();
      degraded.push(`Provider annotation failed (${error instanceof Error ? error.message : String(error)}); deterministic names and summaries were used instead.`);
    }
  }
  assertNotCancelled();

  // Freeze the exact visible edge set before the provider labels it. This prevents the
  // new labels from changing density selection and guarantees it only sees emitted edges.
  let preparedModuleGraph = prepareModuleGraphForEmission(finalGraph, annotations);
  if (annotations) {
    const mergeComparison = compareArchitectureCandidates(finalGraph, preparedModuleGraph, scan);
    if (!mergeComparison.accepted) {
      annotations = {
        ...annotations,
        clusters: annotations.clusters.map(({ mergeInto: _mergeInto, ...cluster }) => cluster)
      };
      preparedModuleGraph = prepareModuleGraphForEmission(finalGraph, annotations);
      degraded.push(`Provider merge proposals were rejected because they regressed architecture contracts (${mergeComparison.reasons.join("; ")}).`);
    }
  }
  const titlesBeforeHierarchicalRefinement = new Map(preparedModuleGraph.clusters.map((cluster) => [cluster.id, cluster.title]));
  if (callArchitectureProvider && annotations && allowHierarchicalRefinement) {
    try {
      const hierarchical = await requestHierarchicalAnnotations({
        moduleGraph: preparedModuleGraph,
        annotations,
        callProvider: callArchitectureProvider,
        assertNotCancelled,
        beforeArea: (title, index, total) => emitProgress({
          phase: "annotate",
          label: `Refining deep graph details (${index + 1}/${total})`,
          detail: title,
          itemsDone: index,
          itemsTotal: total
        })
      });
      if (hierarchical.clusters.length) {
        const clusters = new Map(annotations.clusters.map((cluster) => [cluster.id, cluster]));
        for (const cluster of hierarchical.clusters) clusters.set(cluster.id, cluster);
        annotations = { ...annotations, clusters: [...clusters.values()] };
      }
      if (hierarchical.degraded) degraded.push(hierarchical.degraded);
    } catch (error) {
      if (error instanceof CodebaseImportCancelledError || shouldCancel()) throw new CodebaseImportCancelledError();
      degraded.push(`Hierarchical synthesis was unavailable (${error instanceof Error ? error.message : String(error)}); deterministic deep-node descriptions were retained.`);
    }
  }
  assertNotCancelled();
  if (callArchitectureProvider && annotations && allowHierarchicalRefinement && preparedModuleGraph.edges.length) {
    emitProgress({ phase: "annotate", label: "Labeling finalized graph relationships" });
    try {
      const annotationById = new Map(annotations.clusters.map((cluster) => [cluster.id, cluster]));
      const graphWithFinalTitles: typeof preparedModuleGraph = {
        ...preparedModuleGraph,
        clusters: preparedModuleGraph.clusters.map((cluster) => ({ ...cluster, title: annotationById.get(cluster.id)?.title || cluster.title }))
      };
      const changedClusterIds = graphWithFinalTitles.clusters
        .filter((cluster) => titlesBeforeHierarchicalRefinement.get(cluster.id) !== cluster.title)
        .map((cluster) => cluster.id);
      const finalized = await requestDerivedEdgeLabels({ moduleGraph: graphWithFinalTitles, existingLabels: annotations.edgeLabels, changedClusterIds, callProvider: callArchitectureProvider });
      if (finalized.edgeLabels.length) {
        const labels = new Map(annotations.edgeLabels.map((edge) => [`${edge.source} ${edge.target}`, edge]));
        for (const edge of finalized.edgeLabels) labels.set(`${edge.source} ${edge.target}`, edge);
        annotations = { ...annotations, edgeLabels: [...labels.values()] };
      }
      if (finalized.degraded) degraded.push(finalized.degraded);
    } catch (error) {
      if (error instanceof CodebaseImportCancelledError || shouldCancel()) throw new CodebaseImportCancelledError();
      degraded.push(`Finalized-edge labeling was unavailable (${error instanceof Error ? error.message : String(error)}); evidence-based labels were retained.`);
    }
  }
  assertNotCancelled();

  emitProgress({ phase: "emit", label: "Compiling graph flows against repository evidence" });
  let atlas = emitArchitectureAtlasOperations({
    baseFlowId: input.flowId,
    moduleGraph: finalGraph,
    annotations,
    projectName: path.basename(input.projectRoot),
    codebaseHints: input.codebaseHints,
    checkedAt: new Date().toISOString(),
    globalLimitations: structuralFallbackLimitation ? [structuralFallbackLimitation] : [],
    preparedModuleGraph,
    lensPlans,
    expectLensPlans: Boolean(input.callProvider)
  });
  const failedCompiledLenses = atlas.lensDiagnostics.filter((diagnostic) => diagnostic.fallbackUsed);
  if (callArchitectureProvider && failedCompiledLenses.length) {
    const attemptedLensIds = failedCompiledLenses.map((diagnostic) => diagnostic.lensId);
    try {
      const repaired = await requestCompiledLensRepairs({
        projectRoot: input.projectRoot,
        moduleGraph: finalGraph,
        scan,
        parsed,
        fileGraph,
        inventory,
        levels: input.levels,
        detail: input.detail,
        granularity: input.granularity,
        codebaseHints: input.codebaseHints,
        callProvider: callArchitectureProvider,
        onProgress: (label, detail) => emitProgress({ phase: "emit", label, detail }),
        lensPlans,
        failures: failedCompiledLenses
      });
      lensPlans = repaired.lensPlans;
      compiledLensRepair = {
        requestedLensIds: repaired.requestedLensIds,
        replacementLensIds: repaired.replacementLensIds,
        validation: repaired.diagnostics
      };
      if (repaired.degraded) degraded.push(repaired.degraded);
    } catch (error) {
      if (error instanceof CodebaseImportCancelledError || shouldCancel()) throw new CodebaseImportCancelledError();
      degraded.push(`Targeted compiled-lens repair was unavailable (${error instanceof Error ? error.message : String(error)}); failed lenses use explicit deterministic fallbacks.`);
    }
    atlas = emitArchitectureAtlasOperations({
      baseFlowId: input.flowId,
      moduleGraph: finalGraph,
      annotations,
      projectName: path.basename(input.projectRoot),
      codebaseHints: input.codebaseHints,
      checkedAt: new Date().toISOString(),
      globalLimitations: structuralFallbackLimitation ? [structuralFallbackLimitation] : [],
      preparedModuleGraph,
      lensPlans,
      expectLensPlans: true,
      repairAttemptedLensIds: attemptedLensIds
    });
  }
  lensCompilation = atlas.lensDiagnostics;
  for (const diagnostic of lensCompilation.filter((item) => item.fallbackUsed)) {
    degraded.push(`${diagnostic.lensId} lens used an explicit deterministic fallback after compilation${diagnostic.repairAttempted ? " and one targeted repair" : ""}: ${diagnostic.issues.join("; ")}.`);
  }
  let operations = enforceSemanticTruthOnAtlasOperations(atlas.operations, finalGraph);
  // The generated atlas must already be internally sound. Reviewer retries are for
  // proposed improvements, never for repairing an invalid starting graph.
  validateReviewedOperations(operations, operations, input.flowId, new Set(scan.files.map((file) => file.relPath)));
  let review: ImportReviewLedger | undefined;
  if (input.callProvider && input.reviewEnabled !== false) {
    try {
      const reviewed = await reviewArchitectureAtlasOperations({
        projectRoot: input.projectRoot,
        baseFlowId: input.flowId,
        operations,
        scan,
        inventory,
        effort: input.reviewEffort ?? "balanced",
        callProvider: input.callProvider,
        onProgress: emitProgress,
        shouldCancel,
        persistLedger: input.persistKnowledgeSnapshot,
        maxUnits: input.reviewMaxUnits
      });
      operations = enforceSemanticTruthOnAtlasOperations(reviewed.operations, finalGraph);
      review = reviewed.ledger;
      if (review.status === "partial") degraded.push(...review.limitations);
    } catch (error) {
      if (error instanceof CodebaseImportCancelledError || shouldCancel()) throw new CodebaseImportCancelledError();
      degraded.push(`Agentic architecture review was unavailable (${error instanceof Error ? error.message : String(error)}); the validated pre-review atlas was retained.`);
    }
  }
  const safeguards = semanticTruthSafeguardsForOperations(operations);
  if (input.persistKnowledgeSnapshot) {
    const evidenceWrite = rememberGraphEvidenceForFlows(
      input.projectRoot,
      atlas.flowIds.map((flowId) => ({
        flowId,
        edges: operations.flatMap((operation) => {
          if (operation.kind === "create-edge" && operation.flowId === flowId && operation.edge.id && operation.edge.evidence) {
            return [{ id: operation.edge.id, evidence: operation.edge.evidence }];
          }
          if (operation.kind === "create-flow" && operation.flow.id === flowId) {
            return operation.flow.edges.flatMap((edge) => edge.evidence ? [{ id: edge.id, evidence: edge.evidence }] : []);
          }
          return [];
        })
      }))
    );
    const knowledgeWrite = writeCodeKnowledgeSnapshot(input.projectRoot, buildCodeKnowledgeSnapshot({
      scan,
      parsed,
      fileGraph,
      source: "codebase-import",
      moduleGraph: finalGraph
    }));
    await Promise.all([evidenceWrite, knowledgeWrite]);
  }
  architectureProviderCalls.sort((left, right) => left.sequence - right.sequence);

  if (activePhase) {
    const now = Date.now();
    phaseTimings.push({ phase: activePhase.phase, label: activePhase.label, startedAt: activePhase.startedAt, completedAt: new Date(now).toISOString(), durationMs: now - activePhase.startedAtMs });
    activePhase = undefined;
  }
  const quality = evaluateImportQuality(finalGraph, scan);
  if (input.persistKnowledgeSnapshot) {
    const completedAtMs = Date.now();
    const completedAt = new Date(completedAtMs).toISOString();
    const importRunRecord = {
      version: 2,
      runId: importRunId,
      importerVersion: IMPORTER_VERSION,
      startedAt: importStartedAt,
      completedAt,
      durationMs: completedAtMs - importStartedAtMs,
      provider: input.provider,
      settings: {
        levels: input.levels,
        detail: input.detail,
        granularity: input.granularity,
        reviewEffort: input.reviewEffort ?? "balanced",
        reviewMaxUnits: input.reviewMaxUnits ?? codebaseReviewPartitionBudget[input.reviewEffort ?? "balanced"],
        semanticEnabled: input.semanticEnabled ?? false
      },
      phases: phaseTimings,
      architectureProvider: {
        calls: architectureProviderCalls,
        validation: architectureValidation,
        lensCompilation,
        compiledLensRepair
      },
      review: review ? {
        status: review.status,
        selectedUnits: review.totalUnits,
        possibleUnits: review.totalPlannedUnits,
        providerAttempts: review.unitResults.reduce((sum, unit) => sum + unit.providerAttempts, 0),
        failedProviderAttempts: review.failedProviderAttempts,
        retryAttempts: review.unitResults.reduce((sum, unit) => sum + Math.max(0, unit.providerAttempts - 1), 0),
        proposedEdits: review.proposedEdits,
        appliedEdits: review.appliedEdits,
        rejectedBatches: review.rejectedBatches,
        reviewedSubjects: review.reviewedSubjectIds.length,
        totalSubjects: review.totalSubjects,
        reviewedSourceFiles: review.reviewedSourceFiles.length,
        totalSourceFiles: review.totalSourceFiles,
        reviewedSourceSlices: review.reviewedSourceSlices.length,
        totalSourceSlices: review.totalSourceSlices,
        citedSourceFiles: review.citedSourceFiles,
        units: review.unitResults.map((unit) => ({
          unitId: unit.unitId,
          flowId: unit.flowId,
          kind: unit.kind,
          purpose: unit.purpose,
          priority: unit.priority,
          anomalySignals: unit.anomalySignals,
          startedAt: unit.startedAt,
          completedAt: unit.completedAt,
          durationMs: unit.durationMs,
          providerAttempts: unit.providerAttempts,
          failedProviderAttempts: unit.failedProviderAttempts,
          proposedEdits: unit.proposedEdits,
          appliedEdits: unit.appliedEdits,
          appliedChanges: unit.appliedChanges,
          findings: unit.findings,
          unresolved: unit.unresolved
        }))
      } : undefined,
      safeguards,
      degraded,
      quality
    };
    await Promise.all([
      writeJson(projectStatePath(input.projectRoot, "runtime", "import-run-latest.json"), importRunRecord),
      writeJson(projectStatePath(input.projectRoot, "runtime", "import-runs", `${importRunId}.json`), importRunRecord)
    ]);
  }

  const importCompletedAtMs = Date.now();
  const importCompletedAt = new Date(importCompletedAtMs).toISOString();
  const provenance = {
    runId: importRunId,
    importerVersion: IMPORTER_VERSION,
    startedAt: importStartedAt,
    completedAt: importCompletedAt,
    durationMs: importCompletedAtMs - importStartedAtMs,
    provider: input.provider,
    settings: {
      levels: input.levels,
      detail: input.detail,
      granularity: input.granularity,
      reviewEffort: input.reviewEffort ?? "balanced" as const,
      reviewMaxUnits: input.reviewMaxUnits ?? codebaseReviewPartitionBudget[input.reviewEffort ?? "balanced"],
      semanticEnabled: input.semanticEnabled ?? false
    }
  };

  return {
    operations,
    flowIds: atlas.flowIds,
    perspectiveFlowIds: atlas.perspectiveFlowIds,
    analysis,
    moduleGraph: finalGraph,
    analysisSnapshot: { scan, parsed, fileGraph },
    stats: {
      filesScanned: scan.stats.totalFiles,
      filesParsed: parsed.filter((file) => !file.parseError).length,
      fileEdges: fileGraph.edges.length,
      resolutionRate: fileGraph.resolutionRate,
      degraded,
      safeguards,
      quality,
      review,
      phaseTimings,
      provenance,
      architectureProvider: {
        calls: architectureProviderCalls,
        validation: architectureValidation,
        lensCompilation,
        compiledLensRepair
      }
    }
  };
}
