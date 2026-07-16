import { Bot, ChevronRight, Eye, EyeOff, FileText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { rawRunLog, runTraceGroups } from "../utils/runProgress";
import { Button, EmptyState, StatusPill, TextInput } from "./ui";

const traceColumnGap = 8;
const minTraceTimeWidth = 88;
const minTraceActionWidth = 180;
const minTraceDetailWidth = 140;
const defaultTraceColumnWidths = { time: 96, action: 260 };

function traceVisibilityKey(rootPath: string, runId: string): string {
  return `archicode-trace-cleared-before:${rootPath}:${runId}`;
}

function traceColumnWidthsKey(rootPath: string): string {
  return `archicode-trace-column-widths:${rootPath}`;
}

function readStoredTraceCutoff(rootPath: string, runId: string): string | null {
  try {
    return localStorage.getItem(traceVisibilityKey(rootPath, runId));
  } catch {
    return null;
  }
}

function readStoredTraceColumnWidths(rootPath: string): typeof defaultTraceColumnWidths {
  try {
    const raw = localStorage.getItem(traceColumnWidthsKey(rootPath));
    if (!raw) return defaultTraceColumnWidths;
    const parsed = JSON.parse(raw) as Partial<typeof defaultTraceColumnWidths>;
    return {
      time: Number.isFinite(parsed.time) ? Number(parsed.time) : defaultTraceColumnWidths.time,
      action: Number.isFinite(parsed.action) ? Number(parsed.action) : defaultTraceColumnWidths.action
    };
  } catch {
    return defaultTraceColumnWidths;
  }
}

function clampTraceColumnWidths(
  widths: typeof defaultTraceColumnWidths,
  containerWidth?: number
): typeof defaultTraceColumnWidths {
  let time = Math.max(minTraceTimeWidth, Math.round(widths.time));
  let action = Math.max(minTraceActionWidth, Math.round(widths.action));
  if (!containerWidth || !Number.isFinite(containerWidth)) return { time, action };
  const usableWidth = Math.max(0, containerWidth - traceColumnGap * 2);
  const maxTime = Math.max(minTraceTimeWidth, usableWidth - action - minTraceDetailWidth);
  time = Math.min(time, maxTime);
  const maxAction = Math.max(minTraceActionWidth, usableWidth - time - minTraceDetailWidth);
  action = Math.min(action, maxAction);
  return { time, action };
}

export function RunTrace() {
  const { bundle, rootPath, selectedRunId } = useArchicodeStore();
  const [raw, setRaw] = useState(false);
  const [query, setQuery] = useState("");
  const [clearedBefore, setClearedBefore] = useState<string | null>(null);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Record<string, boolean>>({});
  const [columnWidths, setColumnWidths] = useState(defaultTraceColumnWidths);
  const traceListRef = useRef<HTMLDivElement | null>(null);
  const columnWidthsRef = useRef(columnWidths);
  const runs = useMemo(() => [...(bundle?.runs ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [bundle]);
  const visibleRuns = useMemo(() => runs.filter((run) => !run.queueRemovedAt), [runs]);
  const selected = visibleRuns.find((run) => run.id === selectedRunId) ?? visibleRuns[0] ?? null;

  useEffect(() => {
    columnWidthsRef.current = columnWidths;
  }, [columnWidths]);

  useEffect(() => {
    if (!rootPath || !selected?.id) {
      setClearedBefore(null);
      return;
    }
    setClearedBefore(readStoredTraceCutoff(rootPath, selected.id));
  }, [rootPath, selected?.id]);

  useEffect(() => {
    setExpandedGroupIds({});
  }, [selected?.id, clearedBefore, raw]);

  useEffect(() => {
    if (!rootPath) {
      setColumnWidths(defaultTraceColumnWidths);
      return;
    }
    setColumnWidths(clampTraceColumnWidths(readStoredTraceColumnWidths(rootPath), traceListRef.current?.getBoundingClientRect().width));
  }, [rootPath]);

  const visibleLogs = useMemo(() => {
    if (!selected) return [];
    return selected.logs.filter((log) => !clearedBefore || log.at > clearedBefore);
  }, [selected, clearedBefore]);
  const visibleRun = useMemo(() => (selected ? { ...selected, logs: visibleLogs } : null), [selected, visibleLogs]);
  const traceGroups = visibleRun ? runTraceGroups(visibleRun, 120).filter((group) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${group.label} ${group.detail ?? ""} ${group.raw}`.toLowerCase().includes(needle);
  }) : [];
  const rawText = visibleRun ? rawRunLog(visibleRun) : "";
  const filteredRawText = query.trim()
    ? rawText.split("\n").filter((line) => line.toLowerCase().includes(query.trim().toLowerCase())).join("\n")
    : rawText;
  const hasStoredClear = Boolean(clearedBefore);
  const showStatusPill = !hasStoredClear || visibleLogs.length > 0;

  const persistColumnWidths = (next: typeof defaultTraceColumnWidths) => {
    setColumnWidths(next);
    if (!rootPath) return;
    try {
      localStorage.setItem(traceColumnWidthsKey(rootPath), JSON.stringify(next));
    } catch {
      // Ignore localStorage persistence errors and keep the in-memory width.
    }
  };

  const resizeColumns = (next: typeof defaultTraceColumnWidths, containerWidth?: number) => {
    persistColumnWidths(clampTraceColumnWidths(next, containerWidth ?? traceListRef.current?.getBoundingClientRect().width));
  };

  const clearTrace = () => {
    if (!rootPath || !selected) return;
    const cutoff = new Date().toISOString();
    localStorage.setItem(traceVisibilityKey(rootPath, selected.id), cutoff);
    setClearedBefore(cutoff);
  };

  const showAllTrace = () => {
    if (!rootPath || !selected) return;
    localStorage.removeItem(traceVisibilityKey(rootPath, selected.id));
    setClearedBefore(null);
  };

  const toggleGroup = (groupId: string, defaultExpanded: boolean) => {
    setExpandedGroupIds((current) => ({
      ...current,
      [groupId]: !(current[groupId] ?? defaultExpanded)
    }));
  };

  const startColumnResize = (target: "time" | "action") => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      const bounds = traceListRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const relativeX = moveEvent.clientX - bounds.left;
      if (target === "time") {
        resizeColumns(
          { ...columnWidthsRef.current, time: relativeX - traceColumnGap / 2 },
          bounds.width
        );
        return;
      }
      resizeColumns(
        {
          ...columnWidthsRef.current,
          action: relativeX - columnWidthsRef.current.time - traceColumnGap * 1.5
        },
        bounds.width
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const adjustColumnWidth = (target: "time" | "action") => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 12;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -step : step;
    if (target === "time") {
      resizeColumns({ ...columnWidths, time: columnWidths.time + delta });
      return;
    }
    resizeColumns({ ...columnWidths, action: columnWidths.action + delta });
  };

  useEffect(() => {
    const handleResize = () => resizeColumns(columnWidthsRef.current);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [rootPath]);

  const traceColumnStyle = {
    "--trace-time-width": `${columnWidths.time}px`,
    "--trace-action-width": `${columnWidths.action}px`
  } as CSSProperties;
  const timeResizerLeft = columnWidths.time + traceColumnGap / 2;
  const actionResizerLeft = columnWidths.time + traceColumnGap + columnWidths.action + traceColumnGap / 2;

  if (!selected) {
    return <EmptyState icon={<Bot size={20} />} title="No visible run selected">Run activity will appear here for runs still shown in the queue.</EmptyState>;
  }

  return (
    <div className="run-trace-panel">
      <div className="run-trace-head">
        <div className="action-row end">
          {showStatusPill ? (
            <StatusPill tone={selected.status === "failed" ? "danger" : selected.status === "succeeded" ? "success" : "accent"}>{selected.status}</StatusPill>
          ) : null}
          <TextInput className="run-trace-search" value={query} placeholder="Search trace" onChange={(event) => setQuery(event.target.value)} />
          <Button type="button" size="sm" variant={raw ? "secondary" : "primary"} onClick={() => setRaw(false)}>
            <Bot size={14} />
            <span>Compact</span>
          </Button>
          <Button type="button" size="sm" variant={raw ? "primary" : "secondary"} onClick={() => setRaw(true)}>
            <FileText size={14} />
            <span>Raw</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={hasStoredClear ? showAllTrace : clearTrace}
            disabled={!selected.logs.length && !hasStoredClear}
            title={hasStoredClear ? "Show the full saved trace again" : "Hide the current trace for this run without deleting run files or artifacts"}
          >
            {hasStoredClear ? <Eye size={14} /> : <EyeOff size={14} />}
            <span>{hasStoredClear ? "Show all" : "Clear"}</span>
          </Button>
        </div>
      </div>

      {raw ? (
        <pre className="run-log run-trace-raw">{filteredRawText || (hasStoredClear && !query.trim() ? "Trace cleared for this run. New lines will appear here." : "No matching trace lines.")}</pre>
      ) : (
        <div ref={traceListRef} className="run-progress-list run-trace-list" style={traceColumnStyle}>
          <div className="run-trace-column-guides">
            <div
              className="run-trace-column-resizer"
              style={{ left: timeResizerLeft }}
              role="separator"
              aria-label="Resize trace time column"
              aria-orientation="vertical"
              aria-valuemin={minTraceTimeWidth}
              aria-valuemax={Math.max(minTraceTimeWidth, (traceListRef.current?.getBoundingClientRect().width ?? 0) - columnWidths.action - minTraceDetailWidth - traceColumnGap * 2)}
              aria-valuenow={columnWidths.time}
              tabIndex={0}
              onKeyDown={adjustColumnWidth("time")}
              onPointerDown={startColumnResize("time")}
            />
            <div
              className="run-trace-column-resizer"
              style={{ left: actionResizerLeft }}
              role="separator"
              aria-label="Resize trace action column"
              aria-orientation="vertical"
              aria-valuemin={minTraceActionWidth}
              aria-valuemax={Math.max(minTraceActionWidth, (traceListRef.current?.getBoundingClientRect().width ?? 0) - columnWidths.time - minTraceDetailWidth - traceColumnGap * 2)}
              aria-valuenow={columnWidths.action}
              tabIndex={0}
              onKeyDown={adjustColumnWidth("action")}
              onPointerDown={startColumnResize("action")}
            />
          </div>
          {traceGroups.length ? traceGroups.map((group) => {
            const expanded = expandedGroupIds[group.id] ?? group.defaultExpanded;
            const timeLabel = group.at === group.endAt
              ? new Date(group.at).toLocaleTimeString()
              : `${new Date(group.at).toLocaleTimeString()} - ${new Date(group.endAt).toLocaleTimeString()}`;
            return (
              <section key={group.id} className={`run-trace-group run-progress-item run-progress-${group.tone}${group.detail ? "" : " no-detail"}${group.collapsible ? " is-collapsible" : ""}${expanded ? " is-expanded" : ""}`}>
                <button
                  type="button"
                  className="run-trace-group-trigger"
                  onClick={() => group.collapsible && toggleGroup(group.id, group.defaultExpanded)}
                  disabled={!group.collapsible}
                >
                  <span>{timeLabel}</span>
                  <strong>
                    {group.collapsible ? <ChevronRight size={14} className="run-trace-group-chevron" /> : null}
                    {group.label}
                  </strong>
                  <small>{group.detail ?? `${group.lineCount} line${group.lineCount === 1 ? "" : "s"}`}</small>
                </button>
                {group.collapsible && expanded ? <pre className="run-log run-trace-group-raw">{group.raw}</pre> : null}
              </section>
            );
          }) : <small>{query.trim() ? "No matching trace items." : hasStoredClear ? "Trace cleared for this run. New activity will appear here." : "Waiting for provider activity..."}</small>}
        </div>
      )}
    </div>
  );
}
