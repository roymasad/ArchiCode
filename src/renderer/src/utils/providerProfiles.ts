import { t } from "@renderer/i18n";
import {
  defaultPhaseModelPolicies,
  defaultSubagentModelPolicies,
  type PhaseModelPolicy,
  type ProjectSettings
} from "../../../shared/schema";

export type ProviderSettings = ProjectSettings["providers"][number];
export type ProviderKind = ProviderSettings["kind"];

export const providerKindOptions: Array<{ value: ProviderKind; label: string }> = [
  { value: "anthropic-compatible", label: t("Anthropic Compatible API") },
  { value: "openai-compatible", label: t("OpenAI Compatible API") },
  { value: "claude-local", label: t("Claude Code CLI") },
  { value: "codex-local", label: t("Codex Local CLI") },
  { value: "antigravity-local", label: t("Google Antigravity CLI") },
  { value: "grok-local", label: t("Grok Build CLI") },
  { value: "kimi-local", label: t("Kimi Code CLI") },
  { value: "opencode-local", label: t("OpenCode Local CLI") }
];

export const codexLocalCommandAccessHint =
  "Windows needs full access for Codex package installs and registry/cache writes. macOS usually works with workspace write.";

export const codexLocalSandboxOptions: Array<{ value: NonNullable<ProviderSettings["localSandbox"]>; label: string }> = [
  { value: "read-only", label: t("read only") },
  { value: "workspace-write", label: t("workspace write") },
  { value: "danger-full-access", label: t("full access") }
];

export const outputVerbosityOptions: Array<{
  value: "default" | NonNullable<ProviderSettings["outputVerbosity"]>;
  label: string;
}> = [
  { value: "default", label: t("Model default") },
  { value: "low", label: t("Low") },
  { value: "medium", label: t("Medium") },
  { value: "high", label: t("High") }
];

export function codexLocalSandboxLabel(value?: ProviderSettings["localSandbox"]): string {
  return codexLocalSandboxOptions.find((option) => option.value === value)?.label ?? "read only";
}

export function localProviderUsageUnavailableDetail(provider?: ProviderSettings): string {
  const cliName = provider?.kind === "codex-local"
    ? "Codex CLI provider"
    : provider?.kind === "claude-local"
      ? "Claude Code CLI provider"
      : provider?.kind === "opencode-local"
        ? "OpenCode CLI provider"
      : provider?.kind === "antigravity-local"
        ? "Antigravity CLI provider"
        : provider?.kind === "grok-local"
          ? "Grok Build CLI provider"
        : provider?.kind === "kimi-local"
          ? "Kimi Code CLI provider"
      : "Local CLI provider";
  const profile = provider?.label?.trim();
  return `${cliName}${profile ? ` (${profile})` : ""} — token usage is not reported.`;
}

export function looksLikeEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function providerApiKeyValue(provider: ProviderSettings): string {
  if (provider.apiKey) return provider.apiKey;
  const legacyValue = provider.apiKeyEnv?.trim();
  return legacyValue && !looksLikeEnvironmentVariableName(legacyValue) ? legacyValue : "";
}

export function shouldAutoCheckProviderOnSave(
  provider: ProviderSettings,
  savedApiKeyIds: Set<string>
): boolean {
  return (provider.kind === "openai-compatible" || provider.kind === "anthropic-compatible") &&
    (providerApiKeyValue(provider).trim().length >= 20 || savedApiKeyIds.has(provider.id));
}

export function providersNeedingAutoCheckOnSave(
  providers: ProviderSettings[],
  previousProviders: ProviderSettings[],
  savedApiKeyIds: Set<string>
): ProviderSettings[] {
  const previousById = new Map(previousProviders.map((provider) => [provider.id, provider]));
  return providers.filter((provider) => {
    if (!shouldAutoCheckProviderOnSave(provider, savedApiKeyIds)) return false;
    const previous = previousById.get(provider.id);
    return !previous || providerAutoCheckFingerprint(previous) !== providerAutoCheckFingerprint(provider);
  });
}

export function mergeProviderCapabilityMetadata(
  providers: ProviderSettings[],
  checkedProvider: ProviderSettings
): ProviderSettings[] {
  return providers.map((provider) => provider.id === checkedProvider.id
    ? normalizeProviderModelSelections({
        ...provider,
        detectedAvailableModels: checkedProvider.detectedAvailableModels,
        detectedModelCapabilities: checkedProvider.detectedModelCapabilities,
        detectedContextWindowTokens: checkedProvider.detectedContextWindowTokens,
        detectedOpenAiEndpointMode: checkedProvider.detectedOpenAiEndpointMode
      })
    : provider);
}

const phasePolicyKeys = Object.keys(defaultPhaseModelPolicies) as Array<keyof typeof defaultPhaseModelPolicies>;
const subagentPolicyKeys = Object.keys(defaultSubagentModelPolicies) as Array<keyof typeof defaultSubagentModelPolicies>;

function clearPolicyModelOverrides<T extends Record<string, PhaseModelPolicy>>(policies: T): T {
  return Object.fromEntries(Object.entries(policies).map(([key, policy]) => [
    key,
    { ...policy, modelOverride: undefined }
  ])) as T;
}

/**
 * Treat a checked provider catalog as authoritative. Stale provider and
 * profile selections fall back to the provider default instead of continuing
 * to send a model ID the provider no longer exposes.
 */
export function normalizeProviderModelSelections(provider: ProviderSettings): ProviderSettings {
  if (!provider.detectedAvailableModels.length) return provider;
  const availableModels = new Set(provider.detectedAvailableModels);
  let changed = false;
  const normalizePolicy = (policy: PhaseModelPolicy): PhaseModelPolicy => {
    const override = policy.modelOverride?.trim();
    if (!override || availableModels.has(override)) return policy;
    changed = true;
    return { ...policy, modelOverride: undefined };
  };
  const phaseModelPolicies = { ...(provider.phaseModelPolicies ?? defaultPhaseModelPolicies) };
  for (const phase of phasePolicyKeys) {
    phaseModelPolicies[phase] = normalizePolicy(phaseModelPolicies[phase]);
  }
  const subagentModelPolicies = { ...(provider.subagentModelPolicies ?? defaultSubagentModelPolicies) };
  for (const profile of subagentPolicyKeys) {
    subagentModelPolicies[profile] = normalizePolicy(subagentModelPolicies[profile]);
  }
  const currentModel = provider.model?.trim();
  const model = currentModel && availableModels.has(currentModel)
    ? provider.model
    : provider.detectedAvailableModels[0];
  if (model !== provider.model) changed = true;
  return changed ? { ...provider, model, phaseModelPolicies, subagentModelPolicies } : provider;
}

export function defaultProviderLabel(kind: ProviderKind): string {
  if (kind === "openai-compatible") return "New provider";
  if (kind === "anthropic-compatible") return "Anthropic-Compatible Profile";
  if (kind === "codex-local") return "Codex Local CLI";
  if (kind === "claude-local") return "Claude Code CLI";
  if (kind === "opencode-local") return "OpenCode Local CLI";
  if (kind === "antigravity-local") return "Google Antigravity CLI";
  if (kind === "grok-local") return "Grok Build CLI";
  if (kind === "kimi-local") return "Kimi Code CLI";
  return "Manual / Offline";
}

export function uniqueProviderId(providers: ProviderSettings[], label: string): string {
  const existing = new Set(providers.map((provider) => provider.id));
  const base = slugProviderLabel(label) || "custom-provider";
  let candidate = base;
  let index = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

export function createProviderProfile(
  providers: ProviderSettings[],
  kind: ProviderKind = "openai-compatible",
  label = defaultProviderLabel(kind)
): ProviderSettings {
  const id = uniqueProviderId(providers, label);
  return {
    id,
    label,
    ...providerDefaultsForKind(kind),
    phaseModelPolicies: defaultPhaseModelPolicies,
    subagentModelPolicies: defaultSubagentModelPolicies,
    enabled: providers.length === 0
  };
}

export function duplicateProviderProfile(providers: ProviderSettings[], source: ProviderSettings): ProviderSettings {
  const label = uniqueProviderLabel(providers, `${source.label} Copy`);
  return {
    ...source,
    id: uniqueProviderId(providers, label),
    label,
    apiKey: undefined,
    apiKeyEnv: undefined,
    detectedAvailableModels: [],
    detectedModelCapabilities: {},
    detectedContextWindowTokens: undefined,
    detectedOpenAiEndpointMode: undefined,
    enabled: false
  };
}

export function removeProviderProfile(providers: ProviderSettings[], providerId: string): ProviderSettings[] {
  const nextProviders = providers.filter((provider) => provider.id !== providerId);
  if (!nextProviders.length || nextProviders.some((provider) => provider.enabled)) return nextProviders;
  return nextProviders.map((provider, index) => ({ ...provider, enabled: index === 0 }));
}

export function changeProviderCompatibility(provider: ProviderSettings, kind: ProviderKind): ProviderSettings {
  if (provider.kind === kind) return provider;
  return {
    ...provider,
    ...providerDefaultsForKind(kind),
    label: provider.label,
    id: provider.id,
    enabled: provider.enabled,
    phaseModelPolicies: clearPolicyModelOverrides(provider.phaseModelPolicies ?? defaultPhaseModelPolicies),
    subagentModelPolicies: clearPolicyModelOverrides(provider.subagentModelPolicies ?? defaultSubagentModelPolicies)
  };
}

export function defaultCodexLocalSandbox(): ProviderSettings["localSandbox"] {
  if (typeof navigator !== "undefined" && /\bWin/i.test(`${navigator.platform} ${navigator.userAgent}`)) {
    return "danger-full-access";
  }
  return "workspace-write";
}

function providerDefaultsForKind(kind: ProviderKind): Omit<ProviderSettings, "id" | "label" | "phaseModelPolicies" | "subagentModelPolicies" | "enabled"> {
  const common = {
    kind,
    detectedAvailableModels: [],
    detectedModelCapabilities: {},
    detectedContextWindowTokens: undefined,
    contextWindowTokens: undefined,
    detectedOpenAiEndpointMode: undefined,
    apiKey: undefined,
    apiKeyEnv: undefined,
    outputVerbosity: undefined,
    localProfile: undefined,
    localSandbox: "read-only" as const,
    ephemeral: true
  };
  if (kind === "openai-compatible") {
    return {
      ...common,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.5",
      openAiEndpointMode: "auto",
      localCommand: undefined
    };
  }
  if (kind === "anthropic-compatible") {
    return {
      ...common,
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      openAiEndpointMode: undefined,
      localCommand: undefined
    };
  }
  if (kind === "codex-local") {
    return {
      ...common,
      baseUrl: undefined,
      model: "",
      openAiEndpointMode: undefined,
      localCommand: "codex",
      localSandbox: defaultCodexLocalSandbox()
    };
  }
  if (kind === "claude-local") {
    return {
      ...common,
      baseUrl: undefined,
      model: "",
      openAiEndpointMode: undefined,
      localCommand: "claude",
      localSandbox: defaultCodexLocalSandbox()
    };
  }
  if (kind === "opencode-local") {
    return {
      ...common,
      baseUrl: undefined,
      model: "",
      openAiEndpointMode: undefined,
      localCommand: "opencode",
      localSandbox: defaultCodexLocalSandbox()
    };
  }
  if (kind === "antigravity-local") {
    return {
      ...common,
      baseUrl: undefined,
      model: "",
      openAiEndpointMode: undefined,
      localCommand: "agy",
      localSandbox: defaultCodexLocalSandbox()
    };
  }
  if (kind === "grok-local") {
    return {
      ...common,
      baseUrl: undefined,
      model: "",
      openAiEndpointMode: undefined,
      localCommand: "grok",
      localSandbox: defaultCodexLocalSandbox(),
      ephemeral: true
    };
  }
  if (kind === "kimi-local") {
    return {
      ...common,
      baseUrl: undefined,
      model: "",
      openAiEndpointMode: undefined,
      localCommand: "kimi",
      localSandbox: defaultCodexLocalSandbox(),
      ephemeral: true
    };
  }
  return {
    ...common,
    baseUrl: undefined,
    model: undefined,
    openAiEndpointMode: undefined,
    localCommand: undefined,
    localSandbox: "read-only" as const
  };
}

function uniqueProviderLabel(providers: ProviderSettings[], label: string): string {
  const existing = new Set(providers.map((provider) => provider.label.trim().toLowerCase()));
  if (!existing.has(label.trim().toLowerCase())) return label;
  let index = 2;
  let candidate = `${label} ${index}`;
  while (existing.has(candidate.trim().toLowerCase())) {
    index += 1;
    candidate = `${label} ${index}`;
  }
  return candidate;
}

function slugProviderLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function providerAutoCheckFingerprint(provider: ProviderSettings): string {
  if (provider.kind === "openai-compatible") {
    return JSON.stringify({
      kind: provider.kind,
      baseUrl: provider.baseUrl ?? "",
      model: provider.model ?? "",
      apiKey: provider.apiKey ?? "",
      apiKeyEnv: provider.apiKeyEnv ?? "",
      openAiEndpointMode: provider.openAiEndpointMode ?? "auto"
    });
  }
  if (provider.kind === "anthropic-compatible") {
    return JSON.stringify({
      kind: provider.kind,
      baseUrl: provider.baseUrl ?? "",
      model: provider.model ?? "",
      apiKey: provider.apiKey ?? "",
      apiKeyEnv: provider.apiKeyEnv ?? ""
    });
  }
  if (provider.kind === "codex-local") {
    return JSON.stringify({
      kind: provider.kind,
      model: provider.model ?? "",
      localCommand: provider.localCommand ?? "",
      localProfile: provider.localProfile ?? "",
      localSandbox: provider.localSandbox ?? "read-only",
      ephemeral: Boolean(provider.ephemeral)
    });
  }
  if (provider.kind === "claude-local" || provider.kind === "opencode-local" || provider.kind === "antigravity-local" || provider.kind === "grok-local" || provider.kind === "kimi-local") {
    return JSON.stringify({
      kind: provider.kind,
      model: provider.model ?? "",
      localCommand: provider.localCommand ?? "",
      localProfile: provider.localProfile ?? "",
      localSandbox: provider.localSandbox ?? "read-only",
      ephemeral: Boolean(provider.ephemeral)
    });
  }
  return JSON.stringify({ kind: provider.kind });
}
