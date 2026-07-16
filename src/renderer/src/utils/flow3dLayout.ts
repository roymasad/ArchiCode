import { subflowDepth } from "../../../shared/graph";
import type { ArchicodeNode, Flow } from "../../../shared/schema";

type ScopeBounds = {
  scopeId: string | null;
  logicalLayer: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

const defaultNodeSize = { width: 248, height: 154 };

export function build3dScopeOffsets(flow: Flow, nodes: ArchicodeNode[]): Map<string | null, { x: number; z: number }> {
  const scopeOrder = new Map<string | null, number>([
    [null, 0],
    ...flow.subflows.map((subflow, index) => [subflow.id, index + 1] as const)
  ]);
  const scopeBounds = new Map<string | null, ScopeBounds>();
  for (const node of nodes) {
    const scopeId = node.subflowId ?? null;
    const size = node.size ?? defaultNodeSize;
    const x = (node.position.x + size.width / 2) * 0.44;
    const z = (node.position.y + size.height / 2) * 0.44;
    const halfWidth = Math.max(36, size.width * 0.26) / 2;
    const halfDepth = Math.max(28, size.height * 0.26) / 2;
    const current = scopeBounds.get(scopeId);
    if (current) {
      current.minX = Math.min(current.minX, x - halfWidth);
      current.maxX = Math.max(current.maxX, x + halfWidth);
      current.minZ = Math.min(current.minZ, z - halfDepth);
      current.maxZ = Math.max(current.maxZ, z + halfDepth);
    } else {
      scopeBounds.set(scopeId, {
        scopeId,
        logicalLayer: node.subflowId ? subflowDepth(flow, node.subflowId) + 1 : 0,
        minX: x - halfWidth,
        maxX: x + halfWidth,
        minZ: z - halfDepth,
        maxZ: z + halfDepth
      });
    }
  }

  const offsets = new Map<string | null, { x: number; z: number }>();
  const logicalLayers = new Set(Array.from(scopeBounds.values(), (bounds) => bounds.logicalLayer));
  for (const logicalLayer of logicalLayers) {
    const scopes = Array.from(scopeBounds.values())
      .filter((bounds) => bounds.logicalLayer === logicalLayer)
      .sort((a, b) => (scopeOrder.get(a.scopeId) ?? 0) - (scopeOrder.get(b.scopeId) ?? 0));
    const columns = Math.max(1, Math.ceil(Math.sqrt(scopes.length)));
    const rows = Math.ceil(scopes.length / columns);
    const cellWidth = Math.max(...scopes.map((bounds) => bounds.maxX - bounds.minX)) + 320;
    const cellDepth = Math.max(...scopes.map((bounds) => bounds.maxZ - bounds.minZ)) + 320;
    for (const [index, bounds] of scopes.entries()) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const targetX = (column - (columns - 1) / 2) * cellWidth;
      const targetZ = (row - (rows - 1) / 2) * cellDepth;
      offsets.set(bounds.scopeId, {
        x: targetX - (bounds.minX + bounds.maxX) / 2,
        z: targetZ - (bounds.minZ + bounds.maxZ) / 2
      });
    }
  }
  return offsets;
}
