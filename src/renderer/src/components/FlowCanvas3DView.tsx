import { t } from "@renderer/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Maximize2 } from "lucide-react";
import type { ArchicodeNode, Flow, FlowEdge } from "@shared/schema";
import { subflowDepth, visibleEdgesForNodes, visibleNodesForFlow } from "@shared/graph";
import { build3dScopeOffsets } from "../utils/flow3dLayout";

type ViewMode = "active" | "overview";

type FlowCanvas3DViewProps = {
  flow: Flow | null | undefined;
  searchQuery: string;
  theme: "light" | "dark";
  activeSubflowId?: string | null;
  focusedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  onSelectScope?: (subflowId: string | null) => void;
  onToggleFocusMode?: () => void;
};

type SceneNode = {
  id: string;
  title: string;
  description: string;
  scopeId: string | null;
  subflowId: string | null;
  layer: number;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  color: [number, number, number, number];
  isActiveLayer: boolean;
  isAdjacentLayer: boolean;
  isFocused: boolean;
  isNeighbor: boolean;
  isSearchMatch: boolean;
  showLabel: boolean;
  weight: number;
};

type SceneScope = {
  id: string;
  scopeId: string | null;
  parentId: string | null;
  name: string;
  depth: number;
  hue: number;
  fontSize: number;
  isRoot: boolean;
  isActive: boolean;
  labelPoint: [number, number, number];
  focusPoint: [number, number, number];
  focusRadius: number;
};

type SceneGeometry = {
  nodes: SceneNode[];
  scopes: SceneScope[];
  edges: FlowEdge[];
  floorVertices: Float32Array;
  panelVertices: Float32Array;
  lineVertices: Float32Array;
  boundsRadius: number;
  activeLayerCenter: [number, number, number] | null;
};

type CameraState = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
};

type CameraTween = {
  startedAt: number;
  duration: number;
  from: CameraState;
  to: CameraState;
};

type SceneBuildOptions = {
  mode: ViewMode;
  activeSubflowId: string | null;
  focusedNodeId: string | null;
  hoveredNodeId: string | null;
};

const stageOrder = [
  "planned",
  "plan-approved",
  "working",
  "draft",
  "draft-rejected",
  "draft-approved-production"
];

const defaultNodeSize = {
  width: 248,
  height: 154
};

function sceneScopeId(scopeId: string | null): string {
  return scopeId ? `subflow:${scopeId}` : "flow:root";
}

function hueForScope(scopeId: string | null, depth: number, index: number): number {
  if (!scopeId) return 154;
  let hash = 0;
  for (const character of scopeId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return (205 + depth * 43 + index * 67 + hash % 31) % 360;
}

function cameraControlKey(event: KeyboardEvent) {
  if (event.code === "Space" || event.key === " " || event.key === "Spacebar") return "space";
  const key = event.key.toLowerCase();
  if (key === "control" || key === "meta") return key;
  return key;
}

function nodeSizeFor(node: ArchicodeNode) {
  return node.size ?? defaultNodeSize;
}

function layerForNode(flow: Flow, node: ArchicodeNode) {
  return node.subflowId ? subflowDepth(flow, node.subflowId) + 1 : 0;
}

function nodeMatchesActiveLayer(node: ArchicodeNode, activeSubflowId: string | null) {
  return activeSubflowId ? node.subflowId === activeSubflowId : !node.subflowId;
}

function adjacentSubflowIdsFor(flow: Flow, activeSubflowId: string | null): Set<string | null> {
  const adjacent = new Set<string | null>();
  if (activeSubflowId) {
    const active = flow.subflows.find((subflow) => subflow.id === activeSubflowId);
    if (active?.parentSubflowId) adjacent.add(active.parentSubflowId);
    else adjacent.add(null);
    for (const subflow of flow.subflows) {
      if ((subflow.parentSubflowId ?? null) === activeSubflowId) adjacent.add(subflow.id);
    }
  } else {
    for (const subflow of flow.subflows) {
      if (!subflow.parentSubflowId) adjacent.add(subflow.id);
    }
  }
  return adjacent;
}

function nodeMatchesAdjacentLayer(node: ArchicodeNode, adjacentSubflowIds: Set<string | null>) {
  return adjacentSubflowIds.has(node.subflowId ?? null);
}

function nodeMatchesSearch(node: ArchicodeNode, searchQuery: string) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return false;
  return [
    node.title,
    node.description,
    node.type,
    node.stage,
    node.ignored ? "ignored" : "included",
    ...node.flags,
    ...node.techStack,
    ...node.acceptanceCriteria,
    ...Object.values(node.customProperties ?? {})
  ].some((value) => value.toLowerCase().includes(query));
}

function colorFromHex(hex: string, alpha: number): [number, number, number, number] | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  const red = ((value >> 16) & 255) / 255;
  const green = ((value >> 8) & 255) / 255;
  const blue = (value & 255) / 255;
  const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  const boost = (channel: number) => Math.max(0, Math.min(1, luma + (channel - luma) * 1.65));
  const saturated = [boost(red), boost(green), boost(blue)];
  const maxChannel = Math.max(...saturated);
  const brightnessScale = maxChannel > 0 ? Math.max(1, 0.92 / maxChannel) : 1;
  return [
    Math.min(1, saturated[0] * brightnessScale),
    Math.min(1, saturated[1] * brightnessScale),
    Math.min(1, saturated[2] * brightnessScale),
    alpha
  ];
}

function colorForNode(node: ArchicodeNode): [number, number, number, number] {
  const customColor = node.visual.backgroundColor ? colorFromHex(node.visual.backgroundColor, 0.96) : null;
  if (customColor) return customColor;
  if (node.locked) return [0.4, 1, 0.52, 0.78];
  if (node.flags.includes("needs-attention")) return [1, 0.38, 0.24, 0.82];
  if (node.flags.includes("has-diff") || node.flags.includes("changed")) return [0, 0.96, 0.68, 0.82];
  if (node.stage === "working") return [0.3, 0.9, 1, 0.84];
  if (node.stage === "draft-approved-production") return [0.74, 1, 0.42, 0.84];
  return [0.15, 0.78, 1, 0.74];
}

function scaleColor(color: [number, number, number, number], weight: number, alphaScale = 1): [number, number, number, number] {
  const tone = 0.55 + weight * 0.45;
  return [
    color[0] * tone,
    color[1] * tone,
    color[2] * tone,
    Math.max(0.08, Math.min(1, color[3] * alphaScale * (0.35 + weight * 0.65)))
  ];
}

function pushVertex(vertices: number[], x: number, y: number, z: number, color: [number, number, number, number]) {
  vertices.push(x, y, z, color[0], color[1], color[2], color[3]);
}

function addLine(vertices: number[], a: [number, number, number], b: [number, number, number], color: [number, number, number, number]) {
  pushVertex(vertices, a[0], a[1], a[2], color);
  pushVertex(vertices, b[0], b[1], b[2], color);
}

function addQuad(vertices: number[], corners: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]], color: [number, number, number, number]) {
  pushVertex(vertices, ...corners[0], color);
  pushVertex(vertices, ...corners[1], color);
  pushVertex(vertices, ...corners[2], color);
  pushVertex(vertices, ...corners[0], color);
  pushVertex(vertices, ...corners[2], color);
  pushVertex(vertices, ...corners[3], color);
}

function sideCenterPointForNode(node: SceneNode, toward: SceneNode): [number, number, number] {
  const dx = toward.x - node.x;
  const dz = toward.z - node.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.001) return [node.x, node.y + node.height / 2, node.z];
  const xScale = Math.abs(dx) > 0.001 ? (node.width / 2) / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const zScale = Math.abs(dz) > 0.001 ? (node.depth / 2) / Math.abs(dz) : Number.POSITIVE_INFINITY;
  const scale = Math.min(xScale, zScale);
  const x = node.x + dx * scale + (dx / length) * 1.5;
  const z = node.z + dz * scale + (dz / length) * 1.5;
  return [x, node.y + node.height / 2, z];
}

function addThickEdgeBeam(
  vertices: number[],
  lines: number[],
  start: [number, number, number],
  end: [number, number, number],
  options?: { halfWidth?: number; glow?: [number, number, number, number]; core?: [number, number, number, number] }
) {
  const direction = normalize([end[0] - start[0], end[1] - start[1], end[2] - start[2]]);
  const reference: [number, number, number] = Math.abs(direction[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0];
  const axisA = normalize(cross(direction, reference));
  const axisB = normalize(cross(direction, axisA));
  const halfWidth = options?.halfWidth ?? 3.2;
  const glow = options?.glow ?? [1, 0.9, 0.18, 0.38];
  const core = options?.core ?? [1, 0.96, 0.42, 0.92];
  const wideA: [number, number, number] = [axisA[0] * halfWidth, axisA[1] * halfWidth, axisA[2] * halfWidth];
  const wideB: [number, number, number] = [axisB[0] * halfWidth, axisB[1] * halfWidth, axisB[2] * halfWidth];

  addQuad(vertices, [
    [start[0] - wideA[0], start[1] - wideA[1], start[2] - wideA[2]],
    [end[0] - wideA[0], end[1] - wideA[1], end[2] - wideA[2]],
    [end[0] + wideA[0], end[1] + wideA[1], end[2] + wideA[2]],
    [start[0] + wideA[0], start[1] + wideA[1], start[2] + wideA[2]]
  ], glow);
  addQuad(vertices, [
    [start[0] - wideB[0], start[1] - wideB[1], start[2] - wideB[2]],
    [end[0] - wideB[0], end[1] - wideB[1], end[2] - wideB[2]],
    [end[0] + wideB[0], end[1] + wideB[1], end[2] + wideB[2]],
    [start[0] + wideB[0], start[1] + wideB[1], start[2] + wideB[2]]
  ], glow);
  addLine(lines, start, end, core);
}

function addQuietEdge(lines: number[], start: [number, number, number], end: [number, number, number], alpha = 0.2) {
  addLine(lines, start, end, [0.55, 0.9, 0.62, alpha]);
}

function addBox(lines: number[], panels: number[], node: SceneNode) {
  const x0 = node.x - node.width / 2;
  const x1 = node.x + node.width / 2;
  const y0 = node.y;
  const y1 = node.y + node.height;
  const z0 = node.z - node.depth / 2;
  const z1 = node.z + node.depth / 2;
  const c = node.color;
  const fillAlpha = node.isFocused ? 0.62 : node.isNeighbor ? 0.48 : 0.28 + node.weight * 0.22;
  const lineAlpha = node.isFocused ? 1 : node.isNeighbor ? 0.88 : 0.45 + node.weight * 0.5;
  const fill: [number, number, number, number] = [c[0], c[1], c[2], fillAlpha];
  const glow: [number, number, number, number] = [c[0], c[1], c[2], lineAlpha];
  const bottom: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]] = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]];
  const top: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]] = [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];

  addQuad(panels, top, fill);
  addQuad(panels, bottom, fill);
  addQuad(panels, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], fill);
  addQuad(panels, [[x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]], fill);
  addQuad(panels, [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], fill);
  addQuad(panels, [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], fill);

  for (let index = 0; index < 4; index += 1) {
    addLine(lines, bottom[index], bottom[(index + 1) % 4], glow);
    addLine(lines, top[index], top[(index + 1) % 4], glow);
    addLine(lines, bottom[index], top[index], glow);
  }
}

function buildSceneGeometry(flow: Flow | null | undefined, searchQuery: string, options: SceneBuildOptions): SceneGeometry {
  if (!flow) {
    return {
      nodes: [],
      scopes: [],
      edges: [],
      floorVertices: new Float32Array(),
      panelVertices: new Float32Array(),
      lineVertices: new Float32Array(),
      boundsRadius: 720,
      activeLayerCenter: null
    };
  }

  const { mode, activeSubflowId, focusedNodeId, hoveredNodeId } = options;
  const layerIds = [null, ...flow.subflows.map((subflow) => subflow.id)];
  const nodesById = new Map<string, ArchicodeNode>();
  for (const layerId of layerIds) {
    for (const node of visibleNodesForFlow(flow, layerId, searchQuery)) {
      nodesById.set(node.id, node);
    }
  }
  const sourceNodes = Array.from(nodesById.values());
  const scopeOffsets = build3dScopeOffsets(flow, sourceNodes);

  const detailLogicalLayerByNodeId = new Map(
    flow.subflows.flatMap((subflow) => subflow.parentNodeId ? [[subflow.parentNodeId, subflowDepth(flow, subflow.id) + 1] as const] : [])
  );
  const logicalLayers = sourceNodes.map((node) => layerForNode(flow, node));
  const maxLayer = Math.max(0, ...logicalLayers, ...detailLogicalLayerByNodeId.values());
  const layerSpacing = Math.max(140, 118 + Math.min(70, sourceNodes.length * 0.35) + maxLayer * 8);
  const hasSearch = searchQuery.trim().length > 0;

  const neighborIds = new Set<string>();
  const emphasisIds = new Set<string>();
  if (focusedNodeId) emphasisIds.add(focusedNodeId);
  if (hoveredNodeId) emphasisIds.add(hoveredNodeId);
  for (const edge of flow.edges) {
    if (!emphasisIds.has(edge.source) && !emphasisIds.has(edge.target)) continue;
    neighborIds.add(edge.source);
    neighborIds.add(edge.target);
  }
  for (const id of emphasisIds) neighborIds.add(id);

  const activeLayerNodeCount = sourceNodes.filter((node) => nodeMatchesActiveLayer(node, activeSubflowId)).length;
  const activeLayerLabelBudget = activeLayerNodeCount <= 36;
  const adjacentSubflowIds = adjacentSubflowIdsFor(flow, activeSubflowId);
  const adjacentLayerNodeCount = sourceNodes.filter((node) => nodeMatchesAdjacentLayer(node, adjacentSubflowIds)).length;
  const overviewLabelBudget = activeLayerNodeCount + adjacentLayerNodeCount <= 96;

  const nodes = sourceNodes.map((node, index) => {
    const size = nodeSizeFor(node);
    const scopeId = node.subflowId ?? null;
    const scopeOffset = scopeOffsets.get(scopeId) ?? { x: 0, z: 0 };
    const logicalLayer = logicalLayers[index] ?? 0;
    const layer = maxLayer - logicalLayer;
    const stageOffset = Math.max(0, stageOrder.indexOf(node.stage)) * 8;
    const isActiveLayer = nodeMatchesActiveLayer(node, activeSubflowId);
    const isAdjacentLayer = nodeMatchesAdjacentLayer(node, adjacentSubflowIds);
    const isFocused = node.id === focusedNodeId;
    const isHovered = node.id === hoveredNodeId;
    const isNeighbor = neighborIds.has(node.id);
    const isSearchMatch = nodeMatchesSearch(node, searchQuery);
    let weight = 1;
    if (mode === "active") {
      weight = isActiveLayer ? 1 : 0.28;
      if (isSearchMatch) weight = Math.max(weight, 0.85);
      if (isNeighbor) weight = Math.max(weight, 0.72);
      if (isFocused || isHovered) weight = 1;
    } else {
      weight = isActiveLayer ? 0.92 : isAdjacentLayer ? 0.46 : 0.72;
      if (isSearchMatch) weight = Math.max(weight, 0.92);
      if (isNeighbor) weight = Math.max(weight, 0.88);
      if (isFocused || isHovered) weight = 1;
    }
    if (hasSearch && !isSearchMatch && !isFocused && !isHovered && !isNeighbor) {
      weight *= 0.35;
    }

    const sizeScale = mode === "overview"
      ? 0.78 + weight * 0.18
      : (isActiveLayer ? 1 : 0.72) * (0.88 + weight * 0.12);
    const baseColor = colorForNode(node);
    const color = scaleColor(baseColor, weight, isFocused || isHovered ? 1.05 : 1);

    let showLabel = false;
    if (isFocused || isHovered || isSearchMatch) showLabel = true;
    else if (mode === "active" && isActiveLayer && (activeLayerLabelBudget || isNeighbor)) showLabel = true;
    else if (mode === "active" && isNeighbor) showLabel = true;
    else if (mode === "overview" && overviewLabelBudget && (isActiveLayer || isAdjacentLayer)) showLabel = true;

    return {
      id: node.id,
      title: node.title,
      description: node.description ?? "",
      scopeId,
      subflowId: node.subflowId ?? null,
      layer,
      x: (node.position.x + size.width / 2) * 0.44 + scopeOffset.x,
      y: layer * layerSpacing + stageOffset,
      z: (node.position.y + size.height / 2) * 0.44 + scopeOffset.z,
      width: Math.max(36, size.width * 0.26 * sizeScale),
      height: (18 + Math.max(0, stageOrder.indexOf(node.stage)) * 2.5) * (0.9 + weight * 0.15),
      depth: Math.max(28, size.height * 0.26 * sizeScale),
      color,
      isActiveLayer,
      isAdjacentLayer,
      isFocused,
      isNeighbor,
      isSearchMatch,
      showLabel,
      weight
    } satisfies SceneNode;
  });

  const sceneNodesById = new Map(nodes.map((node) => [node.id, node]));
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const allEdges = visibleEdgesForNodes(flow, visibleNodeIds);
  const lines: number[] = [];
  const floorPanels: number[] = [];
  const panels: number[] = [];
  const floorPadding = 120;
  const nodesByScope = new Map<string | null, SceneNode[]>();
  for (const node of nodes) {
    nodesByScope.set(node.scopeId, [...(nodesByScope.get(node.scopeId) ?? []), node]);
  }
  const scopeFloorBounds = Array.from(
    nodesByScope.entries(),
    ([scopeId, scopeNodes]) => ({
      layer: scopeNodes[0]?.layer ?? 0,
      scopeId,
      nodes: scopeNodes,
      minX: Math.min(...scopeNodes.map((node) => node.x - node.width / 2)) - floorPadding,
      maxX: Math.max(...scopeNodes.map((node) => node.x + node.width / 2)) + floorPadding,
      minZ: Math.min(...scopeNodes.map((node) => node.z - node.depth / 2)) - floorPadding,
      maxZ: Math.max(...scopeNodes.map((node) => node.z + node.depth / 2)) + floorPadding
    })
  );
  const layerFloorBounds = Array.from({ length: maxLayer + 1 }, (_unused, layer) => {
    const layerNodes = nodes.filter((node) => node.layer === layer);
    if (!layerNodes.length) {
      return { minX: -220, maxX: 220, minZ: -160, maxZ: 160 };
    }
    return {
      minX: Math.min(...layerNodes.map((node) => node.x - node.width / 2)) - floorPadding,
      maxX: Math.max(...layerNodes.map((node) => node.x + node.width / 2)) + floorPadding,
      minZ: Math.min(...layerNodes.map((node) => node.z - node.depth / 2)) - floorPadding,
      maxZ: Math.max(...layerNodes.map((node) => node.z + node.depth / 2)) + floorPadding
    };
  });
  const scopes: SceneScope[] = [
    { scopeId: null, name: flow.name, parentScopeId: null as string | null },
    ...flow.subflows
      .filter((subflow) => nodesByScope.has(subflow.id))
      .map((subflow) => ({
        scopeId: subflow.id,
        name: subflow.name,
        parentScopeId: subflow.parentSubflowId ?? null
      }))
  ].map((descriptor, index) => {
    const depth = descriptor.scopeId ? subflowDepth(flow, descriptor.scopeId) + 1 : 0;
    const layer = maxLayer - depth;
    const section = scopeFloorBounds.find((item) => item.scopeId === descriptor.scopeId);
    const bounds = section ?? layerFloorBounds[layer] ?? { minX: -220, maxX: 220, minZ: -160, maxZ: 160 };
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const floorY = layer * layerSpacing - 20;
    const isRoot = descriptor.scopeId === null;
    return {
      id: sceneScopeId(descriptor.scopeId),
      scopeId: descriptor.scopeId,
      parentId: isRoot ? null : sceneScopeId(descriptor.parentScopeId),
      name: descriptor.name,
      depth,
      hue: hueForScope(descriptor.scopeId, depth, index),
      fontSize: isRoot ? 15.5 : Math.max(10.5, 12 - (depth - 1) * 0.45),
      isRoot,
      isActive: (activeSubflowId ?? null) === descriptor.scopeId,
      labelPoint: [centerX, floorY + (isRoot ? 38 : 26), bounds.maxZ + (isRoot ? 38 : 28)],
      focusPoint: [centerX, floorY + 34, centerZ],
      focusRadius: Math.max(260, Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 0.68)
    };
  });
  const gridColor: [number, number, number, number] = [0, 0.92, 0.5, mode === "overview" ? 0.08 : 0.1];
  const layerFill: [number, number, number, number] = [0, 0.38, 0.24, 0.05];

  for (const section of scopeFloorBounds) {
    const layer = section.layer;
    const y = layer * layerSpacing - 20;
    const { minX, maxX, minZ, maxZ } = section;
    const floorAlpha = mode === "active"
      ? (section.nodes.some((node) => node.isActiveLayer) ? 0.08 : 0.03)
      : 0.05;
    addQuad(floorPanels, [[minX, y, minZ], [maxX, y, minZ], [maxX, y, maxZ], [minX, y, maxZ]], [layerFill[0], layerFill[1], layerFill[2], floorAlpha]);
    for (let x = Math.floor(minX / 80) * 80; x <= maxX; x += 80) {
      addLine(lines, [x, y + 0.2, minZ], [x, y + 0.2, maxZ], [gridColor[0], gridColor[1], gridColor[2], gridColor[3] * (floorAlpha / 0.05)]);
    }
    for (let z = Math.floor(minZ / 80) * 80; z <= maxZ; z += 80) {
      addLine(lines, [minX, y + 0.2, z], [maxX, y + 0.2, z], [gridColor[0], gridColor[1], gridColor[2], gridColor[3] * (floorAlpha / 0.05)]);
    }
  }

  const scopesById = new Map(scopes.map((scope) => [scope.id, scope]));
  const activeHierarchyGlow: [number, number, number, number] = [0.48, 0.96, 0.86, 0.36];
  const activeHierarchyCore: [number, number, number, number] = [0.86, 1, 0.96, 0.98];
  for (const scope of scopes) {
    if (!scope.parentId) continue;
    const parent = scopesById.get(scope.parentId) ?? scopesById.get(sceneScopeId(null));
    if (!parent) continue;
    const touchesActiveScope = scope.isActive || parent.isActive;
    if (!touchesActiveScope) continue;
    addThickEdgeBeam(panels, lines, parent.labelPoint, scope.labelPoint, {
      halfWidth: scope.depth === 1 ? 2.5 : 2.15,
      glow: activeHierarchyGlow,
      core: activeHierarchyCore
    });
  }

  for (const node of nodes) {
    addBox(lines, panels, node);
  }

  const drawnEdges: FlowEdge[] = [];
  for (const edge of allEdges) {
    const source = sceneNodesById.get(edge.source);
    const target = sceneNodesById.get(edge.target);
    if (!source || !target) continue;

    const touchesEmphasis = neighborIds.has(edge.source) && neighborIds.has(edge.target)
      && (emphasisIds.has(edge.source) || emphasisIds.has(edge.target));
    const bothActive = source.isActiveLayer && target.isActiveLayer;
    let draw = false;
    let emphasized = false;

    if (touchesEmphasis && (emphasisIds.has(edge.source) || emphasisIds.has(edge.target))) {
      draw = true;
      emphasized = true;
    } else if (mode === "active" && bothActive && !focusedNodeId) {
      draw = true;
    } else if (mode === "active" && bothActive && focusedNodeId) {
      draw = true;
    }

    if (!draw) continue;
    drawnEdges.push(edge);
    const start = sideCenterPointForNode(source, target);
    const end = sideCenterPointForNode(target, source);
    if (emphasized) {
      addThickEdgeBeam(panels, lines, start, end, {
        halfWidth: 3.4,
        glow: [1, 0.9, 0.18, 0.42],
        core: [1, 0.96, 0.42, 0.95]
      });
    } else {
      addQuietEdge(lines, start, end, focusedNodeId ? 0.12 : 0.22);
    }
  }

  const floorMinX = Math.min(...layerFloorBounds.map((bounds) => bounds.minX));
  const floorMaxX = Math.max(...layerFloorBounds.map((bounds) => bounds.maxX));
  const floorMinZ = Math.min(...layerFloorBounds.map((bounds) => bounds.minZ));
  const floorMaxZ = Math.max(...layerFloorBounds.map((bounds) => bounds.maxZ));
  const boundsRadius = Math.max(620, Math.hypot(floorMaxX - floorMinX, floorMaxZ - floorMinZ) * 0.72 + maxLayer * layerSpacing * 0.75);

  const activeNodes = nodes.filter((node) => node.isActiveLayer);
  const activeLayerCenter = activeNodes.length
    ? [
      activeNodes.reduce((sum, node) => sum + node.x, 0) / activeNodes.length,
      activeNodes.reduce((sum, node) => sum + node.y + node.height / 2, 0) / activeNodes.length,
      activeNodes.reduce((sum, node) => sum + node.z, 0) / activeNodes.length
    ] as [number, number, number]
    : null;

  return {
    nodes,
    scopes,
    edges: drawnEdges,
    floorVertices: new Float32Array(floorPanels),
    panelVertices: new Float32Array(panels),
    lineVertices: new Float32Array(lines),
    boundsRadius,
    activeLayerCenter
  };
}

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create WebGL shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Unknown shader error.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, `
    attribute vec3 aPosition;
    attribute vec4 aColor;
    uniform mat4 uViewProjection;
    varying vec4 vColor;
    void main() {
      vColor = aColor;
      gl_Position = uViewProjection * vec4(aPosition, 1.0);
    }
  `);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec4 vColor;
    void main() {
      gl_FragColor = vColor;
    }
  `);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create WebGL program.");
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "Unknown WebGL program error.";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function perspective(fovRadians: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovRadians / 2);
  const rangeInv = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (near + far) * rangeInv, -1,
    0, 0, near * far * rangeInv * 2, 0
  ]);
}

function normalize(vector: [number, number, number]): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function dot(a: [number, number, number], b: [number, number, number]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cameraAnglesForTarget(position: Pick<CameraState, "x" | "y" | "z">, target: [number, number, number]) {
  const direction = normalize([target[0] - position.x, target[1] - position.y, target[2] - position.z]);
  return {
    yaw: Math.atan2(direction[0], -direction[2]),
    pitch: Math.asin(Math.max(-1, Math.min(1, direction[1])))
  };
}

function easeInOutCubic(value: number) {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

function lerpAngle(start: number, end: number, amount: number) {
  const delta = Math.atan2(Math.sin(end - start), Math.cos(end - start));
  return start + delta * amount;
}

function lookAt(eye: [number, number, number], target: [number, number, number], up: [number, number, number]) {
  const zAxis = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);
  return new Float32Array([
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -dot(xAxis, eye), -dot(yAxis, eye), -dot(zAxis, eye), 1
  ]);
}

function multiply(a: Float32Array, b: Float32Array) {
  const output = new Float32Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      output[column * 4 + row] =
        a[0 * 4 + row] * b[column * 4 + 0]
        + a[1 * 4 + row] * b[column * 4 + 1]
        + a[2 * 4 + row] * b[column * 4 + 2]
        + a[3 * 4 + row] * b[column * 4 + 3];
    }
  }
  return output;
}

function projectScenePoint(matrix: Float32Array, point: [number, number, number]) {
  const [x, y, z] = point;
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const clipZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (clipW <= 0.001) return null;
  return {
    x: clipX / clipW,
    y: clipY / clipW,
    z: clipZ / clipW,
    w: clipW
  };
}

function cameraBasis(camera: CameraState) {
  const cosPitch = Math.cos(camera.pitch);
  const forward = normalize([
    Math.sin(camera.yaw) * cosPitch,
    Math.sin(camera.pitch),
    -Math.cos(camera.yaw) * cosPitch
  ]);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  return { forward, right, up };
}

function rayFromScreenPoint(canvas: HTMLCanvasElement, camera: CameraState, clientX: number, clientY: number) {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const normalizedX = ((clientX - bounds.left) / width) * 2 - 1;
  const normalizedY = 1 - ((clientY - bounds.top) / height) * 2;
  const aspect = width / height;
  const viewScale = Math.tan(Math.PI / 6);
  const { forward, right, up } = cameraBasis(camera);
  const direction = normalize([
    forward[0] + right[0] * normalizedX * viewScale * aspect + up[0] * normalizedY * viewScale,
    forward[1] + right[1] * normalizedX * viewScale * aspect + up[1] * normalizedY * viewScale,
    forward[2] + right[2] * normalizedX * viewScale * aspect + up[2] * normalizedY * viewScale
  ]);
  return {
    origin: [camera.x, camera.y, camera.z] as [number, number, number],
    direction
  };
}

function intersectRayAabb(origin: [number, number, number], direction: [number, number, number], node: SceneNode) {
  const min: [number, number, number] = [node.x - node.width / 2, node.y, node.z - node.depth / 2];
  const max: [number, number, number] = [node.x + node.width / 2, node.y + node.height, node.z + node.depth / 2];
  let entry = Number.NEGATIVE_INFINITY;
  let exit = Number.POSITIVE_INFINITY;

  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(direction[axis]) < 0.00001) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
      continue;
    }
    const inverseDirection = 1 / direction[axis];
    const near = (min[axis] - origin[axis]) * inverseDirection;
    const far = (max[axis] - origin[axis]) * inverseDirection;
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
    if (entry > exit) return null;
  }

  if (exit < 0) return null;
  return Math.max(0, entry);
}

function pickNodeFromPointer(canvas: HTMLCanvasElement, nodes: SceneNode[], camera: CameraState, clientX: number, clientY: number) {
  const ray = rayFromScreenPoint(canvas, camera, clientX, clientY);
  let pickedNodeId: string | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const node of nodes) {
    const distance = intersectRayAabb(ray.origin, ray.direction, node);
    if (distance === null || distance >= closestDistance) continue;
    pickedNodeId = node.id;
    closestDistance = distance;
  }

  return pickedNodeId;
}

function bindGeometry(gl: WebGLRenderingContext, buffer: WebGLBuffer, vertices: Float32Array, positionLocation: number, colorLocation: number) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 28, 0);
  gl.enableVertexAttribArray(colorLocation);
  gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 28, 12);
}

function cameraLookingAt(target: [number, number, number], boundsRadius: number, preferSide = true): CameraState {
  const sideSign = preferSide && target[0] >= 0 ? 1 : preferSide ? -1 : 0.35;
  const position = {
    x: target[0] + sideSign * Math.max(180, boundsRadius * 0.18),
    y: target[1] + Math.max(90, boundsRadius * 0.12),
    z: target[2] + Math.max(220, boundsRadius * 0.28)
  };
  return { ...position, ...cameraAnglesForTarget(position, target) };
}

export function FlowCanvas3DView({
  flow,
  searchQuery,
  theme,
  activeSubflowId = null,
  focusedNodeId,
  onSelectNode,
  onSelectScope,
  onToggleFocusMode
}: FlowCanvas3DViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keysRef = useRef(new Set<string>());
  const labelRefs = useRef(new Map<string, HTMLSpanElement>());
  const scopeLabelRefs = useRef(new Map<string, HTMLButtonElement>());
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<CameraState>({ x: 0, y: 190, z: 760, yaw: 0, pitch: -0.28 });
  const cameraTweenRef = useRef<CameraTween | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const lastFramedSubflowRef = useRef<string | null | undefined>(undefined);
  const lastFocusedNodeIdRef = useRef<string | null>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("active");
  const [trackSelection, setTrackSelection] = useState(true);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const scene = useMemo(
    () => buildSceneGeometry(flow, searchQuery, {
      mode: viewMode,
      activeSubflowId: activeSubflowId ?? null,
      focusedNodeId: focusedNodeId ?? null,
      hoveredNodeId
    }),
    [flow, searchQuery, viewMode, activeSubflowId, focusedNodeId, hoveredNodeId]
  );

  const labeledNodes = useMemo(() => scene.nodes.filter((node) => node.showLabel), [scene.nodes]);

  useEffect(() => {
    cameraRef.current = { x: 0, y: Math.max(150, scene.boundsRadius * 0.22), z: scene.boundsRadius, yaw: 0, pitch: -0.28 };
    cameraTweenRef.current = null;
    lastFramedSubflowRef.current = undefined;
    // Intentionally not depending on scene.boundsRadius: it is rebuilt on every
    // hover (via hoveredNodeId), since hover changes node weights/sizes and thus
    // the floor bounds. Depending on it here would re-center the camera every
    // time the user hovers a node whose size pushes the scene bounds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow?.id]);

  useEffect(() => {
    if (!focusedNodeId) {
      lastFocusedNodeIdRef.current = null;
      return;
    }
    if (!trackSelection) {
      lastFocusedNodeIdRef.current = null;
      return;
    }
    if (lastFocusedNodeIdRef.current === focusedNodeId) return;
    lastFocusedNodeIdRef.current = focusedNodeId;
    const node = scene.nodes.find((item) => item.id === focusedNodeId);
    if (!node) return;
    const target: [number, number, number] = [node.x, node.y + node.height * 0.82, node.z];
    const sideSign = node.x >= 0 ? 1 : -1;
    const sideDistance = Math.max(170, node.width * 3.2);
    const depthDistance = Math.max(130, node.depth * 2.4);
    const position = {
      x: target[0] + sideSign * sideDistance,
      y: target[1] + Math.max(58, node.height * 1.75),
      z: target[2] + depthDistance
    };
    const angles = cameraAnglesForTarget(position, target);
    cameraTweenRef.current = {
      startedAt: performance.now(),
      duration: 760,
      from: { ...cameraRef.current },
      to: { ...position, ...angles }
    };
    lastFramedSubflowRef.current = activeSubflowId ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedNodeId, trackSelection, scene.nodes]);

  useEffect(() => {
    if (focusedNodeId) return;
    if (viewMode !== "active") return;
    if (lastFramedSubflowRef.current === (activeSubflowId ?? null)) return;
    const center = scene.activeLayerCenter;
    if (!center) return;
    const to = cameraLookingAt(center, scene.boundsRadius);
    cameraTweenRef.current = {
      startedAt: performance.now(),
      duration: 640,
      from: { ...cameraRef.current },
      to
    };
    lastFramedSubflowRef.current = activeSubflowId ?? null;
    // Intentionally not depending on scene.activeLayerCenter/boundsRadius: those
    // are rebuilt on every hover (via hoveredNodeId), which would re-trigger this
    // framing tween even when the active subflow has not changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSubflowId, focusedNodeId, viewMode, flow?.id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus({ preventScroll: true });
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) {
      setWebglError("WebGL is unavailable on this machine.");
      return;
    }

    let animationFrame = 0;
    let lastFrame = performance.now();
    let disposed = false;
    const floorBuffer = gl.createBuffer();
    const panelBuffer = gl.createBuffer();
    const lineBuffer = gl.createBuffer();
    if (!floorBuffer || !panelBuffer || !lineBuffer) {
      setWebglError("WebGL could not allocate scene buffers.");
      return;
    }

    let program: WebGLProgram;
    try {
      program = createProgram(gl);
    } catch (error) {
      setWebglError(error instanceof Error ? error.message : "WebGL shader setup failed.");
      return;
    }

    const positionLocation = gl.getAttribLocation(program, "aPosition");
    const colorLocation = gl.getAttribLocation(program, "aColor");
    const viewProjectionLocation = gl.getUniformLocation(program, "uViewProjection");
    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.floor(canvas.clientWidth * scale));
      const height = Math.max(1, Math.floor(canvas.clientHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
    };

    const stepCamera = (deltaSeconds: number) => {
      if (cameraTweenRef.current) return;
      const camera = cameraRef.current;
      const speed = (keysRef.current.has("shift") ? 420 : 250) * deltaSeconds;
      const cosPitch = Math.cos(camera.pitch);
      const forward = [
        Math.sin(camera.yaw) * cosPitch,
        Math.sin(camera.pitch),
        -Math.cos(camera.yaw) * cosPitch
      ] as [number, number, number];
      const right = normalize(cross(forward, [0, 1, 0]));
      if (keysRef.current.has("w")) {
        camera.x += forward[0] * speed;
        camera.y += forward[1] * speed;
        camera.z += forward[2] * speed;
      }
      if (keysRef.current.has("s")) {
        camera.x -= forward[0] * speed;
        camera.y -= forward[1] * speed;
        camera.z -= forward[2] * speed;
      }
      if (keysRef.current.has("a")) {
        camera.x -= right[0] * speed;
        camera.y -= right[1] * speed;
        camera.z -= right[2] * speed;
      }
      if (keysRef.current.has("d")) {
        camera.x += right[0] * speed;
        camera.y += right[1] * speed;
        camera.z += right[2] * speed;
      }
      if (keysRef.current.has("space")) {
        camera.y += speed;
      }
      if (keysRef.current.has("control") || keysRef.current.has("meta")) {
        camera.y -= speed;
      }
      camera.y = Math.max(-scene.boundsRadius * 1.2, Math.min(scene.boundsRadius * 1.8, camera.y));
    };

    const stepCameraTween = (now: number) => {
      const tween = cameraTweenRef.current;
      if (!tween) return;
      const progress = Math.min(1, Math.max(0, (now - tween.startedAt) / tween.duration));
      const eased = easeInOutCubic(progress);
      cameraRef.current = {
        x: lerp(tween.from.x, tween.to.x, eased),
        y: lerp(tween.from.y, tween.to.y, eased),
        z: lerp(tween.from.z, tween.to.z, eased),
        yaw: lerpAngle(tween.from.yaw, tween.to.yaw, eased),
        pitch: lerp(tween.from.pitch, tween.to.pitch, eased)
      };
      if (progress >= 1) {
        cameraTweenRef.current = null;
      }
    };

    const render = (now: number) => {
      if (disposed) return;
      const deltaSeconds = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;
      resize();
      stepCameraTween(now);
      stepCamera(deltaSeconds);

      const camera = cameraRef.current;
      const cosPitch = Math.cos(camera.pitch);
      const forward: [number, number, number] = [
        Math.sin(camera.yaw) * cosPitch,
        Math.sin(camera.pitch),
        -Math.cos(camera.yaw) * cosPitch
      ];
      const target: [number, number, number] = [camera.x + forward[0], camera.y + forward[1], camera.z + forward[2]];
      const projection = perspective(Math.PI / 3, canvas.width / canvas.height, 0.1, scene.boundsRadius * 5);
      const view = lookAt([camera.x, camera.y, camera.z], target, [0, 1, 0]);
      const viewProjection = multiply(projection, view);
      const cssWidth = canvas.clientWidth;
      const cssHeight = canvas.clientHeight;

      const bg = theme === "dark" ? [0.002, 0.012, 0.01, 1] : [0.015, 0.038, 0.034, 1];
      gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(viewProjectionLocation, false, viewProjection);

      gl.depthMask(false);
      bindGeometry(gl, floorBuffer, scene.floorVertices, positionLocation, colorLocation);
      gl.drawArrays(gl.TRIANGLES, 0, scene.floorVertices.length / 7);

      gl.depthMask(true);
      bindGeometry(gl, panelBuffer, scene.panelVertices, positionLocation, colorLocation);
      gl.drawArrays(gl.TRIANGLES, 0, scene.panelVertices.length / 7);

      bindGeometry(gl, lineBuffer, scene.lineVertices, positionLocation, colorLocation);
      gl.drawArrays(gl.LINES, 0, scene.lineVertices.length / 7);

      for (const scope of scene.scopes) {
        const label = scopeLabelRefs.current.get(scope.id);
        if (!label) continue;
        const projected = projectScenePoint(viewProjection, scope.labelPoint);
        if (!projected || projected.x < -1.15 || projected.x > 1.15 || projected.y < -1.15 || projected.y > 1.15) {
          label.style.opacity = "0";
          label.style.transform = "translate(-50%, -50%) scale(0.82)";
          continue;
        }
        const left = (projected.x * 0.5 + 0.5) * cssWidth;
        const top = (-projected.y * 0.5 + 0.5) * cssHeight;
        const distanceScale = Math.max(0.78, Math.min(1.12, 1.2 - projected.w / (scene.boundsRadius * 3.2)));
        const emphasisScale = scope.isActive ? (scope.isRoot ? 1.08 : 1.04) : scope.isRoot ? 0.96 : 0.82;
        const scale = distanceScale * emphasisScale;
        const depthFade = Math.max(0.68, Math.min(1, 1 - Math.max(0, projected.z) * 0.12));
        label.style.left = `${left}px`;
        label.style.top = `${top}px`;
        const emphasisOpacity = scope.isActive ? 1 : scope.isRoot ? 0.8 : 0.7;
        label.style.opacity = `${depthFade * emphasisOpacity}`;
        label.style.transform = `translate(-50%, -50%) scale(${scale})`;
      }

      for (const node of scene.nodes) {
        const label = labelRefs.current.get(node.id);
        if (!label) continue;
        if (!node.showLabel) {
          label.style.opacity = "0";
          continue;
        }
        const projected = projectScenePoint(viewProjection, [node.x, node.y + node.height * 0.58, node.z]);
        if (!projected || projected.x < -1.15 || projected.x > 1.15 || projected.y < -1.15 || projected.y > 1.15) {
          label.style.opacity = "0";
          label.style.transform = "translate(-50%, -50%) scale(0.86)";
          continue;
        }
        const left = (projected.x * 0.5 + 0.5) * cssWidth;
        const top = (-projected.y * 0.5 + 0.5) * cssHeight;
        const scale = Math.max(0.74, Math.min(1.08, 1.16 - projected.w / (scene.boundsRadius * 2.8)));
        const depthFade = Math.max(0.42, Math.min(1, 1 - Math.max(0, projected.z) * 0.18));
        label.style.left = `${left}px`;
        label.style.top = `${top}px`;
        label.style.opacity = `${depthFade * (0.55 + node.weight * 0.45)}`;
        label.style.transform = `translate(-50%, -50%) scale(${scale})`;
      }

      const tooltip = tooltipRef.current;
      const hoveredNode = hoveredNodeId ? scene.nodes.find((item) => item.id === hoveredNodeId) : null;
      if (tooltip && hoveredNode && hoveredNode.showLabel) {
        const projected = projectScenePoint(viewProjection, [hoveredNode.x, hoveredNode.y + hoveredNode.height * 0.58, hoveredNode.z]);
        if (projected && projected.x >= -1.15 && projected.x <= 1.15 && projected.y >= -1.15 && projected.y <= 1.15) {
          const left = (projected.x * 0.5 + 0.5) * cssWidth;
          const top = (-projected.y * 0.5 + 0.5) * cssHeight;
          tooltip.style.left = `${left}px`;
          tooltip.style.top = `${top}px`;
          tooltip.style.opacity = "1";
        } else {
          tooltip.style.opacity = "0";
        }
      } else if (tooltip) {
        tooltip.style.opacity = "0";
      }

      animationFrame = requestAnimationFrame(render);
    };

    animationFrame = requestAnimationFrame(render);
    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      gl.deleteBuffer(floorBuffer);
      gl.deleteBuffer(panelBuffer);
      gl.deleteBuffer(lineBuffer);
      gl.deleteProgram(program);
    };
  }, [scene, theme, hoveredNodeId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = cameraControlKey(event);
      if (!["w", "a", "s", "d", "shift", "space", "control", "meta"].includes(key)) return;
      event.preventDefault();
      cameraTweenRef.current = null;
      keysRef.current.add(key);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      keysRef.current.delete(cameraControlKey(event));
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      keysRef.current.clear();
    };
  }, []);

  const rotateCamera = (deltaX: number, deltaY: number) => {
    cameraTweenRef.current = null;
    const camera = cameraRef.current;
    camera.yaw += deltaX * 0.004;
    camera.pitch = Math.max(-1.25, Math.min(0.72, camera.pitch - deltaY * 0.003));
  };

  const moveCameraAlongView = (delta: number) => {
    cameraTweenRef.current = null;
    const camera = cameraRef.current;
    const cosPitch = Math.cos(camera.pitch);
    const forward = [
      Math.sin(camera.yaw) * cosPitch,
      Math.sin(camera.pitch),
      -Math.cos(camera.yaw) * cosPitch
    ];
    camera.x += forward[0] * delta;
    camera.y += forward[1] * delta;
    camera.z += forward[2] * delta;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const moveCameraOnWheel = (event: WheelEvent) => {
      event.preventDefault();
      moveCameraAlongView(event.deltaY * 0.32);
    };
    canvas.addEventListener("wheel", moveCameraOnWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", moveCameraOnWheel);
  }, []);

  const updateHoverFromPointer = useCallback((clientX: number, clientY: number, canvas: HTMLCanvasElement) => {
    if (dragRef.current) return;
    const picked = pickNodeFromPointer(canvas, scene.nodes, cameraRef.current, clientX, clientY);
    setHoveredNodeId((current) => (current === picked ? current : picked));
  }, [scene.nodes]);

  const focusScope = useCallback((scope: SceneScope) => {
    onSelectScope?.(scope.scopeId);
    const to = cameraLookingAt(scope.focusPoint, scope.focusRadius, false);
    cameraTweenRef.current = {
      startedAt: performance.now(),
      duration: 680,
      from: { ...cameraRef.current },
      to
    };
    lastFocusedNodeIdRef.current = null;
    lastFramedSubflowRef.current = scope.scopeId;
  }, [onSelectScope]);

  const activeLayerLabel = activeSubflowId
    ? flow?.subflows.find((subflow) => subflow.id === activeSubflowId)?.name ?? "Subflow"
    : "Root flow";

  return (
    <div className="flow-3d-view" aria-label={t("Read-only 3D flow visualization. Use WASD keys and mouse drag to navigate.")}>
      <canvas
        ref={canvasRef}
        className={`flow-3d-webgl${dragging ? " is-dragging" : ""}`}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag && drag.pointerId === event.pointerId) {
            rotateCamera(event.clientX - drag.x, event.clientY - drag.y);
            dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
            return;
          }
          updateHoverFromPointer(event.clientX, event.clientY, event.currentTarget);
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const clickDistance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
          if (clickDistance <= 5) {
            const pickedNodeId = pickNodeFromPointer(event.currentTarget, scene.nodes, cameraRef.current, event.clientX, event.clientY);
            onSelectNode?.(pickedNodeId);
          }
          dragRef.current = null;
          setDragging(false);
        }}
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
            setDragging(false);
          }
        }}
        onPointerLeave={() => {
          if (!dragRef.current) setHoveredNodeId(null);
        }}
      />
      <div className="flow-3d-toolbar" role="toolbar" aria-label={t("3D view mode")}>
        <button
          type="button"
          className={`flow-3d-mode-btn${viewMode === "active" ? " is-active" : ""}`}
          aria-pressed={viewMode === "active"}
          title={t("Emphasize the active layer; other layers stay visible but dimmed")}
          onClick={() => setViewMode("active")}
        >
          {t("Active")}{" "}</button>
        <button
          type="button"
          className={`flow-3d-mode-btn${viewMode === "overview" ? " is-active" : ""}`}
          aria-pressed={viewMode === "overview"}
          title={t("Even multi-layer overview; edges appear on focus")}
          onClick={() => setViewMode("overview")}
        >
          {t("Overview")}{" "}</button>
        <button
          type="button"
          className={`flow-3d-mode-btn flow-3d-focus-toggle${trackSelection ? " is-active" : ""}`}
          aria-pressed={trackSelection}
          title={trackSelection ? t("Camera follows selection (click to keep camera fixed)") : t("Camera stays fixed on selection (click to follow selection)")}
          onClick={() => setTrackSelection((value) => !value)}
        >
          {trackSelection ? t("✓ Follow") : t("Follow")}
        </button>
        <span className="flow-3d-toolbar-meta" title={t("Active layer emphasis")}>
          {viewMode === "active" ? activeLayerLabel : t("All layers")}
          <span className="flow-3d-toolbar-counts">{t("· {{length}} f · {{length2}} n · {{length3}} e", { length: scene.scopes.length, length2: scene.nodes.length, length3: scene.edges.length })}</span>
        </span>
      </div>
      <div className="flow-3d-corner-controls" role="toolbar" aria-label={t("3D canvas controls")}>
        <button
          type="button"
          title={t("Toggle full screen mode")}
          aria-label={t("Toggle full screen mode")}
          onClick={onToggleFocusMode}
        >
          <Maximize2 size={15} />
        </button>
      </div>
      <div className="flow-3d-label-layer">
        {scene.scopes.map((scope) => (
          <button
            type="button"
            key={scope.id}
            ref={(element) => {
              if (element) scopeLabelRefs.current.set(scope.id, element);
              else scopeLabelRefs.current.delete(scope.id);
            }}
            className={`flow-3d-scope-label ${scope.isRoot ? "is-root" : "is-subflow"}${scope.isActive ? " is-active" : ""}`}
            aria-label={t("Focus {{value1}}{{name}}", { value1: scope.isRoot ? "flow" : `level ${scope.depth} subflow`, name: scope.name })}
            aria-pressed={scope.isActive}
            title={t("Focus {{name}}", { name: scope.name })}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              focusScope(scope);
            }}
            style={{
              "--flow-scope-hue": scope.hue,
              "--flow-scope-font-size": `${scope.fontSize}px`
            } as CSSProperties}
          >
            <span className="flow-3d-scope-kind">{scope.isRoot ? t("FLOW") : t("L {{depth}}", { depth: scope.depth })}</span>
            <span className="flow-3d-scope-name">{scope.name}</span>
          </button>
        ))}
        {labeledNodes.map((node) => (
          <span
            key={node.id}
            aria-hidden="true"
            ref={(element) => {
              if (element) labelRefs.current.set(node.id, element);
              else labelRefs.current.delete(node.id);
            }}
            className={`flow-3d-node-label${node.id === focusedNodeId ? " is-focused" : ""}${node.id === hoveredNodeId ? " is-hovered" : ""}${node.isActiveLayer ? " is-active-layer" : ""}`}
          >
            {node.title}
          </span>
        ))}
      </div>
      {(() => {
        const hoveredSceneNode = hoveredNodeId ? scene.nodes.find((node) => node.id === hoveredNodeId) : null;
        const description = hoveredSceneNode?.description?.trim();
        if (!hoveredSceneNode || !description) return null;
        return (
          <div
            ref={tooltipRef}
            className="flow-3d-node-tooltip"
            role="tooltip"
          >
            <span className="flow-3d-node-tooltip-title">{hoveredSceneNode.title}</span>
            <span className="flow-3d-node-tooltip-desc">{description}</span>
          </div>
        );
      })()}
      {webglError ? <div className="flow-3d-fallback">{webglError}</div> : null}
    </div>
  );
}
