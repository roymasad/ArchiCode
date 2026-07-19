import { AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { codebaseReviewPartitionBudget } from "@shared/schema";
import type { CodebaseMappingSummary } from "../../../preload";
import { useArchicodeStore, type CodebaseOnboardingDetail, type CodebaseOnboardingGranularity, type CodebaseOnboardingLevel, type CodebaseOnboardingReviewEffort } from "../store/useArchicodeStore";
import { Button, DialogContent, DialogRoot, Field, Select } from "./ui";

const levelOptions: Array<{ value: CodebaseOnboardingLevel; label: string; hint?: string }> = [
  { value: "1", label: "1 total flow: flat overview" },
  { value: "2", label: "2 total flows: overview + one detail flow" },
  { value: "3", label: "3 total flows: context -> areas -> components", hint: "default" },
  { value: "4", label: "4 total flows: context -> areas -> components -> modules" }
];

const detailOptions: Array<{ value: CodebaseOnboardingDetail; label: string; hint?: string }> = [
  { value: "light", label: "Light detail" },
  { value: "balanced", label: "Balanced detail", hint: "default" },
  { value: "deep", label: "Deep detail" }
];

const reviewEffortOptions: Array<{ value: CodebaseOnboardingReviewEffort; label: string; hint?: string }> = [
  { value: "light", label: `Light review · up to ${codebaseReviewPartitionBudget.light} partitions` },
  { value: "balanced", label: `Balanced review · up to ${codebaseReviewPartitionBudget.balanced} partitions`, hint: "default" },
  { value: "deep", label: `Deep review · up to ${codebaseReviewPartitionBudget.deep} partitions` },
  { value: "ultra", label: `Ultra review · up to ${codebaseReviewPartitionBudget.ultra} partitions` }
];

const granularityOptions: Array<{ value: CodebaseOnboardingGranularity; label: string; hint?: string }> = [
  { value: "system", label: "Systems: big-picture areas only" },
  { value: "module", label: "Modules: packages and services" },
  { value: "component", label: "Components: inside each module", hint: "default" },
  { value: "file", label: "Files: every source file" }
];

const depthHint = "How many drill-down levels the map has. Each level below the root becomes a nested flow you enter by opening a parent node.";
const detailHint = "How many nodes fit on each level before small ones are folded together: light ≈ 6-10, balanced ≈ 10-16, deep ≈ 16-30 per flow.";
const reviewEffortHint = "How thoroughly the LLM checks generated flows against bounded source slices. This affects review time and provider usage, not graph density.";
const granularityHint = "The smallest thing one node can represent — the map's zoom floor. Systems stop at big areas; Modules show packages and services; Components go inside each module; Files show individual source files. Finer units still show the coarser ones on the levels above, and need enough diagram depth to be reached.";

function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function ImportSummaryDetails({
  title,
  messages,
  className = ""
}: {
  title: string;
  messages: string[];
  className?: string;
}) {
  if (!messages.length) return null;
  return (
    <details className={`onboarding-summary-details${className ? ` ${className}` : ""}`}>
      <summary>
        <strong>{title} ({messages.length})</strong>
        <span>View details</span>
      </summary>
      <ul>{messages.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul>
    </details>
  );
}

function ImportCompletionSummary({ summary }: { summary: CodebaseMappingSummary }) {
  const report = summary.report ?? {
    correctionsAndSafeguards: [],
    limitations: summary.warnings,
    rejectedReviewSuggestions: [],
    informationalNotes: []
  };
  const hasIssues = summary.graph.flows === 0
    || summary.graph.operationsFailed > 0
    || summary.review?.status === "failed";
  const issueMessage = summary.graph.flows === 0
    ? "No architecture flows were generated. Rerun the import; if it happens again, open the technical report before retrying."
    : summary.graph.operationsFailed > 0
      ? `${summary.graph.operationsFailed.toLocaleString()} generated graph change${summary.graph.operationsFailed === 1 ? "" : "s"} could not be saved. Rerun the import before relying on the map.`
      : summary.review?.status === "failed"
        ? "The architecture review did not finish. Rerun the import to complete the quality check before relying on the map."
        : "";
  const reviewValue = summary.review
    ? `${summary.review.reviewedUnits}/${summary.review.selectedUnits} checks completed`
    : "Not run";
  const hasDetailedProviderCalls = summary.providerCalls.architecture !== undefined && summary.providerCalls.review !== undefined;
  const providerCallValue = hasDetailedProviderCalls
    ? `${summary.providerCalls.total.toLocaleString()} total · ${summary.providerCalls.architecture!.toLocaleString()} architecture · ${summary.providerCalls.review!.toLocaleString()} review · ${(summary.providerCalls.runtimeSetup ?? 0).toLocaleString()} runtime setup`
    : `${summary.providerCalls.total.toLocaleString()} total · ${summary.providerCalls.failed.toLocaleString()} failed`;
  const accuracy = summary.accuracyEstimate;
  return (
    <div className={hasIssues ? "onboarding-summary has-issues" : "onboarding-summary"}>
      <div className="onboarding-summary-heading">
        {hasIssues ? <AlertTriangle size={22} /> : <CheckCircle2 size={22} />}
        <div>
          <strong>{hasIssues ? "Map created with an issue requiring attention" : "Map ready to explore"}</strong>
          <span>
            {hasIssues
              ? issueMessage
              : `ArchiCode generated ${summary.graph.flows.toLocaleString()} architecture flows and completed the selected review. No action is required.`}
          </span>
        </div>
      </div>

      <div className="onboarding-summary-grid is-outcome">
        {accuracy ? (
          <div className="onboarding-summary-accuracy">
            <span>Estimated accuracy</span>
            <strong>{accuracy.score}% · {accuracy.label}</strong>
            <small>{accuracy.recommendation}</small>
          </div>
        ) : null}
        <div><span>Total time</span><strong>{formatElapsedTime(summary.durationMs)}</strong></div>
        <div>
          <span>Repository coverage</span>
          <strong>{summary.files.scanned.toLocaleString()} files scanned</strong>
          <small>{summary.files.parsed.toLocaleString()} source files parsed in depth</small>
        </div>
        <div>
          <span>Generated map</span>
          <strong>{summary.graph.flows.toLocaleString()} flows</strong>
          <small>{summary.graph.nodes.toLocaleString()} nodes · {summary.graph.relationships.toLocaleString()} relationships</small>
        </div>
        <div>
          <span>Architecture review</span>
          <strong>{reviewValue}</strong>
          <small>{summary.review ? `${summary.review.appliedEdits.toLocaleString()} verified improvements applied` : "Generated without an LLM review"}</small>
        </div>
      </div>

      <details className="onboarding-summary-technical">
        <summary>
          <div>
            <strong>Technical import report</strong>
            <span>Provider activity, safeguards, coverage notes, and phase timing</span>
          </div>
          <span>View details</span>
        </summary>
        <div className="onboarding-summary-technical-body">
          <div className="onboarding-summary-meta">
            <span>{summary.provider.label}{summary.provider.model ? ` · ${summary.provider.model}` : ""}</span>
            <span>{Math.round(summary.files.resolutionRate * 100)}% imports resolved</span>
            <span>{summary.files.importLinks.toLocaleString()} import links</span>
            <span>{providerCallValue}</span>
            {hasDetailedProviderCalls ? <span>{(summary.providerCalls.retries ?? 0).toLocaleString()} retries recovered · {summary.providerCalls.failed.toLocaleString()} failed calls · {(summary.providerCalls.rejected ?? 0).toLocaleString()} invalid suggestions safely ignored</span> : null}
            {summary.review?.reviewedSourceFiles !== undefined
              ? <span>{summary.review.reviewedSourceFiles.toLocaleString()} source files deeply reviewed · {summary.settings.reviewEffort} budget</span>
              : null}
          </div>

          {summary.errors.length ? (
            <div className="onboarding-summary-issues is-error">
              <strong>Provider or graph errors ({summary.errors.length})</strong>
              <ul>{summary.errors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul>
            </div>
          ) : null}
          <ImportSummaryDetails title="Automated protections applied" messages={report.correctionsAndSafeguards} />
          {accuracy ? <ImportSummaryDetails title="Accuracy estimate factors" messages={[accuracy.explanation, ...accuracy.factors.map((factor) => `${factor.label}: ${factor.value}`)]} /> : null}
          <ImportSummaryDetails title="Coverage and review notes" messages={report.limitations} />
          <ImportSummaryDetails title="Unverified suggestions omitted" messages={report.rejectedReviewSuggestions} />
          <ImportSummaryDetails title="Additional implementation details" messages={report.informationalNotes} />

          {summary.phaseTimings.length ? (
            <details className="onboarding-summary-phases">
              <summary>Phase timing breakdown</summary>
              <div>
                {summary.phaseTimings.map((phase, index) => (
                  <span key={`${phase.phase}-${index}`}><strong>{phase.label}</strong>{formatElapsedTime(phase.durationMs)}</span>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </details>
    </div>
  );
}

export function CodebaseOnboardingWizard() {
  const {
    bundle,
    providerHealth,
    codebaseOnboarding,
    dismissCodebaseOnboarding,
    startCodebaseOnboardingRun,
    cancelCodebaseOnboardingRun,
    openProjectSettings,
    checkProvider
  } = useArchicodeStore(useShallow((state) => ({
    bundle: state.bundle,
    providerHealth: state.providerHealth,
    codebaseOnboarding: state.codebaseOnboarding,
    dismissCodebaseOnboarding: state.dismissCodebaseOnboarding,
    startCodebaseOnboardingRun: state.startCodebaseOnboardingRun,
    cancelCodebaseOnboardingRun: state.cancelCodebaseOnboardingRun,
    openProjectSettings: state.openProjectSettings,
    checkProvider: state.checkProvider
  })));
  const [levels, setLevels] = useState<CodebaseOnboardingLevel>("3");
  const [detail, setDetail] = useState<CodebaseOnboardingDetail>("balanced");
  const [reviewEffort, setReviewEffort] = useState<CodebaseOnboardingReviewEffort>("balanced");
  const [granularity, setGranularity] = useState<CodebaseOnboardingGranularity>("component");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const autoCheckedProviderId = useRef<string | null>(null);
  const enabledProvider = bundle?.project.settings.providers.find((provider) => provider.enabled);
  const enabledProviderHealth = enabledProvider ? providerHealth[enabledProvider.id] : null;
  const providerIsLlm = enabledProvider ? enabledProvider.kind !== "offline-manual" : false;
  const providerReady = Boolean(providerIsLlm && enabledProviderHealth?.ok);
  const mapping = codebaseOnboarding?.mapping ?? null;
  const completedSummary = mapping?.result ?? null;
  const mappingInProgress = Boolean(mapping && !mapping.error && !completedSummary);
  const elapsedLabel = completedSummary
    ? formatElapsedTime(completedSummary.durationMs)
    : mapping?.startedAtMs
      ? formatElapsedTime((mapping.completedAtMs ?? nowMs) - mapping.startedAtMs)
      : null;
  const mappingPercent = mapping?.step && mapping.totalSteps
    ? Math.max(8, Math.min(100, Math.round((mapping.step / mapping.totalSteps) * 100)))
    : 8;
  const providerStatus = !enabledProvider
    ? "No LLM provider is selected."
    : !providerIsLlm
      ? "The selected provider is manual/offline, but codebase mapping requires an LLM provider."
      : enabledProviderHealth?.ok
        ? `${enabledProvider.label} is ready.`
        : enabledProviderHealth
          ? `${enabledProvider.label} is not ready: ${enabledProviderHealth.message}`
          : `${enabledProvider.label} has not been checked yet.`;

  useEffect(() => {
    if (!codebaseOnboarding) {
      autoCheckedProviderId.current = null;
      return;
    }
    if (!enabledProvider || !providerIsLlm) return;
    if (autoCheckedProviderId.current === enabledProvider.id) return;
    autoCheckedProviderId.current = enabledProvider.id;
    void checkProvider(enabledProvider.id);
  }, [checkProvider, codebaseOnboarding, enabledProvider, providerIsLlm]);

  useEffect(() => {
    if (!mappingInProgress || !mapping?.startedAtMs) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [mapping?.startedAtMs, mappingInProgress]);

  return (
    <DialogRoot open={Boolean(codebaseOnboarding)} onOpenChange={(open) => {
      if (!open) dismissCodebaseOnboarding();
    }}>
      {codebaseOnboarding ? (
        <DialogContent
          title={completedSummary ? "Codebase import summary" : "Map Existing Codebase"}
          description={completedSummary
            ? "The import is finished. Review the result, then open the generated map."
            : "This folder did not have ArchiCode graph metadata yet. ArchiCode created an empty workspace; you can let an LLM map the current codebase into flows and nodes."}
          className="codebase-onboarding-dialog"
          hideCloseButton
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          {completedSummary ? <ImportCompletionSummary summary={completedSummary} /> : <>
          <div className="onboarding-detected">
            <strong>Detected</strong>
            <span>{codebaseOnboarding.codebaseHints.length ? codebaseOnboarding.codebaseHints.join(", ") : "No common stack markers found"}</span>
          </div>

          {!mappingInProgress ? (
            <div className={providerReady ? "onboarding-provider is-ready" : "onboarding-provider needs-setup"}>
              <strong>LLM provider required</strong>
              <span>{providerStatus}</span>
              <div className="action-row">
                <Button type="button" size="sm" variant="secondary" onClick={() => openProjectSettings("providers")}>
                  Set up provider
                </Button>
                {enabledProvider && providerIsLlm ? (
                  <Button type="button" size="sm" onClick={() => void checkProvider(enabledProvider.id)}>
                    Check again
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="onboarding-controls">
            <Field label="Diagram depth" hint={depthHint}>
              <Select
                value={levels}
                onValueChange={(value) => setLevels(value as CodebaseOnboardingLevel)}
                options={levelOptions}
                disabled={mappingInProgress}
              />
            </Field>
            <Field label="Node detail" hint={detailHint}>
              <Select
                value={detail}
                onValueChange={(value) => setDetail(value as CodebaseOnboardingDetail)}
                options={detailOptions}
                disabled={mappingInProgress}
              />
            </Field>
            <Field label="Review effort" hint={reviewEffortHint}>
              <Select
                value={reviewEffort}
                onValueChange={(value) => setReviewEffort(value as CodebaseOnboardingReviewEffort)}
                options={reviewEffortOptions}
                disabled={mappingInProgress}
              />
            </Field>
            <Field label="Smallest unit" hint={granularityHint}>
              <Select
                value={granularity}
                onValueChange={(value) => setGranularity(value as CodebaseOnboardingGranularity)}
                options={granularityOptions}
                disabled={mappingInProgress}
              />
            </Field>
          </div>

          {mapping ? (
            <div className={mapping.error ? "onboarding-progress is-error" : "onboarding-progress"}>
              {mapping.error ? null : (
                <div
                  className="onboarding-progress-bar"
                  aria-hidden="true"
                  style={{ "--progress": `${mappingPercent}%` } as CSSProperties & Record<"--progress", string>}
                />
              )}
              {mapping.error ? (
                <div className="onboarding-progress-copy">
                  <strong>Import failed</strong>
                  <span>{mapping.error}</span>
                  {elapsedLabel ? <span className="onboarding-progress-elapsed">Elapsed {elapsedLabel}</span> : null}
                </div>
              ) : (
                <div className="onboarding-progress-copy">
                  <strong>
                    {mapping.step && mapping.totalSteps ? `Step ${mapping.step}/${mapping.totalSteps}: ` : null}
                    {mapping.status}
                  </strong>
                  {mapping.detail ? <span>{mapping.detail}</span> : null}
                  {mapping.itemsDone !== undefined && mapping.itemsTotal !== undefined && !mapping.detail ? (
                    <span>{mapping.itemsDone.toLocaleString()} / {mapping.itemsTotal.toLocaleString()} files</span>
                  ) : null}
                  {elapsedLabel ? <span className="onboarding-progress-elapsed" aria-live="off">Elapsed {elapsedLabel}</span> : null}
                </div>
              )}
            </div>
          ) : null}

          <div className="onboarding-warning">
            <AlertTriangle size={17} />
            <span>
              This initial import is a one-time operation and can take time while ArchiCode analyzes and reviews the
              codebase. Skipping is allowed, but the graph will remain empty until you generate a map or add nodes
              manually.
            </span>
          </div>
          </>}

          <div className="dialog-actions">
            {completedSummary ? (
              <Button type="button" variant="primary" onClick={dismissCodebaseOnboarding}>
                Explore graph
              </Button>
            ) : <>{mappingInProgress ? (
              <Button type="button" variant="secondary" onClick={() => void cancelCodebaseOnboardingRun()}>
                Cancel import
              </Button>
            ) : (
              <Button type="button" variant="secondary" onClick={dismissCodebaseOnboarding}>
                {mapping?.error ? "Close" : "Skip for now"}
              </Button>
            )}
            <Button type="button" variant="primary" disabled={!providerReady || mappingInProgress} onClick={() => void startCodebaseOnboardingRun({ levels, detail, reviewEffort, granularity })}>
              <Sparkles size={15} />
              <span>{mapping?.error ? "Try again" : mappingInProgress ? "Mapping codebase" : "Generate map with AI"}</span>
            </Button>
            </>}
          </div>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}
