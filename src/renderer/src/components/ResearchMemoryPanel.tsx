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


export function ResearchMemoryPanel({ session }: { session: ResearchChatSession }) {
  const memory = session.memory;
  const activeWork = session.orchestration.todos.filter((todo) => todo.status !== "done" && todo.status !== "cancelled");
  const openTodos = memory.todos.filter((todo) => todo.status !== "done" && todo.status !== "cancelled");
  const openQuestions = memory.openQuestions.filter((question) => question.status === "open");
  const decisions = memory.decisions;
  const links = memory.links;
  const facts = memory.facts;
  const assumptions = memory.assumptions;
  const graphRefs = memory.graphRefs;
  const runRefs = memory.runRefs;
  const fileRefs = memory.fileRefs;
  const artifactRefs = memory.artifactRefs;
  const imageRefs = memory.imageRefs;
  const debugFindings = memory.debugFindings;
  const itemCount = [
    memory.summary.trim() ? 1 : 0,
    activeWork.length,
    memory.decisions.length,
    openTodos.length,
    openQuestions.length,
    memory.links.length,
    memory.facts.length,
    memory.assumptions.length,
    memory.graphRefs.length,
    memory.runRefs.length,
    memory.fileRefs.length,
    memory.artifactRefs.length,
    memory.imageRefs.length,
    memory.debugFindings.length,
    memory.lastUpdateError ? 1 : 0
  ].reduce((total, count) => total + count, 0);
  const detailParts = [
    memory.summary.trim() ? "summary" : null,
    activeWork.length ? `${activeWork.length} active work item${activeWork.length === 1 ? "" : "s"}` : null,
    memory.decisions.length ? `${memory.decisions.length} decision${memory.decisions.length === 1 ? "" : "s"}` : null,
    openTodos.length ? `${openTodos.length} todo${openTodos.length === 1 ? "" : "s"}` : null,
    openQuestions.length ? `${openQuestions.length} question${openQuestions.length === 1 ? "" : "s"}` : null,
    memory.links.length ? `${memory.links.length} link${memory.links.length === 1 ? "" : "s"}` : null,
    memory.facts.length ? `${memory.facts.length} fact${memory.facts.length === 1 ? "" : "s"}` : null,
    memory.assumptions.length ? `${memory.assumptions.length} assumption${memory.assumptions.length === 1 ? "" : "s"}` : null,
    memory.graphRefs.length ? `${memory.graphRefs.length} graph ref${memory.graphRefs.length === 1 ? "" : "s"}` : null,
    memory.runRefs.length ? `${memory.runRefs.length} run ref${memory.runRefs.length === 1 ? "" : "s"}` : null,
    memory.fileRefs.length ? `${memory.fileRefs.length} file ref${memory.fileRefs.length === 1 ? "" : "s"}` : null,
    memory.artifactRefs.length ? `${memory.artifactRefs.length} artifact ref${memory.artifactRefs.length === 1 ? "" : "s"}` : null,
    memory.imageRefs.length ? `${memory.imageRefs.length} image ref${memory.imageRefs.length === 1 ? "" : "s"}` : null,
    memory.debugFindings.length ? `${memory.debugFindings.length} debug finding${memory.debugFindings.length === 1 ? "" : "s"}` : null,
    memory.lastUpdateError ? "update error" : null
  ].filter(Boolean).join(", ");
  const label = `Research memory: ${detailParts || "empty"}`;

  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button type="button" className={memory.lastUpdateError ? "research-memory-panel has-error" : "research-memory-panel"} title={label} aria-label={label}>
          <Brain size={15} aria-hidden="true" />
          <span>{itemCount}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="research-memory-popover" align="start" side="bottom" sideOffset={6}>
        <div className="research-memory-popover-head">
          <strong>Research memory</strong>
          <div className="research-memory-badges">
            {activeWork.length ? <Badge tone="accent">{activeWork.length} active</Badge> : null}
            {openTodos.length ? <Badge tone="warning">{openTodos.length} todo{openTodos.length === 1 ? "" : "s"}</Badge> : null}
            {openQuestions.length ? <Badge tone="accent">{openQuestions.length} question{openQuestions.length === 1 ? "" : "s"}</Badge> : null}
            {memory.links.length ? <Badge tone="neutral">{memory.links.length} link{memory.links.length === 1 ? "" : "s"}</Badge> : null}
          </div>
        </div>
        {memory.summary.trim() ? <p>{memory.summary.trim()}</p> : null}
        <div className="research-memory-grid">
          {activeWork.length ? <MemoryList title="Active work" items={activeWork.map(formatResearchOrchestrationTodo)} /> : null}
          {decisions.length ? <MemoryList title="Decisions" items={decisions.map((item) => item.text)} /> : null}
          {openTodos.length ? <MemoryList title="Todos" items={openTodos.map((item) => `${item.title}${item.notes ? ` - ${item.notes}` : ""}`)} /> : null}
          {openQuestions.length ? <MemoryList title="Questions" items={openQuestions.map((item) => item.question)} /> : null}
          {links.length ? <MemoryList title="Links" items={links.map((item) => item.title ? `${item.title}: ${item.url}` : item.url)} /> : null}
          {facts.length ? <MemoryList title="Facts" items={facts.map((item) => item.text)} /> : null}
          {assumptions.length ? <MemoryList title="Assumptions" items={assumptions.map((item) => item.text)} /> : null}
          {graphRefs.length ? <MemoryList title="Graph refs" items={graphRefs.map(formatMemoryGraphRef)} /> : null}
          {runRefs.length ? <MemoryList title="Run refs" items={runRefs.map(formatMemoryRunRef)} /> : null}
          {fileRefs.length ? <MemoryList title="File refs" items={fileRefs.map(formatMemoryFileRef)} /> : null}
          {artifactRefs.length ? <MemoryList title="Artifact refs" items={artifactRefs.map(formatMemoryArtifactRef)} /> : null}
          {imageRefs.length ? <MemoryList title="Image refs" items={imageRefs.map(formatMemoryImageRef)} /> : null}
          {debugFindings.length ? <MemoryList title="Debug" items={debugFindings.map((item) => item.text)} /> : null}
        </div>
        {memory.lastUpdateError ? <small className="research-memory-error">Memory update failed: {memory.lastUpdateError}</small> : null}
      </PopoverContent>
    </PopoverRoot>
  );
}

export function formatResearchOrchestrationTodo(todo: ResearchChatSession["orchestration"]["todos"][number]): string {
  const details = [todo.status, todo.notes].filter(Boolean).join(" - ");
  return `${todo.title}${details ? ` (${details})` : ""}`;
}

export function formatMemoryGraphRef(ref: ResearchChatSession["memory"]["graphRefs"][number]): string {
  const label = ref.title || ref.nodeId || ref.subflowId || ref.flowId || "Graph reference";
  const ids = [ref.kind, ref.flowId, ref.subflowId, ref.nodeId].filter(Boolean).join(" / ");
  return `${label}${ids ? ` (${ids})` : ""}${ref.note ? ` - ${ref.note}` : ""}`;
}

export function formatMemoryRunRef(ref: ResearchChatSession["memory"]["runRefs"][number]): string {
  const label = ref.title || ref.runId;
  const details = [ref.status, ref.note].filter(Boolean).join(" - ");
  return `${label}${details ? ` (${details})` : ""}`;
}

export function formatMemoryFileRef(ref: ResearchChatSession["memory"]["fileRefs"][number]): string {
  return `${ref.title || ref.path}${ref.title ? ` (${ref.path})` : ""}${ref.note ? ` - ${ref.note}` : ""}`;
}

export function formatMemoryArtifactRef(ref: ResearchChatSession["memory"]["artifactRefs"][number]): string {
  const label = ref.title || ref.artifactId;
  const details = [ref.type, ref.path, ref.note].filter(Boolean).join(" - ");
  return `${label}${details ? ` (${details})` : ""}`;
}

export function formatMemoryImageRef(ref: ResearchChatSession["memory"]["imageRefs"][number]): string {
  const label = ref.title || ref.artifactId;
  const details = [ref.mediaType, ref.visualSummary, ...ref.relevantFindings].filter(Boolean).join(" - ");
  return `${label}${details ? ` (${details})` : ""}`;
}

export function MemoryList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="research-memory-list">
      <span>{title}</span>
      <ul>
        {items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
      </ul>
    </div>
  );
}

export function ResearchHistoryList({
  sessions,
  selectedId,
  onSelect,
  onArchive
}: {
  sessions: ResearchChatSession[];
  selectedId: string | null;
  onSelect: (sessionId: string | null) => void;
  onArchive: (sessionId: string) => void;
}) {
  return (
    <div className="research-history-list">
      {sessions.map((session) => (
        <div key={session.id} className={session.id === selectedId ? "research-history-row is-active" : "research-history-row"}>
          <button type="button" onClick={() => onSelect(session.id)}>
            <strong>{session.title}</strong>
            <small>{new Date(session.updatedAt).toLocaleString()}</small>
          </button>
          <IconButton title="Archive chat" onClick={() => onArchive(session.id)}>
            <Archive size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
