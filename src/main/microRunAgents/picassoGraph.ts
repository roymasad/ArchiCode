import type { MicroRunAgent, MicroRunContext, MicroRunTool, MicroRunToolInvocation } from "../microRuns";
import {
  graphReconciliationInputSchema,
  picassoGraphInputSchema,
  researchGraphChangeSetSchema,
  type GraphReconciliationInput,
  type ArchicodeNode,
  type Flow,
  type FlowEdge,
  type FlowGroup,
  type FlowSubflow,
  type PicassoGraphOutput,
  type ResearchGraphOperation
} from "../../shared/schema";
import { createReadOnlyInvestigationTools, extractJsonObject } from "./readOnlyTools";

const PICASSO_TIMEOUT_MS = 45 * 60 * 1000;
const PICASSO_BATCH_MAX_OPERATIONS = 16;
const PICASSO_MIN_NODE_DESCRIPTION_CHARS = 160;
const PICASSO_MIN_FLOW_DESCRIPTION_CHARS = 140;
const PICASSO_SUBSTANTIAL_ROOT_NODE_COUNT = 6;
const PICASSO_VISUAL_SHAPES = ["rounded", "rectangle", "capsule", "document", "database", "note", "ellipse", "diamond", "hexagon", "parallelogram", "cloud", "actor"] as const;
type PicassoVisualShape = typeof PICASSO_VISUAL_SHAPES[number];
type PicassoTask = GraphReconciliationInput & { objective?: string };
type PicassoDetailFlowAssessment = {
  flowId: string;
  decision: "decomposed" | "keep-flat";
  candidateNodeIds: string[];
  rationale: string;
};
type PicassoFinalBatchArgs = {
  summary: string;
  operations: unknown[];
  detailFlowAssessments?: PicassoDetailFlowAssessment[];
};

function normalizePicassoStringList(value: unknown): unknown {
  if (Array.isArray(value) || value === undefined) return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    // Preserve malformed or truncated list-shaped text as one constraint. The
    // subagent can still follow it, and a weak parent model does not prevent
    // Picasso from starting merely because it serialized an array as text.
  }
  return [trimmed];
}

const picassoNodeVisualInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["shape", "backgroundColor"],
  properties: {
    shape: {
      type: "string",
      enum: [...PICASSO_VISUAL_SHAPES],
      description: "Visual geometry only. Use exactly one allowed enum value; semantic roles such as workflow, service, screen, policy, or integration belong in node.type, not visual.shape."
    },
    backgroundColor: {
      type: "string",
      pattern: "^#[0-9a-fA-F]{6}$",
      description: "Use a consistent domain color encoded as #RRGGBB."
    }
  }
};

const picassoNodeInputSchema = {
  type: "object",
  additionalProperties: true,
  required: ["id", "type", "title", "description", "visual", "techStack", "acceptanceCriteria"],
  properties: {
    id: { type: "string", description: "Stable unique node id, required so later edge batches can reference this node." },
    type: {
      type: "string",
      description: "Semantic architectural type such as actor, screen, workflow, service, api, data-store, integration, policy, security-control, infrastructure, or quality-gate. Do not label every node feature."
    },
    title: { type: "string" },
    description: {
      type: "string",
      minLength: PICASSO_MIN_NODE_DESCRIPTION_CHARS,
      description: "A substantial 2-4 sentence description covering responsibility, inputs/outputs or interactions, and important constraints. Target roughly 180-360 characters."
    },
    stage: { type: "string", enum: ["planned", "plan-approved", "working", "draft", "draft-rejected", "draft-approved-production"] },
    visual: picassoNodeVisualInputSchema,
    techStack: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: { type: "string" },
      description: "Relevant technologies, protocols, platforms, standards, or explicit technology decisions still pending."
    },
    acceptanceCriteria: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: { type: "string" },
      description: "Specific observable outcomes that make this node reviewable and implementable."
    },
    subflowId: { type: "string" },
    groupId: { type: "string" },
    position: {
      oneOf: [
        { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
        { type: "object", required: ["relativeToNodeId", "placement"], properties: { relativeToNodeId: { type: "string" }, placement: { type: "string", enum: ["above", "below", "left", "right"] } } }
      ]
    },
    positionHint: {
      type: "object",
      required: ["relativeToNodeId", "placement"],
      properties: { relativeToNodeId: { type: "string" }, placement: { type: "string", enum: ["above", "below", "left", "right"] } }
    },
    customProperties: { type: "object", additionalProperties: { type: "string" } }
  }
};

const picassoGraphOperationInputSchema = {
  type: "object",
  additionalProperties: true,
  required: ["kind"],
  properties: {
    kind: {
      type: "string",
      enum: [
        "update-project", "update-flow", "update-node", "update-edge", "add-note", "resolve-note", "delete-note",
        "create-flow", "create-node", "create-edge", "create-subflow", "create-group", "update-group", "update-subflow",
        "link-node-subflow", "delete-node", "delete-edge", "delete-subflow", "delete-group"
      ]
    },
    flowId: { type: "string", description: "Containing top-level flow id, for example flow-main. Required for flow graph operations." },
    flow: {
      type: "object",
      additionalProperties: true,
      required: ["id", "name", "description", "nodes", "edges", "subflows", "groups"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: {
          type: "string",
          minLength: PICASSO_MIN_FLOW_DESCRIPTION_CHARS,
          description: "A multi-sentence boundary description covering primary actors/capabilities and relationships to neighboring flows."
        },
        nodes: { type: "array", items: { type: "object", additionalProperties: true } },
        edges: { type: "array", items: { type: "object", additionalProperties: true } },
        subflows: { type: "array", items: { type: "object", additionalProperties: true } },
        groups: { type: "array", items: { type: "object", additionalProperties: true } }
      },
      description: "Nested top-level flow object for create-flow. To use auto-layout, create the flow with empty collections and follow it with rich create-node and create-edge operations."
    },
    patch: { type: "object", description: "Nested patch for update operations." },
    node: { ...picassoNodeInputSchema, description: "Nested rich node object for create-node. Child nodes must include subflowId." },
    edge: {
      type: "object",
      additionalProperties: true,
      required: ["source", "target", "label"],
      properties: {
        id: { type: "string" },
        source: { type: "string" },
        target: { type: "string" },
        label: { type: "string", description: "Short relationship verb or phrase, such as authenticates, invokes, stores, publishes, or verifies." },
        lineStyle: { type: "string", enum: ["solid", "dashed", "dotted"] },
        animated: { type: "boolean" },
        bidirectional: { type: "boolean" }
      },
      description: "Nested semantic edge object for create-edge. Both endpoints must be on the same canvas scope."
    },
    subflow: { type: "object", description: "Nested subflow object for create-subflow with id, name, and optional parent ids." },
    group: { type: "object", description: "Nested group object for create-group." },
    note: { type: "object", description: "Nested note object for add-note." },
    nodeId: { type: "string" },
    edgeId: { type: "string" },
    subflowId: { type: ["string", "null"] },
    groupId: { type: "string" },
    noteId: { type: "string" },
    resolved: { type: "boolean" }
  }
};

const picassoDetailFlowAssessmentInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["flowId", "decision", "candidateNodeIds", "rationale"],
  properties: {
    flowId: { type: "string" },
    decision: {
      type: "string",
      enum: ["decomposed", "keep-flat"],
      description: "Use decomposed when one or more nodes open a populated detail flow. Use keep-flat only when the assessed nodes are genuinely peer-level leaves."
    },
    candidateNodeIds: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description: "Root-node ids explicitly considered as possible Open details parents."
    },
    rationale: {
      type: "string",
      minLength: 80,
      description: "Semantic explanation of why detail decomposition improves the graph or why a flat peer-level canvas is clearer."
    }
  }
};

function parsePicassoTask(input: unknown): PicassoTask {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const normalizedRecord: Record<string, unknown> = {
    ...record,
    constraints: normalizePicassoStringList(record.constraints)
  };
  const legacyReconciliation = !("objective" in normalizedRecord) && (
    normalizedRecord.mode === "reconcile" ||
    (!("mode" in normalizedRecord) && Array.isArray(normalizedRecord.resolvedFiles) && normalizedRecord.resolvedFiles.length > 0)
  );
  if (legacyReconciliation) return graphReconciliationInputSchema.parse(normalizedRecord);
  return picassoGraphInputSchema.parse({
    ...normalizedRecord,
    mode: typeof normalizedRecord.mode === "string" ? normalizedRecord.mode : "refine"
  });
}

function projectPicassoCheckpoint(context: MicroRunContext, acceptedOperations: ResearchGraphOperation[]): {
  project: MicroRunContext["bundle"]["project"];
  flows: Flow[];
} {
  const project = structuredClone(context.bundle.project);
  const flows = structuredClone(context.bundle.flows);
  const flowFor = (flowId: string): Flow | undefined => flows.find((flow) => flow.id === flowId);

  for (let operationIndex = 0; operationIndex < acceptedOperations.length; operationIndex += 1) {
    const operation = acceptedOperations[operationIndex];
    if (operation.kind === "update-project") {
      Object.assign(project, operation.patch);
      continue;
    }
    if (operation.kind === "create-flow") {
      if (!flowFor(operation.flow.id)) flows.push(structuredClone(operation.flow));
      continue;
    }
    const flowId = operationFlowId(operation);
    const flow = flowId ? flowFor(flowId) : undefined;
    if (!flow) continue;

    if (operation.kind === "update-flow") {
      Object.assign(flow, operation.patch);
    } else if (operation.kind === "create-node" && operation.node.id) {
      const { position, positionHint: _positionHint, ...node } = operation.node;
      const projectedPosition = position && "x" in position
        ? position
        : { x: 120 + flow.nodes.length * 36, y: 120 + flow.nodes.length * 28 };
      if (!flow.nodes.some((item) => item.id === operation.node.id)) {
        flow.nodes.push({ ...node, id: operation.node.id, position: projectedPosition, updatedAt: "" } as ArchicodeNode);
      }
    } else if (operation.kind === "update-node") {
      const node = flow.nodes.find((item) => item.id === operation.patch.id);
      if (node) {
        const { id: _id, ...patch } = operation.patch;
        Object.assign(node, patch);
      }
    } else if (operation.kind === "delete-node") {
      flow.nodes = flow.nodes.filter((node) => node.id !== operation.nodeId);
      flow.edges = flow.edges.filter((edge) => edge.source !== operation.nodeId && edge.target !== operation.nodeId);
      for (const subflow of flow.subflows) {
        if (subflow.parentNodeId === operation.nodeId) delete subflow.parentNodeId;
      }
    } else if (operation.kind === "create-edge") {
      const edgeId = operation.edge.id ?? `checkpoint-edge-${operationIndex + 1}`;
      if (!flow.edges.some((edge) => edge.id === edgeId)) {
        flow.edges.push({ ...operation.edge, id: edgeId } as FlowEdge);
      }
    } else if (operation.kind === "update-edge") {
      const edge = flow.edges.find((item) => item.id === operation.edgeId);
      if (edge) Object.assign(edge, operation.patch);
    } else if (operation.kind === "delete-edge") {
      flow.edges = flow.edges.filter((edge) => edge.id !== operation.edgeId);
    } else if (operation.kind === "create-subflow" && operation.subflow.id) {
      if (!flow.subflows.some((subflow) => subflow.id === operation.subflow.id)) {
        flow.subflows.push(structuredClone(operation.subflow) as FlowSubflow);
      }
    } else if (operation.kind === "update-subflow") {
      const subflow = flow.subflows.find((item) => item.id === operation.subflowId);
      if (subflow) Object.assign(subflow, operation.patch);
    } else if (operation.kind === "link-node-subflow") {
      for (const subflow of flow.subflows) {
        if (subflow.parentNodeId === operation.nodeId) delete subflow.parentNodeId;
      }
      if (operation.subflowId) {
        const subflow = flow.subflows.find((item) => item.id === operation.subflowId);
        if (subflow) subflow.parentNodeId = operation.nodeId;
      }
    } else if (operation.kind === "delete-subflow") {
      flow.subflows = flow.subflows.filter((subflow) => subflow.id !== operation.subflowId);
      flow.nodes = flow.nodes.map((node) => node.subflowId === operation.subflowId
        ? { ...node, subflowId: undefined }
        : node);
    } else if (operation.kind === "create-group" && operation.group.id) {
      if (!flow.groups.some((group) => group.id === operation.group.id)) {
        flow.groups.push(structuredClone(operation.group) as FlowGroup);
      }
    } else if (operation.kind === "update-group") {
      const group = flow.groups.find((item) => item.id === operation.groupId);
      if (group) Object.assign(group, operation.patch);
    } else if (operation.kind === "delete-group") {
      flow.groups = flow.groups.filter((group) => group.id !== operation.groupId);
      flow.nodes = flow.nodes.map((node) => node.groupId === operation.groupId
        ? { ...node, groupId: undefined }
        : node);
    }
  }
  return { project, flows };
}

function graphScope(
  context: MicroRunContext,
  input: PicassoTask,
  acceptedOperations: ResearchGraphOperation[] = [],
  acceptedBatchCount = 0
): unknown {
  const flowId = input.scope?.flowId;
  const nodeIds = new Set(input.scope?.nodeIds ?? []);
  for (const operation of acceptedOperations) {
    if (operation.kind === "create-node" && operation.node.id && (!flowId || operation.flowId === flowId)) {
      nodeIds.add(operation.node.id);
    }
  }
  const projected = projectPicassoCheckpoint(context, acceptedOperations);
  const flows = projected.flows
    .filter((flow) => !flowId || flow.id === flowId)
    .map((flow) => ({
      ...flow,
      nodes: nodeIds.size ? flow.nodes.filter((node) => nodeIds.has(node.id)) : flow.nodes,
      edges: nodeIds.size
        ? flow.edges.filter((edge) => nodeIds.has(edge.source) || nodeIds.has(edge.target))
        : flow.edges
    }));
  return {
    project: {
      id: projected.project.id,
      name: projected.project.name,
      description: projected.project.description
    },
    flows,
    checkpoint: {
      state: acceptedOperations.length ? "staged-not-applied" : "base-graph",
      acceptedBatches: acceptedBatchCount,
      acceptedOperations: acceptedOperations.length,
      instruction: acceptedOperations.length
        ? "This projected graph includes every accepted Picasso batch from this run. Do not recreate or replace this staged work; continue only with the remaining scope. Nothing is persisted until the user approves the assembled review card."
        : "This is the persisted base graph. Later reads in this run will include accepted Picasso batches as a staged projection."
    }
  };
}

function boundedPicassoError(error: unknown, maxLength = 900): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return message.length <= maxLength ? message : `${message.slice(0, maxLength - 1)}…`;
}

function operationFlowId(operation: ResearchGraphOperation): string | undefined {
  if ("flowId" in operation && typeof operation.flowId === "string") return operation.flowId;
  if (operation.kind === "add-note") return operation.note.flowId;
  return undefined;
}

function operationIdentity(operation: ResearchGraphOperation): string | undefined {
  const record = operation as unknown as Record<string, unknown>;
  const nested = (key: string): Record<string, unknown> | null => recordValue(record[key]);
  if (operation.kind === "update-project") return "update-project";
  if (operation.kind === "create-flow") return `create-flow:${operation.flow.id}`;
  if (operation.kind === "update-flow") return `update-flow:${operation.flowId}`;
  if (operation.kind === "create-node") return operation.node.id ? `create-node:${operation.flowId}:${operation.node.id}` : undefined;
  if (operation.kind === "update-node") return `update-node:${operation.flowId}:${operation.patch.id}`;
  if (operation.kind === "create-edge") return `create-edge:${operation.flowId}:${operation.edge.id ?? `${operation.edge.source}->${operation.edge.target}`}`;
  if (operation.kind === "update-edge" || operation.kind === "delete-edge") return `${operation.kind}:${operation.flowId}:${operation.edgeId}`;
  if (operation.kind === "add-note") return `add-note:${operation.note.flowId}:${operation.note.nodeId}:${operation.note.body}`;
  if (operation.kind === "resolve-note" || operation.kind === "delete-note") return `${operation.kind}:${operation.noteId}`;
  if (operation.kind === "create-subflow") return operation.subflow.id ? `create-subflow:${operation.flowId}:${operation.subflow.id}` : undefined;
  if (operation.kind === "create-group") return operation.group.id ? `create-group:${operation.flowId}:${operation.group.id}` : undefined;
  if (operation.kind === "update-group" || operation.kind === "delete-group") return `${operation.kind}:${operation.flowId}:${operation.groupId}`;
  if (operation.kind === "update-subflow" || operation.kind === "delete-subflow") return `${operation.kind}:${operation.flowId}:${operation.subflowId}`;
  if (operation.kind === "link-node-subflow") return `${operation.kind}:${operation.flowId}:${operation.nodeId}`;
  if (operation.kind === "delete-node") return `${operation.kind}:${operation.flowId}:${operation.nodeId}`;
  const id = nested("node")?.id ?? nested("edge")?.id ?? nested("subflow")?.id ?? nested("group")?.id;
  return typeof id === "string" ? `${operation.kind}:${operationFlowId(operation) ?? "global"}:${id}` : undefined;
}

function validatePicassoBatchNodeQuality(operations: ResearchGraphOperation[]): string[] {
  const errors: string[] = [];
  const createdNodes: Array<{
    flowId: string;
    node: {
      id?: string;
      type: string;
      title: string;
      description: string;
      visual: { shape?: string; backgroundColor?: string };
      techStack: string[];
      acceptanceCriteria: string[];
    };
  }> = [];
  for (const operation of operations) {
    if (operation.kind === "create-node") createdNodes.push({ flowId: operation.flowId, node: operation.node });
    if (operation.kind === "create-flow") {
      createdNodes.push(...operation.flow.nodes.map((node) => ({ flowId: operation.flow.id, node })));
      const description = operation.flow.description.trim();
      if (description.length < PICASSO_MIN_FLOW_DESCRIPTION_CHARS) {
        errors.push(`create-flow ${operation.flow.id} needs a useful multi-sentence description of at least ${PICASSO_MIN_FLOW_DESCRIPTION_CHARS} characters; received ${description.length}.`);
      }
    }
    if (operation.kind === "update-flow" && typeof operation.patch.description === "string") {
      const description = operation.patch.description.trim();
      if (description.length < PICASSO_MIN_FLOW_DESCRIPTION_CHARS) {
        errors.push(`update-flow ${operation.flowId} description must be at least ${PICASSO_MIN_FLOW_DESCRIPTION_CHARS} characters when supplied; received ${description.length}.`);
      }
    }
    if (operation.kind === "create-edge" && !operation.edge.label?.trim()) {
      errors.push(`create-edge ${operation.edge.source} -> ${operation.edge.target} must have a short semantic relationship label.`);
    }
  }
  for (const { flowId, node } of createdNodes) {
    const label = `create-node ${node.id ?? node.title} in ${flowId}`;
    if (!node.id?.trim()) {
      errors.push(`${label} must provide a stable id so later batches can connect it with create-edge operations.`);
    }
    const description = node.description.trim();
    if (description.length < PICASSO_MIN_NODE_DESCRIPTION_CHARS) {
      errors.push(`${label} needs a substantial 2-4 sentence description of at least ${PICASSO_MIN_NODE_DESCRIPTION_CHARS} characters; received ${description.length}.`);
    }
    if (!node.techStack.length) {
      errors.push(`${label} must populate techStack with relevant technologies, protocols, platforms, standards, or an explicit pending technology decision.`);
    }
    if (node.acceptanceCriteria.length < 2) {
      errors.push(`${label} must include at least 2 specific acceptance criteria.`);
    }
    if (!node.visual.shape || !node.visual.backgroundColor) {
      errors.push(`${label} must define both visual.shape and visual.backgroundColor so its role and domain are visible on the canvas.`);
    }
  }
  if (createdNodes.length >= 4) {
    const semanticTypes = new Set(createdNodes.map(({ node }) => node.type.trim().toLowerCase()));
    const genericTypes = new Set(["feature", "node", "item", "task"]);
    if (semanticTypes.size < 2 || [...semanticTypes].every((type) => genericTypes.has(type))) {
      errors.push(`This batch creates ${createdNodes.length} nodes but does not use a meaningful mix of semantic node types. Classify architectural roles such as actor, screen, workflow, service, api, data-store, integration, policy, security-control, infrastructure, or quality-gate instead of defaulting everything to feature/task.`);
    }
  }
  return errors;
}

function validatePicassoProposalQuality(
  context: MicroRunContext,
  operations: ResearchGraphOperation[],
  detailFlowAssessments: PicassoDetailFlowAssessment[] = []
): string[] {
  const errors: string[] = [];
  const nodeScopesByFlow = new Map<string, Map<string, string | null>>();
  const adjacencyByFlow = new Map<string, Map<string, Set<string>>>();
  const createdNodeIdsByScope = new Map<string, Set<string>>();
  const createdNodeTypesByFlow = new Map<string, Map<string, string>>();
  const scopeKey = (flowId: string, subflowId: string | null): string => `${flowId}\u0000${subflowId ?? "~root"}`;
  const ensureAdjacency = (flowId: string, nodeId: string): Set<string> => {
    const byNode = adjacencyByFlow.get(flowId) ?? new Map<string, Set<string>>();
    adjacencyByFlow.set(flowId, byNode);
    const neighbors = byNode.get(nodeId) ?? new Set<string>();
    byNode.set(nodeId, neighbors);
    return neighbors;
  };
  const addNode = (flowId: string, nodeId: string, subflowId: string | null, created: boolean, type: string): void => {
    const scopes = nodeScopesByFlow.get(flowId) ?? new Map<string, string | null>();
    scopes.set(nodeId, subflowId);
    nodeScopesByFlow.set(flowId, scopes);
    ensureAdjacency(flowId, nodeId);
    if (!created) return;
    const key = scopeKey(flowId, subflowId);
    const ids = createdNodeIdsByScope.get(key) ?? new Set<string>();
    ids.add(nodeId);
    createdNodeIdsByScope.set(key, ids);
    const types = createdNodeTypesByFlow.get(flowId) ?? new Map<string, string>();
    types.set(nodeId, type);
    createdNodeTypesByFlow.set(flowId, types);
  };
  const addEdge = (flowId: string, source: string, target: string): void => {
    ensureAdjacency(flowId, source).add(target);
    ensureAdjacency(flowId, target).add(source);
  };

  for (const flow of context.bundle.flows) {
    for (const node of flow.nodes) addNode(flow.id, node.id, node.subflowId ?? null, false, node.type);
    for (const edge of flow.edges) addEdge(flow.id, edge.source, edge.target);
  }
  for (const operation of operations) {
    if (operation.kind === "create-flow") {
      for (const node of operation.flow.nodes) addNode(operation.flow.id, node.id, node.subflowId ?? null, true, node.type);
      for (const edge of operation.flow.edges) addEdge(operation.flow.id, edge.source, edge.target);
    } else if (operation.kind === "create-node" && operation.node.id) {
      addNode(operation.flowId, operation.node.id, operation.node.subflowId ?? null, true, operation.node.type);
    } else if (operation.kind === "update-node" && typeof operation.patch.type === "string") {
      createdNodeTypesByFlow.get(operation.flowId)?.set(operation.patch.id, operation.patch.type);
    } else if (operation.kind === "create-edge") {
      addEdge(operation.flowId, operation.edge.source, operation.edge.target);
    }
  }

  for (const [key, createdIds] of createdNodeIdsByScope.entries()) {
    if (createdIds.size < 2) continue;
    const [flowId, rawSubflowId] = key.split("\u0000");
    const subflowLabel = rawSubflowId === "~root" ? "root canvas" : `subflow ${rawSubflowId}`;
    const adjacency = adjacencyByFlow.get(flowId) ?? new Map<string, Set<string>>();
    const isolated = [...createdIds].filter((nodeId) => !(adjacency.get(nodeId)?.size));
    if (isolated.length) {
      errors.push(`${flowId} ${subflowLabel} leaves ${isolated.length} new node${isolated.length === 1 ? "" : "s"} without any logical edge (${isolated.slice(0, 4).join(", ")}${isolated.length > 4 ? ", …" : ""}). Every new node in a multi-node scope must participate in the topology.`);
      continue;
    }
    const first = [...createdIds][0];
    const visited = new Set<string>([first]);
    const pending = [first];
    while (pending.length) {
      const current = pending.shift() as string;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    const disconnected = [...createdIds].filter((nodeId) => !visited.has(nodeId));
    if (disconnected.length) {
      errors.push(`${flowId} ${subflowLabel} has disconnected new-node islands. Add meaningful labeled edges so the generated architecture is one navigable topology.`);
    }
  }

  const genericTypes = new Set(["feature", "node", "item", "task"]);
  for (const [flowId, typesByNode] of createdNodeTypesByFlow.entries()) {
    if (typesByNode.size < 4) continue;
    const semanticTypes = new Set([...typesByNode.values()].map((type) => type.trim().toLowerCase()));
    if (semanticTypes.size < 2 || [...semanticTypes].every((type) => genericTypes.has(type))) {
      errors.push(`${flowId} uses only generic node types for ${typesByNode.size} new nodes. Update the nodes with varied semantic architectural types before final assembly.`);
    }
  }

  const detailChildCounts = new Map<string, number>();
  const detailParentNodeIds = new Map<string, Set<string>>();
  const createdDetailKeys = new Set<string>();
  const affectedDetailKeys = new Set<string>();
  const detailKey = (flowId: string, subflowId: string): string => `${flowId}\u0000${subflowId}`;
  const addDetailParent = (flowId: string, subflowId: string, nodeId: string): void => {
    const key = detailKey(flowId, subflowId);
    const parents = detailParentNodeIds.get(key) ?? new Set<string>();
    parents.add(nodeId);
    detailParentNodeIds.set(key, parents);
  };
  for (const flow of context.bundle.flows) {
    for (const subflow of flow.subflows) {
      const key = detailKey(flow.id, subflow.id);
      detailChildCounts.set(key, flow.nodes.filter((node) => node.subflowId === subflow.id).length);
      if (subflow.parentNodeId) addDetailParent(flow.id, subflow.id, subflow.parentNodeId);
    }
  }
  for (const operation of operations) {
    if (operation.kind === "create-subflow" && operation.subflow.id) {
      const key = detailKey(operation.flowId, operation.subflow.id);
      createdDetailKeys.add(key);
      affectedDetailKeys.add(key);
      if (operation.subflow.parentNodeId) addDetailParent(operation.flowId, operation.subflow.id, operation.subflow.parentNodeId);
    } else if (operation.kind === "link-node-subflow" && operation.subflowId) {
      const key = detailKey(operation.flowId, operation.subflowId);
      affectedDetailKeys.add(key);
      addDetailParent(operation.flowId, operation.subflowId, operation.nodeId);
    } else if (operation.kind === "create-node" && operation.node.subflowId) {
      const key = detailKey(operation.flowId, operation.node.subflowId);
      detailChildCounts.set(key, (detailChildCounts.get(key) ?? 0) + 1);
    }
  }

  const validDetailKeys = new Set<string>();
  for (const key of affectedDetailKeys) {
    const [flowId, subflowId] = key.split("\u0000");
    const parentCount = detailParentNodeIds.get(key)?.size ?? 0;
    const childCount = detailChildCounts.get(key) ?? 0;
    if (createdDetailKeys.has(key) && parentCount === 0) {
      errors.push(`${flowId} detail flow ${subflowId} is not connected to any node's Open details field. Set create-subflow.parentNodeId and submit link-node-subflow for the chosen parent node.`);
    }
    if (createdDetailKeys.has(key) && childCount < 2) {
      errors.push(`${flowId} detail flow ${subflowId} has only ${childCount} child node${childCount === 1 ? "" : "s"}. A generated Open details flow must contain at least two meaningful child nodes rather than an empty or token drill-down.`);
    }
    if (parentCount > 0 && childCount >= 2) validDetailKeys.add(key);
  }

  const assessmentsByFlow = new Map(detailFlowAssessments.map((assessment) => [assessment.flowId, assessment]));
  for (const [key, rootNodeIds] of createdNodeIdsByScope.entries()) {
    const [flowId, rawSubflowId] = key.split("\u0000");
    if (rawSubflowId !== "~root" || rootNodeIds.size < PICASSO_SUBSTANTIAL_ROOT_NODE_COUNT) continue;
    const assessment = assessmentsByFlow.get(flowId);
    if (!assessment) {
      errors.push(`${flowId} creates ${rootNodeIds.size} root nodes but omitted detailFlowAssessments. Picasso must explicitly decide which substantial nodes should open populated detail flows, or justify why this flow is clearer as peer-level leaves.`);
      continue;
    }
    if (assessment.rationale.trim().length < 80) {
      errors.push(`${flowId} detail-flow assessment rationale must be at least 80 characters and explain the semantic decomposition decision.`);
    }
    if (!assessment.candidateNodeIds.length || !assessment.candidateNodeIds.some((nodeId) => rootNodeIds.has(nodeId))) {
      errors.push(`${flowId} detail-flow assessment must identify at least one generated root node that was genuinely considered for Open details.`);
    }
    const hasValidDetailFlow = [...validDetailKeys].some((detailFlowKey) => detailFlowKey.startsWith(`${flowId}\u0000`));
    if (assessment.decision === "decomposed" && !hasValidDetailFlow) {
      errors.push(`${flowId} says it was decomposed but no affected detail flow is both linked to a parent node and populated with at least two child nodes.`);
    }
    if (assessment.decision === "keep-flat" && hasValidDetailFlow) {
      errors.push(`${flowId} reports keep-flat even though the proposal creates or links a populated detail flow. Mark the assessment decomposed so the review record matches the graph design.`);
    }
  }
  return errors;
}

function validatePicassoBatchReferences(
  context: MicroRunContext,
  acceptedOperations: ResearchGraphOperation[],
  batchOperations: ResearchGraphOperation[]
): string[] {
  const errors: string[] = [];
  const nodeIdsByFlow = new Map(context.bundle.flows.map((flow) => [flow.id, new Set(flow.nodes.map((node) => node.id))]));
  const nodeScopesByFlow = new Map(context.bundle.flows.map((flow) => [
    flow.id,
    new Map(flow.nodes.map((node) => [node.id, node.subflowId ?? null]))
  ]));
  const subflowIdsByFlow = new Map(context.bundle.flows.map((flow) => [flow.id, new Set(flow.subflows.map((subflow) => subflow.id))]));
  const existingEdgesByFlow = new Map(context.bundle.flows.map((flow) => [flow.id, new Set(flow.edges.map((edge) => `${edge.source}->${edge.target}`))]));

  for (const operation of [...acceptedOperations, ...batchOperations]) {
    if (operation.kind !== "create-flow") continue;
    if (nodeIdsByFlow.has(operation.flow.id)) {
      if (batchOperations.includes(operation)) errors.push(`create-flow ${operation.flow.id} duplicates an existing or already submitted flow.`);
      continue;
    }
    nodeIdsByFlow.set(operation.flow.id, new Set(operation.flow.nodes.map((node) => node.id)));
    nodeScopesByFlow.set(operation.flow.id, new Map(operation.flow.nodes.map((node) => [node.id, node.subflowId ?? null])));
    subflowIdsByFlow.set(operation.flow.id, new Set(operation.flow.subflows.map((subflow) => subflow.id)));
    existingEdgesByFlow.set(operation.flow.id, new Set(operation.flow.edges.map((edge) => `${edge.source}->${edge.target}`)));
  }

  for (const operation of [...acceptedOperations, ...batchOperations]) {
    if (operation.kind !== "create-subflow" || !operation.subflow.id) continue;
    const subflowIds = subflowIdsByFlow.get(operation.flowId);
    if (!subflowIds) {
      if (batchOperations.includes(operation)) errors.push(`create-subflow ${operation.subflow.id} targets unknown flow ${operation.flowId}.`);
      continue;
    }
    if (subflowIds.has(operation.subflow.id)) {
      if (batchOperations.includes(operation)) errors.push(`create-subflow ${operation.subflow.id} duplicates a detail flow already present or submitted in ${operation.flowId}.`);
      continue;
    }
    subflowIds.add(operation.subflow.id);
  }

  for (const operation of [...acceptedOperations, ...batchOperations]) {
    if (operation.kind !== "create-node") continue;
    const nodeIds = nodeIdsByFlow.get(operation.flowId);
    if (!nodeIds) {
      if (batchOperations.includes(operation)) errors.push(`create-node ${operation.node.id ?? operation.node.title} targets unknown flow ${operation.flowId}. Submit/create the flow first.`);
      continue;
    }
    if (!operation.node.id) continue;
    if (nodeIds.has(operation.node.id)) {
      if (batchOperations.includes(operation)) errors.push(`create-node ${operation.node.id} duplicates a node already present or submitted in flow ${operation.flowId}.`);
      continue;
    }
    nodeIds.add(operation.node.id);
    if (operation.node.subflowId && !subflowIdsByFlow.get(operation.flowId)?.has(operation.node.subflowId)) {
      if (batchOperations.includes(operation)) errors.push(`create-node ${operation.node.id} targets unknown detail flow ${operation.node.subflowId} in ${operation.flowId}. Create the subflow first or in the same proposal.`);
    }
    const nodeScopes = nodeScopesByFlow.get(operation.flowId) ?? new Map<string, string | null>();
    nodeScopes.set(operation.node.id, operation.node.subflowId ?? null);
    nodeScopesByFlow.set(operation.flowId, nodeScopes);
  }

  const priorIdentities = new Set(acceptedOperations.map(operationIdentity).filter((value): value is string => Boolean(value)));
  const batchIdentities = new Set<string>();
  for (const operation of batchOperations) {
    const flowId = operationFlowId(operation);
    if (flowId && !nodeIdsByFlow.has(flowId)) {
      errors.push(`${operation.kind} targets unknown flow ${flowId}.`);
      continue;
    }
    const identity = operationIdentity(operation);
    if (identity && (priorIdentities.has(identity) || batchIdentities.has(identity))) {
      errors.push(`${operation.kind} repeats an operation target already submitted (${identity}). Do not replay completed batches.`);
    }
    if (identity) batchIdentities.add(identity);
    if (operation.kind === "create-subflow") {
      const nodeIds = nodeIdsByFlow.get(operation.flowId);
      const subflowIds = subflowIdsByFlow.get(operation.flowId);
      if (operation.subflow.parentNodeId && !nodeIds?.has(operation.subflow.parentNodeId)) {
        errors.push(`create-subflow ${operation.subflow.id ?? operation.subflow.name} parentNodeId ${operation.subflow.parentNodeId} was not found in ${operation.flowId}.`);
      }
      if (operation.subflow.parentSubflowId && !subflowIds?.has(operation.subflow.parentSubflowId)) {
        errors.push(`create-subflow ${operation.subflow.id ?? operation.subflow.name} parentSubflowId ${operation.subflow.parentSubflowId} was not found in ${operation.flowId}.`);
      }
    }
    if (operation.kind === "link-node-subflow") {
      if (!nodeIdsByFlow.get(operation.flowId)?.has(operation.nodeId)) {
        errors.push(`link-node-subflow node ${operation.nodeId} was not found in ${operation.flowId}.`);
      }
      if (operation.subflowId && !subflowIdsByFlow.get(operation.flowId)?.has(operation.subflowId)) {
        errors.push(`link-node-subflow target ${operation.subflowId} was not found in ${operation.flowId}.`);
      }
    }
    if (operation.kind === "create-edge") {
      const nodeIds = nodeIdsByFlow.get(operation.flowId);
      if (!nodeIds?.has(operation.edge.source) || !nodeIds.has(operation.edge.target)) {
        errors.push(`create-edge ${operation.edge.source} -> ${operation.edge.target} must connect two nodes in the same top-level flow ${operation.flowId}. Cross-flow edges are not supported; capture that dependency in descriptions, acceptance criteria, or a node-scoped note.`);
      } else {
        const scopes = nodeScopesByFlow.get(operation.flowId);
        if ((scopes?.get(operation.edge.source) ?? null) !== (scopes?.get(operation.edge.target) ?? null)) {
          errors.push(`create-edge ${operation.edge.source} -> ${operation.edge.target} crosses root/detail canvas scopes inside ${operation.flowId}. Both endpoints must belong to the same root canvas or the same subflow so the relationship remains visible.`);
          continue;
        }
        const edgeKey = `${operation.edge.source}->${operation.edge.target}`;
        const existingEdges = existingEdgesByFlow.get(operation.flowId) ?? new Set<string>();
        if (existingEdges.has(edgeKey)) errors.push(`create-edge ${edgeKey} already exists in flow ${operation.flowId}.`);
        existingEdges.add(edgeKey);
        existingEdgesByFlow.set(operation.flowId, existingEdges);
      }
    }
    if (operation.kind === "add-note") {
      const nodeIds = nodeIdsByFlow.get(operation.note.flowId);
      if (!nodeIds?.has(operation.note.nodeId)) errors.push(`add-note must target an existing or already submitted node in flow ${operation.note.flowId}; node ${operation.note.nodeId} was not found.`);
    }
  }
  return [...new Set(errors)];
}

function validatePicassoBatch(
  args: { summary: string; operations: unknown[] },
  task: PicassoTask,
  context: MicroRunContext,
  acceptedOperations: ResearchGraphOperation[]
): ResearchGraphOperation[] {
  const visualShapeRepairCount = args.operations.reduce<number>((count, operation) => count + countPicassoVisualShapeRepairs(operation), 0);
  const normalizedOperations = args.operations.map((operation) => normalizePicassoGraphOperation(operation, task.scope?.flowId));
  const validated = researchGraphChangeSetSchema.omit({ id: true, createdAt: true }).safeParse({
    summary: args.summary,
    operations: normalizedOperations
  });
  if (!validated.success) {
    const issues = validated.error.issues.slice(0, 10).map((issue) => `${issue.path.join(".")} ${issue.message}`).join(" | ");
    throw new Error(`Batch rejected before assembly: ${issues}. Correct and resubmit only this batch; no operations from it were accepted.`);
  }
  const qualityErrors = validatePicassoBatchNodeQuality(validated.data.operations);
  if (qualityErrors.length) {
    throw new Error(`Batch rejected before assembly: ${qualityErrors.slice(0, 8).join(" ")} Correct and resubmit only this batch; no operations from it were accepted.`);
  }
  const referenceErrors = validatePicassoBatchReferences(context, acceptedOperations, validated.data.operations);
  if (referenceErrors.length) {
    throw new Error(`Batch rejected before assembly: ${referenceErrors.slice(0, 8).join(" ")} Correct and resubmit only this batch; no operations from it were accepted.`);
  }
  if (visualShapeRepairCount) {
    context.onProgress?.(`Normalized ${visualShapeRepairCount} safe visual-shape ${visualShapeRepairCount === 1 ? "alias" : "aliases"} in graph batch “${args.summary}”; semantic node types were preserved`);
  }
  // executeMicroRun records the post-handler arguments. Mutating this parsed
  // object makes the assembled card use the same normalized payload that was
  // actually validated here.
  args.operations = validated.data.operations;
  return validated.data.operations;
}

function normalizePicassoDetailFlowAssessments(value: unknown): PicassoDetailFlowAssessment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordValue(item);
    if (
      !record ||
      typeof record.flowId !== "string" ||
      (record.decision !== "decomposed" && record.decision !== "keep-flat") ||
      !Array.isArray(record.candidateNodeIds) ||
      typeof record.rationale !== "string"
    ) return [];
    return [{
      flowId: record.flowId,
      decision: record.decision,
      candidateNodeIds: record.candidateNodeIds.filter((nodeId): nodeId is string => typeof nodeId === "string"),
      rationale: record.rationale
    }];
  });
}

function tools(context: MicroRunContext, input: unknown): MicroRunTool[] {
  const task = parsePicassoTask(input);
  const acceptedOperations: ResearchGraphOperation[] = [];
  let acceptedBatchCount = 0;
  const getGraph: MicroRunTool = {
    providerToolName: "picasso_read_graph",
    serverId: "archicode-subagents",
    serverLabel: "Picasso",
    toolName: "read_graph",
    description: "Read Picasso's current projected graph within the assigned scope. After a batch is accepted, later reads include that staged checkpoint even though nothing is persisted until the user approves the final review card.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    handler: async () => {
      const selectedNodeCount = task.scope?.nodeIds?.length ?? 0;
      const checkpoint = acceptedBatchCount
        ? ` with staged checkpoint B${acceptedBatchCount} (${acceptedOperations.length} accepted operation${acceptedOperations.length === 1 ? "" : "s"})`
        : "";
      context.onProgress?.(`Reading graph scope${task.scope?.flowId ? ` for flow ${task.scope.flowId}` : " for the project"}${selectedNodeCount ? ` (${selectedNodeCount} selected node${selectedNodeCount === 1 ? "" : "s"})` : ""}${checkpoint}`);
      return graphScope(context, task, acceptedOperations, acceptedBatchCount);
    }
  };
  const proposeChangeSet: MicroRunTool = {
    providerToolName: "propose_graph_change_set",
    serverId: "archicode-subagents",
    serverLabel: "Picasso",
    toolName: "propose_graph_change_set",
    description: `Submit Picasso's final graph batch and finish the pending proposal. For a proposal larger than ${PICASSO_BATCH_MAX_OPERATIONS} operations, submit all earlier batches through picasso_submit_graph_batch first. Include detailFlowAssessments for every generated flow with ${PICASSO_SUBSTANTIAL_ROOT_NODE_COUNT}+ root nodes. The harness assembles every batch into one review card. This never applies changes directly.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "operations"],
      properties: {
        summary: { type: "string" },
        operations: { type: "array", minItems: 1, maxItems: PICASSO_BATCH_MAX_OPERATIONS, items: picassoGraphOperationInputSchema },
        detailFlowAssessments: {
          type: "array",
          items: picassoDetailFlowAssessmentInputSchema,
          description: `Required by the harness for each generated flow with ${PICASSO_SUBSTANTIAL_ROOT_NODE_COUNT}+ root nodes. This records Picasso's semantic Open details decision without exposing its full private reasoning.`
        }
      }
    },
    handler: async (args: PicassoFinalBatchArgs) => {
      if (args.operations.length > PICASSO_BATCH_MAX_OPERATIONS) {
        throw new Error(`Picasso's final graph batch may contain at most ${PICASSO_BATCH_MAX_OPERATIONS} operations.`);
      }
      let operations: ResearchGraphOperation[];
      try {
        operations = validatePicassoBatch(args, task, context, acceptedOperations);
        const detailFlowAssessments = normalizePicassoDetailFlowAssessments(args.detailFlowAssessments);
        const proposalQualityErrors = validatePicassoProposalQuality(context, [...acceptedOperations, ...operations], detailFlowAssessments);
        if (proposalQualityErrors.length) {
          throw new Error(`Final graph quality check failed before assembly: ${proposalQualityErrors.slice(0, 8).join(" ")} Submit the missing update-node or create-edge operations in bounded batches, then retry the final batch.`);
        }
      } catch (error) {
        context.onProgress?.(`Rejected final graph batch “${args.summary}”: ${boundedPicassoError(error)} Picasso is correcting it before assembly`);
        throw error;
      }
      acceptedOperations.push(...operations);
      acceptedBatchCount += 1;
      context.onProgress?.(`Submitted final graph batch B${acceptedBatchCount} “${args.summary}” with ${operations.length} operation${operations.length === 1 ? "" : "s"}; assembling the review card`);
      return {
        acceptedForReview: true,
        checkpoint: { state: "staged-not-applied", acceptedBatches: acceptedBatchCount, acceptedOperations: acceptedOperations.length },
        ...args
      };
    }
  };
  const submitGraphBatch: MicroRunTool = {
    providerToolName: "picasso_submit_graph_batch",
    serverId: "archicode-subagents",
    serverLabel: "Picasso",
    toolName: "submit_graph_batch",
    description: `Submit one bounded, non-final graph-operation batch for harness assembly. Keep the batch coherent and at or below ${PICASSO_BATCH_MAX_OPERATIONS} operations—normally one flow or one tightly related graph region. Continue with the next batch after this tool returns.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "operations"],
      properties: {
        summary: { type: "string" },
        operations: { type: "array", minItems: 1, maxItems: PICASSO_BATCH_MAX_OPERATIONS, items: picassoGraphOperationInputSchema }
      }
    },
    handler: async (args: { summary: string; operations: unknown[] }) => {
      if (args.operations.length > PICASSO_BATCH_MAX_OPERATIONS) {
        throw new Error(`Picasso graph batches may contain at most ${PICASSO_BATCH_MAX_OPERATIONS} operations.`);
      }
      let operations: ResearchGraphOperation[];
      try {
        operations = validatePicassoBatch(args, task, context, acceptedOperations);
      } catch (error) {
        context.onProgress?.(`Rejected graph batch “${args.summary}”: ${boundedPicassoError(error)} Picasso is correcting and resubmitting only this batch`);
        throw error;
      }
      acceptedOperations.push(...operations);
      acceptedBatchCount += 1;
      context.onProgress?.(`Submitted graph batch B${acceptedBatchCount} “${args.summary}” with ${operations.length} operation${operations.length === 1 ? "" : "s"}; continuing with the remaining scope`);
      return {
        acceptedForAssembly: true,
        batchNumber: acceptedBatchCount,
        operationCount: operations.length,
        acceptedOperationCount: acceptedOperations.length,
        checkpointState: "staged-not-applied",
        instruction: "This batch is now present in picasso_read_graph. Do not recreate it; continue only with the remaining scope.",
        summary: args.summary
      };
    }
  };
  return [...createReadOnlyInvestigationTools(context, { includeWeb: false }), getGraph, submitGraphBatch, proposeChangeSet];
}

function systemPrompt(input: unknown): string {
  const task = parsePicassoTask(input);
  const assessmentOnly = task.mode === "assess";
  const legacyEvidence = task.resolvedFiles.length
    ? `Resolved files: ${task.resolvedFiles.join(", ")}. Resolution summary: ${task.resolutionSummary || "not provided"}. Verification: ${task.verificationResult || "not provided"}.`
    : "";
  return [
    "You are Picasso, ArchiCode's master graph architect and updater.",
    assessmentOnly
      ? "Work in a fresh isolated context. Read the assigned graph and relevant project evidence, then produce a rigorous assessment without editing or proposing changes."
      : "Work in a fresh isolated context. Read the graph and relevant project evidence, then design a coherent, detailed graph update for the assigned objective.",
    "The graph expresses user intent and architecture. Preserve stable node identities, existing decisions, useful notes, and meaningful relationships unless the objective requires changing them.",
    "Check descriptions, acceptance criteria, implementation scope hints, edges, subflows, positions, and neighboring responsibilities together instead of making isolated cosmetic edits.",
    assessmentOnly
      ? "This is assessment-only. Do not call propose_graph_change_set and omit graphChangeSet unless the caller explicitly requested graph edits. Put the complete findings and recommendations in designReport."
      : `The parent chat already confirmed this exact graph-edit scope. Do not ask for confirmation again. You must never apply graph operations. Build large proposals incrementally: submit coherent non-final batches through picasso_submit_graph_batch, keeping each batch at or below ${PICASSO_BATCH_MAX_OPERATIONS} operations, then submit the last bounded batch through propose_graph_change_set. The harness assembles every batch into one normal review card. Never one-shot a large multi-flow proposal in the final tool, and do not print the proposal as JSON or prose instead of calling the tools.`,
    "An accepted batch is a staged checkpoint for this Picasso run. Later picasso_read_graph calls project every accepted checkpoint into the returned graph and label it staged-not-applied. Treat that projected state as authoritative for the remaining work: never recreate, replace, or replay an accepted batch. If a batch is rejected, correct and resubmit only that rejected batch; accepted earlier batches remain intact.",
    "Every operation must use the exact Research graph-operation envelope: create-flow nests the complete top-level flow under flow; other flow-scoped operations include flowId; create-node nests fields under node; create-edge nests fields under edge; create-subflow nests fields under subflow; create-group nests fields under group; add-note nests fields under note; update operations nest changes under patch. Never flatten flow, node, edge, subflow, group, note, or patch fields onto the operation itself.",
    "Top-level flow deletion is not a supported review operation. Never emit delete-flow; leave an extra top-level flow unchanged and mention it in the visible report. Graph edges are strictly intra-flow: create-edge.flowId must name the one top-level flow containing both source and target nodes. Never model cross-flow dependencies as edges; record them in node/flow descriptions, acceptance criteria, or node-scoped notes instead.",
    "Every add-note operation must target a concrete node and use note: { flowId, nodeId, body, kind, author, ... }. Use kind: system-note and author: llm unless a more specific supported value is required. A flow-only note without nodeId is invalid.",
    "For a new top-level flow whose nodes should be auto-laid out, submit create-flow with flow.nodes/edges/subflows/groups as empty arrays and then submit create-node operations using the new flow id. Omit create-node.node.position when no coordinates were requested.",
    `A generated architecture must be richer than a flat checklist. Every new node needs: (1) a semantic architectural type chosen for its real role—not a blanket feature/task default; (2) a substantial 2-4 sentence description of at least ${PICASSO_MIN_NODE_DESCRIPTION_CHARS} characters, roughly twice a terse one-sentence summary, covering responsibility, interactions or inputs/outputs, and important constraints; (3) a populated techStack with 1-6 relevant technologies, protocols, platforms, standards, or an explicit pending technology decision; (4) at least two concrete acceptance criteria; and (5) visual.shape plus a consistent #RRGGBB visual.backgroundColor. node.type carries semantic roles such as workflow, service, screen, policy, and integration. visual.shape is geometry and must be exactly one of: ${PICASSO_VISUAL_SHAPES.join(", ")}. Never copy a semantic type such as workflow into visual.shape. Do not fabricate certainty: distinguish selected technology from a technology decision that remains pending.`,
    "Model the actual logical topology with labeled create-edge operations. In every multi-node root canvas or detail flow, connect every new node into a coherent navigable graph; do not leave a stack of isolated nodes. Edges must describe real relationships such as invokes, authenticates, reads/writes, publishes/subscribes, verifies, or governs. Submit node batches first when necessary, then one or more bounded edge batches. The harness lays nodes out by dependency depth once the card is applied, so meaningful edge direction directly controls multi-column placement.",
    `Give new and substantially renamed flows a useful multi-sentence description of at least ${PICASSO_MIN_FLOW_DESCRIPTION_CHARS} characters covering their boundary, primary actors/capabilities, and relationship to neighboring flows. Keep domain colors consistent within one flow while using shapes to distinguish roles—for example actor for people, database for stores, document for policies/content, hexagon for services/integrations, diamond for decisions/gates, cloud for external systems, and rounded/rectangle/capsule for screens, workflows, and components.`,
    `Perform a semantic Open details audit before final assembly. For each substantial root node, decide whether it is a high-level capability or façade whose internal workflow, components, states, policies, or integrations deserve a separate drill-down canvas. When decomposition improves comprehension, create a named detail flow, link it to the parent node, populate it with at least two rich child nodes, and connect those children with semantic edges. Keep genuine peer-level leaves flat; do not manufacture empty, one-node, repetitive, or universal detail flows. Every generated flow with ${PICASSO_SUBSTANTIAL_ROOT_NODE_COUNT}+ root nodes must include one detailFlowAssessments entry in the final tool call, listing the candidate parent nodes, decision (decomposed or keep-flat), and a concise semantic rationale of at least 80 characters. This is a decision record, not hidden chain-of-thought. Prefer useful drill-down when a root node bundles multiple independently understandable responsibilities.`,
    "When creating nodes inside a detail flow/subflow, every child create-node operation must keep flowId set to the containing top-level flow id (for example flow-main) and include node.subflowId set to the target subflow id. If you create the subflow in the same proposal, choose the subflow.id first and reuse that exact id in create-subflow.subflow.id, link-node-subflow.subflowId, and each child create-node.node.subflowId. Never put a subflow id in operation.flowId. flowId alone is not enough; nodes without node.subflowId are created on the root canvas.",
    "You must call picasso_read_graph before finalizing. If graph access fails, return JSON with status blocked and the exact concrete failures in blockers; never present an uninspected design as completed.",
    "Note pinning policy: use pinned: true for important decisions, unresolved risks, user-actionable follow-ups, or durable architectural context. Use pinned: false for traceability and routine bookkeeping. Never say a note is pinned unless the add-note operation sets pinned: true.",
    "Do not edit source files, settings, providers, or runs. Do not spawn another agent.",
    assessmentOnly
      ? "Return one JSON object with status, blockers, nodesAffected, designReport, assumptions, validationChecks, and openQuestions. Set status to completed only after the assessment is complete."
      : "Your required completion action is the propose_graph_change_set tool call containing only the final bounded batch. After that call, no duplicate JSON response is required.",
    `Mode: ${task.mode}. Detail level: ${task.detailLevel}.`,
    task.evidenceSummary ? `Caller evidence summary: ${task.evidenceSummary}` : "",
    legacyEvidence,
    task.constraints.length ? `Constraints: ${task.constraints.join("; ")}` : ""
  ].filter(Boolean).join("\n");
}

function validateOutput(output: unknown, toolCalls: MicroRunToolInvocation[], input: unknown): string | undefined {
  const task = parsePicassoTask(input);
  const result = output as PicassoGraphOutput;
  result.graphChangeSet = normalizePicassoGraphChangeSet(result.graphChangeSet, task);
  if (result.status === "blocked") {
    const blockerSummary = result.blockers.join("; ").trim() || result.designReport.trim();
    return `Picasso reported a graph-inspection blocker instead of completing the design: ${blockerSummary.slice(0, 500)}`;
  }
  if (result.blockers.length > 0) {
    return "Picasso returned blockers while marking the graph pass completed.";
  }
  if (!toolCalls.some((call) => call.providerToolName === "picasso_read_graph")) {
    return "Picasso completed without reading the assigned graph scope.";
  }
  const submittedFinalProposal = toolCalls.some((call) => call.succeeded !== false && (call.providerToolName === "propose_graph_change_set" || call.providerToolName === "picasso_propose_graph_change_set"));
  if (task.mode !== "assess" && task.mode !== "reconcile" && !submittedFinalProposal) {
    return "Picasso completed without submitting a reviewable graph change set through the final bounded graph batch.";
  }
  const operationCount = Array.isArray(result.graphChangeSet?.operations)
    ? result.graphChangeSet.operations.length
    : 0;
  if (task.mode !== "assess" && task.mode !== "reconcile" && operationCount === 0) {
    return "Picasso completed without submitting a reviewable graph change set.";
  }
  if (operationCount > 0) {
    const validated = researchGraphChangeSetSchema.omit({ id: true, createdAt: true }).safeParse(result.graphChangeSet);
    if (!validated.success) {
      return `Picasso submitted an invalid graph change set: ${validated.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join(" | ")}`;
    }
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function pickRecordFields(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => record[key] === undefined ? [] : [[key, record[key]]]));
}

const picassoVisualShapeSet = new Set<string>(PICASSO_VISUAL_SHAPES);
const picassoVisualShapeAliases: Record<string, PicassoVisualShape> = {
  workflow: "rounded",
  capability: "rounded",
  component: "rounded",
  feature: "rounded",
  screen: "rectangle",
  page: "rectangle",
  service: "hexagon",
  api: "hexagon",
  integration: "hexagon",
  "data-store": "database",
  datastore: "database",
  store: "database",
  policy: "document",
  "security-control": "diamond",
  "quality-gate": "diamond",
  decision: "diamond",
  "external-system": "cloud",
  infrastructure: "cloud"
};

function normalizedPicassoVisualShape(shape: unknown, nodeType: unknown): unknown {
  if (typeof shape !== "string") return shape;
  const normalized = shape.trim().toLowerCase();
  if (picassoVisualShapeSet.has(normalized)) return normalized;
  const normalizedType = typeof nodeType === "string" ? nodeType.trim().toLowerCase() : "";
  return picassoVisualShapeAliases[normalized] ?? picassoVisualShapeAliases[normalizedType] ?? "rounded";
}

function normalizePicassoNodeVisual(value: unknown): unknown {
  const node = recordValue(value);
  const visual = node ? recordValue(node.visual) : null;
  if (!node || !visual || visual.shape === undefined) return value;
  const shape = normalizedPicassoVisualShape(visual.shape, node.type);
  if (shape === visual.shape) return value;
  return { ...node, visual: { ...visual, shape } };
}

function countPicassoVisualShapeRepairs(value: unknown): number {
  const operation = recordValue(value);
  if (!operation) return 0;
  const nodeNeedsRepair = (nodeValue: unknown): number => {
    const node = recordValue(nodeValue);
    const visual = node ? recordValue(node.visual) : null;
    if (!node || !visual || visual.shape === undefined) return 0;
    return normalizedPicassoVisualShape(visual.shape, node.type) === visual.shape ? 0 : 1;
  };
  if (operation.kind === "create-node") return nodeNeedsRepair(recordValue(operation.node) ?? operation);
  if (operation.kind === "update-node") return nodeNeedsRepair(recordValue(operation.patch));
  if (operation.kind === "create-flow") {
    const flow = recordValue(operation.flow) ?? operation;
    return Array.isArray(flow.nodes) ? flow.nodes.reduce((count, node) => count + nodeNeedsRepair(node), 0) : 0;
  }
  return 0;
}

function normalizePicassoGraphOperation(value: unknown, defaultFlowId?: string): unknown {
  const operation = recordValue(value);
  if (!operation || typeof operation.kind !== "string") return value;
  const withFlow = defaultFlowId && operation.flowId === undefined ? { ...operation, flowId: defaultFlowId } : { ...operation };
  if (operation.kind === "create-flow") {
    const nested = recordValue(operation.flow);
    const candidate = nested ?? pickRecordFields(operation, [
      "id", "name", "description", "ignored", "evidenceBackbone", "perspective", "visual", "nodes", "edges", "subflows", "groups", "updatedAt"
    ]);
    return {
      kind: "create-flow",
      flow: {
        ...candidate,
        description: typeof candidate.description === "string" ? candidate.description : "",
        ignored: typeof candidate.ignored === "boolean" ? candidate.ignored : false,
        nodes: Array.isArray(candidate.nodes) ? candidate.nodes.map(normalizePicassoNodeVisual) : [],
        edges: Array.isArray(candidate.edges) ? candidate.edges : [],
        subflows: Array.isArray(candidate.subflows) ? candidate.subflows : [],
        groups: Array.isArray(candidate.groups) ? candidate.groups : [],
        updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : ""
      }
    };
  }
  if (operation.kind === "create-subflow" && !recordValue(operation.subflow)) {
    return { ...withFlow, subflow: pickRecordFields(operation, ["id", "name", "parentNodeId", "parentSubflowId", "ignored"]) };
  }
  if (operation.kind === "create-node" && !recordValue(operation.node)) {
    return {
      ...withFlow,
      node: normalizePicassoNodeVisual(pickRecordFields(operation, [
        "id", "type", "title", "description", "stage", "ignored", "flags", "locked", "visual", "position", "positionHint",
        "size", "parentId", "subflowId", "groupId", "techStack", "acceptanceCriteria", "acceptanceChecks",
        "implementationScope", "moduleProfileMode", "moduleProfileId", "customProperties", "ruleIds", "attachments", "todos"
      ]))
    };
  }
  if (operation.kind === "create-node" && recordValue(operation.node)) {
    return { ...withFlow, node: normalizePicassoNodeVisual(operation.node) };
  }
  if (operation.kind === "create-edge" && !recordValue(operation.edge)) {
    return { ...withFlow, edge: pickRecordFields(operation, ["id", "source", "target", "label"]) };
  }
  if (operation.kind === "create-group" && !recordValue(operation.group)) {
    return { ...withFlow, group: pickRecordFields(operation, ["id", "name", "color"]) };
  }
  if (operation.kind === "add-note" && recordValue(operation.note)) {
    const note = recordValue(operation.note)!;
    return {
      ...withFlow,
      note: {
        ...note,
        flowId: note.flowId ?? withFlow.flowId,
        nodeId: note.nodeId ?? operation.nodeId,
        kind: note.kind ?? "system-note",
        author: note.author ?? "llm"
      }
    };
  }
  if (operation.kind === "add-note" && !recordValue(operation.note)) {
    const noteKind = [operation.noteKind, operation.noteType, operation.type]
      .find((candidate) => typeof candidate === "string") as string | undefined;
    return {
      ...withFlow,
      note: {
        ...pickRecordFields(withFlow, ["flowId", "nodeId", "body", "category", "priority", "attachmentIds", "resolved", "pinned"]),
        kind: noteKind ?? "system-note",
        author: typeof operation.author === "string" ? operation.author : "llm"
      }
    };
  }
  if ((operation.kind === "update-project" || operation.kind === "update-node" || operation.kind === "update-flow" || operation.kind === "update-edge" || operation.kind === "update-group" || operation.kind === "update-subflow") && !recordValue(operation.patch)) {
    const controlKeys = new Set(["kind", "flowId", "nodeId", "edgeId", "groupId", "subflowId"]);
    const patch = Object.fromEntries(Object.entries(operation).filter(([key]) => !controlKeys.has(key)));
    return { ...withFlow, patch: operation.kind === "update-node" ? normalizePicassoNodeVisual(patch) : patch };
  }
  if (operation.kind === "update-node" && recordValue(operation.patch)) {
    return { ...withFlow, patch: normalizePicassoNodeVisual(operation.patch) };
  }
  return withFlow;
}

function normalizePicassoGraphChangeSet(value: unknown, task: PicassoTask): unknown {
  const changeSet = recordValue(value);
  if (!changeSet || !Array.isArray(changeSet.operations)) return value;
  return {
    ...changeSet,
    operations: changeSet.operations.map((operation) => normalizePicassoGraphOperation(operation, task.scope?.flowId))
  };
}

function userMessage(input: unknown): string {
  const task = parsePicassoTask(input);
  const objective = task.objective?.trim() || (task.resolvedFiles.length
    ? `Reconcile the graph after changes to ${task.resolvedFiles.join(", ")}.`
    : "Inspect the assigned graph scope and propose any necessary detailed updates.");
  if (task.mode === "assess") {
    return `Assess the assigned graph for this objective:\n\n${objective}\n\nStart by reading the graph, inspect relevant project evidence, and return a complete findings report. This is read-only analysis; do not submit graph operations.`;
  }
  return `Design the graph update for this objective:\n\n${objective}\n\nStart by reading the graph, inspect relevant project evidence, validate the complete design, and submit any operations for review.`;
}

function changeSetFromToolCalls(toolCalls?: MicroRunToolInvocation[]): { summary: string; operations: unknown[] } | undefined {
  if (!toolCalls?.length) return undefined;
  const operations: unknown[] = [];
  let finalSummary: string | undefined;
  let finalSubmitted = false;
  for (const call of toolCalls) {
    if (call.succeeded === false) continue;
    const isBatch = call.providerToolName === "picasso_submit_graph_batch";
    const isFinal = call.providerToolName === "propose_graph_change_set" || call.providerToolName === "picasso_propose_graph_change_set";
    if (!isBatch && !isFinal) continue;
    try {
      const args = JSON.parse(call.argumentsJson || "{}") as Record<string, unknown>;
      if (typeof args.summary === "string" && Array.isArray(args.operations)) {
        operations.push(...args.operations);
        if (isFinal) {
          finalSummary = args.summary;
          finalSubmitted = true;
        }
      }
    } catch {
      // Ignore a malformed batch; validation will reject a missing final proposal.
    }
  }
  return finalSubmitted && finalSummary && operations.length
    ? { summary: finalSummary, operations }
    : undefined;
}

function parseOutput(text: string, toolCalls?: MicroRunToolInvocation[]): PicassoGraphOutput {
  const parsed = extractJsonObject(text);
  const captured = changeSetFromToolCalls(toolCalls);
  const graphChangeSet = captured ?? (parsed.graphChangeSet && typeof parsed.graphChangeSet === "object"
    ? parsed.graphChangeSet
    : undefined);
  const designReport = typeof parsed.designReport === "string" && parsed.designReport.trim()
    ? parsed.designReport
    : typeof parsed.reconciliationReport === "string" && parsed.reconciliationReport.trim()
      ? parsed.reconciliationReport
      : captured
        ? `Picasso proposed ${captured.operations.length} graph update${captured.operations.length === 1 ? "" : "s"} for review.`
        : text.trim().slice(0, 4000) || "Picasso completed without proposing graph changes.";
  return {
    status: parsed.status === "blocked" ? "blocked" : "completed",
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers.filter((item): item is string => typeof item === "string") : [],
    graphChangeSet,
    nodesAffected: Array.isArray(parsed.nodesAffected) ? parsed.nodesAffected.filter((item): item is string => typeof item === "string") : [],
    designReport,
    reconciliationReport: designReport,
    discrepancies: Array.isArray(parsed.discrepancies) ? parsed.discrepancies.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.nodeId !== "string" || typeof record.nodeTitle !== "string" || typeof record.issue !== "string" || typeof record.proposedFix !== "string") return [];
      return [{ nodeId: record.nodeId, nodeTitle: record.nodeTitle, issue: record.issue, proposedFix: record.proposedFix }];
    }) : [],
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.filter((item): item is string => typeof item === "string") : [],
    validationChecks: Array.isArray(parsed.validationChecks) ? parsed.validationChecks.filter((item): item is string => typeof item === "string") : [],
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.filter((item): item is string => typeof item === "string") : []
  };
}

function repairMessage(
  input: unknown,
  outputText: string,
  validationError: string,
  _context: MicroRunContext,
  toolCalls: MicroRunToolInvocation[]
): string {
  const task = parsePicassoTask(input);
  const acceptedCalls = toolCalls.filter((call) => call.succeeded !== false && (
    call.providerToolName === "picasso_submit_graph_batch" ||
    call.providerToolName === "propose_graph_change_set" ||
    call.providerToolName === "picasso_propose_graph_change_set"
  ));
  const acceptedOperationCount = acceptedCalls.reduce((total, call) => {
    try {
      const args = JSON.parse(call.argumentsJson || "{}") as { operations?: unknown[] };
      return total + (Array.isArray(args.operations) ? args.operations.length : 0);
    } catch {
      return total;
    }
  }, 0);
  const checkpoint = acceptedCalls.length
    ? `${acceptedCalls.length} validated batch${acceptedCalls.length === 1 ? "" : "es"} containing ${acceptedOperationCount} operations are already retained by the harness. Do not resubmit, recreate, or replay those completed batches. Before repairing a missing or rejected final batch, call picasso_read_graph once to inspect the exact staged checkpoint IDs and remaining topology; do not repeat that read. Correct only the rejected or missing work and continue from that checkpoint.`
    : "No graph batch has been accepted yet.";
  const completion = task.mode === "assess"
    ? "Return the required assessment JSON object now, including status and blockers."
    : `${checkpoint} Submit any genuinely remaining non-final operation batches through picasso_submit_graph_batch with at most ${PICASSO_BATCH_MAX_OPERATIONS} operations each, then call propose_graph_change_set with only the corrected final bounded batch. Do not ask for confirmation and do not return the proposal only as prose or JSON.`;
  return [
    "Your previous response did not satisfy Picasso's completion contract.",
    `Validation error: ${validationError}`,
    completion,
    outputText.trim() ? `Previous response for repair context:\n${outputText.slice(0, 4_000)}` : ""
  ].filter(Boolean).join("\n\n");
}

export const picassoGraphAgent: MicroRunAgent = {
  kind: "graph-reconciliation",
  systemPrompt,
  userMessage,
  tools,
  timeoutMs: PICASSO_TIMEOUT_MS,
  parseOutput,
  validateOutput,
  repairMessage
};
