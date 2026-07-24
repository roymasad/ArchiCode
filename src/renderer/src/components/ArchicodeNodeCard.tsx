import { t } from "@renderer/i18n";
import { Handle, NodeResizer, useViewport, type NodeProps } from "@xyflow/react";
import { AlertTriangle, Boxes, CheckCircle2, ChevronRight, EyeOff, FileCode2, Layers3, Loader2, Lock, MessageSquare, Paperclip, Pin, Wrench } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import type { ArchicodeNode } from "@shared/schema";
import { nodePolicyViolationTooltip, type NodeSignalCounts } from "../utils/nodeSignals";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { readableTextForBackground } from "../utils/colorContrast";
import { nodeHandleSides } from "../utils/graphHandles";
import { nodeContextTargets } from "../utils/nodeContext";
import { Tooltip } from "./ui";

const nodeSizeBounds = {
  width: { min: 180, max: 420 },
  height: { min: 116, max: 300 }
};

export const nodeDetailZoomThreshold = 0.42;

const stageLabels: Record<ArchicodeNode["stage"], string> = {
  planned: "Planned",
  "plan-approved": "Plan Approved",
  working: "Working",
  draft: "Draft",
  "draft-rejected": "Draft Rejected",
  "draft-approved-production": "Production"
};

function NodeSignalTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="node-signal-tip nodrag" title={label} aria-label={label}>
      {children}
    </span>
  );
}

function NodeContextTooltip({ node, signals }: { node: ArchicodeNode; signals?: NodeSignalCounts }) {
  const [implementationExpanded, setImplementationExpanded] = useState(false);
  const targets = nodeContextTargets(node);
  const stack = node.techStack.slice(0, 6);
  const pinnedNotes = signals?.pinnedNotes ?? 0;
  const badges: Array<{ id: string; label: string; tone: "neutral" | "accent" | "warning" | "danger" | "success"; icon: ReactNode }> = [];
  if (signals?.openQuestions || node.flags.includes("llm-question")) badges.push({ id: "questions", label: signals?.openQuestions ? `${signals.openQuestions} open question${signals.openQuestions === 1 ? "" : "s"}` : "Agent question", tone: "accent", icon: <MessageSquare size={11} aria-hidden="true" /> });
  if (signals?.policyViolations) badges.push({ id: "policy-violations", label: t("{{policyViolations}} architecture violation {{value2}}", { policyViolations: signals.policyViolations, value2: signals.policyViolations === 1 ? "" : "s" }), tone: "danger", icon: <AlertTriangle size={11} aria-hidden="true" /> });
  if (node.flags.includes("needs-attention")) badges.push({ id: "attention", label: t("Needs attention"), tone: "danger", icon: <AlertTriangle size={11} aria-hidden="true" /> });
  if (node.flags.includes("modified-not-built")) badges.push({ id: "unverified", label: t("Build not verified"), tone: "warning", icon: <Wrench size={11} aria-hidden="true" /> });
  if (node.flags.includes("changed")) badges.push({ id: "changed", label: t("Change pending"), tone: "warning", icon: <AlertTriangle size={11} aria-hidden="true" /> });
  if (node.flags.includes("has-diff")) badges.push({ id: "diff", label: t("Source diff linked"), tone: "neutral", icon: <FileCode2 size={11} aria-hidden="true" /> });
  if (node.flags.includes("user-approved")) badges.push({ id: "approved", label: t("User approved"), tone: "success", icon: <CheckCircle2 size={11} aria-hidden="true" /> });
  if (node.locked) badges.push({ id: "locked", label: t("Locked"), tone: "neutral", icon: <Lock size={11} aria-hidden="true" /> });
  if (node.ignored) badges.push({ id: "ignored", label: t("Ignored by agents"), tone: "neutral", icon: <EyeOff size={11} aria-hidden="true" /> });
  if (signals?.notes) badges.push({ id: "notes", label: t("{{notes}} note {{value2}}", { notes: signals.notes, value2: signals.notes === 1 ? "" : "s" }), tone: "neutral", icon: <MessageSquare size={11} aria-hidden="true" /> });
  if (signals?.attachments || node.flags.includes("has-attachments")) badges.push({ id: "attachments", label: signals?.attachments ? `${signals.attachments} attachment${signals.attachments === 1 ? "" : "s"}` : "Has attachments", tone: "neutral", icon: <Paperclip size={11} aria-hidden="true" /> });
  return (
    <span className="semantic-lens-tooltip node-context-tooltip">
      <span className="semantic-lens-tooltip-heading">
        <span><Boxes size={13} aria-hidden="true" /><strong>{t("Node context")}</strong></span>
        <small>{node.type}</small>
      </span>
      <span className="node-context-related-section">
        <button type="button" className="node-context-section-toggle nodrag nopan" aria-expanded={implementationExpanded} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setImplementationExpanded((current) => !current); }}>
          <span>
            <b>{t("Related implementation")}</b>
            <small>{targets.length ? t("{{length}} top match {{value2}}", { length: targets.length, value2: targets.length === 1 ? "" : "es" }) : t("No recorded matches")}</small>
          </span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        {implementationExpanded ? <span className="node-context-related-items">
          <small>{t("Top files, classes, or symbols")}</small>
          {targets.length ? targets.map((target) => (
            <span className="node-context-target" key={`${target.kind}:${target.path}:${target.label}`}>
              <span className="node-context-target-icon"><FileCode2 size={14} aria-hidden="true" /></span>
              <span>
                <b>{target.label}</b>
                <small>{t("{{kind}} · {{path}}", { kind: target.kind, path: target.path })}</small>
              </span>
            </span>
          )) : <span className="node-context-empty">{t("No related implementation has been recorded for this node.")}</span>}
        </span> : null}
      </span>
      <span className="node-context-meta-section">
        <span className="semantic-lens-section-title">
          <b>{t("Tech stack")}</b>
          <small>{node.techStack.length ? t("{{length}} tagged", { length: node.techStack.length }) : t("No tags")}</small>
        </span>
        {stack.length ? <span className="node-context-stack"><Layers3 size={13} aria-hidden="true" />{stack.map((item) => <span key={item}>{item}</span>)}{node.techStack.length > stack.length ? <em>{t("+ {{length}}", { length: node.techStack.length - stack.length })}</em> : null}</span> : <span className="node-context-empty">{t("No technologies tagged.")}</span>}
      </span>
      {badges.length ? <span className="node-context-meta-section node-context-notifications">
        <span className="semantic-lens-section-title">
          <b>{t("Badges & notifications")}</b>
          <small>{t("{{length}} active", { length: badges.length })}</small>
        </span>
        <span className="node-context-badges">
          {badges.map((badge) => (
            <span className={`node-context-badge tone-${badge.tone}`} key={badge.id}>
              {badge.icon}
              {badge.label}
            </span>
          ))}
        </span>
      </span> : null}
      <span className="node-context-pinned"><Pin size={13} aria-hidden="true" /><b>{pinnedNotes}</b> {" "}{t("pinned note")}{pinnedNotes === 1 ? "" : t("s")}</span>
    </span>
  );
}

type PrimaryNodeSignal = {
  kind: "question" | "warning" | "verify";
  label: string;
  icon: ReactNode;
};

function primaryNodeSignal(flags: Set<ArchicodeNode["flags"][number]>, signals?: NodeSignalCounts): PrimaryNodeSignal | null {
  if (flags.has("llm-question") || Boolean(signals?.openQuestions)) {
    return {
      kind: "question",
      label: t("The agent has a question that needs an answer. Check Notes."),
      icon: <MessageSquare size={13} aria-hidden="true" />
    };
  }

  if (flags.has("needs-attention")) {
    return {
      kind: "warning",
      label: t("Open Activity > Errors or the latest run details for this node."),
      icon: <AlertTriangle size={13} aria-hidden="true" />
    };
  }

  if (flags.has("modified-not-built")) {
    return {
      kind: "verify",
      label: t("This node has source changes that have not passed a build/test/check command yet. Use AI Run > Build."),
      icon: <Wrench size={13} aria-hidden="true" />
    };
  }

  if (flags.has("changed")) {
    return {
      kind: "warning",
      label: t("This node has changed planning state. Requires implementation."),
      icon: <AlertTriangle size={13} aria-hidden="true" />
    };
  }

  return null;
}

export function ArchicodeNodeCard({ data, selected, dragging }: NodeProps) {
  const node = data.node as ArchicodeNode;
  const signals = data.signals as NodeSignalCounts | undefined;
  const { zoom } = useViewport();
  const updateNode = useArchicodeStore((state) => state.updateNode);
  const isSelected = selected || Boolean(data.selectedExternally);
  const isOverlapping = Boolean(data.overlapping);
  const isBusyTests = Boolean(data.busyTests);
  const isHistoricalChange = Boolean(data.historicalChange);
  const previewState = data.previewState as "added" | "modified" | "removed" | undefined;
  const previewFocused = Boolean(data.previewFocused);
  const onExplainPolicyViolations = data.onExplainPolicyViolations as (() => void) | undefined;
  const flags = new Set(node.flags);
  const primarySignal = primaryNodeSignal(flags, signals);
  const zoomMode = zoom < nodeDetailZoomThreshold ? "overview" : "full";
  const overviewTextScale = zoomMode === "overview"
    ? Math.min(18, Math.max(1.6, 0.96 / zoom))
    : 1;
  const overviewLabelOffset = data.overviewLabelOffset as { x?: number; y?: number } | undefined;
  const overviewLabelOffsetX = typeof overviewLabelOffset?.x === "number" ? overviewLabelOffset.x : 0;
  const overviewLabelOffsetY = typeof overviewLabelOffset?.y === "number" ? overviewLabelOffset.y : 0;
  const shape = node.visual?.shape ?? "rounded";
  const nodeStyle = {
    ...(node.size ? { width: node.size.width, height: node.size.height } : {}),
    ...(node.visual?.backgroundColor ? { "--node-background": node.visual.backgroundColor } : {}),
    ...(node.visual?.backgroundColor ? { "--node-text": readableTextForBackground(node.visual.backgroundColor) } : {})
  } as CSSProperties;

  const card = (
    <div
      className={`flow-node shape-${shape} stage-${node.stage} zoom-${zoomMode} ${isSelected ? "is-selected" : ""} ${isOverlapping ? "is-overlapping" : ""} ${node.locked ? "is-locked" : ""} ${node.ignored ? "is-ignored" : ""} ${isBusyTests ? "is-authoring-tests" : ""} ${signals?.policyViolations ? "has-policy-violation" : ""} ${isHistoricalChange ? "is-historical-change" : ""} ${previewState ? `is-preview-${previewState}` : ""} ${previewFocused ? "is-preview-focused" : ""}`}
      style={nodeStyle}
    >
      {isBusyTests ? (
        <NodeSignalTip label={t("Generating acceptance tests… An AI agent is writing test files for this node's criteria. This can take a minute.")}>
          <div className="node-authoring-badge">
            <Loader2 size={18} className="is-spinning" />
          </div>
        </NodeSignalTip>
      ) : null}
      <NodeResizer
        isVisible={isSelected && zoomMode === "full"}
        minWidth={nodeSizeBounds.width.min}
        minHeight={nodeSizeBounds.height.min}
        maxWidth={nodeSizeBounds.width.max}
        maxHeight={nodeSizeBounds.height.max}
        handleClassName="flow-node-resize-handle"
        lineClassName="flow-node-resize-line"
        onResizeEnd={(_event, params) => {
          void updateNode({
            id: node.id,
            position: { x: Math.round(params.x), y: Math.round(params.y) },
            size: { width: Math.round(params.width), height: Math.round(params.height) }
          });
        }}
      />
      {nodeHandleSides.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type="source"
          position={handle.position}
          className={`node-connection-handle handle-${handle.id}`}
          aria-label={t("{{id}} connection handle", { id: handle.id })}
        />
      ))}
      {nodeHandleSides.map((handle) => (
        <span
          key={`pin-${handle.id}`}
          className={`node-connection-pin pin-${handle.id}`}
          aria-hidden="true"
        />
      ))}
      {zoomMode === "full" ? (
        <>
          <div className="node-header">
            <span className="node-type">{node.type}</span>
            <span className="node-stage">{stageLabels[node.stage]}</span>
          </div>
          <div className="node-title-row">
            <strong>{node.title}</strong>
            {node.locked ? (
              <NodeSignalTip label={t("Locked node")}>
                <Lock size={15} aria-hidden="true" />
              </NodeSignalTip>
            ) : null}
          </div>
          <p>{node.description}</p>
          <div className="node-signals">
            {primarySignal ? (
              <NodeSignalTip label={primarySignal.label}>
                <span className={`node-primary-signal ${primarySignal.kind}`}>{primarySignal.icon}</span>
              </NodeSignalTip>
            ) : null}
            {node.ignored ? (
              <NodeSignalTip label={t("Ignored by agents")}>
                <EyeOff size={16} aria-hidden="true" />
              </NodeSignalTip>
            ) : null}
            {signals?.notes ? (
              <NodeSignalTip label={t("{{notes}} note {{value2}}", { notes: signals.notes, value2: signals.notes === 1 ? "" : "s" })}>
                <span className="node-count-badge">{t("C {{notes}}", { notes: signals.notes })}</span>
              </NodeSignalTip>
            ) : null}
            {signals?.attachments ? (
              <NodeSignalTip label={t("{{attachments}} attachment {{value2}}", { attachments: signals.attachments, value2: signals.attachments === 1 ? "" : "s" })}>
                <span className="node-count-badge">{t("A {{attachments}}", { attachments: signals.attachments })}</span>
              </NodeSignalTip>
            ) : null}
            {signals?.policyViolations ? (
              <NodeSignalTip label={nodePolicyViolationTooltip(signals.policyViolations)}>
                <button
                  type="button"
                  className="node-count-badge danger is-action nodrag nopan"
                  aria-label={t("Explain {{policyViolations}} architecture violation {{value2}} and suggest resolution", { policyViolations: signals.policyViolations, value2: signals.policyViolations === 1 ? "" : "s" })}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onExplainPolicyViolations?.();
                  }}
                >{t("P {{policyViolations}}", { policyViolations: signals.policyViolations })}</button>
              </NodeSignalTip>
            ) : null}
          </div>
        </>
      ) : (
        <div
          className="node-overview-chip"
          style={{
            "--overview-text-scale": String(overviewTextScale),
            "--overview-label-offset-x": `${overviewLabelOffsetX / Math.max(zoom, 0.05)}px`,
            "--overview-label-offset-y": `${overviewLabelOffsetY / Math.max(zoom, 0.05)}px`
          } as CSSProperties}
        >
          <strong title={node.title}>{node.title}</strong>
          {primarySignal || node.locked || node.ignored ? (
            <div className="node-overview-meta">
              {primarySignal ? (
                <NodeSignalTip label={primarySignal.label}>
                  <span className={`node-primary-signal ${primarySignal.kind}`}>{primarySignal.icon}</span>
                </NodeSignalTip>
              ) : null}
              {node.locked ? (
                <NodeSignalTip label={t("Locked node")}>
                  <span className="node-zoom-icon">
                    <Lock size={13} aria-hidden="true" />
                  </span>
                </NodeSignalTip>
              ) : null}
              {node.ignored ? (
                <NodeSignalTip label={t("Ignored by agents")}>
                  <span className="node-zoom-icon">
                    <EyeOff size={13} aria-hidden="true" />
                  </span>
                </NodeSignalTip>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
  return (
    <Tooltip disabled={dragging} content={<NodeContextTooltip node={node} signals={signals} />}>
      {card}
    </Tooltip>
  );
}
