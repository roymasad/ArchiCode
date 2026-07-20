import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteProjectState, ensureFixtureProject, loadProject, updateProjectSettings } from "../src/main/storage/projectStore";
import { startAgentRun } from "../src/main/storage/runEngine";
import { createResearchChat, setResearchStorageRoot } from "../src/main/research/chatStore";

function researchStorageFile(storageRoot: string, projectRoot: string): string {
  const key = createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 32);
  return path.join(storageRoot, "research-chats", `${key}.json`);
}

describe("filesystem guard", () => {
  it("deletes only ArchiCode project state and leaves source files alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delete-state-"));
    const storageRoot = await mkdtemp(path.join(tmpdir(), "archicode-delete-state-research-"));
    setResearchStorageRoot(storageRoot);
    const sourcePath = path.join(root, "package.json");
    await writeFile(sourcePath, "{\"scripts\":{}}\n", "utf8");
    await ensureFixtureProject(root);
    await createResearchChat({
      projectRoot: root,
      scope: { type: "project", projectId: "project-seed" }
    });
    const researchStorePath = researchStorageFile(storageRoot, root);

    await expect(stat(path.join(root, ".archicode"))).resolves.toBeTruthy();
    await expect(stat(researchStorePath)).resolves.toBeTruthy();
    await deleteProjectState(root);

    await expect(stat(sourcePath)).resolves.toBeTruthy();
    await expect(stat(path.join(root, ".archicode"))).rejects.toThrow();
    await expect(stat(researchStorePath)).rejects.toThrow();
  });

  it("blocks shell runs whose cwd escapes the project under project-write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-fs-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "archicode-fs-outside-"));
    await ensureFixtureProject(root);

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Outside cwd",
      command: "echo ok",
      cwd: outside,
      allowShell: true
    });
    const bundle = await loadProject(root);
    const run = bundle.runs.find((item) => item.id === runId);

    expect(run?.status).toBe("failed");
    expect(run?.permission.decision).toBe("denied");
    expect(run?.filesystemScope?.violations[0]).toMatch(/Working directory is outside/);
  });

  it("blocks obvious command path references outside the project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-fs-path-"));
    await ensureFixtureProject(root);

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Outside path",
      command: "cat /etc/hosts",
      allowShell: true
    });
    const bundle = await loadProject(root);
    const run = bundle.runs.find((item) => item.id === runId);

    expect(run?.status).toBe("failed");
    expect(run?.filesystemScope?.violations.join(" ")).toContain("/etc/hosts");
  });

  it("allows full-access policy to request permission for outside cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-fs-full-"));
    const outside = await mkdtemp(path.join(tmpdir(), "archicode-fs-full-outside-"));
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      filesystem: {
        ...bundle.project.settings.filesystem,
        policy: "full-access"
      },
      autoApproveShellCommands: false
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Outside cwd under full access",
      command: "echo ok",
      cwd: outside
    });
    const next = await loadProject(root);
    const run = next.runs.find((item) => item.id === runId);

    expect(run?.status).toBe("needs-permission");
    expect(run?.filesystemScope?.violations).toEqual([]);
  });
});
