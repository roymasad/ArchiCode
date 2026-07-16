import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listAgentInstructionFiles, readAgentInstructionFile, writeAgentInstructionFile } from "../src/main/storage/agentFiles";
import { ensureProject, updateProjectDetails } from "../src/main/storage/projectStore";

describe("project details", () => {
  it("updates the project name without changing settings", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-project-details-"));
    const initial = await ensureProject(projectRoot);

    const updated = await updateProjectDetails(projectRoot, { name: "Customer Portal" });

    expect(updated.project.name).toBe("Customer Portal");
    expect(updated.project.settings).toEqual(initial.project.settings);
  });

  it("rejects an empty project name", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-project-details-empty-"));
    await ensureProject(projectRoot);

    await expect(updateProjectDetails(projectRoot, { name: "   " })).rejects.toThrow("Project name cannot be empty");
  });

  it("lists, prefers, and writes common agent instruction files", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-agent-instructions-"));
    await writeFile(path.join(projectRoot, "CLAUDE.md"), "# Claude Notes\n", "utf8");

    const summaries = await listAgentInstructionFiles(projectRoot);
    expect(summaries.find((file) => file.path === "CLAUDE.md")).toMatchObject({ exists: true, preferred: true });

    const preferred = await readAgentInstructionFile(projectRoot);
    expect(preferred.path).toBe("CLAUDE.md");
    expect(preferred.text).toContain("Claude Notes");

    await ensureProject(projectRoot);
    const written = await writeAgentInstructionFile(projectRoot, ".github/copilot-instructions.md", "# Copilot Notes");
    expect(written).toMatchObject({ path: ".github/copilot-instructions.md", exists: true });
    await expect(readFile(path.join(projectRoot, ".github", "copilot-instructions.md"), "utf8")).resolves.toBe("# Copilot Notes\n");
    await expect(writeAgentInstructionFile(projectRoot, "../CLAUDE.md", "nope")).rejects.toThrow("Agent instruction files are limited");
  });
});
