import { formatDateTime } from "@renderer/i18n";
import { t } from "@renderer/i18n";
import { ChevronDown, ChevronLeft, ChevronRight, GitCommitHorizontal, History, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { Button, IconButton, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger, Tooltip } from "./ui";

function graphVersionNumber(
  versions: ReturnType<typeof useArchicodeStore.getState>["graphHistory"],
  graphVersion?: string,
  commit?: string
): number | null {
  if (!graphVersion) return null;
  const index = commit
    ? versions.findIndex((version) => version.commits.some((entry) => entry.commit === commit))
    : versions.findIndex((version) => version.graphVersion === graphVersion);
  return index >= 0 ? versions[index]?.versionNumber ?? versions.length - index : versions.length ? (versions[0]?.versionNumber ?? versions.length) + 1 : null;
}

export function GraphHistoryBar({ inline = false }: { inline?: boolean }) {
  const {
    bundle,
    gitStatus,
    graphHistory,
    graphHistoryOpen,
    graphHistoryLoading,
    graphHistoryHasMore,
    historicalInspection,
    toggleGraphHistory,
    refreshGraphHistory,
    loadMoreGraphHistory,
    inspectHistoricalGraph,
    exitHistoricalInspection
  } = useArchicodeStore(useShallow((state) => ({
    bundle: state.bundle,
    gitStatus: state.gitStatus,
    graphHistory: state.graphHistory,
    graphHistoryOpen: state.graphHistoryOpen,
    graphHistoryLoading: state.graphHistoryLoading,
    graphHistoryHasMore: state.graphHistoryHasMore,
    historicalInspection: state.historicalInspection,
    toggleGraphHistory: state.toggleGraphHistory,
    refreshGraphHistory: state.refreshGraphHistory,
    loadMoreGraphHistory: state.loadMoreGraphHistory,
    inspectHistoricalGraph: state.inspectHistoricalGraph,
    exitHistoricalInspection: state.exitHistoricalInspection
  })));

  const entry = historicalInspection?.entry;
  const currentBundle = historicalInspection?.currentBundle ?? bundle;
  const autoLoadedRepoRef = useRef<string | null>(null);
  const historyEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const repoKey = gitStatus?.repoRoot ?? bundle?.rootPath ?? null;
    if ((inline && entry) || !repoKey || !gitStatus?.isRepo || autoLoadedRepoRef.current === repoKey) return;
    autoLoadedRepoRef.current = repoKey;
    if (!graphHistory.length) void refreshGraphHistory();
  }, [bundle?.rootPath, entry, gitStatus?.isRepo, gitStatus?.repoRoot, graphHistory.length, inline, refreshGraphHistory]);
  useEffect(() => {
    const target = historyEndRef.current;
    const root = target?.parentElement;
    if (!target || !root || !graphHistoryHasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((item) => item.isIntersecting)) void loadMoreGraphHistory();
    }, { root, rootMargin: "120px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [graphHistoryHasMore, graphHistoryLoading, graphHistoryOpen, loadMoreGraphHistory]);
  if (inline && entry) return null;
  const flatEntries = graphHistory.flatMap((version) => version.commits);
  const activeIndex = entry ? flatEntries.findIndex((item) => item.commit === entry.commit) : -1;
  const newer = activeIndex > 0 ? flatEntries[activeIndex - 1] : null;
  const older = activeIndex >= 0 ? flatEntries[activeIndex + 1] : null;
  const currentGraphVersion = currentBundle?.project.graphVersion;
  const currentCommittedVersionIndex = currentGraphVersion
    ? graphHistory.findIndex((version) => version.graphVersion === currentGraphVersion)
    : -1;
  const hasCurrentUncommittedVersion = Boolean(
    currentGraphVersion && currentCommittedVersionIndex < 0 && (graphHistory.length > 0 || !graphHistoryLoading)
  );
  const newestCommittedVersionNumber = graphHistory[0]?.versionNumber ?? (graphHistory.length || null);
  const currentVersionNumber = currentGraphVersion
    ? currentCommittedVersionIndex >= 0
      ? graphHistory[currentCommittedVersionIndex]?.versionNumber ?? graphHistory.length - currentCommittedVersionIndex
      : newestCommittedVersionNumber ? newestCommittedVersionNumber + 1 : null
    : null;
  const displayedVersionNumber = entry
    ? graphVersionNumber(graphHistory, entry.graphVersion, entry.commit)
    : currentVersionNumber;
  const displayedVersionLabel = displayedVersionNumber ? `Graph v${displayedVersionNumber}` : "Graph history";
  const currentFlowCount = currentBundle?.flows.length ?? 0;
  const currentNodeCount = currentBundle?.flows.reduce((count, flow) => count + flow.nodes.length, 0) ?? 0;
  const currentEdgeCount = currentBundle?.flows.reduce((count, flow) => count + flow.edges.length, 0) ?? 0;
  const selectCurrentGraph = () => {
    if (graphHistoryOpen) toggleGraphHistory();
    if (entry) void exitHistoricalInspection();
  };
  const selectHistoricalGraph = (commit: string) => {
    if (graphHistoryOpen) toggleGraphHistory();
    void inspectHistoricalGraph(commit);
  };
  const historyPanelContents = (
    <>
      <header>
        <div><strong>{t("Graph history")}</strong><small>{hasCurrentUncommittedVersion ? t("Current working graph and read-only snapshots from this branch’s Git history") : t("Read-only snapshots from the current branch’s Git history")}</small></div>
        <div>
          <IconButton title={t("Refresh graph history")} onClick={() => void refreshGraphHistory()} disabled={graphHistoryLoading}>
            {graphHistoryLoading ? <LoaderCircle className="spin" size={16} /> : <History size={16} />}
          </IconButton>
          <IconButton title={t("Close graph history")} onClick={toggleGraphHistory}><X size={16} /></IconButton>
        </div>
      </header>
      <div className="graph-history-list">
        {hasCurrentUncommittedVersion ? (
          <button
            type="button"
            className={!entry ? "graph-history-item is-current is-selected" : "graph-history-item is-current"}
            onClick={selectCurrentGraph}
          >
            <span className="graph-history-dot" />
            <span className="graph-history-item-body">
              <strong>{t("Graph v {{currentVersionNumber}}", { currentVersionNumber: currentVersionNumber })}</strong>
              <span>{t("Current uncommitted graph")}</span>
              <small>{t("Working tree · {{currentFlowCount}} flows · {{currentNodeCount}} nodes · {{currentEdgeCount}} relationships", { currentFlowCount: currentFlowCount, currentNodeCount: currentNodeCount, currentEdgeCount: currentEdgeCount })}</small>
            </span>
          </button>
        ) : null}
        {graphHistoryLoading && !graphHistory.length ? <p className="graph-history-empty">{t("Reading graph snapshots from Git…")}</p> : null}
        {!graphHistoryLoading && !graphHistory.length ? <p className="graph-history-empty">{t("No committed ArchiCode graphs were found on this branch.")}</p> : null}
        {graphHistory.map((version, index) => {
          const latest = version.latest;
          const selected = entry?.graphVersion === version.graphVersion;
          return (
            <button
              type="button"
              key={`${version.graphVersion}:${latest.commit}`}
              className={selected ? "graph-history-item is-selected" : "graph-history-item"}
              onClick={() => selectHistoricalGraph(latest.commit)}
            >
              <span className="graph-history-dot" />
              <span className="graph-history-item-body">
                <strong>{t("Graph v {{index}}", { index: version.versionNumber ?? graphHistory.length - index })}</strong>
                <span>{latest.subject}</span>
                <small>{t("{{value1}} · {{flowCount}} flows · {{nodeCount}} nodes · {{edgeCount}} relationships", { value1: version.commits.length === 1 ? latest.shortCommit : `${version.commits.at(-1)?.shortCommit}–${latest.shortCommit}`, flowCount: latest.flowCount, nodeCount: latest.nodeCount, edgeCount: latest.edgeCount })}</small>
              </span>
            </button>
          );
        })}
        {graphHistoryHasMore ? (
          <div ref={historyEndRef} className="graph-history-loading-more" aria-live="polite">
            {graphHistoryLoading ? <><LoaderCircle className="spin" size={15} /> {" "}{t("Loading older commits…")}</> : t("Scroll for older commits")}
          </div>
        ) : null}
      </div>
    </>
  );

  if (inline) {
    return (
      <div className="graph-history-shell is-inline">
        <PopoverRoot open={graphHistoryOpen} onOpenChange={(open) => { if (open !== graphHistoryOpen) toggleGraphHistory(); }}>
          <PopoverTrigger asChild>
            <span className="graph-version-tooltip-target">
              <Tooltip content={(
                <span className="graph-version-tooltip">
                  <strong>{t("Graph history")}</strong>
                  <small>{gitStatus?.isRepo
                    ? t("{{value1}} · {{value2}}", { value1: gitStatus.currentBranch ?? "Current branch", value2: displayedVersionNumber ? displayedVersionLabel : graphHistoryLoading ? "Reading versions…" : "No committed graph snapshots" })
                    : t("Available after this project is committed to Git")}</small>
                  <small>{t("Inspect the graph captured by each Git commit.")}</small>
                </span>
              )}>
                <IconButton
                  className="graph-version-button"
                  type="button"
                  disabled={!gitStatus?.isRepo}
                  aria-label={displayedVersionNumber ? `Open graph history, Graph v${displayedVersionNumber}` : t("Open graph history")}
                >
                  <GitCommitHorizontal size={17} />
                  {displayedVersionNumber ? <span className="graph-version-badge">{t("v {{displayedVersionNumber}}", { displayedVersionNumber: displayedVersionNumber })}</span> : null}
                </IconButton>
              </Tooltip>
            </span>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent className="graph-history-panel is-popover" align="start" side="bottom" sideOffset={8} aria-label={t("Graph history")}>
              {historyPanelContents}
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
      </div>
    );
  }

  return (
    <div className={["graph-history-shell", entry ? "is-historical" : "", inline ? "is-inline" : ""].filter(Boolean).join(" ")}>
      <div className="graph-history-bar">
        {entry ? (
          <>
            <div className="graph-history-summary">
              <span className="graph-history-mode"><History size={15} /> {" "}{t("Historical inspection")}</span>
              <span className="graph-history-context">
                <span className="graph-history-context-primary"><b>{entry.shortCommit}</b><span>{displayedVersionLabel}</span></span>
                <span className="graph-history-context-secondary">
                  <span className="graph-history-change-key"><i aria-hidden="true" /> {historicalInspection.nodeChanges.length} {" "}{t("changed node")}{historicalInspection.nodeChanges.length === 1 ? "" : t("s")}</span>
                  <span className="graph-history-timestamp">{formatDateTime(new Date(entry.committedAt))}</span>
                </span>
              </span>
            </div>
            <div className="graph-history-actions">
              <IconButton title={t("Older graph snapshot")} disabled={!older || graphHistoryLoading} onClick={() => older && void inspectHistoricalGraph(older.commit)}>
                <ChevronLeft size={16} />
              </IconButton>
              <IconButton
                title={activeIndex === 0 && hasCurrentUncommittedVersion ? t("Current uncommitted graph") : t("Newer graph snapshot")}
                disabled={(!newer && !(activeIndex === 0 && hasCurrentUncommittedVersion)) || graphHistoryLoading}
                onClick={() => {
                  if (newer) void inspectHistoricalGraph(newer.commit);
                  else if (activeIndex === 0 && hasCurrentUncommittedVersion) void exitHistoricalInspection();
                }}
              >
                <ChevronRight size={16} />
              </IconButton>
              <Button size="sm" variant="secondary" onClick={toggleGraphHistory}>
                {t("Timeline")}{" "}<ChevronDown size={14} />
              </Button>
              <Button className="graph-history-return" size="sm" variant="primary" onClick={() => void exitHistoricalInspection()} disabled={graphHistoryLoading} title={t("Return to current graph")}>
                <X size={14} /> <span>{t("Current")}</span>
              </Button>
            </div>
          </>
        ) : null}
      </div>

      {graphHistoryOpen ? (
        <div className="graph-history-panel" role="dialog" aria-label={t("Graph history")}>
          {historyPanelContents}
        </div>
      ) : null}
    </div>
  );
}
