import { describe, expect, it } from "vitest";
import { createSeedProject } from "../src/shared/fixtures";
import {
  changeProviderCompatibility,
  createProviderProfile,
  duplicateProviderProfile,
  isSeedProvider,
  localProviderUsageUnavailableDetail,
  mergeProviderCapabilityMetadata,
  providerKindOptions,
  providersNeedingAutoCheckOnSave
} from "../src/renderer/src/utils/providerProfiles";

describe("provider profile helpers", () => {
  const expectedCodexDefaultSandbox = process.platform === "win32" ? "danger-full-access" : "workspace-write";

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
        "qwen/qwen3.7-plus": { supportsImageInput: true }
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
    expect(merged.detectedContextWindowTokens).toBe(1_000_000);
    expect(merged.detectedOpenAiEndpointMode).toBe("responses");
  });
});
