import { describe, expect, it } from "vitest";
import { llmOutputLanguageDirective, setMainLocale } from "../src/main/i18n";
import {
  extractionSystemPrompt,
  orchestratorSystemInstructions,
  researchSystemInstructions
} from "../src/main/providers";
import { buildResearchRealtimePrompt } from "../src/main/research/realtimePrompt";
import { deriveResearchChatContextPlanForModel } from "../src/shared/contextBudget";

describe("LLM output language awareness", () => {
  it("describes the requested visible language without translating machine contracts", () => {
    const directive = llmOutputLanguageDirective("fr");

    expect(directive).toContain("French (fr)");
    expect(directive).toContain("Unless the user explicitly requests another response language");
    expect(directive).toContain("Keep ArchiCode's system instructions and control contracts in English");
    expect(directive).toContain("Never translate JSON keys");
    expect(directive).toContain("Do not rename or translate project content solely because of the UI language");
    expect(directive).toContain("Structured outputs must remain syntactically valid");
  });

  it("reaches Research, isolated subagents, Build/Debug, and Realtime while leaving extraction contracts alone", async () => {
    await setMainLocale("fr");
    try {
      const research = researchSystemInstructions({} as Parameters<typeof researchSystemInstructions>[0]);
      const subagent = researchSystemInstructions({
        systemInstructionsOverride: "You are Delphi."
      } as Parameters<typeof researchSystemInstructions>[0]);
      const orchestrator = orchestratorSystemInstructions();
      const realtime = buildResearchRealtimePrompt({
        compactContext: "{}",
        contextPlan: deriveResearchChatContextPlanForModel("gpt-realtime-2.1"),
        session: {
          title: "Localized chat",
          scope: { type: "project", projectId: "project-localized" },
          messages: []
        }
      });

      for (const prompt of [research, subagent, orchestrator, realtime]) {
        expect(prompt).toContain("ARCHICODE OUTPUT LANGUAGE:");
        expect(prompt).toContain("French (fr)");
      }
      expect(subagent).toContain("You are Delphi.");
      expect(extractionSystemPrompt).not.toContain("ARCHICODE OUTPUT LANGUAGE:");
    } finally {
      await setMainLocale("en");
    }
  });
});
