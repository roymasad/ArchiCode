import { describe, expect, it } from "vitest";
import {
  GLOBAL_RESEARCH_PERSONALITY_IDS,
  GLOBAL_RESEARCH_VERBOSITY_IDS,
  defaultResearchPersonalityPrompt,
  parseGlobalResearchPersonality,
  parseGlobalResearchVerbosity,
  researchPersonalities,
  researchPersonalityPrompt,
  researchPersonalitySharedDirective
} from "../src/shared/researchPersonality";

describe("research personality registry", () => {
  it("falls back to default for missing or invalid stored values", () => {
    expect(parseGlobalResearchPersonality(undefined)).toBe("default");
    expect(parseGlobalResearchPersonality(null)).toBe("default");
    expect(parseGlobalResearchPersonality("not-a-personality")).toBe("default");
    expect(parseGlobalResearchVerbosity(undefined)).toBe("default");
    expect(parseGlobalResearchVerbosity(null)).toBe("default");
    expect(parseGlobalResearchVerbosity("not-a-verbosity")).toBe("default");
  });

  it("round-trips every supported personality id", () => {
    expect(researchPersonalities.map((personality) => personality.id)).toEqual([...GLOBAL_RESEARCH_PERSONALITY_IDS]);
    for (const personality of GLOBAL_RESEARCH_PERSONALITY_IDS) {
      expect(parseGlobalResearchPersonality(personality)).toBe(personality);
    }
    for (const verbosity of GLOBAL_RESEARCH_VERBOSITY_IDS) {
      expect(parseGlobalResearchVerbosity(verbosity)).toBe(verbosity);
    }
  });

  it("builds the default and non-default prompt variants correctly", () => {
    expect(researchPersonalityPrompt("default")).toBe(defaultResearchPersonalityPrompt);
    expect(researchPersonalityPrompt("claptrap")).toContain(researchPersonalitySharedDirective);
    expect(researchPersonalityPrompt("claptrap")).toContain("Roleplay the selected character throughout the conversation.");
    expect(researchPersonalityPrompt("claptrap")).toContain("Dial the personality impersonation and roleplay to 11");
    expect(researchPersonalityPrompt("claptrap")).toContain("Make the persona obvious immediately");
    expect(researchPersonalityPrompt("claptrap")).toContain("must persist across the full reply and across the whole chat session");
    expect(researchPersonalityPrompt("claptrap")).toContain("Claptrap from Borderlands");
    expect(researchPersonalityPrompt("jar-jar-binks")).toContain("Adopt the personality and presentation style of Jar Jar Binks");
    expect(researchPersonalityPrompt("jar-jar-binks")).toContain("Gungan-inspired grammar");
    expect(researchPersonalityPrompt("groot")).toContain("Groot from Guardians of the Galaxy");
    expect(researchPersonalityPrompt("groot")).toContain("I am Groot");
    expect(researchPersonalityPrompt("cat-waifu")).toContain("Adopt a playful cat-waifu anime-assistant persona");
    expect(researchPersonalityPrompt("cat-waifu")).toContain("make the catlike anime-assistant vibe immediately obvious");
  });
});
