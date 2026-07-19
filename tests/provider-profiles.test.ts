import { describe, expect, it } from "vitest";
import { createSeedProject } from "../src/shared/fixtures";
import {
  changeProviderCompatibility,
  createProviderProfile,
  duplicateProviderProfile,
  isSeedProvider,
  localProviderUsageUnavailableDetail,
  mergeProviderCapabilityMetadata,
  normalizeProviderModelSelections,
  providerKindOptions,
  providersNeedingAutoCheckOnSave
} from "../src/renderer/src/utils/providerProfiles";

describe("provider profile helpers", () => {
  const expectedCodexDefaultSandbox = process.platform === "win32" ? "danger-full-access" : "workspace-write";

  it("defaults Sherlock to high reasoning effort and all subagents to 32k output", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers[0]!;

    expect(provider.phaseModelPolicies.summarizing.maxOutputTokens).toBe(8000);
    expect(provider.subagentModelPolicies.sherlock.reasoningMode).toBe("high");
    expect(Object.values(provider.subagentModelPolicies).map((policy) => policy.maxOutputTokens)).toEqual([
      32000,
      32000,
      32000,
      32000
    ]);
  });

  it("only offers functional LLM provider adapters", () => {
    expect(providerKindOptions.map((option) => option.value)).toEqual([
      "openai-compatible",
      "codex-local",
      "anthropic-compatible",
      "claude-local"
    ]);
  });

  it("creates custom named profiles on existing compatibility adapters", () => {
    const seedProviders = createSeedProject("/tmp/archicode").project.settings.providers;
    const openRouter = createProviderProfile(seedProviders, "openai-compatible", "OpenRouter GPT-5.5");

    expect(openRouter.id).toBe("openrouter-gpt-5-5");
    expect(openRouter.kind).toBe("openai-compatible");
    expect(openRouter.baseUrl).toBe("https://api.openai.com/v1");
    expect(openRouter.enabled).toBe(false);
    expect(isSeedProvider(openRouter)).toBe(false);
  });

  it("duplicates provider profiles without copying local secrets or health cache", () => {
    const seedProviders = createSeedProject("/tmp/archicode").project.settings.providers;
    const source = {
      ...seedProviders.find((provider) => provider.kind === "openai-compatible")!,
      apiKey: "secret",
      detectedAvailableModels: ["gpt-test"],
      detectedContextWindowTokens: 123456,
      detectedOpenAiEndpointMode: "chat-completions" as const
    };

    const copy = duplicateProviderProfile(seedProviders, source);

    expect(copy.id).toBe("custom-openai-compatible-copy");
    expect(copy.label).toBe("Custom OpenAI-Compatible Copy");
    expect(copy.apiKey).toBeUndefined();
    expect(copy.detectedAvailableModels).toEqual([]);
    expect(copy.detectedContextWindowTokens).toBeUndefined();
    expect(copy.detectedOpenAiEndpointMode).toBeUndefined();
    expect(copy.enabled).toBe(false);
  });

  it("switches compatibility while preserving profile identity", () => {
    const seedProviders = createSeedProject("/tmp/archicode").project.settings.providers;
    const profile = createProviderProfile(seedProviders, "openai-compatible", "LM Studio");
    const changed = changeProviderCompatibility(profile, "codex-local");

    expect(changed.id).toBe(profile.id);
    expect(changed.label).toBe(profile.label);
    expect(changed.kind).toBe("codex-local");
    expect(changed.localCommand).toBe("codex");
    expect(changed.localSandbox).toBe(expectedCodexDefaultSandbox);
    expect(changed.apiKey).toBeUndefined();
    expect(changed.detectedAvailableModels).toEqual([]);
  });

  it("resets model overrides when a provider profile changes compatibility", () => {
    const seedProviders = createSeedProject("/tmp/archicode").project.settings.providers;
    const source = seedProviders.find((provider) => provider.kind === "openai-compatible")!;
    const changed = changeProviderCompatibility({
      ...source,
      phaseModelPolicies: {
        ...source.phaseModelPolicies,
        planning: { ...source.phaseModelPolicies.planning, modelOverride: "gpt-planning" }
      },
      subagentModelPolicies: {
        ...source.subagentModelPolicies,
        picasso: { ...source.subagentModelPolicies.picasso, modelOverride: "gpt-picasso" }
      }
    }, "anthropic-compatible");

    expect(changed.phaseModelPolicies.planning.modelOverride).toBeUndefined();
    expect(changed.subagentModelPolicies.picasso.modelOverride).toBeUndefined();
    expect(changed.phaseModelPolicies.planning.reasoningMode).toBe(source.phaseModelPolicies.planning.reasoningMode);
  });

  it("falls stale checked-catalog profile models back to each provider's default", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers
      .find((item) => item.kind === "openai-compatible")!;
    const normalized = normalizeProviderModelSelections({
      ...provider,
      model: "removed-provider-model",
      detectedAvailableModels: ["gpt-current", "gpt-fast"],
      phaseModelPolicies: {
        ...provider.phaseModelPolicies,
        planning: { ...provider.phaseModelPolicies.planning, modelOverride: "removed-profile-model" },
        coding: { ...provider.phaseModelPolicies.coding, modelOverride: "gpt-fast" }
      },
      subagentModelPolicies: {
        ...provider.subagentModelPolicies,
        picasso: { ...provider.subagentModelPolicies.picasso, modelOverride: "removed-picasso-model" },
        sherlock: { ...provider.subagentModelPolicies.sherlock, modelOverride: "gpt-fast" }
      }
    });

    expect(normalized.model).toBe("gpt-current");
    expect(normalized.phaseModelPolicies.planning.modelOverride).toBeUndefined();
    expect(normalized.phaseModelPolicies.coding.modelOverride).toBe("gpt-fast");
    expect(normalized.subagentModelPolicies.picasso.modelOverride).toBeUndefined();
    expect(normalized.subagentModelPolicies.sherlock.modelOverride).toBe("gpt-fast");
  });

  it("keeps model profile choices isolated per provider card", () => {
    const providers = createSeedProject("/tmp/archicode").project.settings.providers;
    const openai = providers.find((provider) => provider.kind === "openai-compatible")!;
    const anthropic = providers.find((provider) => provider.kind === "anthropic-compatible")!;
    const configured = providers.map((provider) => provider.id === openai.id
      ? {
          ...provider,
          subagentModelPolicies: {
            ...provider.subagentModelPolicies,
            sherlock: { ...provider.subagentModelPolicies.sherlock, modelOverride: "gpt-sherlock" }
          }
        }
      : provider.id === anthropic.id
        ? {
            ...provider,
            subagentModelPolicies: {
              ...provider.subagentModelPolicies,
              sherlock: { ...provider.subagentModelPolicies.sherlock, modelOverride: "claude-sherlock" }
            }
          }
        : provider);

    expect(configured.find((provider) => provider.id === openai.id)?.subagentModelPolicies.sherlock.modelOverride).toBe("gpt-sherlock");
    expect(configured.find((provider) => provider.id === anthropic.id)?.subagentModelPolicies.sherlock.modelOverride).toBe("claude-sherlock");
  });

  it("can switch compatibility to Claude Code Local while preserving identity", () => {
    const seedProviders = createSeedProject("/tmp/archicode").project.settings.providers;
    const profile = createProviderProfile(seedProviders, "openai-compatible", "Claude Local");
    const changed = changeProviderCompatibility(profile, "claude-local");

    expect(changed.id).toBe(profile.id);
    expect(changed.label).toBe(profile.label);
    expect(changed.kind).toBe("claude-local");
    expect(changed.localCommand).toBe("claude");
    expect(changed.localSandbox).toBe(expectedCodexDefaultSandbox);
    expect(changed.apiKey).toBeUndefined();
    expect(changed.detectedAvailableModels).toEqual([]);
  });

  it("seeds Codex Local with a write-capable sandbox", () => {
    const seedProviders = createSeedProject("/tmp/archicode").project.settings.providers;
    const codex = seedProviders.find((provider) => provider.id === "codex-local");

    expect(codex?.localSandbox).toBe("workspace-write");
  });

  it("seeds Claude Code Local with a write-capable sandbox", () => {
    const seedProviders = createSeedProject("/tmp/archicode").project.settings.providers;
    const claude = seedProviders.find((provider) => provider.id === "claude-local");

    expect(claude?.localSandbox).toBe("workspace-write");
  });

  it("names the specific local CLI when usage is unavailable", () => {
    const providers = createSeedProject("/tmp/archicode").project.settings.providers;
    const codex = providers.find((provider) => provider.kind === "codex-local");
    const claude = providers.find((provider) => provider.kind === "claude-local");

    expect(localProviderUsageUnavailableDetail(codex)).toBe("Codex CLI provider (Codex Local CLI) — token usage is not reported.");
    expect(localProviderUsageUnavailableDetail(claude)).toBe("Claude Code CLI provider (Claude Code CLI) — token usage is not reported.");
  });

  it("only auto-checks providers whose connectivity settings changed", () => {
    const providers = createSeedProject("/tmp/archicode").project.settings.providers;
    const savedApiKeyIds = new Set(["openai-compatible"]);
    const previous = providers.map((provider) => ({ ...provider, apiKey: undefined }));
    const current = previous.map((provider) => provider.id === "openai-compatible"
      ? { ...provider, label: "Renamed provider" }
      : provider);

    expect(providersNeedingAutoCheckOnSave(current, previous, savedApiKeyIds)).toEqual([]);

    const withNewBaseUrl = previous.map((provider) => provider.id === "openai-compatible"
      ? { ...provider, baseUrl: "https://openrouter.ai/api/v1" }
      : provider);

    expect(providersNeedingAutoCheckOnSave(withNewBaseUrl, previous, savedApiKeyIds).map((provider) => provider.id))
      .toEqual(["openai-compatible"]);
  });

  it("auto-checks new compatible providers when a usable key is present", () => {
    const providers = createSeedProject("/tmp/archicode").project.settings.providers;
    const customProvider = createProviderProfile(providers, "openai-compatible", "Custom Host");
    const current = [...providers, {
      ...customProvider,
      apiKey: "sk-test-key-12345678901234567890",
      baseUrl: "https://example.com/v1"
    }];

    expect(providersNeedingAutoCheckOnSave(current, providers, new Set()).map((provider) => provider.id))
      .toEqual([customProvider.id]);
  });

  it("merges checked model capabilities into an open provider draft without replacing unsaved fields", () => {
    const providers = createSeedProject("/tmp/archicode").project.settings.providers;
    const original = providers.find((provider) => provider.id === "openai-compatible")!;
    const draft = {
      ...original,
      label: "Unsaved OpenRouter name",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "unsaved-key",
      model: "qwen/qwen3.7-plus"
    };
    const checked = {
      ...original,
      detectedAvailableModels: ["qwen/qwen3.7-plus", "openai/gpt-5.4"],
      detectedModelCapabilities: {
        "qwen/qwen3.7-plus": { supportsImageInput: true, contextWindowTokens: 1_000_000, maxOutputTokens: 64_000 }
      },
      detectedContextWindowTokens: 1_000_000,
      detectedOpenAiEndpointMode: "responses" as const
    };

    const merged = mergeProviderCapabilityMetadata(
      providers.map((provider) => provider.id === draft.id ? draft : provider),
      checked
    ).find((provider) => provider.id === draft.id)!;

    expect(merged.label).toBe("Unsaved OpenRouter name");
    expect(merged.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(merged.apiKey).toBe("unsaved-key");
    expect(merged.model).toBe("qwen/qwen3.7-plus");
    expect(merged.detectedAvailableModels).toEqual(["qwen/qwen3.7-plus", "openai/gpt-5.4"]);
    expect(merged.detectedModelCapabilities["qwen/qwen3.7-plus"]?.supportsImageInput).toBe(true);
    expect(merged.detectedModelCapabilities["qwen/qwen3.7-plus"]?.maxOutputTokens).toBe(64_000);
    expect(merged.detectedContextWindowTokens).toBe(1_000_000);
    expect(merged.detectedOpenAiEndpointMode).toBe("responses");
  });
});
