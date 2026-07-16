import type { ResyncReport } from "./resyncTypes";
import { projectStatePath, readJson, readJsonDirectory } from "../storage/persistence";

export const RESYNC_REPORT_LATEST_FILE = "resync-report-latest.json";
export const RESYNC_REPORT_DIRECTORY = "resync-reports";

function isResyncReport(value: unknown): value is ResyncReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<ResyncReport>;
  return typeof report.reportId === "string"
    && typeof report.completedAt === "string"
    && typeof report.durationMs === "number"
    && typeof report.baselineVersion === "number"
    && Boolean(report.patch && typeof report.patch.verifiedUnchanged === "number")
    && Boolean(report.delta && Array.isArray(report.delta.added));
}

export async function readLatestResyncReport(projectRoot: string): Promise<ResyncReport | null> {
  try {
    const value = await readJson<unknown>(projectStatePath(projectRoot, "runtime", RESYNC_REPORT_LATEST_FILE), null);
    return isResyncReport(value) ? value : null;
  } catch {
    return null;
  }
}

export async function readResyncReports(projectRoot: string): Promise<ResyncReport[]> {
  const values = await readJsonDirectory<unknown>(projectStatePath(projectRoot, "runtime", RESYNC_REPORT_DIRECTORY));
  return values.filter(isResyncReport).sort((left, right) => right.completedAt.localeCompare(left.completedAt));
}
