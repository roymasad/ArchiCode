import {
  Activity,
  Bug,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  Hammer,
  HelpCircle,
  LayoutGrid,
  Moon,
  MoreHorizontal,
  MessageSquare,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  UploadCloud,
  Upload,
  ImagePlus,
  Loader2,
  Mic,
  Plus,
  PlugZap,
  Volume2,
  Wrench,
  Square,
  X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";
import { defaultPhaseModelPolicies, runTargetProfileSchema, type LlmPhase, type ProjectSettings, type RunEffort, type RunScope, type RuntimeService, type SpeechSettings, type TtsSettings } from "@shared/schema";
import { deriveContextBudgetPlan } from "@shared/contextBudget";
import { isSubflowIgnored } from "@shared/graph";
import { providerHasCompletedCapabilityCheck, providerImageInputSupportStatus } from "@shared/providerCapabilities";
import { researchPersonalities, type GlobalResearchPersonality, type GlobalResearchVerbosity } from "@shared/researchPersonality";
import { runtimeInsight } from "@shared/runtimeInsights";
import { stripAnsiEscapes } from "@shared/terminalText";
import { useArchicodeStore, type ProjectSettingsTab } from "../store/useArchicodeStore";
import { runFailureMessage } from "../utils/runErrors";
import { isRunBlockingNewChange } from "../utils/runStatus";
import { canvasBackgroundOptions } from "../utils/canvasBackgrounds";
import {
  changeProviderCompatibility,
  codexLocalCommandAccessHint,
  codexLocalSandboxOptions,
  createProviderProfile,
  duplicateProviderProfile,
  isSeedProvider,
  providerApiKeyValue,
  providersNeedingAutoCheckOnSave,
  providerKindOptions,
  type ProviderKind
} from "../utils/providerProfiles";
import { PatchReviewPanel } from "./PatchReviewPanel";
import { HelpPage } from "./HelpPage";
import { GitPanel } from "./GitPanel";
import { ModelCombobox } from "./ModelCombobox";
import { ShortcutsSettingsTab } from "./ShortcutsSettingsTab";
import {
  Badge,
  Button,
  DialogContent,
  DialogRoot,
  Field,
  IconButton,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  Select,
  Switch,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
  TextArea,
  TextInput,
  Tooltip,
  Toolbar
} from "./ui";


export const fallbackModelPresets: Partial<Record<ProjectSettings["providers"][number]["kind"], string[]>> = {
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

export function isOfficialOpenAiCompatibleProvider(provider: ProjectSettings["providers"][number]): boolean {
  if (provider.kind !== "openai-compatible") return false;
  const baseUrl = provider.baseUrl?.trim() || "https://api.openai.com/v1";
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

export function providerCheckHint(kind: ProjectSettings["providers"][number]["kind"]): string {
  if (kind === "codex-local" || kind === "claude-local") {
    return "Checks the CLI connection and refreshes available models. Make sure the latest CLI version is installed.";
  }
  return "Checks the provider connection and refreshes available models when the provider exposes a model catalog.";
}

export const defaultSpeechSettings: SpeechSettings = {
  enabled: false,
  modelId: "base",
  language: "english",
  translateToEnglish: false,
  threads: 4
};

export const defaultTtsSettings: TtsSettings = {
  enabled: false,
  modelId: "kokoro-82m",
  voiceId: "af_heart",
  speed: 1,
  autoplay: false
};

export const projectSettingsTabs = new Set<ProjectSettingsTab>([
  "general",
  "providers",
  "commands",
  "agent-memory",
  "security",
  "context",
  "policy",
  "capabilities",
  "advanced",
  "shortcuts"
]);

export function modelOptionsForProvider(provider: ProjectSettings["providers"][number]): string[] {
  const fallbackOptions = fallbackModelPresets[provider.kind] ?? [];
  if (provider.detectedAvailableModels.length) {
    return provider.detectedAvailableModels;
  }
  return fallbackOptions;
}

export function modelHint(provider: ProjectSettings["providers"][number]): string {
  if (provider.kind === "codex-local") {
    return "Leave blank to use the Codex CLI/app configured default, currently treated as gpt-5.5. Use Check to load local Codex model IDs when available.";
  }
  if (provider.kind === "claude-local") {
    return "Leave blank to use the Claude Code configured default. Use Check to verify the local CLI/auth setup. ArchiCode shows curated fallback model suggestions here because the Claude CLI does not expose a machine-readable local model catalog or context window endpoint.";
  }
  if (provider.detectedAvailableModels.length) {
    if (isOfficialOpenAiCompatibleProvider(provider)) {
      return `Loaded ${provider.detectedAvailableModels.length} models from OpenAI's models endpoint.`;
    }
    return `Loaded ${provider.detectedAvailableModels.length} models from this provider's models endpoint.`;
  }
  return "Fallback suggestions only. Click Check to load this provider's available model IDs.";
}

export function modelOptionLabel(provider: ProjectSettings["providers"][number], model: string): string {
  const support = providerImageInputSupportStatus(provider, model);
  if (support.source !== "detected") return model;
  if (support.status === "supported") return `${model} · images`;
  if (support.status === "unsupported") return `${model} · text only`;
  return model;
}

export function selectedModelImageHint(provider: ProjectSettings["providers"][number]): string {
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

export function openAiEndpointLabel(mode: NonNullable<ProjectSettings["providers"][number]["detectedOpenAiEndpointMode"]>): string {
  return mode === "responses" ? "Responses API" : "Chat Completions";
}

export function openAiEndpointHint(provider: ProjectSettings["providers"][number]): string {
  if (provider.detectedOpenAiEndpointMode) {
    return `Check detected ${openAiEndpointLabel(provider.detectedOpenAiEndpointMode)} for this provider.`;
  }
  return "Auto tries Responses API first, then falls back to Chat Completions when the endpoint is not supported.";
}

export const policyPhases: LlmPhase[] = ["planning", "coding", "debugging", "review", "verifying", "summarizing", "brainstorming"];

export const phaseLabels: Record<LlmPhase, string> = {
  planning: "Planning",
  coding: "Coding",
  debugging: "Debugging",
  review: "Build/runtime review",
  verifying: "Verification",
  summarizing: "Context summary",
  brainstorming: "Chat Research"
};

export const mcpRegistryCategoryOptions = [
  { value: "all", label: "All" },
  { value: "coding", label: "Coding" },
  { value: "design", label: "Design" },
  { value: "office", label: "Office" },
  { value: "project-management", label: "Projects / Jira" },
  { value: "data-analytics", label: "Data & Analytics" },
  { value: "devops", label: "DevOps" },
  { value: "browser-automation", label: "Browser Automation" },
  { value: "communication", label: "Communication" },
  { value: "finance-commerce", label: "Finance & Commerce" },
  { value: "marketing-sales", label: "Marketing & Sales" },
  { value: "ai-media", label: "AI & Media" },
  { value: "knowledge-docs", label: "Knowledge & Docs" },
  { value: "other", label: "Other" }
];

export const mcpRegistrySortOptions = [
  { value: "registry", label: "Registry order" },
  { value: "name-asc", label: "Name A-Z" },
  { value: "name-desc", label: "Name Z-A" },
  { value: "installable", label: "Installable first" },
  { value: "category", label: "Category" }
];

export const speechLanguageOptions = [
  { value: "english", label: "English" },
  { value: "chinese", label: "Chinese" },
  { value: "german", label: "German" },
  { value: "spanish", label: "Spanish" },
  { value: "russian", label: "Russian" },
  { value: "korean", label: "Korean" },
  { value: "french", label: "French" },
  { value: "japanese", label: "Japanese" },
  { value: "portuguese", label: "Portuguese" },
  { value: "turkish", label: "Turkish" },
  { value: "polish", label: "Polish" },
  { value: "catalan", label: "Catalan" },
  { value: "dutch", label: "Dutch" },
  { value: "arabic", label: "Arabic" },
  { value: "swedish", label: "Swedish" },
  { value: "italian", label: "Italian" },
  { value: "indonesian", label: "Indonesian" },
  { value: "hindi", label: "Hindi" },
  { value: "finnish", label: "Finnish" },
  { value: "vietnamese", label: "Vietnamese" },
  { value: "hebrew", label: "Hebrew" },
  { value: "ukrainian", label: "Ukrainian" },
  { value: "greek", label: "Greek" },
  { value: "malay", label: "Malay" },
  { value: "czech", label: "Czech" },
  { value: "romanian", label: "Romanian" },
  { value: "danish", label: "Danish" },
  { value: "hungarian", label: "Hungarian" },
  { value: "tamil", label: "Tamil" },
  { value: "norwegian", label: "Norwegian" },
  { value: "thai", label: "Thai" },
  { value: "urdu", label: "Urdu" },
  { value: "croatian", label: "Croatian" },
  { value: "bulgarian", label: "Bulgarian" },
  { value: "lithuanian", label: "Lithuanian" },
  { value: "latin", label: "Latin" },
  { value: "maori", label: "Maori" },
  { value: "malayalam", label: "Malayalam" },
  { value: "welsh", label: "Welsh" },
  { value: "slovak", label: "Slovak" },
  { value: "telugu", label: "Telugu" },
  { value: "persian", label: "Persian" },
  { value: "latvian", label: "Latvian" },
  { value: "bengali", label: "Bengali" },
  { value: "serbian", label: "Serbian" },
  { value: "azerbaijani", label: "Azerbaijani" },
  { value: "slovenian", label: "Slovenian" },
  { value: "kannada", label: "Kannada" },
  { value: "estonian", label: "Estonian" },
  { value: "macedonian", label: "Macedonian" },
  { value: "breton", label: "Breton" },
  { value: "basque", label: "Basque" },
  { value: "icelandic", label: "Icelandic" },
  { value: "armenian", label: "Armenian" },
  { value: "nepali", label: "Nepali" },
  { value: "mongolian", label: "Mongolian" },
  { value: "bosnian", label: "Bosnian" },
  { value: "kazakh", label: "Kazakh" },
  { value: "albanian", label: "Albanian" },
  { value: "swahili", label: "Swahili" },
  { value: "galician", label: "Galician" },
  { value: "marathi", label: "Marathi" },
  { value: "punjabi", label: "Punjabi" },
  { value: "sinhala", label: "Sinhala" },
  { value: "khmer", label: "Khmer" },
  { value: "shona", label: "Shona" },
  { value: "yoruba", label: "Yoruba" },
  { value: "somali", label: "Somali" },
  { value: "afrikaans", label: "Afrikaans" },
  { value: "occitan", label: "Occitan" },
  { value: "georgian", label: "Georgian" },
  { value: "belarusian", label: "Belarusian" },
  { value: "tajik", label: "Tajik" },
  { value: "sindhi", label: "Sindhi" },
  { value: "gujarati", label: "Gujarati" },
  { value: "amharic", label: "Amharic" },
  { value: "yiddish", label: "Yiddish" },
  { value: "lao", label: "Lao" },
  { value: "uzbek", label: "Uzbek" },
  { value: "faroese", label: "Faroese" },
  { value: "haitian creole", label: "Haitian Creole" },
  { value: "pashto", label: "Pashto" },
  { value: "turkmen", label: "Turkmen" },
  { value: "nynorsk", label: "Nynorsk" },
  { value: "maltese", label: "Maltese" },
  { value: "sanskrit", label: "Sanskrit" },
  { value: "luxembourgish", label: "Luxembourgish" },
  { value: "myanmar", label: "Myanmar" },
  { value: "tibetan", label: "Tibetan" },
  { value: "tagalog", label: "Tagalog" },
  { value: "malagasy", label: "Malagasy" },
  { value: "assamese", label: "Assamese" },
  { value: "tatar", label: "Tatar" },
  { value: "hawaiian", label: "Hawaiian" },
  { value: "lingala", label: "Lingala" },
  { value: "hausa", label: "Hausa" },
  { value: "bashkir", label: "Bashkir" },
  { value: "javanese", label: "Javanese" },
  { value: "sundanese", label: "Sundanese" }
];

export const speechLanguageAliases: Record<string, string> = {
  auto: "english",
  en: "english",
  zh: "chinese",
  de: "german",
  es: "spanish",
  ru: "russian",
  ko: "korean",
  fr: "french",
  ja: "japanese",
  pt: "portuguese",
  ar: "arabic",
  it: "italian"
};

export const runtimeUrlPattern = /(https?:\/\/[^\s"'<>),]+)/g;

export function providerSupportsImages(provider: ProjectSettings["providers"][number] | undefined): boolean {
  if (!provider || provider.kind === "offline-manual") return false;
  if (provider.kind === "codex-local" || provider.kind === "claude-local") return true;
  const model = (provider.model ?? "").toLowerCase();
  return !model.includes("text");
}

export function openRuntimeUrl(url: string): void {
  if (window.archicode?.openExternalUrl) {
    void window.archicode.openExternalUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function runtimeCwdLabel(cwd: string | undefined): string {
  return cwd?.trim() ? cwd : "project root";
}

export function extractRuntimeUrl(text: string): string | null {
  const match = stripAnsiEscapes(text).match(runtimeUrlPattern);
  return match?.[1]?.replace(/[.,;]+$/, "") ?? null;
}

export function runtimePrimaryUrl(service: RuntimeService): string | null {
  if (service.url) return stripAnsiEscapes(service.url);
  for (const line of [...service.logs].reverse()) {
    const url = extractRuntimeUrl(line.text);
    if (url) return url;
  }
  return null;
}

export function runtimeUrls(service: RuntimeService): string[] {
  const primaryUrl = runtimePrimaryUrl(service);
  return primaryUrl ? [primaryUrl] : [];
}

export function RuntimeUrlLinks({ urls }: { urls: string[] }) {
  if (!urls.length) return null;
  return (
    <>
      {urls.map((url) => (
        <a
          key={url}
          href={url}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openRuntimeUrl(url);
          }}
        >
          {url}
        </a>
      ))}
    </>
  );
}

export function renderRuntimeTextWithLinks(text: string) {
  return stripAnsiEscapes(text).split(runtimeUrlPattern).map((part, index) => {
    if (!/^https?:\/\//.test(part)) return part;
    return (
      <a
        key={`${part}-${index}`}
        href={part}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openRuntimeUrl(part);
        }}
      >
        {part}
      </a>
    );
  });
}

export function renderRuntimeInsightDetail(service: RuntimeService, label: string, detail: string) {
  const linkedUrl = extractRuntimeUrl(detail) ?? (label === "Ready" ? runtimePrimaryUrl(service) : null);
  if (!linkedUrl) return <span>{detail}</span>;
  return (
    <a
      href={linkedUrl}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openRuntimeUrl(linkedUrl);
      }}
    >
      {detail}
    </a>
  );
}

export function isMacRuntime(): boolean {
  if (typeof navigator === "undefined") return false;
  return /\bMac\b/i.test(navigator.platform) || /\bMac OS\b/i.test(navigator.userAgent);
}

export function mcpRegistryInitials(title: string, name: string): string {
  const words = (title || name).replace(/[@/.-]+/g, " ").split(/\s+/).filter(Boolean);
  return (words.length >= 2 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "M").slice(0, 2)).toUpperCase();
}

export function mcpRegistryCategoryLabel(category: string): string {
  return mcpRegistryCategoryOptions.find((option) => option.value === category)?.label ?? category;
}

export function normalizeSpeechLanguage(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "english";
  return speechLanguageAliases[normalized] ?? normalized;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let amount = value / 1024;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${Math.max(1, Math.round(amount))} ${units[unitIndex]}`;
}

export function mergeAudioChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function encodeWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  const samples = mergeAudioChunks(chunks);
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return buffer;
}


export function contextLabel(key: keyof ProjectSettings["contextBuilder"]): string {
  const labels: Record<string, string> = {
    includeNotes: "Include notes and answers",
    includeArtifacts: "Include artifacts",
    includeRuns: "Include recent runs",
    includeSummaries: "Include summaries",
    includeLockedNodes: "Include approved locked nodes"
  };
  return labels[key] ?? key;
}

export function providerDescription(kind: ProjectSettings["providers"][number]["kind"]): string {
  if (kind === "offline-manual") return "Legacy manual mode. Existing projects should choose a real provider before planning or coding.";
  if (kind === "openai-compatible") return "Custom HTTP endpoint using the OpenAI chat/completions shape, including local or hosted compatible providers.";
  if (kind === "anthropic-compatible") return "Anthropic Messages API endpoint.";
  if (kind === "codex-local") return "Runs the local Codex CLI/app bridge when installed and signed in.";
  if (kind === "claude-local") return "Runs the local Claude Code CLI when installed and signed in.";
  return "";
}

export function formatTokenCount(value: number): string {
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

export function contextBudgetSourceLabel(source: string): string {
  if (source === "provider-override") return "override";
  if (source === "provider-detected") return "detected";
  if (source === "known-model") return "known";
  if (source === "manual") return "manual";
  return "fallback";
}
