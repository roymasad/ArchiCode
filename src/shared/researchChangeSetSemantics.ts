export type ResearchChangeSetCategory = "graph" | "queue" | "change";

type ResearchOperationLike = { kind: string };

type ResearchGraphDependencyOperationLike = ResearchOperationLike & {
  flowId?: string;
  node?: { id?: string };
  edge?: { source?: string; target?: string };
};

const graphOperationKinds = new Set([
  "update-project",
  "update-flow",
  "create-flow",
  "update-node",
  "update-edge",
  "add-note",
  "resolve-note",
  "delete-note",
  "create-node",
  "create-edge",
  "create-subflow",
  "create-group",
  "update-group",
  "update-subflow",
  "link-node-subflow",
  "delete-node",
  "delete-edge",
  "delete-subflow",
  "delete-group"
]);

const queueOperationKinds = new Set([
  "start-agent-run",
  "start-run-profile",
  "retry-run",
  "start-debugging-run",
  "start-runtime-debug-run",
  "start-incident-debug-run"
]);

export function researchChangeSetCategory(operations: readonly ResearchOperationLike[]): ResearchChangeSetCategory {
  if (operations.length && operations.every((operation) => queueOperationKinds.has(operation.kind))) return "queue";
  if (operations.length && operations.every((operation) => graphOperationKinds.has(operation.kind))) return "graph";
  return "change";
}

/**
 * Returns operation indexes that must remain selected for each operation.
 * Edges created in the same card depend on any endpoint nodes that the card
 * also creates; existing graph endpoints have no selection dependency.
 */
export function researchGraphOperationDependencies(
  operations: readonly ResearchGraphDependencyOperationLike[]
): number[][] {
  const createdNodeIndexes = new Map<string, number>();
  operations.forEach((operation, index) => {
    if (operation.kind === "create-node" && operation.flowId && operation.node?.id) {
      createdNodeIndexes.set(`${operation.flowId}:${operation.node.id}`, index);
    }
  });

  return operations.map((operation) => {
    if (operation.kind !== "create-edge" || !operation.flowId || !operation.edge) return [];
    return Array.from(new Set(
      [operation.edge.source, operation.edge.target]
        .filter((nodeId): nodeId is string => Boolean(nodeId))
        .map((nodeId) => createdNodeIndexes.get(`${operation.flowId}:${nodeId}`))
        .filter((index): index is number => index !== undefined)
    ));
  });
}

export function toggleResearchGraphOperationSelection(
  operations: readonly ResearchGraphDependencyOperationLike[],
  selected: ReadonlySet<number>,
  operationIndex: number
): Set<number> {
  const next = new Set(selected);
  if (!next.has(operationIndex)) {
    next.add(operationIndex);
    return next;
  }

  next.delete(operationIndex);
  const dependencies = researchGraphOperationDependencies(operations);
  let changed = true;
  while (changed) {
    changed = false;
    operations.forEach((_operation, index) => {
      if (!next.has(index) || !dependencies[index]?.some((dependencyIndex) => !next.has(dependencyIndex))) return;
      next.delete(index);
      changed = true;
    });
  }
  return next;
}
