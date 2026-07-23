import { formatTime } from "@renderer/i18n";
import { t } from "@renderer/i18n";
import type { Artifact, Run } from "@shared/schema";

export type RunProgressItem = {
  id: string;
  at: string;
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  label: string;
  detail?: string;
};

export type RunTraceGroup = {
  id: string;
  at: string;
  endAt: string;
  stream: Run["logs"][number]["stream"];
  tone: RunProgressItem["tone"];
  label: string;
  detail?: string;
  raw: string;
  lineCount: number;
  collapsible: boolean;
  defaultExpanded: boolean;
};

function textFromRecordSummary(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.summary === "string" && record.summary.trim()) return record.summary.trim();
  const patch = record.archicodePatch;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    const patchSummary = (patch as Record<string, unknown>).summary;
    if (typeof patchSummary === "string" && patchSummary.trim()) return patchSummary.trim();
  }
  return null;
}

function parseJsonSummary(candidate: string): string | null {
  try {
    return textFromRecordSummary(JSON.parse(candidate));
  } catch {
    return null;
  }
}

export function displayPlanText(text: string): string {
  const trimmed = text.trim();
  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fencedMatches) {
    const summary = parseJsonSummary(match[1]?.trim() ?? "");
    if (summary) return summary;
  }

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const directSummary = parseJsonSummary(withoutFence);
  if (directSummary) return directSummary;

  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const summary = parseJsonSummary(withoutFence.slice(firstBrace, lastBrace + 1));
    if (summary) return summary;
  }

  return trimmed;
}

type RunPlanArtifactSummary = Pick<Artifact, "id" | "summary" | "title" | "promptSummary" | "providerSummary" | "planOutputAt">;

function generatedArtifactPlanText(run: Run, artifacts: RunPlanArtifactSummary[]): string | null {
  const labels = run.planArtifactIds
    .map((artifactId) => artifacts.find((item) => item.id === artifactId))
    .flatMap((artifact) => {
      if (!artifact) return [];
      const generated = artifact.providerSummary?.trim() ||
        (artifact.planOutputAt && artifact.summary?.trim() && artifact.summary.trim() !== artifact.promptSummary?.trim() ? artifact.summary.trim() : "");
      return generated ? [generated] : [];
    });
  return labels.join(", ") || null;
}

function runPlanOutput(run: Run): string | null {
  const controlLine = /^(Prepared context|Plan artifact:|Planning phase started\.|Planning completed|Planning produced|Planning graph|MCP transcript artifact:|Provider is planning|Review approved\.|Waiting for approval|Run started\.)/i;
  const log = [...run.logs].reverse().find((line) => {
    const text = line.text.trim();
    return line.stream === "system" && text && !controlLine.test(text) && (text.includes("Decision:") || text.length > 120);
  });
  return log ? displayPlanText(log.text) : null;
}

function shouldPreferLivePlanOutput(run: Run): boolean {
  return run.status === "planning" || run.status === "awaiting-plan-review";
}

export function runPlanText(run: Run, artifacts: RunPlanArtifactSummary[] = []): string | null {
  const livePlanOutput = shouldPreferLivePlanOutput(run) ? runPlanOutput(run) : null;
  if (livePlanOutput) return livePlanOutput;
  const artifactPlan = generatedArtifactPlanText(run, artifacts);
  if (artifactPlan) return artifactPlan;
  const fallbackLivePlanOutput = !shouldPreferLivePlanOutput(run) ? runPlanOutput(run) : null;
  if (fallbackLivePlanOutput) return fallbackLivePlanOutput;
  if (shouldPreferLivePlanOutput(run) && run.promptSummary.trim()) return run.promptSummary.trim();
  if (run.promptSummary.trim()) return run.promptSummary.trim();
  return run.runInstructions?.trim() || null;
}

export function runHasGeneratedPlan(run: Run, artifacts: RunPlanArtifactSummary[] = []): boolean {
  return Boolean(runPlanOutput(run) || generatedArtifactPlanText(run, artifacts));
}

function textFromUnknown(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    return value.map(textFromUnknown).filter(Boolean).join(" ").trim() || null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textFromUnknown(record.text) ?? textFromUnknown(record.content) ?? textFromUnknown(record.message);
  }
  return null;
}

function parseJsonLog(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function looksLikeProviderJsonFragment(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") && /"type"\s*:\s*"(item|turn|thread|response|session)\./.test(trimmed) ||
    /"type"\s*:\s*"(command_execution|agent_message|file_change)"/.test(trimmed) ||
    /\\?"(aggregated_output|exit_code|status|command)\\?"/.test(trimmed);
}

function compactText(text: string, maxLength = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function isTinyTraceFragment(text: string): boolean {
  const trimmed = text.trim();
  return /^[{}[\](),:]$/.test(trimmed) || trimmed.length <= 3;
}

function endsInsideQuotedString(text: string): boolean {
  let escaped = false;
  let quoteCount = 0;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") quoteCount += 1;
  }
  return quoteCount % 2 === 1;
}

function structureBalance(text: string, opener: string, closer: string): number {
  let balance = 0;
  let escaped = false;
  let inString = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === opener) balance += 1;
    if (char === closer) balance -= 1;
  }
  return balance;
}

function hasOpenStructuredFragment(lines: string[]): boolean {
  const joined = lines.join("\n");
  return structureBalance(joined, "{", "}") > 0 ||
    structureBalance(joined, "[", "]") > 0 ||
    endsInsideQuotedString(joined);
}

function looksLikeStandaloneTraceLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (parseJsonLog(trimmed)) return true;
  if (/^(Run started\.|Planning phase started\.|Coding phase started\.|Debugging phase started\.|Verification phase started:?|Waiting for approval|Prepared context|Plan artifact:|Source diff artifact:|Log artifact:|MCP transcript artifact:|Command exited with code )/i.test(trimmed)) {
    return true;
  }
  if (/^(started|queued|waiting|completed|succeeded|failed|blocked|denied)\b/i.test(trimmed)) return true;
  return false;
}

function summarizeJsonLog(record: Record<string, unknown>): string | null {
  const type = textFromUnknown(record.type) ?? textFromUnknown(record.event) ?? textFromUnknown(record.kind);
  const item = record.item && typeof record.item === "object" && !Array.isArray(record.item) ? record.item as Record<string, unknown> : null;
  if (item && textFromUnknown(item.type)?.includes("agent_message")) {
    const message = textFromUnknown(item.text) ?? textFromUnknown(item.message);
    return message ? compactText(message, 180) : null;
  }
  if (item && textFromUnknown(item.type)?.includes("file_change")) {
    const changes = Array.isArray(item.changes) ? item.changes.length : 0;
    const status = textFromUnknown(item.status);
    return [`file changes${changes ? `: ${changes}` : ""}`, status ? `status ${status}` : ""].filter(Boolean).join(" · ");
  }
  if (item && textFromUnknown(item.type)?.includes("command")) {
    const command = textFromUnknown(item.command);
    const status = textFromUnknown(item.status);
    const exitCode = textFromUnknown(item.exit_code);
    const output = textFromUnknown(item.aggregated_output) ?? textFromUnknown(item.output);
    return [
      command ? `command: ${command}` : "command execution",
      status ? `status ${status}` : "",
      exitCode ? `exit ${exitCode}` : "",
      output ? compactText(output, 140) : ""
    ].filter(Boolean).join(" · ");
  }
  const message = textFromUnknown(record.message) ?? textFromUnknown(record.text) ?? textFromUnknown(record.delta);
  if (!type && !message) return null;

  const normalizedType = type?.replace(/[_-]/g, " ");
  if (/^item[ ._-]*(started|completed)$/i.test(normalizedType ?? "") && !message) return null;
  if (/^(turn|response|thread|session)[ ._-]*(started|completed)$/i.test(normalizedType ?? "") && !message) return null;
  if (message && normalizedType) return `${normalizedType}: ${message}`;
  return message ?? normalizedType ?? null;
}

function labelForJsonLog(record: Record<string, unknown>, summary: string): string {
  const item = record.item && typeof record.item === "object" && !Array.isArray(record.item) ? record.item as Record<string, unknown> : null;
  if (item && textFromUnknown(item.type)?.includes("command")) return "Command";
  if (item && textFromUnknown(item.type)?.includes("agent_message")) return "Provider";
  if (item && textFromUnknown(item.type)?.includes("file_change")) return "Files";
  if (/error|failed|denied/i.test(summary)) return "Provider error";
  const type = textFromUnknown(record.type) ?? textFromUnknown(record.event) ?? textFromUnknown(record.kind);
  const normalized = type?.replace(/[_-]/g, " ").replace(/\./g, " ").trim();
  if (!normalized || /^(item|turn|response|thread|session) (started|completed)$/i.test(normalized)) return "Provider output";
  return normalized.length > 28 ? "Provider output" : normalized.replace(/^\w/, (letter) => letter.toUpperCase());
}

function usefulProviderDetail(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const withoutEventPrefix = normalized.replace(/^item[ ._-]*completed:\s*/i, "");
  if (!withoutEventPrefix || /^item[ ._-]*started$/i.test(withoutEventPrefix)) return null;
  if (/^(turn|response|thread|session)[ ._-]*(started|completed)$/i.test(withoutEventPrefix)) return null;
  if (/^(Coding|Planning|Debugging|Verification) phase started\.$/i.test(withoutEventPrefix)) return null;
  return withoutEventPrefix;
}

function labelForLog(log: Run["logs"][number]): Omit<RunProgressItem, "id"> | null {
  const json = parseJsonLog(log.text);
  const jsonSummary = json ? summarizeJsonLog(json) : null;
  if (json && jsonSummary) {
    return {
      at: log.at,
      tone: log.stream === "stderr" ? "danger" : "accent",
      label: labelForJsonLog(json, jsonSummary),
      detail: compactText(jsonSummary)
    };
  }
  if (json && !jsonSummary) return null;
  if (!json && looksLikeProviderJsonFragment(log.text)) return null;

  const text = compactText(log.text);
  if (!text) return null;
  if (log.stream === "stderr") return { at: log.at, tone: "danger", label: t("Error"), detail: text };
  if (/started|queued|waiting/i.test(text)) return { at: log.at, tone: "accent", label: text };
  if (/completed|succeeded|artifact|diff/i.test(text)) return { at: log.at, tone: "success", label: text };
  if (/failed|blocked|denied/i.test(text)) return { at: log.at, tone: "danger", label: text };
  if (log.stream === "stdout") return { at: log.at, tone: "neutral", label: t("Provider output"), detail: text };
  return { at: log.at, tone: "neutral", label: text };
}

export function runProgressItems(run: Run, limit = 8): RunProgressItem[] {
  return run.logs
    .flatMap((log, index) => {
      const item = labelForLog(log);
      return item ? [{ ...item, id: `${log.at}-${index}-${log.stream}` }] : [];
    })
    .slice(-limit)
    .reverse();
}

type TraceBlock = {
  stream: Run["logs"][number]["stream"];
  startedAt: string;
  endAt: string;
  lines: string[];
};

type McpToolCall = Run["mcpToolCalls"][number];

function shouldAppendToTraceBlock(block: TraceBlock, nextLog: Run["logs"][number]): boolean {
  if (block.stream !== nextLog.stream || block.stream === "system") return false;
  const gapMs = Math.abs(Date.parse(nextLog.at) - Date.parse(block.endAt));
  if (!Number.isFinite(gapMs) || gapMs > 1200) return false;
  const nextText = nextLog.text.trim();
  if (!nextText) return false;
  if (hasOpenStructuredFragment(block.lines)) return true;
  if (isTinyTraceFragment(nextText)) return true;
  const lastLine = block.lines[block.lines.length - 1] ?? "";
  if (isTinyTraceFragment(lastLine)) return true;
  if (looksLikeProviderJsonFragment(lastLine) || looksLikeProviderJsonFragment(nextText)) return true;
  return !looksLikeStandaloneTraceLine(lastLine) && !looksLikeStandaloneTraceLine(nextText);
}

function traceBlocks(logs: Run["logs"]): TraceBlock[] {
  const blocks: TraceBlock[] = [];
  for (const log of logs) {
    const text = log.text.trim();
    if (!text) continue;
    const current = blocks.at(-1);
    if (current && shouldAppendToTraceBlock(current, log)) {
      current.lines.push(text);
      current.endAt = log.at;
      continue;
    }
    blocks.push({
      stream: log.stream,
      startedAt: log.at,
      endAt: log.at,
      lines: [text]
    });
  }
  return blocks;
}

function traceLabelFromBurst(stream: Run["logs"][number]["stream"], text: string, lineCount: number): { label: string; detail?: string; tone: RunProgressItem["tone"] } {
  const preview = compactText(text, 200);
  if (stream === "stderr") {
    return {
      label: lineCount > 1 ? "Error output" : "Error",
      detail: preview,
      tone: "danger"
    };
  }
  return {
    label: lineCount > 1 ? "Provider output" : "Provider output",
    detail: preview,
    tone: "neutral"
  };
}

function groupFromBlock(block: TraceBlock, index: number): RunTraceGroup | null {
  const raw = block.lines.join("\n");
  const json = parseJsonLog(raw);
  const jsonSummary = json ? summarizeJsonLog(json) : null;
  if (json && jsonSummary) {
    return {
      id: `${block.startedAt}-${index}-${block.stream}`,
      at: block.startedAt,
      endAt: block.endAt,
      stream: block.stream,
      tone: block.stream === "stderr" ? "danger" : "accent",
      label: labelForJsonLog(json, jsonSummary),
      detail: compactText(jsonSummary),
      raw,
      lineCount: block.lines.length,
      collapsible: true,
      defaultExpanded: /error|failed|denied/i.test(jsonSummary)
    };
  }
  if (!json && block.lines.some((line) => looksLikeProviderJsonFragment(line))) {
    const preview = compactText(raw, 180);
    return {
      id: `${block.startedAt}-${index}-${block.stream}`,
      at: block.startedAt,
      endAt: block.endAt,
      stream: block.stream,
      tone: block.stream === "stderr" ? "danger" : "neutral",
      label: block.stream === "stderr" ? "Provider error output" : "Provider output",
      detail: preview,
      raw,
      lineCount: block.lines.length,
      collapsible: true,
      defaultExpanded: block.stream === "stderr"
    };
  }
  if (block.lines.length > 1 && block.stream !== "system") {
    const burst = traceLabelFromBurst(block.stream, raw, block.lines.length);
    return {
      id: `${block.startedAt}-${index}-${block.stream}`,
      at: block.startedAt,
      endAt: block.endAt,
      stream: block.stream,
      tone: burst.tone,
      label: burst.label,
      detail: burst.detail,
      raw,
      lineCount: block.lines.length,
      collapsible: true,
      defaultExpanded: block.stream === "stderr"
    };
  }
  const item = labelForLog({ at: block.startedAt, stream: block.stream, text: raw });
  if (!item) return null;
  return {
    id: `${block.startedAt}-${index}-${block.stream}`,
    at: block.startedAt,
    endAt: block.endAt,
    stream: block.stream,
    tone: item.tone,
    label: item.label,
    detail: item.detail,
    raw,
    lineCount: block.lines.length,
    collapsible: block.stream !== "system" && Boolean(item.detail),
    defaultExpanded: item.tone === "danger"
  };
}

function humanizeToolName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Tool call";
}

function valueFromRecord(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberFromRecord(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toolRequestDetail(call: McpToolCall, args: Record<string, unknown> | null): string | null {
  const directory = valueFromRecord(args, "directory");
  const path = valueFromRecord(args, "path");
  const query = valueFromRecord(args, "query");
  const command = valueFromRecord(args, "command");
  const url = valueFromRecord(args, "url");
  const startLine = numberFromRecord(args, "startLine");
  const endLine = numberFromRecord(args, "endLine");
  const range = startLine ? `lines ${startLine}${endLine ? `-${endLine}` : "+"}` : null;

  if (call.toolName === "read_file") return [path, range].filter(Boolean).join(" · ") || null;
  if (call.toolName === "list_files") return [directory ?? ".", args?.recursive === true ? "recursive" : null].filter(Boolean).join(" · ");
  if (call.toolName === "search_files") return [query ? `\"${query}\"` : null, directory ? `in ${directory}` : null].filter(Boolean).join(" · ") || null;
  if (call.toolName === "run_command") return command;
  if (call.toolName === "web_open_url") return url;
  if (call.toolName === "web_search") return query ? `\"${query}\"` : null;
  return path ?? directory ?? query ?? command ?? url;
}

function toolResultDetail(call: McpToolCall, result: Record<string, unknown> | null): string | null {
  if (call.status === "started") return "running";
  if (call.status === "approval-required") return "approval needed";
  if (call.status === "failed") return call.error ? compactText(call.error, 120) : "failed";
  if (call.status === "deferred") return "deferred until source apply";
  if (!result) return call.resultSummary ? "result available" : "completed";

  if (call.toolName === "read_file") {
    const totalLines = numberFromRecord(result, "totalLines");
    const binary = result.binary === true;
    return [
      binary ? "binary file" : totalLines ? `${totalLines} lines` : null,
      result.redacted === true ? "redacted" : null,
      result.truncated === true ? "preview truncated" : null
    ].filter(Boolean).join(" · ") || "read";
  }
  if (call.toolName === "list_files") {
    const entries = Array.isArray(result.entries) ? result.entries : Array.isArray(result.files) ? result.files : [];
    const omitted = numberFromRecord(result, "omitted") ?? 0;
    return [`${entries.length} entr${entries.length === 1 ? "y" : "ies"}`, omitted ? `${omitted} omitted` : null].filter(Boolean).join(" · ");
  }
  if (call.toolName === "search_files") {
    const matches = Array.isArray(result.matches) ? result.matches : [];
    const omitted = numberFromRecord(result, "omitted") ?? 0;
    return [`${matches.length} match${matches.length === 1 ? "" : "es"}`, omitted ? `${omitted} omitted` : null].filter(Boolean).join(" · ");
  }
  const status = valueFromRecord(result, "status");
  return status ? `status ${status}` : "completed";
}

function formatToolPayload(text: string | undefined, emptyLabel: string): string {
  const trimmed = text?.trim();
  if (!trimmed) return emptyLabel;
  const parsed = parseJsonLog(trimmed);
  return parsed ? JSON.stringify(parsed, null, 2) : trimmed;
}

function toolTraceGroup(call: McpToolCall, index: number): RunTraceGroup {
  const args = parseJsonLog(call.argumentsJson ?? "");
  const result = parseJsonLog(call.resultSummary ?? "");
  const requestDetail = toolRequestDetail(call, args);
  const resultDetail = toolResultDetail(call, result);
  const raw = [
    `Tool\n${call.serverLabel ?? call.serverId} / ${call.toolName}`,
    `Status\n${call.status}`,
    `Request\n${formatToolPayload(call.argumentsJson, "No arguments")}`,
    call.status === "failed"
      ? `Error\n${call.error?.trim() || "No error detail was recorded."}`
      : call.status === "deferred"
        ? `Result\n${formatToolPayload(call.resultSummary, "Deferred until the source batch is applied.")}`
      : call.status === "approval-required"
        ? "Result\nWaiting for approval."
        : `Result preview\n${formatToolPayload(call.resultSummary, call.status === "started" ? "Waiting for result." : "No result detail was recorded.")}`
  ].join("\n\n");

  return {
    id: `tool-${call.id}-${index}`,
    at: call.startedAt,
    endAt: call.completedAt ?? call.startedAt,
    stream: "system",
    tone: call.status === "failed" ? "danger" : call.status === "approval-required" ? "warning" : call.status === "deferred" ? "neutral" : call.status === "started" ? "accent" : "success",
    label: humanizeToolName(call.toolName),
    detail: [requestDetail, resultDetail].filter(Boolean).join(" · ") || undefined,
    raw,
    lineCount: 1,
    collapsible: true,
    defaultExpanded: call.status === "failed" || call.status === "approval-required"
  };
}

function isToolLifecycleBlock(block: TraceBlock, calls: McpToolCall[]): boolean {
  if (block.stream !== "system" || block.lines.length !== 1) return false;
  const text = block.lines[0]?.trim() ?? "";
  const successOrStart = text.match(/^(?:ArchiCode|MCP) tool (started|succeeded):\s*(.+?)\s*\/\s*([^/]+)$/i);
  const failure = text.match(/^(?:ArchiCode|MCP) tool failed:/i);
  const at = Date.parse(block.startedAt);
  if (!Number.isFinite(at)) return false;

  return calls.some((call) => {
    const expectedAt = call.status === "failed" ? call.completedAt : successOrStart?.[1]?.toLowerCase() === "started" ? call.startedAt : call.completedAt;
    const expectedTime = expectedAt ? Date.parse(expectedAt) : Number.NaN;
    if (!Number.isFinite(expectedTime) || Math.abs(at - expectedTime) > 5_000) return false;
    if (failure) return call.status === "failed";
    if (!successOrStart) return false;
    const [, event, serverLabel, toolName] = successOrStart;
    if (toolName.trim() !== call.toolName) return false;
    if (call.serverLabel && serverLabel.trim() !== call.serverLabel) return false;
    return event.toLowerCase() === "started" || call.status === "succeeded";
  });
}

export function runTraceGroups(run: Run, limit = 120): RunTraceGroup[] {
  const toolCalls = run.mcpToolCalls ?? [];
  const logGroups = traceBlocks(run.logs)
    .filter((block) => !isToolLifecycleBlock(block, toolCalls))
    .flatMap((block, index) => {
      const group = groupFromBlock(block, index);
      return group ? [group] : [];
    });
  const toolGroups = toolCalls.map(toolTraceGroup);
  return [...logGroups, ...toolGroups]
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id))
    .slice(-limit)
    .reverse();
}

export function latestProviderExplanation(run: Run, maxLength = 260): string | null {
  for (const log of [...run.logs].reverse()) {
    const json = parseJsonLog(log.text);
    const jsonSummary = json ? summarizeJsonLog(json) : null;
    const detail = usefulProviderDetail(jsonSummary ?? log.text);
    if (!detail) continue;
    if (/Coding produced no source file changes/i.test(detail)) continue;
    if (detail === run.promptSummary) continue;
    if (detail.length < 24 && !/(source|file|package|git|error|fail|cannot|unable|denied)/i.test(detail)) continue;
    return compactText(detail, maxLength);
  }
  return null;
}

export function rawRunLog(run: Run, limit = 200): string {
  return run.logs
    .slice(-limit)
    .reverse()
    .map((line) => `[${formatTime(new Date(line.at))}] ${line.stream}: ${line.text}`)
    .join("\n");
}
