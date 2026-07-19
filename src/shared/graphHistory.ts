import type { ProjectBundle } from "./schema";

export type GraphHistoryEntry = {
  commit: string;
  shortCommit: string;
  subject: string;
  author: string;
  committedAt: string;
  graphVersion: string;
  flowCount: number;
  nodeCount: number;
  edgeCount: number;
};

export type GraphHistoryVersion = {
  graphVersion: string;
  commits: GraphHistoryEntry[];
  latest: GraphHistoryEntry;
  versionNumber?: number;
};

export type GraphHistoryPage = {
  versions: GraphHistoryVersion[];
  nextCursor: string | null;
  hasMore: boolean;
  newestVersionNumber: number | null;
};

export type GraphHistoryPageOptions = {
  cursor?: string | null;
  limit?: number;
};

export type HistoricalGraphBundle = {
  entry: GraphHistoryEntry;
  bundle: ProjectBundle;
};

export type GitGraphIdentity = {
  name: string;
  email?: string;
};

export type GraphNodeHistoryChange = {
  kind: "introduced" | "modified" | "removed";
  commit: string;
  shortCommit: string;
  subject: string;
  committedAt: string;
  author: GitGraphIdentity;
  committer?: GitGraphIdentity;
  graphVersion?: string;
  changedFields: string[];
};

export type GraphNodeHistory = {
  available: boolean;
  flowId: string;
  nodeId: string;
  revision?: string;
  introduced?: GraphNodeHistoryChange;
  lastSemanticChange?: GraphNodeHistoryChange;
  changes: GraphNodeHistoryChange[];
  message?: string;
};
