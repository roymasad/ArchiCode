import { formatDateTime } from "@renderer/i18n";
import { t } from "@renderer/i18n";
import { AlertTriangle, Bot, Check, CheckCircle2, ChevronDown, ChevronUp, ClipboardList, FileDiff, GitBranch, Loader2, MessageSquare, MoreHorizontal, MoveUpRight, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ReactNode } from "react";
import type { Artifact, Note, Run } from "@shared/schema";
import type { ProjectMaintenanceChangedFile } from "@shared/projectMaintenance";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { collectRunErrors } from "../utils/runErrors";
import { planArtifactBadgeLabel, planArtifactDerivedDisplay, planArtifactListLabel } from "../utils/planArtifacts";
import { runFailureStatusLabel, runFailureTone } from "../utils/runFailureTaxonomy";
import { isRunBlockingNewChange } from "../utils/runStatus";
import { ArtifactPreview } from "./ArtifactBrowser";
import { ProjectConsole } from "./ProjectConsole";
import { RunConsole } from "./RunConsole";
import { RunTrace } from "./RunTrace";
import { GitActivityLog } from "./GitActivityLog";
import { Badge, Button, IconButton, MenuContent, MenuItem, MenuLabel, MenuRoot, MenuSeparator, MenuTrigger, PopoverContent, PopoverRoot, PopoverTrigger, TabsContent, TabsList, TabsRoot, TabsTrigger, TextArea, Tooltip } from "./ui";

type SettingsAndRunsProps = {
  open: boolean;
  height: number;
  onToggleOpen: () => void;
  panelAction?: ReactNode;
  showCollapseControl?: boolean;
};

const optionalActivityTabs = [
  { value: "plans", label: t("Plan"), icon: ClipboardList },
  { value: "diffs", label: t("Source Changes"), icon: FileDiff },
  { value: "git", label: t("Git"), icon: GitBranch },
  { value: "questions", label: t("Questions"), icon: MessageSquare }
] as const;
const optionalActivityTabValues: string[] = optionalActivityTabs.map((tab) => tab.value);
const defaultActivityTab = "runs";

function hasLiveTrace(run: Run): boolean {
  return [
    "running",
    "needs-permission",
    "planning",
    "awaiting-plan-review",
    "coding",
    "awaiting-code-review",
    "debugging",
    "verifying"
  ].includes(run.status) && run.logs.length > 0;
}

export function SettingsAndRuns({ open, height, onToggleOpen, panelAction, showCollapseControl = true }: SettingsAndRunsProps) {
  const { bundle, rootPath, selectRun, selectNode, addNote, updateNoteResolved, dismissRunError, setWorkbenchView, refreshProjectFiles, selectProjectFile } = useArchicodeStore(useShallow((state) => ({
    bundle: state.bundle,
    rootPath: state.rootPath,
    selectRun: state.selectRun,
    selectNode: state.selectNode,
    addNote: state.addNote,
    updateNoteResolved: state.updateNoteResolved,
    dismissRunError: state.dismissRunError,
    setWorkbenchView: state.setWorkbenchView,
    refreshProjectFiles: state.refreshProjectFiles,
    selectProjectFile: state.selectProjectFile
  })));
  const [activeTab, setActiveTab] = useState(defaultActivityTab);
  const [visibleOptionalTabs, setVisibleOptionalTabs] = useState<string[]>([]);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [maintenance, setMaintenance] = useState<Awaited<ReturnType<typeof window.archicode.getProjectMaintenanceStatus>> | null>(null);
  const [maintenancePopoverOpen, setMaintenancePopoverOpen] = useState(false);
  const [maintenanceTooltipOpen, setMaintenanceTooltipOpen] = useState(false);
  const activityTabListRef = useRef<HTMLDivElement | null>(null);

  const planArtifacts = (bundle?.artifacts ?? []).filter((artifact) => artifact.type === "plan").slice(-8);
  const codeReviewArtifacts = (bundle?.artifacts ?? [])
    .filter((artifact) => artifact.type === "diff")
    .slice(-8);
  const openQuestions = (bundle?.notes ?? []).filter((note) => note.kind === "llm-question" && !note.resolved);
  const nodeTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const flow of bundle?.flows ?? []) {
      for (const node of flow.nodes) titles.set(node.id, node.title);
    }
    return titles;
  }, [bundle]);
  const runErrors = collectRunErrors(bundle?.runs ?? []);
  const queueIsLive = (bundle?.runs ?? []).some((run) => isRunBlockingNewChange(run) && !run.queueRemovedAt);
  const traceIsLive = (bundle?.runs ?? []).some(hasLiveTrace);
  const collapseControlTitle = open && queueIsLive
    ? "Activity stays open while a run is in progress"
    : open
      ? "Collapse activity panel"
      : "Expand activity panel";
  const setPersistedActiveTab = (value: string) => {
    setActiveTab(value);
    if (rootPath) localStorage.setItem(`archicode-activity-tab:${rootPath}`, value);
  };

  const persistVisibleOptionalTabs = (values: string[]) => {
    const next = optionalActivityTabs
      .map((tab) => tab.value)
      .filter((value) => values.includes(value));
    setVisibleOptionalTabs(next);
    if (rootPath) localStorage.setItem(`archicode-activity-visible-tabs:${rootPath}`, JSON.stringify(next));
  };

  const showOptionalTab = (value: string, activate = true) => {
    if (!optionalActivityTabValues.includes(value as (typeof optionalActivityTabValues)[number])) return;
    persistVisibleOptionalTabs([...visibleOptionalTabs, value]);
    if (activate) setPersistedActiveTab(value);
  };

  const hideOptionalTab = (value: string) => {
    if (!optionalActivityTabValues.includes(value as (typeof optionalActivityTabValues)[number])) return;
    persistVisibleOptionalTabs(visibleOptionalTabs.filter((item) => item !== value));
    if (activeTab === value) setPersistedActiveTab("console");
  };

  const toggleOptionalTab = (value: string) => {
    if (visibleOptionalTabs.includes(value)) hideOptionalTab(value);
    else showOptionalTab(value);
  };

  useEffect(() => {
    if (!open) return;
    const tabList = activityTabListRef.current;
    if (!tabList) return;
    const scrollActivityTabs = (event: WheelEvent) => {
      const maxScrollLeft = tabList.scrollWidth - tabList.clientWidth;
      if (maxScrollLeft <= 0) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, tabList.scrollLeft + delta));
      if (nextScrollLeft === tabList.scrollLeft) return;
      event.preventDefault();
      tabList.scrollLeft = nextScrollLeft;
    };
    tabList.addEventListener("wheel", scrollActivityTabs, { passive: false });
    return () => tabList.removeEventListener("wheel", scrollActivityTabs);
  }, [open]);

  useEffect(() => {
    if (!rootPath || !window.archicode?.getProjectMaintenanceStatus) {
      setMaintenance(null);
      return;
    }
    let disposed = false;
    void window.archicode.getProjectMaintenanceStatus(rootPath)
      .then((status) => { if (!disposed) setMaintenance(status); })
      .catch(() => undefined);
    const unsubscribe = window.archicode.onProjectMaintenanceUpdated?.((status) => {
      if (!disposed && status.projectRoot === rootPath) setMaintenance(status);
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [rootPath]);

  const openMaintenanceFile = async (changedFile: ProjectMaintenanceChangedFile) => {
    setMaintenancePopoverOpen(false);
    setWorkbenchView("files");
    await refreshProjectFiles();
    await selectProjectFile(changedFile.path, { preferredTab: changedFile.change === "deleted" ? "diff" : "preview" });
  };

  const ignoreMaintenanceWarning = async () => {
    if (!rootPath) return;
    const status = await window.archicode.dismissProjectMaintenanceWarning(rootPath);
    setMaintenance(status);
    setMaintenancePopoverOpen(false);
  };

  const openCodebaseResync = () => {
    setMaintenancePopoverOpen(false);
    window.dispatchEvent(new CustomEvent("archicode:open-codebase-resync"));
  };

  useEffect(() => {
    if (!rootPath) return;
    const visibleKey = `archicode-activity-visible-tabs:${rootPath}`;
    const savedVisible = localStorage.getItem(visibleKey);
    const nextVisible: string[] = (() => {
      if (!savedVisible) return [];
      try {
        const parsed = JSON.parse(savedVisible) as unknown;
        if (!Array.isArray(parsed)) return [];
        return optionalActivityTabs
          .map((tab): string => tab.value)
          .filter((value) => parsed.includes(value));
      } catch {
        return [];
      }
    })();
    const saved = localStorage.getItem(`archicode-activity-tab:${rootPath}`);
    if (saved && optionalActivityTabValues.includes(saved as (typeof optionalActivityTabValues)[number]) && !nextVisible.includes(saved)) {
      nextVisible.push(saved);
    }
    setVisibleOptionalTabs(nextVisible);
    if (saved) setActiveTab(saved);
  }, [rootPath]);

  useEffect(() => {
    const listener = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      if (typeof next !== "string") return;
      if (optionalActivityTabValues.includes(next as (typeof optionalActivityTabValues)[number])) showOptionalTab(next);
      else setPersistedActiveTab(next);
    };
    window.addEventListener("archicode:set-activity-tab", listener);
    return () => window.removeEventListener("archicode:set-activity-tab", listener);
  }, [rootPath, visibleOptionalTabs]);

  const openQuestionTarget = (question: Note) => {
    selectNode(question.nodeId);
    window.dispatchEvent(new CustomEvent("archicode:focus-note", {
      detail: {
        noteId: question.id,
        nodeId: question.nodeId
      }
    }));
  };

  const answerQuestion = async (question: Note) => {
    const answer = questionAnswers[question.id]?.trim();
    if (!answer) return;
    await addNote({
      flowId: question.flowId,
      nodeId: question.nodeId,
      kind: "user-answer",
      author: "user",
      body: answer,
      category: "decision",
      priority: question.priority,
      replyToNoteId: question.id,
      resolved: true
    });
    await updateNoteResolved(question.id, true);
    setQuestionAnswers((current) => {
      const next = { ...current };
      delete next[question.id];
      return next;
    });
  };

  const letAiDecideQuestion = async (question: Note) => {
    await addNote({
      flowId: question.flowId,
      nodeId: question.nodeId,
      kind: "user-answer",
      author: "user",
      body: "Let the agent decide. Make a reasonable assumption and continue.",
      category: "decision",
      priority: question.priority,
      replyToNoteId: question.id,
      resolved: true
    });
    await updateNoteResolved(question.id, true);
    setQuestionAnswers((current) => {
      const next = { ...current };
      delete next[question.id];
      return next;
    });
  };

  return (
    <aside
      className={open ? "activity-panel is-open" : "activity-panel"}
      aria-label={t("Runs and artifacts")}
      style={open ? { height } : undefined}
    >
      <div className="activity-panel-header">
        <div>
          <strong>{t("Activity")}</strong>
        </div>
        <div className="activity-summary">
          {maintenance && (maintenance.state === "scheduled" || maintenance.state === "running") ? (
            <Tooltip content={maintenance.message}>
              <span className="activity-maintenance-indicator is-running" role="status" aria-label={maintenance.message}>
                <Loader2 size={15} className="is-spinning" />
              </span>
            </Tooltip>
          ) : maintenance?.state === "error" ? (
            <Tooltip content={t("{{message}}{{value2}} Click to retry.", { message: maintenance.message, value2: maintenance.error ?? "" })}>
              <button
                type="button"
                className="activity-maintenance-indicator is-error"
                aria-label={t("Background code-data refresh failed; retry")}
                onClick={() => rootPath && void window.archicode.retryProjectMaintenance(rootPath).then(setMaintenance)}
              >
                <AlertTriangle size={15} />
              </button>
            </Tooltip>
          ) : maintenance?.graphAnalysisMayBeOutdated ? (
            <Tooltip
              open={maintenancePopoverOpen ? false : maintenanceTooltipOpen}
              onOpenChange={(nextOpen) => {
                if (!maintenancePopoverOpen) setMaintenanceTooltipOpen(nextOpen);
              }}
              content={(
                <span className="activity-maintenance-tooltip">
                  <strong>{t("Code change detected since ArchiCode last analyzed the architecture graph.")}</strong>
                  <span>{t("Code Knowledge and the enabled semantic index were refreshed. Graph nodes cannot be changed automatically; they require review.")}</span>
                  <span>{t("Click to review the changed files, open them, resync the codebase, or ignore this warning.")}</span>
                </span>
              )}
            >
              <span className="activity-maintenance-trigger-shell">
                <PopoverRoot
                  open={maintenancePopoverOpen}
                  onOpenChange={(nextOpen) => {
                    setMaintenancePopoverOpen(nextOpen);
                    if (nextOpen) setMaintenanceTooltipOpen(false);
                  }}
                >
                  <PopoverTrigger asChild>
                    <button type="button" className="activity-maintenance-indicator is-warning" aria-label={t("Review files changed since graph analysis")}>
                      <AlertTriangle size={15} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="activity-maintenance-popover"
                    align="end"
                    side="top"
                    sideOffset={8}
                    onCloseAutoFocus={(event) => event.preventDefault()}
                  >
                    <div className="activity-maintenance-popover-head">
                      <AlertTriangle size={16} />
                      <div>
                        <strong>{t("Source changed outside ArchiCode")}</strong>
                        <small>{t("The Code Knowledge Map and enabled semantic index are current. The architecture graph was left unchanged.")}</small>
                      </div>
                    </div>
                    <div className="activity-maintenance-files">
                      <strong>{t("{{length}} changed file {{value2}}", { length: maintenance.changedFiles.length, value2: maintenance.changedFiles.length === 1 ? "" : "s" })}</strong>
                      {maintenance.changedFiles.length ? (
                        <div className="activity-maintenance-file-list" aria-label={t("Files changed since graph analysis")}>
                          {maintenance.changedFiles.map((changedFile) => (
                            <button type="button" key={changedFile.path} onClick={() => void openMaintenanceFile(changedFile)}>
                              <FileDiff size={14} />
                              <code>{changedFile.path}</code>
                              <Badge tone={changedFile.change === "deleted" ? "danger" : changedFile.change === "added" ? "success" : "warning"}>{changedFile.change}</Badge>
                            </button>
                          ))}
                        </div>
                      ) : <small>{t("The exact paths were unavailable for this older warning.")}</small>}
                    </div>
                    <small>{t("Resync compares the architecture graph with current code. Ignore clears this notice without changing the graph.")}</small>
                    <div className="activity-maintenance-actions">
                      <Button type="button" size="sm" variant="secondary" onClick={() => void ignoreMaintenanceWarning()}>{t("Ignore")}</Button>
                      <Button type="button" size="sm" onClick={openCodebaseResync}>{t("Resync codebase")}</Button>
                    </div>
                  </PopoverContent>
                </PopoverRoot>
              </span>
            </Tooltip>
          ) : null}
          {panelAction}
          {runErrors.length ? <Badge tone="danger">{t("{{length}} issues", { length: runErrors.length })}</Badge> : null}
          {showCollapseControl ? (
            <IconButton title={collapseControlTitle} onClick={onToggleOpen}>
              {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </IconButton>
          ) : null}
        </div>
      </div>

      {open ? (
        <TabsRoot value={activeTab} onValueChange={setPersistedActiveTab} className="activity-tabs">
          <TabsList ref={activityTabListRef} className="ui-tabs-list compact activity-tab-list">
            <TabsTrigger
              value="runs"
              className={queueIsLive ? "is-queue-live" : undefined}
              aria-label={queueIsLive ? t("Queue, active run in progress") : t("Queue")}
            >
              <Terminal size={14} />
              {t("Queue")}{" "}{queueIsLive ? <span className="queue-live-chip" aria-hidden="true"><span className="queue-live-dot" /> {" "}{t("Live")}</span> : null}
            </TabsTrigger>
            <TabsTrigger
              value="trace"
              className={traceIsLive ? "is-trace-live" : undefined}
              aria-label={traceIsLive ? t("Trace, live output updating") : t("Trace")}
            >
              <Bot size={14} />
              {t("Trace")}{" "}{traceIsLive ? <span className="trace-live-chip" aria-hidden="true"><span className="trace-live-dot" /> {" "}{t("Live")}</span> : null}
            </TabsTrigger>
            <TabsTrigger value="errors">
              <AlertTriangle size={14} />
              {t("Errors")}{" "}</TabsTrigger>
            <TabsTrigger value="console">
              <Terminal size={14} />
              {t("Console")}{" "}</TabsTrigger>
            {optionalActivityTabs.filter((tab) => visibleOptionalTabs.includes(tab.value)).map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} className="activity-secondary-active-tab">
                <Icon size={14} />
                {label}
                {value === "questions" && openQuestions.length ? <Badge tone="warning">{openQuestions.length}</Badge> : null}
              </TabsTrigger>
            ))}
            <MenuRoot>
              <MenuTrigger asChild>
                <button type="button" className="activity-more-tabs-trigger" aria-label={t("More activity views")}>
                  <MoreHorizontal size={15} />
                  <span>{t("More")}</span>
                  {openQuestions.length ? <Badge tone="warning">{openQuestions.length}</Badge> : null}
                </button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuLabel>{t("Review")}</MenuLabel>
                {optionalActivityTabs.slice(0, 3).map(({ value, label, icon: Icon }) => (
                  <MenuItem key={value} onSelect={() => toggleOptionalTab(value)}>
                    <Check size={14} className={visibleOptionalTabs.includes(value) ? "activity-more-tab-check is-visible" : "activity-more-tab-check"} />
                    <Icon size={15} /> {label}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuLabel>{t("Project")}</MenuLabel>
                {optionalActivityTabs.slice(3).map(({ value, label, icon: Icon }) => (
                  <MenuItem key={value} onSelect={() => toggleOptionalTab(value)}>
                    <Check size={14} className={visibleOptionalTabs.includes(value) ? "activity-more-tab-check is-visible" : "activity-more-tab-check"} />
                    <Icon size={15} /> {label}
                    {value === "questions" && openQuestions.length ? <Badge tone="warning">{openQuestions.length}</Badge> : null}
                  </MenuItem>
                ))}
              </MenuContent>
            </MenuRoot>
          </TabsList>
          <TabsContent value="runs" className="activity-tab">
            <RunConsole />
          </TabsContent>
          <TabsContent value="trace" className="activity-tab">
            <RunTrace />
          </TabsContent>
          <TabsContent value="errors" className="activity-tab">
            <div className="record-list compact-records error-records">
              {runErrors.length === 0 ? <strong>{t("No open run issues.")}</strong> : null}
              {runErrors.map(({ run, classification, title, message, at }) => (
                <article key={run.id} className="record-card error-record">
                  <div className="record-card-head">
                    <Badge tone={runFailureTone(classification)}>{runFailureStatusLabel(classification)}</Badge>
                    <small>{at ? formatDateTime(new Date(at)) : run.phase}</small>
                  </div>
                  <strong>{title}</strong>
                  <small>{message}</small>
                  <small>{run.promptSummary}</small>
                  <div className="action-row">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        selectRun(run.id);
                        setActiveTab("runs");
                      }}
                    >
                      <Terminal size={14} />
                      <span>{t("Show in Queue")}</span>
                    </Button>
                    <Button type="button" size="sm" onClick={() => dismissRunError(run.id)}>
                      <span>{t("Dismiss")}</span>
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          </TabsContent>
          <TabsContent value="plans" className="activity-tab">
            <ActivityArtifactPreview
              artifacts={planArtifacts}
              empty="No plan artifacts yet."
            />
          </TabsContent>
          <TabsContent value="diffs" className="activity-tab">
            <ActivityArtifactPreview
              artifacts={codeReviewArtifacts}
              empty="No source changes yet."
            />
          </TabsContent>
          <TabsContent value="git" className="activity-tab">
            <GitActivityLog />
          </TabsContent>
          <TabsContent value="questions" className="activity-tab">
            <div className="record-list compact-records question-record-list">
              {openQuestions.length === 0 ? <strong>{t("No open planning questions.")}</strong> : null}
              {openQuestions.map((question) => (
                <article key={question.id} className="record-card question-record-card">
                  <div className="record-card-head">
                    <strong>{nodeTitles.get(question.nodeId) ?? question.nodeId}</strong>
                    <Button type="button" size="sm" variant="ghost" onClick={() => openQuestionTarget(question)}>
                      <MoveUpRight size={14} />
                      <span>{t("Open")}</span>
                    </Button>
                  </div>
                  <small>{question.body}</small>
                  <TextArea
                    rows={2}
                    value={questionAnswers[question.id] ?? ""}
                    placeholder={t("Answer this question")}
                    onChange={(event) => setQuestionAnswers((current) => ({
                      ...current,
                      [question.id]: event.target.value
                    }))}
                  />
                  <div className="action-row">
                    <Button type="button" size="sm" variant="primary" disabled={!questionAnswers[question.id]?.trim()} onClick={() => void answerQuestion(question)}>
                      <CheckCircle2 size={14} />
                      <span>{t("Answer")}</span>
                    </Button>
                    <Button type="button" size="sm" onClick={() => void letAiDecideQuestion(question)}>
                      <span>{t("Let AI decide")}</span>
                    </Button>
                    <Button type="button" size="sm" onClick={() => updateNoteResolved(question.id, true)}>
                      <span>{t("Dismiss")}</span>
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          </TabsContent>
          {/*
          <TabsContent value="artifacts" className="activity-tab">
            <ArtifactBrowser embedded />
          </TabsContent>
          */}
          <TabsContent value="console" className="activity-tab">
            <ProjectConsole />
          </TabsContent>
        </TabsRoot>
      ) : null}
    </aside>
  );
}

function ActivityArtifactPreview({ artifacts, empty }: { artifacts: Artifact[]; empty: string }) {
  const rootPath = useArchicodeStore((state) => state.rootPath);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ artifactId: string; text: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[artifacts.length - 1] ?? null;
  const selectedPreviewText = preview && preview.artifactId === selected?.id ? preview.text : null;
  const selectedPlanDisplay = selected
    ? planArtifactDerivedDisplay(selected, selected.type === "plan" ? selectedPreviewText : null)
    : null;

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    if (!selected || !rootPath || !window.archicode?.readArtifactText) return;
    window.archicode.readArtifactText(rootPath, selected.path)
      .then((text) => {
        if (!cancelled) setPreview({ artifactId: selected.id, text });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPreviewError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, selected]);

  if (!artifacts.length) {
    return <strong>{empty}</strong>;
  }

  return (
    <div className="activity-artifact-preview">
      <div className="activity-artifact-list" aria-label={t("Artifacts")}>
        {[...artifacts].reverse().map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            className={artifact.id === selected?.id ? "is-active" : ""}
            onClick={() => setSelectedId(artifact.id)}
            title={artifact.title}
          >
            <small>{artifact.id === selected?.id && selectedPlanDisplay ? selectedPlanDisplay.listLabel : planArtifactListLabel(artifact)}</small>
          </button>
        ))}
      </div>
      <div className="activity-artifact-detail">
        {selected ? (
          <>
            <div className="record-card-head">
              <Badge>{selectedPlanDisplay?.badgeLabel ?? planArtifactBadgeLabel(selected)}</Badge>
              <small>{selected.path}</small>
            </div>
            <ArtifactPreview
              artifact={selected}
              text={preview?.artifactId === selected.id ? preview.text : previewError ?? selected.summary ?? "Preview unavailable in this environment."}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
