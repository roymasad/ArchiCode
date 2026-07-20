import path from "node:path";

export type StoredProjectRoots = {
  lastProjectRoot?: string;
  recentProjectRoots?: string[];
};

export type ReconciledProjectRoots = {
  lastProjectRoot?: string;
  recentProjectRoots: string[];
};

/**
 * Removes missing and duplicate recent projects without silently replacing the
 * last-opened project. If that specific project disappeared, startup must have
 * no default project even when older recent projects still exist.
 */
export function reconcileProjectRoots(
  state: StoredProjectRoots,
  exists: (rootPath: string) => boolean,
  limit = 8
): ReconciledProjectRoots {
  const normalizedLastRoot = state.lastProjectRoot ? path.resolve(state.lastProjectRoot) : undefined;
  const lastProjectRoot = normalizedLastRoot && exists(normalizedLastRoot) ? normalizedLastRoot : undefined;
  const candidates = [normalizedLastRoot, ...(state.recentProjectRoots ?? []).map((rootPath) => path.resolve(rootPath))]
    .filter((rootPath): rootPath is string => Boolean(rootPath));
  const seen = new Set<string>();
  const recentProjectRoots = candidates.filter((rootPath) => {
    if (seen.has(rootPath)) return false;
    seen.add(rootPath);
    return exists(rootPath);
  }).slice(0, limit);

  return { lastProjectRoot, recentProjectRoots };
}
