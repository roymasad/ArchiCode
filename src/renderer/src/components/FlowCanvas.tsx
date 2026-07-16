import {
  Background,
  ConnectionMode,
  Controls,
  ControlButton,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ViewportPortal,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type OnNodeDrag,
  type NodeMouseHandler,
  type ReactFlowInstance
} from "@xyflow/react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignHorizontalSpaceAround,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceAround,
  AlertTriangle,
  Bot,
  Box,
  Bug,
  ChevronRight,
  CircleHelp,
  CircleDot,
  ClipboardList,
  Copy,
  EyeOff,
  FileCode2,
  FilePenLine,
  GitBranch,
  Map,
  Maximize2,
  Merge,
  MessageSquare,
  Network,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  X,
  ZoomIn
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ArchicodeNode, ArchitecturePolicyViolation } from "@shared/schema";
import type { Flow, ResearchChatScope } from "@shared/schema";
import type { CodeKnowledgeSnapshot } from "@shared/codeKnowledge";
import { isProductionApproved } from "@shared/schema";
import { visibleEdgesForNodes, visibleNodesForFlow } from "@shared/graph";
import { ArchicodeNodeCard, nodeDetailZoomThreshold } from "./ArchicodeNodeCard";
import { ArchicodeEdge } from "./ArchicodeEdge";
import { FlowCanvas3DView } from "./FlowCanvas3DView";
import { CodeKnowledgeMapView } from "./CodeKnowledgeMapView";
import { CodeDetailKnowledgeMapView } from "./CodeDetailKnowledgeMapView";
import { getActiveFlow, useArchicodeStore } from "../store/useArchicodeStore";
import { getNodeSignalCounts } from "../utils/nodeSignals";
import { builtInNodeTypes } from "../utils/nodeTypes";
import { canvasBackgroundStyle } from "../utils/canvasBackgrounds";
import { matches as chordMatches, type KeyChord } from "../utils/keybindings";
import { inferEdgeHandleSides } from "../utils/graphHandles";
import { explainNodesPrompt, explainPolicyViolationsPrompt } from "../utils/explainPrompts";
import { Button, DialogContent, DialogRoot, Tooltip } from "./ui";

const nodeTypes = {
  archicode: ArchicodeNodeCard
};

const edgeTypes: EdgeTypes = {
  archicode: ArchicodeEdge,
  archicodeCurved: ArchicodeEdge
};

const multiSelectionKeyCode = ["Shift", "Meta", "Control"];
const minimapContextScale = 4;
const minimapSize = { width: 196, height: 147 };
const minimapOffsetScale = ((minimapContextScale - 1) / 2) * minimapSize.width;
const policyEdgeColor = "#ff3f5f";

function policyNodePairKey(leftNodeId: string, rightNodeId: string): string {
  return leftNodeId < rightNodeId ? `${leftNodeId}\0${rightNodeId}` : `${rightNodeId}\0${leftNodeId}`;
}

const defaultNodeSize = {
  width: 248,
  height: 154
};

function nodeSizeFor(node: ArchicodeNode) {
  return node.size ?? defaultNodeSize;
}

function flowScopeBreadcrumb(flow: Flow, activeSubflowId: string | null): Array<{ id: string | null; name: string }> {
  const items: Array<{ id: string | null; name: string }> = [{ id: null, name: flow.name }];
  if (!activeSubflowId) return items;
  const byId = new globalThis.Map(flow.subflows.map((subflow) => [subflow.id, subflow]));
  const branch: Array<{ id: string; name: string }> = [];
  const visited = new Set<string>();
  let current = byId.get(activeSubflowId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    branch.unshift({ id: current.id, name: current.name });
    current = current.parentSubflowId ? byId.get(current.parentSubflowId) : undefined;
  }
  return [...items, ...branch];
}

type NodeArrangeAction =
  | "align-left"
  | "align-center-horizontal"
  | "align-right"
  | "align-top"
  | "align-center-vertical"
  | "align-bottom"
  | "distribute-horizontal"
  | "distribute-vertical";

type NodeLayoutBox = {
  node: ArchicodeNode;
  position: { x: number; y: number };
  size: { width: number; height: number };
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function layoutBoxesFor(nodes: ArchicodeNode[], livePositions: globalThis.Map<string, { x: number; y: number }>) {
  return nodes.map((node) => {
    const position = livePositions.get(node.id) ?? node.position;
    const size = nodeSizeFor(node);
    return {
      node,
      position,
      size,
      left: position.x,
      top: position.y,
      right: position.x + size.width,
      bottom: position.y + size.height
    } satisfies NodeLayoutBox;
  });
}

function arrangedPositionsFor(layouts: NodeLayoutBox[], action: NodeArrangeAction) {
  const nextPositions = new globalThis.Map<string, { x: number; y: number }>();
  if (layouts.length < 2) return nextPositions;

  const minLeft = Math.min(...layouts.map((layout) => layout.left));
  const maxRight = Math.max(...layouts.map((layout) => layout.right));
  const minTop = Math.min(...layouts.map((layout) => layout.top));
  const maxBottom = Math.max(...layouts.map((layout) => layout.bottom));
  const centerX = (minLeft + maxRight) / 2;
  const centerY = (minTop + maxBottom) / 2;

  const assign = (layout: NodeLayoutBox, position: { x: number; y: number }) => {
    nextPositions.set(layout.node.id, position);
  };

  switch (action) {
    case "align-left":
      layouts.forEach((layout) => assign(layout, { x: minLeft, y: layout.top }));
      break;
    case "align-center-horizontal":
      layouts.forEach((layout) => assign(layout, { x: centerX - layout.size.width / 2, y: layout.top }));
      break;
    case "align-right":
      layouts.forEach((layout) => assign(layout, { x: maxRight - layout.size.width, y: layout.top }));
      break;
    case "align-top":
      layouts.forEach((layout) => assign(layout, { x: layout.left, y: minTop }));
      break;
    case "align-center-vertical":
      layouts.forEach((layout) => assign(layout, { x: layout.left, y: centerY - layout.size.height / 2 }));
      break;
    case "align-bottom":
      layouts.forEach((layout) => assign(layout, { x: layout.left, y: maxBottom - layout.size.height }));
      break;
    case "distribute-horizontal": {
      const sorted = [...layouts].sort((left, right) =>
        left.left - right.left || left.top - right.top || left.node.id.localeCompare(right.node.id)
      );
      const totalWidth = sorted.reduce((sum, layout) => sum + layout.size.width, 0);
      const gap = sorted.length > 1 ? (maxRight - minLeft - totalWidth) / (sorted.length - 1) : 0;
      let cursor = minLeft;
      for (const layout of sorted) {
        assign(layout, { x: cursor, y: layout.top });
        cursor += layout.size.width + gap;
      }
      break;
    }
    case "distribute-vertical": {
      const sorted = [...layouts].sort((left, right) =>
        left.top - right.top || left.left - right.left || left.node.id.localeCompare(right.node.id)
      );
      const totalHeight = sorted.reduce((sum, layout) => sum + layout.size.height, 0);
      const gap = sorted.length > 1 ? (maxBottom - minTop - totalHeight) / (sorted.length - 1) : 0;
      let cursor = minTop;
      for (const layout of sorted) {
        assign(layout, { x: layout.left, y: cursor });
        cursor += layout.size.height + gap;
      }
      break;
    }
  }

  return nextPositions;
}

type FlowGroupBox = {
  id: string;
  name: string;
  color: string;
  memberCount: number;
  nodeIds: string[];
  bounds: { x: number; y: number; width: number; height: number };
};

function groupBoxesFor(nodes: ArchicodeNode[], groups: Flow["groups"] = []): FlowGroupBox[] {
  const groupById = new globalThis.Map(groups.map((group) => [group.id, group]));
  const nodesByGroup = new globalThis.Map<string, ArchicodeNode[]>();
  for (const node of nodes) {
    if (!node.groupId || !groupById.has(node.groupId)) continue;
    nodesByGroup.set(node.groupId, [...(nodesByGroup.get(node.groupId) ?? []), node]);
  }
  return Array.from(nodesByGroup.entries()).flatMap(([groupId, groupedNodes]) => {
    const group = groupById.get(groupId);
    if (!group || groupedNodes.length === 0) return [];
    const minX = Math.min(...groupedNodes.map((node) => node.position.x));
    const minY = Math.min(...groupedNodes.map((node) => node.position.y));
    const maxX = Math.max(...groupedNodes.map((node) => node.position.x + nodeSizeFor(node).width));
    const maxY = Math.max(...groupedNodes.map((node) => node.position.y + nodeSizeFor(node).height));
    const xPadding = 30;
    const topPadding = 42;
    const bottomPadding = 28;
    return [{
      id: group.id,
      name: group.name,
      color: group.color ?? "#7bc6d5",
      memberCount: groupedNodes.length,
      nodeIds: groupedNodes.map((node) => node.id),
      bounds: {
        x: minX - xPadding,
        y: minY - topPadding,
        width: maxX - minX + xPadding * 2,
        height: maxY - minY + topPadding + bottomPadding
      }
    }];
  });
}

function estimatedOverviewLabelSize(node: ArchicodeNode) {
  const titleWidth = Math.min(190, Math.max(72, node.title.length * 8.4));
  const signalWidth = node.flags.length || node.locked || node.ignored ? 28 : 0;
  return {
    width: titleWidth + signalWidth + 28,
    height: 32
  };
}

function overviewLabelOffsetsFor(nodes: ArchicodeNode[], zoom: number) {
  const overviewScale = Math.min(18, Math.max(1.6, 0.96 / Math.max(zoom, 0.01)));
  const screenScale = overviewScale * zoom;
  const layouts = nodes
    .map((node) => {
      const size = nodeSizeFor(node);
      const labelSize = estimatedOverviewLabelSize(node);
      return {
        id: node.id,
        anchorX: (node.position.x + size.width / 2) * zoom,
        anchorY: (node.position.y + size.height / 2) * zoom,
        x: (node.position.x + size.width / 2) * zoom,
        y: (node.position.y + size.height / 2) * zoom,
        width: labelSize.width * screenScale,
        height: labelSize.height * screenScale
      };
    })
    .sort((left, right) =>
      left.anchorY - right.anchorY ||
      left.anchorX - right.anchorX ||
      left.id.localeCompare(right.id)
    );

  const padding = zoom < 0.12 ? 1.5 : zoom < 0.22 ? 2.5 : 4;
  const iterations = zoom < 0.16 ? 72 : 48;
  const maxOffset = zoom < 0.12 ? 48 : zoom < 0.22 ? 40 : 32;

  for (let iteration = 0; iteration < iterations; iteration++) {
    const pushes = layouts.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < layouts.length; i++) {
      for (let j = i + 1; j < layouts.length; j++) {
        const left = layouts[i];
        const right = layouts[j];
        const deltaX = right.x - left.x;
        const deltaY = right.y - left.y;
        const requiredX = (left.width + right.width) / 2 + padding;
        const requiredY = (left.height + right.height) / 2 + padding;
        const overlapX = requiredX - Math.abs(deltaX);
        const overlapY = requiredY - Math.abs(deltaY);
        if (overlapX <= 0 || overlapY <= 0) continue;

        const xSign = deltaX === 0 ? (left.id < right.id ? 1 : -1) : Math.sign(deltaX);
        const ySign = deltaY === 0 ? (left.id < right.id ? 1 : -1) : Math.sign(deltaY);
        if (overlapX < overlapY) {
          const push = (overlapX / 2) * 0.86;
          pushes[i].x -= push * xSign;
          pushes[j].x += push * xSign;
        } else {
          const push = (overlapY / 2) * 0.86;
          pushes[i].y -= push * ySign;
          pushes[j].y += push * ySign;
        }
      }
    }

    for (let index = 0; index < layouts.length; index++) {
      const layout = layouts[index];
      const anchorPull = iteration < iterations * 0.65 ? 0.035 : 0.012;
      layout.x += pushes[index].x + (layout.anchorX - layout.x) * anchorPull;
      layout.y += pushes[index].y + (layout.anchorY - layout.y) * anchorPull;
      const offsetX = layout.x - layout.anchorX;
      const offsetY = layout.y - layout.anchorY;
      const offsetLength = Math.hypot(offsetX, offsetY);
      if (offsetLength > maxOffset) {
        const clamp = maxOffset / offsetLength;
        layout.x = layout.anchorX + offsetX * clamp;
        layout.y = layout.anchorY + offsetY * clamp;
      }
    }
  }

  const offsets = new globalThis.Map<string, { x: number; y: number }>();
  layouts.forEach((layout) => {
    offsets.set(layout.id, { x: layout.x - layout.anchorX, y: layout.y - layout.anchorY });
  });
  return offsets;
}

const defaultEdgeOptions = {
  interactionWidth: 18
};

function getInitialMinimapVisible(): boolean {
  return localStorage.getItem("archicode-minimap-visible") === "true";
}

function matchesChord(chord: KeyChord | undefined, event: KeyboardEvent): boolean {
  return chord ? chordMatches(chord, event) : false;
}

function isEmptyPanePointerTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (!target.closest(".react-flow__pane")) return false;
  return !target.closest(".react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, .canvas-minimap-toggle, .canvas-3d-toggle, .canvas-knowledge-toggle, .node-context-menu");
}

function nodeChatScope(flow: Flow, nodeId: string): ResearchChatScope {
  return { type: "node", flowId: flow.id, nodeId };
}

function visualQaCodeKnowledgeSnapshot(flow: Flow | null): CodeKnowledgeSnapshot | null {
  if (!flow || !new URLSearchParams(window.location.search).has("visualQa")) return null;
  const generatedAt = new Date().toISOString();
  const fileNodes = flow.nodes.slice(0, 48).map((node) => ({
    id: `preview-file-${node.id}`,
    kind: "file" as const,
    label: `${node.title.replace(/\s+/g, "")}.ts`,
    path: `src/${node.type}/${node.title.replace(/\s+/g, "")}.ts`,
    language: "typescript",
    role: "production",
    community: node.customProperties?.["Dependency community"] || node.groupId || node.type,
    architectureNodeId: node.id
  }));
  const symbolNodes = fileNodes.map((file, index) => ({
    id: `preview-symbol-${index}`,
    kind: "symbol" as const,
    label: file.label.replace(/\.ts$/, ""),
    path: file.path,
    line: 4,
    endLine: 24,
    symbolKind: index % 3 === 0 ? "component" : "function",
    language: "typescript",
    role: "symbol",
    community: file.community,
    architectureNodeId: file.architectureNodeId
  }));
  const fileIdByArchitectureNode = new globalThis.Map(fileNodes.map((node) => [node.architectureNodeId, node.id]));
  const containsEdges = fileNodes.map((file, index) => ({
    id: `preview-contains-${index}`,
    source: file.id,
    target: symbolNodes[index].id,
    kind: "contains" as const,
    evidence: { origin: "extracted" as const, confidence: 1, relationKinds: ["contains"], locations: [{ path: file.path, line: 4 }], analyzerVersion: 1, checkedAt: generatedAt, verification: "verified" as const, freshness: "current" as const }
  }));
  const dependencyEdges = flow.edges.flatMap((edge, index) => {
    const source = fileIdByArchitectureNode.get(edge.source);
    const target = fileIdByArchitectureNode.get(edge.target);
    return source && target ? [{
      id: `preview-dependency-${index}`,
      source,
      target,
      kind: "dependency" as const,
      evidence: { origin: "extracted" as const, confidence: 1, relationKinds: ["dependency"], locations: [{ path: fileNodes.find((file) => file.id === source)?.path ?? "src/index.ts", line: 1 }], analyzerVersion: 1, checkedAt: generatedAt, verification: "verified" as const, freshness: "current" as const }
    }] : [];
  });
  const communities = [...new Set(fileNodes.map((node) => node.community))].map((id) => ({ id, label: id, nodeCount: [...fileNodes, ...symbolNodes].filter((node) => node.community === id).length }));
  return {
    version: 1,
    generatedAt,
    source: "codebase-import",
    nodes: [...fileNodes, ...symbolNodes],
    edges: [...containsEdges, ...dependencyEdges],
    communities,
    stats: { files: fileNodes.length, symbols: symbolNodes.length, dependencies: dependencyEdges.length, calls: 0, availableNodes: fileNodes.length + symbolNodes.length, availableEdges: containsEdges.length + dependencyEdges.length, truncated: false, unresolvedImports: 0, resolutionRate: 1 }
  };
}

function taggedNodeContext(nodes: ArchicodeNode[], flowId: string): string {
  const tags = nodes.map((node) => (
    `[@${node.title}](archicode://node/${encodeURIComponent(flowId)}/${encodeURIComponent(node.id)})`
  ));
  return `Tagged node${nodes.length === 1 ? "" : "s"}: ${tags.join(", ")}`;
}

function specReviewPrompt(node: ArchicodeNode, flow: Flow): string {
  const linkedSubflow = flow.subflows.find((subflow) => subflow.parentNodeId === node.id);
  return [
    `AI / Review Code Against Spec for node "${node.title}".`,
    "",
    "Compare the current codebase against this node's spec: title, description, acceptance criteria, rules, notes, custom fields, edges, and any linked detail flow.",
    linkedSubflow ? `Include linked detail flow "${linkedSubflow.name}" in the review.` : "If there is no linked detail flow, review only this node and related graph/code context.",
    "Report what appears in sync, what appears missing or incorrect, and what evidence you used.",
    "If the graph and code are out of sync, discuss whether the graph should change or code should change. Propose graph/note edits or an implementation run only after explaining the tradeoff and getting user consent."
  ].join("\n");
}

function multiNodeSpecReviewPrompt(nodes: ArchicodeNode[], flow: Flow): string {
  if (nodes.length === 1) return specReviewPrompt(nodes[0], flow);
  return [
    `AI / Review Code Against Specs for ${nodes.length} selected nodes: ${nodes.map((node) => `@${node.title}`).join(", ")}.`,
    "",
    "Compare the current codebase against each selected node's title, description, acceptance criteria, rules, notes, custom fields, edges, and linked detail flow.",
    "Report findings per node, then call out shared gaps, conflicts, or duplicated responsibilities across the selection.",
    "Explain what appears in sync, what appears missing or incorrect, and what evidence you used.",
    "If graph and code are out of sync, discuss whether the graph or code should change. Propose graph/note edits or an implementation run only after explaining the tradeoff and getting user consent."
  ].join("\n");
}

function bugIssuePrompt(node: ArchicodeNode): string {
  return [
    `AI / Report a Bug/Issue for node "${node.title}".`,
    "",
    "First ask me what bug, issue, or unexpected behavior I want to report.",
    "After I answer, investigate the scoped graph and codebase. Decide whether this is a formal bug, a broader issue, a graph/spec mismatch, or an implementation follow-up.",
    "Use the available ArchiCode options appropriately: add bug-category notes, propose graph/node data edits, prepare a bug report, or propose AI Debug / implementation runs. Do not queue runs or apply graph changes without user consent."
  ].join("\n");
}

function multiNodeBugIssuePrompt(nodes: ArchicodeNode[]): string {
  if (nodes.length === 1) return bugIssuePrompt(nodes[0]);
  return [
    `AI / Report a Bug/Issue for ${nodes.length} selected nodes: ${nodes.map((node) => `@${node.title}`).join(", ")}.`,
    "",
    "First ask me what bug, issue, or unexpected behavior I want to report and how it relates to these nodes.",
    "After I answer, investigate the selected graph context and codebase. Decide whether this is a formal bug, a broader issue, a cross-node graph/spec mismatch, or an implementation follow-up.",
    "Use the available ArchiCode options appropriately. Do not queue runs or apply graph changes without user consent."
  ].join("\n");
}

function refineNodePrompt(node: ArchicodeNode, flow: Flow): string {
  const linkedSubflow = flow.subflows.find((subflow) => subflow.parentNodeId === node.id);
  const relatedEdges = flow.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  return [
    `Refine @${node.title} in place by reviewing its current specification and adding useful missing detail.`,
    "",
    "Current node:",
    `- Type: ${node.type}`,
    `- Description: ${node.description || "(none)"}`,
    `- Acceptance criteria: ${node.acceptanceCriteria.length ? node.acceptanceCriteria.map((criterion) => `  - ${criterion}`).join("\n") : "(none)"}`,
    `- Related edges: ${relatedEdges.length}`,
    `- Linked detail flow: ${linkedSubflow?.name ?? "(none)"}`,
    "",
    "Review the node against its graph relationships, rules, notes, custom fields, linked implementation evidence, and any detail flow. Identify ambiguity, missing responsibilities, incomplete boundaries, untestable criteria, contradictions, and important assumptions.",
    "Propose a focused update to this existing node: improve its description, responsibilities and boundaries, acceptance criteria, relevant rules or notes, and relationship wording where the available evidence supports it.",
    "Keep this as one node. Do not split it, create replacement nodes, delete nodes, or rewire its graph. Preserve its scope, title, and type unless a correction is clearly necessary and you explain why.",
    "Prepare the proposed in-place node edits for review. Do not apply graph changes until I approve them."
  ].join("\n");
}

function multiNodeRefinePrompt(nodes: ArchicodeNode[], flow: Flow): string {
  if (nodes.length === 1) return refineNodePrompt(nodes[0], flow);
  const selectedIds = new Set(nodes.map((node) => node.id));
  const relatedEdges = flow.edges.filter((edge) => selectedIds.has(edge.source) || selectedIds.has(edge.target));
  return [
    `Refine these ${nodes.length} selected nodes in place: ${nodes.map((node) => `@${node.title}`).join(", ")}.`,
    "",
    "Review each selected node against its description, acceptance criteria, rules, notes, custom fields, graph relationships, linked implementation evidence, and any detail flow.",
    "Selected nodes:",
    ...nodes.map((node) => `- @${node.title} (${node.type}): ${node.description || "(no description)"}; ${node.acceptanceCriteria.length} acceptance ${node.acceptanceCriteria.length === 1 ? "criterion" : "criteria"}`),
    "",
    `Related edges in and around the selection: ${relatedEdges.length}.`,
    "For each node, identify ambiguity, missing responsibilities, incomplete boundaries, untestable criteria, contradictions, and important assumptions. Then propose clearer descriptions, responsibilities and boundaries, concrete acceptance criteria, relevant rules or notes, and more precise relationship wording where supported.",
    "Clarify overlaps and handoffs across the selected nodes, but keep every selected node as an individual node. Do not split, combine, replace, create, delete, or rewire nodes.",
    "Prepare the proposed in-place node edits for review. Do not apply graph changes until I approve them."
  ].join("\n");
}

function breakdownNodePrompt(node: ArchicodeNode, flow: Flow): string {
  const outgoingEdges = flow.edges.filter((e) => e.source === node.id);
  const incomingEdges = flow.edges.filter((e) => e.target === node.id);
  const outgoingTargets = outgoingEdges.map((e) => {
    const target = flow.nodes.find((n) => n.id === e.target);
    return target ? `@${target.title}` : "(unknown)";
  });
  const incomingSources = incomingEdges.map((e) => {
    const source = flow.nodes.find((n) => n.id === e.source);
    return source ? `@${source.title}` : "(unknown)";
  });
  return [
    `Review and enrich @${node.title}, then break it down into smaller, well-scoped sub-nodes.`,
    "",
    "Current node:",
    `- Type: ${node.type}`,
    `- Description: ${node.description || "(none)"}`,
    `- Acceptance criteria: ${node.acceptanceCriteria.length ? node.acceptanceCriteria.map((c) => `  - ${c}`).join("\n") : "(none)"}`,
    "",
    "Incoming from:",
    incomingSources.length ? incomingSources.map((s) => `- ${s}`).join("\n") : "(none)",
    "",
    "Outgoing to:",
    outgoingTargets.length ? outgoingTargets.map((t) => `- ${t}`).join("\n") : "(none)",
    "",
    "First identify missing detail, ambiguity, boundaries, assumptions, and untestable criteria in the parent node. Propose an improved parent description and acceptance criteria so it remains a coherent summary and entry point.",
    "Then break its responsibilities into a linked detail flow of focused sub-nodes. If direct peer decomposition is materially better than a detail flow, explain why before proposing it.",
    "For each proposed sub-node, provide:",
    "1. Title and type",
    "2. Short description (1-2 sentences)",
    "3. Acceptance criteria (specific, testable)",
    "4. Which incoming/outgoing edges should connect to it",
    "",
    "Preserve all existing relationships by reconnecting or mirroring edges to the appropriate sub-nodes without losing the parent node's overview role. Prepare the complete parent refinement and breakdown for review; do not apply graph changes until I approve it."
  ].join("\n");
}

function multiNodeBreakdownPrompt(nodes: ArchicodeNode[], flow: Flow): string {
  if (nodes.length === 1) return breakdownNodePrompt(nodes[0], flow);
  const selectedIds = new Set(nodes.map((node) => node.id));
  const relatedEdges = flow.edges.filter((edge) => selectedIds.has(edge.source) || selectedIds.has(edge.target));
  return [
    `Review, enrich, and break down these ${nodes.length} selected nodes: ${nodes.map((node) => `@${node.title}`).join(", ")}.`,
    "",
    "Treat the selection as one connected design scope. For each selected parent, identify missing details, ambiguity, boundaries, assumptions, untestable criteria, overlaps, and handoffs.",
    "Selected nodes:",
    ...nodes.map((node) => `- @${node.title} (${node.type}): ${node.description || "(no description)"}`),
    "",
    `Related edges in and around the selection: ${relatedEdges.length}.`,
    "Propose improved descriptions and acceptance criteria for the selected parent nodes so each remains a coherent summary and entry point. Then propose a linked detail flow of focused sub-nodes for each parent; call out any shared structure without silently merging the parents.",
    "For every proposed sub-node, provide its title, type, description, testable acceptance criteria, parent/detail-flow placement, and edge reconnection plan.",
    "Preserve existing relationships and prepare the complete parent refinements and breakdowns for review. Do not apply graph changes until I approve them."
  ].join("\n");
}

function combineNodesPrompt(nodes: ArchicodeNode[], flow: Flow): string {
  const nodeRefs = nodes.map((n) => `@${n.title}`);
  const nodeDetails = nodes.map((n) => [
    `@${n.title}:`,
    `- Type: ${n.type}`,
    `- Description: ${n.description || "(none)"}`,
    `- Acceptance criteria: ${n.acceptanceCriteria.length ? n.acceptanceCriteria.map((c) => `  - ${c}`).join("\n") : "(none)"}`
  ].join("\n"));
  const internalEdges = flow.edges.filter(
    (e) => nodes.some((n) => n.id === e.source) && nodes.some((n) => n.id === e.target)
  );
  const externalEdges = flow.edges.filter(
    (e) => {
      const sourceInSelection = nodes.some((n) => n.id === e.source);
      const targetInSelection = nodes.some((n) => n.id === e.target);
      return (sourceInSelection && !targetInSelection) || (!sourceInSelection && targetInSelection);
    }
  );
  const externalEdgeDescriptions = externalEdges.map((e) => {
    const source = flow.nodes.find((n) => n.id === e.source);
    const target = flow.nodes.find((n) => n.id === e.target);
    const sourceRef = source ? `@${source.title}` : "(unknown)";
    const targetRef = target ? `@${target.title}` : "(unknown)";
    return `- ${sourceRef} → ${targetRef}`;
  });
  return [
    `Combine these ${nodes.length} nodes into a single, well-scoped node: ${nodeRefs.join(", ")}.`,
    "",
    "Nodes to combine:",
    nodeDetails.join("\n\n"),
    "",
    "Internal edges (between selected nodes):",
    internalEdges.length ? internalEdges.map((e) => {
      const source = nodes.find((n) => n.id === e.source);
      const target = nodes.find((n) => n.id === e.target);
      return `- @${source?.title} → @${target?.title}`;
    }).join("\n") : "(none)",
    "",
    "External edges (connecting to nodes outside selection):",
    externalEdgeDescriptions.length ? externalEdgeDescriptions.join("\n") : "(none)",
    "",
    "Propose a merged node with:",
    "1. Title and type that captures the combined responsibility",
    "2. Merged description (synthesize from all input nodes)",
    "3. Unified acceptance criteria (combine and deduplicate)",
    "4. How each external edge should reconnect to the merged node",
    "",
    "Do not apply graph changes until I approve the combination."
  ].join("\n");
}

type CanvasContextMenu =
  | { kind: "node"; nodeId: string; x: number; y: number }
  | { kind: "pane"; x: number; y: number; position: { x: number; y: number } };

type DragSelection = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

export function FlowCanvas({ onNodeSelected }: { onNodeSelected?: () => void }) {
  const {
    bundle,
    activeFlowId,
    activeSubflowId,
    searchQuery,
    selectedNodeId,
    selectedNodeIds,
    selectedEdgeId,
    selectNode,
    selectNodes,
    toggleNodeSelection,
    selectEdge,
    setActiveSubflow,
    deleteSelectedEdge,
    deleteSelectedNode,
    copySelectedNode,
    cutSelectedNode,
    pasteNode,
    duplicateSelectedNode,
    autoLayout,
    authorAcceptanceTestsForFlow,
    busyTestNodeIds,
    saveFlow,
    addNode,
    canvasViewport,
    setCanvasViewport,
    setCanvasViewportCenter,
    graphNavigationRequest,
    projectReloadNonce,
    clearGraphNavigationRequest,
    startScopedResearchChat,
    sendResearchMessage,
    openResearchPanel,
    createResearchChat,
    appendResearchDraftMention,
    requestResearchComposerFocus,
    theme,
    selectProjectFile,
    setWorkbenchView,
    navigateToGraphTarget,
    showDirectUndoNotice,
    keybindings,
    reload
  } = useArchicodeStore();
  const flow = getActiveFlow(bundle, activeFlowId);
  const canvasRef = useRef<HTMLElement | null>(null);
  const reactFlowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const suppressNodeClickRef = useRef<string | null>(null);
  const lastCanvasPointerRef = useRef<{ x: number; y: number } | null>(null);
  const visibleNodes = useMemo(() => flow ? visibleNodesForFlow(flow, activeSubflowId, searchQuery) : [], [flow, activeSubflowId, searchQuery]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : []), [selectedNodeId, selectedNodeIds]);
  const autoFocusSelectedNode = bundle?.project.settings.autoFocusSelectedNode ?? false;
  const canvasStyle = canvasBackgroundStyle(bundle?.project.settings.canvasBackground, theme);
  const edgeType = bundle?.project.settings.canvasEdgeStyle === "curved" ? "archicodeCurved" : "archicode";
  const policyViolations = bundle?.policyEvaluation?.violations ?? [];
  const [policyIssuesOpen, setPolicyIssuesOpen] = useState(false);
  const mappedPolicyViolations = useMemo(() => policyViolations.filter((violation) =>
    violation.source.flowId === flow?.id &&
    violation.target?.flowId === flow?.id &&
    Boolean(violation.source.nodeId) &&
    Boolean(violation.target?.nodeId) &&
    violation.source.nodeId !== violation.target?.nodeId &&
    visibleNodeIds.has(violation.source.nodeId!) &&
    visibleNodeIds.has(violation.target!.nodeId!)
  ), [flow?.id, policyViolations, visibleNodeIds]);
  const policyRuleTargets = useMemo(() => {
    const targets = new globalThis.Map<string, { flowId: string; nodeId: string }>();
    if (!bundle) return targets;
    for (const violation of policyViolations) {
      const endpointTarget = [violation.source, violation.target].flatMap((endpoint) => {
        if (!endpoint?.flowId || !endpoint.nodeId) return [];
        const endpointFlow = bundle.flows.find((item) => item.id === endpoint.flowId);
        const endpointNode = endpointFlow?.nodes.find((item) => item.id === endpoint.nodeId);
        return endpointNode?.ruleIds?.includes(violation.policyId)
          ? [{ flowId: endpoint.flowId, nodeId: endpoint.nodeId }]
          : [];
      })[0];
      if (endpointTarget) {
        targets.set(violation.id, endpointTarget);
        continue;
      }
      for (const projectFlow of bundle.flows) {
        const ownerNode = projectFlow.nodes.find((node) => node.ruleIds?.includes(violation.policyId));
        if (!ownerNode) continue;
        targets.set(violation.id, { flowId: projectFlow.id, nodeId: ownerNode.id });
        break;
      }
    }
    return targets;
  }, [bundle, policyViolations]);
  const canvasScopeKey = `${bundle?.rootPath ?? "preview"}:${flow?.id ?? "flow"}:${activeSubflowId ?? "root"}:${projectReloadNonce}`;
  const canvas3dFocusedNodeId = selectedNodeIds.length > 1 ? null : selectedNodeIds[0] ?? selectedNodeId ?? null;
  const scopeBreadcrumb = useMemo(
    () => flow ? flowScopeBreadcrumb(flow, activeSubflowId) : [],
    [activeSubflowId, flow]
  );
  const selectNodeIn3d = useCallback((nodeId: string | null) => {
    if (!nodeId) {
      selectNode(null);
      return;
    }
    const node = flow?.nodes.find((item) => item.id === nodeId);
    if (!node) {
      selectNode(null);
      return;
    }
    const targetSubflowId = node.subflowId ?? null;
    if (targetSubflowId !== activeSubflowId) {
      // Promote the node's layer (also clears selection), then re-select for sidebar inspect.
      setActiveSubflow(targetSubflowId);
    }
    selectNode(nodeId);
  }, [activeSubflowId, flow, selectNode, setActiveSubflow]);
  const selectScopeIn3d = useCallback((subflowId: string | null) => {
    setActiveSubflow(subflowId);
  }, [setActiveSubflow]);
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const [currentCanvasZoom, setCurrentCanvasZoom] = useState(canvasViewport?.zoom ?? 1);

  const overlappingNodeIds = useMemo(() => {
    const rects = visibleNodes.map((node) => {
      const size = nodeSizeFor(node);
      return { id: node.id, x: node.position.x, y: node.position.y, width: size.width, height: size.height };
    });
    const overlapping = new globalThis.Set<string>();
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const intersects =
          a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        if (intersects) {
          overlapping.add(a.id);
          overlapping.add(b.id);
        }
      }
    }
    return overlapping;
  }, [visibleNodes]);

  const overviewLabelOffsets = useMemo(
    () => overviewLabelOffsetsFor(visibleNodes, currentCanvasZoom),
    [currentCanvasZoom, visibleNodes]
  );

  const startViolationExplanation = useCallback((
    violations: ArchitecturePolicyViolation[],
    preferredNode?: ArchicodeNode
  ) => {
    if (!bundle || !violations.length) return;
    const endpoint = violations[0]?.source.nodeId
      ? violations[0].source
      : violations[0]?.target?.nodeId
        ? violations[0].target
        : violations[0]?.source;
    const scope: ResearchChatScope = preferredNode && flow
      ? { type: "node", flowId: flow.id, nodeId: preferredNode.id }
      : endpoint?.flowId && endpoint.nodeId
        ? { type: "node", flowId: endpoint.flowId, nodeId: endpoint.nodeId }
        : endpoint?.flowId
          ? { type: "flow", flowId: endpoint.flowId }
          : { type: "project", projectId: bundle.project.id };
    setPolicyIssuesOpen(false);
    void startScopedResearchChat(scope, explainPolicyViolationsPrompt(violations, preferredNode?.title));
  }, [bundle, flow, startScopedResearchChat]);

  const sourceNodes = useMemo<Node[]>(() => {
    return visibleNodes.map((node) => {
      const size = nodeSizeFor(node);
      return {
        id: node.id,
        type: "archicode",
        position: node.position,
        measured: size,
        style: size,
        selected: selectedNodeIdSet.has(node.id),
        data: {
          node,
          signals: getNodeSignalCounts(bundle, node.id, flow?.id),
          selectedExternally: selectedNodeIdSet.has(node.id),
          overlapping: overlappingNodeIds.has(node.id),
          busyTests: busyTestNodeIds.includes(node.id),
          onExplainPolicyViolations: () => startViolationExplanation(
            policyViolations.filter((violation) => {
              const target = violation.target;
              return (violation.source.flowId === flow?.id && violation.source.nodeId === node.id) ||
                Boolean(target && target.flowId === flow?.id && target.nodeId === node.id);
            }),
            node
          ),
          overviewLabelOffset: overviewLabelOffsets.get(node.id) ?? { x: 0, y: 0 }
        }
      };
    });
  }, [bundle, visibleNodes, selectedNodeIdSet, overlappingNodeIds, busyTestNodeIds, overviewLabelOffsets, flow?.id, policyViolations, startViolationExplanation]);
  const [canvasNodes, setCanvasNodes] = useState<Node[]>(sourceNodes);
  const [minimapVisible, setMinimapVisible] = useState(getInitialMinimapVisible);
  const [minimapRenderVersion, setMinimapRenderVersion] = useState(0);
  const [canvas3dVisible, setCanvas3dVisible] = useState(false);
  const [knowledgeMapVisible, setKnowledgeMapVisible] = useState(false);
  const [knowledgeMapLayer, setKnowledgeMapLayer] = useState<"architecture" | "code">("architecture");
  const [codeKnowledgeSnapshot, setCodeKnowledgeSnapshot] = useState<CodeKnowledgeSnapshot | null>(() => visualQaCodeKnowledgeSnapshot(flow));
  const [knowledgeRefreshState, setKnowledgeRefreshState] = useState<{
    status: "idle" | "refreshing" | "complete" | "failed";
    label: string;
  }>({ status: "idle", label: "" });
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const groupDragRef = useRef<{
    groupId: string;
    startPointerScreen: { x: number; y: number };
    startPositions: globalThis.Map<string, { x: number; y: number }>;
    dragging: boolean;
  } | null>(null);

  useEffect(() => {
    setCanvasNodes(sourceNodes);
  }, [sourceNodes]);

  const openPolicyViolationSource = useCallback((violation: ArchitecturePolicyViolation) => {
    setPolicyIssuesOpen(false);
    if (violation.source.entityKind === "node" && violation.source.flowId && violation.source.nodeId) {
      navigateToGraphTarget({ kind: "node", flowId: violation.source.flowId, nodeId: violation.source.nodeId });
      return;
    }
    setWorkbenchView("files");
    void selectProjectFile(violation.source.path, { lineNumber: violation.source.line ?? null });
  }, [navigateToGraphTarget, selectProjectFile, setWorkbenchView]);

  const openPolicyViolationRule = useCallback((violation: ArchitecturePolicyViolation) => {
    const target = policyRuleTargets.get(violation.id);
    if (!target) return;
    setPolicyIssuesOpen(false);
    navigateToGraphTarget({ kind: "node", flowId: target.flowId, nodeId: target.nodeId });
    window.dispatchEvent(new CustomEvent("archicode:focus-rule", {
      detail: {
        ruleId: violation.policyId,
        nodeId: target.nodeId
      }
    }));
  }, [navigateToGraphTarget, policyRuleTargets]);

  useEffect(() => {
    if (!policyViolations.length) setPolicyIssuesOpen(false);
  }, [policyViolations.length]);

  const groupBoxes = useMemo(() => {
    const positionByNodeId = new globalThis.Map<string, { x: number; y: number }>();
    for (const canvasNode of canvasNodes) {
      positionByNodeId.set(canvasNode.id, canvasNode.position);
    }
    const nodesWithLivePositions = visibleNodes.map((node) => {
      const livePosition = positionByNodeId.get(node.id);
      return livePosition ? { ...node, position: livePosition } : node;
    });
    return groupBoxesFor(nodesWithLivePositions, flow?.groups);
  }, [canvasNodes, flow?.groups, visibleNodes]);

  const updateViewportState = (instance = reactFlowRef.current) => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds || !instance) return;
    setCanvasViewport(instance.getViewport());
    setCanvasViewportCenter(instance.screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2
    }));
  };

  const openPaneMenuAt = useCallback((clientX: number, clientY: number) => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    const instance = reactFlowRef.current;
    if (!bounds || !instance) return false;
    selectNode(null);
    selectEdge(null);
    setContextMenu({
      kind: "pane",
      x: Math.min(Math.max(8, clientX - bounds.left), Math.max(8, bounds.width - 280)),
      y: Math.min(Math.max(8, clientY - bounds.top), Math.max(8, bounds.height - 250)),
      position: instance.screenToFlowPosition({ x: clientX, y: clientY })
    });
    return true;
  }, [selectEdge, selectNode]);

  const openPaneMenuAtPointer = useCallback(() => {
    const pointer = lastCanvasPointerRef.current;
    if (!pointer) return false;
    const target = document.elementFromPoint(pointer.x, pointer.y);
    if (!isEmptyPanePointerTarget(target)) return false;
    return openPaneMenuAt(pointer.x, pointer.y);
  }, [openPaneMenuAt]);

  const toggleMinimap = useCallback(() => {
    setMinimapVisible((current) => {
      const next = !current;
      localStorage.setItem("archicode-minimap-visible", String(next));
      return next;
    });
  }, []);

  const toggleCanvas3d = useCallback(() => {
    setContextMenu(null);
    setDragSelection(null);
    setKnowledgeMapVisible(false);
    setCanvas3dVisible((current) => !current);
  }, []);

  const toggleKnowledgeMap = useCallback(() => {
    setContextMenu(null);
    setDragSelection(null);
    setCanvas3dVisible(false);
    setKnowledgeMapVisible((current) => !current);
  }, []);

  useEffect(() => {
    if (!window.archicode?.onGraphEvidenceRefreshProgress || !bundle?.rootPath) return;
    return window.archicode.onGraphEvidenceRefreshProgress((progress) => {
      if (progress.projectRoot !== bundle.rootPath) return;
      const detail = progress.itemsDone !== undefined && progress.itemsTotal !== undefined
        ? ` · ${progress.itemsDone}/${progress.itemsTotal}`
        : "";
      setKnowledgeRefreshState({ status: "refreshing", label: `${progress.label}${detail}` });
    });
  }, [bundle?.rootPath]);

  useEffect(() => {
    if (!knowledgeMapVisible || !bundle?.rootPath || !window.archicode?.getCodeKnowledgeSnapshot) return;
    let disposed = false;
    void window.archicode.getCodeKnowledgeSnapshot(bundle.rootPath).then((snapshot) => {
      if (!disposed) setCodeKnowledgeSnapshot(snapshot);
    });
    return () => { disposed = true; };
  }, [bundle?.rootPath, flow?.updatedAt, knowledgeMapVisible]);

  useEffect(() => {
    if (!window.archicode?.onExternalProjectUpdated || !bundle?.rootPath) return;
    return window.archicode.onExternalProjectUpdated((payload) => {
      if (payload.projectRoot !== bundle.rootPath || payload.source !== "knowledge-refresh") return;
      if (payload.action === "architecture-policies-evaluated") {
        const violations = payload.policyViolations ?? 0;
        setKnowledgeRefreshState({
          status: "complete",
          label: violations
            ? `Live architecture checks found ${violations} violation${violations === 1 ? "" : "s"}.`
            : "Live architecture checks passed."
        });
        return;
      }
      const refreshed = payload.refreshedEdges ?? 0;
      const unresolved = payload.unresolvedEdges ?? 0;
      setKnowledgeRefreshState({
        status: "complete",
        label: unresolved
          ? `Refreshed ${refreshed} relationships; ${unresolved} need review because current source no longer proves them.`
          : `Verified ${refreshed} relationships from current source.`
      });
    });
  }, [bundle?.rootPath]);

  const refreshKnowledgeEvidence = useCallback(() => {
    if (!bundle?.rootPath || !flow || !window.archicode?.refreshGraphEvidence) return;
    setKnowledgeRefreshState({ status: "refreshing", label: "Starting deterministic relationship analysis…" });
    void window.archicode.refreshGraphEvidence(bundle.rootPath, flow.id).then(async (result) => {
      await reload();
      setKnowledgeRefreshState({
        status: "complete",
        label: result.unresolvedEdges
          ? `Refreshed ${result.refreshedEdges} relationships; ${result.unresolvedEdges} no longer have clear source support.`
          : `Verified ${result.refreshedEdges} relationships from current source.`
      });
    }).catch((error) => {
      setKnowledgeRefreshState({ status: "failed", label: error instanceof Error ? error.message : String(error) });
    });
  }, [bundle?.rootPath, flow, reload]);

  const fitVisibleNodes = useCallback(() => {
    const instance = reactFlowRef.current;
    if (!instance) return;
    void instance.fitView({ padding: 0.16, duration: 220 }).then(() => updateViewportState(instance));
  }, []);

  const toggleFocusMode = useCallback(() => {
    window.dispatchEvent(new CustomEvent("archicode:toggle-focus-mode"));
  }, []);

  const selectedDeleteNodeIds = useMemo(() => selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : [], [selectedNodeId, selectedNodeIds]);
  const selectedDeleteNodes = useMemo(() => flow
    ? selectedDeleteNodeIds
      .map((nodeId) => flow.nodes.find((node) => node.id === nodeId))
      .filter((node): node is ArchicodeNode => Boolean(node))
    : []
  , [flow, selectedDeleteNodeIds]);
  const openDeleteConfirm = useCallback(() => {
    const selectedCount = selectedNodeIds.length || (selectedNodeId ? 1 : 0);
    if (!selectedCount) return false;
    setDeleteConfirmOpen(true);
    return true;
  }, [selectedNodeId, selectedNodeIds]);

  useEffect(() => {
    if (!autoFocusSelectedNode) return;
    if (!selectedNodeId || !reactFlowRef.current || !visibleNodeIds.has(selectedNodeId)) return;
    void reactFlowRef.current.fitView({
      nodes: [{ id: selectedNodeId }],
      duration: 260,
      padding: 0.44,
      maxZoom: 1.05
    }).then(() => updateViewportState());
  }, [autoFocusSelectedNode, selectedNodeId, visibleNodeIds]);

  useEffect(() => {
    const request = graphNavigationRequest;
    const instance = reactFlowRef.current;
    if (!request || !instance || !flow) return;
    if (request.kind === "project") {
      clearGraphNavigationRequest(request.requestId);
      return;
    }
    if (request.flowId !== flow.id) return;
    if (request.kind === "subflow" && activeSubflowId !== request.subflowId) return;
    if (request.kind === "flow" && activeSubflowId !== null) return;
    if (request.kind === "canvas") {
      if (activeSubflowId !== request.subflowId) return;
      const finish = () => {
        updateViewportState(instance);
        clearGraphNavigationRequest(request.requestId);
      };
      const viewportAction = request.viewport;
      if (viewportAction.mode === "preserve") {
        clearGraphNavigationRequest(request.requestId);
        return;
      }
      if (viewportAction.mode === "fit") {
        const requestedVisibleNodeIds = request.nodeIds.filter((nodeId) => visibleNodeIds.has(nodeId));
        const fitNodeIds = requestedVisibleNodeIds.length ? requestedVisibleNodeIds : visibleNodes.map((node) => node.id);
        if (!fitNodeIds.length) {
          clearGraphNavigationRequest(request.requestId);
          return;
        }
        void instance.fitView({
          nodes: fitNodeIds.map((id) => ({ id })),
          duration: 320,
          padding: viewportAction.padding,
          maxZoom: viewportAction.maxZoom
        }).then(finish);
        return;
      }
      if (viewportAction.mode === "center") {
        void instance.setCenter(viewportAction.x, viewportAction.y, {
          duration: 320,
          zoom: viewportAction.zoom ?? instance.getZoom()
        }).then(finish);
        return;
      }
      if (viewportAction.mode === "pan") {
        const bounds = canvasRef.current?.getBoundingClientRect();
        if (!bounds) {
          clearGraphNavigationRequest(request.requestId);
          return;
        }
        const currentCenter = instance.screenToFlowPosition({
          x: bounds.left + bounds.width / 2,
          y: bounds.top + bounds.height / 2
        });
        void instance.setCenter(currentCenter.x + viewportAction.dx, currentCenter.y + viewportAction.dy, {
          duration: 320,
          zoom: instance.getZoom()
        }).then(finish);
        return;
      }
      const targetZoom = viewportAction.mode === "zoom-to"
        ? viewportAction.zoom
        : Math.min(1.35, Math.max(0.035, instance.getZoom() * viewportAction.factor));
      void instance.zoomTo(targetZoom, { duration: 320 }).then(finish);
      return;
    }
    if (request.kind === "node") {
      if (!visibleNodeIds.has(request.nodeId)) return;
      void instance.fitView({
        nodes: [{ id: request.nodeId }],
        duration: 320,
        padding: 0.5,
        maxZoom: 1.08
      }).then(() => {
        updateViewportState(instance);
        clearGraphNavigationRequest(request.requestId);
      });
      return;
    }
    if (!visibleNodes.length) {
      clearGraphNavigationRequest(request.requestId);
      return;
    }
    void instance.fitView({
      nodes: visibleNodes.map((node) => ({ id: node.id })),
      duration: 320,
      padding: 0.24,
      maxZoom: 1.08
    }).then(() => {
      updateViewportState(instance);
      clearGraphNavigationRequest(request.requestId);
    });
  }, [activeSubflowId, clearGraphNavigationRequest, flow, graphNavigationRequest, visibleNodeIds, visibleNodes]);

  const edges = useMemo<Edge[]>(() => {
    if (!flow) return [];

    const visibleEdges = visibleEdgesForNodes(flow, visibleNodeIds);
    const nodesById = new globalThis.Map(visibleNodes.map((node) => [node.id, node]));
    const policyGroupsByNodePair = new globalThis.Map<string, ArchitecturePolicyViolation[]>();
    for (const violation of mappedPolicyViolations) {
      const source = violation.source.nodeId!;
      const target = violation.target?.nodeId;
      if (!target) continue;
      const pairKey = policyNodePairKey(source, target);
      policyGroupsByNodePair.set(pairKey, [...(policyGroupsByNodePair.get(pairKey) ?? []), violation]);
    }
    const edgeHandles = new globalThis.Map(visibleEdges.map((edge) => [
      edge.id,
      inferEdgeHandleSides(nodesById.get(edge.source), nodesById.get(edge.target), edge)
    ]));
    const pinMembership = new globalThis.Map<string, { edgeId: string; end: "source" | "target"; oppositeNodeId: string }[]>();

    for (const edge of visibleEdges) {
      const handles = edgeHandles.get(edge.id);
      if (!handles) continue;
      const sourceKey = `${edge.source}:${handles.sourceHandle}`;
      const targetKey = `${edge.target}:${handles.targetHandle}`;
      pinMembership.set(sourceKey, [...(pinMembership.get(sourceKey) ?? []), { edgeId: edge.id, end: "source", oppositeNodeId: edge.target }]);
      pinMembership.set(targetKey, [...(pinMembership.get(targetKey) ?? []), { edgeId: edge.id, end: "target", oppositeNodeId: edge.source }]);
    }

    const endpointOffsets = new globalThis.Map<string, number>();
    for (const members of pinMembership.values()) {
      const sortedMembers = [...members].sort((left, right) =>
        left.oppositeNodeId.localeCompare(right.oppositeNodeId) || left.edgeId.localeCompare(right.edgeId) || left.end.localeCompare(right.end)
      );
      const spacing = 16;
      const center = (sortedMembers.length - 1) / 2;
      sortedMembers.forEach((member, index) => {
        endpointOffsets.set(`${member.edgeId}:${member.end}`, sortedMembers.length > 1 ? (index - center) * spacing : 0);
      });
    }

    const persistedEdges = visibleEdges.filter((edge) => !policyGroupsByNodePair.has(policyNodePairKey(edge.source, edge.target))).map((edge) => {
      const handles = edgeHandles.get(edge.id) ?? inferEdgeHandleSides(nodesById.get(edge.source), nodesById.get(edge.target), edge);
      const isSelected = edge.id === selectedEdgeId;
      const legacyAnimated = edge.label === "feeds context" || edge.label === "guards edits";
      const isAnimated = edge.animated ?? legacyAnimated;
      // Selection switches the whole edge (line, arrowheads, label) to the dedicated
      // selection color — a width/brightness bump alone is too easy to miss.
      const strokeColor = isSelected ? "var(--edge-selected)" : edge.color ?? "var(--accent)";
      // Arrowheads sit a hue-step toward the theme's text color so they read distinctly
      // from the line in both light and dark themes.
      const arrowColor = isSelected ? "var(--edge-selected)" : `color-mix(in srgb, ${strokeColor} 55%, var(--text) 45%)`;
      const baseStrokeWidth = edge.width ?? 2.35;
      const strokeDasharray = isAnimated
        ? undefined
        : edge.lineStyle === "dashed"
        ? "10 6"
        : edge.lineStyle === "dotted"
          ? "2 8"
          : undefined;
      const edgeStyle = {
        "--edge-stroke": strokeColor,
        stroke: "var(--edge-stroke)",
        strokeWidth: isSelected ? baseStrokeWidth + 1 : baseStrokeWidth,
        ...(strokeDasharray ? { strokeDasharray } : {}),
        ...(!isAnimated && edge.lineStyle === "dotted" ? { strokeLinecap: "round" as const } : {})
      } as CSSProperties;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        label: edge.label,
        type: edgeType,
        animated: isAnimated,
        selected: isSelected,
        style: edgeStyle,
        data: {
          pathKind: edgeType === "archicodeCurved" ? "bezier" : "smoothstep",
          sourceOffset: endpointOffsets.get(`${edge.id}:source`) ?? 0,
          targetOffset: endpointOffsets.get(`${edge.id}:target`) ?? 0,
          arrowColor,
          bidirectional: edge.bidirectional ?? false,
          onSelect: () => selectEdge(edge.id)
        }
      };
    });
    const policyEdges: Edge[] = [...policyGroupsByNodePair.values()].map((violations) => {
      const violation = violations[0]!;
      const source = violation.source.nodeId!;
      const target = violation.target!.nodeId!;
      const matchingEdge = visibleEdges.find((edge) => edge.source === source && edge.target === target)
        ?? visibleEdges.find((edge) => edge.source === target && edge.target === source);
      const matchingHandles = matchingEdge ? edgeHandles.get(matchingEdge.id) : undefined;
      const reversedMatch = Boolean(matchingEdge && matchingEdge.source === target);
      const handles = matchingHandles
        ? {
            sourceHandle: reversedMatch ? matchingHandles.targetHandle : matchingHandles.sourceHandle,
            targetHandle: reversedMatch ? matchingHandles.sourceHandle : matchingHandles.targetHandle
          }
        : inferEdgeHandleSides(nodesById.get(source), nodesById.get(target));
      const sourceOffset = matchingEdge
        ? endpointOffsets.get(`${matchingEdge.id}:${reversedMatch ? "target" : "source"}`) ?? 0
        : 0;
      const targetOffset = matchingEdge
        ? endpointOffsets.get(`${matchingEdge.id}:${reversedMatch ? "source" : "target"}`) ?? 0
        : 0;
      const highestSeverity = violations.some((item) => item.severity === "error")
        ? "error"
        : violations.some((item) => item.severity === "warning")
          ? "warning"
          : "info";
      return {
        id: `derived-${violation.id}`,
        source,
        target,
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        label: violations.length === 1 ? `Policy violation: ${violation.policyTitle}` : `${violations.length} policy violations`,
        type: edgeType,
        animated: false,
        selectable: false,
        style: {
          "--edge-stroke": policyEdgeColor,
          stroke: "var(--edge-stroke)",
          strokeWidth: highestSeverity === "error" ? 5.8 : highestSeverity === "warning" ? 4.8 : 4,
          strokeDasharray: "13 5",
          strokeLinecap: "round",
          opacity: 1
        } as CSSProperties,
        data: {
          pathKind: edgeType === "archicodeCurved" ? "bezier" : "smoothstep",
          sourceOffset,
          targetOffset,
          arrowColor: policyEdgeColor,
          bidirectional: false,
          policyAlert: true,
          policyViolationId: violation.id,
          labelTooltip: violations.map((item) => item.message).join("\n\n"),
          onSelect: () => openPolicyViolationSource(violation)
        }
      };
    });
    return [...persistedEdges, ...policyEdges];
  }, [edgeType, flow, mappedPolicyViolations, openPolicyViolationSource, selectEdge, selectedEdgeId, visibleNodeIds, visibleNodes]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, [contenteditable='true']")) return;
      if (matchesChord(keybindings["canvas.toggle3d"], event)) {
        event.preventDefault();
        toggleCanvas3d();
        return;
      }
      if (canvas3dVisible) return;
      if (knowledgeMapVisible) return;
      if (matchesChord(keybindings["canvas.addNode"], event)) {
        event.preventDefault();
        if (!event.repeat) openPaneMenuAtPointer();
        return;
      }
      if (matchesChord(keybindings["canvas.toggleMinimap"], event)) {
        event.preventDefault();
        toggleMinimap();
        return;
      }
      const command = event.metaKey || event.ctrlKey;
      const selectedText = window.getSelection()?.toString() ?? "";
      const deleteKeyPressed =
        matchesChord(keybindings["canvas.delete"], event) ||
        (event.key === "Backspace" && !event.metaKey && !event.ctrlKey && !event.altKey);
      if (deleteKeyPressed) {
        event.preventDefault();
        if (selectedEdgeId) void deleteSelectedEdge();
        else openDeleteConfirm();
      } else if (matchesChord(keybindings["canvas.copy"], event)) {
        if (selectedText.trim()) return;
        event.preventDefault();
        copySelectedNode();
      } else if (matchesChord(keybindings["canvas.cut"], event)) {
        if (selectedText.trim()) return;
        event.preventDefault();
        void cutSelectedNode();
      } else if (matchesChord(keybindings["canvas.paste"], event)) {
        event.preventDefault();
        void pasteNode();
      } else if (matchesChord(keybindings["canvas.duplicate"], event)) {
        event.preventDefault();
        void duplicateSelectedNode();
      } else if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopPropagation();
        showDirectUndoNotice();
      } else if (matchesChord(keybindings["canvas.autoLayout"], event)) {
        event.preventDefault();
        void autoLayout();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [autoLayout, canvas3dVisible, copySelectedNode, cutSelectedNode, deleteSelectedEdge, deleteSelectedNode, duplicateSelectedNode, keybindings, knowledgeMapVisible, openDeleteConfirm, openPaneMenuAtPointer, pasteNode, selectedEdgeId, showDirectUndoNotice, toggleCanvas3d, toggleMinimap]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => {
      setContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!dragSelection) return;
    const finishDragSelection = () => {
      const bounds = canvasRef.current?.getBoundingClientRect();
      const instance = reactFlowRef.current;
      if (!bounds || !instance) {
        setDragSelection(null);
        return;
      }
      const width = Math.abs(dragSelection.currentX - dragSelection.startX);
      const height = Math.abs(dragSelection.currentY - dragSelection.startY);
      if (width < 4 && height < 4) {
        setDragSelection(null);
        return;
      }
      const start = instance.screenToFlowPosition({ x: dragSelection.startX, y: dragSelection.startY });
      const end = instance.screenToFlowPosition({ x: dragSelection.currentX, y: dragSelection.currentY });
      const minX = Math.min(start.x, end.x);
      const maxX = Math.max(start.x, end.x);
      const minY = Math.min(start.y, end.y);
      const maxY = Math.max(start.y, end.y);
      const selectedIds = visibleNodes.flatMap((node) => {
        const size = nodeSizeFor(node);
        const nodeMinX = node.position.x;
        const nodeMaxX = node.position.x + size.width;
        const nodeMinY = node.position.y;
        const nodeMaxY = node.position.y + size.height;
        const intersects = nodeMaxX >= minX && nodeMinX <= maxX && nodeMaxY >= minY && nodeMinY <= maxY;
        return intersects ? [node.id] : [];
      });
      if (selectedIds.length) {
        selectNodes(selectedIds, selectedIds[selectedIds.length - 1]);
      } else {
        selectNode(null);
        selectEdge(null);
      }
      setDragSelection(null);
    };
    const handlePointerMove = (event: PointerEvent) => {
      setDragSelection((current) => current ? { ...current, currentX: event.clientX, currentY: event.clientY } : current);
    };
    const handlePointerUp = () => finishDragSelection();
    const handleBlur = () => setDragSelection(null);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
    window.addEventListener("blur", handleBlur, { once: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [dragSelection, selectEdge, selectNode, selectNodes, visibleNodes]);

  const persistEdgeConnection = async (connection: Connection) => {
    if (!flow || !connection.source || !connection.target || connection.source === connection.target) return;
    const edgeExists = flow.edges.some((edge) => edge.source === connection.source && edge.target === connection.target);
    if (edgeExists) return;

    const nextEdge = {
      id: `edge-${connection.source}-${connection.target}-${Date.now().toString(36)}`,
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle ?? undefined,
      targetHandle: connection.targetHandle ?? undefined,
      label: "relates"
    };

    await saveFlow({
      ...flow,
      edges: [...flow.edges, nextEdge],
      updatedAt: new Date().toISOString()
    });
  };

  const handleEdgeClick: EdgeMouseHandler = (_event, edge) => {
    setContextMenu(null);
    const policyViolationId = (edge.data as { policyViolationId?: string } | undefined)?.policyViolationId;
    if (policyViolationId) {
      const violation = policyViolations.find((item) => item.id === policyViolationId);
      if (violation) openPolicyViolationSource(violation);
      return;
    }
    selectEdge(edge.id);
  };

  const selectCanvasNode = (event: MouseEvent | TouchEvent | React.MouseEvent, nodeId: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }
    onNodeSelected?.();
    if (selectedNodeIdSet.has(nodeId)) {
      toggleNodeSelection(nodeId);
      return;
    }
    selectNode(nodeId);
  };

  const openNodeDetailFlow: NodeMouseHandler = (_event, node) => {
    if (!flow) return;
    const linkedSubflow = flow.subflows.find((subflow) => subflow.parentNodeId === node.id);
    if (!linkedSubflow) return;
    setContextMenu(null);
    setActiveSubflow(linkedSubflow.id);
  };

  const openNodeMenu: NodeMouseHandler = (event, node) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const menuWidth = 300;
    const menuHeight = selectedNodeIdSet.has(node.id) && selectedNodeIdSet.size > 1 ? 575 : 420;
    if (!selectedNodeIdSet.has(node.id)) selectNode(node.id);
    setContextMenu({
      kind: "node",
      nodeId: node.id,
      x: Math.min(Math.max(8, event.clientX - bounds.left), Math.max(8, bounds.width - menuWidth)),
      y: Math.min(Math.max(8, event.clientY - bounds.top), Math.max(8, bounds.height - menuHeight))
    });
  };

  const runNodeMenuAction = (action: () => void | Promise<void>) => {
    setContextMenu(null);
    void action();
  };

  const eligibleFlowCheckNodeCount = flow
    ? flow.nodes.filter((node) => !node.ignored && !isProductionApproved(node) && node.acceptanceCriteria.some((text) => text.trim())).length
    : 0;

  const runGenerateFlowChecks = () => {
    setContextMenu(null);
    if (!eligibleFlowCheckNodeCount) return;
    const suffix = eligibleFlowCheckNodeCount === 1 ? "" : "s";
    if (!window.confirm(`Author tests for ${eligibleFlowCheckNodeCount} node${suffix} with criteria in this flow? This runs an AI agent that writes real test files into your repo (one agent pass per node; tests fail until implemented).`)) return;
    void authorAcceptanceTestsForFlow();
  };

  const nodesForContextAction = (nodeId: string): ArchicodeNode[] => {
    if (!flow) return [];
    const ids = selectedNodeIdSet.has(nodeId) && selectedNodeIdSet.size > 1
      ? [...selectedNodeIdSet]
      : [nodeId];
    return ids.flatMap((id) => {
      const node = flow.nodes.find((item) => item.id === id);
      return node ? [node] : [];
    });
  };

  const researchScopeForNodes = (nodes: ArchicodeNode[]): ResearchChatScope => nodes.length === 1
    ? nodeChatScope(flow!, nodes[0]!.id)
    : { type: "flow", flowId: flow!.id };

  const runNodeResearchAction = (nodeId: string, messageForNodes: (nodes: ArchicodeNode[]) => string) => {
    if (!flow) return;
    const nodes = nodesForContextAction(nodeId);
    if (!nodes.length) return;
    setContextMenu(null);
    selectNodes(nodes.map((node) => node.id), nodeId);
    const scope = researchScopeForNodes(nodes);
    const message = `${messageForNodes(nodes)}\n\n${taggedNodeContext(nodes, flow.id)}`;
    const refs = nodes.map((node) => ({ flowId: flow.id, nodeId: node.id }));
    void (async () => {
      const session = await createResearchChat(scope);
      if (!session) return;
      useArchicodeStore.setState({ selectedResearchSessionId: session.id, researchPanelOpen: true, researchScope: scope });
      await sendResearchMessage(message, [], [], [], undefined, refs);
    })();
  };

  const runNodeAddToChatAction = (nodeId: string) => {
    if (!flow) return;
    const nodes = nodesForContextAction(nodeId);
    if (!nodes.length) return;
    setContextMenu(null);
    selectNodes(nodes.map((node) => node.id), nodeId);
    void (async () => {
      const state = useArchicodeStore.getState();
      const hasActiveSession = Boolean(state.selectedResearchSessionId && state.researchSessions.some((session) => session.id === state.selectedResearchSessionId && !session.archived));
      if (!hasActiveSession) {
        await createResearchChat(researchScopeForNodes(nodes));
      } else {
        await openResearchPanel();
      }
      for (const node of nodes) appendResearchDraftMention({ flowId: flow.id, nodeId: node.id });
      requestResearchComposerFocus();
    })();
  };

  const runNodeNewChatAction = (nodeId: string) => {
    if (!flow) return;
    const nodes = nodesForContextAction(nodeId);
    if (!nodes.length) return;
    setContextMenu(null);
    selectNodes(nodes.map((node) => node.id), nodeId);
    void (async () => {
      await createResearchChat(researchScopeForNodes(nodes));
      for (const node of nodes) appendResearchDraftMention({ flowId: flow.id, nodeId: node.id });
      requestResearchComposerFocus();
    })();
  };

  const runCombineNodesResearchAction = () => {
    if (!flow) return;
    const ids = selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : [];
    const nodes = ids.map((id) => flow.nodes.find((n) => n.id === id)).filter(Boolean) as ArchicodeNode[];
    if (nodes.length < 2) return;
    setContextMenu(null);
    const scope: ResearchChatScope = { type: "flow", flowId: flow.id };
    const message = `${combineNodesPrompt(nodes, flow)}\n\n${taggedNodeContext(nodes, flow.id)}`;
    const refs = nodes.map((n) => ({ flowId: flow.id, nodeId: n.id }));
    void (async () => {
      const session = await createResearchChat(scope);
      if (!session) return;
      useArchicodeStore.setState({ selectedResearchSessionId: session.id, researchPanelOpen: true, researchScope: scope });
      await sendResearchMessage(message, [], [], [], undefined, refs);
    })();
  };

  const runPaneAddNode = (kind: string, position: { x: number; y: number }) => {
    setContextMenu(null);
    void addNode(kind, { position });
  };

  const arrangeSelectedNodes = async (action: NodeArrangeAction) => {
    if (!flow) return;
    const selectedIds = selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : [];
    if (selectedIds.length < 2) return;
    const nodesById = new globalThis.Map(flow.nodes.map((node) => [node.id, node]));
    const selectedNodes = selectedIds
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is ArchicodeNode => Boolean(node));
    if (selectedNodes.length < 2) return;
    const livePositions = new globalThis.Map(canvasNodes.map((node) => [node.id, node.position]));
    const nextPositions = arrangedPositionsFor(layoutBoxesFor(selectedNodes, livePositions), action);
    if (!nextPositions.size) return;

    const previousCanvasNodes = canvasNodes;
    const nextCanvasNodes = canvasNodes.map((node) => {
      const position = nextPositions.get(node.id);
      return position ? { ...node, position } : node;
    });
    const updatedAt = new Date().toISOString();

    setCanvasNodes(nextCanvasNodes);
    try {
      await saveFlow({
        ...flow,
        nodes: flow.nodes.map((node) => {
          const position = nextPositions.get(node.id);
          return position ? { ...node, position, updatedAt } : node;
        }),
        updatedAt
      });
    } catch {
      setCanvasNodes(previousCanvasNodes);
    }
  };

  const onNodesChange = (changes: NodeChange[]) => {
    setCanvasNodes((current) => applyNodeChanges(changes, current));
  };

  const persistNodePositions: OnNodeDrag = async (_event, draggedNode, draggedNodes) => {
    if (!flow) return;
    const draggedPositions = new globalThis.Map(
      (draggedNodes.length ? draggedNodes : [draggedNode]).map((node) => [node.id, node.position])
    );
    const nextNodes: ArchicodeNode[] = flow.nodes.map((node) => {
      const position = draggedPositions.get(node.id);
      if (!position) return node;
      return {
        ...node,
        position,
        updatedAt: new Date().toISOString()
      };
    });
    await saveFlow({ ...flow, nodes: nextNodes, updatedAt: new Date().toISOString() });
  };

  const handleSelectionChange = useCallback(({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
    if (nodes.length) {
      selectNodes(nodes.map((node) => node.id), nodes[nodes.length - 1]?.id ?? null);
    } else if (edges.length === 1) {
      selectEdge(edges[0].id);
    } else {
      selectNode(null);
      selectEdge(null);
    }
  }, [selectEdge, selectNode, selectNodes]);

  const selectGroupNodes = useCallback((groupBox: FlowGroupBox) => {
    setContextMenu(null);
    selectEdge(null);
    selectNodes(groupBox.nodeIds, groupBox.nodeIds[groupBox.nodeIds.length - 1] ?? null);
  }, [selectEdge, selectNodes]);

  const handleGroupLabelPointerDown = useCallback((event: React.PointerEvent, groupBox: FlowGroupBox) => {
    if (!flow) return;
    const startPositions = new globalThis.Map<string, { x: number; y: number }>();
    for (const canvasNode of canvasNodes) {
      if (groupBox.nodeIds.includes(canvasNode.id)) {
        startPositions.set(canvasNode.id, { ...canvasNode.position });
      }
    }
    groupDragRef.current = {
      groupId: groupBox.id,
      startPointerScreen: { x: event.clientX, y: event.clientY },
      startPositions,
      dragging: false
    };
    setDraggingGroupId(groupBox.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [canvasNodes, flow]);

  const handleGroupLabelPointerMove = useCallback((event: React.PointerEvent) => {
    const dragState = groupDragRef.current;
    if (!dragState || !flow) return;
    const instance = reactFlowRef.current;
    if (!instance) return;
    const screenDeltaX = event.clientX - dragState.startPointerScreen.x;
    const screenDeltaY = event.clientY - dragState.startPointerScreen.y;
    if (!dragState.dragging) {
      if (Math.abs(screenDeltaX) < 4 && Math.abs(screenDeltaY) < 4) return;
      dragState.dragging = true;
    }
    const zoom = instance.getViewport().zoom;
    const flowDeltaX = screenDeltaX / zoom;
    const flowDeltaY = screenDeltaY / zoom;
    setCanvasNodes((current) => current.map((canvasNode) => {
      const startPosition = dragState.startPositions.get(canvasNode.id);
      if (!startPosition) return canvasNode;
      return {
        ...canvasNode,
        position: {
          x: startPosition.x + flowDeltaX,
          y: startPosition.y + flowDeltaY
        }
      };
    }));
  }, [flow]);

  const handleGroupLabelPointerUp = useCallback(async (event: React.PointerEvent, groupBox: FlowGroupBox) => {
    const dragState = groupDragRef.current;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDraggingGroupId(null);
    groupDragRef.current = null;
    if (!dragState?.dragging) {
      selectGroupNodes(groupBox);
      return;
    }
    if (!flow) return;
    const draggedPositions = new globalThis.Map<string, { x: number; y: number }>();
    for (const canvasNode of canvasNodes) {
      if (dragState.startPositions.has(canvasNode.id)) {
        draggedPositions.set(canvasNode.id, canvasNode.position);
      }
    }
    const nextNodes: ArchicodeNode[] = flow.nodes.map((node) => {
      const position = draggedPositions.get(node.id);
      if (!position) return node;
      return {
        ...node,
        position,
        updatedAt: new Date().toISOString()
      };
    });
    await saveFlow({ ...flow, nodes: nextNodes, updatedAt: new Date().toISOString() });
  }, [canvasNodes, flow, saveFlow, selectGroupNodes]);

  useEffect(() => {
    if (!minimapVisible) return;
    const minimapSvg = canvasRef.current?.querySelector<SVGSVGElement>(".archicode-minimap svg");
    if (!minimapSvg) return;

    const flowPositionFromPointer = (event: PointerEvent, screenMatrix: DOMMatrix) => {
      const screenPoint = minimapSvg.createSVGPoint();
      screenPoint.x = event.clientX;
      screenPoint.y = event.clientY;
      return screenPoint.matrixTransform(screenMatrix);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const instance = reactFlowRef.current;
      const bounds = canvasRef.current?.getBoundingClientRect();
      const startZoom = instance?.getViewport().zoom;
      if (!instance || !bounds || !startZoom) return;
      const screenMatrix = minimapSvg.getScreenCTM()?.inverse();
      if (!screenMatrix) return;
      const startPosition = flowPositionFromPointer(event, screenMatrix);
      if (!startPosition) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const frozenViewBox = minimapSvg.getAttribute("viewBox");
      const viewBoxObserver = frozenViewBox ? new MutationObserver(() => {
        if (minimapSvg.getAttribute("viewBox") !== frozenViewBox) {
          minimapSvg.setAttribute("viewBox", frozenViewBox);
        }
      }) : null;
      viewBoxObserver?.observe(minimapSvg, { attributes: true, attributeFilter: ["viewBox"] });

      const visibleTopLeft = instance.screenToFlowPosition({ x: bounds.left, y: bounds.top });
      const visibleBottomRight = instance.screenToFlowPosition({ x: bounds.right, y: bounds.bottom });
      const visibleCenter = instance.screenToFlowPosition({
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2
      });
      const grabbedViewport = startPosition.x >= visibleTopLeft.x
        && startPosition.x <= visibleBottomRight.x
        && startPosition.y >= visibleTopLeft.y
        && startPosition.y <= visibleBottomRight.y;
      const dragOffset = grabbedViewport
        ? { x: visibleCenter.x - startPosition.x, y: visibleCenter.y - startPosition.y }
        : { x: 0, y: 0 };

      const panToPointer = (pointerEvent: PointerEvent, duration = 0) => {
        pointerEvent.stopPropagation();
        pointerEvent.stopImmediatePropagation();
        const position = flowPositionFromPointer(pointerEvent, screenMatrix);
        if (!position) return;
        void instance.setCenter(position.x + dragOffset.x, position.y + dragOffset.y, { zoom: startZoom, duration });
      };

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        pointerEvent.preventDefault();
        pointerEvent.stopPropagation();
        pointerEvent.stopImmediatePropagation();
        panToPointer(pointerEvent);
      };

      const finishPan = (pointerEvent: PointerEvent) => {
        pointerEvent.preventDefault();
        pointerEvent.stopPropagation();
        pointerEvent.stopImmediatePropagation();
        window.removeEventListener("pointermove", handlePointerMove, { capture: true });
        window.removeEventListener("pointerup", finishPan, { capture: true });
        window.removeEventListener("pointercancel", finishPan, { capture: true });
        viewBoxObserver?.disconnect();
        void instance.setViewport({ ...instance.getViewport(), zoom: startZoom })
          .then(() => {
            updateViewportState(instance);
            setMinimapRenderVersion((version) => version + 1);
          });
      };

      panToPointer(event);
      window.addEventListener("pointermove", handlePointerMove, { capture: true });
      window.addEventListener("pointerup", finishPan, { capture: true });
      window.addEventListener("pointercancel", finishPan, { capture: true });
    };

    minimapSvg.addEventListener("pointerdown", handlePointerDown, { capture: true });
    return () => {
      minimapSvg.removeEventListener("pointerdown", handlePointerDown, { capture: true });
    };
  }, [canvasScopeKey, minimapRenderVersion, minimapVisible]);

  const dragSelectionStyle = dragSelection && canvasRef.current ? (() => {
    const bounds = canvasRef.current.getBoundingClientRect();
    const left = Math.min(dragSelection.startX, dragSelection.currentX) - bounds.left;
    const top = Math.min(dragSelection.startY, dragSelection.currentY) - bounds.top;
    return {
      left,
      top,
      width: Math.abs(dragSelection.currentX - dragSelection.startX),
      height: Math.abs(dragSelection.currentY - dragSelection.startY)
    };
  })() : null;

  return (
    <section
      ref={canvasRef}
      className="canvas-shell"
      style={canvasStyle}
      aria-label="Architecture flow canvas"
      onPointerEnter={(event) => {
        lastCanvasPointerRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMoveCapture={(event) => {
        lastCanvasPointerRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerLeave={() => {
        lastCanvasPointerRef.current = null;
      }}
      onPointerDownCapture={(event) => {
        if (canvas3dVisible || knowledgeMapVisible) return;
        if (event.button !== 0 || !isEmptyPanePointerTarget(event.target)) return;
        if (event.ctrlKey || event.metaKey) {
          setContextMenu(null);
          setDragSelection({
            startX: event.clientX,
            startY: event.clientY,
            currentX: event.clientX,
            currentY: event.clientY
          });
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {dragSelectionStyle ? <div className="canvas-drag-selection" style={dragSelectionStyle} aria-hidden="true" /> : null}
      {!knowledgeMapVisible && scopeBreadcrumb.length ? (
        <nav
          className={`canvas-scope-breadcrumb${canvas3dVisible ? " is-3d" : ""}`}
          aria-label="Current flow scope"
        >
          {scopeBreadcrumb.map((item, index) => {
            const isCurrent = index === scopeBreadcrumb.length - 1;
            return (
              <span key={item.id ?? "root"} className="canvas-scope-breadcrumb-item">
                {index ? <ChevronRight size={10} aria-hidden="true" /> : null}
                {isCurrent ? (
                  <strong title={item.name}>{item.name}</strong>
                ) : (
                  <button type="button" title={`Open ${item.name}`} onClick={() => setActiveSubflow(item.id)}>{item.name}</button>
                )}
              </span>
            );
          })}
        </nav>
      ) : null}
      <button
        type="button"
        className="canvas-minimap-toggle"
        title={minimapVisible ? "Hide minimap" : "Show minimap"}
        aria-label={minimapVisible ? "Hide minimap" : "Show minimap"}
        aria-pressed={minimapVisible}
        onClick={toggleMinimap}
      >
        {minimapVisible ? <EyeOff size={16} /> : <Map size={16} />}
      </button>
      <button
        type="button"
        className={`canvas-3d-toggle${canvas3dVisible ? " is-active" : ""}`}
        title={canvas3dVisible ? "Show editable 2D canvas" : "Show read-only 3D flow"}
        aria-label={canvas3dVisible ? "Show editable 2D canvas" : "Show read-only 3D flow"}
        aria-pressed={canvas3dVisible}
        onClick={toggleCanvas3d}
      >
        <Box size={16} />
      </button>
      <button
        type="button"
        className={`canvas-knowledge-toggle${knowledgeMapVisible ? " is-active" : ""}`}
        title={knowledgeMapVisible ? "Show editable 2D canvas" : "Show architecture lens map"}
        aria-label={knowledgeMapVisible ? "Show editable 2D canvas" : "Show architecture lens map"}
        aria-pressed={knowledgeMapVisible}
        onClick={toggleKnowledgeMap}
      >
        <Network size={16} />
      </button>
      {knowledgeMapVisible && knowledgeMapLayer === "code" && codeKnowledgeSnapshot ? (
        <CodeDetailKnowledgeMapView
          snapshot={codeKnowledgeSnapshot}
          refreshState={knowledgeRefreshState}
          onRefresh={refreshKnowledgeEvidence}
          onBack={() => setKnowledgeMapLayer("architecture")}
          onOpenSource={(path, line) => void selectProjectFile(path, line ? { lineNumber: line } : undefined)}
          onSelectArchitectureNode={(nodeId) => {
            selectNode(nodeId);
            setKnowledgeMapLayer("architecture");
          }}
        />
      ) : knowledgeMapVisible ? (
        <CodeKnowledgeMapView
          flow={flow!}
          searchQuery={searchQuery}
          onSelectNode={selectNode}
          onSelectEdge={selectEdge}
          onOpenSource={(path, line) => void selectProjectFile(path, line ? { lineNumber: line } : undefined)}
          refreshState={knowledgeRefreshState}
          onRefresh={refreshKnowledgeEvidence}
          codeDetailAvailable={Boolean(codeKnowledgeSnapshot)}
          onOpenCodeDetail={() => setKnowledgeMapLayer("code")}
        />
      ) : canvas3dVisible ? (
        <FlowCanvas3DView
          flow={flow}
          searchQuery={searchQuery}
          theme={theme}
          activeSubflowId={activeSubflowId}
          focusedNodeId={canvas3dFocusedNodeId}
          onSelectNode={selectNodeIn3d}
          onSelectScope={selectScopeIn3d}
          onToggleFocusMode={toggleFocusMode}
        />
      ) : (
        <ReactFlow
          key={canvasScopeKey}
          nodes={canvasNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          defaultViewport={canvasViewport ?? undefined}
          fitView={!canvasViewport}
          fitViewOptions={{ padding: 0.16 }}
          minZoom={0.035}
          maxZoom={1.35}
          connectionMode={ConnectionMode.Loose}
          onInit={(instance) => {
            reactFlowRef.current = instance;
            setCurrentCanvasZoom(instance.getViewport().zoom);
            window.setTimeout(() => updateViewportState(instance), 0);
          }}
          onMove={(_event, viewport) => {
            setCurrentCanvasZoom((current) => Math.abs(current - viewport.zoom) > 0.01 ? viewport.zoom : current);
          }}
          onMoveEnd={() => updateViewportState()}
          onNodeClick={(event, node) => {
            setContextMenu(null);
            if (suppressNodeClickRef.current === node.id) {
              suppressNodeClickRef.current = null;
              return;
            }
            selectCanvasNode(event, node.id);
          }}
          onNodeDoubleClick={openNodeDetailFlow}
          onNodeContextMenu={openNodeMenu}
          onEdgeClick={handleEdgeClick}
          onPaneClick={() => {
            setContextMenu(null);
            selectNode(null);
            selectEdge(null);
          }}
          onPaneContextMenu={(event) => {
            event.preventDefault();
            if (event.ctrlKey || event.metaKey) return;
            openPaneMenuAt(event.clientX, event.clientY);
          }}
          onNodesChange={onNodesChange}
          onSelectionChange={handleSelectionChange}
          onConnect={persistEdgeConnection}
          onNodeDragStart={(event, node) => {
            setContextMenu(null);
            if (!selectedNodeIdSet.has(node.id)) {
              suppressNodeClickRef.current = node.id;
              selectCanvasNode(event, node.id);
            }
          }}
          onNodeDragStop={persistNodePositions}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={multiSelectionKeyCode}
          panActivationKeyCode={null}
          nodeClickDistance={8}
          nodeDragThreshold={4}
          nodesDraggable
          nodesConnectable
          elementsSelectable
          panOnDrag
        >
          <ViewportPortal>
            <div className="flow-group-layer">
              {groupBoxes.map((groupBox) => (
                <div
                  key={groupBox.id}
                  className="flow-group-box"
                  style={{
                    left: groupBox.bounds.x,
                    top: groupBox.bounds.y,
                    width: groupBox.bounds.width,
                    height: groupBox.bounds.height,
                    borderColor: groupBox.color,
                    backgroundColor: `${groupBox.color}24`
                  }}
                />
              ))}
              {/* Labels live outside the boxes: the box sits at z-index -1 (a background),
                  which would trap the label beneath edge paths. */}
              {groupBoxes.map((groupBox) => (
                <div
                  key={`${groupBox.id}-label`}
                  className="flow-group-label-anchor"
                  style={{ left: groupBox.bounds.x, top: groupBox.bounds.y, width: groupBox.bounds.width }}
                >
                  <button
                    type="button"
                    className="flow-group-label"
                    style={{ backgroundColor: groupBox.color, cursor: draggingGroupId === groupBox.id ? "grabbing" : "grab" }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      handleGroupLabelPointerDown(event, groupBox);
                    }}
                    onPointerMove={(event) => {
                      event.stopPropagation();
                      handleGroupLabelPointerMove(event);
                    }}
                    onPointerUp={(event) => {
                      event.stopPropagation();
                      handleGroupLabelPointerUp(event, groupBox);
                    }}
                    onPointerCancel={() => {
                      setDraggingGroupId(null);
                      groupDragRef.current = null;
                    }}
                    title={`Drag to move ${groupBox.name} or click to select all ${groupBox.memberCount} nodes`}
                  >
                    <span className="flow-group-label-name">{groupBox.name}</span>
                    <small>{groupBox.memberCount}</small>
                  </button>
                </div>
              ))}
            </div>
          </ViewportPortal>
          <Background color="var(--flow-grid)" bgColor="transparent" gap={22} />
          {policyViolations.length ? (
            <Panel position="bottom-right" className={`architecture-policy-overlay${minimapVisible ? " has-minimap" : ""}`}>
              {policyIssuesOpen ? (
                <section className="architecture-policy-issues" aria-label="Architecture policy violations">
                  <div className="architecture-policy-issues-heading">
                    <AlertTriangle size={17} aria-hidden="true" />
                    <strong>{policyViolations.length} architecture issue{policyViolations.length === 1 ? "" : "s"}</strong>
                    <small>deterministic</small>
                    <button type="button" className="architecture-policy-issues-close" aria-label="Collapse architecture issues" onClick={() => setPolicyIssuesOpen(false)}>
                      <X size={15} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="architecture-policy-issue-list">
                    {policyViolations.map((violation) => {
                      const ruleTarget = policyRuleTargets.get(violation.id);
                      return (
                        <article key={violation.id}>
                          <div className="architecture-policy-issue-copy">
                            <span>{violation.policyTitle}</span>
                            <small>{violation.source.path}{violation.source.line ? `:${violation.source.line}` : ""}</small>
                          </div>
                          <div className="architecture-policy-issue-actions">
                            <button
                              type="button"
                              title="Explain this violation and suggest resolution in Research chat"
                              onClick={() => startViolationExplanation([violation])}
                            >
                              <CircleHelp size={13} aria-hidden="true" />
                              <span>Explain</span>
                            </button>
                            <button type="button" onClick={() => openPolicyViolationSource(violation)}>
                              {violation.source.entityKind === "node" ? <Box size={13} aria-hidden="true" /> : <FileCode2 size={13} aria-hidden="true" />}
                              <span>{violation.source.entityKind === "node" ? "View node" : "View file"}</span>
                            </button>
                            <button
                              type="button"
                              disabled={!ruleTarget}
                              title={ruleTarget ? undefined : "This policy is not attached to a graph node."}
                              onClick={() => openPolicyViolationRule(violation)}
                            >
                              <ClipboardList size={13} aria-hidden="true" />
                              <span>View rule</span>
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : (
                <Tooltip content={`${policyViolations.length} deterministic architecture issue${policyViolations.length === 1 ? "" : "s"}. Click to review all.`}>
                  <button
                    type="button"
                    className="architecture-policy-trigger"
                    aria-label={`Show ${policyViolations.length} architecture issue${policyViolations.length === 1 ? "" : "s"}`}
                    aria-expanded="false"
                    onClick={() => setPolicyIssuesOpen(true)}
                  >
                    <AlertTriangle size={22} aria-hidden="true" />
                    <span>{policyViolations.length}</span>
                  </button>
                </Tooltip>
              )}
            </Panel>
          ) : null}
          {minimapVisible ? (
            <MiniMap
              key={`${canvasScopeKey}:${minimapRenderVersion}`}
              className="archicode-minimap"
              style={minimapSize}
              offsetScale={minimapOffsetScale}
              bgColor={theme === "dark" ? "#202326" : "#fffefa"}
              nodeStrokeWidth={3}
              maskColor={theme === "dark" ? "rgba(13, 15, 16, 0.72)" : "rgba(255, 255, 255, 0.62)"}
              maskStrokeColor={theme === "dark" ? "#7bc6d5" : "#187487"}
              maskStrokeWidth={2}
              nodeColor={(node) => {
                const archicodeNode = node.data.node as ArchicodeNode;
                if (archicodeNode.locked) return theme === "dark" ? "#425643" : "#d8ecd5";
                if (archicodeNode.flags.includes("needs-attention")) return theme === "dark" ? "#65413b" : "#f1d0c8";
                return theme === "dark" ? "#27383c" : "#dceff2";
              }}
            />
          ) : null}
          {currentCanvasZoom < nodeDetailZoomThreshold && visibleNodes.length > 0 ? (
            <Panel position="bottom-center" className="canvas-node-detail-hint" role="status">
              <ZoomIn size={14} aria-hidden="true" />
              <span>Zoom in to see node details</span>
            </Panel>
          ) : null}
          <Controls position="bottom-left" showFitView={false} showInteractive={false}>
            <ControlButton onClick={fitVisibleNodes} title="Fit view" aria-label="Fit view">
              <CircleDot className="canvas-fit-view-icon" size={13} />
            </ControlButton>
            <ControlButton onClick={toggleFocusMode} title="Toggle full screen mode" aria-label="Toggle full screen mode">
              <Maximize2 size={15} />
            </ControlButton>
          </Controls>
        </ReactFlow>
      )}
      {!canvas3dVisible && !knowledgeMapVisible && contextMenu ? (
        <div
          className="node-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          aria-label={contextMenu.kind === "node" ? "Node actions" : "Canvas actions"}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextMenu.kind === "pane" ? (
            <>
              <span className="context-menu-label">Add node</span>
              {builtInNodeTypes.map((kind) => (
                <button key={kind} type="button" role="menuitem" onClick={() => runPaneAddNode(kind, contextMenu.position)}>
                  <Plus size={15} />
                  <span>{kind}</span>
                </button>
              ))}
              <button type="button" role="menuitem" onClick={() => runNodeMenuAction(pasteNode)}>
                <ClipboardList size={15} />
                <span>Paste node</span>
              </button>
              <span className="context-menu-label">Acceptance tests</span>
              <button
                type="button"
                role="menuitem"
                disabled={eligibleFlowCheckNodeCount === 0}
                title={eligibleFlowCheckNodeCount === 0
                  ? "No nodes with acceptance criteria in this flow"
                  : "Run an AI agent that writes real test files from acceptance criteria for every eligible node in this flow"}
                onClick={runGenerateFlowChecks}
              >
                <Sparkles size={15} />
                <span>Generate tests for flow</span>
              </button>
            </>
          ) : (
            <>
              <span className="context-menu-label">AI</span>
              <button
                type="button"
                role="menuitem"
                title="Explain the selected node and its relationships in project context"
                onClick={() => runNodeResearchAction(contextMenu.nodeId, (nodes) => explainNodesPrompt(nodes, flow!.name))}
              >
                <CircleHelp size={15} />
                <span>{selectedNodeIdSet.size > 1 ? "Explain Selected Nodes" : "Explain This"}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                title="Tag this node in the active research chat so you can ask questions about it"
                onClick={() => runNodeAddToChatAction(contextMenu.nodeId)}
              >
                <MessageSquare size={15} />
                <span>{selectedNodeIdSet.size > 1 ? `Add ${selectedNodeIdSet.size} Nodes to Chat` : "Add to Chat"}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                title="Start a new research chat scoped to this node's context"
                onClick={() => runNodeNewChatAction(contextMenu.nodeId)}
              >
                <Plus size={15} />
                <span>{selectedNodeIdSet.size > 1 ? "New Multi-Node Chat" : "New Scoped Chat"}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                title="Compare the current codebase against this node's spec, acceptance criteria, and linked detail flow"
                onClick={() => runNodeResearchAction(contextMenu.nodeId, (nodes) => multiNodeSpecReviewPrompt(nodes, flow!))}
              >
                <Bot size={15} />
                <span>{selectedNodeIdSet.size > 1 ? "Review Code Against Specs" : "Review Code Against Spec"}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                title="Report a bug or unexpected behavior related to this node"
                onClick={() => runNodeResearchAction(contextMenu.nodeId, multiNodeBugIssuePrompt)}
              >
                <Bug size={15} />
                <span>Report a Bug/Issue</span>
              </button>
              <button
                type="button"
                role="menuitem"
                title="Review the selected node and add missing specification details without splitting it"
                onClick={() => runNodeResearchAction(contextMenu.nodeId, (nodes) => multiNodeRefinePrompt(nodes, flow!))}
              >
                <FilePenLine size={15} />
                <span>{selectedNodeIdSet.size > 1 ? "Refine Selected Nodes" : "Refine Node"}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                title="Add missing detail, then break the selected node into smaller sub-nodes while preserving its overview and relationships"
                onClick={() => runNodeResearchAction(contextMenu.nodeId, (nodes) => multiNodeBreakdownPrompt(nodes, flow!))}
              >
                <GitBranch size={15} />
                <span>{selectedNodeIdSet.size > 1 ? "Break Down Selected Nodes" : "Break Down Node"}</span>
              </button>
              {selectedNodeIdSet.size > 1 ? (
                <button
                  type="button"
                  role="menuitem"
                  title="Merge the selected nodes into a single node with unified description and criteria"
                  onClick={runCombineNodesResearchAction}
                >
                  <Merge size={15} />
                  <span>Combine Nodes</span>
                </button>
              ) : null}
              {selectedNodeIdSet.size > 1 ? (
                <>
                  <span className="context-menu-separator" aria-hidden="true" />
                  <span className="context-menu-label">Arrange</span>
                  <div className="context-submenu">
                    <button type="button" role="menuitem" className="context-submenu-trigger">
                      <AlignLeft size={15} />
                      <span>Align</span>
                      <ChevronRight size={14} className="context-submenu-chevron" />
                    </button>
                    <div className="context-submenu-content" role="menu" aria-label="Align nodes">
                      <button type="button" role="menuitem" onClick={() => runNodeMenuAction(() => arrangeSelectedNodes("align-left"))}>
                        <AlignLeft size={15} />
                        <span>Align left</span>
                      </button>
                      <button type="button" role="menuitem" onClick={() => runNodeMenuAction(() => arrangeSelectedNodes("align-center-horizontal"))}>
                        <AlignCenterHorizontal size={15} />
                        <span>Align centers horizontally</span>
                      </button>
                      <button type="button" role="menuitem" onClick={() => runNodeMenuAction(() => arrangeSelectedNodes("align-right"))}>
                        <AlignRight size={15} />
                        <span>Align right</span>
                      </button>
                      <button type="button" role="menuitem" onClick={() => runNodeMenuAction(() => arrangeSelectedNodes("align-top"))}>
                        <AlignVerticalJustifyStart size={15} />
                        <span>Align top</span>
                      </button>
                      <button type="button" role="menuitem" onClick={() => runNodeMenuAction(() => arrangeSelectedNodes("align-center-vertical"))}>
                        <AlignCenterVertical size={15} />
                        <span>Align centers vertically</span>
                      </button>
                      <button type="button" role="menuitem" onClick={() => runNodeMenuAction(() => arrangeSelectedNodes("align-bottom"))}>
                        <AlignVerticalJustifyEnd size={15} />
                        <span>Align bottom</span>
                      </button>
                    </div>
                  </div>
                  <button type="button" role="menuitem" onClick={() => runNodeMenuAction(() => arrangeSelectedNodes("distribute-horizontal"))}>
                    <AlignVerticalSpaceAround size={15} />
                    <span>Distribute horizontally</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => runNodeMenuAction(() => arrangeSelectedNodes("distribute-vertical"))}>
                    <AlignHorizontalSpaceAround size={15} />
                    <span>Distribute vertically</span>
                  </button>
                </>
              ) : null}
              <span className="context-menu-separator" aria-hidden="true" />
              <button type="button" role="menuitem" onClick={() => runNodeMenuAction(duplicateSelectedNode)}>
                <Copy size={15} />
                <span>{selectedNodeIdSet.size > 1 ? "Duplicate nodes" : "Duplicate node"}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => runNodeMenuAction(copySelectedNode)}>
                <Copy size={15} />
                <span>{selectedNodeIdSet.size > 1 ? "Copy nodes" : "Copy node"}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => runNodeMenuAction(cutSelectedNode)}>
                <Scissors size={15} />
                <span>{selectedNodeIdSet.size > 1 ? "Cut nodes" : "Cut node"}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => runNodeMenuAction(pasteNode)}>
                <ClipboardList size={15} />
                <span>Paste node</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setContextMenu(null);
                  openDeleteConfirm();
                }}
              >
                <Trash2 size={15} />
                <span>{selectedNodeIdSet.size > 1 ? "Delete nodes" : "Delete node"}</span>
              </button>
            </>
          )}
        </div>
      ) : null}

      <DialogRoot open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent
          title={selectedDeleteNodes.length > 1 ? "Delete selected nodes?" : "Delete node?"}
          description="This removes the node data and any connected edges from the current flow."
        >
          <div className="confirm-summary">
            <div className="confirm-summary-grid">
              <span><b>Selection</b>{selectedDeleteNodes.length === 1 ? selectedDeleteNodes[0]?.title ?? "Node" : `${selectedDeleteNodes.length} nodes`}</span>
              <span><b>Effect</b>Connected edges will be removed too</span>
            </div>
            {selectedDeleteNodes.length > 1 ? (
              <p className="confirm-note">
                {selectedDeleteNodes.slice(0, 3).map((node) => node.title).join(", ")}
                {selectedDeleteNodes.length > 3 ? `, and ${selectedDeleteNodes.length - 3} more.` : "."}
              </p>
            ) : null}
          </div>
          <div className="dialog-actions">
            <Button type="button" variant="danger" onClick={() => {
              void deleteSelectedNode();
              setDeleteConfirmOpen(false);
            }}>
              <Trash2 size={15} />
              <span>Delete</span>
            </Button>
            <Button type="button" onClick={() => setDeleteConfirmOpen(false)}>Cancel</Button>
          </div>
        </DialogContent>
      </DialogRoot>
    </section>
  );
}
