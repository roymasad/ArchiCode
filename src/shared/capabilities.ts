import type { McpServer } from "./schema";

export type ProjectSkill = {
  id: string;
  title: string;
  description: string;
  path: string;
  enabled: boolean;
  content?: string;
};

export type CreateProjectSkillInput = {
  id: string;
  title: string;
  description?: string;
  whenToUse?: string;
  instructions?: string;
};

export type McpServerView = McpServer;

export type McpImportSource =
  | { kind: "codex-auto" }
  | { kind: "json"; content: string };

export type McpRefreshResult = {
  server: McpServer;
  ok: boolean;
  message: string;
};

export type McpRegistrySecret = {
  name: string;
  description?: string;
  required: boolean;
  secret: boolean;
  target: "env" | "header";
};

export type McpRegistryInstallPlan = {
  kind: "remote" | "package";
  transport: McpServer["transport"];
  command?: string;
  args: string[];
  url?: string;
  runtime?: string;
  runtimeAvailable: boolean | null;
  packageType?: string;
  packageId?: string;
  secrets: McpRegistrySecret[];
};

export type McpRegistryEntry = {
  id: string;
  name: string;
  title: string;
  description?: string;
  version?: string;
  status?: string;
  isLatest: boolean;
  websiteUrl?: string;
  repositoryUrl?: string;
  iconUrl?: string;
  categories: string[];
  typeTags: string[];
  packageSummary: string;
  installable: boolean;
  installMessage: string;
  install?: McpRegistryInstallPlan;
};

export type McpRegistrySearchInput = {
  query?: string;
  category?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
  registryUrl?: string;
};

export type McpRegistrySearchResult = {
  entries: McpRegistryEntry[];
  nextCursor?: string;
  count: number;
  registryUrl: string;
};

export type McpRegistryInstallInput = {
  entry: McpRegistryEntry;
  enabled?: boolean;
  trusted?: boolean;
  refresh?: boolean;
};

export type McpRegistryInstallResult = {
  server: McpServer;
  refresh?: McpRefreshResult;
  message: string;
};
