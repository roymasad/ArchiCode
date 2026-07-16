export type FilePreviewNavigationTarget = {
  lineNumber?: number | null;
  matchText?: string | null;
  searchQuery?: string | null;
};

export type FileSearchMatch = {
  lineNumber: number;
  start: number;
  end: number;
};

const TEST_CALL_PATTERNS = [
  /\b(?:it|test)(?:\.[a-zA-Z]+)*\s*\(/,
  /\bdescribe(?:\.[a-zA-Z]+)*\s*\(/
];

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findFirstContainingLine(lines: string[], needle: string): number | null {
  const normalizedNeedle = normalizeSearchText(needle);
  if (!normalizedNeedle) return null;
  for (let index = 0; index < lines.length; index += 1) {
    if (normalizeSearchText(lines[index] ?? "").includes(normalizedNeedle)) return index + 1;
  }
  return null;
}

function findTestCallLine(lines: string[], testName: string): number | null {
  const normalizedNeedle = normalizeSearchText(testName);
  if (!normalizedNeedle) return null;
  for (const pattern of TEST_CALL_PATTERNS) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!pattern.test(line)) continue;
      const windowText = lines.slice(index, index + 4).join(" ");
      if (normalizeSearchText(windowText).includes(normalizedNeedle)) return index + 1;
    }
  }
  return findFirstContainingLine(lines, testName);
}

export function findPreviewStartLine(lines: string[], target?: FilePreviewNavigationTarget | null): number | null {
  if (!lines.length || !target) return null;
  if (Number.isFinite(target.lineNumber)) {
    const lineNumber = Math.trunc(target.lineNumber as number);
    return Math.min(lines.length, Math.max(1, lineNumber));
  }
  if (target.matchText) {
    const testLine = findTestCallLine(lines, target.matchText);
    if (testLine) return testLine;
  }
  if (target.searchQuery) return findFirstContainingLine(lines, target.searchQuery);
  return null;
}

export function findSearchMatches(lines: string[], query: string): FileSearchMatch[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const pattern = new RegExp(escapeRegExp(trimmed), "gi");
  const matches: FileSearchMatch[] = [];
  lines.forEach((line, index) => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(line)) !== null) {
      matches.push({
        lineNumber: index + 1,
        start: match.index,
        end: match.index + match[0].length
      });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  });
  return matches;
}

export function lineHasSearchMatch(matches: FileSearchMatch[], lineNumber: number): boolean {
  return matches.some((match) => match.lineNumber === lineNumber);
}
