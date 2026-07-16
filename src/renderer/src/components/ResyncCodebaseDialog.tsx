import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ResyncProgress, ResyncReport, ResyncScope } from "../../../preload";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { Button, DialogContent, DialogRoot } from "./ui";

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function countDelta(report: ResyncReport): number {
  return report.delta.added.length
    + report.delta.modified.length
    + report.delta.deleted.length
    + report.delta.moved.length
    + report.delta.renamed.length;
}

function resultTitle(report: ResyncReport): string {
  if (report.status === "up-to-date") return "Already up to date";
  if (report.status === "review-required") return "Synchronized with items requiring review";
  return "Map synchronized";
}

function resyncScopeLabel(scope: ResyncScope | undefined, flows: Array<{ id: string; name: string }> = []): string {
  if (!scope || scope.kind === "project") return flows.length ? `Project · all ${flows.length} flow${flows.length === 1 ? "" : "s"}` : "Project · all flows";
  const names = scope.flowIds.map((flowId) => flows.find((flow) => flow.id === flowId)?.name ?? flowId);
  if (names.length === 1) return names[0];
  return `${names.length} selected flows`;
}

function ResyncSummary({ report, flows }: { report: ResyncReport; flows: Array<{ id: string; name: string }> }) {
  const actionable = report.status === "review-required";
  const patch = report.patch;
  return (
    <div className={actionable ? "resync-summary has-issues" : "resync-summary"}>
      <div className="resync-summary-heading">
        {actionable ? <AlertTriangle size={22} /> : <CheckCircle2 size={22} />}
        <div>
          <strong>{resultTitle(report)}</strong>
          <span>{actionable
            ? "The verified patch was applied; ambiguous user-owned items were preserved for your review."
            : report.status === "up-to-date"
              ? "Repository evidence matches the previous baseline. The graph was not regenerated or rewritten."
              : "ArchiCode applied the smallest validated patch to the existing map."}</span>
        </div>
      </div>
      <div className="resync-summary-grid">
        <div><span>Map scope</span><strong>{resyncScopeLabel(report.scope, flows)}</strong></div>
        <div><span>Estimated map accuracy</span><strong>{report.accuracyEstimate.score}% · {report.accuracyEstimate.label}</strong><small>Estimate, not a guarantee</small></div>
        <div><span>Total time</span><strong>{elapsedLabel(report.durationMs)}</strong></div>
        <div><span>Repository scope</span><strong>{countDelta(report).toLocaleString()} changed · {report.files.scanned.toLocaleString()} scanned</strong><small>{report.files.parsed.toLocaleString()} parsed in depth</small></div>
        <div><span>Verified unchanged</span><strong>{patch.verifiedUnchanged.toLocaleString()} graph entities</strong></div>
        <div><span>Updated</span><strong>{patch.nodesUpdated.toLocaleString()} nodes · {patch.edgesUpdated.toLocaleString()} edges</strong><small>{patch.flowsUpdated.toLocaleString()} flows</small></div>
        <div><span>Added / removed</span><strong>{(patch.nodesAdded + patch.edgesAdded + patch.flowsAdded).toLocaleString()} / {(patch.nodesRemoved + patch.edgesRemoved).toLocaleString()}</strong></div>
        <div><span>Needs review</span><strong>{patch.conflicts.length.toLocaleString()} conflicts · {patch.potentialStale.toLocaleString()} potentially stale</strong></div>
        <div><span>LLM affected-scope review</span><strong>{report.llmReview.affectedEntitiesReviewed.toLocaleString()} entities</strong><small>{report.llmReview.failedCalls.toLocaleString()} failed calls · {report.llmReview.suggestionsRejected.toLocaleString()} unsafe suggestions rejected</small></div>
      </div>

      {patch.conflicts.length || patch.staleItems.length ? (
        <div className="resync-action-items">
          <strong>Review these preserved items</strong>
          <ul>{[...patch.conflicts, ...patch.staleItems].map((conflict) => (
            <li key={conflict.id}>
              <strong>{conflict.title}</strong>
              <span>{conflict.reason}</span>
              {conflict.disappearedEvidence.length ? <small>Evidence no longer found: {conflict.disappearedEvidence.join(", ")}</small> : null}
            </li>
          ))}</ul>
        </div>
      ) : null}

      <details className="resync-technical">
        <summary>Technical synchronization details</summary>
        <div>
          <p>{report.accuracyEstimate.explanation}</p>
          <ul>
            {report.safeguards.map((item) => <li key={item}>{item}</li>)}
            {patch.rejectedSuggestions.map((item) => <li key={item}>{item}</li>)}
            {report.technical.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <div className="resync-phase-list">
            {report.phaseTimings.map((phase, index) => <span key={`${phase.phase}-${index}`}><strong>{phase.label}</strong>{elapsedLabel(phase.durationMs)}</span>)}
          </div>
        </div>
      </details>
    </div>
  );
}

export function ResyncCodebaseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { bundle, rootPath, reload } = useArchicodeStore();
  const [progress, setProgress] = useState<ResyncProgress | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [report, setReport] = useState<ResyncReport | null>(null);
  const [history, setHistory] = useState<ResyncReport[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeKind, setScopeKind] = useState<"project" | "flows">("project");
  const [selectedFlowIds, setSelectedFlowIds] = useState<string[]>([]);

  const flows = bundle?.flows ?? [];

  useEffect(() => {
    if (!flows.length || selectedFlowIds.length) return;
    const initialFlowId = bundle?.project.activeFlowId && flows.some((flow) => flow.id === bundle.project.activeFlowId)
      ? bundle.project.activeFlowId
      : flows[0]?.id;
    if (initialFlowId) setSelectedFlowIds([initialFlowId]);
  }, [bundle?.project.activeFlowId, flows, selectedFlowIds.length]);

  useEffect(() => {
    if (!open || !window.archicode?.listResyncReports) return;
    void window.archicode.listResyncReports(rootPath).then(setHistory).catch(() => setHistory([]));
  }, [open, rootPath]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const elapsed = useMemo(() => startedAt ? now - startedAt : 0, [now, startedAt]);
  const validSelectedFlowIds = selectedFlowIds.filter((flowId) => flows.some((flow) => flow.id === flowId));
  const selectedScope: ResyncScope = scopeKind === "project"
    ? { kind: "project" }
    : { kind: "flows", flowIds: validSelectedFlowIds };
  const canStart = selectedScope.kind === "project" || selectedScope.flowIds.length > 0;
  const start = async (): Promise<void> => {
    if (!window.archicode?.resyncCodebase || running || !canStart) return;
    const providerId = bundle?.project.settings.providers.find((provider) => provider.enabled)?.id;
    const dispose = window.archicode.onCodebaseResyncProgress?.((next) => {
      if (next.projectRoot === rootPath) setProgress(next);
    });
    setRunning(true);
    setStartedAt(Date.now());
    setNow(Date.now());
    setReport(null);
    setError(null);
    setProgress({ projectRoot: rootPath, phase: "baseline", label: "Preparing conservative synchronization" });
    try {
      const result = await window.archicode.resyncCodebase({ projectRoot: rootPath, providerId, scope: selectedScope });
      setReport(result.report);
      setHistory((current) => [result.report, ...current.filter((item) => item.reportId !== result.report.reportId)]);
      await reload();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.includes("Codebase resync was cancelled")) setProgress(null);
      else setError(message);
    } finally {
      dispose?.();
      setRunning(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!window.archicode?.cancelCodebaseResync) return;
    setProgress((current) => current ? { ...current, label: "Cancelling synchronization", detail: "No graph or baseline changes will be committed." } : current);
    await window.archicode.cancelCodebaseResync(rootPath);
  };

  return (
    <DialogRoot open={open} onOpenChange={(next) => { if (!running) onOpenChange(next); }}>
      <DialogContent className="resync-dialog" title="Resync codebase" description="Update the existing architecture map from verified code changes while preserving truthful graph and user-authored content.">
        {!running ? (
          <section className="resync-scope" aria-label="Resync scope">
            <div className="resync-scope-heading">
              <div><strong>Scope</strong><span>Choose which architecture flows may be updated.</span></div>
              <small>{scopeKind === "project" ? `${flows.length} flow${flows.length === 1 ? "" : "s"}` : `${validSelectedFlowIds.length} selected`}</small>
            </div>
            <div className="resync-scope-options">
              <label className={scopeKind === "project" ? "is-selected" : ""}>
                <input type="radio" name="resync-scope" checked={scopeKind === "project"} onChange={() => setScopeKind("project")} />
                <span><strong>Project (all flows)</strong><small>Resync every flow and advance the project-wide evidence baseline.</small></span>
              </label>
              <label className={scopeKind === "flows" ? "is-selected" : ""}>
                <input type="radio" name="resync-scope" checked={scopeKind === "flows"} onChange={() => setScopeKind("flows")} />
                <span><strong>Specific flows</strong><small>Only selected flows may change; other flows keep pending code changes for later.</small></span>
              </label>
            </div>
            {scopeKind === "flows" ? (
              <div className="resync-flow-picker">
                <div className="resync-flow-picker-toolbar">
                  <span>Select one or more flows</span>
                  <div>
                    <Button type="button" size="sm" variant="secondary" onClick={() => setSelectedFlowIds(flows.map((flow) => flow.id))}>Select all</Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => setSelectedFlowIds([])}>Clear</Button>
                  </div>
                </div>
                <div className="resync-flow-list">
                  {flows.map((flow) => {
                    const selected = selectedFlowIds.includes(flow.id);
                    return (
                      <label key={flow.id} className={selected ? "is-selected" : ""}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(event) => setSelectedFlowIds((current) => event.target.checked
                            ? [...new Set([...current, flow.id])]
                            : current.filter((flowId) => flowId !== flow.id))}
                        />
                        <span><strong>{flow.name}</strong><small>{flow.evidenceBackbone ? "Evidence backbone" : flow.perspective ? `${flow.perspective.kind} perspective` : "Project flow"} · {flow.nodes.length} nodes</small></span>
                      </label>
                    );
                  })}
                </div>
                {!validSelectedFlowIds.length ? <small className="resync-scope-warning">Select at least one flow to continue.</small> : null}
              </div>
            ) : null}
          </section>
        ) : null}
        {running ? (
          <div className="resync-running">
            <div className="resync-running-icon"><RefreshCw size={24} /></div>
            <div>
              <strong>{progress?.label ?? "Synchronizing existing map"}</strong>
              <span>{progress?.detail ?? "ArchiCode is applying a conservative, evidence-backed update."}</span>
              <small>Scope: {resyncScopeLabel(selectedScope, flows)}</small>
            </div>
            <div className="resync-elapsed"><Clock3 size={15} /> {elapsedLabel(elapsed)}</div>
            {progress?.itemsDone !== undefined ? <small>{progress.itemsDone.toLocaleString()}{progress.itemsTotal !== undefined ? ` / ${progress.itemsTotal.toLocaleString()}` : ""}</small> : null}
          </div>
        ) : report ? <ResyncSummary report={report} flows={flows} /> : (
          <div className="resync-intro">
            <p>The current graph remains the source of truth. ArchiCode hashes the repository, freezes unchanged entities, and reconciles only the affected evidence and relationships.</p>
            <ul>
              <li>Node and edge IDs, wording, layout, flow membership, notes, and custom properties remain untouched when evidence is unchanged.</li>
              <li>User-edited or ambiguous content is preserved and reported as an actionable conflict.</li>
              <li>No-change runs skip parsing, graph mutation, and LLM review.</li>
            </ul>
          </div>
        )}

        {error ? <div className="resync-error"><XCircle size={18} /><span><strong>Synchronization did not apply</strong>{error}</span></div> : null}

        {!running && history.length ? (
          <details className="resync-history">
            <summary>Sync history ({history.length})</summary>
            <div>{history.map((item) => (
              <button type="button" key={item.reportId} className={report?.reportId === item.reportId ? "is-active" : ""} onClick={() => {
                setReport(item);
                if (item.scope?.kind === "flows") {
                  setScopeKind("flows");
                  setSelectedFlowIds(item.scope.flowIds);
                } else setScopeKind("project");
              }}>
                <span>{new Date(item.completedAt).toLocaleString()}</span>
                <strong>{resultTitle(item)}</strong>
                <small>{resyncScopeLabel(item.scope, flows)} · {countDelta(item)} changed files · {elapsedLabel(item.durationMs)}</small>
              </button>
            ))}</div>
          </details>
        ) : null}

        <div className="resync-dialog-actions">
          {running
            ? <Button type="button" variant="secondary" onClick={() => void cancel()}>Cancel resync</Button>
            : <>
                <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
                <Button type="button" variant="primary" disabled={!canStart} onClick={() => void start()}><RefreshCw size={15} /> {scopeKind === "flows" ? "Resync selected flows" : report ? "Resync again" : "Resync codebase"}</Button>
              </>}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
