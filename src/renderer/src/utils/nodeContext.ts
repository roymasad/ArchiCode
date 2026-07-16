import type { ArchicodeNode } from "@shared/schema";

export type NodeContextTarget = {
  kind: "file" | "directory" | "class" | "function" | "symbol";
  label: string;
  path: string;
};

const claimPriority: Record<NodeContextTarget["kind"], number> = {
  class: 0,
  function: 1,
  symbol: 2,
  file: 3,
  directory: 4
};

function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? path;
}

export function nodeContextTargets(node: ArchicodeNode, limit = 3): NodeContextTarget[] {
  const claims = (node.implementationScope?.claims ?? [])
    .map((claim, index) => ({
      kind: claim.kind,
      label: claim.symbol ?? fileName(claim.path),
      path: claim.path,
      index
    }))
    .sort((left, right) => claimPriority[left.kind] - claimPriority[right.kind] || left.index - right.index);
  const unique = new Map<string, NodeContextTarget>();
  for (const claim of claims) {
    const key = `${claim.kind}:${claim.path}:${claim.label}`;
    if (!unique.has(key)) unique.set(key, { kind: claim.kind, label: claim.label, path: claim.path });
  }
  if (unique.size) return [...unique.values()].slice(0, limit);

  const evidencePaths = node.customProperties?.["Evidence paths"]
    ?.split(",")
    .map((path) => path.trim())
    .filter((path) => path && !/^none\b/i.test(path)) ?? [];
  for (const path of evidencePaths) {
    if (!unique.has(path)) unique.set(path, { kind: "file", label: fileName(path), path });
  }
  return [...unique.values()].slice(0, limit);
}
