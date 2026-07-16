import { describe, expect, it } from "vitest";
import { deriveContextBudgetPlan } from "../src/shared/contextBudget";
import { createSeedProject } from "../src/shared/fixtures";

describe("context budget planning", () => {
  it("derives automatic limits from the active model", () => {
    const settings = {
      ...createSeedProject("/tmp/archicode").project.settings,
      providers: createSeedProject("/tmp/archicode").project.settings.providers.map((provider) => ({
        ...provider,
        enabled: provider.id === "anthropic-compatible",
        model: provider.id === "anthropic-compatible" ? "claude-sonnet-4-6" : provider.model
      }))
    };

    const plan = deriveContextBudgetPlan(settings);

    expect(plan.mode).toBe("auto");
    expect(plan.modelContextTokens).toBe(1000000);
    expect(plan.compactionThreshold).toBe(700000);
    expect(plan.summaryReserveTokens).toBe(100000);
    expect(plan.responseReserveTokens).toBe(150000);
  });

  it("uses the custom provider as the default active model", () => {
    const settings = createSeedProject("/tmp/archicode").project.settings;
    const plan = deriveContextBudgetPlan(settings);

    expect(settings.providers.find((provider) => provider.id === "offline-manual")).toBeUndefined();
    expect(settings.providers.find((provider) => provider.id === "openai-compatible")?.enabled).toBe(true);
    expect(plan.providerLabel).toBe("Custom OpenAI-Compatible");
    expect(plan.modelLabel).toBe("gpt-5.5");
  });

  it("respects manual overrides only when manual mode is enabled", () => {
    const settings = {
      ...createSeedProject("/tmp/archicode").project.settings,
      contextBudgetMode: "manual" as const,
      contextTokenBudget: 4096,
      compactionThreshold: 2048,
      contextBuilder: {
        ...createSeedProject("/tmp/archicode").project.settings.contextBuilder,
        recentRunLimit: 2,
        artifactLimit: 3
      }
    };

    const plan = deriveContextBudgetPlan(settings);

    expect(plan.mode).toBe("manual");
    expect(plan.modelContextTokens).toBe(4096);
    expect(plan.compactionThreshold).toBe(2048);
    expect(plan.recentRunLimit).toBe(2);
    expect(plan.artifactLimit).toBe(3);
  });

  it("prefers provider context window overrides over detected and known-model values", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings;
    const settings = {
      ...seed,
      providers: seed.providers.map((provider) => provider.id === "openai-compatible"
        ? {
            ...provider,
            enabled: true,
            model: "gpt-5.5",
            contextWindowTokens: 96000,
            detectedContextWindowTokens: 128000
          }
        : { ...provider, enabled: false })
    };

    const plan = deriveContextBudgetPlan(settings);

    expect(plan.source).toBe("provider-override");
    expect(plan.modelContextTokens).toBe(96000);
  });

  it("uses provider-detected context windows before model-name inference", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings;
    const settings = {
      ...seed,
      providers: seed.providers.map((provider) => provider.id === "openai-compatible"
        ? {
            ...provider,
            enabled: true,
            model: "unknown-custom-model",
            detectedContextWindowTokens: 131072
          }
        : { ...provider, enabled: false })
    };

    const plan = deriveContextBudgetPlan(settings);

    expect(plan.source).toBe("provider-detected");
    expect(plan.modelContextTokens).toBe(131072);
  });

  it("overrides stale detected context windows for GPT-5.6 family models", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings;
    const settings = {
      ...seed,
      providers: seed.providers.map((provider) => provider.id === "codex-local"
        ? {
            ...provider,
            enabled: true,
            model: "gpt-5.6-terra",
            detectedContextWindowTokens: 272000
          }
        : { ...provider, enabled: false })
    };

    const plan = deriveContextBudgetPlan(settings);

    expect(plan.source).toBe("known-model");
    expect(plan.modelContextTokens).toBe(1050000);
  });

  it("uses the current Codex Local default model budget when model is blank", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings;
    const settings = {
      ...seed,
      providers: seed.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, model: "" }
        : { ...provider, enabled: false })
    };

    const plan = deriveContextBudgetPlan(settings);

    expect(plan.modelLabel).toBe("Codex default (gpt-5.5)");
    expect(plan.modelContextTokens).toBe(272000);
  });

  it("keeps Codex Spark on its smaller context window", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings;
    const settings = {
      ...seed,
      providers: seed.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, model: "gpt-5.3-codex-spark" }
        : { ...provider, enabled: false })
    };

    const plan = deriveContextBudgetPlan(settings);

    expect(plan.modelContextTokens).toBe(128000);
  });

  it("uses the GPT-5.6 family context window for Codex Local models", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings;
    const settings = {
      ...seed,
      providers: seed.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, model: "gpt-5.6-terra" }
        : { ...provider, enabled: false })
    };

    const plan = deriveContextBudgetPlan(settings);

    expect(plan.source).toBe("known-model");
    expect(plan.modelContextTokens).toBe(1050000);
  });

  it("uses the GPT-5.6 family context window for OpenAI-compatible models", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings;
    const settings = {
      ...seed,
      providers: seed.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, model: "gpt-5.6-luna" }
        : { ...provider, enabled: false })
    };

    const plan = deriveContextBudgetPlan(settings);

    expect(plan.source).toBe("known-model");
    expect(plan.modelContextTokens).toBe(1050000);
  });
});
