import type { ArchicodeNode, Flow, Note, Project, ProjectBundle } from "../shared/schema";
import { flowSchema, noteSchema, projectBundleSchema, projectSchema } from "../shared/schema";
import type { GraphHistoryEntry, GraphHistoryPage, GraphHistoryPageOptions, GraphHistoryVersion, GraphNodeHistory, GraphNodeHistoryChange, HistoricalGraphBundle } from "../shared/graphHistory";
import type { ProjectFileBrowserData, ProjectFileText, ProjectFileTreeNode } from "../shared/projectTools";
import { flowFromDisk } from "./storage/persistence";
import { canonicalSemanticNode, computeGraphVersion, semanticNodeChangedFields, semanticNodeValue } from "./storage/graphVersion";
import { runGit } from "./projectTools";

const MAX_NODE_HISTORY_COMMITS = 500;
const DEFAULT_GRAPH_HISTORY_PAGE_SIZE = 20;
const MAX_GRAPH_HISTORY_PAGE_SIZE = 100;
const MAX_FILE_BYTES = 300_000;
const MAX_TREE_ENTRIES = 1800;
const MAX_NODE_HISTORY_CACHE_ENTRIES = 500;
const nodeHistoryCache = new Map<string, GraphNodeHistory>();

function historicalPath(relativePath: string): string {
  const candidate = relativePath.trim().replaceAll("\\", "/");
  const normalized = candidate ? candidate.split("/").filter((part) => part && part !== ".").join("/") : "";
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error("Historical file path must stay inside the project.");
  }
  return normalized;
}

function historicalLanguage(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx"].includes(extension)) return "typescript";
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return "javascript";
  if (["json", "jsonc"].includes(extension)) return "json";
  if (["md", "mdx"].includes(extension)) return "markdown";
  if (["css", "scss", "sass"].includes(extension)) return "css";
  if (["html", "xml", "svg"].includes(extension)) return "markup";
  if (["yml", "yaml"].includes(extension)) return "yaml";
  if (["sh", "zsh", "bash"].includes(extension)) return "shell";
  return extension || "text";
}

async function requireCommit(projectRoot: string, revision: string): Promise<string> {
  const candidate = revision.trim();
  if (!candidate) throw new Error("A Git commit is required.");
  const result = await runGit(projectRoot, ["rev-parse", "--verify", `${candidate}^{commit}`]);
  if (!result.ok) throw new Error("The selected Git commit is no longer available.");
  return result.stdout.trim();
}

async function showFile(projectRoot: string, commit: string, relativePath: string): Promise<string | null> {
  const result = await runGit(projectRoot, ["show", `${commit}:${relativePath}`]);
  return result.ok ? result.stdout : null;
}

async function readHistoricalFlows(projectRoot: string, commit: string): Promise<Flow[]> {
  const tree = await runGit(projectRoot, ["ls-tree", "-r", "--name-only", commit, "--", ".archicode/flows"]);
  if (!tree.ok) return [];
  const paths = tree.stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.endsWith(".json"));
  const flows: Flow[] = [];
  for (const filePath of paths) {
    const text = await showFile(projectRoot, commit, filePath);
    if (!text) continue;
    const parsed = flowSchema.safeParse(flowFromDisk(JSON.parse(text)));
    if (parsed.success) flows.push(parsed.data);
  }
  return flows;
}

function readHistoricalNotes(text: string | null): Note[] {
  if (!text) return [];
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = noteSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

async function commitMetadata(projectRoot: string, commit: string): Promise<Omit<GraphHistoryEntry, "graphVersion" | "flowCount" | "nodeCount" | "edgeCount">> {
  const result = await runGit(projectRoot, ["show", "-s", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI", commit]);
  if (!result.ok) throw new Error(result.stderr || "Unable to inspect Git history.");
  const [full, short, subject, author, committedAt] = result.stdout.trim().split("\u001f");
  return { commit: full, shortCommit: short, subject, author, committedAt };
}

async function readHistoricalProject(projectRoot: string, commit: string): Promise<{ project: Project; flows: Flow[] } | null> {
  const projectText = await showFile(projectRoot, commit, ".archicode/project.json");
  if (!projectText) return null;
  const flows = await readHistoricalFlows(projectRoot, commit);
  const parsed = projectSchema.safeParse({ ...JSON.parse(projectText), rootPath: projectRoot });
  if (!parsed.success) return null;
  const graphVersion = computeGraphVersion(flows);
  return { project: projectSchema.parse({ ...parsed.data, graphVersion }), flows };
}

export async function loadHistoricalGraphBundle(projectRoot: string, revision: string): Promise<HistoricalGraphBundle> {
  const commit = await requireCommit(projectRoot, revision);
  const historical = await readHistoricalProject(projectRoot, commit);
  if (!historical) throw new Error("This commit does not contain a readable ArchiCode graph.");
  const metadata = await commitMetadata(projectRoot, commit);
  const graphVersion = historical.project.graphVersion!;
  const entry: GraphHistoryEntry = {
    ...metadata,
    graphVersion,
    flowCount: historical.flows.length,
    nodeCount: historical.flows.reduce((sum, flow) => sum + flow.nodes.length, 0),
    edgeCount: historical.flows.reduce((sum, flow) => sum + flow.edges.length, 0)
  };
  const notes = readHistoricalNotes(await showFile(projectRoot, commit, ".archicode/notes.jsonl"));
  const bundle: ProjectBundle = projectBundleSchema.parse({
    rootPath: projectRoot,
    project: historical.project,
    flows: historical.flows,
    notes,
    incidents: [],
    runs: [],
    artifacts: [],
    summaries: [],
    graphChanges: [],
    policyEvaluation: null,
    validationErrors: []
  });
  return { entry, bundle };
}

async function countStoredGraphVersions(projectRoot: string): Promise<number | null> {
  const result = await runGit(projectRoot, [
    "log",
    "--first-parent",
    "-G\"graphVersion\"[[:space:]]*:",
    "--format=%H",
    "--",
    ".archicode/project.json"
  ]);
  if (!result.ok) return null;
  return result.stdout.split(/\r?\n/).filter(Boolean).length;
}

export async function listGraphHistory(projectRoot: string, options: GraphHistoryPageOptions = {}): Promise<GraphHistoryPage> {
  const limit = Math.max(1, Math.min(MAX_GRAPH_HISTORY_PAGE_SIZE, Math.floor(options.limit ?? DEFAULT_GRAPH_HISTORY_PAGE_SIZE)));
  const format = "%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e";
  const cursor = options.cursor?.trim() || null;
  const revisionArgs = cursor ? ["--skip=1", cursor] : [];
  const log = await runGit(projectRoot, ["log", "--first-parent", `--max-count=${limit + 1}`, `--format=${format}`, ...revisionArgs]);
  if (!log.ok) return { versions: [], nextCursor: null, hasMore: false, newestVersionNumber: null };
  const records = log.stdout.split("\u001e").map((record) => record.trim()).filter(Boolean);
  const pageRecords = records.slice(0, limit);
  const hasMore = records.length > limit;
  const entries: GraphHistoryEntry[] = [];
  const countsByVersion = new Map<string, Pick<GraphHistoryEntry, "flowCount" | "nodeCount" | "edgeCount">>();
  for (const record of pageRecords) {
    const [commit, shortCommit, subject, author, committedAt] = record.trim().split("\u001f");
    if (!commit) continue;
    try {
      const projectText = await showFile(projectRoot, commit, ".archicode/project.json");
      if (!projectText) continue;
      let graphVersion: string | undefined;
      try {
        const stored = (JSON.parse(projectText) as { graphVersion?: unknown }).graphVersion;
        if (typeof stored === "string" && /^sha256:[0-9a-f]{64}$/.test(stored)) graphVersion = stored;
      } catch {
        // Fall through to content-derived versions for older snapshots.
      }
      let counts = graphVersion ? countsByVersion.get(graphVersion) : undefined;
      if (!graphVersion || !counts) {
        const historical = await readHistoricalProject(projectRoot, commit);
        if (!historical) continue;
        graphVersion = historical.project.graphVersion!;
        counts = {
          flowCount: historical.flows.length,
          nodeCount: historical.flows.reduce((sum, flow) => sum + flow.nodes.length, 0),
          edgeCount: historical.flows.reduce((sum, flow) => sum + flow.edges.length, 0)
        };
        countsByVersion.set(graphVersion, counts);
      }
      entries.push({ commit, shortCommit, subject, author, committedAt, graphVersion, ...counts });
    } catch {
      // Commits from before ArchiCode metadata existed are not graph snapshots.
    }
  }
  const versions: GraphHistoryVersion[] = [];
  for (const entry of entries) {
    const current = versions[versions.length - 1];
    if (current?.graphVersion === entry.graphVersion) current.commits.push(entry);
    else versions.push({ graphVersion: entry.graphVersion, commits: [entry], latest: entry });
  }
  const newestVersionNumber = cursor ? null : await countStoredGraphVersions(projectRoot);
  if (newestVersionNumber !== null) {
    versions.forEach((version, index) => {
      version.versionNumber = newestVersionNumber - index;
    });
  }
  return {
    versions,
    nextCursor: hasMore ? pageRecords.at(-1)?.split("\u001f")[0] ?? null : null,
    hasMore,
    newestVersionNumber
  };
}

export async function readHistoricalProjectFile(projectRoot: string, revision: string, relativePath: string): Promise<ProjectFileText> {
  const commit = await requireCommit(projectRoot, revision);
  const filePath = historicalPath(relativePath);
  const text = await showFile(projectRoot, commit, filePath);
  if (text === null) throw new Error(`File was not present at ${commit.slice(0, 7)}: ${filePath}`);
  const size = Buffer.byteLength(text);
  const binary = text.includes("\0");
  const truncated = size > MAX_FILE_BYTES;
  const content = binary ? "" : truncated ? Buffer.from(text).subarray(0, MAX_FILE_BYTES).toString("utf8") : text;
  return { path: filePath, content, size, language: historicalLanguage(filePath), truncated, binary };
}

function treeFromPaths(projectRoot: string, paths: string[]): ProjectFileTreeNode {
  const root: ProjectFileTreeNode = { name: projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "project", path: "", type: "directory", children: [] };
  let count = 0;
  for (const filePath of paths) {
    if (count >= MAX_TREE_ENTRIES) {
      root.truncated = true;
      break;
    }
    const parts = filePath.split("/").filter(Boolean);
    let parent = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]!;
      const entryPath = parts.slice(0, index + 1).join("/");
      const isFile = index === parts.length - 1;
      let child = parent.children?.find((item) => item.name === name);
      if (!child) {
        child = { name, path: entryPath, type: isFile ? "file" : "directory", ...(isFile ? {} : { children: [] }) };
        parent.children?.push(child);
        count += 1;
      }
      parent = child;
    }
  }
  const sort = (node: ProjectFileTreeNode) => {
    node.children?.sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1);
    node.children?.forEach(sort);
  };
  sort(root);
  return root;
}

export async function listHistoricalProjectFiles(projectRoot: string, revision: string): Promise<ProjectFileBrowserData> {
  const commit = await requireCommit(projectRoot, revision);
  const result = await runGit(projectRoot, ["ls-tree", "-r", "--name-only", commit]);
  if (!result.ok) throw new Error(result.stderr || "Unable to read historical project files.");
  const paths = result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return {
    tree: treeFromPaths(projectRoot, paths),
    gitStatus: {
      isRepo: true,
      currentBranch: `historical:${commit.slice(0, 7)}`,
      ahead: 0,
      behind: 0,
      branches: [],
      changes: [],
      recentCommits: [],
      stashes: []
    }
  };
}

type NodeHistoryCommit = {
  commit: string;
  shortCommit: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
};

function parseNodeHistoryLog(text: string): NodeHistoryCommit[] {
  return text.split("\u001e").flatMap((record) => {
    const trimmed = record.trim();
    if (!trimmed) return [];
    const [commit, shortCommit, subject, authorName, authorEmail, committerName, committerEmail, committedAt] = trimmed.split("\u001f");
    if (!commit || !shortCommit) return [];
    return [{ commit, shortCommit, subject, authorName, authorEmail, committerName, committerEmail, committedAt }];
  });
}

async function readNodeAtCommit(projectRoot: string, commit: string, flowId: string, nodeId: string): Promise<ArchicodeNode | null> {
  const text = await showFile(projectRoot, commit, `.archicode/flows/${flowId}.json`);
  if (!text) return null;
  try {
    const parsed = flowSchema.safeParse(flowFromDisk(JSON.parse(text)));
    return parsed.success ? parsed.data.nodes.find((node) => node.id === nodeId) ?? null : null;
  } catch {
    return null;
  }
}

async function graphVersionAtCommit(projectRoot: string, commit: string): Promise<string | undefined> {
  const text = await showFile(projectRoot, commit, ".archicode/project.json");
  if (text) {
    try {
      const value = (JSON.parse(text) as { graphVersion?: unknown }).graphVersion;
      if (typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)) return value;
    } catch {
      // Fall through to content-derived versions for commits predating graphVersion.
    }
  }
  return (await readHistoricalProject(projectRoot, commit))?.project.graphVersion;
}

function nodeHistoryChange(
  metadata: NodeHistoryCommit,
  kind: GraphNodeHistoryChange["kind"],
  changedFields: string[],
  graphVersion?: string
): GraphNodeHistoryChange {
  const committerDiffers = metadata.authorName !== metadata.committerName || metadata.authorEmail !== metadata.committerEmail;
  return {
    kind,
    commit: metadata.commit,
    shortCommit: metadata.shortCommit,
    subject: metadata.subject,
    committedAt: metadata.committedAt,
    author: { name: metadata.authorName, email: metadata.authorEmail || undefined },
    committer: committerDiffers ? { name: metadata.committerName, email: metadata.committerEmail || undefined } : undefined,
    graphVersion,
    changedFields
  };
}

export async function getGraphNodeHistory(
  projectRoot: string,
  revision: string,
  flowId: string,
  nodeId: string
): Promise<GraphNodeHistory> {
  let commit: string;
  try {
    commit = await requireCommit(projectRoot, revision);
  } catch {
    return { available: false, flowId, nodeId, changes: [], message: "Git attribution is unavailable until this graph is committed." };
  }
  const cacheKey = `${projectRoot}\u0000${commit}\u0000${flowId}\u0000${nodeId}`;
  const cached = nodeHistoryCache.get(cacheKey);
  if (cached) return cached;
  const flowPath = `.archicode/flows/${flowId}.json`;
  const format = "%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%aI%x1e";
  const log = await runGit(projectRoot, [
    "log", "--first-parent", "--reverse", `--max-count=${MAX_NODE_HISTORY_COMMITS}`, `--format=${format}`, commit, "--", flowPath
  ]);
  if (!log.ok) return { available: false, flowId, nodeId, revision: commit, changes: [], message: "No Git history is available for this node." };

  let previous: ArchicodeNode | null = null;
  const changes: GraphNodeHistoryChange[] = [];
  for (const metadata of parseNodeHistoryLog(log.stdout)) {
    const current = await readNodeAtCommit(projectRoot, metadata.commit, flowId, nodeId);
    let kind: GraphNodeHistoryChange["kind"] | null = null;
    let changedFields: string[] = [];
    if (!previous && current) {
      kind = "introduced";
      changedFields = Object.keys(semanticNodeValue(current)).sort();
    } else if (previous && !current) {
      kind = "removed";
    } else if (previous && current && canonicalSemanticNode(previous) !== canonicalSemanticNode(current)) {
      kind = "modified";
      changedFields = semanticNodeChangedFields(previous, current);
    }
    if (kind) changes.push(nodeHistoryChange(metadata, kind, changedFields, await graphVersionAtCommit(projectRoot, metadata.commit)));
    previous = current;
  }

  const history: GraphNodeHistory = {
    available: changes.length > 0,
    flowId,
    nodeId,
    revision: commit,
    introduced: changes.find((change) => change.kind === "introduced"),
    lastSemanticChange: [...changes].reverse().find((change) => change.kind !== "removed"),
    changes,
    message: changes.length ? undefined : "This node has no attributable committed graph changes in the available history."
  };
  nodeHistoryCache.set(cacheKey, history);
  if (nodeHistoryCache.size > MAX_NODE_HISTORY_CACHE_ENTRIES) {
    nodeHistoryCache.delete(nodeHistoryCache.keys().next().value!);
  }
  return history;
}
