import { readFile } from "node:fs/promises";
import path from "node:path";

export type ImportSourceReader = {
  read(relPath: string): Promise<Buffer | null>;
  readonly hits: number;
  readonly misses: number;
};

/** One immutable source snapshot shared by every phase of a single import. */
export function createImportSourceReader(projectRoot: string): ImportSourceReader {
  const root = path.resolve(projectRoot);
  const reads = new Map<string, Promise<Buffer | null>>();
  let hits = 0;
  let misses = 0;
  return {
    get hits() { return hits; },
    get misses() { return misses; },
    read(relPath: string): Promise<Buffer | null> {
      const absolute = path.resolve(root, relPath);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return Promise.resolve(null);
      const key = path.relative(root, absolute).split(path.sep).join("/");
      const existing = reads.get(key);
      if (existing) {
        hits += 1;
        return existing;
      }
      misses += 1;
      const pending = readFile(absolute).catch(() => null);
      reads.set(key, pending);
      return pending;
    }
  };
}
