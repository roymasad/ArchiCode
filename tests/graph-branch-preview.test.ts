import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import flowFixture from "../fixtures/sample-project/.archicode/flows/flow-main.json";
import { previewGraphBranches } from "../src/main/graphBranchPreview";
import { buildGraphBranchPreviewDiff } from "../src/shared/graphBranchPreview";
import { flowSchema, type Flow } from "../src/shared/schema";

const execFileAsync = promisify(execFile);

function fixtureFlow(): Flow {
  return flowSchema.parse(structuredClone(flowFixture));
}

describe("graph branch preview", () => {
  it("builds an ordered structural diff while ignoring timestamps", () => {
    const before = fixtureFlow();
    const firstNode = before.nodes[0];
    const removedNode = before.nodes.at(-1)!;
    const after = flowSchema.parse({
      ...before,
      updatedAt: "later",
      nodes: [
        {
          ...firstNode,
          title: `${firstNode.title} updated`,
          updatedAt: "later"
        },
        ...before.nodes.slice(1, -1),
        {
          ...removedNode,
          id: "node-preview-added",
          title: "Preview added",
          position: { x: removedNode.position.x + 300, y: removedNode.position.y }
        }
      ],
      edges: [
        ...before.edges.filter((edge) => edge.source !== removedNode.id && edge.target !== removedNode.id),
        {
          id: "edge-preview-added",
          source: firstNode.id,
          target: before.nodes[1].id,
          label: "previews",
          lineStyle: "dashed",
          animated: true
        }
      ]
    });

    const preview = buildGraphBranchPreviewDiff([before], [after]);

    expect(preview.changes.some((change) =>
      change.entityKind === "node" &&
      change.entityId === firstNode.id &&
      change.changeKind === "modified" &&
      change.fields.map((field) => field.field).includes("title")
    )).toBe(true);
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityKind: "node", entityId: removedNode.id, changeKind: "removed" }),
      expect.objectContaining({ entityKind: "node", entityId: "node-preview-added", changeKind: "added" })
    ]));
    expect(preview.changes.some((change) => change.entityKind === "flow" && change.fields.some((field) => field.field === "updatedAt"))).toBe(false);
    expect(preview.flows[0]?.flow.nodes.some((node) => node.id === removedNode.id)).toBe(true);
    expect(preview.flows[0]?.nodeStates[removedNode.id]).toBe("removed");
    expect(preview.flows[0]?.nodeStates["node-preview-added"]).toBe("added");
    const addedNode = preview.changes.find((change) => change.entityId === "node-preview-added");
    expect(addedNode?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "type", after: removedNode.type }),
      expect.objectContaining({ field: "description", after: removedNode.description })
    ]));
    expect(addedNode?.fields.some((field) => field.field === "position")).toBe(false);
    const addedEdge = preview.changes.find((change) => change.entityId === "edge-preview-added");
    expect(addedEdge?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "source", after: `${firstNode.title} updated` }),
      expect.objectContaining({ field: "target", after: before.nodes[1].title }),
      expect.objectContaining({ field: "lineStyle", after: "dashed" }),
      expect.objectContaining({ field: "animated", after: "Yes" })
    ]));
  });

  it("marks position-only changes as layout-only", () => {
    const before = fixtureFlow();
    const changedNode = before.nodes[0];
    const after = flowSchema.parse({
      ...before,
      nodes: before.nodes.map((node) => node.id === changedNode.id
        ? { ...node, position: { x: node.position.x + 80, y: node.position.y + 40 } }
        : node)
    });

    const preview = buildGraphBranchPreviewDiff([before], [after]);
    const change = preview.changes.find((item) => item.entityId === changedNode.id);

    expect(change).toMatchObject({
      entityKind: "node",
      changeKind: "modified",
      layoutOnly: true
    });
    expect(change?.fields.map((field) => field.field)).toEqual(["position"]);
    expect(preview.stats.layoutOnly).toBe(1);
  });

  it("reads a PR-style committed graph diff without switching branches or changing files", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-graph-preview-"));
    const flowPath = path.join(projectRoot, ".archicode", "flows", "flow-main.json");
    await mkdir(path.dirname(flowPath), { recursive: true });
    await execFileAsync("git", ["-C", projectRoot, "init", "-b", "main"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.name", "ArchiCode Test"]);
    const before = fixtureFlow();
    await writeFile(flowPath, `${JSON.stringify(before, null, 2)}\n`);
    await execFileAsync("git", ["-C", projectRoot, "add", ".archicode/flows/flow-main.json"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "Add graph"]);
    const baseCommit = (await execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"])).stdout.trim();

    await execFileAsync("git", ["-C", projectRoot, "switch", "-c", "feature/graph-preview"]);
    const changedNode = before.nodes[0];
    const after = {
      ...before,
      nodes: before.nodes.map((node) => node.id === changedNode.id ? { ...node, title: "Candidate title" } : node)
    };
    await writeFile(flowPath, `${JSON.stringify(after, null, 2)}\n`);
    await execFileAsync("git", ["-C", projectRoot, "add", ".archicode/flows/flow-main.json"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "Change graph title"]);
    const candidateCommit = (await execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", projectRoot, "switch", "main"]);
    await writeFile(path.join(projectRoot, "README.md"), "# Main moved\n");
    await execFileAsync("git", ["-C", projectRoot, "add", "README.md"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "Move main"]);

    const preview = await previewGraphBranches(projectRoot, "main", "feature/graph-preview");
    const status = await execFileAsync("git", ["-C", projectRoot, "status", "--porcelain=v1", "--branch"]);

    expect(preview.comparisonCommit).toBe(baseCommit);
    expect(preview.candidateCommit).toBe(candidateCommit);
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityKind: "node",
        entityId: changedNode.id,
        changeKind: "modified",
        title: "Candidate title"
      })
    ]));
    expect(status.stdout).toBe("## main\n");
  });
});
