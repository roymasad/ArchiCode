import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  McpImportSource,
  McpRefreshResult,
  McpRegistryEntry,
  McpRegistryInstallInput,
  McpRegistryInstallPlan,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpRegistrySecret
} from "../shared/capabilities";
import { mcpServerSchema, type McpServer, type ProjectSettings } from "../shared/schema";

const OFFICIAL_MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1";
const REGISTRY_META_KEY = "io.modelcontextprotocol.registry/official";

const MCP_REGISTRY_DOMAIN_CATEGORIES = [
  {
    id: "coding",
    terms: ["code", "coding", "developer", "github", "gitlab", "bitbucket", "repository", "pull request", "commit", "source", "ide", "npm", "package"]
  },
  {
    id: "design",
    terms: ["design", "figma", "sketch", "canva", "wireframe", "prototype", "ui", "ux", "brand", "asset"]
  },
  {
    id: "office",
    terms: ["office", "document", "docs", "word", "excel", "spreadsheet", "sheets", "slides", "powerpoint", "calendar", "email", "gmail", "outlook", "drive"]
  },
  {
    id: "project-management",
    terms: ["jira", "linear", "asana", "trello", "monday", "clickup", "ticket", "issue", "sprint", "backlog", "project management", "confluence"]
  },
  {
    id: "data-analytics",
    terms: ["data", "database", "sql", "postgres", "mysql", "snowflake", "bigquery", "analytics", "metrics", "warehouse", "query", "dashboard"]
  },
  {
    id: "devops",
    terms: ["devops", "deploy", "kubernetes", "docker", "cloud", "aws", "azure", "gcp", "terraform", "ci", "monitoring", "logs", "sre"]
  },
  {
    id: "browser-automation",
    terms: ["browser", "web automation", "scrape", "scraping", "playwright", "puppeteer", "chrome", "crawl", "website"]
  },
  {
    id: "communication",
    terms: ["slack", "discord", "teams", "message", "messaging", "chat", "notification", "sms", "telegram"]
  },
  {
    id: "finance-commerce",
    terms: ["finance", "trading", "market", "crypto", "payment", "commerce", "shopify", "stripe", "salesforce", "invoice", "accounting"]
  },
  {
    id: "marketing-sales",
    terms: ["marketing", "sales", "crm", "ads", "adwords", "campaign", "hubspot", "lead", "seo", "customer"]
  },
  {
    id: "ai-media",
    terms: ["image", "video", "audio", "media", "llm", "ai app", "generation", "3d", "transcription", "voice"]
  },
  {
    id: "knowledge-docs",
    terms: ["knowledge", "wiki", "documentation", "docs", "search", "semantic", "memory", "context", "notion", "obsidian"]
  }
];

export type ProviderMcpTool = {
  providerToolName: string;
  serverId: string;
  serverLabel: string;
  toolName: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpToolCallInput = {
  providerToolName: string;
  argumentsJson: string;
};

export type McpToolCallOutput = {
  serverId: string;
  serverLabel: string;
  toolName: string;
  resultText: string;
};

function normalizeId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  return normalized || `mcp-${Date.now().toString(36)}`;
}

function providerToolName(serverId: string, toolName: string): string {
  const safeServer = normalizeId(serverId).replace(/-/g, "_").slice(0, 28);
  const safeTool = toolName.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 28) || "tool";
  return `mcp_${safeServer}_${safeTool}`.slice(0, 64);
}

function envArrayToRecord(env: McpServer["env"]): Record<string, string> | undefined {
  if (!env.length) return undefined;
  return Object.fromEntries(env.filter((item) => item.name.trim()).map((item) => [item.name.trim(), item.value ?? ""]));
}

function headersArrayToRecord(headers: McpServer["headers"]): Record<string, string> | undefined {
  const entries = headers.filter((item) => item.name.trim() && item.value?.trim());
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map((item) => [item.name.trim(), item.value!.trim()]));
}

async function withMcpClient<T>(server: McpServer, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "archicode", version: "0.1.1" }, { capabilities: {} });
  const headers = headersArrayToRecord(server.headers);
  const transport = server.transport === "streamable-http"
    ? new StreamableHTTPClientTransport(new URL(server.url ?? ""), headers ? { requestInit: { headers } } : undefined)
    : new StdioClientTransport({
        command: server.command ?? "",
        args: server.args,
        cwd: server.cwd,
        env: envArrayToRecord(server.env),
        stderr: "pipe"
      });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function enabledMcpServers(settings: ProjectSettings): McpServer[] {
  return settings.mcp.servers.filter((server) => server.enabled);
}

export function untrustedEnabledMcpServers(settings: ProjectSettings, approvedServerIds: string[] = []): McpServer[] {
  const approved = new Set(approvedServerIds);
  return enabledMcpServers(settings).filter((server) => !server.trusted && !approved.has(server.id));
}

export function providerMcpTools(settings: ProjectSettings): ProviderMcpTool[] {
  return enabledMcpServers(settings).flatMap((server) =>
    server.tools.map((tool) => ({
      providerToolName: providerToolName(server.id, tool.name),
      serverId: server.id,
      serverLabel: server.label,
      toolName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  );
}

export async function refreshMcpServerCapabilities(server: McpServer): Promise<McpRefreshResult> {
  try {
    if (server.transport === "stdio" && !server.command?.trim()) throw new Error("MCP stdio server command is required.");
    if (server.transport === "streamable-http" && !server.url?.trim()) throw new Error("MCP Streamable HTTP server URL is required.");
    const refreshed = await withMcpClient(server, async (client) => {
      const [tools, resources, prompts] = await Promise.all([
        client.listTools().catch(() => ({ tools: [] })),
        client.listResources().catch(() => ({ resources: [] })),
        client.listPrompts().catch(() => ({ prompts: [] }))
      ]);
      return mcpServerSchema.parse({
        ...server,
        tools: tools.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        })),
        resources: resources.resources.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType
        })),
        prompts: prompts.prompts.map((prompt) => ({
          name: prompt.name,
          description: prompt.description
        })),
        lastRefreshedAt: new Date().toISOString(),
        lastError: undefined
      });
    });
    return { server: refreshed, ok: true, message: `Loaded ${refreshed.tools.length} tool(s).` };
  } catch (error) {
    const failed = mcpServerSchema.parse({
      ...server,
      lastError: error instanceof Error ? error.message : String(error),
      lastRefreshedAt: new Date().toISOString()
    });
    return { server: failed, ok: false, message: failed.lastError ?? "MCP refresh failed." };
  }
}

export async function callMcpTool(settings: ProjectSettings, input: McpToolCallInput): Promise<McpToolCallOutput> {
  const tool = providerMcpTools(settings).find((item) => item.providerToolName === input.providerToolName);
  if (!tool) throw new Error(`MCP tool ${input.providerToolName} is not available.`);
  const server = settings.mcp.servers.find((item) => item.id === tool.serverId);
  if (!server) throw new Error(`MCP server ${tool.serverId} is not configured.`);
  let args: Record<string, unknown> = {};
  if (input.argumentsJson.trim()) {
    const parsed = JSON.parse(input.argumentsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  }
  const result = await withMcpClient(server, async (client) => client.callTool({ name: tool.toolName, arguments: args }));
  const resultText = stringifyToolResult(result);
  return {
    serverId: server.id,
    serverLabel: server.label,
    toolName: tool.toolName,
    resultText
  };
}

function stringifyToolResult(result: unknown): string {
  const record = result && typeof result === "object" ? result as { content?: unknown } : {};
  if (Array.isArray(record.content)) {
    const parts = record.content.map((part) => {
      if (part && typeof part === "object" && "type" in part) {
        const item = part as { type?: string; text?: string; data?: string; mimeType?: string };
        if (item.type === "text") return item.text ?? "";
        if (item.type === "image") return `[image ${item.mimeType ?? "unknown"} ${item.data?.length ?? 0} bytes]`;
        if (item.type === "audio") return `[audio ${item.mimeType ?? "unknown"} ${item.data?.length ?? 0} bytes]`;
      }
      return JSON.stringify(part);
    }).filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  return JSON.stringify(result, null, 2);
}

type RegistryHeaderOrEnv = {
  name?: unknown;
  description?: unknown;
  isRequired?: unknown;
  isSecret?: unknown;
};

type RegistryRemote = {
  type?: unknown;
  url?: unknown;
  headers?: unknown;
};

type RegistryPackage = {
  registryType?: unknown;
  identifier?: unknown;
  version?: unknown;
  transport?: unknown;
  environmentVariables?: unknown;
};

type RegistryIcon = {
  src?: unknown;
  mimeType?: unknown;
  sizes?: unknown;
};

type RegistryServerRecord = {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  version?: unknown;
  websiteUrl?: unknown;
  repository?: unknown;
  icons?: unknown;
  _meta?: unknown;
  remotes?: unknown;
  packages?: unknown;
};

type RegistryWrapper = {
  server?: RegistryServerRecord;
  _meta?: unknown;
};

type RegistryPage = {
  servers?: RegistryWrapper[];
  metadata?: {
    nextCursor?: string;
    count?: number;
  };
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function registryMeta(wrapper: RegistryWrapper): Record<string, unknown> {
  const meta = wrapper._meta && typeof wrapper._meta === "object" ? wrapper._meta as Record<string, unknown> : {};
  const official = meta[REGISTRY_META_KEY];
  return official && typeof official === "object" ? official as Record<string, unknown> : {};
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}

function collectRegistryMetaText(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectRegistryMetaText(item, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [key, ...collectRegistryMetaText(item, depth + 1)]);
  }
  return [];
}

function publisherCategories(server: RegistryServerRecord): string[] {
  const meta = server._meta && typeof server._meta === "object" ? server._meta as Record<string, unknown> : {};
  const categories = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const category of stringArrayValue(record.categories)) categories.add(category.toLowerCase());
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") visit(nested);
    }
  };
  visit(meta);
  return [...categories];
}

function repositoryUrl(repository: unknown): string | undefined {
  if (!repository || typeof repository !== "object") return undefined;
  return stringValue((repository as Record<string, unknown>).url);
}

function registryIconUrl(icons: unknown): string | undefined {
  if (!Array.isArray(icons)) return undefined;
  for (const icon of icons) {
    const record = icon && typeof icon === "object" ? icon as RegistryIcon : {};
    const src = stringValue(record.src);
    if (!src) continue;
    try {
      const url = new URL(src);
      if (url.protocol === "https:") return url.toString();
    } catch {
      continue;
    }
  }
  return undefined;
}

function registryCategoryHaystack(server: RegistryServerRecord, wrapper: RegistryWrapper, packageTypes: string[]): string {
  return [
    stringValue(server.name),
    stringValue(server.title),
    stringValue(server.description),
    stringValue(server.websiteUrl),
    repositoryUrl(server.repository),
    ...packageTypes,
    ...publisherCategories(server),
    ...collectRegistryMetaText(server._meta),
    ...collectRegistryMetaText(wrapper._meta)
  ].filter(Boolean).join("\n").toLowerCase();
}

function registryDomainCategories(server: RegistryServerRecord, wrapper: RegistryWrapper, packageTypes: string[]): string[] {
  const haystack = registryCategoryHaystack(server, wrapper, packageTypes);
  const categories = MCP_REGISTRY_DOMAIN_CATEGORIES
    .filter((category) => category.terms.some((term) => haystack.includes(term)))
    .map((category) => category.id);
  return categories.length ? categories : ["other"];
}

function registryTypeTags(plan: McpRegistryInstallPlan | null, packageTypes: string[]): string[] {
  const tags = new Set<string>();
  if (plan?.kind === "remote") tags.add("Remote");
  if (plan?.kind === "package") tags.add("Package");
  for (const type of packageTypes) tags.add(type === "oci" ? "Docker / OCI" : type);
  if (plan?.runtime) tags.add(plan.runtime);
  if (plan?.secrets.some((secret) => secret.required)) tags.add("Needs credentials");
  if (plan?.runtimeAvailable === false) tags.add("Missing runtime");
  if (plan?.runtimeAvailable !== false && plan) tags.add("Installable");
  return [...tags];
}

function registrySecrets(items: unknown, target: McpRegistrySecret["target"]): McpRegistrySecret[] {
  if (!Array.isArray(items)) return [];
  const secrets: McpRegistrySecret[] = [];
  for (const item of items) {
    const record = item && typeof item === "object" ? item as RegistryHeaderOrEnv : {};
    const name = stringValue(record.name);
    if (!name) continue;
    secrets.push({
      name,
      description: stringValue(record.description),
      required: record.isRequired === true,
      secret: record.isSecret !== false,
      target
    });
  }
  return secrets;
}

function runtimeAvailable(runtime: string | undefined): boolean | null {
  if (!runtime) return null;
  const result = spawnSync(runtime, ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function versionedNpmPackage(identifier: string, version?: string): string {
  if (!version || identifier.endsWith(`@${version}`)) return identifier;
  return `${identifier}@${version}`;
}

function versionedPypiPackage(identifier: string, version?: string): string {
  if (!version || identifier.includes("==")) return identifier;
  return `${identifier}==${version}`;
}

function packageInstallPlan(pkg: RegistryPackage): McpRegistryInstallPlan | null {
  const registryType = stringValue(pkg.registryType)?.toLowerCase();
  const identifier = stringValue(pkg.identifier);
  if (!registryType || !identifier) return null;
  const version = stringValue(pkg.version);
  const transport = pkg.transport && typeof pkg.transport === "object" ? pkg.transport as Record<string, unknown> : {};
  if (stringValue(transport.type) !== "stdio") return null;
  const env = registrySecrets(pkg.environmentVariables, "env");
  if (registryType === "npm") {
    const runtime = "npx";
    return {
      kind: "package",
      transport: "stdio",
      command: runtime,
      args: ["-y", versionedNpmPackage(identifier, version)],
      runtime,
      runtimeAvailable: runtimeAvailable(runtime),
      packageType: registryType,
      packageId: identifier,
      secrets: env
    };
  }
  if (registryType === "pypi") {
    const runtime = "uvx";
    return {
      kind: "package",
      transport: "stdio",
      command: runtime,
      args: [versionedPypiPackage(identifier, version)],
      runtime,
      runtimeAvailable: runtimeAvailable(runtime),
      packageType: registryType,
      packageId: identifier,
      secrets: env
    };
  }
  if (registryType === "oci") {
    const runtime = "docker";
    return {
      kind: "package",
      transport: "stdio",
      command: runtime,
      args: ["run", "--rm", "-i", version ? `${identifier}:${version}` : identifier],
      runtime,
      runtimeAvailable: runtimeAvailable(runtime),
      packageType: registryType,
      packageId: identifier,
      secrets: env
    };
  }
  return null;
}

function remoteInstallPlan(remote: RegistryRemote): McpRegistryInstallPlan | null {
  if (stringValue(remote.type) !== "streamable-http") return null;
  const url = stringValue(remote.url);
  if (!url) return null;
  return {
    kind: "remote",
    transport: "streamable-http",
    args: [],
    url,
    runtimeAvailable: null,
    secrets: registrySecrets(remote.headers, "header")
  };
}

function installMessage(plan: McpRegistryInstallPlan | null, server: RegistryServerRecord): string {
  if (!plan) {
    const remotes = Array.isArray(server.remotes) ? server.remotes as RegistryRemote[] : [];
    if (remotes.some((remote) => stringValue(remote.type) === "sse")) {
      return "This registry entry only exposes SSE remotes, which ArchiCode does not run yet.";
    }
    return "No supported Streamable HTTP, npm, PyPI, or OCI package install was found.";
  }
  const missingRuntime = plan.runtime && plan.runtimeAvailable === false;
  const requiredSecrets = plan.secrets.filter((secret) => secret.required).map((secret) => secret.name);
  if (missingRuntime) return `Requires ${plan.runtime} on PATH before ArchiCode can connect.`;
  if (requiredSecrets.length) return `Requires ${requiredSecrets.join(", ")} before connecting.`;
  return plan.kind === "remote" ? "Ready to add as a remote MCP server." : `Ready to run with ${plan.command}.`;
}

function firstInstallPlan(plans: Array<McpRegistryInstallPlan | null>): McpRegistryInstallPlan | null {
  return plans.find((plan): plan is McpRegistryInstallPlan => Boolean(plan)) ?? null;
}

export function registryEntryFromServer(wrapper: RegistryWrapper): McpRegistryEntry | null {
  const server = wrapper.server;
  if (!server) return null;
  const name = stringValue(server.name);
  if (!name) return null;
  const version = stringValue(server.version);
  const meta = registryMeta(wrapper);
  const remotes = Array.isArray(server.remotes) ? server.remotes as RegistryRemote[] : [];
  const packages = Array.isArray(server.packages) ? server.packages as RegistryPackage[] : [];
  const plan = firstInstallPlan(remotes.map(remoteInstallPlan)) ?? firstInstallPlan(packages.map(packageInstallPlan));
  const packageTypes = [
    ...remotes.map((remote) => stringValue(remote.type)).filter((item): item is string => Boolean(item)),
    ...packages.map((pkg) => stringValue(pkg.registryType)).filter((item): item is string => Boolean(item))
  ];
  return {
    id: version ? `${name}@${version}` : name,
    name,
    title: stringValue(server.title) ?? name,
    description: stringValue(server.description),
    version,
    status: stringValue(meta.status),
    isLatest: meta.isLatest !== false,
    websiteUrl: stringValue(server.websiteUrl),
    repositoryUrl: repositoryUrl(server.repository),
    iconUrl: registryIconUrl(server.icons),
    categories: registryDomainCategories(server, wrapper, packageTypes),
    typeTags: registryTypeTags(plan, packageTypes),
    packageSummary: packageTypes.length ? [...new Set(packageTypes)].join(", ") : "metadata only",
    installable: plan ? plan.runtimeAvailable !== false : false,
    installMessage: installMessage(plan, server),
    install: plan ?? undefined
  };
}

function registryMatches(entry: McpRegistryEntry, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = [
    entry.name,
    entry.title,
    entry.description,
    entry.packageSummary,
    entry.websiteUrl,
    entry.repositoryUrl,
    entry.installMessage,
    entry.install?.packageId,
    entry.install?.command,
    ...(entry.install?.args ?? []),
    ...entry.categories,
    ...entry.typeTags
  ].filter(Boolean).join("\n").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

function registryMatchesCategory(entry: McpRegistryEntry, category: string | undefined): boolean {
  const normalized = category?.trim();
  if (!normalized || normalized === "all") return true;
  return entry.categories.includes(normalized);
}

function sortRegistryEntries(entries: McpRegistryEntry[], sort: string | undefined): McpRegistryEntry[] {
  const byName = (a: McpRegistryEntry, b: McpRegistryEntry) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return [...entries].sort((a, b) => {
    if (sort === "name-asc") return byName(a, b);
    if (sort === "name-desc") return byName(b, a);
    if (sort === "installable") return Number(b.installable) - Number(a.installable) || byName(a, b);
    if (sort === "category") {
      const left = a.categories[0] ?? "other";
      const right = b.categories[0] ?? "other";
      return left.localeCompare(right, undefined, { sensitivity: "base" }) || byName(a, b);
    }
    return 0;
  });
}

function normalizeRegistryUrl(registryUrl: string | undefined): string {
  const raw = registryUrl?.trim() || OFFICIAL_MCP_REGISTRY_URL;
  return raw.replace(/\/+$/, "");
}

export async function listMcpRegistryServers(input: McpRegistrySearchInput = {}): Promise<McpRegistrySearchResult> {
  const registryUrl = normalizeRegistryUrl(input.registryUrl);
  const requestedLimit = Math.max(1, Math.min(input.limit ?? 30, 100));
  const query = input.query?.trim() ?? "";
  const category = input.category?.trim() ?? "all";
  const useRegistrySearch = Boolean(query);
  const categoryOnlyFilter = !useRegistrySearch && category !== "all";
  const fetchLimit = categoryOnlyFilter ? 100 : requestedLimit;
  const entries: McpRegistryEntry[] = [];
  let cursor = input.cursor;
  let nextCursor: string | undefined;
  let count = 0;
  const maxPages = categoryOnlyFilter ? 20 : 1;
  for (let page = 0; page < maxPages && entries.length < requestedLimit; page += 1) {
    const url = new URL(`${registryUrl}/servers`);
    url.searchParams.set("limit", String(fetchLimit));
    if (useRegistrySearch) url.searchParams.set("search", query);
    if (cursor) url.searchParams.set("cursor", cursor);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let payload: RegistryPage;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`MCP registry request failed: ${response.status} ${response.statusText}`);
      payload = await response.json() as RegistryPage;
    } finally {
      clearTimeout(timeout);
    }
    count += payload.metadata?.count ?? payload.servers?.length ?? 0;
    nextCursor = payload.metadata?.nextCursor;
    const pageEntries = (payload.servers ?? [])
      .map(registryEntryFromServer)
      .filter((entry): entry is McpRegistryEntry => Boolean(entry))
      .filter((entry) => entry.isLatest && entry.status !== "deprecated")
      .filter((entry) => useRegistrySearch || registryMatches(entry, query))
      .filter((entry) => registryMatchesCategory(entry, category));
    entries.push(...pageEntries);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return {
    entries: sortRegistryEntries(entries, input.sort).slice(0, requestedLimit),
    nextCursor,
    count,
    registryUrl
  };
}

export function mcpServerFromRegistryEntry(input: McpRegistryInstallInput): McpServer {
  const install = input.entry.install;
  if (!install || !input.entry.installable) throw new Error(input.entry.installMessage || "This MCP server is not installable.");
  const id = normalizeId(input.entry.name);
  const requiredSecrets = install.secrets.filter((secret) => secret.required);
  const enabled = input.enabled ?? requiredSecrets.length === 0;
  const trusted = input.trusted ?? (enabled && requiredSecrets.length === 0);
  return mcpServerSchema.parse({
    id,
    label: input.entry.title,
    transport: install.transport,
    command: install.command,
    args: install.args,
    env: install.secrets
      .filter((secret) => secret.target === "env")
      .map((secret) => ({ name: secret.name, value: "" })),
    headers: install.secrets
      .filter((secret) => secret.target === "header")
      .map((secret) => ({ name: secret.name, value: "" })),
    url: install.url,
    enabled,
    trusted,
    source: "registry",
    lastError: requiredSecrets.length ? `Add required ${requiredSecrets.map((secret) => secret.name).join(", ")} values before connecting.` : undefined
  });
}

export async function importMcpServers(source: McpImportSource): Promise<McpServer[]> {
  if (source.kind === "json") return parseJsonMcpServers(source.content, "imported-json");
  const configPath = process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, "config.toml")
    : path.join(homedir(), ".codex", "config.toml");
  if (!existsSync(configPath)) return [];
  return parseCodexToml(await readFile(configPath, "utf8"));
}

function parseJsonMcpServers(content: string, source: McpServer["source"]): McpServer[] {
  const parsed = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
  const servers = parsed.mcpServers ?? {};
  return Object.entries(servers).map(([name, value]) => serverFromConfig(name, value, source));
}

function serverFromConfig(name: string, value: unknown, source: McpServer["source"]): McpServer {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const env = record.env && typeof record.env === "object" && !Array.isArray(record.env)
    ? Object.entries(record.env as Record<string, unknown>).map(([envName, envValue]) => ({ name: envName, value: String(envValue ?? "") }))
    : [];
  const headers = record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)
    ? Object.entries(record.headers as Record<string, unknown>).map(([headerName, headerValue]) => ({ name: headerName, value: String(headerValue ?? "") }))
    : [];
  return mcpServerSchema.parse({
    id: normalizeId(name),
    label: String(record.label ?? name),
    transport: record.url ? "streamable-http" : "stdio",
    command: typeof record.command === "string" ? record.command : undefined,
    args: Array.isArray(record.args) ? record.args.map(String) : [],
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    env,
    headers,
    url: typeof record.url === "string" ? record.url : undefined,
    enabled: false,
    trusted: false,
    source
  });
}

function parseCodexToml(content: string): McpServer[] {
  const records = new Map<string, { record: Record<string, unknown>; env: Record<string, string> }>();
  let currentName: string | null = null;
  let currentEnv = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (section) {
      const rawName = section[1].replace(/^"|"$/g, "");
      currentEnv = rawName.endsWith(".env");
      currentName = currentEnv ? rawName.slice(0, -4) : rawName;
      if (!records.has(currentName)) records.set(currentName, { record: {}, env: {} });
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      currentName = null;
      currentEnv = false;
      continue;
    }
    if (!currentName) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    const key = match[1];
    const raw = match[2].trim();
    const entry = records.get(currentName)!;
    if (currentEnv) {
      entry.env[key] = parseTomlScalar(raw);
    } else if (key.startsWith("env.")) {
      entry.env[key.slice(4)] = parseTomlScalar(raw);
    } else {
      entry.record[key] = key === "args" ? parseTomlArray(raw) : parseTomlScalar(raw);
    }
  }
  return [...records.entries()].map(([name, entry]) => {
    const record = Object.keys(entry.env).length ? { ...entry.record, env: entry.env } : entry.record;
    return serverFromConfig(name, record, "imported-codex");
  });
}

function parseTomlScalar(raw: string): string {
  return raw.replace(/^"|"$/g, "").replace(/\\"/g, "\"");
}

function parseTomlArray(raw: string): string[] {
  const jsonish = raw.replace(/'/g, "\"");
  try {
    const parsed = JSON.parse(jsonish) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
