import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Flow } from "../../shared/schema";
import { flowSchema } from "../../shared/schema";
import { flowToDisk, projectStatePath } from "../storage/persistence";
import { RESYNC_BASELINE_FILE } from "./resyncBaseline";
import { RESYNC_REPORT_DIRECTORY, RESYNC_REPORT_LATEST_FILE } from "./resyncReports";
import type { ResyncTransactionInput } from "./resyncTypes";

const TRANSACTION_DIRECTORY = "resync-transactions";

type TransactionEntry = { relativePath: string; existed: boolean };
type TransactionJournal = { version: 1; id: string; state: "prepared" | "committed"; entries: TransactionEntry[] };

function jsonBody(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function relativeFlowPath(flow: Flow): string {
  return path.posix.join("flows", `${flow.id}.json`);
}

function targetPath(projectRoot: string, relativePath: string): string {
  return projectStatePath(projectRoot, ...relativePath.split("/"));
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false);
}

async function rollbackPrepared(projectRoot: string, transactionRoot: string, journal: TransactionJournal): Promise<void> {
  for (const entry of [...journal.entries].reverse()) {
    const target = targetPath(projectRoot, entry.relativePath);
    const backup = path.join(transactionRoot, "backup", ...entry.relativePath.split("/"));
    if (entry.existed && await pathExists(backup)) {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(backup, target);
    } else if (!entry.existed) {
      await rm(target, { force: true });
    }
  }
}

export async function recoverPendingResyncTransactions(projectRoot: string): Promise<void> {
  const root = projectStatePath(projectRoot, "runtime", TRANSACTION_DIRECTORY);
  const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const transactionRoot = path.join(root, directory.name);
    const journalPath = path.join(transactionRoot, "journal.json");
    let journal: TransactionJournal | null = null;
    try {
      journal = JSON.parse(await readFile(journalPath, "utf8")) as TransactionJournal;
    } catch {
      // An incomplete staging directory has not mutated canonical files.
    }
    if (journal?.version === 1 && journal.state === "prepared") await rollbackPrepared(projectRoot, transactionRoot, journal);
    await rm(transactionRoot, { recursive: true, force: true });
  }
}

/**
 * Stage, journal, and replace all graph/baseline/report files as one recoverable
 * transaction. A thrown write or rename rolls every canonical file back; a
 * process crash is recovered before the next project load.
 */
export async function commitResyncTransaction(
  input: ResyncTransactionInput,
  hooks: { beforeReplace?: (relativePath: string, index: number) => void | Promise<void> } = {}
): Promise<void> {
  const transactionId = input.report.reportId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const transactionRoot = projectStatePath(input.projectRoot, "runtime", TRANSACTION_DIRECTORY, transactionId);
  await rm(transactionRoot, { recursive: true, force: true });
  const values = new Map<string, string>();
  for (const flow of input.flows) {
    const parsed = flowSchema.parse(flow);
    values.set(relativeFlowPath(parsed), jsonBody(flowToDisk(parsed)));
  }
  values.set(path.posix.join("runtime", RESYNC_BASELINE_FILE), jsonBody(input.baseline));
  values.set(path.posix.join("runtime", RESYNC_REPORT_LATEST_FILE), jsonBody(input.report));
  values.set(path.posix.join("runtime", RESYNC_REPORT_DIRECTORY, `${input.report.reportId}.json`), jsonBody(input.report));
  const entries: TransactionEntry[] = [];
  try {
    for (const [relativePath, body] of values) {
      const target = targetPath(input.projectRoot, relativePath);
      const staged = path.join(transactionRoot, "staged", ...relativePath.split("/"));
      const backup = path.join(transactionRoot, "backup", ...relativePath.split("/"));
      const existed = await pathExists(target);
      entries.push({ relativePath, existed });
      await mkdir(path.dirname(staged), { recursive: true });
      await writeFile(staged, body, "utf8");
      if (existed) {
        await mkdir(path.dirname(backup), { recursive: true });
        await copyFile(target, backup);
      }
    }
    const journal: TransactionJournal = { version: 1, id: transactionId, state: "prepared", entries };
    await writeFile(path.join(transactionRoot, "journal.json"), jsonBody(journal), "utf8");
    let index = 0;
    for (const entry of entries) {
      await hooks.beforeReplace?.(entry.relativePath, index++);
      const staged = path.join(transactionRoot, "staged", ...entry.relativePath.split("/"));
      const target = targetPath(input.projectRoot, entry.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(staged, target);
    }
    await writeFile(path.join(transactionRoot, "journal.json"), jsonBody({ ...journal, state: "committed" }), "utf8");
    await rm(transactionRoot, { recursive: true, force: true });
  } catch (error) {
    if (entries.length) await rollbackPrepared(input.projectRoot, transactionRoot, { version: 1, id: transactionId, state: "prepared", entries }).catch(() => undefined);
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
