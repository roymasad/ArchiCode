import type { Run } from "@shared/schema";

const blockingRunStatuses = new Set<Run["status"]>([
  "preparing",
  "queued",
  "needs-permission",
  "running",
  "planning",
  "awaiting-plan-review",
  "coding",
  "awaiting-code-review",
  "debugging",
  "needs-replan",
  "verifying"
]);

export function isRunBlockingNewChange(run: Run): boolean {
  return blockingRunStatuses.has(run.status);
}

export function latestVerificationExitCode(run: Run): number | "unknown" | null {
  for (const line of [...run.logs].reverse()) {
    const match = line.text.match(/\bCommand exited with code (unknown|\d+)\b/i);
    if (!match) continue;
    return match[1]?.toLowerCase() === "unknown" ? "unknown" : Number(match[1]);
  }
  return null;
}

export function verificationOutcome(run: Run): "passed" | "failed" | "unknown" | null {
  const exitCode = latestVerificationExitCode(run);
  if (exitCode === null) return null;
  if (exitCode === 0) return "passed";
  if (exitCode === "unknown") return "unknown";
  return "failed";
}
