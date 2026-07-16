import { describe, expect, it } from "vitest";
import { importedProjectMetadata } from "../src/main/importer/projectMetadata";
import { flowSchema } from "../src/shared/schema";

describe("imported project metadata", () => {
  it("replaces onboarding fixture assumptions with evidence-backed project details", () => {
    const flow = flowSchema.parse({
      id: "flow-main",
      name: "Evidence",
      description: "Evidence flow.",
      nodes: [{
        id: "node-project",
        type: "project",
        title: "Avoid",
        description: "A Flutter product for tracking commitments and recovery progress.",
        stage: "draft-approved-production",
        visual: { shape: "hexagon" },
        position: { x: 0, y: 0 },
        techStack: ["Dart", "Flutter", "Electron", "React", "Source files"],
        acceptanceCriteria: [],
        acceptanceChecks: [],
        customProperties: {},
        attachments: [],
        todos: []
      }, {
        id: "node-app",
        type: "system",
        title: "Flutter Application",
        description: "The imported application code.",
        stage: "draft-approved-production",
        visual: { shape: "rounded" },
        position: { x: 200, y: 0 },
        techStack: ["Dart", "Flutter"],
        acceptanceCriteria: [],
        acceptanceChecks: [],
        subjectRef: { id: "code:flutter-app", kind: "code", evidenceStatus: "observed" },
        customProperties: {},
        attachments: [],
        todos: []
      }],
      edges: [],
      subflows: [],
      groups: []
    });
    const metadata = importedProjectMetadata("/tmp/avoid_todo", flow);
    expect(metadata.name).toBe("Avoid");
    expect(metadata.description).toContain("tracking commitments");
    expect(metadata.stackAssumptions).toEqual(["Dart", "Flutter"]);
    expect(metadata.stackAssumptions).not.toEqual(expect.arrayContaining(["Electron", "React"]));
    expect(metadata.environmentNotes).toContain("Imported existing codebase");
  });
});
