import type { ModuleCluster, ParsedFile } from "./types";

const KIND_WEIGHT: Record<string, number> = {
  component: 9,
  class: 8,
  interface: 7,
  trait: 7,
  struct: 7,
  function: 6,
  enum: 5,
  type: 4,
  method: 3,
  symbol: 2
};

/** Keep important public symbols available even when a cluster contains hundreds of files. */
export function rankClusterSymbolRefs(
  files: string[],
  parsedByFile: Map<string, ParsedFile>,
  fileScore: (file: string) => number,
  limit = 12
): NonNullable<ModuleCluster["symbolRefs"]> {
  const ranked = files.flatMap((file) => (parsedByFile.get(file)?.symbolRefs ?? []).map((symbol, position) => ({
    path: file,
    ...symbol,
    score: fileScore(file) * 100 + (KIND_WEIGHT[symbol.kind] ?? 0) - position / 100
  })));
  ranked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.name.localeCompare(right.name));
  const seen = new Set<string>();
  const selected: NonNullable<ModuleCluster["symbolRefs"]> = [];
  for (const { score: _score, ...symbol } of ranked) {
    const key = `${symbol.path}\u0000${symbol.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(symbol);
    if (selected.length >= limit) break;
  }
  return selected;
}
