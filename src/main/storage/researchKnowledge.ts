import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactSchema,
  projectMemoryNoteSchema,
  researchChatScopeSchema,
  type Artifact,
  type ProjectBundle,
  type ProjectMemoryNote,
  type ResearchChatScope
} from "../../shared/schema";
import { loadProject } from "./projectStore";
import { id, iso, projectStatePath, readJson, readJsonDirectory, replaceFileWithRetry, writeJson } from "./persistence";

export const PROJECT_MEMORY_NOTE_MAX_CHARS = 4_000;
export const PROJECT_MEMORY_NOTE_LIMIT = 200;
export const CHAT_ARTIFACT_MAX_CHARS = 1_000_000;
export const CHAT_ARTIFACT_LIMIT = 100;

export type ChatArtifactFormat = "markdown" | "text" | "json" | "csv";

const knowledgeLocks = new Map<string, Promise<unknown>>();

function withKnowledgeLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectRoot);
  const prior = knowledgeLocks.get(key) ?? Promise.resolve();
  const run = prior.then(() => fn(), () => fn());
  knowledgeLocks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

function compactString(value: string, label: string, maxChars: number): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxChars) throw new Error(`${label} exceeds the ${maxChars.toLocaleString()} character limit.`);
  if (text.includes("\0")) throw new Error(`${label} cannot contain NUL bytes.`);
  return text;
}

function safeIdentifier(value: string, label: string): string {
  const normalized = compactString(value, label, 160);
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) throw new Error(`${label} contains unsupported characters.`);
  return normalized;
}

function uniqueStrings(values: string[] | undefined, limit = 100): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function projectRelativePaths(values: string[] | undefined): string[] {
  return uniqueStrings(values, 100).map((value) => {
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
    if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) || normalized.split("/").includes("..")) {
      throw new Error("Memory note file paths must stay inside the project and use project-relative paths.");
    }
    return normalized;
  });
}

function knownArtifactIds(bundle: ProjectBundle, values: string[] | undefined): string[] {
  const ids = uniqueStrings(values, 100);
  const known = new Set(bundle.artifacts.map((artifact) => artifact.id));
  const missing = ids.filter((artifactId) => !known.has(artifactId));
  if (missing.length) throw new Error(`Memory note references unknown artifact ids: ${missing.join(", ")}.`);
  return ids;
}

function scopeMatches(scope: ResearchChatScope, filter: ResearchChatScope | undefined): boolean {
  if (!filter) return true;
  if (scope.type === "project") return true;
  if (filter.type === "project") return true;
  if (scope.flowId !== filter.flowId) return false;
  if (scope.type === "flow" || filter.type === "flow") return true;
  if (scope.type === "subflow") return filter.type === "subflow" && scope.subflowId === filter.subflowId;
  return filter.type === "node" && scope.nodeId === filter.nodeId;
}

function assertScopeExists(bundle: ProjectBundle, rawScope: ResearchChatScope): ResearchChatScope {
  const scope = researchChatScopeSchema.parse(rawScope);
  if (scope.type === "project") {
    if (scope.projectId !== bundle.project.id) throw new Error(`Project ${scope.projectId} was not found.`);
    return scope;
  }
  const flow = bundle.flows.find((item) => item.id === scope.flowId);
  if (!flow) throw new Error(`Flow ${scope.flowId} was not found.`);
  if (scope.type === "subflow" && !flow.subflows.some((item) => item.id === scope.subflowId)) {
    throw new Error(`Subflow ${scope.subflowId} was not found.`);
  }
  if (scope.type === "node" && !flow.nodes.some((item) => item.id === scope.nodeId)) {
    throw new Error(`Node ${scope.nodeId} was not found.`);
  }
  return scope;
}

export async function listProjectMemoryNotes(
  projectRoot: string,
  options: { includeArchived?: boolean; scope?: ResearchChatScope } = {}
): Promise<ProjectMemoryNote[]> {
  const raw = await readJsonDirectory<unknown>(projectStatePath(projectRoot, "memory-notes"));
  return raw.flatMap((value) => {
    const parsed = projectMemoryNoteSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  }).filter((note) => (options.includeArchived || note.status !== "archived") && scopeMatches(note.scope, options.scope))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt.localeCompare(left.updatedAt));
}

export async function readProjectMemoryNote(projectRoot: string, noteId: string): Promise<ProjectMemoryNote> {
  const normalizedId = safeIdentifier(noteId, "noteId");
  const raw = await readJson<unknown | null>(projectStatePath(projectRoot, "memory-notes", `${normalizedId}.json`), null);
  const parsed = projectMemoryNoteSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Project memory note ${normalizedId} was not found.`);
  return parsed.data;
}

export async function createProjectMemoryNote(projectRoot: string, input: {
  title: string;
  body: string;
  scope: ResearchChatScope;
  pinned?: boolean;
  originChatId?: string;
  sourceMessageIds?: string[];
  artifactIds?: string[];
  filePaths?: string[];
}): Promise<ProjectMemoryNote> {
  return withKnowledgeLock(projectRoot, async () => {
    const existing = await listProjectMemoryNotes(projectRoot, { includeArchived: true });
    if (existing.filter((note) => note.status !== "archived").length >= PROJECT_MEMORY_NOTE_LIMIT) {
      throw new Error(`This project already has the maximum of ${PROJECT_MEMORY_NOTE_LIMIT} memory notes. Archive an old note before creating another.`);
    }
    const bundle = await loadProject(projectRoot);
    const now = iso();
    const note = projectMemoryNoteSchema.parse({
      id: id("memory-note"),
      title: compactString(input.title, "title", 160),
      body: compactString(input.body, "body", PROJECT_MEMORY_NOTE_MAX_CHARS),
      scope: assertScopeExists(bundle, input.scope),
      pinned: input.pinned ?? false,
      status: "active",
      originChatId: input.originChatId ? safeIdentifier(input.originChatId, "originChatId") : undefined,
      sourceMessageIds: uniqueStrings(input.sourceMessageIds),
      artifactIds: knownArtifactIds(bundle, input.artifactIds),
      filePaths: projectRelativePaths(input.filePaths),
      revision: 1,
      createdAt: now,
      updatedAt: now
    });
    await writeJson(projectStatePath(projectRoot, "memory-notes", `${note.id}.json`), note);
    return note;
  });
}

export async function updateProjectMemoryNote(projectRoot: string, noteId: string, input: {
  expectedRevision: number;
  title?: string;
  body?: string;
  scope?: ResearchChatScope;
  pinned?: boolean;
  status?: "active" | "stale" | "archived";
  sourceMessageIds?: string[];
  artifactIds?: string[];
  filePaths?: string[];
}): Promise<ProjectMemoryNote> {
  return withKnowledgeLock(projectRoot, async () => {
    const current = await readProjectMemoryNote(projectRoot, noteId);
    if (current.revision !== input.expectedRevision) {
      throw new Error(`Memory note ${current.id} changed since it was read. Expected revision ${input.expectedRevision}, current revision is ${current.revision}.`);
    }
    const bundle = await loadProject(projectRoot);
    const updated = projectMemoryNoteSchema.parse({
      ...current,
      title: input.title === undefined ? current.title : compactString(input.title, "title", 160),
      body: input.body === undefined ? current.body : compactString(input.body, "body", PROJECT_MEMORY_NOTE_MAX_CHARS),
      scope: input.scope === undefined ? current.scope : assertScopeExists(bundle, input.scope),
      pinned: input.pinned ?? current.pinned,
      status: input.status ?? current.status,
      sourceMessageIds: input.sourceMessageIds === undefined ? current.sourceMessageIds : uniqueStrings(input.sourceMessageIds),
      artifactIds: input.artifactIds === undefined ? current.artifactIds : knownArtifactIds(bundle, input.artifactIds),
      filePaths: input.filePaths === undefined ? current.filePaths : projectRelativePaths(input.filePaths),
      revision: current.revision + 1,
      updatedAt: iso()
    });
    await writeJson(projectStatePath(projectRoot, "memory-notes", `${updated.id}.json`), updated);
    return updated;
  });
}

function artifactFormat(format: ChatArtifactFormat): { extension: string; mediaType: string } {
  if (format === "json") return { extension: "json", mediaType: "application/json" };
  if (format === "csv") return { extension: "csv", mediaType: "text/csv" };
  if (format === "text") return { extension: "txt", mediaType: "text/plain" };
  return { extension: "md", mediaType: "text/markdown" };
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporaryPath, content, "utf8");
  await replaceFileWithRetry(temporaryPath, filePath);
}

export async function listChatArtifacts(projectRoot: string, chatId: string): Promise<Artifact[]> {
  const normalizedChatId = safeIdentifier(chatId, "chatId");
  const raw = await readJsonDirectory<unknown>(projectStatePath(projectRoot, "artifacts"));
  return raw.flatMap((value) => {
    const parsed = artifactSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  }).filter((artifact) => artifact.type === "chat-artifact" && artifact.chatId === normalizedChatId)
    .sort((left, right) => (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt));
}

export async function createChatArtifact(projectRoot: string, chatId: string, input: {
  title: string;
  content: string;
  format?: ChatArtifactFormat;
  summary?: string;
}): Promise<Artifact> {
  return withKnowledgeLock(projectRoot, async () => {
    const normalizedChatId = safeIdentifier(chatId, "chatId");
    const existing = await listChatArtifacts(projectRoot, normalizedChatId);
    if (existing.length >= CHAT_ARTIFACT_LIMIT) {
      throw new Error(`This chat already has the maximum of ${CHAT_ARTIFACT_LIMIT} artifacts.`);
    }
    const title = compactString(input.title, "title", 200);
    const content = compactString(input.content, "content", CHAT_ARTIFACT_MAX_CHARS);
    const format = input.format ?? "markdown";
    if (format === "json") JSON.parse(content);
    const file = artifactFormat(format);
    const artifactId = id("chat-artifact");
    const relativePath = `.archicode/artifacts/chats/${normalizedChatId}/${artifactId}.${file.extension}`;
    const now = iso();
    await writeTextAtomic(path.join(projectRoot, relativePath), content.endsWith("\n") ? content : `${content}\n`);
    const sizeBytes = (await stat(path.join(projectRoot, relativePath))).size;
    const artifact = artifactSchema.parse({
      id: artifactId,
      type: "chat-artifact",
      title,
      path: relativePath,
      chatId: normalizedChatId,
      mediaType: file.mediaType,
      summary: input.summary?.trim().slice(0, 500) || undefined,
      sizeBytes,
      revision: 1,
      createdAt: now,
      updatedAt: now
    });
    await writeJson(projectStatePath(projectRoot, "artifacts", `${artifact.id}.json`), artifact);
    return artifact;
  });
}

export async function readChatArtifact(projectRoot: string, chatId: string, artifactId: string): Promise<{ artifact: Artifact; text: string }> {
  const normalizedChatId = safeIdentifier(chatId, "chatId");
  const artifacts = await listChatArtifacts(projectRoot, normalizedChatId);
  const artifact = artifacts.find((item) => item.id === artifactId);
  if (!artifact) throw new Error(`Chat artifact ${artifactId} was not found in chat ${chatId}.`);
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(root, artifact.path);
  const expectedPrefix = path.resolve(root, ".archicode", "artifacts", "chats", normalizedChatId) + path.sep;
  if (!absolutePath.startsWith(expectedPrefix)) throw new Error("Chat artifact path is outside its session directory.");
  return { artifact, text: await readFile(absolutePath, "utf8") };
}

export async function updateChatArtifact(projectRoot: string, chatId: string, artifactId: string, input: {
  expectedRevision: number;
  title?: string;
  content?: string;
  summary?: string;
}): Promise<Artifact> {
  return withKnowledgeLock(projectRoot, async () => {
    const current = await readChatArtifact(projectRoot, chatId, artifactId);
    const revision = current.artifact.revision ?? 1;
    if (revision !== input.expectedRevision) {
      throw new Error(`Chat artifact ${artifactId} changed since it was read. Expected revision ${input.expectedRevision}, current revision is ${revision}.`);
    }
    const content = input.content === undefined
      ? current.text
      : compactString(input.content, "content", CHAT_ARTIFACT_MAX_CHARS);
    if (current.artifact.mediaType === "application/json") JSON.parse(content);
    await writeTextAtomic(path.join(projectRoot, current.artifact.path), content.endsWith("\n") ? content : `${content}\n`);
    const updated = artifactSchema.parse({
      ...current.artifact,
      title: input.title === undefined ? current.artifact.title : compactString(input.title, "title", 200),
      summary: input.summary === undefined ? current.artifact.summary : input.summary.trim().slice(0, 500) || undefined,
      sizeBytes: (await stat(path.join(projectRoot, current.artifact.path))).size,
      revision: revision + 1,
      updatedAt: iso()
    });
    await writeJson(projectStatePath(projectRoot, "artifacts", `${updated.id}.json`), updated);
    return updated;
  });
}
