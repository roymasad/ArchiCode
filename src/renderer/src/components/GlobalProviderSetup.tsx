import { Activity, Copy, Eye, EyeOff, Loader2, Plus, Settings, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectSettings } from "@shared/schema";
import { providerHasCompletedCapabilityCheck, providerImageInputSupportStatus } from "@shared/providerCapabilities";
import type { ProviderHealthResult } from "../../../preload";
import { Button, DialogContent, DialogRoot, Field, IconButton, Select, Switch, TextInput, Tooltip } from "./ui";
import { ModelCombobox } from "./ModelCombobox";
import {
  changeProviderCompatibility,
  codexLocalCommandAccessHint,
  codexLocalSandboxOptions,
  createProviderProfile,
  duplicateProviderProfile,
  outputVerbosityOptions,
  providerApiKeyValue,
  providersNeedingAutoCheckOnSave,
  providerKindOptions,
  removeProviderProfile,
  type ProviderKind
} from "../utils/providerProfiles";

const fallbackModelPresets: Partial<Record<ProjectSettings["providers"][number]["kind"], string[]>> = {
  "codex-local": [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark"
  ],
  "claude-local": [
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5"
  ],
  "openai-compatible": [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5",
    "gpt-5-mini"
  ],
  "anthropic-compatible": [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001"
  ]
};

function isOfficialOpenAiCompatibleProvider(provider: ProjectSettings["providers"][number]): boolean {
  if (provider.kind !== "openai-compatible") return false;
  const baseUrl = provider.baseUrl?.trim() || "https://api.openai.com/v1";
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function providerCheckHint(kind: ProjectSettings["providers"][number]["kind"]): string {
  if (kind === "codex-local" || kind === "claude-local" || kind === "opencode-local" || kind === "antigravity-local" || kind === "grok-local") {
    return "Checks the CLI connection and refreshes available models. Make sure the latest CLI version is installed.";
  }
  return "Checks the provider connection and refreshes available models when the provider exposes a model catalog.";
}

function modelOptionsForProvider(provider: ProjectSettings["providers"][number]): string[] {
  const fallbackOptions = fallbackModelPresets[provider.kind] ?? [];
  if (provider.detectedAvailableModels.length) {
    return provider.detectedAvailableModels;
  }
  return fallbackOptions;
}

function modelHint(provider: ProjectSettings["providers"][number]): string {
  if (provider.kind === "codex-local") {
    return "Leave blank to use the Codex CLI/app configured default, currently treated as gpt-5.5. Use Check to load local Codex model IDs when available.";
  }
  if (provider.kind === "claude-local") {
    return "Leave blank to use the Claude Code configured default. Use Check to verify the local CLI/auth setup. ArchiCode shows curated fallback model suggestions here because the Claude CLI does not expose a machine-readable local model catalog or context window endpoint.";
  }
  if (provider.kind === "opencode-local") {
    return provider.detectedAvailableModels.length
      ? `Loaded ${provider.detectedAvailableModels.length} configured OpenCode models. Model IDs retain their provider prefix.`
      : "Click Check to load the configured OpenCode provider/model catalog. Authentication is managed with opencode auth login.";
  }
  if (provider.kind === "antigravity-local") {
    return provider.detectedAvailableModels.length
      ? `Loaded ${provider.detectedAvailableModels.length} models from agy.`
      : "Click Check to load the models available to your Antigravity account. Authentication is managed by agy.";
  }
  if (provider.kind === "grok-local") {
    return provider.detectedAvailableModels.length
      ? `Loaded ${provider.detectedAvailableModels.length} models from Grok Build.`
      : "Click Check to load the models available to the signed-in Grok Build account and configured custom providers.";
  }
  if (provider.detectedAvailableModels.length) {
    if (isOfficialOpenAiCompatibleProvider(provider)) {
      return `Loaded ${provider.detectedAvailableModels.length} models from OpenAI's models endpoint.`;
    }
    return `Loaded ${provider.detectedAvailableModels.length} models from this provider's models endpoint.`;
  }
  return "Fallback suggestions only. Click Check to load this provider's available model IDs.";
}

function modelOptionLabel(provider: ProjectSettings["providers"][number], model: string): string {
  const support = providerImageInputSupportStatus(provider, model);
  if (support.source !== "detected") return model;
  if (support.status === "supported") return `${model} · images`;
  if (support.status === "unsupported") return `${model} · text only`;
  return model;
}

function selectedModelImageHint(provider: ProjectSettings["providers"][number]): string {
  const support = providerImageInputSupportStatus(provider);
  if (support.status === "supported") {
    return support.source === "detected"
      ? "Selected model supports image input."
      : "Selected model likely supports image input.";
  }
  if (support.status === "unsupported") {
    return support.source === "detected"
      ? "Selected model does not support image input. ArchiCode will not send images to it."
      : "Image support is not confirmed for this model. ArchiCode will keep image input disabled.";
  }
  if (providerHasCompletedCapabilityCheck(provider)) {
    return "This provider was checked, but the selected model did not advertise image support metadata. ArchiCode will keep image input disabled.";
  }
  return "Image support is unknown until this provider is checked.";
}

function openAiEndpointLabel(mode: NonNullable<ProjectSettings["providers"][number]["detectedOpenAiEndpointMode"]>): string {
  return mode === "responses" ? "Responses API" : "Chat Completions";
}

function openAiEndpointHint(provider: ProjectSettings["providers"][number]): string {
  if (provider.detectedOpenAiEndpointMode) {
    return `Check detected ${openAiEndpointLabel(provider.detectedOpenAiEndpointMode)} for this provider.`;
  }
  return "Auto tries Responses API first, then falls back to Chat Completions when the endpoint is not supported.";
}

function providerDescription(kind: ProjectSettings["providers"][number]["kind"]): string {
  if (kind === "offline-manual") return "Legacy manual mode. Existing projects should choose a real provider before planning or coding.";
  if (kind === "openai-compatible") return "Custom HTTP endpoint using the OpenAI chat/completions shape, including local or hosted compatible providers.";
  if (kind === "anthropic-compatible") return "Anthropic Messages API endpoint.";
  if (kind === "codex-local") return "Runs the local Codex CLI/app bridge when installed and signed in.";
  if (kind === "claude-local") return "Runs the local Claude Code CLI when installed and signed in.";
  if (kind === "opencode-local") return "Runs one-shot OpenCode CLI processes using OpenCode's configured providers and models.";
  if (kind === "antigravity-local") return "Runs one-shot Google Antigravity CLI print calls using the models available to the signed-in agy account.";
  if (kind === "grok-local") return "Runs one-shot Grok Build CLI processes using the signed-in account or models configured in Grok Build.";
  return "";
}

function formatTokenCount(value: number): string {
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function isMacRuntime(): boolean {
  if (typeof navigator === "undefined") return false;
  return /\bMac\b/i.test(navigator.platform) || /\bMac OS\b/i.test(navigator.userAgent);
}

function maskSavedProviderSecrets(
  providers: ProjectSettings["providers"],
  savedApiKeyIds: Set<string>
): ProjectSettings["providers"] {
  return providers.map((provider) => savedApiKeyIds.has(provider.id)
    ? { ...provider, apiKey: undefined }
    : provider);
}

export function GlobalProviderSetup() {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProjectSettings["providers"]>([]);
  const [loadedProviders, setLoadedProviders] = useState<ProjectSettings["providers"]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [providerHealth, setProviderHealth] = useState<Record<string, ProviderHealthResult>>({});
  const [checkingProviderIds, setCheckingProviderIds] = useState<Set<string>>(() => new Set());
  const [saveBusy, setSaveBusy] = useState(false);
  const [savedApiKeyIds, setSavedApiKeyIds] = useState<Set<string>>(() => new Set());
  const [pendingModelCheckIds, setPendingModelCheckIds] = useState<Set<string>>(() => new Set());
  const [visibleApiKeyIds, setVisibleApiKeyIds] = useState<Set<string>>(() => new Set());
  const [pendingProviderRevealId, setPendingProviderRevealId] = useState<string | null>(null);
  const showMacKeychainNote = isMacRuntime();

  const refreshSavedApiKeyStatus = async (): Promise<Set<string>> => {
    if (!window.archicode?.getGlobalProviderSecretStatus) {
      const next = new Set<string>();
      setSavedApiKeyIds(next);
      return next;
    }
    const status = await window.archicode.getGlobalProviderSecretStatus();
    const next = new Set(Object.entries(status).filter(([, saved]) => saved).map(([providerId]) => providerId));
    setSavedApiKeyIds(next);
    return next;
  };

  const loadProviders = async () => {
    const loaded = await window.archicode?.getGlobalProviders();
    if (!loaded) return;
    const nextSavedApiKeyIds = await refreshSavedApiKeyStatus();
    const maskedProviders = maskSavedProviderSecrets(loaded, nextSavedApiKeyIds);
    setLoadedProviders(maskedProviders);
    setProviders(maskedProviders);
  };

  const openDialog = () => {
    setOpen(true);
    setNotice(null);
    setProviderHealth({});
    setCheckingProviderIds(new Set());
    setPendingModelCheckIds(new Set());
    setSaveBusy(false);
    void loadProviders().catch((error) => {
      setNotice(error instanceof Error ? error.message : String(error));
    });
  };

  const updateProvider = (providerId: string, patch: Partial<ProjectSettings["providers"][number]>) => {
    setProviders((current) => current.map((provider) => provider.id === providerId ? { ...provider, ...patch } : provider));
    setProviderHealth((current) => {
      if (!current[providerId]) return current;
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    setPendingModelCheckIds((current) => {
      if (!current.has(providerId)) return current;
      const next = new Set(current);
      next.delete(providerId);
      return next;
    });
  };

  const addProviderProfile = () => {
    let createdProviderId: string | null = null;
    setProviders((current) => {
      const provider = createProviderProfile(current);
      createdProviderId = provider.id;
      return [...current, provider];
    });
    setPendingProviderRevealId(createdProviderId);
  };

  const duplicateProvider = (providerId: string) => {
    let duplicateId: string | null = null;
    setProviders((current) => {
      const source = current.find((provider) => provider.id === providerId);
      if (!source) return current;
      const duplicate = duplicateProviderProfile(current, source);
      duplicateId = duplicate.id;
      return [...current, duplicate];
    });
    setPendingProviderRevealId(duplicateId);
  };

  const removeProvider = (providerId: string) => {
    setProviders((current) => removeProviderProfile(current, providerId));
    setProviderHealth((current) => {
      if (!current[providerId]) return current;
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    setPendingModelCheckIds((current) => {
      if (!current.has(providerId)) return current;
      const next = new Set(current);
      next.delete(providerId);
      return next;
    });
  };

  const changeProviderKind = (providerId: string, kind: ProviderKind) => {
    setProviders((current) => current.map((provider) => provider.id === providerId
      ? changeProviderCompatibility(provider, kind)
      : provider));
    setVisibleApiKeyIds((current) => {
      if (!current.has(providerId)) return current;
      const next = new Set(current);
      next.delete(providerId);
      return next;
    });
    setProviderHealth((current) => {
      if (!current[providerId]) return current;
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    setPendingModelCheckIds((current) => {
      if (!current.has(providerId)) return current;
      const next = new Set(current);
      next.delete(providerId);
      return next;
    });
  };

  useEffect(() => {
    if (!open || !pendingProviderRevealId) return;
    if (!providers.some((provider) => provider.id === pendingProviderRevealId)) return;
    const frame = window.requestAnimationFrame(() => {
      const providerCard = document.querySelector<HTMLElement>(`[data-provider-card="${pendingProviderRevealId}"]`);
      const nameInput = document.querySelector<HTMLInputElement>(`input[data-provider-name-input="${pendingProviderRevealId}"]`);
      providerCard?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      nameInput?.focus();
      nameInput?.select();
      setPendingProviderRevealId((current) => current === pendingProviderRevealId ? null : current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, pendingProviderRevealId, providers]);

  useEffect(() => {
    if (!providers.length) return;
    const nextProviders = providers.map((provider) => {
      if (!provider.detectedAvailableModels.length) return provider;
      const options = modelOptionsForProvider(provider);
      if (provider.model && options.includes(provider.model)) return provider;
      return {
        ...provider,
        model: options[0]
      };
    });
    if (JSON.stringify(nextProviders) !== JSON.stringify(providers)) {
      setProviders(nextProviders);
    }
  }, [providers]);

  const save = async () => {
    if (!window.archicode) return;
    setNotice(null);
    setSaveBusy(true);
    try {
      const providerIdsToCheck = new Set(
        providersNeedingAutoCheckOnSave(providers, loadedProviders, savedApiKeyIds).map((provider) => provider.id)
      );
      const saved = await window.archicode.saveGlobalProviders(providers, { preserveMissingSecrets: true, includeSecrets: false });
      await refreshSavedApiKeyStatus();
      setLoadedProviders(saved);
      setProviders(saved);
      for (const provider of saved.filter((item) => providerIdsToCheck.has(item.id))) {
        await checkProvider(provider.id);
      }
      setOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaveBusy(false);
    }
  };

  const checkProvider = async (providerId: string) => {
    if (!window.archicode) return;
    if (typeof window.archicode.checkGlobalProvider !== "function") {
      setNotice("Provider checks need a full app restart after this update. Close and reopen ArchiCode, then try Check again.");
      return;
    }
    setNotice(null);
    setCheckingProviderIds((current) => new Set(current).add(providerId));
    try {
      const saved = await window.archicode.saveGlobalProviders(providers, { preserveMissingSecrets: true, includeSecrets: false });
      await refreshSavedApiKeyStatus();
      setProviders(saved);
      const health = await window.archicode.checkGlobalProvider(providerId);
      setProviderHealth((current) => ({ ...current, [providerId]: health }));
      await loadProviders();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingProviderIds((current) => {
        if (!current.has(providerId)) return current;
        const next = new Set(current);
        next.delete(providerId);
        return next;
      });
    }
  };

  const renderProviderModelField = (provider: ProjectSettings["providers"][number], placeholder: string) => {
    const options = modelOptionsForProvider(provider);
    const currentModel = provider.model ?? "";
    const discoveredOptions = provider.detectedAvailableModels.length
      ? options
      : [currentModel, ...options];
    const selectOptions = Array.from(new Set(discoveredOptions.filter(Boolean))).map((model) => ({
      value: model,
      label: modelOptionLabel(provider, model)
    }));
    return (
      <Field label="Model" hint={modelHint(provider)}>
        <ModelCombobox
          value={currentModel}
          placeholder={placeholder}
          options={selectOptions}
          catalogMode={provider.detectedAvailableModels.length > 0}
          onValueChange={(value) => updateProvider(provider.id, { model: value || undefined })}
        />
        <small>{selectedModelImageHint(provider)}</small>
      </Field>
    );
  };

  const renderOutputVerbosityField = (provider: ProjectSettings["providers"][number]) => {
    if (provider.kind !== "openai-compatible" && provider.kind !== "codex-local") return null;
    const isCodexLocal = provider.kind === "codex-local";
    return (
      <Field
        label="Output verbosity"
        hint={isCodexLocal
          ? "Overrides Codex model_verbosity for each ArchiCode invocation without changing Codex files."
          : "Sent as text.verbosity for GPT-5.6 Responses API requests. Other models and Chat Completions are unchanged."}
      >
        <Select
          value={provider.outputVerbosity ?? "default"}
          onValueChange={(value) => updateProvider(provider.id, {
            outputVerbosity: value === "default"
              ? undefined
              : value as NonNullable<ProjectSettings["providers"][number]["outputVerbosity"]>
          })}
          options={outputVerbosityOptions}
        />
      </Field>
    );
  };

  const renderContextWindowField = (provider: ProjectSettings["providers"][number]) => (
    <Field
      label="Context window"
      hint={provider.detectedContextWindowTokens
        ? `Auto detected: ${formatTokenCount(provider.detectedContextWindowTokens)} tokens. Enter a value only to override.`
        : "Auto uses detected model metadata or conservative known-model defaults. Suggestions are editable because provider catalogs change."}
    >
      <TextInput
        type="number"
        min={1000}
        value={provider.contextWindowTokens ?? ""}
        placeholder={provider.detectedContextWindowTokens ? `${provider.detectedContextWindowTokens}` : "Auto"}
        onChange={(event) => updateProvider(provider.id, {
          contextWindowTokens: event.target.value ? Number(event.target.value) : undefined
        })}
      />
    </Field>
  );

  useEffect(() => {
    if (!open || !pendingModelCheckIds.size) return;
    const candidates = providers.filter((provider) =>
      pendingModelCheckIds.has(provider.id) &&
      (provider.kind === "openai-compatible" || provider.kind === "anthropic-compatible") &&
      providerApiKeyValue(provider).trim().length >= 20
    );
    if (!candidates.length) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const provider of candidates) {
          await checkProvider(provider.id);
        }
        setPendingModelCheckIds((current) => {
          const next = new Set(current);
          for (const provider of candidates) next.delete(provider.id);
          return next;
        });
      })();
    }, 450);
    return () => window.clearTimeout(timer);
  }, [open, pendingModelCheckIds, providers]);

  return (
    <>
      <Button type="button" onClick={openDialog}>
        <Settings size={16} />
        <span>Set up LLM provider</span>
      </Button>
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent
          title="LLM Provider Setup"
          description="Codebase mapping requires a working LLM provider. These provider settings are saved globally and reused when projects are opened."
          className="global-provider-dialog"
        >
          {notice ? <div className="settings-note">{notice}</div> : null}
          {showMacKeychainNote ? (
            <p className="settings-note settings-keychain-note">On macOS, API keys are stored in Keychain. Saving or using a saved key may ask you to allow ArchiCode to access it.</p>
          ) : null}
          <div className="provider-profile-toolbar">
            <Button type="button" size="sm" onClick={addProviderProfile}>
              <Plus size={14} />
              <span>New Provider</span>
            </Button>
          </div>
          <div className="provider-editor-list compact">
            {providers.map((provider) => (
              <article
                key={provider.id}
                data-provider-card={provider.id}
                className={provider.enabled ? "provider-card enabled" : "provider-card"}
              >
                <div className="provider-card-head">
                  <div className="provider-card-title">
                    <label className="radio-row">
                      <input
                        type="radio"
                        checked={provider.enabled}
                        onChange={() => setProviders((current) => current.map((item) => ({ ...item, enabled: item.id === provider.id })))}
                      />
                      <span>{provider.label}</span>
                    </label>
                    <small>{provider.id}</small>
                  </div>
                  <div className="provider-card-actions">
                    <Tooltip content={providerCheckHint(provider.kind)}>
                      <span>
                        <Button
                          type="button"
                          size="sm"
                          disabled={checkingProviderIds.has(provider.id)}
                          onClick={() => void checkProvider(provider.id)}
                        >
                          <Activity size={14} />
                          <span>{checkingProviderIds.has(provider.id) ? "Checking..." : "Check"}</span>
                        </Button>
                      </span>
                    </Tooltip>
                    <IconButton type="button" title="Duplicate provider profile" onClick={() => duplicateProvider(provider.id)}>
                      <Copy size={16} />
                    </IconButton>
                    <IconButton
                      type="button"
                      title="Delete provider profile"
                      onClick={() => removeProvider(provider.id)}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                </div>
                <Field label="Profile name">
                  <TextInput
                    data-provider-name-input={provider.id}
                    value={provider.label}
                    onChange={(event) => updateProvider(provider.id, { label: event.target.value })}
                  />
                </Field>
                <Field label="LLM Provider Source">
                  <Select
                    value={provider.kind}
                    onValueChange={(value) => changeProviderKind(provider.id, value as ProviderKind)}
                    options={providerKindOptions}
                  />
                </Field>
                <small>{providerDescription(provider.kind)}</small>
                {providerHealth[provider.id] ? (
                  <small className={providerHealth[provider.id].ok ? "health-ok" : "health-bad"}>
                    {providerHealth[provider.id].status}: {providerHealth[provider.id].message}
                  </small>
                ) : null}
                {provider.kind === "codex-local" || provider.kind === "claude-local" || provider.kind === "opencode-local" || provider.kind === "antigravity-local" || provider.kind === "grok-local" ? (
                  <>
                    {renderProviderModelField(provider, provider.kind === "codex-local" ? "configured Codex default" : provider.kind === "claude-local" ? "configured Claude default" : provider.kind === "opencode-local" ? "provider/model" : provider.kind === "antigravity-local" ? "configured agy default" : "configured Grok Build default")}
                    {provider.kind === "codex-local" ? renderOutputVerbosityField(provider) : null}
                    {renderContextWindowField(provider)}
                    <Field label="Local command">
                      <TextInput
                        value={provider.localCommand ?? (provider.kind === "codex-local" ? "codex" : provider.kind === "claude-local" ? "claude" : provider.kind === "opencode-local" ? "opencode" : provider.kind === "antigravity-local" ? "agy" : "grok")}
                        placeholder={provider.kind === "codex-local" ? "codex" : provider.kind === "claude-local" ? "claude" : provider.kind === "opencode-local" ? "opencode" : provider.kind === "antigravity-local" ? "agy" : "grok"}
                        onChange={(event) => updateProvider(provider.id, { localCommand: event.target.value || undefined })}
                      />
                    </Field>
                    <Field label={provider.kind === "opencode-local" || provider.kind === "antigravity-local" || provider.kind === "grok-local" ? "Agent" : provider.kind === "codex-local" ? "Profile" : "Settings override"}>
                      <TextInput
                        value={provider.localProfile ?? ""}
                        placeholder={provider.kind === "codex-local" ? "optional Codex profile" : provider.kind === "claude-local" ? "optional Claude settings profile" : provider.kind === "opencode-local" ? "optional OpenCode agent" : provider.kind === "antigravity-local" ? "optional Antigravity agent" : "optional Grok Build agent"}
                        onChange={(event) => updateProvider(provider.id, { localProfile: event.target.value || undefined })}
                      />
                    </Field>
                    <Field label={`${provider.kind === "codex-local" ? "Codex" : provider.kind === "claude-local" ? "Claude" : provider.kind === "opencode-local" ? "OpenCode" : provider.kind === "antigravity-local" ? "Antigravity" : "Grok Build"} command access`}>
                      <Select
                        value={provider.localSandbox ?? "read-only"}
                        onValueChange={(value) => updateProvider(provider.id, {
                          localSandbox: value as ProjectSettings["providers"][number]["localSandbox"]
                        })}
                        options={codexLocalSandboxOptions}
                      />
                    </Field>
                    <small>{provider.kind === "codex-local"
                      ? codexLocalCommandAccessHint
                      : provider.kind === "claude-local"
                        ? "Claude Code uses permission modes instead of a true filesystem sandbox. ArchiCode maps these access levels to read-only planning, auto-accepted workspace edits, or full bypass mode."
                        : provider.kind === "opencode-local"
                          ? "OpenCode runs once per request. Read-only phases receive explicit edit, shell, and external-directory denies; write-capable build phases use --auto."
                          : provider.kind === "antigravity-local"
                            ? "Antigravity uses plan+sandbox for read-only phases, accept-edits+sandbox for workspace writes, and bypasses permissions only in full-access mode."
                            : "Grok Build uses dontAsk plus its read-only sandbox for review phases, and bypassPermissions inside the selected workspace/off sandbox only for write-capable phases."}</small>
                    {provider.kind === "antigravity-local" ? (
                      <small>Antigravity always runs through one-shot <code>agy --print</code> calls; ArchiCode owns conversation continuity.</small>
                    ) : (
                      <>
                        <Switch
                          checked={Boolean(provider.ephemeral)}
                          onCheckedChange={(checked) => updateProvider(provider.id, { ephemeral: checked })}
                          label={provider.kind === "codex-local" ? "Use throwaway Codex sessions" : provider.kind === "claude-local" ? "Disable Claude session persistence" : provider.kind === "opencode-local" ? "Delete OpenCode sessions after each call" : "Delete Grok Build sessions after each call"}
                        />
                        <small>{provider.kind === "codex-local"
                          ? <>Adds <code>--ephemeral</code> for local Codex runs. ArchiCode still saves runs and artifacts, but Codex should not reuse or save its own CLI session state.</>
                          : provider.kind === "claude-local"
                            ? <>Adds <code>--no-session-persistence</code> for local Claude runs. ArchiCode still saves runs and artifacts, but Claude should not reuse or save its own CLI session state.</>
                            : provider.kind === "opencode-local"
                              ? <>Runs <code>opencode session delete</code> after the one-shot response. ArchiCode still saves its own runs and artifacts.</>
                              : <>Adds <code>--no-memory</code> and runs <code>grok sessions delete</code> after the one-shot response. ArchiCode still saves its own runs and artifacts.</>}</small>
                      </>
                    )}
                  </>
                ) : provider.kind === "offline-manual" ? (
                  <small>This is a non-AI offline mode for using ArchiCode as a living diagram, run ledger, artifact browser, and permissioned command shell. It cannot plan or code with an LLM until another provider is selected.</small>
                ) : (
                  <>
                    {renderProviderModelField(provider, provider.kind === "anthropic-compatible" ? "claude-sonnet-4-6" : "gpt-5.5")}
                    {provider.kind === "openai-compatible" ? renderOutputVerbosityField(provider) : null}
                    {renderContextWindowField(provider)}
                    <Field label="Base URL">
                      <TextInput
                        value={provider.baseUrl ?? ""}
                        placeholder={provider.kind === "anthropic-compatible" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
                        onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value || undefined })}
                      />
                    </Field>
                    {provider.kind === "openai-compatible" ? (
                      <Field label="Endpoint" hint={openAiEndpointHint(provider)}>
                        <Select
                          value={provider.openAiEndpointMode ?? "auto"}
                          onValueChange={(value) => updateProvider(provider.id, {
                            openAiEndpointMode: value as ProjectSettings["providers"][number]["openAiEndpointMode"],
                            detectedOpenAiEndpointMode: undefined
                          })}
                          options={[
                            {
                              value: "auto",
                              label: provider.detectedOpenAiEndpointMode
                                ? `Auto (${openAiEndpointLabel(provider.detectedOpenAiEndpointMode)})`
                                : "Auto (recommended)"
                            },
                            { value: "responses", label: "Responses API" },
                            { value: "chat-completions", label: "Chat Completions" }
                          ]}
                        />
                      </Field>
                    ) : null}
                    <Field label="API key" hint="Saved locally on this computer and hidden from project JSON.">
                      <div className="secret-input-row">
                        <TextInput
                          type={visibleApiKeyIds.has(provider.id) ? "text" : "password"}
                          value={providerApiKeyValue(provider)}
                          placeholder={savedApiKeyIds.has(provider.id)
                            ? "Saved API key (hidden)"
                            : provider.kind === "anthropic-compatible" ? "Paste Anthropic API key" : "Paste OpenAI API key"}
                          autoComplete="off"
                          spellCheck={false}
                          onPaste={() => setPendingModelCheckIds((current) => new Set(current).add(provider.id))}
                          onChange={(event) => updateProvider(provider.id, {
                            apiKey: event.target.value || undefined,
                            apiKeyEnv: undefined
                          })}
                        />
                        <IconButton
                          type="button"
                          title={visibleApiKeyIds.has(provider.id) ? "Hide API key" : "Show API key"}
                          onClick={() => setVisibleApiKeyIds((current) => {
                            const next = new Set(current);
                            if (next.has(provider.id)) next.delete(provider.id);
                            else next.add(provider.id);
                            return next;
                          })}
                        >
                          {visibleApiKeyIds.has(provider.id) ? <EyeOff size={18} /> : <Eye size={18} />}
                        </IconButton>
                      </div>
                      {savedApiKeyIds.has(provider.id) && !providerApiKeyValue(provider) ? (
                        <small>Saved key will be used. Paste a new key here to replace it.</small>
                      ) : null}
                    </Field>
                  </>
                )}
              </article>
            ))}
          </div>
          <div className="dialog-actions">
            <Button type="button" onClick={() => setOpen(false)}>Close</Button>
            <Button type="button" variant="primary" onClick={() => void save()} disabled={saveBusy}>
              {saveBusy ? <Loader2 size={16} className="is-spinning" /> : null}
              <span>{saveBusy ? "Saving..." : "Save provider setup"}</span>
            </Button>
          </div>
        </DialogContent>
      </DialogRoot>
    </>
  );
}
