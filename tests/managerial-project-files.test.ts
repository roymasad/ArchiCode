import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureManagerialProjectFiles,
  generatedTargetProjectAgentInstructions,
  isUntouchedLegacyGeneratedAgentInstructions
} from "../src/main/storage/commandInference";
import { createProject, ensureFixtureProject } from "../src/main/storage/projectStore";
import { createProjectFromTemplate } from "../src/shared/templates";

const legacyGeneratedInstructions = [
  "# Agent Instructions",
  "",
  "- Keep implementation aligned with the ArchiCode graph, selected node, and acceptance criteria.",
  "- Prefer the existing stack, file layout, and component patterns before adding new tools.",
  "- Treat ArchiCode as stack-neutral: derive languages, frameworks, package/build tools, commands, and generated files from this project and its graph; never default to a familiar stack.",
  "- Add or update meaningful tests for changed behavior; do not add placeholder tests that only prove the harness ran.",
  "- Before handoff, run finite verification commands when available: `npm run build`. Record any blocker.",
  "- Do not start app/runtime/dev/serve/preview/watch commands during ArchiCode verification; runtime launch belongs to Run App targets.",
  "- Do not add backend services, authentication, databases, or new deployment targets unless the graph asks for them.",
  ""
].join("\n");

describe("managed target-project instruction files", () => {
  it("generates instructions for the target project and its recorded technology", () => {
    const template = createProjectFromTemplate("/tmp/managed-website", "website");
    const instructions = generatedTargetProjectAgentInstructions({
      project: template.project,
      flows: [template.flow]
    }, ["npm run build"]);

    expect(instructions).toContain("# Project Agent Instructions");
    expect(instructions).toContain("the target project");
    expect(instructions).not.toContain("They are not instructions for developing the ArchiCode application itself.");
    expect(instructions).toContain("Recorded technology choices for this project: Vue 3, Vite");
    expect(instructions).toContain("this target project's graph");
    expect(instructions).not.toContain("Treat ArchiCode as stack-neutral");
    expect(instructions).not.toContain("never default to a familiar stack");
  });

  it("recognizes only the untouched legacy-generated template", () => {
    expect(isUntouchedLegacyGeneratedAgentInstructions(legacyGeneratedInstructions)).toBe(true);
    expect(isUntouchedLegacyGeneratedAgentInstructions(`${legacyGeneratedInstructions}- Custom project rule.\n`)).toBe(false);
    expect(isUntouchedLegacyGeneratedAgentInstructions("# Custom Instructions\n\n- Use Vue.\n")).toBe(false);
  });

  it("creates the corrected file, migrates the exact legacy file, and preserves custom instructions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-target-agent-instructions-"));
    const bundle = await createProject(root, "website");

    await ensureManagerialProjectFiles(root, bundle);
    const created = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(created).toContain("target project");
    expect(created).toContain("Vue 3, Vite");
    expect(created).not.toContain("Treat ArchiCode as stack-neutral");

    await writeFile(path.join(root, "AGENTS.md"), legacyGeneratedInstructions, "utf8");
    await ensureFixtureProject(root);
    const migrated = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(migrated).toContain("# Project Agent Instructions");
    expect(migrated).not.toContain("They are not instructions for developing the ArchiCode application itself.");
    expect(migrated).not.toContain("Treat ArchiCode as stack-neutral");

    const previousGenerated = generatedTargetProjectAgentInstructions(bundle, ["npm run build"]).replace(
      "the target project represented by this repository and its ArchiCode graph.",
      "the target project represented by this repository and its ArchiCode graph. They are not instructions for developing the ArchiCode application itself."
    );
    await writeFile(path.join(root, "AGENTS.md"), `${previousGenerated}\n`, "utf8");
    await ensureFixtureProject(root);
    const refreshed = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(refreshed).not.toContain("They are not instructions for developing the ArchiCode application itself.");

    const custom = "# Project Team Rules\n\n- Preserve the team's custom deployment workflow.\n";
    await writeFile(path.join(root, "AGENTS.md"), custom, "utf8");
    await ensureFixtureProject(root);
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).resolves.toBe(custom);
  });
});
