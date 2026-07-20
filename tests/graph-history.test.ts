import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { getGraphNodeHistory, listGraphHistory, listHistoricalProjectFiles, loadHistoricalGraphBundle, readHistoricalProjectFile } from "../src/main/graphHistory";
import { ensureFixtureProject, saveFlow } from "../src/main/storage/projectStore";

const execFileAsync = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

describe("Git-backed graph history", () => {
  it("groups source-only commits and loads every flow from a historical commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-graph-history-"));
    const initial = await ensureFixtureProject(root);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "example.ts"), "export const version = 1;\n", "utf8");
    await git(root, "init");
    await git(root, "config", "user.email", "history-test@example.com");
    await git(root, "config", "user.name", "History Test");
    await git(root, "add", ".archicode/project.json", ".archicode/flows", ".archicode/notes.jsonl", ".gitignore", ".gitattributes", "src/example.ts");
    await git(root, "commit", "-m", "Initial graph");
    const initialCommit = await git(root, "rev-parse", "HEAD");

    await writeFile(path.join(root, "README.md"), "source only\n", "utf8");
    await writeFile(path.join(root, "src", "example.ts"), "export const version = 2;\n", "utf8");
    await git(root, "add", "README.md", "src/example.ts");
    await git(root, "commit", "-m", "Change source only");

    await git(root, "config", "user.email", "graph-editor@example.com");
    await git(root, "config", "user.name", "Graph Editor");
    await saveFlow(root, {
      ...initial.flows[0]!,
      description: "Graph evolved",
      nodes: initial.flows[0]!.nodes.map((node, index) => index === 0 ? { ...node, title: `${node.title} evolved` } : node)
    });
    await git(root, "add", ".archicode/project.json", ".archicode/flows");
    await git(root, "commit", "-m", "Evolve graph");

    const page = await listGraphHistory(root);
    const history = page.versions;
    expect(history).toHaveLength(2);
    expect(page.newestVersionNumber).toBe(2);
    expect(history.map((version) => version.versionNumber)).toEqual([2, 1]);
    expect(history[1]?.commits).toHaveLength(2);
    expect(history[0]?.graphVersion).not.toBe(history[1]?.graphVersion);

    const historical = await loadHistoricalGraphBundle(root, initialCommit);
    expect(historical.bundle.flows).toHaveLength(initial.flows.length);
    expect(historical.bundle.flows[0]?.description).toBe(initial.flows[0]?.description);
    expect(historical.entry.graphVersion).toBe(history[1]?.graphVersion);
    expect(historical.nodeChanges).toEqual(initial.flows.flatMap((flow) =>
      flow.nodes.map((node) => ({ flowId: flow.id, nodeId: node.id, kind: "introduced" }))
    ));

    const evolved = await loadHistoricalGraphBundle(root, "HEAD");
    expect(evolved.nodeChanges).toEqual([{
      flowId: initial.flows[0]!.id,
      nodeId: initial.flows[0]!.nodes[0]!.id,
      kind: "modified"
    }]);

    const historicalSource = await readHistoricalProjectFile(root, initialCommit, "src/example.ts");
    expect(historicalSource.content).toContain("version = 1");
    expect(historicalSource.content).not.toContain("version = 2");
    const historicalFiles = await listHistoricalProjectFiles(root, initialCommit);
    expect(JSON.stringify(historicalFiles.tree)).toContain("src/example.ts");
    expect(JSON.stringify(historicalFiles.tree)).not.toContain("README.md");

    const nodeId = initial.flows[0]!.nodes[0]!.id;
    const initialNodeHistory = await getGraphNodeHistory(root, initialCommit, initial.flows[0]!.id, nodeId);
    expect(initialNodeHistory.changes.map((change) => change.kind)).toEqual(["introduced"]);
    expect(initialNodeHistory.introduced?.author).toEqual({ name: "History Test", email: "history-test@example.com" });

    const currentNodeHistory = await getGraphNodeHistory(root, "HEAD", initial.flows[0]!.id, nodeId);
    expect(currentNodeHistory.changes.map((change) => change.kind)).toEqual(["introduced", "modified"]);
    expect(currentNodeHistory.lastSemanticChange?.author).toEqual({ name: "Graph Editor", email: "graph-editor@example.com" });
    expect(currentNodeHistory.lastSemanticChange?.changedFields).toContain("title");
  });

  it("loads first-parent history in bounded commit pages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-graph-history-pages-"));
    await ensureFixtureProject(root);
    await git(root, "init");
    await git(root, "config", "user.email", "history-test@example.com");
    await git(root, "config", "user.name", "History Test");
    await git(root, "add", ".archicode", ".gitignore", ".gitattributes");
    await git(root, "commit", "-m", "Initial graph");
    for (let index = 1; index <= 25; index += 1) {
      await writeFile(path.join(root, "source.txt"), `source ${index}\n`, "utf8");
      await git(root, "add", "source.txt");
      await git(root, "commit", "-m", `Source change ${index}`);
    }

    const first = await listGraphHistory(root, { limit: 20 });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(first.versions).toHaveLength(1);
    expect(first.versions[0]?.commits).toHaveLength(20);
    expect(first.versions[0]?.versionNumber).toBe(1);

    const second = await listGraphHistory(root, { cursor: first.nextCursor, limit: 20 });
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(second.newestVersionNumber).toBeNull();
    expect(second.versions).toHaveLength(1);
    expect(second.versions[0]?.commits).toHaveLength(6);
  });
});
