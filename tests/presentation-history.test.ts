import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPresentationPatch, ensureProject, updateNode } from "../src/main/storage/projectStore";

describe("guarded presentation history persistence", () => {
  it("reverses presentation fields without overwriting a later semantic edit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-presentation-history-"));
    const initial = await ensureProject(root);
    const flow = initial.flows[0]!;
    const node = flow.nodes[0]!;
    const moved = { x: node.position.x + 240, y: node.position.y + 120 };

    const forward = await applyPresentationPatch(root, {
      flowId: flow.id,
      mutations: [{ nodeId: node.id, field: "position", expected: node.position, value: moved }]
    });
    expect(forward.status).toBe("applied");

    const renamed = `${node.title} renamed later`;
    await updateNode(root, flow.id, { id: node.id, title: renamed }, "user");
    const undone = await applyPresentationPatch(root, {
      flowId: flow.id,
      mutations: [{ nodeId: node.id, field: "position", expected: moved, value: node.position }]
    });

    expect(undone.status).toBe("applied");
    const current = undone.bundle.flows.find((item) => item.id === flow.id)!.nodes.find((item) => item.id === node.id)!;
    expect(current.position).toEqual(node.position);
    expect(current.title).toBe(renamed);
  });

  it("rejects a stale inverse without partially applying its batch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-presentation-conflict-"));
    const initial = await ensureProject(root);
    const flow = initial.flows[0]!;
    const [first, second] = flow.nodes;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const firstMoved = { x: first!.position.x + 100, y: first!.position.y };
    const secondMoved = { x: second!.position.x + 100, y: second!.position.y };
    const newerFirstPosition = { x: firstMoved.x + 50, y: firstMoved.y + 50 };

    await applyPresentationPatch(root, {
      flowId: flow.id,
      mutations: [
        { nodeId: first!.id, field: "position", expected: first!.position, value: firstMoved },
        { nodeId: second!.id, field: "position", expected: second!.position, value: secondMoved }
      ]
    });
    await applyPresentationPatch(root, {
      flowId: flow.id,
      mutations: [{ nodeId: first!.id, field: "position", expected: firstMoved, value: newerFirstPosition }]
    });

    const staleUndo = await applyPresentationPatch(root, {
      flowId: flow.id,
      mutations: [
        { nodeId: first!.id, field: "position", expected: firstMoved, value: first!.position },
        { nodeId: second!.id, field: "position", expected: secondMoved, value: second!.position }
      ]
    });

    expect(staleUndo.status).toBe("conflict");
    const currentFlow = staleUndo.bundle.flows.find((item) => item.id === flow.id)!;
    expect(currentFlow.nodes.find((item) => item.id === first!.id)!.position).toEqual(newerFirstPosition);
    expect(currentFlow.nodes.find((item) => item.id === second!.id)!.position).toEqual(secondMoved);
  });

  it("supports nullable node size while rejecting semantic fields at validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-presentation-size-"));
    const initial = await ensureProject(root);
    const flow = initial.flows[0]!;
    const node = flow.nodes[0]!;
    const size = { width: 420, height: 260 };

    const resized = await applyPresentationPatch(root, {
      flowId: flow.id,
      mutations: [{ nodeId: node.id, field: "size", expected: null, value: size }]
    });
    expect(resized.status).toBe("applied");
    const reset = await applyPresentationPatch(root, {
      flowId: flow.id,
      mutations: [{ nodeId: node.id, field: "size", expected: size, value: null }]
    });
    expect(reset.status).toBe("applied");
    expect(reset.bundle.flows[0]!.nodes.find((item) => item.id === node.id)!.size).toBeUndefined();

    await expect(applyPresentationPatch(root, {
      flowId: flow.id,
      mutations: [{ nodeId: node.id, field: "title", expected: node.title, value: "Unsafe" }]
    } as never)).rejects.toThrow();
  });
});
