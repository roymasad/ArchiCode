import type { ProjectSettings } from "./schema";

type Provider = ProjectSettings["providers"][number];

const codexLocalDefaultModel = "gpt-5.5";
const claudeLocalDefaultModel = "claude default";

export type ContextBudgetPlan = {
  mode: "auto" | "manual";
  providerLabel: string;
  modelLabel: string;
  source: "manual" | "provider-override" | "provider-detected" | "known-model" | "fallback";
  modelContextTokens: number;
  usableContextTokens: number;
  compactionThreshold: number;
  summaryReserveTokens: number;
  responseReserveTokens: number;
  safetyReserveTokens: number;
  recentRunLimit: number;
  artifactLimit: number;
};

export type ResearchChatContextPlan = {
  modelContextTokens: number;
  recentMessageLimit: number;
  compactionTriggerLimit: number;
  historyTokenBudget: number;
};

export function deriveContextBudgetPlan(settings: ProjectSettings): ContextBudgetPlan {
  const provider = settings.providers.find((item) => item.enabled) ?? settings.providers[0];
  const mode = settings.contextBudgetMode ?? "auto";

  if (mode === "manual") {
    return {
      mode,
      providerLabel: provider?.label ?? "No provider selected",
      modelLabel: providerModelLabel(provider),
      source: "manual",
      modelContextTokens: settings.contextTokenBudget,
      usableContextTokens: settings.contextTokenBudget,
      compactionThreshold: settings.compactionThreshold,
      summaryReserveTokens: Math.floor(settings.contextTokenBudget * 0.1),
      responseReserveTokens: Math.floor(settings.contextTokenBudget * 0.15),
      safetyReserveTokens: Math.max(0, settings.contextTokenBudget - settings.compactionThreshold),
      recentRunLimit: settings.contextBuilder.recentRunLimit,
      artifactLimit: settings.contextBuilder.artifactLimit
    };
  }

  const inferred = inferModelContextTokens(provider);
  const modelContextTokens = inferred.tokens;
  const responseReserveTokens = Math.floor(modelContextTokens * 0.15);
  const summaryReserveTokens = Math.floor(modelContextTokens * 0.1);
  const safetyReserveTokens = Math.floor(modelContextTokens * 0.05);
  const usableContextTokens = Math.floor(modelContextTokens * 0.8);
  const compactionThreshold = Math.floor(modelContextTokens * 0.7);

  return {
    mode,
    providerLabel: provider?.label ?? "No provider selected",
    modelLabel: providerModelLabel(provider),
    source: inferred.source,
    modelContextTokens,
    usableContextTokens,
    compactionThreshold,
    summaryReserveTokens,
    responseReserveTokens,
    safetyReserveTokens,
    recentRunLimit: automaticRecentRunLimit(modelContextTokens),
    artifactLimit: automaticArtifactLimit(modelContextTokens)
  };
}

function providerModelLabel(provider?: Provider): string {
  if (!provider) return "no provider selected";
  if (provider.kind === "offline-manual") return "no model API";
  if (provider.kind === "codex-local" && !provider.model?.trim()) return `Codex default (${codexLocalDefaultModel})`;
  if (provider.kind === "claude-local" && !provider.model?.trim()) return `Claude Code default (${claudeLocalDefaultModel})`;
  return provider.model?.trim() || provider.kind;
}

export function inferModelContextTokens(provider?: Provider): { tokens: number; source: ContextBudgetPlan["source"] } {
  if (!provider) return { tokens: 32000, source: "fallback" };
  if (provider.contextWindowTokens) return { tokens: provider.contextWindowTokens, source: "provider-override" };
  const knownFloor = knownContextWindowFloorForProvider(provider);
  if (provider.detectedContextWindowTokens) {
    if (knownFloor && provider.detectedContextWindowTokens < knownFloor) return { tokens: knownFloor, source: "known-model" };
    return { tokens: provider.detectedContextWindowTokens, source: "provider-detected" };
  }
  if (provider.kind === "offline-manual") return { tokens: 32000, source: "fallback" };
  if (provider.kind === "codex-local") {
    const codexModel = provider.model?.toLowerCase().trim() || codexLocalDefaultModel;
    if (knownFloor) return { tokens: knownFloor, source: "known-model" };
    if (codexModel.includes("gpt-5.3-codex-spark")) return { tokens: 128000, source: "known-model" };
    if (codexModel.includes("gpt-5.5") || codexModel.includes("gpt-5.4")) return { tokens: 272000, source: "known-model" };
    if (codexModel.includes("gpt-5")) return { tokens: 272000, source: "known-model" };
  }
  if (provider.kind === "claude-local" && !provider.model?.trim()) {
    return { tokens: 200000, source: "known-model" };
  }

  const model = provider.model?.toLowerCase().trim() ?? "";
  if (!model) return provider.kind === "anthropic-compatible"
    ? { tokens: 200000, source: "known-model" }
    : { tokens: 128000, source: "fallback" };
  if (knownFloor) return { tokens: knownFloor, source: "known-model" };
  if (model.includes("gpt-5.5") || model.includes("gpt-5.4")) return { tokens: model.includes("mini") || model.includes("nano") ? 400000 : 1000000, source: "known-model" };
  if (model.includes("claude-fable-5") || model.includes("claude-opus-4-8") || model.includes("claude-sonnet-4-6")) return { tokens: 1000000, source: "known-model" };
  if (model.includes("claude-haiku-4-5")) return { tokens: 200000, source: "known-model" };
  if (model.includes("claude")) return { tokens: 200000, source: "known-model" };
  if (model.includes("gpt-5")) return { tokens: 400000, source: "known-model" };
  if (model.includes("gpt-4.1") || model.includes("gpt-4o") || model.includes("o3") || model.includes("o4")) return { tokens: 128000, source: "known-model" };
  if (model.includes("qwen") || model.includes("llama")) return { tokens: 128000, source: "known-model" };
  if (model.includes("deepseek")) return { tokens: 64000, source: "known-model" };
  if (model.includes("mini") || model.includes("haiku")) return { tokens: 64000, source: "known-model" };
  if (model.includes("local") || model.includes("manual")) return { tokens: 32000, source: "fallback" };
  return { tokens: 64000, source: "fallback" };
}

function knownContextWindowFloorForProvider(provider: Provider): number | undefined {
  const model = (provider.kind === "codex-local"
    ? provider.model?.trim() || codexLocalDefaultModel
    : provider.model?.trim() ?? "").toLowerCase();
  if (model.includes("gpt-5.6")) return 1050000;
  return undefined;
}

export function deriveResearchChatContextPlan(settings: ProjectSettings): ResearchChatContextPlan {
  const provider = settings.providers.find((item) => item.enabled) ?? settings.providers[0];
  const modelContextTokens = (settings.contextBudgetMode ?? "auto") === "manual"
    ? settings.contextTokenBudget
    : inferModelContextTokens(provider).tokens;
  const recentMessageLimit = automaticResearchMessageLimit(modelContextTokens);
  return {
    modelContextTokens,
    recentMessageLimit,
    compactionTriggerLimit: automaticResearchCompactionTriggerLimit(recentMessageLimit),
    historyTokenBudget: automaticResearchHistoryTokenBudget(modelContextTokens)
  };
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function automaticRecentRunLimit(modelContextTokens: number): number {
  if (modelContextTokens >= 128000) return 8;
  if (modelContextTokens >= 64000) return 6;
  return 4;
}

function automaticArtifactLimit(modelContextTokens: number): number {
  if (modelContextTokens >= 128000) return 20;
  if (modelContextTokens >= 64000) return 12;
  return 8;
}

function automaticResearchMessageLimit(modelContextTokens: number): number {
  if (modelContextTokens >= 200000) return 64;
  if (modelContextTokens >= 128000) return 48;
  if (modelContextTokens >= 64000) return 40;
  return 32;
}

function automaticResearchCompactionTriggerLimit(recentMessageLimit: number): number {
  const buffer = Math.max(16, Math.min(80, Math.floor(recentMessageLimit * 0.25)));
  return recentMessageLimit + buffer;
}

function automaticResearchHistoryTokenBudget(modelContextTokens: number): number {
  // 25% above the old 8% budget: batched history eviction retains 75% of the
  // window after each eviction, so the bigger budget keeps the effective
  // retained history at least as large as before while the (mostly cached)
  // extra tokens cost less than the old always-rebilled sliding window.
  const proportionalBudget = Math.floor(modelContextTokens * 0.10);
  return Math.max(15000, Math.min(80000, proportionalBudget));
}
