import { llmPatchProposalSchema, type LlmPatchProposal } from "./schema";

export type QuarantinedPatchOperation = {
  operationIndex: number;
  kind?: string;
  reason: string;
  operation: unknown;
};

type ExtractionOptions = {
  phase?: string;
};

type ExtractionResult = {
  proposal: LlmPatchProposal | null;
  errors: string[];
  quarantinedOperations: QuarantinedPatchOperation[];
  warnings: string[];
};

export function extractArchicodePatch(output: string, runId: string, options: ExtractionOptions = {}): ExtractionResult {
  const candidates = collectJsonCandidates(output);
  const errors: string[] = [];
  const quarantinedOperations: QuarantinedPatchOperation[] = [];
  const warnings: string[] = [];
  const codingSourceOnly = isCodingSourceOnlyPhase(options.phase);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const payload = normalizePatchPayload(parsed, runId);
      if (codingSourceOnly) {
        const codingPayload = sourceOnlyCodingPayload(payload);
        if (!codingPayload) {
          errors.push("coding handoff did not include an operations array.");
          continue;
        }
        if (codingPayload.sourceOperationCount === 0) {
          // A handoff with no source operations is only a failure when the
          // provider did not explicitly signal completion. When it reports
          // implementationStatus "complete" (the field the coding contract asks
          // for when the current task needs no changes), treat it as a valid
          // no-op completion rather than an unusable handoff.
          if (codingHandoffDeclaresCompletion(codingPayload.payload)) {
            const completionResult = llmPatchProposalSchema.safeParse(codingPayload.payload);
            if (completionResult.success) {
              return {
                proposal: completionResult.data,
                errors,
                quarantinedOperations: codingPayload.quarantinedOperations,
                warnings: codingPayload.quarantinedOperations.map((operation) => formatQuarantinedOperation(operation, 0))
              };
            }
            errors.push(...completionResult.error.issues.map((issue) => formatValidationIssue(issue, codingPayload.payload)));
            continue;
          }
          const quarantined = codingPayload.quarantinedOperations.map((operation) =>
            formatQuarantinedOperation(operation, codingPayload.sourceOperationCount)
          );
          errors.push(quarantined.length
            ? `coding handoff did not include usable propose-source-file operations; ${quarantined.join("; ")}`
            : "coding handoff did not include usable propose-source-file operations.");
          continue;
        }
        const result = llmPatchProposalSchema.safeParse(codingPayload.payload);
        if (result.success) {
          const candidateWarnings = codingPayload.quarantinedOperations.map((operation) =>
            formatQuarantinedOperation(operation, codingPayload.sourceOperationCount)
          );
          return {
            proposal: result.data,
            errors,
            quarantinedOperations: codingPayload.quarantinedOperations,
            warnings: candidateWarnings
          };
        }
        errors.push(...result.error.issues.map((issue) => formatValidationIssue(issue, codingPayload.payload)));
        continue;
      }
      const result = llmPatchProposalSchema.safeParse(payload);
      if (result.success) return { proposal: result.data, errors, quarantinedOperations, warnings };
      errors.push(...result.error.issues.map((issue) => formatValidationIssue(issue, payload)));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { proposal: null, errors, quarantinedOperations, warnings };
}

function collectJsonCandidates(output: string): string[] {
  const candidates = new Set<string>();
  for (const value of collectFencedJsonCandidates(output)) candidates.add(value);

  const keyIndex = output.indexOf("\"archicodePatch\"");
  if (keyIndex >= 0) {
    const outerStart = output.lastIndexOf("{", keyIndex);
    const innerStart = output.indexOf("{", keyIndex + "\"archicodePatch\"".length);
    const outer = outerStart >= 0 ? readBalancedObject(output, outerStart) : null;
    const inner = innerStart >= 0 ? readBalancedObject(output, innerStart) : null;
    if (outer) candidates.add(outer);
    if (inner) candidates.add(inner);
  }

  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") continue;
    const object = readBalancedObject(output, index);
    if (object && object.includes("schemaVersion") && object.includes("operations")) {
      candidates.add(object);
    }
  }

  return [...candidates];
}

function collectFencedJsonCandidates(output: string): string[] {
  const candidates: string[] = [];
  const fencePattern = /(?:^|\n)```(?:json)?[ \t]*\n/gim;
  let startMatch: RegExpExecArray | null;
  while ((startMatch = fencePattern.exec(output)) !== null) {
    const contentStart = startMatch.index + startMatch[0].length;
    const closePattern = /\n```[ \t]*(?:\n|$)/g;
    closePattern.lastIndex = contentStart;
    const closeMatch = closePattern.exec(output);
    if (!closeMatch) continue;
    const value = output.slice(contentStart, closeMatch.index).trim();
    if (value) candidates.push(value);
    fencePattern.lastIndex = closeMatch.index + closeMatch[0].length;
  }
  return candidates;
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

function normalizePatchPayload(parsed: unknown, runId: string): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const record = parsed as Record<string, unknown>;
  const payload = "archicodePatch" in record ? record.archicodePatch : record;
  if (!payload || typeof payload !== "object") return payload;
  const payloadRecord = payload as Record<string, unknown>;
  return {
    ...payloadRecord,
    runId,
    operations: Array.isArray(payloadRecord.operations)
      ? payloadRecord.operations.map(normalizeOperation)
      : payloadRecord.operations
  };
}

function normalizeOperation(operation: unknown): unknown {
  if (!operation || typeof operation !== "object") return operation;
  const record = operation as Record<string, unknown>;

  if (record.kind === "update-node" && !record.patch && typeof record.nodeId === "string") {
    const { nodeId, flowId, kind, ...rest } = record;
    const patch: Record<string, unknown> = { id: nodeId };
    for (const [key, value] of Object.entries(rest)) {
      if (key === "reason") continue;
      patch[key] = value;
    }
    return {
      kind,
      flowId: typeof flowId === "string" ? flowId : "flow-main",
      patch
    };
  }

  if (record.kind === "propose-project-file" && !record.mode && (record.action === "create" || record.action === "replace")) {
    const { action, ...rest } = record;
    return {
      ...rest,
      mode: action
    };
  }

  if (record.kind === "propose-source-file" && record.testIntent === null) {
    const { testIntent: _testIntent, ...rest } = record;
    return rest;
  }

  if (record.kind === "add-note") {
    const note = record.note && typeof record.note === "object"
      ? { ...(record.note as Record<string, unknown>) }
      : {};
    copyOperationFieldToNote(record, note, "noteKind", "kind");
    copyOperationFieldToNote(record, note, "author", "author");
    copyOperationFieldToNote(record, note, "body", "body");
    copyOperationFieldToNote(record, note, "category", "category");
    copyOperationFieldToNote(record, note, "priority", "priority");
    copyOperationFieldToNote(record, note, "resolved", "resolved");
    copyOperationFieldToNote(record, note, "pinned", "pinned");
    copyOperationFieldToNote(record, note, "attachmentIds", "attachmentIds");
    if (typeof record.flowId === "string" && typeof note.flowId !== "string") {
      note.flowId = record.flowId;
    }
    if (typeof record.nodeId === "string" && typeof note.nodeId !== "string") {
      note.nodeId = record.nodeId;
    }
    if (typeof note.flowId !== "string") {
      note.flowId = "flow-main";
    }
    if (note.kind === "llm-question" && note.category === "question") {
      note.category = "note";
    }
    return {
      kind: record.kind,
      note
    };
  }

  return operation;
}

function copyOperationFieldToNote(
  operation: Record<string, unknown>,
  note: Record<string, unknown>,
  operationKey: string,
  noteKey: string
): void {
  if (note[noteKey] !== undefined || operation[operationKey] === undefined) return;
  note[noteKey] = operation[operationKey];
}

function isCodingSourceOnlyPhase(phase: string | undefined): boolean {
  return phase === "coding" || phase === "debugging";
}

function codingHandoffDeclaresCompletion(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const runSummary = (payload as Record<string, unknown>).runSummary;
  if (!runSummary || typeof runSummary !== "object") return false;
  return (runSummary as Record<string, unknown>).implementationStatus === "complete";
}

function sourceOnlyCodingPayload(payload: unknown): {
  payload: unknown;
  sourceOperationCount: number;
  quarantinedOperations: QuarantinedPatchOperation[];
} | null {
  if (!payload || typeof payload !== "object") return null;
  const payloadRecord = payload as Record<string, unknown>;
  if (!Array.isArray(payloadRecord.operations)) return null;

  const sourceOperations: unknown[] = [];
  const quarantinedOperations: QuarantinedPatchOperation[] = [];
  for (const [operationIndex, operation] of payloadRecord.operations.entries()) {
    const kind = operation && typeof operation === "object"
      ? (operation as Record<string, unknown>).kind
      : undefined;
    if (kind === "propose-source-file") {
      sourceOperations.push(operation);
      continue;
    }
    quarantinedOperations.push({
      operationIndex,
      kind: typeof kind === "string" ? kind : undefined,
      reason: "coding handoff accepts source-file proposals only",
      operation
    });
  }

  return {
    payload: {
      ...payloadRecord,
      operations: sourceOperations
    },
    sourceOperationCount: sourceOperations.length,
    quarantinedOperations
  };
}

function formatQuarantinedOperation(operation: QuarantinedPatchOperation, retainedSourceOperations: number): string {
  const salvage = retainedSourceOperations > 0
    ? `${retainedSourceOperations} source-file proposal${retainedSourceOperations === 1 ? " was" : "s were"} valid and retained`
    : "no source-file proposals were salvageable";
  return `operation ${operation.operationIndex} ${operation.kind ?? "unknown"} quarantined: ${operation.reason}; ${salvage}`;
}

function formatValidationIssue(
  issue: { path: (string | number)[]; message: string },
  payload: unknown
): string {
  const [root, rawOperationIndex, ...fieldPath] = issue.path;
  if (root === "operations" && typeof rawOperationIndex === "number") {
    const kind = operationKindAt(payload, rawOperationIndex);
    const field = fieldPath.join(".");
    const prefix = `operation ${rawOperationIndex}${kind ? ` ${kind}` : ""}`;
    if (issue.message === "Required" && field) return `${prefix} missing ${field}`;
    if (field) return `${prefix} ${field}: ${issue.message}`;
    return `${prefix}: ${issue.message}`;
  }
  return `${issue.path.join(".")}: ${issue.message}`;
}

function operationKindAt(payload: unknown, operationIndex: number): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const operations = (payload as Record<string, unknown>).operations;
  if (!Array.isArray(operations)) return undefined;
  const operation = operations[operationIndex];
  if (!operation || typeof operation !== "object") return undefined;
  const kind = (operation as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
}
