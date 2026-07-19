import type { LlmUsage, ModelPricing } from "./schema";

export function mergeReasoningReplayStates(
  states: Array<LlmUsage["reasoningReplayState"]>
): LlmUsage["reasoningReplayState"] {
  const observed = new Set(states.filter((state): state is NonNullable<LlmUsage["reasoningReplayState"]> => Boolean(state)));
  if (!observed.size) return undefined;
  if (observed.has("mixed") || observed.size > 1) return "mixed";
  return observed.values().next().value;
}

type ProviderLike = {
  kind: string;
  model?: string;
  pricing?: ModelPricing;
};

type PricingEntry = ModelPricing & {
  match: (model: string, kind: string) => boolean;
};

// Default USD pricing per *million* tokens. Verified against each provider's
// official pricing pages (Anthropic docs.anthropic.com, OpenAI
// developers.openai.com/api/docs/pricing, DeepSeek api-docs.deepseek.com, Together AI
// together.ai/pricing for hosted open models). Users can override per-provider
// via provider.pricing. Entries are checked top-down; the first match wins, so
// more specific variants (pro/mini/nano) MUST precede the family fallback.
//
// Anthropic: cache-write uses the 5-minute rate (1.25x input) which is the
// default caching duration the codebase sets; the 1h rate (2x input) is not
// used. `input_tokens` is already non-cached; cache read billed at ~0.1x input.
// OpenAI: there is no separate cache-write charge — the first pass bills at the
// full input rate and subsequent reads at the "cached input" rate, so
// cacheCreationTokens is always 0 for OpenAI transports and cacheWritePerMTok
// is set equal to input (unused in practice).
// OpenAI entries use the direct API Standard, short-context token rates. Batch,
// Flex, Priority, regional, and long-context variants are not selected here.
// DeepSeek: context caching is automatic; cache hit is billed at ~0.02x input,
// cache miss at full input. No separate write premium.
const DEFAULT_PRICING_TABLE: PricingEntry[] = [
  // --- Anthropic Claude (5m cache-write = 1.25x input) ---
  {
    inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1, cacheWritePerMTok: 12.5,
    match: (m) => m.includes("claude-fable-5") || m.includes("claude-mythos")
  },
  {
    inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25,
    match: (m) => m.includes("opus-4-8") || m.includes("opus-4-7") || m.includes("opus-4-6") || m.includes("opus-4-5") || m === "claude-opus"
  },
  {
    inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75,
    match: (m) => m.includes("opus-4-1") || m.includes("opus-4-0") || m.includes("claude-3-opus")
  },
  {
    // Claude Sonnet 5 has introductory pricing through Aug 31, 2026; update this
    // row to the standard $3/$15 rate when Anthropic's Sep 1, 2026 pricing starts.
    inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5,
    match: (m) => m.includes("sonnet-5")
  },
  {
    inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75,
    match: (m) => m.includes("claude-sonnet") || m.includes("sonnet-4-6") || m.includes("sonnet-4-5")
  },
  {
    inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25,
    match: (m) => m.includes("claude-haiku-4-5") || m.includes("haiku-4-5") || m.includes("claude-haiku")
  },
  {
    // Retired Haiku 3.5 price; kept so legacy sessions still resolve.
    inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheWritePerMTok: 1,
    match: (m) => m.includes("haiku-3")
  },
  {
    // Generic Anthropic fallback (any other Claude model).
    inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75,
    match: (_m, k) => k.includes("anthropic") || _m.includes("claude")
  },
  // --- OpenAI GPT-5.x (pro/mini/nano BEFORE the family fallback) ---
  {
    // GPT-5.6 uses the direct API Standard, short-context rates. Cache-write
    // rates are recorded for completeness; OpenAI usage currently exposes
    // cache reads only, so normal OpenAI calls never bill this field.
    inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25,
    match: (m) => m.includes("gpt-5.6-sol")
  },
  {
    inputPerMTok: 2.5, outputPerMTok: 15, cacheReadPerMTok: 0.25, cacheWritePerMTok: 3.125,
    match: (m) => m.includes("gpt-5.6-terra")
  },
  {
    inputPerMTok: 1, outputPerMTok: 6, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25,
    match: (m) => m.includes("gpt-5.6-luna")
  },
  {
    // Pro models have no prompt-caching discount (cached input shown as "-").
    inputPerMTok: 30, outputPerMTok: 180,
    match: (m) => m.includes("gpt-5.5-pro") || m.includes("gpt-5.4-pro") || m.includes("gpt-5-pro")
  },
  {
    inputPerMTok: 0.2, outputPerMTok: 1.25, cacheReadPerMTok: 0.02, cacheWritePerMTok: 0.2,
    match: (m) => m.includes("gpt-5.4-nano") || m.includes("gpt-5.5-nano")
  },
  {
    inputPerMTok: 0.75, outputPerMTok: 4.5, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0.75,
    match: (m) => m.includes("gpt-5.4-mini") || m.includes("gpt-5.5-mini")
  },
  {
    inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5, cacheWritePerMTok: 5,
    match: (m) => m.includes("gpt-5.5")
  },
  {
    inputPerMTok: 2.5, outputPerMTok: 15, cacheReadPerMTok: 0.25, cacheWritePerMTok: 2.5,
    match: (m) => m.includes("gpt-5.4")
  },
  {
    // Codex local specialized model.
    inputPerMTok: 1.75, outputPerMTok: 14, cacheReadPerMTok: 0.175, cacheWritePerMTok: 1.75,
    match: (m) => m.includes("gpt-5.3-codex") || m.includes("codex")
  },
  {
    inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5, cacheWritePerMTok: 5,
    match: (m) => m.includes("gpt-5") || m.includes("gpt5")
  },
  // --- OpenAI o-series reasoning (legacy; not in the current standard table) ---
  {
    // o4-mini inference price (from the fine-tuning inference table).
    inputPerMTok: 4, outputPerMTok: 16, cacheReadPerMTok: 1, cacheWritePerMTok: 4,
    match: (m) => m.includes("o4-mini")
  },
  {
    inputPerMTok: 10, outputPerMTok: 40, cacheReadPerMTok: 1, cacheWritePerMTok: 10,
    match: (m) => m.includes("o3") || m.includes("o4")
  },
  // --- OpenAI GPT-4.x (legacy; not in the current standard table) ---
  {
    inputPerMTok: 0.1, outputPerMTok: 0.4, cacheReadPerMTok: 0.025, cacheWritePerMTok: 0.1,
    match: (m) => m.includes("gpt-4.1-nano")
  },
  {
    inputPerMTok: 0.4, outputPerMTok: 1.6, cacheReadPerMTok: 0.1, cacheWritePerMTok: 0.4,
    match: (m) => m.includes("gpt-4.1-mini")
  },
  {
    inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5, cacheWritePerMTok: 2,
    match: (m) => m.includes("gpt-4.1")
  },
  {
    inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25, cacheWritePerMTok: 2.5,
    match: (m) => m.includes("gpt-4o") || m.includes("gpt-4")
  },
  // --- DeepSeek (automatic context caching; cache hit ~0.02x input) ---
  {
    inputPerMTok: 0.435, outputPerMTok: 0.87, cacheReadPerMTok: 0.003625, cacheWritePerMTok: 0.435,
    match: (m) => m.includes("deepseek-v4-pro")
  },
  {
    inputPerMTok: 0.14, outputPerMTok: 0.28, cacheReadPerMTok: 0.0028, cacheWritePerMTok: 0.14,
    match: (m) => m.includes("deepseek")
  },
  // --- xAI Grok (verified docs.x.ai; no published cache rates, defaults applied) ---
  {
    inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1,
    match: (m) => m.includes("grok-build")
  },
  {
    inputPerMTok: 2, outputPerMTok: 6, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2,
    match: (m) => m.includes("grok-4-5") || m.includes("grok-4.5")
  },
  {
    inputPerMTok: 1.25, outputPerMTok: 2.5, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.25,
    match: (m) => m.includes("grok-4-3") || m.includes("grok-4.3") || m.includes("grok-4-2") || m.includes("grok-4.20") || m.includes("grok")
  },
  // --- Moonshot Kimi (verified together.ai; cached input shown) ---
  {
    inputPerMTok: 0.95, outputPerMTok: 4, cacheReadPerMTok: 0.19, cacheWritePerMTok: 0.95,
    match: (m) => m.includes("k2.7-code") || m.includes("k27-code") || m.includes("kimi-k2.7-code")
  },
  {
    inputPerMTok: 1.2, outputPerMTok: 4.5, cacheReadPerMTok: 0.2, cacheWritePerMTok: 1.2,
    match: (m) => m.includes("k2.6") || m.includes("k26") || m.includes("kimi-k2.6")
  },
  {
    inputPerMTok: 1.2, outputPerMTok: 4.5, cacheReadPerMTok: 0.2, cacheWritePerMTok: 1.2,
    match: (m) => m.includes("kimi") || m.includes("moonshot")
  },
  // --- Zhipu GLM (verified together.ai; cached input shown) ---
  {
    inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26, cacheWritePerMTok: 1.4,
    match: (m) => m.includes("glm")
  },
  // --- MiniMax (verified together.ai; cached input shown) ---
  {
    inputPerMTok: 0.3, outputPerMTok: 1.2, cacheReadPerMTok: 0.06, cacheWritePerMTok: 0.3,
    match: (m) => m.includes("minimax")
  },
  // --- Xiaomi MiMo (UNVERIFIED — small open 7B; conservative open-model
  //     placeholder until an official hosted price is confirmed. Override via
  //     provider.pricing if you serve it on a priced endpoint.) ---
  {
    inputPerMTok: 0.15, outputPerMTok: 0.15, cacheReadPerMTok: 0.015, cacheWritePerMTok: 0.15,
    match: (m) => m.includes("mimo")
  },
  // --- Other hosted open models (Together AI serverless prices) ---
  {
    inputPerMTok: 0.32, outputPerMTok: 1.28, cacheReadPerMTok: 0.032, cacheWritePerMTok: 0.32,
    match: (m) => m.includes("qwen")
  },
  {
    inputPerMTok: 1.04, outputPerMTok: 1.04, cacheReadPerMTok: 0.104, cacheWritePerMTok: 1.04,
    match: (m) => m.includes("llama")
  }
];

// Conservative fallback for unknown models so cost is always computable; the
// `matched` flag lets callers annotate "estimated pricing" in tooltips.
const FALLBACK_PRICING: ModelPricing = {
  inputPerMTok: 1,
  outputPerMTok: 5,
  cacheReadPerMTok: 0.1,
  cacheWritePerMTok: 1.25
};

function normalizePricing(pricing: ModelPricing): Required<Pick<ModelPricing, "inputPerMTok" | "outputPerMTok" | "cacheReadPerMTok" | "cacheWritePerMTok">> {
  return {
    inputPerMTok: pricing.inputPerMTok,
    outputPerMTok: pricing.outputPerMTok,
    cacheReadPerMTok: pricing.cacheReadPerMTok ?? pricing.inputPerMTok * 0.1,
    cacheWritePerMTok: pricing.cacheWritePerMTok ?? pricing.inputPerMTok * 1.25
  };
}

export function resolveModelPricing(
  modelId: string,
  providerKind: string,
  override?: ModelPricing
): { pricing: ModelPricing; matched: boolean } {
  if (override) return { pricing: override, matched: true };
  const model = modelId.toLowerCase().trim();
  for (const entry of DEFAULT_PRICING_TABLE) {
    if (entry.match(model, providerKind.toLowerCase())) {
      const { match: _match, ...pricing } = entry;
      return { pricing, matched: true };
    }
  }
  return { pricing: FALLBACK_PRICING, matched: false };
}

// Computes USD cost for a single usage record. `inputTokens` is the non-cached
// billable input; cache hits split into cache-read/cache-write at their own
// rates; `outputTokens` (incl. thinking) bills at the output rate. Thinking
// tokens are a detail subset of output and are NOT billed separately here.
// Token fields are optional so raw extracted usage (before normalization) can
// be passed directly.
export function computeLlmCost(
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number },
  pricing: ModelPricing
): number {
  const p = normalizePricing(pricing);
  const inputCost = ((usage.inputTokens ?? 0) / 1_000_000) * p.inputPerMTok;
  const cacheReadCost = ((usage.cacheReadTokens ?? 0) / 1_000_000) * p.cacheReadPerMTok;
  const cacheWriteCost = ((usage.cacheCreationTokens ?? 0) / 1_000_000) * p.cacheWritePerMTok;
  const outputCost = ((usage.outputTokens ?? 0) / 1_000_000) * p.outputPerMTok;
  return roundCost(inputCost + cacheReadCost + cacheWriteCost + outputCost);
}

export function computeUsageCost(usage: LlmUsage, provider: ProviderLike): number {
  const { pricing } = resolveModelPricing(usage.modelId, provider.kind, provider.pricing);
  return computeLlmCost(usage, pricing);
}

export function computeUsageCostDetails(usage: LlmUsage, provider: ProviderLike): { costUsd: number; estimated: boolean } {
  const { pricing, matched } = resolveModelPricing(usage.modelId, provider.kind, provider.pricing);
  return {
    costUsd: computeLlmCost(usage, pricing),
    estimated: !matched
  };
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// Merges multiple usage records into one aggregate (summing tokens, costUsd,
// and call counts). Skips undefined and `unavailable` records. Returns null
// when there is nothing billable to aggregate.
export function sumLlmUsage(usages: Array<LlmUsage | undefined | null>): LlmUsage | null {
  const valid = usages.filter((u): u is LlmUsage => u != null && !u.unavailable);
  if (!valid.length) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let calls = 0;
  let costUsd = 0;
  let estimated = false;
  let estimatedContextTokens = 0;
  const contextModes = new Set<NonNullable<LlmUsage["contextMode"]>>();
  const contextLifecycleTiers = new Set<NonNullable<LlmUsage["contextLifecycleTier"]>>();
  const contextSections = new Map<string, { label: string; tokens: number; detail?: string }>();
  let escalatedFromCompact = false;
  for (const u of valid) {
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    thinkingTokens += u.thinkingTokens ?? 0;
    cacheReadTokens += u.cacheReadTokens ?? 0;
    cacheCreationTokens += u.cacheCreationTokens ?? 0;
    calls += u.calls;
    costUsd += u.costUsd ?? 0;
    if (u.estimated) estimated = true;
    estimatedContextTokens += u.estimatedContextTokens ?? 0;
    if (u.contextMode) contextModes.add(u.contextMode);
    if (u.contextLifecycleTier) contextLifecycleTiers.add(u.contextLifecycleTier);
    if (u.escalatedFromCompact) escalatedFromCompact = true;
    for (const section of u.contextSections ?? []) {
      const existing = contextSections.get(section.label);
      contextSections.set(section.label, {
        label: section.label,
        tokens: (existing?.tokens ?? 0) + section.tokens,
        detail: existing?.detail ?? section.detail
      });
    }
  }
  const first = valid[0];
  return {
    providerId: first.providerId,
    modelId: first.modelId,
    inputTokens,
    outputTokens,
    thinkingTokens: thinkingTokens || undefined,
    cacheReadTokens: cacheReadTokens || undefined,
    cacheCreationTokens: cacheCreationTokens || undefined,
    reasoningReplayState: mergeReasoningReplayStates(valid.map((usage) => usage.reasoningReplayState)),
    calls,
    estimated: estimated || undefined,
    costUsd: roundCost(costUsd),
    contextMode: contextModes.size === 1 ? Array.from(contextModes)[0] : undefined,
    contextLifecycleTier: contextLifecycleTiers.size === 1 ? Array.from(contextLifecycleTiers)[0] : undefined,
    escalatedFromCompact: escalatedFromCompact || undefined,
    estimatedContextTokens: estimatedContextTokens || undefined,
    contextSections: contextSections.size ? Array.from(contextSections.values()) : undefined
  };
}

export function llmUsageTotalTokens(usage: LlmUsage): number {
  return usage.inputTokens
    + usage.outputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheCreationTokens ?? 0);
}

// True when there is at least one usage record and every present record is
// unavailable (e.g. all turns used a local CLI provider) — used to render "n/a".
export function isAllUsageUnavailable(usages: Array<LlmUsage | undefined | null>): boolean {
  const present = usages.filter((u): u is LlmUsage => u != null);
  return present.length > 0 && present.every((u) => u.unavailable === true);
}

export function formatCostUsd(value: number | undefined, options: { compact?: boolean; estimated?: boolean } = {}): string {
  if (value === undefined) return "—";
  const prefix = options.estimated ? "~" : "";
  if (options.compact) {
    if (value === 0) return `${prefix}$0.00`;
    if (value < 0.01) return `${prefix}$${value.toFixed(4)}`;
    if (value < 1) return `${prefix}$${value.toFixed(2)}`;
    return `${prefix}$${value.toFixed(2)}`;
  }
  return `${prefix}$${value.toFixed(4)}`;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}
