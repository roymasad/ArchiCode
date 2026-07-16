import type { Run } from "@shared/schema";
import { classifyRunFailure, runFailureNextStep, runFailureTitle, type RunFailureClassification } from "./runFailureTaxonomy";
import { latestProviderExplanation } from "./runProgress";

export type RunErrorSummary = {
  run: Run;
  classification: RunFailureClassification;
  title: string;
  message: string;
  at?: string;
};

const failureStatuses = new Set<Run["status"]>(["failed", "cancelled"]);

export function isRunErrorDismissed(run: Run): boolean {
  return Boolean(run.errorDismissedAt);
}

export function hasSuccessfulFollowUp(run: Run, runs: Run[]): boolean {
  const runsById = new Map(runs.map((item) => [item.id, item]));
  return runs.some((candidate) => {
    if (candidate.status !== "succeeded") return false;
    let current: Run | undefined = candidate;
    const seen = new Set<string>();
    while (current?.retryOf && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.retryOf === run.id) return true;
      current = runsById.get(current.retryOf);
    }
    return false;
  });
}

export function isRunErrorResolved(run: Run, runs: Run[] = []): boolean {
  return isRunErrorDismissed(run) || hasSuccessfulFollowUp(run, runs);
}

function firstUsefulLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => line.toLowerCase().startsWith("error:")) ?? lines[0] ?? text.trim();
}

export function runFailureDetails(run: Run, runs: Run[] = []): { classification: RunFailureClassification; title: string; message: string } | null {
  if (isRunErrorResolved(run, runs)) return null;
  if (!failureStatuses.has(run.status)) return null;

  const classification = classifyRunFailure(run);
  if (!classification) return null;

  const stderr = [...run.logs].reverse().find((line) => line.stream === "stderr" && line.text.trim());
  const message = stderr ? firstUsefulLine(stderr.text) : run.runInstructions ?? `${run.status} during ${run.phase}.`;
  const providerExplanation = /no source file changes|no source changes/i.test(message)
    ? latestProviderExplanation(run, 220)
    : null;
  const detail = providerExplanation ? `${message} Codex said: ${providerExplanation}` : message;
  const fallback = runFailureNextStep(classification);
  return {
    classification,
    title: runFailureTitle(classification),
    message: detail === run.runInstructions ? detail : `${detail} ${fallback}`.trim()
  };
}

export function runFailureMessage(run: Run, runs: Run[] = []): string | null {
  return runFailureDetails(run, runs)?.message ?? null;
}

export function collectRunErrors(runs: Run[]): RunErrorSummary[] {
  return runs
    .filter((run) => !isRunErrorResolved(run, runs))
    .flatMap((run) => {
      const details = runFailureDetails(run, runs);
      if (!details) return [];
      const source = [...run.logs].reverse().find((line) => line.stream === "stderr" && line.text.trim());
      return [{
        run,
        classification: details.classification,
        title: details.title,
        message: details.message,
        at: source?.at ?? run.completedAt ?? run.createdAt
      }];
    })
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}
