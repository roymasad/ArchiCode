import { t } from "@renderer/i18n";
import { AlertCircle, Archive, Brain, Check, CheckCircle2, ChevronDown, ChevronUp, Circle, Copy, Download, FileJson, FileText, History, ListTodo, Loader2, MessageSquare, Mic, Paperclip, Play, Plus, RefreshCw, Send, ShieldCheck, Sparkles, Split, Square, Volume2, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
  if (status === "waiting") return "Waiting";
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
  if (status === "waiting") return <History size={14} aria-hidden="true" />;
  if (status === "awaiting-approval") return <ShieldCheck size={14} aria-hidden="true" />;
  return <Circle size={14} aria-hidden="true" />;
}

export function ResearchWorkCapsule({ session, items }: { session: ResearchChatSession; items: ResearchTodoCapsuleItem[] }) {
  const goal = session.orchestration.goal;

  if (!goal && !items.length) return null;

  const goalItems: ResearchTodoCapsuleItem[] = (goal?.steps ?? []).map((step) => ({
    id: `${goal!.id}:${step.id}`,
    kind: "goal",
    notes: step.notes,
    status: step.status,
    title: step.title
  }));
  const workItems = [...goalItems, ...items];
  const activeCount = workItems.filter((item) => item.status !== "done" && item.status !== "cancelled").length;
  const doneCount = workItems.filter((item) => item.status === "done").length;
  const blockedCount = workItems.filter((item) => item.status === "blocked").length;
  const goalDoneCount = goalItems.filter((item) => item.status === "done" || item.status === "cancelled").length;
  const capsuleTone = blockedCount ? "danger" : activeCount ? "warning" : "success";
  const label = [
    goal ? `Goal: ${goal.objective}. ${goalDoneCount} of ${goalItems.length} steps complete` : undefined,
    items.length ? `${items.length} additional chat task${items.length === 1 ? "" : "s"}` : undefined
  ].filter(Boolean).join(". ");

  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`research-work-capsule research-work-capsule-${capsuleTone}`}
          aria-label={label}
        >
          <ListTodo size={14} aria-hidden="true" />
          <span>{workItems.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="research-todo-popover"
        align="start"
        side="bottom"
        sideOffset={6}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="research-todo-popover-head">
          <div>
            <strong>{goal ? t("Goal & tasks") : t("Task list")}</strong>
            <small>{goal?.objective ?? (activeCount ? `${activeCount} active` : "No active items")}</small>
          </div>
          {blockedCount ? <Badge tone="danger">{t("{{blockedCount}} blocked", { blockedCount: blockedCount })}</Badge> : activeCount ? <Badge tone="warning">{t("In progress")}</Badge> : <Badge tone="success">{t("Complete")}</Badge>}
        </div>
        <ul className="research-todo-list">
          {goalItems.length ? <li className="research-todo-group-label">{t("Goal steps")}{" "}<span>{t("{{goalDoneCount}} / {{length}}", { goalDoneCount: goalDoneCount, length: goalItems.length })}</span></li> : null}
          {goalItems.map((item) => (
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
          {items.length ? <li className="research-todo-group-label">{t("Other tasks")}{" "}<span>{items.length}</span></li> : null}
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
        {doneCount && !activeCount ? <small className="research-work-checkpoint">{t("All {{doneCount}} tracked work items are complete.", { doneCount: doneCount })}</small> : null}
        {goal?.checkpointSummary ? <small className="research-work-checkpoint">{goal.checkpointSummary}</small> : null}
      </PopoverContent>
    </PopoverRoot>
  );
}
