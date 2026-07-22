import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultPhaseModelPolicies, researchGraphOperationKinds, type LlmPhase, type LlmUsage, type McpServer, type ModelCapabilityProfile, type PhaseModelPolicy, type ProjectSettings, type ResearchChatMessage } from "../shared/schema";
import { estimateTextTokens, knownContextWindowFloorTokensForModel } from "../shared/contextBudget";
import { gaiaAgent, pandoraAgent } from "../shared/agentIdentities";
import { computeUsageCostDetails, mergeReasoningReplayStates } from "../shared/llmPricing";
export { createConsecutiveToolCallLoopDetector } from "./agentRuntime";
import type { AgentTurnDiagnostics } from "./agentRuntime";
export type { AgentTurnDiagnostics } from "./agentRuntime";
import { heuristicImageInputSupportStatus, providerModelOutputTokenLimit, providerSupportsImageInput } from "../shared/providerCapabilities";
import type { GlobalResearchVerbosity } from "../shared/researchPersonality";
import { extractTextDocument } from "./documentText";
import type { ProviderMcpTool } from "./mcp";
import {
  callClaudeLocal,
  callClaudeLocalResearch,
  callCodexLocal,
  callCodexLocalResearch,
  callOpenCodeLocal,
  callOpenCodeLocalResearch,
  callAntigravityLocal,
  callAntigravityLocalResearch,
  callGrokLocal,
  callGrokLocalResearch,
  callKimiLocal,
  callKimiLocalResearch,
  checkClaudeLocal,
  checkCodexLocal,
  checkOpenCodeLocal,
  checkAntigravityLocal,
  checkGrokLocal,
  checkKimiLocal,
  isClaudeLocalProvider,
  isCodexLocalProvider,
  isOpenCodeLocalProvider,
  isAntigravityLocalProvider,
  isGrokLocalProvider,
  isKimiLocalProvider
} from "./providers/localCli";

import {
  anthropicMcpTools,
  callOpenAICompatible,
  callOpenAIResearch,
  checkOpenAICompatible
} from "./providers/openai";
import {
  callAnthropicCompatible,
  callAnthropicResearch,
  checkAnthropicCompatible
} from "./providers/anthropic";




export type Provider = ProjectSettings["providers"][number];

// Raw token counts extracted from one provider response, before aggregation.
// `inputTokens` is the *non-cached* billable input (cache hits are split out).
export type RawLlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningReplayState?: "received" | "absent";
};

// Accumulates raw usage across a call's tool-loop iterations / thinking retries
// and finalizes it into a persisted LlmUsage (with computed USD cost).
export function createUsageAccumulator(): {
  add: (raw: RawLlmUsage) => void;
  finalize: (provider: Provider, modelId: string) => LlmUsage;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  const reasoningReplayStates: Array<RawLlmUsage["reasoningReplayState"]> = [];
  let calls = 0;
  return {
    add(raw) {
      inputTokens += raw.inputTokens ?? 0;
      outputTokens += raw.outputTokens ?? 0;
      thinkingTokens += raw.thinkingTokens ?? 0;
      cacheReadTokens += raw.cacheReadTokens ?? 0;
      cacheCreationTokens += raw.cacheCreationTokens ?? 0;
      reasoningReplayStates.push(raw.reasoningReplayState);
      calls += 1;
    },
    finalize(provider, modelId) {
      const usage: LlmUsage = {
        providerId: provider.id,
        modelId,
        inputTokens,
        outputTokens,
        thinkingTokens: thinkingTokens || undefined,
        cacheReadTokens: cacheReadTokens || undefined,
        cacheCreationTokens: cacheCreationTokens || undefined,
        reasoningReplayState: mergeReasoningReplayStates(reasoningReplayStates),
        calls: Math.max(1, calls)
      };
      const cost = computeUsageCostDetails(usage, provider);
      usage.costUsd = cost.costUsd;
      if (cost.estimated) usage.estimated = true;
      return usage;
    }
  };
}

export function resolveModelId(provider: Provider, policy: PhaseModelPolicy): string {
  return policy.modelOverride?.trim() || provider.model?.trim() || provider.kind;
}

export function emitUnavailableUsage(provider: Provider, policy: PhaseModelPolicy, onUsage?: (usage: LlmUsage) => void): void {
  if (!onUsage) return;
  onUsage({
    providerId: provider.id,
    modelId: resolveModelId(provider, policy),
    inputTokens: 0,
    outputTokens: 0,
    calls: 1,
    unavailable: true
  });
}

export type ProviderCallOptions = {
  projectRoot?: string;
  webSearchEnabled?: boolean;
  phase?: LlmPhase;
  signal?: AbortSignal;
  onProgress?: (event: ProviderProgressEvent) => void;
  imageAttachments?: ProviderImageAttachment[];
  textAttachments?: ProviderTextAttachment[];
  selectedSkillsPrompt?: string;
  mcpTools?: ProviderMcpTool[];
  mcpServers?: McpServer[];
  callMcpTool?: (input: { providerToolName: string; argumentsJson: string }) => Promise<string>;
  /**
   * Coding/debugging providers can submit source files as independent tool
   * calls instead of embedding every file inside one large JSON string.
   */
  structuredSourceHandoff?: boolean;
  /** Mark a provider response's tool boundary before any call in it executes. */
  prepareToolBatch?: (calls: Array<{ providerToolName: string; argumentsJson: string }>) => void;
  /**
   * Allows a caller-owned sink-tool batch to finish the provider turn without
   * another LLM round-trip. Returning false feeds the tool receipts back to
   * the model so it can repair only the rejected calls.
   */
  shouldCompleteToolBatch?: (calls: ProviderExecutedToolCall[]) => boolean;
  // Focused structured-extraction mode: bypass the orchestrator/phase agent
  // framing (which pushes the model toward plans, questions, and archicodePatch
  // envelopes) and send only a minimal "return exactly what the task asks"
  // instruction plus the task prompt. Use for one-shot JSON extraction tasks.
  bareExtraction?: boolean;
  // Receives the aggregated LLM token usage + computed USD cost for this call
  // (one invocation per top-level callProvider, covering its tool loop/retries).
  onUsage?: (usage: LlmUsage) => void;
  /**
   * Stable id for the logical work unit (run id, research session id). Sent to
   * OpenRouter as `session_id` so every request in the unit routes to the same
   * upstream provider, keeping the prompt cache warm from the first request.
   */
  cacheSessionId?: string;
};

export type ProviderExecutedToolCall = {
  providerToolName: string;
  argumentsJson: string;
  result: string;
};

// Minimal system framing for bareExtraction calls — no ArchiCode agent identity,
// no phase, no patch/question contracts. Just "do the task, return only output".
export const extractionSystemPrompt = [
  "You are a precise data-extraction function embedded in a larger application.",
  "Follow the task described in the input exactly and return only the requested output.",
  "Do not add explanations, preamble, questions, plans, or any wrapper envelope. Do not ask for approval or clarification.",
  "If the task asks for JSON, return only that JSON with no surrounding prose or markdown fences."
].join("\n");

export type ProviderImageAttachment = {
  title: string;
  path: string;
  mediaType: string;
  source?: "message" | "context";
  sourceLabel?: string;
};

export type ProviderTextAttachment = {
  title: string;
  path: string;
  mediaType: string;
  source?: "message" | "context";
  sourceLabel?: string;
};

export type ProviderTokenKind = "answer" | "thinking";

export type ResearchProviderOptions = {
  projectRoot?: string;
  webSearchEnabled?: boolean;
  signal?: AbortSignal;
  scopeContext: string;
  sessionSummary?: string;
  researchMemory?: string;
  researchOrchestration?: string;
  currentTurnDirective?: string;
  researchPersonalityPrompt?: string;
  researchVerbosity?: GlobalResearchVerbosity;
  /**
   * Isolated micro-runs (Sherlock/Picasso/Solomon/etc.) supply their own
   * highest-priority identity and output contract. When present, do not mix
   * the parent Archi Research-chat contract into the subagent session.
   */
  systemInstructionsOverride?: string;
  /**
   * When true, the provider is advertised the native sink tools
   * (propose_graph_change_set / update_memory), so the system prompt instructs
   * it to deliver structured output via tools instead of embedding JSON.
   */
  researchStructuredToolsEnabled?: boolean;
  /** Whether spawn_merge_resolution_agent is in the advertised tool list for this turn. */
  mergeResolutionSubagentEnabled?: boolean;
  /** Whether spawn_graph_reconciliation_agent is in the advertised tool list for this turn. */
  graphReconciliationSubagentEnabled?: boolean;
  /** Whether spawn_sherlock is in the advertised tool list for this turn. */
  sherlockResearchSubagentEnabled?: boolean;
  /** Whether spawn_delphi is in the advertised tool list for this turn. */
  delphiTestingSubagentEnabled?: boolean;
  messages: ResearchChatMessage[];
  researchMessageLimit?: number;
  researchHistoryTokenBudget?: number;
  imageAttachments?: ProviderImageAttachment[];
  textAttachments?: ProviderTextAttachment[];
  selectedSkillsPrompt?: string;
  onToken?: (text: string, kind?: ProviderTokenKind) => void;
  /** Clears the visible stream before a later local tool-loop iteration starts. */
  onTokenReset?: () => void;
  mcpTools?: ProviderMcpTool[];
  mcpServers?: McpServer[];
  callMcpTool?: (input: { providerToolName: string; argumentsJson: string }) => Promise<string>;
  /**
   * Optional caller-owned final-answer contract. A returned error is appended
   * to the same provider transcript so the agent can repair its own trajectory.
   */
  validateFinalAnswer?: (text: string) => string | undefined | Promise<string | undefined>;
  /** Reports a shared-runtime retry of the current provider turn after a transport-only failure. */
  onTransientRetry?: (error: unknown) => void;
  /** Reports host-counted turn work (rounds/rerolls/transient retries) once, for diagnostics/exports. */
  onTurnDiagnostics?: (diagnostics: AgentTurnDiagnostics) => void;
  /**
   * "Sink" tools (e.g. propose_graph_change_set / update_memory) whose only job
   * is to hand structured output back to the caller. When a model turn calls
   * only terminal tools (no external tools that need a result fed back), the
   * loop captures them and returns that turn's prose as the final answer
   * without spending another round-trip.
   */
  isTerminalTool?: (providerToolName: string) => boolean;
  /** A terminal sink whose successful tool call is itself a complete result, even when the model emitted no prose. */
  terminalToolCompletesTurn?: (providerToolName: string) => boolean;
  /** Recognizes the caller's MCP-approval-required error so the loop can persist continuation state. */
  isApprovalError?: (error: unknown) => boolean;
  /** When set, resume an approved tool mid-exchange instead of re-generating the pre-approval work. */
  resumeContinuation?: ResearchProviderContinuation & { approvedResult: string };
  // Receives the aggregated LLM token usage + computed USD cost for this turn
  // (one invocation per top-level callResearchProvider, covering its tool loop).
  onUsage?: (usage: LlmUsage) => void;
  /**
   * Stable id for the logical work unit (research session id). Sent to
   * OpenRouter as `session_id` so every request in the unit routes to the same
   * upstream provider, keeping the prompt cache warm from the first request.
   */
  cacheSessionId?: string;
};

export type ResearchProviderContinuation = {
  transport: "anthropic" | "openai-chat" | "openai-responses" | "codex-local" | "claude-local" | "opencode-local" | "antigravity-local" | "grok-local" | "kimi-local";
  messages?: unknown[];
  previousResponseId?: string;
  pendingToolCall: { id: string; providerToolName: string; argumentsJson: string };
};

export type ProviderHealthResult = {
  providerId: string;
  ok: boolean;
  status: "ready" | "missing-key" | "failed";
  checkedAt: string;
  message: string;
  detectedContextWindowTokens?: number;
  contextWindowSource?: string;
  availableModels?: string[];
  detectedModelCapabilities?: ProjectSettings["providers"][number]["detectedModelCapabilities"];
  modelListSource?: string;
  detectedOpenAiEndpointMode?: "responses" | "chat-completions";
};

export type ProviderProgressEvent = {
  stream: "stdout" | "stderr" | "system";
  text: string;
};

function looksLikeEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function resolveProviderApiKey(provider: Provider): string | undefined {
  const direct = provider.apiKey?.trim();
  if (direct) return direct;
  const legacyValue = provider.apiKeyEnv?.trim();
  if (!legacyValue) return undefined;
  if (!looksLikeEnvironmentVariableName(legacyValue)) return legacyValue;
  return process.env[legacyValue];
}

/**
 * OpenRouter-only sticky routing: sending `session_id` makes OpenRouter route
 * every request carrying the same id to the same upstream provider (with
 * fallback still available), so prompt caches stay warm from the first request
 * of a run/session. Gated on the OpenRouter host because other
 * OpenAI-compatible servers may reject unknown body fields.
 */
export function isOpenRouterProvider(provider: Provider): boolean {
  let host: string;
  try {
    host = new URL(provider.baseUrl ?? "").hostname;
  } catch {
    return false;
  }
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

export function applyOpenRouterSessionId(body: Record<string, unknown>, provider: Provider, cacheSessionId: string | undefined): void {
  const id = cacheSessionId?.trim();
  if (!id || !isOpenRouterProvider(provider)) return;
  body.session_id = id.slice(0, 256);
}

export async function callProvider(provider: Provider, contextText: string, promptSummary: string, options: ProviderCallOptions = {}): Promise<string> {
  const phase = options.phase ?? "planning";
  const policy = resolvePhaseModelPolicy(provider, phase);
  if (provider.kind === "offline-manual") {
    return [
      "Offline/manual provider selected.",
      "ArchiCode prepared the JSON context and persisted this run for human review.",
      `Phase: ${phase}.`,
      `Prompt summary: ${promptSummary}`
    ].join("\n");
  }

  if (isCodexLocalProvider(provider)) {
    return callCodexLocal(provider, contextText, promptSummary, { ...options, phase }, policy);
  }
  if (isClaudeLocalProvider(provider)) {
    return callClaudeLocal(provider, contextText, promptSummary, { ...options, phase }, policy);
  }
  if (isOpenCodeLocalProvider(provider)) {
    return callOpenCodeLocal(provider, contextText, promptSummary, { ...options, phase }, policy);
  }
  if (isAntigravityLocalProvider(provider)) {
    return callAntigravityLocal(provider, contextText, promptSummary, { ...options, phase }, policy);
  }
  if (isGrokLocalProvider(provider)) {
    return callGrokLocal(provider, contextText, promptSummary, { ...options, phase }, policy);
  }
  if (isKimiLocalProvider(provider)) {
    return callKimiLocal(provider, contextText, promptSummary, { ...options, phase }, policy);
  }

  const apiKey = resolveProviderApiKey(provider);
  if (!apiKey) {
    throw new Error(`Provider ${provider.label} requires an API key.`);
  }

  if (provider.kind === "openai-compatible") {
    return callOpenAICompatible(provider, apiKey, contextText, promptSummary, options.webSearchEnabled ?? false, phase, policy, options);
  }

  return callAnthropicCompatible(provider, apiKey, contextText, promptSummary, options.webSearchEnabled ?? false, phase, policy, options);
}

export async function callResearchProvider(provider: Provider, userMessage: string, options: ResearchProviderOptions): Promise<string> {
  const policy = resolvePhaseModelPolicy(provider, "brainstorming");
  if (provider.kind === "offline-manual") {
    return JSON.stringify({
      archicodeResearch: {
        answer: [
          "Offline/manual provider selected.",
          "ArchiCode prepared scoped research context, but no LLM provider is available to answer this chat."
        ].join("\n"),
        summary: options.sessionSummary ?? ""
      }
    });
  }

  if (isCodexLocalProvider(provider)) {
    return callCodexLocalResearch(provider, userMessage, options, policy);
  }
  if (isClaudeLocalProvider(provider)) {
    return callClaudeLocalResearch(provider, userMessage, options, policy);
  }
  if (isOpenCodeLocalProvider(provider)) {
    return callOpenCodeLocalResearch(provider, userMessage, options, policy);
  }
  if (isAntigravityLocalProvider(provider)) {
    return callAntigravityLocalResearch(provider, userMessage, options, policy);
  }
  if (isGrokLocalProvider(provider)) {
    return callGrokLocalResearch(provider, userMessage, options, policy);
  }
  if (isKimiLocalProvider(provider)) {
    return callKimiLocalResearch(provider, userMessage, options, policy);
  }

  const apiKey = resolveProviderApiKey(provider);
  if (!apiKey) {
    throw new Error(`Provider ${provider.label} requires an API key.`);
  }

  if (provider.kind === "openai-compatible") {
    return callOpenAIResearch(provider, apiKey, userMessage, options, policy);
  }

  return callAnthropicResearch(provider, apiKey, userMessage, options, policy);
}

const researchDurableMemoryPolicy = [
  "HOST-OWNED CONTINUITY:",
  "ArchiCode folds conversation summary, approvals, tool results, subagent outcomes, and goal progress from persisted host events. Do not call tools merely to update memory or goal state, do not narrate bookkeeping, and do not delay the user's answer for a memory decision."
].join("\n");

const researchGraphDelegationPolicy = [
  "GRAPH WORK DELEGATION:",
  "Archi may prepare graph operations directly only for a simple, quick, tightly bounded edit whose correct shape is already obvious and requires no architecture or design synthesis—for example one small rename, one short metadata correction, one note lifecycle change, one unambiguous node move, or one simple existing-node relationship.",
  "Any substantial graph work requires Picasso. This includes creating or restructuring flows, decomposing a feature into multiple nodes, creating populated subflows, coordinating changes across several nodes or flows, deriving a graph from an attachment/specification, designing acceptance criteria and relationships together, or any broad architecture, refinement, reconciliation, or multi-operation pass. These examples describe semantic complexity; they are not keyword triggers.",
  "For substantial graph edits, Archi must inspect enough to describe the exact coherent scope and obtain the one required user confirmation. After the model understands that the user confirmed, it MUST call spawn_picasso in that same next turn. It must not construct or submit the complex change set directly.",
  "If Picasso is unavailable or disabled, do not bypass this boundary with a direct complex change set; explain that the required graph architect is unavailable.",
  "Never say that graph work is queued, being prepared, underway, completed, or ready for review unless the corresponding tool was actually called in the same turn and returned that result."
].join("\n");

const researchToolDeliveryDirective = [
  "STRUCTURED OUTPUT OVERRIDE (this provider supports tools):",
  "Put your visible chat answer in normal prose. Do NOT embed archicodeResearch, changeSet, or memory JSON in your prose or in fenced code blocks.",
  "For a confirmed simple graph edit, deliver the change set by calling archicode_propose_graph_change_set with { summary, operations } instead of writing JSON. For confirmed substantial graph work, call spawn_picasso; direct complex change-set submission is not allowed.",
  "When the user explicitly asks you to select/focus nodes or groups, switch the visible canvas flow/detail flow, pan, center, or zoom, you MUST call archicode_control_canvas with the reversible UI action in that same response. Prose cannot manipulate the canvas: never say the action is happening, incoming, or will happen unless you make the tool call. Do not call it merely because you mention or inspect a graph item.",
  researchDurableMemoryPolicy,
  researchGraphDelegationPolicy,
  "The archicodeResearch canvasAction/changeSet and researchMemoryDelta JSON contracts below describe the FIELD SHAPES to pass as those tools' arguments; they are not instructions to print JSON."
].join("\n");

function researchSubagentDirective(options: ResearchProviderOptions): string {
  if (!options.mergeResolutionSubagentEnabled && !options.graphReconciliationSubagentEnabled && !options.sherlockResearchSubagentEnabled && !options.delphiTestingSubagentEnabled) return "";
  const reconciliationEnabled = Boolean(options.graphReconciliationSubagentEnabled);
  return [
    options.sherlockResearchSubagentEnabled
      ? "Use spawn_sherlock for substantial codebase, online, or topic investigation that would otherwise fill this chat's context with a long research trail. A codebase security review or audit is substantial research and belongs to Sherlock unless the user explicitly asks Archi to perform it directly. Give Sherlock a bounded objective and the correct research mode, then use its compact evidence dossier; Sherlock is read-only and runs immediately. When Sherlock returns a valid evidence dossier, synthesize it and perform only targeted verification needed to answer—do not repeat the entire investigation. If Sherlock fails or reports a genuine evidence blocker, say that you are taking over before using the parent tools for a fallback investigation."
      : "",
    options.delphiTestingSubagentEnabled
      ? "Use spawn_delphi when the user asks Archi to run, retest, visually audit, or runtime-audit a project. Give Delphi the goal, relevant scope, platforms, acceptance criteria, target context, and an explicit visualInspection value; do not prescribe its command sequence or tool order. Set visualInspection to pixel only when the user requested model inspection of appearance/layout, capture for human-review screenshots, and none otherwise. Never leave that decision to objective wording. Read the host-provided DELPHI MODEL PREFLIGHT before promising visual inspection. Preserve any page, route, screen, or flow the user named. Default to visible observation so the user can watch supported targets. Set target.launch to if-needed when Delphi should start an existing Run App profile; the approval card grants a bounded verification/runtime capability and lists target lifecycle. Delphi chooses purposeful evidence within ceilings. Missing supported adapters are offered for approval in ArchiCode's isolated managed cache and the same audit resumes. Do not claim tests ran until Delphi returns. Project dependency installation and source edits are never implicit."
      : "",
    reconciliationEnabled
      ? `${researchGraphDelegationPolicy}\nFor read-only substantial graph analysis with no edits requested, call Picasso with mode assess; no graph-edit confirmation is needed and no change set is expected. For graph edits, preserve the graph-edit confirmation gate: first inspect enough to describe the concrete, coherent scope, then end the visible response with a direct question asking whether the user wants that exact scope prepared as a review card. A request to propose a concrete graph update is still a graph-edit scope-confirmation request, not open-ended brainstorming. Do not finish that turn by merely promising future inspection: perform the needed inspection with tools during the same turn, then present the scope and ask the direct confirmation question. Do not invoke Picasso or produce a graph change set before that confirmation. After the user confirms, invoke spawn_picasso in that next turn and let its graphChangeSet become the normal review card without asking again. Picasso's graph changes are proposal-only and are not applied automatically. An explicit request to use Picasso does not itself replace confirmation of a previously described concrete edit scope. If Sherlock already investigated the topic, pass only its compact evidence summary to Picasso.`
      : "",
    reconciliationEnabled
      ? "Be truthful about Picasso execution. Never say or imply that you will use Picasso, are using Picasso, started a dedicated graph-design pass, or that Picasso is working or completed unless you actually call spawn_picasso in that turn. If you are still inspecting or waiting for scope confirmation, describe that as Archi's own work and explicitly ask the user for the required confirmation instead of ending passively."
      : "",
    options.mergeResolutionSubagentEnabled
      ? "EXCEPTION: When the user explicitly requests help with git merge conflicts, you may spawn Solomon, the merge resolution subagent, using spawn_merge_resolution_agent. This is the ONLY subagent that may edit code from research."
      : "",
    options.mergeResolutionSubagentEnabled
      ? "Calling spawn_merge_resolution_agent does NOT resolve anything immediately: it only creates a proposal card in the chat UI that the user must explicitly approve (optionally editing the resolution strategy) before anything runs, because it writes real repo files. Treat the proposal as pending, not as success."
      : "",
    options.mergeResolutionSubagentEnabled
      ? `When handling merge conflicts: identify conflicted files, propose a strategy when needed, and call spawn_merge_resolution_agent once.${reconciliationEnabled ? " Picasso reconciliation runs automatically after an approved Solomon run succeeds." : " Graph reconciliation is disabled for this project."}`
      : "",
    reconciliationEnabled
      ? "When Picasso returns a graphChangeSet, ArchiCode automatically turns it into a review card. Do not re-propose it yourself and do not claim it was applied."
      : "",
    "Either subagent's result may include an \"unresolvedClarifications\" field: the subagent had an ambiguous decision to make, could not ask you live, and proceeded on its own best judgment. Always surface any unresolvedClarifications to the user verbatim, explain what assumption was made, and invite them to re-run with more guidance (e.g. a resolutionStrategy) if the assumption looks wrong."
  ].filter(Boolean).join("\n");
}

export function researchResponseStyleDirective(verbosity: GlobalResearchVerbosity = "default"): string {
  if (verbosity !== "chatty") return "";
  return [
    "Per-turn response-style requirement: Important Research chat response style: be warm, welcoming, chatty & verbose in every response; never default to terse or short introverted answers.",
    "This applies to every chat message, including greetings, acknowledgements, straightforward questions, follow-ups, familiar topics, and complex research answers.",
    "Give complete, rich, inquisitive and useful responses and explanations, including relevant reasoning, context, caveats, examples, and actionable details.",
    "Provide a detailed, conversational, and warm explanation.",
    "Expand on your reasoning and give examples for each point.",
    "This requirement overrides any general instruction to be concise.",
    "Never collapse a response into one or two sentences. Provide several developed paragraphs or a clearly structured explanation without padding it with empty filler.",
    "This chatty style applies ONLY to your single final answer to the user. While you are still calling tools to gather context, stay silent: do not greet, re-introduce yourself, narrate what you are about to do, or emit any prose between tool calls. Save all of your voice and verbosity for the one final response after the tools are done."
  ].join(" ");
}

export function researchSystemInstructions(options: ResearchProviderOptions): string {
  const override = options.systemInstructionsOverride?.trim();
  if (override) return override;
  return [
    researchSystemPrompt,
    researchResponseStyleDirective(options.researchVerbosity) || "Keep the visible answer conversational and concise.",
    researchSubagentDirective(options),
    options.researchStructuredToolsEnabled ? researchToolDeliveryDirective : "",
    options.researchPersonalityPrompt?.trim() ? options.researchPersonalityPrompt.trim() : ""
  ].filter(Boolean).join("\n\n");
}

export async function researchUserPromptText(userMessage: string, options: ResearchProviderOptions): Promise<string> {
  return [
    options.webSearchEnabled
      ? "Web search is enabled. Use it when useful and cite URLs when web results inform the answer."
      : "Web search is disabled by project settings. Use only provided context and local model knowledge.",
    "",
    options.sessionSummary ? `Existing chat summary:\n${options.sessionSummary}` : "Existing chat summary: none",
    "",
    options.researchMemory?.trim() ? `Research session memory:\n${options.researchMemory.trim()}` : "Research session memory: none",
    "",
    options.researchOrchestration?.trim() ? `Active research orchestration todos:\n${options.researchOrchestration.trim()}` : "Active research orchestration todos: none",
    "",
    options.currentTurnDirective?.trim() ? options.currentTurnDirective.trim() : "",
    "",
    "Recent chat messages:",
    formatResearchMessages(options.messages, options.researchMessageLimit, options.researchHistoryTokenBudget),
    "",
    options.selectedSkillsPrompt?.trim() ? options.selectedSkillsPrompt.trim() : "",
    "",
    "Scoped ArchiCode project context:",
    options.scopeContext,
    "",
    imageAttachmentText(options.imageAttachments),
    await textAttachmentText(options.textAttachments),
    "",
    `User message: ${userMessage}`
  ].join("\n");
}

/**
 * Large, slowly-changing context worth placing in the cacheable system prefix
 * (selected skills + scoped project graph). Kept separate from volatile
 * per-turn state so prompt caching survives across turns of a session.
 */
export function researchStableContextText(options: ResearchProviderOptions): string {
  return [
    options.selectedSkillsPrompt?.trim() ? options.selectedSkillsPrompt.trim() : "",
    "",
    "Scoped ArchiCode project context:",
    options.scopeContext
  ].filter(Boolean).join("\n");
}

/**
 * Per-turn durable state (web mode, running summary, session memory, active
 * orchestration todos). This changes every turn, so it rides in the current
 * user message rather than the cached system prefix.
 */
function researchVolatileContextText(options: ResearchProviderOptions): string {
  return [
    options.webSearchEnabled
      ? "Web search is enabled. Use it when useful and cite URLs when web results inform the answer."
      : "Web search is disabled by project settings. Use only provided context and local model knowledge.",
    "",
    options.sessionSummary ? `Existing chat summary:\n${options.sessionSummary}` : "Existing chat summary: none",
    "",
    options.researchMemory?.trim() ? `Research session memory:\n${options.researchMemory.trim()}` : "Research session memory: none",
    "",
    options.researchOrchestration?.trim() ? `Active research orchestration todos:\n${options.researchOrchestration.trim()}` : "Active research orchestration todos: none",
    "",
    options.currentTurnDirective?.trim() ? options.currentTurnDirective.trim() : ""
  ].join("\n");
}

/**
 * The text of the current user turn: volatile durable-context header,
 * attachment descriptions/contents, then the user's message. Actual image
 * bytes are attached as provider-specific content blocks by each builder.
 */
export async function researchCurrentMessageText(userMessage: string, options: ResearchProviderOptions): Promise<string> {
  return [
    researchVolatileContextText(options),
    "",
    imageAttachmentText(options.imageAttachments),
    await textAttachmentText(options.textAttachments),
    "",
    `User message: ${userMessage}`
  ].join("\n");
}

export type ResearchThreadTurn = { role: "user" | "assistant"; text: string };

/**
 * Builds the prior conversation as real user/assistant turns (rather than the
 * legacy `User:/Assistant:` flattened text), respecting the same recent-message
 * and token-budget window as {@link formatResearchMessages}. Internal system
 * notes map to prefixed user turns; the current user message is excluded (each
 * builder appends it with attachments). Consecutive same-role turns are merged
 * and any leading assistant turns are dropped so the thread starts with a user.
 */
export function researchHistoryThread(userMessage: string, options: ResearchProviderOptions): ResearchThreadTurn[] {
  let history = options.messages;
  const last = history[history.length - 1];
  if (last && last.role === "user" && last.content === userMessage) {
    history = history.slice(0, -1);
  }
  const selected = selectResearchHistoryMessages(history, options.researchMessageLimit, options.researchHistoryTokenBudget);
  const turns: ResearchThreadTurn[] = selected.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    text: message.role === "system" ? `ArchiCode system note: ${message.content}` : message.content
  }));
  while (turns.length && turns[0]?.role === "assistant") turns.shift();
  return mergeConsecutiveResearchTurns(turns);
}

function mergeConsecutiveResearchTurns(turns: ResearchThreadTurn[]): ResearchThreadTurn[] {
  const merged: ResearchThreadTurn[] = [];
  for (const turn of turns) {
    if (!turn.text.trim()) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === turn.role) prev.text = `${prev.text}\n\n${turn.text}`;
    else merged.push({ role: turn.role, text: turn.text });
  }
  return merged;
}

export async function summarizeWithProvider(provider: Provider | undefined, text: string, projectRoot?: string): Promise<string> {
  if (!provider || provider.kind === "offline-manual") {
    return summarizeLocally(text);
  }

  const prompt = [
    "Summarize this ArchiCode project context into durable JSON-readable notes.",
    "Preserve project goals, selected nodes, constraints, approvals, questions, recent run results, artifacts, and open todos.",
    "Be concise but specific enough for a later LLM run to continue safely."
  ].join(" ");

  try {
    return await callProvider(provider, text.slice(0, 50000), prompt, { projectRoot, webSearchEnabled: false, phase: "summarizing" });
  } catch (error) {
    return [
      "Provider summarization failed; ArchiCode used local fallback compaction.",
      error instanceof Error ? error.message : String(error),
      summarizeLocally(text)
    ].join("\n\n");
  }
}

export async function checkProviderHealth(provider: Provider): Promise<ProviderHealthResult> {
  const checkedAt = new Date().toISOString();
  if (provider.kind === "offline-manual") {
    return {
      providerId: provider.id,
      ok: true,
      status: "ready",
      checkedAt,
      message: "Offline/manual provider is always available."
    };
  }

  if (isCodexLocalProvider(provider)) {
    return checkCodexLocal(provider, checkedAt);
  }
  if (isClaudeLocalProvider(provider)) {
    return checkClaudeLocal(provider, checkedAt);
  }
  if (isOpenCodeLocalProvider(provider)) {
    return checkOpenCodeLocal(provider, checkedAt);
  }
  if (isAntigravityLocalProvider(provider)) {
    return checkAntigravityLocal(provider, checkedAt);
  }
  if (isGrokLocalProvider(provider)) {
    return checkGrokLocal(provider, checkedAt);
  }
  if (isKimiLocalProvider(provider)) {
    return checkKimiLocal(provider, checkedAt);
  }

  const apiKey = resolveProviderApiKey(provider);
  if (!apiKey) {
    return {
      providerId: provider.id,
      ok: false,
      status: "missing-key",
      checkedAt,
      message: "Missing API key. Paste a provider key in settings, then check again."
    };
  }

  try {
    let detectedContextWindowTokens: number | undefined;
    let contextWindowSource: string | undefined;
    let availableModels: string[] | undefined;
    let detectedModelCapabilities: ProviderHealthResult["detectedModelCapabilities"];
    let modelListSource: string | undefined;
    let detectedOpenAiEndpointMode: ProviderHealthResult["detectedOpenAiEndpointMode"];
    if (provider.kind === "openai-compatible") {
      const check = await checkOpenAICompatible(provider, apiKey);
      detectedContextWindowTokens = check.detectedContextWindowTokens;
      availableModels = check.availableModels;
      detectedModelCapabilities = check.detectedModelCapabilities;
      contextWindowSource = detectedContextWindowTokens ? "models metadata" : undefined;
      modelListSource = availableModels.length ? "models endpoint" : undefined;
      detectedOpenAiEndpointMode = check.detectedOpenAiEndpointMode;
    } else {
      const check = await checkAnthropicCompatible(provider, apiKey);
      detectedContextWindowTokens = check.detectedContextWindowTokens;
      availableModels = check.availableModels;
      detectedModelCapabilities = check.detectedModelCapabilities;
      contextWindowSource = detectedContextWindowTokens ? "models metadata" : undefined;
      modelListSource = availableModels.length ? "models endpoint" : undefined;
    }
    return {
      providerId: provider.id,
      ok: true,
      status: "ready",
      checkedAt,
      message: detectedContextWindowTokens
        ? `Provider endpoint responded successfully. Detected ${detectedContextWindowTokens.toLocaleString()} token context window.`
        : "Provider endpoint responded successfully.",
      detectedContextWindowTokens,
      contextWindowSource,
      availableModels,
      detectedModelCapabilities,
      modelListSource,
      detectedOpenAiEndpointMode
    };
  } catch (error) {
    return {
      providerId: provider.id,
      ok: false,
      status: "failed",
      checkedAt,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export const orchestratorSystemPrompt = [
  "You are ArchiCode's local orchestrator.",
  "Use the JSON context to produce concise implementation guidance, questions, todos, and safe next actions.",
  "Every build run has a mandatory plan gate before any code proposal.",
  "In planning, explicitly decide whether to proceed or ask questions before describing implementation work.",
  "During planning, use archicode_project_manage_rules with action list_violations for the run's target flow and nodes before finalizing source work. Treat active policies and current findings as architecture constraints. An Error + Enforced finding can block only when the run introduces it after the run baseline; an existing baseline finding does not fail the run by itself. If the reported evaluation is stale or unavailable, say so and plan conservatively because verification will refresh it.",
  "Treat the current graph, flows, nodes, edges, notes, tags, logs, artifacts, diff deltas, run history, data fields, acceptance criteria, and approvals as the evolving project source of truth.",
  "Treat node.implementationScope separately as deterministic, best-effort code-navigation hints. own/share/cover claims may be incomplete, inaccurate, or stale; use checkedAt to judge when they were last evaluated, use them to orient inspection, verify them against current files, and never treat them as permissions, hard edit boundaries, or replacements for node intent and acceptance criteria. Missing hints mean unknown.",
  "Evidence order for code mapping: current inspected source is authoritative; node.implementationScope is stronger structural orientation than semanticRetrieval; semantic matches are secondary discovery candidates only. Use semantic matches to broaden inspection, never as proof of implementation, dependency, ownership, edit scope, or graph truth.",
  `${gaiaAgent.title} powers AI Implement at project inception to create the first runnable scaffold and throughout the lifecycle to update an existing codebase; code she creates or edits must match the latest graph/node state.`,
  "First inspect the selected node or full diagram state, including stages, flags, diffs, notes, artifacts, edges, and approvals.",
  "Respect projectConventions from the context, including .gitignore, agent instruction files such as AGENTS.md/CLAUDE.md/GEMINI.md, README, package scripts, and missing recommended convention files.",
  "Before proceeding, check for ambiguity in target user/job, product identity/content source, core workflows/pages/data, stack/runtime/integration constraints, acceptance criteria/testing, and visual/brand constraints.",
  "If ambiguity would materially change files, UX, architecture, data model, graph relationships, permissions, tests, or verification, ask questions instead of assuming.",
  "If required product, technical, file, permission, or user intent information is missing, abort the code phase.",
  "An empty workspace or missing app scaffold is not, by itself, missing information when the graph already names a stack, routes, acceptance criteria, and product shape; scaffold the smallest useful app from that context.",
  "ArchiCode is stack-neutral. Never default to web, JavaScript/TypeScript, Node, Python, mobile, or any other technology because it is familiar or common. Derive the stack, package/build tools, file conventions, commands, and generated-artifact behavior only from the graph, project settings, detected files, and explicit user requirements; when a material stack choice is still missing, ask during planning instead of assuming.",
  "For starter templates, use concrete editable placeholder copy for low-stakes names or marketing copy, but ask questions when brand/content direction is central to the requested product or acceptance criteria.",
  "During planning, when aborting for missing information, ask 1-5 focused clarification questions as add-note operations with kind llm-question and author llm; do not include update-node operations or code-change artifacts.",
  "Only propose code or node-state changes after the plan gate has enough information.",
  "During planning, when inspected code provides concrete evidence that implementationScope is stale, you may include one bounded update-node patch for the affected node using source implementation-agent and no more than 24 claims. Do not churn or expand hints speculatively.",
  "For code changes, create or update tests that match the affected layer: unit tests for logic, integration tests for flows/APIs/storage, renderer tests for UI behavior, and visual QA when visual layout/theme behavior changes.",
  "Use existing test frameworks, file locations, and naming patterns before introducing new tools.",
  "Acceptance checks (acceptanceChecks) are opt-in and only belong on nodes that represent verifiable code behavior (features, components, services, endpoints, data flows). Do NOT add checks to notes, docs, decisions, diagrams, external actors/systems, or other non-code nodes; leave their acceptanceChecks empty so they clear normally on build. When a node does represent code you are implementing, populate acceptanceChecks with one check per acceptance criterion you can actually test: set criterion to the criterion text and testCommand to a concrete, finite command that verifies it (reuse the module's testCommand or a scoped test invocation). ArchiCode runs these on the next verified build and the node only clears once every check passes, so prefer commands that genuinely exercise the criterion over trivially-passing ones. If a real criterion has no practical automated test, leave it out of acceptanceChecks rather than adding a hollow check that would block the node. During coding/debugging, inspect existing acceptanceChecks and their current status/evidence before deciding whether to keep, rerun, or regenerate them.",
  "Build-module binding uses node.moduleProfileMode plus optional node.moduleProfileId. auto means leave it unbound unless there is exactly one run target, in which case that single target is implied; if there are multiple run targets and the node is still auto, set moduleProfileMode to manual and moduleProfileId to the correct target only when you can confidently map the node. Do not churn an already-manual binding unless the code clearly proves it is wrong.",
  "During planning, if no test framework exists or the correct test strategy is unclear, ask a focused llm-question or propose a small test setup instead of pretending coverage exists.",
  "After coding, run or recommend the most relevant finite verification command: build, test, lint, typecheck, check, package, or equivalent.",
  "Do not start app/runtime/server/watch commands during planning, coding, debugging, or verification. Do not run dev/start/serve/preview/watch commands; Run App owns runtime launch.",
  "During planning, if project context lacks useful run targets or the project has multiple runnable modules, propose target-aware Run App profiles with propose-run-profile instead of relying only on a fallback run command.",
  "Run profiles should be project-specific and code-agnostic in shape: label, kind, optional discover/launch/wait/diagnostic/recovery commands, runCommand, readyPattern, timeoutSeconds, and safe placeholders such as {targetId}.",
  "Do not modify approved locked nodes.",
  "Respect ignored nodes and flows: they exist for awareness only and are outside the working set. Do not implement, debug, update, ask questions against, or create run targets from ignored graph items.",
  "Never approve your own work: do not set stage to plan-approved or draft-approved-production, do not add user-approved, and do not lock nodes as approved.",
  "When proposing machine-applicable changes, include an archicodePatch JSON object with schemaVersion: 1, runId, summary, and operations.",
  "For API-provider coding phases, propose actual source edits with propose-source-file operations. Every source operation must include nodeIds with one or more valid IDs from sourceAttribution.allowedNodes in the run context. Include path, action, content for create/replace, baseSha256 when replacing, reason, and testIntent.",
  "Before replacing an existing file, read it with read_file and copy the returned sha256 exactly into baseSha256. Do not invent or approximate hashes.",
  "Do not claim local files were edited by an API provider; ArchiCode applies reviewed source-file operations after validating them.",
  "During coding and debugging, do not ask questions and do not return graph notes, node updates, graph proposals, run profiles, or general metadata operations; return usable source-file proposals or fail with a clear run-level summary.",
  "Use add-note with kind llm-question for missing user input only during planning.",
  "Use resolve-note when existing node feedback is no longer active after updating the node fields. Use delete-note only for clearly wrong or duplicate notes that should be removed from durable graph context.",
  "Use propose-node, propose-edge, and propose-subflow when planning reveals a useful graph addition; these require user acceptance and should be concise.",
  "Use propose-graph-operation with a nested validated graph operation for group lifecycle changes or structural graph edits not represented by the legacy propose-node, propose-edge, and propose-subflow operations. These always require manual review.",
  "During coding, .gitignore, README.md, agent instruction files such as AGENTS.md/CLAUDE.md/GEMINI.md, package.json, configs, source files, tests, and assets are real project files and must use propose-source-file.",
  "Use propose-project-file only for ArchiCode-owned metadata/control files, not user project files.",
  "Use propose-run-profile during planning when the harness needs a new or corrected Run App target for this stack, module, emulator, service, or local preview.",
  "Valid operation kinds are update-node, add-note, resolve-note, delete-note, add-artifact-reference, propose-node, propose-edge, propose-subflow, propose-graph-operation, propose-project-file, propose-run-profile, and propose-source-file."
].join(" ");

export const planningQuestionGateInstructions = [
  "Planning must begin with exactly one visible decision line: Decision: ask_questions or Decision: proceed.",
  "Choose Decision: ask_questions when unanswered information could materially change the files, UX, architecture, data model, graph relationships, permissions, tests, or verification command.",
  "When asking questions, return an archicodePatch with only add-note operations using kind llm-question and author llm, attach each question to the most relevant node, and stop without proposing code.",
  "Choose Decision: proceed only after listing the key assumptions you are comfortable making from the graph/context.",
  "When proceeding, write a user-facing implementation plan in normal prose before any JSON. Use these exact section headings when the information is available: Goal, Approach, Key Assumptions, Implementation Steps, Verification, Risks.",
  "The visible plan must read like a real implementation plan for the user, not private scratch notes to yourself. Keep it concrete, project-specific, and explicit about what coding will do next.",
  "When proceeding, include archicodePatch.runSummary.implementationTasks: 1-8 named source implementation tasks with title, summary, batchBudget, optional lightVerificationCommand, and optional finite verificationCommand when a focused test/check/build command is known. Prefer fewer tasks for small or low-risk scaffolds.",
  "Also include archicodePatch.runSummary.goal, approach, assumptions, verificationPlan, and risks whenever you can infer them confidently; these fields back the user-facing plan view.",
  "Choose batchBudget per task from your expected implementation complexity, confidence, and slice size. For fast effort use 1-2 batches per task and keep the total small; for high effort use 1-6 batches per task when the work is broad, risky, multi-system, or long-horizon.",
  "Use lightVerificationCommand for cheap finite checks between tasks, such as typecheck, lint, focused tests, or a typecheck-only prefix of a build. Use verificationCommand for the full final verification when known.",
  "If the run asks for automatic implementation effort, choose archicodePatch.runSummary.implementationEffort as either \"fast\" for quick small/low-risk work or \"high\" for broader/riskier/long-horizon work.",
  "Implementation tasks should be ordered, self-contained source slices that coding can execute one at a time; planning owns this split.",
  "Inspect the target node's and flow's actual source with read_file before finalizing the task split; do not author the plan from graph metadata alone.",
  "For large or multi-node scope, keep the planning context lean: when a research subagent (Sherlock) is available, delegate breadth-first codebase inspection to it with a bounded objective and the relevant codePaths, then build the task split from its compact evidence dossier instead of reading every file inline.",
  "Reserve inline read_file for the specific files you must confirm yourself, and do not delegate for small or single-node scope where direct inspection is cheaper.",
  "Coverage: every in-scope node should be covered by at least one implementation task; name the node it implements in that task's summary.",
  "Order tasks by dependency and never place a test-authoring task before the implementation it verifies.",
  "The user-facing plan sections (Goal, Approach, Key Assumptions, Implementation Steps, Verification, Risks) must be concrete and project-specific, not generic boilerplate."
].join(" ");

export const planningPatchJsonContract = [
  "Planning handoff JSON contract:",
  "When planning needs durable graph changes, questions, implementation tasks, or run profiles, return exactly one machine-readable JSON object, preferably in a fenced ```json block, with this top-level shape: { \"archicodePatch\": { ... } }.",
  "Do not return the bare patch object with schemaVersion at the top level; schemaVersion, runId, summary, runSummary, and operations belong inside archicodePatch.",
  "archicodePatch planning schema:",
  "{",
  "  \"archicodePatch\": {",
  "    \"schemaVersion\": 1,",
  "    \"runId\": string,",
  "    \"summary\": string,",
  "    \"runSummary\": {",
  "      \"goal\": string,",
  "      \"approach\": string,",
  "      \"assumptions\": string[],",
  "      \"verificationPlan\": string,",
  "      \"risks\": string[],",
  "      \"implementationEffort\": \"fast\" | \"high\",",
  "      \"implementationTasks\": [",
  "        {",
  "          \"id\": string,",
  "          \"title\": string,",
  "          \"summary\": string,",
  "          \"batchBudget\": number,",
  "          \"lightVerificationCommand\": string,",
  "          \"verificationCommand\": string",
  "        }",
  "      ],",
  "      \"suggestedQuestions\": string[]",
  "    },",
  "    \"operations\": [",
  "      { \"kind\": \"add-note\", \"note\": { \"flowId\": string, \"nodeId\": string, \"kind\": \"llm-question\", \"author\": \"llm\", \"body\": string, \"category\": \"note\", \"priority\": \"normal\" | \"high\" | \"urgent\", \"attachmentIds\": [], \"resolved\": false, \"pinned\": false } },",
  "      { \"kind\": \"update-node\", \"flowId\": string, \"patch\": { \"id\": string, \"implementationScope\": { \"source\": \"implementation-agent\", \"analyzerVersion\": number, \"claims\": [{ \"relation\": \"own\" | \"share\" | \"cover\", \"kind\": \"file\" | \"directory\" | \"class\" | \"function\" | \"symbol\", \"path\": string, \"symbol\": string }] } } },",
  "      { \"kind\": \"propose-node\", \"flowId\": string, \"node\": object },",
  "      { \"kind\": \"propose-edge\", \"flowId\": string, \"edge\": object },",
  "      { \"kind\": \"propose-subflow\", \"flowId\": string, \"subflow\": object },",
  "      { \"kind\": \"propose-graph-operation\", \"operation\": { \"kind\": \"create-group\" | \"update-group\" | \"delete-group\" | string, ... } },",
  "      { \"kind\": \"propose-run-profile\", \"profile\": object, \"mode\": \"create\" | \"replace\", \"reason\": string }",
  "    ]",
  "  }",
  "}",
  "Only schemaVersion, runId, summary, and operations are required at archicodePatch level; include runSummary.implementationTasks when proceeding to coding.",
  "During planning, never return propose-source-file operations. Source files belong to coding.",
  "Valid proceed example:",
  "{",
  "  \"archicodePatch\": {",
  "    \"schemaVersion\": 1,",
  "    \"runId\": \"run-current\",",
  "    \"summary\": \"Proceed with a two-step implementation plan.\",",
  "    \"runSummary\": {",
  "      \"goal\": \"Create the smallest runnable app shell that matches the selected node acceptance criteria.\",",
  "      \"approach\": \"Scaffold the shell first, then add the focused route-level feature work in ordered slices.\",",
  "      \"assumptions\": [\"The current stack should stay in place.\", \"The default build command remains the main verification path.\"],",
  "      \"verificationPlan\": \"Run npm run typecheck after the first slice and npm run build at the end.\",",
  "      \"risks\": [\"Shared navigation and routing changes can affect multiple screens.\"],",
  "      \"implementationEffort\": \"fast\",",
  "      \"implementationTasks\": [",
  "        { \"id\": \"task-1\", \"title\": \"Scaffold app shell\", \"summary\": \"Create the minimal runnable shell.\", \"batchBudget\": 1, \"lightVerificationCommand\": \"npm run typecheck\", \"verificationCommand\": \"npm run build\" }",
  "      ]",
  "    },",
  "    \"operations\": []",
  "  }",
  "}",
  "Valid ask-questions example:",
  "{",
  "  \"archicodePatch\": {",
  "    \"schemaVersion\": 1,",
  "    \"runId\": \"run-current\",",
  "    \"summary\": \"Ask for missing platform direction.\",",
  "    \"operations\": [",
  "      {",
  "        \"kind\": \"add-note\",",
  "        \"note\": {",
  "          \"flowId\": \"flow-main\",",
  "          \"nodeId\": \"node-app\",",
  "          \"kind\": \"llm-question\",",
  "          \"author\": \"llm\",",
  "          \"body\": \"Which platform should this app target first?\",",
  "          \"category\": \"note\",",
  "          \"priority\": \"high\",",
  "          \"attachmentIds\": [],",
  "          \"resolved\": false,",
  "          \"pinned\": false",
  "        }",
  "      }",
  "    ]",
  "  }",
  "}"
].join("\n");

export const sourceProposalBatchingInstructions = [
  "Source proposal sizing: every propose-source-file operation must contain complete file content for create/replace actions; never return partial files, ellipses, TODO-only stubs, or prose summaries in place of content.",
  "If the full implementation is large, return the smallest self-contained runnable slice that fits the phase maxOutputTokens instead of trying to emit every file at once.",
  "Prefer a small batch of closely related files per response. For starter scaffolds, include the minimal runnable shell first, then put any remaining follow-up in the run summary, not graph notes or Source Changes.",
  "When a file would become very large, split it into smaller route, component, style, data, or utility files before proposing it.",
  "In archicodePatch.runSummary.implementationStatus, return complete when this batch finishes the requested implementation, continue when another source-file batch is needed, or blocked when coding cannot safely continue.",
  "When using implementationStatus continue, include runSummary.nextSourceSlice with the next concrete file slice to implement.",
  "Do not use continue only to wait for ArchiCode to apply files, install dependencies, or run build/test/verification; the host performs those steps after a complete source handoff.",
  "If the current implementation task cannot proceed because the plan is insufficient or materially wrong, set runSummary.implementationStatus to blocked, runSummary.needsReplan to true, and include runSummary.replanReason plus suggestedQuestions; do not ask questions as graph notes during coding.",
  "If the requested change cannot fit as a valid complete archicodePatch, do not return malformed or truncated JSON; fail with a clear run-level summary naming the next source-file slice."
].join(" ");

const codingPatchJsonContract = [
  "Coding handoff JSON contract:",
  "Return exactly one machine-readable JSON object, preferably in a fenced ```json block, with this top-level shape: { \"archicodePatch\": { ... } }.",
  "Do not return the bare patch object with schemaVersion at the top level; schemaVersion, runId, summary, runSummary, and operations belong inside archicodePatch.",
  "archicodePatch schema:",
  "{",
  "  \"archicodePatch\": {",
  "    \"schemaVersion\": 1,",
  "    \"runId\": string,",
  "    \"summary\": string,",
  "    \"runSummary\": {",
  "      \"implementationStatus\": \"complete\" | \"continue\" | \"blocked\",",
  "      \"notes\": string,",
  "      \"verificationNotes\": string,",
  "      \"nextSourceSlice\": string,",
  "      \"needsReplan\": boolean,",
  "      \"replanReason\": string,",
  "      \"suggestedQuestions\": string[]",
  "    },",
  "    \"operations\": [",
  "      {",
  "        \"kind\": \"propose-source-file\",",
  "        \"path\": string,",
  "        \"action\": \"create\" | \"replace\" | \"delete\",",
  "        \"content\": string,",
  "        \"baseSha256\": string,",
  "        \"nodeIds\": string[],",
  "        \"reason\": string,",
  "        \"testIntent\": string",
  "      }",
  "    ]",
  "  }",
  "}",
  "Only schemaVersion, runId, summary, and operations are required at archicodePatch level; include runSummary fields only when useful.",
  "runSummary.notes and runSummary.verificationNotes must be strings, not arrays or objects. If you have multiple notes, join them into one newline-separated string.",
  "For create/replace actions, content is required and must be the complete final file text. For delete actions, omit content.",
  "Valid coding example:",
  "{",
  "  \"archicodePatch\": {",
  "    \"schemaVersion\": 1,",
  "    \"runId\": \"run-current\",",
  "    \"summary\": \"Create the app entrypoint.\",",
  "    \"runSummary\": {",
  "      \"implementationStatus\": \"complete\",",
  "      \"notes\": \"Created a minimal source entrypoint. Verification should run after ArchiCode applies the file proposal.\"",
  "    },",
  "    \"operations\": [",
  "      {",
  "        \"kind\": \"propose-source-file\",",
  "        \"path\": \"src/main.ts\",",
  "        \"action\": \"create\",",
  "        \"content\": \"console.log('ready')\\n\",",
  "        \"nodeIds\": [\"node-app\"],",
  "        \"reason\": \"Add the application entrypoint.\",",
  "        \"testIntent\": \"Build verification imports the entrypoint.\"",
  "      }",
  "    ]",
  "  }",
  "}"
].join("\n");

export const codingSourceHandoffInstructions = [
  codingPatchJsonContract,
  "Return only propose-source-file operations for real project file changes.",
  "Source attribution is mandatory: attach every changed file to one or more IDs from sourceAttribution.allowedNodes. Use all directly affected nodes when a shared file serves several nodes. This is advisory implementation history, not proof of exclusive ownership.",
  "Treat .gitignore, README.md, agent instruction files such as AGENTS.md/CLAUDE.md/GEMINI.md, package.json, configs, source files, tests, and assets as real project files.",
  "Do not return graph notes, questions, node updates, graph proposals, run profiles, propose-project-file, or general metadata operations during coding.",
  "Keep Source Changes pure: only file proposals, paths, diffs, file-specific reason, and testIntent belong there.",
  "Put run-level summaries, caveats, warnings, and verification notes in the visible response/summary text, not Source Changes and not graph notes.",
  "If information is still missing, fail with a clear run-level reason instead of asking questions; planning owns questions."
].join(" ");

export function phaseHandoffInstructions(phase: LlmPhase, structuredSourceHandoff = false): string {
  if (phase === "coding") {
    if (structuredSourceHandoff) {
      return [
        `You are ${gaiaAgent.title}, ArchiCode's implementation agent. Own the requested source work through a valid handoff without changing your role or identity.`,
        "Submit source changes with the available ArchiCode source handoff tools instead of returning an archicodePatch JSON block.",
        "Call archicode_submit_source_file once per file. You may issue many independent file calls in the same response, so a normal successful batch still takes one provider turn.",
        "End that same response with exactly one archicode_finish_source_batch call. If a file receipt reports a parse or validation error, resend only that file and finish the batch again; previously accepted files remain staged.",
        "Inspect files and run any necessary discovery tools before the first source-file submission. Once you submit any source file, do not call file-reading, command, MCP, or subagent tools: staged files are not on disk yet, so those tools would observe stale state.",
        "If all requested source files cannot fit in this batch, submit a coherent runnable slice and finish with implementationStatus continue plus nextSourceSlice naming the remaining source work. Never use continue merely to wait for file application, dependency installation, build, tests, or verification.",
        "After the final requested source slice is submitted, use implementationStatus complete. ArchiCode applies the staged files, installs required dependencies, and performs authoritative verification after the handoff; do not run or claim verification against staged files.",
        "Do not place multiple files inside one JSON string and do not return source-file prose in place of tool calls. ArchiCode validates the staged batch, applies it atomically, and then verifies it."
      ].join(" ");
    }
    return `You are ${gaiaAgent.title}, ArchiCode's implementation agent. Return an archicodePatch JSON object using the coding handoff schema. ArchiCode will validate, apply safe source-file proposals, and review unsafe changes. ${codingSourceHandoffInstructions} ${sourceProposalBatchingInstructions}`;
  }
  if (phase === "debugging") {
    if (structuredSourceHandoff) {
      return [
        `You are ${pandoraAgent.title}, ArchiCode's debugging agent. Own the incident investigation and focused repair through a valid handoff.`,
        "Submit the smallest source repair with the available ArchiCode source handoff tools instead of returning an archicodePatch JSON block.",
        "Call archicode_submit_source_file once per changed file; multiple independent file calls may be issued in the same response.",
        "End the same response with archicode_finish_source_batch. Resend only a file whose receipt reports an error.",
        "Run discovery tools before submitting the first repair file. After source submission starts, finish the batch without reading files or running commands because staged repairs are not on disk yet.",
        "Use implementationStatus complete after the final repair file. ArchiCode applies and verifies it; use continue only when another concrete source-file slice remains."
      ].join(" ");
    }
    return `You are ${pandoraAgent.title}, ArchiCode's debugging agent. Debug the failed run from logs and diffs. Return an archicodePatch JSON object using the coding handoff schema with the smallest repair source-file proposals, or fail with a clear run-level reason. ${codingSourceHandoffInstructions} ${sourceProposalBatchingInstructions}`;
  }
  if (phase === "planning") {
    return `You are ${gaiaAgent.title}, ArchiCode's implementation agent. This is your non-mutating planning phase before coding. ${planningQuestionGateInstructions} ${planningPatchJsonContract}`;
  }
  return "This is a non-mutating phase unless you return reviewed archicodePatch operations.";
}

export const localAskModeMcpRequestInstructions = [
  "Local MCP approval contract for Ask-mode external servers:",
  "Enabled Ask-mode MCP servers remain visible to you in the run context even when they are not mounted for direct execution yet.",
  "If you need one, stop and return exactly one machine-readable JSON object, preferably in a fenced ```json block, with this top-level shape: { \"archicodeMcpRequest\": { \"serverId\": string, \"toolName\": string, \"arguments\": object, \"intent\": string } }.",
  "Do not mix that JSON object with prose. Use only server ids and tool names that were listed as enabled for this run.",
  "After the user allows or denies that exact tool call, ArchiCode will resume the same run with the tool result or denial reason."
].join("\n");

export type LocalResearchToolCall = {
  id: string;
  providerToolName: string;
  argumentsJson: string;
};

type LocalResearchContinuationMessage =
  | { role: "assistant"; answer?: string; toolCalls: LocalResearchToolCall[] }
  | { role: "tool"; toolCallId: string; providerToolName: string; result: string }
  | { role: "feedback"; content: string };

type LocalResearchTurn = {
  answer?: string;
  toolCalls: LocalResearchToolCall[];
};

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

function collectJsonCandidates(output: string, key: string): string[] {
  const candidates = new Set<string>();
  const fenced = output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fenced) {
    const value = match[1]?.trim();
    if (value) candidates.add(value);
  }
  const keyIndex = output.indexOf(`"${key}"`);
  if (keyIndex >= 0) {
    const outerStart = output.lastIndexOf("{", keyIndex);
    const innerStart = output.indexOf("{", keyIndex + key.length + 2);
    const outer = outerStart >= 0 ? readBalancedObject(output, outerStart) : null;
    const inner = innerStart >= 0 ? readBalancedObject(output, innerStart) : null;
    if (outer) candidates.add(outer);
    if (inner) candidates.add(inner);
  }
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") continue;
    const object = readBalancedObject(output, index);
    if (object && object.includes(key)) candidates.add(object);
  }
  return [...candidates];
}

export function extractLocalResearchTurn(output: string): LocalResearchTurn | null {
  const candidates = collectJsonCandidates(output, "archicodeResearchTurn");
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const turnRecord = "archicodeResearchTurn" in (parsed as Record<string, unknown>)
        ? (parsed as Record<string, unknown>).archicodeResearchTurn
        : parsed;
      if (!turnRecord || typeof turnRecord !== "object") continue;
      const record = turnRecord as Record<string, unknown>;
      const toolCalls = Array.isArray(record.toolCalls)
        ? record.toolCalls.flatMap((item, index) => {
            if (!item || typeof item !== "object") return [];
            const toolRecord = item as Record<string, unknown>;
            const providerToolName = typeof toolRecord.providerToolName === "string" ? toolRecord.providerToolName.trim() : "";
            if (!providerToolName) return [];
            const argumentsJson = toolRecord.arguments === undefined
              ? "{}"
              : typeof toolRecord.arguments === "string"
                ? toolRecord.arguments
                : JSON.stringify(toolRecord.arguments);
            return [{
              id: typeof toolRecord.id === "string" && toolRecord.id.trim() ? toolRecord.id.trim() : `local-tool-${index + 1}`,
              providerToolName,
              argumentsJson
            }];
          })
        : [];
      if (!toolCalls.length) continue;
      return {
        answer: typeof record.answer === "string" && record.answer.trim() ? record.answer : undefined,
        toolCalls
      };
    } catch {
      // Ignore malformed candidates and keep scanning.
    }
  }
  return null;
}

/**
 * Local CLI transports use a JSON envelope in place of native tool calls.
 * If a model starts emitting that private envelope but produces malformed
 * JSON, it is not a user-facing answer: return a contract correction to the
 * same trajectory instead of letting the transport syntax leak into chat.
 */
export function localResearchTurnValidationFeedback(output: string): string | undefined {
  if (!/"archicodeResearchTurn"\s*:/.test(output)) return undefined;
  if (extractLocalResearchTurn(output)) return undefined;
  return [
    "Your response appears to be an internal archicodeResearchTurn tool envelope, but ArchiCode could not parse it as a valid tool turn.",
    "Do not show the internal envelope to the user. If tools are still needed, return one syntactically valid JSON object with archicodeResearchTurn.toolCalls and complete quoted arguments. Otherwise return only the normal user-facing answer in prose."
  ].join("\n\n");
}

export function localResearchToolLoopInstructions(options: ResearchProviderOptions): string {
  if (!options.mcpTools?.length) return "";
  const isolatedSubagent = Boolean(options.systemInstructionsOverride?.trim());
  const toolLines = options.mcpTools.map((tool) => {
    let schema = "{}";
    try {
      schema = JSON.stringify(tool.inputSchema ?? {});
    } catch {
      // MCP schemas are expected to be JSON-compatible. Keep the tool visible
      // if a third-party server nevertheless returns an unserializable value.
    }
    return [
      `- ${tool.providerToolName}: ${tool.description || `${tool.serverLabel}: ${tool.toolName}`}`,
      `  argumentsSchema: ${schema}`
    ].join("\n");
  });
  return [
    "Structured research tool loop for this local CLI session:",
    "Native tool calling is not available in this local provider transport, so use the JSON tool-turn contract below instead of pretending tools are unavailable.",
    "When you need tools, return exactly one machine-readable JSON object, preferably in a fenced ```json block, with this top-level shape: { \"archicodeResearchTurn\": { \"answer\": string, \"toolCalls\": [{ \"id\": string, \"providerToolName\": string, \"arguments\": object }] } }.",
    "Use providerToolName exactly as listed. If toolCalls is present, do not include prose outside that JSON object.",
    "Every tool call's arguments object MUST satisfy that tool's argumentsSchema exactly. Include every field listed in required, respect enum values and nested shapes, and do not invent fields when additionalProperties is false.",
    isolatedSubagent
      ? "This is an isolated subagent tool loop. Parent Research memory, goal, graph-delegation, and confirmation obligations do not apply. Call only tools listed below. Continue through the required execution tools until the assigned subagent objective is actually complete or a concrete tool result blocks it; inspection alone is not completion when execution was requested."
      : researchDurableMemoryPolicy,
    isolatedSubagent ? "" : researchGraphDelegationPolicy,
    isolatedSubagent
      ? "You may request several independent listed tools in one response. After ArchiCode returns their results, use them and continue; never claim a listed execution tool or its result is unavailable merely because it was not called yet."
      : "Include answer when the requested tools are terminal sink tools and the user should see a final visible answer from the same turn. For non-terminal inspection/tool steps, answer may be omitted or brief because ArchiCode will call you again with the tool results.",
    isolatedSubagent
      ? "ArchiCode will execute requested tools and continue this isolated run with their results."
      : "Request tools one turn at a time as needed. ArchiCode will execute them, pause for approval when required, and continue this same turn with their results.",
    "Available structured tools:",
    ...toolLines
  ].join("\n");
}

export function formatLocalResearchTranscript(messages: LocalResearchContinuationMessage[]): string {
  if (!messages.length) return "No prior structured tool transcript yet.";
  return messages.map((message) => {
    if (message.role === "assistant") {
      const toolText = message.toolCalls.length
        ? `\nTool calls:\n${message.toolCalls.map((toolCall) => `- ${toolCall.providerToolName} ${toolCall.argumentsJson}`).join("\n")}`
        : "";
      return [`Assistant answer: ${message.answer ?? "(no visible answer)"}`, toolText].filter(Boolean).join("");
    }
    if (message.role === "feedback") return `Host validation feedback: ${message.content}`;
    return `Tool result for ${message.providerToolName}: ${message.result}`;
  }).join("\n\n");
}

export function localResearchTranscriptFromContinuation(
  continuation: ResearchProviderContinuation & { approvedResult: string },
  transport: "codex-local" | "claude-local" | "opencode-local" | "antigravity-local" | "grok-local" | "kimi-local"
): LocalResearchContinuationMessage[] {
  if (continuation.transport !== transport || !continuation.messages) return [];
  const transcript = (continuation.messages as LocalResearchContinuationMessage[]).map((message) => ({ ...message }));
  transcript.push({
    role: "tool",
    toolCallId: continuation.pendingToolCall.id,
    providerToolName: continuation.pendingToolCall.providerToolName,
    result: continuation.approvedResult
  });
  return transcript;
}

const researchMemoryToolContract = [
  "Optional semantic memory-delta contract:",
  researchDurableMemoryPolicy,
  "Only when useful semantic detail cannot be derived from host-observed events, archicode_update_memory accepts a research memory delta with optional summary and arrays for decisions, todos, openQuestions, links, facts, assumptions, graphRefs, runRefs, fileRefs, artifactRefs, imageRefs, and debugFindings.",
  "The summary is the long-term compass for future research turns: keep concise cumulative meeting notes, preserving earlier durable direction while adding new decisions, unresolved questions, and next focus.",
  "Do not write a raw chat log, generic capability blurb, or transient explanation into memory.",
  "Use canonical structured records rather than raw string arrays. Include sourceMessageIds when known, omit inapplicable optional graph ids instead of null, and never include raw file or image dumps."
].join("\n");

const researchChangeSetJsonContract = [
  "Research changeSet JSON contract:",
  "Return normal prose when you are answering the user, planning, clarifying, researching, or confirming a graph-edit scope. Include exactly one fenced ```json block with this top-level shape: { \"archicodeResearch\": { ... } } only after the user has affirmed a previously described concrete graph-edit scope, or explicitly asks you to show/prepare the review card now. The review card's buttons or auto-approve setting remain the mechanism that applies or rejects the change.",
  "Do not return a bare object with answer, summary, or changeSet at the top level; answer, summary, and changeSet belong inside archicodeResearch.",
  "The archicodeResearch.answer field is the visible chat response. When the user asks to edit, create, update, delete, or move a graph item, inspect the affected nodes, edges, descriptions, acceptance criteria, and nearby graph context before proposing a change. State the concrete, coherent scope you intend to put on the review card, including related connections or node updates that should change together; ask every necessary clarifying question in that same response, and ask once for confirmation that this is the scope they want prepared. The visible answer must end with a direct confirmation question such as: Should I prepare this exact scope as the graph review card? Never wait passively for confirmation without asking for it. Do not return a changeSet yet. After the user affirmatively confirms that scope, return the review-card changeSet in the next response without asking for scope confirmation again. For planning or brainstorming, answer in normal prose without a changeSet.",
  "Do not include memoryDelta, researchMemoryDelta, or archicodeResearchMemory inside archicodeResearch. ArchiCode derives durable continuity from persisted host events; an optional archicode_update_memory call may add semantic details, but it is never required to finish the user's task.",
  "archicodeResearch schema:",
  "{",
  "  \"archicodeResearch\": {",
  "    \"answer\": string,",
  "    \"summary\": string,",
  "    \"canvasAction\": { \"flowId\": string, optional \"subflowId\": string | null, \"nodeIds\": string[], \"groupIds\": string[], \"selection\": \"replace\" | \"clear\" | \"preserve\", \"viewport\": { \"mode\": \"fit\" | \"center\" | \"pan\" | \"zoom-to\" | \"zoom-by\" | \"preserve\", optional \"padding\"/\"maxZoom\"/\"x\"/\"y\"/\"zoom\"/\"dx\"/\"dy\"/\"factor\": number } },",
  "    \"changeSet\": {",
  "      \"summary\": string,",
  "      \"operations\": [",
  "        { \"kind\": \"update-project\", \"patch\": { \"name\": string, \"description\": string, \"stackAssumptions\": string[], \"environmentNotes\": string } },",
  "        { \"kind\": \"update-flow\", \"flowId\": string, \"patch\": { \"name\": string, \"description\": string } },",
  "        { \"kind\": \"create-flow\", \"flow\": { \"id\": string, \"name\": string, \"description\": string, \"ignored\": false, \"nodes\": object[], \"edges\": object[], \"subflows\": object[], \"groups\": object[], \"updatedAt\": string } },",
  "        { \"kind\": \"update-node\", \"flowId\": string, \"patch\": { \"id\": string, \"title\": string, \"description\": string, \"acceptanceCriteria\": string[], \"acceptanceChecks\": [{ \"id\": string, \"criterion\": string, \"testCommand\": string }], \"implementationScope\": { \"source\": \"chat-agent\", \"analyzerVersion\": number, \"claims\": [{ \"relation\": \"own\" | \"share\" | \"cover\", \"kind\": \"file\" | \"directory\" | \"class\" | \"function\" | \"symbol\", \"path\": string, \"symbol\": string }] }, \"moduleProfileMode\": \"auto\" | \"manual\" | \"none\", \"moduleProfileId\": string, \"techStack\": string[], \"flags\": string[], visual/backgroundColor/shape fields, and optional position as exact { x, y } or relative { relativeToNodeId, placement } } },",
  "        { \"kind\": \"update-edge\", \"flowId\": string, \"edgeId\": string, \"patch\": object },",
  "        { \"kind\": \"add-note\", \"note\": { \"flowId\": string, \"nodeId\": string, \"kind\": \"user-note\" | \"llm-question\" | \"user-answer\" | \"system-note\", \"author\": \"llm\", \"body\": string, \"category\": \"note\" | \"decision\" | \"bug\" | \"task\", \"priority\": \"low\" | \"normal\" | \"high\" | \"urgent\", \"attachmentIds\": [], \"resolved\": false, \"pinned\": boolean } },",
  "        { \"kind\": \"resolve-note\", \"noteId\": string, \"resolved\": boolean },",
  "        { \"kind\": \"delete-note\", \"noteId\": string },",
  "        { \"kind\": \"create-node\", \"flowId\": string, \"node\": { \"id\": string, \"type\": string, \"title\": string, \"description\": string, \"stage\": \"planned\" | \"draft\", \"flags\": string[], optional \"subflowId\": string, optional \"groupId\": string, \"techStack\": string[], \"acceptanceCriteria\": string[], \"acceptanceChecks\": [{ \"id\": string, \"criterion\": string, \"testCommand\": string }], \"moduleProfileMode\": \"auto\" | \"manual\" | \"none\", optional \"moduleProfileId\": string } },",
  "        { \"kind\": \"create-edge\", \"flowId\": string, \"edge\": { \"source\": string, \"target\": string, \"label\": string } },",
  "        { \"kind\": \"create-subflow\", \"flowId\": string, \"subflow\": { \"id\": string, \"name\": string, \"parentNodeId\": string } },",
  "        { \"kind\": \"create-group\", \"flowId\": string, \"group\": { \"id\": string, \"name\": string, \"color\": string } },",
  "        { \"kind\": \"update-group\", \"flowId\": string, \"groupId\": string, \"patch\": { \"name\": string, \"color\": string } },",
  "        { \"kind\": \"update-subflow\", \"flowId\": string, \"subflowId\": string, \"patch\": { \"name\": string } },",
  "        { \"kind\": \"link-node-subflow\", \"flowId\": string, \"nodeId\": string, \"subflowId\": string | null },",
  "        { \"kind\": \"propose-run-profile\", \"mode\": \"create\" | \"replace\", \"profile\": object, \"reason\": string },",
  "        { \"kind\": \"start-agent-run\", \"flowId\": string, optional \"nodeId\": string, \"scope\": { \"kind\": \"project\" | \"flow\" | \"nodes\" | \"no-scope\", optional \"flowId\": string, \"nodeIds\": string[], optional \"label\": string }, \"promptSummary\": string, \"effort\": \"high\" | \"fast\", \"allowShell\": false, \"reusableApproval\": false, optional \"guidance\": { \"text\": string, \"evidence\": (\"last-error\" | \"trace-tail\" | \"latest-diff\" | \"runtime-log\" | \"node-notes\")[] } },",
  "        { \"kind\": \"stop-runtime-service\", \"serviceId\": string },",
  "        { \"kind\": \"restart-runtime-service\", \"serviceId\": string },",
  "        { \"kind\": \"retry-run\", \"runId\": string, \"guidance\": object },",
  "        { \"kind\": \"start-debugging-run\", \"runId\": string, \"guidance\": object },",
  "        { \"kind\": \"author-acceptance-tests\", \"flowId\": string, \"nodeId\": string },",
  "        { \"kind\": \"run-acceptance-checks\", \"flowId\": string, \"nodeId\": string },",
  "        { \"kind\": \"start-runtime-debug-run\", \"serviceId\": string, \"flowId\": string, \"guidance\": object },",
  "        { \"kind\": \"start-incident-debug-run\", \"flowId\": string, \"guidance\": { \"text\": string, \"evidence\": (\"last-error\" | \"trace-tail\" | \"latest-diff\" | \"runtime-log\" | \"node-notes\")[] } },",
  "        { \"kind\": \"delete-node\", \"flowId\": string, \"nodeId\": string },",
  "        { \"kind\": \"delete-edge\", \"flowId\": string, \"edgeId\": string },",
  "        { \"kind\": \"delete-subflow\", \"flowId\": string, \"subflowId\": string },",
  "        { \"kind\": \"delete-group\", \"flowId\": string, \"groupId\": string }",
  "      ]",
  "    }",
  "  }",
  "}",
  "Note pinning policy for add-note operations: set pinned true only for important decisions, unresolved risks, user-actionable follow-ups, or durable architectural context the user should see by default on the node. Set pinned false for traceability, audit/log notes, routine merge summaries, and low-value bookkeeping. Never claim a note is pinned unless its add-note operation has pinned true.",
  "Acceptance checks (node.acceptanceChecks) are the structured, testable form of acceptance criteria: each is { id, criterion, testCommand, status } and ArchiCode runs them on the next verified build, gating the node until they pass. You can read each node's acceptanceChecks (and their status) from context, and when the user asks to turn criteria into a checklist you can author them by including acceptanceChecks in update-node/create-node operations. To convert criteria for many nodes at once, put several update-node operations in a single changeSet. Only add checks for criteria that can be verified by an automated test command; leave genuinely untestable criteria as prose. Do not add checks to note/doc/decision/external-actor nodes. moduleProfileMode controls build-module binding for a node: auto means unresolved/implicit, manual means moduleProfileId is pinned, and none opts out. Emit these as ordinary changeSet operations; ArchiCode applies them through the user's normal research graph-change flow (auto-applied or shown as a review card depending on their auto-approve settings) — do not assume they are applied instantly or claim they were.",
  "Implementation scope is not ordinary user-authored graph intent. Treat node.implementationScope as bounded, best-effort navigation hints that may be incomplete, wrong, or stale. Use checkedAt to judge when the mapping was last evaluated, read it for orientation, verify it against current project files, and never treat own/share/cover as permissions or hard edit boundaries. Only propose an implementationScope update when the user explicitly asks to correct/refresh the mapping or inspected code provides concrete evidence of a mismatch; use source chat-agent and no more than 24 claims. ArchiCode stamps checkedAt when an accepted update is persisted.",
  "Evidence order for code mapping: current inspected source is authoritative; implementationScope is stronger structural orientation than local semantic retrieval; semantic matches are secondary discovery candidates only. They may broaden inspection but never prove implementation, dependencies, ownership, edit scope, or graph truth.",
  "Only answer is required inside archicodeResearch. Include summary when useful for future context. Include changeSet only after the user has affirmed the described graph-edit scope, or when the user explicitly asks to show or prepare the review card now.",
  "Include canvasAction whenever the user explicitly asks for a reversible visual canvas action. A prose promise does nothing: never claim selection, focus, switching, panning, centering, or zooming is happening unless the same response includes canvasAction. It applies immediately after the response without a graph review card. Use replace plus nodeIds/groupIds for visual selection; fit to focus targets; center uses graph coordinates; pan dx/dy moves the view center in graph units; zoom-to sets an absolute level; zoom-by uses a factor greater than 1 to zoom in or below 1 to zoom out; preserve leaves that aspect unchanged. One action can target only one visible root/detail-flow layer.",
  "Do not directly edit project code files from Research chat. Source implementation belongs to graph/build runs. For any other project-scoped work, choose whatever guarded console actions materially advance the goal; normal risk classification and the user's approval settings apply.",
  "Queue action operations must keep allowShell and reusableApproval false unless the user explicitly asks to grant shell approval.",
  "Do not include providerId in queue action operations. ArchiCode chooses the implementation/debug provider from the user's enabled project settings.",
  `When queueing ${gaiaAgent.name} through AI Implement from Research, choose effort "fast" for small, localized, low-risk implementation or verification work; choose effort "high" for broader, riskier, multi-system, ambiguous, or long-horizon work. Do not choose "auto" from Research.`,
  `When queueing ${gaiaAgent.name} through AI Implement from Research, choose the run scope that best fits this specific implementation task, independent of the current chat scope. Always include scope on newly proposed start-agent-run operations. Use scope.kind "project" for broad app/project-wide work, "flow" for work centered on one flow, "nodes" for work centered on one or more concrete nodes, and "no-scope" only for trivial localized source edits that do not affect architecture, graph meaning, flow responsibilities, node acceptance criteria, data contracts, notes, or graph truth. nodeId is optional: include it as a primary anchor only when it exactly matches a real existing node or a node created in the same changeSet. Never copy flowId into nodeId. For flow-wide work with no node anchor, omit nodeId and use scope.kind "flow" with an empty scope.nodeIds array. For no-scope, omit nodeId and keep scope.nodeIds empty. This scope is an internal handoff to Gaia; do not mention the chosen scope in the visible answer unless the user explicitly asks about implementation scoping.`,
  `When queueing ${gaiaAgent.name} through AI Implement or ${pandoraAgent.name} through AI Debug from Research, you may include optional guidance.text and guidance.evidence to pass concise private handoff notes to the responsible agent. guidance.evidence is not for graph IDs; it may only contain last-error, trace-tail, latest-diff, runtime-log, or node-notes. Put graph/node/file/run/artifact IDs in guidance.text instead. Do not include guidance on Build/Run App target operations.`,
  "For create-node graph edits, place new nodes logically in relation to the surrounding graph. When the user gives placement instructions, always honor them and treat them as highest priority. You may return node.position as exact { x, y } or as a relative placement object { relativeToNodeId, placement }, or return node.positionHint with that relative shape; use whichever best fits the goal. ArchiCode auto-layout is only a fallback when no create-time placement intent is provided.",
  "For a root-level create-node, omit node.subflowId entirely. Only include subflowId when placing the node inside a real detail subflow, and only include groupId, parentId, or moduleProfileId when each points to a real graph item or run target. Never use an empty string as a placeholder for an optional ID.",
  "For existing-node visual repositioning that the user explicitly requests, use update-node patch.position. You may return exact coordinates { x, y } or a relative placement object { relativeToNodeId, placement } when the desired move is simply above, below, left, or right of another node.",
  "Never return an empty update-node patch. If you say you are moving or styling a node, include the actual persisted field change in patch.position or patch.visual.",
  "Valid change proposal example:",
  "```json",
  "{",
  "  \"archicodeResearch\": {",
  "    \"answer\": \"I can queue this as an implementation run for approval.\",",
  "    \"summary\": \"Suggested an implementation run for the selected node.\",",
  "    \"changeSet\": {",
  "      \"summary\": \"Queue implementation\",",
  "      \"operations\": [",
  "        {",
  "          \"kind\": \"start-agent-run\",",
  "          \"flowId\": \"flow-main\",",
  "          \"nodeId\": \"node-landing-page\",",
  "          \"scope\": { \"kind\": \"nodes\", \"flowId\": \"flow-main\", \"nodeIds\": [\"node-landing-page\"], \"label\": \"Landing page\" },",
  "          \"promptSummary\": \"Implement the landing page acceptance criteria.\",",
  "          \"effort\": \"fast\",",
  "          \"allowShell\": false,",
  "          \"reusableApproval\": false,",
  "          \"guidance\": {",
  "            \"text\": \"Follow the latest graph acceptance criteria and notes; prioritize the selected node and keep the scaffold minimal if the app is new.\",",
  "            \"evidence\": [\"node-notes\"]",
  "          }",
  "        }",
  "      ]",
  "    }",
  "  }",
  "}",
  "```"
].join("\n");

const researchSystemPrompt = [
  "You are ArchiCode's scoped research assistant.",
  "Your name is Archi. If asked who or what you are, explain that you are the Research chat agent inside ArchiCode: you help users understand the target project, plan new features, refine existing features, inspect runs/artifacts, and propose graph or queue actions for approval; you are not the direct coding agent. Preserve the active persona while conveying those facts rather than switching into a flat stock self-introduction.",
  "When the user asks what ArchiCode supports, what options exist, or whether the app can do something, use archicodeApp.capabilities as the current product capability manifest and archicodeApp.currentProjectOptions for the current project's secret-free configuration snapshot. Distinguish Research-chat actions from user-interface-only controls and from hosted/external MCP tools; do not imply that every app feature is directly callable from chat.",
  "If the user simply greets you or asks what you can do, reply in the active persona immediately in the first sentence and keep that same persona through the rest of the answer. If a non-default research personality is active, the greeting and the capability blurb that follows should both remain unmistakably in that voice rather than shifting into a generic assistant intro. Mention graph-to-code sync only as one brief capability alongside your other capabilities. Do not explain sync options, comparison scopes, or the approval flow unless the user specifically asks about syncing, drift, or external edits.",
  "Keep the active persona throughout the visible answer, including explanations, lists, clarifications, and follow-up sentences. Do not use one in-character opener followed by neutral generic helper prose.",
  "Answer the user's question directly from the scoped project graph context and, when enabled, current web research.",
  "The chat renderer supports Mermaid diagrams. When the user asks for a diagram and Mermaid is suitable, return valid diagram source in a fenced ```mermaid block; do not claim that rendering support is uncertain.",
  "The chat renderer automatically turns direct HTTPS image-file links and project-file image links into clickable thumbnails with clickable source links beneath them. When sharing an image, use Markdown image syntax, a direct Markdown link ending in png, jpg, jpeg, gif, webp, avif, bmp, or svg, or an image CDN URL whose format query parameter names one of those formats. For local project images, use the existing archicode://project-file/{projectRelativePath} format and never an absolute path or file:// URL.",
  "For substantive assigned work, own the investigation and tool trajectory until the objective is satisfied or a real approval, external event, blocker, cancellation, or resource boundary pauses it. Subagents own their delegated tactics; consume their returned evidence instead of repeating their work. ArchiCode derives host-visible goal and memory state from persisted events, so do not spend tool calls on bookkeeping or narrate internal state updates.",
  "The selected scope focuses your attention and context, but it does not limit what graph or queue changes you may prepare.",
  "When projectFiles are present, use the advertised project tools to list, search, and read project files/runs/runtime services/artifacts, and use the guarded console when a bounded project command materially advances the goal; do not assume all file contents, command output, or run artifacts are already in context.",
  "When mcpServers are present in context, enabled MCP servers are visible to research even when their permission mode is Ask. If an Ask MCP tool is called, ArchiCode blocks execution and returns a permission-required tool result; explain that the server exists but needs approval/trust before execution.",
  "Use archicode_project_manage_rules to inspect reusable guidance, decisions, live policies, their node attachments, each rule's reported implication, and current flow violations. Use action list_violations when the user asks about findings or before advising on work affected by a policy; filter by flow/node where useful, report whether the cached evaluation is current, stale, or unavailable, and do not omit unassigned file findings without saying so. Read the relevant rule before editing it. Guidance and decision rules provide durable context but do not lint; policy rules are deterministic local checks whose active violations appear on the canvas. Only an active policy with Error severity and Enforced enforcement can fail a source-changing run, and only for a violation introduced after that run's baseline.",
  "Rule create/update is the sole project-settings mutation available directly from Research chat. It must use archicode_project_manage_rules, never a graph changeSet or prose claim. Each create/update tool call pauses for a non-reusable approval of that exact payload; tell the user what will change and its effect, and never say it was applied until the approved tool call returns success. Reading rules does not require approval. If the user rejects a rule change, accept that decision and do not immediately submit it again.",
  "Respect projectConventions from context, especially agent instruction files such as AGENTS.md/CLAUDE.md/GEMINI.md, README.md, package scripts, and .gitignore, before proposing graph edits or build/run/debug orchestration.",
  "Use the web by default when the answer may depend on current external facts, package/API details, pricing, policies, or public documentation.",
  "If scoped context includes fetchedWebPages from user-provided URLs, use that fetched content as primary evidence before making search-index claims.",
  "Cite source URLs inline when web research is used.",
  "Do not propose or edit project source files. Source implementation belongs to Gaia through ArchiCode's AI Implement/build path, while focused repairs belong to Pandora through AI Debug.",
  `AI Implement can create a new codebase from the graph when the workspace has no scaffold and update an existing codebase later; its agent is ${gaiaAgent.title}, and the graph/nodes are the source of truth for what the code should become.`,
  "Graph relationship semantics are intentionally flexible. Treat edges as connections between nodes with project-specific labels, not as a typed parent/child or prerequisite system unless the context explicitly says so.",
  "Do not infer fixed semantics from an edge label alone. Labels such as navigation, style, data, ownership, sequence, or dependency wording are freeform project text and may mean different things in different graphs.",
  "Graph relationship semantics are carried by edges, their labels, node descriptions, and explicit user instructions. Do not invent extra hidden relationship systems that are not present in the persisted graph context.",
  "When edges, labels, and visual placement could support multiple interpretations, do not silently pick one as graph truth. Call out the ambiguity, explain the competing readings briefly, and prefer a proposal/review step over acting as though the relationship is already canonical.",
  "Do not cite a relationship that you just proposed, or that exists only in a pending/unreviewed changeSet, as evidence of preexisting graph truth. Distinguish clearly between current graph state, user instructions, and your own proposal.",
  `When proposing start-agent-run for ${gaiaAgent.name}, choose the implementation scope that best fits the user's requested task, independent of the current Research chat scope. Use scope.kind "project" for broad app/project-wide work, "flow" for work centered on one flow, "nodes" for work centered on one or more concrete nodes, and "no-scope" only for trivial localized source edits that do not affect architecture, graph meaning, flow responsibilities, node acceptance criteria, data contracts, notes, or graph truth. If the user asks for a no-scope-style quick code change that would contradict or materially affect existing nodes/flows, first say that the graph needs to change and propose graph edits/notes instead of queueing no-scope. Once graph truth is aligned, or when there is no desync risk, Gaia may inspect other graph context for references, but your chosen scope tells her where to focus edits, graph/node diffs, data, and notes. Treat the chosen scope as internal metadata between Research and Gaia; do not expose it in the visible answer unless the user asks about implementation scoping.`,
  "Use node fields, stages, flags/tags, acceptance criteria, notes, logs, artifacts, run history, and diff deltas to anchor that evolving truth before queueing implementation or debug work.",
  "Persistent project edits and agent queue actions must go through the ArchiCode review model: update bounded project metadata, update flow metadata, update nodes/edges, add/resolve/delete notes, create/delete graph objects, propose run profiles, or propose implementation/debug/verification queue starts for user approval. Directly starting an already configured Run App runtime is reversible runtime control, not an agent queue action.",
  "You may suggest graph changes only through an archicodeResearch JSON object with answer, summary, and optional changeSet.",
  "If the user asks you to edit, update, create, delete, move, or otherwise change the graph, first inspect/research enough to understand the affected nodes, edges, descriptions, acceptance criteria, and adjacent responsibilities. Propose a coherent graph change rather than an isolated edit: include related connection, description, or criterion updates when they are needed to keep the graph truthful; ask every clarification you need in the same scope-confirmation response, then ask exactly once whether this is the scope they want prepared as a review card. The visible scope-confirmation response must end with a direct confirmation question, for example: Should I prepare this exact scope as the graph review card? Never stop passively while waiting for confirmation. Do not show a card before that affirmative confirmation, and do not ask a second confirmation after it: the next affirmative reply should produce the card. For planning, brainstorming, or an unspecified improvement, discuss the direction without preparing a card until the user requests a concrete edit.",
  "When researchSessionMemory is present, treat it as durable chat memory: decisions, todos, links, questions, assumptions, references, and debug findings from earlier turns.",
  "All graph changes and queue actions are pending until the user approves them.",
  "graphEditingLock is project-wide and overrides graph scope only for persistence. When graphEditingLock.locked is true, a build, implementation, debug, verification, or review-waiting run already owns current graph truth. You may freely discuss, analyze, clarify, and design future graph/flow changes, call Picasso, and prepare a pending review-card changeSet. The card must remain pending: do not auto-approve it, do not claim it was applied, and explain that Apply is locked until the active run ends.",
  "Do not say you cannot edit the graph merely because direct application is gated. First confirm the concrete scope in chat once, then provide the pending review card immediately after that confirmation; the card's Apply/Reject controls or auto-approve setting decide whether it is applied.",
  "Do not include a changeSet for a vague request to propose, plan, brainstorm, or improve. A clear request to change a known graph item or create a described item is enough to begin scope confirmation, but the card comes only after the user confirms that scope.",
  "If the current message says a graph review was just completed, treat it as a system continuation after explicit user approval. Continue any remaining work that was already approved or unblocked by the applied graph changes; if another reviewable graph step is needed for that same approved direction, you may return the next changeSet.",
  "When active research orchestration todos are present, treat them as the current work queue for this chat. Continue the next open or unblocked item, avoid re-proposing work already marked done, and mark blocked work in your explanation when user input is needed.",
  "Respect locked or user-approved nodes. Do not mutate approved nodes; instead explain that a user revision is needed.",
  "Respect ignored nodes and flows. They exist for awareness only, are not part of the working set, and must not be changed, built, debugged, or used as queue targets unless the user restores them first.",
  `Supported changeSet operation kinds are ${researchGraphOperationKinds.join(", ")}.`,
  "start-run-profile remains parseable only for legacy saved proposals. Never emit it for new work; use archicode_project_start_runtime_service for an explicit interactive launch.",
  `Use start-agent-run to ask approval to queue ${gaiaAgent.name} through AI Implement, selecting scope.kind project/flow/nodes/no-scope for the task rather than blindly inheriting the chat scope. Use retry-run or start-debugging-run for existing runs. Use start-runtime-debug-run for an active runtime service, and start-incident-debug-run for open bug notes/incidents/failed runs; these debugging paths belong to ${pandoraAgent.name}. Always include flowId and scope on new start-agent-run proposals. nodeId is optional and may be included only when it identifies a real existing node or a node created in the same changeSet; never put a flow ID in nodeId. Omit nodeId for unanchored flow/project work and for no-scope work. Keep allowShell/reusableApproval false unless the user explicitly asked to grant shell approval. Never choose a provider from Research; ArchiCode resolves the provider from settings.`,
  "Runtime lifecycle control is not a graph edit or agent queue action and does not need the graph scope-confirmation exchange. When the user explicitly asks to launch, stop, or restart an already configured app/site/runtime, inspect exact profiles/services/targets when needed and call archicode_project_start_runtime_service, archicode_project_stop_runtime_service, or archicode_project_restart_runtime_service in that turn. These act directly: do not emit start-run-profile, stop-runtime-service, or restart-runtime-service; do not create a review card; and do not claim an Activity run was queued.",
  "Before proposing any new queue start, check activeQueue, queue, recentRuns, runtimeServices, and orchestration todos already in context. If similar work is already active, already queued, or clearly overlaps enough to risk contradiction, duplication, or wasted work, do not propose another new queue start yet; explain the conflict and prefer monitoring, retrying, debugging, or waiting unless the user explicitly wants to replace or supersede the existing work.",
  `For start-agent-run, retry-run, start-debugging-run, start-runtime-debug-run, and start-incident-debug-run, include optional guidance when your chat context would help ${gaiaAgent.name} or ${pandoraAgent.name} focus. Keep it concise, factual, and grounded in graph state, user decisions, notes, artifacts, logs, or files you inspected. Use guidance.evidence only for allowed evidence selectors, never graph IDs.`,
  "Before proposing queue or runtime actions, inspect relevant runs, plans, traces, artifacts, configured run profiles, runtime services, discoverable targets, or project files using tools when the needed evidence is not already in context. After a queued run or runtime exists, monitor it by reading run/service state and logs in later turns rather than claiming completion from the proposal alone.",
  "Use create-flow to create a new top-level flow (including its nodes, edges, subflows, and groups when the requested scope is already concrete). Use update-flow to rename/update a top-level flow. Use update-subflow to rename an existing detail flow/subflow. Use link-node-subflow to set or clear the existing Opens detail flow relation for a node. Use create-subflow with subflow.parentNodeId only when creating a new detail flow.",
  "When creating nodes inside a detail flow/subflow, set create-node.flowId to the containing top-level flow id (for example flow-main), and set create-node.node.subflowId to the exact target subflow id. If the same changeSet creates a new subflow, choose a stable subflow.id up front, then reuse that exact id in link-node-subflow.subflowId and every child create-node.node.subflowId. Never put a subflow id in any operation.flowId; flowId names the containing top-level flow file, while node.subflowId is what places the node inside the detail subflow.",
  "When pointing the user to graph locations, use markdown links with internal graph hrefs from context, such as [Node title](archicode://node/flow-id/node-id), [Flow title](archicode://flow/flow-id), or [Subflow title](archicode://subflow/flow-id/subflow-id). Prefer graphLink values from context when available.",
  "When pointing the user to local project files or folders, use markdown links with project-scoped internal hrefs such as [src/main/index.ts](archicode://project-file/src/main/index.ts). Use project-relative paths only, URL-encode spaces or special characters, and do not use absolute paths or file:// links.",
  "You may propose visual-only node updates with update-node patch.visual using valid shape and backgroundColor values from context. If the user asks to color nodes, use visual.backgroundColor.",
  "For new graph nodes, choose a logical visual placement relative to the existing graph. If the user gives placement instructions, always honor them first. You may return node.position as exact { x, y } or as a relative placement object { relativeToNodeId, placement }, or return node.positionHint with that relative shape. ArchiCode auto-layout is only a fallback when no placement intent is provided.",
  "When the user explicitly asks to move an existing node on the canvas, you may use update-node patch.position with exact { x, y } or relative placement { relativeToNodeId, placement }. Do not claim a move happened unless the patch includes a real persisted position change.",
  "ArchiCode supports draw.io/diagrams.net XML import and export for the current flow or subflow scope; imported ambiguities may appear as node notes.",
  "Use update-project only for name, description, stackAssumptions, and environmentNotes; do not attempt provider, security, shell, web, MCP, or skills settings edits from research chat.",
  "Do not include a visible section named Summary. Put the compact future-context summary only in archicodeResearch.summary when returning JSON.",
  researchMemoryToolContract,
  researchChangeSetJsonContract
].join(" ");

export function resolvePhaseModelPolicy(provider: Provider, phase: LlmPhase): PhaseModelPolicy {
  const policy = {
    ...defaultPhaseModelPolicies[phase],
    ...(provider.phaseModelPolicies?.[phase] ?? {})
  };
  const modelOverride = availableProviderModelOverride(provider, policy.modelOverride);
  const modelOutputLimit = providerModelOutputTokenLimit(provider, modelOverride);
  return {
    ...policy,
    maxOutputTokens: policy.maxOutputTokens && modelOutputLimit
      ? Math.min(policy.maxOutputTokens, modelOutputLimit)
      : policy.maxOutputTokens,
    modelOverride
  };
}

export function availableProviderModelOverride(provider: Provider, modelOverride?: string): string | undefined {
  const model = modelOverride?.trim();
  if (!model) return undefined;
  if (provider.detectedAvailableModels.length && !provider.detectedAvailableModels.includes(model)) return undefined;
  return model;
}

export function inferModelCapabilityProfile(provider: Provider, modelOverride?: string): ModelCapabilityProfile {
  const model = (modelOverride ?? provider.model ?? "").toLowerCase();
  if (provider.kind === "offline-manual") {
    return {
      providerKind: provider.kind,
      model: provider.model,
      supportsTemperature: false,
      supportsReasoning: false,
      supportsThinking: false,
      supportsMaxOutputTokens: false,
      supportsImageInput: false,
      reasoningField: "none"
    };
  }
  if (provider.kind === "codex-local" || provider.kind === "claude-local" || provider.kind === "opencode-local" || provider.kind === "antigravity-local" || provider.kind === "grok-local" || provider.kind === "kimi-local") {
    return {
      providerKind: provider.kind,
      model: provider.model,
      supportsTemperature: false,
      supportsReasoning: false,
      supportsThinking: false,
      supportsMaxOutputTokens: false,
      supportsImageInput: true,
      reasoningField: "prompt-only"
    };
  }
  if (provider.kind === "anthropic-compatible") {
    const supportsThinking = model.includes("claude") && (
      model.includes("sonnet-5") ||
      model.includes("sonnet-4") ||
      model.includes("opus-4") ||
      model.includes("haiku-4") ||
      model.includes("3.7")
    );
    return {
      providerKind: provider.kind,
      model: provider.model,
      supportsTemperature: true,
      supportsReasoning: supportsThinking,
      supportsThinking,
      supportsMaxOutputTokens: true,
      supportsImageInput: providerSupportsImageInput(provider, modelOverride),
      reasoningField: supportsThinking ? "thinking" : "none"
    };
  }

  const supportsReasoning = /\b(o1|o3|o4|gpt-5)\b/.test(model) || model.includes("reasoning");
  return {
    providerKind: provider.kind,
    model: provider.model,
    supportsTemperature: true,
    supportsReasoning,
    supportsThinking: false,
    supportsMaxOutputTokens: true,
    supportsImageInput: providerSupportsImageInput(provider, modelOverride),
    reasoningField: supportsReasoning ? "reasoning_effort" : "none"
  };
}

export function reasoningEffort(mode: PhaseModelPolicy["reasoningMode"]): "low" | "medium" | "high" | undefined {
  if (mode === "off") return undefined;
  return mode;
}

export function phasePolicyText(phase: LlmPhase, policy: PhaseModelPolicy, profile: ModelCapabilityProfile): string {
  return [
    "ArchiCode phase model policy:",
    `- phase: ${phase}`,
    `- temperature: ${policy.temperature ?? "provider default"}`,
    `- reasoningMode: ${policy.reasoningMode}`,
    `- maxOutputTokens: ${policy.maxOutputTokens ?? "provider default"}`,
    `- modelOverride: ${policy.modelOverride ?? "none"}`,
    `- providerCapability: temperature=${profile.supportsTemperature}, reasoning=${profile.supportsReasoning}, thinking=${profile.supportsThinking}, imageInput=${profile.supportsImageInput}`
  ].join("\n");
}

/**
 * User prompt for single-shot orchestrator runs, ordered most-stable-first:
 * skills prompt and project JSON lead, per-call state (phase, policy,
 * attachments, prompt summary) trails. Providers with implicit prefix caching
 * (OpenAI, DeepSeek, Qwen, ...) match on the exact serialized prefix, so the
 * large project context is reusable across the phases of a run only while it
 * sits ahead of everything that changes per call. Keep additions in
 * stability order: new stable content before "ArchiCode phase", volatile
 * content after it.
 */
export function orchestratorUserPromptParts(
  contextText: string,
  promptSummary: string,
  webSearchLine: string,
  phase: LlmPhase,
  policy: PhaseModelPolicy,
  profile: ModelCapabilityProfile,
  selectedSkillsPrompt = "",
  imageAttachments?: ProviderImageAttachment[],
  structuredSourceHandoff = false
): { stable: string; volatile: string } {
  return {
    stable: [
      selectedSkillsPrompt.trim(),
      "Project JSON context:",
      contextText
    ].join("\n"),
    volatile: [
      "",
      `ArchiCode phase: ${phase}.`,
      phaseHandoffInstructions(phase, structuredSourceHandoff),
      phasePolicyText(phase, policy, profile),
      imageAttachmentText(imageAttachments),
      webSearchLine,
      "",
      `Prompt summary: ${promptSummary}`
    ].join("\n")
  };
}

export function orchestratorUserPromptText(
  contextText: string,
  promptSummary: string,
  webSearchLine: string,
  phase: LlmPhase,
  policy: PhaseModelPolicy,
  profile: ModelCapabilityProfile,
  selectedSkillsPrompt = "",
  imageAttachments?: ProviderImageAttachment[],
  structuredSourceHandoff = false
): string {
  const parts = orchestratorUserPromptParts(contextText, promptSummary, webSearchLine, phase, policy, profile, selectedSkillsPrompt, imageAttachments, structuredSourceHandoff);
  return `${parts.stable}\n${parts.volatile}`;
}

export async function imageAttachmentsForPrompt(images: ProviderImageAttachment[] | undefined): Promise<Array<ProviderImageAttachment & { data: string }>> {
  const supportedImages = (images ?? []).filter((image) => image.mediaType.startsWith("image/"));
  const encoded: Array<ProviderImageAttachment & { data: string }> = [];
  for (const image of supportedImages.slice(0, 6)) {
    encoded.push({
      ...image,
      data: (await readFile(image.path)).toString("base64")
    });
  }
  return encoded;
}

function imageSourceName(image: ProviderImageAttachment): string {
  if (image.source === "message") return "chat-message-attachment";
  if (image.source === "context") return "node-note-attachment";
  return "image";
}

export function imageLabelText(image: ProviderImageAttachment, index: number): string {
  return `Image ${index + 1} source=${imageSourceName(image)} title=${image.title}. ${image.source === "message"
    ? "This image was attached to the current chat message by the user."
    : image.source === "context"
      ? "This image came from a scoped node/note attachment. It is project context, not a current chat-message upload."
      : "This image is available context."}`;
}

export function imageAttachmentText(images: ProviderImageAttachment[] | undefined): string {
  if (!images?.length) return "Attached images: none";
  const formatImage = (image: ProviderImageAttachment): string => {
    const label = image.sourceLabel ? ` [${image.sourceLabel}]` : "";
    return `- ${image.title}${label}: ${image.path} (${image.mediaType})`;
  };
  const messageImages = images.filter((image) => image.source === "message");
  const contextImages = images.filter((image) => image.source === "context");
  const uncategorizedImages = images.filter((image) => image.source !== "message" && image.source !== "context");
  if (messageImages.length) {
    return [
      "Attached images (current chat message only):",
      "The user attached only the images in this section to their current chat message. If the user says \"the image I attached\" or similar, answer using only these current-message images.",
      ...messageImages.map(formatImage),
      contextImages.length
        ? "Node/note image context (not current chat-message attachments). These are also available as visual inputs when the user asks about node notes or project context:"
        : "",
      ...contextImages.map(formatImage),
      ...(uncategorizedImages.length ? ["Other available images:", ...uncategorizedImages.map(formatImage)] : [])
    ].filter(Boolean).join("\n");
  }
  return [
    "Attached images:",
    contextImages.length
      ? "Context images from scoped graph notes/notes. There are no current chat-message image attachments in this turn:"
      : "Context images from scoped graph notes/notes: none",
    ...contextImages.map(formatImage),
    ...(uncategorizedImages.length ? ["Other available images:", ...uncategorizedImages.map(formatImage)] : [])
  ].join("\n");
}

const maxTextAttachmentCharsPerFile = 20_000;
const maxTextAttachmentCharsTotal = 60_000;

export async function textAttachmentText(attachments: ProviderTextAttachment[] | undefined): Promise<string> {
  if (!attachments?.length) return "Attached text documents: none";
  const lines = [
    "Attached text documents:",
    "Text documents uploaded with the current chat message are included below. Node/note text-document attachments are normally listed only as metadata in scoped context; if any appear here, they were included because the user asked for their contents.",
    ""
  ];
  let remaining = maxTextAttachmentCharsTotal;
  for (const attachment of attachments.slice(0, 8)) {
    if (remaining <= 0) {
      lines.push("[additional text attachments omitted due to context budget]");
      break;
    }
    const label = attachment.sourceLabel ? ` [${attachment.sourceLabel}]` : "";
    const extracted = await extractTextDocument(attachment.path, attachment.mediaType);
    const text = extracted.text.slice(0, Math.min(maxTextAttachmentCharsPerFile, remaining));
    remaining -= text.length;
    const truncated = extracted.text.length > text.length ? "\n[truncated]" : "";
    lines.push(`--- ${attachment.title}${label} (${attachment.mediaType}) ---`);
    if (extracted.extracted) lines.push("[text extracted from document attachment]");
    for (const warning of extracted.warnings.slice(0, 3)) lines.push(`[extraction warning] ${warning}`);
    lines.push(text + truncated);
    lines.push(`--- end ${attachment.title} ---`);
  }
  return lines.join("\n");
}

export async function appendTextAttachmentBlock(text: string, attachments: ProviderTextAttachment[] | undefined): Promise<string> {
  if (!attachments?.length) return text;
  return [text, "", await textAttachmentText(attachments)].join("\n");
}

const RESEARCH_PROMPT_MESSAGE_LIMIT = 64;
const RESEARCH_PROMPT_HISTORY_TOKEN_BUDGET = 20000;
/** After the window overflows, evict oldest messages down to this fill ratio. */
const RESEARCH_HISTORY_RETAIN_RATIO = 0.75;

/**
 * Selects the most recent messages that fit within the message-count and
 * token-budget window (newest-first, then restored to chronological order).
 * Shared by the flattened codex/offline prompt and the structured multi-turn
 * thread so both honour the same context budget.
 */
/**
 * Start index of the recent-history window, using batched eviction: dropping
 * one old message every turn changes the prompt prefix every turn, defeating
 * provider prompt caching for the whole history block. Here the window start
 * only moves when the budget overflows, and then jumps far enough to free 25%
 * of the budget in one step, so the prefix stays byte-identical for many turns
 * between evictions. Replaying the eviction sequence from the start of the
 * session keeps the window deterministic across turns without persisted state:
 * appending new messages never changes where earlier evictions landed.
 * Memory compaction uses this same computation so nothing leaves the prompt
 * window without being folded into research memory first.
 */
export function researchHistoryWindowStart(
  messages: ResearchChatMessage[],
  messageLimit = RESEARCH_PROMPT_MESSAGE_LIMIT,
  tokenBudget = RESEARCH_PROMPT_HISTORY_TOKEN_BUDGET
): number {
  const retainTokens = Math.max(1, Math.floor(tokenBudget * RESEARCH_HISTORY_RETAIN_RATIO));
  const retainCount = Math.max(1, Math.floor(messageLimit * RESEARCH_HISTORY_RETAIN_RATIO));
  const messageTokens = messages.map((message) => estimateTextTokens(message?.content ?? "") + 8);
  let start = 0;
  let usedTokens = 0;
  for (let index = 0; index < messages.length; index += 1) {
    usedTokens += messageTokens[index] ?? 0;
    if (usedTokens <= tokenBudget && index - start + 1 <= messageLimit) continue;
    while (start < index && (usedTokens > retainTokens || index - start + 1 > retainCount)) {
      usedTokens -= messageTokens[start] ?? 0;
      start += 1;
    }
  }
  return start;
}

function selectResearchHistoryMessages(
  messages: ResearchChatMessage[],
  messageLimit = RESEARCH_PROMPT_MESSAGE_LIMIT,
  tokenBudget = RESEARCH_PROMPT_HISTORY_TOKEN_BUDGET
): ResearchChatMessage[] {
  return messages
    .slice(researchHistoryWindowStart(messages, messageLimit, tokenBudget))
    .filter((message): message is ResearchChatMessage => Boolean(message));
}

function formatResearchMessages(messages: ResearchChatMessage[], messageLimit = RESEARCH_PROMPT_MESSAGE_LIMIT, tokenBudget = RESEARCH_PROMPT_HISTORY_TOKEN_BUDGET): string {
  if (!messages.length) return "none";
  const selected = selectResearchHistoryMessages(messages, messageLimit, tokenBudget);
  return selected.map((message) => {
    const prefix = message.role === "assistant" ? "AI Assistant" : message.role === "user" ? "User" : "System";
    return `${prefix}: ${message.content}`;
  }).join("\n\n");
}

function researchPromptSummary(userMessage: string, options: ResearchProviderOptions): string {
  return [
    "Research chat request.",
    options.webSearchEnabled ? "Web is enabled." : "Web is disabled.",
    options.sessionSummary ? `Session summary: ${options.sessionSummary}` : "",
    `User message: ${userMessage}`
  ].filter(Boolean).join("\n");
}

type ModelMetadata = Record<string, unknown>;

export function extractModelIdsFromModels(payload: unknown): string[] {
  const records = modelRecords(payload);
  const ids = records
    .filter(isTextGenerationModelRecord)
    .map(readModelId)
    .filter((value): value is string => Boolean(value));
  return [...new Set(ids)].sort((left, right) => {
    const leftCreated = readCreatedAt(records.find((record) => record.id === left || record.slug === left || record.name === left || record.model === left));
    const rightCreated = readCreatedAt(records.find((record) => record.id === right || record.slug === right || record.name === right || record.model === right));
    if (leftCreated && rightCreated && leftCreated !== rightCreated) return rightCreated - leftCreated;
    if (leftCreated && !rightCreated) return -1;
    if (!leftCreated && rightCreated) return 1;
    return left.localeCompare(right);
  });
}

export function extractModelCapabilitiesFromModels(
  payload: unknown,
  providerKind: Provider["kind"]
): ProjectSettings["providers"][number]["detectedModelCapabilities"] {
  const capabilities: ProjectSettings["providers"][number]["detectedModelCapabilities"] = {};
  for (const record of modelRecords(payload)) {
    const modelId = readModelId(record);
    if (!modelId || !isTextGenerationModelRecord(record)) continue;
    capabilities[modelId] = {
      supportsImageInput: readImageSupportFromModelRecord(record, providerKind, modelId),
      contextWindowTokens: readContextWindow(record),
      maxOutputTokens: readMaxOutputTokens(record)
    };
  }
  return capabilities;
}

function isTextGenerationModelRecord(record: ModelMetadata): boolean {
  // Provider catalogs are not consistent enough for a positive family allowlist.
  // Prefer declared output capabilities; when metadata is absent, keep unknown
  // families and reject only IDs that clearly advertise a non-text purpose.
  const outputModalities = readOutputModalities(record);
  if (outputModalities.length) {
    return outputModalities.every((modality) => modality === "text" || modality === "output_text" || modality === "json");
  }

  const declaredPurpose = [
    record.type,
    record.task,
    record.task_type,
    record.taskType,
    record.model_type,
    record.modelType,
    record.endpoint_type,
    record.endpointType,
    nestedRecordValue(record.capabilities, "task"),
    nestedRecordValue(record.capabilities, "type")
  ].flatMap((value) => collectModalityStrings(value));
  if (declaredPurpose.some(isExplicitNonTextPurpose)) return false;

  const id = readModelId(record)?.toLowerCase() ?? "";
  return ![
    "embedding",
    "tts",
    "whisper",
    "transcribe",
    "speech",
    "audio",
    "image",
    "dall-e",
    "sora",
    "moderation",
    "realtime",
    "search",
    "rerank"
  ].some((blocked) => id.includes(blocked));
}

function readOutputModalities(record: ModelMetadata): string[] {
  const explicit = [
    record.output_modalities,
    record.outputModalities,
    record.supported_output_modalities,
    record.supportedOutputModalities,
    nestedRecordValue(record.capabilities, "output_modalities"),
    nestedRecordValue(record.capabilities, "outputModalities"),
    nestedRecordValue(record.architecture, "output_modalities"),
    nestedRecordValue(record.architecture, "outputModalities")
  ].flatMap((value) => collectModalityStrings(value));
  if (explicit.length) return [...new Set(explicit)];

  const directional = [record.modality, nestedRecordValue(record.architecture, "modality")]
    .flatMap((value) => collectModalityStrings(value))
    .filter((value) => value.includes("->"))
    .flatMap((value) => value.split("->").at(-1)?.split("+") ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(directional)];
}

function isExplicitNonTextPurpose(value: string): boolean {
  const normalized = value.replace(/[\s_]+/g, "-");
  return /^(?:audio|embedding|embeddings|feature-extraction|image|image-generation|moderation|rerank|reranking|search|speech|text-to-speech|transcription|video)(?:-|$)/.test(normalized);
}

function readModelId(record: ModelMetadata): string | undefined {
  const value = record.id ?? record.slug ?? record.name ?? record.model;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function extractContextWindowFromModels(payload: unknown, modelId?: string): number | undefined {
  const records = modelRecords(payload);
  const model = modelId?.trim();
  const knownFloor = knownContextWindowFloorForModel(model);
  const selected = model
    ? records.find((record) => record.id === model || record.slug === model || record.name === model || record.model === model)
    : records[0];
  if (!selected) return knownFloor;

  const detected = readContextWindow(selected);
  if (knownFloor && (!detected || detected < knownFloor)) return knownFloor;
  return detected;
}

function knownContextWindowFloorForModel(modelId?: string): number | undefined {
  return knownContextWindowFloorTokensForModel(modelId);
}

function modelRecords(payload: unknown): ModelMetadata[] {
  const records = Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data
    : Array.isArray((payload as { models?: unknown }).models)
      ? (payload as { models: unknown[] }).models
    : Array.isArray(payload)
      ? payload
      : [];
  return records.filter((record): record is ModelMetadata => Boolean(record && typeof record === "object"));
}

function readCreatedAt(record?: ModelMetadata): number | undefined {
  if (!record) return undefined;
  const created = record.created ?? record.created_at ?? record.createdAt;
  if (typeof created === "number" && Number.isFinite(created)) return created;
  if (typeof created === "string") {
    const timestamp = Date.parse(created);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  return undefined;
}

function readImageSupportFromModelRecord(record: ModelMetadata, providerKind: Provider["kind"], modelId: string): boolean {
  const directBoolean = [
    record.supports_image_input,
    record.supportsImageInput,
    record.supports_vision,
    record.supportsVision,
    nestedRecordValue(record.capabilities, "supports_image_input"),
    nestedRecordValue(record.capabilities, "supportsImageInput"),
    nestedRecordValue(record.capabilities, "supports_vision"),
    nestedRecordValue(record.capabilities, "supportsVision"),
    nestedRecordValue(record.capabilities, "vision")
  ].find((value) => typeof value === "boolean");
  if (typeof directBoolean === "boolean") return directBoolean;

  const modalityValues = [
    record.modalities,
    record.input_modalities,
    record.inputModalities,
    record.supported_modalities,
    record.supportedModalities,
    nestedRecordValue(record.capabilities, "modalities"),
    nestedRecordValue(record.capabilities, "input_modalities"),
    nestedRecordValue(record.capabilities, "inputModalities"),
    nestedRecordValue(record.architecture, "modalities"),
    nestedRecordValue(record.architecture, "input_modalities"),
    nestedRecordValue(record.architecture, "inputModalities")
  ];
  if (modalityValues.some(hasImageLikeModality)) return true;
  if (modalityValues.some(hasExplicitTextOnlyModality)) return false;

  return heuristicImageInputSupportStatus(providerKind, modelId) === "supported";
}

function nestedRecordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function hasImageLikeModality(value: unknown): boolean {
  return collectModalityStrings(value).some((entry) =>
    entry === "image" ||
    entry === "images" ||
    entry === "input_image" ||
    entry.includes("vision") ||
    entry.includes("multimodal") ||
    entry.includes("omni") ||
    entry.includes("pixtral") ||
    entry.includes("llava") ||
    entry.includes("moondream") ||
    /(?:^|[-_.])(vl|img)(?:[-_.]|$)/.test(entry)
  );
}

function hasExplicitTextOnlyModality(value: unknown): boolean {
  const entries = collectModalityStrings(value);
  return entries.length > 0 && entries.every((entry) => entry === "text" || entry === "input_text");
}

function collectModalityStrings(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string") return [value.trim().toLowerCase()].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((entry) => collectModalityStrings(entry, depth + 1));
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap((entry) => collectModalityStrings(entry, depth + 1));
  return [];
}

function readContextWindow(record: ModelMetadata): number | undefined {
  const keys = [
    "max_input_tokens",
    "maxInputTokens",
    "context_window",
    "contextWindow",
    "context_length",
    "contextLength",
    "max_context_length",
    "maxContextLength",
    "max_context_tokens",
    "maxContextTokens",
    "max_position_embeddings",
    "n_ctx"
  ];

  for (const key of keys) {
    const value = record[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const nested = readContextWindow(value as ModelMetadata);
      if (nested) return nested;
    }
  }
  return undefined;
}

function readMaxOutputTokens(record: ModelMetadata): number | undefined {
  const keys = [
    "max_output_tokens",
    "maxOutputTokens",
    "max_completion_tokens",
    "maxCompletionTokens",
    "output_token_limit",
    "outputTokenLimit",
    "max_tokens"
  ];

  for (const key of keys) {
    const value = record[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const nested = readMaxOutputTokens(value as ModelMetadata);
      if (nested) return nested;
    }
  }
  return undefined;
}

function summarizeLocally(text: string): string {
  const clipped = text.slice(0, 9000);
  return [
    "Context exceeded the configured threshold and was compacted locally.",
    "The summary preserves project settings, selected node intent, recent notes, recent run status, and artifact references.",
    clipped
  ].join("\n\n");
}
