import type { LlmPhase, PhaseModelPolicy, ProjectSettings } from "../../shared/schema";
import type { ProviderMcpTool } from "../mcp";
import { type Provider, type ProviderCallOptions, type ProviderImageAttachment, type RawLlmUsage, type ResearchProviderContinuation, type ResearchProviderOptions, appendTextAttachmentBlock, createConsecutiveToolCallLoopDetector, createUsageAccumulator, extractContextWindowFromModels, extractModelCapabilitiesFromModels, extractModelIdsFromModels, extractionSystemPrompt, imageAttachmentText, imageAttachmentsForPrompt, imageLabelText, inferModelCapabilityProfile, orchestratorSystemPrompt, phaseHandoffInstructions, phasePolicyText, reasoningEffort, researchCurrentMessageText, researchHistoryThread, researchStableContextText, researchSystemInstructions, resolveModelId } from "../providers";
import { attachProviderContinuation } from "./anthropic";

export const openAiHealthProbeMaxOutputTokens = 16;
export type OpenAiEndpointMode = "responses" | "chat-completions";

export function extractOpenAIChatUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
} | undefined): RawLlmUsage {
  if (!usage) return {};
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const promptTokens = usage.prompt_tokens ?? 0;
  return {
    inputTokens: Math.max(0, promptTokens - cached),
    outputTokens: usage.completion_tokens,
    thinkingTokens: usage.completion_tokens_details?.reasoning_tokens,
    cacheReadTokens: cached || undefined,
    cacheCreationTokens: 0
  };
}

export function extractOpenAIResponsesUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
} | undefined): RawLlmUsage {
  if (!usage) return {};
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const inputTokens = usage.input_tokens ?? 0;
  return {
    inputTokens: Math.max(0, inputTokens - cached),
    outputTokens: usage.output_tokens,
    thinkingTokens: usage.output_tokens_details?.reasoning_tokens,
    cacheReadTokens: cached || undefined,
    cacheCreationTokens: 0
  };
}
export type OpenAiResponsesPayload = {
  id?: string;
  output_text?: unknown;
  status?: string;
  incomplete_details?: {
    reason?: string;
  } | null;
  error?: {
    message?: string;
  } | null;
  output?: Array<{
    type?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    content?: Array<Record<string, unknown>>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
};

export function openAiEndpointMode(provider: Provider): OpenAiEndpointMode {
  if (provider.openAiEndpointMode === "responses" || provider.openAiEndpointMode === "chat-completions") return provider.openAiEndpointMode;
  return provider.detectedOpenAiEndpointMode ?? "responses";
}

export function isOpenAiEndpointAuto(provider: Provider): boolean {
  return !provider.openAiEndpointMode || provider.openAiEndpointMode === "auto";
}

export function openAiModel(provider: Provider, policy: PhaseModelPolicy): string {
  return policy.modelOverride?.trim() || provider.model || "gpt-5.5";
}

export function isGpt56Model(model: string): boolean {
  return /(?:^|\/)gpt-5\.6(?:[-.:]|$)/i.test(model.trim());
}

export function addOpenAiResponsesVerbosity(body: Record<string, unknown>, provider: Provider, model: string): void {
  const verbosity = provider.outputVerbosity;
  if (!verbosity || !isGpt56Model(model)) return;
  const existingText = body.text && typeof body.text === "object" && !Array.isArray(body.text)
    ? body.text as Record<string, unknown>
    : {};
  body.text = { ...existingText, verbosity };
}

export function addOpenAiTokenLimit(body: Record<string, unknown>, model: string, maxOutputTokens: number | undefined): void {
  if (!maxOutputTokens) return;
  const normalized = model.toLowerCase();
  if (/^(gpt-5|o[134])(?:[\.-]|$)/.test(normalized)) {
    body.max_completion_tokens = maxOutputTokens;
  } else {
    body.max_tokens = maxOutputTokens;
  }
}

export function isOpenAiEndpointUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(404|not found|unknown endpoint|unknown request url|unsupported (?:path|url|endpoint)|invalid (?:path|url|endpoint))\b/i.test(message);
}

export function isOpenAiImageContentUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(image_url|input_image|input_image_url|unknown variant[`'"\s]+image_url|expected [`'"]text[`'"])\b/i.test(message);
}

export function isTransientOpenAiResponsesError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b(?:408|425|429|500|502|503|504)\b|internal server error|server[_ ]error|temporarily unavailable|service unavailable|overloaded|upstream (?:error|failure|idle timeout)|idle timeout|fetch failed|socket hang up|econnreset|etimedout|headers timeout|body timeout|\bterminated\b)/i.test(message);
}

export function dropContextOnlyImageAttachments<T extends { imageAttachments?: ProviderImageAttachment[] }>(options: T): T | null {
  const attachments = options.imageAttachments ?? [];
  if (!attachments.length) return null;
  if (attachments.some((attachment) => attachment.source === "message")) return null;
  return { ...options, imageAttachments: [] };
}

export async function openAiImageContent(images: ProviderImageAttachment[] | undefined): Promise<Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>> {
  const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
  const encoded = await imageAttachmentsForPrompt(images);
  encoded.forEach((image, index) => {
    content.push({ type: "text", text: imageLabelText(image, index) });
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` }
    });
  });
  return content;
}

export async function openAiResponsesImageContent(images: ProviderImageAttachment[] | undefined): Promise<Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }>> {
  const content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> = [];
  const encoded = await imageAttachmentsForPrompt(images);
  encoded.forEach((image, index) => {
    content.push({ type: "input_text", text: imageLabelText(image, index) });
    content.push({ type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}` });
  });
  return content;
}

export async function callOpenAICompatible(
  provider: Provider,
  apiKey: string,
  contextText: string,
  promptSummary: string,
  webSearchEnabled: boolean,
  phase: LlmPhase,
  policy: PhaseModelPolicy,
  options: ProviderCallOptions = {}
): Promise<string> {
  if (openAiEndpointMode(provider) === "responses") {
    try {
      return await callOpenAIResponsesCompatible(provider, apiKey, contextText, promptSummary, webSearchEnabled, phase, policy, options);
    } catch (error) {
      if (isOpenAiEndpointAuto(provider) && isOpenAiEndpointUnsupported(error)) {
        return callOpenAIChatCompatible(provider, apiKey, contextText, promptSummary, webSearchEnabled, phase, policy, options);
      }
      throw error;
    }
  }
  return callOpenAIChatCompatible(provider, apiKey, contextText, promptSummary, webSearchEnabled, phase, policy, options);
}

export async function callOpenAIChatCompatible(
  provider: Provider,
  apiKey: string,
  contextText: string,
  promptSummary: string,
  webSearchEnabled: boolean,
  phase: LlmPhase,
  policy: PhaseModelPolicy,
  options: ProviderCallOptions = {}
): Promise<string> {
  try {
    const baseUrl = provider.baseUrl ?? "https://api.openai.com/v1";
    const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
    const body = buildOpenAICompatibleBody(provider, contextText, promptSummary, webSearchEnabled, phase, policy, profile, options.selectedSkillsPrompt, options.imageAttachments, options.bareExtraction, options.structuredSourceHandoff);
    const imageContent = profile.supportsImageInput ? await openAiImageContent(options.imageAttachments) : [];
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
    const messages = body.messages as Array<Record<string, unknown>>;
    const tools = openAiMcpTools(options.mcpTools ?? []);
    if (tools.length) {
      body.tools = tools;
      delete body.reasoning_effort;
    }
    const toolLoopDetector = createConsecutiveToolCallLoopDetector();
    while (true) {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: options.signal
      });

      if (!response.ok) {
        throw new Error(`OpenAI-compatible provider failed with ${response.status}: ${await response.text()}`);
      }

      const payload = await response.json() as {
        choices?: {
          message?: {
            content?: string | null;
            tool_calls?: Array<{ id: string; type: string; function?: { name?: string; arguments?: string } }>;
          };
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };
      acc.add(extractOpenAIChatUsage(payload.usage));
      const message = payload.choices?.[0]?.message;
      const toolCalls = message?.tool_calls ?? [];
      if (!toolCalls.length || !options.callMcpTool) {
        return emitAndReturn(message?.content ?? "Provider returned no content.");
      }
      messages.push({
        role: "assistant",
        content: message?.content ?? null,
        tool_calls: toolCalls
      });
      options.prepareToolBatch?.(toolCalls.flatMap((toolCall) => {
        const providerToolName = toolCall.function?.name;
        return providerToolName ? [{
          providerToolName,
          argumentsJson: toolCall.function?.arguments ?? "{}"
        }] : [];
      }));
      const executedToolCalls = [];
      for (const toolCall of toolCalls) {
        const providerToolName = toolCall.function?.name;
        if (!providerToolName) continue;
        const argumentsJson = toolCall.function?.arguments ?? "{}";
        toolLoopDetector.record(providerToolName, argumentsJson);
        const result = await options.callMcpTool({
          providerToolName,
          argumentsJson
        });
        executedToolCalls.push({ providerToolName, argumentsJson, result });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result
        });
      }
      if (options.shouldCompleteToolBatch?.(executedToolCalls)) {
        return emitAndReturn(message?.content ?? "Structured source handoff completed.");
      }
    }
  } catch (error) {
    const retryOptions = isOpenAiImageContentUnsupported(error) ? dropContextOnlyImageAttachments(options) : null;
    if (retryOptions) {
      return callOpenAIChatCompatible(provider, apiKey, contextText, promptSummary, webSearchEnabled, phase, policy, retryOptions);
    }
    throw error;
  }
}

export async function callOpenAIResponsesCompatible(
  provider: Provider,
  apiKey: string,
  contextText: string,
  promptSummary: string,
  webSearchEnabled: boolean,
  phase: LlmPhase,
  policy: PhaseModelPolicy,
  options: ProviderCallOptions = {}
): Promise<string> {
  const baseUrl = provider.baseUrl ?? "https://api.openai.com/v1";
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  const body = buildOpenAIResponsesBody(provider, contextText, promptSummary, webSearchEnabled, phase, policy, profile, options.selectedSkillsPrompt, options.imageAttachments, options.bareExtraction, options.structuredSourceHandoff);
  const imageContent = profile.supportsImageInput ? await openAiResponsesImageContent(options.imageAttachments) : [];
  if (imageContent.length && typeof body.input === "string") {
    body.input = [{
      role: "user",
      content: [
        { type: "input_text", text: await appendTextAttachmentBlock(body.input, options.textAttachments) },
        ...imageContent
      ]
    }];
  } else if (typeof body.input === "string" && options.textAttachments?.length) {
    body.input = await appendTextAttachmentBlock(body.input, options.textAttachments);
  }
  const tools = openAiResponsesTools(options.mcpTools ?? []);
  if (tools.length) body.tools = [...(Array.isArray(body.tools) ? body.tools : []), ...tools];
  const modelId = resolveModelId(provider, policy);
  const acc = createUsageAccumulator();
  const result = await callOpenAIResponsesToolLoop(baseUrl, apiKey, body, "OpenAI-compatible Responses provider", { ...options, onUsage: acc.add });
  const usage = acc.finalize(provider, modelId);
  if (usage.calls >= 1 && (usage.inputTokens > 0 || usage.outputTokens > 0)) options.onUsage?.(usage);
  return result;
}

export async function callOpenAIResearch(
  provider: Provider,
  apiKey: string,
  userMessage: string,
  options: ResearchProviderOptions,
  policy: PhaseModelPolicy
): Promise<string> {
  if (openAiEndpointMode(provider) === "chat-completions") {
    return callOpenAIResearchChatCompatible(provider, apiKey, userMessage, options, policy);
  }
  const baseUrl = provider.baseUrl ?? "https://api.openai.com/v1";
  const body = await buildOpenAIResearchResponsesBody(provider, userMessage, options, policy);
  const resume = options.resumeContinuation;
  if (resume?.transport === "openai-responses") {
    // Resume from the server-side response instead of re-generating: resend the
    // already-completed tool outputs plus the just-approved one.
    if (resume.previousResponseId) body.previous_response_id = resume.previousResponseId;
    body.input = [
      ...((resume.messages as Array<Record<string, unknown>> | undefined) ?? []),
      { type: "function_call_output", call_id: resume.pendingToolCall.id, output: resume.approvedResult }
    ];
  }
  const modelId = resolveModelId(provider, policy);
  const acc = createUsageAccumulator();
  const emitUsage = (): void => {
    const usage = acc.finalize(provider, modelId);
    if (usage.calls >= 1 && (usage.inputTokens > 0 || usage.outputTokens > 0)) options.onUsage?.(usage);
  };
  const toolLoopOptions = {
    callMcpTool: options.callMcpTool,
    onToken: options.onToken,
    signal: options.signal,
    isTerminalTool: options.isTerminalTool,
    terminalToolCompletesTurn: options.terminalToolCompletesTurn,
    isApprovalError: options.isApprovalError,
    onUsage: acc.add
  };
  try {
    if (options.mcpTools?.length) {
      const result = await callOpenAIResponsesToolLoop(baseUrl, apiKey, body, "OpenAI-compatible research Responses provider", toolLoopOptions);
      emitUsage();
      return result;
    }
    const result = await callOpenAIResponsesStreaming(baseUrl, apiKey, body, "OpenAI-compatible research Responses provider", options.onToken, options.signal, acc.add);
    emitUsage();
    return result;
  } catch (error) {
    if (isOpenAiEndpointAuto(provider) && isOpenAiEndpointUnsupported(error)) {
      emitUsage();
      return callOpenAIResearchChatCompatible(provider, apiKey, userMessage, options, policy);
    }
    emitUsage();
    throw error;
  }
}

export async function callOpenAIResearchChatCompatible(
  provider: Provider,
  apiKey: string,
  userMessage: string,
  options: ResearchProviderOptions,
  policy: PhaseModelPolicy
): Promise<string> {
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
  try {
    const baseUrl = provider.baseUrl ?? "https://api.openai.com/v1";
    const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
    const body = await buildOpenAIResearchChatCompletionsBody(provider, userMessage, options, policy);
    const imageContent = profile.supportsImageInput ? await openAiImageContent(options.imageAttachments) : [];
    const messages = body.messages as Array<Record<string, unknown>>;
    // Attach image bytes to the current (last) user turn. Text attachments are
    // already embedded in that turn's text by researchCurrentMessageText.
    const userMessageRecord = [...messages].reverse().find((message) => message.role === "user");
    if (imageContent.length && typeof userMessageRecord?.content === "string") {
      userMessageRecord.content = [{ type: "text", text: userMessageRecord.content }, ...imageContent];
    }
    const tools = openAiMcpTools(options.mcpTools ?? []);
    if (!tools.length) {
      return emitAndReturn(await callOpenAIChatStreaming(baseUrl, apiKey, body, "OpenAI-compatible research Chat Completions provider", options.onToken, options.signal, acc.add));
    }
    body.tools = tools;
    delete body.reasoning_effort;

    // Resume: continue from the persisted transcript plus the approved result.
    if (options.resumeContinuation?.transport === "openai-chat" && options.resumeContinuation.messages) {
      body.messages = openAIChatResumeMessages(options.resumeContinuation);
    }

    const label = "OpenAI-compatible research Chat Completions provider";
    const toolLoopDetector = createConsecutiveToolCallLoopDetector();
    while (true) {
      // Stream every iteration so tool-assisted turns are no longer silent.
      const result = await streamOpenAIChatCompletion(baseUrl, apiKey, body, label, options.onToken, options.signal);
      if (result.usage) acc.add(result.usage);
      if (!result.toolCalls.length || !options.callMcpTool) {
        return emitAndReturn(result.text || "Provider returned no content.");
      }
      const assistantMessage = {
        role: "assistant",
        content: result.text || null,
        tool_calls: result.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: { name: toolCall.name, arguments: toolCall.arguments }
        }))
      };
      result.toolCalls.forEach((toolCall) => toolLoopDetector.record(toolCall.name, toolCall.arguments || "{}"));
      // Execute all tool calls concurrently, settling so an approval-required
      // tool does not discard results of tools that already completed.
      const settled = await Promise.allSettled(result.toolCalls.map((toolCall) =>
        options.callMcpTool!({ providerToolName: toolCall.name, argumentsJson: toolCall.arguments || "{}" })));
      const toolMessages: Array<Record<string, unknown>> = [];
      let pendingApproval: { toolCall: OpenAIChatToolCall; error: unknown } | undefined;
      let firstError: unknown;
      settled.forEach((outcome, index) => {
        const toolCall = result.toolCalls[index]!;
        if (outcome.status === "fulfilled") {
          toolMessages.push({ role: "tool", tool_call_id: toolCall.id, content: outcome.value });
        } else if (options.isApprovalError?.(outcome.reason) && !pendingApproval) {
          pendingApproval = { toolCall, error: outcome.reason };
        } else if (firstError === undefined) {
          firstError = outcome.reason;
        }
      });
      if (pendingApproval) {
        attachProviderContinuation(pendingApproval.error, {
          transport: "openai-chat",
          messages: [...messages, assistantMessage, ...toolMessages],
          pendingToolCall: {
            id: pendingApproval.toolCall.id,
            providerToolName: pendingApproval.toolCall.name,
            argumentsJson: pendingApproval.toolCall.arguments || "{}"
          }
        });
        throw pendingApproval.error;
      }
      if (firstError !== undefined) throw firstError;
      const needsContinuation = result.toolCalls.some((toolCall) => !options.isTerminalTool?.(toolCall.name));
      if (!needsContinuation) {
        // Only sink tools were called: the answer is this turn's streamed prose.
        return emitAndReturn(result.text || "Provider returned no content.");
      }
      messages.push(assistantMessage);
      messages.push(...toolMessages);
    }
  } catch (error) {
    const retryOptions = isOpenAiImageContentUnsupported(error) ? dropContextOnlyImageAttachments(options) : null;
    if (retryOptions) {
      return callOpenAIResearchChatCompatible(provider, apiKey, userMessage, retryOptions, policy);
    }
    // Emit partial usage captured before the error (e.g. an approval-required
    // turn still consumed tokens). The image-retry branch above had no usage.
    emitUsage();
    throw error;
  }
}

export function openAIChatResumeMessages(
  continuation: ResearchProviderContinuation & { approvedResult: string }
): Array<Record<string, unknown>> {
  const messages = (continuation.messages as Array<Record<string, unknown>> | undefined)?.map((message) => ({ ...message })) ?? [];
  messages.push({ role: "tool", tool_call_id: continuation.pendingToolCall.id, content: continuation.approvedResult });
  return messages;
}

export function extractOpenAIResponsesText(payload: OpenAiResponsesPayload, label: string): string {
  if (payload.error?.message) {
    throw new Error(`${label} returned an error: ${payload.error.message}`);
  }
  if (payload.status === "incomplete") {
    const reason = payload.incomplete_details?.reason;
    throw new Error([
      `${label} returned an incomplete response${reason ? ` (${reason})` : ""}.`,
      "Increase the phase Max output setting or lower reasoning for this phase, then retry."
    ].join(" "));
  }

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const text = (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => {
      if (typeof part.text === "string") return part.text;
      if (typeof part.output_text === "string") return part.output_text;
      return undefined;
    })
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n");
  if (text.trim()) return text;

  if (payload.status && payload.status !== "completed") {
    throw new Error(`${label} returned no text output (status: ${payload.status}).`);
  }
  return "Provider returned no content.";
}

export async function postOpenAIResponses(baseUrl: string, apiKey: string, body: Record<string, unknown>, label: string, signal?: AbortSignal): Promise<OpenAiResponsesPayload> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal
      });
      if (!response.ok) {
        const error = new Error(`${label} failed with ${response.status}: ${await response.text()}`);
        if (attempt === 0 && !signal?.aborted && isTransientOpenAiResponsesError(error)) continue;
        throw error;
      }
      const payload = await response.json() as OpenAiResponsesPayload;
      if (attempt === 0 && !signal?.aborted && payload.error?.message && isTransientOpenAiResponsesError(payload.error.message)) continue;
      return payload;
    } catch (error) {
      if (attempt === 0 && !signal?.aborted && isTransientOpenAiResponsesError(error)) continue;
      throw error;
    }
  }
  throw new Error(`${label} transient retry exhausted.`);
}

export async function callOpenAIResponsesToolLoop(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  label: string,
  options: { callMcpTool?: (input: { providerToolName: string; argumentsJson: string }) => Promise<string>; onToken?: (text: string) => void; signal?: AbortSignal; isTerminalTool?: (providerToolName: string) => boolean; terminalToolCompletesTurn?: (providerToolName: string) => boolean; prepareToolBatch?: ProviderCallOptions["prepareToolBatch"]; shouldCompleteToolBatch?: ProviderCallOptions["shouldCompleteToolBatch"]; isApprovalError?: (error: unknown) => boolean; onUsage?: (raw: RawLlmUsage) => void }
): Promise<string> {
  const initialInput = Array.isArray(body.input)
    ? [...body.input]
    : body.input === undefined
      ? []
      : [{ role: "user", content: [{ type: "input_text", text: String(body.input) }] }];
  const transcript: unknown[] = initialInput;
  const toolLoopDetector = createConsecutiveToolCallLoopDetector();
  const extractVisibleText = (payload: OpenAiResponsesPayload): string => {
    const text = extractOpenAIResponsesText(payload, label);
    return text === "Provider returned no content." ? "" : text;
  };
  while (true) {
    const streamed = options.onToken
      ? await callOpenAIResponsesStreamingPayload(baseUrl, apiKey, body, label, options.onToken, options.signal)
      : null;
    const payload = streamed
      ? streamed.payload ?? { status: "completed", output_text: streamed.text }
      : await postOpenAIResponses(baseUrl, apiKey, body, label, options.signal);
    if (payload.usage) options.onUsage?.(extractOpenAIResponsesUsage(payload.usage));
    if (payload.error?.message || (payload.status && payload.status !== "completed")) {
      extractOpenAIResponsesText(payload, label);
    }
    const functionCalls = (payload.output ?? []).filter((item) =>
      item.type === "function_call" && typeof item.name === "string" && typeof item.call_id === "string"
    );
    if (!functionCalls.length || !options.callMcpTool) {
      if (streamed?.text.trim()) return streamed.text;
      const text = extractVisibleText(payload);
      return text || "Provider returned no content.";
    }
    options.prepareToolBatch?.(functionCalls.map((toolCall) => ({
      providerToolName: toolCall.name as string,
      argumentsJson: toolCall.arguments ?? "{}"
    })));
    functionCalls.forEach((toolCall) => toolLoopDetector.record(toolCall.name!, toolCall.arguments ?? "{}"));
    // Capture/execute every tool call, settling so an approval-required tool
    // does not discard results of tools that already completed.
    const settled = await Promise.allSettled(functionCalls.map((toolCall) => options.callMcpTool!({
      providerToolName: toolCall.name!,
      argumentsJson: toolCall.arguments ?? "{}"
    })));
    const toolOutputs: Array<Record<string, unknown>> = [];
    let pendingApproval: { callId: string; name: string; args: string; error: unknown } | undefined;
    let firstError: unknown;
    settled.forEach((outcome, index) => {
      const toolCall = functionCalls[index]!;
      if (outcome.status === "fulfilled") {
        toolOutputs.push({ type: "function_call_output", call_id: toolCall.call_id, output: outcome.value });
      } else if (options.isApprovalError?.(outcome.reason) && !pendingApproval) {
        pendingApproval = { callId: toolCall.call_id as string, name: toolCall.name as string, args: toolCall.arguments ?? "{}", error: outcome.reason };
      } else if (firstError === undefined) {
        firstError = outcome.reason;
      }
    });
    if (pendingApproval) {
      attachProviderContinuation(pendingApproval.error, {
        transport: "openai-responses",
        messages: [...transcript, ...(payload.output ?? []), ...toolOutputs],
        pendingToolCall: { id: pendingApproval.callId, providerToolName: pendingApproval.name, argumentsJson: pendingApproval.args }
      });
      throw pendingApproval.error;
    }
    if (firstError !== undefined) throw firstError;
    const executedToolCalls = settled.flatMap((outcome, index) => {
      if (outcome.status !== "fulfilled") return [];
      const toolCall = functionCalls[index]!;
      return [{
        providerToolName: toolCall.name as string,
        argumentsJson: toolCall.arguments ?? "{}",
        result: outcome.value
      }];
    });
    if (options.shouldCompleteToolBatch?.(executedToolCalls)) {
      if (streamed?.text.trim()) return streamed.text;
      const text = extractVisibleText(payload);
      return text || "Structured source handoff completed.";
    }
    const needsContinuation = functionCalls.some((toolCall) => !options.isTerminalTool?.(toolCall.name as string));
    if (!needsContinuation) {
      // Only sink tools were called: the answer is this turn's streamed prose.
      if (streamed?.text.trim()) return streamed.text;
      const text = extractVisibleText(payload);
      if (text) return text;
      if (functionCalls.some((toolCall) => options.terminalToolCompletesTurn?.(toolCall.name as string))) {
        return "Prepared the requested update for review.";
      }
      transcript.push(...(payload.output ?? []), ...toolOutputs, {
        role: "user",
        content: [{
          type: "input_text",
          text: "The previous turn only called internal sink tools and did not include a visible chat answer. Provide the concise visible assistant answer now in normal prose. Do not call any tools."
        }]
      });
      body.input = transcript;
      delete body.previous_response_id;
      delete body.tools;
      body.tool_choice = "none";
      continue;
    }
    transcript.push(...(payload.output ?? []), ...toolOutputs);
    body.input = transcript;
    delete body.previous_response_id;
  }
}

export async function callOpenAIResponsesStreaming(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  label: string,
  onToken?: (text: string) => void,
  signal?: AbortSignal,
  onUsage?: (raw: RawLlmUsage) => void
): Promise<string> {
  const result = await callOpenAIResponsesStreamingPayload(baseUrl, apiKey, body, label, onToken, signal);
  if (result.payload?.usage) onUsage?.(extractOpenAIResponsesUsage(result.payload.usage));
  if (result.payload?.error?.message || (result.payload?.status && result.payload.status !== "completed")) {
    return extractOpenAIResponsesText(result.payload, label);
  }
  if (result.text.trim()) return result.text;
  if (result.payload) return extractOpenAIResponsesText(result.payload, label);
  return "Provider returned no content.";
}

export async function callOpenAIResponsesStreamingPayload(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  label: string,
  onToken?: (text: string) => void,
  signal?: AbortSignal
): Promise<{ text: string; payload: OpenAiResponsesPayload | null }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let emittedVisibleText = false;
    try {
      const result = await callOpenAIResponsesStreamingPayloadOnce(
        baseUrl,
        apiKey,
        body,
        label,
        (text) => {
          if (text) emittedVisibleText = true;
          onToken?.(text);
        },
        signal
      );
      const terminalError = result.payload?.error?.message;
      if (attempt === 0 && !emittedVisibleText && !signal?.aborted && terminalError && isTransientOpenAiResponsesError(terminalError)) continue;
      return result;
    } catch (error) {
      if (attempt === 0 && !emittedVisibleText && !signal?.aborted && isTransientOpenAiResponsesError(error)) continue;
      throw error;
    }
  }
  throw new Error(`${label} transient retry exhausted.`);
}

async function callOpenAIResponsesStreamingPayloadOnce(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  label: string,
  onToken?: (text: string) => void,
  signal?: AbortSignal
): Promise<{ text: string; payload: OpenAiResponsesPayload | null }> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal
  });

  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error(`${label} streaming response did not include a body.`);

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let text = "";
  let terminalPayload: OpenAiResponsesPayload | null = null;
  let streamError: string | null = null;

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
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      onToken?.(event.delta);
      return;
    }
    if ((event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") && event.response) {
      terminalPayload = event.response as OpenAiResponsesPayload;
      return;
    }
    if (event.type === "error") {
      const error = event.error as { message?: string } | undefined;
      streamError = error?.message ?? "Unknown OpenAI streaming error.";
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

  if (streamError) throw new Error(`${label} returned a streaming error: ${streamError}`);
  return { text, payload: terminalPayload };
}

export async function callOpenAIChatStreaming(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  label: string,
  onToken?: (text: string) => void,
  signal?: AbortSignal,
  onUsage?: (raw: RawLlmUsage) => void
): Promise<string> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    signal
  });

  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error(`${label} streaming response did not include a body.`);

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let text = "";
  let terminalMessageText: string | null = null;
  let rawUsage: RawLlmUsage | undefined;

  const extractChatContentText = (content: unknown): string | null => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return null;
    const joined = content
      .map((part) => {
        if (!part || typeof part !== "object") return null;
        const record = part as Record<string, unknown>;
        return typeof record.text === "string"
          ? record.text
          : typeof record.content === "string"
            ? record.content
            : null;
      })
      .filter((part): part is string => Boolean(part))
      .join("");
    return joined || null;
  };

  const consumeEvent = (eventText: string): void => {
    const dataLines = eventText.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, ""));
    if (!dataLines.length) return;
    const dataText = dataLines.join("\n");
    if (!dataText || dataText === "[DONE]") return;
    let event: {
      choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    try {
      event = JSON.parse(dataText) as {
        choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };
    } catch {
      return;
    }
    if (event.usage) rawUsage = extractOpenAIChatUsage(event.usage);
    const choice = event.choices?.[0];
    const delta = extractChatContentText(choice?.delta?.content);
    if (delta) {
      text += delta;
      onToken?.(delta);
    }
    const messageText = extractChatContentText(choice?.message?.content);
    if (!messageText) return;
    terminalMessageText = messageText;
    if (!text) {
      text = messageText;
      onToken?.(messageText);
      return;
    }
    if (messageText.startsWith(text) && messageText.length > text.length) {
      const suffix = messageText.slice(text.length);
      text = messageText;
      onToken?.(suffix);
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
  if (rawUsage) onUsage?.(rawUsage);
  let finalText = text;
  const terminalText = typeof terminalMessageText === "string" ? terminalMessageText : "";
  if (terminalText.trim()) {
    if (terminalText.startsWith(text)) finalText = terminalText;
    else if (!text.startsWith(terminalText) && terminalText.length > text.length) finalText = terminalText;
  }
  return finalText.trim() ? finalText : "Provider returned no content.";
}

export type OpenAIChatToolCall = { id: string; name: string; arguments: string };
export type OpenAIChatStreamResult = { text: string; toolCalls: OpenAIChatToolCall[]; usage?: RawLlmUsage };

/**
 * Streams an OpenAI Chat Completions response, surfacing text token deltas via
 * `onToken` while accumulating streamed `tool_calls` fragments (by index) so the
 * research tool loop streams every iteration rather than blocking.
 */
export async function streamOpenAIChatCompletion(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  label: string,
  onToken?: (text: string) => void,
  signal?: AbortSignal
): Promise<OpenAIChatStreamResult> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    signal
  });
  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error(`${label} streaming response did not include a body.`);

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let text = "";
  let rawUsage: RawLlmUsage | undefined;
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

  const consumeEvent = (eventText: string): void => {
    const dataLines = eventText.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, ""));
    if (!dataLines.length) return;
    const dataText = dataLines.join("\n");
    if (!dataText || dataText === "[DONE]") return;
    let event: {
      choices?: Array<{
        delta?: {
          content?: unknown;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    try {
      event = JSON.parse(dataText);
    } catch {
      return;
    }
    // The final streamed chunk carries `usage` (with an empty choices array).
    if (event.usage) rawUsage = extractOpenAIChatUsage(event.usage);
    const delta = event.choices?.[0]?.delta;
    if (typeof delta?.content === "string" && delta.content) {
      text += delta.content;
      onToken?.(delta.content);
    }
    for (const toolCall of delta?.tool_calls ?? []) {
      const index = typeof toolCall.index === "number" ? toolCall.index : 0;
      const existing = toolAcc.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof toolCall.id === "string" && toolCall.id) existing.id = toolCall.id;
      if (toolCall.function?.name) existing.name = toolCall.function.name;
      if (typeof toolCall.function?.arguments === "string") existing.arguments += toolCall.function.arguments;
      toolAcc.set(index, existing);
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

  const toolCalls = [...toolAcc.values()]
    .filter((toolCall) => toolCall.name)
    .map((toolCall) => ({ id: toolCall.id || `call_${toolCall.name}`, name: toolCall.name, arguments: toolCall.arguments }));
  return { text, toolCalls, usage: rawUsage };
}

export async function buildOpenAIResearchResponsesBody(
  provider: Provider,
  userMessage: string,
  options: ResearchProviderOptions,
  policy: PhaseModelPolicy
): Promise<Record<string, unknown>> {
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  // Stable system-equivalent (instructions + policy + scoped context) goes in
  // `instructions`; OpenAI applies automatic prefix caching to it. Prior turns
  // and the current message form a real multi-turn `input` array.
  const instructions = [
    researchSystemInstructions(options),
    phasePolicyText("brainstorming", policy, profile),
    researchStableContextText(options)
  ].filter((part) => part.trim()).join("\n\n");
  const currentText = await researchCurrentMessageText(userMessage, options);
  const imageContent = profile.supportsImageInput ? await openAiResponsesImageContent(options.imageAttachments) : [];
  const input: Array<Record<string, unknown>> = researchHistoryThread(userMessage, options).map((turn) => ({
    role: turn.role,
    // Stored research history retains assistant text, not the complete
    // provider output item (id/status/type). Replay it as an easy input message
    // instead of an incomplete output_text item, which strict Responses
    // implementations reject on the second turn.
    content: turn.role === "assistant"
      ? turn.text
      : [{ type: "input_text", text: turn.text }]
  }));
  const lastInput = input[input.length - 1];
  const currentContent = [{ type: "input_text", text: currentText }, ...imageContent];
  if (lastInput && lastInput.role === "user") {
    lastInput.content = [...(lastInput.content as Array<Record<string, unknown>>), ...currentContent];
  } else {
    input.push({ role: "user", content: currentContent });
  }
  const body: Record<string, unknown> = {
    model: policy.modelOverride?.trim() || provider.model || "gpt-5.5",
    instructions,
    input,
    tool_choice: "auto"
  };
  addOpenAiResponsesVerbosity(body, provider, String(body.model));
  const tools = [
    ...(options.webSearchEnabled ? [{ type: "web_search" }] : []),
    ...openAiResponsesTools(options.mcpTools ?? [])
  ];
  if (tools.length) body.tools = tools;
  if (profile.supportsMaxOutputTokens && policy.maxOutputTokens) body.max_output_tokens = policy.maxOutputTokens;
  const effort = reasoningEffort(policy.reasoningMode);
  if (profile.reasoningField === "reasoning_effort" && effort) body.reasoning = { effort };
  return body;
}

export async function buildOpenAIResearchChatCompletionsBody(
  provider: Provider,
  userMessage: string,
  options: ResearchProviderOptions,
  policy: PhaseModelPolicy
): Promise<Record<string, unknown>> {
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  const currentText = await researchCurrentMessageText(userMessage, options);
  // Stable system first (instructions + policy + scoped context) for automatic
  // prefix caching, then prior turns as real messages, then the current turn.
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: [researchSystemInstructions(options), phasePolicyText("brainstorming", policy, profile), researchStableContextText(options)]
        .filter((part) => part.trim())
        .join("\n\n")
    },
    ...researchHistoryThread(userMessage, options).map((turn) => ({ role: turn.role, content: turn.text as unknown }))
  ];
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === "user" && typeof lastMessage.content === "string") {
    lastMessage.content = `${lastMessage.content}\n\n${currentText}`;
  } else {
    messages.push({ role: "user", content: currentText });
  }
  const body: Record<string, unknown> = {
    model: policy.modelOverride?.trim() || provider.model || "gpt-5.5",
    messages
  };
  if (profile.supportsTemperature && policy.temperature !== undefined) body.temperature = policy.temperature;
  addOpenAiTokenLimit(body, String(body.model ?? ""), profile.supportsMaxOutputTokens ? policy.maxOutputTokens : undefined);
  const effort = reasoningEffort(policy.reasoningMode);
  if (profile.reasoningField === "reasoning_effort" && effort) body.reasoning_effort = effort;
  return body;
}

export function objectSchema(inputSchema: unknown): Record<string, unknown> {
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) return inputSchema as Record<string, unknown>;
  return { type: "object", additionalProperties: false, properties: {} };
}

export function openAiMcpTools(tools: ProviderMcpTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.providerToolName,
      description: tool.description || `${tool.serverLabel}: ${tool.toolName}`,
      parameters: objectSchema(tool.inputSchema)
    }
  }));
}

export function openAiResponsesTools(tools: ProviderMcpTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    name: tool.providerToolName,
    description: tool.description || `${tool.serverLabel}: ${tool.toolName}`,
    parameters: objectSchema(tool.inputSchema)
  }));
}

export function anthropicMcpTools(tools: ProviderMcpTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.providerToolName,
    description: tool.description || `${tool.serverLabel}: ${tool.toolName}`,
    input_schema: objectSchema(tool.inputSchema)
  }));
}

export function buildOpenAICompatibleBody(
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
  const body: Record<string, unknown> = {
    model: policy.modelOverride?.trim() || provider.model || "gpt-5.5",
    messages: bareExtraction
      ? [
          { role: "system", content: extractionSystemPrompt },
          { role: "user", content: contextText }
        ]
      : [
      {
        role: "system",
        content: orchestratorSystemPrompt
      },
      {
        role: "user",
        content: [
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
  if (profile.supportsTemperature && policy.temperature !== undefined) body.temperature = policy.temperature;
  addOpenAiTokenLimit(body, String(body.model ?? ""), profile.supportsMaxOutputTokens ? policy.maxOutputTokens : undefined);
  const effort = reasoningEffort(policy.reasoningMode);
  if (profile.reasoningField === "reasoning_effort" && effort) body.reasoning_effort = effort;
  return body;
}

export function buildOpenAIResponsesBody(
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
  const model = openAiModel(provider, policy);
  const body: Record<string, unknown> = {
    model,
    instructions: bareExtraction ? extractionSystemPrompt : orchestratorSystemPrompt,
    input: bareExtraction ? contextText : [
      `Prompt summary: ${promptSummary}`,
      `ArchiCode phase: ${phase}.`,
      phaseHandoffInstructions(phase, structuredSourceHandoff),
      phasePolicyText(phase, policy, profile),
      selectedSkillsPrompt.trim(),
      imageAttachmentText(imageAttachments),
      webSearchEnabled
        ? "Web access is enabled. Use available web search tooling when current external information is required."
        : "Web search is disabled for this run.",
      "",
      "Project JSON context:",
      contextText
    ].join("\n")
  };
  addOpenAiResponsesVerbosity(body, provider, model);
  if (webSearchEnabled) body.tools = [{ type: "web_search" }];
  if (profile.supportsMaxOutputTokens && policy.maxOutputTokens) body.max_output_tokens = policy.maxOutputTokens;
  const effort = reasoningEffort(policy.reasoningMode);
  if (profile.reasoningField === "reasoning_effort" && effort) body.reasoning = { effort };
  return body;
}

export async function checkOpenAICompatible(provider: Provider, apiKey: string): Promise<{
  detectedContextWindowTokens?: number;
  availableModels: string[];
  detectedModelCapabilities: ProjectSettings["providers"][number]["detectedModelCapabilities"];
  detectedOpenAiEndpointMode?: OpenAiEndpointMode;
}> {
  const baseUrl = provider.baseUrl ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compatible health check failed with ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  const availableModels = extractModelIdsFromModels(payload);
  const detectedOpenAiEndpointMode = await detectOpenAIEndpointMode(provider, apiKey, availableModels);
  return {
    detectedContextWindowTokens: extractContextWindowFromModels(payload, provider.model),
    availableModels,
    detectedModelCapabilities: extractModelCapabilitiesFromModels(payload, provider.kind),
    detectedOpenAiEndpointMode
  };
}

export async function detectOpenAIEndpointMode(provider: Provider, apiKey: string, availableModels: string[]): Promise<OpenAiEndpointMode> {
  if (provider.openAiEndpointMode === "responses") {
    await probeOpenAIResponses(provider, apiKey, availableModels);
    return "responses";
  }
  if (provider.openAiEndpointMode === "chat-completions") {
    await probeOpenAIChatCompletions(provider, apiKey, availableModels);
    return "chat-completions";
  }
  try {
    await probeOpenAIResponses(provider, apiKey, availableModels);
    return "responses";
  } catch (error) {
    if (!isOpenAiEndpointUnsupported(error)) throw error;
    await probeOpenAIChatCompletions(provider, apiKey, availableModels);
    return "chat-completions";
  }
}

export async function probeOpenAIResponses(provider: Provider, apiKey: string, availableModels: string[]): Promise<void> {
  const model = provider.model || availableModels[0] || "gpt-5.5";
  const body = { model, input: "Reply with ok.", max_output_tokens: openAiHealthProbeMaxOutputTokens };
  const baseUrl = provider.baseUrl ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`OpenAI-compatible Responses probe failed with ${response.status}: ${await response.text()}`);
}

export async function probeOpenAIChatCompletions(provider: Provider, apiKey: string, availableModels: string[]): Promise<void> {
  const model = provider.model || availableModels[0] || "gpt-5.5";
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: "Reply with ok." }]
  };
  addOpenAiTokenLimit(body, model, openAiHealthProbeMaxOutputTokens);
  const baseUrl = provider.baseUrl ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`OpenAI-compatible Chat Completions probe failed with ${response.status}: ${await response.text()}`);
}
