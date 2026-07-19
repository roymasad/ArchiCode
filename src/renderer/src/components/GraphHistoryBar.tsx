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
  return index >= 0 ? versions.length - index : versions.length ? versions.length + 1 : null;
}

export function GraphHistoryBar({ inline = false }: { inline?: boolean }) {
  const {
    bundle,
    gitStatus,
    graphHistory,
    graphHistoryOpen,
    graphHistoryLoading,
    historicalInspection,
    toggleGraphHistory,
    refreshGraphHistory,
    inspectHistoricalGraph,
    exitHistoricalInspection
  } = useArchicodeStore(useShallow((state) => ({
    bundle: state.bundle,
    gitStatus: state.gitStatus,
    graphHistory: state.graphHistory,
    graphHistoryOpen: state.graphHistoryOpen,
    graphHistoryLoading: state.graphHistoryLoading,
    historicalInspection: state.historicalInspection,
    toggleGraphHistory: state.toggleGraphHistory,
    refreshGraphHistory: state.refreshGraphHistory,
    inspectHistoricalGraph: state.inspectHistoricalGraph,
    exitHistoricalInspection: state.exitHistoricalInspection
  })));

  const entry = historicalInspection?.entry;
  const autoLoadedRepoRef = useRef<string | null>(null);
  useEffect(() => {
    const repoKey = gitStatus?.repoRoot ?? bundle?.rootPath ?? null;
    if ((inline && entry) || !repoKey || !gitStatus?.isRepo || autoLoadedRepoRef.current === repoKey) return;
    autoLoadedRepoRef.current = repoKey;
    if (!graphHistory.length) void refreshGraphHistory();
  }, [bundle?.rootPath, entry, gitStatus?.isRepo, gitStatus?.repoRoot, graphHistory.length, inline, refreshGraphHistory]);
  if (inline && entry) return null;
  const flatEntries = graphHistory.flatMap((version) => version.commits);
  const activeIndex = entry ? flatEntries.findIndex((item) => item.commit === entry.commit) : -1;
  const newer = activeIndex > 0 ? flatEntries[activeIndex - 1] : null;
  const older = activeIndex >= 0 ? flatEntries[activeIndex + 1] : null;
  const displayedGraphVersion = entry?.graphVersion ?? bundle?.project.graphVersion;
  const displayedVersionNumber = graphVersionNumber(graphHistory, displayedGraphVersion, entry?.commit);
  const displayedVersionLabel = displayedVersionNumber ? `Graph v${displayedVersionNumber}` : "Graph history";
  const historyPanelContents = (
    <>
      <header>
        <div><strong>Graph history</strong><small>Read-only snapshots from the current branch’s Git history</small></div>
        <div>
          <IconButton title="Refresh graph history" onClick={() => void refreshGraphHistory()} disabled={graphHistoryLoading}>
            {graphHistoryLoading ? <LoaderCircle className="spin" size={16} /> : <History size={16} />}
          </IconButton>
          <IconButton title="Close graph history" onClick={toggleGraphHistory}><X size={16} /></IconButton>
        </div>
      </header>
      <div className="graph-history-list">
        {graphHistoryLoading && !graphHistory.length ? <p className="graph-history-empty">Reading graph snapshots from Git…</p> : null}
        {!graphHistoryLoading && !graphHistory.length ? <p className="graph-history-empty">No committed ArchiCode graphs were found on this branch.</p> : null}
        {graphHistory.map((version, index) => {
          const latest = version.latest;
          const selected = entry?.graphVersion === version.graphVersion;
          return (
            <button
              type="button"
              key={`${version.graphVersion}:${latest.commit}`}
              className={selected ? "graph-history-item is-selected" : "graph-history-item"}
              onClick={() => void inspectHistoricalGraph(latest.commit)}
            >
              <span className="graph-history-dot" />
              <span className="graph-history-item-body">
                <strong>Graph v{graphHistory.length - index}</strong>
                <span>{latest.subject}</span>
                <small>{version.commits.length === 1 ? latest.shortCommit : `${version.commits.at(-1)?.shortCommit}–${latest.shortCommit}`} · {latest.flowCount} flows · {latest.nodeCount} nodes · {latest.edgeCount} relationships</small>
              </span>
            </button>
          );
        })}
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
                  <strong>Graph history</strong>
                  <small>{gitStatus?.isRepo
                    ? `${gitStatus.currentBranch ?? "Current branch"} · ${displayedVersionNumber ? displayedVersionLabel : graphHistoryLoading ? "Reading versions…" : "No committed graph snapshots"}`
                    : "Available after this project is committed to Git"}</small>
                  <small>Inspect the graph captured by each Git commit.</small>
                </span>
              )}>
                <IconButton
                  className="graph-version-button"
                  type="button"
                  disabled={!gitStatus?.isRepo}
                  aria-label={displayedVersionNumber ? `Open graph history, Graph v${displayedVersionNumber}` : "Open graph history"}
                >
                  <GitCommitHorizontal size={17} />
                  {displayedVersionNumber ? <span className="graph-version-badge">v{displayedVersionNumber}</span> : null}
                </IconButton>
              </Tooltip>
            </span>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent className="graph-history-panel is-popover" align="start" side="bottom" sideOffset={8} aria-label="Graph history">
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
            <span className="graph-history-mode"><History size={15} /> Historical inspection</span>
            <span className="graph-history-context">
              <b>{entry.shortCommit}</b>
              <span>{displayedVersionLabel}</span>
              <span>{new Date(entry.committedAt).toLocaleString()}</span>
            </span>
            <div className="graph-history-actions">
              <IconButton title="Older graph snapshot" disabled={!older || graphHistoryLoading} onClick={() => older && void inspectHistoricalGraph(older.commit)}>
                <ChevronLeft size={16} />
              </IconButton>
              <IconButton title="Newer graph snapshot" disabled={!newer || graphHistoryLoading} onClick={() => newer && void inspectHistoricalGraph(newer.commit)}>
                <ChevronRight size={16} />
              </IconButton>
              <Button size="sm" variant="secondary" onClick={toggleGraphHistory}>
                Timeline <ChevronDown size={14} />
              </Button>
              <Button size="sm" variant="primary" onClick={() => void exitHistoricalInspection()} disabled={graphHistoryLoading}>
                <X size={14} /> Return to current
              </Button>
            </div>
          </>
        ) : null}
      </div>

      {graphHistoryOpen ? (
        <div className="graph-history-panel" role="dialog" aria-label="Graph history">
          {historyPanelContents}
        </div>
      ) : null}
    </div>
  );
}
