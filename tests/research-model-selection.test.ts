import { describe, expect, it } from "vitest";
import { createSeedProject } from "../src/shared/fixtures";
import { researchChatSessionSchema, type ResearchChatSession } from "../src/shared/schema";
import {
  lastUsedResearchModelId,
  persistedResearchModelId
} from "../src/renderer/src/utils/researchModels";

function chat(input: {
  id: string;
  modelId?: string | null;
  providerId?: string;
  usageModelId?: string;
  updatedAt: string;
}): ResearchChatSession {
  return researchChatSessionSchema.parse({
    id: input.id,
    projectRoot: "/tmp/project",
    scope: { type: "project", projectId: "project-seed" },
    title: input.id,
    providerId: input.providerId,
    modelId: input.modelId,
    messages: input.usageModelId ? [{
      id: `${input.id}-assistant`,
      role: "assistant",
      content: "Answer",
      createdAt: input.updatedAt,
      usage: {
        providerId: input.providerId ?? "openai-compatible",
        modelId: input.usageModelId,
        inputTokens: 1,
        outputTokens: 1
      }
    }] : [{
      id: `${input.id}-user`,
      role: "user",
      content: "Question",
      createdAt: input.updatedAt
    }],
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt
  });
}

describe("research chat model selection", () => {
  const provider = {
    ...createSeedProject("/tmp/project").project.settings.providers[0]!,
    model: "provider-default"
  };

  it("never lets another chat's newer model alter an existing chat", () => {
    const existing = chat({
      id: "existing",
      providerId: provider.id,
      modelId: "model-a",
      updatedAt: "2026-07-14T10:00:00.000Z"
    });
    const newer = chat({
      id: "newer",
      providerId: provider.id,
      modelId: "model-b",
      updatedAt: "2026-07-14T11:00:00.000Z"
    });

    expect(persistedResearchModelId(existing, provider)).toBe("model-a");
    expect(lastUsedResearchModelId([existing, newer], provider)).toBe("model-b");
  });

  it("keeps the chat's model when the active provider changes", () => {
    const existing = chat({
      id: "existing",
      providerId: "previous-provider",
      modelId: "model-from-this-chat",
      updatedAt: "2026-07-14T10:00:00.000Z"
    });
    const activeProvider = {
      ...provider,
      id: "active-provider",
      model: "active-provider-default"
    };

    expect(persistedResearchModelId(existing, activeProvider)).toBe("model-from-this-chat");
  });

  it("recovers a legacy chat's own model from its usage history", () => {
    const legacy = chat({
      id: "legacy",
      providerId: provider.id,
      usageModelId: "legacy-model",
      updatedAt: "2026-07-14T09:00:00.000Z"
    });

    expect(persistedResearchModelId(legacy, provider)).toBe("legacy-model");
  });

  it("recovers a legacy chat's model when it stored provider-default as null", () => {
    const legacy = chat({
      id: "legacy-null",
      providerId: "previous-provider",
      modelId: null,
      usageModelId: "legacy-model",
      updatedAt: "2026-07-14T09:00:00.000Z"
    });

    expect(persistedResearchModelId(legacy, provider)).toBe("legacy-model");
  });

  it("falls back to the active provider default when no model history exists", () => {
    expect(lastUsedResearchModelId([], provider)).toBe("provider-default");
  });
});
