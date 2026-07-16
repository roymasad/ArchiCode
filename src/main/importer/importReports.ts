import type { CodebaseMappingSummary } from "../research";
import { projectStatePath, readJson, writeJson } from "../storage/persistence";

const INITIAL_IMPORT_REPORT_FILE = "initial-import-report.json";

function isImportReport(value: unknown): value is CodebaseMappingSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<CodebaseMappingSummary>;
  return typeof report.reportId === "string"
    && typeof report.completedAt === "string"
    && typeof report.durationMs === "number"
    && Boolean(report.graph && typeof report.graph.flows === "number")
    && Boolean(report.files && typeof report.files.scanned === "number");
}

export async function writeInitialCodebaseImportReport(projectRoot: string, report: CodebaseMappingSummary): Promise<void> {
  await writeJson(projectStatePath(projectRoot, "runtime", INITIAL_IMPORT_REPORT_FILE), report);
}

export async function readInitialCodebaseImportReport(projectRoot: string): Promise<CodebaseMappingSummary | null> {
  const report = await readJson<unknown>(projectStatePath(projectRoot, "runtime", INITIAL_IMPORT_REPORT_FILE), null);
  return isImportReport(report) ? report : null;
}
