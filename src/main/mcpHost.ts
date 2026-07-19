import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { generateAcceptanceChecksScoped } from "./storage/acceptanceChecks";
import { buildContext } from "./storage/contextBuilder";
import { readArtifactText } from "./storage/patches";
import { ensureExternalMcpHostToken, loadProject, regenerateExternalMcpHostToken } from "./storage/projectStore";
import { listRuntimeServices } from "./storage/runtimeServices";
import { applyExternalGraphOperation } from "./research/graphOps";
import type { Artifact, Note, ProjectBundle, ProjectSettings, RunScope } from "../shared/schema";
import { archicodeCapabilityDigest, archicodeCapabilityVersion, archicodeCurrentProjectOptions } from "../shared/appCapabilities";
import { redactSensitiveText, sanitizeExternalValue } from "../shared/redaction";
import { queryCodeKnowledgeSnapshot, type CodeKnowledgeEdge, type CodeKnowledgeQueryInput } from "../shared/codeKnowledge";
import { readCodeKnowledgeSnapshot } from "./importer/knowledgeSnapshot";

export type ExternalMcpHostStatus = {
  enabled: boolean;
  running: boolean;
  host: string;
  port: number;
  endpoint: string;
  requireToken: boolean;
  writeMode: "apply";
  token?: string;
  error?: string;
  codexConfig: string;
  claudeConfig: string;
};

type HostRuntime = {
  projectRoot: string;
  host: string;
  port: number;
  token?: string;
  httpServer: http.Server;
  sessions: Map<string, HostSession>;
  error?: string;
};

type HostSession = {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
};

type ToolSpec = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    additionalProperties: boolean;
    required?: string[];
    properties: Record<string, unknown>;
  };
};

const JSON_MIME = "application/json";
const MCP_PATH = "/mcp";
let runtime: HostRuntime | null = null;
let lastError: string | undefined;
let projectUpdatePublisher: ((projectRoot: string, payload: { source: "mcp"; action: string }) => void) | null = null;

const ARCHICODE_HOST_VERSION = "0.2.0";
const idProperty = { type: "string", minLength: 1 } as const;
const groupProperties = {
  id: idProperty,
  name: { type: "string", minLength: 1 },
  color: { type: "string" }
};
const subflowProperties = {
  id: idProperty,
  name: { type: "string", minLength: 1 },
  parentNodeId: idProperty,
  parentSubflowId: idProperty,
  ignored: { type: "boolean" }
};
const edgeProperties = {
  id: idProperty,
  source: idProperty,
  target: idProperty,
  sourceHandle: { type: "string" },
  targetHandle: { type: "string" },
  label: { type: "string" },
  color: { type: "string" },
  width: { type: "number", minimum: 1, maximum: 8 },
  lineStyle: { type: "string", enum: ["solid", "dashed", "dotted"] },
  animated: { type: "boolean" }
};
const noteProperties = {
  flowId: idProperty,
  nodeId: idProperty,
  kind: { type: "string", enum: ["user-note", "llm-question", "user-answer", "system-note"] },
  author: { type: "string", enum: ["user", "llm", "system"] },
  body: { type: "string", minLength: 1 },
  category: { type: "string", enum: ["note", "decision", "bug", "task"] },
  priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
  attachmentIds: { type: "array", items: idProperty },
  replyToNoteId: idProperty,
  resolved: { type: "boolean" },
  pinned: { type: "boolean" }
};
const runProfileProperties = {
  id: idProperty,
  label: { type: "string", minLength: 1 },
  kind: { type: "string" },
  cwd: { type: "string" },
  description: { type: "string" },
  installCommand: { type: "string" },
  setupCommand: { type: "string" },
  buildCommand: { type: "string" },
  testCommand: { type: "string" },
  stopCommand: { type: "string" },
  targetStopCommand: { type: "string" },
  healthCommand: { type: "string" },
  url: { type: "string" },
  ports: { type: "array", items: { type: "integer", minimum: 1, maximum: 65535 } },
  groupId: { type: "string" },
  dependsOn: { type: "array", items: { type: "string" } },
  inferred: { type: "boolean" },
  discoverCommand: { type: "string" },
  targetPattern: { type: "string" },
  targetPreferencePattern: { type: "string" },
  defaultTargetId: { type: "string" },
  targetRequired: { type: "boolean" },
  launchCommand: { type: "string" },
  waitCommand: { type: "string" },
  readyPattern: { type: "string" },
  notReadyPattern: { type: "string" },
  readyTargetPattern: { type: "string" },
  runtimeReadyPattern: { type: "string" },
  diagnosticCommands: { type: "array", items: { type: "string" } },
  recoveryCommands: { type: "array", items: { type: "string" } },
  retryAfterRecovery: { type: "boolean" },
  runCommand: { type: "string", minLength: 1 },
  timeoutSeconds: { type: "integer", minimum: 1, maximum: 600 }
};
const artifactProperties = {
  id: idProperty,
  type: { type: "string", enum: ["summary", "diff", "log", "attachment", "screenshot", "instructions", "generated-file", "context-manifest", "memory", "plan"] },
  title: { type: "string" },
  path: { type: "string" },
  nodeId: idProperty,
  noteId: idProperty,
  runId: idProperty,
  mediaType: { type: "string" },
  status: { type: "string", enum: ["pending-review", "partially-applied", "applied", "rejected"] },
  summary: { type: "string" },
  promptSummary: { type: "string" },
  providerSummary: { type: "string" },
  planOutputAt: { type: "string" },
  sizeBytes: { type: "integer", minimum: 0 },
  createdAt: { type: "string" }
};
const nodeProperties = {
  id: idProperty,
  type: { type: "string" },
  title: { type: "string", minLength: 1 },
  description: { type: "string" },
  stage: { type: "string", enum: ["planned", "plan-approved", "working", "draft", "draft-rejected", "draft-approved-production"] },
  ignored: { type: "boolean" },
  flags: { type: "array", items: { type: "string", enum: ["changed", "has-diff", "needs-attention", "has-attachments", "llm-question", "modified-not-built", "user-approved"] } },
  locked: { type: "boolean" },
  visual: { type: "object", additionalProperties: false, properties: { backgroundColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, shape: { type: "string", enum: ["rounded", "rectangle", "capsule", "document", "database", "note", "ellipse", "diamond", "hexagon", "parallelogram", "cloud", "actor"] } } },
  position: { type: "object", additionalProperties: false, properties: { x: { type: "number" }, y: { type: "number" }, relativeToNodeId: idProperty, placement: { type: "string", enum: ["above", "below", "left", "right"] } } },
  positionHint: { type: "object", additionalProperties: false, required: ["relativeToNodeId", "placement"], properties: { relativeToNodeId: idProperty, placement: { type: "string", enum: ["above", "below", "left", "right"] } } },
  size: { type: "object", additionalProperties: false, required: ["width", "height"], properties: { width: { type: "number" }, height: { type: "number" } } },
  parentId: idProperty,
  subflowId: idProperty,
  groupId: idProperty,
  techStack: { type: "array", items: { type: "string" } },
  acceptanceCriteria: { type: "array", items: { type: "string" } },
  acceptanceChecks: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "criterion"], properties: { id: idProperty, criterion: { type: "string" }, testCommand: { type: "string" }, testFilePath: { type: "string" }, testName: { type: "string" }, status: { type: "string", enum: ["unverified", "passing", "failing"] }, verifiedByRunId: idProperty, evidence: { type: "string" }, updatedAt: { type: "string" } } } },
  implementationScope: { type: "object", additionalProperties: false, required: ["claims"], properties: { source: { type: "string", enum: ["codebase-importer", "implementation-agent", "chat-agent", "user"] }, analyzerVersion: { type: "integer", minimum: 1 }, updatedByRunId: idProperty, checkedAt: { type: "string" }, claims: { type: "array", maxItems: 24, items: { type: "object", additionalProperties: false, required: ["relation", "kind", "path"], properties: { relation: { type: "string", enum: ["own", "share", "cover"] }, kind: { type: "string", enum: ["file", "directory", "class", "function", "symbol"] }, path: { type: "string", minLength: 1 }, symbol: { type: "string", minLength: 1 } } } } } },
  moduleProfileMode: { type: "string", enum: ["auto", "manual", "none"] },
  moduleProfileId: idProperty,
  customProperties: { type: "object", additionalProperties: { type: "string" } },
  ruleIds: { type: "array", items: idProperty },
  attachments: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "type", "title", "path", "createdAt"], properties: artifactProperties } },
  todos: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text"], properties: { id: idProperty, text: { type: "string" }, done: { type: "boolean" } } } }
};

const readTools: ToolSpec[] = [
  tool("archicode_about", "Explain what ArchiCode is, what this MCP server exposes, and how coding agents should use it.", {}),
  tool("archicode_get_project", "Read a bounded, secret-safe view of the current ArchiCode project, flows, notes, runs, artifacts, incidents, and graph-change metadata.", {
    maxFlows: { type: "integer", minimum: 1, maximum: 100 },
    maxNodesPerFlow: { type: "integer", minimum: 1, maximum: 1000 },
    maxNotes: { type: "integer", minimum: 1, maximum: 500 },
    maxRuns: { type: "integer", minimum: 1, maximum: 100 },
    maxArtifacts: { type: "integer", minimum: 1, maximum: 500 },
    maxGraphChanges: { type: "integer", minimum: 1, maximum: 1000 },
    maxIncidents: { type: "integer", minimum: 1, maximum: 200 }
  }),
  tool("archicode_get_scoped_change_context", "Build ArchiCode's smart scoped implementation context for project, flow, or selected node scopes. This is the best entry point before coding because it includes dirty/changed nodes, pending graph changes, notes, runs, artifacts, memory, and scope guidance.", {
    scopeKind: { type: "string", enum: ["project", "flow", "nodes"] },
    flowId: { type: "string", description: "Flow id. Defaults to the active flow for project scope." },
    nodeIds: { type: "array", items: { type: "string" }, description: "Selected node ids for nodes scope." },
    providerId: { type: "string", description: "Optional provider id used only if the context must be compacted." },
    includeContextText: { type: "boolean", description: "Include the raw JSON context text in addition to the parsed context object." },
    maxContextTextChars: { type: "integer", minimum: 1000, maximum: 500000, description: "Maximum raw context text characters when includeContextText is true." },
    persistArtifacts: { type: "boolean", description: "Persist context manifest/summary artifacts and memory records. Defaults to false for external read-only probes." }
  }, ["scopeKind"]),
  tool("archicode_get_flow", "Read one ArchiCode flow by id.", {
    flowId: { type: "string", minLength: 1 }
  }, ["flowId"]),
  tool("archicode_get_node", "Read one graph node by flow id and node id, including notes and attachments.", {
    flowId: { type: "string", minLength: 1 },
    nodeId: { type: "string", minLength: 1 }
  }, ["flowId", "nodeId"]),
  tool("archicode_get_rules", "Read reusable node rules, their graph attachments, and optionally the rules attached to one flow or node.", {
    flowId: { type: "string", description: "Optional flow id used to filter rule attachments. Required when nodeId is provided." },
    nodeId: { type: "string", description: "Optional node id used to read attached rules for one node." }
  }),
  tool("archicode_search_graph", "Search flows, subflows, groups, nodes, edges, rules, notes, runs, incidents, artifacts, and graph-change metadata.", {
    query: { type: "string", minLength: 1 },
    maxResults: { type: "integer", minimum: 1, maximum: 100 }
  }, ["query"]),
  tool("archicode_query_code_graph", "Query the local structural code graph without loading the full snapshot. Supports bounded file/symbol search, dependency neighbors, shortest paths, and reverse impact.", {
    action: { type: "string", enum: ["search", "neighbors", "path", "impact"] },
    query: { type: "string", description: "Search text for the search action." },
    source: { type: "string", description: "Exact node id, file path, or unique symbol label for neighbors, path, or impact." },
    target: { type: "string", description: "Exact node id, file path, or unique symbol label for the path target." },
    direction: { type: "string", enum: ["incoming", "outgoing", "both"] },
    kinds: { type: "array", maxItems: 4, items: { type: "string", enum: ["contains", "dependency", "calls", "runtime"] } },
    maxResults: { type: "integer", minimum: 1, maximum: 40 },
    maxDepth: { type: "integer", minimum: 1, maximum: 4 }
  }, ["action"]),
  tool("archicode_list_runs", "List recent ArchiCode runs and their artifacts.", {
    status: { type: "string", enum: ["preparing", "queued", "needs-permission", "running", "planning", "awaiting-plan-review", "coding", "awaiting-code-review", "debugging", "needs-replan", "verifying", "succeeded", "failed", "cancelled"] },
    maxResults: { type: "integer", minimum: 1, maximum: 50 },
    maxLogs: { type: "integer", minimum: 0, maximum: 200 }
  }),
  tool("archicode_get_graph_changes", "List graph-change ledger entries with optional status filtering.", {
    status: { type: "string", enum: ["pending", "implemented", "obsolete"] },
    maxResults: { type: "integer", minimum: 1, maximum: 1000 }
  }),
  tool("archicode_list_incidents", "List recent runtime/debug incidents with optional status filtering.", {
    status: { type: "string" },
    maxResults: { type: "integer", minimum: 1, maximum: 200 }
  }),
  tool("archicode_list_runtime_services", "List current runtime services with bounded log tails.", {
    maxLogs: { type: "integer", minimum: 0, maximum: 200 }
  }),
  tool("archicode_read_artifact", "Read a known ArchiCode artifact by artifact id or path.", {
    artifactId: { type: "string" },
    path: { type: "string" },
    maxChars: { type: "integer", minimum: 1000, maximum: 80000 }
  })
];

const writeTools: ToolSpec[] = [
  tool("archicode_update_project", "Apply a validated project metadata update.", {
    patch: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        stackAssumptions: { type: "array", items: { type: "string" } },
        environmentNotes: { type: "string" }
      }
    }
  }, ["patch"]),
  tool("archicode_update_flow", "Apply a validated flow metadata update.", {
    flowId: { type: "string", minLength: 1 },
    patch: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        description: { type: "string" }
      }
    }
  }, ["flowId", "patch"]),
  tool("archicode_update_subflow", "Apply a validated detail flow/subflow metadata update.", {
    flowId: { type: "string", minLength: 1 },
    subflowId: { type: "string", minLength: 1 },
    patch: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" }
      }
    }
  }, ["flowId", "subflowId", "patch"]),
  tool("archicode_create_subflow", "Create a validated detail flow/subflow.", {
    flowId: idProperty,
    subflow: { type: "object", additionalProperties: false, required: ["name"], properties: subflowProperties }
  }, ["flowId", "subflow"]),
  tool("archicode_delete_subflow", "Delete a detail flow that contains no approved locked nodes.", {
    flowId: idProperty,
    subflowId: idProperty
  }, ["flowId", "subflowId"]),
  tool("archicode_link_node_subflow", "Link a node to a detail flow, or clear its detail-flow link with null.", {
    flowId: idProperty,
    nodeId: idProperty,
    subflowId: { anyOf: [idProperty, { type: "null" }] }
  }, ["flowId", "nodeId", "subflowId"]),
  tool("archicode_create_group", "Create a validated visual node group.", {
    flowId: idProperty,
    group: { type: "object", additionalProperties: false, required: ["name"], properties: groupProperties }
  }, ["flowId", "group"]),
  tool("archicode_update_group", "Update a visual node group's name or color.", {
    flowId: idProperty,
    groupId: idProperty,
    patch: { type: "object", additionalProperties: false, properties: { name: groupProperties.name, color: groupProperties.color } }
  }, ["flowId", "groupId", "patch"]),
  tool("archicode_delete_group", "Delete a visual group and clear membership from unlocked member nodes.", {
    flowId: idProperty,
    groupId: idProperty
  }, ["flowId", "groupId"]),
  tool("archicode_update_node", "Apply a validated node patch.", {
    flowId: { type: "string", minLength: 1 },
    patch: { type: "object", additionalProperties: false, required: ["id"], properties: nodeProperties }
  }, ["flowId", "patch"]),
  tool("archicode_generate_acceptance_checks", "Use AI to convert a node's free-text acceptance criteria into structured, testable acceptanceChecks (one check per verifiable criterion, each with a test command). Omit nodeId to generate across every eligible node in the flow in one batch. Writes directly and non-destructively (existing checks are kept; new checks start unverified and gate the node until they pass on the next build).", {
    flowId: { type: "string", minLength: 1 },
    nodeId: { type: "string", description: "Optional. A single node to generate for; omit to batch-generate for all eligible nodes in the flow." }
  }, ["flowId"]),
  tool("archicode_create_node", "Create a graph node using ArchiCode validation and default layout.", {
    flowId: { type: "string", minLength: 1 },
    node: { type: "object", additionalProperties: false, required: ["title"], properties: nodeProperties }
  }, ["flowId", "node"]),
  tool("archicode_create_edge", "Create a graph edge using ArchiCode validation.", {
    flowId: { type: "string", minLength: 1 },
    edge: { type: "object", additionalProperties: false, required: ["source", "target"], properties: edgeProperties }
  }, ["flowId", "edge"]),
  tool("archicode_update_edge", "Update a graph edge using ArchiCode validation.", {
    flowId: { type: "string", minLength: 1 },
    edgeId: { type: "string", minLength: 1 },
    patch: { type: "object", additionalProperties: false, properties: edgeProperties }
  }, ["flowId", "edgeId", "patch"]),
  tool("archicode_delete_node", "Delete an unlocked graph node using ArchiCode validation.", {
    flowId: { type: "string", minLength: 1 },
    nodeId: { type: "string", minLength: 1 }
  }, ["flowId", "nodeId"]),
  tool("archicode_delete_edge", "Delete a graph edge using ArchiCode validation.", {
    flowId: { type: "string", minLength: 1 },
    edgeId: { type: "string", minLength: 1 }
  }, ["flowId", "edgeId"]),
  tool("archicode_add_note", "Add a graph note to a node.", {
    note: { type: "object", additionalProperties: false, required: ["flowId", "nodeId", "kind", "author", "body"], properties: noteProperties }
  }, ["note"]),
  tool("archicode_resolve_note", "Resolve or reopen a graph note.", {
    noteId: { type: "string", minLength: 1 },
    resolved: { type: "boolean" }
  }, ["noteId"]),
  tool("archicode_delete_note", "Delete a graph note.", {
    noteId: idProperty
  }, ["noteId"]),
  tool("archicode_run_acceptance_checks", "Execute a node's structured acceptance checks and persist their results.", {
    flowId: idProperty,
    nodeId: idProperty
  }, ["flowId", "nodeId"]),
  tool("archicode_upsert_run_profile", "Create or replace a validated Build/Run App target profile.", {
    mode: { type: "string", enum: ["create", "replace"] },
    profile: { type: "object", additionalProperties: false, required: ["id", "label", "runCommand"], properties: runProfileProperties },
    reason: { type: "string" }
  }, ["mode", "profile"])
];

export async function syncExternalMcpHost(projectRoot: string, settings: ProjectSettings): Promise<ExternalMcpHostStatus> {
  if (!settings.externalMcpHost.enabled) {
    if (runtime?.projectRoot === projectRoot) await stopExternalMcpHost();
    return externalMcpHostStatus(settings, false);
  }
  const token = settings.externalMcpHost.requireToken ? await ensureExternalMcpHostToken(projectRoot) : undefined;
  const currentMatches = runtime &&
    runtime.projectRoot === projectRoot &&
    runtime.host === settings.externalMcpHost.host &&
    runtime.port === settings.externalMcpHost.port &&
    runtime.token === token;
  if (!currentMatches) {
    await stopExternalMcpHost();
    await startExternalMcpHost(projectRoot, settings, token);
  }
  return getExternalMcpHostStatus(projectRoot, settings);
}

export function setExternalMcpProjectUpdatePublisher(
  publisher: ((projectRoot: string, payload: { source: "mcp"; action: string }) => void) | null
): void {
  projectUpdatePublisher = publisher;
}

export async function stopExternalMcpHost(): Promise<void> {
  const current = runtime;
  runtime = null;
  if (!current) return;
  await Promise.all([...current.sessions.values()].map((session) => session.transport.close().catch(() => undefined)));
  await new Promise<void>((resolve) => {
    current.httpServer.close(() => resolve());
  }).catch(() => undefined);
}

export async function getExternalMcpHostStatus(projectRoot: string, settings?: ProjectSettings): Promise<ExternalMcpHostStatus> {
  const effectiveSettings = settings ?? (await loadProject(projectRoot)).project.settings;
  const token = effectiveSettings.externalMcpHost.requireToken
    ? await ensureExternalMcpHostToken(projectRoot)
    : undefined;
  const endpoint = endpointFor(effectiveSettings.externalMcpHost.host, effectiveSettings.externalMcpHost.port);
  const running = Boolean(runtime && runtime.projectRoot === projectRoot && runtime.port === effectiveSettings.externalMcpHost.port);
  return externalMcpHostStatus(effectiveSettings, running, token, effectiveSettings.externalMcpHost.enabled ? (running ? runtime?.error : lastError) : undefined);
}

export async function regenerateExternalMcpHostAuth(projectRoot: string): Promise<ExternalMcpHostStatus> {
  const token = await regenerateExternalMcpHostToken(projectRoot);
  const bundle = await loadProject(projectRoot);
  if (bundle.project.settings.externalMcpHost.enabled) {
    await stopExternalMcpHost();
    await startExternalMcpHost(projectRoot, bundle.project.settings, token);
  }
  return getExternalMcpHostStatus(projectRoot, bundle.project.settings);
}

async function startExternalMcpHost(projectRoot: string, settings: ProjectSettings, token?: string): Promise<void> {
  lastError = undefined;
  const host = settings.externalMcpHost.host;
  const port = settings.externalMcpHost.port;
  const sessions = new Map<string, HostSession>();
  const httpServer = http.createServer((req, res) => {
    void handleHttpRequest(req, res, projectRoot, sessions, token, settings.externalMcpHost.requireToken);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    runtime = { projectRoot, host, port, token, httpServer, sessions };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
}

function externalMcpHostStatus(
  settings: ProjectSettings,
  running: boolean,
  token?: string,
  error?: string
): ExternalMcpHostStatus {
  const endpoint = endpointFor(settings.externalMcpHost.host, settings.externalMcpHost.port);
  return {
    enabled: settings.externalMcpHost.enabled,
    running,
    host: settings.externalMcpHost.host,
    port: settings.externalMcpHost.port,
    endpoint,
    requireToken: settings.externalMcpHost.requireToken,
    writeMode: settings.externalMcpHost.writeMode,
    token,
    error,
    codexConfig: codexAppSetupText(endpoint, token),
    claudeConfig: JSON.stringify(httpClientConfig("archicode", endpoint, token), null, 2)
  };
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  projectRoot: string,
  sessions: Map<string, HostSession>,
  token: string | undefined,
  requireToken: boolean
): Promise<void> {
  if (req.url && new URL(req.url, "http://127.0.0.1").pathname !== MCP_PATH) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (requireToken && token && req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { ...corsHeaders(), "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Missing or invalid ArchiCode MCP bearer token." }));
    return;
  }
  for (const [key, value] of Object.entries(corsHeaders())) res.setHeader(key, value);
  let parsedBody: unknown;
  if (req.method === "POST") {
    try {
      parsedBody = await readRequestJson(req);
    } catch (error) {
      res.writeHead(400, { ...corsHeaders(), "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      return;
    }
  }
  const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
  let session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session && req.method === "POST" && isInitializePayload(parsedBody)) {
    session = await createMcpSession(projectRoot, sessions);
  }
  if (!session) {
    res.writeHead(sessionId ? 404 : 400, { ...corsHeaders(), "content-type": "application/json" });
    res.end(JSON.stringify({ error: sessionId ? "MCP session was not found." : "Mcp-Session-Id header is required." }));
    return;
  }
  await session.transport.handleRequest(req, res, parsedBody);
  if (req.method === "DELETE" && sessionId) sessions.delete(sessionId);
}

async function createMcpSession(projectRoot: string, sessions: Map<string, HostSession>): Promise<HostSession> {
  let sessionId: string | undefined;
  let session: HostSession;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: (id) => {
      sessionId = id;
      sessions.set(id, session);
    }
  });
  const mcpServer = createMcpServer(projectRoot);
  session = { transport, mcpServer };
  transport.onclose = () => {
    if (sessionId) sessions.delete(sessionId);
  };
  await mcpServer.connect(transport);
  return session;
}

async function readRequestJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 2_000_000) throw new Error("ArchiCode MCP request body exceeds the 2 MB limit.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  return JSON.parse(text) as unknown;
}

function isInitializePayload(payload: unknown): boolean {
  const messages = Array.isArray(payload) ? payload : [payload];
  return messages.some((message) =>
    Boolean(message && typeof message === "object" && (message as { method?: unknown }).method === "initialize")
  );
}

function createMcpServer(projectRoot: string): McpServer {
  const server = new McpServer(
    { name: "archicode-host", version: ARCHICODE_HOST_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: [
        "ArchiCode is a local Electron app that treats a visual graph as the durable software planning model.",
        "This MCP server exposes the opened ArchiCode project to local coding agents.",
        "Use archicode_get_scoped_change_context before coding; it reuses ArchiCode's build-run context builder and includes dirty nodes, pending graph changes, notes, runs, artifacts, memory, and scope directives.",
        "Use graph mutation tools only for validated graph/project updates; source code edits should be made through your normal coding environment.",
        "The hosted mutation surface is intentionally narrower than ArchiCode Research review cards. Treat the listed MCP tools as the complete set available to this client rather than assuming every in-app action is exposed here."
      ].join(" ")
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...readTools, ...writeTools] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await listResources(projectRoot) }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: "archicode://flow/{flowId}", name: "Flow", description: "One graph flow by id.", mimeType: JSON_MIME },
      { uriTemplate: "archicode://node/{flowId}/{nodeId}", name: "Node", description: "One graph node with notes, rules, and artifacts.", mimeType: JSON_MIME },
      { uriTemplate: "archicode://subflow/{flowId}/{subflowId}", name: "Subflow", description: "One detail flow and its member nodes.", mimeType: JSON_MIME },
      { uriTemplate: "archicode://context/flow/{flowId}", name: "Flow Smart Context", description: "Smart implementation context for one flow.", mimeType: JSON_MIME },
      { uriTemplate: "archicode://context/nodes/{flowId}/{nodeIds}", name: "Node Smart Context", description: "Smart implementation context for comma-separated node ids.", mimeType: JSON_MIME }
    ]
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => readResource(projectRoot, request.params.uri));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{
      name: "archicode_coding_orientation",
      title: "ArchiCode Coding Orientation",
      description: "How to use ArchiCode's hosted MCP context before changing source code.",
      arguments: [
        { name: "scope", description: "Project, flow, or node scope you intend to work on.", required: false }
      ]
    }]
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== "archicode_coding_orientation") {
      throw new Error(`Unknown ArchiCode MCP prompt: ${request.params.name}`);
    }
    const scope = request.params.arguments?.scope ?? "the current task";
    return {
      description: "Use this prompt to orient a coding agent to ArchiCode.",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `You are coding against an ArchiCode project for ${scope}.`,
            "Before editing source files, call archicode_about, then archicode_get_scoped_change_context with the narrowest accurate scope.",
            "Use the scoped context's runScope.directive, detailedNodes, summarizedNodes, pendingGraphChanges, notes, recentRuns, artifacts, and memory to understand what changed and why.",
            "Treat the ArchiCode graph as the planning source of truth. If source changes alter architecture, responsibilities, acceptance criteria, graph relationships, or implementation status, update the graph through the validated ArchiCode MCP tools."
          ].join("\n")
        }
      }]
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = sanitizeExternalValue(await callTool(projectRoot, request.params.name, request.params.arguments ?? {}));
      return { content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
      };
    }
  });
  return server;
}

async function listResources(projectRoot: string): Promise<Array<{ uri: string; name: string; description?: string; mimeType: string }>> {
  const bundle = await loadProject(projectRoot);
  return [
    { uri: "archicode://about", name: "About ArchiCode MCP", description: "What ArchiCode is and how this hosted MCP server should be used.", mimeType: JSON_MIME },
    { uri: "archicode://project", name: "Project", description: "Current ArchiCode project metadata.", mimeType: JSON_MIME },
    { uri: "archicode://context/project", name: "Project Smart Context", description: "Smart scoped implementation context anchored to the active flow.", mimeType: JSON_MIME },
    { uri: "archicode://flows", name: "Flows", description: "All ArchiCode graph flows.", mimeType: JSON_MIME },
    { uri: "archicode://rules", name: "Node Rules", description: "Reusable node rules and graph attachments.", mimeType: JSON_MIME },
    ...bundle.flows.map((flow) => ({
      uri: `archicode://flow/${encodeURIComponent(flow.id)}`,
      name: flow.name,
      description: flow.description,
      mimeType: JSON_MIME
    })),
    ...bundle.flows.filter((flow) => !flow.ignored).map((flow) => ({
      uri: `archicode://context/flow/${encodeURIComponent(flow.id)}`,
      name: `${flow.name} Smart Context`,
      description: `Smart implementation context for flow "${flow.name}".`,
      mimeType: JSON_MIME
    })),
    { uri: "archicode://graph-changes", name: "Graph Changes", description: "Graph change ledger.", mimeType: JSON_MIME },
    { uri: "archicode://runs", name: "Runs", description: "Recent ArchiCode run records.", mimeType: JSON_MIME },
    { uri: "archicode://incidents", name: "Incidents", description: "Recent runtime and debug incidents.", mimeType: JSON_MIME },
    { uri: "archicode://runtime-services", name: "Runtime Services", description: "Current Build/Run App runtime services.", mimeType: JSON_MIME },
    { uri: "archicode://artifacts", name: "Artifacts", description: "Known artifact metadata.", mimeType: JSON_MIME }
  ];
}

async function readResource(projectRoot: string, uri: string): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  const bundle = await loadProject(projectRoot);
  let value: unknown;
  if (uri === "archicode://about") value = aboutPayload(bundle);
  else if (uri === "archicode://project") value = bundle.project;
  else if (uri === "archicode://context/project") value = await scopedContext(projectRoot, { scopeKind: "project" });
  else if (uri === "archicode://flows") value = boundedFlows(bundle, 100, 500);
  else if (uri === "archicode://rules") value = getRules(bundle);
  else if (uri === "archicode://graph-changes") value = recentItems(bundle.graphChanges, 500);
  else if (uri === "archicode://runs") value = listRuns(bundle, undefined, 50, 50);
  else if (uri === "archicode://incidents") value = recentItems(bundle.incidents, 100);
  else if (uri === "archicode://runtime-services") value = await runtimeServicesView(projectRoot, 50);
  else if (uri === "archicode://artifacts") value = recentItems(externallyVisibleArtifacts(bundle), 500).map(compactArtifact);
  else if (uri.startsWith("archicode://flow/")) {
    const flowId = decodeURIComponent(uri.slice("archicode://flow/".length));
    value = requiredFlow(bundle, flowId);
  } else if (uri.startsWith("archicode://context/flow/")) {
    const flowId = decodeURIComponent(uri.slice("archicode://context/flow/".length));
    value = await scopedContext(projectRoot, { scopeKind: "flow", flowId });
  } else if (uri.startsWith("archicode://context/nodes/")) {
    const rest = uri.slice("archicode://context/nodes/".length);
    const [encodedFlowId, encodedNodeIds = ""] = rest.split("/");
    const nodeIds = decodeURIComponent(encodedNodeIds).split(",").map((idValue) => idValue.trim()).filter(Boolean);
    value = await scopedContext(projectRoot, {
      scopeKind: "nodes",
      flowId: decodeURIComponent(encodedFlowId),
      nodeIds
    });
  } else if (uri.startsWith("archicode://node/")) {
    const [encodedFlowId = "", encodedNodeId = ""] = uri.slice("archicode://node/".length).split("/");
    value = getNode(bundle, decodeURIComponent(encodedFlowId), decodeURIComponent(encodedNodeId));
  } else if (uri.startsWith("archicode://subflow/")) {
    const [encodedFlowId = "", encodedSubflowId = ""] = uri.slice("archicode://subflow/".length).split("/");
    const flow = requiredFlow(bundle, decodeURIComponent(encodedFlowId));
    const subflowId = decodeURIComponent(encodedSubflowId);
    const subflow = flow.subflows.find((item) => item.id === subflowId);
    if (!subflow) throw new Error(`Subflow ${subflowId} was not found.`);
    value = { flowId: flow.id, subflow, nodes: flow.nodes.filter((node) => node.subflowId === subflowId) };
  } else {
    throw new Error(`Unknown ArchiCode MCP resource: ${uri}`);
  }
  const sanitized = sanitizeExternalValue(value);
  return { contents: [{ uri, mimeType: JSON_MIME, text: JSON.stringify(sanitized.value, null, 2) }] };
}

async function callTool(projectRoot: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const bundle = await loadProject(projectRoot);
  if (name === "archicode_about") return aboutPayload(bundle);
  if (name === "archicode_get_project") return projectView(bundle, {
    maxFlows: integerArg(args, "maxFlows", 50, 1, 100),
    maxNodesPerFlow: integerArg(args, "maxNodesPerFlow", 500, 1, 1000),
    maxNotes: integerArg(args, "maxNotes", 100, 1, 500),
    maxRuns: integerArg(args, "maxRuns", 30, 1, 100),
    maxArtifacts: integerArg(args, "maxArtifacts", 200, 1, 500),
    maxGraphChanges: integerArg(args, "maxGraphChanges", 300, 1, 1000),
    maxIncidents: integerArg(args, "maxIncidents", 100, 1, 200)
  });
  if (name === "archicode_get_scoped_change_context") return scopedContext(projectRoot, {
    scopeKind: scopedKindArg(args),
    flowId: optionalStringArg(args, "flowId"),
    nodeIds: stringArrayArg(args, "nodeIds"),
    providerId: optionalStringArg(args, "providerId"),
    includeContextText: args.includeContextText === true,
    maxContextTextChars: integerArg(args, "maxContextTextChars", 120000, 1000, 500000),
    persistArtifacts: args.persistArtifacts === true
  });
  if (name === "archicode_get_flow") return requiredFlow(bundle, stringArg(args, "flowId"));
  if (name === "archicode_get_node") return getNode(bundle, stringArg(args, "flowId"), stringArg(args, "nodeId"));
  if (name === "archicode_get_rules") return getRules(bundle, optionalStringArg(args, "flowId"), optionalStringArg(args, "nodeId"));
  if (name === "archicode_search_graph") return searchGraph(bundle, stringArg(args, "query"), integerArg(args, "maxResults", 25, 1, 100));
  if (name === "archicode_query_code_graph") {
    const snapshot = await readCodeKnowledgeSnapshot(projectRoot);
    if (!snapshot) return { available: false, message: "The local code graph is not available yet. Import or refresh the code knowledge map first." };
    const action = stringArg(args, "action");
    if (!["search", "neighbors", "path", "impact"].includes(action)) throw new Error("action must be search, neighbors, path, or impact.");
    const direction = optionalStringArg(args, "direction");
    if (direction && !["incoming", "outgoing", "both"].includes(direction)) throw new Error("direction must be incoming, outgoing, or both.");
    const kinds = (stringArrayArg(args, "kinds") ?? []).filter((kind): kind is CodeKnowledgeEdge["kind"] => ["contains", "dependency", "calls", "runtime"].includes(kind));
    return {
      available: true,
      generatedAt: snapshot.generatedAt,
      snapshotStats: snapshot.stats,
      ...queryCodeKnowledgeSnapshot(snapshot, {
        action: action as CodeKnowledgeQueryInput["action"],
        query: optionalStringArg(args, "query"),
        source: optionalStringArg(args, "source"),
        target: optionalStringArg(args, "target"),
        direction: direction as CodeKnowledgeQueryInput["direction"],
        kinds,
        maxResults: integerArg(args, "maxResults", 20, 1, 40),
        maxDepth: integerArg(args, "maxDepth", 1, 1, 4)
      })
    };
  }
  if (name === "archicode_list_runs") return listRuns(bundle, optionalStringArg(args, "status"), integerArg(args, "maxResults", 20, 1, 50), integerArg(args, "maxLogs", 50, 0, 200));
  if (name === "archicode_get_graph_changes") return recentItems(bundle.graphChanges.filter((change) => !optionalStringArg(args, "status") || change.status === optionalStringArg(args, "status")), integerArg(args, "maxResults", 100, 1, 1000));
  if (name === "archicode_list_incidents") return recentItems(bundle.incidents.filter((incident) => !optionalStringArg(args, "status") || incident.status === optionalStringArg(args, "status")), integerArg(args, "maxResults", 50, 1, 200));
  if (name === "archicode_list_runtime_services") return runtimeServicesView(projectRoot, integerArg(args, "maxLogs", 50, 0, 200));
  if (name === "archicode_read_artifact") return readArtifact(projectRoot, bundle, optionalStringArg(args, "artifactId"), optionalStringArg(args, "path"), integerArg(args, "maxChars", 40000, 1000, 80000));
  if (name === "archicode_update_project") return applyHostedOperation(projectRoot, name, { kind: "update-project", patch: objectArg(args, "patch") });
  if (name === "archicode_update_flow") return applyHostedOperation(projectRoot, name, { kind: "update-flow", flowId: stringArg(args, "flowId"), patch: objectArg(args, "patch") });
  if (name === "archicode_update_subflow") return applyHostedOperation(projectRoot, name, { kind: "update-subflow", flowId: stringArg(args, "flowId"), subflowId: stringArg(args, "subflowId"), patch: objectArg(args, "patch") });
  if (name === "archicode_create_subflow") return applyHostedOperation(projectRoot, name, { kind: "create-subflow", flowId: stringArg(args, "flowId"), subflow: objectArg(args, "subflow") });
  if (name === "archicode_delete_subflow") return applyHostedOperation(projectRoot, name, { kind: "delete-subflow", flowId: stringArg(args, "flowId"), subflowId: stringArg(args, "subflowId") });
  if (name === "archicode_link_node_subflow") return applyHostedOperation(projectRoot, name, { kind: "link-node-subflow", flowId: stringArg(args, "flowId"), nodeId: stringArg(args, "nodeId"), subflowId: nullableStringArg(args, "subflowId") });
  if (name === "archicode_create_group") return applyHostedOperation(projectRoot, name, { kind: "create-group", flowId: stringArg(args, "flowId"), group: objectArg(args, "group") });
  if (name === "archicode_update_group") return applyHostedOperation(projectRoot, name, { kind: "update-group", flowId: stringArg(args, "flowId"), groupId: stringArg(args, "groupId"), patch: objectArg(args, "patch") });
  if (name === "archicode_delete_group") return applyHostedOperation(projectRoot, name, { kind: "delete-group", flowId: stringArg(args, "flowId"), groupId: stringArg(args, "groupId") });
  if (name === "archicode_update_node") return applyHostedOperation(projectRoot, name, { kind: "update-node", flowId: stringArg(args, "flowId"), patch: objectArg(args, "patch") });
  if (name === "archicode_generate_acceptance_checks") return publishAfterWrite(projectRoot, name, async () => {
    const { results } = await generateAcceptanceChecksScoped(projectRoot, stringArg(args, "flowId"), optionalStringArg(args, "nodeId"));
    const totalAdded = results.reduce((sum, result) => sum + result.added, 0);
    return {
      totalChecksAdded: totalAdded,
      nodesProcessed: results.length,
      perNode: results
    };
  });
  if (name === "archicode_create_node") return applyHostedOperation(projectRoot, name, { kind: "create-node", flowId: stringArg(args, "flowId"), node: objectArg(args, "node") });
  if (name === "archicode_create_edge") return applyHostedOperation(projectRoot, name, { kind: "create-edge", flowId: stringArg(args, "flowId"), edge: objectArg(args, "edge") });
  if (name === "archicode_update_edge") return applyHostedOperation(projectRoot, name, { kind: "update-edge", flowId: stringArg(args, "flowId"), edgeId: stringArg(args, "edgeId"), patch: objectArg(args, "patch") });
  if (name === "archicode_delete_node") return applyHostedOperation(projectRoot, name, { kind: "delete-node", flowId: stringArg(args, "flowId"), nodeId: stringArg(args, "nodeId") });
  if (name === "archicode_delete_edge") return applyHostedOperation(projectRoot, name, { kind: "delete-edge", flowId: stringArg(args, "flowId"), edgeId: stringArg(args, "edgeId") });
  if (name === "archicode_add_note") {
    return applyHostedOperation(projectRoot, name, { kind: "add-note", note: objectArg(args, "note") });
  }
  if (name === "archicode_resolve_note") {
    return applyHostedOperation(projectRoot, name, { kind: "resolve-note", noteId: stringArg(args, "noteId"), resolved: args.resolved !== false });
  }
  if (name === "archicode_delete_note") return applyHostedOperation(projectRoot, name, { kind: "delete-note", noteId: stringArg(args, "noteId") });
  if (name === "archicode_run_acceptance_checks") return applyHostedOperation(projectRoot, name, { kind: "run-acceptance-checks", flowId: stringArg(args, "flowId"), nodeId: stringArg(args, "nodeId") });
  if (name === "archicode_upsert_run_profile") return applyHostedOperation(projectRoot, name, { kind: "propose-run-profile", mode: stringArg(args, "mode") as "create" | "replace", profile: objectArg(args, "profile"), reason: optionalStringArg(args, "reason") });
  throw new Error(`Unknown ArchiCode MCP tool: ${name}`);
}

function searchGraph(bundle: ProjectBundle, query: string, maxResults: number): Array<Record<string, unknown>> {
  const normalized = query.toLowerCase();
  const results: Array<Record<string, unknown>> = [];
  const push = (item: Record<string, unknown>, haystack: string): void => {
    if (results.length >= maxResults || !haystack.toLowerCase().includes(normalized)) return;
    results.push(item);
  };
  for (const flow of bundle.flows) {
    push({ kind: "flow", id: flow.id, name: flow.name, description: flow.description }, `${flow.id} ${flow.name} ${flow.description}`);
    for (const subflow of flow.subflows) {
      push({ kind: "subflow", flowId: flow.id, ...subflow }, `${subflow.id} ${subflow.name} ${subflow.parentNodeId ?? ""} ${subflow.parentSubflowId ?? ""}`);
    }
    for (const group of flow.groups) {
      const memberNodeIds = flow.nodes.filter((node) => node.groupId === group.id).map((node) => node.id);
      push({ kind: "group", flowId: flow.id, ...group, memberNodeIds }, `${group.id} ${group.name} ${group.color ?? ""} ${memberNodeIds.join(" ")}`);
    }
    for (const edge of flow.edges) {
      const sourceTitle = flow.nodes.find((node) => node.id === edge.source)?.title ?? edge.source;
      const targetTitle = flow.nodes.find((node) => node.id === edge.target)?.title ?? edge.target;
      push({ kind: "edge", flowId: flow.id, ...edge, sourceTitle, targetTitle }, `${edge.id} ${edge.source} ${sourceTitle} ${edge.target} ${targetTitle} ${edge.label ?? ""}`);
    }
    for (const node of flow.nodes) {
      push({
        kind: "node",
        flowId: flow.id,
        id: node.id,
        type: node.type,
        title: node.title,
        description: node.description,
        stage: node.stage,
        implementationScope: node.implementationScope
      }, `${node.id} ${node.type} ${node.title} ${node.description} ${node.techStack.join(" ")} ${node.acceptanceCriteria.join(" ")} ${JSON.stringify(node.acceptanceChecks)} ${JSON.stringify(node.todos)} ${JSON.stringify(node.flags)} ${JSON.stringify(node.ruleIds)} ${node.groupId ?? ""} ${node.subflowId ?? ""} ${JSON.stringify(node.customProperties)} ${JSON.stringify(node.implementationScope)}`);
    }
  }
  for (const rule of bundle.project.settings.nodeRules ?? []) {
    push({ ...rule, intentKind: rule.kind ?? "guidance", kind: "rule" }, `${rule.id} ${rule.title} ${rule.body}`);
  }
  for (const note of bundle.notes) {
    push({ kind: "note", id: note.id, flowId: note.flowId, nodeId: note.nodeId, body: note.body }, `${note.id} ${note.body}`);
  }
  for (const run of bundle.runs) push({ kind: "run", id: run.id, flowId: run.flowId, nodeId: run.nodeId, status: run.status, phase: run.phase, promptSummary: run.promptSummary }, `${run.id} ${run.status} ${run.phase} ${run.promptSummary} ${run.logs.map((log) => log.text).join(" ")}`);
  for (const incident of bundle.incidents) push({ kind: "incident", ...incident }, `${incident.id} ${incident.title} ${incident.description} ${incident.status} ${incident.priority}`);
  for (const artifact of externallyVisibleArtifacts(bundle)) push({ kind: "artifact", ...compactArtifact(artifact) }, `${artifact.id} ${artifact.title} ${artifact.summary ?? ""} ${artifact.path} ${artifact.type}`);
  for (const change of bundle.graphChanges) push({ recordType: "graph-change", ...change }, `${change.id} ${change.kind} ${change.summary} ${change.status} ${change.fieldPaths.join(" ")}`);
  return results;
}

function listRuns(bundle: ProjectBundle, status: string | undefined, maxResults: number, maxLogs: number): unknown {
  const runs = bundle.runs
    .filter((run) => !status || run.status === status)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, maxResults);
  return runs.map((run) => ({
    ...run,
    logs: run.logs.slice(-maxLogs),
    logsOmitted: Math.max(0, run.logs.length - maxLogs),
    artifacts: externallyVisibleArtifacts(bundle).filter((artifact) => artifact.runId === run.id).map(compactArtifact)
  }));
}

function artifactPathStem(artifactPath: string): string {
  return path.basename(artifactPath).replace(/\.[^.]+$/, "");
}

function resolveArtifactReference(bundle: ProjectBundle, artifactId?: string, artifactPath?: string): Artifact | undefined {
  const artifacts = externallyVisibleArtifacts(bundle);
  if (artifactId) {
    const exact = artifacts.find((item) => item.id === artifactId);
    if (exact) return exact;
    const byPath = artifacts.find((item) =>
      item.path === artifactId ||
      path.basename(item.path) === artifactId ||
      artifactPathStem(item.path) === artifactId
    );
    if (byPath) return byPath;
  }
  if (artifactPath) {
    const normalizedPath = artifactPath.replace(/^\.\//, "");
    return artifacts.find((item) =>
      item.path === artifactPath ||
      item.path === normalizedPath ||
      path.basename(item.path) === artifactPath ||
      artifactPathStem(item.path) === artifactPath
    );
  }
  return undefined;
}

async function readArtifact(projectRoot: string, bundle: ProjectBundle, artifactId?: string, artifactPath?: string, maxChars = 40000): Promise<unknown> {
  if (!artifactId && !artifactPath) throw new Error("artifactId or path is required.");
  const artifact = resolveArtifactReference(bundle, artifactId, artifactPath);
  if (!artifact) throw new Error("Artifact was not found.");
  const rawText = await readArtifactText(projectRoot, artifact.path);
  const redacted = redactSensitiveText(rawText);
  return {
    ...compactArtifact(artifact),
    text: redacted.text.slice(0, maxChars),
    redacted: redacted.redacted,
    truncated: redacted.text.length > maxChars,
    originalChars: rawText.length
  };
}

function compactArtifact(artifact: Artifact): Record<string, unknown> {
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    path: artifact.path,
    mediaType: artifact.mediaType,
    nodeId: artifact.nodeId,
    noteId: artifact.noteId,
    runId: artifact.runId,
    status: artifact.status,
    summary: artifact.summary,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt
  };
}

function externallyVisibleArtifacts(bundle: ProjectBundle): Artifact[] {
  return bundle.artifacts.filter((artifact) => artifact.type !== "chat-artifact");
}

function notesWithAttachments(bundle: ProjectBundle, notes: Note[]): Array<Note & { attachments: Array<Record<string, unknown>> }> {
  const artifactsById = new Map(externallyVisibleArtifacts(bundle).map((artifact) => [artifact.id, artifact]));
  return notes.map((note) => ({
    ...note,
    attachments: note.attachmentIds.flatMap((attachmentId) => {
      const artifact = artifactsById.get(attachmentId);
      return artifact ? [compactArtifact(artifact)] : [];
    })
  }));
}

function getNode(bundle: ProjectBundle, flowId: string, nodeId: string): unknown {
  const flow = requiredFlow(bundle, flowId);
  const node = flow.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} was not found.`);
  const notes = bundle.notes.filter((note) => note.flowId === flowId && note.nodeId === nodeId);
  return {
    flowId,
    node,
    attachedRules: resolveNodeRules(bundle, node.ruleIds ?? []),
    notes: notesWithAttachments(bundle, notes),
    artifacts: externallyVisibleArtifacts(bundle).filter((artifact) => artifact.nodeId === nodeId).map(compactArtifact)
  };
}

function getRules(bundle: ProjectBundle, flowId?: string, nodeId?: string): Record<string, unknown> {
  if (nodeId && !flowId) throw new Error("flowId is required when nodeId is provided.");
  const rules = bundle.project.settings.nodeRules ?? [];
  const attachments = bundle.flows.flatMap((flow) =>
    flow.nodes.flatMap((node) => (node.ruleIds ?? []).map((ruleId) => {
      const rule = rules.find((item) => item.id === ruleId);
      return {
        ruleId,
        ruleTitle: rule?.title ?? "Missing rule",
        flowId: flow.id,
        flowName: flow.name,
        nodeId: node.id,
        nodeTitle: node.title,
        missing: !rule
      };
    }))
  ).filter((attachment) =>
    (!flowId || attachment.flowId === flowId) &&
    (!nodeId || attachment.nodeId === nodeId)
  );
  const node = nodeId && flowId
    ? requiredFlow(bundle, flowId).nodes.find((item) => item.id === nodeId)
    : undefined;
  if (nodeId && !node) throw new Error(`Node ${nodeId} was not found.`);

  return {
    rules,
    attachments,
    selectedNode: node && flowId ? {
      flowId,
      nodeId: node.id,
      nodeTitle: node.title,
      ruleIds: node.ruleIds ?? [],
      attachedRules: resolveNodeRules(bundle, node.ruleIds ?? [])
    } : undefined
  };
}

function resolveNodeRules(bundle: ProjectBundle, ruleIds: string[]): Array<{ id: string; title: string; body: string; updatedAt?: string }> {
  const rules = bundle.project.settings.nodeRules ?? [];
  return ruleIds.flatMap((ruleId) => {
    const rule = rules.find((item) => item.id === ruleId);
    return rule ? [{ id: rule.id, title: rule.title, body: rule.body, updatedAt: rule.updatedAt }] : [];
  });
}

function aboutPayload(bundle: ProjectBundle): Record<string, unknown> {
  const activeFlow = bundle.flows.find((flow) => flow.id === bundle.project.activeFlowId) ?? bundle.flows[0];
  return {
    server: {
      name: "archicode-host",
      version: ARCHICODE_HOST_VERSION,
      transport: "Streamable HTTP",
      endpointPath: MCP_PATH,
      locality: "local-only localhost host",
      auth: "bearer token when enabled in Advanced settings"
    },
    archicode: {
      name: "ArchiCode",
      description: "A local visual-first Electron app for planning, evolving, and implementing software through a durable project graph.",
      capabilityVersion: archicodeCapabilityVersion,
      capabilities: archicodeCapabilityDigest(),
      currentProjectOptions: archicodeCurrentProjectOptions(bundle.project.settings),
      graphTruth: "Flows, nodes, edges, notes, runs, artifacts, metadata, and graph-change history are the planning source of truth. Source code changes should be reflected back into the graph when they alter architecture, responsibilities, contracts, acceptance criteria, graph relationships, or implementation state.",
      workflow: [
        "Model the project as graph flows and nodes.",
        "Use scoped build context to understand changed and dirty graph areas before coding.",
        "Apply source edits in the normal workspace.",
        "Record validated graph mutations and notes through ArchiCode operations."
      ]
    },
    guidance: {
      firstCalls: ["archicode_about", "archicode_get_scoped_change_context"],
      bestContextTool: "archicode_get_scoped_change_context",
      bestContextResources: ["archicode://context/project", activeFlow ? `archicode://context/flow/${encodeURIComponent(activeFlow.id)}` : undefined].filter(Boolean),
      prompt: "archicode_coding_orientation",
      note: "The scoped context reuses ArchiCode's build-run context builder, including dirty/changed nodes, pending graph changes, notes, recent runs, artifacts, memory, and run-scope directives.",
      mutationSurface: {
        mode: "direct validated apply",
        availableTools: writeTools.map((entry) => entry.name),
        limitation: "Only listed hosted MCP mutations are callable. Other in-app Research actions remain available through ArchiCode's review-card workflow, not implicitly through this server.",
        intentionallyExcluded: {
          queueAndDebugActions: "Starting, retrying, or debugging agent/runtime runs remains an in-app, user-reviewed action.",
          providerAndSecretSettings: "Provider credentials, MCP credentials, and security settings are never exposed or mutated through this server."
        }
      }
    },
    prompts: [{
      name: "archicode_coding_orientation",
      title: "ArchiCode Coding Orientation",
      description: "Orient a coding agent to use ArchiCode graph truth and scoped context before changing source code.",
      arguments: [{ name: "scope", required: false, description: "Project, flow, or node scope you intend to work on." }]
    }],
    project: {
      id: bundle.project.id,
      name: bundle.project.name,
      rootPath: bundle.project.rootPath,
      activeFlowId: activeFlow?.id,
      flowCount: bundle.flows.length,
      nodeCount: bundle.flows.reduce((count, flow) => count + flow.nodes.length, 0),
      edgeCount: bundle.flows.reduce((count, flow) => count + flow.edges.length, 0),
      runCount: bundle.runs.length,
      artifactCount: externallyVisibleArtifacts(bundle).length,
      pendingGraphChangeCount: bundle.graphChanges.filter((change) => change.status === "pending").length
    }
  };
}

async function scopedContext(
  projectRoot: string,
  input: {
    scopeKind: "project" | "flow" | "nodes";
    flowId?: string;
    nodeIds?: string[];
    providerId?: string;
    includeContextText?: boolean;
    maxContextTextChars?: number;
    persistArtifacts?: boolean;
  }
): Promise<Record<string, unknown>> {
  const bundle = await loadProject(projectRoot);
  const flow = input.flowId
    ? requiredFlow(bundle, input.flowId)
    : bundle.flows.find((item) => item.id === bundle.project.activeFlowId && !item.ignored) ?? bundle.flows.find((item) => !item.ignored);
  if (!flow) throw new Error("No active ArchiCode flow is available for scoped context.");

  const selectedNodeIds = input.scopeKind === "nodes" ? uniqueStringArray(input.nodeIds ?? []) : [];
  if (input.scopeKind === "nodes" && !selectedNodeIds.length) throw new Error("nodeIds is required for nodes scoped context.");
  for (const nodeId of selectedNodeIds) {
    if (!flow.nodes.some((node) => node.id === nodeId)) throw new Error(`Node ${nodeId} was not found.`);
  }

  const scope: RunScope = input.scopeKind === "project"
    ? { kind: "project", flowId: flow.id, nodeIds: [] }
    : input.scopeKind === "nodes"
      ? { kind: "nodes", flowId: flow.id, nodeIds: selectedNodeIds }
      : { kind: "flow", flowId: flow.id, nodeIds: [] };
  const nodeId = scope.kind === "nodes" ? selectedNodeIds[0] : undefined;
  const built = await buildContext(projectRoot, flow.id, nodeId, input.providerId, scope, {
    persistArtifacts: input.persistArtifacts === true
  });
  const maxChars = input.maxContextTextChars ?? 120000;
  return {
    scope,
    context: parseContextText(built.text),
    summary: built.summary,
    artifacts: built.artifacts.map(compactArtifact),
    contextText: input.includeContextText ? built.text.slice(0, maxChars) : undefined,
    contextTextTruncated: input.includeContextText ? built.text.length > maxChars : undefined,
    usage: {
      preferredForCodingAgents: true,
      note: "Use this before source edits. It is the same smart context ArchiCode prepares for build runs."
    }
  };
}

function projectView(
  bundle: ProjectBundle,
  limits: { maxFlows: number; maxNodesPerFlow: number; maxNotes: number; maxRuns: number; maxArtifacts: number; maxGraphChanges: number; maxIncidents: number }
): Record<string, unknown> {
  const artifacts = externallyVisibleArtifacts(bundle);
  return {
    project: bundle.project,
    flows: boundedFlows(bundle, limits.maxFlows, limits.maxNodesPerFlow),
    notes: recentItems(bundle.notes, limits.maxNotes),
    runs: listRuns(bundle, undefined, limits.maxRuns, 30),
    artifacts: recentItems(artifacts, limits.maxArtifacts).map(compactArtifact),
    graphChanges: recentItems(bundle.graphChanges, limits.maxGraphChanges),
    incidents: recentItems(bundle.incidents, limits.maxIncidents),
    omitted: {
      notes: Math.max(0, bundle.notes.length - limits.maxNotes),
      flows: Math.max(0, bundle.flows.length - limits.maxFlows),
      nodesByFlow: Object.fromEntries(bundle.flows.slice(0, limits.maxFlows).map((flow) => [flow.id, Math.max(0, flow.nodes.length - limits.maxNodesPerFlow)])),
      runs: Math.max(0, bundle.runs.length - limits.maxRuns),
      artifacts: Math.max(0, artifacts.length - limits.maxArtifacts),
      graphChanges: Math.max(0, bundle.graphChanges.length - limits.maxGraphChanges),
      incidents: Math.max(0, bundle.incidents.length - limits.maxIncidents)
    }
  };
}

function boundedFlows(bundle: ProjectBundle, maxFlows: number, maxNodesPerFlow: number): ProjectBundle["flows"] {
  return bundle.flows.slice(0, maxFlows).map((flow) => {
    const nodes = flow.nodes.slice(0, maxNodesPerFlow);
    const nodeIds = new Set(nodes.map((node) => node.id));
    return { ...flow, nodes, edges: flow.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)) };
  });
}

function recentItems<T extends { createdAt?: string; updatedAt?: string }>(items: T[], maxResults: number): T[] {
  return items.slice().sort((left, right) =>
    (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? "")
  ).slice(0, maxResults);
}

async function runtimeServicesView(projectRoot: string, maxLogs: number): Promise<unknown> {
  const services = await listRuntimeServices(projectRoot);
  return services.map((service) => ({
    ...service,
    logs: service.logs.slice(-maxLogs),
    logsOmitted: Math.max(0, service.logs.length - maxLogs)
  }));
}

async function applyHostedOperation(projectRoot: string, action: string, operation: unknown): Promise<Record<string, unknown>> {
  return publishAfterWrite(projectRoot, action, async () => {
    const result = await applyExternalGraphOperation(projectRoot, operation);
    const operationRecord = operation && typeof operation === "object" ? operation as Record<string, unknown> : {};
    const noteRecord = operationRecord.note && typeof operationRecord.note === "object" ? operationRecord.note as Record<string, unknown> : undefined;
    const createdNote = operationRecord.kind === "add-note" && noteRecord
      ? result.bundle.notes.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)).find((note) =>
          note.flowId === noteRecord.flowId && note.nodeId === noteRecord.nodeId && note.body === noteRecord.body
        )
      : undefined;
    return {
      message: result.message,
      project: {
        id: result.bundle.project.id,
        name: result.bundle.project.name,
        updatedAt: result.bundle.project.updatedAt
      },
      graphChangeCount: result.bundle.graphChanges.length,
      mutation: createdNote ? { noteId: createdNote.id } : undefined
    };
  });
}

async function publishAfterWrite<T>(projectRoot: string, action: string, task: () => Promise<T>): Promise<T> {
  const result = await task();
  projectUpdatePublisher?.(projectRoot, { source: "mcp", action });
  return result;
}

function parseContextText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { rawTextUnavailable: true };
  }
}

function requiredFlow(bundle: ProjectBundle, flowId: string): ProjectBundle["flows"][number] {
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  return flow;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required?: string[]): ToolSpec {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required?.length ? { required } : {})
    }
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nullableStringArg(args: Record<string, unknown>, key: string): string | null {
  if (args[key] === null) return null;
  return stringArg(args, key);
}

function scopedKindArg(args: Record<string, unknown>): "project" | "flow" | "nodes" {
  const value = optionalStringArg(args, "scopeKind") ?? "project";
  if (value === "project" || value === "flow" || value === "nodes") return value;
  throw new Error("scopeKind must be project, flow, or nodes.");
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${key} must be an array of strings.`);
  return uniqueStringArray(value);
}

function uniqueStringArray(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function objectArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} object is required.`);
  return value as Record<string, unknown>;
}

function integerArg(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function endpointFor(host: string, port: number): string {
  return `http://${host}:${port}${MCP_PATH}`;
}

function httpClientConfig(name: string, endpoint: string, token?: string): unknown {
  return {
    mcpServers: {
      [name]: {
        type: "http",
        url: endpoint,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {})
      }
    }
  };
}

function codexAppSetupText(endpoint: string, token?: string): string {
  return [
    "ArchiCode Hosted MCP - Codex app setup",
    "",
    "Open Codex Settings -> MCP servers -> Connect to a custom MCP.",
    "",
    "Name: ArchiCode",
    "Type: Streamable HTTP",
    `URL: ${endpoint}`,
    "Bearer token env var: leave empty",
    "",
    "Direct headers:",
    ...(token ? [`Authorization: Bearer ${token}`] : []),
    "default_tools_approval_mode: auto",
    "",
    "Headers from environment variables: leave empty"
  ].join("\n");
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "http://127.0.0.1",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, default_tools_approval_mode, mcp-session-id, mcp-protocol-version",
    "access-control-expose-headers": "mcp-session-id"
  };
}
