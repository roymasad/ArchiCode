import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { createSeedProject } from "../src/shared/fixtures";
import { projectBundleSchema } from "../src/shared/schema";
import {
  projectBriefingSchema,
  projectBriefingVoiceCommands,
  type ProjectBriefing
} from "../src/shared/projectBriefing";
import {
  buildProjectBriefingEvidenceCatalog,
  listProjectBriefings,
  projectBriefingLanguageInstruction,
  saveProjectBriefing,
  validateProjectBriefingEvidence
} from "../src/main/projectBriefing";
import { briefingExportHtml, exportProjectBriefing } from "../src/main/projectBriefingExport";

function bundle() {
  const seed = createSeedProject("/tmp/briefing-project");
  return projectBundleSchema.parse({
    rootPath: "/tmp/briefing-project",
    project: seed.project,
    flows: [seed.flow],
    notes: [],
    incidents: [],
    runs: [],
    artifacts: [],
    summaries: [],
    graphChanges: [],
    validationErrors: []
  });
}

function briefing(reference: string): ProjectBriefing {
  return projectBriefingSchema.parse({
    id: "briefing-1",
    projectId: "project-archicode",
    preset: "quick",
    title: "ArchiCode in five cards",
    subtitle: "A compact tour",
    generatedAt: "2026-07-24T10:00:00.000Z",
    voice: projectBriefingVoiceCommands,
    slides: Array.from({ length: 5 }, (_, index) => ({
      id: `slide-${index + 1}`,
      kicker: `Part ${index + 1}`,
      title: `Card ${index + 1}`,
      body: "One concise grounded fact.",
      narration: "Here is the same fact phrased naturally for future spoken playback.",
      visual: {
        kind: index % 2 ? "sequence" : "spotlight",
        items: [
          { id: "start", label: "Start", kind: "concept", tone: "cyan" },
          { id: "result", label: "Result", kind: "system", tone: "violet" }
        ],
        connections: [{ from: "start", to: "result", label: "leads to" }]
      },
      evidence: [{ reference, label: "Project evidence", excerpt: "A specific supporting fact." }],
      suggestedQuestions: ["Why does this matter?"]
    }))
  });
}

describe("project briefing", () => {
  it("builds stable evidence references for the project graph", () => {
    const projectBundle = bundle();
    const catalog = buildProjectBriefingEvidenceCatalog(projectBundle);
    const flow = projectBundle.flows[0];

    expect(catalog.references).toContain(`project:${projectBundle.project.id}`);
    expect(catalog.references).toContain(`flow:${flow.id}`);
    expect(catalog.references).toContain(`node:${flow.id}:${flow.nodes[0].id}`);
    expect(catalog.references).toContain(`edge:${flow.id}:${flow.edges[0].id}`);
    expect(catalog.context).toContain(flow.nodes[0].title);
  });

  it("accepts a voice-ready five-card deck with grounded evidence", () => {
    const projectBundle = bundle();
    const catalog = buildProjectBriefingEvidenceCatalog(projectBundle);
    const deck = briefing(`project:${projectBundle.project.id}`);

    expect(validateProjectBriefingEvidence(deck, catalog.references)).toBeUndefined();
    expect(deck.slides).toHaveLength(5);
    expect(deck.slides[0].narration).not.toBe(deck.slides[0].body);
    expect(deck.voice.commands).toContain("show-evidence");
  });

  it("directs the curator to use the selected application language", () => {
    expect(projectBriefingLanguageInstruction("fr")).toContain("French");
    expect(projectBriefingLanguageInstruction("zh-Hans")).toContain("Simplified Chinese");
    expect(projectBriefingLanguageInstruction("ja")).toContain("Japanese");
    expect(projectBriefingLanguageInstruction("ja")).toContain("exact evidence references");
  });

  it("rejects unknown evidence and malformed visual connections", () => {
    const projectBundle = bundle();
    const catalog = buildProjectBriefingEvidenceCatalog(projectBundle);
    const deck = briefing("file:invented.ts");

    expect(validateProjectBriefingEvidence(deck, catalog.references)).toContain("file:invented.ts");
    expect(() => projectBriefingSchema.parse({
      ...deck,
      slides: deck.slides.map((slide, index) => index === 0
        ? {
            ...slide,
            visual: {
              ...slide.visual,
              connections: [{ from: "missing", to: "result" }]
            }
          }
        : slide)
    })).toThrow("must reference visual item ids");
  });

  it("persists the latest generated briefing for each preset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-briefing-save-"));
    try {
      const first = briefing("project:project-archicode");
      const replacement = projectBriefingSchema.parse({
        ...first,
        id: "briefing-2",
        locale: "fr",
        generatedAt: "2026-07-24T11:00:00.000Z"
      });
      await saveProjectBriefing(root, first);
      await saveProjectBriefing(root, replacement);

      const saved = await listProjectBriefings(root);
      expect(saved).toHaveLength(1);
      expect(saved[0].id).toBe("briefing-2");
      expect(saved[0].locale).toBe("fr");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports a real editable PowerPoint package with slides and source notes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-briefing-pptx-"));
    const target = path.join(root, "briefing.pptx");
    try {
      const deck = briefing("project:project-archicode");
      await exportProjectBriefing(deck, "pptx", target);
      const archive = await JSZip.loadAsync(await readFile(target));

      expect(Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(5);
      expect(Object.keys(archive.files).some((name) => name.startsWith("ppt/notesSlides/notesSlide"))).toBe(true);
      expect(await archive.file("ppt/slides/slide1.xml")?.async("text")).toContain("Card 1");

      const contentTypes = await archive.file("[Content_Types].xml")?.async("text");
      expect(contentTypes).toBeDefined();
      const declaredParts = Array.from(
        contentTypes!.matchAll(/<Override\b[^>]*\bPartName="\/([^"]+)"/g),
        (match) => match[1]
      );
      expect(declaredParts).toContain("ppt/slideMasters/slideMaster1.xml");
      expect(declaredParts).not.toContain("ppt/slideMasters/slideMaster2.xml");
      expect(declaredParts.filter((part) => !archive.file(part))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds one printable PDF page per briefing card with visible evidence", () => {
    const html = briefingExportHtml(briefing("project:project-archicode"));

    expect(html.match(/<section class="slide">/g)).toHaveLength(5);
    expect(html).toContain("@page { size: 13.333in 7.5in");
    expect(html).toContain("A specific supporting fact.");
    expect(html).toContain("project:project-archicode");
  });
});
