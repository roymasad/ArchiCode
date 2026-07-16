import { describe, expect, it } from "vitest";
import { projectBundleSchema } from "../src/shared/schema";
import { createSeedProject } from "../src/shared/fixtures";
import { createProjectExportHtml } from "../src/main/storage/projectDocumentExport";

describe("project document export", () => {
  it("creates a standalone HTML architecture document for only the selected flows", () => {
    const seed = createSeedProject("/tmp/project");
    const secondFlow = {
      ...seed.flow,
      id: "flow-secondary",
      name: "Secondary flow",
      nodes: seed.flow.nodes.map((node) => ({ ...node, id: `secondary-${node.id}` })),
      edges: []
    };
    const bundle = projectBundleSchema.parse({
      rootPath: "/tmp/project",
      project: { ...seed.project, name: "Project <One>" },
      flows: [seed.flow, secondFlow],
      notes: [],
      incidents: [],
      runs: [],
      artifacts: [],
      summaries: [],
      graphChanges: [],
      validationErrors: []
    });

    const html = createProjectExportHtml(bundle, [seed.flow.id]);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Project &lt;One&gt;");
    expect(html).toContain(seed.flow.name);
    expect(html).not.toContain("Secondary flow");
    expect(html).toContain("<svg");
    expect(html).toContain("Node index");
    expect(html).toContain(`${seed.flow.nodes.length} nodes`);
  });

  it("requires at least one valid flow", () => {
    const seed = createSeedProject("/tmp/project");
    const bundle = projectBundleSchema.parse({
      rootPath: "/tmp/project",
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

    expect(() => createProjectExportHtml(bundle, [])).toThrow("Choose at least one flow");
  });
});
