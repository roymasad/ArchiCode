import { describe, expect, it } from "vitest";
import { reconcileProjectRoots } from "../src/main/recentProjects";

describe("recent project startup selection", () => {
  it("does not promote an older recent project when the last project is missing", () => {
    const result = reconcileProjectRoots({
      lastProjectRoot: "/projects/deleted",
      recentProjectRoots: ["/projects/deleted", "/projects/older"]
    }, (rootPath) => rootPath === "/projects/older");

    expect(result.lastProjectRoot).toBeUndefined();
    expect(result.recentProjectRoots).toEqual(["/projects/older"]);
  });

  it("keeps an existing last project as the startup project", () => {
    const existing = new Set(["/projects/current", "/projects/older"]);
    const result = reconcileProjectRoots({
      lastProjectRoot: "/projects/current",
      recentProjectRoots: ["/projects/current", "/projects/older"]
    }, (rootPath) => existing.has(rootPath));

    expect(result.lastProjectRoot).toBe("/projects/current");
    expect(result.recentProjectRoots).toEqual(["/projects/current", "/projects/older"]);
  });
});
