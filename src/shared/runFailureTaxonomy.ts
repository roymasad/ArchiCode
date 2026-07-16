import type { Run } from "./schema";

export type RunFailureFamily =
  | "harness"
  | "provider"
  | "verification"
  | "dependency"
  | "environment"
  | "requirements"
  | "user-action";

export type RunFailureCode =
  | "invalid-source-proposal"
  | "provider-quota-exceeded"
  | "tool-schema-invalid"
  | "artifact-read-failed"
  | "preflight-path-mismatch"
  | "implementation-incomplete"
  | "verification-blocked-approval"
  | "dependency-sync-needed"
  | "build-command-failed"
  | "test-command-failed"
  | "runtime-command-failed"
  | "requirements-blocked"
  | "user-cancelled"
  | "unknown";

export type RunFailureClassification = {
  family: RunFailureFamily;
  code: RunFailureCode;
};

const failureStatuses = new Set<Run["status"]>(["failed", "cancelled"]);

function runTextPool(run: Run): string[] {
  return [
    ...run.logs.map((line) => line.text),
    run.runInstructions,
    run.promptSummary,
    run.command,
    ...run.plannedCommands,
    ...run.mcpToolCalls.flatMap((call) => [call.resultSummary, call.error])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function terminalTextPool(run: Run): string[] {
  return [
    run.runInstructions,
    run.permission.decision === "allowed" ? undefined : run.permission.reason,
    ...run.logs.slice(-12).map((line) => line.text)
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function hasPattern(texts: string[], pattern: RegExp): boolean {
  return texts.some((text) => pattern.test(text));
}

export function latestVerificationExitCode(run: Run): number | "unknown" | null {
  if (run.lastVerification) return run.lastVerification.exitCode ?? "unknown";
  // Legacy fallback for runs persisted before lastVerification existed.
  for (const line of [...run.logs].reverse()) {
    const match = line.text.match(/\bCommand exited with code (unknown|\d+)\b/i);
    if (!match) continue;
    return match[1]?.toLowerCase() === "unknown" ? "unknown" : Number(match[1]);
  }
  return null;
}

function latestVerificationCommand(run: Run): string | null {
  if (run.lastVerification?.command.trim()) return run.lastVerification.command.trim();
  // Legacy fallback for runs persisted before lastVerification existed.
  for (const log of [...run.logs].reverse()) {
    const targeted = log.text.match(/Targeted verification (?:passed|failed):\s*(.+?)(?:\s+\(log artifact:.*\))?$/i);
    if (targeted?.[1]?.trim()) return targeted[1].trim();
    const phaseStart = log.text.match(/Verification phase started:\s*(.+)$/i);
    if (phaseStart?.[1]?.trim()) return phaseStart[1].trim();
  }
  return run.command ?? run.plannedCommands[0] ?? null;
}

function isTestCommand(command: string | null): boolean {
  return Boolean(command && /\b(test|vitest|jest|playwright|cypress|mocha|ava|pytest|tox|nox|phpunit|rspec|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle(?:w)?\s+test)\b/i.test(command));
}

function isBuildCommand(command: string | null): boolean {
  return Boolean(command && /\b(build|typecheck|lint|check|compile|package|publish|assemble|xcodebuild|cargo\s+build|go\s+build|dotnet\s+(?:build|publish)|mvn\s+(?:package|verify|compile)|gradle(?:w)?\s+(?:build|assemble|check))\b/i.test(command));
}

function looksLikeDependencyOrToolchainBlocker(texts: string[]): boolean {
  return hasPattern(texts, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find package|Cannot find module|No module named|ModuleNotFoundError|ImportError: No module named|Could not resolve (?:module|package|import)|unresolved import|package .* not found|project\.assets\.json.*not found|run (?:install|restore|sync)|composer install|bundle install/i);
}

export function classifyRunFailure(run: Run): RunFailureClassification | null {
  if (!failureStatuses.has(run.status)) return null;

  if (run.status === "cancelled") {
    return {
      family: "user-action",
      code: "user-cancelled"
    };
  }

  const texts = runTextPool(run);
  const terminalTexts = terminalTextPool(run);
  const verificationCommand = latestVerificationCommand(run);
  const verificationExitCode = latestVerificationExitCode(run);

  const implementationHasOpenTasks = run.implementation?.tasks.some((task) => task.status === "todo" || task.status === "doing") ?? false;
  const stoppedDuringImplementation = run.stoppedAtPhase === "coding" || run.stoppedAtPhase === "debugging";
  if (
    hasPattern(terminalTexts, /Implementation stopped (?:before all planned source tasks|before all implementation tasks|after the dynamic batch budget)/i) ||
    (stoppedDuringImplementation && implementationHasOpenTasks && hasPattern(terminalTexts, /Implementation stopped|source work remains/i))
  ) {
    return {
      family: "provider",
      code: "implementation-incomplete"
    };
  }

  if (hasPattern(texts, /Invalid schema for function/i)) {
    return {
      family: "harness",
      code: "tool-schema-invalid"
    };
  }

  if (hasPattern(texts, /A known artifactId or artifact path is required/i)) {
    return {
      family: "harness",
      code: "artifact-read-failed"
    };
  }

  if (hasPattern(texts, /invalid or unsupported coding handoff|could not safely use|did not include usable propose-source-file operations/i)) {
    return {
      family: "provider",
      code: "invalid-source-proposal"
    };
  }

  if (hasPattern(texts, /insufficient_quota|exceeded your current quota|quota exceeded|billing details|rate limit|429/i)) {
    return {
      family: "provider",
      code: "provider-quota-exceeded"
    };
  }

  if (hasPattern(texts, /is not a readable file/i)) {
    return {
      family: "harness",
      code: "preflight-path-mismatch"
    };
  }

  const stoppedDuringVerification = run.stoppedAtPhase === "verifying" || run.phase === "verifying";
  if (stoppedDuringVerification && hasPattern(terminalTexts, /approval-required|requires approval or a reusable shell policy|Waiting for approval to verify/i)) {
    return {
      family: "environment",
      code: "verification-blocked-approval"
    };
  }

  if (looksLikeDependencyOrToolchainBlocker(texts)) {
    return {
      family: "dependency",
      code: "dependency-sync-needed"
    };
  }

  if (verificationExitCode !== null && verificationExitCode !== 0 && verificationExitCode !== "unknown") {
    if (isTestCommand(verificationCommand)) {
      return {
        family: "verification",
        code: "test-command-failed"
      };
    }
    if (isBuildCommand(verificationCommand)) {
      return {
        family: "verification",
        code: "build-command-failed"
      };
    }
  }

  if (hasPattern(texts, /needs replan|missing decisions|missing product direction|requirements are clarified|ask for missing/i)) {
    return {
      family: "requirements",
      code: "requirements-blocked"
    };
  }

  if (verificationExitCode !== null && verificationExitCode !== 0 && verificationExitCode !== "unknown") {
    return {
      family: "verification",
      code: "runtime-command-failed"
    };
  }

  return {
    family: "verification",
    code: "unknown"
  };
}

export function runFailureTitle(classification: RunFailureClassification): string {
  switch (classification.code) {
    case "invalid-source-proposal":
      return "Provider handoff invalid";
    case "provider-quota-exceeded":
      return "Provider quota exceeded";
    case "tool-schema-invalid":
      return "Harness tool schema error";
    case "artifact-read-failed":
      return "Harness artifact lookup failed";
    case "preflight-path-mismatch":
      return "Preflight path mismatch";
    case "implementation-incomplete":
      return "Implementation incomplete";
    case "verification-blocked-approval":
      return "Verification blocked";
    case "dependency-sync-needed":
      return "Dependency or toolchain sync needed";
    case "build-command-failed":
      return "Build failed";
    case "test-command-failed":
      return "Tests failed";
    case "runtime-command-failed":
      return "Verification failed";
    case "requirements-blocked":
      return "Requirements blocked";
    case "user-cancelled":
      return "Run cancelled";
    default:
      return "Run failed";
  }
}

export function runFailureStatusLabel(classification: RunFailureClassification): string {
  switch (classification.code) {
    case "invalid-source-proposal":
    case "provider-quota-exceeded":
      return "provider";
    case "tool-schema-invalid":
    case "artifact-read-failed":
    case "preflight-path-mismatch":
      return "harness";
    case "implementation-incomplete":
      return "incomplete";
    case "verification-blocked-approval":
    case "requirements-blocked":
      return "blocked";
    case "dependency-sync-needed":
      return "deps";
    case "build-command-failed":
      return "build";
    case "test-command-failed":
      return "tests";
    case "user-cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

export function runFailureTone(classification: RunFailureClassification): "neutral" | "warning" | "danger" {
  switch (classification.code) {
    case "user-cancelled":
      return "neutral";
    case "verification-blocked-approval":
    case "requirements-blocked":
    case "implementation-incomplete":
      return "warning";
    default:
      return "danger";
  }
}

export function runFailureNextStep(classification: RunFailureClassification): string {
  switch (classification.code) {
    case "invalid-source-proposal":
      return "Retry with tighter provider guidance or stricter output constraints before continuing.";
    case "provider-quota-exceeded":
      return "Check provider billing/quota or switch to another enabled provider, then retry.";
    case "tool-schema-invalid":
      return "Fix the tool schema or provider tool exposure before retrying this path.";
    case "artifact-read-failed":
      return "Repair artifact lookup inputs before rerunning the debug or retry flow.";
    case "preflight-path-mismatch":
      return "Regenerate the change against the current workspace file paths before verifying again.";
    case "implementation-incomplete":
      return "Resume from the latest implementation checkpoint; review any blocked source operations before rerunning verification.";
    case "verification-blocked-approval":
      return "Approve the blocked verification command, then resume or retry the run.";
    case "dependency-sync-needed":
      return "Install, restore, or sync the project's dependencies/toolchain prerequisites before rerunning verification.";
    case "build-command-failed":
      return "Inspect the verification log and changed files, then debug the build failure.";
    case "test-command-failed":
      return "Inspect the failing test output and changed files, then debug the test failure.";
    case "requirements-blocked":
      return "Answer the missing planning questions or replan before retrying.";
    case "user-cancelled":
      return "This run was stopped intentionally and can be retried when ready.";
    default:
      return "Inspect the trace and retry or debug from the recorded failure context.";
  }
}
