import { researchChatResponseSchema, researchMemoryDeltaSchema, type ResearchChatResponse, type ResearchMemoryDelta } from "./schema";

const runGuidanceEvidenceKinds = new Set(["last-error", "trace-tail", "latest-diff", "runtime-log", "node-notes"]);

type ResearchExtractionResult = {
  response: ResearchChatResponse | null;
  errors: string[];
};

type ResearchMemoryDeltaExtractionResult = {
  delta: ResearchMemoryDelta | null;
  errors: string[];
};

export function extractArchicodeResearch(output: string): ResearchExtractionResult {
  const candidates = collectJsonCandidates(output);
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const payload = normalizeResearchPayload(parsed);
      const result = researchChatResponseSchema.safeParse(payload);
      if (result.success) return { response: result.data, errors };
      errors.push(...result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { response: null, errors };
}

export function extractResearchMemoryDelta(output: string): ResearchMemoryDeltaExtractionResult {
  const candidates = collectJsonCandidates(output);
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const payload = normalizeMemoryDeltaPayload(parsed);
      const result = researchMemoryDeltaSchema.safeParse(payload);
      if (result.success) return { delta: result.data, errors };
      errors.push(...result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { delta: null, errors: [...new Set(errors)] };
}

function collectJsonCandidates(output: string): string[] {
  const candidates = new Set<string>();
  const fenced = output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fenced) {
    const value = match[1]?.trim();
    if (value) candidates.add(value);
  }

  const keyIndex = output.indexOf("\"archicodeResearch\"");
  if (keyIndex >= 0) {
    const outerStart = output.lastIndexOf("{", keyIndex);
    const innerStart = output.indexOf("{", keyIndex + "\"archicodeResearch\"".length);
    const outer = outerStart >= 0 ? readBalancedObject(output, outerStart) : null;
    const inner = innerStart >= 0 ? readBalancedObject(output, innerStart) : null;
    if (outer) candidates.add(outer);
    if (inner) candidates.add(inner);
  }

  for (const key of ["\"researchMemoryDelta\"", "\"memoryDelta\"", "\"archicodeResearchMemory\""]) {
    const memoryKeyIndex = output.indexOf(key);
    if (memoryKeyIndex < 0) continue;
    const outerStart = output.lastIndexOf("{", memoryKeyIndex);
    const innerStart = output.indexOf("{", memoryKeyIndex + key.length);
    const outer = outerStart >= 0 ? readBalancedObject(output, outerStart) : null;
    const inner = innerStart >= 0 ? readBalancedObject(output, innerStart) : null;
    if (outer) candidates.add(outer);
    if (inner) candidates.add(inner);
  }

  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") continue;
    const object = readBalancedObject(output, index);
    if (object && (object.includes("answer") || object.includes("memoryDelta") || object.includes("researchMemoryDelta") || object.includes("archicodeResearchMemory"))) candidates.add(object);
  }

  return [...candidates];
}

function readBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function normalizeResearchPayload(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const record = parsed as Record<string, unknown>;
  const payload = "archicodeResearch" in record ? record.archicodeResearch : parsed;
  if (!payload || typeof payload !== "object") return normalizeGraphOperations(payload);
  const payloadRecord = payload as Record<string, unknown>;
  const { memoryDelta: _memoryDelta, researchMemoryDelta: _researchMemoryDelta, archicodeResearchMemory: _archicodeResearchMemory, ...rest } = payloadRecord;
  return normalizeGraphOperations(rest);
}

function normalizeMemoryDeltaPayload(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const record = parsed as Record<string, unknown>;
  if ("researchMemoryDelta" in record) return normalizeMemoryDelta(record.researchMemoryDelta);
  if ("memoryDelta" in record) return normalizeMemoryDelta(record.memoryDelta);
  if ("archicodeResearchMemory" in record) return normalizeMemoryDelta(record.archicodeResearchMemory);
  if ("archicodeResearch" in record && record.archicodeResearch && typeof record.archicodeResearch === "object") {
    const research = record.archicodeResearch as Record<string, unknown>;
    if ("memoryDelta" in research) return normalizeMemoryDelta(research.memoryDelta);
  }
  return normalizeMemoryDelta(parsed);
}

function normalizeMemoryDelta(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  const decisions = normalizeMemoryTextRecords(record.decisions);
  const todos = Array.isArray(record.todos)
    ? record.todos.map(normalizeMemoryTodo).filter(Boolean)
    : record.todos;
  const facts = normalizeMemoryTextRecords(record.facts);
  const assumptions = normalizeMemoryTextRecords(record.assumptions);
  const debugFindings = normalizeMemoryTextRecords(record.debugFindings);
  const links = Array.isArray(record.links)
    ? record.links.map(normalizeMemoryLink).filter(Boolean)
    : record.links;
  const graphRefs = Array.isArray(record.graphRefs)
    ? record.graphRefs.map(normalizeMemoryGraphRef)
    : record.graphRefs;
  const openQuestions = Array.isArray(record.openQuestions)
    ? record.openQuestions.map(normalizeMemoryQuestion).filter(Boolean)
    : record.openQuestions;
  const fileRefs = firstArray(record.fileRefs, record.files, record.fileReferences, record.projectFiles)
    ?.map(normalizeMemoryFileRef).filter(Boolean);
  const artifactRefs = firstArray(record.artifactRefs, record.artifacts, record.artifactReferences)
    ?.map(normalizeMemoryArtifactRef).filter(Boolean);
  const imageRefs = firstArray(record.imageRefs, record.images, record.imageReferences, record.screenshots, record.screenshotRefs)
    ?.map(normalizeMemoryImageRef).filter(Boolean);
  return {
    ...record,
    ...(decisions ? { decisions } : {}),
    ...(Array.isArray(record.todos) ? { todos } : {}),
    ...(facts ? { facts } : {}),
    ...(assumptions ? { assumptions } : {}),
    ...(debugFindings ? { debugFindings } : {}),
    ...(Array.isArray(record.links) ? { links } : {}),
    ...(Array.isArray(record.graphRefs) ? { graphRefs } : {}),
    ...(Array.isArray(record.openQuestions) ? { openQuestions } : {}),
    ...(fileRefs ? { fileRefs } : {}),
    ...(artifactRefs ? { artifactRefs } : {}),
    ...(imageRefs ? { imageRefs } : {})
  };
}

function normalizeMemoryTodo(todo: unknown): unknown {
  if (typeof todo === "string" && todo.trim()) return { title: todo.trim() };
  if (!todo || typeof todo !== "object") return null;
  const record = todo as Record<string, unknown>;
  const title = firstString(
    record.title,
    record.text,
    record.todo,
    record.task,
    record.label,
    record.summary,
    record.description
  );
  if (!title) return null;
  const status = normalizeMemoryTodoStatus(record.status);
  const rest = { ...record };
  delete rest.status;
  return {
    ...rest,
    title,
    ...(status ? { status } : {})
  };
}

function normalizeMemoryStatusToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
  return normalized || undefined;
}

function normalizeMemoryTodoStatus(value: unknown): "open" | "awaiting-approval" | "doing" | "blocked" | "done" | "cancelled" | undefined {
  const status = normalizeMemoryStatusToken(value);
  if (!status) return undefined;
  if (["open", "awaiting-approval", "doing", "blocked", "done", "cancelled"].includes(status)) {
    return status as "open" | "awaiting-approval" | "doing" | "blocked" | "done" | "cancelled";
  }
  if (["pending", "todo", "to-do", "not-started", "queued", "new"].includes(status)) return "open";
  if (["in-progress", "inprogress", "active", "working", "started"].includes(status)) return "doing";
  if (["awaiting-review", "pending-review", "waiting-review", "awaiting-confirmation", "pending-approval", "needs-approval"].includes(status)) return "awaiting-approval";
  if (["awaiting-user", "waiting-user", "waiting-for-user", "waiting-on-user", "needs-user", "needs-input", "stuck"].includes(status)) return "blocked";
  if (["complete", "completed", "finished", "closed", "resolved"].includes(status)) return "done";
  if (["canceled", "abandoned", "dropped"].includes(status)) return "cancelled";
  // A model-invented status must not invalidate an otherwise useful memory
  // update. Omitting it lets the schema default new items to "open" and lets
  // the merge preserve an existing item's current status.
  return undefined;
}

function normalizeMemoryTextRecords(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    if (typeof item === "string" && item.trim()) return { text: item.trim() };
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    const text = firstString(
      record.text,
      record.fact,
      record.assumption,
      record.decision,
      record.finding,
      record.summary,
      record.note,
      record.description
    );
    return text && !("text" in record) ? { ...record, text } : item;
  }).filter(Boolean);
}

function normalizeMemoryLink(link: unknown): unknown {
  if (typeof link === "string" && link.trim()) return { url: link.trim() };
  if (!link || typeof link !== "object") return null;
  const record = link as Record<string, unknown>;
  const url = firstString(record.url, record.href, record.link, record.uri, record.source, record.reference);
  return url ? { ...record, url } : null;
}

function normalizeMemoryFileRef(ref: unknown): unknown {
  if (typeof ref === "string" && ref.trim()) return { path: ref.trim() };
  if (!ref || typeof ref !== "object") return ref;
  const record = ref as Record<string, unknown>;
  const filePath = firstString(record.path, record.filePath, record.relativePath, record.projectPath, record.url);
  return filePath ? { ...record, path: filePath } : ref;
}

function normalizeMemoryArtifactRef(ref: unknown): unknown {
  if (typeof ref === "string" && ref.trim()) return { artifactId: ref.trim() };
  if (!ref || typeof ref !== "object") return ref;
  const record = ref as Record<string, unknown>;
  const artifactId = firstString(record.artifactId, record.id, record.artifact, record.refId);
  return artifactId ? { ...record, artifactId } : ref;
}

function normalizeMemoryImageRef(ref: unknown): unknown {
  if (typeof ref === "string" && ref.trim()) return { artifactId: ref.trim() };
  if (!ref || typeof ref !== "object") return ref;
  const record = ref as Record<string, unknown>;
  const artifactId = firstString(record.artifactId, record.id, record.imageId, record.screenshotId, record.refId);
  const visualSummary = firstString(record.visualSummary, record.summary, record.description, record.note);
  return artifactId ? { ...record, artifactId, ...(visualSummary ? { visualSummary } : {}) } : ref;
}

function normalizeMemoryQuestion(question: unknown): unknown {
  if (!question || typeof question !== "object") {
    return typeof question === "string" && question.trim() ? { question: question.trim() } : question;
  }
  const record = question as Record<string, unknown>;
  const text = firstString(
    record.question,
    record.text,
    record.title,
    record.prompt,
    record.label,
    record.description
  );
  if (!text) return question;
  const status = normalizeMemoryQuestionStatus(record.status);
  const rest = { ...record };
  delete rest.status;
  return {
    ...rest,
    question: text,
    ...(status ? { status } : {})
  };
}

function normalizeMemoryQuestionStatus(value: unknown): "open" | "answered" | "resolved" | undefined {
  const status = normalizeMemoryStatusToken(value);
  if (!status) return undefined;
  if (["open", "answered", "resolved"].includes(status)) return status as "open" | "answered" | "resolved";
  if (["pending", "unanswered", "awaiting-user", "waiting-user", "waiting-for-user", "waiting-on-user", "needs-input", "unknown"].includes(status)) return "open";
  if (["responded", "replied", "response-received"].includes(status)) return "answered";
  if (["done", "complete", "completed", "closed", "settled"].includes(status)) return "resolved";
  return undefined;
}

function normalizeMemoryGraphRef(ref: unknown): unknown {
  if (!ref || typeof ref !== "object") return ref;
  const record = ref as Record<string, unknown>;
  const normalizedRecord = Object.fromEntries(Object.entries(record).filter(([key, value]) => (
    value !== null || !["flowId", "subflowId", "nodeId", "title", "note"].includes(key)
  )));
  const explicitKind = normalizeGraphRefKind(firstString(
    record.kind,
    record.type,
    record.refKind,
    record.graphKind
  ));
  const inferredKind = explicitKind ?? inferGraphRefKind(record);
  return {
    ...normalizedRecord,
    ...(inferredKind ? { kind: inferredKind } : {})
  };
}

function normalizeGraphRefKind(value: string | undefined): "project" | "flow" | "subflow" | "node" | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized === "project") return "project";
  if (normalized === "flow") return "flow";
  if (normalized === "subflow" || normalized === "sub-flow") return "subflow";
  if (normalized === "node") return "node";
  return undefined;
}

function inferGraphRefKind(record: Record<string, unknown>): "project" | "flow" | "subflow" | "node" | undefined {
  if (firstString(record.nodeId, record.node, record.node_id)) return "node";
  if (firstString(record.subflowId, record.subflow, record.subflow_id, record.detailFlowId)) return "subflow";
  if (firstString(record.flowId, record.flow, record.flow_id)) return "flow";
  if (firstString(record.projectId, record.project, record.project_id)) return "project";
  return undefined;
}

function normalizeGraphOperations(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  const changeSet = record.changeSet;
  if (!changeSet || typeof changeSet !== "object") return payload;
  const changeSetRecord = changeSet as Record<string, unknown>;
  const operations = Array.isArray(changeSetRecord.operations)
    ? changeSetRecord.operations.map(normalizeGraphOperation)
    : changeSetRecord.operations;
  return {
    ...record,
    changeSet: {
      ...changeSetRecord,
      operations
    }
  };
}

function normalizeGraphOperation(operation: unknown): unknown {
  if (!operation || typeof operation !== "object") return operation;
  const record = operation as Record<string, unknown>;
  const normalizedGuidance = normalizeRunGuidance(record.guidance);
  const normalizedRecord = normalizedGuidance ? { ...record, guidance: normalizedGuidance } : record;
  if (record.kind === "update-node") return normalizeUpdateNodeOperation(normalizedRecord);
  if (record.kind === "create-node") return normalizeCreateNodeOperation(normalizedRecord);
  if (record.kind === "create-subflow") return normalizeCreateSubflowOperation(normalizedRecord);
  if (record.kind === "update-subflow") return normalizeUpdateSubflowOperation(normalizedRecord);
  if (record.kind === "link-node-subflow") return normalizeLinkNodeSubflowOperation(normalizedRecord);
  if (record.kind !== "create-edge") return normalizedRecord;
  const edgeRecord = record.edge && typeof record.edge === "object" ? record.edge as Record<string, unknown> : {};
  const source = firstString(
    edgeRecord.source,
    edgeRecord.sourceId,
    edgeRecord.from,
    edgeRecord.fromId,
    edgeRecord.fromNode,
    edgeRecord.fromNodeId,
    edgeRecord.sourceNode,
    edgeRecord.sourceNodeId,
    record.source,
    record.sourceId,
    record.from,
    record.fromId,
    record.fromNode,
    record.fromNodeId
  );
  const target = firstString(
    edgeRecord.target,
    edgeRecord.targetId,
    edgeRecord.to,
    edgeRecord.toId,
    edgeRecord.toNode,
    edgeRecord.toNodeId,
    edgeRecord.targetNode,
    edgeRecord.targetNodeId,
    record.target,
    record.targetId,
    record.to,
    record.toId,
    record.toNode,
    record.toNodeId
  );
  return {
    ...normalizedRecord,
    edge: {
      ...edgeRecord,
      ...(source ? { source } : {}),
      ...(target ? { target } : {})
    }
  };
}

function normalizeUpdateNodeOperation(record: Record<string, unknown>): unknown {
  const patchRecord = record.patch && typeof record.patch === "object" ? { ...(record.patch as Record<string, unknown>) } : {};
  const id = firstString(patchRecord.id, record.nodeId, record.id);
  const exactPosition = normalizeExactNodePosition(patchRecord.position ?? record.position);
  const relativePosition = exactPosition ? null : normalizeRelativeNodePosition(
    patchRecord.positionHint ??
    patchRecord.position ??
    record.positionHint ??
    record.position ??
    patchRecord.layout ??
    record.layout
  );

  if (exactPosition) {
    patchRecord.position = exactPosition;
  } else if (relativePosition) {
    delete patchRecord.position;
    patchRecord.positionHint = relativePosition;
  }

  return {
    ...record,
    patch: {
      ...patchRecord,
      ...(id ? { id } : {})
    }
  };
}

function normalizeRunGuidance(guidance: unknown): unknown {
  if (!guidance || typeof guidance !== "object") return guidance;
  const record = guidance as Record<string, unknown>;
  const text = firstString(record.text, record.guidance, record.note, record.summary, record.instructions) ?? "";
  const rawEvidence = firstStringArray(record.evidence, record.evidenceKinds, record.includeEvidence);
  const evidence = rawEvidence.filter((item) => runGuidanceEvidenceKinds.has(item));
  const invalidEvidence = rawEvidence.filter((item) => !runGuidanceEvidenceKinds.has(item));
  const referenceText = invalidEvidence.length
    ? `Referenced graph/context ids from model evidence: ${invalidEvidence.join(", ")}.`
    : "";
  return {
    ...record,
    text: [text, referenceText].filter(Boolean).join(text && referenceText ? "\n" : ""),
    evidence
  };
}

function normalizeCreateNodeOperation(record: Record<string, unknown>): unknown {
  const nodeRecord = record.node && typeof record.node === "object" ? record.node as Record<string, unknown> : {};
  const {
    visual: _visual,
    shape: _shape,
    backgroundColor: _backgroundColor,
    color: _color,
    position: _position,
    positionHint: _positionHint,
    layout: _layout,
    ...nodeFields
  } = nodeRecord;
  const id = firstString(nodeRecord.id, record.id, record.nodeId);
  const type = firstString(nodeRecord.type, nodeRecord.kind, record.type, record.nodeType);
  const title = firstString(
    nodeRecord.title,
    nodeRecord.name,
    nodeRecord.label,
    nodeRecord.displayName,
    nodeRecord.heading,
    record.title,
    record.name,
    record.label,
    record.displayName,
    record.heading
  );
  const subflowId = firstString(
    nodeRecord.subflowId,
    nodeRecord.subflow_id,
    nodeRecord.subflow,
    nodeRecord.flow,
    nodeRecord.detailFlowId,
    record.subflowId,
    record.subflow_id,
    record.subflow,
    record.detailFlowId
  );
  const parentId = firstString(nodeRecord.parentId, nodeRecord.parent, record.parentId, record.parent);
  const description = firstString(
    nodeRecord.description,
    nodeRecord.responsibility,
    nodeRecord.responsibilities,
    nodeRecord.purpose,
    record.description,
    record.responsibility,
    record.responsibilities,
    record.purpose
  );
  const techStack = firstStringArray(
    nodeRecord.techStack,
    nodeRecord.technologies,
    nodeRecord.technology,
    nodeRecord.stack,
    nodeRecord.frameworks,
    record.techStack,
    record.technologies,
    record.technology,
    record.stack,
    record.frameworks
  );
  const acceptanceCriteria = firstStringArray(
    nodeRecord.acceptanceCriteria,
    nodeRecord.acceptance_criteria,
    nodeRecord.criteria,
    nodeRecord.expectedBehavior,
    nodeRecord.responsibilities,
    record.acceptanceCriteria,
    record.acceptance_criteria,
    record.criteria,
    record.expectedBehavior,
    record.responsibilities
  );
  const exactPosition = normalizeExactNodePosition(nodeRecord.position ?? record.position);
  const relativePosition = exactPosition ? null : normalizeRelativeNodePosition(
    nodeRecord.positionHint ??
    nodeRecord.position ??
    record.positionHint ??
    record.position ??
    nodeRecord.layout ??
    record.layout
  );
  return {
    ...record,
    node: {
      ...nodeFields,
      ...(id ? { id } : {}),
      ...(type ? { type } : {}),
      ...(title ? { title } : {}),
      ...(subflowId ? { subflowId } : {}),
      ...(parentId ? { parentId } : {}),
      ...(description ? { description } : {}),
      ...(techStack.length ? { techStack } : {}),
      ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
      ...(exactPosition ? { position: exactPosition } : {}),
      ...(relativePosition ? { positionHint: relativePosition } : {})
    }
  };
}

function normalizeCreateSubflowOperation(record: Record<string, unknown>): unknown {
  const subflowRecord = record.subflow && typeof record.subflow === "object" ? record.subflow as Record<string, unknown> : {};
  const name = firstString(
    subflowRecord.name,
    subflowRecord.title,
    subflowRecord.label,
    subflowRecord.displayName,
    record.name,
    record.title,
    record.label,
    record.displayName
  );
  return {
    ...record,
    subflow: {
      ...subflowRecord,
      ...(name ? { name } : {})
    }
  };
}

function normalizeUpdateSubflowOperation(record: Record<string, unknown>): unknown {
  const subflowRecord = record.subflow && typeof record.subflow === "object" ? record.subflow as Record<string, unknown> : {};
  const patchRecord = record.patch && typeof record.patch === "object" ? record.patch as Record<string, unknown> : {};
  const subflowId = firstString(
    record.subflowId,
    record.detailFlowId,
    record.subflow,
    subflowRecord.id,
    subflowRecord.subflowId,
    subflowRecord.detailFlowId
  );
  const name = firstString(
    patchRecord.name,
    patchRecord.title,
    patchRecord.label,
    patchRecord.displayName,
    subflowRecord.name,
    subflowRecord.title,
    subflowRecord.label,
    subflowRecord.displayName,
    record.name,
    record.title,
    record.label,
    record.displayName
  );
  return {
    ...record,
    ...(subflowId ? { subflowId } : {}),
    patch: {
      ...patchRecord,
      ...(name ? { name } : {})
    }
  };
}

function normalizeLinkNodeSubflowOperation(record: Record<string, unknown>): unknown {
  const nodeRecord = record.node && typeof record.node === "object" ? record.node as Record<string, unknown> : {};
  const subflowRecord = record.subflow && typeof record.subflow === "object" ? record.subflow as Record<string, unknown> : {};
  const nodeId = firstString(record.nodeId, record.node, record.parentNodeId, nodeRecord.id, nodeRecord.nodeId);
  const subflowId = firstNullableString(
    record.subflowId,
    record.detailFlowId,
    record.opensDetailFlow,
    record.subflow,
    subflowRecord.id,
    subflowRecord.subflowId,
    subflowRecord.detailFlowId
  );
  return {
    ...record,
    ...(nodeId ? { nodeId } : {}),
    ...(subflowId !== undefined ? { subflowId } : {})
  };
}

function normalizeExactNodePosition(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.x !== "number" || typeof record.y !== "number") return null;
  return { x: record.x, y: record.y };
}

function normalizeRelativeNodePosition(value: unknown): { relativeToNodeId: string; placement: "above" | "below" | "left" | "right" } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const relativeToNodeId = firstString(
    record.relativeToNodeId,
    record.relativeTo,
    record.anchorNodeId,
    record.anchorId,
    record.nodeId,
    record.targetNodeId
  );
  const placement = normalizeNodePlacement(firstString(
    record.placement,
    record.side,
    record.direction,
    record.relation
  ));
  if (!relativeToNodeId || !placement) return null;
  return { relativeToNodeId, placement };
}

function normalizeNodePlacement(value: string | undefined): "above" | "below" | "left" | "right" | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized === "above" || normalized === "below" || normalized === "left" || normalized === "right") {
    return normalized;
  }
  return null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNullableString(...values: unknown[]): string | null | undefined {
  for (const value of values) {
    if (value === null) return null;
    if (typeof value === "string") return value.trim() ? value.trim() : null;
  }
  return undefined;
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function firstStringArray(...values: unknown[]): string[] {
  for (const value of values) {
    const normalized = normalizeStringArray(value);
    if (normalized.length) return normalized;
  }
  return [];
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => typeof item === "string" ? [item.trim()] : []).filter(Boolean);
  }
  if (typeof value !== "string") return [];
  return value
    .split(/\n|;|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}
