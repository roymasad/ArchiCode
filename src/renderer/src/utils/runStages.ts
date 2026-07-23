import { t } from "@renderer/i18n";
import type { Run } from "@shared/schema";
import { verificationOutcome } from "./runStatus";

export type RunStageTone = "neutral" | "accent" | "success" | "warning" | "danger";

export type RunStageItem = {
  label: string;
  tone: RunStageTone;
  detail: string;
};

type RunStageOptions = {
  planningReviewMode?: "auto" | "manual";
  codeReviewMode?: "auto-apply" | "manual";
};

function hasLog(run: Run, pattern: RegExp): boolean {
  return run.logs.some((line) => pattern.test(line.text));
}

function hasNoSourceChanges(run: Run): boolean {
  return hasLog(run, /no source file changes|no source changes/i);
}

function hasBenignNoSourceChanges(run: Run): boolean {
  return hasNoSourceChanges(run) && (run.status === "succeeded" || verificationOutcome(run) === "passed");
}

function hasProblemNoSourceChanges(run: Run): boolean {
  return hasNoSourceChanges(run) && !hasBenignNoSourceChanges(run) && (run.status === "failed" || run.status === "cancelled");
}

function reviewDecision(run: Run, kind: "planning" | "code"): "accepted" | "rejected" | "skipped" | null {
  const decision = [...run.reviewDecisions].reverse().find((item) => item.kind === kind);
  return decision?.decision === "accepted" || decision?.decision === "rejected" || decision?.decision === "skipped" ? decision.decision : null;
}

export function runStageItems(run: Run, options: RunStageOptions = {}): RunStageItem[] {
  const planningStarted = hasLog(run, /Planning phase started/i) || run.status === "planning" || run.phase === "planning";
  const planningDone = hasLog(run, /Planning completed|Planning returned|Planning produced|Planning graph bookkeeping|Planning completed without graph patch proposals/i) ||
    run.status === "awaiting-plan-review" ||
    reviewDecision(run, "planning") === "accepted" ||
    hasLog(run, /Coding phase started|API coding phase started|Debugging phase started|Verification phase started/i) ||
    run.sourceDiffArtifactIds.length > 0 ||
    run.status === "succeeded";
  const planningFailed = run.status === "failed" && planningStarted && !planningDone;
  const planningDecision = reviewDecision(run, "planning");
  const codeDecision = reviewDecision(run, "code");
  const autoPlanReviewSkipped = options.planningReviewMode === "auto";
  const autoCodeReviewSkipped = options.codeReviewMode === "auto-apply";
  const planReviewSkipped = planningDecision === "skipped" ||
    (autoPlanReviewSkipped && run.status !== "awaiting-plan-review" && planningDecision !== "accepted" && planningDecision !== "rejected");
  const codeReviewSkipped = codeDecision === "skipped" ||
    (autoCodeReviewSkipped && run.status !== "awaiting-code-review" && codeDecision !== "accepted" && codeDecision !== "rejected");
  const verificationRetry = (Boolean(run.retryOf) || hasLog(run, /Retrying this run from verification/i)) &&
    run.phase === "verifying" &&
    run.sourceDiffArtifactIds.length > 0;
  const codingStarted = hasLog(run, /Coding phase started|API coding phase started|Debugging phase started/i) ||
    ["coding", "debugging", "awaiting-code-review", "verifying", "succeeded"].includes(run.status);
  const codingChanged = codingStarted && (run.sourceDiffArtifactIds.length > 0 || hasLog(run, /Source diff artifact/i));
  const codingNoop = hasProblemNoSourceChanges(run);
  const codingNoopBenign = hasBenignNoSourceChanges(run);
  const verificationStarted = hasLog(run, /Verification phase started|Command exited/i) || run.phase === "verifying";
  const latestVerificationOutcome = verificationOutcome(run);
  const verificationSucceeded = latestVerificationOutcome === "passed";
  const verificationFailed = latestVerificationOutcome === "failed" || latestVerificationOutcome === "unknown";
  const verificationRunning = run.phase === "verifying" && (run.status === "running" || run.status === "verifying");
  const verificationWaiting = (autoPlanReviewSkipped || autoCodeReviewSkipped) &&
    !verificationStarted &&
    !verificationFailed &&
    !["failed", "cancelled", "succeeded"].includes(run.status);

  return [
    {
      label: t("Plan"),
      tone: run.status === "preparing" || run.status === "planning" ? "accent" : planningFailed ? "danger" : planningDone ? "success" : "neutral",
      detail: t(run.status === "preparing" ? "preparing" : run.status === "planning" ? "running" : planningFailed ? "failed" : planningDone ? "done" : "waiting")
    },
    {
      label: t("Plan review"),
      tone: run.status === "awaiting-plan-review" ? "warning" : planningDecision === "accepted" || planReviewSkipped ? "success" : planningDecision === "rejected" ? "danger" : planningDone && codingStarted ? "success" : "neutral",
      detail: t(run.status === "awaiting-plan-review" ? "needed" : planningDecision === "accepted" ? "approved" : planningDecision === "rejected" ? "rejected" : planReviewSkipped ? "skipped" : planningDone && codingStarted ? "auto" : planningFailed ? "not run" : "waiting")
    },
    {
      label: t("Code"),
      tone: codingNoop ? "danger" : codingNoopBenign ? "success" : run.status === "coding" || run.status === "debugging" ? "accent" : run.status === "awaiting-code-review" ? "warning" : codingChanged ? "success" : codingStarted && run.status === "failed" ? "danger" : codingStarted ? "neutral" : "neutral",
      detail: t(codingNoop ? "no changes" : codingNoopBenign ? "not needed" : run.status === "coding" ? "running" : run.status === "awaiting-code-review" ? "review" : verificationRetry ? "reused" : codingChanged ? "changed" : codingStarted ? "not needed" : planningFailed ? "not run" : "waiting")
    },
    {
      label: t("Code review"),
      tone: run.status === "awaiting-code-review" ? "warning" : codeDecision === "accepted" || codeReviewSkipped ? "success" : codeDecision === "rejected" ? "danger" : codingChanged && (verificationStarted || run.status === "succeeded") ? "success" : "neutral",
      detail: t(run.status === "awaiting-code-review" ? "needed" : codeDecision === "accepted" ? "approved" : codeDecision === "rejected" ? "rejected" : codeReviewSkipped ? "skipped" : codingChanged && (verificationStarted || run.status === "succeeded") ? "auto" : "not needed")
    },
    {
      label: t("Verify"),
      tone: verificationFailed ? "danger" : verificationRunning ? "accent" : verificationSucceeded ? "success" : run.status === "succeeded" && !codingNoop ? "success" : "neutral",
      detail: t(verificationFailed ? "failed" : verificationRunning ? "running" : verificationSucceeded ? "passed" : run.status === "succeeded" && !codingNoop ? "done" : verificationStarted ? "done" : verificationWaiting ? "waiting" : "not run")
    }
  ];
}
