import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type Edge, type EdgeProps, type Position } from "@xyflow/react";
import { Tooltip } from "./ui";

type ArchicodeEdgeData = {
  pathKind?: "smoothstep" | "bezier";
  sourceOffset?: number;
  targetOffset?: number;
  arrowColor?: string;
  bidirectional?: boolean;
  policyAlert?: boolean;
  policyViolationId?: string;
  labelTooltip?: string;
  onSelect?: () => void;
};

/**
 * Edge endpoints anchor at the OUTER edge of the 22px handles, which are centered on the
 * node border (see `.flow-node .react-flow__handle` ±11px offsets) — so raw endpoints sit
 * 11px outside the node. We pull them back so lines touch the border and arrow tips sit
 * a hair outside it.
 */
const HANDLE_OVERHANG = 11;
const ARROW_CLEARANCE = 1.5;
const ARROW_LENGTH = 13;
const ARROW_WIDTH = 14;
/** Push the arrowhead forward along the line so its tip meets the node border. */
const ARROW_TIP_ADVANCE = 6;

function insetEndpointTowardNode(x: number, y: number, position: Position, amount: number) {
  switch (position) {
    case "left":
      return { x: x + amount, y };
    case "right":
      return { x: x - amount, y };
    case "top":
      return { x, y: y + amount };
    case "bottom":
      return { x, y: y - amount };
    default:
      return { x, y };
  }
}

function offsetEndpoint(x: number, y: number, position: Position, amount = 0) {
  if (!amount) return { x, y };
  if (position === "left" || position === "right") {
    return { x, y: y + amount };
  }
  return { x: x + amount, y };
}

/** Smoothstep/bezier approach node sides axis-aligned, so arrows rotate per side. */
const ARROW_ROTATION: Record<string, number> = { top: 180, bottom: 0, left: 90, right: 270 };

function ArrowHead({ tip, position, color, selected, policyAlert }: { tip: { x: number; y: number }; position: Position; color: string; selected?: boolean; policyAlert?: boolean }) {
  // The triangle points up at rotation 0 (tip at top-center); position its tip on the
  // endpoint (advanced toward the node) by shifting the center half a length back.
  const arrowLength = policyAlert ? ARROW_LENGTH + 4 : ARROW_LENGTH;
  const arrowWidth = policyAlert ? ARROW_WIDTH + 4 : ARROW_WIDTH;
  const center = insetEndpointTowardNode(tip.x, tip.y, position, ARROW_TIP_ADVANCE - arrowLength / 2);
  return (
    <div
      className={`archicode-edge-arrowhead${selected ? " is-selected" : ""}${policyAlert ? " is-policy-alert" : ""}`}
      style={{
        transform: `translate(-50%, -50%) translate(${center.x}px, ${center.y}px) rotate(${ARROW_ROTATION[position] ?? 0}deg)`,
        borderLeftWidth: arrowWidth / 2,
        borderRightWidth: arrowWidth / 2,
        borderBottomWidth: arrowLength,
        borderBottomColor: color
      }}
    />
  );
}

export function ArchicodeEdge({
  id,
  data,
  selected,
  label,
  sourcePosition,
  sourceX,
  sourceY,
  targetPosition,
  targetX,
  targetY,
  style,
  interactionWidth,
  animated
}: EdgeProps<Edge<ArchicodeEdgeData>>) {
  const bidirectional = data?.bidirectional ?? false;
  const offsetSourcePoint = offsetEndpoint(sourceX, sourceY, sourcePosition, data?.sourceOffset);
  const sourcePoint = insetEndpointTowardNode(
    offsetSourcePoint.x,
    offsetSourcePoint.y,
    sourcePosition,
    HANDLE_OVERHANG - (bidirectional ? ARROW_CLEARANCE : 0)
  );
  const offsetTargetPoint = offsetEndpoint(targetX, targetY, targetPosition, data?.targetOffset);
  const targetPoint = insetEndpointTowardNode(
    offsetTargetPoint.x,
    offsetTargetPoint.y,
    targetPosition,
    HANDLE_OVERHANG - ARROW_CLEARANCE
  );
  const [path, labelX, labelY] = data?.pathKind === "bezier"
    ? getBezierPath({
      sourceX: sourcePoint.x,
      sourceY: sourcePoint.y,
      sourcePosition,
      targetX: targetPoint.x,
      targetY: targetPoint.y,
      targetPosition,
      curvature: 0.34
    })
    : getSmoothStepPath({
      sourceX: sourcePoint.x,
      sourceY: sourcePoint.y,
      sourcePosition,
      targetX: targetPoint.x,
      targetY: targetPoint.y,
      targetPosition,
      borderRadius: 18,
      offset: 22
    });
  const arrowColor = data?.arrowColor ?? "var(--accent)";
  const labelChip = label ? (
    <div
      className={`archicode-edge-label-chip nodrag nopan${selected ? " is-selected" : ""}${data?.policyAlert ? " is-policy-alert" : ""}`}
      style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
      tabIndex={data?.labelTooltip ? 0 : undefined}
      onClick={(event) => {
        event.stopPropagation();
        data?.onSelect?.();
      }}
    >
      {label}
    </div>
  ) : null;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={interactionWidth}
        className={`archicode-edge${selected ? " is-selected" : ""}${animated ? " is-animated" : ""}${data?.policyAlert ? " is-policy-alert" : ""}`}
        style={style}
      />
      <EdgeLabelRenderer>
        {/* HTML arrowheads and labels always paint above every SVG edge path. */}
        <ArrowHead tip={targetPoint} position={targetPosition} color={arrowColor} selected={selected} policyAlert={data?.policyAlert} />
        {bidirectional ? <ArrowHead tip={sourcePoint} position={sourcePosition} color={arrowColor} selected={selected} policyAlert={data?.policyAlert} /> : null}
        {labelChip && data?.labelTooltip ? <Tooltip content={data.labelTooltip}>{labelChip}</Tooltip> : labelChip}
      </EdgeLabelRenderer>
    </>
  );
}
