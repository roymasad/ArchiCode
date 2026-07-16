import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import {
  llmPatchProposalSchema,
  type LlmPatchProposal,
  type SourceFileProposal
} from "./schema";

export const SOURCE_FILE_HANDOFF_TOOL = "archicode_submit_source_file";
export const SOURCE_BATCH_FINISH_TOOL = "archicode_finish_source_batch";

const sourceFileToolArgumentsSchema = z.object({
  path: z.string().trim().min(1),
  action: z.enum(["create", "replace", "delete"]),
  content: z.string().optional(),
  baseSha256: z.string().optional(),
  nodeId: z.string().optional(),
  nodeIds: z.array(z.string().trim().min(1)).optional(),
  reason: z.string().optional(),
  testIntent: z.preprocess((value) => value === null ? undefined : value, z.string().optional())
}).strict().superRefine((value, context) => {
  if (!value.nodeId?.trim() && !value.nodeIds?.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nodeIds"],
      message: "nodeIds is required and must name at least one allowed graph node"
    });
  }
  if ((value.action === "create" || value.action === "replace") && value.content === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: `content is required when action is ${value.action}`
    });
  }
  if (value.action === "delete" && value.content !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "content must be omitted when action is delete"
    });
  }
});

export const sourceBatchFinishArgumentsSchema = z.object({
  implementationStatus: z.enum(["complete", "continue", "blocked"]),
  summary: z.string().trim().min(1),
  notes: z.string().optional(),
  verificationNotes: z.string().optional(),
  nextSourceSlice: z.string().optional(),
  needsReplan: z.boolean().optional(),
  replanReason: z.string().optional(),
  suggestedQuestions: z.array(z.string()).default([])
}).strict();

export type SourceBatchFinish = z.infer<typeof sourceBatchFinishArgumentsSchema>;
type SourceBatchFinishRepair = "jsonrepair" | "verification-only-continuation" | "jsonrepair+verification-only-continuation";

export type ParsedSourceFileToolArguments = {
  success: true;
  operation: SourceFileProposal;
  repairedBy?: "content-quote-repair" | "jsonrepair";
} | {
  success: false;
  pathHint?: string;
  error: string;
};

export type ParsedSourceBatchFinishArguments = {
  success: true;
  finish: SourceBatchFinish;
  repairedBy?: SourceBatchFinishRepair;
} | {
  success: false;
  error: string;
};

export function sourceFileProposalNodeIds(operation: Pick<SourceFileProposal, "nodeId" | "nodeIds">): string[] {
  return [...new Set([...(operation.nodeIds ?? []), ...(operation.nodeId ? [operation.nodeId] : [])]
    .map((value) => value.trim())
    .filter(Boolean))];
}

function compactError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
    .join(" | ");
}

function verificationOnlyContinuation(finish: SourceBatchFinish): boolean {
  if (finish.implementationStatus !== "continue") return false;
  const next = finish.nextSourceSlice?.trim() ?? "";
  if (!next) return false;
  const namesConcreteSourceWork = /\b(?:create|replace|edit|implement|add|remove|delete|refactor|migrate|split|move|fix|update|generate|scaffold|wire|integrate)\b[^.\n]{0,80}\b(?:source|files?|components?|pages?|routes?|views?|modules?|clients?|tests?|configs?|styles?|assets?|schemas?|migrations?|endpoints?)\b/i.test(next) ||
    /(?:^|\s)(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:[cm]?[jt]sx?|vue|svelte|css|scss|html|json|ya?ml|toml|md|svg|sh|sql|py|rb|go|rs|java|kt|swift|dart|php|cs)\b/i.test(next);
  if (namesConcreteSourceWork) return false;
  return /\b(?:apply|applied|staged|on disk|install|dependencies|build|compile|typecheck|test|verify|verification|check|lint|run|rerun)\b/i.test(next);
}

function normalizeSourceBatchFinish(
  finish: SourceBatchFinish,
  repairedBy?: "jsonrepair"
): { finish: SourceBatchFinish; repairedBy?: SourceBatchFinishRepair } {
  if (!verificationOnlyContinuation(finish)) return { finish, repairedBy };
  const verificationNote = "ArchiCode normalized a verification-only continuation to complete; staged files will be applied and verified by the host.";
  return {
    finish: {
      ...finish,
      implementationStatus: "complete",
      nextSourceSlice: undefined,
      verificationNotes: [finish.verificationNotes, verificationNote].filter(Boolean).join("\n")
    },
    repairedBy: repairedBy ? "jsonrepair+verification-only-continuation" : "verification-only-continuation"
  };
}

function sourceOperation(value: unknown): SourceFileProposal {
  const parsed = sourceFileToolArgumentsSchema.safeParse(value);
  if (!parsed.success) throw new Error(validationError(parsed.error));
  return {
    kind: "propose-source-file",
    ...parsed.data
  };
}

function stringFieldHint(text: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(text);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

function quoteIsEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function escapeBrokenJsonStringBody(text: string): string {
  let repaired = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") {
      if (!quoteIsEscaped(text, index)) repaired += "\\";
      repaired += char;
    } else if (char === "\n") {
      repaired += "\\n";
    } else if (char === "\r") {
      repaired += "\\r";
    } else if (char === "\t") {
      repaired += "\\t";
    } else {
      repaired += char;
    }
  }
  return repaired;
}

function contentQuoteRepairCandidates(argumentsJson: string): Array<{ operation: SourceFileProposal; metadataScore: number }> {
  const contentStartMatch = /"content"\s*:\s*"/.exec(argumentsJson);
  if (!contentStartMatch || contentStartMatch.index === undefined) return [];
  const contentStart = contentStartMatch.index + contentStartMatch[0].length;
  const tail = argumentsJson.slice(contentStart);
  const boundaryPattern = /"(?=\s*,\s*"(?:path|action|baseSha256|nodeId|nodeIds|reason|testIntent)"\s*:)|"(?=\s*}\s*$)/g;
  const candidates: Array<{ operation: SourceFileProposal; metadataScore: number }> = [];
  let boundary: RegExpExecArray | null;
  while ((boundary = boundaryPattern.exec(tail)) !== null) {
    const contentEnd = contentStart + boundary.index;
    if (quoteIsEscaped(argumentsJson, contentEnd)) continue;
    const repaired = [
      argumentsJson.slice(0, contentStart),
      escapeBrokenJsonStringBody(argumentsJson.slice(contentStart, contentEnd)),
      argumentsJson.slice(contentEnd)
    ].join("");
    try {
      const parsed = JSON.parse(repaired) as unknown;
      const operation = sourceOperation(parsed);
      const record = parsed as Record<string, unknown>;
      const metadataScore = ["baseSha256", "nodeId", "nodeIds", "reason", "testIntent"]
        .filter((key) => record[key] !== undefined).length;
      candidates.push({ operation, metadataScore });
    } catch {
      // Keep scanning for the actual outer content-string boundary.
    }
  }
  return candidates.sort((left, right) =>
    right.metadataScore - left.metadataScore ||
    (right.operation.content?.length ?? 0) - (left.operation.content?.length ?? 0));
}

export function parseSourceFileToolArguments(argumentsJson: string): ParsedSourceFileToolArguments {
  const pathHint = stringFieldHint(argumentsJson, "path");
  let strictError = "";
  try {
    return { success: true, operation: sourceOperation(JSON.parse(argumentsJson || "{}") as unknown) };
  } catch (error) {
    strictError = compactError(error);
  }

  const contentRepair = contentQuoteRepairCandidates(argumentsJson)[0];
  if (contentRepair) {
    return {
      success: true,
      operation: contentRepair.operation,
      repairedBy: "content-quote-repair"
    };
  }

  try {
    const repaired = jsonrepair(argumentsJson);
    return {
      success: true,
      operation: sourceOperation(JSON.parse(repaired) as unknown),
      repairedBy: "jsonrepair"
    };
  } catch (repairError) {
    return {
      success: false,
      pathHint,
      error: `Strict parse failed: ${strictError}. Deterministic repair failed: ${compactError(repairError)}`
    };
  }
}

export function parseSourceBatchFinishArguments(argumentsJson: string): ParsedSourceBatchFinishArguments {
  let strictError = "";
  try {
    const parsed = sourceBatchFinishArgumentsSchema.safeParse(JSON.parse(argumentsJson || "{}") as unknown);
    if (!parsed.success) throw new Error(validationError(parsed.error));
    return { success: true, ...normalizeSourceBatchFinish(parsed.data) };
  } catch (error) {
    strictError = compactError(error);
  }
  try {
    const repaired = JSON.parse(jsonrepair(argumentsJson)) as unknown;
    const parsed = sourceBatchFinishArgumentsSchema.safeParse(repaired);
    if (!parsed.success) throw new Error(validationError(parsed.error));
    return { success: true, ...normalizeSourceBatchFinish(parsed.data, "jsonrepair") };
  } catch (repairError) {
    return {
      success: false,
      error: `Strict parse failed: ${strictError}. Deterministic repair failed: ${compactError(repairError)}`
    };
  }
}

export function sourceHandoffPatch(
  runId: string,
  operations: SourceFileProposal[],
  finish: SourceBatchFinish
): LlmPatchProposal {
  return llmPatchProposalSchema.parse({
    schemaVersion: 1,
    runId,
    summary: finish.summary,
    runSummary: {
      implementationStatus: finish.implementationStatus,
      notes: finish.notes,
      verificationNotes: finish.verificationNotes,
      nextSourceSlice: finish.nextSourceSlice,
      needsReplan: finish.needsReplan,
      replanReason: finish.replanReason,
      suggestedQuestions: finish.suggestedQuestions
    },
    operations
  });
}
