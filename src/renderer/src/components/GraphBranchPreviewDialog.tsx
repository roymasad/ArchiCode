import { t } from "@renderer/i18n";
import {
  Background,
  ConnectionMode,
  Controls,
  ReactFlow,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
  type ReactFlowInstance
} from "@xyflow/react";
import { ChevronLeft, ChevronRight, Eye, GitCompareArrows } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArchicodeNode, FlowEdge } from "@shared/schema";
import type {
  GraphBranchPreview,
  GraphBranchPreviewChange,
  GraphBranchPreviewChangeKind
} from "@shared/graphBranchPreview";
import { ArchicodeNodeCard } from "./ArchicodeNodeCard";
import { ArchicodeEdge } from "./ArchicodeEdge";
import {
  Badge,
  Button,
  DialogContent,
  DialogRoot,
  Select,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
  Tooltip
} from "./ui";

const nodeTypes: NodeTypes = { archicode: ArchicodeNodeCard };
const edgeTypes: EdgeTypes = { archicode: ArchicodeEdge };
const ALL_FLOWS = "__all_flows__";

function nodeSizeFor(node: ArchicodeNode) {
  return node.size ?? { width: 240, height: 160 };
}

function changeTone(kind: GraphBranchPreviewChangeKind): "success" | "warning" | "danger" {
  if (kind === "added") return "success";
  if (kind === "removed") return "danger";
  return "warning";
}

function changeKindLabel(kind: GraphBranchPreviewChangeKind): string {
  if (kind === "added") return t("Added");
  if (kind === "removed") return t("Removed");
  return t("Modified");
}

function entityKindLabel(change: GraphBranchPreviewChange): string {
  if (change.entityKind === "flow") return t("Flow");
  if (change.entityKind === "group") return t("Group");
  if (change.entityKind === "subflow") return t("Subflow");
  if (change.entityKind === "edge") return t("Relationship");
  return t("Node");
}

function localizedFieldValue(value: string): string {
  if (value === "Yes" || value === "No" || value === "None") return t(value);
  const itemCount = /^(\d+) items?$/.exec(value);
  return itemCount ? t("{{count}} items", { count: Number(itemCount[1]) }) : value;
}

function edgeStyle(edge: FlowEdge): Record<string, string | number> {
  const dash = edge.lineStyle === "dashed" ? "8 6" : edge.lineStyle === "dotted" ? "2 6" : "none";
  return {
    "--edge-stroke": edge.color ?? "var(--accent)",
    strokeWidth: edge.width ?? 2,
    strokeDasharray: dash
  };
}

export function GraphBranchPreviewDialog({
  open,
  preview,
  onOpenChange
}: {
  open: boolean;
  preview: GraphBranchPreview | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [changeIndex, setChangeIndex] = useState(0);
  const [detailTab, setDetailTab] = useState<"watch" | "all">("watch");
  const [flowFilter, setFlowFilter] = useState(ALL_FLOWS);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<Node, Edge> | null>(null);
  const fittedPreviewKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      setChangeIndex(0);
      setDetailTab("watch");
      setFlowFilter(ALL_FLOWS);
    } else {
      fittedPreviewKeyRef.current = null;
    }
  }, [open, preview?.baseCommit, preview?.candidateCommit]);

  const changedFlows = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; count: number }>();
    for (const item of preview?.changes ?? []) {
      const current = byId.get(item.flowId);
      if (current) current.count += 1;
      else byId.set(item.flowId, { id: item.flowId, name: item.flowName, count: 1 });
    }
    return [...byId.values()];
  }, [preview]);
  const scopedChangeIndexes = useMemo(() => (preview?.changes ?? []).flatMap((item, index) =>
    flowFilter === ALL_FLOWS || item.flowId === flowFilter ? [index] : []
  ), [flowFilter, preview]);
  const scopePosition = Math.max(0, scopedChangeIndexes.indexOf(changeIndex));
  const change = preview?.changes[changeIndex] ?? null;
  const previewFlow = change ? preview?.flows.find((item) => item.flow.id === change.flowId) ?? null : null;
  const activeSubflowId = useMemo(() => {
    if (!previewFlow || !change) return null;
    const changedNode = change.nodeIds
      .map((nodeId) => previewFlow.flow.nodes.find((node) => node.id === nodeId))
      .find(Boolean);
    return changedNode?.subflowId ?? null;
  }, [change, previewFlow]);
  const visibleNodes = useMemo(() => {
    if (!previewFlow) return [];
    return previewFlow.flow.nodes.filter((node) => (node.subflowId ?? null) === activeSubflowId);
  }, [activeSubflowId, previewFlow]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(() => previewFlow?.flow.edges.filter((edge) =>
    visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
  ) ?? [], [previewFlow, visibleNodeIds]);

  const nodes = useMemo<Node[]>(() => visibleNodes.map((node) => {
    const size = nodeSizeFor(node);
    return {
      id: node.id,
      type: "archicode",
      position: node.position,
      measured: size,
      style: size,
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      data: {
        node,
        signals: undefined,
        selectedExternally: false,
        overlapping: false,
        busyTests: false,
        historicalChange: false,
        previewState: previewFlow?.nodeStates[node.id],
        previewFocused: Boolean(change?.nodeIds.includes(node.id)),
        overviewLabelOffset: { x: 0, y: 0 }
      }
    };
  }), [change?.nodeIds, previewFlow, visibleNodes]);

  const edges = useMemo<Edge[]>(() => visibleEdges.map((edge) => {
    const previewState = previewFlow?.edgeStates[edge.id];
    const selected = change?.edgeId === edge.id;
    const previewColor = previewState === "added"
      ? "var(--preview-added)"
      : previewState === "modified"
        ? "var(--preview-modified)"
        : previewState === "removed"
          ? "var(--preview-removed)"
          : edge.color ?? "var(--accent)";
    const style = edgeStyle(edge);
    return {
      id: edge.id,
      type: "archicode",
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      label: edge.label,
      animated: previewState === "removed" ? false : edge.animated,
      selectable: false,
      deletable: false,
      selected,
      zIndex: selected ? 20 : previewState === "removed" ? 10 : 0,
      style: {
        ...style,
        "--edge-stroke": previewColor,
        stroke: "var(--edge-stroke)",
        strokeWidth: selected ? Math.max(edge.width ?? 2, 4.5) : edge.width ?? 2.5,
        ...(previewState === "removed" ? { strokeDasharray: "10 6" } : {})
      },
      data: {
        pathKind: "smoothstep",
        arrowColor: previewColor,
        bidirectional: edge.bidirectional,
        previewState
      }
    };
  }), [change?.edgeId, previewFlow, visibleEdges]);

  useEffect(() => {
    if (!reactFlow || !open || !nodes.length) return;
    const focusIds = change?.nodeIds.filter((nodeId) => visibleNodeIds.has(nodeId)) ?? [];
    const previewKey = preview ? `${preview.baseCommit}:${preview.candidateCommit}` : null;
    const frame = window.requestAnimationFrame(() => {
      if (previewKey && fittedPreviewKeyRef.current !== previewKey) {
        fittedPreviewKeyRef.current = previewKey;
        void reactFlow.fitView({
          nodes,
          padding: 0.2,
          minZoom: 0.2,
          maxZoom: 1.15,
          duration: 280
        });
        return;
      }

      const zoom = reactFlow.getZoom();
      const focusNodes = focusIds.length
        ? focusIds.map((id) => ({ id }))
        : nodes.map(({ id }) => ({ id }));
      void reactFlow.fitView({
        nodes: focusNodes,
        padding: 0,
        minZoom: zoom,
        maxZoom: zoom,
        duration: 280
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [change?.id, nodes, open, preview, reactFlow, visibleNodeIds]);

  const total = preview?.changes.length ?? 0;
  const scopedTotal = scopedChangeIndexes.length;
  const canGoBack = scopePosition > 0;
  const canGoForward = scopePosition + 1 < scopedTotal;
  const shortBase = preview?.baseCommit.slice(0, 7) ?? "";
  const shortCandidate = preview?.candidateCommit.slice(0, 7) ?? "";
  const selectFlow = (value: string) => {
    setFlowFilter(value);
    if (value === ALL_FLOWS) return;
    const firstIndex = preview?.changes.findIndex((item) => item.flowId === value) ?? -1;
    if (firstIndex >= 0) setChangeIndex(firstIndex);
  };
  const moveChange = (offset: -1 | 1) => {
    const nextPosition = Math.min(scopedTotal - 1, Math.max(0, scopePosition + offset));
    const nextIndex = scopedChangeIndexes[nextPosition];
    if (nextIndex !== undefined) setChangeIndex(nextIndex);
  };

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t("Graph change preview")}
        description={preview
          ? t("Read-only comparison of graph changes introduced by {{candidateRef}} relative to {{baseRef}}.", {
              candidateRef: preview.candidateRef,
              baseRef: preview.baseRef
            })
          : t("Read-only graph comparison.")}
        className="graph-branch-preview-dialog"
      >
        {!preview ? null : (
          <div className="graph-branch-preview">
            <header className="graph-branch-preview-summary">
              <div className="graph-branch-preview-refs">
                <GitCompareArrows size={17} aria-hidden="true" />
                <span><strong>{preview.candidateRef}</strong><small>{shortCandidate}</small></span>
                <span aria-hidden="true">→</span>
                <span><strong>{preview.baseRef}</strong><small>{shortBase}</small></span>
              </div>
              <div className="graph-branch-preview-counts">
                <Badge tone="success">{t("{{count}} added", { count: preview.stats.added })}</Badge>
                <Badge tone="warning">{t("{{count}} modified", { count: preview.stats.modified })}</Badge>
                <Badge tone="danger">{t("{{count}} removed", { count: preview.stats.removed })}</Badge>
                <Tooltip content={t("This preview never modifies files, branches, or the graph.")}>
                  <span><Badge>{t("Read-only")}</Badge></span>
                </Tooltip>
              </div>
            </header>

            {!total ? (
              <div className="graph-branch-preview-empty">
                <Eye size={30} aria-hidden="true" />
                <strong>{t("No graph changes in this comparison.")}</strong>
                <p>{t("This preview checks committed ArchiCode graph data only. It does not analyze whether source-code changes should have changed the graph.")}</p>
              </div>
            ) : (
              <>
                <div className="graph-branch-preview-stage">
                  <section className="graph-branch-preview-canvas" aria-label={t("Graph preview canvas")}>
                    <ReactFlow
                      nodes={nodes}
                      edges={edges}
                      nodeTypes={nodeTypes}
                      edgeTypes={edgeTypes}
                      connectionMode={ConnectionMode.Loose}
                      nodesDraggable={false}
                      nodesConnectable={false}
                      elementsSelectable={false}
                      panOnDrag
                      zoomOnScroll
                      minZoom={0.1}
                      maxZoom={1.5}
                      onInit={setReactFlow}
                      proOptions={{ hideAttribution: true }}
                    >
                      <Background gap={24} size={1} />
                      <Controls showInteractive={false} />
                    </ReactFlow>
                  </section>

                  {change ? (
                    <aside className="graph-branch-preview-detail">
                      <TabsRoot
                        value={detailTab}
                        onValueChange={(value) => setDetailTab(value as "watch" | "all")}
                        className="graph-branch-preview-side-tabs"
                      >
                        <TabsList className="ui-tabs-list compact graph-branch-preview-tab-list">
                          <TabsTrigger value="watch">{t("Watch changes")}</TabsTrigger>
                          <TabsTrigger value="all">
                            <span>{t("All changes")}</span>
                            <Badge>{total}</Badge>
                          </TabsTrigger>
                        </TabsList>

                        <TabsContent value="watch" className="graph-branch-preview-tab graph-branch-preview-watch">
                          <div className="graph-branch-preview-detail-head">
                            <Badge tone={changeTone(change.changeKind)}>{changeKindLabel(change.changeKind)}</Badge>
                            <span>{entityKindLabel(change)}</span>
                            {change.layoutOnly ? (
                              <Tooltip content={t("Only position or size changed; graph meaning is unchanged.")}>
                                <span><Badge>{t("Layout only")}</Badge></span>
                              </Tooltip>
                            ) : null}
                          </div>
                          <div className="graph-branch-preview-flow-context">
                            <span className="ui-eyebrow">{t("Flow")}</span>
                            <strong>{change.flowName}</strong>
                          </div>
                          <h3>{change.title}</h3>
                          {change.fields.length ? (
                            <div className={`graph-branch-preview-fields${change.changeKind === "added" ? " is-added-properties" : ""}`}>
                              {change.fields.map((field) => (
                                <article key={field.field}>
                                  <strong>{t(field.label)}</strong>
                                  {change.changeKind === "added" ? (
                                    <code>{localizedFieldValue(field.after)}</code>
                                  ) : (
                                    <div>
                                      <span><small>{t("Before")}</small><code>{localizedFieldValue(field.before)}</code></span>
                                      <ChevronRight size={14} aria-hidden="true" />
                                      <span><small>{t("After")}</small><code>{localizedFieldValue(field.after)}</code></span>
                                    </div>
                                  )}
                                </article>
                              ))}
                            </div>
                          ) : (
                            <p>{change.changeKind === "added"
                              ? t("This graph element will be introduced by the candidate branch.")
                              : t("This graph element will be removed by the candidate branch.")}</p>
                          )}
                        </TabsContent>

                        <TabsContent value="all" className="graph-branch-preview-tab">
                          <div className="graph-branch-preview-flow-filter">
                            <span className="ui-eyebrow">{t("Filter by flow")}</span>
                            <Select
                              value={flowFilter}
                              onValueChange={selectFlow}
                              ariaLabel={t("Filter by flow")}
                              options={[
                                { value: ALL_FLOWS, label: t("All flows"), hint: String(total) },
                                ...changedFlows.map((flow) => ({
                                  value: flow.id,
                                  label: flow.name,
                                  hint: String(flow.count)
                                }))
                              ]}
                            />
                          </div>
                          <div className="graph-branch-preview-change-list">
                            {changedFlows
                              .filter((flow) => flowFilter === ALL_FLOWS || flow.id === flowFilter)
                              .map((flow) => {
                                const flowChanges = preview.changes
                                  .map((item, index) => ({ item, index }))
                                  .filter(({ item }) => item.flowId === flow.id);
                                return (
                                  <section key={flow.id} className="graph-branch-preview-change-group">
                                    <header>
                                      <strong>{flow.name}</strong>
                                      <Badge>{flowChanges.length}</Badge>
                                    </header>
                                    {flowChanges.map(({ item, index }) => (
                                      <button
                                        key={item.id}
                                        type="button"
                                        className={`graph-branch-preview-change-item is-${item.changeKind}${index === changeIndex ? " is-active" : ""}`}
                                        aria-current={index === changeIndex ? "true" : undefined}
                                        onClick={() => setChangeIndex(index)}
                                        title={`${flow.name} · ${item.title}`}
                                      >
                                        <span className="graph-branch-preview-change-marker" aria-hidden="true" />
                                        <span>
                                          <strong>{item.title}</strong>
                                          <small>{entityKindLabel(item)}</small>
                                        </span>
                                        <code>{index + 1}</code>
                                      </button>
                                    ))}
                                  </section>
                                );
                              })}
                          </div>
                        </TabsContent>
                      </TabsRoot>
                    </aside>
                  ) : null}
                </div>

                <footer className="graph-branch-preview-navigation">
                  <Button type="button" size="sm" onClick={() => moveChange(-1)} disabled={!canGoBack}>
                    <ChevronLeft size={15} />
                    <span>{t("Previous")}</span>
                  </Button>
                  <div>
                    <strong>{t("Change {{current}} of {{total}}", { current: scopePosition + 1, total: scopedTotal })}</strong>
                    <small><span>{t("Flow")}:</span> {change?.flowName}</small>
                  </div>
                  <Button type="button" size="sm" variant="primary" onClick={() => moveChange(1)} disabled={!canGoForward}>
                    <span>{t("Next")}</span>
                    <ChevronRight size={15} />
                  </Button>
                </footer>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
