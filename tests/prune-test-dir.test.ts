import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneNodeTestDirectory } from "../src/main/storage/acceptanceChecks";

async function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

describe("pruneNodeTestDirectory", () => {
  it("deletes orphaned test files but keeps referenced ones", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-prune-"));
    const dir = path.join(root, ".archicode", "tests", "about-page");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "keep.test.ts"), "keep", "utf8");
    await writeFile(path.join(dir, "orphan.test.ts"), "orphan", "utf8");

    await pruneNodeTestDirectory(root, ".archicode/tests/about-page",
      new Set([".archicode/tests/about-page/keep.test.ts"]));

    expect(await fileExists(path.join(dir, "keep.test.ts"))).toBe(true);
    expect(await fileExists(path.join(dir, "orphan.test.ts"))).toBe(false);
  });

  it("never touches files outside .archicode/tests, even if referenced dir is manipulated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-prune-safety-"));
    // A real source file and a real project test — must survive untouched.
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "app.ts"), "source", "utf8");
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "tests", "real.test.ts"), "real", "utf8");

    // Attempt to prune a path that escapes .archicode/tests — must be a no-op.
    await pruneNodeTestDirectory(root, "../..", new Set());
    await pruneNodeTestDirectory(root, "tests", new Set());
    await pruneNodeTestDirectory(root, ".archicode/tests/../../src", new Set());

    expect(await readFile(path.join(root, "src", "app.ts"), "utf8")).toBe("source");
    expect(await readFile(path.join(root, "tests", "real.test.ts"), "utf8")).toBe("real");
  });

  it("no-ops when the node's test folder does not exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-prune-missing-"));
    await expect(pruneNodeTestDirectory(root, ".archicode/tests/nope", new Set())).resolves.toBeUndefined();
  });
});
