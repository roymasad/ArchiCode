import { describe, expect, it } from "vitest";
import { createSeedProject } from "../src/shared/fixtures";
import {
  computeLlmCost,
  computeUsageCost,
  computeUsageCostDetails,
  formatCostUsd,
  formatTokenCount,
  isAllUsageUnavailable,
  llmUsageTotalTokens,
  resolveModelPricing,
  sumLlmUsage
} from "../src/shared/llmPricing";
import type { LlmUsage, ModelPricing } from "../src/shared/schema";
import { extractAnthropicUsage } from "../src/main/providers/anthropic";
import { extractOpenAIChatUsage, extractOpenAIResponsesUsage } from "../src/main/providers/openai";

function anthropicProvider() {
  return createSeedProject("/tmp/archicode").project.settings.providers.find((p) => p.id === "anthropic-compatible")!;
}
function openaiProvider() {
  return createSeedProject("/tmp/archicode").project.settings.providers.find((p) => p.id === "openai-compatible")!;
}

describe("llm usage extraction", () => {
  it("splits Anthropic input/cache fields and keeps output incl. thinking", () => {
    const raw = extractAnthropicUsage({
      input_tokens: 1200,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 4000,
      output_tokens: 1500,
      output_tokens_details: { thinking_tokens: 900 }
    });
    expect(raw).toEqual({
      inputTokens: 1200,
      outputTokens: 1500,
      thinkingTokens: 900,
      cacheReadTokens: 8000,
      cacheCreationTokens: 4000
    });
  });

  it("carves OpenAI chat cached_tokens out of prompt_tokens", () => {
    const raw = extractOpenAIChatUsage({
      prompt_tokens: 10000,
      completion_tokens: 2000,
      prompt_tokens_details: { cached_tokens: 7000 },
      completion_tokens_details: { reasoning_tokens: 1200 }
    });
    // non-cached input = 10000 - 7000
    expect(raw.inputTokens).toBe(3000);
    expect(raw.cacheReadTokens).toBe(7000);
    expect(raw.outputTokens).toBe(2000);
    expect(raw.thinkingTokens).toBe(1200);
    expect(raw.cacheCreationTokens).toBe(0);
  });

  it("carves OpenAI Responses cached_tokens out of input_tokens", () => {
    const raw = extractOpenAIResponsesUsage({
      input_tokens: 5000,
      output_tokens: 800,
      input_tokens_details: { cached_tokens: 4500 },
      output_tokens_details: { reasoning_tokens: 300 }
    });
    expect(raw.inputTokens).toBe(500);
    expect(raw.cacheReadTokens).toBe(4500);
    expect(raw.outputTokens).toBe(800);
    expect(raw.thinkingTokens).toBe(300);
  });

  it("returns an empty object when usage is absent", () => {
    expect(extractAnthropicUsage(undefined)).toEqual({});
    expect(extractOpenAIChatUsage(undefined)).toEqual({});
    expect(extractOpenAIResponsesUsage(undefined)).toEqual({});
  });
});

describe("computeLlmCost cached-token split", () => {
  const pricing: ModelPricing = {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75
  };

  it("bills Anthropic non-cached input, cache-read, cache-write, and output separately", () => {
    const usage = extractAnthropicUsage({
      input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      output_tokens_details: { thinking_tokens: 500_000 }
    });
    // input: 1M * $3 = $3
    // cache-read: 1M * $0.30 = $0.30
    // cache-write: 1M * $3.75 = $3.75
    // output (incl thinking): 1M * $15 = $15  -> thinking NOT double-billed
    expect(computeLlmCost(usage, pricing)).toBe(3 + 0.3 + 3.75 + 15);
  });

  it("bills OpenAI non-cached input at full rate and cached at cache-read rate (no cache-write)", () => {
    const usage = extractOpenAIChatUsage({
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 700_000 },
      completion_tokens_details: { reasoning_tokens: 400_000 }
    });
    // non-cached input: 300k * $3 = $0.9
    // cache-read: 700k * $0.30 = $0.21
    // output (incl reasoning): 1M * $15 = $15
    expect(computeLlmCost(usage, pricing)).toBe(0.9 + 0.21 + 15);
  });

  it("does not double-bill thinking tokens", () => {
    const withoutThinking = { inputTokens: 0, outputTokens: 1_000_000 };
    const withThinking = { inputTokens: 0, outputTokens: 1_000_000, thinkingTokens: 600_000 };
    expect(computeLlmCost(withoutThinking, pricing)).toBe(computeLlmCost(withThinking, pricing));
  });

  it("computeUsageCost resolves pricing from the provider's model", () => {
    const usage: LlmUsage = {
      providerId: "anthropic-compatible",
      modelId: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 0,
      calls: 1
    };
    // Claude Sonnet defaults: input $3/MTok -> $3 for 1M input tokens.
    expect(computeUsageCost(usage, anthropicProvider())).toBe(3);
  });
});

describe("resolveModelPricing", () => {
  it("matches known Claude Sonnet models", () => {
    const { pricing, matched } = resolveModelPricing("claude-sonnet-4-6", "anthropic-compatible");
    expect(matched).toBe(true);
    expect(pricing.inputPerMTok).toBe(3);
    expect(pricing.outputPerMTok).toBe(15);
    expect(pricing.cacheReadPerMTok).toBe(0.3);
    expect(pricing.cacheWritePerMTok).toBe(3.75);
  });

  it("matches Claude Sonnet 5 introductory pricing", () => {
    const { pricing, matched } = resolveModelPricing("claude-sonnet-5", "anthropic-compatible");
    expect(matched).toBe(true);
    expect(pricing.inputPerMTok).toBe(2);
    expect(pricing.outputPerMTok).toBe(10);
    expect(pricing.cacheReadPerMTok).toBe(0.2);
    expect(pricing.cacheWritePerMTok).toBe(2.5);
  });

  it("matches known GPT-5.5 models", () => {
    const { pricing, matched } = resolveModelPricing("gpt-5.5", "openai-compatible");
    expect(matched).toBe(true);
    expect(pricing.inputPerMTok).toBe(5);
    expect(pricing.outputPerMTok).toBe(30);
  });

  it("matches each GPT-5.6 model at its official standard short-context rate", () => {
    const sol = resolveModelPricing("gpt-5.6-sol", "openai-compatible");
    expect(sol.matched).toBe(true);
    expect(sol.pricing).toMatchObject({
      inputPerMTok: 5,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
      outputPerMTok: 30
    });

    const terra = resolveModelPricing("gpt-5.6-terra", "openai-compatible");
    expect(terra.matched).toBe(true);
    expect(terra.pricing).toMatchObject({
      inputPerMTok: 2.5,
      cacheReadPerMTok: 0.25,
      cacheWritePerMTok: 3.125,
      outputPerMTok: 15
    });

    const luna = resolveModelPricing("gpt-5.6-luna", "openai-compatible");
    expect(luna.matched).toBe(true);
    expect(luna.pricing).toMatchObject({
      inputPerMTok: 1,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
      outputPerMTok: 6
    });
  });

  it("matches GPT-5.4-mini before the gpt-5.4 family fallback", () => {
    const mini = resolveModelPricing("gpt-5.4-mini", "openai-compatible");
    expect(mini.matched).toBe(true);
    expect(mini.pricing.inputPerMTok).toBe(0.75);
    expect(mini.pricing.outputPerMTok).toBe(4.5);
    // And the non-mini gpt-5.4 resolves to the full price.
    const full = resolveModelPricing("gpt-5.4", "openai-compatible");
    expect(full.pricing.inputPerMTok).toBe(2.5);
    expect(full.pricing.outputPerMTok).toBe(15);
  });

  it("matches Claude Fable 5 at its premium price", () => {
    const { pricing } = resolveModelPricing("claude-fable-5", "anthropic-compatible");
    expect(pricing.inputPerMTok).toBe(10);
    expect(pricing.outputPerMTok).toBe(50);
  });

  it("matches Claude Opus 4.8 (not the deprecated 4.1 price)", () => {
    const { pricing } = resolveModelPricing("claude-opus-4-8", "anthropic-compatible");
    expect(pricing.inputPerMTok).toBe(5);
    expect(pricing.outputPerMTok).toBe(25);
  });

  it("matches Claude Opus 4.1 at the deprecated higher price", () => {
    const { pricing } = resolveModelPricing("claude-opus-4-1", "anthropic-compatible");
    expect(pricing.inputPerMTok).toBe(15);
    expect(pricing.outputPerMTok).toBe(75);
  });

  it("matches GPT-4.1 mini and nano before GPT-5 mini/nano rows", () => {
    const mini = resolveModelPricing("gpt-4.1-mini", "openai-compatible");
    expect(mini.matched).toBe(true);
    expect(mini.pricing.inputPerMTok).toBe(0.4);
    expect(mini.pricing.outputPerMTok).toBe(1.6);
    expect(mini.pricing.cacheReadPerMTok).toBe(0.1);

    const nano = resolveModelPricing("gpt-4.1-nano", "openai-compatible");
    expect(nano.matched).toBe(true);
    expect(nano.pricing.inputPerMTok).toBe(0.1);
    expect(nano.pricing.outputPerMTok).toBe(0.4);
    expect(nano.pricing.cacheReadPerMTok).toBe(0.025);
  });

  it("matches DeepSeek with cache-hit pricing", () => {
    const { pricing } = resolveModelPricing("deepseek-v4-flash", "openai-compatible");
    expect(pricing.inputPerMTok).toBe(0.14);
    expect(pricing.outputPerMTok).toBe(0.28);
    expect(pricing.cacheReadPerMTok).toBe(0.0028);
  });

  it("matches DeepSeek V4 Pro before the generic DeepSeek Flash row", () => {
    const { pricing } = resolveModelPricing("deepseek-v4-pro", "openai-compatible");
    expect(pricing.inputPerMTok).toBe(0.435);
    expect(pricing.outputPerMTok).toBe(0.87);
    expect(pricing.cacheReadPerMTok).toBe(0.003625);
  });

  it("matches xAI Grok 4.5 and 4.3 at distinct prices", () => {
    const v45 = resolveModelPricing("grok-4.5", "openai-compatible");
    expect(v45.matched).toBe(true);
    expect(v45.pricing.inputPerMTok).toBe(2);
    expect(v45.pricing.outputPerMTok).toBe(6);
    const v43 = resolveModelPricing("grok-4.3", "openai-compatible");
    expect(v43.pricing.inputPerMTok).toBe(1.25);
    expect(v43.pricing.outputPerMTok).toBe(2.5);
  });

  it("matches Kimi K2.7 Code before the generic Kimi fallback", () => {
    const code = resolveModelPricing("kimi-k2.7-code", "openai-compatible");
    expect(code.matched).toBe(true);
    expect(code.pricing.inputPerMTok).toBe(0.95);
    expect(code.pricing.outputPerMTok).toBe(4);
    const k26 = resolveModelPricing("kimi-k2.6", "openai-compatible");
    expect(k26.pricing.inputPerMTok).toBe(1.2);
    expect(k26.pricing.outputPerMTok).toBe(4.5);
  });

  it("matches GLM and MiniMax", () => {
    const glm = resolveModelPricing("glm-5.2", "openai-compatible");
    expect(glm.pricing.inputPerMTok).toBe(1.4);
    expect(glm.pricing.outputPerMTok).toBe(4.4);
    const mm = resolveModelPricing("minimax-m3", "openai-compatible");
    expect(mm.pricing.inputPerMTok).toBe(0.3);
    expect(mm.pricing.outputPerMTok).toBe(1.2);
  });

  it("prefers a provider pricing override over the default table", () => {
    const override: ModelPricing = { inputPerMTok: 99, outputPerMTok: 88 };
    const { pricing, matched } = resolveModelPricing("claude-sonnet-4-6", "anthropic-compatible", override);
    expect(matched).toBe(true);
    expect(pricing.inputPerMTok).toBe(99);
    expect(pricing.outputPerMTok).toBe(88);
    // missing cache rates default inside computeLlmCost (10% / 125% of input)
    expect(computeLlmCost({ inputTokens: 1_000_000, outputTokens: 0 }, pricing)).toBe(99);
  });

  it("falls back to a conservative default for unknown models", () => {
    const { pricing, matched } = resolveModelPricing("some-unknown-model-xyz", "openai-compatible");
    expect(matched).toBe(false);
    expect(pricing.inputPerMTok).toBe(1);
    expect(pricing.outputPerMTok).toBe(5);
  });

  it("flags unknown-model cost as estimated", () => {
    const usage: LlmUsage = {
      providerId: "openai-compatible",
      modelId: "some-unknown-model-xyz",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      calls: 1
    };
    const details = computeUsageCostDetails(usage, openaiProvider());
    expect(details.costUsd).toBe(6);
    expect(details.estimated).toBe(true);
  });
});

describe("sumLlmUsage", () => {
  it("sums tokens, calls, and cost across records", () => {
    const a: LlmUsage = { providerId: "p", modelId: "m", inputTokens: 100, outputTokens: 50, calls: 1, costUsd: 0.01 };
    const b: LlmUsage = { providerId: "p", modelId: "m", inputTokens: 200, outputTokens: 25, calls: 2, costUsd: 0.02 };
    const total = sumLlmUsage([a, b])!;
    expect(total.inputTokens).toBe(300);
    expect(total.outputTokens).toBe(75);
    expect(total.calls).toBe(3);
    expect(total.costUsd).toBe(0.03);
  });

  it("skips unavailable records but sums real ones alongside them", () => {
    const real: LlmUsage = { providerId: "p", modelId: "m", inputTokens: 100, outputTokens: 50, calls: 1, costUsd: 0.01 };
    const unavailable: LlmUsage = { providerId: "p", modelId: "m", inputTokens: 0, outputTokens: 0, calls: 1, unavailable: true };
    const total = sumLlmUsage([unavailable, real])!;
    expect(total.inputTokens).toBe(100);
    expect(total.unavailable).toBeUndefined();
  });

  it("returns null when every record is unavailable or absent", () => {
    const unavailable: LlmUsage = { providerId: "p", modelId: "m", inputTokens: 0, outputTokens: 0, calls: 1, unavailable: true };
    expect(sumLlmUsage([unavailable])).toBeNull();
    expect(sumLlmUsage([undefined, null])).toBeNull();
    expect(sumLlmUsage([])).toBeNull();
  });

  it("isAllUsageUnavailable detects all-unavailable sets", () => {
    const unavailable: LlmUsage = { providerId: "p", modelId: "m", inputTokens: 0, outputTokens: 0, calls: 1, unavailable: true };
    const real: LlmUsage = { providerId: "p", modelId: "m", inputTokens: 1, outputTokens: 1, calls: 1 };
    expect(isAllUsageUnavailable([unavailable, unavailable])).toBe(true);
    expect(isAllUsageUnavailable([unavailable, real])).toBe(false);
    expect(isAllUsageUnavailable([])).toBe(false);
    expect(isAllUsageUnavailable([undefined])).toBe(false);
  });

  it("llmUsageTotalTokens sums billable usage without double-counting thinking", () => {
    const usage: LlmUsage = {
      providerId: "p",
      modelId: "m",
      inputTokens: 100,
      outputTokens: 50,
      thinkingTokens: 40,
      cacheReadTokens: 300,
      cacheCreationTokens: 25,
      calls: 1,
      costUsd: 0.01
    };
    expect(llmUsageTotalTokens(usage)).toBe(475);
  });
});

describe("formatters", () => {
  it("formatCostUsd compact vs full", () => {
    expect(formatCostUsd(0.04123, { compact: true })).toBe("$0.04");
    expect(formatCostUsd(0.04123)).toBe("$0.0412");
    expect(formatCostUsd(0.001, { compact: true })).toBe("$0.0010");
    expect(formatCostUsd(1.5, { compact: true })).toBe("$1.50");
    expect(formatCostUsd(undefined)).toBe("—");
    expect(formatCostUsd(0, { compact: true })).toBe("$0.00");
    expect(formatCostUsd(0.04123, { estimated: true })).toBe("~$0.0412");
  });

  it("formatTokenCount abbreviates large numbers", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(150_000)).toBe("150k");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });
});
