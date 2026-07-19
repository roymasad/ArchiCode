import { spawn } from "node:child_process";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  parseGitStatusPorcelain,
  type GitCommitSummary,
  type GitOperationResult,
  type GitStatus,
  type ProjectFileBrowserData,
  type ProjectFileDiff,
  type ProjectFileText,
  type ProjectFileTreeNode
} from "../shared/projectTools";

const MAX_FILE_BYTES = 300_000;
const MAX_TREE_ENTRIES = 1800;
const MAX_TREE_DEPTH = 8;
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "release",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".vite",
  ".next",
  ".turbo"
]);
const IGNORED_ARCHICODE_DIRS = new Set(["artifacts", "runs", "incidents", "summaries", "memory", "manifests", "reviews", "runtime", "tmp"]);

async function projectRealRoot(projectRoot: string): Promise<string> {
  return realpath(projectRoot);
}

async function resolveProjectPath(projectRoot: string, relativePath = ""): Promise<string> {
  const root = await projectRealRoot(projectRoot);
  const candidate = path.resolve(root, relativePath || ".");
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the project folder.");
  }
  return candidate;
}

function toProjectRelative(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

function isIgnored(relativePath: string, name: string, isDirectory: boolean): boolean {
  if (!isDirectory) return false;
  if (IGNORED_DIRS.has(name)) return true;
  if (relativePath.startsWith(".archicode/")) {
    const [, section] = relativePath.split("/");
    return IGNORED_ARCHICODE_DIRS.has(section);
  }
  return false;
}

function languageForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if ([".ts", ".tsx"].includes(ext)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if ([".json", ".jsonc"].includes(ext)) return "json";
  if ([".css", ".scss", ".sass"].includes(ext)) return "css";
  if ([".html", ".xml", ".svg"].includes(ext)) return "markup";
  if ([".md", ".mdx"].includes(ext)) return "markdown";
  if ([".py"].includes(ext)) return "python";
  if ([".java", ".kt", ".kts", ".swift", ".go", ".rs", ".c", ".cpp", ".h", ".hpp"].includes(ext)) return ext.slice(1);
  if ([".yml", ".yaml"].includes(ext)) return "yaml";
  if ([".sh", ".zsh", ".bash"].includes(ext)) return "shell";
  return "text";
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

export function runGit(projectRoot: string, args: string[]): Promise<GitOperationResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", projectRoot, ...args], { shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({
        ok: false,
        command: `git ${args.join(" ")}`,
        stdout: "",
        stderr: error.message,
        exitCode: null,
        at: new Date().toISOString()
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        ok: exitCode === 0,
        command: `git ${args.join(" ")}`,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        at: new Date().toISOString()
      });
    });
  });
}

const gitCloneTimeoutMs = 10 * 60 * 1000;

export function gitRepositoryFolderName(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  const scpPath = /^[^@\s]+@[^:\s]+:(.+)$/.exec(trimmed)?.[1];
  let repositoryPath = scpPath;
  if (!repositoryPath) {
    try {
      const parsed = new URL(trimmed);
      if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) {
        throw new Error("Unsupported Git URL protocol.");
      }
      repositoryPath = decodeURIComponent(parsed.pathname);
    } catch (error) {
      if (error instanceof Error && error.message === "Unsupported Git URL protocol.") throw error;
      throw new Error("Enter a valid Git URL, such as https://github.com/owner/repository.git or git@github.com:owner/repository.git.");
    }
  }
  const finalSegment = repositoryPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.replace(/\.git$/i, "") ?? "";
  const safeName = finalSegment.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  if (!safeName) throw new Error("The Git URL does not contain a usable repository name.");
  return safeName;
}

function safeGitCloneError(stderr: string): string {
  return stderr
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1***@")
    .trim()
    .slice(-4000);
}

export async function gitCloneRepository(remoteUrl: string, destinationParent: string): Promise<string> {
  const trimmedUrl = remoteUrl.trim();
  if (!trimmedUrl || /[\u0000-\u001f\u007f]/.test(trimmedUrl)) {
    throw new Error("Enter a valid Git URL.");
  }
  const folderName = gitRepositoryFolderName(trimmedUrl);
  const parent = await realpath(destinationParent);
  const parentStats = await stat(parent);
  if (!parentStats.isDirectory()) throw new Error("The selected clone destination is not a folder.");
  const destination = path.join(parent, folderName);
  try {
    await stat(destination);
    throw new Error(`A folder named "${folderName}" already exists in the selected destination.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists in the selected destination")) throw error;
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code && code !== "ENOENT") throw error;
  }

  const result = await new Promise<{ exitCode: number | null; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn("git", ["clone", "--", trimmedUrl, destination], {
      shell: false,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never"
      }
    });
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stderr: Buffer.concat(stderr).toString("utf8"), timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, gitCloneTimeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (stderr.reduce((sum, item) => sum + item.length, 0) > 64_000) stderr.shift();
    });
    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message));
      finish(null);
    });
    child.on("close", finish);
  });

  if (result.exitCode !== 0) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    if (result.timedOut) throw new Error("Git clone timed out after 10 minutes. Check the repository URL and network connection, then try again.");
    const detail = safeGitCloneError(result.stderr);
    if (result.exitCode === null && /ENOENT|spawn git/i.test(detail)) {
      throw new Error("Git is not installed or could not be started. Install Git and try again.");
    }
    throw new Error(detail ? `Git clone failed: ${detail}` : "Git clone failed. Check the repository URL, access permissions, and network connection.");
  }
  return destination;
}

async function requireGitRepo(projectRoot: string): Promise<string> {
  const result = await runGit(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) {
    throw new Error("No Git repository found for this project.");
  }
  return result.stdout.trim();
}

function parseGitLog(output: string): GitCommitSummary[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash = "", shortHash = "", subject = "", authorName = "", authoredAt = ""] = line.split("\u001f");
    return { hash, shortHash, subject, authorName, authoredAt };
  });
}

function parseGitStashes(output: string) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref = "", message = "", relativeTime = ""] = line.split("\u001f");
    return { ref, message, relativeTime };
  });
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [added, removed, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    if (!filePath) continue;
    counts.set(filePath, {
      additions: added === "-" ? 0 : Number(added),
      deletions: removed === "-" ? 0 : Number(removed)
    });
  }
  return counts;
}

function isSharedArchicodeStatePath(filePath: string): boolean {
  return filePath === ".archicode/project.json" ||
    filePath === ".archicode/notes.jsonl" ||
    filePath === ".archicode/graph-changes.jsonl" ||
    filePath.startsWith(".archicode/flows/");
}

export async function getGitStatus(projectRoot: string): Promise<GitStatus> {
  const root = await projectRealRoot(projectRoot);
  const repoResult = await runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!repoResult.ok) {
    return {
      isRepo: false,
      ahead: 0,
      behind: 0,
      branches: [],
      changes: [],
      recentCommits: [],
      stashes: [],
      message: "No Git repository found."
    };
  }

  const branchResult = await runGit(root, ["branch", "--format=%(refname:short)"]);
  const branches = branchResult.ok
    ? branchResult.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    : [];
  const statusResult = await runGit(root, ["status", "--porcelain=v1", "--branch"]);
  const status = parseGitStatusPorcelain(statusResult.stdout, branches);
  status.repoRoot = repoResult.stdout.trim();
  const unstagedNumstat = await runGit(root, ["diff", "--numstat"]);
  const stagedNumstat = await runGit(root, ["diff", "--cached", "--numstat"]);
  const unstagedCounts = unstagedNumstat.ok ? parseNumstat(unstagedNumstat.stdout) : new Map();
  const stagedCounts = stagedNumstat.ok ? parseNumstat(stagedNumstat.stdout) : new Map();
  status.changes = status.changes.map((change) => {
    const counts = unstagedCounts.get(change.path) ?? stagedCounts.get(change.path);
    return counts ? { ...change, ...counts } : change;
  });
  const logResult = await runGit(root, ["log", "--max-count=30", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ai"]);
  status.recentCommits = logResult.ok ? parseGitLog(logResult.stdout) : [];
  const stashResult = await runGit(root, ["stash", "list", "--format=%gd%x1f%s%x1f%cr"]);
  status.stashes = stashResult.ok ? parseGitStashes(stashResult.stdout) : [];
  const mergeHeadResult = await runGit(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  status.merging = mergeHeadResult.ok;
  return status;
}

export async function gitInit(projectRoot: string): Promise<GitOperationResult> {
  const root = await projectRealRoot(projectRoot);
  const existing = await runGit(root, ["rev-parse", "--show-toplevel"]);
  if (existing.ok) {
    return {
      ok: false,
      command: "git init",
      stdout: "",
      stderr: "This project already has a Git repository.",
      exitCode: existing.exitCode,
      at: new Date().toISOString()
    };
  }
  return runGit(root, ["init"]);
}

export async function gitPull(projectRoot: string): Promise<GitOperationResult> {
  const repoRoot = await requireGitRepo(projectRoot);
  return runGit(repoRoot, ["pull", "--ff-only"]);
}

export async function gitPush(projectRoot: string): Promise<GitOperationResult> {
  const repoRoot = await requireGitRepo(projectRoot);
  return runGit(repoRoot, ["push"]);
}

export async function gitDiscardChanges(projectRoot: string): Promise<GitOperationResult> {
  const repoRoot = await requireGitRepo(projectRoot);
  const command = "git reset --hard HEAD && git clean -fd";
  const headResult = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!headResult.ok) {
    return {
      ok: false,
      command,
      stdout: "",
      stderr: "Cannot discard changes before the first commit.",
      exitCode: headResult.exitCode,
      at: new Date().toISOString()
    };
  }
  const resetResult = await runGit(repoRoot, ["reset", "--hard", "HEAD"]);
  if (!resetResult.ok) return resetResult;
  const cleanResult = await runGit(repoRoot, ["clean", "-fd"]);
  return {
    ok: cleanResult.ok,
    command,
    stdout: [resetResult.stdout, cleanResult.stdout].filter(Boolean).join("\n"),
    stderr: [resetResult.stderr, cleanResult.stderr].filter(Boolean).join("\n"),
    exitCode: cleanResult.exitCode,
    at: cleanResult.at
  };
}

export async function gitSwitchBranch(projectRoot: string, branch: string): Promise<GitOperationResult> {
  const repoRoot = await requireGitRepo(projectRoot);
  const status = await getGitStatus(repoRoot);
  if (!status.branches.includes(branch)) {
    throw new Error("Branch was not found in this repository.");
  }
  const dirtyProjectState = status.changes.filter((change) => isSharedArchicodeStatePath(change.path));
  if (dirtyProjectState.length) {
    return {
      ok: false,
      command: `git switch ${branch}`,
      stdout: "",
      stderr: [
        "ArchiCode project graph changes are uncommitted.",
        "Commit or stash .archicode project state before switching branches so graph changes stay branch-specific.",
        `Dirty project state: ${dirtyProjectState.map((change) => change.path).join(", ")}`
      ].join("\n"),
      exitCode: 1,
      at: new Date().toISOString()
    };
  }
  return runGit(repoRoot, ["switch", branch]);
}

export async function gitStashChanges(projectRoot: string, message?: string): Promise<GitOperationResult> {
  const repoRoot = await requireGitRepo(projectRoot);
  const status = await getGitStatus(repoRoot);
  if (!status.changes.length) {
    return {
      ok: false,
      command: "git stash push -u",
      stdout: "",
      stderr: "No local changes to stash.",
      exitCode: 1,
      at: new Date().toISOString()
    };
  }
  const trimmed = message?.trim();
  return trimmed
    ? runGit(repoRoot, ["stash", "push", "-u", "-m", trimmed])
    : runGit(repoRoot, ["stash", "push", "-u"]);
}

export async function gitPopStash(projectRoot: string, stashRef: string): Promise<GitOperationResult> {
  const repoRoot = await requireGitRepo(projectRoot);
  const status = await getGitStatus(repoRoot);
  if (!status.stashes.some((stash) => stash.ref === stashRef)) {
    throw new Error("Stash was not found in this repository.");
  }
  return runGit(repoRoot, ["stash", "pop", stashRef]);
}

export async function gitCreateBranch(projectRoot: string, branch: string): Promise<GitOperationResult> {
  const repoRoot = await requireGitRepo(projectRoot);
  const trimmed = branch.trim();
  const command = `git switch -c ${trimmed}`;
  if (!trimmed) {
    throw new Error("Branch name is required.");
  }
  const validationResult = await runGit(repoRoot, ["check-ref-format", "--branch", trimmed]);
  if (!validationResult.ok) {
    return {
      ok: false,
      command,
      stdout: "",
      stderr: "Branch name is invalid.",
      exitCode: validationResult.exitCode,
      at: new Date().toISOString()
    };
  }
  const status = await getGitStatus(repoRoot);
  if (status.branches.includes(trimmed)) {
    return {
      ok: false,
      command,
      stdout: "",
      stderr: "Branch already exists.",
      exitCode: 1,
      at: new Date().toISOString()
    };
  }
  return runGit(repoRoot, ["switch", "-c", trimmed]);
}

export async function gitCommit(projectRoot: string, message: string, files: string[]): Promise<GitOperationResult> {
  const repoRoot = await requireGitRepo(projectRoot);
  const trimmed = message.trim();
  if (!trimmed) throw new Error("Commit message is required.");
  if (!files.length) throw new Error("Select at least one changed file to commit.");
  for (const file of files) {
    await resolveProjectPath(repoRoot, file);
  }
  const addResult = await runGit(repoRoot, ["add", "--", ...files]);
  if (!addResult.ok) return addResult;
  return runGit(repoRoot, ["commit", "-m", trimmed]);
}

async function readTreeNode(projectRoot: string, absolutePath: string, depth: number, counter: { count: number }): Promise<ProjectFileTreeNode | null> {
  if (counter.count >= MAX_TREE_ENTRIES) return null;
  const entryStat = await stat(absolutePath);
  const relativePath = toProjectRelative(projectRoot, absolutePath);
  const name = relativePath ? path.basename(absolutePath) : path.basename(projectRoot);
  const isDirectory = entryStat.isDirectory();
  if (relativePath && isIgnored(relativePath, name, isDirectory)) return null;
  counter.count += 1;

  if (!isDirectory) {
    return {
      name,
      path: relativePath,
      type: "file",
      size: entryStat.size
    };
  }

  const node: ProjectFileTreeNode = {
    name: relativePath ? name : path.basename(projectRoot),
    path: relativePath,
    type: "directory",
    children: []
  };

  if (depth >= MAX_TREE_DEPTH || counter.count >= MAX_TREE_ENTRIES) {
    node.truncated = true;
    return node;
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of sorted) {
    if (counter.count >= MAX_TREE_ENTRIES) {
      node.truncated = true;
      break;
    }
    const child = await readTreeNode(projectRoot, path.join(absolutePath, entry.name), depth + 1, counter);
    if (child) node.children?.push(child);
  }
  return node;
}

export async function listProjectFiles(projectRoot: string): Promise<ProjectFileBrowserData> {
  const root = await projectRealRoot(projectRoot);
  const tree = await readTreeNode(root, root, 0, { count: 0 });
  if (!tree) throw new Error("Project folder could not be read.");
  return {
    tree,
    gitStatus: await getGitStatus(root)
  };
}

export async function readProjectFile(projectRoot: string, relativePath: string): Promise<ProjectFileText> {
  const root = await projectRealRoot(projectRoot);
  const absolutePath = await resolveProjectPath(root, relativePath);
  const entryStat = await stat(absolutePath);
  if (!entryStat.isFile()) throw new Error("Only files can be previewed.");
  const full = await readFile(absolutePath);
  const truncated = full.length > MAX_FILE_BYTES;
  const buffer = truncated ? full.subarray(0, MAX_FILE_BYTES) : full;
  const binary = looksBinary(buffer);
  return {
    path: relativePath,
    content: binary ? "" : buffer.toString("utf8"),
    size: entryStat.size,
    language: languageForPath(relativePath),
    truncated,
    binary
  };
}

export async function readProjectFileDiff(projectRoot: string, relativePath: string): Promise<ProjectFileDiff> {
  const root = await projectRealRoot(projectRoot);
  await resolveProjectPath(root, relativePath);
  const status = await getGitStatus(root);
  if (!status.isRepo) {
    return {
      path: relativePath,
      diff: ""
    };
  }
  const staged = await runGit(root, ["diff", "--cached", "--", relativePath]);
  const unstaged = await runGit(root, ["diff", "--", relativePath]);
  const diff = [
    staged.stdout ? "# Staged changes\n" + staged.stdout : "",
    unstaged.stdout ? "# Working tree changes\n" + unstaged.stdout : ""
  ].filter(Boolean).join("\n");
  return {
    path: relativePath,
    diff
  };
}
