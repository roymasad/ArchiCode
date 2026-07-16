import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export const PROJECT_STATE_DIR = ".archicode";

export function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function iso(): string {
  return new Date().toISOString();
}

export function projectStatePath(projectRoot: string, ...segments: string[]): string {
  return path.join(projectRoot, PROJECT_STATE_DIR, ...segments);
}

export function safeParseOptional<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> | undefined {
  if (value === undefined) return undefined;
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function definedOnly<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  if (!(await exists(filePath))) return fallback;
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  return (isFlowStateFile(filePath) ? flowFromDisk(parsed) : parsed) as T;
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  if (!(await exists(filePath))) return null;
  return readFile(filePath, "utf8");
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const serializedValue = isFlowStateFile(filePath)
    ? flowToDisk(value)
    : isSharedProjectFile(filePath)
      ? projectToDisk(value)
      : value;
  const body = `${JSON.stringify(serializedValue, null, 2)}\n`;
  if (await exists(filePath)) {
    const current = await readFile(filePath, "utf8");
    if (current === body) return;
  }
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  await writeFile(temporaryPath, body, "utf8");
  await replaceFileWithRetry(temporaryPath, filePath);
}

export function isFlowStateFile(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join("/");
  return normalized.includes(`/${PROJECT_STATE_DIR}/flows/`) && normalized.endsWith(".json");
}

export function isSharedProjectFile(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join("/");
  return normalized.endsWith(`/${PROJECT_STATE_DIR}/project.json`);
}

export function projectToDisk(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const { updatedAt: _updatedAt, ...withoutTimestamp } = value as Record<string, unknown>;
  return withoutTimestamp;
}

export function keyedValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  // Insertion order is load-bearing: layout, flag reconciliation, and graph
  // mutations all depend on entity array order, so disk keys must round-trip
  // in file order rather than being re-sorted.
  return Object.keys(value as Record<string, unknown>)
    .map((key) => (value as Record<string, unknown>)[key]);
}

export function flowFromDisk(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const flow = value as Record<string, unknown>;
  return {
    ...flow,
    nodes: keyedValues(flow.nodes),
    edges: keyedValues(flow.edges),
    subflows: keyedValues(flow.subflows),
    groups: keyedValues(flow.groups)
  };
}

export function keyedById(values: unknown): Record<string, unknown> {
  if (!Array.isArray(values)) return {};
  // Keys keep the array's insertion order (see keyedValues). Entity ids are
  // non-numeric strings ("node-…"), so JSON object key order round-trips; a
  // purely numeric id would be reordered by JS integer-key rules.
  return Object.fromEntries(values
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string")
    .map((value) => {
      const { updatedAt: _updatedAt, ...withoutTimestamp } = value;
      return [String(value.id), withoutTimestamp];
    }));
}

function flowEdgesToDisk(values: unknown): Record<string, unknown> {
  if (!Array.isArray(values)) return {};
  return Object.fromEntries(values
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string")
    .map((value) => {
      const { updatedAt: _updatedAt, evidence, ...edge } = value;
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [String(value.id), edge];
      // Refresh time and freshness are workstation observations, not durable
      // architectural facts. Keeping them out of shared flow JSON prevents an
      // app open or local file edit from creating collaborator merge conflicts.
      const { checkedAt: _checkedAt, freshness: _freshness, ...sharedEvidence } = evidence as Record<string, unknown>;
      return [String(value.id), { ...edge, evidence: sharedEvidence }];
    }));
}

export function flowToDisk(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const flow = value as Record<string, unknown>;
  const { updatedAt: _updatedAt, ...withoutTimestamp } = flow;
  return {
    ...withoutTimestamp,
    nodes: keyedById(flow.nodes),
    edges: flowEdgesToDisk(flow.edges),
    subflows: keyedById(flow.subflows),
    groups: keyedById(flow.groups)
  };
}

export async function readJsonLines<T>(filePath: string): Promise<T[]> {
  if (!(await exists(filePath))) return [];
  const text = await readFile(filePath, "utf8");
  const values: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      values.push(JSON.parse(trimmed) as T);
    } catch {
      // Ignore malformed partial lines; the next successful write restores the ledger.
    }
  }
  return values;
}

export async function writeJsonLines(filePath: string, values: unknown[]): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  await writeFile(temporaryPath, body ? `${body}\n` : "", "utf8");
  await replaceFileWithRetry(temporaryPath, filePath);
}

export async function replaceFileWithRetry(temporaryPath: string, filePath: string): Promise<void> {
  let waitMs = 25;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temporaryPath, filePath);
      return;
    } catch (error) {
      if (!isRetryableReplaceError(error) || attempt === 5) throw error;
      await delay(waitMs);
      waitMs *= 2;
    }
  }
}

export function isRetryableReplaceError(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function safeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export async function readJsonDirectory<T>(dirPath: string): Promise<T[]> {
  if (!(await exists(dirPath))) return [];
  const files = (await readdir(dirPath)).filter((entry) => entry.endsWith(".json")).sort();
  const values: T[] = [];
  for (const file of files) {
    try {
      const filePath = path.join(dirPath, file);
      const value = await readJson<T | null>(filePath, null);
      if (value !== null) values.push(value);
    } catch {
      // A run update can briefly observe an artifact while another async task is writing it.
      // The next reload will pick it up once the JSON is complete.
    }
  }
  return values;
}

export function safeParseOne<T>(
  label: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } },
  value: unknown,
  errors: string[]
): T | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  errors.push(...parsed.error.issues.map((issue) => `${label}: ${issue.path.join(".")} ${issue.message}`));
  return null;
}

export function safeParseMany<T>(
  label: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } },
  value: unknown,
  errors: string[]
): T[] {
  const parsed = schema.safeParse(value);
  if (parsed.success) return [parsed.data];
  errors.push(...parsed.error.issues.map((issue) => `${label}: ${issue.path.join(".")} ${issue.message}`));
  return [];
}

export async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}
