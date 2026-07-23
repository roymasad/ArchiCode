import type { ArchicodeNode, Flow, FlowEdge, FlowGroup, FlowSubflow, Note, NodePatch, ProjectBundle, ProjectSettings, ResearchChatMessage, ResearchChatScope, RunGuidance } from "../../shared/schema";
import { gaiaAgent, pandoraAgent } from "../../shared/agentIdentities";
import {
  applyNodePatch,
  archicodeNodeSchema,
  flowEdgeSchema,
  flowGroupSchema,
  flowSchema,
  flowSubflowSchema,
  isProductionApproved,
  researchGraphOperationSchema,
  runTargetProfileSchema
} from "../../shared/schema";
import { deleteSubflowFromFlow, isSubflowIgnored, linkNodeToSubflow, workingNodesForFlow } from "../../shared/graph";
import { authorAcceptanceTestsScoped, runNodeAcceptanceChecks } from "../storage/acceptanceChecks";
import { recordGraphChange } from "../storage/ledgers";
import { addNote, deleteNote, updateNoteResolved } from "../storage/notes";
import { loadProject, saveFlow, updateNode, updateProjectMetadata, updateProjectSettings } from "../storage/projectStore";
import { retryRun, startAgentRun, startDebuggingRun, startIncidentDebugRun, startRuntimeDebugRun } from "../storage/runEngine";
import { listRuntimeServices, restartRuntimeService, startRuntimeService, stopRuntimeService } from "../storage/runtimeServices";
import { id, iso, layoutResearchCreatedNodes } from "../research";

export type ResearchOperation = NonNullable<ResearchChatMessage["changeSet"]>["operations"][number];
export type NormalizedResearchCreateNode = Omit<Extract<ResearchOperation, { kind: "create-node" }>["node"], "position" | "positionHint"> & {
  position?: { x: number; y: number };
};

export async function applyExternalGraphOperation(
  projectRoot: string,
  input: unknown
): Promise<{ message: string; bundle: ProjectBundle }> {
  const operation = researchGraphOperationSchema.parse(input);
  const bundle = await loadProject(projectRoot);
  const nodeIdsBefore = operation.kind === "create-node"
    ? new Set(bundle.flows.find((item) => item.id === operation.flowId)?.nodes.map((node) => node.id) ?? [])
    : new Set<string>();
  validateResearchChangeSet(bundle, { type: "project", projectId: bundle.project.id }, [operation]);
  const message = await applyResearchOperation(projectRoot, operation);
  if (operation.kind === "create-node" && !createNodeHasExplicitPlacement(operation.node)) {
    const createdNodeIds = new Set<string>();
    if (operation.node.id) createdNodeIds.add(operation.node.id);
    else {
      const latest = await loadProject(projectRoot);
      const flow = latest.flows.find((item) => item.id === operation.flowId);
      const createdNode = flow?.nodes.find((node) => !nodeIdsBefore.has(node.id));
      if (createdNode) createdNodeIds.add(createdNode.id);
    }
    if (createdNodeIds.size) await layoutResearchCreatedNodes(projectRoot, new Map([[operation.flowId, createdNodeIds]]));
  }
  return {
    message: message ?? "Applied successfully.",
    bundle: await loadProject(projectRoot)
  };
}
export type ResearchChangeSet = NonNullable<ResearchChatMessage["changeSet"]>;

export const autoApprovableGraphOperationKinds = new Set<ResearchOperation["kind"]>([
  "update-flow",
  "update-node",
  "update-edge",
  "create-node",
  "create-edge",
  "create-subflow",
  "create-group",
  "update-group",
  "update-subflow",
  "link-node-subflow"
]);

export const destructiveGraphOperationKinds = new Set<ResearchOperation["kind"]>([
  "delete-node",
  "delete-edge",
  "delete-subflow",
  "delete-group"
]);

export function isAutoApprovableGraphOperation(operation: ResearchOperation, includeDestructive: boolean): boolean {
  return autoApprovableGraphOperationKinds.has(operation.kind) || (includeDestructive && destructiveGraphOperationKinds.has(operation.kind));
}

export function shouldAutoApproveResearchChangeSet(settings: ProjectSettings["researchAutoApproveGraphChanges"], changeSet: ResearchChangeSet): boolean {
  return Boolean(settings.enabled && changeSet.operations.length && changeSet.operations.every((operation) =>
    isAutoApprovableGraphOperation(operation, settings.includeDestructive)
  ));
}

export function researchAgentGuidance(guidance?: RunGuidance): RunGuidance | undefined {
  if (!guidance) return undefined;
  return { ...guidance, source: "research-agent" };
}

export function preferredResearchProviderId(bundle: ProjectBundle): string | undefined {
  return bundle.project.settings.providers.find((item) => item.enabled && item.kind !== "offline-manual")?.id
    ?? bundle.project.settings.providers.find((item) => item.enabled)?.id;
}

export function normalizeResearchQueueProviders(operations: ResearchOperation[]): ResearchOperation[] {
  return operations.map((operation) => {
    if (
      operation.kind === "start-agent-run" ||
      operation.kind === "start-run-profile" ||
      operation.kind === "start-runtime-debug-run" ||
      operation.kind === "start-incident-debug-run"
    ) {
      const { providerId: _providerId, ...rest } = operation;
      void _providerId;
      return rest;
    }
    return operation;
  });
}

export function normalizeResearchAgentRunNodeIds(bundle: ProjectBundle, operations: ResearchOperation[]): ResearchOperation[] {
  const knownNodeIdsByFlow = new Map(bundle.flows.map((flow) => [flow.id, new Set(flow.nodes.map((node) => node.id))]));
  for (const operation of operations) {
    if (operation.kind === "create-flow") {
      knownNodeIdsByFlow.set(operation.flow.id, new Set(operation.flow.nodes.map((node) => node.id)));
    }
    if (operation.kind === "create-node" && operation.node.id) {
      const nodeIds = knownNodeIdsByFlow.get(operation.flowId) ?? new Set<string>();
      nodeIds.add(operation.node.id);
      knownNodeIdsByFlow.set(operation.flowId, nodeIds);
    }
  }

  return operations.map((operation) => {
    if (
      operation.kind !== "start-agent-run" ||
      operation.nodeId !== operation.flowId ||
      operation.scope?.kind === "nodes" ||
      knownNodeIdsByFlow.get(operation.flowId)?.has(operation.nodeId)
    ) return operation;

    const { nodeId: _copiedFlowId, ...runOperation } = operation;
    void _copiedFlowId;
    return {
      ...runOperation,
      scope: operation.scope ?? {
        kind: "flow",
        flowId: operation.flowId,
        nodeIds: []
      }
    };
  });
}

export function normalizeResearchSubflowFlowIds(operations: ResearchOperation[]): ResearchOperation[] {
  const subflowToFlowId = new Map<string, string>();
  for (const operation of operations) {
    if (operation.kind === "create-subflow" && operation.subflow.id) {
      subflowToFlowId.set(operation.subflow.id, operation.flowId);
    }
  }
  if (!subflowToFlowId.size) return operations;

  return operations.map((operation) => {
    if (operation.kind === "create-node") {
      const topLevelFlowId = subflowToFlowId.get(operation.flowId);
      if (!topLevelFlowId) return operation;
      return {
        ...operation,
        flowId: topLevelFlowId,
        node: {
          ...operation.node,
          subflowId: operation.node.subflowId ?? operation.flowId
        }
      };
    }
    if (operation.kind === "create-edge") {
      const topLevelFlowId = subflowToFlowId.get(operation.flowId);
      return topLevelFlowId ? { ...operation, flowId: topLevelFlowId } : operation;
    }
    return operation;
  });
}

export async function applyResearchOperation(projectRoot: string, operation: ResearchOperation): Promise<string | undefined> {
  if (operation.kind === "update-project") {
    await updateProjectMetadata(projectRoot, operation.patch);
  } else if (operation.kind === "create-flow") {
    await createFlow(projectRoot, operation.flow);
  } else if (operation.kind === "update-flow") {
    await updateFlow(projectRoot, operation.flowId, operation.patch);
  } else if (operation.kind === "update-node") {
    const bundle = await loadProject(projectRoot);
    const flow = findFlow(bundle, operation.flowId);
    const patch = normalizeResearchUpdateNodePatch(flow, operation.patch);
    await updateNode(projectRoot, operation.flowId, patch, "user", { graphChangeActor: "accepted-research" });
  } else if (operation.kind === "update-edge") {
    await updateEdge(projectRoot, operation.flowId, operation.edgeId, operation.patch);
  } else if (operation.kind === "add-note") {
    await addNote(projectRoot, operation.note);
  } else if (operation.kind === "resolve-note") {
    await updateNoteResolved(projectRoot, operation.noteId, operation.resolved);
  } else if (operation.kind === "delete-note") {
    await deleteNote(projectRoot, operation.noteId);
  } else if (operation.kind === "create-node") {
    await createNode(projectRoot, operation.flowId, operation.node);
  } else if (operation.kind === "create-edge") {
    await createEdge(projectRoot, operation.flowId, operation.edge);
  } else if (operation.kind === "create-subflow") {
    await createSubflow(projectRoot, operation.flowId, operation.subflow);
  } else if (operation.kind === "create-group") {
    await createGroup(projectRoot, operation.flowId, operation.group);
  } else if (operation.kind === "update-group") {
    await updateGroup(projectRoot, operation.flowId, operation.groupId, operation.patch);
  } else if (operation.kind === "update-subflow") {
    await updateSubflow(projectRoot, operation.flowId, operation.subflowId, operation.patch);
  } else if (operation.kind === "link-node-subflow") {
    await linkNodeSubflow(projectRoot, operation.flowId, operation.nodeId, operation.subflowId);
  } else if (operation.kind === "propose-run-profile") {
    await upsertResearchRunProfile(projectRoot, operation.profile, operation.mode);
  } else if (operation.kind === "start-agent-run") {
    const { runId } = await startAgentRun({
      projectRoot,
      flowId: operation.flowId,
      nodeId: operation.nodeId,
      providerId: await researchOperationProviderId(projectRoot),
      promptSummary: operation.promptSummary,
      command: operation.command,
      cwd: operation.cwd,
      effort: operation.effort ?? "high",
      allowShell: operation.allowShell,
      reusableApproval: operation.reusableApproval,
      guidance: researchAgentGuidance(operation.guidance),
      scope: operation.scope
    });
    return `Queued AI Implement run ${runId} with ${gaiaAgent.title}.`;
  } else if (operation.kind === "start-run-profile") {
    const services = await startRuntimeService({
      projectRoot,
      profileId: operation.profileId,
      targetId: operation.targetId
    });
    const service = services.find((item) => item.profileId === operation.profileId
      && (!operation.targetId || item.targetId === operation.targetId));
    if (!service) throw new Error(`Run App profile ${operation.profileId} did not return a runtime service.`);
    if (service.status === "failed") {
      throw new Error(service.logs.at(-1)?.text || `Run App profile ${operation.profileId} failed to start.`);
    }
    return `Started runtime service ${service.label} (${service.id}) directly${service.url ? ` at ${service.url}` : ""}.`;
  } else if (operation.kind === "stop-runtime-service") {
    const service = (await listRuntimeServices(projectRoot)).find((item) => item.id === operation.serviceId);
    if (!service) throw new Error(`Runtime service ${operation.serviceId} was not found.`);
    if (service.status === "stopped") return `Runtime service ${service.label} was already stopped.`;
    await stopRuntimeService(projectRoot, operation.serviceId);
    return `Stopped runtime service ${service.label} (${operation.serviceId}).`;
  } else if (operation.kind === "restart-runtime-service") {
    const service = (await listRuntimeServices(projectRoot)).find((item) => item.id === operation.serviceId);
    if (!service) throw new Error(`Runtime service ${operation.serviceId} was not found.`);
    const services = await restartRuntimeService(projectRoot, operation.serviceId);
    const restarted = services.find((item) => item.id === operation.serviceId && item.status === "running")
      ?? services.find((item) => item.status === "running"
        && item.profileId === service.profileId
        && item.targetId === service.targetId
        && item.relativeCwd === service.relativeCwd);
    if (!restarted) throw new Error(`Runtime service ${service.label} failed to restart.`);
    return `Restarted runtime service ${service.label} (${restarted.id}).`;
  } else if (operation.kind === "retry-run") {
    const { runId } = await retryRun(projectRoot, operation.runId, researchAgentGuidance(operation.guidance));
    return `Queued retry ${runId} for run ${operation.runId}.`;
  } else if (operation.kind === "start-debugging-run") {
    const { runId } = await startDebuggingRun(projectRoot, operation.runId, researchAgentGuidance(operation.guidance));
    return `Queued AI Debug run ${runId} with ${pandoraAgent.title} for failed run ${operation.runId}.`;
  } else if (operation.kind === "author-acceptance-tests") {
    // This operation reaches execution only after the user accepts its review
    // card, which is the explicit authorization Test Authoring requires.
    const result = await authorAcceptanceTestsScoped(projectRoot, operation.flowId, operation.nodeId, await researchOperationProviderId(projectRoot), {
      writeAuthorizedByUser: true
    });
    return operation.nodeId
      ? `Regenerated acceptance tests for ${result.results[0]?.title ?? operation.nodeId}.`
      : `Regenerated acceptance tests for ${result.results.length} node${result.results.length === 1 ? "" : "s"}.`;
  } else if (operation.kind === "run-acceptance-checks") {
    const result = await runNodeAcceptanceChecks(projectRoot, operation.flowId, operation.nodeId);
    return `Acceptance checks finished: ${result.passing}/${result.total} passing.`;
  } else if (operation.kind === "start-runtime-debug-run") {
    const { runId } = await startRuntimeDebugRun({
      projectRoot,
      serviceId: operation.serviceId,
      flowId: operation.flowId,
      providerId: await researchOperationProviderId(projectRoot),
      guidance: researchAgentGuidance(operation.guidance)
    });
    return `Queued AI Debug run ${runId} with ${pandoraAgent.title} for service ${operation.serviceId}.`;
  } else if (operation.kind === "start-incident-debug-run") {
    const { runId } = await startIncidentDebugRun({
      projectRoot,
      flowId: operation.flowId,
      providerId: await researchOperationProviderId(projectRoot),
      guidance: researchAgentGuidance(operation.guidance)
    });
    return `Queued AI Debug incident run ${runId} with ${pandoraAgent.title}.`;
  } else if (operation.kind === "delete-node") {
    await deleteNode(projectRoot, operation.flowId, operation.nodeId);
  } else if (operation.kind === "delete-edge") {
    await deleteEdge(projectRoot, operation.flowId, operation.edgeId);
  } else if (operation.kind === "delete-subflow") {
    await deleteSubflow(projectRoot, operation.flowId, operation.subflowId);
  } else if (operation.kind === "delete-group") {
    await deleteGroup(projectRoot, operation.flowId, operation.groupId);
  }
  return undefined;
}

export async function researchOperationProviderId(projectRoot: string): Promise<string> {
  const bundle = await loadProject(projectRoot);
  const provider = preferredResearchProviderId(bundle);
  if (!provider) throw new Error("Choose an enabled provider before starting agent orchestration.");
  return provider;
}

export const RESEARCH_POSITION_X_GAP = 330;
export const RESEARCH_POSITION_Y_GAP = 220;

export function exactResearchNodePosition(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.x !== "number" || typeof record.y !== "number") return null;
  return { x: record.x, y: record.y };
}

export function relativeResearchNodePositionHint(value: unknown): { relativeToNodeId: string; placement: "above" | "below" | "left" | "right" } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const relativeToNodeId = typeof record.relativeToNodeId === "string" && record.relativeToNodeId.trim()
    ? record.relativeToNodeId.trim()
    : null;
  const placement = typeof record.placement === "string" ? record.placement.trim().toLowerCase() : "";
  if (!relativeToNodeId || !["above", "below", "left", "right"].includes(placement)) return null;
  return {
    relativeToNodeId,
    placement: placement as "above" | "below" | "left" | "right"
  };
}

export function resolveRelativeResearchNodePosition(
  flow: Flow,
  hint: { relativeToNodeId: string; placement: "above" | "below" | "left" | "right" }
): { x: number; y: number } {
  const anchor = flow.nodes.find((node) => node.id === hint.relativeToNodeId);
  if (!anchor) throw new Error(`Relative position anchor node ${hint.relativeToNodeId} was not found.`);
  if (hint.placement === "above") return { x: anchor.position.x, y: anchor.position.y - RESEARCH_POSITION_Y_GAP };
  if (hint.placement === "below") return { x: anchor.position.x, y: anchor.position.y + RESEARCH_POSITION_Y_GAP };
  if (hint.placement === "left") return { x: anchor.position.x - RESEARCH_POSITION_X_GAP, y: anchor.position.y };
  return { x: anchor.position.x + RESEARCH_POSITION_X_GAP, y: anchor.position.y };
}

export function normalizeResearchUpdateNodePatch(flow: Flow, patch: Partial<ArchicodeNode> & { id?: string }): NodePatch {
  const patchRecord = { ...(patch as Record<string, unknown>) };
  const exactPosition = exactResearchNodePosition(patchRecord.position);
  const relativeHint = relativeResearchNodePositionHint(patchRecord.positionHint)
    ?? (exactPosition ? null : relativeResearchNodePositionHint(patchRecord.position));
  delete patchRecord.positionHint;
  if (relativeHint) {
    patchRecord.position = resolveRelativeResearchNodePosition(flow, relativeHint);
  } else if (exactPosition) {
    patchRecord.position = exactPosition;
  }
  return patchRecord as NodePatch;
}

export function normalizeResearchCreateNode(
  flow: Flow,
  node: Extract<ResearchOperation, { kind: "create-node" }>["node"]
): NormalizedResearchCreateNode {
  const nodeRecord = { ...(node as Record<string, unknown>) };
  const exactPosition = exactResearchNodePosition(nodeRecord.position);
  const relativeHint = relativeResearchNodePositionHint(nodeRecord.positionHint)
    ?? (exactPosition ? null : relativeResearchNodePositionHint(nodeRecord.position));
  delete nodeRecord.positionHint;
  if (relativeHint) {
    nodeRecord.position = resolveRelativeResearchNodePosition(flow, relativeHint);
  } else if (exactPosition) {
    nodeRecord.position = exactPosition;
  }
  return nodeRecord as NormalizedResearchCreateNode;
}

export function createNodeHasExplicitPlacement(
  node: Extract<ResearchOperation, { kind: "create-node" }>["node"]
): boolean {
  return Boolean(
    exactResearchNodePosition(node.position)
    || relativeResearchNodePositionHint(node.positionHint)
    || relativeResearchNodePositionHint(node.position)
  );
}

export function validateResearchNodePositionReference(
  positionHintValue: unknown,
  positionValue: unknown,
  nodeIds: Set<string>
): void {
  const exactPosition = exactResearchNodePosition(positionValue);
  const relativeHint = relativeResearchNodePositionHint(positionHintValue)
    ?? (exactPosition ? null : relativeResearchNodePositionHint(positionValue));
  if (relativeHint && !nodeIds.has(relativeHint.relativeToNodeId)) {
    throw new Error(`Relative position anchor node ${relativeHint.relativeToNodeId} was not found.`);
  }
}

export function comparableNodeState(node: ArchicodeNode): Omit<ArchicodeNode, "updatedAt"> {
  const { updatedAt: _updatedAt, ...rest } = node;
  return rest;
}

export function nodePatchChangesPersistedState(node: ArchicodeNode, patch: NodePatch): boolean {
  const updated = applyNodePatch(node, patch, "llm");
  return JSON.stringify(comparableNodeState(updated)) !== JSON.stringify(comparableNodeState(node));
}

export function isNoopResearchUpdateNode(bundle: ProjectBundle, operation: ResearchOperation): boolean {
  if (operation.kind !== "update-node") return false;
  const flow = bundle.flows.find((item) => item.id === operation.flowId);
  const existingNode = flow?.nodes.find((node) => node.id === operation.patch.id);
  if (!flow || !existingNode) return false;
  try {
    const resolvedPatch = normalizeResearchUpdateNodePatch(flow, operation.patch);
    return !nodePatchChangesPersistedState(existingNode, resolvedPatch);
  } catch {
    return false;
  }
}

export type ResearchChangeSetValidationError = {
  operationIndex?: number;
  operationKind?: ResearchOperation["kind"];
  message: string;
};

export function formatResearchChangeSetValidationErrors(errors: ResearchChangeSetValidationError[]): string {
  return `Research graph change set failed validation. ${errors.map((error) =>
    error.operationIndex === undefined
      ? error.message
      : `#${error.operationIndex + 1} ${error.operationKind ?? "operation"}: ${error.message}`
  ).join(" ")}`;
}

export function collectResearchChangeSetValidationErrors(
  bundle: ProjectBundle,
  scope: ResearchChatScope,
  operations: ResearchOperation[]
): ResearchChangeSetValidationError[] {
  const errors: ResearchChangeSetValidationError[] = [];
  // Validate against a staged projection, not only the persisted base graph.
  // Large review cards commonly create a flow and then populate it with later
  // operations; those later references are valid inside the same transaction.
  const projectedBundle = structuredClone(bundle);
  const draftNodeIdsByFlow = new Map<string, Set<string>>();
  const draftSubflowIdsByFlow = new Map<string, Set<string>>();
  const addDraftNode = (flowId: string, nodeId: string): void => {
    draftNodeIdsByFlow.set(flowId, new Set([...(draftNodeIdsByFlow.get(flowId) ?? []), nodeId]));
  };
  const addDraftSubflow = (flowId: string, subflowId: string): void => {
    draftSubflowIdsByFlow.set(flowId, new Set([...(draftSubflowIdsByFlow.get(flowId) ?? []), subflowId]));
  };

  operations.forEach((operation, index) => {
    try {
      validateResearchOperationReferences(projectedBundle, operation, draftNodeIdsByFlow, draftSubflowIdsByFlow);
      if (operation.kind === "create-node" && operation.node.id) addDraftNode(operation.flowId, operation.node.id);
      if (operation.kind === "create-subflow" && operation.subflow.id) addDraftSubflow(operation.flowId, operation.subflow.id);
      projectResearchOperationForValidation(projectedBundle, operation, index);
    } catch (error) {
      errors.push({
        operationIndex: index,
        operationKind: operation.kind,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
  errors.push(...validateCreatedSubflowNodePlacement(bundle, operations).map((message) => ({ message })));
  return errors;
}

function projectResearchOperationForValidation(bundle: ProjectBundle, operation: ResearchOperation, operationIndex: number): void {
  if (operation.kind === "update-project") {
    Object.assign(bundle.project, operation.patch);
    return;
  }
  if (operation.kind === "create-flow") {
    bundle.flows.push(structuredClone(operation.flow));
    return;
  }
  if (operation.kind === "propose-run-profile") {
    const profiles = bundle.project.settings.runTargetProfiles;
    const existingIndex = profiles.findIndex((profile) => profile.id === operation.profile.id);
    if (existingIndex >= 0) profiles[existingIndex] = structuredClone(operation.profile);
    else profiles.push(structuredClone(operation.profile));
    return;
  }
  if (operation.kind === "add-note") {
    return;
  }
  if (operation.kind === "resolve-note") {
    const note = bundle.notes.find((item) => item.id === operation.noteId);
    if (note) note.resolved = operation.resolved;
    return;
  }
  if (operation.kind === "delete-note") {
    bundle.notes = bundle.notes.filter((note) => note.id !== operation.noteId);
    return;
  }

  const flowId = operationFlowId(operation);
  const flow = flowId ? bundle.flows.find((item) => item.id === flowId) : undefined;
  if (!flow) return;
  if (operation.kind === "update-flow") {
    Object.assign(flow, operation.patch);
  } else if (operation.kind === "create-node" && operation.node.id) {
    const { positionHint: _positionHint, ...node } = operation.node;
    const position = node.position && "x" in node.position
      ? node.position
      : { x: 120 + flow.nodes.length * 36, y: 120 + flow.nodes.length * 28 };
    flow.nodes.push({ ...node, id: operation.node.id, position, updatedAt: "" } as ArchicodeNode);
  } else if (operation.kind === "update-node") {
    const node = flow.nodes.find((item) => item.id === operation.patch.id);
    if (node) {
      const resolvedPatch = normalizeResearchUpdateNodePatch(flow, operation.patch);
      const nextNode = applyNodePatch(node, resolvedPatch, "llm");
      const nodeIndex = flow.nodes.findIndex((item) => item.id === node.id);
      flow.nodes[nodeIndex] = nextNode;
    }
  } else if (operation.kind === "delete-node") {
    flow.nodes = flow.nodes.filter((node) => node.id !== operation.nodeId);
    flow.edges = flow.edges.filter((edge) => edge.source !== operation.nodeId && edge.target !== operation.nodeId);
  } else if (operation.kind === "create-edge") {
    flow.edges.push({ ...operation.edge, id: operation.edge.id ?? `projected-edge-${operationIndex + 1}` } as FlowEdge);
  } else if (operation.kind === "update-edge") {
    const edge = flow.edges.find((item) => item.id === operation.edgeId);
    if (edge) Object.assign(edge, operation.patch);
  } else if (operation.kind === "delete-edge") {
    flow.edges = flow.edges.filter((edge) => edge.id !== operation.edgeId);
  } else if (operation.kind === "create-subflow" && operation.subflow.id) {
    flow.subflows.push(structuredClone(operation.subflow) as FlowSubflow);
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
    flow.nodes = flow.nodes.map((node) => node.subflowId === operation.subflowId ? { ...node, subflowId: undefined } : node);
  } else if (operation.kind === "create-group" && operation.group.id) {
    flow.groups.push(structuredClone(operation.group) as FlowGroup);
  } else if (operation.kind === "update-group") {
    const group = flow.groups.find((item) => item.id === operation.groupId);
    if (group) Object.assign(group, operation.patch);
  } else if (operation.kind === "delete-group") {
    flow.groups = flow.groups.filter((group) => group.id !== operation.groupId);
    flow.nodes = flow.nodes.map((node) => node.groupId === operation.groupId ? { ...node, groupId: undefined } : node);
  }
}

export function validateResearchChangeSet(bundle: ProjectBundle, scope: ResearchChatScope, operations: ResearchOperation[]): void {
  const errors = collectResearchChangeSetValidationErrors(bundle, scope, operations);
  if (errors.length) {
    throw new Error(formatResearchChangeSetValidationErrors(errors));
  }
}

export function validateCreatedSubflowNodePlacement(bundle: ProjectBundle, operations: ResearchOperation[]): string[] {
  const errors: string[] = [];
  const createdSubflowsByFlow = new Map<string, Set<string>>();
  const linkedSubflowsByFlow = new Map<string, Set<string>>();
  const createdNodeIdsByFlow = new Map<string, Set<string>>();
  const explicitRootNodeIdsByFlow = new Map<string, Set<string>>();
  const unscopedCreatedNodesByFlow = new Map<string, Array<{ index: number; id: string; title: string }>>();
  const existingRootNodeIdsByFlow = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, flowId: string, id: string): void => {
    map.set(flowId, new Set([...(map.get(flowId) ?? []), id]));
  };

  for (const [index, operation] of operations.entries()) {
    if (operation.kind === "create-subflow" && operation.subflow.id) {
      add(createdSubflowsByFlow, operation.flowId, operation.subflow.id);
      if (operation.subflow.parentNodeId) add(explicitRootNodeIdsByFlow, operation.flowId, operation.subflow.parentNodeId);
    }
    if (operation.kind === "link-node-subflow" && operation.subflowId) {
      add(linkedSubflowsByFlow, operation.flowId, operation.subflowId);
      add(explicitRootNodeIdsByFlow, operation.flowId, operation.nodeId);
    }
    if (operation.kind === "create-node" && operation.node.id) {
      add(createdNodeIdsByFlow, operation.flowId, operation.node.id);
      if (!operation.node.subflowId) {
        const nodes = unscopedCreatedNodesByFlow.get(operation.flowId) ?? [];
        nodes.push({ index, id: operation.node.id, title: operation.node.title });
        unscopedCreatedNodesByFlow.set(operation.flowId, nodes);
      }
    }
  }

  for (const flow of bundle.flows) {
    existingRootNodeIdsByFlow.set(flow.id, new Set(flow.nodes
      .filter((node) => !node.subflowId && !node.ignored && !isSubflowIgnored(flow, node.subflowId))
      .map((node) => node.id)));
  }

  for (const [flowId, unscopedNodes] of unscopedCreatedNodesByFlow.entries()) {
    const createdSubflows = createdSubflowsByFlow.get(flowId) ?? new Set<string>();
    if (!createdSubflows.size) continue;
    const linkedSubflows = linkedSubflowsByFlow.get(flowId) ?? new Set<string>();
    const hasNewLinkedDetailFlow = [...createdSubflows].some((subflowId) => linkedSubflows.has(subflowId));
    if (!hasNewLinkedDetailFlow) continue;

    const createdNodeIds = createdNodeIdsByFlow.get(flowId) ?? new Set<string>();
    const knownRootNodeIds = new Set([
      ...(existingRootNodeIdsByFlow.get(flowId) ?? []),
      ...(explicitRootNodeIdsByFlow.get(flowId) ?? [])
    ]);
    const rootConnectedCreatedNodeIds = new Set<string>();
    const adjacentNodeIds = new Map<string, Set<string>>();
    for (const operation of operations) {
      if (operation.kind !== "create-edge" || operation.flowId !== flowId) continue;
      const sourceAdjacent = adjacentNodeIds.get(operation.edge.source) ?? new Set<string>();
      sourceAdjacent.add(operation.edge.target);
      adjacentNodeIds.set(operation.edge.source, sourceAdjacent);
      const targetAdjacent = adjacentNodeIds.get(operation.edge.target) ?? new Set<string>();
      targetAdjacent.add(operation.edge.source);
      adjacentNodeIds.set(operation.edge.target, targetAdjacent);
    }
    // A substantial newly-created flow can legitimately contain both root
    // nodes and a populated detail flow. The linked detail-flow owner is an
    // explicit root anchor; every newly-created unscoped node connected to
    // that anchor belongs to the root topology rather than being a misplaced
    // detail-flow child. This preserves the missing-subflowId guard for truly
    // isolated child nodes without misclassifying an entire new root canvas.
    const pendingRootNodeIds = [...knownRootNodeIds];
    const visitedRootNodeIds = new Set(pendingRootNodeIds);
    while (pendingRootNodeIds.length) {
      const nodeId = pendingRootNodeIds.shift()!;
      for (const adjacentNodeId of adjacentNodeIds.get(nodeId) ?? []) {
        if (visitedRootNodeIds.has(adjacentNodeId)) continue;
        visitedRootNodeIds.add(adjacentNodeId);
        pendingRootNodeIds.push(adjacentNodeId);
      }
    }
    for (const nodeId of createdNodeIds) {
      if (visitedRootNodeIds.has(nodeId)) rootConnectedCreatedNodeIds.add(nodeId);
    }

    const isolatedUnscopedNodes = unscopedNodes.filter((node) => !rootConnectedCreatedNodeIds.has(node.id));
    if (isolatedUnscopedNodes.length) {
      const targetSubflow = [...createdSubflows].find((subflowId) => linkedSubflows.has(subflowId)) ?? [...createdSubflows][0];
      const labels = isolatedUnscopedNodes.map((node) => `#${node.index + 1} "${node.title}"`).join(", ");
      errors.push(`create-node operations ${labels} appear to be children of newly-created detail subflow ${targetSubflow}, but are missing node.subflowId. Add "subflowId": "${targetSubflow}" to each child node so they are created inside the subflow instead of on the root canvas.`);
    }
  }

  return errors;
}

export function operationFlowId(operation: ResearchOperation): string | null {
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
    operation.kind === "author-acceptance-tests" ||
    operation.kind === "run-acceptance-checks" ||
    operation.kind === "start-runtime-debug-run" ||
    operation.kind === "delete-node" ||
    operation.kind === "delete-edge" ||
    operation.kind === "delete-subflow" ||
    operation.kind === "delete-group"
  ) return operation.flowId;
  if (operation.kind === "start-incident-debug-run") return operation.flowId ?? null;
  if (operation.kind === "add-note") return operation.note.flowId;
  return null;
}

export function existingOrDraftNodeIds(flow: Flow, flowId: string, draftNodeIdsByFlow: Map<string, Set<string>>): Set<string> {
  return new Set([...workingNodesForFlow(flow).map((node) => node.id), ...(draftNodeIdsByFlow.get(flowId) ?? [])]);
}

export function existingOrDraftSubflowIds(flow: Flow, flowId: string, draftSubflowIdsByFlow: Map<string, Set<string>>): Set<string> {
  return new Set([...flow.subflows.filter((subflow) => !isSubflowIgnored(flow, subflow.id)).map((subflow) => subflow.id), ...(draftSubflowIdsByFlow.get(flowId) ?? [])]);
}

export function noteForOperation(bundle: ProjectBundle, operation: Extract<ResearchOperation, { kind: "resolve-note" | "delete-note" }>): Note {
  const note = bundle.notes.find((item) => item.id === operation.noteId);
  if (!note) throw new Error(`Note ${operation.noteId} was not found.`);
  return note;
}

export function validateResearchOperationReferences(
  bundle: ProjectBundle,
  operation: ResearchOperation,
  draftNodeIdsByFlow: Map<string, Set<string>>,
  draftSubflowIdsByFlow: Map<string, Set<string>>
): void {
  if (operation.kind === "create-flow") {
    const proposed = flowSchema.parse(operation.flow);
    if (bundle.flows.some((flow) => flow.id === proposed.id)) throw new Error(`Flow ${proposed.id} already exists.`);
    if (proposed.ignored || proposed.subflows.some((subflow) => subflow.ignored) || proposed.nodes.some((node) =>
      node.ignored || node.locked || isProductionApproved(node) || node.flags.includes("user-approved")
    )) throw new Error("Research-created flows cannot contain approved, locked, or ignored graph items.");
    const nodeIds = new Set(proposed.nodes.map((node) => node.id));
    if (nodeIds.size !== proposed.nodes.length) throw new Error(`Flow ${proposed.id} contains duplicate node IDs.`);
    for (const edge of proposed.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new Error(`Flow ${proposed.id} edge ${edge.id} references a missing node.`);
    }
    return;
  }
  const flowId = operationFlowId(operation);
  const flow = flowId ? findFlow(bundle, flowId) : null;
  if (flow?.ignored) {
    throw new Error(`Flow ${flow.id} is ignored and outside the agent working set.`);
  }
  if (operation.kind === "update-project") {
    if (operation.patch.name !== undefined && !operation.patch.name.trim()) throw new Error("Project name cannot be empty.");
    return;
  }
  if (operation.kind === "propose-run-profile") {
    runTargetProfileSchema.parse(operation.profile);
    return;
  }
  if (operation.kind === "retry-run" || operation.kind === "start-debugging-run") {
    if (!bundle.runs.some((run) => run.id === operation.runId)) throw new Error(`Run ${operation.runId} was not found.`);
    return;
  }
  if (operation.kind === "author-acceptance-tests" || operation.kind === "run-acceptance-checks") {
    if (!flow) throw new Error(`Flow ${operation.flowId} was not found.`);
  }
  if (operation.kind === "start-incident-debug-run") {
    if (operation.flowId) findFlow(bundle, operation.flowId);
    return;
  }
  if (operation.kind === "resolve-note" || operation.kind === "delete-note") {
    const note = noteForOperation(bundle, operation);
    const noteFlow = findFlow(bundle, note.flowId);
    if (noteFlow.ignored || noteFlow.nodes.some((node) => node.id === note.nodeId && (node.ignored || isSubflowIgnored(noteFlow, node.subflowId)))) {
      throw new Error(`Note ${note.id} belongs to an ignored graph item.`);
    }
    return;
  }
  if (!flow) return;
  const nodeIds = existingOrDraftNodeIds(flow, flow.id, draftNodeIdsByFlow);
  const subflowIds = existingOrDraftSubflowIds(flow, flow.id, draftSubflowIdsByFlow);
  if (operation.kind === "update-flow") {
    if (operation.patch.name !== undefined && !operation.patch.name.trim()) throw new Error("Flow name cannot be empty.");
    return;
  }
  if (operation.kind === "start-agent-run") {
    if (!operation.promptSummary.trim()) throw new Error("AI Implement run promptSummary cannot be empty.");
    if (operation.nodeId && !nodeIds.has(operation.nodeId)) throw new Error(`Node ${operation.nodeId} was not found.`);
    if (operation.scope?.flowId && operation.scope.flowId !== operation.flowId) throw new Error(`Run scope flow ${operation.scope.flowId} must match operation flow ${operation.flowId}.`);
    if (operation.scope?.kind === "no-scope") {
      if (operation.nodeId) throw new Error("No-scope AI Implement runs must not include nodeId.");
      if (operation.scope.nodeIds.length) throw new Error("No-scope AI Implement runs must not include scope node IDs.");
    }
    if (operation.scope?.kind === "nodes") {
      if (!operation.scope.nodeIds.length) throw new Error("Node-scoped AI Implement runs require at least one scope node.");
      for (const scopedNodeId of operation.scope.nodeIds) {
        if (!nodeIds.has(scopedNodeId)) throw new Error(`Scope node ${scopedNodeId} was not found.`);
      }
      if (operation.nodeId && !operation.scope.nodeIds.includes(operation.nodeId)) {
        throw new Error(`Primary node ${operation.nodeId} must be included in scope.nodeIds.`);
      }
    }
    return;
  }
  if (operation.kind === "start-run-profile") {
    if (!bundle.project.settings.runTargetProfiles.some((profile) => profile.id === operation.profileId)) throw new Error(`Run profile ${operation.profileId} was not found.`);
    return;
  }
  if (operation.kind === "stop-runtime-service" || operation.kind === "restart-runtime-service") return;
  if (operation.kind === "run-acceptance-checks") {
    if (!nodeIds.has(operation.nodeId)) throw new Error(`Node ${operation.nodeId} was not found.`);
    return;
  }
  if (operation.kind === "author-acceptance-tests") {
    if (operation.nodeId && !nodeIds.has(operation.nodeId)) throw new Error(`Node ${operation.nodeId} was not found.`);
    return;
  }
  if (operation.kind === "start-runtime-debug-run") {
    return;
  }
  if (operation.kind === "update-node") {
    const resolvedPatch = normalizeResearchUpdateNodePatch(flow, operation.patch);
    validateNodePatchReferences(bundle, flow, resolvedPatch, nodeIds, subflowIds);
    const existingNode = flow.nodes.find((node) => node.id === operation.patch.id);
    if (existingNode && !nodePatchChangesPersistedState(existingNode, resolvedPatch)) {
      throw new Error(`Update node ${existingNode.id} does not change any persisted fields.`);
    }
    if (existingNode) {
      // Keep proposal-time validation aligned with the accepted Research apply
      // path. In particular, an LLM must not approve a node or mutate an
      // importer/user-approved node without a user-created revision.
      applyNodePatch(existingNode, resolvedPatch, "llm");
    }
  }
  if (operation.kind === "create-node") {
    validateResearchNodePositionReference(operation.node.positionHint, operation.node.position, nodeIds);
    const { position: _position, positionHint: _positionHint, ...referenceNode } = operation.node;
    validateNodePatchReferences(bundle, flow, referenceNode, nodeIds, subflowIds, false);
    if (operation.node.stage === "plan-approved" || operation.node.stage === "draft-approved-production" || operation.node.ignored || operation.node.locked || operation.node.flags.includes("user-approved")) {
      throw new Error("Research-created nodes cannot be born approved, locked, or ignored.");
    }
  }
  if (operation.kind === "add-note") {
    if (!nodeIds.has(operation.note.nodeId)) throw new Error(`Note target node ${operation.note.nodeId} was not found.`);
  }
  if (operation.kind === "create-edge") validateEdgeReferences(flow, operation.edge.source, operation.edge.target, nodeIds);
  if (operation.kind === "update-edge") {
    const edge = flow.edges.find((item) => item.id === operation.edgeId);
    if (!edge) throw new Error(`Edge ${operation.edgeId} was not found.`);
    validateEdgeReferences(flow, operation.patch.source ?? edge.source, operation.patch.target ?? edge.target, nodeIds, operation.edgeId);
  }
  if (operation.kind === "delete-edge" && !flow.edges.some((edge) => edge.id === operation.edgeId)) throw new Error(`Edge ${operation.edgeId} was not found.`);
  if (operation.kind === "create-subflow") {
    if (operation.subflow.ignored) throw new Error("Research-created subflows cannot be born ignored.");
    if (operation.subflow.parentNodeId && !nodeIds.has(operation.subflow.parentNodeId)) throw new Error(`Parent node ${operation.subflow.parentNodeId} was not found.`);
    if (operation.subflow.parentSubflowId && !subflowIds.has(operation.subflow.parentSubflowId)) throw new Error(`Parent subflow ${operation.subflow.parentSubflowId} was not found.`);
  }
  if (operation.kind === "create-group") {
    if (!operation.group.name.trim()) throw new Error("Group name cannot be empty.");
    if (operation.group.id && flow.groups.some((group) => group.id === operation.group.id)) throw new Error(`Group ${operation.group.id} already exists.`);
  }
  if (operation.kind === "update-group") {
    if (!flow.groups.some((group) => group.id === operation.groupId)) throw new Error(`Group ${operation.groupId} was not found.`);
    if (operation.patch.name !== undefined && !operation.patch.name.trim()) throw new Error("Group name cannot be empty.");
  }
  if (operation.kind === "update-subflow") {
    if (!subflowIds.has(operation.subflowId)) throw new Error(`Subflow ${operation.subflowId} was not found.`);
    if (operation.patch.name !== undefined && !operation.patch.name.trim()) throw new Error("Subflow name cannot be empty.");
  }
  if (operation.kind === "link-node-subflow") {
    if (!nodeIds.has(operation.nodeId)) throw new Error(`Node ${operation.nodeId} was not found.`);
    if (operation.subflowId !== null && !subflowIds.has(operation.subflowId)) throw new Error(`Subflow ${operation.subflowId} was not found.`);
  }
  if (operation.kind === "delete-node") {
    const node = flow.nodes.find((item) => item.id === operation.nodeId);
    if (!node) throw new Error(`Node ${operation.nodeId} was not found.`);
    if (isProductionApproved(node)) throw new Error(`Node "${node.title}" is approved and locked. Create a revision before deleting it.`);
  }
  if (operation.kind === "delete-subflow") validateDeleteSubflow(flow, operation.subflowId);
  if (operation.kind === "delete-group") {
    const group = flow.groups.find((item) => item.id === operation.groupId);
    if (!group) throw new Error(`Group ${operation.groupId} was not found.`);
    const approvedNodes = flow.nodes.filter((node) => node.groupId === operation.groupId && isProductionApproved(node));
    if (approvedNodes.length) throw new Error(`Group ${operation.groupId} contains approved locked nodes: ${approvedNodes.map((node) => node.title).join(", ")}.`);
  }
}

export function validateNodePatchReferences(
  bundle: ProjectBundle,
  flow: Flow,
  patch: Partial<ArchicodeNode> & { id?: string },
  nodeIds: Set<string>,
  subflowIds: Set<string>,
  requireExistingId = true
): void {
  if (requireExistingId && patch.id && !nodeIds.has(patch.id)) throw new Error(`Node ${patch.id} was not found.`);
  if (patch.subflowId !== undefined && !subflowIds.has(patch.subflowId)) throw new Error(`Subflow ${patch.subflowId} was not found.`);
  if (patch.groupId !== undefined && !flow.groups.some((group) => group.id === patch.groupId)) throw new Error(`Group ${patch.groupId} was not found.`);
  if (patch.parentId !== undefined && !nodeIds.has(patch.parentId)) throw new Error(`Parent node ${patch.parentId} was not found.`);
  if (patch.parentId && patch.id && patch.parentId === patch.id) throw new Error("A node cannot be its own parent.");
  if (Object.prototype.hasOwnProperty.call(patch, "dependencies")) {
    throw new Error("Node dependencies are no longer supported. Use edges and edge labels to represent graph relationships.");
  }
  if (patch.attachments) {
    const artifactIds = new Set(bundle.artifacts.map((artifact) => artifact.id));
    for (const attachment of patch.attachments) {
      if (!artifactIds.has(attachment.id)) throw new Error(`Attachment artifact ${attachment.id} was not found.`);
    }
  }
}

export function validateEdgeReferences(flow: Flow, source: string, target: string, nodeIds: Set<string>, existingEdgeId?: string): void {
  if (!nodeIds.has(source)) throw new Error(`Source node ${source} was not found.`);
  if (!nodeIds.has(target)) throw new Error(`Target node ${target} was not found.`);
  if (source === target) throw new Error("Research edge cannot connect a node to itself.");
  if (flow.edges.some((edge) => edge.id !== existingEdgeId && edge.source === source && edge.target === target)) {
    throw new Error(`Edge ${source} -> ${target} already exists.`);
  }
}

export function validateDeleteSubflow(flow: Flow, subflowId: string): void {
  if (!flow.subflows.some((subflow) => subflow.id === subflowId)) throw new Error(`Subflow ${subflowId} was not found.`);
  const approvedNodes = flow.nodes.filter((node) => node.subflowId === subflowId && isProductionApproved(node));
  if (approvedNodes.length) {
    throw new Error(`Subflow ${subflowId} contains approved locked nodes: ${approvedNodes.map((node) => node.title).join(", ")}.`);
  }
}

export function findFlow(bundle: ProjectBundle, flowId: string): Flow {
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  return flow;
}

export async function createFlow(projectRoot: string, proposed: Flow): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = flowSchema.parse(proposed);
  if (bundle.flows.some((item) => item.id === flow.id)) throw new Error(`Flow ${flow.id} already exists.`);
  if (flow.ignored || flow.subflows.some((subflow) => subflow.ignored) || flow.nodes.some((node) =>
    node.ignored || node.locked || isProductionApproved(node) || node.flags.includes("user-approved")
  )) throw new Error("Research-created flows cannot contain approved, locked, or ignored graph items.");
  await saveFlow(projectRoot, { ...flow, updatedAt: iso() });
}

export async function updateFlow(
  projectRoot: string,
  flowId: string,
  patch: { name?: string; description?: string; perspective?: Flow["perspective"] }
): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  const name = patch.name === undefined ? flow.name : patch.name.trim();
  if (!name) throw new Error("Flow name cannot be empty.");
  const fieldPaths = [
    ...(name !== flow.name ? ["name"] : []),
    ...(patch.description !== undefined && patch.description.trim() !== flow.description ? ["description"] : []),
    ...(patch.perspective !== undefined && JSON.stringify(patch.perspective) !== JSON.stringify(flow.perspective) ? ["perspective"] : [])
  ];
  await saveFlow(projectRoot, {
    ...flow,
    name,
    description: patch.description === undefined ? flow.description : patch.description.trim(),
    perspective: patch.perspective ?? flow.perspective,
    updatedAt: iso()
  });
  if (fieldPaths.length) {
    await recordGraphChange(projectRoot, {
      flowId,
      actor: "accepted-research",
      kind: "flow-updated",
      summary: `Updated flow "${name}" (${fieldPaths.join(", ")}).`,
      fieldPaths,
      snippets: fieldPaths.map((fieldPath) => ({
        path: fieldPath,
        before: String((flow as unknown as Record<string, unknown>)[fieldPath] ?? ""),
        after: String(({ name, description: patch.description === undefined ? flow.description : patch.description.trim(), perspective: patch.perspective ?? flow.perspective } as Record<string, unknown>)[fieldPath] ?? "")
      }))
    });
  }
}

export async function updateEdge(projectRoot: string, flowId: string, edgeId: string, patch: Partial<Omit<FlowEdge, "id">>): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  const edge = flow.edges.find((item) => item.id === edgeId);
  if (!edge) throw new Error(`Edge ${edgeId} was not found.`);
  const nextEdge = flowEdgeSchema.parse({ ...edge, ...patch, id: edge.id });
  const nodeIds = new Set(flow.nodes.map((node) => node.id));
  validateEdgeReferences(flow, nextEdge.source, nextEdge.target, nodeIds, edgeId);
  const fieldPaths = ["source", "target", "label"].filter((fieldPath) =>
    (edge as unknown as Record<string, unknown>)[fieldPath] !== (nextEdge as unknown as Record<string, unknown>)[fieldPath]
  );
  await saveFlow(projectRoot, {
    ...flow,
    edges: flow.edges.map((item) => item.id === edgeId ? nextEdge : item),
    updatedAt: iso()
  });
  if (fieldPaths.length) {
    await recordGraphChange(projectRoot, {
      flowId,
      actor: "accepted-research",
      kind: "edge-updated",
      summary: `Updated edge ${edgeId}.`,
      nodeIds: [...new Set([edge.source, edge.target, nextEdge.source, nextEdge.target])],
      edgeIds: [edgeId],
      fieldPaths,
      snippets: fieldPaths.map((fieldPath) => ({
        path: fieldPath,
        before: String((edge as unknown as Record<string, unknown>)[fieldPath] ?? ""),
        after: String((nextEdge as unknown as Record<string, unknown>)[fieldPath] ?? "")
      }))
    });
  }
}

export async function upsertResearchRunProfile(projectRoot: string, profile: ProjectSettings["runTargetProfiles"][number], mode: "create" | "replace"): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const parsedProfile = runTargetProfileSchema.parse(profile);
  const existingProfiles = bundle.project.settings.runTargetProfiles;
  const hasProfile = existingProfiles.some((item) => item.id === parsedProfile.id);
  if (hasProfile && mode === "create") throw new Error(`Run target profile ${parsedProfile.id} already exists.`);
  await updateProjectSettings(projectRoot, {
    ...bundle.project.settings,
    runTargetProfiles: hasProfile
      ? existingProfiles.map((item) => item.id === parsedProfile.id ? parsedProfile : item)
      : [...existingProfiles, parsedProfile]
  });
}

export async function createNode(projectRoot: string, flowId: string, proposed: Extract<ResearchOperation, { kind: "create-node" }>["node"]): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  if (proposed.stage === "plan-approved" || proposed.stage === "draft-approved-production" || proposed.ignored || proposed.locked || proposed.flags.includes("user-approved")) {
    throw new Error("Research-created nodes cannot be born approved, locked, or ignored.");
  }
  const nodeId = proposed.id ?? id("node");
  if (flow.nodes.some((node) => node.id === nodeId)) throw new Error(`Node ${nodeId} already exists.`);
  if (proposed.subflowId && !flow.subflows.some((subflow) => subflow.id === proposed.subflowId)) {
    throw new Error(`Subflow ${proposed.subflowId} was not found.`);
  }
  if (proposed.groupId && !flow.groups.some((group) => group.id === proposed.groupId)) {
    throw new Error(`Group ${proposed.groupId} was not found.`);
  }
  const normalized = normalizeResearchCreateNode(flow, proposed);
  const node = archicodeNodeSchema.parse({
    ...normalized,
    ...(normalized.implementationScope
      ? { implementationScope: { ...normalized.implementationScope, checkedAt: iso() } }
      : {}),
    id: nodeId,
    position: normalized.position ?? { x: 120 + flow.nodes.length * 36, y: 120 + flow.nodes.length * 28 },
    flags: Array.from(new Set([...(normalized.flags ?? []), "changed"])),
    updatedAt: iso()
  });
  await saveFlow(projectRoot, { ...flow, nodes: [...flow.nodes, node], updatedAt: iso() });
}

export async function createEdge(projectRoot: string, flowId: string, proposed: Partial<FlowEdge> & Pick<FlowEdge, "source" | "target">): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  if (!flow.nodes.some((node) => node.id === proposed.source)) throw new Error(`Source node ${proposed.source} was not found.`);
  if (!flow.nodes.some((node) => node.id === proposed.target)) throw new Error(`Target node ${proposed.target} was not found.`);
  if (proposed.source === proposed.target) throw new Error("Research edge cannot connect a node to itself.");
  const edge = flowEdgeSchema.parse({ ...proposed, id: proposed.id ?? id("edge") });
  if (flow.edges.some((item) => item.id === edge.id)) throw new Error(`Edge ${edge.id} already exists.`);
  if (flow.edges.some((item) => item.source === edge.source && item.target === edge.target)) {
    throw new Error(`Edge ${edge.source} -> ${edge.target} already exists.`);
  }
  await saveFlow(projectRoot, { ...flow, edges: [...flow.edges, edge], updatedAt: iso() });
  await recordGraphChange(projectRoot, {
    flowId,
    actor: "accepted-research",
    kind: "edge-created",
    summary: `Created edge ${edge.source} -> ${edge.target}${edge.label ? ` (${edge.label})` : ""}.`,
    nodeIds: [edge.source, edge.target],
    edgeIds: [edge.id],
    fieldPaths: ["source", "target", ...(edge.label ? ["label"] : [])],
    snippets: [
      { path: "source", after: edge.source },
      { path: "target", after: edge.target },
      ...(edge.label ? [{ path: "label", after: edge.label }] : [])
    ]
  });
}

export async function createGroup(projectRoot: string, flowId: string, proposed: Partial<FlowGroup> & Pick<FlowGroup, "name">): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  const group = flowGroupSchema.parse({ ...proposed, id: proposed.id ?? id("group") });
  if (flow.groups.some((item) => item.id === group.id)) throw new Error(`Group ${group.id} already exists.`);
  await saveFlow(projectRoot, { ...flow, groups: [...flow.groups, group], updatedAt: iso() });
  await recordGraphChange(projectRoot, {
    flowId,
    actor: "accepted-research",
    kind: "group-created",
    summary: `Created group "${group.name}".`,
    groupIds: [group.id],
    fieldPaths: ["name", ...(group.color ? ["color"] : [])],
    snippets: [
      { path: "name", after: group.name },
      ...(group.color ? [{ path: "color", after: group.color }] : [])
    ]
  });
}

export async function updateGroup(
  projectRoot: string,
  flowId: string,
  groupId: string,
  patch: Partial<Pick<FlowGroup, "name" | "color">>
): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  const group = flow.groups.find((item) => item.id === groupId);
  if (!group) throw new Error(`Group ${groupId} was not found.`);
  const nextGroup = flowGroupSchema.parse({ ...group, ...patch, id: group.id });
  const fieldPaths = ["name", "color"].filter((fieldPath) =>
    (group as unknown as Record<string, unknown>)[fieldPath] !== (nextGroup as unknown as Record<string, unknown>)[fieldPath]
  );
  if (!fieldPaths.length) return;
  await saveFlow(projectRoot, {
    ...flow,
    groups: flow.groups.map((item) => item.id === groupId ? nextGroup : item),
    updatedAt: iso()
  });
  await recordGraphChange(projectRoot, {
    flowId,
    actor: "accepted-research",
    kind: "group-updated",
    summary: `Updated group "${nextGroup.name}".`,
    groupIds: [groupId],
    fieldPaths,
    snippets: fieldPaths.map((fieldPath) => ({
      path: fieldPath,
      before: String((group as unknown as Record<string, unknown>)[fieldPath] ?? ""),
      after: String((nextGroup as unknown as Record<string, unknown>)[fieldPath] ?? "")
    }))
  });
}

export async function deleteGroup(projectRoot: string, flowId: string, groupId: string): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  const group = flow.groups.find((item) => item.id === groupId);
  if (!group) throw new Error(`Group ${groupId} was not found.`);
  const members = flow.nodes.filter((node) => node.groupId === groupId);
  const approvedMember = members.find((node) => isProductionApproved(node));
  if (approvedMember) {
    throw new Error(`Group ${groupId} contains approved node "${approvedMember.title}". Revise that node before deleting the group.`);
  }
  const nowValue = iso();
  await saveFlow(projectRoot, {
    ...flow,
    groups: flow.groups.filter((item) => item.id !== groupId),
    nodes: flow.nodes.map((node) => node.groupId === groupId ? { ...node, groupId: undefined, updatedAt: nowValue } : node),
    updatedAt: nowValue
  });
  await recordGraphChange(projectRoot, {
    flowId,
    actor: "accepted-research",
    kind: "group-deleted",
    summary: `Deleted group "${group.name}" and cleared ${members.length} membership${members.length === 1 ? "" : "s"}.`,
    nodeIds: members.map((node) => node.id),
    groupIds: [groupId],
    fieldPaths: ["groups", ...members.map((node) => `nodes.${node.id}.groupId`)],
    snippets: [
      { path: "groups", before: group.name },
      ...members.map((node) => ({ path: `nodes.${node.id}.groupId`, before: groupId, after: "" }))
    ]
  });
}

export async function createSubflow(projectRoot: string, flowId: string, proposed: Partial<FlowSubflow> & Pick<FlowSubflow, "name">): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  const subflow = flowSubflowSchema.parse({ ...proposed, id: proposed.id ?? id("subflow") });
  if (flow.subflows.some((item) => item.id === subflow.id)) throw new Error(`Subflow ${subflow.id} already exists.`);
  if (subflow.parentNodeId && !flow.nodes.some((node) => node.id === subflow.parentNodeId)) {
    throw new Error(`Parent node ${subflow.parentNodeId} was not found.`);
  }
  if (subflow.parentSubflowId && !flow.subflows.some((item) => item.id === subflow.parentSubflowId)) {
    throw new Error(`Parent subflow ${subflow.parentSubflowId} was not found.`);
  }
  await saveFlow(projectRoot, { ...flow, subflows: [...flow.subflows, subflow], updatedAt: iso() });
  await recordGraphChange(projectRoot, {
    flowId,
    actor: "accepted-research",
    kind: "subflow-created",
    summary: `Created subflow "${subflow.name}".`,
    nodeIds: subflow.parentNodeId ? [subflow.parentNodeId] : [],
    subflowIds: [subflow.id],
    fieldPaths: ["name", "parentNodeId", "parentSubflowId"],
    snippets: [
      { path: "name", after: subflow.name },
      ...(subflow.parentNodeId ? [{ path: "parentNodeId", after: subflow.parentNodeId }] : []),
      ...(subflow.parentSubflowId ? [{ path: "parentSubflowId", after: subflow.parentSubflowId }] : [])
    ]
  });
}

export async function updateSubflow(projectRoot: string, flowId: string, subflowId: string, patch: { name?: string }): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  const subflow = flow.subflows.find((item) => item.id === subflowId);
  if (!subflow) throw new Error(`Subflow ${subflowId} was not found.`);
  const name = patch.name === undefined ? subflow.name : patch.name.trim();
  if (!name) throw new Error("Subflow name cannot be empty.");
  const nextSubflow = flowSubflowSchema.parse({ ...subflow, name });
  const fieldPaths = [
    ...(nextSubflow.name !== subflow.name ? ["name"] : [])
  ];
  await saveFlow(projectRoot, {
    ...flow,
    subflows: flow.subflows.map((item) => item.id === subflowId ? nextSubflow : item),
    updatedAt: iso()
  });
  if (fieldPaths.length) {
    await recordGraphChange(projectRoot, {
      flowId,
      actor: "accepted-research",
      kind: "subflow-updated",
      summary: `Updated detail flow "${nextSubflow.name}" (${fieldPaths.join(", ")}).`,
      nodeIds: nextSubflow.parentNodeId ? [nextSubflow.parentNodeId] : [],
      subflowIds: [subflowId],
      fieldPaths,
      snippets: fieldPaths.map((fieldPath) => ({
        path: fieldPath,
        before: String((subflow as unknown as Record<string, unknown>)[fieldPath] ?? ""),
        after: String((nextSubflow as unknown as Record<string, unknown>)[fieldPath] ?? "")
      }))
    });
  }
}

export async function linkNodeSubflow(projectRoot: string, flowId: string, nodeId: string, subflowId: string | null): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  if (!flow.nodes.some((node) => node.id === nodeId)) throw new Error(`Node ${nodeId} was not found.`);
  if (subflowId !== null && !flow.subflows.some((subflow) => subflow.id === subflowId)) {
    throw new Error(`Subflow ${subflowId} was not found.`);
  }
  await saveFlow(projectRoot, linkNodeToSubflow(flow, nodeId, subflowId));
  await recordGraphChange(projectRoot, {
    flowId,
    actor: "accepted-research",
    kind: "node-subflow-linked",
    summary: subflowId ? `Linked node ${nodeId} to subflow ${subflowId}.` : `Unlinked node ${nodeId} from its detail subflow.`,
    nodeIds: [nodeId],
    subflowIds: subflowId ? [subflowId] : [],
    fieldPaths: ["parentNodeId", "parentSubflowId"],
    snippets: [{ path: "subflowId", after: subflowId ?? "null" }]
  });
}

export async function deleteNode(projectRoot: string, flowId: string, nodeId: string): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  const node = flow.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} was not found.`);
  if (isProductionApproved(node)) throw new Error(`Node "${node.title}" is approved and locked. Create a revision before deleting it.`);
  await saveFlow(projectRoot, {
    ...flow,
    nodes: flow.nodes.filter((item) => item.id !== nodeId),
    edges: flow.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    subflows: flow.subflows.map((subflow) => subflow.parentNodeId === nodeId ? { ...subflow, parentNodeId: undefined } : subflow),
    updatedAt: iso()
  });
  await recordGraphChange(projectRoot, {
    flowId,
    actor: "accepted-research",
    kind: "node-deleted",
    summary: `Deleted node "${node.title}".`,
    nodeIds: [node.id],
    fieldPaths: ["title", "description", "type", "stage"],
    snippets: [
      { path: "title", before: node.title },
      { path: "description", before: node.description },
      { path: "type", before: node.type },
      { path: "stage", before: node.stage }
    ]
  });
}

export async function deleteEdge(projectRoot: string, flowId: string, edgeId: string): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  const edge = flow.edges.find((item) => item.id === edgeId);
  if (!edge) throw new Error(`Edge ${edgeId} was not found.`);
  await saveFlow(projectRoot, { ...flow, edges: flow.edges.filter((edge) => edge.id !== edgeId), updatedAt: iso() });
  await recordGraphChange(projectRoot, {
    flowId,
    actor: "accepted-research",
    kind: "edge-deleted",
    summary: `Deleted edge ${edge.source} -> ${edge.target}${edge.label ? ` (${edge.label})` : ""}.`,
    nodeIds: [edge.source, edge.target],
    edgeIds: [edge.id],
    fieldPaths: ["source", "target", ...(edge.label ? ["label"] : [])],
    snippets: [
      { path: "source", before: edge.source },
      { path: "target", before: edge.target },
      ...(edge.label ? [{ path: "label", before: edge.label }] : [])
    ]
  });
}

export async function deleteSubflow(projectRoot: string, flowId: string, subflowId: string): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = findFlow(bundle, flowId);
  const subflow = flow.subflows.find((item) => item.id === subflowId);
  if (!subflow) throw new Error(`Subflow ${subflowId} was not found.`);
  await saveFlow(projectRoot, deleteSubflowFromFlow(flow, subflowId));
  await recordGraphChange(projectRoot, {
    flowId,
    actor: "accepted-research",
    kind: "subflow-deleted",
    summary: `Deleted subflow "${subflow.name}".`,
    nodeIds: subflow.parentNodeId ? [subflow.parentNodeId] : [],
    subflowIds: [subflow.id],
    fieldPaths: ["name", "parentNodeId", "parentSubflowId"],
    snippets: [
      { path: "name", before: subflow.name },
      ...(subflow.parentNodeId ? [{ path: "parentNodeId", before: subflow.parentNodeId }] : []),
      ...(subflow.parentSubflowId ? [{ path: "parentSubflowId", before: subflow.parentSubflowId }] : [])
    ]
  });
}
