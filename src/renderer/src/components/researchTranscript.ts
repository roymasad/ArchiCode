import { formatDateTime } from "@renderer/i18n";
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
import { visibleResearchContent } from "./researchContent";
import { safeFilePart } from "./researchTts";
import { formatResearchOrchestrationTodo } from "./ResearchMemoryPanel";


export function roleLabel(role: ResearchChatSession["messages"][number]["role"]): string {
  if (role === "assistant") return "AI Assistant";
  if (role === "user") return "You";
  return "System";
}

export function chatFileBaseName(session: ResearchChatSession): string {
  const date = new Date(session.updatedAt).toISOString().slice(0, 10);
  return `${safeFilePart(session.title)}-${date}`;
}

export function downloadTextFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let amount = value / 1024;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${Math.max(1, Math.round(amount))} ${units[unitIndex]}`;
}

export function mergeAudioChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function encodeWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  const samples = mergeAudioChunks(chunks);
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return buffer;
}

export function formatResearchChatMarkdown(session: ResearchChatSession, bundle: ProjectBundle, scopeName: string): string {
  const lines = [
    `# ${session.title}`,
    "",
    `- Project: ${bundle.project.name}`,
    `- Scope: ${scopeName}`,
    `- Created: ${formatDateTime(new Date(session.createdAt))}`,
    `- Updated: ${formatDateTime(new Date(session.updatedAt))}`,
    `- Messages: ${session.messages.length}`,
    ""
  ];

  if (session.summary.trim()) {
    lines.push("## Rolling Summary", "", session.summary.trim(), "");
  }
  const goal = session.orchestration.goal;
  if (goal) {
    lines.push("## Durable Goal", "", `${goal.objective} (${goal.status})`, "");
    appendMemoryList(lines, "Success Criteria", goal.successCriteria);
    appendMemoryList(lines, "Goal Steps", goal.steps.map((step) => `${step.title} (${step.status})${step.notes ? ` - ${step.notes}` : ""}`));
    appendMemoryList(lines, "Completion Evidence", goal.completionEvidence);
  }
  const activeWork = session.orchestration.todos.filter((item) => item.status !== "done" && item.status !== "cancelled");
  appendMemoryList(lines, "Active Work", activeWork.map(formatResearchOrchestrationTodo));
  if (hasResearchMemory(session.memory)) {
    lines.push("## Research Memory", "");
    if (session.memory.summary.trim()) lines.push(session.memory.summary.trim(), "");
    appendMemoryList(lines, "Decisions", session.memory.decisions.map((item) => item.text));
    appendMemoryList(lines, "Open Todos", session.memory.todos.filter((item) => item.status !== "done" && item.status !== "cancelled").map((item) => `${item.title}${item.notes ? ` - ${item.notes}` : ""}`));
    appendMemoryList(lines, "Open Questions", session.memory.openQuestions.filter((item) => item.status === "open").map((item) => item.question));
    appendMemoryList(lines, "Links", session.memory.links.map((item) => `${item.title ?? item.url}: ${item.url}${item.note ? ` - ${item.note}` : ""}`));
    appendMemoryList(lines, "Facts", session.memory.facts.map((item) => item.text));
    appendMemoryList(lines, "Assumptions", session.memory.assumptions.map((item) => item.text));
    if (session.memory.lastUpdateError) lines.push(`Memory update error: ${session.memory.lastUpdateError}`, "");
  }

  for (const message of session.messages) {
    lines.push(`## ${roleLabel(message.role)} - ${formatDateTime(new Date(message.createdAt))}`, "");
    lines.push(visibleResearchContent(message.content) || "_No content_", "");
    if (message.attachmentIds.length) lines.push(`Attachments: ${message.attachmentIds.join(", ")}`, "");
    if (message.mcpToolCalls?.length) {
      lines.push(`MCP tools: ${message.mcpToolCalls.map((tool) => `${tool.toolName} (${tool.status})`).join(", ")}`, "");
    }
    if (message.changeSet) {
      lines.push(`Change set: ${message.changeSet.summary}`, "");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

export function appendMemoryList(lines: string[], title: string, values: string[]): void {
  const visible = values.map((value) => value.trim()).filter(Boolean);
  if (!visible.length) return;
  lines.push(`### ${title}`, "");
  for (const value of visible) lines.push(`- ${value}`);
  lines.push("");
}

export function formatResearchChatJson(session: ResearchChatSession, bundle: ProjectBundle, scopeName: string): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    project: {
      id: bundle.project.id,
      name: bundle.project.name,
      rootPath: bundle.rootPath
    },
    scopeName,
    session
  }, null, 2);
}

export function hasResearchMemory(memory: ResearchChatSession["memory"]): boolean {
  return Boolean(
    memory.summary.trim() ||
    memory.decisions.length ||
    memory.todos.length ||
    memory.openQuestions.length ||
    memory.links.length ||
    memory.facts.length ||
    memory.assumptions.length ||
    memory.graphRefs.length ||
    memory.runRefs.length ||
    memory.debugFindings.length ||
    memory.lastUpdateError
  );
}
