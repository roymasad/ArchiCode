import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addNote, attachNodeReferences, deleteNote, purgeResolvedNotes, purgeSystemNotes, updateNotePinned, updateNoteResolved } from "../src/main/storage/notes";
import { ensureFixtureProject, loadProject, saveFlow, updateNode, updateProjectSettings } from "../src/main/storage/projectStore";

describe("node note workflow", () => {
  it("stores updates and deletions as append-only events that survive union reordering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-notes-events-"));
    await ensureFixtureProject(root);
    const created = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Append-only note",
      resolved: false
    });
    const noteId = created.notes.find((note) => note.body === "Append-only note")!.id;
    await updateNoteResolved(root, noteId, true);
    await updateNoteResolved(root, noteId, false);
    await deleteNote(root, noteId);

    const ledgerPath = path.join(root, ".archicode", "notes.jsonl");
    const lines = (await readFile(ledgerPath, "utf8")).trim().split(/\r?\n/);
    const events = lines.map((line) => JSON.parse(line) as { noteId?: string; kind?: string });
    expect(events.filter((event) => event.noteId === noteId).map((event) => event.kind)).toEqual([
      "upsert",
      "upsert",
      "upsert",
      "delete"
    ]);

    // Git's union driver does not guarantee line order. Event timestamps make
    // folding deterministic and keep the deletion durable.
    await writeFile(ledgerPath, `${[...lines].reverse().join("\n")}\n`, "utf8");
    const reloaded = await loadProject(root);
    expect(reloaded.notes.some((note) => note.id === noteId)).toBe(false);
  });

  it("resolves agent questions and attaches node references", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-notes-"));
    const referencePath = path.join(root, "reference.txt");
    await writeFile(referencePath, "reference material", "utf8");
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    await saveFlow(root, {
      ...flow,
      nodes: flow.nodes.map((node) => node.id === "node-project" ? { ...node, flags: [] } : node)
    });

    const withNote = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "llm-question",
      author: "llm",
      body: "Which visual reference should guide this node?",
      resolved: false
    });
    const note = withNote.notes.find((item) => item.body.includes("visual reference"));
    expect(note?.resolved).toBe(false);
    expect(withNote.flows[0]?.nodes.find((item) => item.id === "node-project")?.flags).toEqual(
      expect.arrayContaining(["llm-question", "needs-attention"])
    );

    const withAttachment = await attachNodeReferences(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      noteId: note?.id,
      filePaths: [referencePath]
    });
    const node = withAttachment.flows[0]?.nodes.find((item) => item.id === "node-project");

    expect(node?.flags).toContain("has-attachments");
    expect(node?.flags).toContain("changed");
    const referenceArtifact = withAttachment.artifacts.find((artifact) => artifact.type === "attachment" && artifact.noteId === note?.id);
    expect(referenceArtifact).toBeDefined();

    // Deliberate node-note references must be persisted to the committed
    // .archicode/references/ directory (not the ignored artifacts bucket) so
    // they travel with the repo, and the copied file + metadata JSON must exist.
    expect(referenceArtifact!.path.startsWith(".archicode/references/")).toBe(true);
    await expect(readFile(path.join(root, referenceArtifact!.path), "utf8")).resolves.toBe("reference material");
    await expect(readFile(path.join(root, ".archicode", "references", `${referenceArtifact!.id}.json`), "utf8")).resolves.toContain(referenceArtifact!.id);

    // A fresh load (as a teammate cloning the repo would do) must still surface
    // the reference in bundle.artifacts, resolved from references/.
    const reloadedWithReference = await loadProject(root);
    expect(reloadedWithReference.artifacts.some((artifact) => artifact.id === referenceArtifact!.id)).toBe(true);

    const resolved = await updateNoteResolved(root, note?.id ?? "", true);
    expect(resolved.notes.find((item) => item.id === note?.id)?.resolved).toBe(true);
    const resolvedNode = resolved.flows[0]?.nodes.find((item) => item.id === "node-project");
    expect(resolvedNode?.flags).not.toContain("llm-question");
    expect(resolvedNode?.flags).not.toContain("needs-attention");
    expect(resolvedNode?.flags).toContain("changed");
  });

  it("deletes notes and refreshes node question flags", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-notes-delete-"));
    await ensureFixtureProject(root);
    const withNote = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "llm-question",
      author: "llm",
      body: "Should this stale question remain?",
      resolved: false
    });
    const note = withNote.notes.find((item) => item.body.includes("stale question"));
    expect(withNote.flows[0]?.nodes.find((item) => item.id === "node-project")?.flags).toContain("llm-question");

    const deleted = await deleteNote(root, note?.id ?? "");

    expect(deleted.notes.some((item) => item.id === note?.id)).toBe(false);
    const node = deleted.flows[0]?.nodes.find((item) => item.id === "node-project");
    expect(node?.flags).not.toContain("llm-question");
    expect(node?.flags).not.toContain("needs-attention");
    expect(node?.flags).toContain("changed");
  });

  it("purges resolved notes by node or across the whole project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-notes-purge-"));
    await ensureFixtureProject(root);
    const targetResolved = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Resolved target note",
      resolved: true
    });
    const pinnedResolved = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Pinned resolved reference",
      resolved: true,
      pinned: true
    });
    const targetOpen = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Open target note",
      resolved: false
    });
    const otherResolved = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      kind: "user-note",
      author: "user",
      body: "Resolved note on another node",
      resolved: true
    });
    const targetResolvedId = targetResolved.notes.find((note) => note.body === "Resolved target note")!.id;
    const pinnedResolvedId = pinnedResolved.notes.find((note) => note.body === "Pinned resolved reference")!.id;
    const targetOpenId = targetOpen.notes.find((note) => note.body === "Open target note")!.id;
    const otherResolvedId = otherResolved.notes.find((note) => note.body === "Resolved note on another node")!.id;

    const nodePurged = await purgeResolvedNotes(root, { flowId: "flow-main", nodeId: "node-project" });

    expect(nodePurged.notes.some((note) => note.id === targetResolvedId)).toBe(false);
    expect(nodePurged.notes.some((note) => note.id === pinnedResolvedId)).toBe(true);
    expect(nodePurged.notes.some((note) => note.id === targetOpenId)).toBe(true);
    expect(nodePurged.notes.some((note) => note.id === otherResolvedId)).toBe(true);

    const projectPurged = await purgeResolvedNotes(root);

    expect(projectPurged.notes.some((note) => note.id === targetOpenId)).toBe(true);
    expect(projectPurged.notes.find((note) => note.id === pinnedResolvedId)?.resolved).toBe(true);
    expect(projectPurged.notes.filter((note) => note.id !== pinnedResolvedId).some((note) => note.resolved)).toBe(false);
  });

  it("purges system generated notes by node scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-notes-system-purge-"));
    await ensureFixtureProject(root);
    const handoff = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "system-note",
      author: "llm",
      body: "LLM handoff for run run-123",
      resolved: false
    });
    const systemNote = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "system",
      body: "System bookkeeping note",
      resolved: false
    });
    const humanNote = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Human-facing note",
      resolved: false
    });
    const pinnedSystem = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "system-note",
      author: "llm",
      body: "Pinned handoff reference",
      resolved: false,
      pinned: true
    });
    const otherSystem = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      kind: "system-note",
      author: "llm",
      body: "Other node handoff",
      resolved: false
    });
    const handoffId = handoff.notes.find((note) => note.body.includes("run-123"))!.id;
    const systemNoteId = systemNote.notes.find((note) => note.body === "System bookkeeping note")!.id;
    const humanNoteId = humanNote.notes.find((note) => note.body === "Human-facing note")!.id;
    const pinnedSystemId = pinnedSystem.notes.find((note) => note.body === "Pinned handoff reference")!.id;
    const otherSystemId = otherSystem.notes.find((note) => note.body === "Other node handoff")!.id;

    const purged = await purgeSystemNotes(root, { flowId: "flow-main", nodeId: "node-project" });

    expect(purged.notes.some((note) => note.id === handoffId)).toBe(false);
    expect(purged.notes.some((note) => note.id === systemNoteId)).toBe(false);
    expect(purged.notes.some((note) => note.id === humanNoteId)).toBe(true);
    expect(purged.notes.some((note) => note.id === pinnedSystemId)).toBe(true);
    expect(purged.notes.some((note) => note.id === otherSystemId)).toBe(true);
  });

  it("toggles pinned notes independently from delete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-notes-pin-"));
    await ensureFixtureProject(root);
    const withNote = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Keep this architecture constraint nearby.",
      resolved: true
    });
    const noteId = withNote.notes.find((note) => note.body.includes("architecture constraint"))!.id;

    const pinned = await updateNotePinned(root, noteId, true);
    const unpinned = await updateNotePinned(root, noteId, false);
    const deleted = await deleteNote(root, noteId);

    expect(pinned.notes.find((note) => note.id === noteId)?.pinned).toBe(true);
    expect(unpinned.notes.find((note) => note.id === noteId)?.pinned).toBe(false);
    expect(deleted.notes.some((note) => note.id === noteId)).toBe(false);
  });

  it("auto-resolves open node notes when the node is approved for production", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-notes-approval-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    await saveFlow(root, {
      ...flow,
      nodes: flow.nodes.map((node) => node.id === "node-project" ? { ...node, stage: "draft", flags: [] } : node)
    });
    const withNote = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Fold this feedback into the approved node.",
      resolved: false
    });
    const withQuestion = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "llm-question",
      author: "llm",
      body: "Should this question be closed by approval?",
      resolved: false
    });
    const noteId = withNote.notes.find((note) => note.body.includes("Fold this feedback"))!.id;
    const questionId = withQuestion.notes.find((note) => note.body.includes("closed by approval"))!.id;

    const approved = await updateNode(root, "flow-main", { id: "node-project", stage: "draft-approved-production" }, "user");
    const node = approved.flows[0]?.nodes.find((item) => item.id === "node-project");

    expect(approved.notes.find((note) => note.id === noteId)?.resolved).toBe(true);
    expect(approved.notes.find((note) => note.id === questionId)?.resolved).toBe(true);
    expect(node?.stage).toBe("draft-approved-production");
    expect(node?.flags).toContain("user-approved");
    expect(node?.flags).not.toContain("changed");
    expect(node?.flags).not.toContain("llm-question");
    expect(node?.flags).not.toContain("needs-attention");
  });

  it("auto-resolves open node notes when the node moves to plan-approved", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-notes-plan-approved-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    await saveFlow(root, {
      ...flow,
      nodes: flow.nodes.map((node) => node.id === "node-project" ? { ...node, stage: "draft", flags: [] } : node)
    });
    const withNote = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Planning feedback has been accepted.",
      resolved: false
    });
    const noteId = withNote.notes.find((note) => note.body.includes("Planning feedback"))!.id;

    const approved = await updateNode(root, "flow-main", { id: "node-project", stage: "plan-approved" }, "user");

    expect(approved.notes.find((note) => note.id === noteId)?.resolved).toBe(true);
    expect(approved.flows[0]?.nodes.find((item) => item.id === "node-project")?.stage).toBe("plan-approved");
  });

  it("can purge resolved node notes automatically when approving a node", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-notes-auto-purge-"));
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      purgeResolvedNotesOnApproval: true
    });
    const flow = bundle.flows[0]!;
    await saveFlow(root, {
      ...flow,
      nodes: flow.nodes.map((node) => node.id === "node-project" ? { ...node, stage: "draft", flags: [] } : node)
    });
    const openTarget = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Approved work should purge this open target after resolving it.",
      resolved: false
    });
    const resolvedTarget = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Already resolved target should also be purged.",
      resolved: true
    });
    const otherResolved = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      kind: "user-note",
      author: "user",
      body: "Resolved note on another node should remain.",
      resolved: true
    });
    const openTargetId = openTarget.notes.find((note) => note.body.includes("open target"))!.id;
    const resolvedTargetId = resolvedTarget.notes.find((note) => note.body.includes("Already resolved target"))!.id;
    const otherResolvedId = otherResolved.notes.find((note) => note.body.includes("another node should remain"))!.id;

    const approved = await updateNode(root, "flow-main", { id: "node-project", stage: "draft-approved-production" }, "user");

    expect(approved.notes.some((note) => note.id === openTargetId)).toBe(false);
    expect(approved.notes.some((note) => note.id === resolvedTargetId)).toBe(false);
    expect(approved.notes.some((note) => note.id === otherResolvedId)).toBe(true);
    expect(approved.flows[0]?.nodes.find((item) => item.id === "node-project")?.stage).toBe("draft-approved-production");
  });
});
