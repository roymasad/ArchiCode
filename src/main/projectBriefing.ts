import { randomUUID } from "node:crypto";
import type { ProjectBundle } from "../shared/schema";
import type { SupportedLocale } from "../shared/i18n/locale";
import {
  projectBriefingAnswerSchema,
  projectBriefingQuestionInputSchema,
  projectBriefingSchema,
  projectBriefingVoiceCommands,
  type ProjectBriefing,
  type ProjectBriefingAnswer,
  type ProjectBriefingPreset,
  type ProjectBriefingQuestionInput
} from "../shared/projectBriefing";
import { archicodeInternalTools, callArchicodeInternalTool } from "./internalTools";
import type { ProviderMcpTool } from "./mcp";
import { extractJsonObject } from "./microRunAgents/readOnlyTools";
import { callResearchProvider } from "./providers";
import { readArtifactText } from "./storage/patches";
import { hydrateProviderForUse, loadProject } from "./storage/projectStore";
import { projectStatePath, readJsonDirectory, writeJson } from "./storage/persistence";

const MAX_TOOL_CALLS = 8;
const readOnlyBriefingToolNames = new Set([
  "archicode_project_list_files",
  "archicode_project_search_files",
  "archicode_project_read_file",
  "archicode_project_query_code_graph"
]);

const presetDirections: Record<ProjectBriefingPreset, string> = {
  simple: [
    "Explain the project as if the audience is bright but completely non-technical.",
    "Prefer everyday actors, goals, and cause-and-effect. Define any unavoidable technical term immediately.",
    "Use a warm, playful tone without being childish or inaccurate."
  ].join(" "),
  quick: [
    "Brief a busy developer who needs the shortest useful mental model.",
    "Prioritize purpose, major actors, the happy path, architecture boundaries, and the two or three facts that prevent wrong assumptions.",
    "Keep every card crisp and information-dense."
  ].join(" "),
  onboarding: [
    "Onboard a developer who will work in this repository.",
    "Move from product purpose to major flows, system boundaries, code organization, and a sensible first area to inspect.",
    "Explain project vocabulary and mention uncertainty honestly."
  ].join(" ")
};

const briefingLanguageNames: Record<SupportedLocale, string> = {
  en: "English",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  "zh-Hans": "Simplified Chinese",
  ja: "Japanese"
};

export function projectBriefingLanguageInstruction(locale: SupportedLocale): string {
  return [
    `Write all user-facing content in ${briefingLanguageNames[locale]} (locale ${locale}).`,
    "Use that language even when the project evidence or the user's question is written in another language.",
    "Preserve proper names, file paths, code identifiers, exact evidence references, JSON property names, and required enum values.",
    "For a briefing, this applies to the title, subtitle, kickers, slide copy, narration, visual labels and details, connection labels, evidence labels and excerpts, and suggested questions.",
    "For an answer, this applies to the answer, evidence labels and excerpts, and suggested questions."
  ].join(" ");
}

type EvidenceCatalog = {
  context: string;
  references: Set<string>;
};

function compactText(value: string, length: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, Math.max(0, length - 1))}…` : text;
}

export function buildProjectBriefingEvidenceCatalog(bundle: ProjectBundle): EvidenceCatalog {
  const references = new Set<string>([`project:${bundle.project.id}`]);
  const flows = bundle.flows.slice(0, 18).map((flow) => {
    const flowReference = `flow:${flow.id}`;
    references.add(flowReference);
    const nodes = flow.nodes.slice(0, 24).map((node) => {
      references.add(`node:${flow.id}:${node.id}`);
      return {
        reference: `node:${flow.id}:${node.id}`,
        type: node.type,
        title: node.title,
        summary: compactText(node.description, 180),
        technology: node.techStack.slice(0, 5)
      };
    });
    const edges = flow.edges.slice(0, 32).map((edge) => {
      references.add(`edge:${flow.id}:${edge.id}`);
      return {
        reference: `edge:${flow.id}:${edge.id}`,
        source: edge.source,
        target: edge.target,
        label: edge.label
      };
    });
    return {
      reference: flowReference,
      name: flow.name,
      summary: compactText(flow.description, 240),
      nodes,
      edges,
      omittedNodes: Math.max(0, flow.nodes.length - nodes.length),
      omittedEdges: Math.max(0, flow.edges.length - edges.length)
    };
  });
  const context = JSON.stringify({
    project: {
      reference: `project:${bundle.project.id}`,
      name: bundle.project.name,
      description: compactText(bundle.project.description, 800),
      flowCount: bundle.flows.length
    },
    flows,
    omittedFlows: Math.max(0, bundle.flows.length - flows.length),
    evidenceRule: "Every factual claim must cite one or more exact reference values from this catalog or a file:<path> reference obtained by reading that file."
  });
  return { context, references };
}

export function validateProjectBriefingEvidence(
  value: Pick<ProjectBriefing, "slides"> | ProjectBriefingAnswer,
  allowedReferences: Set<string>
): string | undefined {
  const evidence = "slides" in value
    ? value.slides.flatMap((slide) => slide.evidence)
    : value.evidence;
  const invalid = evidence
    .map((item) => item.reference)
    .filter((reference) => !allowedReferences.has(reference));
  return invalid.length
    ? `Unknown evidence reference(s): ${[...new Set(invalid)].join(", ")}. Use only catalog references or files actually read with a tool.`
    : undefined;
}

export async function listProjectBriefings(projectRoot: string): Promise<ProjectBriefing[]> {
  const values = await readJsonDirectory<unknown>(projectStatePath(projectRoot, "artifacts", "briefings"));
  return values
    .flatMap((value) => {
      const parsed = projectBriefingSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
}

export async function loadProjectBriefing(projectRoot: string, briefingId: string): Promise<ProjectBriefing> {
  const briefing = (await listProjectBriefings(projectRoot)).find((item) => item.id === briefingId);
  if (!briefing) throw new Error("That saved project briefing was not found. Generate it again.");
  return briefing;
}

export async function saveProjectBriefing(projectRoot: string, briefing: ProjectBriefing): Promise<void> {
  await writeJson(projectStatePath(projectRoot, "artifacts", "briefings", `${briefing.preset}.json`), briefing);
}

function briefingTools(bundle: ProjectBundle): ProviderMcpTool[] {
  return archicodeInternalTools(bundle.project.settings)
    .filter((tool) => readOnlyBriefingToolNames.has(tool.providerToolName));
}

function generationInstructions(locale: SupportedLocale): string {
  return [
    "You are the ArchiCode Project Briefing Curator.",
    projectBriefingLanguageInstruction(locale),
    "Create a friendly, accurate visual briefing from supplied project evidence. This is not a raw graph tour.",
    "You are read-only. You may use only the provided investigation tools and must never suggest that you changed the project.",
    `Use at most ${MAX_TOOL_CALLS} tool calls. Investigate only when the supplied catalog is insufficient.`,
    "Return one JSON object and no markdown or prose outside it.",
    "The JSON shape is:",
    '{"title":"string","subtitle":"string","slides":[{"id":"stable-short-id","kicker":"string","title":"string","body":"string","narration":"string","visual":{"kind":"map|sequence|spotlight|layers|timeline","items":[{"id":"string","label":"string","detail":"optional string","kind":"person|service|screen|data|system|step|concept","tone":"cyan|violet|green|amber|rose|neutral"}],"connections":[{"from":"item id","to":"item id","label":"optional string"}]},"evidence":[{"reference":"exact supplied reference","label":"human label","excerpt":"specific supporting fact"}],"suggestedQuestions":["question"]}]}',
    "Produce 5 to 8 slides. Each slide needs at least one evidence item. Prefer distinct evidence across the deck.",
    "body is concise display copy. narration is a natural spoken version with enough context to stand alone; do not merely duplicate body.",
    "Visuals are semantic primitives, not graph coordinates. Every connection endpoint must match an item id on that slide.",
    "Never invent a file, feature, user, service, or relationship. If evidence is thin, state uncertainty rather than filling a gap.",
    "For graph evidence use exact project:, flow:, node:, or edge: references from the catalog.",
    "For source evidence, cite file:<project-relative-path> only after archicode_project_read_file successfully read that exact path."
  ].join("\n");
}

function answerInstructions(locale: SupportedLocale): string {
  return [
    "You answer questions during an ArchiCode project briefing.",
    projectBriefingLanguageInstruction(locale),
    "Be concise, friendly, and grounded in the supplied deck and project evidence.",
    "You are read-only and may use at most 8 provided investigation tool calls.",
    "Return one JSON object and no markdown or prose outside it:",
    '{"answer":"string","evidence":[{"reference":"exact supplied reference","label":"human label","excerpt":"specific supporting fact"}],"suggestedQuestions":["optional follow-up"]}',
    "Every answer needs at least one evidence item. Never invent evidence.",
    "For source evidence, cite file:<project-relative-path> only after reading that exact file."
  ].join("\n");
}

function parseObject(text: string): Record<string, unknown> {
  return extractJsonObject(text);
}

function enabledProvider(bundle: ProjectBundle) {
  return bundle.project.settings.providers.find((provider) => provider.enabled && provider.kind !== "offline-manual")
    ?? bundle.project.settings.providers.find((provider) => provider.enabled);
}

function createToolCaller(projectRoot: string, bundle: ProjectBundle, allowedReferences: Set<string>) {
  let calls = 0;
  return async (input: { providerToolName: string; argumentsJson: string }): Promise<string> => {
    if (!readOnlyBriefingToolNames.has(input.providerToolName)) {
      throw new Error(`Tool ${input.providerToolName} is not available in read-only briefing mode.`);
    }
    calls += 1;
    if (calls > MAX_TOOL_CALLS) throw new Error(`Briefing investigation is limited to ${MAX_TOOL_CALLS} tool calls.`);
    const result = await callArchicodeInternalTool({
      projectRoot,
      settings: bundle.project.settings,
      loadProject: () => loadProject(projectRoot),
      readArtifactText: (artifactPath) => readArtifactText(projectRoot, artifactPath)
    }, input);
    if (input.providerToolName === "archicode_project_read_file") {
      const args = JSON.parse(input.argumentsJson) as { path?: unknown };
      if (typeof args.path === "string" && args.path.trim()) allowedReferences.add(`file:${args.path.trim()}`);
    }
    return result.resultText;
  };
}

export async function generateProjectBriefing(
  projectRoot: string,
  preset: ProjectBriefingPreset,
  locale: SupportedLocale
): Promise<ProjectBriefing> {
  const bundle = await loadProject(projectRoot);
  const provider = enabledProvider(bundle);
  if (!provider || provider.kind === "offline-manual") {
    throw new Error("Choose an AI provider in Settings before creating a project briefing.");
  }
  const hydratedProvider = await hydrateProviderForUse(provider);
  const catalog = buildProjectBriefingEvidenceCatalog(bundle);
  const tools = briefingTools(bundle);
  const response = await callResearchProvider(hydratedProvider, [
    `Create the “${preset}” project briefing.`,
    presetDirections[preset]
  ].join("\n\n"), {
    projectRoot,
    webSearchEnabled: false,
    scopeContext: catalog.context,
    systemInstructionsOverride: generationInstructions(locale),
    messages: [],
    mcpTools: tools,
    mcpServers: [],
    callMcpTool: createToolCaller(projectRoot, bundle, catalog.references),
    cacheSessionId: `briefing:${bundle.project.id}:${preset}:${locale}`,
    validateFinalAnswer: (text) => {
      try {
        const candidate = parseObject(text);
        const parsed = projectBriefingSchema.omit({
          id: true,
          projectId: true,
          preset: true,
          locale: true,
          generatedAt: true,
          voice: true
        }).safeParse(candidate);
        if (!parsed.success) return `Your briefing JSON is invalid: ${parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
        return validateProjectBriefingEvidence({ slides: parsed.data.slides }, catalog.references);
      } catch (error) {
        return `Return valid briefing JSON only. ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  });
  const generated = projectBriefingSchema.omit({
    id: true,
    projectId: true,
    preset: true,
    locale: true,
    generatedAt: true,
    voice: true
  }).parse(parseObject(response));
  const briefing = projectBriefingSchema.parse({
    ...generated,
    id: randomUUID(),
    projectId: bundle.project.id,
    preset,
    locale,
    generatedAt: new Date().toISOString(),
    voice: projectBriefingVoiceCommands
  });
  await saveProjectBriefing(projectRoot, briefing);
  return briefing;
}

export async function askProjectBriefingQuestion(
  projectRoot: string,
  rawInput: ProjectBriefingQuestionInput,
  locale: SupportedLocale
): Promise<ProjectBriefingAnswer> {
  const input = projectBriefingQuestionInputSchema.parse(rawInput);
  const slide = input.deck.slides[input.slideIndex];
  if (!slide) throw new Error("That briefing slide does not exist.");
  const bundle = await loadProject(projectRoot);
  if (bundle.project.id !== input.deck.projectId) throw new Error("This briefing belongs to a different project.");
  const provider = enabledProvider(bundle);
  if (!provider || provider.kind === "offline-manual") {
    throw new Error("Choose an AI provider in Settings before asking briefing questions.");
  }
  const hydratedProvider = await hydrateProviderForUse(provider);
  const catalog = buildProjectBriefingEvidenceCatalog(bundle);
  const response = await callResearchProvider(hydratedProvider, [
    `Question: ${input.question}`,
    `Current slide: ${JSON.stringify(slide)}`,
    `Briefing outline: ${JSON.stringify(input.deck.slides.map((item) => ({ title: item.title, body: item.body, evidence: item.evidence })))}`,
    `Recent briefing Q&A: ${JSON.stringify(input.history.slice(-6))}`
  ].join("\n\n"), {
    projectRoot,
    webSearchEnabled: false,
    scopeContext: catalog.context,
    systemInstructionsOverride: answerInstructions(locale),
    messages: [],
    mcpTools: briefingTools(bundle),
    mcpServers: [],
    callMcpTool: createToolCaller(projectRoot, bundle, catalog.references),
    cacheSessionId: `briefing:${input.deck.id}:${locale}`,
    validateFinalAnswer: (text) => {
      try {
        const parsed = projectBriefingAnswerSchema.safeParse(parseObject(text));
        if (!parsed.success) return `Your answer JSON is invalid: ${parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
        return validateProjectBriefingEvidence(parsed.data, catalog.references);
      } catch (error) {
        return `Return valid answer JSON only. ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  });
  return projectBriefingAnswerSchema.parse(parseObject(response));
}
