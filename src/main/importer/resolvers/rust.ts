import { readFile } from "node:fs/promises";
import path from "node:path";

export type RustCrate = {
  name: string;
  dir: string;
  srcDir: string;
};

export type RustResolverContext = {
  fileSet: Set<string>;
  crates: RustCrate[];
};

export type RustResolution =
  | { kind: "file"; relPath: string }
  | { kind: "external"; packageName: string }
  | null;

const RUST_BUILTIN_CRATES = new Set(["std", "core", "alloc", "proc_macro", "test"]);

async function readCrate(projectRoot: string, dir: string): Promise<RustCrate | null> {
  const text = await readFile(path.join(projectRoot, dir, "Cargo.toml"), "utf8").catch(() => null);
  if (text === null) return null;
  const packageSection = text.split(/^\[/m).find((section) => section.startsWith("package]"));
  const nameMatch = packageSection?.match(/^name\s*=\s*"([^"]+)"/m);
  const name = nameMatch ? nameMatch[1] : path.posix.basename(dir || ".");
  return { name: name.replace(/-/g, "_"), dir, srcDir: dir ? `${dir}/src` : "src" };
}

export async function buildRustResolverContext(projectRoot: string, filePaths: string[]): Promise<RustResolverContext> {
  const cargoDirs = filePaths
    .filter((filePath) => path.posix.basename(filePath) === "Cargo.toml")
    .map((filePath) => path.posix.dirname(filePath))
    .map((dir) => (dir === "." ? "" : dir));
  const crates = (await Promise.all(cargoDirs.map((dir) => readCrate(projectRoot, dir))))
    .filter((crate): crate is RustCrate => Boolean(crate));
  return { fileSet: new Set(filePaths), crates };
}

function crateEntryFile(context: RustResolverContext, crate: RustCrate): string | null {
  for (const candidate of [`${crate.srcDir}/lib.rs`, `${crate.srcDir}/main.rs`]) {
    if (context.fileSet.has(candidate)) return candidate;
  }
  return null;
}

function crateForFile(context: RustResolverContext, fromFile: string): RustCrate | null {
  let best: RustCrate | null = null;
  for (const crate of context.crates) {
    const prefix = crate.dir ? `${crate.dir}/` : "";
    if (!fromFile.startsWith(prefix)) continue;
    if (!best || crate.dir.length > best.dir.length) best = crate;
  }
  return best;
}

/** Resolve a module path segment list from a base directory: deepest existing a/b.rs or a/b/mod.rs wins. */
function probeModulePath(fileSet: Set<string>, baseDir: string, segments: string[]): string | null {
  for (let take = segments.length; take >= 1; take -= 1) {
    const joined = path.posix.join(baseDir, ...segments.slice(0, take));
    if (fileSet.has(`${joined}.rs`)) return `${joined}.rs`;
    if (fileSet.has(`${joined}/mod.rs`)) return `${joined}/mod.rs`;
  }
  return null;
}

export function resolveRustImport(
  context: RustResolverContext,
  fromFile: string,
  specifier: string,
  kind: string
): RustResolution {
  const spec = specifier.trim();
  if (!spec) return null;

  if (kind === "mod") {
    const dir = path.posix.dirname(fromFile);
    const base = path.posix.basename(fromFile);
    // mod declarations in foo.rs (not mod.rs/lib.rs/main.rs) look in foo/.
    const searchDir = ["mod.rs", "lib.rs", "main.rs"].includes(base) ? dir : path.posix.join(dir, base.replace(/\.rs$/, ""));
    for (const candidate of [`${searchDir}/${spec}.rs`, `${searchDir}/${spec}/mod.rs`, `${dir}/${spec}.rs`, `${dir}/${spec}/mod.rs`]) {
      if (context.fileSet.has(candidate)) return { kind: "file", relPath: candidate };
    }
    return null;
  }

  const cleaned = spec.replace(/\{[\s\S]*\}/, "").replace(/::\s*$/, "").replace(/\s+as\s+\w+$/, "");
  const segments = cleaned.split("::").map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) return null;
  const head = segments[0];
  const crate = crateForFile(context, fromFile);

  if (head === "crate" && crate) {
    const resolved = probeModulePath(context.fileSet, crate.srcDir, segments.slice(1));
    if (resolved) return { kind: "file", relPath: resolved };
    const entry = crateEntryFile(context, crate);
    return entry ? { kind: "file", relPath: entry } : null;
  }
  if (head === "self") {
    const resolved = probeModulePath(context.fileSet, path.posix.dirname(fromFile), segments.slice(1));
    return resolved ? { kind: "file", relPath: resolved } : null;
  }
  if (head === "super") {
    let baseDir = path.posix.dirname(fromFile);
    let index = 0;
    while (segments[index] === "super") {
      baseDir = path.posix.dirname(baseDir);
      index += 1;
    }
    const resolved = probeModulePath(context.fileSet, baseDir, segments.slice(index));
    return resolved ? { kind: "file", relPath: resolved } : null;
  }
  if (RUST_BUILTIN_CRATES.has(head)) return { kind: "external", packageName: head };

  const workspaceCrate = context.crates.find((candidate) => candidate.name === head);
  if (workspaceCrate) {
    const resolved = probeModulePath(context.fileSet, workspaceCrate.srcDir, segments.slice(1));
    if (resolved) return { kind: "file", relPath: resolved };
    const entry = crateEntryFile(context, workspaceCrate);
    if (entry) return { kind: "file", relPath: entry };
    return null;
  }
  return { kind: "external", packageName: head };
}
