import { AlertCircle, Archive, BookMarked, Brain, Check, CheckCircle2, ChevronDown, ChevronUp, Circle, Copy, Download, FileJson, Files, FileText, History, ListTodo, Loader2, MessageSquare, Mic, Paperclip, Pencil, Pin, PinOff, Play, Plus, RefreshCw, Send, ShieldCheck, Sparkles, Split, Square, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Artifact, LlmUsage, ProjectBundle, ProjectMemoryNote, ProjectSettings, ResearchChatScope, ResearchChatSession } from "@shared/schema";
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

function projectMemoryScopeLabel(note: ProjectMemoryNote): string {
  if (note.scope.type === "project") return "Project";
  if (note.scope.type === "flow") return `Flow · ${note.scope.flowId}`;
  if (note.scope.type === "subflow") return `Subflow · ${note.scope.subflowId}`;
  return `Node · ${note.scope.nodeId}`;
}

export function ProjectMemoryNotesPanel({ projectRoot, refreshKey }: { projectRoot: string; refreshKey: string }) {
  const [notes, setNotes] = useState<ProjectMemoryNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.archicode) return;
    try {
      setError(null);
      setNotes(await window.archicode.listProjectMemoryNotes(projectRoot, { includeArchived }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [includeArchived, projectRoot]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh, refreshKey]);

  const update = async (note: ProjectMemoryNote, patch: { pinned?: boolean; status?: ProjectMemoryNote["status"] }) => {
    if (!window.archicode) return;
    setUpdatingId(note.id);
    try {
      await window.archicode.updateProjectMemoryNote(projectRoot, note.id, {
        expectedRevision: note.revision,
        ...patch
      });
      await refresh();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setUpdatingId(null);
    }
  };

  // Keep the chat status row focused on actionable state. The component stays
  // mounted and continues loading/refreshing, then appears as soon as a note
  // exists (or when an error needs to be surfaced).
  if (!notes.length && !error) return null;

  const label = `Project memory notes: ${notes.length}${error ? ", unavailable" : ""}`;
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button type="button" className={error ? "research-memory-panel has-error" : "research-memory-panel"} title={label} aria-label={label}>
          <BookMarked size={15} aria-hidden="true" />
          <span>{loading ? "…" : notes.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="research-memory-popover" align="start" side="bottom" sideOffset={6}>
        <div className="research-memory-popover-head">
          <strong>Project memory notes</strong>
          <div className="research-memory-badges">
            <Badge tone="neutral">Across chats</Badge>
            <Button variant="ghost" size="sm" onClick={() => setIncludeArchived((current) => !current)}>
              {includeArchived ? "Hide archived" : "Show archived"}
            </Button>
          </div>
        </div>
        <p>Small, important knowledge retained for this project. Notes are local and may be scoped to a flow, subflow, or node.</p>
        {notes.length ? (
          <div className="research-knowledge-list">
            {notes.map((note) => (
              <article key={note.id} className={`research-knowledge-card${note.status === "stale" ? " is-stale" : ""}${note.status === "archived" ? " is-archived" : ""}`}>
                <div className="research-knowledge-card-head">
                  <div>
                    <strong>{note.title}</strong>
                    <small>{projectMemoryScopeLabel(note)} · revision {note.revision}{note.status === "stale" ? " · stale" : ""}</small>
                  </div>
                  <div className="research-knowledge-actions">
                    <IconButton
                      title={note.pinned ? "Unpin memory note" : "Pin memory note"}
                      disabled={updatingId === note.id}
                      onClick={() => void update(note, { pinned: !note.pinned })}
                    >
                      {note.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                    </IconButton>
                    <IconButton
                      title={note.status === "archived" ? "Restore memory note" : "Archive memory note"}
                      disabled={updatingId === note.id}
                      onClick={() => void update(note, { status: note.status === "archived" ? "active" : "archived" })}
                    >
                      {note.status === "archived" ? <RefreshCw size={13} /> : <Archive size={13} />}
                    </IconButton>
                  </div>
                </div>
                <p>{note.body}</p>
                {note.artifactIds.length ? <small>Artifacts: {note.artifactIds.join(", ")}</small> : null}
              </article>
            ))}
          </div>
        ) : loading ? <small>Loading project memory…</small> : <small>No project memory notes yet.</small>}
        {error ? <small className="research-memory-error">{error}</small> : null}
      </PopoverContent>
    </PopoverRoot>
  );
}

export function ChatArtifactsPanel({ projectRoot, session, refreshKey }: { projectRoot: string; session: ResearchChatSession; refreshKey: string }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [preview, setPreview] = useState<{ artifactId: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!window.archicode) return;
    setError(null);
    void window.archicode.listChatArtifacts(projectRoot, session.id).then((items) => {
      if (!cancelled) setArtifacts(items);
    }).catch((loadError) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
    return () => { cancelled = true; };
  }, [projectRoot, session.id, refreshKey]);

  const readPreview = async (artifact: Artifact) => {
    if (!window.archicode) return;
    try {
      setError(null);
      const result = await window.archicode.readChatArtifact(projectRoot, session.id, artifact.id);
      setPreview({ artifactId: artifact.id, text: result.text });
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : String(readError));
    }
  };

  if (!artifacts.length) return null;
  const selectedArtifact = artifacts.find((artifact) => artifact.id === preview?.artifactId);
  const label = `Chat artifacts: ${artifacts.length}${error ? ", unavailable" : ""}`;
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button type="button" className={error ? "research-memory-panel has-error" : "research-memory-panel"} title={label} aria-label={label}>
          <Files size={15} aria-hidden="true" />
          <span>{artifacts.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="research-memory-popover" align="end" side="bottom" sideOffset={6}>
        <div className="research-memory-popover-head">
          <strong>Chat artifacts</strong>
          <Badge tone="neutral">This chat only</Badge>
        </div>
        <p>Large reports and working files created for this chat are loaded only when requested.</p>
        <div className="research-chat-artifact-layout">
          <div className="research-knowledge-list">
            {artifacts.map((artifact) => (
              <button key={artifact.id} type="button" className={preview?.artifactId === artifact.id ? "research-artifact-row is-active" : "research-artifact-row"} onClick={() => void readPreview(artifact)}>
                <strong>{artifact.title}</strong>
                <small>{artifact.mediaType ?? "text"} · revision {artifact.revision ?? 1}</small>
                {artifact.summary ? <span>{artifact.summary}</span> : null}
              </button>
            ))}
          </div>
          {preview ? (
            <div className="research-chat-artifact-preview">
              <div className="research-knowledge-card-head">
                <strong>{selectedArtifact?.title ?? "Artifact preview"}</strong>
                {selectedArtifact ? (
                  <Button variant="ghost" size="sm" onClick={() => void window.archicode.openProjectFile(projectRoot, selectedArtifact.path)}>Open file</Button>
                ) : null}
              </div>
              <pre>{preview.text.slice(0, 20_000)}</pre>
            </div>
          ) : null}
        </div>
        {error ? <small className="research-memory-error">{error}</small> : null}
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
  onArchive,
  onRename
}: {
  sessions: ResearchChatSession[];
  selectedId: string | null;
  onSelect: (sessionId: string | null) => void;
  onArchive: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
}) {
  return (
    <div className="research-history-list">
      {sessions.map((session) => (
        <div key={session.id} className={session.id === selectedId ? "research-history-row is-active" : "research-history-row"}>
          <button type="button" onClick={() => onSelect(session.id)}>
            <strong>{session.title}</strong>
            <small>{new Date(session.updatedAt).toLocaleString()}</small>
          </button>
          <IconButton title="Rename chat" onClick={() => onRename(session.id)}>
            <Pencil size={13} />
          </IconButton>
          <IconButton title="Archive chat" onClick={() => onArchive(session.id)}>
            <Archive size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
