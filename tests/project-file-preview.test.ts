import { describe, expect, it } from "vitest";
import { findPreviewStartLine, findSearchMatches } from "../src/renderer/src/utils/projectFilePreview";

describe("project file preview helpers", () => {
  const lines = [
    "describe('about page', () => {",
    "  it('renders a clear about page heading at /about', async () => {",
    "    expect(true).toBe(true);",
    "  });",
    "",
    "  it(",
    "    'navigation links land on landing and about pages',",
    "    async () => {",
    "      expect(true).toBe(true);",
    "    }",
    "  );",
    "});"
  ];

  it("finds the start line for a matching test name on a single line", () => {
    expect(findPreviewStartLine(lines, { matchText: "renders a clear about page heading at /about" })).toBe(2);
  });

  it("finds the start line for a matching test name across wrapped lines", () => {
    expect(findPreviewStartLine(lines, { matchText: "navigation links land on landing and about pages" })).toBe(6);
  });

  it("falls back to the first matching search query when needed", () => {
    expect(findPreviewStartLine(lines, { searchQuery: "expect(true).toBe(true);" })).toBe(3);
  });

  it("returns every case-insensitive search match with line numbers", () => {
    expect(findSearchMatches(lines, "about")).toEqual([
      { lineNumber: 1, start: 10, end: 15 },
      { lineNumber: 2, start: 22, end: 27 },
      { lineNumber: 2, start: 45, end: 50 },
      { lineNumber: 7, start: 42, end: 47 }
    ]);
  });
});
