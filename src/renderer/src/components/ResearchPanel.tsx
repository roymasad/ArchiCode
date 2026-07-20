import { AlertCircle, AlertTriangle, Archive, Box, Brain, Check, CheckCircle2, ChevronDown, ChevronUp, Circle, Clock3, Copy, Download, ExternalLink, Eye, FileJson, FileText, FolderKanban, History, Layers3, ListTodo, Loader2, Maximize2, MessageSquare, Mic, Minimize2, PanelLeftClose, PanelLeftOpen, Paperclip, Play, Plus, RefreshCw, Send, ShieldCheck, Sparkles, Split, Square, Volume2, Workflow, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Artifact, LlmUsage, ProjectBundle, ProjectSettings, ResearchChatScope, ResearchChatSession } from "@shared/schema";
import { gaiaAgent, pandoraAgent } from "@shared/agentIdentities";
import { deriveResearchChatContextPlan } from "@shared/contextBudget";
import { sumLlmUsage, isAllUsageUnavailable, formatCostUsd, formatTokenCount, llmUsageTotalTokens } from "@shared/llmPricing";
import { extractArchicodeResearch } from "@shared/researchExtraction";
import { isResearchThinkingPhrase } from "@shared/researchPersonality";
import { researchChangeSetCategory, type ResearchChangeSetCategory } from "@shared/researchChangeSetSemantics";
import { defaultResearchScope, getActiveFlow, useArchicodeStore } from "../store/useArchicodeStore";
import archiChatEmptyIllustration from "../assets/archi-chat-empty.png";
import { ChatComposer } from "./ChatComposer";
import { composerDraftText, serializeComposerDraft, composerHasContent } from "../store/useArchicodeStore";
import { canRetryResearchMessage } from "../utils/researchRetry";
import { localProviderUsageUnavailableDetail } from "../utils/providerProfiles";
import { ContextSizeIndicator } from "./ContextSizeIndicator";
import { Badge, Button, DialogContent, DialogRoot, EmptyState, IconButton, MenuContent, MenuItem, MenuLabel, MenuRoot, MenuSeparator, MenuTrigger, PopoverContent, PopoverRoot, PopoverTrigger, ScrollArea, Select, Switch, TextArea, Tooltip } from "./ui";
import {
  attachmentFileName,
  displayResearchContent,
  formatUsageSummaryLine,
  changeSetResultReportPresentation,
  isImageAttachmentPath,
  isImageArtifact,
  isTextAttachmentArtifact,
  mcpToolActivityLine,
  mcpToolUsageTooltip,
  type ResearchMcpToolCall,
  readableResearchContent,
  scopeKey,
  visibleResearchContent
} from "./researchContent";
import {
  type PendingTtsSpeechJob,
  type PendingTtsStartWaiter,
  type StreamingTtsState,
  type TtsDebugContext,
  displayTtsHighlightText,
  inspectStreamingSpeechPrefix,
  makeTtsDebugLogId,
  maxActiveTtsSpeechJobs,
  previewTtsText,
  splitTtsPrepareUnits,
  ttsConsoleInfo,
  ttsElapsed,
  ttsFileDebugEnabled,
  writeClipboardText
} from "./researchTts";
import {
  chatFileBaseName,
  downloadTextFile,
  encodeWav,
  formatBytes,
  formatResearchChatJson,
  formatResearchChatMarkdown,
  hasResearchMemory
} from "./researchTranscript";
import { ResearchWorkCapsule, researchTodosForSession } from "./ResearchTodoCapsule";
import { type ArchicodeGraphLink, type ArchicodeProjectPathLink, ResearchMarkdown } from "./ResearchMarkdown";
import { ChatArtifactsPanel, ProjectMemoryNotesPanel, ResearchHistoryList, ResearchMemoryPanel } from "./ResearchMemoryPanel";
import { ChatModelPicker } from "./ChatModelPicker";
import { modelOptionsForProvider } from "./projectToolbarShared";
import { providerImageInputSupportStatus, type ProviderImageInputSupportStatus } from "@shared/providerCapabilities";
import { isRunBlockingNewChange } from "../utils/runStatus";
import { isTimeoutFailureMessage } from "@shared/failureSemantics";
import { classifyCommandRisk, type ShellCommandRisk } from "@shared/execution";
import {
  chatModelDisplayName,
  configuredResearchModelId,
  lastUsedResearchModelId,
  persistedResearchModelId,
  PROVIDER_DEFAULT_MODEL_VALUE
} from "../utils/researchModels";

const RESEARCH_RULES_TOOL_NAME = "archicode_project_manage_rules";

type DelphiObservationArtifact = { id: string; label: string; path: string; mediaType: string };
type DelphiObservationRunStatus = "awaiting-approval" | "running" | "completed" | "incomplete" | "blocked" | "timed-out" | "failed" | "rejected";

function delphiObservationInspectionSummary(
  captureCount: number,
  inspectedCount: number,
  imageInputSupport: ProviderImageInputSupportStatus | undefined,
  runStatus: DelphiObservationRunStatus
): string {
  const pendingCount = Math.max(0, captureCount - inspectedCount);
  if (inspectedCount > 0) {
    return imageInputSupport === "supported" && runStatus === "running" && pendingCount > 0
      ? `${inspectedCount} model-inspected · ${pendingCount} pending`
      : `${inspectedCount} model-inspected`;
  }
  return imageInputSupport === "supported" && runStatus === "running"
    ? "inspection pending"
    : "not model-inspected";
}

function DelphiObservationGallery(props: {
  projectRoot: string;
  artifacts: DelphiObservationArtifact[];
  modelInspectedArtifactIds: string[];
  imageInputSupport?: ProviderImageInputSupportStatus;
  runStatus: DelphiObservationRunStatus;
}): ReactNode {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [shouldLoadPreviews, setShouldLoadPreviews] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const galleryRef = useRef<HTMLDivElement | null>(null);
  const imageArtifacts = props.artifacts.filter((artifact) => artifact.mediaType.startsWith("image/"));
  const inspectedArtifactIds = new Set(props.modelInspectedArtifactIds);
  const inspectionSummary = delphiObservationInspectionSummary(
    props.artifacts.length,
    props.modelInspectedArtifactIds.length,
    props.imageInputSupport,
    props.runStatus
  );
  const pendingInspection = props.imageInputSupport === "supported" && props.runStatus === "running";
  const visibleArtifacts = expanded ? imageArtifacts : imageArtifacts.slice(-4);
  const artifactKey = visibleArtifacts.map((artifact) => `${artifact.id}:${artifact.path}`).join("|");

  useEffect(() => {
    if (shouldLoadPreviews || !visibleArtifacts.length) return;
    const gallery = galleryRef.current;
    if (!gallery || typeof IntersectionObserver === "undefined") {
      setShouldLoadPreviews(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldLoadPreviews(true);
      observer.disconnect();
    }, { rootMargin: "500px 0px" });
    observer.observe(gallery);
    return () => observer.disconnect();
  }, [shouldLoadPreviews, visibleArtifacts.length]);

  useEffect(() => {
    let cancelled = false;
    if (!shouldLoadPreviews || !visibleArtifacts.length || !window.archicode?.readArtifactDataUrl) {
      setPreviews({});
      return () => { cancelled = true; };
    }
    void Promise.all(visibleArtifacts.map(async (artifact) => {
      try {
        return [artifact.id, await window.archicode.readArtifactDataUrl(props.projectRoot, artifact.path)] as const;
      } catch {
        return [artifact.id, ""] as const;
      }
    })).then((entries) => {
      if (!cancelled) setPreviews(Object.fromEntries(entries.filter(([, value]) => value)));
    });
    return () => { cancelled = true; };
  // artifactKey is a stable content key; depending on the array itself would
  // reload previews on every live progress line.
  }, [artifactKey, props.projectRoot, shouldLoadPreviews]);

  if (!visibleArtifacts.length) return null;
  return (
    <div ref={galleryRef} className="research-delphi-observations">
      <div className="research-delphi-observations-head">
        <Eye size={13} />
        <span>Captured evidence</span>
        <small>
          {props.artifacts.length} capture{props.artifacts.length === 1 ? "" : "s"}
          {` · ${inspectionSummary}`}
        </small>
      </div>
      <div className={`research-delphi-observation-grid${visibleArtifacts.length === 1 ? " is-single" : ""}`}>
        {visibleArtifacts.map((artifact) => (
          <button
            type="button"
            key={artifact.id}
            title={`${artifact.label} — ${inspectedArtifactIds.has(artifact.id) ? "model-inspected" : pendingInspection ? "inspection pending" : "not model-inspected"}; open evidence`}
            onClick={() => void window.archicode?.openProjectFile(props.projectRoot, artifact.path)}
          >
            {previews[artifact.id] ? <img src={previews[artifact.id]} alt={artifact.label} loading="lazy" decoding="async" /> : <Loader2 size={16} className="is-spinning" />}
            <span>{artifact.label}</span>
          </button>
        ))}
      </div>
      {imageArtifacts.length > 4 ? (
        <button
          type="button"
          className="research-delphi-observation-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : `Show all ${imageArtifacts.length}`}
        </button>
      ) : null}
    </div>
  );
}

function ResearchMessageImageAttachments(props: { projectRoot: string; artifacts: Artifact[] }): ReactNode {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [shouldLoad, setShouldLoad] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const artifactKey = props.artifacts.map((artifact) => `${artifact.id}:${artifact.path}`).join("|");

  useEffect(() => {
    if (shouldLoad || !props.artifacts.length) return;
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { rootMargin: "500px 0px" });
    observer.observe(container);
    return () => observer.disconnect();
  }, [props.artifacts.length, shouldLoad]);

  useEffect(() => {
    let cancelled = false;
    if (!shouldLoad || !props.artifacts.length || !window.archicode?.readArtifactDataUrl) return;
    void Promise.all(props.artifacts.map(async (artifact) => {
      try {
        return [artifact.id, await window.archicode.readArtifactDataUrl(props.projectRoot, artifact.path)] as const;
      } catch {
        return [artifact.id, ""] as const;
      }
    })).then((entries) => {
      if (!cancelled) setPreviews(Object.fromEntries(entries.filter(([, value]) => value)));
    });
    return () => { cancelled = true; };
  // artifactKey captures the stable identity/path inputs without retriggering
  // when the parent recreates the filtered artifact array during streaming.
  }, [artifactKey, props.projectRoot, shouldLoad]);

  if (!props.artifacts.length) return null;
  return (
    <div ref={containerRef} className="research-message-image-grid" aria-label="Image attachments">
      {props.artifacts.map((artifact) => (
        <button
          key={artifact.id}
          type="button"
          className="research-message-image-thumb"
          title={artifact.title}
          onClick={() => void window.archicode?.openProjectFile(props.projectRoot, artifact.path)}
        >
          {previews[artifact.id]
            ? <img src={previews[artifact.id]} alt={artifact.title} loading="lazy" decoding="async" />
            : <Loader2 size={16} className="is-spinning" />}
        </button>
      ))}
    </div>
  );
}

type RuleApprovalPresentation = {
  summary: string;
  implication: string;
  exactJson: string;
};

type CommandApprovalPresentation = {
  command: string;
  cwd: string;
  risk: ShellCommandRisk;
};

export function shellCommandMarkdown(command: string): string {
  const longestBacktickRun = Math.max(0, ...(command.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}bash\n${command}\n${fence}`;
}

function commandRiskHint(risk: ShellCommandRisk, command: string): string {
  if (risk === "low") return "Recognized as read-only or low-impact by ArchiCode's command safety classifier.";
  if (risk === "medium") return "May invoke tools, access external resources, or change local state; review before allowing.";
  if (command.includes("$(") || command.includes("`")) {
    return "Classified high because shell command substitution can execute nested commands that the safety classifier cannot prove are read-only.";
  }
  return "Contains destructive, privileged, or unrestricted shell behavior; review especially carefully.";
}

function parsedToolArguments(argumentsJson: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function ResearchToolTrace(props: {
  call: ResearchMcpToolCall;
  copyKey: string;
  copiedCommandKey: string | null;
  onCopyCommand: (copyKey: string, command: string) => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const command = commandApprovalPresentation("", props.call.toolName, props.call.argumentsJson ?? "{}");
  const args = parsedToolArguments(props.call.argumentsJson);
  const description = typeof args.description === "string" ? args.description.trim() : "";
  const statusLabel = props.call.status === "succeeded"
    ? command ? "Ran CLI" : "Used tool"
    : props.call.status === "failed"
      ? command ? "CLI failed" : "Tool failed"
      : "Approval requested";
  const statusTone = props.call.status === "succeeded" ? "success" : props.call.status === "failed" ? "danger" : "warning";
  const activity = command
    ? description || command.command.split(/\r?\n/, 1)[0] || "Shell command"
    : mcpToolActivityLine(props.call);
  const result = props.call.error?.trim() || props.call.resultSummary?.trim() || "";
  const argumentsDisplay = props.call.argumentsJson?.trim()
    ? JSON.stringify(args, null, 2)
    : "";

  return (
    <details
      className={`research-tool-trace is-${props.call.status}`}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {command ? <Play size={12} aria-hidden="true" /> : <Workflow size={12} aria-hidden="true" />}
        <span className="research-tool-trace-status">{statusLabel}</span>
        <span className="research-tool-trace-activity">{activity}</span>
        <ChevronDown size={12} className="research-tool-trace-chevron" aria-hidden="true" />
      </summary>
      {expanded ? <div className="research-tool-trace-details">
        <div className="research-tool-trace-meta">
          <span>{props.call.serverLabel?.trim() || props.call.serverId} · {props.call.toolName}</span>
          <Badge tone={statusTone}>{props.call.status}</Badge>
        </div>
        {command ? (
          <>
            <div className="research-command-approval-heading">
              <strong>Exact command</strong>
              <Badge
                className="research-command-risk-badge"
                tone={command.risk === "low" ? "success" : command.risk === "medium" ? "warning" : "danger"}
              >
                {command.risk[0].toUpperCase() + command.risk.slice(1)} risk
              </Badge>
            </div>
            <div className="research-command-approval-code">
              <IconButton
                className="research-command-copy-button"
                title={props.copiedCommandKey === props.copyKey ? "Copied" : "Copy exact command"}
                aria-label={props.copiedCommandKey === props.copyKey ? "Command copied" : "Copy exact command"}
                onClick={() => props.onCopyCommand(props.copyKey, command.command)}
              >
                {props.copiedCommandKey === props.copyKey ? <Check size={12} /> : <Copy size={12} />}
              </IconButton>
              <ResearchMarkdown content={shellCommandMarkdown(command.command)} />
            </div>
            <small className="research-command-risk-hint">{commandRiskHint(command.risk, command.command)}</small>
            <small>Working directory: {command.cwd}</small>
          </>
        ) : argumentsDisplay && argumentsDisplay !== "{}" ? (
          <>
            <strong>Arguments</strong>
            <pre>{argumentsDisplay}</pre>
          </>
        ) : null}
        {result ? (
          <>
            <strong>{props.call.status === "failed" ? "Error" : "Result"}</strong>
            <pre className={props.call.status === "failed" ? "is-error" : ""}>{result}</pre>
          </>
        ) : null}
        <time dateTime={props.call.createdAt}>{new Date(props.call.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
      </div> : null}
    </details>
  );
}

export function commandApprovalPresentation(
  providerToolName: string,
  toolName: string,
  argumentsJson: string
): CommandApprovalPresentation | null {
  if (providerToolName !== "archicode_console_run_command" && toolName !== "run_command") return null;
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const args = parsed as Record<string, unknown>;
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return null;
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : "Project root";
    return { command, cwd, risk: classifyCommandRisk(command) };
  } catch {
    return null;
  }
}

export function ruleApprovalPresentation(argumentsJson: string): RuleApprovalPresentation {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    return {
      summary: "Change a reusable rule",
      implication: "The exact request could not be formatted, so review the raw payload carefully before approving.",
      exactJson: argumentsJson
    };
  }
  const action = args.action === "create" ? "Create" : "Edit";
  const source = args.action === "create" && args.rule && typeof args.rule === "object" && !Array.isArray(args.rule)
    ? args.rule as Record<string, unknown>
    : args.patch && typeof args.patch === "object" && !Array.isArray(args.patch)
      ? args.patch as Record<string, unknown>
      : {};
  const title = typeof source.title === "string" && source.title.trim()
    ? source.title.trim()
    : typeof args.ruleId === "string" && args.ruleId.trim()
      ? args.ruleId.trim()
      : "reusable rule";
  const attachmentCount = Array.isArray(args.attachTo) ? args.attachTo.length : 0;
  const detachmentCount = Array.isArray(args.detachFrom) ? args.detachFrom.length : 0;
  const attachmentSummary = [
    attachmentCount ? `attach to ${attachmentCount} node${attachmentCount === 1 ? "" : "s"}` : "",
    detachmentCount ? `detach from ${detachmentCount} node${detachmentCount === 1 ? "" : "s"}` : ""
  ].filter(Boolean).join(" and ");
  const isPolicy = source.kind === "policy" || Boolean(source.constraint);
  const severity = typeof source.severity === "string" ? source.severity : "warning";
  const enforcement = typeof source.enforcement === "string" ? source.enforcement : "advisory";
  return {
    summary: `${action} “${title}”${attachmentSummary ? ` and ${attachmentSummary}` : ""}.`,
    implication: isPolicy
      ? `This is a local deterministic policy (${severity}, ${enforcement}); lint evaluation uses no LLM. ${severity === "error" && enforcement === "enforced" ? "New violations can fail source-changing runs after their baseline." : "Violations will be reported without failing runs."}`
      : "This guidance/decision changes durable agent context but does not create live lint violations.",
    exactJson: JSON.stringify(args, null, 2)
  };
}

function providerSupportsImages(provider: ProjectSettings["providers"][number] | undefined, modelId?: string): boolean {
  if (!provider || provider.kind === "offline-manual") return false;
  if (provider.kind === "codex-local" || provider.kind === "claude-local" || provider.kind === "opencode-local" || provider.kind === "antigravity-local" || provider.kind === "grok-local" || provider.kind === "kimi-local") return true;
  const support = providerImageInputSupportStatus(provider, modelId);
  if (support.status !== "unknown") return support.status === "supported";
  return !(modelId ?? provider.model ?? "").toLowerCase().includes("text");
}

function sameScope(left: ResearchChatScope, right: ResearchChatScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

export function successfulSubagentBatchCount(
  kind: "merge-resolution" | "graph-reconciliation" | "test-authoring" | "sherlock-research" | "delphi-testing",
  progressLines: string[]
): number {
  if (kind !== "graph-reconciliation") return 0;
  return progressLines.reduce((highest, line) => {
    const match = line.match(/^Submitted (?:final )?graph batch B(\d+)\b/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
}

function scopeLabel(scope: ResearchChatScope, bundle: ReturnType<typeof useArchicodeStore.getState>["bundle"]): string {
  if (!bundle) return "Project";
  if (scope.type === "project") return `Project: ${bundle.project.name}`;
  const flow = bundle.flows.find((item) => item.id === scope.flowId);
  if (scope.type === "flow") return `Flow: ${flow?.name ?? scope.flowId}`;
  if (scope.type === "subflow") {
    const subflow = flow?.subflows.find((item) => item.id === scope.subflowId);
    return `Subflow: ${subflow?.name ?? scope.subflowId}`;
  }
  const node = flow?.nodes.find((item) => item.id === scope.nodeId);
  return `Node: ${node?.title ?? scope.nodeId}`;
}

function ResearchScopeIcon({ scope }: { scope: ResearchChatScope }) {
  if (scope.type === "project") return <FolderKanban size={14} aria-hidden="true" />;
  if (scope.type === "flow") return <Workflow size={14} aria-hidden="true" />;
  if (scope.type === "subflow") return <Layers3 size={14} aria-hidden="true" />;
  return <Box size={14} aria-hidden="true" />;
}

function parseScope(value: string, projectId: string): ResearchChatScope {
  const [type, flowId, id] = value.split(":");
  if (type === "flow" && flowId) return { type: "flow", flowId };
  if (type === "subflow" && flowId && id) return { type: "subflow", flowId, subflowId: id };
  if (type === "node" && flowId && id) return { type: "node", flowId, nodeId: id };
  return { type: "project", projectId };
}

type ResearchOperationView = NonNullable<ResearchChatSession["messages"][number]["changeSet"]>["operations"][number];
type ResearchChangeSetView = NonNullable<ResearchChatSession["messages"][number]["changeSet"]>;
type ResearchChangeSetReviewSummary = {
  applied: number;
  rejected: number;
  failed: number;
  autoApproved: boolean;
};

type ResearchTranscriptAnalysis = {
  lastVisibleMessageIndex: number;
  reviewSummaryByChangeSetIndex: Map<number, ResearchChangeSetReviewSummary>;
};

function changeSetReviewKey(sessionId: string, messageId: string, changeSetId: string): string {
  return `${sessionId}:${messageId}:${changeSetId}`;
}

export function parseResearchChangeSetReviewSummary(message: ResearchChatSession["messages"][number]): ResearchChangeSetReviewSummary | null {
  if (message.role !== "system") return null;
  const match = message.content.trim().match(/^(Graph changes reviewed|Graph changes retry reviewed|Auto-approved graph changes|Queue submission reviewed|Queue submission retry reviewed|Changes reviewed|Changes retry reviewed):\s+(\d+)\s+(?:applied|queued),\s+(\d+)\s+rejected,\s+(\d+)\s+failed\./);
  if (!match) return null;
  return {
    autoApproved: match[1] === "Auto-approved graph changes",
    applied: Number(match[2]),
    rejected: Number(match[3]),
    failed: Number(match[4])
  };
}

function isChangeSetReviewMessage(message: ResearchChatSession["messages"][number]): boolean {
  return Boolean(parseResearchChangeSetReviewSummary(message));
}

function reviewSummaryAfterChangeSet(session: ResearchChatSession, messageIndex: number): ResearchChangeSetReviewSummary | null {
  let latest: ResearchChangeSetReviewSummary | null = null;
  for (const laterMessage of session.messages.slice(messageIndex + 1)) {
    if (laterMessage.changeSet) break;
    const summary = parseResearchChangeSetReviewSummary(laterMessage);
    if (summary) latest = summary;
  }
  return latest;
}

function analyzeResearchTranscript(session: ResearchChatSession): ResearchTranscriptAnalysis {
  let lastVisibleMessageIndex = -1;
  let activeChangeSetIndex: number | null = null;
  const reviewSummaryByChangeSetIndex = new Map<number, ResearchChangeSetReviewSummary>();

  session.messages.forEach((message, messageIndex) => {
    const reviewSummary = parseResearchChangeSetReviewSummary(message);
    if (!reviewSummary) lastVisibleMessageIndex = messageIndex;
    if (message.changeSet) {
      activeChangeSetIndex = messageIndex;
      return;
    }
    if (reviewSummary && activeChangeSetIndex !== null) {
      reviewSummaryByChangeSetIndex.set(activeChangeSetIndex, reviewSummary);
    }
  });

  return { lastVisibleMessageIndex, reviewSummaryByChangeSetIndex };
}

function reviewStatusPresentation(summary: ResearchChangeSetReviewSummary | null, category: ResearchChangeSetCategory): {
  badgeTone: "success" | "warning" | "danger";
  badgeLabel: string;
  actionLabel: string;
  summaryLabel: string;
} | null {
  if (!summary) return null;
  const queueSubmission = category === "queue";
  const summaryLabel = `${summary.applied} ${queueSubmission ? "queued" : "applied"}, ${summary.rejected} rejected, ${summary.failed} failed`;
  if (summary.failed > 0 && summary.applied === 0) {
    return {
      badgeTone: "danger",
      badgeLabel: queueSubmission ? "Queue failed" : "Failed",
      actionLabel: queueSubmission ? "Queue failed" : "Apply Failed",
      summaryLabel
    };
  }
  if (summary.failed > 0 || summary.rejected > 0) {
    return {
      badgeTone: "warning",
      badgeLabel: queueSubmission ? "Partially queued" : "Partial",
      actionLabel: queueSubmission ? "Partially queued" : "Partially Applied",
      summaryLabel
    };
  }
  return {
    badgeTone: "success",
    badgeLabel: queueSubmission ? "Queued" : summary.autoApproved ? "Auto-applied" : "Applied",
    actionLabel: queueSubmission ? "Queued" : summary.autoApproved ? "Auto-applied" : "Applied",
    summaryLabel
  };
}

function hasLegacyReviewAfterChangeSet(session: ResearchChatSession, messageIndex: number): boolean {
  return Boolean(reviewSummaryAfterChangeSet(session, messageIndex));
}

function nodeTitleMap(bundle: ReturnType<typeof useArchicodeStore.getState>["bundle"], changeSet?: ResearchChangeSetView): Map<string, string> {
  const titles = new Map<string, string>();
  for (const flow of bundle?.flows ?? []) {
    for (const node of flow.nodes) titles.set(node.id, node.title);
  }
  for (const operation of changeSet?.operations ?? []) {
    if (operation.kind === "create-node" && operation.node.id) {
      titles.set(operation.node.id, operation.node.title);
    }
  }
  return titles;
}

function nodeTitleLabel(nodeId: string | undefined, titles: Map<string, string>): string {
  if (!nodeId) return "unscoped";
  return titles.get(nodeId) ?? nodeId;
}

function flowTitleMap(bundle: ReturnType<typeof useArchicodeStore.getState>["bundle"], changeSet?: ResearchChangeSetView): Map<string, string> {
  const titles = new Map<string, string>();
  for (const flow of bundle?.flows ?? []) titles.set(flow.id, flow.name);
  for (const operation of changeSet?.operations ?? []) {
    if (operation.kind === "create-flow") {
      titles.set(operation.flow.id, operation.flow.name);
    }
    if (operation.kind === "update-flow" && operation.patch.name?.trim()) {
      titles.set(operation.flowId, operation.patch.name.trim());
    }
  }
  return titles;
}

function flowTitleLabel(flowId: string, titles: Map<string, string>): string {
  return titles.get(flowId) ?? flowId;
}

function subflowTitleMap(bundle: ReturnType<typeof useArchicodeStore.getState>["bundle"], changeSet?: ResearchChangeSetView): Map<string, string> {
  const titles = new Map<string, string>();
  for (const flow of bundle?.flows ?? []) {
    for (const subflow of flow.subflows) titles.set(subflow.id, subflow.name);
  }
  for (const operation of changeSet?.operations ?? []) {
    if (operation.kind === "create-subflow" && operation.subflow.id) {
      titles.set(operation.subflow.id, operation.subflow.name);
    }
  }
  return titles;
}

function subflowTitleLabel(subflowId: string | undefined, titles: Map<string, string>): string {
  if (!subflowId) return "root flow";
  return titles.get(subflowId) ?? subflowId;
}

function operationLabel(
  operation: ResearchOperationView,
  titles: Map<string, string>,
  subflowTitles: Map<string, string> = new Map(),
  flowTitles: Map<string, string> = new Map()
): string {
  if (operation.kind === "update-project") return "Update project metadata";
  if (operation.kind === "create-flow") return `Create flow "${operation.flow.name}"`;
  if (operation.kind === "update-flow") return `Update flow "${flowTitleLabel(operation.flowId, flowTitles)}"`;
  if (operation.kind === "update-node") return `Update node ${nodeTitleLabel(operation.patch.id, titles)}`;
  if (operation.kind === "update-edge") return `Update edge ${operation.edgeId}`;
  if (operation.kind === "add-note") return `Add note on ${nodeTitleLabel(operation.note.nodeId, titles)}`;
  if (operation.kind === "resolve-note") return `${operation.resolved ? "Resolve" : "Reopen"} note ${operation.noteId}`;
  if (operation.kind === "delete-note") return `Delete note ${operation.noteId}`;
  if (operation.kind === "create-node") {
    return operation.node.subflowId
      ? `Create node "${operation.node.title}" in subflow "${subflowTitleLabel(operation.node.subflowId, subflowTitles)}"`
      : `Create node "${operation.node.title}" on root flow`;
  }
  if (operation.kind === "create-edge") {
    return `Create edge ${nodeTitleLabel(operation.edge.source, titles)} -> ${nodeTitleLabel(operation.edge.target, titles)}`;
  }
  if (operation.kind === "create-subflow") return `Create subflow "${operation.subflow.name}"`;
  if (operation.kind === "update-subflow") return `Update detail flow ${subflowTitleLabel(operation.subflowId, subflowTitles)}`;
  if (operation.kind === "link-node-subflow") return operation.subflowId
    ? `Set detail flow for ${nodeTitleLabel(operation.nodeId, titles)} to "${subflowTitleLabel(operation.subflowId, subflowTitles)}"`
    : `Clear detail flow for ${nodeTitleLabel(operation.nodeId, titles)}`;
  if (operation.kind === "propose-run-profile") return `${operation.mode === "replace" ? "Replace" : "Create"} run target "${operation.profile.label}"`;
  if (operation.kind === "start-agent-run") {
    const effort = operation.effort === "fast" ? "Fast" : "High";
    return operation.nodeId
      ? `Queue ${gaiaAgent.name} for ${nodeTitleLabel(operation.nodeId, titles)} · ${effort} effort`
      : `Queue ${gaiaAgent.name} for "${flowTitleLabel(operation.flowId, flowTitles)}" · ${effort} effort`;
  }
  if (operation.kind === "start-run-profile") return `Queue run target ${operation.profileId}`;
  if (operation.kind === "stop-runtime-service") return `Stop runtime service ${operation.serviceId}`;
  if (operation.kind === "restart-runtime-service") return `Restart runtime service ${operation.serviceId}`;
  if (operation.kind === "retry-run") return `Queue retry for ${operation.runId}`;
  if (operation.kind === "start-debugging-run") return `Queue ${pandoraAgent.name} for ${operation.runId}`;
  if (operation.kind === "author-acceptance-tests") {
    return operation.nodeId
      ? `Regenerate acceptance tests for ${nodeTitleLabel(operation.nodeId, titles)}`
      : `Regenerate acceptance tests for flow "${flowTitleLabel(operation.flowId, flowTitles)}"`;
  }
  if (operation.kind === "run-acceptance-checks") return `Run acceptance checks for ${nodeTitleLabel(operation.nodeId, titles)}`;
  if (operation.kind === "start-runtime-debug-run") return `Queue ${pandoraAgent.name} for runtime ${operation.serviceId}`;
  if (operation.kind === "start-incident-debug-run") return `Queue ${pandoraAgent.name} for reported incidents`;
  if (operation.kind === "delete-node") return `Delete node ${nodeTitleLabel(operation.nodeId, titles)}`;
  if (operation.kind === "delete-edge") return `Delete edge ${operation.edgeId}`;
  if (operation.kind === "create-group") return `Create group "${operation.group.name}"`;
  if (operation.kind === "update-group") return `Update group ${operation.groupId}`;
  if (operation.kind === "delete-group") return `Delete group ${operation.groupId}`;
  return `Delete subflow ${subflowTitleLabel(operation.subflowId, subflowTitles)}`;
}

function operationFields(operation: ResearchOperationView): string {
  if (operation.kind === "update-project") return Object.keys(operation.patch).join(", ");
  if (operation.kind === "create-flow") return `${operation.flow.nodes.length} nodes · ${operation.flow.edges.length} edges`;
  if (operation.kind === "update-flow") return Object.keys(operation.patch).join(", ");
  if (operation.kind === "update-node") return Object.keys(operation.patch).filter((key) => key !== "id").join(", ");
  if (operation.kind === "update-edge") return Object.keys(operation.patch).join(", ");
  if (operation.kind === "update-subflow") return Object.keys(operation.patch).join(", ");
  if (operation.kind === "update-group") return Object.keys(operation.patch).join(", ");
  if (operation.kind === "link-node-subflow") return operation.subflowId ?? "No detail flow";
  if (operation.kind === "propose-run-profile") return [operation.profile.kind, operation.profile.runCommand, operation.reason].filter(Boolean).join(" · ");
  if (operation.kind === "start-agent-run") return [operation.promptSummary, operation.command].filter(Boolean).join(" · ");
  if (operation.kind === "start-run-profile") return [operation.flowId, operation.targetId].filter(Boolean).join(" · ");
  if (operation.kind === "stop-runtime-service" || operation.kind === "restart-runtime-service") return operation.serviceId;
  if (operation.kind === "retry-run" || operation.kind === "start-debugging-run") return "";
  if (operation.kind === "start-runtime-debug-run") return operation.flowId;
  if (operation.kind === "start-incident-debug-run") return operation.flowId ?? "";
  return "";
}

function operationFlowId(operation: ResearchOperationView): string | null {
  if (operation.kind === "create-flow") return operation.flow.id;
  if (
    operation.kind === "update-flow" ||
    operation.kind === "update-node" ||
    operation.kind === "update-edge" ||
    operation.kind === "create-node" ||
    operation.kind === "create-edge" ||
    operation.kind === "create-subflow" ||
    operation.kind === "create-group" ||
    operation.kind === "update-group" ||
    operation.kind === "update-subflow" ||
    operation.kind === "link-node-subflow" ||
    operation.kind === "start-agent-run" ||
    operation.kind === "start-run-profile" ||
    operation.kind === "start-runtime-debug-run" ||
    operation.kind === "delete-node" ||
    operation.kind === "delete-edge" ||
    operation.kind === "delete-subflow" ||
    operation.kind === "delete-group" ||
    operation.kind === "author-acceptance-tests" ||
    operation.kind === "run-acceptance-checks"
  ) return operation.flowId;
  if (operation.kind === "start-incident-debug-run") return operation.flowId ?? null;
  if (operation.kind === "add-note") return operation.note.flowId;
  return null;
}

function isDestructiveOperation(operation: ResearchOperationView): boolean {
  return operation.kind === "delete-note" || operation.kind === "delete-node" || operation.kind === "delete-edge" || operation.kind === "delete-subflow" || operation.kind === "delete-group" || operation.kind === "stop-runtime-service";
}

function formatResearchTaskElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function ResearchSubmitButton({
  disabled,
  label,
  pending,
  onSubmit
}: {
  disabled: boolean;
  label: string;
  pending: boolean;
  onSubmit: () => void;
}) {
  const hasContent = useArchicodeStore((state) => composerHasContent(state.researchDraft));
  return (
    <Button type="button" variant="primary" disabled={disabled || !hasContent} onClick={onSubmit}>
      {pending ? <Loader2 className="is-spinning" size={15} /> : <Send size={15} />}
      <span>{label}</span>
    </Button>
  );
}

function ResearchDraftContextIndicator({
  bundle,
  baseContextCharacters,
  ...props
}: {
  bundle: ProjectBundle | null;
  baseContextCharacters: number;
} & Omit<ComponentProps<typeof ContextSizeIndicator>, "estimatedTokens">) {
  const segments = useArchicodeStore((state) => state.researchDraft);
  const draft = useMemo(() => composerDraftText(segments, bundle), [bundle, segments]);
  // The base JSON contains draft:"". Replace those two empty-string quotes
  // with the exact JSON-encoded draft length without rebuilding chat history.
  const estimatedTokens = Math.ceil((baseContextCharacters - 2 + JSON.stringify(draft).length) / 4);
  return <ContextSizeIndicator {...props} estimatedTokens={estimatedTokens} />;
}

function ResearchTaskTimer({ startedAtMs }: { startedAtMs: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [startedAtMs]);
  const elapsed = formatResearchTaskElapsed(nowMs - startedAtMs);
  return (
    <Tooltip content="Elapsed time for the current user request, including parent continuations and subagent work.">
      <span className="ui-badge research-task-timer" aria-label={`Current task active for ${elapsed}`}>
        <Clock3 size={12} aria-hidden="true" />
        <span>{elapsed}</span>
      </span>
    </Tooltip>
  );
}

export const ResearchPanel = memo(function ResearchPanel({
  focusMode = false,
  onToggleFocusMode
}: {
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
}) {
  const {
    bundle,
    rootPath,
    activeFlowId,
    activeSubflowId,
    selectedNodeId,
    researchSessions,
    selectedResearchSessionId,
    researchScope,
    researchBusySessionIds,
    researchQueuedMessages,
    researchPendingAttachmentPaths,
    researchStreamStates,
    researchSubagentActivity,
    researchChatActivity,
    setResearchScope,
    requestResearchComposerFocus,
    navigateToGraphTarget,
    refreshResearchChats,
    selectResearchChat,
    archiveResearchChat,
    updateResearchChatAutoApproval,
    sendResearchMessage,
    retryResearchMessage,
    stopResearchMessage,
    forkResearchMessage,
    dequeueResearchMessage,
    reorderQueuedResearchMessage,
    summarizeResearchChat,
    applyResearchGraphChangeSet,
    respondToSubagentRun,
    globalSpeechSettings,
    globalTtsSettings,
    clearResearchDraft,
    appendResearchDraftText
  } = useArchicodeStore(useShallow((state) => ({
    bundle: state.bundle,
    rootPath: state.rootPath,
    activeFlowId: state.activeFlowId,
    activeSubflowId: state.activeSubflowId,
    selectedNodeId: state.selectedNodeId,
    researchSessions: state.researchSessions,
    selectedResearchSessionId: state.selectedResearchSessionId,
    researchScope: state.researchScope,
    researchBusySessionIds: state.researchBusySessionIds,
    researchQueuedMessages: state.researchQueuedMessages,
    researchPendingAttachmentPaths: state.researchPendingAttachmentPaths,
    researchStreamStates: state.researchStreamStates,
    researchSubagentActivity: state.researchSubagentActivity,
    researchChatActivity: state.researchChatActivity,
    setResearchScope: state.setResearchScope,
    requestResearchComposerFocus: state.requestResearchComposerFocus,
    navigateToGraphTarget: state.navigateToGraphTarget,
    refreshResearchChats: state.refreshResearchChats,
    selectResearchChat: state.selectResearchChat,
    archiveResearchChat: state.archiveResearchChat,
    updateResearchChatAutoApproval: state.updateResearchChatAutoApproval,
    sendResearchMessage: state.sendResearchMessage,
    retryResearchMessage: state.retryResearchMessage,
    stopResearchMessage: state.stopResearchMessage,
    forkResearchMessage: state.forkResearchMessage,
    dequeueResearchMessage: state.dequeueResearchMessage,
    reorderQueuedResearchMessage: state.reorderQueuedResearchMessage,
    summarizeResearchChat: state.summarizeResearchChat,
    applyResearchGraphChangeSet: state.applyResearchGraphChangeSet,
    respondToSubagentRun: state.respondToSubagentRun,
    globalSpeechSettings: state.globalSpeechSettings,
    globalTtsSettings: state.globalTtsSettings,
    clearResearchDraft: state.clearResearchDraft,
    appendResearchDraftText: state.appendResearchDraftText
  })));
  const [attachmentPaths, setAttachmentPaths] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [focusHistoryOpen, setFocusHistoryOpen] = useState(() => window.innerWidth > 900);
  const [acceptedByChangeSet, setAcceptedByChangeSet] = useState<Record<string, Set<number>>>({});
  const [pendingChangeSetKeys, setPendingChangeSetKeys] = useState<Set<string>>(() => new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copiedSubagentRunId, setCopiedSubagentRunId] = useState<string | null>(null);
  const [copiedCommandMessageId, setCopiedCommandMessageId] = useState<string | null>(null);
  const [chatExportStatus, setChatExportStatus] = useState<string | null>(null);
  const [composingNewChat, setComposingNewChat] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<"all" | "scope">("all");
  const [archiveConfirmationSessionId, setArchiveConfirmationSessionId] = useState<string | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [rememberMcpByMessage, setRememberMcpByMessage] = useState<Record<string, boolean>>({});
  const [subagentStrategyDrafts, setSubagentStrategyDrafts] = useState<Record<string, string>>({});
  const [delphiRuntimeTargetSelections, setDelphiRuntimeTargetSelections] = useState<Record<string, Set<string>>>({});
  const [respondingSubagentRunId, setRespondingSubagentRunId] = useState<string | null>(null);
  const [expandedSubagentSummaryIds, setExpandedSubagentSummaryIds] = useState<Set<string>>(() => new Set());
  const [researchHasNewActivity, setResearchHasNewActivity] = useState(false);
  const [rememberedMcpByChat, setRememberedMcpByChat] = useState<Record<string, Set<string>>>({});
  const [retryingMessageId, setRetryingMessageId] = useState<string | null>(null);
  const [chatModelValue, setChatModelValue] = useState(PROVIDER_DEFAULT_MODEL_VALUE);
  const [modelSwitchWarning, setModelSwitchWarning] = useState<{ from: string; to: string } | null>(null);
  const [speechStatus, setSpeechStatus] = useState<Awaited<ReturnType<typeof window.archicode.getSpeechStatus>> | null>(null);
  const [speechProgressLabel, setSpeechProgressLabel] = useState<string | null>(null);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [recordingSpeech, setRecordingSpeech] = useState(false);
  const [speechBusy, setSpeechBusy] = useState(false);
  const [ttsStatus, setTtsStatus] = useState<Awaited<ReturnType<typeof window.archicode.getTtsStatus>> | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsBusyMessageId, setTtsBusyMessageId] = useState<string | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const previousFocusModeRef = useRef(focusMode);
  const [ttsHighlight, setTtsHighlight] = useState<{ messageId: string; text: string } | null>(null);
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const speechMeterRef = useRef<HTMLDivElement | null>(null);
  const researchScrollFollowRef = useRef(true);
  const researchManualScrollHoldRef = useRef(false);
  const researchRevealSubmittedMessageRef = useRef(false);
  const speechStreamRef = useRef<MediaStream | null>(null);
  const speechAudioContextRef = useRef<AudioContext | null>(null);
  const speechSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const speechProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const speechChunksRef = useRef<Float32Array[]>([]);
  const speechSampleRateRef = useRef(44100);
  const ttsAudioContextRef = useRef<AudioContext | null>(null);
  const ttsAudioChunksRef = useRef(new Map<number, { buffer: AudioBuffer; durationMs: number; index: number; text?: string; total: number }>());
  const ttsExpectedChunkCountRef = useRef<number | null>(null);
  const ttsNextChunkIndexRef = useRef(0);
  const ttsQueuedChunkCountRef = useRef(0);
  const ttsSpeechJobSequenceRef = useRef(0);
  const ttsNextStartSpeechJobIndexRef = useRef(0);
  const ttsActiveSpeechJobCountRef = useRef(0);
  const ttsStartWaitersRef = useRef(new Map<number, PendingTtsStartWaiter>());
  const ttsNextFlushSpeechJobIndexRef = useRef(0);
  const ttsFinalSpeechJobCountRef = useRef<number | null>(null);
  const ttsSpeechJobsRef = useRef(new Map<number, PendingTtsSpeechJob>());
  const ttsAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const ttsAudioStartingRef = useRef(false);
  const ttsPlaybackRunIdRef = useRef(0);
  const ttsPlaybackDebugStartedAtMsRef = useRef<number | null>(null);
  const ttsDebugContextRef = useRef<TtsDebugContext | null>(null);
  const lastAutoplayMessageIdRef = useRef<string | null>(null);
  const streamingAutoplayRef = useRef<StreamingTtsState | null>(null);
  const lastStreamingAutoplayObservedKeyRef = useRef<string | null>(null);
  const suppressedStreamingAutoplayRef = useRef<{ messageId: string; sessionId: string } | null>(null);
  useEffect(() => {
    if (focusMode && !previousFocusModeRef.current) {
      setShowHistory(false);
      setFocusHistoryOpen(window.innerWidth > 900);
    }
    previousFocusModeRef.current = focusMode;
  }, [focusMode]);

  const defaultScope = bundle ? defaultResearchScope(bundle, activeFlowId, activeSubflowId, selectedNodeId) : null;
  const scope = researchScope ?? defaultScope;
  const selected = researchSessions.find((session) => session.id === selectedResearchSessionId) ?? null;
  const transcriptAnalysis = useMemo(
    () => selected
      ? analyzeResearchTranscript(selected)
      : { lastVisibleMessageIndex: -1, reviewSummaryByChangeSetIndex: new Map<number, ResearchChangeSetReviewSummary>() },
    [selected]
  );
  const activeGraphLockRun = bundle?.runs.find(isRunBlockingNewChange) ?? null;
  const researchBusy = selected ? researchBusySessionIds.includes(selected.id) : false;
  const latestTaskUserMessage = [...(selected?.messages ?? [])].reverse().find((message) => message.role === "user");
  const parsedResearchTaskStartedAtMs = latestTaskUserMessage ? Date.parse(latestTaskUserMessage.createdAt) : Number.NaN;
  // The user message is the task boundary. Parent continuations, approvals,
  // and subagent passes may briefly toggle the renderer's busy flag, but they
  // must all retain this same cumulative start time.
  const researchTaskStartedAtMs = Number.isFinite(parsedResearchTaskStartedAtMs) ? parsedResearchTaskStartedAtMs : null;
  const queuedMessages = selected ? researchQueuedMessages[selected.id] ?? [] : [];

  const messageAttachmentArtifacts = useMemo(() => {
    if (!bundle || !selected) return [];
    const attachmentIds = new Set(selected.messages.flatMap((message) => message.attachmentIds));
    return bundle.artifacts.filter((artifact) => attachmentIds.has(artifact.id));
  }, [bundle, selected]);
  const messageAttachmentArtifactsById = useMemo(() => {
    return new Map(messageAttachmentArtifacts.map((artifact) => [artifact.id, artifact]));
  }, [messageAttachmentArtifacts]);
  const streamingAssistantMessage = useMemo(() => [...(selected?.messages ?? [])].reverse().find((message) =>
    message.role === "assistant" && !message.error && message.id.startsWith("research-waiting")
  ), [selected?.messages]);
  const streamingAssistantContentKey = streamingAssistantMessage
    ? `${streamingAssistantMessage.id}:${streamingAssistantMessage.content.length}:${streamingAssistantMessage.content.slice(-80)}`
    : "";
  const provider = bundle?.project.settings.providers.find((item) => item.enabled);
  const selectedSessionProvider = selected
    ? bundle?.project.settings.providers.find((item) => item.id === selected.providerId)
    : undefined;
  // A chat owns its selected model, but the currently enabled provider owns
  // the model catalog and transport. Switching providers must not leave an
  // existing chat pinned to the provider that handled its previous turn.
  const chatProvider = provider;
  const persistedChatModelValue = selected
    ? persistedResearchModelId(selected, chatProvider)
    : lastUsedResearchModelId(researchSessions, chatProvider);
  const providerDefaultModelId = configuredResearchModelId(chatProvider);
  const chatModelRequest = chatModelValue === PROVIDER_DEFAULT_MODEL_VALUE ? null : chatModelValue;
  const chatModelOptions = useMemo(() => {
    const availableModels = chatProvider ? modelOptionsForProvider(chatProvider) : [];
    const values = [
      ...(providerDefaultModelId ? [] : [PROVIDER_DEFAULT_MODEL_VALUE]),
      providerDefaultModelId,
      persistedChatModelValue,
      chatModelValue,
      ...availableModels
    ].filter(Boolean);
    return [...new Set(values)].map((modelId) => ({
      value: modelId,
      label: modelId === PROVIDER_DEFAULT_MODEL_VALUE
        ? "Provider default"
        : modelId === providerDefaultModelId
          ? `${modelId} · Default`
          : modelId
    }));
  }, [chatModelValue, chatProvider, persistedChatModelValue, providerDefaultModelId]);
  const speechSettings = globalSpeechSettings;
  const ttsSettings = globalTtsSettings;
  const missingSpeechModelMessage = "Download the active speech model in Advanced settings before recording.";
  const selectedSpeechModelId = speechSettings?.modelId ?? "base";
  const selectedSpeechModel = speechStatus?.models.find((model) => model.id === selectedSpeechModelId) ?? null;
  const selectedTtsModelId = ttsSettings?.modelId ?? "kokoro-82m";
  const selectedTtsModel = ttsStatus?.models.find((model) => model.id === selectedTtsModelId) ?? null;
  const flow = getActiveFlow(bundle, activeFlowId);
  const pendingMcpApprovalMessage = selected?.messages.find((message) => message.mcpApprovalRequest);
  const mcpApprovalPending = Boolean(pendingMcpApprovalMessage);

  useEffect(() => {
    setChatModelValue(persistedChatModelValue);
    setModelSwitchWarning(null);
  }, [chatProvider?.id, persistedChatModelValue, selected?.id]);

  const selectChatModel = (nextModelId: string) => {
    if (nextModelId === chatModelValue) return;
    if (selected?.messages.length) {
      setModelSwitchWarning({
        from: chatModelDisplayName(chatModelValue),
        to: chatModelDisplayName(nextModelId)
      });
    } else {
      setModelSwitchWarning(null);
    }
    setChatModelValue(nextModelId);
  };

  const submitResearchChangeSet = (
    messageId: string,
    changeSet: ResearchChangeSetView,
    decisions: Parameters<typeof applyResearchGraphChangeSet>[3],
    retryReviewed = false
  ) => {
    const messageIndex = selected?.messages.findIndex((message) => message.id === messageId) ?? -1;
    if (!selected || (!retryReviewed && (changeSet.reviewedAt || (messageIndex >= 0 && hasLegacyReviewAfterChangeSet(selected, messageIndex))))) return;
    const key = changeSetReviewKey(selected.id, messageId, changeSet.id);
    if (pendingChangeSetKeys.has(key)) return;
    setPendingChangeSetKeys((current) => new Set(current).add(key));
    void applyResearchGraphChangeSet(selected.id, messageId, changeSet.id, decisions, retryReviewed)
      .finally(() => {
        setPendingChangeSetKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      });
  };

  const refreshSpeechStatus = useCallback(async () => {
    if (!window.archicode?.getSpeechStatus) return null;
    try {
      const status = await window.archicode.getSpeechStatus(selectedSpeechModelId);
      setSpeechStatus(status);
      setSpeechError(null);
      return status;
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : "Could not read speech runtime status.");
      return null;
    }
  }, [selectedSpeechModelId]);

  const setSpeechMeterLevel = useCallback((level: number) => {
    const meter = speechMeterRef.current;
    if (!meter) return;
    const normalized = Math.max(0, Math.min(1, level));
    meter.style.setProperty("--speech-level", normalized.toFixed(3));
    meter.style.setProperty("--speech-opacity", (0.22 + normalized * 0.42).toFixed(3));
    meter.style.setProperty("--speech-scale", (1 + normalized * 0.18).toFixed(3));
    [0.55, 0.9, 1.15, 0.75, 1].forEach((gain, index) => {
      meter.style.setProperty(`--speech-bar-${index}`, `${Math.max(4, 4 + normalized * 18 * gain)}px`);
    });
  }, []);

  const stopSpeechCapture = useCallback(async () => {
    speechProcessorRef.current?.disconnect();
    speechSourceRef.current?.disconnect();
    speechStreamRef.current?.getTracks().forEach((track) => track.stop());
    const audioContext = speechAudioContextRef.current;
    speechProcessorRef.current = null;
    speechSourceRef.current = null;
    speechStreamRef.current = null;
    speechAudioContextRef.current = null;
    setRecordingSpeech(false);
    setSpeechMeterLevel(0);
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close();
    }
  }, [setSpeechMeterLevel]);

  const startSpeechRecording = useCallback(async () => {
    if (!speechSettings?.enabled) {
      setSpeechError("Voice input is disabled for this project.");
      return;
    }
    const status = speechStatus ?? await refreshSpeechStatus();
    const model = status?.models.find((item) => item.id === selectedSpeechModelId);
    if (!status?.runtimeAvailable) {
      setSpeechError(status?.runtimeError ?? "Speech runtime is unavailable.");
      return;
    }
    if (!model?.downloaded) {
      setSpeechError(missingSpeechModelMessage);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setSpeechError("Microphone capture is not available in this runtime.");
      return;
    }

    try {
      setSpeechError(null);
      setSpeechProgressLabel(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      const AudioContextConstructor = window.AudioContext;
      const audioContext = new AudioContextConstructor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      speechChunksRef.current = [];
      speechSampleRateRef.current = audioContext.sampleRate;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        event.outputBuffer.getChannelData(0).fill(0);
        speechChunksRef.current.push(new Float32Array(input));
        let sum = 0;
        for (const sample of input) sum += sample * sample;
        setSpeechMeterLevel(Math.sqrt(sum / input.length) * 14);
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      speechStreamRef.current = stream;
      speechAudioContextRef.current = audioContext;
      speechSourceRef.current = source;
      speechProcessorRef.current = processor;
      if (audioContext.state === "suspended") await audioContext.resume();
      setRecordingSpeech(true);
    } catch (error) {
      await stopSpeechCapture();
      setSpeechError(error instanceof Error ? error.message : "Could not start microphone capture.");
    }
  }, [missingSpeechModelMessage, refreshSpeechStatus, selectedSpeechModelId, setSpeechMeterLevel, speechSettings?.enabled, speechStatus, stopSpeechCapture]);

  const stopSpeechRecording = useCallback(async (completion: "review" | "send" = "review") => {
    const chunks = speechChunksRef.current;
    const sampleRate = speechSampleRateRef.current;
    await stopSpeechCapture();
    if (!chunks.length) {
      setSpeechError("No microphone audio was captured.");
      return;
    }

    setSpeechBusy(true);
    setSpeechError(null);
    setSpeechProgressLabel("Transcribing voice input...");
    try {
      const audio = encodeWav(chunks, sampleRate);
      const result = await window.archicode.transcribeSpeech({
        audio,
        modelId: selectedSpeechModelId,
        language: speechSettings?.language,
        translateToEnglish: speechSettings?.translateToEnglish,
        threads: speechSettings?.threads
      });
      if (completion === "send" && !mcpApprovalPending && result.text.trim()) {
        const researchDraft = useArchicodeStore.getState().researchDraft;
        const draft = composerDraftText(researchDraft, bundle);
        const serialized = serializeComposerDraft(
          [...researchDraft, { kind: "text", text: `${draft ? `${draft.trimEnd()}\n\n` : ""}${result.text.trim()}` }],
          bundle
        );
        if (serialized.message.trim()) {
          setComposingNewChat(false);
          clearResearchDraft();
          const attached = attachmentPaths;
          setAttachmentPaths([]);
          const rememberedMcpServerIds = selected ? [...(rememberedMcpByChat[selected.id] ?? new Set<string>())] : [];
          researchRevealSubmittedMessageRef.current = !researchBusy;
          await sendResearchMessage(
            serialized.message.trim(),
            attached,
            rememberedMcpServerIds,
            [],
            undefined,
            serialized.referencedNodeIds,
            chatModelRequest
          );
        }
      } else {
        appendResearchDraftText(result.text);
      }
      setSpeechProgressLabel(null);
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : "Could not transcribe voice input.");
    } finally {
      setSpeechBusy(false);
      speechChunksRef.current = [];
    }
  }, [
    bundle,
    clearResearchDraft,
    appendResearchDraftText,
    attachmentPaths,
    mcpApprovalPending,
    rememberedMcpByChat,
    researchBusy,
    selected,
    selectedSpeechModelId,
    chatModelRequest,
    sendResearchMessage,
    speechSettings?.language,
    speechSettings?.threads,
    speechSettings?.translateToEnglish,
    stopSpeechCapture
  ]);

  const runSpeechAction = useCallback(async () => {
    if (recordingSpeech) {
      await stopSpeechRecording();
      return;
    }
    await startSpeechRecording();
  }, [recordingSpeech, startSpeechRecording, stopSpeechRecording]);

  const refreshTtsStatus = useCallback(async () => {
    if (!window.archicode?.getTtsStatus) return null;
    try {
      const status = await window.archicode.getTtsStatus(selectedTtsModelId);
      setTtsStatus(status);
      setTtsError(null);
      return status;
    } catch (error) {
      setTtsError(error instanceof Error ? error.message : "Could not read text-to-speech runtime status.");
      return null;
    }
  }, [selectedTtsModelId]);

  const ensureTtsAudioContext = useCallback(async () => {
    const AudioContextConstructor = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) throw new Error("Audio playback is not available in this runtime.");
    let audioContext = ttsAudioContextRef.current;
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContextConstructor();
      ttsAudioContextRef.current = audioContext;
    }
    if (audioContext.state === "suspended") await audioContext.resume();
    return audioContext;
  }, []);

  const writeTtsDebugEvent = useCallback((event: string, details: Record<string, unknown> = {}) => {
    if (!ttsFileDebugEnabled) return;
    const context = ttsDebugContextRef.current;
    if (!context || !window.archicode.writeTtsDebugLog) return;
    const entry = {
      event,
      elapsedMs: Math.max(0, Date.now() - context.startedAtMs),
      seq: ++context.sequence,
      time: new Date().toISOString(),
      ...details
    };
    void window.archicode.writeTtsDebugLog({
      events: [entry],
      logId: context.logId,
      messageId: context.messageId,
      playbackRunId: context.playbackRunId,
      sessionId: context.sessionId
    }).then((result) => {
      if (!context.path) ttsConsoleInfo(`[archicode:tts] debug log ${result.path}`);
      context.path = result.path;
    }).catch(() => undefined);
  }, []);

  const startTtsDebugLog = useCallback((
    messageId: string,
    playbackRunId: number,
    reason: "manual" | "streaming-autoplay",
    startedAtMs: number
  ) => {
    if (!ttsFileDebugEnabled) {
      ttsDebugContextRef.current = null;
      return;
    }
    const context: TtsDebugContext = {
      logId: makeTtsDebugLogId(selected?.id ?? null, messageId, playbackRunId, startedAtMs),
      messageId,
      playbackRunId,
      sequence: 0,
      sessionId: selected?.id ?? null,
      startedAtMs
    };
    ttsDebugContextRef.current = context;
    writeTtsDebugEvent("log-started", {
      reason,
      selectedTtsModelId,
      voiceId: ttsSettings?.voiceId ?? null
    });
  }, [selected?.id, selectedTtsModelId, ttsSettings?.voiceId, writeTtsDebugEvent]);

  const pumpTtsSpeechJobStarts = useCallback(() => {
    for (;;) {
      if (ttsActiveSpeechJobCountRef.current >= maxActiveTtsSpeechJobs) return;
      const jobIndex = ttsNextStartSpeechJobIndexRef.current;
      const waiter = ttsStartWaitersRef.current.get(jobIndex);
      if (!waiter) return;
      ttsStartWaitersRef.current.delete(jobIndex);
      if (ttsPlaybackRunIdRef.current !== waiter.playbackRunId) {
        waiter.resolve(false);
        ttsNextStartSpeechJobIndexRef.current = jobIndex + 1;
        continue;
      }
      ttsActiveSpeechJobCountRef.current += 1;
      ttsNextStartSpeechJobIndexRef.current = jobIndex + 1;
      waiter.resolve(true);
    }
  }, []);

  const waitForTtsSpeechJobStart = useCallback((speechJobIndex: number, playbackRunId: number) => {
    if (ttsPlaybackRunIdRef.current !== playbackRunId) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      ttsStartWaitersRef.current.set(speechJobIndex, { playbackRunId, resolve });
      pumpTtsSpeechJobStarts();
    });
  }, [pumpTtsSpeechJobStarts]);

  const releaseTtsSpeechJobStart = useCallback(() => {
    ttsActiveSpeechJobCountRef.current = Math.max(0, ttsActiveSpeechJobCountRef.current - 1);
    pumpTtsSpeechJobStarts();
  }, [pumpTtsSpeechJobStarts]);

  const stopTtsPlayback = useCallback((options: { messageId?: string; suppressStreamingAutoplay?: boolean } = {}) => {
    if (options.suppressStreamingAutoplay) {
      const streamingState = streamingAutoplayRef.current;
      const sessionId = streamingState?.sessionId ?? selected?.id ?? null;
      const messageId = streamingState?.messageId ?? options.messageId ?? null;
      if (sessionId && messageId) {
        suppressedStreamingAutoplayRef.current = { sessionId, messageId };
        lastAutoplayMessageIdRef.current = messageId;
      }
    }
    writeTtsDebugEvent("playback-stopped", {
      expectedChunkCount: ttsExpectedChunkCountRef.current,
      nextChunkIndex: ttsNextChunkIndexRef.current,
      queuedChunkCount: ttsQueuedChunkCountRef.current
    });
    ttsPlaybackRunIdRef.current += 1;
    ttsAudioStartingRef.current = false;
    try {
      ttsAudioSourceRef.current?.stop();
    } catch {
      // Source may already be stopped.
    }
    ttsAudioSourceRef.current?.disconnect();
    ttsAudioSourceRef.current = null;
    ttsAudioChunksRef.current.clear();
    ttsExpectedChunkCountRef.current = null;
    ttsNextChunkIndexRef.current = 0;
    ttsQueuedChunkCountRef.current = 0;
    ttsSpeechJobSequenceRef.current = 0;
    ttsNextStartSpeechJobIndexRef.current = 0;
    ttsActiveSpeechJobCountRef.current = 0;
    for (const waiter of ttsStartWaitersRef.current.values()) waiter.resolve(false);
    ttsStartWaitersRef.current.clear();
    ttsNextFlushSpeechJobIndexRef.current = 0;
    ttsFinalSpeechJobCountRef.current = null;
    ttsSpeechJobsRef.current.clear();
    ttsPlaybackDebugStartedAtMsRef.current = null;
    streamingAutoplayRef.current = null;
    lastStreamingAutoplayObservedKeyRef.current = null;
    const audioContext = ttsAudioContextRef.current;
    ttsAudioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") void audioContext.close();
    setSpeakingMessageId(null);
    setTtsHighlight(null);
    ttsDebugContextRef.current = null;
  }, [selected?.id, writeTtsDebugEvent]);

  const activeTtsMessageId = useCallback((fallbackMessageId: string, playbackRunId: number): string => {
    const streamingState = streamingAutoplayRef.current;
    return streamingState?.playbackRunId === playbackRunId ? streamingState.messageId : fallbackMessageId;
  }, []);

  const playNextTtsChunk = useCallback((messageId: string, playbackRunId: number) => {
    if (ttsPlaybackRunIdRef.current !== playbackRunId || ttsAudioSourceRef.current || ttsAudioStartingRef.current) return;
    const activeMessageId = activeTtsMessageId(messageId, playbackRunId);
    const debugStartedAtMs = ttsPlaybackDebugStartedAtMsRef.current;
    const nextIndex = ttsNextChunkIndexRef.current;
    const expectedCount = ttsExpectedChunkCountRef.current;
    if (expectedCount !== null && nextIndex >= expectedCount) {
      writeTtsDebugEvent("playback-complete", {
        expectedChunkCount: expectedCount,
        messageId: activeMessageId,
        nextChunkIndex: nextIndex
      });
      setSpeakingMessageId(null);
      setTtsHighlight(null);
      return;
    }
    const next = ttsAudioChunksRef.current.get(nextIndex);
    if (!next) {
      ttsConsoleInfo(`[archicode:tts] ${ttsElapsed(debugStartedAtMs)} playback waiting message=${activeMessageId} index=${nextIndex}/${expectedCount ?? "?"}`);
      writeTtsDebugEvent("playback-waiting", {
        expectedChunkCount: expectedCount,
        messageId: activeMessageId,
        nextChunkIndex: nextIndex,
        queuedChunkCount: ttsQueuedChunkCountRef.current
      });
      return;
    }
    ttsAudioChunksRef.current.delete(nextIndex);
    ttsNextChunkIndexRef.current = nextIndex + 1;
    ttsAudioStartingRef.current = true;
    void (async () => {
      try {
        const audioContext = await ensureTtsAudioContext();
        if (ttsPlaybackRunIdRef.current !== playbackRunId) return;
        const source = audioContext.createBufferSource();
        source.buffer = next.buffer;
        source.connect(audioContext.destination);
        ttsAudioSourceRef.current = source;
        const currentMessageId = activeTtsMessageId(messageId, playbackRunId);
        setSpeakingMessageId(currentMessageId);
        setTtsHighlight(next.text ? { messageId: currentMessageId, text: next.text } : null);
        setTtsBusyMessageId((current) => current === currentMessageId ? null : current);
        source.onended = () => {
          if (ttsAudioSourceRef.current !== source) return;
          const endedMessageId = activeTtsMessageId(messageId, playbackRunId);
          ttsConsoleInfo(
            `[archicode:tts] ${ttsElapsed(debugStartedAtMs)} playback ended message=${endedMessageId} index=${next.index}/${next.total} ` +
            `audio=${(next.durationMs / 1000).toFixed(1)}s ctx=${audioContext.state} time=${audioContext.currentTime.toFixed(3)}s`
          );
          writeTtsDebugEvent("playback-ended", {
            audioMs: next.durationMs,
            audioTimeSeconds: audioContext.currentTime,
            chunkIndex: next.index,
            chunkTotal: next.total,
            messageId: endedMessageId
          });
          source.disconnect();
          ttsAudioSourceRef.current = null;
          playNextTtsChunk(endedMessageId, playbackRunId);
        };
        source.start();
        const outputLatency = (audioContext as AudioContext & { outputLatency?: number }).outputLatency;
        ttsConsoleInfo(
          `[archicode:tts] ${ttsElapsed(debugStartedAtMs)} source.start called message=${currentMessageId} index=${next.index}/${next.total} ` +
          `audio=${(next.durationMs / 1000).toFixed(1)}s ctx=${audioContext.state} time=${audioContext.currentTime.toFixed(3)}s ` +
          `baseLatency=${audioContext.baseLatency?.toFixed(3) ?? "n/a"}s outputLatency=${outputLatency?.toFixed(3) ?? "n/a"}s`
        );
        writeTtsDebugEvent("source-start", {
          audioMs: next.durationMs,
          audioTimeSeconds: audioContext.currentTime,
          baseLatencySeconds: audioContext.baseLatency ?? null,
          chunkIndex: next.index,
          chunkTotal: next.total,
          contextState: audioContext.state,
          highlightText: previewTtsText(next.text),
          messageId: currentMessageId,
          outputLatencySeconds: outputLatency ?? null
        });
      } catch (error) {
        writeTtsDebugEvent("playback-error", {
          message: error instanceof Error ? error.message : String(error)
        });
        stopTtsPlayback();
        setTtsError(error instanceof Error ? error.message : "Could not play generated speech audio.");
      } finally {
        ttsAudioStartingRef.current = false;
      }
    })();
  }, [activeTtsMessageId, ensureTtsAudioContext, stopTtsPlayback, writeTtsDebugEvent]);

  const flushTtsSpeechJobs = useCallback((messageId: string, playbackRunId: number) => {
    if (ttsPlaybackRunIdRef.current !== playbackRunId) return;
    for (;;) {
      const jobIndex = ttsNextFlushSpeechJobIndexRef.current;
      const job = ttsSpeechJobsRef.current.get(jobIndex);
      if (!job || job.playbackRunId !== playbackRunId || job.total === null) break;
      if (job.total === 0) {
        ttsSpeechJobsRef.current.delete(jobIndex);
        ttsNextFlushSpeechJobIndexRef.current = jobIndex + 1;
        continue;
      }
      const chunk = job.chunks.get(job.nextLocalIndex);
      if (!chunk) break;
      job.chunks.delete(job.nextLocalIndex);
      const globalChunkIndex = ttsQueuedChunkCountRef.current;
      ttsQueuedChunkCountRef.current += 1;
      ttsAudioChunksRef.current.set(globalChunkIndex, {
        buffer: chunk.buffer,
        durationMs: chunk.durationMs,
        index: globalChunkIndex,
        text: chunk.text,
        total: ttsExpectedChunkCountRef.current ?? ttsQueuedChunkCountRef.current
      });
      writeTtsDebugEvent("chunk-ordered", {
        audioMs: chunk.durationMs,
        globalChunkIndex,
        messageId: job.messageId,
        sourceChunkIndex: job.nextLocalIndex,
        sourceChunkTotal: chunk.sourceTotal,
        speechJobIndex: jobIndex,
        text: previewTtsText(chunk.text),
        workerIndex: chunk.workerIndex ?? null
      });
      job.nextLocalIndex += 1;
      if (job.nextLocalIndex >= job.total) {
        ttsSpeechJobsRef.current.delete(jobIndex);
        ttsNextFlushSpeechJobIndexRef.current = jobIndex + 1;
      }
      playNextTtsChunk(job.messageId, playbackRunId);
    }

    const finalJobCount = ttsFinalSpeechJobCountRef.current;
    if (
      finalJobCount !== null &&
      ttsNextFlushSpeechJobIndexRef.current >= finalJobCount &&
      ttsSpeechJobsRef.current.size === 0 &&
      ttsExpectedChunkCountRef.current === null
    ) {
      ttsExpectedChunkCountRef.current = ttsQueuedChunkCountRef.current;
      writeTtsDebugEvent("queue-finalized", {
        expectedChunkCount: ttsExpectedChunkCountRef.current,
        messageId
      });
      playNextTtsChunk(messageId, playbackRunId);
      setTtsBusyMessageId((current) => current === messageId ? null : current);
    }
  }, [playNextTtsChunk, writeTtsDebugEvent]);

  const queueTtsSpeechText = useCallback((input: {
    debugStartedAtMs: number;
    finalize?: boolean;
    highlightText?: string;
    messageId: string;
    playbackRunId: number;
    text: string;
  }) => {
    const speechText = input.text.trim();
    if (!speechText) return Promise.resolve();
    const speechJobIndex = ttsSpeechJobSequenceRef.current;
    ttsSpeechJobSequenceRef.current += 1;
    ttsSpeechJobsRef.current.set(speechJobIndex, {
      chunks: new Map(),
      messageId: input.messageId,
      nextLocalIndex: 0,
      playbackRunId: input.playbackRunId,
      total: null
    });
    if (input.finalize) ttsFinalSpeechJobCountRef.current = ttsSpeechJobSequenceRef.current;
    writeTtsDebugEvent("speech-queued", {
      chars: speechText.length,
      finalize: Boolean(input.finalize),
      highlightText: previewTtsText(input.highlightText),
      messageId: input.messageId,
      speechJobIndex,
      text: previewTtsText(speechText)
    });

    let acquiredSpeechJobSlot = false;
    const queued = (async () => {
      if (ttsPlaybackRunIdRef.current !== input.playbackRunId) return;
      writeTtsDebugEvent("stream-start-waiting", {
        activeSpeechJobs: ttsActiveSpeechJobCountRef.current,
        messageId: input.messageId,
        speechJobIndex
      });
      const started = await waitForTtsSpeechJobStart(speechJobIndex, input.playbackRunId);
      if (!started || ttsPlaybackRunIdRef.current !== input.playbackRunId) return;
      acquiredSpeechJobSlot = true;
      writeTtsDebugEvent("stream-started", {
        activeSpeechJobs: ttsActiveSpeechJobCountRef.current,
        messageId: input.messageId,
        speechJobIndex
      });
      ttsConsoleInfo(`[archicode:tts] ${ttsElapsed(input.debugStartedAtMs)} stream requested message=${input.messageId} chars=${speechText.length}`);
      writeTtsDebugEvent("stream-requested", {
        chars: speechText.length,
        finalize: Boolean(input.finalize),
        messageId: input.messageId,
        speechJobIndex,
        text: previewTtsText(speechText)
      });
      await window.archicode.streamSpeech({
        debugStartedAtMs: input.debugStartedAtMs,
        text: speechText,
        modelId: selectedTtsModelId,
        singleSegment: true,
        voiceId: ttsSettings?.voiceId,
        speed: ttsSettings?.speed
      }, (chunk) => {
        if (ttsPlaybackRunIdRef.current !== input.playbackRunId) return;
        const chunkReceivedAtMs = Date.now();
        const chunkHighlightText = chunk.total > 1 ? displayTtsHighlightText(chunk.text) : input.highlightText ?? displayTtsHighlightText(chunk.text);
        const jobForChunk = ttsSpeechJobsRef.current.get(speechJobIndex);
        if (jobForChunk && jobForChunk.total === null) jobForChunk.total = chunk.total;
        ttsConsoleInfo(
          `[archicode:tts] ${ttsElapsed(input.debugStartedAtMs)} chunk ipc message=${input.messageId} job=${speechJobIndex} ` +
          `source=${chunk.index}/${chunk.total} worker=${typeof chunk.workerIndex === "number" ? chunk.workerIndex + 1 : "?"} ` +
          `bytes=${chunk.audio.byteLength} audio=${(chunk.durationMs / 1000).toFixed(1)}s synth=${chunk.synthMs ?? 0}ms`
        );
        writeTtsDebugEvent("chunk-ipc", {
          audioMs: chunk.durationMs,
          bytes: chunk.audio.byteLength,
          expectedChunkCount: ttsExpectedChunkCountRef.current,
          messageId: input.messageId,
          sourceChunkIndex: chunk.index,
          sourceChunkTotal: chunk.total,
          speechJobIndex,
          synthMs: chunk.synthMs ?? null,
          text: previewTtsText(chunkHighlightText),
          workerIndex: chunk.workerIndex ?? null
        });
        void (async () => {
          try {
            const audioContext = await ensureTtsAudioContext();
            const decoded = await audioContext.decodeAudioData(chunk.audio.slice(0));
            if (ttsPlaybackRunIdRef.current !== input.playbackRunId) return;
            const decodeMs = Date.now() - chunkReceivedAtMs;
            ttsConsoleInfo(
              `[archicode:tts] ${ttsElapsed(input.debugStartedAtMs)} chunk decoded message=${input.messageId} job=${speechJobIndex} source=${chunk.index}/${chunk.total} ` +
              `audio=${(chunk.durationMs / 1000).toFixed(1)}s synth=${chunk.synthMs ?? 0}ms ` +
              `decode=${decodeMs}ms decoded=${decoded.duration.toFixed(1)}s`
            );
            writeTtsDebugEvent("chunk-decoded", {
              audioMs: chunk.durationMs,
              decodedDurationSeconds: decoded.duration,
              decodeMs,
              expectedChunkCount: ttsExpectedChunkCountRef.current,
              messageId: input.messageId,
              sourceChunkIndex: chunk.index,
              sourceChunkTotal: chunk.total,
              speechJobIndex,
              synthMs: chunk.synthMs ?? null,
              text: previewTtsText(chunkHighlightText),
              workerIndex: chunk.workerIndex ?? null
            });
            const job = ttsSpeechJobsRef.current.get(speechJobIndex);
            if (!job) return;
            job.total = chunk.total;
            job.chunks.set(chunk.index, {
              buffer: decoded,
              durationMs: chunk.durationMs,
              sourceTotal: chunk.total,
              text: chunkHighlightText,
              workerIndex: chunk.workerIndex
            });
            flushTtsSpeechJobs(input.messageId, input.playbackRunId);
          } catch (error) {
            if (ttsPlaybackRunIdRef.current !== input.playbackRunId) return;
            writeTtsDebugEvent("decode-error", {
              message: error instanceof Error ? error.message : String(error),
              messageId: input.messageId,
              sourceChunkIndex: chunk.index,
              sourceChunkTotal: chunk.total,
              speechJobIndex
            });
            stopTtsPlayback();
            setTtsError(error instanceof Error ? error.message : "Could not decode generated speech audio.");
          }
        })();
      });
      if (ttsPlaybackRunIdRef.current === input.playbackRunId) {
        const job = ttsSpeechJobsRef.current.get(speechJobIndex);
        if (job && job.total === null) {
          writeTtsDebugEvent("stream-zero-chunk-fallback-started", {
            chars: speechText.length,
            messageId: input.messageId,
            speechJobIndex,
            text: previewTtsText(speechText)
          });
          try {
            const fallbackStartedAtMs = Date.now();
            const fallback = await window.archicode.synthesizeSpeech({
              text: speechText,
              modelId: selectedTtsModelId,
              voiceId: ttsSettings?.voiceId,
              speed: ttsSettings?.speed
            });
            if (ttsPlaybackRunIdRef.current !== input.playbackRunId) return;
            const fallbackJob = ttsSpeechJobsRef.current.get(speechJobIndex);
            if (fallbackJob && fallbackJob.total === null) {
              const decodeStartedAtMs = Date.now();
              const audioContext = await ensureTtsAudioContext();
              const decoded = await audioContext.decodeAudioData(fallback.audio.slice(0));
              if (ttsPlaybackRunIdRef.current !== input.playbackRunId) return;
              fallbackJob.total = 1;
              fallbackJob.chunks.set(0, {
                buffer: decoded,
                durationMs: fallback.durationMs,
                sourceTotal: 1,
                text: input.highlightText ?? displayTtsHighlightText(speechText),
                workerIndex: fallback.diagnostics?.workerIndex
              });
              writeTtsDebugEvent("stream-zero-chunk-fallback-decoded", {
                audioMs: fallback.durationMs,
                decodedDurationSeconds: decoded.duration,
                decodeMs: Date.now() - decodeStartedAtMs,
                generationMs: fallback.generationMs,
                messageId: input.messageId,
                speechJobIndex,
                synthMs: Date.now() - fallbackStartedAtMs,
                workerIndex: fallback.diagnostics?.workerIndex ?? null
              });
            }
          } catch (error) {
            writeTtsDebugEvent("stream-zero-chunk-fallback-error", {
              message: error instanceof Error ? error.message : String(error),
              messageId: input.messageId,
              speechJobIndex
            });
            throw error;
          }
        }
        writeTtsDebugEvent("stream-completed", {
          messageId: input.messageId,
          speechJobIndex
        });
        flushTtsSpeechJobs(input.messageId, input.playbackRunId);
      }
    })().finally(() => {
      if (acquiredSpeechJobSlot) releaseTtsSpeechJobStart();
    });

    void queued.catch((error) => {
      if (ttsPlaybackRunIdRef.current !== input.playbackRunId) return;
      writeTtsDebugEvent("stream-error", {
        message: error instanceof Error ? error.message : String(error),
        messageId: input.messageId,
        speechJobIndex
      });
      stopTtsPlayback();
      setTtsError(error instanceof Error ? error.message : "Could not generate speech audio.");
    });
    return queued;
  }, [
    ensureTtsAudioContext,
    flushTtsSpeechJobs,
    releaseTtsSpeechJobStart,
    selectedTtsModelId,
    stopTtsPlayback,
    ttsSettings?.speed,
    ttsSettings?.voiceId,
    waitForTtsSpeechJobStart,
    writeTtsDebugEvent
  ]);

  const queueTtsSpeechUnits = useCallback((input: {
    debugStartedAtMs: number;
    finalize?: boolean;
    highlightText?: string;
    messageId: string;
    playbackRunId: number;
    text: string;
  }) => {
    const units = splitTtsPrepareUnits(input.text, input.highlightText);
    if (!units.length) return Promise.resolve([]);
    writeTtsDebugEvent("prepare-units-created", {
      count: units.length,
      finalize: Boolean(input.finalize),
      messageId: input.messageId,
      text: previewTtsText(input.text),
      unitChars: units.map((unit) => unit.text.length)
    });
    return Promise.all(units.map((unit, index) => queueTtsSpeechText({
      ...input,
      finalize: Boolean(input.finalize) && index === units.length - 1,
      highlightText: unit.highlightText,
      text: unit.text
    })));
  }, [queueTtsSpeechText, writeTtsDebugEvent]);

  const finalizeTtsSpeechQueue = useCallback((messageId: string, playbackRunId: number) => {
    if (ttsPlaybackRunIdRef.current !== playbackRunId) return Promise.resolve();
    ttsFinalSpeechJobCountRef.current = ttsSpeechJobSequenceRef.current;
    flushTtsSpeechJobs(messageId, playbackRunId);
    return Promise.resolve();
  }, [flushTtsSpeechJobs]);

  const playMessageSpeech = useCallback(async (messageId: string, content: string) => {
    if (!ttsSettings?.enabled) {
      setTtsError("Voice output is disabled for this project.");
      return;
    }
    if (speakingMessageId === messageId || ttsBusyMessageId === messageId) {
      stopTtsPlayback({ messageId, suppressStreamingAutoplay: true });
      return;
    }
    const debugStartedAtMs = Date.now();
    stopTtsPlayback();
    ttsPlaybackDebugStartedAtMsRef.current = debugStartedAtMs;
    const playbackRunId = ttsPlaybackRunIdRef.current;
    startTtsDebugLog(messageId, playbackRunId, "manual", debugStartedAtMs);
    ttsConsoleInfo(`[archicode:tts] ${ttsElapsed(debugStartedAtMs)} play requested message=${messageId}`);
    writeTtsDebugEvent("play-requested", {
      chars: visibleResearchContent(content).length,
      messageId
    });
    const status = await refreshTtsStatus();
    ttsConsoleInfo(`[archicode:tts] ${ttsElapsed(debugStartedAtMs)} status checked message=${messageId}`);
    writeTtsDebugEvent("status-checked", {
      runtimeAvailable: status?.runtimeAvailable ?? false,
      statusModelCount: status?.models.length ?? 0
    });
    const model = status?.models.find((item) => item.id === selectedTtsModelId);
    if (!status?.runtimeAvailable) {
      writeTtsDebugEvent("not-ready", {
        reason: "runtime-unavailable",
        runtimeError: status?.runtimeError ?? null
      });
      setTtsError(status?.runtimeError ?? "Text-to-speech runtime is unavailable.");
      return;
    }
    if (!model?.downloaded) {
      writeTtsDebugEvent("not-ready", {
        modelId: selectedTtsModelId,
        reason: "model-not-downloaded"
      });
      setTtsError("Download the active text-to-speech model in Advanced settings before playback.");
      return;
    }

    setTtsBusyMessageId(messageId);
    setTtsError(null);
    try {
      const speechText = readableResearchContent(content);
      if (!speechText) throw new Error("There is no readable text to play.");
      ttsAudioChunksRef.current.clear();
      ttsExpectedChunkCountRef.current = null;
      ttsNextChunkIndexRef.current = 0;
      ttsQueuedChunkCountRef.current = 0;
      ttsSpeechJobSequenceRef.current = 0;
      ttsNextStartSpeechJobIndexRef.current = 0;
      ttsActiveSpeechJobCountRef.current = 0;
      for (const waiter of ttsStartWaitersRef.current.values()) waiter.resolve(false);
      ttsStartWaitersRef.current.clear();
      ttsNextFlushSpeechJobIndexRef.current = 0;
      ttsFinalSpeechJobCountRef.current = null;
      ttsSpeechJobsRef.current.clear();
      await ensureTtsAudioContext();
      ttsConsoleInfo(`[archicode:tts] ${ttsElapsed(debugStartedAtMs)} audio context ready message=${messageId}`);
      writeTtsDebugEvent("audio-context-ready", { messageId });
      await queueTtsSpeechUnits({ debugStartedAtMs, finalize: true, messageId, playbackRunId, text: speechText });
    } catch (error) {
      writeTtsDebugEvent("manual-play-error", {
        message: error instanceof Error ? error.message : String(error),
        messageId
      });
      stopTtsPlayback();
      setTtsError(error instanceof Error ? error.message : "Could not generate speech audio.");
    } finally {
      setTtsBusyMessageId((current) => current === messageId ? null : current);
    }
  }, [
    ensureTtsAudioContext,
    queueTtsSpeechUnits,
    refreshTtsStatus,
    selectedTtsModelId,
    speakingMessageId,
    startTtsDebugLog,
    stopTtsPlayback,
    ttsBusyMessageId,
    ttsSettings?.enabled,
    ttsSettings?.speed,
    ttsSettings?.voiceId,
    writeTtsDebugEvent
  ]);

  const enqueueStreamingAutoplayText = useCallback((state: StreamingTtsState, content: string, final: boolean) => {
    if (state.finalized) return;
    const visibleText = readableResearchContent(content, true);
    if (!visibleText || isResearchThinkingPhrase(visibleText)) return;
    if (visibleText.length < state.consumedContentChars) {
      if (final) {
        state.finalized = true;
        const tailHighlight = state.pendingContent;
        const tail = readableResearchContent(state.pendingContent, true);
        state.pendingContent = "";
        if (tail) {
          void queueTtsSpeechUnits({
            debugStartedAtMs: state.debugStartedAtMs,
            finalize: true,
            highlightText: tailHighlight,
            messageId: state.messageId,
            playbackRunId: state.playbackRunId,
            text: tail
          });
        } else {
          void finalizeTtsSpeechQueue(state.messageId, state.playbackRunId);
        }
        return;
      }
      state.consumedContentChars = 0;
      state.pendingContent = "";
    }
    if (visibleText.length > state.consumedContentChars) {
      const addedText = visibleText.slice(state.consumedContentChars);
      state.pendingContent += addedText;
      state.consumedContentChars = visibleText.length;
      writeTtsDebugEvent("stream-text-consumed", {
        addedChars: addedText.length,
        final,
        messageId: state.messageId,
        pendingChars: state.pendingContent.length,
        preview: previewTtsText(addedText)
      });
    }

    for (;;) {
      const decision = inspectStreamingSpeechPrefix(state.pendingContent, final);
      if (!decision.result) {
        writeTtsDebugEvent("stream-prefix-waiting", {
          clauseCut: decision.clauseCut,
          final,
          messageId: state.messageId,
          newlineCut: decision.newlineCut,
          pendingChars: decision.pendingChars,
          pendingPreview: previewTtsText(state.pendingContent),
          reason: decision.reason,
          sentenceCutEnd: decision.sentenceCutEnd
        });
        break;
      }
      state.pendingContent = decision.result.remainder;
      const spoken = readableResearchContent(decision.result.spoken, true);
      if (spoken) {
        writeTtsDebugEvent("stream-prefix-extracted", {
          final,
          highlightText: previewTtsText(decision.result.spoken),
          messageId: state.messageId,
          pendingChars: state.pendingContent.length,
          reason: decision.reason,
          spokenChars: spoken.length,
          spokenText: previewTtsText(spoken)
        });
        void queueTtsSpeechUnits({
          debugStartedAtMs: state.debugStartedAtMs,
          highlightText: decision.result.spoken,
          messageId: state.messageId,
          playbackRunId: state.playbackRunId,
          text: spoken
        });
      }
      if (!final) break;
    }

    if (!final) return;
    state.finalized = true;
    const tailHighlight = state.pendingContent;
    const tail = readableResearchContent(state.pendingContent, true);
    state.pendingContent = "";
    if (tail) {
      writeTtsDebugEvent("stream-tail-flushed", {
        highlightText: previewTtsText(tailHighlight),
        messageId: state.messageId,
        spokenChars: tail.length,
        spokenText: previewTtsText(tail)
      });
      void queueTtsSpeechUnits({
        debugStartedAtMs: state.debugStartedAtMs,
        finalize: true,
        highlightText: tailHighlight,
        messageId: state.messageId,
        playbackRunId: state.playbackRunId,
        text: tail
      });
    } else {
      writeTtsDebugEvent("stream-tail-empty", { messageId: state.messageId });
      void finalizeTtsSpeechQueue(state.messageId, state.playbackRunId);
    }
  }, [finalizeTtsSpeechQueue, queueTtsSpeechUnits, writeTtsDebugEvent]);

  const navigateGraphLink = useCallback((target: ArchicodeGraphLink) => {
    if (!bundle) return;
    if (target.kind === "project") return navigateToGraphTarget({ kind: "project" });
    const targetFlow = bundle.flows.find((item) => item.id === target.flowId);
    if (!targetFlow) return;
    if (target.kind === "flow") {
      navigateToGraphTarget(target);
      return;
    }
    if (target.kind === "subflow") {
      if (!targetFlow.subflows.some((item) => item.id === target.subflowId)) return;
      navigateToGraphTarget(target);
      return;
    }
    if (!targetFlow.nodes.some((item) => item.id === target.nodeId)) return;
    navigateToGraphTarget(target);
  }, [bundle, navigateToGraphTarget]);

  useEffect(() => {
    void refreshResearchChats();
  }, [refreshResearchChats]);

  useEffect(() => {
    void refreshSpeechStatus();
  }, [refreshSpeechStatus]);

  useEffect(() => {
    if (!ttsSettings?.enabled) {
      stopTtsPlayback();
      return;
    }
    void refreshTtsStatus().then((status) => {
      const model = status?.models.find((item) => item.id === selectedTtsModelId);
      if (!model?.downloaded) return;
      void window.archicode.warmTtsModel(selectedTtsModelId, ttsSettings.voiceId).catch(() => undefined);
    });
  }, [refreshTtsStatus, selectedTtsModelId, stopTtsPlayback, ttsSettings?.enabled, ttsSettings?.voiceId]);

  useEffect(() => {
    stopTtsPlayback();
    suppressedStreamingAutoplayRef.current = null;
    const lastAssistantMessage = [...(selected?.messages ?? [])].reverse().find((message) =>
      message.role === "assistant" && !message.error && !message.id.startsWith("research-waiting")
    );
    lastAutoplayMessageIdRef.current = lastAssistantMessage?.id ?? null;
  }, [selected?.id, stopTtsPlayback]);

  useEffect(() => {
    if (!ttsSettings?.enabled || !ttsSettings.autoplay || !selected) return;
    const currentState = streamingAutoplayRef.current;

    if (researchBusy && streamingAssistantMessage) {
      const suppressed = suppressedStreamingAutoplayRef.current;
      if (suppressed?.sessionId === selected.id && suppressed.messageId === streamingAssistantMessage.id) {
        lastAutoplayMessageIdRef.current = streamingAssistantMessage.id;
        return;
      }
      if (suppressed?.sessionId === selected.id && suppressed.messageId !== streamingAssistantMessage.id) {
        suppressedStreamingAutoplayRef.current = null;
      }
      let state = currentState;
      if (!state || state.sessionId !== selected.id || state.messageId !== streamingAssistantMessage.id || state.finalized) {
        stopTtsPlayback();
        const debugStartedAtMs = Date.now();
        ttsPlaybackDebugStartedAtMsRef.current = debugStartedAtMs;
        ttsAudioChunksRef.current.clear();
        ttsExpectedChunkCountRef.current = null;
        ttsNextChunkIndexRef.current = 0;
        ttsQueuedChunkCountRef.current = 0;
        ttsSpeechJobSequenceRef.current = 0;
        ttsNextStartSpeechJobIndexRef.current = 0;
        ttsActiveSpeechJobCountRef.current = 0;
        for (const waiter of ttsStartWaitersRef.current.values()) waiter.resolve(false);
        ttsStartWaitersRef.current.clear();
        ttsNextFlushSpeechJobIndexRef.current = 0;
        ttsFinalSpeechJobCountRef.current = null;
        ttsSpeechJobsRef.current.clear();
        state = {
          consumedContentChars: 0,
          debugStartedAtMs,
          finalized: false,
          messageId: streamingAssistantMessage.id,
          pendingContent: "",
          playbackRunId: ttsPlaybackRunIdRef.current,
          sessionId: selected.id
        };
        streamingAutoplayRef.current = state;
        startTtsDebugLog(streamingAssistantMessage.id, state.playbackRunId, "streaming-autoplay", debugStartedAtMs);
        lastAutoplayMessageIdRef.current = streamingAssistantMessage.id;
        setTtsBusyMessageId(streamingAssistantMessage.id);
        setTtsError(null);
        ttsConsoleInfo(`[archicode:tts] ${ttsElapsed(debugStartedAtMs)} streaming autoplay started message=${streamingAssistantMessage.id}`);
        writeTtsDebugEvent("streaming-autoplay-started", {
          chars: visibleResearchContent(streamingAssistantMessage.content).length,
          messageId: streamingAssistantMessage.id
        });
        void ensureTtsAudioContext()
          .then(() => {
            ttsConsoleInfo(`[archicode:tts] ${ttsElapsed(debugStartedAtMs)} audio context ready message=${streamingAssistantMessage.id}`);
            writeTtsDebugEvent("audio-context-ready", { messageId: streamingAssistantMessage.id });
          })
          .catch((error: unknown) => {
            writeTtsDebugEvent("audio-context-error", {
              message: error instanceof Error ? error.message : String(error),
              messageId: streamingAssistantMessage.id
            });
            setTtsError(error instanceof Error ? error.message : "Could not prepare text-to-speech playback.");
          });
      }

      const visibleText = readableResearchContent(streamingAssistantMessage.content, true);
      const observedKey = `${streamingAssistantMessage.id}:${visibleText.length}:${visibleText.slice(-80)}`;
      if (lastStreamingAutoplayObservedKeyRef.current !== observedKey) {
        lastStreamingAutoplayObservedKeyRef.current = observedKey;
        writeTtsDebugEvent("stream-message-observed", {
          chars: visibleText.length,
          isPlaceholder: isResearchThinkingPhrase(visibleText),
          messageId: streamingAssistantMessage.id,
          preview: previewTtsText(visibleText)
        });
      }

      const status = ttsStatus;
      const model = status?.models.find((item) => item.id === selectedTtsModelId);
      if (!status) {
        writeTtsDebugEvent("stream-status-waiting", {
          messageId: streamingAssistantMessage.id,
          visibleChars: visibleText.length
        });
        void refreshTtsStatus();
        return;
      }
      if (!status.runtimeAvailable || !model?.downloaded) {
        writeTtsDebugEvent("stream-status-blocked", {
          downloaded: Boolean(model?.downloaded),
          messageId: streamingAssistantMessage.id,
          runtimeAvailable: status.runtimeAvailable,
          visibleChars: visibleText.length
        });
        return;
      }

      enqueueStreamingAutoplayText(state, streamingAssistantMessage.content, false);
      return;
    }

    if (currentState && !currentState.finalized) {
      const finalAssistantMessage = [...selected.messages].reverse().find((message) =>
        message.role === "assistant" && !message.error && !message.id.startsWith("research-waiting")
      );
      if (!finalAssistantMessage) return;
      lastAutoplayMessageIdRef.current = finalAssistantMessage.id;
      const previousMessageId = currentState.messageId;
      currentState.messageId = finalAssistantMessage.id;
      writeTtsDebugEvent("message-id-migrated", {
        from: previousMessageId,
        to: finalAssistantMessage.id
      });
      if (ttsDebugContextRef.current?.playbackRunId === currentState.playbackRunId) {
        ttsDebugContextRef.current.messageId = finalAssistantMessage.id;
      }
      setSpeakingMessageId((current) => current === previousMessageId ? finalAssistantMessage.id : current);
      setTtsBusyMessageId((current) => current === previousMessageId ? finalAssistantMessage.id : current);
      setTtsHighlight((current) => current?.messageId === previousMessageId ? { ...current, messageId: finalAssistantMessage.id } : current);
      enqueueStreamingAutoplayText(currentState, finalAssistantMessage.content, true);
    }
  }, [
    enqueueStreamingAutoplayText,
    ensureTtsAudioContext,
    refreshTtsStatus,
    researchBusy,
    selected,
    selected?.updatedAt,
    selectedTtsModelId,
    startTtsDebugLog,
    stopTtsPlayback,
    streamingAssistantContentKey,
    streamingAssistantMessage,
    ttsSettings?.autoplay,
    ttsSettings?.enabled,
    ttsStatus,
    writeTtsDebugEvent
  ]);

  useEffect(() => {
    if (!ttsSettings?.enabled || !ttsSettings.autoplay || researchBusy || !selected) return;
    const lastAssistantMessage = [...selected.messages].reverse().find((message) =>
      message.role === "assistant" && !message.error && !message.id.startsWith("research-waiting")
    );
    if (!lastAssistantMessage || lastAutoplayMessageIdRef.current === lastAssistantMessage.id) return;
    if (suppressedStreamingAutoplayRef.current?.sessionId === selected.id) {
      suppressedStreamingAutoplayRef.current = null;
      lastAutoplayMessageIdRef.current = lastAssistantMessage.id;
      return;
    }
    lastAutoplayMessageIdRef.current = lastAssistantMessage.id;
    void playMessageSpeech(lastAssistantMessage.id, lastAssistantMessage.content);
  }, [playMessageSpeech, researchBusy, selected, selected?.updatedAt, ttsSettings?.autoplay, ttsSettings?.enabled]);

  useEffect(() => {
    if (!window.archicode?.onSpeechModelDownloadProgress) return undefined;
    return window.archicode.onSpeechModelDownloadProgress((progress) => {
      if (progress.modelId !== selectedSpeechModelId) return;
      const total = progress.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : "";
      setSpeechProgressLabel(`Downloading ${formatBytes(progress.receivedBytes)}${total}`);
    });
  }, [selectedSpeechModelId]);

  useEffect(() => () => {
    stopTtsPlayback();
  }, [stopTtsPlayback]);

  useEffect(() => () => {
    void stopSpeechCapture();
  }, [stopSpeechCapture]);

  useEffect(() => {
    if (!scope) return;
    setResearchScope(scope);
  }, [scope?.type, scope ? scopeKey(scope) : "", setResearchScope]);

  const scopeOptions = useMemo(() => {
    if (!bundle) return [];
    const options = [{ value: `project:${bundle.project.id}`, label: `Project: ${bundle.project.name}` }];
    for (const item of bundle.flows) {
      options.push({ value: `flow:${item.id}`, label: `Flow: ${item.name}` });
      for (const subflow of item.subflows) {
        options.push({ value: `subflow:${item.id}:${subflow.id}`, label: `Subflow: ${subflow.name}` });
      }
      for (const node of item.nodes) {
        options.push({ value: `node:${item.id}:${node.id}`, label: `Node: ${node.title}` });
      }
    }
    return options;
  }, [bundle]);

  const sortedResearchSessions = useMemo(
    () => [...researchSessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [researchSessions]
  );
  const currentScopeChats = scope ? sortedResearchSessions.filter((session) => sameScope(session.scope, scope)) : [];
  const visibleHistoryChats = historyFilter === "scope" ? currentScopeChats : sortedResearchSessions;
  const historyCount = visibleHistoryChats.length;
  const archiveConfirmationSession = archiveConfirmationSessionId
    ? researchSessions.find((session) => session.id === archiveConfirmationSessionId) ?? null
    : null;
  const lastResearchMessage = selected?.messages[selected.messages.length - 1];
  // Only real transcript growth should advertise "New activity". Subagent
  // status, spinner, progress-line, and evidence-gallery mutations happen
  // inside an existing message card and must not masquerade as a new message.
  const researchTranscriptActivityKey = selected?.messages
    .map((message) => `${message.id}:${message.content.length}:${message.error?.length ?? 0}`)
    .join("|") ?? "";
  // Approval cards are actionable transcript milestones, even when a
  // subagent card mutates inside an existing assistant message. They must be
  // revealed immediately rather than hidden behind the generic More button.
  const researchApprovalActivityKey = useMemo(() => selected?.messages.flatMap((message, messageIndex) => [
    message.mcpApprovalRequest ? `mcp:${message.id}` : "",
    ...(message.subagentRuns ?? [])
      .filter((run) => run.status === "awaiting-approval")
      .map((run) => `subagent:${message.id}:${run.id}`),
    message.changeSet && !message.changeSet.reviewedAt && !transcriptAnalysis.reviewSummaryByChangeSetIndex.has(messageIndex)
      ? `change-set:${message.id}:${message.changeSet.id}`
      : ""
  ]).filter(Boolean).join("|") ?? "", [selected?.messages, transcriptAnalysis]);

  const scrollResearchToBottom = useCallback(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    researchManualScrollHoldRef.current = false;
    viewport.scrollTop = viewport.scrollHeight;
    researchScrollFollowRef.current = true;
    setResearchHasNewActivity(false);
  }, []);

  useEffect(() => {
    researchManualScrollHoldRef.current = false;
    researchScrollFollowRef.current = true;
    setResearchHasNewActivity(false);
    requestAnimationFrame(scrollResearchToBottom);
  }, [selected?.id, scrollResearchToBottom]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    const holdAutoFollow = () => {
      researchManualScrollHoldRef.current = true;
      researchScrollFollowRef.current = false;
    };
    const distanceFromBottom = () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const updateFollowState = () => {
      if (distanceFromBottom() <= 8) {
        researchManualScrollHoldRef.current = false;
        researchScrollFollowRef.current = true;
        setResearchHasNewActivity(false);
      }
    };
    const holdAutoFollowOnWheel = (event: WheelEvent) => {
      // Scrolling upward always pauses follow mode. A downward wheel gesture
      // only pauses it when the reader is already away from the live bottom.
      if (event.deltaY < 0 || distanceFromBottom() > 8) holdAutoFollow();
    };
    const holdAutoFollowOnKey = (event: KeyboardEvent) => {
      const upwardKey = event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || (event.key === " " && event.shiftKey);
      const downwardKey = event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End" || event.key === " ";
      if (upwardKey || (downwardKey && distanceFromBottom() > 8)) holdAutoFollow();
    };
    const scrollRoot = viewport.closest(".ui-scroll-area");
    const holdAutoFollowOnScrollbar = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".ui-scrollbar")) holdAutoFollow();
    };
    updateFollowState();
    viewport.addEventListener("scroll", updateFollowState, { passive: true });
    viewport.addEventListener("wheel", holdAutoFollowOnWheel, { passive: true });
    viewport.addEventListener("touchmove", holdAutoFollow, { passive: true });
    viewport.addEventListener("keydown", holdAutoFollowOnKey);
    scrollRoot?.addEventListener("pointerdown", holdAutoFollowOnScrollbar, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", updateFollowState);
      viewport.removeEventListener("wheel", holdAutoFollowOnWheel);
      viewport.removeEventListener("touchmove", holdAutoFollow);
      viewport.removeEventListener("keydown", holdAutoFollowOnKey);
      scrollRoot?.removeEventListener("pointerdown", holdAutoFollowOnScrollbar);
    };
  }, [selected?.id]);

  useEffect(() => {
    if (!selected) return;
    requestAnimationFrame(() => {
      const viewport = messagesViewportRef.current;
      if (viewport && researchRevealSubmittedMessageRef.current) {
        // A message the user just submitted is never hidden behind the generic
        // "More" affordance, even when the transcript was previously scrolled
        // upward. Consume this override once; subsequent activity respects the
        // user's manual scroll position again.
        researchRevealSubmittedMessageRef.current = false;
        researchManualScrollHoldRef.current = false;
        researchScrollFollowRef.current = true;
        viewport.scrollTop = viewport.scrollHeight;
        setResearchHasNewActivity(false);
      } else if (viewport && researchScrollFollowRef.current && !researchManualScrollHoldRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
        setResearchHasNewActivity(false);
      } else {
        const hasUnseenTranscript = Boolean(viewport && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 8);
        setResearchHasNewActivity(hasUnseenTranscript);
      }
    });
  }, [researchTranscriptActivityKey, selected?.id]);

  useEffect(() => {
    if (!researchApprovalActivityKey) return;
    requestAnimationFrame(scrollResearchToBottom);
  }, [researchApprovalActivityKey, scrollResearchToBottom]);

  const submit = async () => {
    if (mcpApprovalPending) return;
    const researchDraft = useArchicodeStore.getState().researchDraft;
    if (!composerHasContent(researchDraft)) return;
    const serialized = serializeComposerDraft(researchDraft, bundle);
    const message = serialized.message.trim();
    if (!message && serialized.referencedNodeIds.length === 0) return;
    setComposingNewChat(false);
    researchManualScrollHoldRef.current = false;
    researchScrollFollowRef.current = true;
    clearResearchDraft();
    const attached = attachmentPaths;
    setAttachmentPaths([]);
    const rememberedMcpServerIds = selected ? [...(rememberedMcpByChat[selected.id] ?? new Set<string>())] : [];
    // An in-flight session queues the new message outside the transcript. A
    // normal send appends an optimistic user message immediately, so mark that
    // single transcript update for an unconditional reveal before dispatching.
    researchRevealSubmittedMessageRef.current = !researchBusy;
    // sendResearchMessage queues the message automatically when this session is
    // already streaming, instead of blocking the send; it fires once the
    // in-flight turn completes.
    await sendResearchMessage(
      message,
      attached,
      rememberedMcpServerIds,
      [],
      undefined,
      serialized.referencedNodeIds,
      chatModelRequest
    );
  };

  const respondToMcpApproval = async (message: ResearchChatSession["messages"][number], decision: "approved" | "rejected") => {
    if (!selected || !message.mcpApprovalRequest) return;
    const request = message.mcpApprovalRequest;
    const remember = Boolean(rememberMcpByMessage[message.id]);
    if (decision === "approved" && remember) {
      setRememberedMcpByChat((current) => {
        const next = new Set(current[selected.id] ?? []);
        for (const serverId of request.serverIds) next.add(serverId);
        return { ...current, [selected.id]: next };
      });
    }
    const remembered = decision === "approved" ? [...(rememberedMcpByChat[selected.id] ?? new Set<string>())] : [];
    const approvedIds = decision === "approved"
      ? [...new Set([...remembered, ...request.serverIds])]
      : remembered;
    await sendResearchMessage(
      request.originalContent,
      request.filePaths,
      approvedIds,
      decision === "rejected" ? request.serverIds : [],
      message.id,
      undefined,
      chatModelRequest
    );
  };

  const respondToSubagent = async (
    message: ResearchChatSession["messages"][number],
    run: NonNullable<ResearchChatSession["messages"][number]["subagentRuns"]>[number],
    decision: "approved" | "rejected",
    runtimeTargetProfileIds?: string[]
  ) => {
    if (!selected) return;
    setRespondingSubagentRunId(run.id);
    try {
      await respondToSubagentRun(
        selected.id,
        message.id,
        run.id,
        decision,
        decision === "approved" ? subagentStrategyDrafts[run.id]?.trim() || undefined : undefined,
        decision === "approved" ? runtimeTargetProfileIds : undefined
      );
    } finally {
      setRespondingSubagentRunId((current) => current === run.id ? null : current);
    }
  };

  const retryFailedMessage = useCallback(async (assistantMessageId: string) => {
    if (!selected || researchBusy) return;
    const rememberedMcpServerIds = [...(rememberedMcpByChat[selected.id] ?? new Set<string>())];
    setRetryingMessageId(assistantMessageId);
    try {
      await retryResearchMessage(assistantMessageId, rememberedMcpServerIds, chatModelRequest);
    } finally {
      setRetryingMessageId((current) => current === assistantMessageId ? null : current);
    }
  }, [chatModelRequest, rememberedMcpByChat, researchBusy, retryResearchMessage, selected]);

  const researchAutoApproveGraphChanges = bundle?.project.settings.researchAutoApproveGraphChanges;
  const setAutoApproveGraphChanges = (enabled: boolean) => {
    if (!researchAutoApproveGraphChanges) return;
    void updateResearchChatAutoApproval({
      ...researchAutoApproveGraphChanges,
      enabled
    });
  };

  const copyMessage = async (messageId: string, content: string) => {
    try {
      await writeClipboardText(displayResearchContent(content));
      setCopiedMessageId(messageId);
      window.setTimeout(() => setCopiedMessageId((current) => current === messageId ? null : current), 1400);
    } catch {
      setCopiedMessageId(null);
    }
  };

  const copySubagentProgress = async (runId: string, progressLines: string[]) => {
    if (!progressLines.length) return;
    try {
      await writeClipboardText(progressLines.join("\n"));
      setCopiedSubagentRunId(runId);
      window.setTimeout(() => setCopiedSubagentRunId((current) => current === runId ? null : current), 1400);
    } catch {
      setCopiedSubagentRunId(null);
    }
  };

  const copyApprovalCommand = async (messageId: string, command: string) => {
    try {
      await writeClipboardText(command);
      setCopiedCommandMessageId(messageId);
      window.setTimeout(() => setCopiedCommandMessageId((current) => current === messageId ? null : current), 1400);
    } catch {
      setCopiedCommandMessageId(null);
    }
  };

  const setTransientExportStatus = useCallback((message: string) => {
    setChatExportStatus(message);
    window.setTimeout(() => setChatExportStatus((current) => current === message ? null : current), 1800);
  }, []);

  const openProjectPathLink = useCallback((target: ArchicodeProjectPathLink) => {
    if (!rootPath || !window.archicode?.openProjectPath) return;
    void window.archicode.openProjectPath(rootPath, target.relativePath)
      .catch((error: unknown) => {
        setTransientExportStatus(error instanceof Error ? error.message : "Project path could not be opened.");
      });
  }, [rootPath, setTransientExportStatus]);

  const loadProjectImage = useCallback((target: ArchicodeProjectPathLink): Promise<string> => {
    if (!rootPath || !window.archicode?.readArtifactDataUrl) {
      return Promise.reject(new Error("Project image previews are unavailable."));
    }
    return window.archicode.readArtifactDataUrl(rootPath, target.relativePath);
  }, [rootPath]);

  const exportChat = (format: "markdown" | "json") => {
    if (!selected || !bundle) return;
    const currentBundle = bundle;
    const scopeName = scopeLabel(selected.scope, currentBundle);
    if (format === "markdown") {
      downloadTextFile(`${chatFileBaseName(selected)}.md`, formatResearchChatMarkdown(selected, currentBundle, scopeName), "text/markdown;charset=utf-8");
      setTransientExportStatus("Markdown downloaded.");
      return;
    }
    downloadTextFile(`${chatFileBaseName(selected)}.json`, formatResearchChatJson(selected, currentBundle, scopeName), "application/json;charset=utf-8");
    setTransientExportStatus("JSON downloaded.");
  };

  const copyChat = async (format: "markdown" | "json") => {
    if (!selected || !bundle) return;
    const currentBundle = bundle;
    const scopeName = scopeLabel(selected.scope, currentBundle);
    const text = format === "markdown"
      ? formatResearchChatMarkdown(selected, currentBundle, scopeName)
      : formatResearchChatJson(selected, currentBundle, scopeName);
    try {
      await writeClipboardText(text);
      setTransientExportStatus(format === "markdown" ? "Markdown copied." : "JSON copied.");
    } catch {
      setTransientExportStatus("Copy failed.");
    }
  };

  const summarizeChat = async () => {
    if (!selected || researchBusy) return;
    setComposingNewChat(false);
    setTransientExportStatus("Summary requested.");
    await summarizeResearchChat(selected.id);
  };

  const speechRuntimeMissing = speechStatus ? !speechStatus.runtimeAvailable : false;
  const speechModelMissing = speechStatus ? !selectedSpeechModel?.downloaded : false;
  const speechNotice = speechError ??
    speechProgressLabel ??
    (recordingSpeech ? "Recording voice input..." : null) ??
    (speechRuntimeMissing ? speechStatus?.runtimeError ?? "Speech runtime unavailable." : null);
  const speechButtonTitle = speechModelMissing
      ? missingSpeechModelMessage
      : "Record voice input";
  const speechButtonDisabled = mcpApprovalPending || speechBusy || (!recordingSpeech && speechRuntimeMissing);
  const recordingSendDisabled = speechBusy || mcpApprovalPending;
  const composerPrimaryDisabled = speechBusy || mcpApprovalPending;
  const composerPrimaryLabel = speechBusy ? "Transcribing" : researchBusy ? "Queue" : "Send";
  const researchContextPlan = useMemo(() => bundle ? deriveResearchChatContextPlan(chatProvider
    ? {
        ...bundle.project.settings,
        providers: bundle.project.settings.providers.map((item) => item.id === chatProvider.id
          ? { ...item, ...(chatModelRequest ? { model: chatModelRequest } : {}), enabled: true }
          : { ...item, enabled: false })
      }
    : bundle.project.settings) : null, [bundle, chatModelRequest, chatProvider]);
  const recentResearchMessages = useMemo(() => selected && researchContextPlan
    ? selected.messages.slice(-researchContextPlan.recentMessageLimit)
    : [], [researchContextPlan, selected]);
  const researchContextBaseCharacters = useMemo(() => JSON.stringify({
    draft: "",
    memory: selected?.memory ?? null,
    messages: recentResearchMessages.map((message) => ({
      content: message.content,
      role: message.role
    }))
  }).length, [recentResearchMessages, selected?.memory]);
  const researchContextEstimate = researchContextPlan
    ? {
      detail: `Recent messages included before send: ${recentResearchMessages.length} / ${researchContextPlan.recentMessageLimit}.`,
      maxTokens: researchContextPlan.modelContextTokens
    }
    : null;
  // Aggregated LLM cost across the whole chat session: every assistant turn's
  // usage plus each subagent run's own multi-turn usage. This is spend/history,
  // not the current context-window fill that drives the radial indicator.
  const researchSessionCost = useMemo<{ text: string; detail: string; tokensUsed?: number } | null>(() => {
    if (!selected) return null;
    const usages: Array<LlmUsage | undefined> = [];
    for (const message of selected.messages) {
      if (message.usage) usages.push(message.usage);
      for (const run of message.subagentRuns) {
        if (run.usage) usages.push(run.usage);
      }
    }
    if (!usages.length) return null;
    if (isAllUsageUnavailable(usages)) {
      return { text: "Cost: n/a", detail: localProviderUsageUnavailableDetail(selectedSessionProvider) };
    }
    const total = sumLlmUsage(usages);
    if (!total) return null;
    const detailLines = [
      total.estimated
        ? "Standard-rate estimate; unknown-model fallback pricing used."
        : "Standard-rate estimate.",
      `Session LLM usage: ${formatTokenCount(llmUsageTotalTokens(total))} tokens.`,
      `Session usage breakdown: ${formatUsageSummaryLine(total)}`
    ];
    let subagentCount = 0;
    let subagentCost = 0;
    for (const message of selected.messages) {
      for (const run of message.subagentRuns) {
        if (run.usage && !run.usage.unavailable && run.usage.costUsd !== undefined) {
          subagentCount += 1;
          subagentCost += run.usage.costUsd;
        }
      }
    }
    if (subagentCount) {
      detailLines.push(`Subagents: ${subagentCount} run${subagentCount === 1 ? "" : "s"}, ${formatCostUsd(subagentCost)}`);
    }
    return {
      text: `Session LLM cost: ${formatCostUsd(total.costUsd, { estimated: total.estimated })}`,
      detail: detailLines.join("\n"),
      tokensUsed: llmUsageTotalTokens(total)
    };
  }, [selected, selectedSessionProvider]);
  const latestContextUsage = useMemo(() => {
    if (!selected) return null;
    return [...selected.messages].reverse().find((message) =>
      message.usage?.estimatedContextTokens !== undefined && !message.usage.unavailable
    )?.usage ?? null;
  }, [selected]);
  const researchPrimaryIndicator = researchContextEstimate && latestContextUsage?.estimatedContextTokens !== undefined
    ? {
        label: "Latest sent context",
        estimatedTokens: latestContextUsage.estimatedContextTokens,
        maxTokens: researchContextEstimate.maxTokens,
        detail: [
          `Latest context lifecycle: ${latestContextUsage.contextLifecycleTier ?? latestContextUsage.contextMode ?? "unknown"}.`,
          latestContextUsage.contextSections?.find((section) => section.label === "lifecycle")?.detail
            ? `Lifecycle notes: ${latestContextUsage.contextSections.find((section) => section.label === "lifecycle")?.detail}.`
            : "",
          latestContextUsage.contextSections?.length
            ? `Latest context sections: ${latestContextUsage.contextSections
              .slice()
              .sort((left, right) => right.tokens - left.tokens)
              .slice(0, 4)
              .map((section) => `${section.label} ${formatTokenCount(section.tokens)}`)
              .join(", ")}.`
            : ""
        ].filter(Boolean).join("\n")
      }
    : null;
  const chatTitle = selected?.title ?? (composingNewChat ? "New chat" : "Chat");

  if (!bundle || !scope) {
    return (
      <aside className="research-panel" aria-label="Research">
        <EmptyState icon={<MessageSquare size={24} />} title="No project open">Open a project to start scoped research.</EmptyState>
      </aside>
    );
  }
  const currentScopeLabel = scopeLabel(scope, bundle);
  const historyVisible = focusMode ? focusHistoryOpen : showHistory;
  const beginNewChat = () => {
    setShowHistory(false);
    setComposingNewChat(true);
    if (defaultScope) setResearchScope(defaultScope);
    selectResearchChat(null);
    requestResearchComposerFocus();
    if (focusMode && window.innerWidth <= 900) setFocusHistoryOpen(false);
  };
  const selectHistorySession = (sessionId: string | null) => {
    setComposingNewChat(false);
    selectResearchChat(sessionId);
    setShowHistory(false);
    if (focusMode && window.innerWidth <= 900) setFocusHistoryOpen(false);
  };
  const requestResearchChatArchive = (sessionId: string) => {
    setArchiveConfirmationSessionId(sessionId);
  };
  const confirmResearchChatArchive = async () => {
    if (!archiveConfirmationSessionId || archiveBusy) return;
    setArchiveBusy(true);
    try {
      await archiveResearchChat(archiveConfirmationSessionId);
      setArchiveConfirmationSessionId(null);
    } finally {
      setArchiveBusy(false);
    }
  };
  const historyContent = (
    <>
      <div className="research-history-filter" role="group" aria-label="Chat history filter">
        <button
          type="button"
          aria-pressed={historyFilter === "all"}
          onClick={() => setHistoryFilter("all")}
        >
          <span>All</span>
          <small>{sortedResearchSessions.length}</small>
        </button>
        <button
          type="button"
          aria-pressed={historyFilter === "scope"}
          onClick={() => setHistoryFilter("scope")}
        >
          <span>{focusMode ? "Scope" : "This scope"}</span>
          <small>{currentScopeChats.length}</small>
        </button>
      </div>
      {historyCount ? (
        <ResearchHistoryList
          sessions={visibleHistoryChats}
          selectedId={selected?.id ?? null}
          onSelect={selectHistorySession}
          onArchive={requestResearchChatArchive}
        />
      ) : (
        <EmptyState icon={<History size={24} />} title={historyFilter === "scope" ? "No chats for this scope" : "No chat history"}>
          {historyFilter === "scope" ? "Switch to All to browse recent chats from the project." : "Start a scoped chat and it will appear here."}
        </EmptyState>
      )}
    </>
  );

  return (
    <aside className={focusMode ? `research-panel is-focus-mode${focusHistoryOpen ? " has-focus-history" : ""}` : "research-panel"} aria-label="Research">
      {focusMode && focusHistoryOpen ? (
        <aside className="research-focus-history" aria-label="Chat history">
          <div className="research-focus-history-head">
            <div>
              <MessageSquare size={16} aria-hidden="true" />
              <strong>Chats</strong>
            </div>
          </div>
          <Button type="button" size="sm" className="research-focus-new-chat" onClick={beginNewChat}>
            <Plus size={14} />
            <span>New chat</span>
          </Button>
          {historyContent}
        </aside>
      ) : null}
      <div className="research-header">
        <div>
          <strong>{chatTitle}</strong>
        </div>
        <div className="research-header-actions">
          <IconButton
            title={historyVisible ? "Hide chat history" : "Show chat history"}
            aria-pressed={historyVisible}
            className={historyVisible ? "research-history-toggle is-active" : "research-history-toggle"}
            onClick={() => focusMode ? setFocusHistoryOpen((current) => !current) : setShowHistory((current) => !current)}
          >
            {focusMode ? (focusHistoryOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />) : <History size={15} />}
          </IconButton>
          <IconButton
            title="New research chat"
            onClick={beginNewChat}
          >
            <Plus size={15} />
          </IconButton>
          {onToggleFocusMode ? (
            <IconButton
              title={focusMode ? "Exit chat focus mode" : "Enter chat focus mode"}
              aria-label={focusMode ? "Exit chat focus mode" : "Enter chat focus mode"}
              aria-pressed={focusMode}
              className={focusMode ? "research-focus-toggle is-active" : "research-focus-toggle"}
              onClick={onToggleFocusMode}
            >
              {focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
          ) : null}
        </div>
      </div>

      <div className={selected ? "research-context-panel" : "research-context-panel is-new-chat"}>
        {!selected ? (
          <Select
            value={scopeKey(scope)}
            onValueChange={(value) => {
              const nextScope = parseScope(value, bundle.project.id);
              setResearchScope(nextScope);
              if (composingNewChat) {
                selectResearchChat(null);
                return;
              }
              const existing = researchSessions.find((session) => sameScope(session.scope, nextScope));
              selectResearchChat(existing?.id ?? null);
            }}
            options={scopeOptions}
          />
        ) : null}
        {selected ? (
          <div className="research-status-row">
            <div className="research-status-cluster">
              <Tooltip content={`Scope : ${currentScopeLabel}`}>
                <span
                  className="ui-badge research-scope-badge"
                  tabIndex={0}
                  aria-label={`Current chat scope: ${currentScopeLabel}`}
                >
                  <ResearchScopeIcon scope={scope} />
                </span>
              </Tooltip>
              {researchBusy && researchTaskStartedAtMs !== null ? (
                <ResearchTaskTimer startedAtMs={researchTaskStartedAtMs} />
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="research-session-controls">
          {selected ? <ResearchWorkCapsule session={selected} items={researchTodosForSession(selected)} /> : null}
          {selected && hasResearchMemory(selected.memory) ? <ResearchMemoryPanel session={selected} /> : null}
          {selected && rootPath ? <ProjectMemoryNotesPanel projectRoot={rootPath} refreshKey={selected.updatedAt} /> : null}
          {selected && rootPath ? <ChatArtifactsPanel key={`chat-artifacts-${selected.id}`} projectRoot={rootPath} session={selected} refreshKey={selected.updatedAt} /> : null}
          {researchAutoApproveGraphChanges ? (
            <div className="research-auto-approve">
              <div className="research-auto-approve-fit">
                <Switch
                  checked={researchAutoApproveGraphChanges.enabled}
                  onCheckedChange={setAutoApproveGraphChanges}
                  label="Auto-approve"
                  tooltip="Automatically applies non-destructive graph changes and safety-classified medium-risk Chat commands across this project. High-risk actions, project-code edits, deletes, and run actions still require review or their dedicated workflow."
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className={showHistory && !focusMode ? "research-body is-history" : "research-body"}>
        {showHistory && !focusMode ? (
          <div className="research-history">
            {historyContent}
          </div>
        ) : (
        <div className="research-chat">
          <ScrollArea className="research-messages" viewportRef={messagesViewportRef}>
            {!selected ? (
              <div className="research-welcome-empty">
                <div className="research-welcome-copy">
                  <h2>What should we shape next?</h2>
                  <p>
                    Brainstorm ideas, research, or request a change.
                    <span>Archi will help turn it into a clear next step.</span>
                  </p>
                </div>
                <img
                  className="research-welcome-illustration"
                  src={archiChatEmptyIllustration}
                  alt="Archi arranging a connected software graph"
                  draggable={false}
                />
              </div>
            ) : (
              <div className="research-message-list">
                {selected ? selected.messages.map((message, messageIndex) => {
                  if (isChangeSetReviewMessage(message)) return null;
                  const isStreamingMessage = researchBusy && message.id.startsWith("research-waiting");
                  const streamKind = researchStreamStates[message.id]?.kind;
                  const isThinkingDraft = isStreamingMessage && streamKind === "thinking";
                  const liveSubagentRuns = researchSubagentActivity[message.id] ?? [];
                  const hasSubagentCards = Boolean(message.subagentRuns?.length || liveSubagentRuns.length);
                  const liveParentActivity = researchChatActivity[message.id];
                  const latestPersistedSubagentUpdate = message.subagentRuns?.reduce(
                    (latest, run) => run.updatedAt > latest ? run.updatedAt : latest,
                    ""
                  ) ?? "";
                  const persistedContinuationLines = hasSubagentCards
                    ? (message.mcpToolCalls ?? [])
                        .filter((call) => !latestPersistedSubagentUpdate || call.createdAt >= latestPersistedSubagentUpdate)
                        .map(mcpToolActivityLine)
                    : [];
                  const parentActivityLines = liveParentActivity?.lines.length
                    ? liveParentActivity.lines
                    : persistedContinuationLines;
                  const hasTimelineActivity = hasSubagentCards || parentActivityLines.length > 0;
                  const isParentActivityRunning = liveParentActivity?.status === "running" || (!liveParentActivity && isStreamingMessage);
                  const isLastMessage = messageIndex === transcriptAnalysis.lastVisibleMessageIndex;
                  const retryableMessage = canRetryResearchMessage(message) && isLastMessage;
                  const messageImageAttachments = message.attachmentIds
                    .map((attachmentId) => messageAttachmentArtifactsById.get(attachmentId))
                    .filter(isImageArtifact);
                  const messageTextAttachments = message.attachmentIds
                    .map((attachmentId) => messageAttachmentArtifactsById.get(attachmentId))
                    .filter(isTextAttachmentArtifact);
                  const pendingTextAttachmentNames = message.attachmentIds.length
                    ? []
                    : (researchPendingAttachmentPaths[message.id] ?? [])
                        .filter((filePath) => !isImageAttachmentPath(filePath))
                        .map(attachmentFileName);
                  const messageAttachmentCount = message.attachmentIds.length || (researchPendingAttachmentPaths[message.id]?.length ?? 0);
                  const changeSetResultReport = isStreamingMessage ? null : changeSetResultReportPresentation(message.content);
                  const ruleApproval = message.mcpApprovalRequest?.providerToolName === RESEARCH_RULES_TOOL_NAME
                    ? ruleApprovalPresentation(message.mcpApprovalRequest.argumentsJson ?? "{}")
                    : null;
                  const commandApproval = message.mcpApprovalRequest
                    ? commandApprovalPresentation(
                        message.mcpApprovalRequest.providerToolName,
                        message.mcpApprovalRequest.toolName,
                        message.mcpApprovalRequest.argumentsJson ?? "{}"
                      )
                    : null;
                  const visibleToolCalls = [...(message.mcpToolCalls ?? [])]
                    .filter((call) => !(message.mcpApprovalRequest && call.status === "approval-required"))
                    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
                  return (
                  <div key={message.id} className={`research-message research-message-${message.role}${isThinkingDraft ? " research-message-thinking-draft" : ""}${hasSubagentCards ? " research-message-has-subagents" : ""}${hasTimelineActivity ? " research-message-has-activity" : ""}`}>
                    <div className="research-message-head">
                      <div className="research-message-meta">
                        <strong>{message.role === "assistant" ? "AI Assistant" : message.role === "user" ? "You" : "System"}</strong>
                        {isThinkingDraft ? <Badge tone="neutral">Thinking</Badge> : null}
                        {message.error ? <Badge tone="danger">Error</Badge> : null}
                        {messageAttachmentCount ? <Badge tone="accent">{messageAttachmentCount} attachment{messageAttachmentCount === 1 ? "" : "s"}</Badge> : null}
                        {message.mcpToolCalls?.length ? (
                          <Tooltip content={mcpToolUsageTooltip(message.mcpToolCalls)}>
                            <span tabIndex={0} aria-label={`${message.mcpToolCalls.length} MCP tool call${message.mcpToolCalls.length === 1 ? "" : "s"}`}>
                              <Badge tone="accent">{message.mcpToolCalls.length} MCP</Badge>
                            </span>
                          </Tooltip>
                        ) : null}
                      </div>
                      <div className="research-message-actions">
                        {ttsSettings?.enabled && message.role === "assistant" ? (
                          <IconButton
                            className={speakingMessageId === message.id ? "research-copy-button is-speaking" : "research-copy-button"}
                            title={isThinkingDraft ? "Waiting for final answer text" : speakingMessageId === message.id ? "Stop playback" : selectedTtsModel?.downloaded ? "Read message aloud" : "Open voice output settings"}
                            disabled={isThinkingDraft || Boolean(ttsBusyMessageId && ttsBusyMessageId !== message.id)}
                            onClick={() => void playMessageSpeech(message.id, message.content)}
                          >
                            {ttsBusyMessageId === message.id ? (
                              <Loader2 size={13} className="is-spinning" />
                            ) : speakingMessageId === message.id ? (
                              <Square size={13} />
                            ) : (
                              <Volume2 size={13} />
                            )}
                          </IconButton>
                        ) : null}
                        {message.role === "assistant" ? (
                          <IconButton
                            className="research-fork-button"
                            title="Fork chat from here"
                            disabled={isThinkingDraft}
                            onClick={() => void forkResearchMessage(message.id)}
                          >
                            <Split size={13} />
                          </IconButton>
                        ) : null}
                        <IconButton
                          className="research-copy-button"
                          title={copiedMessageId === message.id ? "Copied" : "Copy message"}
                          onClick={() => void copyMessage(message.id, message.content)}
                        >
                          {copiedMessageId === message.id ? <Check size={13} /> : <Copy size={13} />}
                        </IconButton>
                      </div>
                    </div>
                    {messageImageAttachments.length && bundle?.project.rootPath ? (
                      <ResearchMessageImageAttachments
                        projectRoot={bundle.project.rootPath}
                        artifacts={messageImageAttachments}
                      />
                    ) : null}
                    {messageTextAttachments.length || pendingTextAttachmentNames.length ? (
                      <div className="research-message-file-list" aria-label="Text document attachments">
                        {messageTextAttachments.map((artifact) => (
                          <button
                            key={artifact.id}
                            type="button"
                            className="research-message-file-chip"
                            title={artifact.title}
                            onClick={() => {
                              if (bundle?.project.rootPath && window.archicode?.openProjectFile) {
                                void window.archicode.openProjectFile(bundle.project.rootPath, artifact.path);
                              }
                            }}
                          >
                            <FileText size={14} />
                            <span>{artifact.title}</span>
                          </button>
                        ))}
                        {pendingTextAttachmentNames.map((fileName, index) => (
                          <span
                            key={`${fileName}-${index}`}
                            className="research-message-file-chip is-pending"
                            title={fileName}
                          >
                            <FileText size={14} />
                            <span>{fileName}</span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {visibleToolCalls.length ? (
                      <div className="research-tool-traces" aria-label="Agent tool activity in chronological order">
                        {visibleToolCalls.map((call, callIndex) => {
                          const copyKey = `${message.id}:tool:${callIndex}`;
                          return (
                            <ResearchToolTrace
                              key={`${call.createdAt}:${call.serverId}:${call.toolName}:${callIndex}`}
                              call={call}
                              copyKey={copyKey}
                              copiedCommandKey={copiedCommandMessageId}
                              onCopyCommand={(key, commandText) => void copyApprovalCommand(key, commandText)}
                            />
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="research-message-content">
                      {changeSetResultReport ? (
                        <div className={`research-change-set-result is-${changeSetResultReport.tone}`}>
                          <div className="research-change-set-result-summary">
                            <strong>{changeSetResultReport.title}</strong>
                            <span>{changeSetResultReport.summary}</span>
                          </div>
                          <details>
                            <summary>
                              <span>Operation details</span>
                              <small>{changeSetResultReport.operationCount}</small>
                            </summary>
                            <div className="research-change-set-result-details">
                              <ResearchMarkdown
                                content={changeSetResultReport.details}
                                loadProjectImage={loadProjectImage}
                                onGraphLink={navigateGraphLink}
                                onProjectPathLink={openProjectPathLink}
                              />
                            </div>
                          </details>
                        </div>
                      ) : (
                        <ResearchMarkdown
                          content={displayResearchContent(message.content, isStreamingMessage)}
                          highlightText={ttsHighlight?.messageId === message.id ? ttsHighlight.text : null}
                          loadProjectImage={loadProjectImage}
                          onGraphLink={navigateGraphLink}
                          onProjectPathLink={openProjectPathLink}
                        />
                      )}
                      {isStreamingMessage ? (
                        <span className="research-thinking" aria-label={isThinkingDraft ? "Research is thinking" : "Research is writing"}>
                          <span />
                          <span />
                          <span />
                        </span>
                      ) : null}
                      {message.error ? (
                        <div className="research-error-actions">
                          <small className="research-error">{message.error}</small>
                          {retryableMessage ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="research-error-retry"
                              disabled={researchBusy}
                              onClick={() => void retryFailedMessage(message.id)}
                            >
                              {retryingMessageId === message.id ? <Loader2 size={13} className="is-spinning" /> : <RefreshCw size={13} />}
                              <span>{retryingMessageId === message.id ? "Retrying" : "Retry"}</span>
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    {message.mcpApprovalRequest ? (
                      <div className={`research-mcp-request${ruleApproval ? " is-rule-change" : ""}`}>
                        <div>
                          <ShieldCheck size={16} />
                          <span>
                            <strong>{ruleApproval ? "Rule change requires approval" : "MCP tool use requires approval"}</strong>
                            <small>{message.mcpApprovalRequest.serverLabels.join(", ")} · {message.mcpApprovalRequest.toolName}</small>
                          </span>
                        </div>
                        {ruleApproval ? (
                          <div className="research-rule-approval-proposal">
                            <strong>{ruleApproval.summary}</strong>
                            <p>{ruleApproval.implication}</p>
                            <details>
                              <summary>Review exact proposed change</summary>
                              <pre>{ruleApproval.exactJson}</pre>
                            </details>
                            <small>This approval applies only to this exact change. It cannot be remembered for later rule edits.</small>
                          </div>
                        ) : (
                          <>
                            {commandApproval ? (
                              <div className="research-command-approval-proposal">
                                <div className="research-command-approval-heading">
                                  <strong>Command to run</strong>
                                  <Badge
                                    className="research-command-risk-badge"
                                    tone={commandApproval.risk === "low" ? "success" : commandApproval.risk === "medium" ? "warning" : "danger"}
                                  >
                                    {commandApproval.risk[0].toUpperCase() + commandApproval.risk.slice(1)} risk
                                  </Badge>
                                </div>
                                <div className="research-command-approval-code">
                                  <IconButton
                                    className="research-command-copy-button"
                                    title={copiedCommandMessageId === message.id ? "Copied" : "Copy exact command"}
                                    aria-label={copiedCommandMessageId === message.id ? "Command copied" : "Copy exact command"}
                                    onClick={() => void copyApprovalCommand(message.id, commandApproval.command)}
                                  >
                                    {copiedCommandMessageId === message.id ? <Check size={12} /> : <Copy size={12} />}
                                  </IconButton>
                                  <ResearchMarkdown content={shellCommandMarkdown(commandApproval.command)} />
                                </div>
                                <small className="research-command-risk-hint">{commandRiskHint(commandApproval.risk, commandApproval.command)}</small>
                                <small>Working directory: {commandApproval.cwd}</small>
                              </div>
                            ) : null}
                            <p>
                              {commandApproval
                                ? "Review this exact command, then approve or reject it."
                                : "The assistant tried to use this Ask-mode MCP tool. Approve or reject this tool use."}
                            </p>
                            <label className="research-mcp-remember">
                              <input
                                type="checkbox"
                                checked={Boolean(rememberMcpByMessage[message.id])}
                                disabled={researchBusy}
                                onChange={(event) => setRememberMcpByMessage((current) => ({ ...current, [message.id]: event.target.checked }))}
                              />
                              <span>Remember for this chat</span>
                            </label>
                          </>
                        )}
                        <div className="research-mcp-request-actions">
                          <Button
                            type="button"
                            size="sm"
                            variant="primary"
                            disabled={researchBusy}
                            onClick={() => void respondToMcpApproval(message, "approved")}
                          >
                            <Check size={15} />
                            <span>{ruleApproval ? "Approve change" : "Approve"}</span>
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={researchBusy}
                            onClick={() => void respondToMcpApproval(message, "rejected")}
                          >
                            <span>Reject</span>
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {(() => {
                      const persistedRuns = [...(message.subagentRuns ?? [])]
                        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
                      const liveRuns = liveSubagentRuns;
                      const liveById = new Map(liveRuns.map((entry) => [entry.id, entry]));
                      const persistedIds = new Set(persistedRuns.map((entry) => entry.id));
                      // Persisted runs, with a live override so a run mid-flight
                      // shows its live status (running → completed/failed) and
                      // live progress even though the reloaded session still says
                      // awaiting-approval/etc. Runs are sequential, so the live
                      // status is what keeps merge from looking "running" while
                      // reconciliation runs.
                      const cards = [
                        ...persistedRuns.map((run) => {
                          const live = liveById.get(run.id);
                          return {
                            id: run.id,
                            kind: run.kind,
                            subtitle: run.title,
                            status: live ? live.status : run.status,
                            proposedResolutionStrategy: run.proposedResolutionStrategy,
                            reviewReason: run.reviewReason,
                            runtimeTargetSelection: run.runtimeTargetSelection,
                            selectedRuntimeTargetProfileIds: run.selectedRuntimeTargetProfileIds,
                            imageInputSupport: run.imageInputSupport,
                            argumentsJson: run.argumentsJson,
                            resultSummary: run.resultSummary,
                            error: run.error,
                            failureKind: run.failureKind,
                            diagnostics: live?.visuallyAnalyzedArtifactIds.length
                              ? {
                                  ...run.diagnostics,
                                  visuallyAnalyzedArtifactIds: Array.from(new Set([
                                    ...(run.diagnostics?.visuallyAnalyzedArtifactIds ?? []),
                                    ...live.visuallyAnalyzedArtifactIds
                                  ]))
                                }
                              : run.diagnostics,
                            progressLines: live?.lines.length ? live.lines : run.progress,
                            artifacts: live?.artifacts.length ? live.artifacts : (run.artifacts ?? [])
                          };
                        }),
                        // Live-only runs (e.g. graph reconciliation that has not
                        // been persisted onto the message yet).
                        ...liveRuns.filter((entry) => !persistedIds.has(entry.id)).map((entry) => ({
                          id: entry.id,
                          kind: entry.kind,
                          subtitle: entry.title,
                          status: entry.status,
                          proposedResolutionStrategy: undefined,
                          reviewReason: undefined,
                          runtimeTargetSelection: undefined,
                          selectedRuntimeTargetProfileIds: [],
                          imageInputSupport: undefined,
                          argumentsJson: "{}",
                          resultSummary: undefined,
                          error: undefined,
                          failureKind: undefined,
                          diagnostics: entry.visuallyAnalyzedArtifactIds.length
                            ? { responsePreview: undefined, visuallyAnalyzedArtifactIds: entry.visuallyAnalyzedArtifactIds }
                            : undefined,
                          progressLines: entry.lines,
                          artifacts: entry.artifacts
                        }))
                      ];
                      if (!cards.length) return null;
                      return (
                      <div className="research-subagent-runs">
                        {cards.map((run) => {
                          const isResponding = respondingSubagentRunId === run.id;
                          let delphiArgs: { objective?: string; mode?: string; observation?: { mode?: string; capture?: string }; target?: { baseUrl?: string; deviceId?: string } } = {};
                          if (run.kind === "delphi-testing") {
                            try { delphiArgs = JSON.parse(run.argumentsJson || "{}"); } catch { delphiArgs = {}; }
                          }
                          const isDelphiSetup = run.kind === "delphi-testing" && delphiArgs.mode === "setup";
                          const runtimeTargetOptions = run.runtimeTargetSelection?.options ?? [];
                          const selectedRuntimeTargets = delphiRuntimeTargetSelections[run.id] ?? new Set(run.selectedRuntimeTargetProfileIds ?? []);
                          const targetSelectionRequired = runtimeTargetOptions.length > 1;
                          const targetSelectionValid = !targetSelectionRequired || selectedRuntimeTargets.size >= (run.runtimeTargetSelection?.minSelections ?? 1);
                          const delphiTargetUrl = delphiArgs.target?.baseUrl;
                          const runSummary = run.kind === "delphi-testing" ? delphiArgs.objective || run.subtitle : run.subtitle;
                          const summaryExpanded = expandedSubagentSummaryIds.has(run.id);
                          const summaryExpandable = runSummary.length > 110 || (run.kind === "delphi-testing" && Boolean(delphiArgs.objective));
                          const successfulBatchCount = successfulSubagentBatchCount(run.kind, run.progressLines);
                          const correctedLegacyDelphiBlock = run.kind === "delphi-testing" &&
                            run.status === "failed" &&
                            /pixel-level visual-quality claim without analyzing/i.test(run.error ?? "") &&
                            /["']status["']\s*:\s*["']blocked["']/i.test(run.diagnostics?.responsePreview ?? "") &&
                            /["']verdict["']\s*:\s*["']blocked["']/i.test(run.diagnostics?.responsePreview ?? "");
                          const timedOut = run.status === "failed" && (
                            run.failureKind === "timeout" ||
                            isTimeoutFailureMessage(run.error) ||
                            isTimeoutFailureMessage(run.resultSummary)
                          );
                          // Delphi's terminal `blocked` output means that the audit
                          // completed with unresolved coverage. Present that as
                          // Incomplete; reserve Blocked for a parent trajectory that
                          // cannot continue at all. The persisted value stays
                          // backward-compatible for older chats.
                          const displayStatus = timedOut
                            ? "timed-out"
                            : run.kind === "delphi-testing" && (correctedLegacyDelphiBlock || run.status === "blocked")
                              ? "incomplete"
                              : run.status;
                          const title = run.kind === "merge-resolution"
                            ? "Solomon — Merge Arbiter"
                            : run.kind === "sherlock-research"
                              ? "Sherlock — Research Detective"
                              : run.kind === "delphi-testing"
                                ? "Delphi — Test & Runtime Oracle"
                              : run.kind === "test-authoring"
                                ? "Test Authoring Agent"
                                : "Picasso — Graph Architect";
                          const statusLabel = displayStatus === "awaiting-approval" ? "Awaiting approval"
                            : displayStatus === "running" ? "Running"
                            : displayStatus === "completed" ? "Completed"
                            : displayStatus === "incomplete" ? "Incomplete"
                            : displayStatus === "timed-out" ? "Timed out"
                            : displayStatus === "blocked" ? "Blocked"
                            : displayStatus === "failed" ? "Failed"
                            : "Cancelled";
                          const statusTone = displayStatus === "completed" ? "success"
                            : displayStatus === "incomplete" ? "warning"
                            : displayStatus === "timed-out" ? "warning"
                            : displayStatus === "blocked" ? "warning"
                            : displayStatus === "failed" ? "danger"
                            : displayStatus === "rejected" ? "neutral"
                            : "accent";
                          return (
                            <div
                              key={run.id}
                              className={`research-subagent-run research-subagent-run-${displayStatus} research-timeline-${displayStatus === "running" || displayStatus === "awaiting-approval" ? "active" : "terminal"}`}
                            >
                              <div className="research-subagent-run-head">
                                {displayStatus === "running" ? <Loader2 size={14} className="is-spinning" />
                                  : displayStatus === "completed" ? <CheckCircle2 size={14} />
                                  : displayStatus === "incomplete" ? <AlertTriangle size={14} />
                                  : displayStatus === "timed-out" ? <Clock3 size={14} />
                                  : displayStatus === "blocked" ? <AlertTriangle size={14} />
                                  : displayStatus === "failed" ? <AlertCircle size={14} />
                                : displayStatus === "rejected" ? <X size={14} />
                                  : <ShieldCheck size={14} />}
                                <strong>{title}</strong>
                                {successfulBatchCount ? (
                                  <span
                                    className="research-subagent-batch-count"
                                    title={`${successfulBatchCount} validated graph ${successfulBatchCount === 1 ? "batch" : "batches"} submitted to the parent chat`}
                                    aria-label={`${successfulBatchCount} validated graph ${successfulBatchCount === 1 ? "batch" : "batches"} submitted`}
                                  >
                                    B{successfulBatchCount}
                                  </span>
                                ) : null}
                                <Badge tone={statusTone}>{statusLabel}</Badge>
                              </div>
                              <div className={`research-subagent-summary${summaryExpanded ? " is-expanded" : ""}`}>
                                <small>{runSummary}</small>
                                {summaryExpandable ? (
                                  <button
                                    type="button"
                                    aria-expanded={summaryExpanded}
                                    onClick={() => setExpandedSubagentSummaryIds((current) => {
                                      const next = new Set(current);
                                      if (next.has(run.id)) next.delete(run.id);
                                      else next.add(run.id);
                                      return next;
                                    })}
                                  >
                                    {summaryExpanded ? "Show less" : "Show more"}
                                  </button>
                                ) : null}
                              </div>
                              {run.kind === "delphi-testing" ? (
                                <div className="research-delphi-observation-status">
                                  <Eye size={13} />
                                  <span>{delphiArgs.observation?.mode === "headless" ? "Headless audit" : "Visible observation"}</span>
                                  {delphiArgs.target?.deviceId ? <small>Target {delphiArgs.target.deviceId}</small> : null}
                                  {delphiTargetUrl ? (
                                    <Button type="button" size="sm" onClick={() => void window.archicode?.openExternalUrl(delphiTargetUrl)}>
                                      <ExternalLink size={13} />
                                      <span>Open target</span>
                                    </Button>
                                  ) : null}
                                </div>
                              ) : null}
                              {run.status === "awaiting-approval" ? (
                                <div className="research-subagent-approval">
                                  {run.kind === "merge-resolution" ? (
                                    <label className="research-subagent-strategy-label">
                                      <span>Resolution strategy (optional — edit before approving)</span>
                                      <TextArea
                                        rows={2}
                                        disabled={researchBusy}
                                        value={subagentStrategyDrafts[run.id] ?? run.proposedResolutionStrategy ?? ""}
                                        onChange={(event) => setSubagentStrategyDrafts((current) => ({ ...current, [run.id]: event.target.value }))}
                                        placeholder="e.g. prefer main branch, merge both sides, keep the feature-branch version..."
                                      />
                                    </label>
                                  ) : (
                                    <>
                                      <div className="research-subagent-reason">
                                        <span>{isDelphiSetup ? "What will be installed?" : run.kind === "delphi-testing" ? "What will Delphi do?" : "Why reconcile?"}</span>
                                        <p>{run.reviewReason ?? (run.kind === "delphi-testing" ? "Delphi will inspect and run the approved finite project checks." : "ArchiCode detected possible graph drift after the merge.")}</p>
                                      </div>
                                      {targetSelectionRequired ? (
                                        <fieldset className="research-delphi-target-picker">
                                          <legend>Choose every target Delphi should run and test</legend>
                                          {runtimeTargetOptions.map((option) => (
                                            <label key={option.profileId}>
                                              <input
                                                type="checkbox"
                                                checked={selectedRuntimeTargets.has(option.profileId)}
                                                disabled={researchBusy}
                                                onChange={() => setDelphiRuntimeTargetSelections((current) => {
                                                  const nextSelection = new Set(current[run.id] ?? []);
                                                  if (nextSelection.has(option.profileId)) nextSelection.delete(option.profileId);
                                                  else nextSelection.add(option.profileId);
                                                  return { ...current, [run.id]: nextSelection };
                                                })}
                                              />
                                              <span>{option.label}<small>{option.kind}</small></span>
                                            </label>
                                          ))}
                                          <small>Select one target or combine several, such as a backend and frontend in a monorepo.</small>
                                        </fieldset>
                                      ) : null}
                                    </>
                                  )}
                                  <div className="research-subagent-approval-actions">
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="primary"
                                      disabled={researchBusy || !targetSelectionValid}
                                      onClick={() => {
                                        const run0 = message.subagentRuns.find((entry) => entry.id === run.id);
                                        if (run0) void respondToSubagent(message, run0, "approved", targetSelectionRequired ? [...selectedRuntimeTargets] : undefined);
                                      }}
                                    >
                                      {isResponding ? <Loader2 size={15} className="is-spinning" /> : <Check size={15} />}
                                      <span>{run.kind === "merge-resolution" ? "Approve" : isDelphiSetup ? "Install" : "Run"}</span>
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      disabled={researchBusy}
                                      onClick={() => {
                                        const run0 = message.subagentRuns.find((entry) => entry.id === run.id);
                                        if (run0) void respondToSubagent(message, run0, "rejected");
                                      }}
                                    >
                                      <span>{run.kind === "merge-resolution" ? "Cancel" : "Skip"}</span>
                                    </Button>
                                  </div>
                                </div>
                              ) : null}
                              {run.progressLines.length ? (
                                <div className="research-subagent-progress">
                                  <IconButton
                                    className="research-subagent-copy-button"
                                    title={copiedSubagentRunId === run.id ? "Copied" : "Copy full subagent log"}
                                    onClick={() => void copySubagentProgress(run.id, run.progressLines)}
                                  >
                                    {copiedSubagentRunId === run.id ? <Check size={12} /> : <Copy size={12} />}
                                  </IconButton>
                                  <div className="research-subagent-progress-lines">
                                    {run.progressLines.slice(-6).map((line, index) => <div key={index}>{line}</div>)}
                                  </div>
                                </div>
                              ) : null}
                              {run.kind === "delphi-testing" && bundle?.project.rootPath ? (
                                <DelphiObservationGallery
                                  projectRoot={bundle.project.rootPath}
                                  artifacts={run.artifacts}
                                  modelInspectedArtifactIds={run.diagnostics?.visuallyAnalyzedArtifactIds ?? []}
                                  imageInputSupport={run.imageInputSupport}
                                  runStatus={displayStatus}
                                />
                              ) : null}
                              {(displayStatus === "completed" || displayStatus === "incomplete" || displayStatus === "blocked" || displayStatus === "timed-out" || displayStatus === "failed") ? (
                                <small className="research-subagent-result">{displayStatus === "failed" || displayStatus === "timed-out" ? run.error ?? run.resultSummary : run.resultSummary}</small>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                      );
                    })()}
                    {parentActivityLines.length ? (
                      <div className={`research-parent-activity research-parent-activity-${liveParentActivity?.status ?? (isStreamingMessage ? "running" : "completed")}`}>
                        <div className="research-parent-activity-head">
                          {liveParentActivity?.status === "failed" ? <AlertCircle size={14} />
                            : isParentActivityRunning ? <Loader2 size={14} className="is-spinning" />
                            : <CheckCircle2 size={14} />}
                          <strong>Archi — Parent investigation</strong>
                          <Badge tone={liveParentActivity?.status === "failed" ? "danger" : isParentActivityRunning ? "accent" : "success"}>
                            {liveParentActivity?.status === "failed" ? "Blocked" : isParentActivityRunning ? "Working" : "Complete"}
                          </Badge>
                        </div>
                        <div className="research-parent-activity-lines">
                          {parentActivityLines.slice(-6).map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}
                        </div>
                      </div>
                    ) : null}
                    {message.changeSet ? (() => {
                      const changeSet = message.changeSet;
                      const changeSetCategory = researchChangeSetCategory(changeSet.operations);
                      const queueSubmission = changeSetCategory === "queue";
                      const reviewKey = changeSetReviewKey(selected.id, message.id, changeSet.id);
                      const reviewPending = pendingChangeSetKeys.has(reviewKey);
                      const reviewSummary = transcriptAnalysis.reviewSummaryByChangeSetIndex.get(messageIndex) ?? null;
                      const reviewPresentation = reviewStatusPresentation(reviewSummary, changeSetCategory);
                      const reviewed = Boolean(changeSet.reviewedAt) || Boolean(reviewSummary);
                      const canRetryFailedReview = Boolean(reviewSummary && reviewSummary.applied === 0 && reviewSummary.rejected === 0 && reviewSummary.failed === changeSet.operations.length);
                      const waitingForRun = Boolean(activeGraphLockRun && (!reviewed || canRetryFailedReview));
                      const primaryActionLabel = waitingForRun
                        ? queueSubmission ? "Queue after run" : "Apply after run"
                        : reviewPending
                          ? canRetryFailedReview ? "Retrying" : queueSubmission ? "Queueing" : "Applying"
                          : canRetryFailedReview
                            ? queueSubmission ? "Retry Queue" : "Repair & Apply"
                            : reviewed
                              ? reviewPresentation?.actionLabel ?? (queueSubmission ? "Queued" : "Applied")
                              : queueSubmission ? "Queue Selected" : "Apply Selected";
                      return (
                        <div className="research-change-set">
                          <div className="research-change-set-head">
                            <strong>{changeSet.summary}</strong>
                            {reviewPresentation
                              ? <Badge tone={reviewPresentation.badgeTone}>{reviewPresentation.badgeLabel}</Badge>
                              : reviewed
                                ? <Badge tone="success">{queueSubmission ? "Queued" : "Reviewed"}</Badge>
                                : waitingForRun
                                  ? <Badge tone="warning">Waiting for run</Badge>
                                : null}
                          </div>
                          {reviewPresentation ? <small>{reviewPresentation.summaryLabel}</small> : null}
                          {waitingForRun && activeGraphLockRun ? (
                            <div className="research-change-run-lock" role="status">
                              <AlertTriangle size={15} />
                              <span>
                                {queueSubmission ? "Queueing" : "Applying"} unlocks after run <strong>{activeGraphLockRun.id}</strong> ({activeGraphLockRun.status}) finishes or is cancelled. You can review the proposed operations or reject this card now; {queueSubmission ? "nothing has been queued" : "no changes have been applied"}.
                              </span>
                            </div>
                          ) : null}
                          {(() => {
                            const operationTitles = nodeTitleMap(bundle, changeSet);
                            const operationFlowTitles = flowTitleMap(bundle, changeSet);
                            const operationSubflowTitles = subflowTitleMap(bundle, changeSet);
                            return changeSet.operations.map((operation, index) => {
                              const set = acceptedByChangeSet[changeSet.id] ?? new Set(changeSet.operations.map((_, operationIndex) => operationIndex));
                              const fields = operationFields(operation);
                              return (
                                <label key={`${changeSet.id}-${index}`} className="research-change-row">
                                  <input
                                    type="checkbox"
                                    checked={set.has(index)}
                                    disabled={reviewPending || reviewed}
                                    onChange={() => setAcceptedByChangeSet((current) => {
                                      const next = new Set(current[changeSet.id] ?? changeSet.operations.map((_, operationIndex) => operationIndex));
                                      if (next.has(index)) next.delete(index);
                                      else next.add(index);
                                      return { ...current, [changeSet.id]: next };
                                    })}
                                  />
                                  <span>
                                    {operationLabel(operation, operationTitles, operationSubflowTitles, operationFlowTitles)}
                                    {fields ? <small>{fields}</small> : null}
                                  </span>
                                  {isDestructiveOperation(operation) ? <Badge tone="danger">destructive</Badge> : null}
                                </label>
                              );
                            });
                          })()}
                          <div className="research-change-actions">
                            <Button
                              type="button"
                              size="sm"
                              variant="primary"
                              title={waitingForRun && activeGraphLockRun
                                ? `${queueSubmission ? "Queueing" : "Apply"} is locked until run ${activeGraphLockRun.id} finishes or is cancelled.`
                                : canRetryFailedReview
                                  ? `Run recovery preflight on the retained card, then ${queueSubmission ? "submit it again" : "apply it"}`
                                  : undefined}
                              disabled={waitingForRun || reviewPending || (reviewed && !canRetryFailedReview)}
                              onClick={() => {
                                const accepted = acceptedByChangeSet[changeSet.id] ?? new Set(changeSet.operations.map((_, index) => index));
                                submitResearchChangeSet(
                                  message.id,
                                  changeSet,
                                  changeSet.operations.map((_, operationIndex) => ({
                                    operationIndex,
                                    decision: accepted.has(operationIndex) ? "accepted" as const : "rejected" as const
                                  })),
                                  canRetryFailedReview
                                );
                              }}
                            >
                              <CheckCircle2 size={15} />
                              <span>{primaryActionLabel}</span>
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="danger"
                              disabled={reviewPending || reviewed}
                              onClick={() => submitResearchChangeSet(
                                message.id,
                                changeSet,
                                changeSet.operations.map((_, operationIndex) => ({ operationIndex, decision: "rejected" as const }))
                              )}
                            >
                              <X size={15} />
                              <span>{reviewPending ? (queueSubmission ? "Queueing" : "Applying") : reviewed ? "Reviewed" : "Reject"}</span>
                            </Button>
                          </div>
                        </div>
                      );
                    })() : null}
                    {isLastMessage && !isStreamingMessage ? (
                      <small className="research-message-timestamp">Last updated {new Date(selected.updatedAt).toLocaleString()}</small>
                    ) : null}
                  </div>
                  );
                }) : null}
              </div>
            )}
          </ScrollArea>
          {researchHasNewActivity ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="research-new-activity"
              onClick={scrollResearchToBottom}
            >
              <ChevronDown size={14} />
              <span>More</span>
            </Button>
          ) : null}
          {selected && queuedMessages.length ? (
            <div className="research-queued-messages" aria-label="Queued messages">
              {queuedMessages.map((queuedMessage, index) => (
                <div key={queuedMessage.id} className="research-queued-message">
                  <span className="research-queued-message-index">{index + 1}</span>
                  <span className="research-queued-message-content">{queuedMessage.content}</span>
                  <div className="research-queued-message-actions">
                    <IconButton
                      title="Move up"
                      disabled={index === 0}
                      onClick={() => reorderQueuedResearchMessage(selected.id, queuedMessage.id, "up")}
                    >
                      <ChevronUp size={13} />
                    </IconButton>
                    <IconButton
                      title="Move down"
                      disabled={index === queuedMessages.length - 1}
                      onClick={() => reorderQueuedResearchMessage(selected.id, queuedMessage.id, "down")}
                    >
                      <ChevronDown size={13} />
                    </IconButton>
                    <IconButton
                      title="Remove from queue"
                      onClick={() => dequeueResearchMessage(selected.id, queuedMessage.id)}
                    >
                      <X size={13} />
                    </IconButton>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <div ref={speechMeterRef} className="research-composer">
            <ChatComposer
              placeholder={mcpApprovalPending ? "Approve or reject first" : "Ask anything"}
              disabled={mcpApprovalPending}
              onSubmit={() => void submit()}
            />
            {modelSwitchWarning ? (
              <div className="research-model-switch-warning" role="status" aria-live="polite">
                <AlertTriangle size={15} aria-hidden="true" />
                <span>
                  <strong>{modelSwitchWarning.from} → {modelSwitchWarning.to}</strong> may not be fully compatible with this existing chat.
                </span>
                <IconButton
                  title="Dismiss model compatibility warning"
                  aria-label="Dismiss model compatibility warning"
                  onClick={() => setModelSwitchWarning(null)}
                >
                  <X size={13} />
                </IconButton>
              </div>
            ) : null}
            <div className="research-composer-actions">
              <div className="research-composer-primary-actions">
                {recordingSpeech ? (
                  <Button
                    type="button"
                    variant="success"
                    className="research-recording-send"
                    disabled={recordingSendDisabled}
                    onClick={() => void stopSpeechRecording("send")}
                  >
                    <Play size={15} />
                    <span>Send</span>
                  </Button>
                ) : (
                  <ResearchSubmitButton
                    disabled={composerPrimaryDisabled}
                    label={composerPrimaryLabel}
                    pending={speechBusy}
                    onSubmit={() => void submit()}
                  />
                )}
                {recordingSpeech ? (
                  <Button
                    type="button"
                    variant="danger"
                    className="research-recording-done research-recording-stop"
                    aria-label="Done"
                    title="Done"
                    disabled={composerPrimaryDisabled}
                    onClick={() => void runSpeechAction()}
                  >
                    <Square size={15} />
                  </Button>
                ) : speechSettings?.enabled ? (
                  <IconButton
                    title={speechButtonTitle}
                    className="research-speech-button"
                    aria-pressed={false}
                    disabled={speechButtonDisabled}
                    onClick={() => void runSpeechAction()}
                  >
                    {speechBusy ? <Loader2 className="is-spinning" size={15} /> : <Mic size={15} />}
                  </IconButton>
                ) : null}
                <IconButton
                  title={attachmentPaths.length ? `${attachmentPaths.length} attachment${attachmentPaths.length === 1 ? "" : "s"} selected` : "Add attachments"}
                  className="research-attachment-button"
                  disabled={mcpApprovalPending}
                  onClick={async () => {
                    const filePaths = await window.archicode?.pickResearchAttachmentFiles?.(
                      providerSupportsImages(chatProvider, chatModelRequest ?? undefined)
                    );
                    if (filePaths?.length) setAttachmentPaths((current) => [...new Set([...current, ...filePaths])]);
                  }}
                >
                  <Paperclip size={15} />
                  {attachmentPaths.length ? <span>{attachmentPaths.length}</span> : null}
                </IconButton>
                {attachmentPaths.length ? (
                  <IconButton
                    title="Clear attachments"
                    disabled={mcpApprovalPending}
                    onClick={() => setAttachmentPaths([])}
                  >
                    <X size={15} />
                  </IconButton>
                ) : null}
              </div>
              <div className="research-composer-secondary-actions">
                {researchBusy && selected ? (
                  <IconButton
                    title="Stop response"
                    className="research-stop-button"
                    onClick={() => void stopResearchMessage(selected.id)}
                  >
                    <Square size={15} />
                  </IconButton>
                ) : null}
                {researchContextEstimate ? (
                  <ResearchDraftContextIndicator
                    bundle={bundle}
                    baseContextCharacters={researchContextBaseCharacters}
                    detail={researchContextEstimate.detail}
                    label="Recent messages"
                    maxTokens={researchContextEstimate.maxTokens}
                    cost={researchSessionCost}
                    primary={researchPrimaryIndicator}
                    showSecondaryContextLine={false}
                  />
                ) : null}
                <MenuRoot>
                  <MenuTrigger asChild>
                    <IconButton title="Export chat" disabled={!selected}>
                      <Download size={15} />
                    </IconButton>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuLabel>Download</MenuLabel>
                    <MenuItem disabled={!selected} onSelect={() => exportChat("markdown")}>
                      <FileText size={15} /> Markdown
                    </MenuItem>
                    <MenuItem disabled={!selected} onSelect={() => exportChat("json")}>
                      <FileJson size={15} /> JSON
                    </MenuItem>
                    <MenuSeparator />
                    <MenuLabel>Clipboard</MenuLabel>
                    <MenuItem disabled={!selected} onSelect={() => void copyChat("markdown")}>
                      <Copy size={15} /> Copy Markdown
                    </MenuItem>
                    <MenuItem disabled={!selected} onSelect={() => void copyChat("json")}>
                      <Copy size={15} /> Copy JSON
                    </MenuItem>
                    <MenuSeparator />
                    <MenuLabel>AI</MenuLabel>
                    <MenuItem disabled={!selected || researchBusy} onSelect={() => void summarizeChat()}>
                      <Sparkles size={15} /> Summarize chat
                    </MenuItem>
                  </MenuContent>
                </MenuRoot>
                <ChatModelPicker
                  value={chatModelValue}
                  options={chatModelOptions}
                  disabled={!chatProvider || chatProvider.kind === "offline-manual" || mcpApprovalPending}
                  onValueChange={selectChatModel}
                />
              </div>
            </div>
            {speechSettings?.enabled && speechNotice ? (
              <small
                className={speechError ? "research-speech-status has-error" : "research-speech-status"}
                aria-live="polite"
              >
                {recordingSpeech && !speechError ? (
                  <span className="research-speech-meter" aria-hidden="true">
                    {[0, 1, 2, 3, 4].map((index) => (
                      <span key={index} />
                    ))}
                  </span>
                ) : null}
                <span>{speechNotice}</span>
              </small>
            ) : null}
            {ttsSettings?.enabled && ttsError ? (
              <small className="research-speech-status has-error" aria-live="polite">
                <span>{ttsError}</span>
              </small>
            ) : null}
            {chatExportStatus ? <small className="research-export-status" aria-live="polite">{chatExportStatus}</small> : null}
          </div>
        </div>
        )}
      </div>
      <DialogRoot open={Boolean(archiveConfirmationSession)} onOpenChange={(open) => {
        if (!open && !archiveBusy) setArchiveConfirmationSessionId(null);
      }}>
        {archiveConfirmationSession ? (
          <DialogContent
            title="Archive this chat?"
            description="Archive this chat and remove it from the active chat history."
          >
            <div className="confirm-summary">
              <div className="confirm-summary-grid">
                <span><b>Chat</b>{archiveConfirmationSession.title}</span>
                <span><b>Effect</b>The chat will no longer appear in All or Scope history.</span>
              </div>
              <p className="confirm-note">The archived chat remains stored with the project and is not permanently deleted.</p>
            </div>
            <div className="dialog-actions">
              <Button
                type="button"
                variant="danger"
                disabled={archiveBusy}
                onClick={() => void confirmResearchChatArchive()}
              >
                {archiveBusy ? <Loader2 size={15} className="is-spinning" /> : <Archive size={15} />}
                <span>Archive chat</span>
              </Button>
              <Button type="button" disabled={archiveBusy} onClick={() => setArchiveConfirmationSessionId(null)}>Cancel</Button>
            </div>
          </DialogContent>
        ) : null}
      </DialogRoot>
    </aside>
  );
});
