import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureProject, loadProject } from "../src/main/storage/projectStore";

describe("production project initialization", () => {
  it("creates an empty map instead of persisting the internal QA harness", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-project-init-"));
    const initialized = await ensureProject(root);
    const reloaded = await loadProject(root);

    expect(initialized.project.name).toBe(path.basename(root));
    expect(initialized.flows[0]?.name).toBe("Codebase Map");
    expect(initialized.flows[0]?.nodes).toEqual([]);
    expect(reloaded.flows[0]?.name).toBe("Codebase Map");
    expect(reloaded.flows[0]?.nodes).toEqual([]);
    expect(JSON.stringify(reloaded)).not.toContain("ArchiCode MVP Harness");
    expect(JSON.stringify(reloaded)).not.toContain("LLM-Clarifying JSON Model");
  });
});
