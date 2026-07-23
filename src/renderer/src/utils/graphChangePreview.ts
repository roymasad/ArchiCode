import type { ArchicodeNode, Flow, FlowEdge, ResearchGraphOperation } from "@shared/schema";
import { placeCreatedResearchNodes } from "../../../shared/researchCreatedNodeLayout";

export type GraphPreviewChangeKind = "added" | "modified" | "removed";

export type FlowGraphPreview = {
  nodeStates: Map<string, GraphPreviewChangeKind>;
  phantomNodes: ArchicodeNode[];
  edgeStates: Map<string, GraphPreviewChangeKind>;
  phantomEdges: FlowEdge[];
  stats: { added: number; modified: number; removed: number };
};

/** Returns the flowId a research graph operation is scoped to, or null for project/global operations. */
export function operationFlowId(operation: ResearchGraphOperation): string | null {
  if (operation.kind === "create-flow") return operation.flow.id;
  if (
    operation.kind === "update-flow" ||
    operation.kind === "update-node" ||
    operation.kind === "update-edge" ||
    operation.kind === "create-node" ||
    operation.kind === "create-edge" ||
    operation.kind === "create-subflow" ||
    operation.kind === "create-group" ||
    operation.kind === "update-group" ||
    operation.kind === "update-subflow" ||
    operation.kind === "link-node-subflow" ||
    operation.kind === "start-agent-run" ||
    operation.kind === "start-run-profile" ||
    operation.kind === "start-runtime-debug-run" ||
    operation.kind === "delete-node" ||
    operation.kind === "delete-edge" ||
    operation.kind === "delete-subflow" ||
    operation.kind === "delete-group" ||
    operation.kind === "author-acceptance-tests" ||
    operation.kind === "run-acceptance-checks"
  ) return operation.flowId;
  if (operation.kind === "start-incident-debug-run") return operation.flowId ?? null;
  if (operation.kind === "add-note") return operation.note.flowId;
  return null;
}

const PHANTOM_STACK_OFFSET_Y = 220;
const RELATIVE_HINT_OFFSET = 260;

type PositionHint = { relativeToNodeId: string; placement: "above" | "below" | "left" | "right" };

function isConcretePosition(value: unknown): value is { x: number; y: number } {
  return Boolean(value) && typeof (value as { x?: unknown }).x === "number" && typeof (value as { y?: unknown }).y === "number";
}

function isPositionHint(value: unknown): value is PositionHint {
  return Boolean(value) && typeof (value as { relativeToNodeId?: unknown }).relativeToNodeId === "string";
}

function contentBoundsBottom(nodes: ArchicodeNode[]): { x: number; y: number } {
  if (!nodes.length) return { x: 0, y: 0 };
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const maxY = Math.max(...nodes.map((node) => node.position.y + (node.size?.height ?? 160)));
  return { x: minX, y: maxY + 80 };
}

function resolvePhantomPosition(
  rawNode: Extract<ResearchGraphOperation, { kind: "create-node" }>["node"],
  positionsById: Map<string, { x: number; y: number }>,
  fallbackOrigin: { x: number; y: number },
  stackIndex: number
): { x: number; y: number } {
  if (isConcretePosition(rawNode.position)) return rawNode.position;
  const hint = isPositionHint(rawNode.positionHint)
    ? rawNode.positionHint
    : isPositionHint(rawNode.position)
      ? rawNode.position
      : undefined;
  if (hint) {
    const anchor = positionsById.get(hint.relativeToNodeId);
    if (anchor) {
      switch (hint.placement) {
        case "above": return { x: anchor.x, y: anchor.y - RELATIVE_HINT_OFFSET };
        case "below": return { x: anchor.x, y: anchor.y + RELATIVE_HINT_OFFSET };
        case "left": return { x: anchor.x - RELATIVE_HINT_OFFSET, y: anchor.y };
        case "right": return { x: anchor.x + RELATIVE_HINT_OFFSET, y: anchor.y };
      }
    }
  }
  return { x: fallbackOrigin.x, y: fallbackOrigin.y + stackIndex * PHANTOM_STACK_OFFSET_Y };
}

function toPhantomNode(
  rawNode: Extract<ResearchGraphOperation, { kind: "create-node" }>["node"],
  id: string,
  position: { x: number; y: number }
): ArchicodeNode {
  return {
    id,
    type: rawNode.type ?? "feature",
    title: rawNode.title,
    description: rawNode.description ?? "",
    stage: rawNode.stage ?? "planned",
    ignored: rawNode.ignored ?? false,
    flags: rawNode.flags ?? [],
    locked: rawNode.locked ?? false,
    visual: rawNode.visual ?? { shape: "rounded" },
    position,
    size: rawNode.size,
    parentId: rawNode.parentId,
    subflowId: rawNode.subflowId,
    groupId: rawNode.groupId,
    techStack: rawNode.techStack ?? [],
    acceptanceCriteria: rawNode.acceptanceCriteria ?? [],
    acceptanceChecks: rawNode.acceptanceChecks ?? [],
    subjectRef: rawNode.subjectRef,
    implementationScope: rawNode.implementationScope,
    moduleProfileMode: rawNode.moduleProfileMode,
    moduleProfileId: rawNode.moduleProfileId,
    customProperties: rawNode.customProperties ?? {},
    ruleIds: rawNode.ruleIds,
    attachments: rawNode.attachments ?? [],
    todos: rawNode.todos ?? [],
    updatedAt: ""
  };
}

let phantomIdCounter = 0;
function nextPhantomId(): string {
  phantomIdCounter += 1;
  return `preview-phantom-node-${phantomIdCounter}`;
}

/**
 * Pure, side-effect-free diff of a change set's operations against one flow's current
 * graph. Used to render a read-only ghost overlay on the canvas — never mutates state
 * and doesn't touch the store.
 */
export function buildFlowGraphPreview(flow: Flow, operations: ResearchGraphOperation[]): FlowGraphPreview {
  const nodeStates = new Map<string, GraphPreviewChangeKind>();
  const edgeStates = new Map<string, GraphPreviewChangeKind>();
  const phantomNodes: ArchicodeNode[] = [];
  const phantomEdges: FlowEdge[] = [];
  const autoLayoutNodeIds = new Set<string>();

  const positionsById = new Map<string, { x: number; y: number }>(flow.nodes.map((node) => [node.id, node.position]));
  const nodeExists = new Set<string>(flow.nodes.map((node) => node.id));
  const fallbackOrigin = contentBoundsBottom(flow.nodes);
  let phantomStackIndex = 0;

  const relevant = operations.filter((operation) => operationFlowId(operation) === flow.id);

  for (const operation of relevant) {
    switch (operation.kind) {
      case "create-node": {
        const id = operation.node.id ?? nextPhantomId();
        const position = resolvePhantomPosition(operation.node, positionsById, fallbackOrigin, phantomStackIndex);
        phantomStackIndex += 1;
        const phantomNode = toPhantomNode(operation.node, id, position);
        phantomNodes.push(phantomNode);
        if (!isConcretePosition(operation.node.position) && !isPositionHint(operation.node.positionHint) && !isPositionHint(operation.node.position)) {
          autoLayoutNodeIds.add(id);
        }
        positionsById.set(id, position);
        nodeExists.add(id);
        nodeStates.set(id, "added");
        break;
      }
      case "update-node": {
        const id = operation.patch.id;
        if (!nodeStates.get(id)) nodeStates.set(id, "modified");
        break;
      }
      case "delete-node": {
        nodeStates.set(operation.nodeId, "removed");
        break;
      }
      case "create-edge": {
        const source = operation.edge.source;
        const target = operation.edge.target;
        if (!source || !target || !nodeExists.has(source) || !nodeExists.has(target)) break;
        const id = operation.edge.id ?? `preview-phantom-edge-${phantomEdges.length + 1}`;
        phantomEdges.push({ ...operation.edge, id, source, target } as FlowEdge);
        edgeStates.set(id, "added");
        break;
      }
      case "update-edge": {
        if (!edgeStates.get(operation.edgeId)) edgeStates.set(operation.edgeId, "modified");
        break;
      }
      case "delete-edge": {
        edgeStates.set(operation.edgeId, "removed");
        break;
      }
      default:
        break;
    }
  }

  // Apply the exact same topology-aware placement used after approval. The
  // filtered operation list already reflects the user's checkbox selection,
  // so a partial preview and its partial apply share identical coordinates.
  const laidOutPreviewFlow = autoLayoutNodeIds.size
    ? placeCreatedResearchNodes({
        ...flow,
        nodes: [...flow.nodes, ...phantomNodes],
        edges: [...flow.edges, ...phantomEdges]
      }, autoLayoutNodeIds)
    : null;
  const laidOutPositions = laidOutPreviewFlow
    ? new Map(laidOutPreviewFlow.nodes.map((node) => [node.id, node.position]))
    : null;
  const positionedPhantomNodes = laidOutPositions
    ? phantomNodes.map((node) => ({ ...node, position: laidOutPositions.get(node.id) ?? node.position }))
    : phantomNodes;

  const stats = { added: 0, modified: 0, removed: 0 };
  for (const kind of nodeStates.values()) stats[kind] += 1;
  for (const kind of edgeStates.values()) stats[kind] += 1;

  return { nodeStates, phantomNodes: positionedPhantomNodes, edgeStates, phantomEdges, stats };
}
