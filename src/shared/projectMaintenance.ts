export type ProjectMaintenanceTask = "semantic-index" | "code-knowledge";

export type ProjectMaintenanceReason = "ai-run" | "external-change" | "initial" | "retry";

export type ProjectMaintenanceChangedFile = {
  path: string;
  change: "added" | "modified" | "deleted";
};

export type ProjectMaintenanceStatus = {
  projectRoot: string;
  state: "idle" | "scheduled" | "running" | "error";
  tasks: ProjectMaintenanceTask[];
  reason?: ProjectMaintenanceReason;
  message: string;
  graphAnalysisMayBeOutdated: boolean;
  changedFiles: ProjectMaintenanceChangedFile[];
  updatedAt: string;
  error?: string;
};

export function projectMaintenanceChangesBetweenHashes(
  baseline: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  candidates = new Set([...baseline.keys(), ...current.keys()])
): ProjectMaintenanceChangedFile[] {
  return [...candidates].flatMap((relativePath): ProjectMaintenanceChangedFile[] => {
    const before = baseline.get(relativePath);
    const after = current.get(relativePath);
    if (before === after) return [];
    return [{
      path: relativePath,
      change: before === undefined ? "added" : after === undefined ? "deleted" : "modified"
    }];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function mergeProjectMaintenanceChanges(
  existing: ProjectMaintenanceChangedFile[],
  incoming: ProjectMaintenanceChangedFile[]
): ProjectMaintenanceChangedFile[] {
  const merged = new Map(existing.map((item) => [item.path, item.change]));
  for (const item of incoming) {
    const previous = merged.get(item.path);
    if (previous === "added" && item.change === "deleted") merged.set(item.path, "deleted");
    else if (previous === "deleted" && item.change === "added") merged.set(item.path, "modified");
    else if (previous === "added") merged.set(item.path, "added");
    else merged.set(item.path, item.change);
  }
  return [...merged].map(([relativePath, change]) => ({ path: relativePath, change }))
    .sort((left, right) => left.path.localeCompare(right.path));
}
