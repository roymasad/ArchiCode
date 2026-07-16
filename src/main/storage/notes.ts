import path from "node:path";
import { flowSchema, isProductionApproved, noteSchema } from "../../shared/schema";
import type { Flow, Note, ProjectBundle } from "../../shared/schema";
import { loadProject, touchProject } from "./projectStore";
import { exists, id, iso, projectStatePath, readJson, writeJson } from "./persistence";
import { appendNote, readNotes, updateNoteById, writeNotes } from "./ledgers";
import { createAttachmentArtifacts } from "./artifacts";

export function isNoteAutoResolveNodeState(node: Pick<Flow["nodes"][number], "stage" | "flags" | "locked">): boolean {
  return node.stage === "plan-approved" || isProductionApproved(node);
}

export async function addNote(
  projectRoot: string,
  input: Omit<Note, "id" | "createdAt" | "attachmentIds" | "category" | "priority" | "pinned"> &
    Partial<Pick<Note, "category" | "priority" | "pinned">> & { attachmentIds?: string[] }
): Promise<ProjectBundle> {
  if (input.kind === "llm-question") {
    const existing = await readNotes(projectRoot);
    const normalizedBody = input.body.trim().replace(/\s+/g, " ");
    const duplicate = existing
      .some((note) =>
        note.flowId === input.flowId &&
        note.nodeId === input.nodeId &&
        note.kind === "llm-question" &&
        !note.resolved &&
        note.body.trim().replace(/\s+/g, " ") === normalizedBody
      );
    if (duplicate) return loadProject(projectRoot);
  }
  const note = noteSchema.parse({
    ...input,
    id: id("note"),
    createdAt: iso()
  });
  await appendNote(projectRoot, note);
  await syncNodeQuestionFlags(projectRoot, note.flowId, note.nodeId);
  if (note.author === "user") {
    await setNodeChangedFlag(projectRoot, note.flowId, note.nodeId, true);
  }
  await touchProject(projectRoot);
  return loadProject(projectRoot);
}

export async function updateNoteResolved(projectRoot: string, noteId: string, resolved: boolean): Promise<ProjectBundle> {
  const target = await updateNoteById(projectRoot, noteId, (note) => ({ ...note, resolved }));
  if (!target) throw new Error(`Note ${noteId} was not found.`);
  await syncNodeQuestionFlags(projectRoot, target.flowId, target.nodeId);
  await setNodeChangedFlag(projectRoot, target.flowId, target.nodeId, true);
  await touchProject(projectRoot);
  return loadProject(projectRoot);
}

export async function updateNotePinned(projectRoot: string, noteId: string, pinned: boolean): Promise<ProjectBundle> {
  const target = await updateNoteById(projectRoot, noteId, (note) => ({ ...note, pinned }));
  if (!target) throw new Error(`Note ${noteId} was not found.`);
  await setNodeChangedFlag(projectRoot, target.flowId, target.nodeId, true);
  await touchProject(projectRoot);
  return loadProject(projectRoot);
}

export async function deleteNote(projectRoot: string, noteId: string): Promise<ProjectBundle> {
  const target = await updateNoteById(projectRoot, noteId, () => null);
  if (!target) throw new Error(`Note ${noteId} was not found.`);
  await syncNodeQuestionFlags(projectRoot, target.flowId, target.nodeId);
  await setNodeChangedFlag(projectRoot, target.flowId, target.nodeId, true);
  await touchProject(projectRoot);
  return loadProject(projectRoot);
}

export async function purgeResolvedNotes(
  projectRoot: string,
  scope: { flowId?: string; nodeId?: string } = {}
): Promise<ProjectBundle> {
  const notes = await readNotes(projectRoot);
  const touchedNodes = new Set<string>();
  const matchesScope = (note: Note): boolean =>
    note.resolved &&
    !note.pinned &&
    (!scope.flowId || note.flowId === scope.flowId) &&
    (!scope.nodeId || note.nodeId === scope.nodeId);

  const retained: Note[] = [];
  for (const note of notes) {
    const parsed = noteSchema.safeParse(note);
    if (!parsed.success) continue;
    if (matchesScope(parsed.data)) {
      touchedNodes.add(`${parsed.data.flowId}\0${parsed.data.nodeId}`);
    } else {
      retained.push(parsed.data);
    }
  }

  if (touchedNodes.size) {
    await writeNotes(projectRoot, retained);
    for (const key of touchedNodes) {
      const [flowId, nodeId] = key.split("\0");
      if (flowId && nodeId) await syncNodeQuestionFlags(projectRoot, flowId, nodeId);
    }
    await touchProject(projectRoot);
  }
  return loadProject(projectRoot);
}

export function isSystemGeneratedNote(note: Note): boolean {
  return note.kind === "system-note" || note.author === "system";
}

export async function purgeSystemNotes(
  projectRoot: string,
  scope: { flowId?: string; nodeId?: string } = {}
): Promise<ProjectBundle> {
  const notes = await readNotes(projectRoot);
  const touchedNodes = new Set<string>();
  const matchesScope = (note: Note): boolean =>
    isSystemGeneratedNote(note) &&
    !note.pinned &&
    (!scope.flowId || note.flowId === scope.flowId) &&
    (!scope.nodeId || note.nodeId === scope.nodeId);

  const retained: Note[] = [];
  for (const note of notes) {
    const parsed = noteSchema.safeParse(note);
    if (!parsed.success) continue;
    if (matchesScope(parsed.data)) {
      touchedNodes.add(`${parsed.data.flowId}\0${parsed.data.nodeId}`);
    } else {
      retained.push(parsed.data);
    }
  }

  if (touchedNodes.size) {
    await writeNotes(projectRoot, retained);
    for (const key of touchedNodes) {
      const [flowId, nodeId] = key.split("\0");
      if (flowId && nodeId) await syncNodeQuestionFlags(projectRoot, flowId, nodeId);
    }
    await touchProject(projectRoot);
  }
  return loadProject(projectRoot);
}

export async function autoResolveNodeNotesForApproval(projectRoot: string, flowId: string, nodeId: string): Promise<boolean> {
  const notes = await readNotes(projectRoot);
  let resolvedAny = false;
  const updated = notes.flatMap((note) => {
    const parsed = noteSchema.safeParse(note);
    if (!parsed.success) return [];
    if (parsed.data.flowId !== flowId || parsed.data.nodeId !== nodeId || parsed.data.resolved) return [parsed.data];
    resolvedAny = true;
    return [noteSchema.parse({ ...parsed.data, resolved: true })];
  });
  if (resolvedAny) {
    await writeNotes(projectRoot, updated);
    await syncNodeQuestionFlags(projectRoot, flowId, nodeId);
    await touchProject(projectRoot);
  }
  return resolvedAny;
}

export async function finalizeNodeNotesForApproval(projectRoot: string, flowId: string, nodeId: string, purgeResolved: boolean): Promise<ProjectBundle> {
  await autoResolveNodeNotesForApproval(projectRoot, flowId, nodeId);
  if (purgeResolved) return purgeResolvedNotes(projectRoot, { flowId, nodeId });
  return loadProject(projectRoot);
}

export async function syncNodeQuestionFlags(projectRoot: string, flowId: string, nodeId: string): Promise<void> {
  const flowPath = projectStatePath(projectRoot, "flows", `${flowId}.json`);
  if (!(await exists(flowPath))) return;
  const flow = flowSchema.parse(await readJson(flowPath, null));
  const notes = await readNotes(projectRoot);
  const hasOpenQuestion = notes.some((note) =>
    note.flowId === flowId &&
    note.nodeId === nodeId &&
    note.kind === "llm-question" &&
    !note.resolved
  );
  let changed = false;
  const nodes = flow.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const flags = new Set(node.flags);
    if (hasOpenQuestion) {
      flags.add("llm-question");
      flags.add("needs-attention");
    } else if (flags.has("llm-question")) {
      flags.delete("llm-question");
      flags.delete("needs-attention");
    }
    const nextFlags = Array.from(flags);
    changed = changed || nextFlags.join("|") !== node.flags.join("|");
    return changed ? { ...node, flags: nextFlags, updatedAt: iso() } : node;
  });
  if (changed) {
    await writeJson(flowPath, flowSchema.parse({ ...flow, nodes, updatedAt: iso() }));
  }
}

export async function setNodeChangedFlag(projectRoot: string, flowId: string, nodeId: string, changedFlag: boolean): Promise<void> {
  const flowPath = projectStatePath(projectRoot, "flows", `${flowId}.json`);
  if (!(await exists(flowPath))) return;
  const flow = flowSchema.parse(await readJson(flowPath, null));
  let changed = false;
  const nodes = flow.nodes.map((node) => {
    if (node.id !== nodeId || isProductionApproved(node)) return node;
    const flags = new Set(node.flags);
    if (changedFlag) flags.add("changed");
    else flags.delete("changed");
    const nextFlags = Array.from(flags);
    const nextChanged = nextFlags.join("|") !== node.flags.join("|");
    changed = changed || nextChanged;
    return nextChanged ? { ...node, flags: nextFlags, updatedAt: iso() } : node;
  });
  if (changed) {
    await writeJson(flowPath, flowSchema.parse({ ...flow, nodes, updatedAt: iso() }));
  }
}

export async function attachNodeReferences(
  projectRoot: string,
  input: {
    flowId: string;
    nodeId: string;
    filePaths: string[];
    noteId?: string;
  }
): Promise<ProjectBundle> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === input.flowId);
  const node = flow?.nodes.find((item) => item.id === input.nodeId);
  if (!flow || !node) throw new Error(`Node ${input.nodeId} was not found.`);

  const artifacts = await createAttachmentArtifacts(projectRoot, input.filePaths, {
    nodeId: input.nodeId,
    noteId: input.noteId,
    summary: "Reference file attached to node notes."
  });

  if (input.noteId && artifacts.length) {
    const attachmentIds = artifacts.map((artifact) => artifact.id);
    await updateNoteById(projectRoot, input.noteId, (note) => ({
      ...note,
      attachmentIds: [...new Set([...(note.attachmentIds ?? []), ...attachmentIds])]
    }));
  }

  if (artifacts.length) {
    const nextFlow = {
      ...flow,
      nodes: flow.nodes.map((item) => item.id === input.nodeId
        ? {
            ...item,
            flags: isProductionApproved(item)
              ? Array.from(new Set([...item.flags, "has-attachments"]))
              : Array.from(new Set([...item.flags, "has-attachments", "changed"])),
            attachments: [...item.attachments, ...artifacts],
            updatedAt: iso()
          }
        : item),
      updatedAt: iso()
    };
    await writeJson(projectStatePath(projectRoot, "flows", `${flow.id}.json`), flowSchema.parse(nextFlow));
  }

  await touchProject(projectRoot);
  return loadProject(projectRoot);
}
