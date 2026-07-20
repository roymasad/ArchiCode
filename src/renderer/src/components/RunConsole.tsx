import { Bug, ChevronDown, CircleHelp, EyeOff, FileJson, PauseCircle, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { llmPatchProposalSchema, type LlmPatchProposal, type LlmUsage, type ProjectBundle, type ProjectSettings, type Run, type RunEvidenceKind } from "@shared/schema";
import { gaiaAgent, pandoraAgent } from "@shared/agentIdentities";
import { formatCostUsd, formatTokenCount, llmUsageTotalTokens } from "@shared/llmPricing";
import { useArchicodeStore, type RunGuidanceInput } from "../store/useArchicodeStore";
import { isRunErrorResolved, runFailureDetails, runFailureMessage } from "../utils/runErrors";
import { runFailureNextStep, runFailureStatusLabel, runFailureTone } from "../utils/runFailureTaxonomy";
import { latestProviderExplanation, runHasGeneratedPlan, runPlanText, runProgressItems } from "../utils/runProgress";
import { runStageItems, type RunStageTone } from "../utils/runStages";
import { isRunBlockingNewChange, verificationOutcome } from "../utils/runStatus";
import { codexLocalSandboxLabel, localProviderUsageUnavailableDetail } from "../utils/providerProfiles";
import { matches as chordMatches } from "../utils/keybindings";
import { explainRunPrompt } from "../utils/explainPrompts";
import { ContextSizeIndicator } from "./ContextSizeIndicator";
import { Button, EmptyState, IconButton, StatusPill, TextArea, Tooltip } from "./ui";

const queueWidthStoragePrefix = "archicode-run-queue-width";
const defaultQueueWidth = 290;
const minQueueWidth = 180;
const maxQueueWidth = 560;
const minQueueDetailWidth = 320;

function queueWidthStorageKey(rootPath: string): string {
  return `${queueWidthStoragePrefix}:${rootPath || "default"}`;
}

function clampQueueWidth(width: number, containerWidth = window.innerWidth): number {
  const availableMax = Math.max(minQueueWidth, containerWidth - minQueueDetailWidth);
  return Math.min(maxQueueWidth, availableMax, Math.max(minQueueWidth, Math.round(width)));
}

function readStoredQueueWidth(rootPath: string): number {
  const saved = Number(localStorage.getItem(queueWidthStorageKey(rootPath)));
  return Number.isFinite(saved) ? clampQueueWidth(saved) : defaultQueueWidth;
}

function hasGraphReviewOperations(proposal: unknown): boolean {
  const parsed = llmPatchProposalSchema.safeParse(proposal);
  if (!parsed.success) return true;
  return parsed.data.operations.some(isGraphReviewOperation);
}

function isGraphReviewOperation(operation: LlmPatchProposal["operations"][number]): boolean {
  if (operation.kind === "propose-node" || operation.kind === "propose-edge" || operation.kind === "propose-subflow" || operation.kind === "propose-graph-operation") return true;
  if (operation.kind !== "update-node") return false;
  const fields = operation.patch.fields;
  const entries = fields && typeof fields === "object" && !Array.isArray(fields)
    ? Object.entries(fields as Record<string, unknown>)
    : Object.entries(operation.patch).filter(([key]) => key !== "id");
  const bookkeepingFields = new Set(["stage", "flags", "todos", "attachments"]);
  return entries.some(([key]) => !bookkeepingFields.has(key));
}

function isActive(run: Run): boolean {
  return [
    "preparing",
    "queued",
    "running",
    "needs-permission",
    "planning",
    "awaiting-plan-review",
    "coding",
    "awaiting-code-review",
    "debugging",
    "verifying"
  ].includes(run.status);
}

function isDebugRunActive(run: Run): boolean {
  return run.status === "debugging" || (run.phase === "debugging" && isActive(run));
}

function isLiveQueueRun(run: Run): boolean {
  return ["planning", "coding", "debugging", "verifying"].includes(run.status) ||
    ["planning", "coding", "debugging", "verifying"].includes(run.phase);
}

function statusTone(status: Run["status"]): "neutral" | "accent" | "success" | "warning" | "danger" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "needs-permission" || status === "awaiting-plan-review" || status === "awaiting-code-review") return "warning";
  if (status === "debugging") return "warning";
  if (status === "preparing" || status === "running" || status === "queued" || status === "planning" || status === "coding" || status === "verifying") return "accent";
  return "neutral";
}

function approvalLabel(run: Run): string {
  if (run.status === "awaiting-plan-review") return "Approve Plan";
  if (run.status === "awaiting-code-review") return "Approve Code";
  if (run.status === "needs-permission" && run.sourceReview) return "Approve Deletion";
  return "Approve";
}

function openQuestionsForRun(bundle: ProjectBundle | null, run: Run): number {
  if (!bundle) return 0;
  const flow = bundle.flows.find((item) => item.id === run.flowId);
  const scopeNodeIds = new Set<string>();
  if (run.nodeId) {
    scopeNodeIds.add(run.nodeId);
    for (const edge of flow?.edges ?? []) {
      if (edge.source === run.nodeId) scopeNodeIds.add(edge.target);
      if (edge.target === run.nodeId) scopeNodeIds.add(edge.source);
    }
  }
  return bundle.notes.filter((note) =>
    note.flowId === run.flowId &&
    note.kind === "llm-question" &&
    !note.resolved &&
    (!run.nodeId || scopeNodeIds.has(note.nodeId))
  ).length;
}

function statusLabel(status: Run["status"]): string {
  if (status === "preparing") return "preparing";
  if (status === "needs-permission") return "approval";
  if (status === "awaiting-plan-review") return "plan review";
  if (status === "awaiting-code-review") return "code review";
  if (status === "needs-replan") return "replan";
  return status;
}

function runHeadline(run: Run, openQuestionCount = 0, runs: Run[] = []): string {
  if (isRunErrorResolved(run, runs)) return "Run error resolved";
  const failure = runFailureDetails(run, runs);
  if (failure) return failure.title;
  if (hasProblemNoSourceChanges(run)) return "Run produced no code changes";
  if (run.status === "preparing") return "Preparing the run";
  if (run.status === "needs-permission") return run.sourceReview ? "Deletion needs your approval" : "Waiting for your approval";
  if (run.status === "awaiting-plan-review" && openQuestionCount) return "Questions need answers";
  if (run.status === "awaiting-plan-review") return "Plan ready for review";
  if (run.status === "awaiting-code-review") return run.sourceDiffArtifactIds.length ? "Source changes ready for review" : "Code review needs source changes";
  if (run.status === "planning") return "Planning the change";
  if (run.status === "coding") return "Applying the change";
  if (run.status === "debugging") return "Debugging the failure";
  if (run.status === "needs-replan") return "Needs replanning";
  if (run.status === "verifying") return "Verifying the change";
  if (run.status === "queued") return "Waiting in queue";
  if (run.status === "failed") return "Run failed";
  if (run.status === "succeeded") return "Run completed";
  if (run.status === "cancelled") return "Run cancelled";
  return "Run in progress";
}

function activeRunAgentTitle(run: Run): string | null {
  if (run.status === "debugging" || run.phase === "debugging") return pandoraAgent.title;
  if (run.purpose === "run-discovery") return null;
  if (run.status === "planning" || run.status === "coding" || run.phase === "planning" || run.phase === "coding") return gaiaAgent.title;
  return null;
}

function runSummary(run: Run, runs: Run[] = []): string {
  if (isRunErrorResolved(run, runs)) return run.errorDismissedAt ? `Error dismissed ${new Date(run.errorDismissedAt).toLocaleString()}.` : "Resolved by successful follow-up run.";
  const failure = runFailureDetails(run, runs);
  if (failure) return failure.message;
  if (hasProblemNoSourceChanges(run)) {
    const providerExplanation = latestProviderExplanation(run, 180);
    return providerExplanation
      ? `Coding finished without source changes. Codex said: ${providerExplanation}`
      : "Coding finished, but no source files changed. Check Trace to see what the provider did.";
  }
  if (hasBenignNoSourceChanges(run)) return run.runInstructions ?? "Verification passed; no source changes were needed.";
  if (run.status === "needs-permission") {
    if (run.sourceReview) {
      return `The agent wants to delete ${run.sourceReview.paths.join(", ")}. Approve or reject this deletion; the same run will continue either way.`;
    }
    const pendingTool = pendingMcpToolCall(run);
    return pendingTool
      ? run.permission.reason ?? `${pendingTool.serverLabel} wants to run ${pendingTool.toolName}.`
      : run.permission.reason ?? "ArchiCode needs approval before continuing.";
  }
  if (run.status === "preparing") return run.runInstructions ?? "ArchiCode is preparing context before this run starts.";
  if (run.status === "awaiting-plan-review") return run.runInstructions ?? "Review is required before the run can continue.";
  if (run.status === "awaiting-code-review") {
    return run.sourceDiffArtifactIds.length
      ? "Review the generated source changes, then approve the run to continue verification."
      : "No source-change artifact was recorded for this manual code review. Reject with guidance or cancel this run.";
  }
  if (run.status === "needs-replan") return run.runInstructions ?? "Coding found a planning gap. Retry to replan from the captured blocker context.";
  if ((run.status === "succeeded" || run.status === "cancelled") && run.runInstructions) return run.runInstructions;
  const latestProgress = runProgressItems(run, 1)[0];
  if (latestProgress) return latestProgress.detail ? `${latestProgress.label}: ${latestProgress.detail}` : latestProgress.label;
  return run.runInstructions ?? run.promptSummary;
}

function compactText(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function timestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function runElapsedLabel(run: Run, nowMs: number): string {
  const startMs = timestampMs(run.startedAt) ?? timestampMs(run.createdAt) ?? nowMs;
  const endMs = timestampMs(run.completedAt) ?? (isActive(run) ? nowMs : timestampMs(run.queueRemovedAt) ?? nowMs);
  return formatDuration(endMs - startMs);
}

function runLastUpdatedLabel(run: Run): string {
  const lastLogAt = run.logs.length ? run.logs[run.logs.length - 1].at : undefined;
  const at = lastLogAt ?? run.completedAt ?? run.startedAt ?? run.createdAt;
  return new Date(at).toLocaleString();
}

function runSubject(bundle: ProjectBundle | null, run: Run): string {
  const flow = bundle?.flows.find((item) => item.id === run.flowId);
  const node = flow?.nodes.find((item) => item.id === run.nodeId);
  if (node) return node.title;
  if (flow) return flow.name;
  return bundle?.project.name ?? "Whole project";
}

function runCommand(run: Run): string {
  return run.command ?? run.plannedCommands[0] ?? "Provider run";
}

function providerSandbox(bundle: ProjectBundle | null, run: Run): string {
  const provider = bundle?.project.settings.providers.find((item) => item.id === run.providerId);
  return provider?.kind === "codex-local" || provider?.kind === "claude-local" || provider?.kind === "opencode-local" || provider?.kind === "antigravity-local"
    ? codexLocalSandboxLabel(provider.localSandbox)
    : "reviewed proposal";
}

function contextBudgetSourceLabel(source: string): string {
  if (source === "manual") return "manual budget";
  if (source === "provider-override") return "provider override";
  if (source === "provider-detected") return "provider detected";
  if (source === "known-model") return "known model";
  return "fallback";
}

function runContextIndicator(run: Run): { estimatedTokens: number; maxTokens: number; detail: string } | null {
  const budget = run.contextSummary?.budget;
  if (!budget) return null;
  return {
    estimatedTokens: budget.estimatedTokens,
    maxTokens: budget.maxTokens,
    detail: `Threshold ${budget.compactionThreshold.toLocaleString()} tokens · ${contextBudgetSourceLabel(budget.source)}.`
  };
}

function formatUsageLine(usage: LlmUsage): string {
  const parts = [`in ${formatTokenCount(usage.inputTokens)}`, `out ${formatTokenCount(usage.outputTokens)}`];
  if (usage.thinkingTokens) parts.push(`thinking ${formatTokenCount(usage.thinkingTokens)}`);
  if (usage.cacheReadTokens) parts.push(`cache-read ${formatTokenCount(usage.cacheReadTokens)}`);
  if (usage.cacheCreationTokens) parts.push(`cache-write ${formatTokenCount(usage.cacheCreationTokens)}`);
  parts.push(`${usage.calls} call${usage.calls === 1 ? "" : "s"}`);
  return parts.join(", ");
}

// Compact headline for the run-detail "Cost" line under Effort.
function runCostLabel(run: Run): string {
  const usage = run.usage;
  if (!usage) return "—";
  if (usage.unavailable) return "n/a";
  return formatCostUsd(usage.costUsd, { compact: true, estimated: usage.estimated });
}

// Full spend/history breakdown for the run radial-icon tooltip: total + per-phase.
// The radial itself is driven by the run context budget, not cumulative LLM usage.
function runCostIndicator(run: Run, provider?: ProjectSettings["providers"][number]): { text: string; detail: string; tokensUsed?: number } | null {
  const usage = run.usage;
  const byPhase = run.usageByPhase ?? [];
  if (!usage && !byPhase.length) return null;
  const phaseUsages = byPhase.map((entry) => entry.usage);
  const hasReal = (usage && !usage.unavailable) || phaseUsages.some((u) => !u.unavailable);
  if (!hasReal) {
    return { text: "Cost: n/a", detail: localProviderUsageUnavailableDetail(provider) };
  }
  const text = usage && usage.costUsd !== undefined && !usage.unavailable
    ? `Run LLM cost: ${formatCostUsd(usage.costUsd, { estimated: usage.estimated })}`
    : "Run LLM cost: —";
  const lines: string[] = [];
  lines.push(usage?.estimated || phaseUsages.some((u) => u.estimated)
    ? "Standard-rate estimate; unknown-model fallback pricing used."
    : "Standard-rate estimate.");
  if (usage && !usage.unavailable) lines.push(`Run LLM usage: ${formatTokenCount(llmUsageTotalTokens(usage))} tokens.`);
  if (usage && !usage.unavailable) lines.push(`Run usage breakdown: ${formatUsageLine(usage)}`);
  if (byPhase.length) {
    lines.push("Run usage by phase:");
    for (const entry of byPhase) {
      if (entry.usage.unavailable) {
        lines.push(`  ${entry.phase}: n/a`);
        continue;
      }
      lines.push(`  ${entry.phase}: ${formatCostUsd(entry.usage.costUsd, { estimated: entry.usage.estimated })} · ${formatUsageLine(entry.usage)}`);
    }
  }
  return {
    text,
    detail: lines.join("\n"),
    tokensUsed: usage && !usage.unavailable ? llmUsageTotalTokens(usage) : undefined
  };
}

function runEffortLabel(run: Run): string {
  if (run.effort === "fast") return "Fast";
  if (run.effort === "high") return "High";
  return "Auto";
}

function pendingMcpToolCall(run: Run) {
  return run.status === "needs-permission" ? run.mcp?.pendingToolCall : undefined;
}

function approvalTitle(bundle: ProjectBundle | null, run: Run): string {
  if (run.status === "awaiting-plan-review") return `Approve plan for ${runSubject(bundle, run)}`;
  if (run.status === "awaiting-code-review") return `Approve code for ${runSubject(bundle, run)}`;
  if (run.sourceReview) return `Approve source deletion for ${runSubject(bundle, run)}`;
  const pendingTool = pendingMcpToolCall(run);
  if (pendingTool) return `Approve ${pendingTool.serverLabel} / ${pendingTool.toolName} for ${runSubject(bundle, run)}`;
  return `Approve ${run.phase} for ${runSubject(bundle, run)}`;
}

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

function implementationCounter(run: Run): string | null {
  if (!run.implementation) return null;
  const { checkpoints, currentBatch, maxBatches, tasks } = run.implementation;
  const visibleBatch = Math.max(currentBatch, checkpoints.length);
  const doneTasks = tasks.filter((task) => task.status === "done").length;
  const terminal = run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
  const incompleteTasks = tasks.some((task) => task.status === "todo" || task.status === "doing") || Boolean(run.implementation.needsMoreWork);
  const taskText = tasks.length
    ? terminal
      ? ` · ${doneTasks}/${tasks.length} tasks ${incompleteTasks ? "completed" : "done"}`
      : ` · ${doneTasks}/${tasks.length} tasks`
    : "";
  if (terminal) return `${visibleBatch} batch${visibleBatch === 1 ? "" : "es"} used${taskText}`;
  return `Implementation ${visibleBatch}/${maxBatches} batches${taskText}`;
}

function workflowPanelLabel(run: Run): string {
  if (run.implementation && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled")) {
    return "Implementation history";
  }
  return "Current step";
}

function workflowTitle(run: Run, openQuestionCount = 0, runs: Run[] = []): string {
  if (isRunErrorResolved(run, runs)) return "Error resolved";
  const failure = runFailureDetails(run, runs);
  if (failure) return failure.title;
  if (run.status === "awaiting-plan-review" && openQuestionCount) return "Answer questions";
  if (run.status === "awaiting-plan-review") return "Review the plan";
  if (run.status === "awaiting-code-review") return run.sourceDiffArtifactIds.length ? "Review source changes" : "Missing source changes";
  if (run.status === "needs-permission") return run.sourceReview ? "Approve source deletion" : pendingMcpToolCall(run) ? "Approve MCP tool" : `Approve ${run.phase}`;
  if (run.status === "preparing") return "Preparing";
  if (run.status === "planning") return "Planning";
  if (run.status === "coding") return "Coding";
  if (run.status === "debugging") return "Debugging";
  if (run.status === "needs-replan") return "Needs replan";
  if (run.status === "verifying") return "Verifying";
  if (hasProblemNoSourceChanges(run)) return "No code changes";
  if (run.status === "succeeded") return "Complete";
  if (run.status === "failed") return "Failed";
  if (run.status === "cancelled") return "Stopped";
  return "Queued";
}

function workflowSummary(run: Run, openQuestionCount = 0, runs: Run[] = []): string {
  if (isRunErrorResolved(run, runs)) return "This failed run is kept in history but no longer counted as an open error.";
  const failure = runFailureDetails(run, runs);
  if (failure) return runFailureNextStep(failure.classification);
  if (run.status === "awaiting-plan-review" && openQuestionCount) {
    return `${openQuestionCount} open question${openQuestionCount === 1 ? "" : "s"} must be answered before this run can resume.`;
  }
  if (run.status === "awaiting-plan-review") return "Approve to continue into coding, or reject to stop this run.";
  if (run.status === "awaiting-code-review") {
    return run.sourceDiffArtifactIds.length
      ? "Review the generated source changes, then approve to continue into verification or reject the code."
      : "This manual code-review gate has no source-change artifact. Reject with guidance or cancel this run.";
  }
  if (run.status === "needs-permission") {
    if (run.sourceReview) return `Approve or reject deletion of ${run.sourceReview.paths.join(", ")}. Coding resumes either way.`;
    return pendingMcpToolCall(run)
      ? "Approve this MCP tool call to execute it and resume the same run, or deny it to continue without that tool."
      : "Approve this provider step to continue, or deny it to stop this run.";
  }
  if (run.status === "preparing") return "ArchiCode is collecting context and preparing the run artifact.";
  if (run.status === "planning") return "The provider is preparing the implementation plan. Open Trace for full text.";
  if (run.status === "coding" || run.status === "debugging") return "The provider is editing files. Progress appears here; full output is in Trace.";
  if (run.status === "needs-replan") return "Coding found that the plan is incomplete or wrong. Retry to send the blocker back through planning, or cancel this run.";
  if (run.status === "verifying") return "Verification is running against the generated change.";
  if (hasProblemNoSourceChanges(run)) {
    const providerExplanation = latestProviderExplanation(run, 220);
    return providerExplanation
      ? `Coding finished without source file changes. Codex said: ${providerExplanation}`
      : "Coding finished without changing project source files. Retry or inspect Trace.";
  }
  if (hasBenignNoSourceChanges(run)) return run.runInstructions ?? "Verification passed; no source changes were needed.";
  if (run.status === "succeeded" && run.implementation) {
    const hasOutstandingImplementationState = run.implementation.tasks.some((task) => task.status === "todo" || task.status === "doing") || Boolean(run.implementation.needsMoreWork);
    if (hasOutstandingImplementationState) {
      return "All required stages finished for this run. The implementation summary above is a historical batch/task snapshot, not remaining required work.";
    }
  }
  if (run.status === "succeeded") return "All required stages finished for this run.";
  if (run.status === "failed") return "Retry the run, or start a debug pass with the failure context.";
  if (run.status === "cancelled") return run.runInstructions ?? "This run was stopped before completion.";
  return "This run is waiting for its turn.";
}

function workflowTone(run: Run, runs: Run[] = []): RunStageTone {
  if (isRunErrorResolved(run, runs)) return "neutral";
  const failure = runFailureDetails(run, runs);
  if (failure) return runFailureTone(failure.classification);
  if (run.status === "failed" || run.status === "cancelled" || hasProblemNoSourceChanges(run)) return "danger";
  if (run.status === "needs-permission" || run.status === "awaiting-plan-review" || run.status === "awaiting-code-review") return "warning";
  if (run.status === "succeeded") return "success";
  if (isActive(run)) return "accent";
  return "neutral";
}

function rejectLabel(run: Run): string {
  if (run.status === "awaiting-plan-review") return "Reject Plan";
  if (run.status === "awaiting-code-review") return "Reject Code";
  if (run.sourceReview) return "Reject Deletion";
  if (pendingMcpToolCall(run)) return "Deny Tool";
  if (run.status === "needs-permission") return "Deny";
  return "Reject";
}

function approvalTooltip(run: Run): string {
  if (run.status === "awaiting-plan-review") return "Approve the reviewed plan and continue into coding.";
  if (run.status === "awaiting-code-review") {
    return run.sourceDiffArtifactIds.length
      ? "Approve the reviewed source changes and continue into verification."
      : "No source-change artifact is available to approve.";
  }
  if (run.sourceReview) return "Approve only the requested file deletion and resume the same coding run.";
  if (pendingMcpToolCall(run)) return "Approve this MCP tool call, run it, and resume the same run with the result.";
  return "Approve this gated run step and continue.";
}

function rejectTooltip(run: Run): string {
  if (run.status === "awaiting-plan-review") return "Reject this plan, record a reason, and stop the run.";
  if (run.status === "awaiting-code-review") return "Reject these source changes, record a reason, and stop the run.";
  if (run.sourceReview) return "Keep the file, record the rejection, and resume the same coding run.";
  if (pendingMcpToolCall(run)) return "Deny this MCP tool call and resume the same run without it.";
  if (run.status === "needs-permission") return "Deny this permission request and stop the run.";
  return "Reject this run step and record a reason.";
}

function cancelTooltip(run: Run): string {
  return run.status === "awaiting-code-review" || run.status === "awaiting-plan-review" || run.status === "needs-permission"
    ? "Stop the run without recording a review rejection."
    : "Stop this run.";
}

function graphReviewTooltip(count: number): string {
  return count === 1
    ? "Review the pending graph edit before approving the plan."
    : `Review ${count} pending graph edits before approving the plan.`;
}

function codeDiffTooltip(run: Run): string {
  return run.sourceDiffArtifactIds.length
    ? "Open Source Changes to inspect generated file edits from this run."
    : "No source-change artifact has been recorded for this run.";
}

const evidenceOptions: Array<{ id: RunEvidenceKind; label: string }> = [
  { id: "last-error", label: "Last error" },
  { id: "trace-tail", label: "Trace tail" },
  { id: "latest-diff", label: "Latest diff" },
  { id: "runtime-log", label: "Runtime log" },
  { id: "node-notes", label: "Node notes" }
];

function defaultEvidenceFor(action: "retry" | "debug"): RunEvidenceKind[] {
  return action === "debug" ? ["last-error", "trace-tail", "latest-diff"] : ["last-error", "trace-tail"];
}

function buildGuidance(text: string, evidence: RunEvidenceKind[]): RunGuidanceInput | undefined {
  const trimmed = text.trim();
  if (!trimmed && !evidence.length) return undefined;
  return { text: trimmed, evidence };
}

export function RunConsole() {
  const { rootPath, bundle, patchProposals, selectedRunId, selectRun, approveRun, cancelRun, rejectRun, dismissRunError, removeRunFromQueue, retryRun, retryRunWithGuidance, startDebuggingRun, startScopedResearchChat, keybindings } = useArchicodeStore(useShallow((state) => ({
    rootPath: state.rootPath,
    bundle: state.bundle,
    patchProposals: state.patchProposals,
    selectedRunId: state.selectedRunId,
    selectRun: state.selectRun,
    approveRun: state.approveRun,
    cancelRun: state.cancelRun,
    rejectRun: state.rejectRun,
    dismissRunError: state.dismissRunError,
    removeRunFromQueue: state.removeRunFromQueue,
    retryRun: state.retryRun,
    retryRunWithGuidance: state.retryRunWithGuidance,
    startDebuggingRun: state.startDebuggingRun,
    startScopedResearchChat: state.startScopedResearchChat,
    keybindings: state.keybindings
  })));
  const [reusableApproval, setReusableApproval] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [guidanceTarget, setGuidanceTarget] = useState<"retry" | "debug" | null>(null);
  const [guidanceText, setGuidanceText] = useState("");
  const [guidanceEvidence, setGuidanceEvidence] = useState<RunEvidenceKind[]>([]);
  const [rejectingRunId, setRejectingRunId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [queueWidth, setQueueWidth] = useState(() => readStoredQueueWidth(rootPath));
  const [runDetailWidth, setRunDetailWidth] = useState(0);
  const runConsoleRef = useRef<HTMLDivElement>(null);
  const runDetailRef = useRef<HTMLDivElement>(null);
  const guidancePanelRef = useRef<HTMLDivElement>(null);
  const runs = useMemo(() => [...(bundle?.runs ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [bundle]);
  const activeCount = runs.filter(isActive).length;
  const removedCount = runs.filter((run) => run.queueRemovedAt).length;
  const queueRuns = showRemoved ? runs : runs.filter((run) => !run.queueRemovedAt);
  const selectedById = queueRuns.find((run) => run.id === selectedRunId) ?? null;
  const selected = selectedById ?? queueRuns.find(isActive) ?? queueRuns[0] ?? null;
  const activeRun = queueRuns.find(isRunBlockingNewChange) ?? null;
  const selectedRunActionBlocked = Boolean(activeRun && selected && activeRun.id !== selected.id);
  const selectedRunActionBlockMessage = activeRun
    ? `Finish or cancel the active run (${activeRun.id}) before retrying or debugging another run.`
    : "";
  const selectedFailure = selected ? runFailureMessage(selected, runs) : null;
  const selectedFailureDetails = selected ? runFailureDetails(selected, runs) : null;
  const selectedPlanText = selected ? runPlanText(selected, bundle?.artifacts ?? []) : null;
  const selectedPromptText = selected ? runSummary(selected, runs) : null;
  const selectedHasGeneratedPlan = selected ? runHasGeneratedPlan(selected, bundle?.artifacts ?? []) : false;
  const progressItems = selected ? runProgressItems(selected, 7) : [];
  const stageItems = selected ? runStageItems(selected, {
    planningReviewMode: bundle?.project.settings.planningReviewMode,
    codeReviewMode: bundle?.project.settings.codeReviewMode
  }) : [];
  const selectedImplementationCounter = selected ? implementationCounter(selected) : null;
  const selectedSubject = selected ? runSubject(bundle, selected) : "";
  const selectedContextIndicator = selected ? runContextIndicator(selected) : null;
  const selectedProvider = selected
    ? bundle?.project.settings.providers.find((provider) => provider.id === selected.providerId)
    : undefined;
  const selectedCostIndicator = selected ? runCostIndicator(selected, selectedProvider) : null;
  const selectedOpenQuestionCount = selected ? openQuestionsForRun(bundle, selected) : 0;
  const selectedPendingGraphProposalCount = selected
    ? patchProposals.filter((item) =>
      item.artifact.runId === selected.id &&
      item.artifact.status === "pending-review" &&
      hasGraphReviewOperations(item.proposal)
    ).length
    : 0;
  const selectedNeedsAction = selected?.status === "needs-permission" ||
    selected?.status === "awaiting-plan-review" ||
    selected?.status === "awaiting-code-review";
  const hasLiveQueueTimer = queueRuns.some((run) => isActive(run) && !run.completedAt);
  const explainSelectedRun = () => {
    if (!bundle || !selected) return;
    const flow = bundle.flows.find((item) => item.id === selected.flowId);
    const hasNodeScope = Boolean(selected.nodeId && flow?.nodes.some((node) => node.id === selected.nodeId));
    const scope = hasNodeScope && selected.nodeId
      ? { type: "node" as const, flowId: selected.flowId, nodeId: selected.nodeId }
      : { type: "flow" as const, flowId: selected.flowId };
    void startScopedResearchChat(scope, explainRunPrompt(selected));
  };

  useEffect(() => {
    if (!hasLiveQueueTimer) return undefined;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [hasLiveQueueTimer]);

  useEffect(() => {
    setQueueWidth(readStoredQueueWidth(rootPath));
  }, [rootPath]);

  useEffect(() => {
    const element = runDetailRef.current;
    if (!element) return undefined;
    const updateWidth = () => {
      const width = Math.round(element.getBoundingClientRect().width);
      setRunDetailWidth((current) => current === width ? current : width);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected?.id]);

  const submitGuidance = () => {
    if (!selected || !guidanceTarget) return;
    if (selectedRunActionBlocked) return;
    const guidance = buildGuidance(guidanceText, guidanceEvidence);
    if (guidanceTarget === "retry") {
      if (guidance) void retryRunWithGuidance(selected.id, guidance);
      else void retryRun(selected.id);
    }
    if (guidanceTarget === "debug") void startDebuggingRun(selected.id, guidance);
    setGuidanceTarget(null);
  };

  const openGuidance = (target: "retry" | "debug") => {
    if (selectedRunActionBlocked) return;
    if (guidanceTarget === target) {
      guidancePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      guidancePanelRef.current?.focus({ preventScroll: true });
      return;
    }
    setGuidanceTarget(target);
    setGuidanceEvidence(defaultEvidenceFor(target));
    setGuidanceText("");
  };

  const openRejectReview = (runId: string) => {
    setRejectingRunId(runId);
    setRejectionReason("");
  };

  const rejectRunViaKeyboard = () => {
    if (!selected) return;
    openRejectReview(selected.id);
  };

  const approveRunViaKeyboard = () => {
    if (!selected) return;
    void approveRun(selected.id, reusableApproval);
  };

  const retryRunViaKeyboard = () => {
    if (!selected || selectedRunActionBlocked) return;
    openGuidance("retry");
  };

  const submitRejection = () => {
    if (!rejectingRunId || !rejectionReason.trim()) return;
    void rejectRun(rejectingRunId, rejectionReason.trim());
    setRejectingRunId(null);
    setRejectionReason("");
  };

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(target.closest("input, textarea, select, button, [contenteditable='true'], [role='combobox']"));
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const approveChord = keybindings["run.approve"];
      const rejectChord = keybindings["run.reject"];
      const retryChord = keybindings["run.retry"];
      if (approveChord && chordMatches(approveChord, event)) {
        event.preventDefault();
        approveRunViaKeyboard();
        return;
      }
      if (rejectChord && chordMatches(rejectChord, event)) {
        event.preventDefault();
        rejectRunViaKeyboard();
        return;
      }
      if (retryChord && chordMatches(retryChord, event)) {
        event.preventDefault();
        retryRunViaKeyboard();
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [approveRun, keybindings, rejectRunViaKeyboard, approveRunViaKeyboard, retryRunViaKeyboard]);

  const openQuestionsTab = () => {
    window.dispatchEvent(new CustomEvent("archicode:set-activity-tab", { detail: "questions" }));
  };

  const openPatchReview = () => {
    window.dispatchEvent(new CustomEvent("archicode:open-patch-review", { detail: { runId: selected?.id } }));
  };

  const openPlanTab = () => {
    window.dispatchEvent(new CustomEvent("archicode:set-activity-tab", { detail: "plans" }));
  };

  const openCodeDiffTab = () => {
    window.dispatchEvent(new CustomEvent("archicode:set-activity-tab", { detail: "diffs" }));
  };

  const resizeQueue = (width: number) => {
    const nextWidth = clampQueueWidth(width, runConsoleRef.current?.getBoundingClientRect().width);
    localStorage.setItem(queueWidthStorageKey(rootPath), String(nextWidth));
    setQueueWidth(nextWidth);
  };

  const startQueueResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      const bounds = runConsoleRef.current?.getBoundingClientRect();
      if (!bounds) return;
      resizeQueue(moveEvent.clientX - bounds.left);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const adjustQueueWidth = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeQueue(queueWidth - step);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeQueue(queueWidth + step);
    }
  };

  const detailCompact = runDetailWidth > 0 && runDetailWidth < 560;
  const runConsoleClassName = runs.length === 0
    ? "run-console run-console-empty"
    : selected
      ? "run-console"
      : "run-console run-console-no-detail";

  return (
    <div
      ref={runConsoleRef}
      className={runConsoleClassName}
      style={{ "--run-queue-width": `${queueWidth}px` } as CSSProperties}
    >
      <div className="run-queue">
        {runs.length === 0 ? (
          <EmptyState title="Queue is empty">Runs will appear here with live logs.</EmptyState>
        ) : (
          <>
            <div className="queue-summary" aria-label={`Queue. ${activeCount ? `${activeCount} active or waiting` : `${queueRuns.length} runs`}`}>
              <div className="queue-summary-row">
                <strong>{activeCount ? `${activeCount} active or waiting` : `${queueRuns.length} runs`}</strong>
                {removedCount ? (
                  <IconButton
                    className="queue-removed-toggle"
                    title={showRemoved ? "Hide removed" : `Show ${removedCount} removed`}
                    onClick={() => setShowRemoved((current) => !current)}
                  >
                    <EyeOff size={16} />
                  </IconButton>
                ) : null}
              </div>
              {!showRemoved && removedCount ? <small>Removed runs are hidden from the queue.</small> : null}
            </div>
            {queueRuns.length === 0 ? (
              <EmptyState title="Queue is clear">Removed runs are hidden. Use the eye button to view history.</EmptyState>
            ) : null}
            {queueRuns.map((run) => {
              const summary = runSummary(run, runs);
              const queueSummary = compactText(runSubject(bundle, run), 54);
              const noSourceChanges = hasProblemNoSourceChanges(run);
              const errorResolved = isRunErrorResolved(run, runs);
              const failure = runFailureDetails(run, runs);
              const elapsed = runElapsedLabel(run, nowMs);
              return (
                <button
                  key={run.id}
                  type="button"
                  className={[
                    run.id === selected?.id ? "is-active" : "",
                    isLiveQueueRun(run) ? `is-live-run is-live-run-${statusTone(run.status)}` : "",
                    isDebugRunActive(run) ? "is-debugging-run" : ""
                  ].filter(Boolean).join(" ")}
                  onClick={() => selectRun(run.id)}
                  title={summary}
                >
                  {isLiveQueueRun(run) ? (
                    <span className="run-queue-live-outline" aria-hidden="true">
                      <span className="run-queue-live-pulse run-queue-live-pulse-top" />
                      <span className="run-queue-live-pulse run-queue-live-pulse-right" />
                      <span className="run-queue-live-pulse run-queue-live-pulse-bottom" />
                      <span className="run-queue-live-pulse run-queue-live-pulse-left" />
                    </span>
                  ) : null}
                  <StatusPill tone={errorResolved ? "neutral" : failure ? runFailureTone(failure.classification) : noSourceChanges ? "danger" : statusTone(run.status)}>
                    {errorResolved ? "resolved" : failure ? runFailureStatusLabel(failure.classification) : noSourceChanges ? "no changes" : statusLabel(run.status)}
                  </StatusPill>
                  <small>{queueSummary}</small>
                  <span className="run-queue-duration" title={isActive(run) ? "Elapsed run time" : "Final run time"}>{elapsed}</span>
                </button>
              );
            })}
          </>
        )}
      </div>

      {selected ? (
        <div
          className="run-queue-resizer"
          role="separator"
          aria-label="Resize queue columns"
          aria-orientation="vertical"
          aria-valuemin={minQueueWidth}
          aria-valuemax={maxQueueWidth}
          aria-valuenow={queueWidth}
          tabIndex={0}
          onKeyDown={adjustQueueWidth}
          onPointerDown={startQueueResize}
        />
      ) : null}

      {selected ? (
        <div ref={runDetailRef} className={detailCompact ? "run-detail is-detail-compact" : "run-detail"}>
          <>
            <div className="run-detail-head">
              <div>
                {activeRunAgentTitle(selected) ? <small>{activeRunAgentTitle(selected)}</small> : null}
                <strong>{runHeadline(selected, selectedOpenQuestionCount, runs)}</strong>
              </div>
              <div className="run-detail-head-actions">
                <Button type="button" size="sm" onClick={explainSelectedRun}>
                  <CircleHelp size={14} />
                  <span>Explain this</span>
                </Button>
                {selectedContextIndicator ? (
                  <ContextSizeIndicator
                    detail={selectedContextIndicator.detail}
                    estimatedTokens={selectedContextIndicator.estimatedTokens}
                    label="Latest run context"
                    maxTokens={selectedContextIndicator.maxTokens}
                    cost={selectedCostIndicator}
                  />
                ) : null}
              </div>
            </div>
            <div className={`run-workflow-panel run-workflow-${workflowTone(selected, runs)}`} role={selectedNeedsAction ? "alert" : "status"}>
              <div className="run-workflow-copy">
                <span className="run-workflow-label-row">
                  <span>{workflowPanelLabel(selected)}</span>
                  {selectedImplementationCounter ? <small>{selectedImplementationCounter}</small> : null}
                </span>
                <strong>{workflowTitle(selected, selectedOpenQuestionCount, runs)}</strong>
                <small>{workflowSummary(selected, selectedOpenQuestionCount, runs)}</small>
              </div>
              <div className="run-workflow-actions">
                {selected.status === "awaiting-plan-review" && selectedOpenQuestionCount ? (
                  <>
                    <Tooltip content="Open the Questions tab to answer blockers before the plan can continue.">
                      <Button type="button" variant="primary" title="Open the Questions tab to answer blockers before the plan can continue." onClick={openQuestionsTab}>
                        <span>Open Questions</span>
                      </Button>
                    </Tooltip>
                    {selectedPendingGraphProposalCount ? (
                      <Tooltip content={graphReviewTooltip(selectedPendingGraphProposalCount)}>
                        <Button type="button" title={graphReviewTooltip(selectedPendingGraphProposalCount)} onClick={openPatchReview}>
                          <FileJson size={16} />
                          <span>Review Graph Changes</span>
                        </Button>
                      </Tooltip>
                    ) : null}
                    <Tooltip content={cancelTooltip(selected)}>
                      <Button type="button" title={cancelTooltip(selected)} onClick={() => cancelRun(selected.id)}>
                        <PauseCircle size={16} />
                        <span>Cancel</span>
                      </Button>
                    </Tooltip>
                  </>
                ) : selectedNeedsAction ? (
                  <>
                    {selected.status === "awaiting-plan-review" && selectedPendingGraphProposalCount ? (
                      <>
                        <Tooltip content={graphReviewTooltip(selectedPendingGraphProposalCount)}>
                          <Button type="button" variant="primary" title={graphReviewTooltip(selectedPendingGraphProposalCount)} onClick={openPatchReview}>
                            <FileJson size={16} />
                            <span>Review Graph Changes</span>
                          </Button>
                        </Tooltip>
                        <Tooltip content={approvalTooltip(selected)}>
                          <Button type="button" title={approvalTooltip(selected)} onClick={() => approveRun(selected.id, reusableApproval)}>
                            <ShieldCheck size={16} />
                            <span>{approvalLabel(selected)}</span>
                          </Button>
                        </Tooltip>
                      </>
                    ) : (
                      <Tooltip content={approvalTooltip(selected)}>
                        <Button type="button" variant="primary" title={approvalTooltip(selected)} onClick={() => approveRun(selected.id, reusableApproval)}>
                          <ShieldCheck size={16} />
                          <span>{approvalLabel(selected)}</span>
                        </Button>
                      </Tooltip>
                    )}
                    <Tooltip content={rejectTooltip(selected)}>
                      <Button type="button" title={rejectTooltip(selected)} onClick={() => openRejectReview(selected.id)}>
                        <XCircle size={16} />
                        <span>{rejectLabel(selected)}</span>
                      </Button>
                    </Tooltip>
                    <Tooltip content={cancelTooltip(selected)}>
                      <Button type="button" title={cancelTooltip(selected)} onClick={() => cancelRun(selected.id)}>
                        <PauseCircle size={16} />
                        <span>Cancel</span>
                      </Button>
                    </Tooltip>
                    {selected.status === "needs-permission" && !pendingMcpToolCall(selected) ? (
                      <label className="check-row compact-check">
                        <input
                          type="checkbox"
                          checked={reusableApproval}
                          onChange={() => setReusableApproval((current) => !current)}
                        />
                        <span>Remember</span>
                      </label>
                    ) : null}
                  </>
                ) : null}
                {isActive(selected) && !selectedNeedsAction ? (
                  <Button type="button" onClick={() => cancelRun(selected.id)}>
                    <PauseCircle size={16} />
                    <span>Cancel</span>
                  </Button>
                ) : null}
                {!isActive(selected) ? (
                  <Tooltip content={selectedRunActionBlocked ? selectedRunActionBlockMessage : "Retry or resume this run."}>
                    <span className="toolbar-tooltip-target">
                      <Button
                        type="button"
                        onClick={() => openGuidance("retry")}
                        disabled={selectedRunActionBlocked}
                        title={selectedRunActionBlocked ? selectedRunActionBlockMessage : undefined}
                      >
                        {guidanceTarget === "retry" ? <ChevronDown size={16} /> : <RefreshCw size={16} />}
                        <span>{guidanceTarget === "retry" ? "Options" : "Retry"}</span>
                      </Button>
                    </span>
                  </Tooltip>
                ) : null}
                {selectedFailure ? (
                  <Button type="button" onClick={() => dismissRunError(selected.id)}>
                    <span>Dismiss Error</span>
                  </Button>
                ) : null}
                {isRunErrorResolved(selected, runs) && !selected.queueRemovedAt ? (
                  <Button type="button" onClick={() => removeRunFromQueue(selected.id)}>
                    <span>Remove from Queue</span>
                  </Button>
                ) : null}
                {selected.status === "failed" ? (
                  <Tooltip content={selectedRunActionBlocked ? selectedRunActionBlockMessage : "Start a debug pass from this failure."}>
                    <span className="toolbar-tooltip-target">
                      <Button
                        type="button"
                        variant="primary"
                        onClick={() => openGuidance("debug")}
                        disabled={selectedRunActionBlocked}
                        title={selectedRunActionBlocked ? selectedRunActionBlockMessage : undefined}
                      >
                        <Bug size={16} />
                        <span>{guidanceTarget === "debug" ? "Run Debug" : "Debug"}</span>
                      </Button>
                    </span>
                  </Tooltip>
                ) : null}
                {selected.planArtifactIds.length ? (
                  <Button
                    type="button"
                    onClick={openPlanTab}
                  >
                    <span>{selectedHasGeneratedPlan ? "Open Plan" : "Open Prompt"}</span>
                  </Button>
                ) : null}
                {selected.sourceDiffArtifactIds.length ? (
                  <Tooltip content={codeDiffTooltip(selected)}>
                    <Button
                      type="button"
                      title={codeDiffTooltip(selected)}
                      onClick={openCodeDiffTab}
                    >
                      <span>Open Source Changes</span>
                    </Button>
                  </Tooltip>
                ) : null}
              </div>
            </div>
            {rejectingRunId === selected.id ? (
              <div className="run-guidance-panel run-rejection-panel">
                <div className="run-guidance-heading">
                  <div>
                    <strong>{selected.sourceReview ? "Reject deletion" : selected.status === "awaiting-code-review" ? "Reject code" : selected.status === "awaiting-plan-review" ? "Reject plan" : pendingMcpToolCall(selected) ? "Deny MCP tool" : "Reject run"}</strong>
                    <small>{selected.sourceReview
                      ? "Explain why the file should be kept. The deletion is rejected and the same coding run continues."
                      : pendingMcpToolCall(selected)
                      ? "Add an optional denial reason. The run will continue without this tool."
                      : "Tell the next retry what must change. Reject stops this run; cancel stops it without a review decision."}</small>
                  </div>
                  <div className="run-guidance-heading-actions">
                    <Button type="button" size="sm" onClick={() => setRejectingRunId(null)}>Keep Reviewing</Button>
                    <Button type="button" size="sm" variant="danger" disabled={!rejectionReason.trim()} onClick={submitRejection}>
                      <XCircle size={14} />
                      <span>{selected.sourceReview ? "Reject and Continue" : "Reject and Stop"}</span>
                    </Button>
                  </div>
                </div>
                <TextArea
                  value={rejectionReason}
                  rows={3}
                  placeholder={selected.sourceReview
                    ? "Why should this file be kept?"
                    : pendingMcpToolCall(selected)
                      ? "Optional reason to show the provider when this tool call is denied"
                      : "What should be changed before this can be accepted?"}
                  onChange={(event) => setRejectionReason(event.target.value)}
                />
              </div>
            ) : null}
            {guidanceTarget ? (
              <div className="run-guidance-panel" ref={guidancePanelRef} tabIndex={-1}>
                <div className="run-guidance-heading">
                  <div>
                    <strong>{guidanceTarget === "retry" ? "Retry run" : "Debug run"}</strong>
                    <small>Add optional direction and evidence, then run.</small>
                  </div>
                  <div className="run-guidance-heading-actions">
                    <Button type="button" size="sm" onClick={() => setGuidanceTarget(null)}>Cancel</Button>
                    <Button type="button" size="sm" variant="primary" onClick={submitGuidance} disabled={selectedRunActionBlocked}>
                      <span>{guidanceTarget === "retry" ? "Run Retry" : "Run Debug"}</span>
                    </Button>
                  </div>
                </div>
                {selectedRunActionBlocked ? <small className="run-guidance-blocked">{selectedRunActionBlockMessage}</small> : null}
                <TextArea
                  value={guidanceText}
                  rows={3}
                  placeholder="Optional guidance for the next run"
                  onChange={(event) => setGuidanceText(event.target.value)}
                />
                <div className="run-guidance-evidence" aria-label="Evidence to include">
                  {evidenceOptions.map((option) => (
                    <label key={option.id} className="check-row compact-check">
                      <input
                        type="checkbox"
                        checked={guidanceEvidence.includes(option.id)}
                        onChange={() => setGuidanceEvidence((current) =>
                          current.includes(option.id) ? current.filter((item) => item !== option.id) : [...current, option.id]
                        )}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            {selectedNeedsAction ? (
              <div className="run-approval-meta" aria-label={approvalTitle(bundle, selected)}>
                <span><b className="run-label-accent">Subject</b>{selectedSubject}</span>
                {pendingMcpToolCall(selected)
                  ? <span><b className="run-label-warning">Tool</b>{`${pendingMcpToolCall(selected)?.serverLabel} / ${pendingMcpToolCall(selected)?.toolName}`}</span>
                  : <span><b className="run-label-warning">Allow</b>{runCommand(selected)}</span>}
                {pendingMcpToolCall(selected)?.intent ? <span><b>Intent</b>{pendingMcpToolCall(selected)?.intent}</span> : null}
                <span><b>Sandbox</b>{providerSandbox(bundle, selected)}</span>
              </div>
            ) : null}
            {selected.status === "awaiting-plan-review" && !selectedOpenQuestionCount ? (
              <section className="run-review-document" aria-label="Plan awaiting approval">
                <strong>Plan awaiting approval</strong>
                <p>{selectedPlanText ?? workflowSummary(selected, selectedOpenQuestionCount, runs)}</p>
              </section>
            ) : null}
            <div className="run-stage-strip" aria-label="Run stages">
              {stageItems.map((stage) => (
                <div key={stage.label} className={`run-stage run-stage-${stage.tone}`}>
                  <b>{stage.label}</b>
                  <span>{stage.detail}</span>
                </div>
              ))}
            </div>
            <div className="run-detail-lines">
              <small><b>Command</b>{runCommand(selected)}</small>
              <small><b className="run-label-accent">Subject</b>{selectedSubject}</small>
              <small><b className="run-label-accent">Updated</b>{runLastUpdatedLabel(selected)}</small>
              {selected.status !== "awaiting-plan-review" ? <small><b className="run-label-success">Status</b>{selectedPromptText ?? workflowSummary(selected, selectedOpenQuestionCount, runs)}</small> : null}
              <small><b className="run-label-accent">Effort</b>{runEffortLabel(selected)}</small>
              <small><b className="run-label-accent">Cost</b>{runCostLabel(selected)}</small>
              {selected.mcp ? (
                <small><b className={selected.mcp.decision === "allowed" ? "run-label-accent" : selected.mcp.decision === "pending" ? "run-label-warning" : undefined}>MCP</b>{`${selected.mcp.decision}${selected.mcp.pendingToolCall ? ` · pending ${selected.mcp.pendingToolCall.serverLabel}/${selected.mcp.pendingToolCall.toolName}` : selected.mcp.pendingServerIds.length ? ` · pending ${selected.mcp.pendingServerIds.join(", ")}` : ""}`}</small>
              ) : null}
              {selected.mcpToolCalls.length ? (
                <small><b className="run-label-accent">Tools</b>{selected.mcpToolCalls.map((call) => `${call.serverId === "archicode-internal-tools" ? "ArchiCode" : call.serverLabel ?? "MCP"}:${call.toolName}:${call.status}`).join(", ")}</small>
              ) : null}
              {selected.filesystemScope ? (
                <small>
                  <b className={selected.filesystemScope.violations.length ? "run-label-danger" : undefined}>Files</b>
                  {selected.filesystemScope.violations.length ? `Blocked: ${selected.filesystemScope.violations.join(" ")}` : selected.filesystemScope.policy}
                </small>
              ) : null}
            </div>
            {selectedFailure ? (
              <div className="run-error-callout" role="alert">
                <XCircle size={16} />
                <span>{selectedFailureDetails ? `${selectedFailureDetails.title}: ${selectedFailure}` : selectedFailure}</span>
              </div>
            ) : null}
            <div className="run-progress-list">
              {progressItems.length ? progressItems.map((item) => (
                <div key={item.id} className={`run-progress-item run-progress-${item.tone}${item.detail ? "" : " no-detail"}`}>
                  <span>{new Date(item.at).toLocaleTimeString()}</span>
                  <strong>{item.label}</strong>
                  {item.detail ? <small>{item.detail}</small> : null}
                </div>
              )) : <small>Waiting for provider activity...</small>}
            </div>
          </>
        </div>
      ) : null}
    </div>
  );
}
