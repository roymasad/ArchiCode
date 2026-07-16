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
import type { ResearchTodoCapsuleItem, ResearchTodoStatus } from "./researchContent";


export function researchTodosForSession(session: ResearchChatSession): ResearchTodoCapsuleItem[] {
  const items = [
    ...session.orchestration.todos
      .map((todo) => ({
        id: todo.id,
        kind: "orchestration" as const,
        notes: todo.notes,
        status: todo.status,
        title: todo.title
      })),
    ...session.memory.todos
      .map((todo) => ({
        id: todo.id,
        kind: "memory" as const,
        notes: todo.notes,
        status: todo.status,
        title: todo.title
      }))
  ];
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function todoStatusLabel(status: ResearchTodoStatus): string {
  if (status === "awaiting-approval") return "Awaiting approval";
  if (status === "doing") return "Doing";
  if (status === "blocked") return "Blocked";
  if (status === "done") return "Done";
  if (status === "cancelled") return "Cancelled";
  return "Open";
}

export function todoStatusTone(status: ResearchTodoStatus): "neutral" | "accent" | "success" | "warning" | "danger" {
  if (status === "done") return "success";
  if (status === "blocked") return "danger";
  if (status === "cancelled") return "neutral";
  if (status === "open") return "accent";
  return "warning";
}

export function TodoStatusIcon({ status }: { status: ResearchTodoStatus }) {
  if (status === "done") return <CheckCircle2 size={14} aria-hidden="true" />;
  if (status === "blocked") return <AlertCircle size={14} aria-hidden="true" />;
  if (status === "cancelled") return <X size={14} aria-hidden="true" />;
  if (status === "doing") return <Loader2 size={14} className="is-spinning" aria-hidden="true" />;
  if (status === "awaiting-approval") return <ShieldCheck size={14} aria-hidden="true" />;
  return <Circle size={14} aria-hidden="true" />;
}

export function ResearchTodoCapsule({ items }: { items: ResearchTodoCapsuleItem[] }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  if (!items.length) return null;

  const activeCount = items.filter((item) => item.status !== "done" && item.status !== "cancelled").length;
  const doneCount = items.filter((item) => item.status === "done").length;
  const blockedCount = items.filter((item) => item.status === "blocked").length;
  const capsuleTone = blockedCount ? "danger" : activeCount ? "warning" : "success";
  const label = `${items.length} chat todo${items.length === 1 ? "" : "s"}`;

  const clearCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const show = () => {
    clearCloseTimer();
    setOpen(true);
  };
  const hideSoon = () => {
    clearCloseTimer();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };
  const toggle = () => {
    clearCloseTimer();
    setOpen((value) => !value);
  };

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`research-todo-capsule research-todo-capsule-${capsuleTone}`}
          aria-label={label}
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
          onMouseEnter={show}
          onMouseLeave={hideSoon}
        >
          <ListTodo size={14} aria-hidden="true" />
          <span>{items.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="research-todo-popover"
        align="start"
        side="bottom"
        sideOffset={6}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="research-todo-popover-head">
          <div>
            <strong>Todo list</strong>
            <small>{activeCount ? `${activeCount} active` : "No active items"}{doneCount ? ` · ${doneCount} done` : ""}</small>
          </div>
          {blockedCount ? <Badge tone="danger">{blockedCount} blocked</Badge> : activeCount ? <Badge tone="warning">In progress</Badge> : <Badge tone="success">Complete</Badge>}
        </div>
        <ul className="research-todo-list">
          {items.map((item) => (
            <li key={`${item.kind}-${item.id}`} className={`research-todo-item research-todo-item-${item.status}`}>
              <span className="research-todo-status-icon">
                <TodoStatusIcon status={item.status} />
              </span>
              <span className="research-todo-copy">
                <strong>{item.title}</strong>
                {item.notes ? <small>{item.notes}</small> : null}
              </span>
              <Badge tone={todoStatusTone(item.status)}>{todoStatusLabel(item.status)}</Badge>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </PopoverRoot>
  );
}
