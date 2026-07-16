import type { ProjectSettings } from "./schema";

export type ProviderSettingsLike = ProjectSettings["providers"][number];

export type ProviderImageInputSupportStatus = "supported" | "unsupported" | "unknown";

function normalizeModelId(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

function detectedImageInputSupport(
  provider: Pick<ProviderSettingsLike, "model" | "detectedModelCapabilities">,
  modelOverride?: string
): boolean | undefined {
  const modelId = (modelOverride ?? provider.model ?? "").trim();
  if (!modelId) return undefined;
  const direct = provider.detectedModelCapabilities?.[modelId];
  if (typeof direct?.supportsImageInput === "boolean") return direct.supportsImageInput;
  const normalized = normalizeModelId(modelId);
  if (!normalized) return undefined;
  for (const [key, capability] of Object.entries(provider.detectedModelCapabilities ?? {})) {
    if (normalizeModelId(key) === normalized && typeof capability?.supportsImageInput === "boolean") {
      return capability.supportsImageInput;
    }
  }
  return undefined;
}

export function heuristicImageInputSupportStatus(
  providerKind: ProviderSettingsLike["kind"],
  model?: string
): ProviderImageInputSupportStatus {
  if (providerKind === "offline-manual") return "unsupported";
  if (providerKind === "codex-local" || providerKind === "claude-local") return "supported";
  const normalized = normalizeModelId(model);
  if (!normalized) return "unknown";
  if (providerKind === "anthropic-compatible") {
    return normalized.includes("claude") ? "supported" : "unknown";
  }
  if (/\b(embedding|embed|rerank|search|moderation|tts|transcribe|whisper|speech|audio|realtime|dall-e|sora|text-)\b/.test(normalized)) {
    return "unsupported";
  }
  if (/\b(vision|multimodal|omni|pixtral|llava|moondream)\b/.test(normalized) || /(?:^|[-_.])(vl|img)(?:[-_.]|$)/.test(normalized)) {
    return "supported";
  }
  if (/^(gpt-5|gpt-4\.1|gpt-4o|o[134](?:[\.-]|$)|claude-|gemini-)/.test(normalized)) {
    return "supported";
  }
  return providerKind === "openai-compatible" ? "unknown" : "unsupported";
}

export function providerImageInputSupportStatus(
  provider: Pick<ProviderSettingsLike, "kind" | "model" | "detectedModelCapabilities">,
  modelOverride?: string
): { status: ProviderImageInputSupportStatus; source: "detected" | "heuristic" } {
  const detected = detectedImageInputSupport(provider, modelOverride);
  if (typeof detected === "boolean") {
    return { status: detected ? "supported" : "unsupported", source: "detected" };
  }
  return {
    status: heuristicImageInputSupportStatus(provider.kind, modelOverride ?? provider.model),
    source: "heuristic"
  };
}

export function providerHasCompletedCapabilityCheck(
  provider: Pick<
    ProviderSettingsLike,
    "kind" | "detectedAvailableModels" | "detectedModelCapabilities" | "detectedContextWindowTokens" | "detectedOpenAiEndpointMode"
  >
): boolean {
  return provider.kind === "codex-local" ||
    provider.kind === "claude-local" ||
    provider.detectedAvailableModels.length > 0 ||
    Object.keys(provider.detectedModelCapabilities ?? {}).length > 0 ||
    typeof provider.detectedContextWindowTokens === "number" ||
    Boolean(provider.detectedOpenAiEndpointMode);
}

export function providerSupportsImageInput(
  provider: Pick<ProviderSettingsLike, "kind" | "model" | "detectedModelCapabilities">,
  modelOverride?: string
): boolean {
  return providerImageInputSupportStatus(provider, modelOverride).status === "supported";
}
