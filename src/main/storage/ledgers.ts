import { z } from "zod";
import { isNoteActiveForModelContext, noteSchema, graphChangeRecordSchema } from "../../shared/schema";
import type { Flow, FlowEdge, GraphChangeRecord, Note } from "../../shared/schema";
import { appendJsonLine, id, iso, projectStatePath, readJsonLines, writeJsonLines } from "./persistence";

export const NOTES_LEDGER_FILE = "notes.jsonl";
export const GRAPH_CHANGES_LEDGER_FILE = "graph-changes.jsonl";
// Cold store for resolved ledger records aged out of the hot JSONL by retention
// compaction. Full-fidelity and append-only so history stays reachable.
export const GRAPH_CHANGES_ARCHIVE_FILE = "graph-changes-archive.jsonl";

export function notesLedgerPath(projectRoot: string): string {
  return projectStatePath(projectRoot, NOTES_LEDGER_FILE);
}

export function graphChangesLedgerPath(projectRoot: string): string {
  return projectStatePath(projectRoot, GRAPH_CHANGES_LEDGER_FILE);
}

export const noteLedgerEventSchema = z.discriminatedUnion("kind", [
  z.object({
    eventId: z.string(),
    noteId: z.string(),
    kind: z.literal("upsert"),
    at: z.string(),
    note: noteSchema
  }),
  z.object({
    eventId: z.string(),
    noteId: z.string(),
    kind: z.literal("delete"),
    at: z.string()
  })
]);
export type NoteLedgerEvent = z.infer<typeof noteLedgerEventSchema>;
export let lastNoteLedgerEventMs = 0;

export function observeNoteLedgerAt(at: string): void {
  const parsed = Date.parse(at);
  if (Number.isFinite(parsed)) lastNoteLedgerEventMs = Math.max(lastNoteLedgerEventMs, parsed);
}

export function nextNoteLedgerAt(): string {
  lastNoteLedgerEventMs = Math.max(Date.now(), lastNoteLedgerEventMs + 1);
  return new Date(lastNoteLedgerEventMs).toISOString();
}

export function noteLedgerEventSort(left: NoteLedgerEvent, right: NoteLedgerEvent): number {
  return left.at.localeCompare(right.at) || left.eventId.localeCompare(right.eventId);
}

export function noteUpsertEvent(note: Note, at = nextNoteLedgerAt()): NoteLedgerEvent {
  const parsed = noteSchema.parse(note);
  return noteLedgerEventSchema.parse({
    eventId: id("note-event"),
    noteId: parsed.id,
    kind: "upsert",
    at,
    note: parsed
  });
}

export function noteDeleteEvent(noteId: string, at = nextNoteLedgerAt()): NoteLedgerEvent {
  return noteLedgerEventSchema.parse({
    eventId: id("note-event"),
    noteId,
    kind: "delete",
    at
  });
}

export async function readNotes(projectRoot: string): Promise<Note[]> {
  const raw = await readJsonLines<unknown>(notesLedgerPath(projectRoot));
  const events: NoteLedgerEvent[] = [];
  for (const value of raw) {
    const event = noteLedgerEventSchema.safeParse(value);
    if (!event.success) continue;
    observeNoteLedgerAt(event.data.at);
    events.push(event.data);
  }
  const byId = new Map<string, Note>();
  for (const event of events.sort(noteLedgerEventSort)) {
    if (event.kind === "delete") byId.delete(event.noteId);
    else byId.set(event.noteId, event.note);
  }
  return [...byId.values()];
}

export async function writeNotes(projectRoot: string, notes: Note[]): Promise<void> {
  const current = new Map((await readNotes(projectRoot)).map((note) => [note.id, note]));
  const desired = new Map(notes.map((note) => {
    const parsed = noteSchema.parse(note);
    return [parsed.id, parsed] as const;
  }));
  for (const [noteId, note] of desired) {
    const previous = current.get(noteId);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(note)) {
      await appendJsonLine(notesLedgerPath(projectRoot), noteUpsertEvent(note));
    }
  }
  for (const noteId of current.keys()) {
    if (!desired.has(noteId)) await appendJsonLine(notesLedgerPath(projectRoot), noteDeleteEvent(noteId));
  }
}

export async function appendNote(projectRoot: string, note: Note): Promise<void> {
  await appendJsonLine(notesLedgerPath(projectRoot), noteUpsertEvent(note));
}

export async function readGraphChanges(projectRoot: string): Promise<GraphChangeRecord[]> {
  const records = await readJsonLines<GraphChangeRecord>(graphChangesLedgerPath(projectRoot));
  const byId = new Map<string, GraphChangeRecord>();
  const statusRank: Record<GraphChangeRecord["status"], number> = { pending: 0, obsolete: 1, implemented: 2 };
  for (const record of records) {
    const parsed = graphChangeRecordSchema.safeParse(record);
    if (!parsed.success) continue;
    const current = byId.get(parsed.data.id);
    if (!current || statusRank[parsed.data.status] > statusRank[current.status] ||
      (statusRank[parsed.data.status] === statusRank[current.status] && (parsed.data.resolvedAt ?? parsed.data.createdAt) > (current.resolvedAt ?? current.createdAt))) {
      byId.set(parsed.data.id, parsed.data);
    }
  }
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export async function writeGraphChanges(projectRoot: string, records: GraphChangeRecord[]): Promise<void> {
  await writeJsonLines(graphChangesLedgerPath(projectRoot), records.map((record) => graphChangeRecordSchema.parse(record)));
}

export type GraphChangeActor = GraphChangeRecord["actor"];
export type GraphChangeRecordInput =
  Pick<GraphChangeRecord, "flowId" | "actor" | "kind" | "summary"> &
  Partial<Pick<GraphChangeRecord, "id" | "status" | "createdAt" | "nodeIds" | "edgeIds" | "subflowIds" | "groupIds" | "fieldPaths" | "snippets" | "runId" | "resolvedAt">>;

export const GRAPH_CHANGE_VALUE_LIMIT = 180;
export const GRAPH_CHANGE_SNIPPET_LIMIT = 6;
export const CONTEXT_GRAPH_CHANGE_LIMIT = 128;

export function compactGraphChangeValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (typeof value === "string") {
    const normalized = value.trim().replace(/\s+/g, " ");
    return normalized.length > GRAPH_CHANGE_VALUE_LIMIT
      ? `${normalized.slice(0, GRAPH_CHANGE_VALUE_LIMIT - 1)}...`
      : normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const preview = value.slice(0, 4).map((item) => compactGraphChangeValue(item) ?? "").filter(Boolean).join("; ");
    const suffix = value.length > 4 ? `; +${value.length - 4} more` : "";
    return `${value.length} item${value.length === 1 ? "" : "s"}${preview ? `: ${preview}${suffix}` : ""}`;
  }
  try {
    const text = JSON.stringify(value);
    return text.length > GRAPH_CHANGE_VALUE_LIMIT ? `${text.slice(0, GRAPH_CHANGE_VALUE_LIMIT - 1)}...` : text;
  } catch {
    return String(value);
  }
}

export function graphChangeSnippets(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fieldPaths: string[]
): GraphChangeRecord["snippets"] {
  return fieldPaths.slice(0, GRAPH_CHANGE_SNIPPET_LIMIT).map((fieldPath) => ({
    path: fieldPath,
    before: compactGraphChangeValue(before[fieldPath]),
    after: compactGraphChangeValue(after[fieldPath])
  })).filter((snippet) => snippet.before !== snippet.after);
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export async function writeGraphChangeRecord(
  projectRoot: string,
  input: GraphChangeRecordInput
): Promise<GraphChangeRecord> {
  const record = graphChangeRecordSchema.parse({
    ...input,
    id: input.id ?? id("graph-change"),
    status: input.status ?? "pending",
    createdAt: input.createdAt ?? iso()
  });
  await appendJsonLine(graphChangesLedgerPath(projectRoot), record);
  return record;
}

export async function recordGraphChange(
  projectRoot: string,
  input: GraphChangeRecordInput
): Promise<GraphChangeRecord> {
  return writeGraphChangeRecord(projectRoot, input);
}

export function flowEdgeTitle(edge: FlowEdge): string {
  return `${edge.source} -> ${edge.target}${edge.label ? ` (${edge.label})` : ""}`;
}

export async function recordFlowShapeChanges(
  projectRoot: string,
  before: Flow | null,
  after: Flow,
  actor: GraphChangeActor,
  options: { status?: GraphChangeRecord["status"] } = {}
): Promise<void> {
  const status = options.status ?? "pending";
  const writeShapeChange = (input: GraphChangeRecordInput): Promise<GraphChangeRecord> =>
    writeGraphChangeRecord(projectRoot, {
      ...input,
      status,
      ...(status === "pending" ? {} : { resolvedAt: iso() })
    });
  const beforeEdges = new Map((before?.edges ?? []).map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  for (const edge of after.edges) {
    const previous = beforeEdges.get(edge.id);
    if (!previous) {
      await writeShapeChange({
        flowId: after.id,
        actor,
        kind: "edge-created",
        summary: `Created edge ${flowEdgeTitle(edge)}.`,
        nodeIds: uniqueStrings([edge.source, edge.target]),
        edgeIds: [edge.id],
        fieldPaths: ["source", "target", ...(edge.label ? ["label"] : [])],
        snippets: graphChangeSnippets({}, edge as unknown as Record<string, unknown>, ["source", "target", "label"])
      });
      continue;
    }
    const fieldPaths = ["source", "target", "label"].filter((fieldPath) =>
      (previous as unknown as Record<string, unknown>)[fieldPath] !== (edge as unknown as Record<string, unknown>)[fieldPath]
    );
    if (fieldPaths.length) {
      await writeShapeChange({
        flowId: after.id,
        actor,
        kind: "edge-updated",
        summary: `Updated edge ${edge.id}.`,
        nodeIds: uniqueStrings([previous.source, previous.target, edge.source, edge.target]),
        edgeIds: [edge.id],
        fieldPaths,
        snippets: graphChangeSnippets(previous as unknown as Record<string, unknown>, edge as unknown as Record<string, unknown>, fieldPaths)
      });
    }
  }
  for (const edge of before?.edges ?? []) {
    if (afterEdges.has(edge.id)) continue;
    await writeShapeChange({
      flowId: after.id,
      actor,
      kind: "edge-deleted",
      summary: `Deleted edge ${flowEdgeTitle(edge)}.`,
      nodeIds: uniqueStrings([edge.source, edge.target]),
      edgeIds: [edge.id],
      fieldPaths: ["source", "target", ...(edge.label ? ["label"] : [])],
      snippets: graphChangeSnippets(edge as unknown as Record<string, unknown>, {}, ["source", "target", "label"])
    });
  }

  const beforeNodeIds = new Set((before?.nodes ?? []).map((node) => node.id));
  const afterNodeIds = new Set(after.nodes.map((node) => node.id));
  for (const node of after.nodes) {
    if (beforeNodeIds.has(node.id)) continue;
    await writeShapeChange({
      flowId: after.id,
      actor,
      kind: "node-created",
      summary: `Created node "${node.title}".`,
      nodeIds: [node.id],
      fieldPaths: ["title", "description", "type", "stage"],
      snippets: graphChangeSnippets({}, node as unknown as Record<string, unknown>, ["title", "description", "type", "stage"])
    });
  }
  for (const node of before?.nodes ?? []) {
    if (afterNodeIds.has(node.id)) continue;
    await writeShapeChange({
      flowId: after.id,
      actor,
      kind: "node-deleted",
      summary: `Deleted node "${node.title}".`,
      nodeIds: [node.id],
      fieldPaths: ["title", "description", "type", "stage"],
      snippets: graphChangeSnippets(node as unknown as Record<string, unknown>, {}, ["title", "description", "type", "stage"])
    });
  }

  const beforeGroups = new Map((before?.groups ?? []).map((group) => [group.id, group]));
  const afterGroups = new Map(after.groups.map((group) => [group.id, group]));
  for (const group of after.groups) {
    const previous = beforeGroups.get(group.id);
    if (!previous) {
      await writeShapeChange({
        flowId: after.id,
        actor,
        kind: "group-created",
        summary: `Created group "${group.name}".`,
        groupIds: [group.id],
        fieldPaths: ["name", ...(group.color ? ["color"] : [])],
        snippets: graphChangeSnippets({}, group as unknown as Record<string, unknown>, ["name", "color"])
      });
      continue;
    }
    const fieldPaths = ["name", "color"].filter((fieldPath) =>
      (previous as unknown as Record<string, unknown>)[fieldPath] !== (group as unknown as Record<string, unknown>)[fieldPath]
    );
    if (fieldPaths.length) {
      await writeShapeChange({
        flowId: after.id,
        actor,
        kind: "group-updated",
        summary: `Updated group "${group.name}".`,
        groupIds: [group.id],
        fieldPaths,
        snippets: graphChangeSnippets(previous as unknown as Record<string, unknown>, group as unknown as Record<string, unknown>, fieldPaths)
      });
    }
  }
  for (const group of before?.groups ?? []) {
    if (afterGroups.has(group.id)) continue;
    await writeShapeChange({
      flowId: after.id,
      actor,
      kind: "group-deleted",
      summary: `Deleted group "${group.name}".`,
      groupIds: [group.id],
      fieldPaths: ["name", ...(group.color ? ["color"] : [])],
      snippets: graphChangeSnippets(group as unknown as Record<string, unknown>, {}, ["name", "color"])
    });
  }

  const beforeSubflows = new Map((before?.subflows ?? []).map((subflow) => [subflow.id, subflow]));
  const afterSubflows = new Map(after.subflows.map((subflow) => [subflow.id, subflow]));
  for (const subflow of after.subflows) {
    const previous = beforeSubflows.get(subflow.id);
    if (!previous) {
      await writeShapeChange({
        flowId: after.id,
        actor,
        kind: "subflow-created",
        summary: `Created subflow "${subflow.name}".`,
        nodeIds: uniqueStrings([subflow.parentNodeId]),
        subflowIds: [subflow.id],
        fieldPaths: ["name", "parentNodeId", "parentSubflowId"],
        snippets: graphChangeSnippets({}, subflow as unknown as Record<string, unknown>, ["name", "parentNodeId", "parentSubflowId"])
      });
      continue;
    }
    const fieldPaths = ["name", "parentNodeId", "parentSubflowId"].filter((fieldPath) =>
      (previous as unknown as Record<string, unknown>)[fieldPath] !== (subflow as unknown as Record<string, unknown>)[fieldPath]
    );
    if (fieldPaths.length) {
      await writeShapeChange({
        flowId: after.id,
        actor,
        kind: fieldPaths.some((fieldPath) => fieldPath.startsWith("parent")) ? "node-subflow-linked" : "subflow-updated",
        summary: `Updated subflow "${subflow.name}".`,
        nodeIds: uniqueStrings([previous.parentNodeId, subflow.parentNodeId]),
        subflowIds: [subflow.id],
        fieldPaths,
        snippets: graphChangeSnippets(previous as unknown as Record<string, unknown>, subflow as unknown as Record<string, unknown>, fieldPaths)
      });
    }
  }
  for (const subflow of before?.subflows ?? []) {
    if (afterSubflows.has(subflow.id)) continue;
    await writeShapeChange({
      flowId: after.id,
      actor,
      kind: "subflow-deleted",
      summary: `Deleted subflow "${subflow.name}".`,
      nodeIds: uniqueStrings([subflow.parentNodeId]),
      subflowIds: [subflow.id],
      fieldPaths: ["name", "parentNodeId", "parentSubflowId"],
      snippets: graphChangeSnippets(subflow as unknown as Record<string, unknown>, {}, ["name", "parentNodeId", "parentSubflowId"])
    });
  }

  if (before) {
    const fieldPaths = ["name", "description", "perspective"].filter((fieldPath) =>
      (before as unknown as Record<string, unknown>)[fieldPath] !== (after as unknown as Record<string, unknown>)[fieldPath]
      && JSON.stringify((before as unknown as Record<string, unknown>)[fieldPath]) !== JSON.stringify((after as unknown as Record<string, unknown>)[fieldPath])
    );
    if (fieldPaths.length) {
      await writeShapeChange({
        flowId: after.id,
        actor,
        kind: "flow-updated",
        summary: `Updated flow "${after.name}".`,
        fieldPaths,
        snippets: graphChangeSnippets(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, fieldPaths)
      });
    }
  }
}

export async function markPendingGraphChangesImplemented(
  projectRoot: string,
  flowId: string,
  nodeIds: Set<string>,
  runId: string,
  coversEntireFlow: boolean
): Promise<void> {
  if (!nodeIds.size) return;
  const records = await readGraphChanges(projectRoot);
  const now = iso();
  let changed = false;
  const updatedRecords = records.map((record) => {
    const parsed = graphChangeRecordSchema.safeParse(record);
    if (!parsed.success) return record;
    const change = parsed.data;
    if (change.status !== "pending" || change.flowId !== flowId) return change;
    // Node-scoped records are only implemented when every node they touch was
    // covered by this run's verified set — a run that verifies one of a
    // record's nodes should not retire the whole multi-node change. Flow-level
    // records (no nodeIds, e.g. flow-updated) only retire on a whole-flow verify.
    if (change.nodeIds.length) {
      if (!change.nodeIds.every((nodeId) => nodeIds.has(nodeId))) return change;
    } else if (!coversEntireFlow) {
      return change;
    }
    changed = true;
    return graphChangeRecordSchema.parse({
      ...change,
      status: "implemented",
      runId,
      resolvedAt: now
    });
  });
  if (changed) await writeGraphChanges(projectRoot, updatedRecords);
}

export async function updateNoteById(
  projectRoot: string,
  noteId: string,
  updater: (note: Note) => Note | null
): Promise<Note | null> {
  const notes = await readNotes(projectRoot);
  let target: Note | null = null;
  const updated = notes.flatMap((note) => {
    const parsed = noteSchema.safeParse(note);
    if (!parsed.success) return [];
    const current = parsed.data;
    if (current.id !== noteId) return [current];
    const next = updater(current);
    target = next ?? current;
    return next ? [noteSchema.parse(next)] : [];
  });
  if (!target) return null;
  await writeNotes(projectRoot, updated);
  return target;
}
export function shouldIncludeNoteInLlmContext(note: Note): boolean {
  return isNoteActiveForModelContext(note);
}
