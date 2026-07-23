export type ChangeSetResultReportPresentation = {
  category: "graph" | "queue" | "change";
  applied: number;
  rejected: number;
  failed: number;
  title: string;
  summary: string;
  narrative: string;
  details: string;
  operationCount: number;
  tone: "success" | "warning" | "danger";
};

export function changeSetResultReportPresentation(content: string): ChangeSetResultReportPresentation | null {
  const trimmed = content.trim();
  let category: "graph" | "queue" | "change";
  if (trimmed.startsWith("Queue submission complete for ")) category = "queue";
  else if (trimmed.startsWith("Change review complete for ")) category = "change";
  else if (trimmed.startsWith("Graph review complete for ")) category = "graph";
  else return null;
  const detailsMatch = trimmed.match(/\n\n(?=(?:Applied|Queued|Rejected|Failed):\s)/);
  if (!detailsMatch?.index) return null;
  const header = trimmed.slice(0, detailsMatch.index).trim();
  const details = trimmed.slice(detailsMatch.index).trim();
  const outcomeMatch = header.match(/(?:^|\n\n)(\d+) (?:applied|queued),\s+(\d+) rejected,\s+(\d+) failed\.?/);
  if (!outcomeMatch || !details) return null;
  const narrative = header.match(/(?:^|\n\n)Outcome:\s+([\s\S]+)$/)?.[1]?.trim() ?? "";
  const applied = Number(outcomeMatch[1]);
  const rejected = Number(outcomeMatch[2]);
  const failed = Number(outcomeMatch[3]);
  const operationLines = details.match(/^(?:Applied|Queued|Rejected|Failed):[^\n]*/gm) ?? [];
  if (category === "graph" && operationLines.length && operationLines.every((line) => /^(?:Applied|Rejected|Failed):\s+Queued\b/.test(line))) {
    category = "queue";
  }
  const tone = failed > 0 && applied === 0
    ? "danger"
    : failed > 0 || rejected > 0
      ? "warning"
      : "success";
  return {
    category,
    applied,
    rejected,
    failed,
    title: category === "queue" ? "Queue submission complete" : category === "graph" ? "Graph review complete" : "Change review complete",
    summary: `${applied} ${category === "queue" ? "queued" : "applied"}, ${rejected} rejected, ${failed} failed.`,
    narrative,
    details: category === "queue" ? details.replace(/^Applied:\s+Queued\s+/gm, "Queued: ") : details,
    operationCount: details.match(/^(?:Applied|Queued|Rejected|Failed):\s/gm)?.length ?? 0,
    tone
  };
}
