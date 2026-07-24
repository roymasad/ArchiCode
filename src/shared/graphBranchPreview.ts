import type { ArchicodeNode, Flow, FlowEdge, FlowGroup, FlowSubflow } from "./schema";

export type GraphBranchPreviewChangeKind = "added" | "modified" | "removed";
export type GraphBranchPreviewEntityKind = "flow" | "group" | "subflow" | "node" | "edge";

export type GraphBranchPreviewFieldChange = {
  field: string;
  label: string;
  before: string;
  after: string;
  layout: boolean;
};

export type GraphBranchPreviewChange = {
  id: string;
  flowId: string;
  flowName: string;
  entityKind: GraphBranchPreviewEntityKind;
  entityId: string;
  changeKind: GraphBranchPreviewChangeKind;
  title: string;
  fields: GraphBranchPreviewFieldChange[];
  nodeIds: string[];
  edgeId?: string;
  layoutOnly: boolean;
};

export type GraphBranchPreviewFlow = {
  flow: Flow;
  nodeStates: Record<string, GraphBranchPreviewChangeKind>;
  edgeStates: Record<string, GraphBranchPreviewChangeKind>;
  changeIds: string[];
};

export type GraphBranchPreviewStats = {
  added: number;
  modified: number;
  removed: number;
  layoutOnly: number;
};

export type GraphBranchPreviewDiff = {
  flows: GraphBranchPreviewFlow[];
  changes: GraphBranchPreviewChange[];
  stats: GraphBranchPreviewStats;
};

export type GraphBranchPreview = GraphBranchPreviewDiff & {
  baseRef: string;
  candidateRef: string;
  baseCommit: string;
  candidateCommit: string;
  comparisonCommit: string;
};

type PreviewEntity = Flow | FlowGroup | FlowSubflow | ArchicodeNode | FlowEdge;

const fieldLabels: Record<string, string> = {
  name: "Name",
  description: "Description",
  ignored: "Ignored",
  evidenceBackbone: "Evidence backbone",
  perspective: "Perspective",
  visual: "Appearance",
  type: "Type",
  title: "Title",
  stage: "Stage",
  flags: "Flags",
  locked: "Locked",
  position: "Position",
  size: "Size",
  parentId: "Parent node",
  subflowId: "Subflow",
  groupId: "Group",
  techStack: "Tech stack",
  acceptanceCriteria: "Acceptance criteria",
  acceptanceChecks: "Acceptance checks",
  subjectRef: "Subject reference",
  implementationScope: "Implementation scope",
  moduleProfileMode: "Module profile mode",
  moduleProfileId: "Module profile",
  customProperties: "Custom properties",
  ruleIds: "Rules",
  attachments: "Attachments",
  todos: "Todos",
  source: "Source",
  target: "Target",
  sourceHandle: "Source handle",
  targetHandle: "Target handle",
  color: "Color",
  width: "Width",
  lineStyle: "Line style",
  animated: "Animated",
  bidirectional: "Bidirectional",
  label: "Label",
  evidence: "Evidence",
  parentNodeId: "Parent node",
  parentSubflowId: "Parent subflow"
};

const entityFields: Record<GraphBranchPreviewEntityKind, string[]> = {
  flow: ["name", "description", "ignored", "evidenceBackbone", "perspective", "visual"],
  group: ["name", "color"],
  subflow: ["name", "ignored", "parentNodeId", "parentSubflowId"],
  node: [
    "type",
    "title",
    "description",
    "stage",
    "ignored",
    "flags",
    "locked",
    "visual",
    "position",
    "size",
    "parentId",
    "subflowId",
    "groupId",
    "techStack",
    "acceptanceCriteria",
    "acceptanceChecks",
    "subjectRef",
    "implementationScope",
    "moduleProfileMode",
    "moduleProfileId",
    "customProperties",
    "ruleIds",
    "attachments",
    "todos"
  ],
  edge: [
    "source",
    "target",
    "sourceHandle",
    "targetHandle",
    "color",
    "width",
    "lineStyle",
    "animated",
    "bidirectional",
    "label",
    "evidence"
  ]
};

const layoutFields = new Set(["position", "size"]);
const addedPropertyFields: Record<GraphBranchPreviewEntityKind, string[]> = {
  flow: ["description", "ignored", "evidenceBackbone", "perspective", "visual"],
  group: ["color"],
  subflow: ["ignored", "parentNodeId", "parentSubflowId"],
  node: [
    "type",
    "description",
    "stage",
    "ignored",
    "flags",
    "locked",
    "parentId",
    "subflowId",
    "groupId",
    "techStack",
    "acceptanceCriteria",
    "acceptanceChecks",
    "subjectRef",
    "implementationScope",
    "moduleProfileMode",
    "moduleProfileId",
    "customProperties",
    "ruleIds",
    "attachments",
    "todos"
  ],
  edge: [
    "source",
    "target",
    "sourceHandle",
    "targetHandle",
    "color",
    "width",
    "lineStyle",
    "animated",
    "bidirectional",
    "evidence"
  ]
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return "None";
    if (value.every((item) => typeof item === "string" || typeof item === "number")) return value.join(", ");
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  const text = stableJson(value);
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function hasAddedPropertyValue(field: string, value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value || field === "animated" || field === "bidirectional";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function referencedEntityName(field: string, value: unknown, flow: Flow): string | null {
  if (typeof value !== "string") return null;
  if (field === "source" || field === "target" || field === "parentId" || field === "parentNodeId") {
    return flow.nodes.find((node) => node.id === value)?.title ?? null;
  }
  if (field === "subflowId" || field === "parentSubflowId") {
    return flow.subflows.find((subflow) => subflow.id === value)?.name ?? null;
  }
  if (field === "groupId") {
    return flow.groups.find((group) => group.id === value)?.name ?? null;
  }
  return null;
}

function addedFields(
  entityKind: GraphBranchPreviewEntityKind,
  entity: PreviewEntity,
  flow: Flow
): GraphBranchPreviewFieldChange[] {
  const record = entity as unknown as Record<string, unknown>;
  return addedPropertyFields[entityKind].flatMap((field) => {
    const value = record[field];
    if (!hasAddedPropertyValue(field, value)) return [];
    const referencedName = referencedEntityName(field, value, flow);
    return [{
      field,
      label: fieldLabels[field] ?? field,
      before: "—",
      after: referencedName ?? displayValue(value),
      layout: false
    }];
  });
}

function changedFields(
  entityKind: GraphBranchPreviewEntityKind,
  before: PreviewEntity,
  after: PreviewEntity
): GraphBranchPreviewFieldChange[] {
  const beforeRecord = before as unknown as Record<string, unknown>;
  const afterRecord = after as unknown as Record<string, unknown>;
  return entityFields[entityKind].flatMap((field) => {
    if (stableJson(beforeRecord[field]) === stableJson(afterRecord[field])) return [];
    return [{
      field,
      label: fieldLabels[field] ?? field,
      before: displayValue(beforeRecord[field]),
      after: displayValue(afterRecord[field]),
      layout: layoutFields.has(field)
    }];
  });
}

function edgeTitle(edge: FlowEdge, nodes: Map<string, ArchicodeNode>): string {
  const source = nodes.get(edge.source)?.title ?? edge.source;
  const target = nodes.get(edge.target)?.title ?? edge.target;
  return edge.label?.trim() || `${source} → ${target}`;
}

function previewChange(input: Omit<GraphBranchPreviewChange, "id" | "layoutOnly">): GraphBranchPreviewChange {
  return {
    ...input,
    id: `${input.flowId}:${input.entityKind}:${input.entityId}:${input.changeKind}`,
    layoutOnly: input.changeKind === "modified" && input.fields.length > 0 && input.fields.every((field) => field.layout)
  };
}

function compareCollection<T extends { id: string }>(input: {
  flowId: string;
  flowName: string;
  entityKind: Exclude<GraphBranchPreviewEntityKind, "flow">;
  before: T[];
  after: T[];
  title: (entity: T, nodes: Map<string, ArchicodeNode>) => string;
  nodeIds: (entity: T, flow: Flow) => string[];
  beforeFlow: Flow;
  afterFlow: Flow;
}): GraphBranchPreviewChange[] {
  const beforeById = new Map(input.before.map((entity) => [entity.id, entity]));
  const afterById = new Map(input.after.map((entity) => [entity.id, entity]));
  const titleNodes = new Map(
    [...input.beforeFlow.nodes, ...input.afterFlow.nodes].map((node) => [node.id, node])
  );
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort((left, right) => left.localeCompare(right));
  return ids.flatMap((id) => {
    const before = beforeById.get(id);
    const after = afterById.get(id);
    const entity = after ?? before;
    if (!entity) return [];
    const common = {
      flowId: input.flowId,
      flowName: input.flowName,
      entityKind: input.entityKind,
      entityId: id,
      title: input.title(entity, titleNodes),
      nodeIds: input.nodeIds(entity, after ? input.afterFlow : input.beforeFlow),
      edgeId: input.entityKind === "edge" ? id : undefined
    };
    if (!before && after) {
      return [previewChange({
        ...common,
        changeKind: "added",
        fields: addedFields(input.entityKind, after as unknown as PreviewEntity, input.afterFlow)
      })];
    }
    if (!after) return [previewChange({ ...common, changeKind: "removed", fields: [] })];
    const fields = changedFields(input.entityKind, before as unknown as PreviewEntity, after as unknown as PreviewEntity);
    return fields.length ? [previewChange({ ...common, changeKind: "modified", fields })] : [];
  });
}

function previewFlowFor(before: Flow | undefined, after: Flow | undefined): Flow {
  if (!before && after) return after;
  if (before && !after) return before;
  if (!before || !after) throw new Error("A graph preview flow requires at least one snapshot.");
  const afterNodeIds = new Set(after.nodes.map((node) => node.id));
  const afterEdgeIds = new Set(after.edges.map((edge) => edge.id));
  const afterSubflowIds = new Set(after.subflows.map((subflow) => subflow.id));
  const afterGroupIds = new Set(after.groups.map((group) => group.id));
  return {
    ...after,
    nodes: [...after.nodes, ...before.nodes.filter((node) => !afterNodeIds.has(node.id))],
    edges: [...after.edges, ...before.edges.filter((edge) => !afterEdgeIds.has(edge.id))],
    subflows: [...after.subflows, ...before.subflows.filter((subflow) => !afterSubflowIds.has(subflow.id))],
    groups: [...after.groups, ...before.groups.filter((group) => !afterGroupIds.has(group.id))]
  };
}

export function buildGraphBranchPreviewDiff(beforeFlows: Flow[], afterFlows: Flow[]): GraphBranchPreviewDiff {
  const beforeById = new Map(beforeFlows.map((flow) => [flow.id, flow]));
  const afterById = new Map(afterFlows.map((flow) => [flow.id, flow]));
  const flowIds = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort((left, right) => {
    const leftName = afterById.get(left)?.name ?? beforeById.get(left)?.name ?? left;
    const rightName = afterById.get(right)?.name ?? beforeById.get(right)?.name ?? right;
    return leftName.localeCompare(rightName) || left.localeCompare(right);
  });
  const changes: GraphBranchPreviewChange[] = [];
  const flows: GraphBranchPreviewFlow[] = [];

  for (const flowId of flowIds) {
    const before = beforeById.get(flowId);
    const after = afterById.get(flowId);
    const flow = previewFlowFor(before, after);
    const flowName = after?.name ?? before?.name ?? flowId;
    const flowChanges: GraphBranchPreviewChange[] = [];
    if (!before) {
      flowChanges.push(previewChange({
        flowId,
        flowName,
        entityKind: "flow",
        entityId: flowId,
        changeKind: "added",
        title: flowName,
        fields: addedFields("flow", after ?? flow, after ?? flow),
        nodeIds: flow.nodes.map((node) => node.id)
      }));
    } else if (!after) {
      flowChanges.push(previewChange({
        flowId,
        flowName,
        entityKind: "flow",
        entityId: flowId,
        changeKind: "removed",
        title: flowName,
        fields: [],
        nodeIds: flow.nodes.map((node) => node.id)
      }));
    } else {
      const fields = changedFields("flow", before, after);
      if (fields.length) {
        flowChanges.push(previewChange({
          flowId,
          flowName,
          entityKind: "flow",
          entityId: flowId,
          changeKind: "modified",
          title: flowName,
          fields,
          nodeIds: flow.nodes.map((node) => node.id)
        }));
      }
    }

    const beforeFlow = before ?? { ...flow, nodes: [], edges: [], subflows: [], groups: [] };
    const afterFlow = after ?? { ...flow, nodes: [], edges: [], subflows: [], groups: [] };
    flowChanges.push(
      ...compareCollection({
        flowId,
        flowName,
        entityKind: "group",
        before: before?.groups ?? [],
        after: after?.groups ?? [],
        title: (group) => group.name,
        nodeIds: (group, sourceFlow) => sourceFlow.nodes.filter((node) => node.groupId === group.id).map((node) => node.id),
        beforeFlow,
        afterFlow
      }),
      ...compareCollection({
        flowId,
        flowName,
        entityKind: "subflow",
        before: before?.subflows ?? [],
        after: after?.subflows ?? [],
        title: (subflow) => subflow.name,
        nodeIds: (subflow, sourceFlow) => sourceFlow.nodes.filter((node) => node.subflowId === subflow.id).map((node) => node.id),
        beforeFlow,
        afterFlow
      }),
      ...compareCollection({
        flowId,
        flowName,
        entityKind: "node",
        before: before?.nodes ?? [],
        after: after?.nodes ?? [],
        title: (node) => node.title,
        nodeIds: (node) => [node.id],
        beforeFlow,
        afterFlow
      }),
      ...compareCollection({
        flowId,
        flowName,
        entityKind: "edge",
        before: before?.edges ?? [],
        after: after?.edges ?? [],
        title: edgeTitle,
        nodeIds: (edge) => [edge.source, edge.target],
        beforeFlow,
        afterFlow
      })
    );

    if (!flowChanges.length) continue;
    const nodeStates: Record<string, GraphBranchPreviewChangeKind> = {};
    const edgeStates: Record<string, GraphBranchPreviewChangeKind> = {};
    for (const change of flowChanges) {
      if (change.entityKind === "node") nodeStates[change.entityId] = change.changeKind;
      if (change.entityKind === "edge") edgeStates[change.entityId] = change.changeKind;
    }
    if (!before || !after) {
      const state: GraphBranchPreviewChangeKind = before ? "removed" : "added";
      for (const node of flow.nodes) nodeStates[node.id] = state;
      for (const edge of flow.edges) edgeStates[edge.id] = state;
    }
    changes.push(...flowChanges);
    flows.push({
      flow,
      nodeStates,
      edgeStates,
      changeIds: flowChanges.map((change) => change.id)
    });
  }

  const stats: GraphBranchPreviewStats = { added: 0, modified: 0, removed: 0, layoutOnly: 0 };
  for (const change of changes) {
    stats[change.changeKind] += 1;
    if (change.layoutOnly) stats.layoutOnly += 1;
  }
  return { flows, changes, stats };
}
