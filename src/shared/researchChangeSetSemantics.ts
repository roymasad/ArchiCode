export type ResearchChangeSetCategory = "graph" | "queue" | "change";

type ResearchOperationLike = { kind: string };

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
