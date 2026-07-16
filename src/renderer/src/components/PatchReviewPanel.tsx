import { CheckCircle2, FileJson, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { llmPatchProposalSchema, type LlmPatchProposal, type PatchOperationDecision, type ProjectBundle } from "@shared/schema";
import { useArchicodeStore, type PatchProposalView } from "../store/useArchicodeStore";
import { Badge, Button, DialogContent, DialogRoot, EmptyState, IconButton, ScrollArea } from "./ui";

type SourceOperation = Extract<LlmPatchProposal["operations"][number], { kind: "propose-source-file" }>;

function readableKind(kind: LlmPatchProposal["operations"][number]["kind"]): string {
  return kind
    .replace(/^propose-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function nodeLabel(bundle: ProjectBundle | null, nodeId: string | undefined): string {
  if (!nodeId) return "unscoped";
  const node = bundle?.flows.flatMap((flow) => flow.nodes).find((item) => item.id === nodeId);
  return node ? `${node.title} (${node.id})` : nodeId;
}

function formatPatchValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(formatPatchValue).join(", ") : "none";
  if (value && typeof value === "object") return JSON.stringify(value);
  return "cleared";
}

function updateNodeEntries(operation: Extract<LlmPatchProposal["operations"][number], { kind: "update-node" }>): Array<[string, unknown]> {
  const entries = Object.entries(operation.patch).filter(([key]) => key !== "id");
  const fields = operation.patch.fields;
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    return Object.entries(fields as Record<string, unknown>);
  }
  return entries;
}

function operationTitle(operation: LlmPatchProposal["operations"][number], bundle: ProjectBundle | null): string {
  if (operation.kind === "update-node") {
    const title = typeof operation.patch.title === "string" ? operation.patch.title : nodeLabel(bundle, operation.patch.id);
    return `Update node: ${title}`;
  }
  if (operation.kind === "add-note") return `Add ${operation.note.kind.replace("-", " ")} to ${nodeLabel(bundle, operation.note.nodeId)}`;
  if (operation.kind === "resolve-note") return `${operation.resolved ? "Resolve" : "Reopen"} note`;
  if (operation.kind === "delete-note") return "Delete note";
  if (operation.kind === "add-artifact-reference") return `Attach artifact: ${operation.artifact.title}`;
  if (operation.kind === "propose-node") return `Create node: ${operation.node.title}`;
  if (operation.kind === "propose-edge") return `Create edge: ${operation.edge.source} -> ${operation.edge.target}`;
  if (operation.kind === "propose-subflow") return `Create subflow: ${operation.subflow.name}`;
  if (operation.kind === "propose-graph-operation") {
    const kind = typeof operation.operation.kind === "string" ? operation.operation.kind : "graph operation";
    return `Graph operation: ${kind.replace(/-/g, " ")}`;
  }
  if (operation.kind === "propose-project-file") return `${operation.mode === "replace" ? "Replace" : "Create"} project file: ${operation.path}`;
  if (operation.kind === "propose-run-profile") return `${operation.mode === "replace" ? "Update" : "Create"} run target: ${operation.profile.label}`;
  return `${operation.action === "replace" ? "Replace" : operation.action === "delete" ? "Delete" : "Create"} source file: ${operation.path}`;
}

function describeOperation(operation: LlmPatchProposal["operations"][number]): string {
  if (operation.kind === "update-node") {
    const keys = updateNodeEntries(operation).map(([key]) => key);
    return keys.length ? `Changes ${keys.join(", ")}.` : "No node fields changed.";
  }
  if (operation.kind === "add-note") {
    return shortText(operation.note.body);
  }
  if (operation.kind === "resolve-note") {
    return `Note ${operation.noteId} will be ${operation.resolved ? "marked resolved" : "reopened"}.`;
  }
  if (operation.kind === "delete-note") {
    return `Note ${operation.noteId} will be removed.`;
  }
  if (operation.kind === "add-artifact-reference") {
    return operation.artifact.summary ?? `Adds ${operation.artifact.type} artifact ${operation.artifact.title}.`;
  }
  if (operation.kind === "propose-node") {
    return shortText(operation.node.description || `${operation.node.type} node in ${operation.node.stage} stage.`);
  }
  if (operation.kind === "propose-edge") {
    return operation.edge.label ? `Relationship label: ${operation.edge.label}.` : "Connects two graph nodes.";
  }
  if (operation.kind === "propose-subflow") {
    return "Adds a grouped graph view.";
  }
  if (operation.kind === "propose-graph-operation") {
    const kind = typeof operation.operation.kind === "string" ? operation.operation.kind.replace(/-/g, " ") : "graph change";
    return `Proposes a validated ${kind} for manual review.`;
  }
  if (operation.kind === "propose-project-file") {
    return operation.reason ? shortText(operation.reason) : `${operation.mode === "replace" ? "Replaces" : "Creates"} an ArchiCode project file.`;
  }
  if (operation.kind === "propose-run-profile") {
    return operation.reason ? shortText(operation.reason) : `Command: ${operation.profile.runCommand}`;
  }
  return operation.reason ? shortText(operation.reason) : `${operation.action === "replace" ? "Replaces" : operation.action === "delete" ? "Deletes" : "Creates"} ${operation.path}.`;
}

function OperationDetails({ operation, bundle }: { operation: LlmPatchProposal["operations"][number]; bundle: ProjectBundle | null }) {
  if (operation.kind === "propose-source-file") return <SourceOperationDetails operation={operation} bundle={bundle} />;
  if (operation.kind === "update-node") {
    const entries = updateNodeEntries(operation);
    if (!entries.length) return null;
    return (
      <div className="operation-detail-list">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{shortText(formatPatchValue(value), 220)}</dd>
          </div>
        ))}
      </div>
    );
  }
  if (operation.kind === "propose-project-file") {
    return (
      <div className="source-operation-detail">
        <div className="source-operation-head">
          <Badge tone={operation.mode === "replace" ? "warning" : "success"}>{operation.mode}</Badge>
          <code>{operation.path}</code>
        </div>
        <p>{operation.reason ?? `${operation.mode === "replace" ? "Replace" : "Create"} project convention file.`}</p>
        <small>{new TextEncoder().encode(operation.content).byteLength.toLocaleString()} bytes proposed</small>
      </div>
    );
  }
  if (operation.kind === "propose-run-profile") {
    return (
      <div className="source-operation-detail">
        <div className="source-operation-head">
          <Badge tone={operation.mode === "replace" ? "warning" : "success"}>{operation.mode}</Badge>
          <code>{operation.profile.id}</code>
        </div>
        <p>{operation.reason ?? "Adds a runnable target to the toolbar."}</p>
        <small>{operation.profile.runCommand}</small>
      </div>
    );
  }
  if (operation.kind === "propose-graph-operation") {
    return (
      <div className="source-operation-detail">
        <div className="source-operation-head">
          <Badge tone="warning">graph</Badge>
          <code>{typeof operation.operation.kind === "string" ? operation.operation.kind : "operation"}</code>
        </div>
        <details className="source-operation-code">
          <summary>Proposed graph operation</summary>
          <pre>{JSON.stringify(operation.operation, null, 2)}</pre>
        </details>
      </div>
    );
  }
  return null;
}

function sourceOperationTone(operation: SourceOperation): "success" | "warning" | "danger" {
  if (operation.action === "delete") return "danger";
  if (
    operation.path.startsWith(".env") ||
    operation.path.includes("/.env") ||
    operation.path.endsWith("lock") ||
    operation.path.endsWith("lockb") ||
    operation.path.includes("package.json") ||
    operation.action === "replace" && !operation.baseSha256
  ) return "warning";
  return "success";
}

function SourceOperationDetails({ operation, bundle }: { operation: SourceOperation; bundle: ProjectBundle | null }) {
  const bytes = new TextEncoder().encode(operation.content ?? "").byteLength;
  return (
    <div className="source-operation-detail">
      <div className="source-operation-head">
        <Badge tone={sourceOperationTone(operation)}>{operation.action}</Badge>
        <code>{operation.path}</code>
      </div>
      <dl>
        <div>
          <dt>Node</dt>
          <dd>{nodeLabel(bundle, operation.nodeId)}</dd>
        </div>
        <div>
          <dt>Bytes</dt>
          <dd>{bytes.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Base hash</dt>
          <dd>{operation.baseSha256 ? operation.baseSha256.slice(0, 12) : operation.action === "replace" ? "missing" : "not needed"}</dd>
        </div>
      </dl>
      {operation.reason ? <p>{operation.reason}</p> : null}
      {operation.testIntent ? <small>Test intent: {operation.testIntent}</small> : null}
      {operation.content ? (
        <details className="source-operation-code" open>
          <summary>Proposed file content</summary>
          <pre>{operation.content}</pre>
        </details>
      ) : null}
    </div>
  );
}

function parseProposal(item: PatchProposalView): LlmPatchProposal | null {
  const parsed = llmPatchProposalSchema.safeParse(item.proposal);
  return parsed.success ? parsed.data : null;
}

function hasGraphReviewOperations(item: PatchProposalView): boolean {
  const proposal = parseProposal(item);
  if (!proposal) return true;
  return proposal.operations.some(isGraphReviewOperation);
}

function isGraphReviewOperation(operation: LlmPatchProposal["operations"][number]): boolean {
  if (operation.kind === "propose-node" || operation.kind === "propose-edge" || operation.kind === "propose-subflow" || operation.kind === "propose-graph-operation") return true;
  if (operation.kind !== "update-node") return false;
  const fields = operation.patch.fields;
  const entries = fields && typeof fields === "object" && !Array.isArray(fields)
    ? Object.entries(fields as Record<string, unknown>)
    : Object.entries(operation.patch).filter(([key]) => key !== "id");
  const bookkeepingFields = new Set(["stage", "flags", "todos", "attachments"]);
  return entries.some(([key]) => !bookkeepingFields.has(key));
}

export function PatchReviewPanel() {
  const { bundle, patchProposals, refreshPatchProposals, applyPatchProposal } = useArchicodeStore();
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const decisionKey = (artifactId: string, operationIndex: number) => `${artifactId}:${operationIndex}`;

  const manualReview = bundle?.project.settings.planningReviewMode === "manual";
  const activePlanReviewRunIds = useMemo(() => new Set(
    (bundle?.runs ?? [])
      .filter((run) => run.status === "awaiting-plan-review")
      .map((run) => run.id)
  ), [bundle?.runs]);
  const hasActivePlanReviewRun = activePlanReviewRunIds.size > 0;
  const graphProposals = useMemo(() => patchProposals.filter((item) =>
    item.artifact.runId &&
    activePlanReviewRunIds.has(item.artifact.runId) &&
    hasGraphReviewOperations(item)
  ), [activePlanReviewRunIds, patchProposals]);
  const pendingCount = graphProposals.filter((item) => item.artifact.status === "pending-review").length;
  const active = useMemo(() => {
    return graphProposals.find((item) => item.artifact.id === activeId) ?? graphProposals[0] ?? null;
  }, [activeId, graphProposals]);
  const proposal = active ? parseProposal(active) : null;
  const reviewOperations = proposal
    ? proposal.operations
      .map((operation, operationIndex) => ({ operation, operationIndex }))
      .filter(({ operation }) => isGraphReviewOperation(operation))
    : [];
  const acceptedCount = active && proposal
    ? reviewOperations.filter(({ operationIndex }) => accepted[decisionKey(active.artifact.id, operationIndex)]).length
    : 0;

  useEffect(() => {
    const onOpenPatchReview = (event: Event) => {
      const runId = event instanceof CustomEvent && typeof event.detail?.runId === "string" ? event.detail.runId : null;
      if (runId) {
        const match = patchProposals.find((item) =>
          item.artifact.status === "pending-review" &&
          item.artifact.runId === runId &&
          hasGraphReviewOperations(item)
        );
        if (match) setActiveId(match.artifact.id);
      }
      setOpen(true);
    };
    window.addEventListener("archicode:open-patch-review", onOpenPatchReview);
    return () => window.removeEventListener("archicode:open-patch-review", onOpenPatchReview);
  }, [patchProposals]);

  if (!manualReview || !hasActivePlanReviewRun) return null;

  const buildDecisions = (rejectAll = false): PatchOperationDecision[] => {
    if (!active || !proposal) return [];
    return reviewOperations.map(({ operationIndex }) => {
      const isAccepted = !rejectAll && accepted[decisionKey(active.artifact.id, operationIndex)];
      return {
        operationIndex,
        decision: isAccepted ? "accepted" : "rejected",
        reason: isAccepted ? undefined : "Rejected from patch review."
      };
    });
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        className={pendingCount ? "patch-review-trigger has-pending" : "patch-review-trigger"}
        title={pendingCount ? `${pendingCount} graph proposal${pendingCount === 1 ? "" : "s"} waiting for review` : "Review proposed graph changes"}
        onClick={() => setOpen(true)}
      >
        <FileJson size={16} />
        <span>{pendingCount ? `Review ${pendingCount}` : "Graph Changes"}</span>
      </Button>

      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Proposed Graph Changes"
          description="Review model-proposed graph edits such as node text, edges, new nodes, and subflows. Source code edits are reviewed in Source Changes."
          className="patch-modal"
        >
          <div className="patch-toolbar">
            <Badge tone={pendingCount ? "warning" : "neutral"}>{pendingCount} pending</Badge>
            <IconButton title="Refresh patch proposals" onClick={refreshPatchProposals}>
              <RefreshCw size={16} />
            </IconButton>
          </div>

          <div className="patch-review-grid">
              <ScrollArea className="patch-list">
                {graphProposals.length === 0 ? (
                  <EmptyState icon={<FileJson size={20} />} title="No graph proposals yet" />
                ) : null}
                {graphProposals.map((item) => (
                  <button
                    key={item.artifact.id}
                    type="button"
                    className={item.artifact.id === active?.artifact.id ? "is-active" : ""}
                    onClick={() => setActiveId(item.artifact.id)}
                  >
                    <span>{item.artifact.title}</span>
                    <small>{item.artifact.status ?? "pending-review"}</small>
                  </button>
                ))}
              </ScrollArea>

              <section className="patch-detail">
                {!active ? (
                  <EmptyState icon={<FileJson size={20} />} title="Select a patch proposal" />
                ) : null}

                {active && active.validationErrors.length > 0 ? (
                  <div className="alert-line">
                    <ShieldAlert size={16} />
                    <span>{active.validationErrors.join(" | ")}</span>
                  </div>
                ) : null}

                {active && proposal ? (
                  <>
                    <div className="patch-summary">
                      <strong>{proposal.summary}</strong>
                      <small>{reviewOperations.length} proposed graph change{reviewOperations.length === 1 ? "" : "s"} from run {proposal.runId}. Check the rows you want to apply; unchecked rows will be rejected.</small>
                    </div>

                    <div className="operation-list">
                      {reviewOperations.map(({ operation, operationIndex }) => {
                        const key = decisionKey(active.artifact.id, operationIndex);
                        return (
                          <label key={key} className="operation-card">
                            <input
                              type="checkbox"
                              checked={Boolean(accepted[key])}
                              onChange={() => setAccepted((current) => ({ ...current, [key]: !current[key] }))}
                            />
                            <span>
                              <b>{readableKind(operation.kind)}</b>
                              <strong>{operationTitle(operation, bundle)}</strong>
                              <small>{describeOperation(operation)}</small>
                              <OperationDetails operation={operation} bundle={bundle} />
                            </span>
                          </label>
                        );
                      })}
                    </div>

                    {active.review ? (
                      <div className="review-results">
                        <strong>Last review</strong>
                        {active.review.results.map((result) => (
                          <small key={result.operationIndex}>
                            #{result.operationIndex + 1} {proposal.operations[result.operationIndex]?.kind ?? "operation"} {result.status}: {result.message}
                          </small>
                        ))}
                      </div>
                    ) : null}

                    <div className="patch-decision-bar">
                      <span>{acceptedCount} of {reviewOperations.length} selected to apply</span>
                      <div className="action-row end">
                        <Button
                          type="button"
                          onClick={() => {
                            setAccepted((current) => ({
                              ...current,
                              ...Object.fromEntries(reviewOperations.map(({ operationIndex }) => [decisionKey(active.artifact.id, operationIndex), true]))
                            }));
                          }}
                        >
                          <CheckCircle2 size={16} />
                          <span>Select All</span>
                        </Button>
                        <Button
                          type="button"
                          onClick={() => {
                            void applyPatchProposal(active.artifact.id, buildDecisions(true));
                            setOpen(false);
                          }}
                        >
                          <XCircle size={16} />
                          <span>Reject All</span>
                        </Button>
                        <Button
                          variant="primary"
                          type="button"
                          disabled={acceptedCount === 0}
                          onClick={() => {
                            void applyPatchProposal(active.artifact.id, buildDecisions());
                            setOpen(false);
                          }}
                        >
                          <CheckCircle2 size={16} />
                          <span>Apply Selected</span>
                        </Button>
                      </div>
                    </div>
                  </>
                ) : null}
              </section>
            </div>
        </DialogContent>
      </DialogRoot>
    </>
  );
}
