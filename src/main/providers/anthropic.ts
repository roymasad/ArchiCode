import type { LlmPhase, ModelCapabilityProfile, PhaseModelPolicy, ProjectSettings } from "../../shared/schema";
import { defaultPhaseModelPolicies } from "../../shared/schema";
import type { ProviderMcpTool } from "../mcp";
import {
  type Provider,
  type ProviderCallOptions,
  type ProviderImageAttachment,
  type RawLlmUsage,
  type ResearchProviderContinuation,
  type ResearchProviderOptions,
  type ResearchThreadTurn,
  appendTextAttachmentBlock,
  createConsecutiveToolCallLoopDetector,
  createUsageAccumulator,
  extractContextWindowFromModels,
  extractModelCapabilitiesFromModels,
  extractModelIdsFromModels,
  extractionSystemPrompt,
  imageAttachmentText,
  imageAttachmentsForPrompt,
  imageLabelText,
  inferModelCapabilityProfile,
  orchestratorSystemPrompt,
  phaseHandoffInstructions,
  phasePolicyText,
  reasoningEffort,
  researchCurrentMessageText,
  researchHistoryThread,
  researchStableContextText,
  researchSystemInstructions,
  resolveModelId
} from "../providers";
import { anthropicMcpTools } from "./openai";

export function extractAnthropicUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
} | undefined): RawLlmUsage {
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    thinkingTokens: usage.output_tokens_details?.thinking_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens
  };
}

export const anthropicAdaptiveDefaultMaxTokens: Record<LlmPhase, number> = {
  planning: 64000,
  coding: 128000,
  debugging: 64000,
  review: 32000,
  verifying: 16000,
  summarizing: 16000,
  brainstorming: 32000
};

export const anthropicAdaptiveDefaultEffort: Record<LlmPhase, "low" | "medium" | "high"> = {
  planning: "medium",
  coding: "medium",
  debugging: "medium",
  review: "medium",
  verifying: "low",
  summarizing: "low",
  brainstorming: "medium"
};

export function anthropicThinkingBudget(effort: "low" | "medium" | "high", maxTokens: number): number {
  return effort === "high" ? Math.min(4096, Math.max(1024, Math.floor(maxTokens * 0.5))) : effort === "medium" ? 1024 : 512;
}

export function supportsAnthropicAdaptiveThinking(model: string | undefined): boolean {
  const normalized = (model ?? "").toLowerCase();
  return (
    normalized.includes("claude-sonnet-5") ||
    normalized.includes("claude-sonnet-4-6") ||
    normalized.includes("claude-opus-4-6") ||
    normalized.includes("claude-opus-4-7") ||
    normalized.includes("claude-opus-4-8")
  );
}

export function isAnthropicAdaptiveModel(policy: PhaseModelPolicy, profile: ModelCapabilityProfile): boolean {
  return supportsAnthropicAdaptiveThinking(policy.modelOverride?.trim() || profile.model);
}

export function anthropicMaxTokensForPhase(phase: LlmPhase, policy: PhaseModelPolicy, profile: ModelCapabilityProfile): number {
  const configured = policy.maxOutputTokens ?? defaultPhaseModelPolicies[phase].maxOutputTokens ?? 1800;
  if (!isAnthropicAdaptiveModel(policy, profile)) return configured;
  const defaultMaxTokens = defaultPhaseModelPolicies[phase].maxOutputTokens;
  if (configured !== defaultMaxTokens) return configured;
  return anthropicAdaptiveDefaultMaxTokens[phase];
}

export function anthropicEffortForPhase(phase: LlmPhase, policy: PhaseModelPolicy, profile: ModelCapabilityProfile): "low" | "medium" | "high" | undefined {
  const effort = reasoningEffort(policy.reasoningMode);
  if (!effort || !isAnthropicAdaptiveModel(policy, profile)) return effort;
  if (policy.reasoningMode !== defaultPhaseModelPolicies[phase].reasoningMode) return effort;
  return anthropicAdaptiveDefaultEffort[phase];
}

export function applyAnthropicGenerationControls(
  body: Record<string, unknown>,
  phase: LlmPhase,
  policy: PhaseModelPolicy,
  profile: ModelCapabilityProfile,
  maxTokens: number
): void {
  const effort = anthropicEffortForPhase(phase, policy, profile);
  if (profile.reasoningField === "thinking" && effort) {
    if (isAnthropicAdaptiveModel(policy, profile)) {
      body.thinking = { type: "adaptive", display: "omitted" };
      body.output_config = { effort };
    } else {
      body.thinking = {
        type: "enabled",
        budget_tokens: anthropicThinkingBudget(effort, maxTokens)
      };
    }
    if (profile.supportsTemperature) body.temperature = 1;
    return;
  }
  if (profile.supportsTemperature && policy.temperature !== undefined) body.temperature = policy.temperature;
}

export type AnthropicMessagePayload = {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    // Anthropic streams input/cache fields in the `message_start` event and
    // output/thinking in `message_delta`; `input_tokens` is already non-cached.
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
};

export function anthropicPayloadText(payload: AnthropicMessagePayload, label: string): string {
  const content = payload.content ?? [];
  const text = content.map((part) => part.type === "text" ? part.text : undefined).filter(Boolean).join("\n");
  if (text.trim()) return text;
  const contentTypes = content.map((part) => part.type).filter(Boolean).join(", ") || "none";
  const usage = payload.usage
    ? ` Usage: input=${payload.usage.input_tokens ?? "?"}, output=${payload.usage.output_tokens ?? "?"}, thinking=${payload.usage.output_tokens_details?.thinking_tokens ?? "?"}.`
    : "";
  const stop = payload.stop_reason ? ` Stop reason: ${payload.stop_reason}.` : "";
  if (payload.stop_reason === "max_tokens") {
    throw new Error(`${label} returned no text before hitting max_tokens.${usage} Lower Anthropic effort/reasoning mode, increase max_tokens, or retry with a smaller source-file slice.`);
  }
  throw new Error(`${label} returned no text content. Content block types: ${contentTypes}.${stop}${usage}`);
}

export function shouldRetryAnthropicWithoutThinking(error: unknown, body: Record<string, unknown>): boolean {
  if (!("thinking" in body) && !("output_config" in body)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /returned no text before hitting max_tokens/i.test(message) && /thinking=(?!0\b)\d+/i.test(message);
}

export function anthropicBodyWithoutThinkingControls(
  body: Record<string, unknown>,
  policy: PhaseModelPolicy,
  profile: ModelCapabilityProfile
): Record<string, unknown> {
  const retryBody = { ...body };
  delete retryBody.thinking;
  delete retryBody.output_config;
  if (profile.supportsTemperature && policy.temperature !== undefined) {
    retryBody.temperature = policy.temperature;
  } else {
    delete retryBody.temperature;
  }
  return retryBody;
}

export function explainProviderFetchError(label: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|headers timeout|terminated|aborted|timeout/i.test(message)) {
    return new Error(`${label} transport failed: ${message}. The provider request likely timed out or the network connection was interrupted before a response arrived. For long Anthropic code generations, retry with streaming/omitted thinking, lower effort, or a smaller source-file slice.`);
  }
  return error instanceof Error ? error : new Error(message);
}

export async function postAnthropicMessages(baseUrl: string, apiKey: string, body: Record<string, unknown>, label: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    throw explainProviderFetchError(label, error);
  }
}

export type AnthropicToolUse = { id: string; name: string; input: unknown };
export type AnthropicStreamResult = {
  text: string;
  toolUses: AnthropicToolUse[];
  stopReason?: string;
  usage?: AnthropicMessagePayload["usage"];
};

/**
 * Streams an Anthropic Messages response, surfacing text token deltas via
 * `onToken` while also accumulating any `tool_use` blocks (from
 * `content_block_start` + streamed `input_json_delta`) so the research tool loop
 * can stream every iteration instead of falling back to blocking requests.
 */
export async function streamAnthropicMessages(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  label: string,
  onToken?: (text: string) => void,
  signal?: AbortSignal,
  onUsage?: (raw: RawLlmUsage) => void
): Promise<AnthropicStreamResult> {
  const response = await postAnthropicMessages(baseUrl, apiKey, { ...body, stream: true }, label, signal);
  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error(`${label} streaming response did not include a body.`);

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let text = "";
  let stopReason: string | undefined;
  // Anthropic splits usage across two events: `message_start` carries
  // input_tokens + cache read/creation, `message_delta` carries output_tokens +
  // thinking. Merge both so cost reflects cached-token pricing.
  let startUsage: AnthropicMessagePayload["usage"];
  let deltaUsage: AnthropicMessagePayload["usage"];
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

  const consumeEvent = (eventText: string): void => {
    const dataLines = eventText.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, ""));
    if (!dataLines.length) return;
    const dataText = dataLines.join("\n");
    if (!dataText || dataText === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(dataText) as Record<string, unknown>;
    } catch {
      return;
    }
    const delta = event.delta as Record<string, unknown> | undefined;
    if (event.type === "message_start") {
      const message = event.message as Record<string, unknown> | undefined;
      const messageUsage = message?.usage as AnthropicMessagePayload["usage"] | undefined;
      if (messageUsage) startUsage = messageUsage;
    }
    if (event.type === "content_block_start") {
      const block = event.content_block as Record<string, unknown> | undefined;
      const index = event.index as number | undefined;
      if (typeof index === "number" && block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        toolBlocks.set(index, { id: block.id, name: block.name, json: "" });
      }
    }
    if (event.type === "content_block_delta") {
      const index = event.index as number | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        text += delta.text;
        onToken?.(delta.text);
      }
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && typeof index === "number") {
        const block = toolBlocks.get(index);
        if (block) block.json += delta.partial_json;
      }
    }
    if (event.type === "message_delta") {
      if (delta && typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
      const eventUsage = event.usage as AnthropicMessagePayload["usage"] | undefined;
      if (eventUsage) deltaUsage = eventUsage;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) consumeEvent(event);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeEvent(buffer);

  const toolUses = [...toolBlocks.values()].map((block) => {
    let input: unknown = {};
    try {
      input = block.json.trim() ? JSON.parse(block.json) : {};
    } catch {
      input = {};
    }
    return { id: block.id, name: block.name, input };
  });
  const mergedUsage: AnthropicMessagePayload["usage"] = {
    input_tokens: startUsage?.input_tokens,
    cache_read_input_tokens: startUsage?.cache_read_input_tokens,
    cache_creation_input_tokens: startUsage?.cache_creation_input_tokens,
    output_tokens: deltaUsage?.output_tokens,
    output_tokens_details: deltaUsage?.output_tokens_details
  };
  if (mergedUsage.input_tokens !== undefined || mergedUsage.output_tokens !== undefined) {
    onUsage?.(extractAnthropicUsage(mergedUsage));
  }
  return { text, toolUses, stopReason, usage: mergedUsage };
}

export async function callAnthropicStreamingMessages(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  label: string,
  onToken?: (text: string) => void,
  signal?: AbortSignal,
  onUsage?: (raw: RawLlmUsage) => void
): Promise<string> {
  const result = await streamAnthropicMessages(baseUrl, apiKey, body, label, onToken, signal, onUsage);
  return anthropicPayloadText(
    { content: result.text ? [{ type: "text", text: result.text }] : [], stop_reason: result.stopReason, usage: result.usage },
    label
  );
}

export async function anthropicImageContent(images: ProviderImageAttachment[] | undefined): Promise<Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>> {
  const content: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [];
  const encoded = await imageAttachmentsForPrompt(images);
  encoded.forEach((image, index) => {
    content.push({ type: "text", text: imageLabelText(image, index) });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType,
        data: image.data
      }
    });
  });
  return content;
}

export async function callAnthropicCompatible(
  provider: Provider,
  apiKey: string,
  contextText: string,
  promptSummary: string,
  webSearchEnabled: boolean,
  phase: LlmPhase,
  policy: PhaseModelPolicy,
  options: ProviderCallOptions = {}
): Promise<string> {
  const baseUrl = provider.baseUrl ?? "https://api.anthropic.com";
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  const body = buildAnthropicCompatibleBody(provider, contextText, promptSummary, webSearchEnabled, phase, policy, profile, options.selectedSkillsPrompt, options.imageAttachments, options.bareExtraction, options.structuredSourceHandoff);
  const imageContent = profile.supportsImageInput ? await anthropicImageContent(options.imageAttachments) : [];
  if (imageContent.length) {
    const messages = body.messages as Array<Record<string, unknown>>;
    const userMessage = messages.find((message) => message.role === "user");
    if (typeof userMessage?.content === "string") {
      userMessage.content = [{ type: "text", text: await appendTextAttachmentBlock(userMessage.content, options.textAttachments) }, ...imageContent];
    }
  } else if (options.textAttachments?.length) {
    const messages = body.messages as Array<Record<string, unknown>>;
    const userMessage = messages.find((message) => message.role === "user");
    if (typeof userMessage?.content === "string") userMessage.content = await appendTextAttachmentBlock(userMessage.content, options.textAttachments);
  }
  const modelId = resolveModelId(provider, policy);
  const acc = createUsageAccumulator();
  const emitAndReturn = (result: string): string => {
    const usage = acc.finalize(provider, modelId);
    if (usage.calls >= 1 && (usage.inputTokens > 0 || usage.outputTokens > 0)) options.onUsage?.(usage);
    return result;
  };
  const tools = anthropicMcpTools(options.mcpTools ?? []);
  if (tools.length) body.tools = tools;
  const messages = body.messages as Array<Record<string, unknown>>;
  if (!tools.length) {
    try {
      return emitAndReturn(await callAnthropicStreamingMessages(baseUrl, apiKey, body, "Anthropic-compatible provider", undefined, options.signal, acc.add));
    } catch (error) {
      if (!shouldRetryAnthropicWithoutThinking(error, body)) throw error;
      options.onProgress?.({
        stream: "stderr",
        text: "Anthropic thinking consumed the full response budget before returning text. Retrying once without Anthropic thinking controls."
      });
      return emitAndReturn(await callAnthropicStreamingMessages(
        baseUrl,
        apiKey,
        anthropicBodyWithoutThinkingControls(body, policy, profile),
        "Anthropic-compatible provider",
        undefined,
        options.signal,
        acc.add
      ));
    }
  }

  let completedToolRounds = 0;
  const toolLoopDetector = createConsecutiveToolCallLoopDetector();
  while (true) {
    // Roll the message-level cache breakpoint to the tail so each tool round
    // reuses the cached prefix (system + tools + project context + prior turns)
    // instead of re-billing the whole transcript.
    setRollingMessageCacheBreakpoint(messages);
    const response = await postAnthropicMessages(baseUrl, apiKey, body, "Anthropic-compatible provider", options.signal);

    if (!response.ok) {
      throw new Error(`Anthropic-compatible provider failed with ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json() as AnthropicMessagePayload;
    acc.add(extractAnthropicUsage(payload.usage));
    const content = payload.content ?? [];
    const toolUses = content.filter((part) => part.type === "tool_use" && part.id && part.name);
    if (!toolUses.length || !options.callMcpTool) {
      try {
        return emitAndReturn(anthropicPayloadText(payload, "Anthropic-compatible provider"));
      } catch (error) {
        if (completedToolRounds > 0 || !shouldRetryAnthropicWithoutThinking(error, body)) throw error;
        options.onProgress?.({
          stream: "stderr",
          text: "Anthropic thinking consumed the full response budget before returning text. Retrying once without Anthropic thinking controls."
        });
        const retryResponse = await postAnthropicMessages(
          baseUrl,
          apiKey,
          anthropicBodyWithoutThinkingControls(body, policy, profile),
          "Anthropic-compatible provider",
          options.signal
        );
        if (!retryResponse.ok) {
          throw new Error(`Anthropic-compatible provider failed with ${retryResponse.status}: ${await retryResponse.text()}`);
        }
        const retryPayload = await retryResponse.json() as AnthropicMessagePayload;
        acc.add(extractAnthropicUsage(retryPayload.usage));
        return emitAndReturn(anthropicPayloadText(retryPayload, "Anthropic-compatible provider"));
      }
    }
    messages.push({ role: "assistant", content });
    options.prepareToolBatch?.(toolUses.map((toolUse) => ({
      providerToolName: toolUse.name as string,
      argumentsJson: JSON.stringify(toolUse.input ?? {})
    })));
    const toolResults = [];
    const executedToolCalls = [];
    for (const toolUse of toolUses) {
      const providerToolName = toolUse.name as string;
      const argumentsJson = JSON.stringify(toolUse.input ?? {});
      toolLoopDetector.record(providerToolName, argumentsJson);
      const result = await options.callMcpTool({
        providerToolName,
        argumentsJson
      });
      executedToolCalls.push({ providerToolName, argumentsJson, result });
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result
      });
    }
    if (options.shouldCompleteToolBatch?.(executedToolCalls)) {
      const visibleText = content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();
      return emitAndReturn(visibleText || "Structured source handoff completed.");
    }
    messages.push({ role: "user", content: toolResults });
    completedToolRounds += 1;
  }
}

export async function callAnthropicResearch(
  provider: Provider,
  apiKey: string,
  userMessage: string,
  options: ResearchProviderOptions,
  policy: PhaseModelPolicy
): Promise<string> {
  const baseUrl = provider.baseUrl ?? "https://api.anthropic.com";
  const body = await buildAnthropicResearchBody(provider, userMessage, options, policy);
  const modelId = resolveModelId(provider, policy);
  const acc = createUsageAccumulator();
  const emitUsage = (): void => {
    const usage = acc.finalize(provider, modelId);
    if (usage.calls >= 1 && (usage.inputTokens > 0 || usage.outputTokens > 0)) options.onUsage?.(usage);
  };
  const emitAndReturn = (result: string): string => {
    emitUsage();
    return result;
  };
  const tools = anthropicMcpTools(options.mcpTools ?? []);
  if (!tools.length) {
    // Cache the conversation tail so later chat turns reuse the prior transcript
    // in addition to the already-cached stable system prefix.
    setRollingMessageCacheBreakpoint(body.messages as Array<Record<string, unknown>>);
    return emitAndReturn(await callAnthropicStreamingMessages(baseUrl, apiKey, body, "Anthropic-compatible research provider", options.onToken, options.signal, acc.add));
  }
  body.tools = [...(Array.isArray(body.tools) ? body.tools : []), ...tools];
  const messages = body.messages as Array<Record<string, unknown>>;
  const label = "Anthropic-compatible research provider";
  const toolLoopDetector = createConsecutiveToolCallLoopDetector();

  // Resume: replace the working transcript with the persisted continuation and
  // splice in the just-approved tool result, so the pre-approval work is reused.
  if (options.resumeContinuation?.transport === "anthropic" && options.resumeContinuation.messages) {
    body.messages = anthropicResumeMessages(options.resumeContinuation);
  }

  while (true) {
    // Roll the cache breakpoint to the transcript tail so each tool round reuses
    // the cached prefix instead of re-billing the accumulated tool results.
    setRollingMessageCacheBreakpoint(messages);
    // Stream every iteration so tool-assisted turns are no longer silent.
    const result = await streamAnthropicMessages(baseUrl, apiKey, body, label, options.onToken, options.signal, acc.add);
    if (!result.toolUses.length || !options.callMcpTool) {
      return emitAndReturn(result.text.trim()
        ? result.text
        : anthropicPayloadText({ content: [], stop_reason: result.stopReason, usage: result.usage }, label));
    }
    const assistantContent = [
      ...(result.text ? [{ type: "text", text: result.text }] : []),
      ...result.toolUses.map((toolUse) => ({ type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input ?? {} }))
    ];
    result.toolUses.forEach((toolUse) => toolLoopDetector.record(toolUse.name, JSON.stringify(toolUse.input ?? {})));
    // Execute all tool calls concurrently (sink tools capture, external tools
    // produce results to feed back). Settle so one approval-required tool does
    // not discard the results of tools that already completed.
    const settled = await Promise.allSettled(result.toolUses.map((toolUse) => options.callMcpTool!({
      providerToolName: toolUse.name,
      argumentsJson: JSON.stringify(toolUse.input ?? {})
    })));
    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
    let pendingApproval: { toolUse: AnthropicToolUse; error: unknown } | undefined;
    let firstError: unknown;
    settled.forEach((outcome, index) => {
      const toolUse = result.toolUses[index]!;
      if (outcome.status === "fulfilled") {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: outcome.value });
      } else if (options.isApprovalError?.(outcome.reason) && !pendingApproval) {
        pendingApproval = { toolUse, error: outcome.reason };
      } else if (firstError === undefined) {
        firstError = outcome.reason;
      }
    });
    if (pendingApproval) {
      const continuationMessages: Array<Record<string, unknown>> = [...messages, { role: "assistant", content: assistantContent }];
      if (toolResults.length) continuationMessages.push({ role: "user", content: toolResults });
      attachProviderContinuation(pendingApproval.error, {
        transport: "anthropic",
        messages: continuationMessages,
        pendingToolCall: {
          id: pendingApproval.toolUse.id,
          providerToolName: pendingApproval.toolUse.name,
          argumentsJson: JSON.stringify(pendingApproval.toolUse.input ?? {})
        }
      });
      emitUsage();
      throw pendingApproval.error;
    }
    if (firstError !== undefined) {
      emitUsage();
      throw firstError;
    }
    const needsContinuation = result.toolUses.some((toolUse) => !options.isTerminalTool?.(toolUse.name));
    if (!needsContinuation) {
      // Only sink tools were called: the answer is this turn's streamed prose.
      return emitAndReturn(result.text.trim() || "Prepared the requested update for your review.");
    }
    messages.push({ role: "assistant", content: assistantContent });
    messages.push({ role: "user", content: toolResults });
  }
}

export function attachProviderContinuation(error: unknown, continuation: ResearchProviderContinuation): void {
  if (error && typeof error === "object") {
    (error as { providerContinuation?: ResearchProviderContinuation }).providerContinuation = continuation;
  }
}

/**
 * Places a single rolling prompt-cache breakpoint on the last content block of
 * the last message, after clearing any breakpoint previously set on message
 * blocks. Anthropic caches the longest matching prefix, so moving the marker to
 * the tail of a growing transcript (chat turns or MCP tool rounds) reuses the
 * cached prefix and only bills the new suffix — while staying within the
 * 4-breakpoint budget as the conversation grows. The system prefix keeps its
 * own breakpoint; this only touches `messages`. Blocks below the model's cache
 * minimum are silently ignored by the API, so marking short turns is harmless.
 */
export function setRollingMessageCacheBreakpoint(messages: Array<Record<string, unknown>>): void {
  for (const message of messages) {
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && "cache_control" in block) {
          delete (block as Record<string, unknown>).cache_control;
        }
      }
    }
  }
  const last = messages[messages.length - 1];
  if (!last) return;
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    return;
  }
  if (Array.isArray(last.content) && last.content.length) {
    const lastBlock = last.content[last.content.length - 1] as Record<string, unknown>;
    if (lastBlock && typeof lastBlock === "object") lastBlock.cache_control = { type: "ephemeral" };
  }
}

export function anthropicResumeMessages(
  continuation: ResearchProviderContinuation & { approvedResult: string }
): Array<Record<string, unknown>> {
  const messages = (continuation.messages as Array<Record<string, unknown>> | undefined)?.map((message) => ({ ...message })) ?? [];
  const approvedResult = { type: "tool_result", tool_use_id: continuation.pendingToolCall.id, content: continuation.approvedResult };
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && Array.isArray(last.content)) {
    last.content = [...(last.content as unknown[]), approvedResult];
  } else {
    messages.push({ role: "user", content: [approvedResult] });
  }
  return messages;
}

export async function buildAnthropicResearchBody(
  provider: Provider,
  userMessage: string,
  options: ResearchProviderOptions,
  policy: PhaseModelPolicy
): Promise<Record<string, unknown>> {
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  const maxTokens = anthropicMaxTokensForPhase("brainstorming", policy, profile);
  const currentText = await researchCurrentMessageText(userMessage, options);
  const imageContent = profile.supportsImageInput ? await anthropicImageContent(options.imageAttachments) : [];

  // Stable, cacheable system prefix: instructions + phase policy, then the
  // large scoped project context marked as a cache breakpoint so it is reused
  // across turns of the session instead of re-billed every message.
  const systemBlocks: Array<Record<string, unknown>> = [
    { type: "text", text: [researchSystemInstructions(options), phasePolicyText("brainstorming", policy, profile)].join("\n\n") }
  ];
  const stableContext = researchStableContextText(options);
  if (stableContext.trim()) {
    systemBlocks.push({ type: "text", text: stableContext, cache_control: { type: "ephemeral" } });
  } else {
    systemBlocks[0].cache_control = { type: "ephemeral" };
  }

  const body: Record<string, unknown> = {
    model: policy.modelOverride?.trim() || provider.model || "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: anthropicResearchMessages(researchHistoryThread(userMessage, options), currentText, imageContent)
  };
  if (options.webSearchEnabled) {
    body.tools = [{ type: "web_search_20260318", name: "web_search" }];
  }
  applyAnthropicGenerationControls(body, "brainstorming", policy, profile, maxTokens);
  return body;
}

/**
 * Renders prior turns as real user/assistant messages and appends the current
 * user message (with any image blocks), merging into a trailing user turn so
 * the message list never has two consecutive user turns.
 */
export function anthropicResearchMessages(
  history: ResearchThreadTurn[],
  currentText: string,
  imageContent: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = history.map((turn) => ({ role: turn.role, content: turn.text }));
  const currentBlocks: Array<Record<string, unknown>> = [{ type: "text", text: currentText }, ...imageContent];
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    last.content = [{ type: "text", text: last.content as string }, ...currentBlocks];
  } else {
    messages.push({ role: "user", content: imageContent.length ? currentBlocks : currentText });
  }
  return messages;
}

export function buildAnthropicCompatibleBody(
  provider: Provider,
  contextText: string,
  promptSummary: string,
  webSearchEnabled: boolean,
  phase: LlmPhase,
  policy: PhaseModelPolicy,
  profile = inferModelCapabilityProfile(provider, policy.modelOverride),
  selectedSkillsPrompt = "",
  imageAttachments?: ProviderImageAttachment[],
  bareExtraction = false,
  structuredSourceHandoff = false
): Record<string, unknown> {
  const maxTokens = anthropicMaxTokensForPhase(phase, policy, profile);
  const body: Record<string, unknown> = {
    model: policy.modelOverride?.trim() || provider.model || "claude-sonnet-4-6",
    max_tokens: maxTokens,
    // Stable across orchestrator invocations, so cache it as the system prefix.
    system: [{ type: "text", text: bareExtraction ? extractionSystemPrompt : orchestratorSystemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: bareExtraction ? contextText : [
          `Prompt summary: ${promptSummary}`,
          `ArchiCode phase: ${phase}.`,
          phaseHandoffInstructions(phase, structuredSourceHandoff),
          phasePolicyText(phase, policy, profile),
          selectedSkillsPrompt.trim(),
          imageAttachmentText(imageAttachments),
          webSearchEnabled
            ? "Web access is enabled. Use any Harness-Fed Web Context in the prompt as source material. If current external information is still required during planning, ask a focused llm-question naming the missing source or URL; during coding/debugging, fail with a clear run-level reason."
            : "Web search is disabled for this run.",
          "",
          "Project JSON context:",
          contextText
        ].join("\n")
      }
    ]
  };
  applyAnthropicGenerationControls(body, phase, policy, profile, maxTokens);
  return body;
}

export async function checkAnthropicCompatible(provider: Provider, apiKey: string): Promise<{
  detectedContextWindowTokens?: number;
  availableModels: string[];
  detectedModelCapabilities: ProjectSettings["providers"][number]["detectedModelCapabilities"];
}> {
  const baseUrl = provider.baseUrl ?? "https://api.anthropic.com";
  const modelsResponse = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    }
  });

  if (modelsResponse.ok) {
    const payload = await modelsResponse.json();
    return {
      detectedContextWindowTokens: extractContextWindowFromModels(payload, provider.model),
      availableModels: extractModelIdsFromModels(payload),
      detectedModelCapabilities: extractModelCapabilitiesFromModels(payload, provider.kind)
    };
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: provider.model ?? "claude-sonnet-4-6",
      max_tokens: 1,
      system: "You are a health check endpoint caller.",
      messages: [{ role: "user", content: "Reply ok." }]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic-compatible health check failed with ${response.status}: ${await response.text()}`);
  }
  return { availableModels: [], detectedModelCapabilities: {} };
}
