export type GitFileStatus = {
  path: string;
  originalPath?: string;
  index: string;
  workingTree: string;
  additions?: number;
  deletions?: number;
};

export type GitCommitSummary = {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authoredAt: string;
};

export type GitStashEntry = {
  ref: string;
  message: string;
  relativeTime: string;
};

export type GitStatus = {
  isRepo: boolean;
  repoRoot?: string;
  currentBranch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  branches: string[];
  changes: GitFileStatus[];
  recentCommits: GitCommitSummary[];
  stashes: GitStashEntry[];
  message?: string;
  // True while a `git merge` is in progress (MERGE_HEAD exists), regardless of
  // whether every conflict has already been resolved and staged.
  merging?: boolean;
};

const CONFLICT_STATUS_CODES = new Set(["UU", "AA", "DU", "UD", "AU", "UA"]);

export function isConflictedGitFileStatus(change: Pick<GitFileStatus, "index" | "workingTree">): boolean {
  return CONFLICT_STATUS_CODES.has(`${change.index}${change.workingTree}`);
}

export type GitOperationResult = {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  at: string;
};

export type ProjectFileTreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: ProjectFileTreeNode[];
  truncated?: boolean;
};

export type ProjectFileText = {
  path: string;
  content: string;
  size: number;
  language: string;
  truncated: boolean;
  binary: boolean;
};

export type ProjectFileDiff = {
  path: string;
  diff: string;
};

export type ProjectFileBrowserData = {
  tree: ProjectFileTreeNode;
  gitStatus: GitStatus;
};

export function parseGitStatusPorcelain(output: string, branches: string[] = []): GitStatus {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const header = lines[0]?.startsWith("## ") ? lines.shift() ?? "" : "";
  const status: GitStatus = {
    isRepo: true,
    ahead: 0,
    behind: 0,
    branches,
    recentCommits: [],
    stashes: [],
    changes: []
  };

  if (header) {
    const content = header.slice(3);
    const [branchPart, metaPart = ""] = content.split(" [");
    const [currentBranch, upstream] = branchPart.split("...");
    status.currentBranch = currentBranch === "HEAD (no branch)" ? "detached" : currentBranch;
    status.upstream = upstream;
    const meta = metaPart.replace(/\]$/, "");
    const ahead = /ahead (\d+)/.exec(meta);
    const behind = /behind (\d+)/.exec(meta);
    status.ahead = ahead ? Number(ahead[1]) : 0;
    status.behind = behind ? Number(behind[1]) : 0;
  }

  status.changes = lines.map((line): GitFileStatus => {
    const index = line[0] ?? " ";
    const workingTree = line[1] ?? " ";
    const rawPath = line.slice(3);
    const renameParts = rawPath.split(" -> ");
    return {
      path: renameParts[1] ?? renameParts[0] ?? rawPath,
      originalPath: renameParts[1] ? renameParts[0] : undefined,
      index,
      workingTree
    };
  });

  return status;
}
