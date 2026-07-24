import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { defaultGraphPreviewRefs, parseGitStatusPorcelain } from "../src/shared/projectTools";
import { getGitStatus, gitCreateBranch, gitDiscardChanges, gitInit, gitPopStash, gitRepositoryFolderName, gitStashChanges, gitSwitchBranch, listProjectFiles, readProjectFile } from "../src/main/projectTools";

const execFileAsync = promisify(execFile);

describe("project tools", () => {
  it("defaults graph previews to a feature candidate against main", () => {
    expect(defaultGraphPreviewRefs(["main", "feature/testdiff1"], "main")).toEqual({
      candidateRef: "feature/testdiff1",
      baseRef: "main"
    });
    expect(defaultGraphPreviewRefs(["main", "feature/testdiff1"], "feature/testdiff1")).toEqual({
      candidateRef: "feature/testdiff1",
      baseRef: "main"
    });
    expect(defaultGraphPreviewRefs(["master", "topic"], "master")).toEqual({
      candidateRef: "topic",
      baseRef: "master"
    });
  });

  it("derives safe destination folder names from supported Git URLs", () => {
    expect(gitRepositoryFolderName("https://github.com/openai/codex.git")).toBe("codex");
    expect(gitRepositoryFolderName("git@github.com:openai/codex.git")).toBe("codex");
    expect(gitRepositoryFolderName("ssh://git@example.com/team/my repo.git")).toBe("my-repo");
    expect(() => gitRepositoryFolderName("file:///tmp/local-repository")).toThrow("Unsupported Git URL protocol");
    expect(() => gitRepositoryFolderName("not a git url")).toThrow("Enter a valid Git URL");
  });
  it("parses porcelain Git status with branch metadata", () => {
    const status = parseGitStatusPorcelain([
      "## main...origin/main [ahead 1, behind 2]",
      " M src/app.ts",
      "A  src/new.ts",
      "?? notes.md"
    ].join("\n"), ["main", "feature"]);

    expect(status.isRepo).toBe(true);
    expect(status.currentBranch).toBe("main");
    expect(status.upstream).toBe("origin/main");
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(2);
    expect(status.branches).toEqual(["main", "feature"]);
    expect(status.changes.map((change) => change.path)).toEqual(["src/app.ts", "src/new.ts", "notes.md"]);
  });

  it("does not initialize Git when a project has no repository", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-no-git-"));
    await writeFile(path.join(projectRoot, "README.md"), "# No Git\n");

    const status = await getGitStatus(projectRoot);

    expect(status.isRepo).toBe(false);
    expect(status.message).toContain("No Git repository found");
  });

  it("initializes a local Git repository without adding remotes", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-git-init-"));
    await writeFile(path.join(projectRoot, "README.md"), "# Local Git\n");

    const result = await gitInit(projectRoot);
    const status = await getGitStatus(projectRoot);
    const remotes = await execFileAsync("git", ["-C", projectRoot, "remote", "-v"]);

    expect(result.ok).toBe(true);
    expect(status.isRepo).toBe(true);
    expect(remotes.stdout.trim()).toBe("");
  });

  it("reports recent Git commit messages", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-git-history-"));
    await execFileAsync("git", ["-C", projectRoot, "init"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.name", "ArchiCode Test"]);
    await writeFile(path.join(projectRoot, "README.md"), "# History\n");
    await execFileAsync("git", ["-C", projectRoot, "add", "README.md"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "Add project readme"]);

    const status = await getGitStatus(projectRoot);

    expect(status.isRepo).toBe(true);
    expect(status.recentCommits[0]?.subject).toBe("Add project readme");
    expect(status.recentCommits[0]?.authorName).toBe("ArchiCode Test");
  });

  it("reports added and removed line counts for changed files", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-git-numstat-"));
    await execFileAsync("git", ["-C", projectRoot, "init"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.name", "ArchiCode Test"]);
    await writeFile(path.join(projectRoot, "app.ts"), "one\ntwo\nthree\n");
    await execFileAsync("git", ["-C", projectRoot, "add", "app.ts"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "Add app"]);
    await writeFile(path.join(projectRoot, "app.ts"), "one\ntwo changed\nfour\nfive\n");

    const status = await getGitStatus(projectRoot);
    const change = status.changes.find((item) => item.path === "app.ts");

    expect(change?.additions).toBe(3);
    expect(change?.deletions).toBe(2);
  });

  it("creates and switches to a new local Git branch", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-git-create-branch-"));
    await execFileAsync("git", ["-C", projectRoot, "init"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.name", "ArchiCode Test"]);
    await writeFile(path.join(projectRoot, "README.md"), "# Branches\n");
    await execFileAsync("git", ["-C", projectRoot, "add", "README.md"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "Add readme"]);

    const result = await gitCreateBranch(projectRoot, "feature/activity-branch-selector");
    const status = await getGitStatus(projectRoot);

    expect(result.ok).toBe(true);
    expect(status.currentBranch).toBe("feature/activity-branch-selector");
    expect(status.branches).toContain("feature/activity-branch-selector");
  });

  it("blocks branch switching while shared ArchiCode graph state is dirty", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-git-dirty-graph-"));
    await execFileAsync("git", ["-C", projectRoot, "init"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.name", "ArchiCode Test"]);
    await mkdir(path.join(projectRoot, ".archicode", "flows"), { recursive: true });
    await writeFile(path.join(projectRoot, ".archicode", "project.json"), JSON.stringify({ id: "project-test" }));
    await writeFile(path.join(projectRoot, ".archicode", "flows", "flow-main.json"), JSON.stringify({ id: "flow-main", nodes: [] }));
    await execFileAsync("git", ["-C", projectRoot, "add", ".archicode"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "Add graph"]);
    const initialBranch = (await getGitStatus(projectRoot)).currentBranch!;
    await execFileAsync("git", ["-C", projectRoot, "switch", "-c", "feature/graph"]);
    await writeFile(path.join(projectRoot, ".archicode", "flows", "flow-main.json"), JSON.stringify({ id: "flow-main", nodes: [{ id: "node-test" }] }));

    const result = await gitSwitchBranch(projectRoot, initialBranch);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("project graph changes are uncommitted");
    expect(result.stderr).toContain(".archicode/flows/flow-main.json");
    expect((await getGitStatus(projectRoot)).currentBranch).toBe("feature/graph");
  });

  it("stashes and pops local changes", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-git-stash-"));
    await execFileAsync("git", ["-C", projectRoot, "init"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.name", "ArchiCode Test"]);
    await mkdir(path.join(projectRoot, ".archicode", "flows"), { recursive: true });
    await writeFile(path.join(projectRoot, ".archicode", "flows", "flow-main.json"), JSON.stringify({ id: "flow-main", nodes: [] }));
    await execFileAsync("git", ["-C", projectRoot, "add", ".archicode"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "Add graph"]);
    await writeFile(path.join(projectRoot, ".archicode", "flows", "flow-main.json"), JSON.stringify({ id: "flow-main", nodes: [{ id: "node-test" }] }));

    const stashResult = await gitStashChanges(projectRoot, "Graph draft");
    const stashedStatus = await getGitStatus(projectRoot);

    expect(stashResult.ok).toBe(true);
    expect(stashedStatus.changes).toEqual([]);
    expect(stashedStatus.stashes[0]?.message).toContain("Graph draft");

    const popResult = await gitPopStash(projectRoot, stashedStatus.stashes[0]!.ref);
    const poppedStatus = await getGitStatus(projectRoot);

    expect(popResult.ok).toBe(true);
    expect(poppedStatus.changes.map((change) => change.path)).toContain(".archicode/flows/flow-main.json");
  });

  it("discards tracked changes and untracked files while preserving ignored files", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-git-discard-"));
    await execFileAsync("git", ["-C", projectRoot, "init"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.name", "ArchiCode Test"]);
    await writeFile(path.join(projectRoot, ".gitignore"), "ignored.log\nignored-dir/\n");
    await writeFile(path.join(projectRoot, "tracked.txt"), "baseline\n");
    await execFileAsync("git", ["-C", projectRoot, "add", ".gitignore", "tracked.txt"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "Add baseline"]);
    await writeFile(path.join(projectRoot, "tracked.txt"), "staged change\n");
    await writeFile(path.join(projectRoot, "staged-new.txt"), "staged new\n");
    await execFileAsync("git", ["-C", projectRoot, "add", "tracked.txt", "staged-new.txt"]);
    await writeFile(path.join(projectRoot, "tracked.txt"), "unstaged change\n");
    await writeFile(path.join(projectRoot, "untracked.txt"), "untracked\n");
    await mkdir(path.join(projectRoot, "untracked-dir"));
    await writeFile(path.join(projectRoot, "untracked-dir", "file.txt"), "untracked dir\n");
    await writeFile(path.join(projectRoot, "ignored.log"), "ignored\n");
    await mkdir(path.join(projectRoot, "ignored-dir"));
    await writeFile(path.join(projectRoot, "ignored-dir", "file.txt"), "ignored dir\n");

    const result = await gitDiscardChanges(projectRoot);
    const status = await getGitStatus(projectRoot);

    expect(result.ok).toBe(true);
    expect(await readFile(path.join(projectRoot, "tracked.txt"), "utf8")).toBe("baseline\n");
    await expect(access(path.join(projectRoot, "staged-new.txt"))).rejects.toThrow();
    await expect(access(path.join(projectRoot, "untracked.txt"))).rejects.toThrow();
    await expect(access(path.join(projectRoot, "untracked-dir"))).rejects.toThrow();
    await expect(readFile(path.join(projectRoot, "ignored.log"), "utf8")).resolves.toBe("ignored\n");
    await expect(readFile(path.join(projectRoot, "ignored-dir", "file.txt"), "utf8")).resolves.toBe("ignored dir\n");
    expect(status.changes).toEqual([]);
  });

  it("does not discard files before the first Git commit", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-git-discard-unborn-"));
    await execFileAsync("git", ["-C", projectRoot, "init"]);
    await writeFile(path.join(projectRoot, "README.md"), "# Draft\n");

    const result = await gitDiscardChanges(projectRoot);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("before the first commit");
    await expect(readFile(path.join(projectRoot, "README.md"), "utf8")).resolves.toBe("# Draft\n");
  });

  it("lists project files while hiding noisy generated directories", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-files-"));
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await mkdir(path.join(projectRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(projectRoot, "src", "app.ts"), "export const app = true;\n");
    await writeFile(path.join(projectRoot, "node_modules", "pkg", "index.js"), "module.exports = {};\n");

    const data = await listProjectFiles(projectRoot);
    const childNames = data.tree.children?.map((child) => child.name) ?? [];

    expect(childNames).toContain("src");
    expect(childNames).not.toContain("node_modules");
  });

  it("guards file previews against paths outside the project", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-guard-"));
    await writeFile(path.join(projectRoot, "safe.txt"), "safe\n");

    await expect(readProjectFile(projectRoot, "../outside.txt")).rejects.toThrow("outside the project");
  });
});
