import type { LlmPhase, ModelCapabilityProfile, PhaseModelPolicy, ProjectSettings } from "../../shared/schema";
import { defaultPhaseModelPolicies } from "../../shared/schema";
import type { ProviderMcpTool } from "../mcp";
import { runAgentLoop, type AgentToolResult } from "../agentRuntime";
import {
  type Provider,
  type ProviderCallOptions,
  type ProviderImageAttachment,
  type RawLlmUsage,
  type ResearchProviderContinuation,
  type ResearchProviderOptions,
  type ResearchThreadTurn,
  appendTextAttachmentBlock,
  createUsageAccumulator,
  extractContextWindowFromModels,
  extractModelCapabilitiesFromModels,
  extractModelIdsFromModels,
  extractionSystemPrompt,
  imageAttachmentsForPrompt,
  imageLabelText,
  inferModelCapabilityProfile,
  orchestratorSystemPrompt,
  orchestratorUserPromptParts,
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
  // The profile value is a strict user-facing ceiling. Adaptive thinking may
  // change effort, but it must never silently increase max_tokens beyond the
  // configured (and model-capability-clamped) policy.
  void profile;
  return policy.maxOutputTokens ?? defaultPhaseModelPolicies[phase].maxOutputTokens ?? 1800;
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

export type AnthropicContentBlock = Record<string, unknown> & {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

export type AnthropicMessagePayload = {
  content?: AnthropicContentBlock[];
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

function anthropicReasoningReplayState(content: AnthropicContentBlock[] | undefined): RawLlmUsage["reasoningReplayState"] {
  return (content ?? []).some((block) => block.type === "thinking" || block.type === "redacted_thinking")
    ? "received"
    : "absent";
}

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
  content: AnthropicContentBlock[];
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
  const contentBlocks = new Map<number, AnthropicContentBlock>();
  const toolInputJson = new Map<number, string>();

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
      if (typeof index === "number" && typeof block?.type === "string") {
        contentBlocks.set(index, { ...block, type: block.type });
        if (block.type === "tool_use") toolInputJson.set(index, "");
      }
    }
    if (event.type === "content_block_delta") {
      const index = event.index as number | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        text += delta.text;
        onToken?.(delta.text);
      }
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && typeof index === "number") {
        toolInputJson.set(index, `${toolInputJson.get(index) ?? ""}${delta.partial_json}`);
      }
      if (typeof index === "number") {
        const block = contentBlocks.get(index);
        if (block) {
          for (const [key, value] of Object.entries(delta ?? {})) {
            if (key === "type" || key === "partial_json") continue;
            if (typeof value === "string") {
              block[key] = `${typeof block[key] === "string" ? block[key] : ""}${value}`;
            } else if (value !== undefined) {
              block[key] = value;
            }
          }
        }
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

  const content = [...contentBlocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, block]) => {
      if (block.type !== "tool_use") return block;
      const json = toolInputJson.get(index) ?? "";
      let input: unknown = block.input ?? {};
      try {
        input = json.trim() ? JSON.parse(json) : input;
      } catch {
        input = {};
      }
      return { ...block, input };
    });
  const toolUses = content.flatMap((block): AnthropicToolUse[] =>
    block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string"
      ? [{ id: block.id, name: block.name, input: block.input ?? {} }]
      : []);
  const mergedUsage: AnthropicMessagePayload["usage"] = {
    input_tokens: startUsage?.input_tokens,
    cache_read_input_tokens: startUsage?.cache_read_input_tokens,
    cache_creation_input_tokens: startUsage?.cache_creation_input_tokens,
    output_tokens: deltaUsage?.output_tokens,
    output_tokens_details: deltaUsage?.output_tokens_details
  };
  if (mergedUsage.input_tokens !== undefined || mergedUsage.output_tokens !== undefined) {
    onUsage?.({
      ...extractAnthropicUsage(mergedUsage),
      reasoningReplayState: anthropicReasoningReplayState(content)
    });
  }
  return { text, toolUses, content, stopReason, usage: mergedUsage };
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
  if (imageContent.length || options.textAttachments?.length) {
    const messages = body.messages as Array<Record<string, unknown>>;
    const userMessage = messages.find((message) => message.role === "user");
    // Attachments land on the trailing (volatile) text block so the cached
    // stable block stays byte-identical across the phases of a run.
    if (typeof userMessage?.content === "string") {
      const withText = await appendTextAttachmentBlock(userMessage.content, options.textAttachments);
      userMessage.content = imageContent.length ? [{ type: "text", text: withText }, ...imageContent] : withText;
    } else if (Array.isArray(userMessage?.content)) {
      const blocks = userMessage.content as Array<Record<string, unknown>>;
      const lastText = [...blocks].reverse().find((block) => block.type === "text" && typeof block.text === "string");
      if (lastText) lastText.text = await appendTextAttachmentBlock(lastText.text as string, options.textAttachments);
      blocks.push(...imageContent);
    }
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
  type AnthropicProviderTurn = {
    content: Array<Record<string, unknown>>;
  };
  const answer = await runAgentLoop<AnthropicProviderTurn>({
    signal: options.signal,
    executeTool: options.callMcpTool
      ? (toolCall) => options.callMcpTool!({ providerToolName: toolCall.providerToolName, argumentsJson: toolCall.argumentsJson })
      : undefined,
    adapter: {
      async nextTurn() {
        // Roll the message cache breakpoint to the tail so each round reuses
        // the accumulated transcript prefix.
        setRollingMessageCacheBreakpoint(messages);
        const response = await postAnthropicMessages(baseUrl, apiKey, body, "Anthropic-compatible provider", options.signal);
        if (!response.ok) {
          throw new Error(`Anthropic-compatible provider failed with ${response.status}: ${await response.text()}`);
        }
        const payload = await response.json() as AnthropicMessagePayload;
        const content = payload.content ?? [];
        acc.add({
          ...extractAnthropicUsage(payload.usage),
          reasoningReplayState: anthropicReasoningReplayState(content)
        });
        const toolUses = content.filter((part) => part.type === "tool_use" && part.id && part.name);
        let text = content
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n")
          .trim();
        if (!toolUses.length) {
          try {
            text = anthropicPayloadText(payload, "Anthropic-compatible provider");
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
            acc.add({
              ...extractAnthropicUsage(retryPayload.usage),
              reasoningReplayState: anthropicReasoningReplayState(retryPayload.content)
            });
            text = anthropicPayloadText(retryPayload, "Anthropic-compatible provider");
          }
        }
        const toolCalls = toolUses.map((toolUse) => ({
          id: toolUse.id as string,
          providerToolName: toolUse.name as string,
          argumentsJson: JSON.stringify(toolUse.input ?? {})
        }));
        options.prepareToolBatch?.(toolCalls.map(({ providerToolName, argumentsJson }) => ({ providerToolName, argumentsJson })));
        return { text, toolCalls, raw: { content } };
      },
      commitToolResults(turn, results) {
        messages.push({ role: "assistant", content: turn.raw.content });
        messages.push({
          role: "user",
          content: results.map(({ toolCall, result }) => ({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: result
          }))
        });
        completedToolRounds += 1;
      }
    },
    completionAfterTools({ results }) {
      const executedToolCalls = results.map(({ toolCall, rawResult }) => ({
        providerToolName: toolCall.providerToolName,
        argumentsJson: toolCall.argumentsJson,
        result: rawResult
      }));
      return options.shouldCompleteToolBatch?.(executedToolCalls)
        ? { complete: true, fallbackText: "Structured source handoff completed." }
        : undefined;
    }
  });
  return emitAndReturn(answer);
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
  if (tools.length) body.tools = [...(Array.isArray(body.tools) ? body.tools : []), ...tools];
  const label = "Anthropic-compatible research provider";

  // Resume: replace the working transcript with the persisted continuation and
  // splice in the just-approved tool result, so the pre-approval work is reused.
  if (options.resumeContinuation?.transport === "anthropic" && options.resumeContinuation.messages) {
    body.messages = anthropicResumeMessages(options.resumeContinuation);
  }
  const messages = body.messages as Array<Record<string, unknown>>;
  type AnthropicAgentTurn = {
    result: AnthropicStreamResult;
    assistantContent: Array<Record<string, unknown>>;
  };
  const resultBlocks = (results: AgentToolResult[]): Array<{ type: "tool_result"; tool_use_id: string; content: string }> =>
    results.map(({ toolCall, result }) => ({
      type: "tool_result",
      tool_use_id: toolCall.id,
      content: result
    }));
  try {
    const answer = await runAgentLoop<AnthropicAgentTurn>({
      signal: options.signal,
      executeTool: options.callMcpTool
        ? (toolCall) => options.callMcpTool!({ providerToolName: toolCall.providerToolName, argumentsJson: toolCall.argumentsJson })
        : undefined,
      isApprovalError: options.isApprovalError,
      onTransientRetry: options.onTransientRetry,
      isTerminalTool: options.isTerminalTool,
      terminalToolCompletesTurn: options.terminalToolCompletesTurn,
      adapter: {
        async nextTurn() {
          // Roll the cache breakpoint to the transcript tail so each tool
          // round reuses the stable prefix and only bills the new suffix.
          setRollingMessageCacheBreakpoint(messages);
          const result = await streamAnthropicMessages(baseUrl, apiKey, body, label, options.onToken, options.signal, acc.add);
          delete body.tool_choice;
          const text = result.toolUses.length || result.text.trim()
            ? result.text
            : anthropicPayloadText({ content: [], stop_reason: result.stopReason, usage: result.usage }, label);
          return {
            text,
            toolCalls: result.toolUses.map((toolUse) => ({
              id: toolUse.id,
              providerToolName: toolUse.name,
              argumentsJson: JSON.stringify(toolUse.input ?? {})
            })),
            raw: { result, assistantContent: result.content }
          };
        },
        commitToolResults(turn, results) {
          messages.push({ role: "assistant", content: turn.raw.assistantContent });
          messages.push({ role: "user", content: resultBlocks(results) });
        },
        commitInvalidAnswer(turn, feedback) {
          messages.push({ role: "assistant", content: turn.raw.assistantContent });
          messages.push({ role: "user", content: feedback });
        },
        commitFeedback(feedback) {
          messages.push({ role: "user", content: feedback });
        },
        attachApprovalContinuation({ turn, completedResults, pendingToolCall, error }) {
          const continuationMessages: Array<Record<string, unknown>> = [
            ...messages,
            { role: "assistant", content: turn.raw.assistantContent }
          ];
          const completedBlocks = resultBlocks(completedResults);
          if (completedBlocks.length) continuationMessages.push({ role: "user", content: completedBlocks });
          attachProviderContinuation(error, {
            transport: "anthropic",
            messages: continuationMessages,
            pendingToolCall: {
              id: pendingToolCall.id,
              providerToolName: pendingToolCall.providerToolName,
              argumentsJson: pendingToolCall.argumentsJson
            }
          });
        },
        requestFinalAnswer() {
          messages.push({
            role: "user",
            content: "The requested internal update completed. Return the concise visible answer now in normal prose. Do not call tools."
          });
          delete body.tools;
          delete body.tool_choice;
        }
      },
      validateFinalAnswer: options.validateFinalAnswer
    });
    return emitAndReturn(answer);
  } catch (error) {
    emitUsage();
    throw error;
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
  // The first message keeps its breakpoints: the single-shot builder marks its
  // stable block (skills + project JSON) so later phases of the run reuse it.
  // Breakpoint budget stays within Anthropic's limit of 4: one on the system
  // prefix, at most two on the first message, one rolling on the tail.
  for (const message of messages.slice(1)) {
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
  const promptParts = bareExtraction ? null : orchestratorUserPromptParts(
    contextText,
    promptSummary,
    webSearchEnabled
      ? "Web access is enabled. Use any Harness-Fed Web Context in the prompt as source material. If current external information is still required during planning, ask a focused llm-question naming the missing source or URL; during coding/debugging, fail with a clear run-level reason."
      : "Web search is disabled for this run.",
    phase,
    policy,
    profile,
    selectedSkillsPrompt,
    imageAttachments,
    structuredSourceHandoff
  );
  const body: Record<string, unknown> = {
    model: policy.modelOverride?.trim() || provider.model || "claude-sonnet-4-6",
    max_tokens: maxTokens,
    // Stable across orchestrator invocations, so cache it as the system prefix.
    system: [{ type: "text", text: bareExtraction ? extractionSystemPrompt : orchestratorSystemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        // Second breakpoint after the stable block (skills + project JSON): the
        // phases of one run share it, so extraction/planning/coding reuse the
        // cached project context instead of re-billing it each phase.
        content: !promptParts ? contextText : [
          { type: "text", text: promptParts.stable, cache_control: { type: "ephemeral" } },
          { type: "text", text: promptParts.volatile }
        ]
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
