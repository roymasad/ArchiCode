import { z } from "zod";
import { supportedLocales } from "./i18n/locale";

export const projectBriefingPresetSchema = z.enum(["simple", "quick", "onboarding"]);
export type ProjectBriefingPreset = z.infer<typeof projectBriefingPresetSchema>;

export const projectBriefingEvidenceSchema = z.object({
  reference: z.string().trim().min(1).max(320),
  label: z.string().trim().min(1).max(160),
  excerpt: z.string().trim().min(1).max(600)
});
export type ProjectBriefingEvidence = z.infer<typeof projectBriefingEvidenceSchema>;

export const projectBriefingVisualItemSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  detail: z.string().trim().min(1).max(140).optional(),
  kind: z.enum(["person", "service", "screen", "data", "system", "step", "concept"]),
  tone: z.enum(["cyan", "violet", "green", "amber", "rose", "neutral"]).default("neutral")
});
export type ProjectBriefingVisualItem = z.infer<typeof projectBriefingVisualItemSchema>;

export const projectBriefingVisualSchema = z.object({
  kind: z.enum(["map", "sequence", "spotlight", "layers", "timeline"]),
  items: z.array(projectBriefingVisualItemSchema).min(1).max(7),
  connections: z.array(z.object({
    from: z.string().trim().min(1).max(80),
    to: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(60).optional()
  })).max(8).default([])
}).superRefine((visual, context) => {
  const ids = new Set(visual.items.map((item) => item.id));
  for (const connection of visual.connections) {
    if (!ids.has(connection.from) || !ids.has(connection.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Visual connection ${connection.from} -> ${connection.to} must reference visual item ids.`
      });
    }
  }
});

export const projectBriefingSlideSchema = z.object({
  id: z.string().trim().min(1).max(80),
  kicker: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(140),
  body: z.string().trim().min(1).max(900),
  narration: z.string().trim().min(1).max(1400),
  visual: projectBriefingVisualSchema,
  evidence: z.array(projectBriefingEvidenceSchema).min(1).max(6),
  suggestedQuestions: z.array(z.string().trim().min(1).max(140)).max(3).default([])
});
export type ProjectBriefingSlide = z.infer<typeof projectBriefingSlideSchema>;

export const projectBriefingVoiceContractSchema = z.object({
  version: z.literal(1),
  commands: z.array(z.enum([
    "next",
    "previous",
    "pause",
    "resume",
    "repeat",
    "simplify",
    "show-evidence"
  ])).min(7).max(7)
});

export const projectBriefingSchema = z.object({
  id: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  preset: projectBriefingPresetSchema,
  locale: z.enum(supportedLocales).default("en"),
  title: z.string().trim().min(1).max(140),
  subtitle: z.string().trim().min(1).max(240),
  generatedAt: z.string().datetime(),
  slides: z.array(projectBriefingSlideSchema).min(5).max(8),
  voice: projectBriefingVoiceContractSchema
});
export type ProjectBriefing = z.infer<typeof projectBriefingSchema>;

export const projectBriefingQuestionInputSchema = z.object({
  deck: projectBriefingSchema,
  slideIndex: z.number().int().nonnegative(),
  question: z.string().trim().min(1).max(1200),
  history: z.array(z.object({
    question: z.string().trim().min(1).max(1200),
    answer: z.string().trim().min(1).max(3000)
  })).max(6).default([])
});
export type ProjectBriefingQuestionInput = z.infer<typeof projectBriefingQuestionInputSchema>;

export const projectBriefingAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(3000),
  evidence: z.array(projectBriefingEvidenceSchema).min(1).max(6),
  suggestedQuestions: z.array(z.string().trim().min(1).max(140)).max(3).default([])
});
export type ProjectBriefingAnswer = z.infer<typeof projectBriefingAnswerSchema>;

export const projectBriefingVoiceCommands: ProjectBriefing["voice"] = {
  version: 1,
  commands: ["next", "previous", "pause", "resume", "repeat", "simplify", "show-evidence"]
};
