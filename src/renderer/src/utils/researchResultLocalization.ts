import { t } from "@renderer/i18n";

function localizeRejectedOperation(detail: string): string {
  const punctuation = detail.endsWith(".") ? "." : "";
  const value = punctuation ? detail.slice(0, -1) : detail;

  const updateNode = value.match(/^Update node (.+)$/);
  if (updateNode) return `${t("Update node {{name}}", { name: updateNode[1] })}${punctuation}`;

  const updateFlow = value.match(/^Update flow "(.+)"$/);
  if (updateFlow) return `${t("Update flow \"{{name}}\"", { name: updateFlow[1] })}${punctuation}`;

  const createRootNode = value.match(/^Create node "(.+)" on root flow$/);
  if (createRootNode) return `${t("Create node \"{{name}}\" on root flow", { name: createRootNode[1] })}${punctuation}`;

  const createSubflowNode = value.match(/^Create node "(.+)" in subflow "(.+)"$/);
  if (createSubflowNode) {
    return `${t("Create node \"{{name}}\" in subflow \"{{subflow}}\"", {
      name: createSubflowNode[1],
      subflow: createSubflowNode[2]
    })}${punctuation}`;
  }

  const createEdge = value.match(/^Create edge (.+) -> (.+)$/);
  if (createEdge) {
    return `${t("Create edge {{source}} -> {{target}}", {
      source: createEdge[1],
      target: createEdge[2]
    })}${punctuation}`;
  }

  if (value === "Update project metadata") return `${t("Update project metadata")}${punctuation}`;
  return detail;
}

function localizeRejectedOperationList(details: string): string {
  return details
    .split("; ")
    .map(localizeRejectedOperation)
    .join("; ");
}

/**
 * Review reports keep a stable English envelope because they are persisted and
 * parsed as host records. Localize deterministic fallback prose at display time.
 */
export function localizeChangeSetResultNarrative(narrative: string): string {
  const outcomePrefix = "Outcome: ";
  const includesOutcomePrefix = narrative.startsWith(outcomePrefix);
  const includesDeterministicOutcome =
    narrative.includes("Not applied by your selection: ")
    || narrative.includes("I kept this exact review outcome and did not generate another proposal.");
  if (!includesOutcomePrefix && !includesDeterministicOutcome) return narrative;

  let localized = includesOutcomePrefix ? narrative.slice(outcomePrefix.length) : narrative;
  localized = localized.replace(
    /Not applied by your selection: (.*?)(?= I kept this exact review outcome and did not generate another proposal\.|$)/,
    (_match, details: string) =>
      `${t("research.reviewOutcomeRejected")} ${localizeRejectedOperationList(details)}`
  );
  localized = localized.replace(
    "I kept this exact review outcome and did not generate another proposal.",
    t("research.reviewOutcomePreserved")
  );

  return includesOutcomePrefix ? `${t("research.reviewOutcomeLabel")} ${localized}` : localized;
}

export function localizeChangeSetResultDetails(details: string): string {
  return details
    .replace(
      /^Rejected: (.*?) \(Rejected or left unapplied by the user\.\)$/gm,
      (_match, detail: string) =>
        `${t("Rejected")}: ${localizeRejectedOperation(detail)} (${t("research.reviewRejectedReason")})`
    )
    .replace(/^(Applied|Queued|Rejected|Failed):/gm, (_match, status: string) => `${t(status)}:`)
    .replace(
      /^No automatic retry was created\. Ask explicitly for a retry or a new proposal if you want to change the remaining operations\.$/gm,
      t("research.reviewNoAutomaticRetry")
    );
}
