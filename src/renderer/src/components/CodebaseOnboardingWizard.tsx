import { formatNumber } from "@renderer/i18n";
import { t } from "@renderer/i18n";
import { AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { codebaseReviewPartitionBudget } from "@shared/schema";
import type { CodebaseMappingSummary } from "../../../preload";
import { useArchicodeStore, type CodebaseOnboardingDetail, type CodebaseOnboardingGranularity, type CodebaseOnboardingLevel, type CodebaseOnboardingReviewEffort } from "../store/useArchicodeStore";
import { Button, DialogContent, DialogRoot, Field, Select } from "./ui";

const levelOptions: Array<{ value: CodebaseOnboardingLevel; label: string; hint?: string }> = [
  { value: "1", label: t("1 total flow: flat overview") },
  { value: "2", label: t("2 total flows: overview + one detail flow") },
  { value: "3", label: t("3 total flows: context -> areas -> components"), hint: t("default") },
  { value: "4", label: t("4 total flows: context -> areas -> components -> modules") }
];

const detailOptions: Array<{ value: CodebaseOnboardingDetail; label: string; hint?: string }> = [
  { value: "light", label: t("Light detail") },
  { value: "balanced", label: t("Balanced detail"), hint: t("default") },
  { value: "deep", label: t("Deep detail") }
];

const reviewEffortOptions: Array<{ value: CodebaseOnboardingReviewEffort; label: string; hint?: string }> = [
  { value: "light", label: t("Light review · up to {{light}} partitions", { light: codebaseReviewPartitionBudget.light }) },
  { value: "balanced", label: t("Balanced review · up to {{balanced}} partitions", { balanced: codebaseReviewPartitionBudget.balanced }), hint: t("default") },
  { value: "deep", label: t("Deep review · up to {{deep}} partitions", { deep: codebaseReviewPartitionBudget.deep }) },
  { value: "ultra", label: t("Ultra review · up to {{ultra}} partitions", { ultra: codebaseReviewPartitionBudget.ultra }) }
];

const granularityOptions: Array<{ value: CodebaseOnboardingGranularity; label: string; hint?: string }> = [
  { value: "system", label: t("Systems: big-picture areas only") },
  { value: "module", label: t("Modules: packages and services") },
  { value: "component", label: t("Components: inside each module"), hint: t("default") },
  { value: "file", label: t("Files: every source file") }
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
        <strong>{t("{{title}} ( {{length}} )", { title: title, length: messages.length })}</strong>
        <span>{t("View details")}</span>
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
      ? `${formatNumber(summary.graph.operationsFailed)} generated graph change${summary.graph.operationsFailed === 1 ? "" : "s"} could not be saved. Rerun the import before relying on the map.`
      : summary.review?.status === "failed"
        ? "The architecture review did not finish. Rerun the import to complete the quality check before relying on the map."
        : "";
  const reviewValue = summary.review
    ? `${summary.review.reviewedUnits}/${summary.review.selectedUnits} checks completed`
    : "Not run";
  const hasDetailedProviderCalls = summary.providerCalls.architecture !== undefined && summary.providerCalls.review !== undefined;
  const providerCallValue = hasDetailedProviderCalls
    ? `${formatNumber(summary.providerCalls.total)} total · ${formatNumber(summary.providerCalls.architecture!)} architecture · ${formatNumber(summary.providerCalls.review!)} review · ${formatNumber((summary.providerCalls.runtimeSetup ?? 0))} runtime setup`
    : `${formatNumber(summary.providerCalls.total)} total · ${formatNumber(summary.providerCalls.failed)} failed`;
  const accuracy = summary.accuracyEstimate;
  return (
    <div className={hasIssues ? "onboarding-summary has-issues" : "onboarding-summary"}>
      <div className="onboarding-summary-heading">
        {hasIssues ? <AlertTriangle size={22} /> : <CheckCircle2 size={22} />}
        <div>
          <strong>{hasIssues ? t("Map created with an issue requiring attention") : t("Map ready to explore")}</strong>
          <span>
            {hasIssues
              ? issueMessage
              : t("ArchiCode generated {{value1}} architecture flows and completed the selected review. No action is required.", { value1: formatNumber(summary.graph.flows) })}
          </span>
        </div>
      </div>

      <div className="onboarding-summary-grid is-outcome">
        {accuracy ? (
          <div className="onboarding-summary-accuracy">
            <span>{t("Estimated accuracy")}</span>
            <strong>{t("{{score}}% · {{label}}", { score: accuracy.score, label: accuracy.label })}</strong>
            <small>{accuracy.recommendation}</small>
          </div>
        ) : null}
        <div><span>{t("Total time")}</span><strong>{formatElapsedTime(summary.durationMs)}</strong></div>
        <div>
          <span>{t("Repository coverage")}</span>
          <strong>{t("{{value1}} files scanned", { value1: formatNumber(summary.files.scanned) })}</strong>
          <small>{t("{{value1}} source files parsed in depth", { value1: formatNumber(summary.files.parsed) })}</small>
        </div>
        <div>
          <span>{t("Generated map")}</span>
          <strong>{t("{{value1}} flows", { value1: formatNumber(summary.graph.flows) })}</strong>
          <small>{t("{{value1}} nodes · {{value2}} relationships", { value1: formatNumber(summary.graph.nodes), value2: formatNumber(summary.graph.relationships) })}</small>
        </div>
        <div>
          <span>{t("Architecture review")}</span>
          <strong>{reviewValue}</strong>
          <small>{summary.review ? t("{{value1}} verified improvements applied", { value1: formatNumber(summary.review.appliedEdits) }) : t("Generated without an LLM review")}</small>
        </div>
      </div>

      <details className="onboarding-summary-technical">
        <summary>
          <div>
            <strong>{t("Technical import report")}</strong>
            <span>{t("Provider activity, safeguards, coverage notes, and phase timing")}</span>
          </div>
          <span>{t("View details")}</span>
        </summary>
        <div className="onboarding-summary-technical-body">
          <div className="onboarding-summary-meta">
            <span>{t("{{label}} {{value2}}", { label: summary.provider.label, value2: summary.provider.model ? ` · ${summary.provider.model}` : "" })}</span>
            <span>{t("{{value1}}% imports resolved", { value1: Math.round(summary.files.resolutionRate * 100) })}</span>
            <span>{t("{{value1}} import links", { value1: formatNumber(summary.files.importLinks) })}</span>
            <span>{providerCallValue}</span>
            {hasDetailedProviderCalls ? <span>{t("{{value1}} retries recovered · {{value2}} failed calls · {{value3}} invalid suggestions safely ignored", { value1: formatNumber((summary.providerCalls.retries ?? 0)), value2: formatNumber(summary.providerCalls.failed), value3: formatNumber((summary.providerCalls.rejected ?? 0)) })}</span> : null}
            {summary.review?.reviewedSourceFiles !== undefined
              ? <span>{t("{{value1}} source files deeply reviewed · {{reviewEffort}} budget", { value1: formatNumber(summary.review.reviewedSourceFiles), reviewEffort: summary.settings.reviewEffort })}</span>
              : null}
          </div>

          {summary.errors.length ? (
            <div className="onboarding-summary-issues is-error">
              <strong>{t("Provider or graph errors ( {{length}} )", { length: summary.errors.length })}</strong>
              <ul>{summary.errors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul>
            </div>
          ) : null}
          <ImportSummaryDetails title={t("Automated protections applied")} messages={report.correctionsAndSafeguards} />
          {accuracy ? <ImportSummaryDetails title={t("Accuracy estimate factors")} messages={[accuracy.explanation, ...accuracy.factors.map((factor) => `${factor.label}: ${factor.value}`)]} /> : null}
          <ImportSummaryDetails title={t("Coverage and review notes")} messages={report.limitations} />
          <ImportSummaryDetails title={t("Unverified suggestions omitted")} messages={report.rejectedReviewSuggestions} />
          <ImportSummaryDetails title={t("Additional implementation details")} messages={report.informationalNotes} />

          {summary.phaseTimings.length ? (
            <details className="onboarding-summary-phases">
              <summary>{t("Phase timing breakdown")}</summary>
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
          title={completedSummary ? t("Codebase import summary") : t("Map Existing Codebase")}
          description={completedSummary
            ? t("The import is finished. Review the result, then open the generated map.")
            : t("This folder did not have ArchiCode graph metadata yet. ArchiCode created an empty workspace; you can let an LLM map the current codebase into flows and nodes.")}
          className="codebase-onboarding-dialog"
          hideCloseButton
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          {completedSummary ? <ImportCompletionSummary summary={completedSummary} /> : <>
          <div className="onboarding-detected">
            <strong>{t("Detected")}</strong>
            <span>{codebaseOnboarding.codebaseHints.length ? codebaseOnboarding.codebaseHints.join(", ") : t("No common stack markers found")}</span>
          </div>

          {!mappingInProgress ? (
            <div className={providerReady ? "onboarding-provider is-ready" : "onboarding-provider needs-setup"}>
              <strong>{t("LLM provider required")}</strong>
              <span>{providerStatus}</span>
              <div className="action-row">
                <Button type="button" size="sm" variant="secondary" onClick={() => openProjectSettings("providers")}>{t("{{value1}} {{value2}}", { value1: t("Set up provider"), value2: " " })}</Button>
                {enabledProvider && providerIsLlm ? (
                  <Button type="button" size="sm" onClick={() => void checkProvider(enabledProvider.id)}>{t("{{value1}} {{value2}}", { value1: t("Check again"), value2: " " })}</Button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="onboarding-controls">
            <Field label={t("Diagram depth")} hint={depthHint}>
              <Select
                value={levels}
                onValueChange={(value) => setLevels(value as CodebaseOnboardingLevel)}
                options={levelOptions}
                disabled={mappingInProgress}
              />
            </Field>
            <Field label={t("Node detail")} hint={detailHint}>
              <Select
                value={detail}
                onValueChange={(value) => setDetail(value as CodebaseOnboardingDetail)}
                options={detailOptions}
                disabled={mappingInProgress}
              />
            </Field>
            <Field label={t("Review effort")} hint={reviewEffortHint}>
              <Select
                value={reviewEffort}
                onValueChange={(value) => setReviewEffort(value as CodebaseOnboardingReviewEffort)}
                options={reviewEffortOptions}
                disabled={mappingInProgress}
              />
            </Field>
            <Field label={t("Smallest unit")} hint={granularityHint}>
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
                  <strong>{t("Import failed")}</strong>
                  <span>{mapping.error}</span>
                  {elapsedLabel ? <span className="onboarding-progress-elapsed">{t("Elapsed {{elapsedLabel}}", { elapsedLabel: elapsedLabel })}</span> : null}
                </div>
              ) : (
                <div className="onboarding-progress-copy">
                  <strong>{t("{{null}} {{status}}", { null: mapping.step && mapping.totalSteps ? `Step ${mapping.step}/${mapping.totalSteps}: ` : null, status: mapping.status })}</strong>
                  {mapping.detail ? <span>{mapping.detail}</span> : null}
                  {mapping.itemsDone !== undefined && mapping.itemsTotal !== undefined && !mapping.detail ? (
                    <span>{t("{{value1}} / {{value2}} files", { value1: formatNumber(mapping.itemsDone), value2: formatNumber(mapping.itemsTotal) })}</span>
                  ) : null}
                  {elapsedLabel ? <span className="onboarding-progress-elapsed" aria-live="off">{t("Elapsed {{elapsedLabel}}", { elapsedLabel: elapsedLabel })}</span> : null}
                </div>
              )}
            </div>
          ) : null}

          <div className="onboarding-warning">
            <AlertTriangle size={17} />
            <span>{t("{{value1}} {{value2}}", { value1: t("This initial import is a one-time operation and can take time while ArchiCode analyzes and reviews the codebase. Skipping is allowed, but the graph will remain empty until you generate a map or add nodes manually."), value2: " " })}</span>
          </div>
          </>}

          <div className="dialog-actions">
            {completedSummary ? (
              <Button type="button" variant="primary" onClick={dismissCodebaseOnboarding}>{t("{{value1}} {{value2}}", { value1: t("Explore graph"), value2: " " })}</Button>
            ) : <>{mappingInProgress ? (
              <Button type="button" variant="secondary" onClick={() => void cancelCodebaseOnboardingRun()}>{t("{{value1}} {{value2}}", { value1: t("Cancel import"), value2: " " })}</Button>
            ) : (
              <Button type="button" variant="secondary" onClick={dismissCodebaseOnboarding}>
                {mapping?.error ? t("Close") : t("Skip for now")}
              </Button>
            )}
            <Button type="button" variant="primary" disabled={!providerReady || mappingInProgress} onClick={() => void startCodebaseOnboardingRun({ levels, detail, reviewEffort, granularity })}>
              <Sparkles size={15} />
              <span>{mapping?.error ? t("Try again") : mappingInProgress ? t("Mapping codebase") : t("Generate map with AI")}</span>
            </Button>
            </>}
          </div>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}
