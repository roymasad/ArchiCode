import type { ProjectSettings, ResearchChatSession } from "@shared/schema";

type Provider = ProjectSettings["providers"][number];

export const PROVIDER_DEFAULT_MODEL_VALUE = "__provider-default__";

export function configuredResearchModelId(provider: Provider | undefined): string {
  return provider?.phaseModelPolicies.brainstorming.modelOverride?.trim() || provider?.model?.trim() || "";
}

function historicalResearchModelId(session: ResearchChatSession, provider: Provider | undefined): string {
  return [...session.messages].reverse().find((message) => (
    message.role === "assistant" && message.usage?.modelId?.trim() && message.usage.modelId !== provider?.kind
  ))?.usage?.modelId?.trim() || "";
}

/** Resolves only this session's model; other chats never influence an existing chat. */
export function persistedResearchModelId(session: ResearchChatSession, provider: Provider | undefined): string {
  return session.modelId?.trim() ||
    historicalResearchModelId(session, provider) ||
    configuredResearchModelId(provider) ||
    PROVIDER_DEFAULT_MODEL_VALUE;
}

/** New-chat default only: most recent model used with this provider, then its configured default. */
export function lastUsedResearchModelId(sessions: ResearchChatSession[], provider: Provider | undefined): string {
  if (!provider) return PROVIDER_DEFAULT_MODEL_VALUE;
  const latestSessions = sessions
    .filter((session) => session.providerId === provider.id && session.messages.length > 0)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const session of latestSessions) {
    const selectedModelId = session.modelId?.trim() || historicalResearchModelId(session, provider);
    if (selectedModelId) return selectedModelId;
  }
  return configuredResearchModelId(provider) || PROVIDER_DEFAULT_MODEL_VALUE;
}

export function chatModelDisplayName(value: string): string {
  return value === PROVIDER_DEFAULT_MODEL_VALUE ? "Provider default" : value;
}
