import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAcceptanceChecksFromCriteria, generateAcceptanceChecksScoped } from "../src/main/storage/acceptanceChecks";
import { addNote, attachNodeReferences } from "../src/main/storage/notes";
import { readArtifactText } from "../src/main/storage/patches";
import { ensureEmptyCodebaseProject, ensureFixtureProject, loadProject, saveFlow, setGlobalMcpSettingsStore, updateNode, updateProjectSettings } from "../src/main/storage/projectStore";
import { reportBug } from "../src/main/storage/runEngine";
import { listRuntimeServices } from "../src/main/storage/runtimeServices";
import { delphiTestingInputSchema, researchChatSessionSchema, researchGraphOperationKinds, runSchema, subagentRunSchema, type ProjectSettings, type ResearchChatSession } from "../src/shared/schema";
import { isResearchThinkingPhrase } from "../src/shared/researchPersonality";
import { applyResearchGraphChangeSet, cancelResearchChatMessage, delphiAuditReport, effectiveDelphiModelPreflight, mapExistingCodebase, reconcileResearchOutcomeReportState, requestsRedundantOutcomeArtifactRead, respondToSubagentRun, resumeResearchGoalsForRunUpdate, sendResearchChatMessage, setGlobalResearchPersonalityResolver, setGlobalResearchVerbosityResolver } from "../src/main/research";
import { createResearchChat, listResearchChats, markSubagentRunLive, markSubagentRunSettled, persistResearchSession, renameResearchChat, setResearchStorageRoot, transitionSubagentRun, updateResearchChatAutoApproval } from "../src/main/research/chatStore";
import { buildResearchGraphLayoutToolResult, researchToolInspectCli, researchToolReadFile } from "../src/main/research/inspectionTools";
import { deriveResearchTurnKind, researchTurnPolicy } from "../src/main/research/turnPolicy";
import { ARCHICODE_RESEARCH_RULES_SERVER_ID, ARCHICODE_RESEARCH_RULES_TOOL_NAME } from "../src/main/internalTools";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }]
}));

/**
 * Cross-provider lifecycle invariants that must hold whenever a Research turn
 * has returned control to the caller. Awaiting-approval is intentionally
 * allowed: it is an honest durable pause, while `running` requires a live owner.
 */
function expectTerminalResearchLifecycleInvariants(session: ResearchChatSession): void {
  const runs = session.messages.flatMap((message) => message.subagentRuns);
  expect(runs.filter((run) => run.status === "running").map((run) => run.id)).toEqual([]);

  const ids = runs.map((run) => run.id);
  expect(new Set(ids).size).toBe(ids.length);
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const correctiveRunsByAncestor = new Map<string, string[]>();
  for (const run of runs) {
    const ancestorId = run.approvalInheritedFromRunId;
    if (!ancestorId) continue;
    expect(runsById.has(ancestorId)).toBe(true);
    expect(ancestorId).not.toBe(run.id);
    const siblings = correctiveRunsByAncestor.get(ancestorId) ?? [];
    siblings.push(run.id);
    correctiveRunsByAncestor.set(ancestorId, siblings);
  }
  for (const siblingIds of correctiveRunsByAncestor.values()) {
    expect(siblingIds).toHaveLength(1);
  }
}

async function createFakeResearchCodex(
  root: string,
  output: string | string[],
  capturePromptPath?: string,
  captureArgsPath?: string
): Promise<string> {
  const commandPath = path.join(root, "fake-research-codex.cjs");
  const callCountPath = path.join(root, "fake-research-codex-count.txt");
  const outputs = Array.isArray(output) ? output : [output];
  await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
process.stdin.on("end", () => {
  if (${JSON.stringify(capturePromptPath)}) fs.appendFileSync(${JSON.stringify(capturePromptPath)}, stdin + "\\n\\n--- prompt boundary ---\\n\\n", "utf8");
  if (${JSON.stringify(captureArgsPath)}) fs.appendFileSync(${JSON.stringify(captureArgsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
  const countPath = ${JSON.stringify(callCountPath)};
  const outputs = ${JSON.stringify(outputs)};
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) || 0 : 0;
  fs.writeFileSync(countPath, String(count + 1), "utf8");
  const output = outputs[Math.min(count, outputs.length - 1)];
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], output, "utf8");
  process.exit(0);
});
`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function createFakeResearchClaude(root: string, output: string | string[], capturePromptPath?: string): Promise<string> {
  const commandPath = path.join(root, "fake-research-claude.cjs");
  const callCountPath = path.join(root, "fake-research-claude-count.txt");
  const outputs = Array.isArray(output) ? output : [output];
  await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
process.stdin.on("end", () => {
  if (${JSON.stringify(capturePromptPath)}) fs.appendFileSync(${JSON.stringify(capturePromptPath)}, stdin + "\\n\\n--- prompt boundary ---\\n\\n", "utf8");
  const countPath = ${JSON.stringify(callCountPath)};
  const outputs = ${JSON.stringify(outputs)};
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) || 0 : 0;
  fs.writeFileSync(countPath, String(count + 1), "utf8");
  const output = outputs[Math.min(count, outputs.length - 1)];
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: output }]
    }
  }) + "\\n");
  process.exit(0);
});
`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function createStreamingFakeResearchCodex(
  root: string,
  output: string,
  events: Array<Record<string, unknown>>
): Promise<string> {
  const commandPath = path.join(root, "fake-streaming-research-codex.cjs");
  await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
process.stdin.resume();
process.stdin.on("end", () => {
  for (const event of ${JSON.stringify(events)}) {
    process.stdout.write(JSON.stringify(event) + "\\n");
  }
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], ${JSON.stringify(output)}, "utf8");
  process.exit(0);
});
`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function createDelayedResearchCodex(root: string, output: string, delayMs: number): Promise<string> {
  const commandPath = path.join(root, "fake-delayed-research-codex.cjs");
  await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
process.stdin.resume();
process.stdin.on("end", () => {
  setTimeout(() => {
    if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], ${JSON.stringify(output)}, "utf8");
    process.exit(0);
  }, ${delayMs});
});
`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function createScriptedResearchCodex(
  root: string,
  steps: Array<{ exitCode?: number; output?: string; stdout?: string; stderr?: string }>
): Promise<string> {
  const commandPath = path.join(root, "fake-scripted-research-codex.cjs");
  const callCountPath = path.join(root, "fake-scripted-research-codex-count.txt");
  await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
process.stdin.resume();
process.stdin.on("end", () => {
  const countPath = ${JSON.stringify(callCountPath)};
  const steps = ${JSON.stringify(steps)};
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) || 0 : 0;
  fs.writeFileSync(countPath, String(count + 1), "utf8");
  const step = steps[Math.min(count, steps.length - 1)] || {};
  if (step.stdout) process.stdout.write(step.stdout);
  if (step.stderr) process.stderr.write(step.stderr);
  if (step.output && outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], step.output, "utf8");
  process.exit(typeof step.exitCode === "number" ? step.exitCode : 0);
});
`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function createMarkedStepResearchCodex(
  root: string,
  steps: Array<{ output: string; delayMs?: number; markerPath?: string }>
): Promise<string> {
  const commandPath = path.join(root, "fake-marked-research-codex.cjs");
  const callCountPath = path.join(root, "fake-marked-research-codex-count.txt");
  await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
process.stdin.resume();
process.stdin.on("end", () => {
  const countPath = ${JSON.stringify(callCountPath)};
  const steps = ${JSON.stringify(steps)};
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) || 0 : 0;
  fs.writeFileSync(countPath, String(count + 1), "utf8");
  const step = steps[Math.min(count, steps.length - 1)] || {};
  if (step.markerPath) fs.writeFileSync(step.markerPath, "started", "utf8");
  setTimeout(() => {
    if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], step.output || "", "utf8");
    process.exit(0);
  }, step.delayMs || 0);
});
`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function setupProject(output: string | string[] = JSON.stringify({
  archicodeResearch: {
    answer: "I found a useful graph expansion. Summary: this internal note should stay hidden.",
    summary: "Discussed graph expansion.",
    changeSet: {
      summary: "Add a research node",
      operations: [
        {
          kind: "create-node",
          flowId: "flow-main",
          node: {
            id: "node-research-added",
            type: "task",
            title: "Research Added",
            description: "Created from research chat."
          }
        }
      ]
    }
  }
}), capturePrompt = false, captureArgs = false) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-project-"));
  const storageRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-storage-"));
  setResearchStorageRoot(storageRoot);
  const promptPath = capturePrompt ? path.join(projectRoot, "research-prompt.txt") : undefined;
  const argsPath = captureArgs ? path.join(projectRoot, "research-args.jsonl") : undefined;
  const command = await createFakeResearchCodex(projectRoot, output, promptPath, argsPath);
  const bundle = await ensureFixtureProject(projectRoot);
  await updateProjectSettings(projectRoot, {
    ...bundle.project.settings,
    providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
      ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
      : { ...provider, enabled: false })
  });
  return { projectRoot, storageRoot, promptPath, argsPath };
}

async function writeActiveResearchLockRun(projectRoot: string, input: { id?: string; flowId?: string; status?: "coding" | "awaiting-code-review" } = {}): Promise<void> {
  const run = runSchema.parse({
    id: input.id ?? "run-active-research-lock",
    flowId: input.flowId ?? "flow-other",
    providerId: "codex-local",
    status: input.status ?? "coding",
    phase: "coding",
    promptSummary: "Active implementation owns the project graph",
    permission: { decision: "allowed" },
    createdAt: new Date().toISOString()
  });
  await writeFile(path.join(projectRoot, ".archicode", "runs", `${run.id}.json`), JSON.stringify(run, null, 2), "utf8");
}

function localResearchSinkTurn(
  answer: string,
  toolCalls: Array<{ providerToolName: string; arguments: unknown }>
): string {
  return JSON.stringify({
    archicodeResearchTurn: {
      answer,
      toolCalls: toolCalls.map((toolCall, index) => ({ id: `sink-${index + 1}`, ...toolCall }))
    }
  });
}

function memorySink(argumentsValue: unknown): { providerToolName: string; arguments: unknown } {
  return { providerToolName: "archicode_update_memory", arguments: argumentsValue };
}

function memoryUnchangedSink(reason = "This turn added no durable state."): { providerToolName: string; arguments: unknown } {
  return { providerToolName: "archicode_leave_memory_unchanged", arguments: { reason } };
}

function graphChangeSink(argumentsValue: unknown): { providerToolName: string; arguments: unknown } {
  return { providerToolName: "archicode_propose_graph_change_set", arguments: argumentsValue };
}

async function createFakeContext7McpServer(root: string): Promise<string> {
  const serverPath = path.join(root, "fake-context7-mcp.cjs");
  await writeFile(serverPath, `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-context7", version: "1.0.0" }
    });
    return;
  }
  if (message.method === "tools/list") {
    send(message.id, {
      tools: [{
        name: "resolve-library-id",
        description: "Resolve docs.",
        inputSchema: {
          type: "object",
          properties: { libraryName: { type: "string" } },
          required: ["libraryName"]
        }
      }]
    });
    return;
  }
  if (message.method === "tools/call") {
    send(message.id, { content: [{ type: "text", text: "context7 approved result for react" }] });
  }
});
`, "utf8");
  await chmod(serverPath, 0o755);
  return serverPath;
}

function researchStorageFile(storageRoot: string, projectRoot: string): string {
  const key = createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 32);
  return path.join(storageRoot, "research-chats", `${key}.json`);
}

async function writeTinyPng(filePath: string): Promise<void> {
  await writeFile(filePath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  ));
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

function promptObjectForKey(prompt: string, key: string): Record<string, unknown> {
  const marker = `"${key}":`;
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Prompt does not contain ${marker}`);
  const start = prompt.indexOf("{", markerIndex + marker.length);
  if (start < 0) throw new Error(`Prompt value for ${key} is not an object`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < prompt.length; index += 1) {
    const character = prompt[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(prompt.slice(start, index + 1)) as Record<string, unknown>;
    }
  }
  throw new Error(`Prompt object for ${key} is incomplete`);
}

function streamingChatCompletionResponse(text: string): Response {
  return sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    "data: [DONE]\n\n"
  ]);
}

// SSE mock for an OpenAI Chat Completions turn that streams tool calls.
function streamingChatCompletionToolCallsResponse(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
  text = "",
  reasoningState?: { reasoning?: string; reasoning_content?: string; reasoning_details?: unknown[] },
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
): Response {
  const chunks: string[] = [];
  if (text) chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  if (reasoningState) chunks.push(`data: ${JSON.stringify({ choices: [{ delta: reasoningState }] })}\n\n`);
  toolCalls.forEach((toolCall, index) => {
    chunks.push(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index, id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.arguments } }] } }]
    })}\n\n`);
  });
  if (usage) chunks.push(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  chunks.push("data: [DONE]\n\n");
  return sseResponse(chunks);
}

// SSE mock for an Anthropic Messages turn with text and/or tool_use blocks.
function streamingAnthropicResponse(
  parts: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "redacted_thinking"; data: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >
): Response {
  const chunks: string[] = [];
  parts.forEach((part, index) => {
    if (part.type === "text") {
      chunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } })}\n\n`);
      chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: part.text } })}\n\n`);
    } else if (part.type === "thinking") {
      chunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } })}\n\n`);
      chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part.thinking } })}\n\n`);
      chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: part.signature } })}\n\n`);
    } else if (part.type === "redacted_thinking") {
      chunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "redacted_thinking", data: part.data } })}\n\n`);
    } else {
      chunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "tool_use", id: part.id, name: part.name, input: {} } })}\n\n`);
      chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(part.input) } })}\n\n`);
    }
    chunks.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`);
  });
  chunks.push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } })}\n\n`);
  chunks.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  return sseResponse(chunks);
}

async function writeTinyPdf(filePath: string): Promise<void> {
  await writeFile(filePath, Buffer.from(
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNjQgPj4Kc3RyZWFtCkJUIC9GMSAyNCBUZiA3MiA3MjAgVGQgKFBERiBhdHRhY2htZW50IGRldGFpbHMgZm9yIHRlc3RzLikgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQyNQolJUVPRgo=",
    "base64"
  ));
}

async function writeTinyDocx(filePath: string): Promise<void> {
  await writeFile(filePath, Buffer.from(
    "UEsDBAoAAAAAAAlu4VzXeYTquAEAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPgogIDxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+CiAgPERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz4KICA8T3ZlcnJpZGUgUGFydE5hbWU9Ii93b3JkL2RvY3VtZW50LnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLmRvY3VtZW50Lm1haW4reG1sIi8+CjwvVHlwZXM+UEsDBAoAAAAAAAlu4VwAAAAAAAAAAAAAAAAGAAAAX3JlbHMvUEsDBAoAAAAAAAlu4VwgG4bqLgEAAC4BAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+CjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPgogIDxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz4KPC9SZWxhdGlvbnNoaXBzPlBLAwQKAAAAAAAJbuFcAAAAAAAAAAAAAAAABQAAAHdvcmQvUEsDBAoAAAAAAAlu4Vy3w0TZ+AAAAPgAAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+Cjx3OmRvY3VtZW50IHhtbG5zOnc9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy93b3JkcHJvY2Vzc2luZ21sLzIwMDYvbWFpbiI+CiAgPHc6Ym9keT4KICAgIDx3OnA+PHc6cj48dzp0PkRPQ1ggYXR0YWNobWVudCBkZXRhaWxzIGZvciB0ZXN0cy48L3c6dD48L3c6cj48L3c6cD4KICA8L3c6Ym9keT4KPC93OmRvY3VtZW50PlBLAQIUAAoAAAAAAAlu4VzXeYTquAEAALgBAAATAAAAAAAAAAAAAAAAAAAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQACgAAAAAACW7hXAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAQAAAA6QEAAF9yZWxzL1BLAQIUAAoAAAAAAAlu4VwgG4bqLgEAAC4BAAALAAAAAAAAAAAAAAAAAA0CAABfcmVscy8ucmVsc1BLAQIUAAoAAAAAAAlu4VwAAAAAAAAAAAAAAAAFAAAAAAAAAAAAEAAAAGQDAAB3b3JkL1BLAQIUAAoAAAAAAAlu4Vy3w0TZ+AAAAPgAAAARAAAAAAAAAAAAAAAAAIcDAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAABQAFACABAACuBAAAAAA=",
    "base64"
  ));
}

describe("research chat workflow", () => {
  beforeEach(() => {
    // MCP servers are an app-wide preference persisted through this store (see
    // storage.ts's setGlobalMcpSettingsStore); wire up an in-memory stand-in so
    // servers set via updateProjectSettings round-trip the same way the real
    // app's global store keeps them, instead of vanishing on the next load.
    let globalMcp: ProjectSettings["mcp"] | null = null;
    setGlobalMcpSettingsStore({
      load: async () => globalMcp,
      save: async (settings) => {
        globalMcp = settings;
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setGlobalResearchPersonalityResolver(null);
    setGlobalResearchVerbosityResolver(null);
    setGlobalMcpSettingsStore(null);
  });

  it("derives one explicit Research turn policy from lifecycle inputs", () => {
    const cases = [
      [{}, "user"],
      [{ internalContinuation: true }, "goal-continuation"],
      [{ approvalResume: true }, "approval-resume"],
      [{ internalContinuation: true, outcomeEvidenceProvided: true }, "outcome-finalization"]
    ] as const;

    for (const [input, expectedKind] of cases) {
      const kind = deriveResearchTurnKind(input);
      expect(kind).toBe(expectedKind);
      expect(researchTurnPolicy(kind).kind).toBe(expectedKind);
    }
    expect(researchTurnPolicy("outcome-finalization")).toMatchObject({
      includeExternalRetrieval: false,
      includeProjectContext: true,
      includeConversationHistory: true,
      includeSelectedSkills: false,
      enforceExplicitDelphiDelegation: false
    });
    expect(researchTurnPolicy("user")).toMatchObject({
      includeExternalRetrieval: true,
      includeProjectContext: true,
      includeConversationHistory: true,
      includeSelectedSkills: true,
      enforceExplicitDelphiDelegation: true
    });
  });

  it("validates Research subagent status transitions through one owner", () => {
    const now = new Date().toISOString();
    const awaiting = subagentRunSchema.parse({
      id: "transition-run",
      kind: "delphi-testing",
      status: "awaiting-approval",
      title: "Audit",
      argumentsJson: "{}",
      progress: [],
      createdAt: now,
      updatedAt: now
    });
    const running = transitionSubagentRun(awaiting, "running", { selectedRuntimeTargetProfileIds: ["web"] });
    expect(running).toMatchObject({ status: "running", selectedRuntimeTargetProfileIds: ["web"] });
    const completed = transitionSubagentRun(running, "completed", { resultSummary: "Verified." });
    expect(completed).toMatchObject({ status: "completed", resultSummary: "Verified." });
    expect(() => transitionSubagentRun(completed, "running")).toThrow("Invalid subagent run transition completed -> running");
  });

  it("includes concrete Delphi finding details in the parent outcome packet", () => {
    const now = new Date().toISOString();
    const report = delphiAuditReport({
      id: "micro-delphi-finding",
      kind: "delphi-testing",
      status: "completed",
      output: {
        status: "completed",
        verdict: "failed",
        summary: "The audit found one navigation defect.",
        attempts: 1,
        checks: [{ name: "About navigation", status: "failed", evidence: ["URL remained on /"] }],
        findings: [{
          title: "About link does not navigate",
          severity: "high",
          category: "functional",
          detail: "Clicking the About link leaves the browser on the landing page.",
          reproductionSteps: ["Open /", "Click About"],
          evidence: ["Expected /about; observed /"]
        }],
        toolchains: [],
        artifacts: [],
        blockers: [],
        recommendedNextSteps: []
      },
      createdAt: now,
      completedAt: now
    });

    expect(report).toContain("Finding 1 [high/functional] About link does not navigate");
    expect(report).toContain("Clicking the About link leaves the browser on the landing page");
    expect(report).toContain("Reproduce: Open /; Click About");
    expect(report).toContain("Evidence: Expected /about; observed /");
  });

  it("reports a timed-out Delphi audit as partial when host evidence survived", () => {
    const report = delphiAuditReport({
      id: "micro-delphi-timeout",
      kind: "delphi-testing",
      status: "failed",
      failureKind: "timeout",
      error: "Local provider call produced no output for 5 minutes.",
      output: {
        status: "blocked",
        verdict: "blocked",
        summary: "The provider stopped before the final report.",
        attempts: 2,
        checks: [{ name: "Playwright live target flow", status: "passed", evidence: ["Captured landing-desktop"] }],
        findings: [],
        toolchains: [],
        artifacts: [{ id: "capture-1", label: "landing-desktop", path: ".archicode/artifacts/delphi/capture.png", mediaType: "image/png" }],
        blockers: ["Provider timeout"],
        recommendedNextSteps: []
      },
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    });

    expect(report).toContain("timed out before returning its final report");
    expect(report).toContain("Host-observed partial evidence was preserved");
    expect(report).toContain("1 check was recorded");
    expect(report).not.toContain("No executable checks were recorded");
  });

  it("host-finalizes a completed Delphi goal after persisting the final report", async () => {
    const { projectRoot } = await setupProject();
    const baseSession = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-delphi-finalize" } });
    const now = new Date().toISOString();
    const seeded = researchChatSessionSchema.parse({
      ...baseSession,
      memory: { ...baseSession.memory, lastUpdateError: "stale optional-memory warning", updatedAt: now },
      orchestration: {
        ...baseSession.orchestration,
        goal: {
          id: "goal-delphi-finalize",
          objective: "Run the requested test/runtime audit and report evidence-backed findings.",
          status: "active",
          steps: [
            { id: "prepare-audit", title: "Prepare audit", status: "done", evidence: ["Approved"], createdAt: now, updatedAt: now },
            { id: "run-audit", title: "Run audit", status: "doing", evidence: ["Checks completed"], createdAt: now, updatedAt: now },
            { id: "report-findings", title: "Report findings", status: "open", evidence: [], createdAt: now, updatedAt: now }
          ],
          currentStepId: "run-audit",
          completionEvidence: [],
          blockers: [],
          waitingFor: [],
          continuationCount: 1,
          createdAt: now,
          updatedAt: now
        },
        updatedAt: now
      },
      messages: [{
        id: "assistant-delphi-final-report",
        role: "assistant",
        content: "Build, runtime, and browser checks passed.",
        createdAt: now,
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: []
      }],
      updatedAt: now
    });
    await persistResearchSession(projectRoot, seeded);

    const reconciled = await reconcileResearchOutcomeReportState(projectRoot, seeded, {
      outcomeKind: "delphi-testing",
      outcomeRunId: "delphi-run-finalize",
      outcomeStatus: "completed"
    });

    expect(reconciled.orchestration.goal?.status).toBe("completed");
    expect(reconciled.orchestration.goal?.steps.every((step) => step.status === "done")).toBe(true);
    expect(reconciled.orchestration.goal?.completionEvidence).toContain("Final evidence-backed report persisted in chat message assistant-delphi-final-report.");
    expect(reconciled.memory.lastUpdateError).toBeUndefined();
  });

  it("hides the legacy optional-memory fallback notice because persistence succeeded", async () => {
    const { projectRoot } = await setupProject();
    const baseSession = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-memory-notice" } });
    const seeded = researchChatSessionSchema.parse({
      ...baseSession,
      memory: {
        ...baseSession.memory,
        lastUpdateError: "The model omitted its optional semantic memory decision. Host-observed subagent status and evidence were preserved without an extra provider repair call."
      }
    });
    await persistResearchSession(projectRoot, seeded);

    const reloaded = (await listResearchChats(projectRoot)).find((session) => session.id === seeded.id)!;

    expect(reloaded.memory.lastUpdateError).toBeUndefined();
  });

  it("uses and persists a model selected for an individual chat", async () => {
    const { projectRoot, argsPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Answered with the selected chat model.",
        summary: "Used a per-chat model."
      }
    }), false, true);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const firstTurn = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Use the alternate model for this chat.",
      modelId: "gpt-5.4-mini"
    });
    const secondTurn = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Continue with the same model."
    });
    const invocations = (await readFile(argsPath!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);

    expect(firstTurn.modelId).toBe("gpt-5.4-mini");
    expect(secondTurn.modelId).toBe("gpt-5.4-mini");
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    for (const args of invocations) {
      const modelFlagIndex = args.indexOf("--model");
      expect(modelFlagIndex).toBeGreaterThanOrEqual(0);
      expect(args[modelFlagIndex + 1]).toBe("gpt-5.4-mini");
    }

    const defaultTurn = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Switch this chat back to the provider default.",
      modelId: null
    });
    const defaultContinuation = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Continue with the provider default."
    });
    const defaultInvocations = (await readFile(argsPath!, "utf8"))
      .trim()
      .split("\n")
      .slice(invocations.length)
      .map((line) => JSON.parse(line) as string[]);

    expect(defaultTurn.modelId).toBeNull();
    expect(defaultContinuation.modelId).toBeNull();
    expect(defaultInvocations.length).toBeGreaterThanOrEqual(2);
    expect(defaultInvocations.every((args) => !args.includes("--model"))).toBe(true);
  });

  it("moves an existing chat to the active provider while retaining its model", async () => {
    const { projectRoot, argsPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Answered through the active provider.",
        summary: "Retained the chat model while changing providers."
      }
    }), false, true);
    const bundle = await loadProject(projectRoot);
    const activeProvider = bundle.project.settings.providers.find((provider) => provider.enabled)!;
    const previousProvider = {
      ...activeProvider,
      id: "previous-provider",
      label: "Previous Provider",
      enabled: false,
      localCommand: "/definitely/missing-previous-provider"
    };
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: [...bundle.project.settings.providers, previousProvider]
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: bundle.project.id },
      providerId: previousProvider.id,
      modelId: "chat-owned-model"
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Continue this existing chat."
    });
    const invocations = (await readFile(argsPath!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);

    expect(answered.providerId).toBe(activeProvider.id);
    expect(answered.modelId).toBe("chat-owned-model");
    expect(invocations.some((args) => {
      const modelFlagIndex = args.indexOf("--model");
      return modelFlagIndex >= 0 && args[modelFlagIndex + 1] === "chat-owned-model";
    })).toBe(true);
  });

  it("stores private scoped chats outside the project bundle and applies approved graph changes", async () => {
    const { projectRoot, storageRoot } = await setupProject();
    const artifactsBefore = await readdir(path.join(projectRoot, ".archicode", "artifacts"));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Expand this node with researched detail."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant");

    expect(assistant?.changeSet?.operations).toHaveLength(1);
    expect((await loadProject(projectRoot)).flows[0]?.nodes.some((node) => node.id === "node-research-added")).toBe(false);

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const artifactsAfter = await readdir(path.join(projectRoot, ".archicode", "artifacts"));
    const loaded = await loadProject(projectRoot);
    const chats = await listResearchChats(projectRoot);
    const localFiles = (await readdir(path.join(storageRoot, "research-chats")))
      .filter((name) => name.endsWith(".json"));

    expect(result.results[0]?.status).toBe("applied");
    expect(result.session.messages.find((message) => message.id === assistant!.id)?.changeSet?.reviewedAt).toBeTruthy();
    await expect(applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    })).rejects.toThrow(/already reviewed/);
    expect(loaded.flows[0]?.nodes.some((node) => node.id === "node-research-added")).toBe(true);
    expect(JSON.stringify(loaded)).not.toContain("Expand this node with researched detail.");
    expect(chats[0]?.messages.some((message) => message.content.includes("I found a useful graph expansion"))).toBe(true);
    expect(chats[0]?.messages.some((message) => message.content.includes("internal note should stay hidden"))).toBe(false);
    expect(localFiles.length).toBe(1);
    expect(artifactsAfter).toEqual(artifactsBefore);
  });

  it("treats an active run in another flow as a project-wide Research graph lock", async () => {
    const proposedChangeSet = {
      summary: "Add a research node",
      operations: [{
        kind: "create-node",
        flowId: "flow-main",
        node: {
          id: "node-research-added",
          type: "task",
          title: "Research Added",
          description: "Created from research chat."
        }
      }]
    };
    const { projectRoot, promptPath } = await setupProject(localResearchSinkTurn(
      "I prepared the requested graph review card.",
      [graphChangeSink(proposedChangeSet)]
    ), true);
    await writeActiveResearchLockRun(projectRoot, { flowId: "flow-not-in-chat" });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });
    await updateResearchChatAutoApproval({
      projectRoot,
      sessionId: session.id,
      autoApproveGraphChanges: { enabled: true, includeDestructive: false }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Create the graph addition now."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant");
    const prompt = await readFile(promptPath!, "utf8");
    const loaded = await loadProject(projectRoot);

    expect(prompt).toContain('"graphEditingLock": {');
    expect(prompt).toContain('"locked": true');
    expect(prompt).toContain("run-active-research-lock");
    expect(prompt).toContain("GRAPH PERSISTENCE LOCK:");
    expect(assistant?.changeSet?.operations).toHaveLength(1);
    expect(assistant?.changeSet?.reviewedAt).toBeUndefined();
    expect(assistant?.content).toContain("This review card is prepared for later");
    expect(loaded.flows[0]?.nodes.some((node) => node.id === "node-research-added")).toBe(false);
  });

  it("rejects applying a stale Research graph card after a project run becomes active", async () => {
    const { projectRoot } = await setupProject();
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Prepare the graph addition."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);
    await writeActiveResearchLockRun(projectRoot, { status: "awaiting-code-review" });

    await expect(applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    })).rejects.toThrow(/Graph editing is locked.*run-active-research-lock \(awaiting-code-review\)/);

    expect((await loadProject(projectRoot)).flows[0]?.nodes.some((node) => node.id === "node-research-added")).toBe(false);
  });

  it("normalizes blank root-node references and applies dependent graph operations without a synthetic todo", async () => {
    const firstAnswer = JSON.stringify({
      archicodeResearch: {
        answer: "I can add a Contact Us page and update the related graph nodes. Should I prepare this exact scope as the graph review card?",
        summary: "Prepared the Contact Us page scope."
      }
    });
    const reviewCard = JSON.stringify({
      archicodeResearch: {
        answer: "Here's the review card with all the precise updates.",
        summary: "Prepared the Contact Us graph changes.",
        changeSet: {
          summary: "Add Contact Us Page node, edge, and update project nodes",
          operations: [
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-contact-page",
                type: "task",
                title: "Contact Us Page",
                description: "Add the /contact route.",
                stage: "planned",
                subflowId: "",
                groupId: "",
                parentId: "",
                moduleProfileId: "",
                techStack: ["Vue Router"],
                acceptanceCriteria: ["Contact page is reachable at /contact"]
              }
            },
            {
              kind: "create-edge",
              flowId: "flow-main",
              edge: { id: "", source: "node-project", target: "node-contact-page", label: "includes" }
            },
            {
              kind: "update-node",
              flowId: "flow-main",
              patch: { id: "node-project", description: "The project includes a Contact Us page." }
            },
            {
              kind: "update-node",
              flowId: "flow-main",
              patch: { id: "node-orchestrator", description: "The orchestrator accounts for the Contact Us page." }
            }
          ]
        }
      }
    });
    const { projectRoot } = await setupProject([firstAnswer, reviewCard]);
    const bundle = await loadProject(projectRoot);
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id } });

    const scoped = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "add a contact us page"
    });
    expect(scoped.memory.todos).toEqual([]);

    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "yes" });
    const assistant = [...answered.messages].reverse().find((message) => message.role === "assistant" && Boolean(message.changeSet));
    const createNodeOperation = assistant?.changeSet?.operations[0];
    expect(createNodeOperation?.kind).toBe("create-node");
    if (createNodeOperation?.kind === "create-node") {
      expect(createNodeOperation.node.subflowId).toBeUndefined();
      expect(createNodeOperation.node.groupId).toBeUndefined();
      expect(createNodeOperation.node.parentId).toBeUndefined();
      expect(createNodeOperation.node.moduleProfileId).toBeUndefined();
    }
    expect(answered.memory.todos).toEqual([]);

    const reviewed = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });
    const flow = reviewed.bundle.flows.find((item) => item.id === "flow-main")!;
    expect(reviewed.results.every((result) => result.status === "applied")).toBe(true);
    const contactNode = flow.nodes.find((node) => node.id === "node-contact-page");
    expect(contactNode).not.toHaveProperty("subflowId");
    expect(contactNode).not.toHaveProperty("groupId");
    expect(flow.edges.some((edge) => edge.source === "node-project" && edge.target === "node-contact-page")).toBe(true);
    expect(reviewed.session.memory.todos).toEqual([]);
  });

  it("reports causal validation errors without repeating them on independent accepted operations", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Prepared a graph card.",
        changeSet: {
          summary: "Invalid dependent graph card",
          operations: [
            {
              kind: "create-node",
              flowId: "flow-main",
              node: { id: "node-invalid", title: "Invalid", subflowId: "subflow-missing" }
            },
            {
              kind: "create-edge",
              flowId: "flow-main",
              edge: { source: "node-project", target: "node-invalid" }
            },
            {
              kind: "update-node",
              flowId: "flow-main",
              patch: { id: "node-project", description: "This valid update remains unapplied atomically." }
            }
          ]
        }
      }
    }));
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-seed" } });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "prepare the invalid card" });
    const assistant = answered.messages.find((message) => message.role === "assistant" && Boolean(message.changeSet));
    const reviewed = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });

    expect(reviewed.results[0]?.message).toBe("Subflow subflow-missing was not found.");
    expect(reviewed.results[1]?.message).toBe("Target node node-invalid was not found.");
    expect(reviewed.results[2]?.message).toContain("graph changes are transactional");
    expect(reviewed.results[2]?.message).not.toContain("Subflow subflow-missing");
    expect(reviewed.bundle.flows[0]?.nodes.find((node) => node.id === "node-project")?.description).not.toContain("valid update remains unapplied");
  });

  it("repairs dependency order and applies nodes that target a flow created by the same review card", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Prepared a dependent multi-flow card.",
        changeSet: {
          summary: "Create and populate a new flow",
          operations: [
            {
              kind: "create-edge",
              flowId: "flow-new-platform",
              edge: { id: "edge-new-platform", source: "node-new-start", target: "node-new-finish" }
            },
            {
              kind: "create-node",
              flowId: "flow-new-platform",
              node: { id: "node-new-start", title: "Start" }
            },
            {
              kind: "create-node",
              flowId: "flow-new-platform",
              node: { id: "node-new-finish", title: "Finish" }
            },
            {
              kind: "create-flow",
              flow: {
                id: "flow-new-platform",
                name: "New Platform",
                description: "A flow created and populated atomically.",
                nodes: [],
                edges: [],
                subflows: [],
                groups: []
              }
            }
          ]
        }
      }
    }));
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-seed" } });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "prepare the new flow" });
    const assistant = answered.messages.find((message) => message.role === "assistant" && Boolean(message.changeSet));
    const reviewed = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });
    const flow = reviewed.bundle.flows.find((item) => item.id === "flow-new-platform");

    expect(reviewed.results).toHaveLength(4);
    expect(reviewed.results.every((result) => result.status === "applied")).toBe(true);
    expect(flow?.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["node-new-start", "node-new-finish"]));
    expect(flow?.edges.some((edge) => edge.id === "edge-new-platform")).toBe(true);
  });

  it("keeps connected new-flow nodes on the root canvas when the same card also creates a linked detail flow", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Prepared a root flow with one linked detail flow.",
        changeSet: {
          summary: "Create a populated flow with root and detail topology",
          operations: [
            {
              kind: "create-flow",
              flow: {
                id: "flow-new-with-details",
                name: "New Flow With Details",
                description: "A root topology with a linked detail canvas.",
                nodes: [],
                edges: [],
                subflows: [],
                groups: []
              }
            },
            {
              kind: "create-subflow",
              flowId: "flow-new-with-details",
              subflow: { id: "subflow-new-details", name: "New Details" }
            },
            {
              kind: "create-node",
              flowId: "flow-new-with-details",
              node: { id: "node-new-owner", title: "Details Owner" }
            },
            {
              kind: "create-node",
              flowId: "flow-new-with-details",
              node: { id: "node-new-root-peer", title: "Root Peer" }
            },
            {
              kind: "create-node",
              flowId: "flow-new-with-details",
              node: { id: "node-new-detail-child", title: "Detail Child", subflowId: "subflow-new-details" }
            },
            {
              kind: "create-edge",
              flowId: "flow-new-with-details",
              edge: { id: "edge-new-root-topology", source: "node-new-owner", target: "node-new-root-peer" }
            },
            {
              kind: "link-node-subflow",
              flowId: "flow-new-with-details",
              nodeId: "node-new-owner",
              subflowId: "subflow-new-details"
            }
          ]
        }
      }
    }));
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-seed" } });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "prepare the mixed root and detail flow" });
    const assistant = answered.messages.find((message) => message.role === "assistant" && Boolean(message.changeSet));
    const reviewed = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });
    const flow = reviewed.bundle.flows.find((item) => item.id === "flow-new-with-details");

    expect(reviewed.results.every((result) => result.status === "applied")).toBe(true);
    expect(flow?.nodes.find((node) => node.id === "node-new-owner")?.subflowId).toBeUndefined();
    expect(flow?.nodes.find((node) => node.id === "node-new-root-peer")?.subflowId).toBeUndefined();
    expect(flow?.nodes.find((node) => node.id === "node-new-detail-child")?.subflowId).toBe("subflow-new-details");
    expect(flow?.subflows.find((subflow) => subflow.id === "subflow-new-details")?.parentNodeId).toBe("node-new-owner");
  });

  it("retries an all-failed reviewed graph card without regenerating its operations", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Prepared a card that targets a temporarily missing node.",
        changeSet: {
          summary: "Update the retry target",
          operations: [{
            kind: "update-node",
            flowId: "flow-main",
            patch: { id: "node-retry-target", description: "Recovered from the retained review card." }
          }]
        }
      }
    }));
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-seed" } });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "prepare the retained card" });
    const assistant = answered.messages.find((message) => message.role === "assistant" && Boolean(message.changeSet));
    const firstReview = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    expect(firstReview.results[0]?.status).toBe("failed");

    const beforeRetry = await loadProject(projectRoot);
    const flow = beforeRetry.flows.find((item) => item.id === "flow-main")!;
    const template = flow.nodes[0]!;
    await saveFlow(projectRoot, {
      ...flow,
      nodes: [...flow.nodes, {
        ...template,
        id: "node-retry-target",
        title: "Retry Target",
        description: "Before retry",
        position: { x: template.position.x + 330, y: template.position.y }
      }]
    });

    const retried = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }],
      retryReviewed: true
    });
    const retryTarget = retried.bundle.flows.find((item) => item.id === "flow-main")?.nodes.find((node) => node.id === "node-retry-target");

    expect(retried.results[0]?.status).toBe("applied");
    expect(retryTarget?.description).toBe("Recovered from the retained review card.");
    expect(retried.session.messages.some((message) => message.content.startsWith("Graph changes retry reviewed: 1 applied"))).toBe(true);
  });

  it("rejects newly-created detail-flow child nodes that omit node.subflowId", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Prepared a detail subflow and child nodes.",
        summary: "Prepared detail subflow card.",
        changeSet: {
          summary: "Break landing page into a detail flow",
          operations: [
            {
              kind: "create-subflow",
              flowId: "flow-main",
              subflow: {
                id: "subflow-landing-sections",
                name: "Landing Page Sections",
                parentNodeId: "node-project"
              }
            },
            {
              kind: "link-node-subflow",
              flowId: "flow-main",
              nodeId: "node-project",
              subflowId: "subflow-landing-sections"
            },
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-landing-hero",
                type: "feature",
                title: "Hero Section",
                description: "Owns the top landing-page hero section.",
                stage: "draft",
                techStack: ["Vue"],
                acceptanceCriteria: ["Hero content is present."]
              }
            },
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-landing-cta",
                type: "feature",
                title: "CTA Section",
                description: "Owns the closing landing-page call to action.",
                stage: "draft",
                techStack: ["Vue"],
                acceptanceCriteria: ["CTA content is present."]
              }
            },
            {
              kind: "create-edge",
              flowId: "flow-main",
              edge: {
                source: "node-landing-hero",
                target: "node-landing-cta",
                label: "followed by"
              }
            }
          ]
        }
      }
    }));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Create a landing page detail flow."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });
    const flow = (await loadProject(projectRoot)).flows[0]!;

    expect(result.results.every((item) => item.status === "failed")).toBe(true);
    expect(result.results[0]?.message).toContain("missing node.subflowId");
    expect(result.results[0]?.message).toContain('"subflowId": "subflow-landing-sections"');
    expect(flow.subflows.some((subflow) => subflow.id === "subflow-landing-sections")).toBe(false);
    expect(flow.nodes.some((node) => node.id === "node-landing-hero")).toBe(false);
  });

  it("normalizes child operations that mistakenly use a new subflow id as operation.flowId", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Prepared a detail subflow and child nodes.",
        summary: "Prepared detail subflow card.",
        changeSet: {
          summary: "Break landing page into a detail flow",
          operations: [
            {
              kind: "create-subflow",
              flowId: "flow-main",
              subflow: {
                id: "subflow-landing-sections",
                name: "Landing Page Sections",
                parentNodeId: "node-project"
              }
            },
            {
              kind: "link-node-subflow",
              flowId: "flow-main",
              nodeId: "node-project",
              subflowId: "subflow-landing-sections"
            },
            {
              kind: "create-node",
              flowId: "subflow-landing-sections",
              node: {
                id: "node-landing-hero",
                type: "feature",
                title: "Hero Section",
                description: "Owns the top landing-page hero section.",
                stage: "draft",
                techStack: ["Vue"],
                acceptanceCriteria: ["Hero content is present."]
              }
            },
            {
              kind: "create-node",
              flowId: "subflow-landing-sections",
              node: {
                id: "node-landing-cta",
                type: "feature",
                title: "CTA Section",
                description: "Owns the closing landing-page call to action.",
                stage: "draft",
                techStack: ["Vue"],
                acceptanceCriteria: ["CTA content is present."]
              }
            },
            {
              kind: "create-edge",
              flowId: "subflow-landing-sections",
              edge: {
                source: "node-landing-hero",
                target: "node-landing-cta",
                label: "followed by"
              }
            }
          ]
        }
      }
    }));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Create a landing page detail flow."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);
    const heroOperation = assistant?.changeSet?.operations.find((operation) => operation.kind === "create-node" && operation.node.id === "node-landing-hero");
    const edgeOperation = assistant?.changeSet?.operations.find((operation) => operation.kind === "create-edge");

    expect(heroOperation).toMatchObject({
      kind: "create-node",
      flowId: "flow-main",
      node: {
        subflowId: "subflow-landing-sections"
      }
    });
    expect(edgeOperation).toMatchObject({
      kind: "create-edge",
      flowId: "flow-main"
    });

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });
    const flow = (await loadProject(projectRoot)).flows[0]!;

    expect(result.results.every((item) => item.status === "applied")).toBe(true);
    expect(flow.subflows.some((subflow) => subflow.id === "subflow-landing-sections")).toBe(true);
    expect(flow.nodes.find((node) => node.id === "node-landing-hero")?.subflowId).toBe("subflow-landing-sections");
    expect(flow.edges.some((edge) => edge.source === "node-landing-hero" && edge.target === "node-landing-cta")).toBe(true);
  });

  it("applies a detail-subflow card whose nodes and edges reference earlier operations in the same card", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Prepared the landing-page detail subflow for review.",
        summary: "Prepared a sequenced detail-subflow card.",
        changeSet: {
          summary: "Create a landing-page detail subflow",
          operations: [
            {
              kind: "create-subflow",
              flowId: "flow-main",
              subflow: {
                id: "subflow-landing-sections",
                name: "Landing Page Sections",
                parentNodeId: "node-project"
              }
            },
            {
              kind: "link-node-subflow",
              flowId: "flow-main",
              nodeId: "node-project",
              subflowId: "subflow-landing-sections"
            },
            {
              kind: "update-node",
              flowId: "flow-main",
              patch: {
                id: "node-project",
                visual: {}
              }
            },
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-landing-hero",
                type: "feature",
                title: "Hero Section",
                description: "Owns the landing-page hero.",
                stage: "draft",
                subflowId: "subflow-landing-sections",
                position: { x: 100, y: 100 }
              }
            },
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-landing-value",
                type: "feature",
                title: "Value Proposition",
                description: "Owns the landing-page value proposition.",
                stage: "draft",
                subflowId: "subflow-landing-sections",
                position: { relativeToNodeId: "node-landing-hero", placement: "right" }
              }
            },
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-landing-benefits",
                type: "feature",
                title: "Benefits Grid",
                description: "Owns the landing-page benefits grid.",
                stage: "draft",
                subflowId: "subflow-landing-sections",
                position: { relativeToNodeId: "node-landing-value", placement: "right" }
              }
            },
            {
              kind: "create-edge",
              flowId: "flow-main",
              edge: {
                id: "edge-landing-hero-value",
                source: "node-landing-hero",
                target: "node-landing-value",
                label: "followed by"
              }
            },
            {
              kind: "create-edge",
              flowId: "flow-main",
              edge: {
                id: "edge-landing-value-benefits",
                source: "node-landing-value",
                target: "node-landing-benefits",
                label: "followed by"
              }
            }
          ]
        }
      }
    }));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Create the approved landing-page detail flow."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });
    const flow = (await loadProject(projectRoot)).flows[0]!;
    const hero = flow.nodes.find((node) => node.id === "node-landing-hero");
    const value = flow.nodes.find((node) => node.id === "node-landing-value");
    const benefits = flow.nodes.find((node) => node.id === "node-landing-benefits");

    expect(result.results.every((item) => item.status === "applied")).toBe(true);
    expect(result.results[2]?.message).toContain("Already up to date");
    expect(hero?.subflowId).toBe("subflow-landing-sections");
    expect(value?.subflowId).toBe("subflow-landing-sections");
    expect(benefits?.subflowId).toBe("subflow-landing-sections");
    expect(hero?.position).toEqual({ x: 100, y: 100 });
    expect(value?.position).toEqual({ x: 430, y: 100 });
    expect(benefits?.position).toEqual({ x: 760, y: 100 });
    expect(flow.edges.some((edge) => edge.id === "edge-landing-hero-value")).toBe(true);
    expect(flow.edges.some((edge) => edge.id === "edge-landing-value-benefits")).toBe(true);
  });

  it("keeps a backup and recovers when the chat store file is corrupted", async () => {
    const { projectRoot, storageRoot } = await setupProject();
    const created = await createResearchChat({ projectRoot, scope: { type: "flow", flowId: "flow-main" } });
    // A second write means the previous good store is copied to <file>.bak.
    await renameResearchChat(projectRoot, created.id, "Renamed research chat");

    const storeFile = researchStorageFile(storageRoot, projectRoot);
    const backup = JSON.parse(await readFile(`${storeFile}.bak`, "utf8"));
    expect(backup.sessions?.[0]?.id).toBe(created.id);

    // Corrupt the primary file; a read should recover from the backup and
    // preserve the corrupt bytes rather than silently returning empty.
    await writeFile(storeFile, "{ this is not valid json", "utf8");
    const recovered = await listResearchChats(projectRoot);
    expect(recovered.some((session) => session.id === created.id)).toBe(true);
    const sidecars = await readdir(path.join(storageRoot, "research-chats"));
    expect(sidecars.some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("reconciles legacy Sherlock source-index false failures when loading chats", async () => {
    const { projectRoot, storageRoot } = await setupProject();
    const created = await createResearchChat({ projectRoot, scope: { type: "flow", flowId: "flow-main" } });
    const storeFile = researchStorageFile(storageRoot, projectRoot);
    const store = JSON.parse(await readFile(storeFile, "utf8"));
    store.sessions[0].messages.push({
      id: "assistant-with-legacy-sherlock-run",
      role: "assistant",
      content: "Sherlock's evidence-backed report is ready.",
      createdAt: "2026-07-15T00:01:00.000Z",
      subagentRuns: [{
        id: "legacy-sherlock-run",
        kind: "sherlock-research",
        status: "failed",
        title: "Investigate the codebase",
        argumentsJson: JSON.stringify({ objective: "Audit the codebase", mode: "codebase" }),
        progress: [],
        resultSummary: "Sherlock completed without a structured sources list.",
        error: "Sherlock completed without a structured sources list.",
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:01:00.000Z"
      }]
    });
    await writeFile(storeFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");

    const [loaded] = await listResearchChats(projectRoot);
    const run = loaded.messages.flatMap((message) => message.subagentRuns).find((item) => item.id === "legacy-sherlock-run");
    expect(run?.status).toBe("completed");
    expect(run?.error).toBeUndefined();
    expect(run?.resultSummary).toContain("evidence-backed findings");
    expect(loaded.id).toBe(created.id);
  });

  it("refuses to overwrite an unreadable store with no recoverable backup", async () => {
    const { projectRoot, storageRoot } = await setupProject();
    const storeDir = path.join(storageRoot, "research-chats");
    await mkdir(storeDir, { recursive: true });
    // Corrupt primary, no .bak present: a mutation must fail loudly, not clobber.
    await writeFile(researchStorageFile(storageRoot, projectRoot), "corrupt", "utf8");
    await expect(renameResearchChat(projectRoot, "any-session", "x")).rejects.toThrow(/could not read/i);
    const sidecars = await readdir(storeDir);
    expect(sidecars.some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("captures graph changes and folds memory from native sink-tool calls in one provider call", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-sink-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.ANTHROPIC_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "anthropic-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ANTHROPIC_RESEARCH_TEST_KEY" }
        : { ...provider, enabled: false })
    });

    // One assistant turn: prose answer + graph, canvas, and memory tool calls.
    const fetchMock = vi.fn().mockResolvedValue(streamingAnthropicResponse([
      { type: "text", text: "Here is the proposed graph expansion." },
      {
        type: "tool_use",
        id: "tu-canvas",
        name: "archicode_control_canvas",
        input: {
          flowId: "flow-main",
          nodeIds: ["node-orchestrator"],
          groupIds: [],
          selection: "replace",
          viewport: { mode: "fit", padding: 0.3, maxZoom: 1.1 }
        }
      },
      {
        type: "tool_use",
        id: "tu-changeset",
        name: "archicode_propose_graph_change_set",
        input: {
          summary: "Add a research node",
          operations: [{
            kind: "create-node",
            flowId: "flow-main",
            node: { id: "node-sink-added", type: "task", title: "Sink Added", description: "Created via tool call." }
          }]
        }
      },
      {
        type: "tool_use",
        id: "tu-memory",
        name: "archicode_update_memory",
        input: { summary: "Agreed to add a research node via the sink tool." }
      }
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const session = await createResearchChat({ projectRoot, scope: { type: "flow", flowId: "flow-main" } });
    const streamedTokens: string[] = [];
    const updated = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Expand the flow",
      activeFlowId: "flow-main",
      activeSubflowId: null,
      onToken: (text) => streamedTokens.push(text)
    });

    // Prose streamed through the (tool-using) turn instead of arriving all at once.
    expect(streamedTokens.join("")).toContain("Here is the proposed graph expansion.");
    // Exactly one provider round-trip: the memory delta was folded in, not a second call.
    expect(fetchMock.mock.calls.length).toBe(1);
    // The request was made with streaming enabled.
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).stream).toBe(true);
    // Tools are advertised to the model.
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { tools?: Array<{ name?: string }> };
    expect(body.tools?.some((tool) => tool.name === "archicode_propose_graph_change_set")).toBe(true);
    expect(body.tools?.some((tool) => tool.name === "archicode_control_canvas")).toBe(true);
    expect(body.tools?.some((tool) => tool.name === "archicode_update_memory")).toBe(true);

    const assistant = updated.messages.find((message) => message.role === "assistant" && Boolean(message.changeSet));
    expect(assistant?.content).toContain("Here is the proposed graph expansion.");
    expect(assistant?.content).not.toContain("archicode_propose_graph_change_set");
    expect(assistant?.usage?.contextMode).toBe("compact");
    expect(assistant?.usage?.contextSections?.some((section) => section.label === "scope")).toBe(true);
    expect(assistant?.changeSet?.operations[0]).toMatchObject({ kind: "create-node" });
    expect(assistant?.canvasAction).toMatchObject({
      flowId: "flow-main",
      subflowId: null,
      nodeIds: ["node-orchestrator"],
      selection: "replace",
      viewport: { mode: "fit" }
    });
    // The pending change set is not auto-applied.
    expect(assistant?.changeSet?.reviewedAt).toBeFalsy();
    // Folded memory delta was applied.
    expect(updated.memory.summary).toContain("Agreed to add a research node");
  });

  it("does not infer a canvas action from user prose when the model omits the canvas tool", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Zooming out — wider view incoming!"
      }
    }), true);
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-seed" } });

    const updated = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "صغّر عرض اللوحة قليلاً كي أرى عقداً أكثر",
      activeFlowId: "flow-main",
      activeSubflowId: null,
      selectedNodeIds: ["node-orchestrator"]
    });

    const assistant = [...updated.messages].reverse().find((message) => message.role === "assistant");
    expect(assistant?.canvasAction).toBeUndefined();
    expect(await readFile(promptPath!, "utf8")).toContain("Prose cannot move the canvas");
  });

  it("does not spend a second provider round repairing an omitted memory decision", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-memory-skip-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.ANTHROPIC_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "anthropic-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ANTHROPIC_RESEARCH_TEST_KEY" }
        : { ...provider, enabled: false })
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(streamingAnthropicResponse([
      { type: "text", text: "Yes — I would add a Contact Page as a sibling to Landing Page and About Page." }
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id } });
    const updated = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "we need to add a new contact page to the website"
    });

    expect(fetchMock.mock.calls.length).toBe(1);
    expect(updated.memory.summary).toBe("Yes — I would add a Contact Page as a sibling to Landing Page and About Page.");
    expect(updated.memory.todos).toEqual([]);
    expect(updated.memory.lastUpdateError).toBeUndefined();
  });

  it("applies a model-chosen memory tool update without assuming English keywords", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-memory-semantic-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.ANTHROPIC_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "anthropic-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ANTHROPIC_RESEARCH_TEST_KEY" }
        : { ...provider, enabled: false })
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(streamingAnthropicResponse([
      { type: "text", text: "سأراجع تصميم صفحة التواصل في الجلسة القادمة." },
      {
        type: "tool_use",
        id: "tu-memory-ar",
        name: "archicode_update_memory",
        input: {
          summary: "طلب المستخدم مراجعة تصميم صفحة التواصل.",
          todos: [{ title: "مراجعة تصميم صفحة التواصل", status: "open", notes: "متابعة في الجلسة القادمة", sourceMessageIds: [] }]
        }
      }
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id } });
    const updated = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "راجع تصميم صفحة التواصل في الجلسة القادمة"
    });

    expect(fetchMock.mock.calls.length).toBe(1);
    expect(updated.memory.todos).toHaveLength(1);
    expect(updated.memory.todos[0]).toMatchObject({
      title: "مراجعة تصميم صفحة التواصل",
      status: "open"
    });
    expect(updated.memory.todos[0]?.sourceMessageIds.length).toBeGreaterThanOrEqual(2);
  });

  it("serializes concurrent turns on the same session without clobbering messages", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-concurrent-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.ANTHROPIC_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "anthropic-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ANTHROPIC_RESEARCH_TEST_KEY" }
        : { ...provider, enabled: false })
    });
    // Every provider/memory call just returns a short text block.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "ok" }])));

    const session = await createResearchChat({ projectRoot, scope: { type: "flow", flowId: "flow-main" } });
    // Fire two turns on the SAME session at once; without per-session
    // serialization the later persist would overwrite the earlier turn.
    await Promise.all([
      sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "first message" }),
      sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "second message" })
    ]);

    const finalSession = (await listResearchChats(projectRoot))[0]!;
    const userContents = finalSession.messages.filter((message) => message.role === "user").map((message) => message.content);
    expect(userContents).toContain("first message");
    expect(userContents).toContain("second message");
    // Two full turns preserved: two user messages + two assistant replies.
    expect(finalSession.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(finalSession.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("auto-approves non-destructive graph changes when enabled for the project research toggle", async () => {
    const { projectRoot } = await setupProject();
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    expect(session.autoApproveGraphChanges.enabled).toBe(false);
    const updated = await updateResearchChatAutoApproval({
      projectRoot,
      sessionId: session.id,
      autoApproveGraphChanges: { enabled: true, includeDestructive: false }
    });
    expect(updated.autoApproveGraphChanges.enabled).toBe(true);
    expect((await listResearchChats(projectRoot))[0]?.autoApproveGraphChanges.enabled).toBe(true);
    expect((await loadProject(projectRoot)).project.settings.researchAutoApproveGraphChanges.enabled).toBe(true);

    const secondSession = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-archicode" }
    });
    expect(secondSession.autoApproveGraphChanges.enabled).toBe(true);

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Vibe design a small addition."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);
    const loaded = await loadProject(projectRoot);

    expect(assistant?.changeSet?.reviewedAt).toBeTruthy();
    expect(answered.messages.some((message) => message.role === "system" && message.content.startsWith("Auto-approved graph changes: 1 applied"))).toBe(true);
    expect(loaded.flows[0]?.nodes.some((node) => node.id === "node-research-added")).toBe(true);
  });

  it("extracts relative existing-node reposition cards instead of showing raw JSON", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({ archicodeResearch: { answer: "unused" } }));
    const before = await loadProject(projectRoot);
    const [anchorBefore, targetBefore] = before.flows[0]!.nodes.slice(0, 2);
    const output = JSON.stringify({
      archicodeResearch: {
        answer: `Prepared a review card to place ${targetBefore!.title} visually below ${anchorBefore!.title}.`,
        summary: "Prepared a relative reposition card.",
        changeSet: {
          summary: `Reposition ${targetBefore!.title}`,
          operations: [
            {
              kind: "update-node",
              flowId: "flow-main",
              patch: {
                id: targetBefore!.id,
                position: {
                  relativeToNodeId: anchorBefore!.id,
                  placement: "below"
                }
              }
            }
          ]
        }
      }
    }, null, 2);
    const command = await createFakeResearchCodex(projectRoot, output);
    await updateProjectSettings(projectRoot, {
      ...before.project.settings,
      providers: before.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "move the architecture node visually below the product goal"
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);

    expect(anchorBefore).toBeTruthy();
    expect(targetBefore).toBeTruthy();
    expect(assistant?.content).toContain("Prepared a review card");
    expect(assistant?.content).not.toContain("\"archicodeResearch\"");
    expect(assistant?.changeSet?.operations).toHaveLength(1);

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const after = await loadProject(projectRoot);
    const targetAfter = after.flows[0]!.nodes.find((node) => node.id === targetBefore!.id);

    expect(result.results[0]?.status).toBe("applied");
    expect(targetAfter?.position).toEqual({
      x: anchorBefore!.position.x,
      y: anchorBefore!.position.y + 220
    });
    expect(targetAfter?.position).not.toEqual(targetBefore?.position);
  });

  it("applies relative placement when creating a node so first-try layout respects graph intent", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({ archicodeResearch: { answer: "unused" } }));
    const before = await loadProject(projectRoot);
    const anchorBefore = before.flows[0]!.nodes[0];
    const output = JSON.stringify({
      archicodeResearch: {
        answer: `Prepared a review card to add Contact Us below ${anchorBefore!.title}.`,
        summary: "Prepared a create-node card with relative placement.",
        changeSet: {
          summary: "Create Contact Us below anchor node",
          operations: [
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-contact-page",
                type: "feature",
                title: "Contact Us",
                description: "Add a contact route that matches the shared site layout and gives visitors a clear way to reach the team.",
                techStack: ["Vue Router", "Responsive CSS"],
                acceptanceCriteria: [
                  "Contact page is reachable at /contact",
                  "Page includes a clear heading and contact section"
                ],
                positionHint: {
                  relativeToNodeId: anchorBefore!.id,
                  placement: "below"
                }
              }
            }
          ]
        }
      }
    }, null, 2);
    const command = await createFakeResearchCodex(projectRoot, output);
    await updateProjectSettings(projectRoot, {
      ...before.project.settings,
      providers: before.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "add a contact page below the about page"
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);

    expect(anchorBefore).toBeTruthy();
    expect(assistant?.content).toContain("Prepared a review card");
    expect(assistant?.content).not.toContain("\"archicodeResearch\"");
    expect(assistant?.changeSet?.operations).toHaveLength(1);

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const after = await loadProject(projectRoot);
    const created = after.flows[0]!.nodes.find((node) => node.id === "node-contact-page");

    expect(result.results[0]?.status).toBe("applied");
    expect(created?.position).toEqual({
      x: anchorBefore!.position.x,
      y: anchorBefore!.position.y + 220
    });
  });

  it("tells Research to use description for persisted node text", async () => {
    const { projectRoot, promptPath } = await setupProject(undefined, true);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "add a graph node"
    });

    const prompt = await readFile(promptPath!, "utf8");
    expect(prompt).toContain('"patch": { "id": string, "title": string, "description": string');
    expect(prompt).toContain('"node": { "id": string, "type": string, "title": string, "description": string');
    expect(prompt).not.toContain('"title": string, "summary": string, "acceptanceCriteria"');
  });

  it("fails no-op update-node review cards instead of pretending they applied", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({ archicodeResearch: { answer: "unused" } }));
    const before = await loadProject(projectRoot);
    const targetBefore = before.flows[0]!.nodes[1];
    const output = JSON.stringify({
      archicodeResearch: {
        answer: `Prepared a review card to move ${targetBefore!.title}.`,
        summary: "Prepared a graph review card.",
        changeSet: {
          summary: `Move ${targetBefore!.title}`,
          operations: [
            {
              kind: "update-node",
              flowId: "flow-main",
              patch: {
                id: targetBefore!.id,
                visual: {}
              }
            }
          ]
        }
      }
    }, null, 2);
    const command = await createFakeResearchCodex(projectRoot, output);
    await updateProjectSettings(projectRoot, {
      ...before.project.settings,
      providers: before.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "move the architecture node"
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);
    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const after = await loadProject(projectRoot);
    const targetAfter = after.flows[0]!.nodes.find((node) => node.id === targetBefore!.id);

    expect(result.results[0]?.status).toBe("failed");
    expect(result.results[0]?.message).toContain("does not change any persisted fields");
    expect(targetAfter?.position).toEqual(targetBefore?.position);
    expect(targetAfter?.visual).toEqual(targetBefore?.visual);
  });

  it("separates current message image attachments from node note context images in Research chat prompts", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can see the visual reference.",
        summary: "Reviewed visual reference."
      }
    }), true);
    const noteImagePath = path.join(projectRoot, "note-reference.png");
    const messageImagePath = path.join(projectRoot, "message-attachment.png");
    await writeTinyPng(noteImagePath);
    await writeTinyPng(messageImagePath);
    const withNote = await addNote(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Use the attached image when answering.",
      resolved: false
    });
    const noteId = withNote.notes.find((note) => note.body.includes("attached image"))!.id;
    await attachNodeReferences(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      noteId,
      filePaths: [noteImagePath]
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "What does the image I attached imply?",
      filePaths: [messageImagePath]
    });

    const prompt = await readFile(promptPath!, "utf8");
    const attachmentBlock = prompt.slice(prompt.indexOf("Attached images"), prompt.indexOf("User message:"));
    expect(attachmentBlock).toContain("Attached images (current chat message only):");
    expect(attachmentBlock).toContain("The user attached only the images in this section to their current chat message.");
    expect(attachmentBlock).toContain("message-attachment.png");
    expect(attachmentBlock).toContain("[current user message]");
    expect(attachmentBlock).not.toContain("note-reference.png");
    expect(prompt).toContain('"imageAttachments"');
    expect(prompt).toContain('"source": "node-note-attachment"');
    expect(prompt).toContain("note-reference.png");
  });

  it("includes field-level pending graph changes in Research chat prompts", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Here is what changed on the graph.",
        summary: "Reported pending graph changes."
      }
    }), true);
    await updateNode(projectRoot, "flow-main", {
      id: "node-project",
      description: "Pending contract change awaiting a build."
    }, "user");
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "What is pending on this node?"
    });

    const prompt = await readFile(promptPath!, "utf8");
    expect(prompt).toContain('"pendingGraphChanges"');
    expect(prompt).toContain("Pending contract change awaiting a build.");
    expect(prompt).toContain("awaiting a build/verify run");
  });

  it("generates testable acceptance checks from a node's acceptance criteria via the LLM", async () => {
    const draftedChecks = JSON.stringify([
      { criterion: "Users can reset their password by email", testCommand: "npm test -- password-reset" },
      { criterion: "Login is rate limited", testCommand: "npm test -- rate-limit" }
    ]);
    const { projectRoot } = await setupProject(draftedChecks);
    const bundle = await loadProject(projectRoot);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    await updateNode(projectRoot, flow.id, {
      id: node.id,
      acceptanceCriteria: ["Users can reset their password by email", "Login is rate limited"]
    }, "user");

    const updated = await generateAcceptanceChecksFromCriteria(projectRoot, flow.id, node.id);
    const checks = updated.flows.find((item) => item.id === flow.id)?.nodes.find((item) => item.id === node.id)?.acceptanceChecks ?? [];

    expect(checks).toHaveLength(2);
    expect(checks.map((check) => check.criterion)).toEqual(expect.arrayContaining([
      "Users can reset their password by email",
      "Login is rate limited"
    ]));
    expect(checks.every((check) => check.testCommand?.includes("npm test"))).toBe(true);
    expect(checks.every((check) => check.status === "unverified")).toBe(true);
  });

  it("batch-generates acceptance checks across every eligible node in a flow", async () => {
    const drafted = JSON.stringify([{ criterion: "Behaviour is verified", testCommand: "npm test -- behaviour" }]);
    const { projectRoot } = await setupProject(drafted);
    const bundle = await loadProject(projectRoot);
    const flow = bundle.flows[0]!;
    const [first, second] = flow.nodes;
    await updateNode(projectRoot, flow.id, { id: first!.id, acceptanceCriteria: ["Alpha behaviour works"] }, "user");
    await updateNode(projectRoot, flow.id, { id: second!.id, acceptanceCriteria: ["Beta behaviour works"] }, "user");

    const { results } = await generateAcceptanceChecksScoped(projectRoot, flow.id);

    const after = await loadProject(projectRoot);
    const afterFlow = after.flows.find((item) => item.id === flow.id)!;
    expect(afterFlow.nodes.find((item) => item.id === first!.id)?.acceptanceChecks.length).toBeGreaterThan(0);
    expect(afterFlow.nodes.find((item) => item.id === second!.id)?.acceptanceChecks.length).toBeGreaterThan(0);
    expect(results.filter((result) => result.added > 0).length).toBeGreaterThanOrEqual(2);
  });

  it("parses wrapped/fenced/aliased acceptance-check generation output", async () => {
    // Model wraps the array in an object under "checks", fences it, and uses the
    // "test" key alias instead of "testCommand" — all of which must still parse.
    const wrapped = "Here you go:\n```json\n" + JSON.stringify({
      checks: [{ criterion: "Login is rate limited", test: "npm test -- rate-limit" }]
    }) + "\n```";
    const { projectRoot } = await setupProject(wrapped);
    const bundle = await loadProject(projectRoot);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    await updateNode(projectRoot, flow.id, { id: node.id, acceptanceCriteria: ["Login is rate limited"] }, "user");

    const updated = await generateAcceptanceChecksFromCriteria(projectRoot, flow.id, node.id);
    const checks = updated.flows.find((item) => item.id === flow.id)?.nodes.find((item) => item.id === node.id)?.acceptanceChecks ?? [];

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ criterion: "Login is rate limited", testCommand: "npm test -- rate-limit", status: "unverified" });
  });

  it("refuses to generate acceptance checks when the node has no criteria", async () => {
    const { projectRoot } = await setupProject("[]");
    const bundle = await loadProject(projectRoot);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    await updateNode(projectRoot, flow.id, { id: node.id, acceptanceCriteria: [] }, "user");

    await expect(generateAcceptanceChecksFromCriteria(projectRoot, flow.id, node.id))
      .rejects.toThrow(/no acceptance criteria/i);
  });

  it("includes node-scoped note images from structural scope without reading user-language keywords", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-visual-move-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const noteImagePath = path.join(projectRoot, "note-reference.png");
    await writeTinyPng(noteImagePath);
    const withNote = await addNote(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Reference screenshot for the node.",
      resolved: false
    });
    const noteId = withNote.notes.find((note) => note.body.includes("Reference screenshot"))!.id;
    await attachNodeReferences(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      noteId,
      filePaths: [noteImagePath]
    });
    const fetchMock = vi.fn().mockResolvedValue(streamingChatCompletionResponse("Moved without attaching note images."));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "حرّك العقدة إلى الموضع المناسب في المخطط"
    });

    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMessage = firstBody.messages.find((message) => message.role === "user");

    expect(Array.isArray(userMessage?.content)).toBe(true);
    expect(JSON.stringify(userMessage?.content)).toContain("image_url");
  });

  it("includes current message text documents without auto-inlining node note text documents", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I read the uploaded text document.",
        summary: "Reviewed text attachment."
      }
    }), true);
    const noteDocPath = path.join(projectRoot, "note-context.md");
    const messageDocPath = path.join(projectRoot, "message-notes.txt");
    await writeFile(noteDocPath, "COMMENT ONLY DETAILS SHOULD STAY METADATA UNTIL ASKED", "utf8");
    await writeFile(messageDocPath, "CURRENT MESSAGE DETAILS SHOULD BE READ", "utf8");
    const withNote = await addNote(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Design reference document.",
      resolved: false
    });
    const noteId = withNote.notes.find((note) => note.body.includes("Design reference"))!.id;
    await attachNodeReferences(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      noteId,
      filePaths: [noteDocPath]
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Please summarize the text file I attached.",
      filePaths: [messageDocPath]
    });

    const prompt = await readFile(promptPath!, "utf8");
    const textAttachmentBlock = prompt.slice(prompt.indexOf("Attached text documents"), prompt.indexOf("User message:"));
    expect(textAttachmentBlock).toContain("message-notes.txt [current user message]");
    expect(textAttachmentBlock).toContain("CURRENT MESSAGE DETAILS SHOULD BE READ");
    expect(textAttachmentBlock).not.toContain("COMMENT ONLY DETAILS SHOULD STAY METADATA UNTIL ASKED");
    expect(prompt).toContain('"textAttachments"');
    expect(prompt).toContain('"source": "node-note-attachment"');
    expect(prompt).toContain("note-context.md");
    expect(answered.messages.find((message) => message.role === "user")?.attachmentIds).toHaveLength(1);
  });

  it("extracts current message PDF and DOCX attachments into Research chat prompts", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I read both document attachments.",
        summary: "Reviewed PDF and DOCX attachments."
      }
    }), true);
    const pdfPath = path.join(projectRoot, "message-reference.pdf");
    const docxPath = path.join(projectRoot, "message-reference.docx");
    await writeTinyPdf(pdfPath);
    await writeTinyDocx(docxPath);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Please summarize the documents I attached.",
      filePaths: [pdfPath, docxPath]
    });

    const prompt = await readFile(promptPath!, "utf8");
    const textAttachmentBlock = prompt.slice(prompt.indexOf("Attached text documents"), prompt.indexOf("User message:"));
    expect(textAttachmentBlock).toContain("message-reference.pdf [current user message]");
    expect(textAttachmentBlock).toContain("application/pdf");
    expect(textAttachmentBlock).toContain("PDF attachment details for tests.");
    expect(textAttachmentBlock).toContain("message-reference.docx [current user message]");
    expect(textAttachmentBlock).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(textAttachmentBlock).toContain("DOCX attachment details for tests.");
    expect(textAttachmentBlock).toContain("[text extracted from document attachment]");
    const loaded = await loadProject(projectRoot);
    const pdfArtifact = loaded.artifacts.find((artifact) => artifact.title === "message-reference.pdf")!;
    const docxArtifact = loaded.artifacts.find((artifact) => artifact.title === "message-reference.docx")!;
    await expect(readArtifactText(projectRoot, pdfArtifact.path)).resolves.toContain("PDF attachment details for tests.");
    await expect(readArtifactText(projectRoot, docxArtifact.path)).resolves.toContain("DOCX attachment details for tests.");
  });

  it("includes node-scoped note text documents regardless of the user's language", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "The note document says to prioritize checkout copy.",
        summary: "Reviewed node note document."
      }
    }), true);
    const noteDocPath = path.join(projectRoot, "note-context.md");
    await writeFile(noteDocPath, "COMMENT DOCUMENT CONTENT INCLUDED ON REQUEST", "utf8");
    const withNote = await addNote(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Attached strategy document.",
      resolved: false
    });
    const noteId = withNote.notes.find((note) => note.body.includes("strategy document"))!.id;
    await attachNodeReferences(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      noteId,
      filePaths: [noteDocPath]
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "اقرأ المرجع المرفق بهذه العقدة وفسّر محتواه"
    });

    const prompt = await readFile(promptPath!, "utf8");
    const textAttachmentBlock = prompt.slice(prompt.indexOf("Attached text documents"), prompt.indexOf("User message:"));
    expect(textAttachmentBlock).toContain("note-context.md [scoped graph note]");
    expect(textAttachmentBlock).toContain("COMMENT DOCUMENT CONTENT INCLUDED ON REQUEST");
  });

  it("includes node-scoped note images regardless of the user's language", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "The node note image is available for inspection.",
        summary: "Reviewed node note image."
      }
    }), true);
    const noteImagePath = path.join(projectRoot, "note-reference.png");
    await writeTinyPng(noteImagePath);
    const withNote = await addNote(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Screenshot reference.",
      resolved: false
    });
    const noteId = withNote.notes.find((note) => note.body.includes("Screenshot reference"))!.id;
    await attachNodeReferences(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      noteId,
      filePaths: [noteImagePath]
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "ما الموجود في المرجع البصري المرتبط بهذه العقدة؟"
    });

    const prompt = await readFile(promptPath!, "utf8");
    const attachmentBlock = prompt.slice(prompt.indexOf("Attached images"), prompt.indexOf("User message:"));
    expect(attachmentBlock).toContain("Context images from scoped graph notes/notes. There are no current chat-message image attachments in this turn:");
    expect(attachmentBlock).toContain("note-reference.png");
    expect(attachmentBlock).toContain("[scoped graph note]");
  });

  it("marks Codex local stream tokens as provisional thinking until the final output is read", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-project-"));
    const storageRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-storage-"));
    setResearchStorageRoot(storageRoot);
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "Final answer text.",
        summary: "Answered after reasoning."
      }
    });
    const command = await createStreamingFakeResearchCodex(projectRoot, output, [
      { type: "response.reasoning_text.delta", delta: "Checking context..." },
      { type: "assistant_message_delta", delta: "Final answer text." }
    ]);
    const bundle = await ensureFixtureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });
    const tokens: Array<{ text: string; kind?: "answer" | "thinking" }> = [];

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Stream reasoning then answer.",
      onToken: (text, kind) => tokens.push({ text, kind })
    });

    expect(tokens).toEqual([
      { text: "Checking context...", kind: "thinking" },
      { text: "Final answer text.", kind: "thinking" }
    ]);
  });

  it("persists a pending assistant draft while a research reply is still in flight", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-project-"));
    const storageRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-storage-"));
    setResearchStorageRoot(storageRoot);
    const command = await createDelayedResearchCodex(projectRoot, JSON.stringify({
      archicodeResearch: {
        answer: "Final persisted answer.",
        summary: "Saved after delay."
      }
    }), 150);
    const bundle = await ensureFixtureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });

    const pendingResponse = sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Keep this chat alive while I switch away."
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    const pendingSession = (await listResearchChats(projectRoot)).find((item) => item.id === session.id);
    const pendingAssistant = pendingSession?.messages[pendingSession.messages.length - 1];
    expect(pendingAssistant?.id.startsWith("research-waiting")).toBe(true);
    expect(pendingAssistant?.role).toBe("assistant");
    expect(isResearchThinkingPhrase(pendingAssistant?.content ?? "")).toBe(true);

    const answeredSession = await pendingResponse;
    const finalAssistant = answeredSession.messages[answeredSession.messages.length - 1];
    expect(finalAssistant?.id.startsWith("research-waiting")).toBe(false);
    expect(finalAssistant?.content).toContain("Final persisted answer.");
  });

  it("retries a failed research response in place without duplicating the user message", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-retry-"));
    const storageRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-storage-"));
    setResearchStorageRoot(storageRoot);
    const command = await createScriptedResearchCodex(projectRoot, [
      { exitCode: 1, stderr: "temporary provider outage" },
      {
        exitCode: 0,
        output: JSON.stringify({
          archicodeResearch: {
            answer: "Recovered answer after retry.",
            summary: "Retry succeeded."
          }
        })
      }
    ]);
    const bundle = await ensureFixtureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });

    const failed = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Which nodes still need implementation work?"
    });
    const failedAssistant = failed.messages.at(-1);

    expect(failed.messages).toHaveLength(2);
    expect(failed.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(failedAssistant?.role).toBe("assistant");
    expect(failedAssistant?.content).toContain("Codex Local failed.");
    expect(failedAssistant?.error).toContain("temporary provider outage");

    const retried = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Which nodes still need implementation work?",
      retryAssistantMessageId: failedAssistant?.id
    });

    expect(retried.messages).toHaveLength(2);
    expect(retried.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(retried.messages.some((message) => message.id === failedAssistant?.id)).toBe(false);
    expect(retried.messages.at(-1)?.error).toBeUndefined();
    expect(retried.messages.at(-1)?.content).toContain("Recovered answer after retry.");
  });

  it("spaces approved research-created nodes into readable columns based on their graph relationships", async () => {
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "I prepared the game-loop structure as a graph edit.",
        summary: "Added game loop structure.",
        changeSet: {
          summary: "Add runner gameplay nodes",
          operations: [
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-core-loop",
                type: "feature",
                title: "Core Game Loop",
                description: "Coordinates the repeating runner update loop."
              }
            },
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-player-jump",
                type: "component",
                title: "Player Jump Controls",
                description: "Handles jump timing and player input."
              }
            },
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-obstacles-collision",
                type: "component",
                title: "Obstacles And Collision",
                description: "Spawns obstacles and resolves collisions."
              }
            },
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-score-restart",
                type: "component",
                title: "Score And Restart",
                description: "Tracks score and handles restart state."
              }
            },
            {
              kind: "create-edge",
              flowId: "flow-main",
              edge: {
                source: "node-project",
                target: "node-core-loop",
                label: "expands"
              }
            },
            {
              kind: "create-edge",
              flowId: "flow-main",
              edge: {
                source: "node-core-loop",
                target: "node-player-jump",
                label: "controls"
              }
            },
            {
              kind: "create-edge",
              flowId: "flow-main",
              edge: {
                source: "node-core-loop",
                target: "node-obstacles-collision",
                label: "checks"
              }
            },
            {
              kind: "create-edge",
              flowId: "flow-main",
              edge: {
                source: "node-core-loop",
                target: "node-score-restart",
                label: "updates"
              }
            }
          ]
        }
      }
    });
    const { projectRoot } = await setupProject(output);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Sketch the game loop structure."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);
    await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });

    const flow = (await loadProject(projectRoot)).flows[0]!;
    const projectNode = flow.nodes.find((node) => node.id === "node-project")!;
    const coreLoop = flow.nodes.find((node) => node.id === "node-core-loop")!;
    const playerJump = flow.nodes.find((node) => node.id === "node-player-jump")!;
    const obstacles = flow.nodes.find((node) => node.id === "node-obstacles-collision")!;
    const scoreRestart = flow.nodes.find((node) => node.id === "node-score-restart")!;
    const createdPositions = [coreLoop, playerJump, obstacles, scoreRestart].map((node) => `${node.position.x},${node.position.y}`);

    expect(new Set(createdPositions).size).toBe(createdPositions.length);
    expect(coreLoop.position.x).toBeGreaterThan(projectNode.position.x);
    expect(playerJump.position.x).toBeGreaterThan(coreLoop.position.x);
    expect(obstacles.position.x).toBe(playerJump.position.x);
    expect(scoreRestart.position.x).toBe(playerJump.position.x);
    expect(new Set([playerJump.position.y, obstacles.position.y, scoreRestart.position.y]).size).toBe(3);
  });

  it("uses a balanced grid fallback when an older review card creates nodes without edges", async () => {
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "I prepared four legacy disconnected nodes.",
        summary: "Added legacy disconnected nodes.",
        changeSet: {
          summary: "Add disconnected legacy nodes",
          operations: ["Alpha", "Beta", "Gamma", "Delta"].map((title) => ({
            kind: "create-node",
            flowId: "flow-main",
            node: {
              id: `node-${title.toLowerCase()}`,
              type: "feature",
              title,
              description: `${title} is retained from a review card produced before connected Picasso topology became mandatory.`
            }
          }))
        }
      }
    });
    const { projectRoot } = await setupProject(output);
    const session = await createResearchChat({ projectRoot, scope: { type: "flow", flowId: "flow-main" } });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Add the legacy nodes." });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);
    await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });

    const created = (await loadProject(projectRoot)).flows[0]!.nodes.filter((node) => node.id.startsWith("node-") && ["Alpha", "Beta", "Gamma", "Delta"].includes(node.title));
    expect(new Set(created.map((node) => node.position.x)).size).toBeGreaterThan(1);
    expect(new Set(created.map((node) => `${node.position.x},${node.position.y}`)).size).toBe(4);
  });

  it("keeps mixed graph and run action change sets manual even when session auto-approval is enabled", async () => {
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "I can add a node and queue implementation.",
        summary: "Mixed graph and queue proposal.",
        changeSet: {
          summary: "Design and queue",
          operations: [
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-auto-mixed",
                type: "task",
                title: "Auto Mixed",
                description: "This should wait because the change set also queues work."
              }
            },
            {
              kind: "start-agent-run",
              flowId: "flow-main",
              nodeId: "node-project",
              promptSummary: "Implement the selected node.",
              allowShell: false,
              reusableApproval: false
            }
          ]
        }
      }
    });
    const { projectRoot } = await setupProject(output);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });
    await updateResearchChatAutoApproval({
      projectRoot,
      sessionId: session.id,
      autoApproveGraphChanges: { enabled: true, includeDestructive: false }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Design and queue this."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);
    const loaded = await loadProject(projectRoot);

    expect(assistant?.changeSet?.reviewedAt).toBeUndefined();
    expect(answered.messages.some((message) => message.role === "system" && message.content.startsWith("Auto-approved graph changes"))).toBe(false);
    expect(loaded.flows[0]?.nodes.some((node) => node.id === "node-auto-mixed")).toBe(false);
  });

  it("repairs a flow id copied into the optional AI Implement node anchor", async () => {
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "I can queue implementation for the main flow.",
        summary: "Prepared a flow-wide implementation handoff.",
        changeSet: {
          summary: "Queue main-flow implementation",
          operations: [{
            kind: "start-agent-run",
            flowId: "flow-main",
            nodeId: "flow-main",
            scope: {
              kind: "flow",
              flowId: "flow-main",
              nodeIds: [],
              label: "Main flow"
            },
            promptSummary: "Implement the main flow.",
            allowShell: false,
            reusableApproval: false
          }]
        }
      }
    });
    const { projectRoot } = await setupProject(output);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Queue implementation for the main flow."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);
    const operation = assistant?.changeSet?.operations[0];

    expect(operation).toMatchObject({
      kind: "start-agent-run",
      flowId: "flow-main",
      scope: { kind: "flow", flowId: "flow-main", nodeIds: [] }
    });
    expect(operation && "nodeId" in operation ? operation.nodeId : undefined).toBeUndefined();

    const reviewed = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const queued = reviewed.bundle.runs.find((run) => run.promptSummary === "Implement the main flow.");

    expect(reviewed.results[0]?.status).toBe("applied");
    expect(queued?.nodeId).toBeUndefined();
    expect(queued?.scope).toMatchObject({ kind: "flow", flowId: "flow-main", nodeIds: [] });
    expect(reviewed.session.messages.some((message) => message.role === "system" && message.content === "Queue submission reviewed: 1 queued, 0 rejected, 0 failed.")).toBe(true);
    const queueReport = [...reviewed.session.messages].reverse().find((message) => message.role === "assistant" && message.content.startsWith("Queue submission complete for"));
    expect(queueReport?.content).toContain("1 queued, 0 rejected, 0 failed.");
    expect(queueReport?.content).toContain("Queued: AI Implement for flow-main.");
    expect(queueReport?.content).not.toContain("Graph review");
  });

  it("rechecks a copied flow id against fresh graph state when reviewing a retained card", async () => {
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "I can queue implementation for the retained flow card.",
        changeSet: {
          summary: "Queue retained flow implementation",
          operations: [{
            kind: "start-agent-run",
            flowId: "flow-main",
            nodeId: "flow-main",
            scope: { kind: "flow", flowId: "flow-main", nodeIds: [] },
            promptSummary: "Implement the retained main-flow card.",
            allowShell: false,
            reusableApproval: false
          }]
        }
      }
    });
    const { projectRoot } = await setupProject(output);
    const initialBundle = await loadProject(projectRoot);
    const initialFlow = initialBundle.flows.find((flow) => flow.id === "flow-main")!;
    const template = initialFlow.nodes[0]!;
    await saveFlow(projectRoot, {
      ...initialFlow,
      nodes: [...initialFlow.nodes, {
        ...template,
        id: "flow-main",
        title: "Temporary Colliding Node",
        position: { x: template.position.x + 360, y: template.position.y }
      }]
    });

    const session = await createResearchChat({ projectRoot, scope: { type: "flow", flowId: "flow-main" } });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Prepare the retained flow implementation card."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);
    const capturedOperation = assistant?.changeSet?.operations[0];
    expect(capturedOperation && "nodeId" in capturedOperation ? capturedOperation.nodeId : undefined).toBe("flow-main");

    const beforeReview = await loadProject(projectRoot);
    const flowBeforeReview = beforeReview.flows.find((flow) => flow.id === "flow-main")!;
    await saveFlow(projectRoot, {
      ...flowBeforeReview,
      nodes: flowBeforeReview.nodes.filter((node) => node.id !== "flow-main")
    });

    const reviewed = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const queued = reviewed.bundle.runs.find((run) => run.promptSummary === "Implement the retained main-flow card.");

    expect(reviewed.results[0]?.status).toBe("applied");
    expect(queued?.nodeId).toBeUndefined();
    expect(queued?.scope?.kind).toBe("flow");
  });

  it("passes research-authored guidance to queued AI Implement runs", async () => {
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "I can queue implementation with a focused handoff note.",
        summary: "Prepared implementation handoff guidance.",
        changeSet: {
          summary: "Queue guided implementation",
          operations: [
            {
              kind: "start-agent-run",
              flowId: "flow-main",
              nodeId: "node-project",
              providerId: "openai-compatible",
              scope: {
                kind: "nodes",
                flowId: "flow-main",
                nodeIds: ["node-project", "node-orchestrator"],
                label: "Starter app core"
              },
              promptSummary: "Implement the graph-backed starter app.",
              allowShell: false,
              reusableApproval: false,
              guidance: {
                text: "Use the graph as source of truth and scaffold only the smallest runnable app.",
                evidence: ["node-notes"]
              }
            }
          ]
        }
      }
    });
    const { projectRoot } = await setupProject(output);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Queue implementation."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);
    const queuedOperation = assistant?.changeSet?.operations[0];
    expect(queuedOperation && "providerId" in queuedOperation ? queuedOperation.providerId : undefined).toBeUndefined();

    await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });

    const queued = (await loadProject(projectRoot)).runs.find((run) => run.promptSummary === "Implement the graph-backed starter app.");
    expect(queued?.providerId).toBe("codex-local");
    expect(queued?.scope).toMatchObject({
      kind: "nodes",
      flowId: "flow-main",
      nodeIds: ["node-project", "node-orchestrator"],
      label: "Starter app core"
    });
    expect(queued?.affectedNodeIds).toEqual(expect.arrayContaining(["node-project", "node-orchestrator"]));
    expect(queued?.guidance?.source).toBe("research-agent");
    expect(queued?.guidance?.text).toContain("graph as source of truth");
    expect(queued?.guidance?.evidence).toContain("node-notes");
    expect(queued?.logs.some((line) => line.text === "Research agent run guidance was attached.")).toBe(true);
  });

  it("passes internal no-scope AI Implement requests without graph node focus", async () => {
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "I can queue that tiny text edit for implementation.",
        summary: "Prepared no-scope implementation handoff.",
        changeSet: {
          summary: "Queue quick text edit",
          operations: [
            {
              kind: "start-agent-run",
              flowId: "flow-main",
              scope: {
                kind: "no-scope",
                flowId: "flow-main",
                nodeIds: [],
                label: "Quick text edit"
              },
              promptSummary: "Change the settings page button copy from Save to Apply.",
              allowShell: false,
              reusableApproval: false,
              guidance: {
                text: "This is a trivial copy-only source edit; do not change graph nodes unless the code contradicts graph truth.",
                evidence: []
              }
            }
          ]
        }
      }
    });
    const { projectRoot } = await setupProject(output);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "In the settings page, change Save to Apply."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);

    await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });

    const queued = (await loadProject(projectRoot)).runs.find((run) => run.promptSummary === "Change the settings page button copy from Save to Apply.");
    expect(queued?.scope).toMatchObject({
      kind: "no-scope",
      flowId: "flow-main",
      nodeIds: [],
      label: "Quick text edit"
    });
    expect(queued?.nodeId).toBeUndefined();
    expect(queued?.affectedNodeIds).toEqual([]);
    expect(queued?.guidance?.source).toBe("research-agent");
  });

  it("updates structured research memory after a successful assistant turn", async () => {
    const { projectRoot } = await setupProject(localResearchSinkTurn(
      "Use the onboarding route as the first pass.",
      [memorySink({
          summary: "The chat decided to prioritize onboarding.",
          decisions: [{ text: "Use the onboarding route as the first pass.", sourceMessageIds: ["msg-user", "msg-assistant"] }],
          todos: [{ title: "Review onboarding copy", status: "open" }],
          openQuestions: [{ text: "Which onboarding copy should ship first?" }],
          files: [{ path: "src/routes/onboarding.tsx", note: "Defines the onboarding route." }],
          artifacts: [{ artifactId: "artifact-plan", type: "plan", title: "Onboarding plan" }],
          images: [{ artifactId: "artifact-screenshot", title: "Onboarding screenshot", summary: "Shows a narrow hero layout." }],
          links: [{ url: "https://example.com/onboarding", title: "Onboarding reference" }]
      })]
    ));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Plan the onboarding route."
    });

    expect(answered.memory.summary).toContain("prioritize onboarding");
    expect(answered.summary).toBe(answered.memory.summary);
    expect(answered.memory.decisions.some((item) => item.text.includes("onboarding route"))).toBe(true);
    expect(answered.memory.todos[0]?.title).toBe("Review onboarding copy");
    expect(answered.memory.openQuestions[0]?.question).toBe("Which onboarding copy should ship first?");
    expect(answered.memory.fileRefs[0]?.path).toBe("src/routes/onboarding.tsx");
    expect(answered.memory.artifactRefs[0]?.artifactId).toBe("artifact-plan");
    expect(answered.memory.imageRefs[0]?.visualSummary).toBe("Shows a narrow hero layout.");
    expect(answered.memory.links[0]?.url).toBe("https://example.com/onboarding");
  });

  it("does not launch a Claude Local repair turn for an omitted memory decision", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-claude-project-"));
    const storageRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-claude-storage-"));
    setResearchStorageRoot(storageRoot);
    const command = await createFakeResearchClaude(projectRoot, [
      JSON.stringify({
        archicodeResearch: {
          answer: "I can help plan the contact page and graph updates.",
          summary: "Discussed the contact page."
        }
      }),
      localResearchSinkTurn("", [memorySink({
        summary: "The user asked to plan the Contact Page and related graph updates.",
        todos: [{ title: "Plan the Contact Page", status: "open", notes: "Graph planning is pending." }]
      })])
    ]);
    const bundle = await ensureFixtureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "claude-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Can you help me plan the contact page?"
    });

    expect(answered.memory.summary).toBe("Discussed the contact page.");
    expect(answered.memory.todos).toEqual([]);
    expect(answered.memory.lastUpdateError).toBeUndefined();
  });

  it("tracks active orchestration todos from graph review cards", async () => {
    const firstResponse = JSON.stringify({
      archicodeResearch: {
        answer: "I prepared the first graph step for review.",
        summary: "Prepared the landing content graph step.",
        changeSet: {
          summary: "Create landing content skeleton",
          operations: [
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-landing-copy",
                type: "task",
                title: "Landing Copy",
                description: "Draft landing page copy."
              }
            }
          ]
        }
      }
    });
    const followupResponse = JSON.stringify({
      archicodeResearch: {
        answer: "I can see the landing content skeleton is still waiting for approval.",
        summary: "Checked active work."
      }
    });
    const { projectRoot, promptPath } = await setupProject([
      firstResponse,
      followupResponse
    ], true);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const proposed = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Prepare the landing content graph."
    });

    const changeMessage = proposed.messages.find((message) => message.changeSet);
    expect(changeMessage?.changeSet?.summary).toBe("Create landing content skeleton");
    expect(proposed.orchestration.todos[0]?.title).toBe("Create landing content skeleton");
    expect(proposed.orchestration.todos[0]?.status).toBe("awaiting-approval");

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "What is still active?"
    });
    const prompts = (await readFile(promptPath!, "utf8")).split("--- prompt boundary ---");
    expect(prompts.some((prompt) => prompt.includes("Active research orchestration todos") && prompt.includes("Create landing content skeleton"))).toBe(true);

    const applied = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: session.id,
      messageId: changeMessage!.id,
      changeSetId: changeMessage!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    expect(applied.results[0]?.status).toBe("applied");
    expect(applied.session.orchestration.todos.find((todo) => todo.changeSetId === changeMessage!.changeSet!.id)?.status).toBe("done");
  });

  it("accepts awaiting-approval todo statuses in research memory deltas", async () => {
    const changeSet = {
      summary: "Move Deepseek Test node under About Page",
      operations: [
        {
          kind: "update-node",
          flowId: "flow-main",
          patch: {
            id: "node-deepseek-test",
            positionHint: {
              relativeToNodeId: "node-about-page",
              placement: "below"
            }
          }
        }
      ]
    };
    const { projectRoot } = await setupProject(localResearchSinkTurn(
      "I prepared the graph change for review.",
      [graphChangeSink(changeSet), memorySink({
          summary: "A graph move was prepared and is waiting for user review.",
          todos: [
            {
              title: "Review the proposed graph move",
              status: "awaiting-approval",
              notes: "The user needs to approve the graph change card first."
            }
          ]
      })]
    ));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Move the Deepseek Test node below the About Page node."
    });

    expect(answered.memory.lastUpdateError).toBeUndefined();
    expect(answered.memory.todos[0]).toEqual(expect.objectContaining({
      title: "Review the proposed graph move",
      status: "awaiting-approval"
    }));
  });

  it("normalizes model-invented todo and question status aliases without losing the memory update", async () => {
    const { projectRoot } = await setupProject(localResearchSinkTurn(
      "I recorded the pending project work and questions.",
      [memorySink({
        summary: "The project goal is recorded and its open questions are awaiting user input.",
        todos: [{ title: "Prepare the first project draft", status: "pending" }],
        openQuestions: [
          { question: "Which audience comes first?", status: "awaiting_user" },
          { question: "Which visual direction should be used?", status: "waiting-for-user" },
          { question: "Which unsupported status should not break memory?", status: "model-specific-state" }
        ]
      })]
    ));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Please remember the project goal and the questions you need me to answer."
    });

    expect(answered.memory.lastUpdateError).toBeUndefined();
    expect(answered.memory.summary).toContain("project goal is recorded");
    expect(answered.memory.todos[0]).toEqual(expect.objectContaining({
      title: "Prepare the first project draft",
      status: "open"
    }));
    expect(answered.memory.openQuestions).toHaveLength(3);
    expect(answered.memory.openQuestions.every((question) => question.status === "open")).toBe(true);
  });

  it("normalizes shorthand text arrays in research memory deltas", async () => {
    const { projectRoot, promptPath } = await setupProject(localResearchSinkTurn(
      "Hi, I can help with this project.",
      [memorySink({
          summary: "The user greeted the research agent.",
          facts: ["The active project is a Vue/Vite website."],
          assumptions: ["The user may want project orientation next."],
          links: [
            { title: "No actual URL yet" },
            { href: "https://example.com/research-notes", title: "Research notes" }
          ],
          debugFindings: ["No project files were inspected during the greeting."]
      })]
    ), true);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "hi"
    });

    expect(answered.memory.lastUpdateError).toBeUndefined();
    expect(answered.memory.facts[0]?.text).toBe("The active project is a Vue/Vite website.");
    expect(answered.memory.assumptions[0]?.text).toBe("The user may want project orientation next.");
    expect(answered.memory.links).toHaveLength(1);
    expect(answered.memory.links[0]?.url).toBe("https://example.com/research-notes");
    expect(answered.memory.debugFindings[0]?.text).toBe("No project files were inspected during the greeting.");
  });

  it("drops malformed research memory todos instead of failing the whole memory update", async () => {
    const { projectRoot } = await setupProject(localResearchSinkTurn(
      "I finished the subagent report.",
      [memorySink({
          summary: "The chat recorded the subagent outcome.",
          todos: [
            { status: "awaiting-approval", notes: "Missing a title, should be ignored." },
            { text: "Review the proposed graph update", status: "awaiting-approval" }
          ]
      })]
    ), true);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "What happened after the subagent run?"
    });

    expect(answered.memory.lastUpdateError).toBeUndefined();
    expect(answered.memory.todos).toEqual([
      expect.objectContaining({
        title: "Review the proposed graph update",
        status: "awaiting-approval"
      })
    ]);
  });

  it("preserves earlier durable research summary when later deltas only summarize the latest turn", async () => {
    const { projectRoot, promptPath } = await setupProject([
      localResearchSinkTurn("Use the onboarding route as the first pass.", [
        memorySink({ summary: "The chat decided to prioritize onboarding." })
      ]),
      localResearchSinkTurn("Compare pricing after onboarding.", [
        memorySink({ summary: "The chat decided to compare pricing after onboarding." })
      ])
    ], true);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Plan the onboarding route."
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Now compare pricing."
    });

    expect(answered.memory.summary).toContain("prioritize onboarding");
    expect(answered.memory.summary).toContain("compare pricing");
    const prompts = (await readFile(promptPath!, "utf8")).split("--- prompt boundary ---").map((part) => part.trim()).filter(Boolean);
    expect(prompts.some((prompt) => prompt.includes("long-term compass for future research turns"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("concise cumulative meeting notes"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("ArchiCode folds conversation summary, approvals, tool results, subagent outcomes, and goal progress"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("never omit both tools"))).toBe(false);
  });

  it("infers graph ref kinds in research memory deltas", async () => {
    const { projectRoot } = await setupProject(localResearchSinkTurn(
      "The Product Goal is the useful anchor.",
      [memorySink({
          summary: "The chat discussed graph context.",
          graphRefs: [
            { flowId: "flow-main", nodeId: "node-project", title: "Product Goal" },
            { flowId: "flow-main", title: "Website Plan" }
          ]
      })]
    ));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "What is this node?"
    });

    expect(answered.memory.lastUpdateError).toBeUndefined();
    expect(answered.memory.graphRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "node", flowId: "flow-main", nodeId: "node-project" }),
      expect.objectContaining({ kind: "flow", flowId: "flow-main" })
    ]));
  });

  it("accepts null placeholders for optional graph ref ids from memory providers", async () => {
    const { projectRoot } = await setupProject(localResearchSinkTurn(
      "The flow assessment is complete.",
      [memorySink({
          summary: "Picasso assessed the current flow.",
          graphRefs: [
            { kind: "flow", flowId: "flow-main", subflowId: null, nodeId: null, title: "Website Plan" },
            { kind: "node", flowId: "flow-main", subflowId: null, nodeId: "node-project", title: "Product Goal" }
          ]
      })]
    ));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Assess the current flow."
    });

    expect(answered.memory.lastUpdateError).toBeUndefined();
    expect(answered.memory.graphRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "flow", flowId: "flow-main", title: "Website Plan" }),
      expect.objectContaining({ kind: "node", flowId: "flow-main", nodeId: "node-project", title: "Product Goal" })
    ]));
  });

  it("compacts old research messages into memory before omitting them from the main prompt", async () => {
    const { projectRoot, storageRoot, promptPath } = await setupProject([
      JSON.stringify({
        researchMemoryDelta: {
          summary: "Older discussion captured.",
          facts: [{ text: "Old message 0 established the auth constraint.", sourceMessageIds: ["old-0"] }]
        }
      }),
      JSON.stringify({
        archicodeResearch: {
          answer: "Recent context is enough.",
          summary: "Answered with compacted memory."
        }
      })
    ], true);
    const created = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });
    const oldMessages = Array.from({ length: 260 }, (_, index) => ({
      id: `old-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Old message ${index}`,
      createdAt: `2026-06-24T10:${String(index).padStart(2, "0")}:00.000Z`,
      attachmentIds: [],
      webUsed: false,
      mcpToolCalls: []
    }));
    await writeFile(researchStorageFile(storageRoot, projectRoot), `${JSON.stringify({
      projectRoot,
      sessions: [{ ...created, messages: oldMessages, updatedAt: "2026-06-24T10:14:00.000Z" }]
    }, null, 2)}\n`, "utf8");

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: created.id,
      content: "Continue from there."
    });
    const prompts = (await readFile(promptPath!, "utf8")).split("--- prompt boundary ---").map((part) => part.trim()).filter(Boolean);

    // The compaction boundary tracks the batched-eviction prompt window: with
    // 261 tiny messages and a 64-message limit the window starts at old-204,
    // so everything through old-203 must be folded into memory.
    expect(answered.memory.lastCompactedMessageId).toBe("old-203");
    expect(answered.memory.facts.some((fact) => fact.text.includes("auth constraint"))).toBe(true);
    expect(prompts[0]).toContain("Research memory delta JSON contract");
    expect(prompts[0]).toContain("top-level shape: { \"researchMemoryDelta\": { ... } }");
    expect(prompts[1]).toContain("Research session memory");
    expect(prompts[1]).toContain("Research changeSet JSON contract");
    expect(prompts[1]).toContain("top-level shape: { \"archicodeResearch\": { ... } }");
    expect(prompts[1]).not.toMatch(/^User: Old message 0$/m);
    expect(prompts[1]).not.toMatch(/^Assistant: Old message 1$/m);
    expect(prompts[1]).not.toContain("Old message 203");
    expect(prompts[1]).toContain("Old message 204");
  });

  it("applies approved research note lifecycle changes", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-notes-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    const stale = await addNote(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "This note is stale.",
      resolved: false
    });
    const wrong = await addNote(projectRoot, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "This note should be deleted.",
      resolved: false
    });
    const staleId = stale.notes.find((note) => note.body.includes("stale"))!.id;
    const wrongId = wrong.notes.find((note) => note.body.includes("deleted"))!.id;
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "I can clean this node feedback up through graph operations.",
        summary: "Proposed note lifecycle cleanup.",
        changeSet: {
          summary: "Clean up stale node notes",
          operations: [
            { kind: "resolve-note", noteId: staleId, resolved: true },
            { kind: "delete-note", noteId: wrongId }
          ]
        }
      }
    });
    const command = await createFakeResearchCodex(projectRoot, output);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Clean up stale notes."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant");
    await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [
        { operationIndex: 0, decision: "accepted" },
        { operationIndex: 1, decision: "accepted" }
      ]
    });
    const loaded = await loadProject(projectRoot);

    expect(loaded.notes.find((note) => note.id === staleId)?.resolved).toBe(true);
    expect(loaded.notes.some((note) => note.id === wrongId)).toBe(false);
  });

  it("reports exact add-note visibility after graph review", async () => {
    const { projectRoot } = await setupProject([
      JSON.stringify({
        archicodeResearch: {
          answer: "I prepared a traceability note.",
          summary: "Prepared traceability note.",
          changeSet: {
            summary: "Add traceability note",
            operations: [
              {
                kind: "add-note",
                note: {
                  flowId: "flow-main",
                  nodeId: "node-project",
                  kind: "system-note",
                  author: "llm",
                  body: "Merge resolution traceability note.",
                  category: "note",
                  priority: "low",
                  attachmentIds: [],
                  resolved: false,
                  pinned: false
                }
              }
            ]
          }
        }
      })
    ]);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Add a traceability note."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant");
    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const loaded = await loadProject(projectRoot);
    const traceabilityNote = loaded.notes.find((note) => note.body === "Merge resolution traceability note.");
    const report = [...result.session.messages].reverse().find((message) => message.role === "assistant" && message.content.includes("Graph review complete"));
    const projectNodeTitle = loaded.flows[0]?.nodes.find((node) => node.id === "node-project")?.title;

    expect(traceabilityNote?.pinned).toBe(false);
    expect(result.results[0]).toMatchObject({ status: "applied" });
    expect(report?.content).toContain(`Added unpinned system note on ${projectNodeTitle}`);
    expect(report?.content).toContain("Relevant notes filter may hide it");
    expect(report?.content).not.toContain("pinned on");
  });

  it("applies approved project, flow, edge, and run target research edits from project scope", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-metadata-"));
    const storageRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-storage-"));
    setResearchStorageRoot(storageRoot);
    const bundle = await ensureFixtureProject(projectRoot);
    const flow = bundle.flows[0]!;
    const edgeId = flow.edges[0]!.id;
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "I can update project graph metadata through bounded operations.",
        summary: "Proposed metadata updates.",
        changeSet: {
          summary: "Update project metadata",
          operations: [
            {
              kind: "update-project",
              patch: {
                name: "Research Renamed Project",
                description: "Research-updated project description.",
                stackAssumptions: ["TypeScript", "Research UI"],
                environmentNotes: "Run through the local preview target."
              }
            },
            { kind: "update-flow", flowId: "flow-main", patch: { name: "Research Flow", description: "Updated flow description." } },
            { kind: "update-node", flowId: "flow-main", patch: { id: "node-project", description: "Research accepted a sharper project node description." } },
            { kind: "update-edge", flowId: "flow-main", edgeId, patch: { label: "coordinates with" } },
            {
              kind: "propose-run-profile",
              mode: "create",
              profile: {
                id: "research-preview",
                label: "Research Preview",
                kind: "web",
                runCommand: "npm run dev",
                timeoutSeconds: 90
              }
            }
          ]
        }
      }
    });
    const command = await createFakeResearchCodex(projectRoot, output);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: bundle.project.id }
    });

    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Update project metadata." });
    const assistant = answered.messages.find((message) => message.role === "assistant");
    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });
    const loaded = await loadProject(projectRoot);

    expect(result.results.every((item) => item.status === "applied")).toBe(true);
    expect(loaded.project.name).toBe("Research Renamed Project");
    expect(loaded.project.description).toBe("Research-updated project description.");
    expect(loaded.project.settings.stackAssumptions).toEqual(["TypeScript", "Research UI"]);
    expect(loaded.project.settings.environmentNotes).toBe("Run through the local preview target.");
    expect(loaded.flows[0]?.name).toBe("Research Flow");
    expect(loaded.flows[0]?.nodes.find((node) => node.id === "node-project")?.description).toBe("Research accepted a sharper project node description.");
    expect(loaded.flows[0]?.nodes.find((node) => node.id === "node-project")?.flags).toContain("changed");
    expect(loaded.flows[0]?.edges.find((edge) => edge.id === edgeId)?.label).toBe("coordinates with");
    expect(loaded.graphChanges.some((change) =>
      change.actor === "accepted-research" &&
      change.kind === "node-updated" &&
      change.nodeIds.includes("node-project") &&
      change.fieldPaths.includes("description")
    )).toBe(true);
    expect(loaded.graphChanges.some((change) =>
      change.actor === "accepted-research" &&
      change.kind === "edge-updated" &&
      change.edgeIds.includes(edgeId)
    )).toBe(true);
    expect(loaded.project.settings.runTargetProfiles.find((profile) => profile.id === "research-preview")?.label).toBe("Research Preview");
  });

  it("applies approved research queue actions for existing run targets", async () => {
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "I can queue the preview target after you approve it.",
        summary: "Proposed running an existing target.",
        changeSet: {
          summary: "Run preview target",
          operations: [
            {
              kind: "start-run-profile",
              flowId: "flow-main",
              profileId: "research-preview"
            }
          ]
        }
      }
    });
    const { projectRoot } = await setupProject(output);
    const bundle = await loadProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      runTargetProfiles: [
        ...bundle.project.settings.runTargetProfiles,
        {
          id: "research-preview",
          label: "Research Preview",
          kind: "web",
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: false,
          runCommand: "npm run dev",
          timeoutSeconds: 90
        }
      ]
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Run the preview target."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant");
    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const loaded = await loadProject(projectRoot);
    const queued = loaded.runs.find((run) => run.runProfileId === "research-preview");

    expect(result.results[0]?.status).toBe("applied");
    expect(result.results[0]?.message).toContain("Queued run profile research-preview as run");
    expect(queued?.status).not.toBe("needs-permission");
    expect(queued?.permission.decision).toBe("allowed");
  });

  it("lets research chat link an existing node to an existing detail flow", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Linked the selected node to an existing detail flow.",
        summary: "Linked node detail flow.",
        changeSet: {
          summary: "Set node detail flow",
          operations: [
            {
              kind: "link-node-subflow",
              flowId: "flow-main",
              nodeId: "node-project",
              subflowId: "subflow-json"
            }
          ]
        }
      }
    }));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Make this node open the JSON detail flow." });
    const assistant = answered.messages.find((message) => message.role === "assistant");
    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const flow = (await loadProject(projectRoot)).flows[0]!;

    expect(result.results[0]?.status).toBe("applied");
    expect(flow.subflows.find((subflow) => subflow.id === "subflow-json")?.parentNodeId).toBe("node-project");
  });

  it("continues orchestration after approving a detail-flow creation step", async () => {
    const { projectRoot } = await setupProject([
      JSON.stringify({
        archicodeResearch: {
          answer: "I prepared the new landing content detail flow first.",
          summary: "Prepared landing content detail flow.",
          changeSet: {
            summary: "Create landing content detail flow",
            operations: [
              {
                kind: "create-subflow",
                flowId: "flow-main",
                subflow: { id: "subflow-landing-content", name: "Landing Page Content", parentNodeId: "node-project" }
              },
              {
                kind: "link-node-subflow",
                flowId: "flow-main",
                nodeId: "node-project",
                subflowId: "subflow-landing-content"
              }
            ]
          }
        }
      }),
      JSON.stringify({
        archicodeResearch: {
          answer: "That detail flow exists now, so I prepared the next card to populate it.",
          summary: "Prepared landing content nodes.",
          changeSet: {
            summary: "Populate landing content detail flow",
            operations: [
              {
                kind: "create-node",
                flowId: "flow-main",
                node: {
                  id: "node-hero-message",
                  type: "task",
                  title: "Hero Message",
                  description: "Define the landing hero headline, support copy, and CTA.",
                  subflowId: "subflow-landing-content"
                }
              }
            ]
          }
        }
      })
    ]);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Create the landing content detail flow, then fill it with content nodes."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant");
    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: assistant!.changeSet!.operations.map((_, operationIndex) => ({ operationIndex, decision: "accepted" as const }))
    });

    const nextAssistant = [...result.session.messages].reverse().find((message) => message.role === "assistant" && message.id !== assistant!.id);
    expect(result.results.every((item) => item.status === "applied")).toBe(true);
    expect(result.session.messages.some((message) => message.role === "system" && message.content.startsWith("Graph changes reviewed: 2 applied"))).toBe(true);
    expect(result.session.messages.some((message) => message.role === "user" && message.content.includes("Graph review was just completed"))).toBe(false);
    expect(nextAssistant?.content).toContain("detail flow exists now");
    expect(nextAssistant?.changeSet?.summary).toBe("Populate landing content detail flow");
    expect(nextAssistant?.changeSet?.operations[0]).toMatchObject({
      kind: "create-node",
      node: {
        subflowId: "subflow-landing-content",
        title: "Hero Message"
      }
    });
  });

  it("asks why after rejecting a proposed graph change set", async () => {
    const { projectRoot } = await setupProject([
      JSON.stringify({
        archicodeResearch: {
          answer: "Prepared a review card to add a portfolio page.",
          summary: "Prepared a graph review card.",
          changeSet: {
            summary: "Add portfolio page",
            operations: [
              {
                kind: "create-node",
                flowId: "flow-main",
                node: {
                  id: "node-portfolio-page",
                  type: "feature",
                  title: "Portfolio Page",
                  description: "Showcase featured work."
                }
              }
            ]
          }
        }
      }),
      JSON.stringify({
        archicodeResearch: {
          answer: "No problem. What felt off about that proposal so I can adjust it?",
          summary: "Asked why the proposal was rejected."
        }
      })
    ]);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Add a portfolio page."
    });
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);
    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "rejected" }]
    });
    const followUp = [...result.session.messages].reverse().find((message) => message.role === "assistant" && message.id !== assistant!.id);

    expect(result.results[0]).toMatchObject({ status: "rejected" });
    expect(followUp?.content).toContain("What felt off about that proposal");
    expect(result.session.messages.some((message) => message.role === "assistant" && message.content.includes("Graph review complete"))).toBe(false);
  });

  it("allows node-scoped research to edit other nodes in the same flow", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can edit another node from this scoped chat.",
        summary: "Cross-node edit.",
        changeSet: {
          summary: "Update another node",
          operations: [
            { kind: "update-node", flowId: "flow-main", patch: { id: "node-orchestrator", description: "Out of scope mutation." } }
          ]
        }
      }
    }));
    const before = await loadProject(projectRoot);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Edit another node." });
    const assistant = answered.messages.find((message) => message.role === "assistant");

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const after = await loadProject(projectRoot);

    expect(result.results[0]?.status).toBe("applied");
    expect(after.flows[0]?.nodes.find((node) => node.id === "node-orchestrator")?.description).toBe("Out of scope mutation.");
  });

  it("allows node-scoped research to update metadata on the containing flow", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can rename the current flow from this node-scoped chat.",
        summary: "Flow rename from node scope.",
        changeSet: {
          summary: "Rename containing flow",
          operations: [
            { kind: "update-flow", flowId: "flow-main", patch: { name: "Renamed From Node Scope", description: "Updated from a node-scoped research chat." } }
          ]
        }
      }
    }));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Rename this flow from here." });
    const assistant = answered.messages.find((message) => message.role === "assistant");

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const updated = await loadProject(projectRoot);

    expect(result.results[0]?.status).toBe("applied");
    expect(updated.flows[0]?.name).toBe("Renamed From Node Scope");
    expect(updated.flows[0]?.description).toBe("Updated from a node-scoped research chat.");
  });

  it("allows research chat to rename an existing detail flow", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can rename that existing detail flow.",
        summary: "Detail flow rename.",
        changeSet: {
          summary: "Rename detail flow",
          operations: [
            { kind: "update-subflow", flowId: "flow-main", subflowId: "subflow-json", patch: { name: "Renamed Detail Flow" } }
          ]
        }
      }
    }));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "subflow", flowId: "flow-main", subflowId: "subflow-json" }
    });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Rename this detail flow." });
    const assistant = answered.messages.find((message) => message.role === "assistant");

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const updated = await loadProject(projectRoot);

    expect(result.results[0]?.status).toBe("applied");
    expect(updated.flows[0]?.subflows.find((subflow) => subflow.id === "subflow-json")?.name).toBe("Renamed Detail Flow");
    expect(updated.graphChanges.some((change) =>
      change.actor === "accepted-research" &&
      change.kind === "subflow-updated" &&
      change.subflowIds.includes("subflow-json") &&
      change.fieldPaths.includes("name")
    )).toBe(true);
  });

  it("allows node-scoped research to update project metadata", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can update project metadata from this scoped chat.",
        summary: "Project metadata from node scope.",
        changeSet: {
          summary: "Rename project from node scope",
          operations: [
            { kind: "update-project", patch: { name: "Renamed From Node Chat", description: "Project metadata updated from a node-scoped research chat." } }
          ]
        }
      }
    }));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Rename the project from here." });
    const assistant = answered.messages.find((message) => message.role === "assistant");

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const updated = await loadProject(projectRoot);

    expect(result.results[0]?.status).toBe("applied");
    expect(updated.project.name).toBe("Renamed From Node Chat");
    expect(updated.project.description).toBe("Project metadata updated from a node-scoped research chat.");
  });

  it("rejects invalid research node references before applying any accepted operation", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I will return one valid and one invalid operation.",
        summary: "Invalid reference.",
        changeSet: {
          summary: "Invalid reference change set",
          operations: [
            { kind: "update-project", patch: { name: "Should Not Apply" } },
            { kind: "update-node", flowId: "flow-main", patch: { id: "node-project", parentId: "node-missing" } }
          ]
        }
      }
    }));
    const before = await loadProject(projectRoot);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: before.project.id }
    });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Apply invalid parent link." });
    const assistant = answered.messages.find((message) => message.role === "assistant");

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [
        { operationIndex: 0, decision: "accepted" },
        { operationIndex: 1, decision: "accepted" }
      ]
    });
    const after = await loadProject(projectRoot);

    expect(result.results.every((item) => item.status === "failed")).toBe(true);
    expect(result.results[0]?.message).toContain("graph changes are transactional");
    expect(result.results[1]?.message).toMatch(/Parent node node-missing was not found/);
    expect(after.project.name).toBe(before.project.name);
    expect(after.flows[0]?.nodes.find((node) => node.id === "node-project")?.parentId).toEqual(
      before.flows[0]?.nodes.find((node) => node.id === "node-project")?.parentId
    );
  });

  it("blocks research subflow deletion when it would move approved nodes", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can delete that subflow if approved.",
        summary: "Delete subflow proposal.",
        changeSet: {
          summary: "Delete approved subflow",
          operations: [
            { kind: "delete-subflow", flowId: "flow-main", subflowId: "subflow-approved" }
          ]
        }
      }
    }));
    const bundle = await loadProject(projectRoot);
    const flow = bundle.flows[0]!;
    await saveFlow(projectRoot, {
      ...flow,
      subflows: [...flow.subflows, { id: "subflow-approved", name: "Approved Area", ignored: false }],
      nodes: flow.nodes.map((node) => node.id === "node-approved-contract" ? { ...node, subflowId: "subflow-approved" } : node)
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Delete approved subflow." });
    const assistant = answered.messages.find((message) => message.role === "assistant");

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const after = await loadProject(projectRoot);

    expect(result.results[0]?.status).toBe("failed");
    expect(result.results[0]?.message).toMatch(/contains approved locked nodes/);
    expect(after.flows[0]?.subflows.some((subflow) => subflow.id === "subflow-approved")).toBe(true);
    expect(after.flows[0]?.nodes.find((node) => node.id === "node-approved-contract")?.subflowId).toBe("subflow-approved");
  });

  it("includes compact nodes from every flow in project-scoped research context", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can see the project graph.",
        summary: "Checked project graph."
      }
    }), true);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });
    const graphBundle = await loadProject(projectRoot);
    const graphFlow = graphBundle.flows[0]!;
    await saveFlow(projectRoot, {
      ...graphFlow,
      groups: [{ id: "group-agent-harness", name: "Agent Harness", color: "#7bc6d5" }],
      nodes: graphFlow.nodes.map((node) => node.id === "node-orchestrator"
        ? { ...node, groupId: "group-agent-harness", subflowId: "subflow-orchestrator" }
        : node)
    });
    await writeFile(path.join(projectRoot, "AGENTS.md"), "# Agent Notes\n\nAlways run npm test before handoff.\n", "utf8");

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Give me a project-wide architecture read."
    });
    const prompt = await readFile(promptPath!, "utf8");

    expect(prompt).toContain("\"contextMode\":\"compact\"");
    expect(prompt).toContain("\"graphOutline\"");
    expect(prompt).toContain("\"implementationScopePolicy\"");
    expect(prompt).toContain("advisory-best-effort");
    expect(prompt).toContain("never treat them as permissions");
    expect(prompt).toContain("\"node-approved-contract\"");
    expect(prompt).toContain("\"graphLink\":\"archicode://flow/flow-main\"");
    expect(prompt).toContain("\"graphLink\":\"archicode://node/flow-main/node-project\"");
    expect(prompt).toContain("\"graphLinks\"");
    expect(prompt).toContain("\"projectConventions\"");
    expect(prompt).toContain("\"path\":\"AGENTS.md\"");
    expect(prompt).toContain("Always run npm test before handoff.");
    expect(prompt).toContain("\"capabilityVersion\":\"2026-07-17.3\"");
    expect(prompt).toContain("\"currentProjectOptions\"");
    expect(prompt).toContain("\"codeReviewMode\":\"auto-apply\"");
    expect(prompt).toContain("fork/archive/cancel/export Research chats");
    expect(prompt).toContain("\"groupId\":\"group-agent-harness\"");
    expect(prompt).toContain("\"subflowId\":\"subflow-orchestrator\"");
    expect(prompt).toContain("\"name\":\"Agent Harness\"");
    expect(prompt).toContain("\"edges\"");
  });

  it("keeps passive selected nodes as compact hints instead of forcing full context", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can see the selected node hint.",
        summary: "Checked selected node hint."
      }
    }), true);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "What should I look at?",
      selectedNodeIds: ["node-project"]
    });
    const prompt = await readFile(promptPath!, "utf8");
    const assistant = answered.messages.find((message) => message.role === "assistant");
    const selectedNodes = promptObjectForKey(prompt, "selectedNodes") as { entries?: Array<{ nodeId?: string }> };

    expect(assistant?.usage?.contextMode).toBe("compact");
    expect(prompt).toContain("\"contextMode\":\"compact\"");
    expect(prompt).toContain("\"selectedNodes\"");
    expect(prompt).toContain("\"nodeId\":\"node-project\"");
    expect(prompt).toContain("\"title\":\"Project Workspace\"");
    expect(prompt).toContain("Passive canvas selection only");
    expect(selectedNodes.entries?.map((entry) => entry.nodeId)).toEqual(["node-project"]);
    expect(prompt).toContain("\"semanticallyRelatedNodes\"");
    expect(prompt).toContain("These nodes are not necessarily selected, highlighted, referenced, or in scope");
  });

  it("moves oversized research prompts into a minimal-resumable lifecycle with reload tools", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I stayed oriented under budget.",
        summary: "Checked budgeted prompt handling."
      }
    }), true);
    const bundle = await loadProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, contextWindowTokens: 5000 }
        : provider)
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Stay oriented but do not crash when the prompt budget is tight.",
      selectedNodeIds: ["node-project"]
    });
    const prompt = await readFile(promptPath!, "utf8");
    const assistant = answered.messages.find((message) => message.role === "assistant");
    const lifecycleDetail = assistant?.usage?.contextSections?.find((section) => section.label === "lifecycle")?.detail ?? "";

    expect(assistant?.usage?.contextMode).toBe("compact");
    expect(assistant?.usage?.contextLifecycleTier).toBe("minimal-resumable");
    expect(lifecycleDetail).toContain("entered minimal-resumable context lifecycle");
    expect(prompt).toContain("\"contextLifecycle\":{\"tier\":\"minimal-resumable\"");
    expect(prompt).toContain("reload tools remain available so the agent can rebuild detail on demand");
    expect(prompt).toContain("\"reloadTools\"");
    expect(prompt).toContain("archicode_read_research_context");
    expect(prompt).toContain("archicode_read_graph_layout");
    expect(prompt).toContain("archicode_read_chat_history");
    expect(prompt).toContain("\"reusableTools\"");
    expect(prompt).toContain("archicode_console_run_command");
    expect(prompt).toContain("archicode_project_read_artifact");
    expect(prompt).toContain("archicode_project_list_runtime_services");
    expect(prompt).toContain("archicode_spawn_sherlock");
    expect(prompt).toContain("\"selectedNodes\"");
    expect(prompt).toContain("\"nodeId\":\"node-project\"");
  });

  it("emits live Sherlock progress before its research result is persisted", async () => {
    const { projectRoot } = await setupProject([
      JSON.stringify({
        archicodeResearchTurn: {
          toolCalls: [{
            id: "sherlock-1",
            providerToolName: "archicode_spawn_sherlock",
            arguments: { objective: "Inspect the route implementation", mode: "codebase" }
          }]
        }
      }),
      JSON.stringify({
        archicodeResearchTurn: {
          toolCalls: [{
            id: "sherlock-search-1",
            providerToolName: "archicode_project_search_files",
            arguments: { path: "src", query: "route" }
          }]
        }
      }),
      JSON.stringify({
        summary: "Sherlock found the route owner.",
        findings: [{
          title: "Route ownership",
          detail: "The route is registered by the project router.",
          confidence: "high",
          evidence: [{ source: "project", reference: "src/router.ts:12" }]
        }],
        sources: [{ label: "router", reference: "src/router.ts", sourceType: "project-file" }],
        openQuestions: [],
        recommendedNextSteps: []
      }),
      "Sherlock's findings are ready."
    ]);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });
    const progress: Array<{ kind: string; status?: string; message: string }> = [];

    const updated = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Ask Sherlock to inspect the route implementation.",
      onSubagentProgress: (event) => progress.push(event)
    });

    expect(progress[0]).toMatchObject({
      kind: "sherlock-research",
      status: "running",
      message: "Sherlock is preparing a fresh investigation."
    });
    expect(progress.some((event) => event.status === "completed")).toBe(true);
    expect(updated.messages.at(-1)?.subagentRuns).toMatchObject([
      { kind: "sherlock-research", status: "completed" }
    ]);
  });

  it("preserves a genuine Sherlock blocker as blocked in live and persisted status", async () => {
    const { projectRoot } = await setupProject([
      JSON.stringify({
        archicodeResearchTurn: {
          toolCalls: [{
            id: "sherlock-1",
            providerToolName: "archicode_spawn_sherlock",
            arguments: { objective: "Inspect a required source path", mode: "codebase" }
          }]
        }
      }),
      JSON.stringify({
        archicodeResearchTurn: {
          toolCalls: [{
            id: "sherlock-list-1",
            providerToolName: "archicode_project_list_files",
            arguments: { path: "src/missing-security-module", recursive: true }
          }]
        }
      }),
      JSON.stringify({
        status: "blocked",
        blockers: ["The requested source path does not exist in the project."],
        summary: "The assigned path could not be inspected.",
        findings: [],
        sources: [],
        openQuestions: [],
        recommendedNextSteps: ["Confirm the intended source path."]
      }),
      "Sherlock could not inspect the requested missing path, so I am reporting the concrete blocker."
    ]);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });
    const progress: Array<{ kind: string; status?: string; message: string }> = [];

    const updated = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Ask Sherlock to inspect the required path.",
      onSubagentProgress: (event) => progress.push(event)
    });

    expect(progress.some((event) => event.kind === "sherlock-research" && event.status === "blocked")).toBe(true);
    expect(updated.messages.at(-1)?.subagentRuns).toMatchObject([
      { kind: "sherlock-research", status: "blocked", resultSummary: expect.stringContaining("could not be inspected") }
    ]);
  });

  it("emits live Picasso progress before its graph-design result is persisted", async () => {
    const { projectRoot } = await setupProject([
      JSON.stringify({
        archicodeResearchTurn: {
          toolCalls: [{
            id: "picasso-1",
            providerToolName: "archicode_spawn_picasso",
            arguments: { objective: "Refine the route graph", mode: "refine" }
          }]
        }
      }),
      JSON.stringify({
        archicodeResearchTurn: {
          toolCalls: [{
            id: "picasso-read-1",
            providerToolName: "picasso_read_graph",
            arguments: {}
          }]
        }
      }),
      localResearchSinkTurn("", [{ providerToolName: "propose_graph_change_set", arguments: {
        summary: "Refine route graph",
        operations: [{
          kind: "update-project",
          patch: { description: "Route graph refined by Picasso." }
        }]
      } }]),
      "Picasso's design report is ready."
    ]);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });
    const progress: Array<{ kind: string; status?: string; message: string }> = [];

    const updated = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Ask Picasso to refine the route graph.",
      onSubagentProgress: (event) => progress.push(event)
    });

    expect(progress[0]).toMatchObject({
      kind: "graph-reconciliation",
      status: "running",
      message: "Picasso is preparing a fresh graph-design pass."
    });
    expect(progress.some((event) => event.status === "completed")).toBe(true);
    expect(updated.messages.at(-1)?.subagentRuns).toMatchObject([
      { kind: "graph-reconciliation", status: "completed" }
    ]);
  });

  it("includes project file tools and activity panel context in Codex Local research prompts", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can inspect project files and run context.",
        summary: "Checked files and run context."
      }
    }), true);
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(path.join(projectRoot, "src", "App.vue"), "<template><main>Hello</main></template>\n", "utf8");
    await writeFile(path.join(projectRoot, ".env"), "ANTHROPIC_API_KEY=anthropic-secret-value\n", "utf8");
    await writeFile(path.join(projectRoot, ".archicode", "runs", "run-test.json"), JSON.stringify({
      id: "run-test",
      status: "failed",
      logs: [{ stream: "stderr", text: "fetch failed" }]
    }), "utf8");
    await reportBug({
      projectRoot,
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      title: "Bug report drawer does not submit",
      description: "Clicking submit leaves the dialog open without creating an incident.",
      priority: "high"
    });
    const bundle = await loadProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      mcp: {
        ...bundle.project.settings.mcp,
        servers: [{
          id: "io-github-upstash-context7",
          label: "Context7",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp@1.0.31"],
          env: [],
          headers: [],
          enabled: true,
          trusted: false,
          source: "registry",
          tools: [{ name: "resolve-library-id", description: "Resolve a package to a Context7 library ID." }],
          resources: [],
          prompts: []
        }]
      }
    });
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "What files and failed runs can you see?"
    });
    const prompt = await readFile(promptPath!, "utf8");

    expect(prompt).toContain("\"archicodeApp\"");
    expect(prompt).toContain("\"contextMode\":\"compact\"");
    expect(prompt).toContain("\"graphOutline\"");
    expect(prompt).toContain("\"activityPanels\"");
    expect(prompt).toContain("\"recentRuns\"");
    expect(prompt).toContain("\"projectFiles\"");
    expect(prompt).not.toContain("\"archicodeModel\"");
    expect(prompt).toContain("Your name is Archi");
    expect(prompt).toContain("\"agentName\":\"Archi\"");
    expect(prompt).toContain("Research chat agent inside ArchiCode");
    expect(prompt).toContain("use archicodeApp.capabilities as the current product capability manifest");
    expect(prompt).toContain("archicodeApp.currentProjectOptions");
    expect(prompt).toContain("user-interface-only controls");
    expect(prompt).toContain("user-visible node groups");
    expect(prompt).toContain("optional authenticated localhost MCP host");
    expect(prompt).toContain("The selected scope focuses your attention and context, but it does not limit what graph or queue changes you may prepare.");
    expect(prompt).toContain("AI Debug");
    expect(prompt).toContain("archicode://node/{flowId}/{nodeId}");
    expect(prompt).toContain("Local Electron app");
    expect(prompt).toContain("\"projectFiles\"");
    expect(prompt).toContain("\"mcpServers\"");
    expect(prompt).toContain("\"Context7\"");
    expect(prompt).toContain("\"permissionMode\":\"ask\"");
    expect(prompt).toContain("enabled MCP servers are visible to research");
    expect(prompt).toContain("use the guarded console when a bounded project command materially advances the goal");
    expect(prompt).toContain("Safe in-scope commands execute; risky or uncertain commands pause for approval");
    expect(prompt).toContain("Application-source implementation remains delegated to graph/build runs");
    expect(prompt).toContain("\"activityPanels\"");
    expect(prompt).toContain("\"scopedRunCounts\"");
    expect(prompt).toContain("\"runtimeServices\"");
    expect(prompt).toContain("start-agent-run");
    expect(prompt).toContain("start-runtime-debug-run");
    for (const operationKind of researchGraphOperationKinds) {
      expect(prompt).toContain(operationKind);
    }
    expect(prompt).toContain("{ \"kind\": \"create-group\"");
    expect(prompt).toContain("optional guidance");
    expect(prompt).toContain("Do not include guidance on start-run-profile");
    expect(prompt).toContain("Before proposing any new queue start, check activeQueue, queue, recentRuns, runtimeServices, and orchestration todos already in context.");
    expect(prompt).toContain("If similar work is already active, already queued, or clearly overlaps enough to risk contradiction, duplication, or wasted work, do not propose another new queue start yet");
    expect(prompt).toContain("AI Implement can create a new codebase from the graph");
    expect(prompt).toContain("graph/nodes are the source of truth");
    expect(prompt).toContain("Treat edges as connections between nodes with project-specific labels");
    expect(prompt).toContain("Do not infer fixed semantics from an edge label alone");
    expect(prompt).toContain("Graph relationship semantics are carried by edges");
    expect(prompt).toContain("Do not include providerId in queue action operations.");
    expect(prompt).toContain("nodeId is optional");
    expect(prompt).toContain("Never copy flowId into nodeId");
    expect(prompt).toContain("never put a flow ID in nodeId");
    expect(prompt).not.toContain("\"providerId\": \"openai-compatible\"");
    expect(prompt).toContain("ask every clarification you need in the same scope-confirmation response");
    expect(prompt).toContain("affected nodes, edges, descriptions, acceptance criteria, and adjacent responsibilities");
    expect(prompt).toContain("Propose a coherent graph change rather than an isolated edit");
    expect(prompt).toContain("When creating nodes inside a detail flow/subflow, set create-node.flowId to the containing top-level flow id");
    expect(prompt).toContain("Never put a subflow id in any operation.flowId");
    expect(prompt).toContain("flowId names the containing top-level flow file, while node.subflowId is what places the node inside the detail subflow");
    expect(prompt).toContain("ask exactly once whether this is the scope they want prepared as a review card");
    expect(prompt).toContain("The visible scope-confirmation response must end with a direct confirmation question");
    expect(prompt).toContain("Never stop passively while waiting for confirmation");
    expect(prompt).toContain("the next affirmative reply should produce the card");
    expect(prompt).toContain("Do not invoke Picasso or produce a graph change set before that confirmation");
    expect(prompt).toContain("A request to propose a concrete graph update");
    expect(prompt).toContain("Do not finish that turn by merely promising future inspection");
    expect(prompt).toContain("After the user confirms, invoke spawn_picasso in that next turn");
    expect(prompt).toContain("Never say or imply that you will use Picasso");
    expect(prompt).toContain("unless you actually call spawn_picasso in that turn");
    expect(prompt).toContain("An explicit request to use Picasso does not itself replace confirmation");
    expect(prompt).toContain("own the investigation and tool trajectory until the objective is satisfied");
    expect(prompt).toContain("Subagents own their delegated tactics");
    expect(prompt).toContain("ArchiCode derives host-visible goal and memory state from persisted events");
    expect(prompt).toContain("do not spend tool calls on bookkeeping");
    expect(prompt).not.toContain("CURRENT TURN COMPLETION CHECKLIST");
    expect(prompt).not.toContain("archicode_leave_memory_unchanged");
    expect(prompt).not.toContain("Never omit both tools");
    expect(prompt).toContain("Direct graph operations are allowed only for a simple quick bounded edit");
    expect(prompt).toContain("specification/attachment decomposition");
    expect(prompt).toContain("call archicode_spawn_picasso now with that exact scope");
    expect(prompt).toContain("Graph edges cannot cross top-level flows");
    expect(prompt).toContain("never instruct Picasso to create or prefer cross-flow edges");
    expect(prompt).toContain("Never promise a future tool action");
    expect(prompt).not.toContain("src/App.vue");
   expect(prompt).not.toContain("<template><main>Hello</main></template>");
    expect(prompt).not.toContain("anthropic-secret-value");
  });

  it("uses the latest global personality for new and resumed chat turns", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can help with that.",
        summary: "Captured prompt."
      }
    }), true);
    setGlobalResearchPersonalityResolver(() => "claptrap");
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Start a new chat turn."
    });

    setGlobalResearchPersonalityResolver(() => "cat-waifu");
    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Resume this chat with a new turn."
    });

    const prompts = (await readFile(promptPath!, "utf8"))
      .split("--- prompt boundary ---")
      .map((part) => part.trim())
      .filter(Boolean);

    const visibleTurnPrompts = prompts.filter((prompt) =>
      prompt.includes("User message: Start a new chat turn.") ||
      prompt.includes("User message: Resume this chat with a new turn.")
    );

    expect(visibleTurnPrompts[0]).toContain("Claptrap from Borderlands");
    expect(visibleTurnPrompts[0]).toContain("Adopt the selected personality fully in how you speak and present yourself.");
    expect(visibleTurnPrompts[1]).toContain("Adopt a playful cat-waifu anime-assistant persona");
    expect(visibleTurnPrompts[1]).toContain("Adopt the selected personality fully in how you speak and present yourself.");
  });

  it("uses the latest global verbosity setting for visible chat turns", async () => {
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can help with that.",
        summary: "Captured prompt."
      }
    }), true);
    setGlobalResearchVerbosityResolver(() => "default");
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Start with normal verbosity."
    });

    setGlobalResearchVerbosityResolver(() => "chatty");
    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Resume with chatty verbosity."
    });

    const prompts = (await readFile(promptPath!, "utf8"))
      .split("--- prompt boundary ---")
      .map((part) => part.trim())
      .filter(Boolean);

    const visibleTurnPrompts = prompts.filter((prompt) =>
      prompt.includes("User message: Start with normal verbosity.") ||
      prompt.includes("User message: Resume with chatty verbosity.")
    );

    expect(visibleTurnPrompts[0]).toContain("Keep the visible answer conversational and concise.");
    expect(visibleTurnPrompts[0]).not.toContain("Important Research chat response style");
    expect(visibleTurnPrompts[1]).toContain("Important Research chat response style");
    expect(visibleTurnPrompts[1]).toContain("warm, welcoming, chatty & verbose");
    expect(visibleTurnPrompts[1]).not.toContain("Keep the visible answer conversational and concise.");
  });

  it("asks once to confirm graph-edit scope before showing a review card", async () => {
    const { projectRoot, promptPath } = await setupProject([
      JSON.stringify({
        archicodeResearch: {
          answer: "I would add the next implementation node under the selected project scope. Is that the scope you want me to prepare for review?",
          summary: "Proposed the graph-edit scope."
        }
      }),
      JSON.stringify({
        archicodeResearch: {
          answer: "Prepared the requested graph edit for review.",
          summary: "Prepared a pending graph edit.",
          changeSet: {
            summary: "Add the next implementation node",
            operations: [{
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-next-implementation",
                type: "task",
                title: "Next Implementation",
                description: "The next scoped implementation task.",
                stage: "draft"
              }
            }]
          }
        }
      })
    ], true);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    const scopeConfirmation = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Edit the graph to add the next implementation node."
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "yes"
    });
    const prompt = await readFile(promptPath!, "utf8");
    const scopeAssistant = scopeConfirmation.messages.find((message) => message.role === "assistant");
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);

    expect(prompt).toContain("User message: Edit the graph to add the next implementation node.");
    expect(scopeAssistant?.changeSet).toBeUndefined();
    expect(scopeAssistant?.content).toContain("scope you want me to prepare for review");
    expect(assistant?.changeSet?.operations).toHaveLength(1);
    expect(prompt).toContain("ask every needed clarification in that same response");
    expect(prompt).toContain("inspect the affected nodes, edges, descriptions, acceptance criteria, and nearby responsibilities");
    expect(prompt).toContain("State the coherent change you propose");
    expect(prompt).toContain("ask once whether this is the scope they want prepared for review");
    expect(prompt).toContain("Do not return the pending changeSet yet");
    expect(prompt).toContain("When the user then affirms that scope, return the pending changeSet immediately without another scope confirmation");
  });

  it("leaves graph-review confirmation interpretation to the provider without host keyword routing", async () => {
    const { projectRoot, promptPath } = await setupProject([
      JSON.stringify({
        archicodeResearch: {
          answer: "I would create a Landing Page Sections detail subflow with Hero, Value Proposition, Benefits Grid, and CTA Section nodes, linked from the Landing Page. Should I prepare this exact scope as the graph review card?",
          summary: "Asked the user to confirm a graph review-card scope."
        }
      }),
      JSON.stringify({
        archicodeResearch: {
          answer: "Prepared the Landing Page Sections graph review card.",
          summary: "Prepared a pending landing-page subflow graph update.",
          changeSet: {
            summary: "Create Landing Page Sections subflow",
            operations: [{
              kind: "create-subflow",
              flowId: "flow-main",
              subflow: {
                id: "subflow-landing-page-sections",
                name: "Landing Page Sections",
                parentNodeId: "node-landing-page"
              }
            }]
          }
        }
      })
    ], true);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "i want you to propose a comprehensive graph update to create a new subflow with nodes to breakdown the landing page"
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "نعم، تابع"
    });

    const prompts = (await readFile(promptPath!, "utf8"))
      .split("--- prompt boundary ---")
      .map((part) => part.trim())
      .filter(Boolean);
    const confirmationPrompt = prompts.find((prompt) => prompt.includes("User message: نعم، تابع"));
    const assistant = answered.messages.find((message) => message.role === "assistant" && message.changeSet);

    expect(confirmationPrompt).not.toContain("CURRENT TURN GRAPH-REVIEW CONFIRMATION");
    expect(confirmationPrompt).not.toContain("affirmative reply satisfies");
    expect(assistant?.changeSet?.operations).toHaveLength(1);
  });

  it("ignores embedded memory deltas in graph responses and still renders the change set", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
        archicodeResearch: {
          answer: "I retried it as a pending graph update for ArchiCode to apply through review.",
          summary: "Retry the pending graph update.",
          memoryDelta: {
            todos: [
              "Retry applying the approved Panic Blob graph structure through the review/apply path."
            ],
            debugFindings: [
              "A prior graph review attempt reported 0 applied, 0 rejected, and 10 failed."
            ]
          },
          changeSet: {
            summary: "Apply the approved Panic Blob mini-game plan to the blank project graph.",
            operations: [
              {
                kind: "update-flow",
                flowId: "flow-main",
                patch: {
                  name: "Panic Blob Plan",
                  description: "A tiny chaotic browser mini-game with one-button survival, built for fast preview and implementation."
                }
              }
            ]
          }
        }
    }));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "try again"
    });
    const assistant = answered.messages.find((message) => message.role === "assistant");

    expect(assistant?.content).toBe("I retried it as a pending graph update for ArchiCode to apply through review.");
    expect(assistant?.changeSet?.operations).toHaveLength(1);
    expect(assistant?.content).not.toContain("\"archicodeResearch\"");
    expect(answered.memory.summary).toBe("Retry the pending graph update.");
  });

  it("reads bounded planning-graph geometry from the current project bundle", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-layout-tool-"));
    const bundle = await ensureFixtureProject(projectRoot);
    const flow = bundle.flows.find((item) => item.id === "flow-main")!;
    const target = flow.nodes.find((node) => !node.subflowId)!;
    target.position = { x: 123, y: 456 };
    target.size = { width: 300, height: 180 };

    const result = JSON.parse(buildResearchGraphLayoutToolResult(bundle, JSON.stringify({
      nodeIds: [target.id, "missing-node"]
    }), {
      activeFlowId: flow.id,
      activeSubflowId: null,
      sessionScope: { type: "project", projectId: bundle.project.id }
    })) as {
      source: string;
      layer: { mode: string; subflowId: string | null };
      nodes: Array<{ id: string; position: { x: number; y: number }; size: { width: number; height: number }; bounds: { left: number; top: number; right: number; bottom: number } }>;
      missingNodeIds: string[];
    };

    expect(result.source).toBe("current-project-bundle");
    expect(result.layer).toEqual(expect.objectContaining({ mode: "root", subflowId: null }));
    expect(result.nodes).toContainEqual(expect.objectContaining({
      id: target.id,
      position: { x: 123, y: 456 },
      size: { width: 300, height: 180 },
      bounds: { left: 123, top: 456, right: 423, bottom: 636 }
    }));
    expect(result.missingNodeIds).toEqual(["missing-node"]);
    expect(() => buildResearchGraphLayoutToolResult(bundle, JSON.stringify({ allLayers: true, subflowId: null }))).toThrow(/cannot be combined/);
  });

  it("reads from startLine through the bounded remainder when endLine is omitted", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-read-range-"));
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(path.join(projectRoot, "src", "main.ts"), "first\nsecond\nthird", "utf8");

    const result = await researchToolReadFile(projectRoot, { path: "src/main.ts", startLine: 2 }) as {
      text: string;
      startLine: number;
      endLine: number;
      totalLines: number;
    };

    expect(result).toMatchObject({ text: "second\nthird", startLine: 2, endLine: 3, totalLines: 3 });
  });

  it("lets direct research providers inspect graph layout and project files through built-in tools", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-tools-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(path.join(projectRoot, "src", "main.ts"), "export const visibleSourceMarker = 'source-snippet-present';\n", "utf8");
    await writeFile(path.join(projectRoot, ".env"), "OPENAI_API_KEY=secret-value\n", "utf8");
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([
        { id: "call-list", name: "archicode_project_list_files", arguments: "{\"directory\":\"src\"}" },
        { id: "call-search", name: "archicode_project_search_files", arguments: "{\"query\":\"visibleSourceMarker\"}" },
        { id: "call-read", name: "archicode_project_read_file", arguments: "{\"path\":\".env\"}" },
        { id: "call-read-lines", name: "archicode_project_read_file", arguments: "{\"path\":\"src/main.ts\",\"startLine\":1,\"endLine\":1}" },
        { id: "call-layout", name: "archicode_read_graph_layout", arguments: "{\"flowId\":\"flow-main\",\"subflowId\":null,\"maxResults\":5}" }
      ]))
      .mockResolvedValueOnce(streamingChatCompletionResponse("I listed, searched, and read project files."));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Can you inspect project files?"
    });
    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const allToolSchemas = new Map(firstBody.tools
      .map((tool: { function: { name: string; parameters: Record<string, unknown> } }) => [tool.function.name, tool.function.parameters]));
    const projectToolSchemas = new Map(firstBody.tools
      .filter((tool: { function?: { name?: string } }) => tool.function?.name?.startsWith("archicode_project_"))
      .map((tool: { function: { name: string; parameters: Record<string, unknown> } }) => [tool.function.name, tool.function.parameters]));
    const readArtifactSchema = projectToolSchemas.get("archicode_project_read_artifact") as Record<string, unknown>;
    const listRunsSchema = projectToolSchemas.get("archicode_project_list_runs") as Record<string, unknown>;
    const consoleSchema = allToolSchemas.get("archicode_console_run_command") as Record<string, unknown>;
    const graphLayoutSchema = allToolSchemas.get("archicode_read_graph_layout") as Record<string, unknown>;
    expect([...projectToolSchemas.values()].every((schema) => (schema as Record<string, unknown>).additionalProperties === false)).toBe(true);
    expect(readArtifactSchema.type).toBe("object");
    expect((readArtifactSchema.properties as Record<string, unknown>).artifactId).toBeTruthy();
    expect((readArtifactSchema.properties as Record<string, unknown>).path).toBeTruthy();
    expect((listRunsSchema.properties as Record<string, Record<string, unknown>>).status.enum).toContain("needs-permission");
    expect(consoleSchema.type).toBe("object");
    expect(consoleSchema.required).toEqual(["command"]);
    expect((consoleSchema.properties as Record<string, Record<string, unknown>>).command.type).toBe("string");
    expect((consoleSchema.properties as Record<string, Record<string, unknown>>).command.enum).toBeUndefined();
    expect(projectToolSchemas.has("archicode_project_inspect_cli")).toBe(false);
    expect(graphLayoutSchema.type).toBe("object");
    expect(graphLayoutSchema.additionalProperties).toBe(false);
    expect((graphLayoutSchema.properties as Record<string, Record<string, unknown>>).subflowId.type).toEqual(["string", "null"]);
    expect((graphLayoutSchema.properties as Record<string, Record<string, unknown>>).maxResults.maximum).toBe(250);

    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    const toolMessages = secondBody.messages.filter((message: { role?: string }) => message.role === "tool");
    const toolText = JSON.stringify(toolMessages);

    expect(toolText).toContain("src/main.ts");
    expect(toolText).toContain("visibleSourceMarker");
    expect(toolText).toContain("startLine");
    expect(toolText).toContain("endLine");
    expect(toolText).toContain("OPENAI_API_KEY=[redacted]");
    expect(toolText).not.toContain("secret-value");
    expect(toolText).toContain("current-project-bundle");
    expect(toolText).toContain("node-project");
    expect(toolText).toContain("positionMeaning");
  });

  it("preflights the effective Delphi model override instead of assuming the parent chat model capability", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-delphi-model-preflight-"));
    const bundle = await ensureFixtureProject(projectRoot);
    const provider = bundle.project.settings.providers.find((entry) => entry.kind === "openai-compatible")!;
    const configuredProvider = {
      ...provider,
      model: "openai/gpt-4o",
      detectedAvailableModels: ["openai/gpt-4o", "deepseek/deepseek-v4-pro"],
      detectedModelCapabilities: {
        "openai/gpt-4o": { supportsImageInput: true },
        "deepseek/deepseek-v4-pro": { supportsImageInput: false }
      },
      subagentModelPolicies: {
        ...provider.subagentModelPolicies,
        delphi: {
          ...provider.subagentModelPolicies.delphi,
          modelOverride: "deepseek/deepseek-v4-pro"
        }
      }
    };

    expect(effectiveDelphiModelPreflight(configuredProvider)).toEqual({
      modelId: "deepseek/deepseek-v4-pro",
      imageInputSupport: "unsupported",
      capabilitySource: "detected"
    });
  });

  it("lets the chat auto-approve toggle cover medium-risk parent commands without a static CLI allowlist", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-delphi-cli-recovery-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "parent-guarded-console",
      private: true,
      scripts: { inspect: "node --version" }
    }), "utf8");
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      autoApproveShellCommands: false,
      researchAutoApproveGraphChanges: { enabled: true, includeDestructive: false },
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      runTargetProfiles: [{
        id: "web-local-browser",
        label: "Local Browser",
        kind: "web",
        runCommand: "npm run dev",
        url: "http://localhost:5173",
        ports: [5173],
        targetRequired: false,
        diagnosticCommands: [],
        recoveryCommands: [],
        retryAfterRecovery: true,
        timeoutSeconds: 120
      }],
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-project-inspect",
        name: "archicode_console_run_command",
        arguments: JSON.stringify({ command: "npm run inspect" })
      }]))
      .mockImplementation(() => Promise.resolve(streamingChatCompletionResponse("The project inspection command completed through the guarded project console.")));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id } });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Run the project's inspection command and tell me whether it completes."
    });

    const assistant = answered.messages.at(-1)!;
    const initialBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const continuationBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    const consoleToolText = JSON.stringify(continuationBody.messages.filter((message: { role?: string }) => message.role === "tool"));
    expect(assistant.error).toBeUndefined();
    expect(assistant.content).toContain("inspection command completed");
    expect(assistant.mcpApprovalRequest).toBeUndefined();
    expect(assistant.content).not.toContain("Research provider failed");
    expect(assistant.mcpToolCalls).toContainEqual(expect.objectContaining({
      toolName: "run_command",
      status: "succeeded"
    }));
    expect(assistant.subagentRuns).toEqual([]);
    expect(consoleToolText).toContain("succeeded");
    expect(consoleToolText).toContain("\\\"exitCode\\\": 0");
    expect(JSON.stringify(initialBody)).toContain("archicode_console_run_command");
    expect(JSON.stringify(initialBody)).not.toContain("archicode_project_inspect_cli");
    expect(initialBody.tool_choice).toBeUndefined();
    expect(initialBody.parallel_tool_calls).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns malformed Codex Local Delphi arguments for correction instead of failing the provider", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-local-delphi-repair-"));
    const storageRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-storage-"));
    const promptPath = path.join(projectRoot, "captured-prompts.txt");
    setResearchStorageRoot(storageRoot);
    const bundle = await ensureFixtureProject(projectRoot);
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "local-delphi-repair",
      private: true,
      scripts: { typecheck: "tsc --noEmit", dev: "vite" }
    }), "utf8");
    const malformed = JSON.stringify({
      archicodeResearchTurn: {
        toolCalls: [{
          id: "bad-delphi",
          providerToolName: "archicode_spawn_delphi",
          arguments: {
            objective: "Audit the live website",
            platforms: ["web-local-browser"],
            commands: [{ command: "npm run typecheck" }]
          }
        }]
      }
    });
    const corrected = JSON.stringify({
      archicodeResearchTurn: {
        toolCalls: [{
          id: "fixed-delphi",
          providerToolName: "archicode_spawn_delphi",
          arguments: {
            objective: "Audit the live website",
            platforms: ["web"],
            target: { profileId: "web-local-browser", launch: "if-needed", cleanup: "stop-if-started" },
            commands: ["npm run typecheck"]
          }
        }]
      }
    });
    const finish = JSON.stringify({
      archicodeResearchTurn: {
        answer: "The corrected Delphi audit is ready for approval.",
        toolCalls: [{
          id: "memory-after-repair",
          providerToolName: "archicode_update_memory",
          arguments: { summary: "A corrected Delphi audit is awaiting approval." }
        }]
      }
    });
    const commandPath = await createFakeResearchCodex(projectRoot, [malformed, corrected, finish], promptPath);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      runTargetProfiles: [{
        id: "web-local-browser",
        label: "Local Browser",
        kind: "web",
        runCommand: "npm run dev",
        url: "http://localhost:5173",
        ports: [5173],
        targetRequired: false,
        diagnosticCommands: [],
        recoveryCommands: [],
        retryAfterRecovery: true,
        timeoutSeconds: 120
      }],
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "codex-local"
        ? { ...provider, enabled: true, localCommand: commandPath, model: "gpt-5.6-terra" }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id } });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Run and test the current website in a live browser."
    });

    const assistant = answered.messages.at(-1)!;
    const delphiRun = assistant.subagentRuns.find((run) => run.kind === "delphi-testing");
    const prompts = await readFile(promptPath, "utf8");
    expect(assistant.error).toBeUndefined();
    expect(assistant.content).toContain("corrected Delphi audit is ready for approval");
    expect(delphiRun).toMatchObject({ status: "awaiting-approval" });
    expect(delphiTestingInputSchema.parse(JSON.parse(delphiRun!.argumentsJson))).toMatchObject({
      platforms: ["web"],
      commands: ["npm run typecheck"],
      target: { profileId: "web-local-browser" }
    });
    expect(prompts).toContain("REPAIRABLE_TOOL_ERROR");
    expect(prompts).toContain("Put a Run App profile id in target.profileId, not platforms");
    expect(prompts).not.toContain("Codex Local failed");
  });

  it("returns an omitted Delphi delegation to the same Anthropic trajectory instead of forcing a provider-specific first tool", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-anthropic-delphi-route-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "anthropic-delphi-route",
      private: true,
      scripts: { test: "vitest run" }
    }), "utf8");
    process.env.ANTHROPIC_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "anthropic-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ANTHROPIC_RESEARCH_TEST_KEY" }
        : { ...provider, enabled: false })
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "text",
        text: "The project appears ready, so I am done."
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "toolu-delphi-route",
        name: "archicode_spawn_delphi",
        input: { objective: "Run the existing tests and audit the current app", mode: "audit", platforms: ["generic"] }
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "text",
        text: "Delphi's audit is ready for your approval."
      }]));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id } });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Run and test the current app, including a runtime audit."
    });
    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const correctionBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);

    expect(firstBody.tool_choice).toBeUndefined();
    expect(JSON.stringify(correctionBody.messages)).toContain("has not delegated that work to Delphi");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(answered.messages.at(-1)?.subagentRuns).toContainEqual(expect.objectContaining({
      kind: "delphi-testing",
      status: "awaiting-approval"
    }));
  });

  it("asks the user to choose one or several compatible Delphi runtime targets", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-delphi-target-choice-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      runTargetProfiles: [
        {
          id: "monorepo-api",
          label: "Monorepo API",
          kind: "api",
          runCommand: "npm run dev:api",
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          timeoutSeconds: 120
        },
        {
          id: "monorepo-web",
          label: "Monorepo Web",
          kind: "web",
          runCommand: "npm run dev:web",
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          timeoutSeconds: 120
        }
      ],
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-delphi-target-choice",
        name: "archicode_spawn_delphi",
        arguments: JSON.stringify({ objective: "Run and test the monorepo services", mode: "audit", platforms: ["generic"] })
      }]))
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-memory-target-choice",
        name: "archicode_leave_memory_unchanged",
        arguments: JSON.stringify({ reason: "The target choice is awaiting user input." })
      }], "Choose the Run App targets Delphi should test."));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id } });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Run and test this monorepo."
    });
    const message = answered.messages.at(-1)!;
    const delphiRun = message.subagentRuns.find((run) => run.kind === "delphi-testing")!;

    expect(delphiRun.runtimeTargetSelection).toMatchObject({
      allowMultiple: true,
      minSelections: 1,
      options: [
        { profileId: "monorepo-api", label: "Monorepo API", kind: "api" },
        { profileId: "monorepo-web", label: "Monorepo Web", kind: "web" }
      ]
    });
    expect(delphiRun.reviewReason).toContain("Choose one or more compatible Run App targets");
    await expect(respondToSubagentRun({
      projectRoot,
      sessionId: answered.id,
      messageId: message.id,
      runId: delphiRun.id,
      decision: "approved",
      runtimeTargetProfileIds: []
    })).rejects.toThrow("Choose at least one Run App target");
  });

  it("starts and audits every selected Delphi runtime target under one approval", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-delphi-multi-target-run-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      private: true,
      scripts: { test: "node -e \"console.log('multi-target-check-ok')\"" }
    }), "utf8");
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      runTargetProfiles: [
        {
          id: "service-api",
          label: "Service API",
          kind: "generic",
          runCommand: "node -e \"console.log('api-ready'); setInterval(() => {}, 1000)\"",
          runtimeReadyPattern: "api-ready",
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          timeoutSeconds: 10
        },
        {
          id: "service-web",
          label: "Service Web",
          kind: "generic",
          runCommand: "node -e \"console.log('web-ready'); setInterval(() => {}, 1000)\"",
          runtimeReadyPattern: "web-ready",
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          timeoutSeconds: 10
        }
      ],
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    let parentTurn = 0;
    let delphiTurn = 0;
    const parentToolNamesByTurn: string[][] = [];
    const parentRequestBodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (body.includes("You are Delphi")) {
        delphiTurn += 1;
        if (delphiTurn === 1 || delphiTurn === 4) {
          return streamingChatCompletionToolCallsResponse([{
            id: `inspect-target-${delphiTurn}`,
            name: "delphi_inspect_test_environment",
            arguments: "{}"
          }]);
        }
        if (delphiTurn === 2) {
          return streamingChatCompletionToolCallsResponse([{
            id: "run-shared-finite-check",
            name: "archicode_console_run_command",
            arguments: JSON.stringify({ command: "npm run test" })
          }]);
        }
        const firstTarget = delphiTurn === 3;
        return streamingChatCompletionResponse(JSON.stringify({
          status: firstTarget ? "completed" : "blocked",
          verdict: firstTarget ? "passed" : "not-run",
          summary: firstTarget ? "The shared finite check passed while both targets were running." : "The second selected runtime started successfully; no additional finite command was repeated.",
          attempts: firstTarget ? 1 : 0,
          checks: firstTarget ? [{ name: "Shared finite check", status: "passed", command: "npm run test", evidence: ["exit code 0"] }] : [],
          findings: [],
          toolchains: [{ adapter: "generic", status: "ready", evidence: ["Selected runtime profile started."] }],
          artifacts: [],
          blockers: firstTarget ? [] : ["No direct generic-target adapter action was available."],
          recommendedNextSteps: []
        }));
      }
      parentTurn += 1;
      const parentRequest = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
      parentRequestBodies.push(body);
      parentToolNamesByTurn.push((parentRequest.tools ?? []).flatMap((tool) => tool.function?.name ? [tool.function.name] : []));
      if (parentTurn === 1) {
        return streamingChatCompletionToolCallsResponse([{
          id: "spawn-multi-target-delphi",
          name: "archicode_spawn_delphi",
          arguments: JSON.stringify({ objective: "Run and test both services", mode: "audit", platforms: ["generic"] })
        }]);
      }
      if (parentTurn === 2) {
        return streamingChatCompletionToolCallsResponse([{
          id: "remember-multi-target-card",
          name: "archicode_update_memory",
          arguments: JSON.stringify({
            summary: "The Delphi audit is awaiting approval.",
            todos: [{ title: "Run Delphi test/runtime audit", status: "awaiting-approval", notes: "Waiting for target selection." }],
            runRefs: [{ runId: "delphi-testing", title: "Delphi audit", status: "awaiting-approval", note: "Pending approval." }]
          })
        }], "Choose which service targets Delphi should test.");
      }
      return streamingChatCompletionResponse([
        "Delphi audit finished. Delphi finished with verdict: blocked.",
        "Service API started and the shared finite check passed. Service Web also started, but direct generic-target adapter coverage was unavailable."
      ].join(" "));
    });
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id } });
    const prepared = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Run and test this multi-service project." });
    const preparedMessage = prepared.messages.at(-1)!;
    const delphiRun = preparedMessage.subagentRuns.find((run) => run.kind === "delphi-testing")!;
    const parentActivity: string[] = [];

    const completed = await respondToSubagentRun({
      projectRoot,
      sessionId: prepared.id,
      messageId: preparedMessage.id,
      runId: delphiRun.id,
      decision: "approved",
      runtimeTargetProfileIds: ["service-api", "service-web"],
      onActivity: (message) => parentActivity.push(message)
    });
    const completedRun = completed.messages.flatMap((message) => message.subagentRuns).find((run) => run.id === delphiRun.id)!;
    const services = await listRuntimeServices(projectRoot);

    expect(completedRun.selectedRuntimeTargetProfileIds).toEqual(["service-api", "service-web"]);
    expect(completedRun.status).toBe("blocked");
    expect(completedRun.resultSummary).toContain("Service API");
    expect(completedRun.resultSummary).toContain("Service Web");
    expect(services.filter((service) => service.profileId === "service-api" || service.profileId === "service-web").every((service) => service.status === "stopped")).toBe(true);
    expect(delphiTurn).toBe(5);
    expect(parentTurn).toBe(3);
    expect(parentActivity).toContain("Delphi finished. Archi is reviewing the evidence and preparing the final report.");
    expect(parentActivity.at(-1)).toBe("The final report is ready in chat.");
    expect(parentRequestBodies[2]).toContain("HOST DURABLE-GOAL EXTERNAL-OUTCOME RESUME");
    expect(parentRequestBodies[2]).toContain("The host outcome above is the complete evidence packet for this event");
    const finalReportMessage = [...completed.messages].reverse().find((message) => message.role === "assistant")!;
    expect(completed.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(finalReportMessage.content).toContain("Delphi audit finished.");
    expect(finalReportMessage.content).toContain("Delphi finished with verdict: blocked.");
    expect(finalReportMessage.content).not.toMatch(/need to update memory|checkpoint is recorded/i);
    expect(completed.orchestration.goal?.status).toBe("blocked");
    expect(completed.orchestration.goal?.checkpointSummary).toContain(finalReportMessage.id);
    expect(completed.orchestration.goal?.completionEvidence).not.toContain(`Final evidence-backed report persisted in chat message ${finalReportMessage.id}.`);
    expect(completed.memory.summary).not.toContain("awaiting approval");
    expect(completed.memory.todos.find((todo) => todo.title === "Run Delphi test/runtime audit")?.status).toBe("blocked");
    expect(completed.memory.runRefs.find((runRef) => runRef.runId === "delphi-testing")?.status).toBe("blocked");
    expect(completed.memory.runRefs.find((runRef) => runRef.runId === delphiRun.id)).toMatchObject({
      title: "delphi-testing",
      status: "blocked"
    });
  });

  it("rejects approval cards created by a parent turn the user stops", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-cancel-corrective-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const markerPath = path.join(projectRoot, "second-round-started.txt");
    const command = await createMarkedStepResearchCodex(projectRoot, [
      {
        output: localResearchSinkTurn("Preparing a fresh audit approval.", [
          { providerToolName: "archicode_spawn_delphi", arguments: { objective: "Audit the remaining untested coverage", mode: "audit", platforms: ["generic"] } }
        ])
      },
      {
        output: JSON.stringify({ archicodeResearch: { answer: "Never delivered.", summary: "" } }),
        delayMs: 15_000,
        markerPath
      }
    ]);
    const bundle = await ensureFixtureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const baseSession = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-cancel" } });
    const now = new Date().toISOString();
    const priorArgs = delphiTestingInputSchema.parse({ objective: "Audit the project", mode: "audit", platforms: ["generic"] });
    const seeded = researchChatSessionSchema.parse({
      ...baseSession,
      orchestration: {
        ...baseSession.orchestration,
        goal: { id: "goal-cancel", objective: "Audit and report", status: "active", steps: [], createdAt: now, updatedAt: now },
        updatedAt: now
      },
      messages: [{
        id: "assistant-prior-delphi",
        role: "assistant",
        content: "Prior audit finished blocked before browser coverage.",
        createdAt: now,
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: [{
          id: "delphi-approved-run",
          kind: "delphi-testing",
          status: "blocked",
          title: "Approved Delphi audit",
          argumentsJson: JSON.stringify(priorArgs),
          approvedRuntimeCommands: [],
          approvedRuntimeCleanupCommands: [],
          progress: [],
          createdAt: now,
          updatedAt: now
        }]
      }]
    });
    await persistResearchSession(projectRoot, seeded);

    const turn = sendResearchChatMessage({
      projectRoot,
      sessionId: seeded.id,
      content: "HOST DURABLE-GOAL EXTERNAL-OUTCOME RESUME.\nThe approved Delphi audit finished blocked before browser coverage.",
      internalContinuation: true,
      outcomeEvidenceProvided: true
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await readFile(markerPath, "utf8");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(cancelResearchChatMessage(seeded.id)).toBe(true);
    const result = await turn;

    expectTerminalResearchLifecycleInvariants(result);
    const finalAssistant = result.messages.at(-1)!;
    expect(finalAssistant.role).toBe("assistant");
    expect(finalAssistant.content).toBe("Stopped.");
    const allRuns = result.messages.flatMap((message) => message.subagentRuns);
    const newAudit = allRuns.find((run) => run.kind === "delphi-testing" && run.id !== "delphi-approved-run");
    expect(newAudit?.status).toBe("rejected");
    expect(newAudit?.approvalInheritedFromRunId).toBeUndefined();
    expect(allRuns.some((run) => run.status === "running" || run.status === "awaiting-approval")).toBe(false);
    expect(result.orchestration.goal?.continuationCount).toBe(0);
    const reloaded = (await listResearchChats(projectRoot)).find((item) => item.id === seeded.id)!;
    expect(reloaded.messages.flatMap((message) => message.subagentRuns).some((run) => run.status === "running")).toBe(false);
  }, 30_000);

  it("does not auto-start a fresh Delphi approval card from a turn that ended in a provider failure", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-error-corrective-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const command = await createScriptedResearchCodex(projectRoot, [
      {
        exitCode: 0,
        output: localResearchSinkTurn("Preparing a fresh audit approval.", [
          { providerToolName: "archicode_spawn_delphi", arguments: { objective: "Audit the remaining untested coverage", mode: "audit", platforms: ["generic"] } }
        ])
      },
      { exitCode: 1, stderr: "provider transport blew up" }
    ]);
    const bundle = await ensureFixtureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const baseSession = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-error-corrective" } });
    const now = new Date().toISOString();
    const priorArgs = delphiTestingInputSchema.parse({ objective: "Audit the project", mode: "audit", platforms: ["generic"] });
    const seeded = researchChatSessionSchema.parse({
      ...baseSession,
      orchestration: {
        ...baseSession.orchestration,
        goal: { id: "goal-error-corrective", objective: "Audit and report", status: "active", steps: [], createdAt: now, updatedAt: now },
        updatedAt: now
      },
      messages: [{
        id: "assistant-prior-delphi",
        role: "assistant",
        content: "Prior audit finished blocked before browser coverage.",
        createdAt: now,
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: [{
          id: "delphi-approved-run",
          kind: "delphi-testing",
          status: "blocked",
          title: "Approved Delphi audit",
          argumentsJson: JSON.stringify(priorArgs),
          approvedRuntimeCommands: [],
          approvedRuntimeCleanupCommands: [],
          progress: [],
          createdAt: now,
          updatedAt: now
        }]
      }]
    });
    await persistResearchSession(projectRoot, seeded);

    const result = await sendResearchChatMessage({
      projectRoot,
      sessionId: seeded.id,
      content: "HOST DURABLE-GOAL EXTERNAL-OUTCOME RESUME.\nThe approved Delphi audit finished blocked before browser coverage.",
      internalContinuation: true,
      outcomeEvidenceProvided: true
    });

    expectTerminalResearchLifecycleInvariants(result);
    const finalAssistant = result.messages.at(-1)!;
    expect(finalAssistant.error).toContain("exit code 1");
    expect(finalAssistant.content).toContain("Codex Local failed");
    const allRuns = result.messages.flatMap((message) => message.subagentRuns);
    const newAudit = allRuns.find((run) => run.kind === "delphi-testing" && run.id !== "delphi-approved-run");
    // The valid card created before the provider failure stays visible for the
    // user to decide, but the host never starts a new audit implicitly.
    expect(newAudit?.status).toBe("awaiting-approval");
    expect(newAudit?.approvalInheritedFromRunId).toBeUndefined();
    expect(allRuns.some((run) => run.status === "running")).toBe(false);
    expect(result.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
  }, 20_000);

  it("stops an inline Sherlock micro-run when the parent turn is cancelled", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-cancel-sherlock-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const markerPath = path.join(projectRoot, "sherlock-round-started.txt");
    const command = await createMarkedStepResearchCodex(projectRoot, [
      {
        output: localResearchSinkTurn("Bringing in Sherlock.", [
          { providerToolName: "archicode_spawn_sherlock", arguments: { objective: "Investigate the flaky navigation handling", mode: "codebase" } }
        ])
      },
      {
        output: JSON.stringify({ archicodeResearch: { answer: "Never delivered.", summary: "" } }),
        delayMs: 20_000,
        markerPath
      }
    ]);
    const bundle = await ensureFixtureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({ projectRoot, scope: { type: "flow", flowId: "flow-main" } });

    const turn = sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Investigate the flaky navigation handling in depth."
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await readFile(markerPath, "utf8");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(cancelResearchChatMessage(session.id)).toBe(true);
    const cancelledAt = Date.now();
    const result = await turn;

    expectTerminalResearchLifecycleInvariants(result);
    // The 20s Sherlock provider call must have been aborted, not awaited out.
    expect(Date.now() - cancelledAt).toBeLessThan(10_000);
    const sherlockRun = result.messages.flatMap((message) => message.subagentRuns).find((run) => run.kind === "sherlock-research")!;
    expect(sherlockRun.status).toBe("failed");
    expect(sherlockRun.error).toMatch(/cancel|abort/i);
    expect(result.messages.at(-1)?.content).toBe("Stopped.");
  }, 30_000);

  it("continues past obsolete bookkeeping calls when the model corrects its trajectory", async () => {
    const { projectRoot } = await setupProject([
      localResearchSinkTurn("Recording progress.", [
        { providerToolName: "archicode_checkpoint_goal", arguments: { status: "continue", summary: "First checkpoint after the outcome." } }
      ]),
      localResearchSinkTurn("Recording progress again.", [
        { providerToolName: "archicode_checkpoint_goal", arguments: { status: "continue", summary: "Second checkpoint with no new work." } }
      ]),
      localResearchSinkTurn("Wrapping up.", [memoryUnchangedSink()]),
      JSON.stringify({ archicodeResearch: { answer: "The finite checks passed; browser coverage remains blocked with the recorded evidence.", summary: "Outcome reported." } })
    ]);
    const baseSession = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-checkpoint-guard" } });
    const now = new Date().toISOString();
    const seeded = researchChatSessionSchema.parse({
      ...baseSession,
      orchestration: {
        ...baseSession.orchestration,
        goal: { id: "goal-checkpoint-guard", objective: "Audit and report", status: "active", steps: [], createdAt: now, updatedAt: now },
        updatedAt: now
      }
    });
    await persistResearchSession(projectRoot, seeded);

    const result = await sendResearchChatMessage({
      projectRoot,
      sessionId: seeded.id,
      content: "HOST DURABLE-GOAL EXTERNAL-OUTCOME RESUME.\nThe approved Delphi audit finished.",
      internalContinuation: true,
      outcomeEvidenceProvided: true
    });

    expectTerminalResearchLifecycleInvariants(result);
    expect(result.orchestration.goal?.status).toBe("completed");
    expect(result.orchestration.goal?.continuationCount).toBe(0);
    expect(result.messages.at(-1)?.content).toContain("browser coverage remains blocked");
  }, 20_000);

  it("stops an exact consecutive no-progress tool loop in the shared runtime", async () => {
    const repeatedCheckpoint = { status: "continue", summary: "No new work was performed." };
    const { projectRoot } = await setupProject([
      localResearchSinkTurn("Recording progress.", [
        { providerToolName: "archicode_checkpoint_goal", arguments: repeatedCheckpoint }
      ]),
      localResearchSinkTurn("Recording the same state again.", [
        { providerToolName: "archicode_checkpoint_goal", arguments: repeatedCheckpoint }
      ]),
      localResearchSinkTurn("Still recording progress.", [
        { providerToolName: "archicode_checkpoint_goal", arguments: repeatedCheckpoint }
      ])
    ]);
    const baseSession = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-checkpoint-loop-limit" } });
    const now = new Date().toISOString();
    const seeded = researchChatSessionSchema.parse({
      ...baseSession,
      orchestration: {
        ...baseSession.orchestration,
        goal: { id: "goal-checkpoint-loop-limit", objective: "Audit and report", status: "active", steps: [], createdAt: now, updatedAt: now },
        updatedAt: now
      }
    });
    await persistResearchSession(projectRoot, seeded);

    const result = await sendResearchChatMessage({
      projectRoot,
      sessionId: seeded.id,
      content: "HOST DURABLE-GOAL EXTERNAL-OUTCOME RESUME.\nThe approved Delphi audit finished.",
      internalContinuation: true,
      outcomeEvidenceProvided: true
    });

    expectTerminalResearchLifecycleInvariants(result);
    const finalAssistant = result.messages.at(-1)!;
    expect(result.orchestration.goal?.continuationCount).toBe(0);
    expect(finalAssistant.error).toContain("Consecutive identical tool-call loop detected");
    expect(finalAssistant.content).toContain("ArchiCode stopped a no-progress agent loop");
    expect(finalAssistant.mcpToolCalls).toHaveLength(2);
    expect(result.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  }, 20_000);

  it("reconciles impossible running subagent cards to an honest failed state on load", async () => {
    const { projectRoot } = await setupProject();
    const baseSession = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-stale-running" } });
    const now = new Date().toISOString();
    const runShape = {
      kind: "delphi-testing" as const,
      status: "running" as const,
      title: "Audit",
      argumentsJson: "{}",
      progress: ["Captured browser-1-goto evidence"],
      createdAt: now,
      updatedAt: now
    };
    const seeded = researchChatSessionSchema.parse({
      ...baseSession,
      messages: [{
        id: "assistant-stale-running",
        role: "assistant",
        content: "Stopped.",
        createdAt: now,
        attachmentIds: [],
        webUsed: false,
        mcpToolCalls: [],
        subagentRuns: [
          { ...runShape, id: "stale-running-run" },
          { ...runShape, id: "live-running-run" }
        ]
      }]
    });
    markSubagentRunLive("live-running-run");
    try {
      await persistResearchSession(projectRoot, seeded);
      const reloaded = (await listResearchChats(projectRoot)).find((item) => item.id === seeded.id)!;
      const runs = reloaded.messages.flatMap((message) => message.subagentRuns);
      const stale = runs.find((run) => run.id === "stale-running-run")!;
      const live = runs.find((run) => run.id === "live-running-run")!;

      expect(stale.status).toBe("failed");
      expect(stale.error).toMatch(/no live work/);
      expect(stale.progress).toEqual(["Captured browser-1-goto evidence"]);
      expect(live.status).toBe("running");
    } finally {
      markSubagentRunSettled("live-running-run");
    }
  });

  it("blocks redundant Delphi artifact rescans without blocking source inspection", () => {
    expect(requestsRedundantOutcomeArtifactRead("archicode_project_list_files", {
      directory: ".archicode/artifacts",
      recursive: true
    })).toBe(true);
    expect(requestsRedundantOutcomeArtifactRead("archicode_project_read_file", {
      path: ".archicode/artifacts/chats/session/report.json"
    })).toBe(true);
    expect(requestsRedundantOutcomeArtifactRead("archicode_project_read_artifact", {
      artifactId: "artifact-delphi-report"
    })).toBe(true);
    expect(requestsRedundantOutcomeArtifactRead("archicode_project_read_file", {
      path: "src/components/AppHeader.vue"
    })).toBe(false);
  });

  it("recovers an unknown tool name with the exact allowlist after switching chat models", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-tool-recovery-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionResponse("First model answered."))
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-guessed-layout",
        name: "archicode_project_read_graph_layout",
        arguments: JSON.stringify({ flowId: "flow-main" })
      }]))
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-exact-layout",
        name: "archicode_read_graph_layout",
        arguments: JSON.stringify({ flowId: "flow-main", maxResults: 5 })
      }]))
      .mockResolvedValueOnce(streamingChatCompletionResponse("Recovered after exact tool-name feedback."));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: bundle.project.id }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Answer this first turn.",
      modelId: "x-ai/grok-4.5"
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Now inspect the graph layout.",
      modelId: "google/gemini-3.5-flash"
    });

    const recoveryBody = JSON.parse(fetchMock.mock.calls[2]![1]!.body as string);
    const recoveryToolResults = JSON.stringify(recoveryBody.messages.filter((message: { role?: string }) => message.role === "tool"));
    const assistant = answered.messages.at(-1)!;
    expect(answered.modelId).toBe("google/gemini-3.5-flash");
    expect(assistant.content).toContain("Recovered after exact tool-name feedback");
    expect(assistant.mcpToolCalls).toContainEqual(expect.objectContaining({
      toolName: "archicode_project_read_graph_layout",
      status: "failed"
    }));
    expect(assistant.mcpToolCalls).toContainEqual(expect.objectContaining({
      toolName: "read_graph_layout",
      status: "succeeded"
    }));
    expect(recoveryToolResults).toContain("invalid-tool-name");
    expect(recoveryToolResults).toContain("archicode_read_graph_layout");
    expect(recoveryToolResults).toContain("No tool ran");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps a multi-step Research investigation in one provider trajectory without synthetic host turns", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-durable-goal-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "inspect-phase-files",
        name: "archicode_project_list_files",
        arguments: JSON.stringify({ directory: ".", recursive: false })
      }]))
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "inspect-phase-content",
        name: "archicode_project_search_files",
        arguments: JSON.stringify({ query: "phase", maxResults: 5 })
      }]))
      .mockResolvedValueOnce(streamingChatCompletionResponse("Both requested phases were inspected and verified from the collected project evidence."));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id } });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Complete both phases and verify the result."
    });

    expect(answered.orchestration.goal).toBeUndefined();
    expect(answered.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(answered.messages.at(-1)?.content).toContain("Both requested phases were inspected and verified");
    expect(answered.messages.at(-1)?.mcpToolCalls.filter((call) => call.status === "succeeded")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("wakes a durable goal only when its exact named run finishes", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-goal-run-wake-"));
    const storageRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-storage-"));
    setResearchStorageRoot(storageRoot);
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id } });
    const storagePath = researchStorageFile(storageRoot, projectRoot);
    const stored = JSON.parse(await readFile(storagePath, "utf8")) as { sessions: Array<Record<string, unknown>> };
    const storedSession = stored.sessions.find((item) => item.id === session.id)!;
    storedSession.orchestration = {
      todos: [],
      updatedAt: "2026-07-18T00:00:00.000Z",
      goal: {
        id: "goal-run-wake",
        objective: "Wait for and verify the implementation run",
        successCriteria: ["The exact implementation run succeeds"],
        status: "waiting",
        steps: [{
          id: "wait-run",
          title: "Wait for implementation",
          status: "waiting",
          evidence: [],
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z"
        }],
        currentStepId: "wait-run",
        checkpointSummary: "Waiting for run-target-123",
        completionEvidence: [],
        blockers: [],
        waitingFor: [{ kind: "run", id: "run-target-123", label: "Implementation run" }],
        continuationCount: 0,
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z"
      }
    };
    await writeFile(storagePath, JSON.stringify(stored), "utf8");
    const fetchMock = vi.fn().mockResolvedValueOnce(streamingChatCompletionResponse(
      "The implementation run succeeded and the goal is complete."
    ));
    vi.stubGlobal("fetch", fetchMock);
    const run = runSchema.parse({
      id: "run-target-123",
      flowId: "flow-main",
      providerId: "provider-openai",
      status: "succeeded",
      phase: "complete",
      effort: "high",
      promptSummary: "Implement the requested target",
      permission: { decision: "allowed" },
      todos: [],
      logs: [{ at: "2026-07-18T00:01:00.000Z", stream: "system", text: "Verification passed." }],
      createdAt: "2026-07-18T00:00:00.000Z"
    });

    expect(await resumeResearchGoalsForRunUpdate(projectRoot, { ...run, id: "another-run" })).toEqual([]);
    const resumed = await resumeResearchGoalsForRunUpdate(projectRoot, run);

    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.orchestration.goal?.status).toBe("completed");
    expect(resumed[0]?.messages.at(-1)?.content).toContain("goal is complete");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resumes an unfinished durable goal after its graph approval is applied", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-goal-review-resume-"));
    const storageRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-storage-"));
    setResearchStorageRoot(storageRoot);
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id } });
    const storagePath = researchStorageFile(storageRoot, projectRoot);
    const stored = JSON.parse(await readFile(storagePath, "utf8")) as { sessions: Array<Record<string, any>> };
    const storedSession = stored.sessions.find((item) => item.id === session.id)!;
    const changeSet = {
      id: "goal-review-change",
      summary: "Add the approved durable-goal node",
      operations: [{
        kind: "create-node",
        flowId: "flow-main",
        node: {
          id: "node-durable-goal-review",
          type: "task",
          title: "Durable goal review",
          description: "Created after the approval pause."
        }
      }],
      createdAt: "2026-07-18T00:00:00.000Z"
    };
    storedSession.messages.push({
      id: "goal-review-message",
      role: "assistant",
      content: "The durable-goal graph update is ready for review.",
      createdAt: "2026-07-18T00:00:00.000Z",
      attachmentIds: [],
      webUsed: false,
      mcpToolCalls: [],
      subagentRuns: [],
      changeSet
    });
    storedSession.orchestration = {
      todos: [{
        id: "goal-review-todo",
        title: changeSet.summary,
        status: "awaiting-approval",
        changeSetId: changeSet.id,
        messageId: "goal-review-message",
        operationIndexes: [0],
        createdAt: "2026-07-18T00:00:00.000Z"
      }],
      updatedAt: "2026-07-18T00:00:00.000Z",
      goal: {
        id: "goal-review-resume",
        objective: "Apply and verify the approved graph update",
        successCriteria: ["The approved node exists in the graph"],
        status: "awaiting-approval",
        steps: [{
          id: "apply-review",
          title: "Apply the graph review",
          status: "awaiting-approval",
          evidence: [],
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z"
        }],
        currentStepId: "apply-review",
        checkpointSummary: "Waiting for graph approval",
        completionEvidence: [],
        blockers: [],
        waitingFor: [{ kind: "approval", id: changeSet.id, label: changeSet.summary }],
        continuationCount: 0,
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z"
      }
    };
    await writeFile(storagePath, JSON.stringify(stored), "utf8");
    const fetchMock = vi.fn().mockResolvedValueOnce(streamingChatCompletionResponse(
      "The approved node was added and verified; the goal is complete."
    ));
    vi.stubGlobal("fetch", fetchMock);

    const reviewed = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: session.id,
      messageId: "goal-review-message",
      changeSetId: changeSet.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });

    expect(reviewed.results[0]?.status).toBe("applied");
    expect(reviewed.session.orchestration.goal?.status).toBe("completed");
    expect(reviewed.session.messages.at(-1)?.content).toContain("goal is complete");
    expect((await loadProject(projectRoot)).flows[0]?.nodes.some((node) => node.id === "node-durable-goal-review")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops an exact consecutive unknown-tool loop with a precise host error", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-tool-limit-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-invalid-one",
        name: "archicode_project_read_graph_layout",
        arguments: "{}"
      }]))
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-invalid-two",
        name: "archicode_project_read_graph_layout",
        arguments: "{}"
      }]))
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-invalid-three",
        name: "archicode_project_read_graph_layout",
        arguments: "{}"
      }]));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: bundle.project.id }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Inspect the graph layout."
    });

    const assistant = answered.messages.at(-1)!;
    expect(assistant.content).toContain("ArchiCode stopped a no-progress agent loop");
    expect(assistant.content).toContain("Consecutive identical tool-call loop detected");
    expect(assistant.content).toContain("No additional tool action was executed after the guard fired");
    expect(assistant.content).not.toContain("Research provider failed");
    expect(assistant.error).toContain("stopped on attempt 3");
    expect(assistant.mcpToolCalls).toHaveLength(2);
    expect(assistant.mcpToolCalls.every((call) => call.status === "failed")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("continues the same trajectory when a claimed graph card has not yet been submitted", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-card-repair-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const proposedChangeSet = {
      summary: "Add the confirmed review node",
      operations: [{
        kind: "create-node",
        flowId: "flow-main",
        node: {
          id: "node-card-repair",
          type: "task",
          title: "Review card repair",
          description: "Captured by the bounded repair pass."
        }
      }]
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-initial-memory",
        name: "archicode_leave_memory_unchanged",
        arguments: JSON.stringify({ reason: "No durable state changed." })
      }], "I have prepared the requested graph review card."))
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-repaired-card",
        name: "archicode_propose_graph_change_set",
        arguments: JSON.stringify(proposedChangeSet)
      }]));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: bundle.project.id }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Add the confirmed review node and prepare the review card."
    });

    const repairBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    const repairToolNames = repairBody.tools.map((tool: { function?: { name?: string } }) => tool.function?.name);
    const repairTranscript = JSON.stringify(repairBody.messages);
    const assistant = answered.messages.at(-1)!;
    expect(repairToolNames).toContain("archicode_propose_graph_change_set");
    expect(repairToolNames).toContain("archicode_project_read_file");
    expect(repairTranscript).toContain("invalid-tool-name");
    expect(repairTranscript).toContain("archicode_propose_graph_change_set");
    expect(assistant.changeSet?.summary).toBe("Add the confirmed review node");
    expect(assistant.changeSet?.operations).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replaces a false review-card completion with an honest answer when repair cannot build one", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-card-honesty-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-false-card-memory",
        name: "archicode_leave_memory_unchanged",
        arguments: JSON.stringify({ reason: "No durable state changed." })
      }], "I created the graph review card and it is ready."))
      .mockResolvedValueOnce(streamingChatCompletionResponse("No review card was created because the requested operations are not yet clear."));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: bundle.project.id }
    });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Prepare whatever graph review card you can."
    });

    const assistant = answered.messages.at(-1)!;
    expect(assistant.content).toBe("No review card was created because the requested operations are not yet clear.");
    expect(assistant.changeSet).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets Research read current flow violations without requesting mutation approval", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-violation-tool-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    const now = "2026-07-16T10:00:00.000Z";
    const rule = {
      id: "rule-research-boundary",
      title: "Canvas cannot depend on storage",
      body: "Keep UI and storage boundaries separate.",
      kind: "policy" as const,
      status: "active" as const,
      severity: "error" as const,
      enforcement: "enforced" as const,
      constraint: {
        kind: "forbidden-dependency" as const,
        fromPathGlobs: ["src/ui/**"],
        toPathGlobs: ["src/storage/**"],
        includeRuntime: false
      },
      createdAt: now,
      updatedAt: now
    };
    const policyFingerprint = createHash("sha256").update(JSON.stringify([{
      id: rule.id,
      title: rule.title,
      body: rule.body,
      kind: rule.kind,
      status: rule.status,
      severity: rule.severity,
      enforcement: rule.enforcement,
      constraint: rule.constraint
    }])).digest("hex");
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      nodeRules: [rule],
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    await mkdir(path.join(projectRoot, ".archicode", "runtime"), { recursive: true });
    await writeFile(path.join(projectRoot, ".archicode", "runtime", "architecture-policy-evaluation.json"), JSON.stringify({
      version: 1,
      generatedAt: now,
      analyzerVersion: 1,
      policyFingerprint,
      violations: [{
        id: "violation-research-flow",
        policyId: rule.id,
        policyTitle: rule.title,
        kind: rule.constraint.kind,
        severity: rule.severity,
        enforcement: rule.enforcement,
        message: "src/ui/Canvas.ts imports src/storage/db.ts",
        source: { entityKind: "file", path: "src/ui/Canvas.ts", flowId: "flow-main", nodeId: "node-canvas" },
        target: { entityKind: "file", path: "src/storage/db.ts" },
        checkedAt: now,
        firstSeenAt: now
      }],
      stats: { policiesEvaluated: 1, edgesChecked: 1, violations: 1 }
    }), "utf8");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-violations",
        name: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
        arguments: JSON.stringify({ action: "list_violations", flowId: "flow-main" })
      }]))
      .mockResolvedValueOnce(streamingChatCompletionResponse("This flow has one enforced architecture error."));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({ projectRoot, scope: { type: "flow", flowId: "flow-main" } });

    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Does this flow have any rule violations?"
    });
    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const rulesSchema = firstBody.tools.find((item: { function?: { name?: string } }) =>
      item.function?.name === ARCHICODE_RESEARCH_RULES_TOOL_NAME).function.parameters;
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    const toolText = JSON.stringify(secondBody.messages.filter((message: { role?: string }) => message.role === "tool"));
    const assistant = answered.messages.at(-1)!;

    expect(rulesSchema.properties.action.enum).toContain("list_violations");
    expect(toolText).toContain("violation-research-flow");
    expect(toolText).toContain('\\"status\\": \\"current\\"');
    expect(assistant.content).toContain("one enforced architecture error");
    expect(assistant.mcpApprovalRequest).toBeUndefined();
    expect(assistant.mcpToolCalls).toContainEqual(expect.objectContaining({
      serverId: ARCHICODE_RESEARCH_RULES_SERVER_ID,
      toolName: "manage_rules",
      status: "succeeded"
    }));
  });

  it("lets direct research providers retrieve older chat history through a capped built-in tool", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-history-tool-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([
        { id: "call-memory-badge", name: "archicode_update_memory", arguments: "{\"summary\":\"The launch badge must be a blue octagon.\"}" }
      ], "Noted the blue octagon decision."))
      .mockResolvedValueOnce(streamingChatCompletionResponse("Second turn noted."))
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([
        { id: "call-history", name: "archicode_read_chat_history", arguments: "{\"mode\":\"search\",\"query\":\"blue octagon\",\"maxMessages\":4,\"maxChars\":2000}" }
      ]))
      .mockResolvedValueOnce(streamingChatCompletionResponse("The older decision was retrieved."));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: bundle.project.id }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Remember that the launch badge must be a blue octagon."
    });
    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Now let's talk about something unrelated."
    });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "What was that earlier badge decision?"
    });

    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const toolNames = firstBody.tools.map((tool: { function?: { name?: string } }) => tool.function?.name);
    expect(toolNames).toContain("archicode_read_chat_history");

    const continuationBody = JSON.parse(fetchMock.mock.calls[3]![1]!.body as string);
    const toolMessages = continuationBody.messages.filter((message: { role?: string }) => message.role === "tool");
    const toolText = JSON.stringify(toolMessages);
    expect(toolText).toContain("blue octagon");
    expect(toolText).toContain("normalRecentWindow");
    expect(toolText).toContain("returnedMessages");
    expect(answered.messages.at(-1)?.mcpToolCalls.some((call) => call.toolName === "read_chat_history" && call.status === "succeeded")).toBe(true);
  });

  it("searches previous chat titles, summaries, and bodies in requested time order", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-previous-chats-tool-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });

    const older = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id }, title: "Release foundations" });
    await persistResearchSession(projectRoot, researchChatSessionSchema.parse({
      ...older,
      summary: "Release planning started with the desktop package.",
      messages: [{ id: "older-body", role: "user", content: "The release must preserve offline startup.", createdAt: "2026-01-01T09:00:00.000Z" }],
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-01-01T10:00:00.000Z"
    }));
    const newer = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id }, title: "Packaging follow-up" });
    await persistResearchSession(projectRoot, researchChatSessionSchema.parse({
      ...newer,
      summary: "Followed up on release signing.",
      messages: [{ id: "newer-body", role: "assistant", content: "The release notarization checklist is ready.", createdAt: "2026-02-01T09:00:00.000Z" }],
      createdAt: "2026-02-01T09:00:00.000Z",
      updatedAt: "2026-02-01T10:00:00.000Z"
    }));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-previous-chats",
        name: "archicode_search_previous_chats",
        arguments: "{\"query\":\"release\",\"sort\":\"oldest\",\"maxResults\":5}"
      }]))
      .mockResolvedValueOnce(streamingChatCompletionResponse("I found the earlier release chats."));
    vi.stubGlobal("fetch", fetchMock);
    const current = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id }, title: "Current release question" });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: current.id,
      content: "Check our old chats for release decisions."
    });

    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(firstBody.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain("archicode_search_previous_chats");
    const continuationBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    const toolText = JSON.stringify(continuationBody.messages.filter((message: { role?: string }) => message.role === "tool"));
    expect(toolText).toContain("Release foundations");
    expect(toolText).toContain("offline startup");
    expect(toolText).toContain("Followed up on release signing");
    expect(toolText.indexOf("Release foundations")).toBeLessThan(toolText.indexOf("Packaging follow-up"));
    expect(toolText).not.toContain("Current release question");
    expect(answered.messages.at(-1)?.mcpToolCalls).toContainEqual(expect.objectContaining({
      toolName: "search_previous_chats",
      status: "succeeded"
    }));
  });

  it("falls back to recent previous chats when a provider reads history from a fresh chat", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-fresh-chat-history-fallback-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });

    const prior = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id }, title: "Snow White story" });
    await persistResearchSession(projectRoot, researchChatSessionSchema.parse({
      ...prior,
      summary: "The user requested a one-paragraph story about Snow White.",
      messages: [
        { id: "snow-white-request", role: "user", content: "Tell me a short story about Snow White, one paragraph.", createdAt: "2026-07-19T21:00:00.000Z" },
        { id: "snow-white-answer", role: "assistant", content: "Once upon a time, Snow White escaped into the forest.", createdAt: "2026-07-19T21:01:00.000Z" }
      ],
      updatedAt: "2026-07-19T21:01:00.000Z"
    }));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([{
        id: "call-wrong-history-tool",
        name: "archicode_read_chat_history",
        arguments: "{\"mode\":\"slice\",\"maxMessages\":8}"
      }]))
      .mockResolvedValueOnce(streamingChatCompletionResponse("The last subject was a short Snow White story."));
    vi.stubGlobal("fetch", fetchMock);
    const current = await createResearchChat({ projectRoot, scope: { type: "project", projectId: bundle.project.id }, title: "What did we discuss?" });
    const answered = await sendResearchChatMessage({
      projectRoot,
      sessionId: current.id,
      content: "What was the last thing we discussed in chat together?"
    });

    const continuationBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    const toolText = JSON.stringify(continuationBody.messages.filter((message: { role?: string }) => message.role === "tool"));
    expect(toolText).toContain("crossChatFallback");
    expect(toolText).toContain("Snow White story");
    expect(toolText).toContain("one-paragraph story about Snow White");
    expect(answered.messages.at(-1)?.content).toContain("Snow White");
  });

  it("normalizes inside-project absolute paths for built-in research file tools", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-absolute-paths-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(path.join(projectRoot, "src", "main.ts"), "export const normalizedPath = true;\n", "utf8");
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([
        { id: "call-list", name: "archicode_project_list_files", arguments: JSON.stringify({ directory: path.join(projectRoot, "src") }) },
        { id: "call-read", name: "archicode_project_read_file", arguments: JSON.stringify({ path: path.join(projectRoot, "src", "main.ts") }) }
      ]))
      .mockResolvedValueOnce(streamingChatCompletionResponse("Absolute project paths were normalized."));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Inspect files even if the tool call uses absolute paths."
    });
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    const toolMessages = secondBody.messages.filter((message: { role?: string }) => message.role === "tool");
    const listResult = JSON.parse(toolMessages.find((message: { tool_call_id?: string }) => message.tool_call_id === "call-list")?.content ?? "{}") as { directory?: string };
    const readResult = JSON.parse(toolMessages.find((message: { tool_call_id?: string }) => message.tool_call_id === "call-read")?.content ?? "{}") as { path?: string; text?: string };
    const updated = (await listResearchChats(projectRoot))[0]!;
    const statuses = updated.messages.at(-1)?.mcpToolCalls.map((call) => call.status) ?? [];

    expect(listResult.directory).toBe("src");
    expect(readResult.path).toBe("src/main.ts");
    expect(readResult.text).toContain("normalizedPath");
    expect(statuses).toEqual(["succeeded", "succeeded"]);
  });

  it("runs broad read-only CLI inspection and rejects write-capable commands", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-cli-"));
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }), "utf8");

    const version = await researchToolInspectCli(projectRoot, {
      command: "node",
      args: ["--version"]
    }) as { status: string; stdout: string };

    expect(version.status).toBe("succeeded");
    expect(version.stdout).toContain("v");
    const noGitRepo = await researchToolInspectCli(projectRoot, {
      command: "git",
      args: ["status", "--short"]
    }) as { status: string; stderr: string; note: string; exitCode: number };

    expect(noGitRepo.status).toBe("succeeded");
    expect(noGitRepo.exitCode).not.toBe(0);
    expect(noGitRepo.stderr).toBe("");
    expect(noGitRepo.note).toContain("Git repository is not initialized");
    await expect(researchToolInspectCli(projectRoot, {
      command: "git",
      args: ["reset", "--hard"]
    })).rejects.toThrow(/not allowed|allowlist/i);
    await expect(researchToolInspectCli(projectRoot, {
      command: "npm",
      args: ["install"]
    })).rejects.toThrow(/not allowed|allowlist/i);
    await expect(researchToolInspectCli(projectRoot, {
      command: "cat",
      args: ["/etc/passwd"]
    })).rejects.toThrow(/project-relative/i);
  });

  it("creates an approval request only after a direct provider attempts an Ask MCP tool", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-ask-mcp-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false }),
      mcp: {
        ...bundle.project.settings.mcp,
        servers: [{
          id: "io-github-upstash-context7",
          label: "Context7",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp@1.0.31"],
          env: [],
          headers: [],
          enabled: true,
          trusted: false,
          source: "registry",
          tools: [{
            name: "resolve-library-id",
            description: "Resolve a package to a Context7 library ID.",
            inputSchema: {
              type: "object",
              properties: { libraryName: { type: "string" } },
              required: ["libraryName"]
            }
          }],
          resources: [],
          prompts: []
        }]
      }
    });
    const context7ToolName = "mcp_io_github_upstash_context7_resolve-library-id";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionResponse("Hi. I can help."))
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([
        { id: "call-context7", name: context7ToolName, arguments: "{\"libraryName\":\"react\"}" }
      ], "", {
        reasoning: "I should consult Context7 before answering.",
        reasoning_details: [{ type: "reasoning.text", id: "reasoning-context7", text: "Consult the requested source.", index: 0 }]
      }, { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 10 } }));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    const greeting = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "hi"
    });

    expect(greeting.messages.at(-1)?.mcpApprovalRequest).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Can you use Context7 for React docs?"
    });
    const updated = (await listResearchChats(projectRoot))[0]!;
    const approvalMessage = updated.messages.at(-1);
    const mcpCall = approvalMessage?.mcpToolCalls[0];

    expect(approvalMessage?.mcpApprovalRequest).toMatchObject({
      serverIds: ["io-github-upstash-context7"],
      serverLabels: ["Context7"],
      toolName: "resolve-library-id",
      providerToolName: context7ToolName,
      argumentsJson: "{\"libraryName\":\"react\"}",
      originalContent: "Can you use Context7 for React docs?",
      internalContinuation: false
    });
    expect(approvalMessage?.usage?.reasoningReplayState).toBe("received");
    expect(JSON.stringify(approvalMessage?.mcpApprovalRequest?.providerContinuation?.messages)).toContain("I should consult Context7 before answering.");
    expect(JSON.stringify(approvalMessage?.mcpApprovalRequest?.providerContinuation?.messages)).toContain("reasoning-context7");
    expect(mcpCall).toMatchObject({
      serverId: "io-github-upstash-context7",
      serverLabel: "Context7",
      toolName: "resolve-library-id",
      status: "approval-required"
    });
    await expect(sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "mmm"
    })).rejects.toThrow("Resolve the pending MCP approval before sending another message");
  });

  it("executes approved Ask MCP tools for OpenAI-compatible research providers", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-approved-mcp-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const mcpServerPath = await createFakeContext7McpServer(projectRoot);
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.OPENAI_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "OPENAI_RESEARCH_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false }),
      mcp: {
        ...bundle.project.settings.mcp,
        servers: [{
          id: "context7",
          label: "Context7",
          transport: "stdio",
          command: process.execPath,
          args: [mcpServerPath],
          env: [],
          headers: [],
          enabled: true,
          trusted: false,
          source: "project",
          tools: [{
            name: "resolve-library-id",
            description: "Resolve a package to a Context7 library ID.",
            inputSchema: {
              type: "object",
              properties: { libraryName: { type: "string" } },
              required: ["libraryName"]
            }
          }],
          resources: [],
          prompts: []
        }]
      }
    });
    const context7ToolName = "mcp_context7_resolve-library-id";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingChatCompletionToolCallsResponse([
        { id: "call-context7", name: context7ToolName, arguments: "{\"libraryName\":\"react\"}" }
      ], "", {
        reasoning: "The user explicitly requested Context7.",
        reasoning_content: "Preserve this Kimi-compatible reasoning alias.",
        reasoning_details: [{ type: "reasoning.text", id: "reasoning-approved", text: "Use the approved tool.", index: 0 }]
      }))
      .mockResolvedValueOnce(streamingChatCompletionResponse("Context7 returned React docs."));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Use Context7 for React docs.",
      approvedMcpServerIds: ["context7"]
    });
    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    const toolMessageText = JSON.stringify(secondBody.messages.filter((message: { role?: string }) => message.role === "tool"));
    const assistantToolMessage = secondBody.messages.find((message: { role?: string; tool_calls?: unknown[] }) => message.role === "assistant" && message.tool_calls?.length);
    const updated = (await listResearchChats(projectRoot))[0]!;
    const mcpCall = updated.messages.at(-1)?.mcpToolCalls[0];

    expect(JSON.stringify(firstBody)).toContain("allow-this-message");
    expect(toolMessageText).toContain("context7 approved result for react");
    expect(assistantToolMessage.reasoning).toBe("The user explicitly requested Context7.");
    expect(assistantToolMessage.reasoning_content).toBe("Preserve this Kimi-compatible reasoning alias.");
    expect(assistantToolMessage.reasoning_details).toEqual([{ type: "reasoning.text", id: "reasoning-approved", text: "Use the approved tool.", index: 0 }]);
    expect(mcpCall).toMatchObject({
      serverId: "context7",
      serverLabel: "Context7",
      toolName: "resolve-library-id",
      status: "succeeded"
    });
  });

  it("executes approved Ask MCP tools for Anthropic-compatible research providers", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-anthropic-mcp-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const mcpServerPath = await createFakeContext7McpServer(projectRoot);
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.ANTHROPIC_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "anthropic-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ANTHROPIC_RESEARCH_TEST_KEY" }
        : { ...provider, enabled: false }),
      mcp: {
        ...bundle.project.settings.mcp,
        servers: [{
          id: "context7",
          label: "Context7",
          transport: "stdio",
          command: process.execPath,
          args: [mcpServerPath],
          env: [],
          headers: [],
          enabled: true,
          trusted: false,
          source: "project",
          tools: [{
            name: "resolve-library-id",
            description: "Resolve a package to a Context7 library ID.",
            inputSchema: {
              type: "object",
              properties: { libraryName: { type: "string" } },
              required: ["libraryName"]
            }
          }],
          resources: [],
          prompts: []
        }]
      }
    });
    const context7ToolName = "mcp_context7_resolve-library-id";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicResponse([
        { type: "thinking", thinking: "I should use the approved documentation source.", signature: "sig-approved-context7" },
        { type: "redacted_thinking", data: "encrypted-approved-context7" },
        { type: "tool_use", id: "toolu-context7", name: context7ToolName, input: { libraryName: "react" } }
      ]))
      .mockResolvedValueOnce(streamingAnthropicResponse([
        { type: "text", text: "Context7 returned React docs." }
      ]));
    vi.stubGlobal("fetch", fetchMock);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: "project-seed" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Use Context7 for React docs.",
      approvedMcpServerIds: ["context7"]
    });
    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    const assistantToolMessage = secondBody.messages.find((message: { role?: string; content?: Array<{ type?: string }> }) =>
      message.role === "assistant" && message.content?.some((block) => block.type === "tool_use"));
    const updated = (await listResearchChats(projectRoot))[0]!;
    const mcpCall = updated.messages.at(-1)?.mcpToolCalls[0];

    expect(JSON.stringify(firstBody)).toContain(context7ToolName);
    expect(JSON.stringify(firstBody)).toContain("allow-this-message");
    expect(JSON.stringify(secondBody.messages)).toContain("context7 approved result for react");
    expect(assistantToolMessage.content).toEqual([
      { type: "thinking", thinking: "I should use the approved documentation source.", signature: "sig-approved-context7" },
      { type: "redacted_thinking", data: "encrypted-approved-context7" },
      { type: "tool_use", id: "toolu-context7", name: context7ToolName, input: { libraryName: "react" } }
    ]);
    expect(updated.messages.at(-1)?.usage?.reasoningReplayState).toBe("mixed");
    expect(mcpCall).toMatchObject({
      serverId: "context7",
      serverLabel: "Context7",
      toolName: "resolve-library-id",
      status: "succeeded"
    });
  });

  it("resumes an approved MCP tool from persisted state without re-generating the pre-approval turn", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-resume-mcp-"));
    setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-research-storage-")));
    const mcpServerPath = await createFakeContext7McpServer(projectRoot);
    const bundle = await ensureFixtureProject(projectRoot);
    process.env.ANTHROPIC_RESEARCH_TEST_KEY = "test";
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      webSearch: { ...bundle.project.settings.webSearch, enabled: false },
      providers: bundle.project.settings.providers.map((provider) => provider.kind === "anthropic-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ANTHROPIC_RESEARCH_TEST_KEY" }
        : { ...provider, enabled: false }),
      mcp: {
        ...bundle.project.settings.mcp,
        servers: [{
          id: "context7",
          label: "Context7",
          transport: "stdio",
          command: process.execPath,
          args: [mcpServerPath],
          env: [],
          headers: [],
          enabled: true,
          trusted: false,
          source: "project",
          tools: [{
            name: "resolve-library-id",
            description: "Resolve a package to a Context7 library ID.",
            inputSchema: { type: "object", properties: { libraryName: { type: "string" } }, required: ["libraryName"] }
          }],
          resources: [],
          prompts: []
        }]
      }
    });
    const context7ToolName = "mcp_context7_resolve-library-id";
    const fetchMock = vi.fn()
      // Turn 1: model reasons in prose, then calls the untrusted tool -> approval.
      .mockResolvedValueOnce(streamingAnthropicResponse([
        { type: "thinking", thinking: "The user requested Context7 and this action needs approval.", signature: "sig-context7-approval" },
        { type: "text", text: "Let me look that up in Context7." },
        { type: "tool_use", id: "toolu-context7", name: context7ToolName, input: { libraryName: "react" } }
      ]))
      // Turn 2 (resume): the continuation produces the final answer.
      .mockResolvedValue(streamingAnthropicResponse([
        { type: "text", text: "Based on the docs, use hooks." }
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-seed" } });

    await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Use Context7 for React docs." });
    const afterApproval = (await listResearchChats(projectRoot))[0]!;
    const approvalMessage = afterApproval.messages.at(-1)!;
    // The approval persisted provider continuation state, including the streamed assistant turn.
    const continuation = approvalMessage.mcpApprovalRequest?.providerContinuation;
    expect(continuation?.transport).toBe("anthropic");
    expect(continuation?.pendingToolCall.providerToolName).toBe(context7ToolName);
    expect(JSON.stringify(continuation?.messages)).toContain("Let me look that up in Context7.");
    expect(JSON.stringify(continuation?.messages)).toContain("The user requested Context7 and this action needs approval.");
    expect(JSON.stringify(continuation?.messages)).toContain("sig-context7-approval");
    expect(JSON.stringify(continuation?.messages)).toContain("toolu-context7");

    const resumeCalls = fetchMock.mock.calls.length;
    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Use Context7 for React docs.",
      resumeApprovalMessageId: approvalMessage.id,
      approvedMcpServerIds: ["context7"]
    });

    // The resume request continues the exchange: it carries the persisted
    // assistant tool_use turn plus the approved tool result, rather than
    // re-generating from scratch.
    const resumeBody = JSON.parse(fetchMock.mock.calls[resumeCalls]![1]!.body as string);
    const resumeMessages = JSON.stringify(resumeBody.messages);
    expect(resumeMessages).toContain("Let me look that up in Context7.");
    expect(resumeMessages).toContain("toolu-context7");
    expect(resumeMessages).toContain("context7 approved result for react");

    const resolved = (await listResearchChats(projectRoot))[0]!;
    expect(resolved.messages.some((message) => message.content.includes("Based on the docs, use hooks."))).toBe(true);
    expect(resolved.messages.at(-1)?.mcpApprovalRequest).toBeUndefined();
  });

  it("requires a fresh exact approval for every Research chat rule mutation", async () => {
    const createArgs = {
      action: "create",
      rule: {
        title: "Canvas nodes require descriptions",
        body: "Describe the node responsibility before implementation.",
        kind: "policy",
        severity: "warning",
        enforcement: "advisory",
        constraint: { kind: "required-node-metadata", scope: "attached", field: "description" }
      },
      attachTo: [{ flowId: "flow-main", nodeId: "node-canvas" }]
    };
    const createArgumentsJson = JSON.stringify(createArgs);
    const ruleId = `rule-chat-${createHash("sha256").update(createArgumentsJson).digest("hex").slice(0, 16)}`;
    const updateArgs = {
      action: "update",
      ruleId,
      patch: { body: "Describe the node responsibility and boundaries before implementation." }
    };
    const { projectRoot } = await setupProject([
      localResearchSinkTurn("I prepared the rule change for approval.", [{
        providerToolName: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
        arguments: createArgs
      }]),
      localResearchSinkTurn("The approved rule is now active.", [
        memorySink({ summary: "Created an approved deterministic node-description policy." })
      ]),
      localResearchSinkTurn("I prepared the follow-up edit for approval.", [{
        providerToolName: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
        arguments: updateArgs
      }])
    ]);
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-seed" } });

    await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Create that live policy." });
    const pending = (await listResearchChats(projectRoot))[0]!.messages.at(-1)!;

    expect(pending.content).toContain("Nothing has been changed yet");
    expect(pending.mcpApprovalRequest).toMatchObject({
      serverIds: [ARCHICODE_RESEARCH_RULES_SERVER_ID],
      serverLabels: ["ArchiCode Rules"],
      toolName: "manage_rules",
      providerToolName: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
      argumentsJson: createArgumentsJson
    });
    expect((await loadProject(projectRoot)).project.settings.nodeRules ?? []).toHaveLength(0);

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: pending.mcpApprovalRequest!.originalContent,
      resumeApprovalMessageId: pending.id,
      approvedMcpServerIds: [ARCHICODE_RESEARCH_RULES_SERVER_ID]
    });
    const applied = await loadProject(projectRoot);
    expect(applied.project.settings.nodeRules?.find((rule) => rule.id === ruleId)?.title).toBe("Canvas nodes require descriptions");
    expect(applied.flows[0]?.nodes.find((node) => node.id === "node-canvas")?.ruleIds).toContain(ruleId);
    expect((await listResearchChats(projectRoot))[0]!.messages.at(-1)?.mcpApprovalRequest).toBeUndefined();

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Also clarify the policy boundaries.",
      // Even if a client accidentally carries this id forward, rule approval is
      // exact and one-shot rather than server trust that can be remembered.
      approvedMcpServerIds: [ARCHICODE_RESEARCH_RULES_SERVER_ID]
    });
    const secondPending = (await listResearchChats(projectRoot))[0]!.messages.at(-1)!;
    expect(secondPending.mcpApprovalRequest).toMatchObject({
      serverIds: [ARCHICODE_RESEARCH_RULES_SERVER_ID],
      providerToolName: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
      argumentsJson: JSON.stringify(updateArgs)
    });
    expect((await loadProject(projectRoot)).project.settings.nodeRules?.find((rule) => rule.id === ruleId)?.body)
      .toBe("Describe the node responsibility before implementation.");
  });

  it("does not execute a rejected Research chat rule mutation", async () => {
    const createArgs = {
      action: "create",
      rule: { title: "Rejected guidance", body: "This should not persist.", kind: "guidance" }
    };
    const { projectRoot } = await setupProject([
      localResearchSinkTurn("I prepared the guidance rule for approval.", [{
        providerToolName: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
        arguments: createArgs
      }]),
      localResearchSinkTurn("Understood. I did not create the rule.", [memoryUnchangedSink("The proposed rule was rejected and no project state changed.")])
    ]);
    const session = await createResearchChat({ projectRoot, scope: { type: "project", projectId: "project-seed" } });

    await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Create this guidance rule." });
    const pending = (await listResearchChats(projectRoot))[0]!.messages.at(-1)!;
    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: pending.mcpApprovalRequest!.originalContent,
      resumeApprovalMessageId: pending.id,
      rejectedMcpServerIds: [ARCHICODE_RESEARCH_RULES_SERVER_ID]
    });

    expect((await loadProject(projectRoot)).project.settings.nodeRules ?? []).toHaveLength(0);
    expect((await listResearchChats(projectRoot))[0]!.messages.at(-1)?.mcpApprovalRequest).toBeUndefined();
  });

  it("rejects research deletion of locked approved nodes", async () => {
    const { projectRoot } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "I can delete that node if approved.",
        summary: "Delete proposal.",
        changeSet: {
          summary: "Delete approved node",
          operations: [
            { kind: "delete-node", flowId: "flow-main", nodeId: "node-approved-contract" }
          ]
        }
      }
    }));
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "flow", flowId: "flow-main" }
    });
    const answered = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Delete the approved node." });
    const assistant = answered.messages.find((message) => message.role === "assistant");

    const result = await applyResearchGraphChangeSet({
      projectRoot,
      sessionId: answered.id,
      messageId: assistant!.id,
      changeSetId: assistant!.changeSet!.id,
      decisions: [{ operationIndex: 0, decision: "accepted" }]
    });
    const nodeStillExists = (await loadProject(projectRoot)).flows[0]?.nodes.some((node) => node.id === "node-approved-contract");

    expect(result.results[0]?.status).toBe("failed");
    expect(result.results[0]?.message).toMatch(/approved and locked/);
    expect(nodeStillExists).toBe(true);
  });

  it("directly fetches user-provided web links into research context", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <html>
        <head><title>Pixel Hat | Product-Focused Software</title></head>
        <body>
          <h1>Welcome to Pixel Hat</h1>
          <p>Pixel Hat builds thoughtful software products and focused digital experiences.</p>
          <a href="https://avoid.pixel-hat.com/">Avoid: Break Bad Habits</a>
        </body>
      </html>
    `, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    })));
    const { projectRoot, promptPath } = await setupProject(JSON.stringify({
      archicodeResearch: {
        answer: "Pixel Hat is a product-focused software studio.",
        summary: "Checked Pixel Hat."
      }
    }), true);
    const session = await createResearchChat({
      projectRoot,
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" }
    });

    await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Can you check pixel-hat.com?"
    });
    const prompt = await readFile(promptPath!, "utf8");

    expect(prompt).toContain("fetchedWebPages");
    expect(prompt).toContain("https://pixel-hat.com/");
    expect(prompt).toContain("Welcome to Pixel Hat");
    expect(prompt).toContain("Avoid: Break Bad Habits");
  });
});
