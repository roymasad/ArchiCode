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


export function ttsElapsed(startedAtMs?: number | null): string {
  return typeof startedAtMs === "number" ? `+${Math.max(0, Date.now() - startedAtMs)}ms` : "+?ms";
}

export const ttsConsoleDebugEnabled = false;
export const ttsFileDebugEnabled = false;
export const streamingTtsMinChars = 40;
export const streamingTtsMaxPendingChars = 90;
export const streamingTtsMinPrepareUnitChars = 24;

export function ttsConsoleInfo(message: string): void {
  if (ttsConsoleDebugEnabled) console.info(message);
}

export type StreamingTtsState = {
  consumedContentChars: number;
  debugStartedAtMs: number;
  finalized: boolean;
  messageId: string;
  pendingContent: string;
  playbackRunId: number;
  sessionId: string;
};

export type TtsDebugContext = {
  logId: string;
  messageId: string;
  path?: string;
  playbackRunId: number;
  sequence: number;
  sessionId: string | null;
  startedAtMs: number;
};

export type PendingTtsSpeechJob = {
  chunks: Map<number, { buffer: AudioBuffer; durationMs: number; sourceTotal: number; text?: string; workerIndex?: number }>;
  messageId: string;
  nextLocalIndex: number;
  playbackRunId: number;
  total: number | null;
};

export type PendingTtsStartWaiter = {
  playbackRunId: number;
  resolve: (started: boolean) => void;
};

export const maxActiveTtsSpeechJobs = 3;

export function safeTtsDebugPart(value: string | number | null | undefined): string {
  const cleaned = String(value ?? "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "unknown";
}

export function makeTtsDebugLogId(sessionId: string | null, messageId: string, playbackRunId: number, startedAtMs: number): string {
  const timestamp = new Date(startedAtMs).toISOString().replace(/[:.]/g, "-");
  return `tts-${timestamp}-${safeTtsDebugPart(sessionId)}-${safeTtsDebugPart(messageId)}-run-${playbackRunId}`;
}

export function previewTtsText(text: string | null | undefined, maxLength = 240): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function displayTtsHighlightText(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  return text
    .replace(/\bArchy Code\b/g, "ArchiCode")
    .replace(/\bArchy\b/g, "Archi");
}

export type TtsPrepareUnit = {
  highlightText?: string;
  text: string;
};

export function splitTtsPrepareUnitText(text: string): string[] {
  const normalized = text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];
  const units: string[] = [];
  for (const block of normalized.split(/\n+/)) {
    const trimmedBlock = block.trim();
    if (!trimmedBlock) continue;
    const sentences = trimmedBlock.match(/[^.!?]+[.!?]+["')\]]?|[^.!?]+$/g) ?? [trimmedBlock];
    for (const sentence of sentences) {
      const compact = sentence.replace(/\s+/g, " ").trim();
      if (!compact) continue;
      if (compact.length <= streamingTtsMaxPendingChars) {
        units.push(compact);
        continue;
      }
      const clauses = compact.split(/(?<=[,;:])\s+/);
      if (clauses.length <= 1) {
        units.push(compact);
        continue;
      }
      let current = "";
      for (const clause of clauses) {
        const candidate = current ? `${current} ${clause}` : clause;
        if (current && candidate.length > streamingTtsMaxPendingChars) {
          units.push(current);
          current = clause;
        } else {
          current = candidate;
        }
      }
      if (current) units.push(current);
    }
  }
  const mergedUnits: string[] = [];
  for (const unit of units.length ? units : [normalized]) {
    const previous = mergedUnits.at(-1);
    if (previous && previous.length < streamingTtsMinPrepareUnitChars) {
      mergedUnits[mergedUnits.length - 1] = `${previous} ${unit}`.trim();
    } else {
      mergedUnits.push(unit);
    }
  }
  if (mergedUnits.length > 1 && mergedUnits[mergedUnits.length - 1].length < streamingTtsMinPrepareUnitChars) {
    const tail = mergedUnits.pop();
    if (tail) mergedUnits[mergedUnits.length - 1] = `${mergedUnits[mergedUnits.length - 1]} ${tail}`.trim();
  }
  return mergedUnits;
}

export function splitTtsPrepareUnits(text: string, highlightText?: string): TtsPrepareUnit[] {
  const units = splitTtsPrepareUnitText(text);
  return units.map((unit) => ({
    text: unit,
    highlightText: units.length === 1 ? highlightText : displayTtsHighlightText(unit)
  }));
}

export type StreamingSpeechPrefixDecision = {
  clauseCut: number;
  final: boolean;
  newlineCut: number;
  pendingChars: number;
  reason: string;
  result: { spoken: string; remainder: string } | null;
  sentenceCutEnd: number | null;
};

export function inspectStreamingSpeechPrefix(text: string, final: boolean): StreamingSpeechPrefixDecision {
  const normalized = text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  const trimmed = normalized.trimStart();
  const leadingTrim = normalized.length - trimmed.length;
  if (!trimmed) {
    return {
      clauseCut: -1,
      final,
      newlineCut: -1,
      pendingChars: 0,
      reason: "empty",
      result: null,
      sentenceCutEnd: null
    };
  }
  if (final) {
    return {
      clauseCut: -1,
      final,
      newlineCut: -1,
      pendingChars: trimmed.length,
      reason: "final-tail",
      result: { spoken: trimmed.trim(), remainder: "" },
      sentenceCutEnd: trimmed.length
    };
  }

  const sentenceMatches = [...trimmed.matchAll(/[.!?]["')\]]?(?:\s+|\n+|$)/g)];
  const sentenceCut = sentenceMatches.at(-1);
  const sentenceCutEnd = sentenceCut?.index === undefined ? null : sentenceCut.index + sentenceCut[0].length;
  if (sentenceCutEnd !== null && sentenceCutEnd >= streamingTtsMinChars) {
    const cut = leadingTrim + sentenceCut!.index! + sentenceCut![0].length;
    return {
      clauseCut: -1,
      final,
      newlineCut: trimmed.lastIndexOf("\n"),
      pendingChars: trimmed.length,
      reason: "sentence-boundary",
      result: { spoken: normalized.slice(0, cut).trim(), remainder: normalized.slice(cut) },
      sentenceCutEnd
    };
  }

  const newlineCut = trimmed.lastIndexOf("\n");
  if (newlineCut >= streamingTtsMinChars) {
    const cut = leadingTrim + newlineCut + 1;
    return {
      clauseCut: -1,
      final,
      newlineCut,
      pendingChars: trimmed.length,
      reason: "newline-boundary",
      result: { spoken: normalized.slice(0, cut).trim(), remainder: normalized.slice(cut) },
      sentenceCutEnd
    };
  }

  const clauseCut = Math.max(trimmed.lastIndexOf(", "), trimmed.lastIndexOf("; "), trimmed.lastIndexOf(": "));
  if (trimmed.length >= streamingTtsMaxPendingChars) {
    if (clauseCut >= streamingTtsMinChars) {
      const cut = leadingTrim + clauseCut + 2;
      return {
        clauseCut,
        final,
        newlineCut,
        pendingChars: trimmed.length,
        reason: "clause-boundary",
        result: { spoken: normalized.slice(0, cut).trim(), remainder: normalized.slice(cut) },
        sentenceCutEnd
      };
    }
  }

  return {
    clauseCut,
    final,
    newlineCut,
    pendingChars: trimmed.length,
    reason: trimmed.length < streamingTtsMaxPendingChars ? "below-max-without-boundary" : "max-reached-without-safe-boundary",
    result: null,
    sentenceCutEnd
  };
}

export function takeStreamingSpeechPrefix(text: string, final: boolean): { spoken: string; remainder: string } | null {
  return inspectStreamingSpeechPrefix(text, final).result;
}

export async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection-based copy path.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy failed.");
}

export function safeFilePart(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "research-chat";
}

