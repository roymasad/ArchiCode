import { AlertCircle, Archive, Brain, Check, CheckCircle2, ChevronDown, ChevronUp, Circle, Copy, Download, FileJson, FileText, History, ListTodo, Loader2, MessageSquare, Mic, Paperclip, Play, Plus, RefreshCw, Send, ShieldCheck, Sparkles, Split, Square, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Artifact, LlmUsage, ProjectBundle, ProjectSettings, ResearchChatScope, ResearchChatSession } from "@shared/schema";
import { deriveResearchChatContextPlan, estimateTextTokens } from "@shared/contextBudget";
import { sumLlmUsage, isAllUsageUnavailable, formatCostUsd, formatTokenCount, llmUsageTotalTokens } from "@shared/llmPricing";
import { extractArchicodeResearch } from "@shared/researchExtraction";
import { isResearchThinkingPhrase } from "@shared/researchPersonality";
import { defaultResearchScope, getActiveFlow, useArchicodeStore } from "../store/useArchicodeStore";
import { ChatComposer } from "./ChatComposer";
import { composerDraftText, serializeComposerDraft, composerHasContent } from "../store/useArchicodeStore";
import { canRetryResearchMessage } from "../utils/researchRetry";
import { localProviderUsageUnavailableDetail } from "../utils/providerProfiles";
import { ContextSizeIndicator } from "./ContextSizeIndicator";
import { Badge, Button, EmptyState, IconButton, MenuContent, MenuItem, MenuLabel, MenuRoot, MenuSeparator, MenuTrigger, PopoverContent, PopoverRoot, PopoverTrigger, ScrollArea, Select, Switch, TextArea, Tooltip } from "./ui";


export type ResearchMcpToolCall = ResearchChatSession["messages"][number]["mcpToolCalls"][number];

export function mcpToolUsageTooltip(calls: ResearchMcpToolCall[]): string {
  const grouped = new Map<string, { server: string; tool: string; count: number }>();
  for (const call of calls) {
    const server = call.serverLabel?.trim() || call.serverId;
    const key = `${call.serverId}\u0000${call.toolName}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, { server, tool: call.toolName, count: 1 });
    }
  }
  const lines = [...grouped.values()].map(({ server, tool, count }) =>
    `${server}: ${tool}${count > 1 ? ` ×${count}` : ""}`
  );
  return [`MCP ${calls.length === 1 ? "tool" : "tools"} used`, ...lines].join("\n");
}

export function mcpToolActivityLine(call: ResearchMcpToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.argumentsJson || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  const text = (key: string): string => typeof args[key] === "string" ? String(args[key]).trim() : "";
  if (call.toolName === "read_file") return `Read ${text("path") || "a project file"}`;
  if (call.toolName === "list_files") return `Listed ${text("path") || text("directory") || "the project"}${args.recursive === true ? " recursively" : ""}`;
  if (call.toolName === "search_files") return `Searched ${text("path") || text("directory") || "the project"} for “${text("query") || "a source pattern"}”`;
  if (call.toolName === "read_context") return "Loaded fuller project context";
  if (call.toolName === "read_chat_history") return "Reviewed older chat history";
  return `Used ${call.serverLabel?.trim() || call.serverId}: ${call.toolName}`;
}

export function scopeKey(scope: ResearchChatScope): string {
  if (scope.type === "project") return `project:${scope.projectId}`;
  if (scope.type === "flow") return `flow:${scope.flowId}`;
  if (scope.type === "subflow") return `subflow:${scope.flowId}:${scope.subflowId}`;
  return `node:${scope.flowId}:${scope.nodeId}`;
}

export function formatUsageSummaryLine(usage: LlmUsage): string {
  const parts = [`in ${formatTokenCount(usage.inputTokens)}`, `out ${formatTokenCount(usage.outputTokens)}`];
  if (usage.thinkingTokens) parts.push(`thinking ${formatTokenCount(usage.thinkingTokens)}`);
  if (usage.cacheReadTokens) parts.push(`cache-read ${formatTokenCount(usage.cacheReadTokens)}`);
  if (usage.cacheCreationTokens) parts.push(`cache-write ${formatTokenCount(usage.cacheCreationTokens)}`);
  if (usage.reasoningReplayState) parts.push(`reasoning-state ${usage.reasoningReplayState}`);
  parts.push(`${usage.calls} call${usage.calls === 1 ? "" : "s"}`);
  return parts.join(", ");
}

export function visibleResearchContent(content: string): string {
  const trimmed = content.trim();
  const withoutTrailingSummary = trimmed.replace(/(?:\n+\s*|\s+)Summary:\s*[\s\S]*$/i, "").trim();
  return withoutTrailingSummary || trimmed;
}

export function isImageArtifact(artifact: Artifact | undefined): artifact is Artifact {
  return Boolean(artifact?.mediaType?.startsWith("image/"));
}

export function isTextAttachmentArtifact(artifact: Artifact | undefined): artifact is Artifact {
  if (!artifact?.mediaType) return false;
  return artifact.mediaType.startsWith("text/") || [
    "application/json",
    "application/x-ndjson",
    "application/yaml",
    "application/toml",
    "application/xml",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ].includes(artifact.mediaType);
}

export function attachmentFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1]?.trim() || filePath;
}

export function isImageAttachmentPath(filePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/i.test(filePath);
}

export type ResearchContentPresentation = {
  display: string;
  pendingStructuredJson: boolean;
  speech: string;
};

export type ResearchTodoStatus = ResearchChatSession["memory"]["todos"][number]["status"] | "waiting";

export type ResearchTodoCapsuleItem = {
  id: string;
  kind: "memory" | "orchestration" | "goal";
  notes?: string;
  status: ResearchTodoStatus;
  title: string;
};

export function isLikelyStreamingJson(content: string): boolean {
  const trimmed = content.trimStart();
  return /^(?:```(?:json)?\s*)?[\[{]/i.test(trimmed);
}

export function streamingStructuredActivityLabel(content: string): string {
  if (/archicode_spawn_sherlock/i.test(content)) return "Starting Sherlock’s investigation…";
  if (/archicode_spawn_picasso|archicode_spawn_graph_reconciliation_agent/i.test(content)) return "Starting Picasso’s graph-design pass…";
  if (/archicode_spawn_merge_resolution_agent/i.test(content)) return "Preparing Solomon’s merge-resolution review…";
  if (/archicode_spawn_delphi/i.test(content)) return "Preparing Delphi’s test/runtime audit review…";
  if (/propose_graph_change_set|archicode_propose_graph_change_set/i.test(content)) return "Preparing graph change preview…";
  if (/archicode_project_(?:read|list|search)|read_file|list_files|search_files/i.test(content)) return "Archi is inspecting project evidence…";
  return "Archi is using research tools…";
}

export function proseBeforeStructuredResearchJson(content: string): string | null {
  const keyIndex = content.indexOf("\"archicodeResearch\"");
  if (keyIndex < 0) return null;
  const fenceStart = content.lastIndexOf("```", keyIndex);
  if (fenceStart >= 0 && !content.slice(fenceStart + 3, keyIndex).includes("```")) {
    return content.slice(0, fenceStart).trim();
  }
  const objectStart = content.lastIndexOf("{", keyIndex);
  if (objectStart >= 0) {
    const prefix = content.slice(0, objectStart).replace(/```(?:json)?\s*$/i, "").trim();
    return prefix;
  }
  return "";
}

export function proseBeforeStreamingJsonFence(content: string): string | null {
  const fence = /```json\b/i.exec(content);
  if (!fence) return null;
  return content.slice(0, fence.index).trim();
}

export function researchContentPresentation(content: string, streaming = false): ResearchContentPresentation {
  const visible = visibleResearchContent(content);
  const extracted = extractArchicodeResearch(visible);
  const answer = extracted.response?.answer?.trim();
  if (answer) {
    const display = visibleResearchContent(answer);
    return {
      display,
      pendingStructuredJson: false,
      speech: speechResearchContent(display)
    };
  }

  const prosePrefix = proseBeforeStructuredResearchJson(visible);
  const streamingJsonPrefix = streaming ? proseBeforeStreamingJsonFence(visible) : null;
  if (prosePrefix !== null || streamingJsonPrefix !== null || (streaming && isLikelyStreamingJson(visible))) {
    const display = prosePrefix || streamingJsonPrefix || (streaming ? streamingStructuredActivityLabel(visible) : visible);
    return {
      display,
      pendingStructuredJson: streaming && !prosePrefix && !streamingJsonPrefix,
      speech: prosePrefix || streamingJsonPrefix ? speechResearchContent(prosePrefix || streamingJsonPrefix || "") : ""
    };
  }

  return {
    display: visible,
    pendingStructuredJson: false,
    speech: speechResearchContent(visible)
  };
}

export function displayResearchContent(content: string, streaming = false): string {
  return researchContentPresentation(content, streaming).display;
}

export function readableResearchContent(content: string, streaming = false): string {
  return researchContentPresentation(content, streaming).speech;
}

export function speechResearchContent(content: string): string {
  let plain = visibleResearchContent(content)
    .replace(/\r\n?/g, "\n")
    .replace(/```[\w.-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[([^\]\n]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^) \n]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/\s+&&\s+/g, " and ");

  let previous = "";
  while (plain !== previous) {
    previous = plain;
    plain = plain
      .replace(/\*\*([^*\n][\s\S]*?)\*\*/g, "$1")
      .replace(/__([^_\n][\s\S]*?)__/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/_([^_\n]+)_/g, "$1")
      .replace(/~~([^~\n]+)~~/g, "$1");
  }

  return plain
    .replace(/\bArchiCode\b/g, "Archy Code")
    .replace(/\bArchi\b/g, "Archy")
    .replace(/[`*]+/g, "")
    .replace(/[<>]/g, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function highlightResearchContent(content: string): string {
  return visibleResearchContent(content)
    .replace(/\r\n?/g, "\n")
    .replace(/```[\w.-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[([^\]\n]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^) \n]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/\*\*([^*\n][\s\S]*?)\*\*/g, "$1")
    .replace(/__([^_\n][\s\S]*?)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/[`*]+/g, "")
    .replace(/[<>]/g, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
