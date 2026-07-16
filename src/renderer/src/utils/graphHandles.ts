import { Position } from "@xyflow/react";
import type { ArchicodeNode, FlowEdge } from "@shared/schema";

export const nodeHandleSides = [
  { id: "top", position: Position.Top },
  { id: "right", position: Position.Right },
  { id: "bottom", position: Position.Bottom },
  { id: "left", position: Position.Left }
] as const;

export type NodeHandleSide = typeof nodeHandleSides[number]["id"];

const handleSidePositions: Record<NodeHandleSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left
};

export function sideFromHandleId(handleId?: string | null): NodeHandleSide | null {
  if (handleId === "top" || handleId === "right" || handleId === "bottom" || handleId === "left") {
    return handleId;
  }
  return null;
}

export function positionForHandleId(handleId?: string | null, fallback: NodeHandleSide = "right"): Position {
  return handleSidePositions[sideFromHandleId(handleId) ?? fallback];
}

export function inferEdgeHandleSides(
  sourceNode: Pick<ArchicodeNode, "position"> | undefined,
  targetNode: Pick<ArchicodeNode, "position"> | undefined,
  edge?: Pick<FlowEdge, "sourceHandle" | "targetHandle">
): { sourceHandle: NodeHandleSide; targetHandle: NodeHandleSide } {
  const explicitSourceHandle = sideFromHandleId(edge?.sourceHandle);
  const explicitTargetHandle = sideFromHandleId(edge?.targetHandle);
  if (explicitSourceHandle && explicitTargetHandle) {
    return {
      sourceHandle: explicitSourceHandle,
      targetHandle: explicitTargetHandle
    };
  }

  if (!sourceNode || !targetNode) {
    return {
      sourceHandle: explicitSourceHandle ?? "right",
      targetHandle: explicitTargetHandle ?? "left"
    };
  }

  const dx = targetNode.position.x - sourceNode.position.x;
  const dy = targetNode.position.y - sourceNode.position.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      sourceHandle: explicitSourceHandle ?? (dx >= 0 ? "right" : "left"),
      targetHandle: explicitTargetHandle ?? (dx >= 0 ? "left" : "right")
    };
  }

  return {
    sourceHandle: explicitSourceHandle ?? (dy >= 0 ? "bottom" : "top"),
    targetHandle: explicitTargetHandle ?? (dy >= 0 ? "top" : "bottom")
  };
}
