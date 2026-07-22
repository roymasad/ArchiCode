import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ProviderMcpTool } from "./mcp";
import { embeddedClassifyCommandRiskSource, embeddedSubprocessEnvSource } from "../shared/execution";
import { embeddedNetworkGuardSource, guardedFetchText } from "../shared/networkGuard";
import {
  nodeRuleSchema,
  runStatusSchema,
  type NodeRule,
  type ProjectBundle,
  type ProjectSettings
} from "../shared/schema";
import { queryCodeKnowledgeSnapshot, type CodeKnowledgeQueryInput } from "../shared/codeKnowledge";
import { readCodeKnowledgeSnapshot } from "./importer/knowledgeSnapshot";

export const ARCHICODE_INTERNAL_SERVER_ID = "archicode-internal-tools";
const ARCHICODE_INTERNAL_SERVER_LABEL = "ArchiCode Tools";
export const ARCHICODE_RESEARCH_RULES_SERVER_ID = "archicode-research-rules";
export const ARCHICODE_RESEARCH_RULES_TOOL_NAME = "archicode_project_manage_rules";
const ARCHICODE_RESEARCH_RULES_SERVER_LABEL = "ArchiCode Rules";
const TOOL_MAX_FILES = 900;
const TOOL_MAX_RESULTS = 500;
const TOOL_MAX_READ_CHARS = 80_000;
const TOOL_COMMAND_TIMEOUT_MS = 60_000;
const BRAVE_WEB_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_WEB_SEARCH_API_KEY_ENV = "ARCHICODE_BRAVE_SEARCH_API_KEY";
const requireFromInternalTools = createRequire(import.meta.url);
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  ".cache",
  ".vite",
  ".turbo"
]);

type ProjectFile = { path: string; size: number; binary: boolean };
type FileInventory = { rootPath: string; files: ProjectFile[]; omittedFiles: number };

export type InternalToolCallInput = {
  providerToolName: string;
  argumentsJson: string;
};

export type InternalToolCallOutput = {
  serverId: string;
  serverLabel: string;
  toolName: string;
  resultText: string;
};

export type InternalConsoleCommandResult = {
  command: string;
  cwd: string;
  risk: "low" | "medium" | "high";
  status: "succeeded" | "failed" | "denied" | "approval-required" | "redirected" | "rejected";
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  message?: string;
};

export type InternalToolEnvironment = {
  projectRoot: string;
  settings: ProjectSettings;
  loadProject: () => Promise<ProjectBundle>;
  readArtifactText: (artifactRelativePath: string) => Promise<string>;
  runConsoleCommand?: (args: Record<string, unknown>) => Promise<InternalConsoleCommandResult>;
  resolveWebSearchApiKey?: () => Promise<string | undefined>;
  /** Research-only mutation capability. It is intentionally absent from the generated internal MCP server. */
  researchRules?: {
    updateProjectSettings: (settings: ProjectSettings) => Promise<ProjectBundle>;
    updateNodeRuleIds: (flowId: string, nodeId: string, ruleIds: string[]) => Promise<ProjectBundle>;
  };
};

let webSearchSecretResolver: (() => Promise<string | undefined>) | null = null;

export function setWebSearchSecretResolver(
  resolver: (() => Promise<string | undefined>) | null
): void {
  webSearchSecretResolver = resolver;
}

function webSearchProvider(settings: ProjectSettings): ProjectSettings["webSearch"]["provider"] {
  return settings.webSearch.provider ?? "native";
}

function internalSearchEnabled(settings: ProjectSettings): boolean {
  return settings.webSearch.enabled && webSearchProvider(settings) === "brave";
}

export function archicodeInternalTools(settings: ProjectSettings): ProviderMcpTool[] {
  const tools: ProviderMcpTool[] = [archicodeRulesReadTool()];
  if (settings.agentTools.projectFiles) {
    tools.push(
      tool("archicode_project_list_files", "list_files", "List files and directories inside the current project root. Use this before reading unknown paths.", {
        type: "object",
        additionalProperties: false,
        properties: {
          directory: { type: "string", description: "Project-relative directory to list. Defaults to the project root." },
          recursive: { type: "boolean", description: "Whether to list files recursively. Defaults to false." },
          maxResults: { type: "integer", minimum: 1, maximum: TOOL_MAX_RESULTS, description: "Maximum entries to return." }
        }
      }),
      tool("archicode_project_search_files", "search_files", "Search readable project files by path and text content. Results include matching line snippets.", {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, description: "Text or path fragment to search for." },
          directory: { type: "string", description: "Optional project-relative directory to restrict the search." },
          maxResults: { type: "integer", minimum: 1, maximum: 100, description: "Maximum matches to return." }
        }
      }),
      tool("archicode_project_read_file", "read_file", "Read a readable project file by project-relative path. Returns the current file sha256 for replace operations. Secrets are redacted and long files are truncated.", {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1, description: "Project-relative file path to read." },
          startLine: { type: "integer", minimum: 1, description: "Optional 1-based first line to read." },
          endLine: { type: "integer", minimum: 1, description: "Optional 1-based last line to read." },
          maxChars: { type: "integer", minimum: 1, maximum: TOOL_MAX_READ_CHARS, description: "Maximum characters to return." }
        }
      }),
      tool("archicode_project_query_code_graph", "query_code_graph", "Query the local structural code graph without loading it into context. Supports bounded file/symbol search, neighbors, shortest paths, and reverse impact.", {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["search", "neighbors", "path", "impact"] },
          query: { type: "string", description: "Search text for the search action." },
          source: { type: "string", description: "Exact node id, file path, or unique symbol label for neighbors, path, or impact." },
          target: { type: "string", description: "Exact node id, file path, or unique symbol label for the path target." },
          direction: { type: "string", enum: ["incoming", "outgoing", "both"], description: "Neighbor traversal direction. Defaults to both." },
          kinds: { type: "array", maxItems: 4, items: { type: "string", enum: ["contains", "dependency", "calls", "runtime"] } },
          maxResults: { type: "integer", minimum: 1, maximum: 40, description: "Hard-bounded node result count. Defaults to 20." },
          maxDepth: { type: "integer", minimum: 1, maximum: 4, description: "Neighbor depth. Defaults to 1." }
        }
      })
    );
  }
  if (settings.agentTools.runArtifacts) {
    tools.push(
      tool("archicode_project_list_runs", "list_runs", "List recent ArchiCode queue runs, including status, phase, todos, planned commands, and artifact ids.", {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: runStatusSchema.options, description: "Optional run status filter." },
          maxResults: { type: "integer", minimum: 1, maximum: 50, description: "Maximum runs to return." }
        }
      }),
      tool("archicode_project_read_run", "read_run", "Read one ArchiCode run with logs, todos, planned commands, traces, plan artifact ids, and produced artifact ids.", {
        type: "object",
        additionalProperties: false,
        required: ["runId"],
        properties: {
          runId: { type: "string", minLength: 1, description: "Run id to inspect." },
          maxLogs: { type: "integer", minimum: 1, maximum: 200, description: "Maximum trailing log entries to include." }
        }
      }),
      tool("archicode_project_read_artifact", "read_artifact", "Read a known ArchiCode artifact by artifact id or artifact path. Use this for run plans, traces, diffs, and generated reports.", {
        type: "object",
        additionalProperties: false,
        properties: {
          artifactId: { type: "string", minLength: 1, description: "Artifact id from run or project context." },
          path: { type: "string", minLength: 1, description: "Artifact path from run or project context." },
          maxChars: { type: "integer", minimum: 1, maximum: TOOL_MAX_READ_CHARS, description: "Maximum characters to return." }
        }
      })
    );
  }
  if (settings.agentTools.console) {
    tools.push(tool("archicode_console_run_command", "run_command", "Run a bounded project command through ArchiCode's shared safety broker. Choose any project-scoped command that advances the goal. Safe actions run and higher-risk actions follow the user's auto-approval or approval settings. Parent Chat's sole role restriction here is that it must route project-code edits through the graph/build implementation path.", {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { type: "string", minLength: 1, description: "Bounded command chosen for the current goal." },
        cwd: { type: "string", description: "Optional project-relative working directory." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: TOOL_COMMAND_TIMEOUT_MS, description: "Optional timeout in milliseconds." }
      }
    }));
  }
  if (settings.webSearch.enabled) {
    if (internalSearchEnabled(settings)) {
      tools.push(tool("archicode_web_search", "web_search", "Search the web through ArchiCode's configured Brave Search backend when project settings allow web access.", {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, description: "Search query." },
          maxResults: { type: "integer", minimum: 1, maximum: 8, description: "Maximum concise results." }
        }
      }));
    }
    tools.push(
      tool("archicode_web_open_url", "web_open_url", "Open a URL read-only and return extracted page text when project settings allow web access.", {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", minLength: 1, pattern: "^https?://", description: "http or https URL to fetch." },
          maxChars: { type: "integer", minimum: 500, maximum: TOOL_MAX_READ_CHARS, description: "Maximum extracted characters." }
        }
      })
    );
  }
  return tools;
}

function archicodeRulesReadTool(): ProviderMcpTool {
  return tool(
    ARCHICODE_RESEARCH_RULES_TOOL_NAME,
    "manage_rules",
    [
      "Read ArchiCode reusable rules, their implications and node attachments, or current deterministic architecture violations.",
      "Use list_violations during planning before finalizing source work because enforced error policies can fail a run when it introduces a new violation after its baseline.",
      "Violation results can be filtered by flow, node, rule, severity, or enforcement and include grouped flow counts plus unassigned file findings.",
      "This run-agent surface is strictly read-only: create and update are available only to Research chat and require exact one-shot user approval."
    ].join(" "),
    {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "get", "list_violations"], description: "Read rule definitions or evaluated violations. No action mutates project state." },
        ruleId: { type: "string", minLength: 1, description: "Required for get; optional violation filter." },
        flowId: { type: "string", minLength: 1, description: "Optional filter. A violation matches when its source or target belongs to this flow." },
        nodeId: { type: "string", minLength: 1, description: "Optional filter. Requires flowId." },
        status: { type: "string", enum: ["active", "disabled", "superseded"], description: "Optional rule list filter." },
        kind: { type: "string", enum: ["guidance", "decision", "policy"], description: "Optional rule list filter." },
        severity: { type: "string", enum: ["info", "warning", "error"], description: "Optional violation filter." },
        enforcement: { type: "string", enum: ["advisory", "enforced"], description: "Optional violation filter." },
        includeUnassigned: { type: "boolean", description: "Include violations not mapped to a graph flow. Defaults to true." },
        maxResults: { type: "integer", minimum: 1, maximum: 500, description: "Maximum returned violations. Group counts cover all matches. Defaults to 100." }
      }
    }
  );
}

const ruleAttachmentInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["flowId", "nodeId"],
  properties: {
    flowId: { type: "string", minLength: 1, description: "The top-level flow containing the node." },
    nodeId: { type: "string", minLength: 1, description: "The node that should receive or lose the reusable rule." }
  }
};

const ruleDecisionInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    context: { type: "string", description: "Why the decision was needed." },
    alternatives: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["option", "reason"],
        properties: {
          option: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 }
        }
      }
    },
    consequences: { type: "array", maxItems: 24, items: { type: "string", minLength: 1 } }
  }
};

const pathGlobArraySchema = (description: string, maxItems = 64) => ({
  type: "array",
  minItems: 1,
  maxItems,
  description,
  items: { type: "string", minLength: 1, maxLength: 240 }
});

const architectureConstraintInputSchema = {
  description: "A deterministic, local architecture check. Supplying this makes the rule a live policy.",
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["kind", "fromPathGlobs", "toPathGlobs"],
      properties: {
        kind: { const: "forbidden-dependency", description: "Report dependencies from matching source files to matching target files." },
        fromPathGlobs: pathGlobArraySchema("Source file path patterns.", 32),
        toPathGlobs: pathGlobArraySchema("Forbidden target file path patterns.", 32),
        includeRuntime: { type: "boolean", description: "Also consider high-confidence runtime relationships. Defaults to false." }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "fromPathGlobs", "toPathGlobs"],
      properties: {
        kind: { const: "required-dependency", description: "Require every matching source file to depend on at least one matching target file." },
        fromPathGlobs: pathGlobArraySchema("Source file path patterns.", 32),
        toPathGlobs: pathGlobArraySchema("Required target file path patterns.", 32),
        includeRuntime: { type: "boolean", description: "Also consider high-confidence runtime relationships. Defaults to false." }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "fromPathGlobs", "allowedPathGlobs"],
      properties: {
        kind: { const: "allowed-dependency", description: "Allow matching source files to depend only on matching target paths." },
        fromPathGlobs: pathGlobArraySchema("Source file path patterns.", 32),
        allowedPathGlobs: pathGlobArraySchema("Allowed target file path patterns."),
        includeRuntime: { type: "boolean", description: "Also consider high-confidence runtime relationships. Defaults to false." }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "pathGlobs"],
      properties: {
        kind: { const: "no-cycles", description: "Report dependency cycles among matching files." },
        pathGlobs: pathGlobArraySchema("File path patterns included in cycle detection.", 32),
        includeRuntime: { type: "boolean", description: "Also consider high-confidence runtime relationships. Defaults to false." }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "fromPathGlobs", "importGlobs"],
      properties: {
        kind: { const: "forbidden-import", description: "Report forbidden import specifiers or imported names in matching source files." },
        fromPathGlobs: pathGlobArraySchema("Source file path patterns.", 32),
        importGlobs: pathGlobArraySchema("Forbidden import specifier patterns."),
        importedNames: { type: "array", maxItems: 64, items: { type: "string", minLength: 1 }, description: "Optional forbidden named imports. Empty means any import from a matching specifier." }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "pathGlobs"],
      properties: {
        kind: { const: "file-convention", description: "Enforce allowed locations, file-name style, or a required suffix for matching files." },
        pathGlobs: pathGlobArraySchema("Files governed by the convention.", 32),
        allowedPathGlobs: { type: "array", maxItems: 64, items: { type: "string", minLength: 1 }, description: "Optional allowed locations." },
        fileNameStyle: { type: "string", enum: ["kebab-case", "camelCase", "PascalCase", "snake_case"] },
        requiredSuffix: { type: "string", minLength: 1, maxLength: 80, description: "Optional suffix required before the file extension." }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "sourcePathGlobs", "companionPathGlobs"],
      properties: {
        kind: { const: "required-companion-file", description: "Require matching source files to have a matching companion such as a test, story, or documentation file." },
        sourcePathGlobs: pathGlobArraySchema("Source file path patterns.", 32),
        companionPathGlobs: pathGlobArraySchema("Companion file path patterns."),
        match: { type: "string", enum: ["same-stem", "any"], description: "same-stem pairs files by base name; any only requires one matching companion. Defaults to same-stem." }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "field"],
      properties: {
        kind: { const: "required-node-metadata", description: "Require graph nodes in scope to contain a selected metadata field." },
        scope: { type: "string", enum: ["attached", "flow", "subflow", "project"], description: "Graph scope. flow/subflow expand from attached anchor nodes; project needs no anchor." },
        field: { type: "string", enum: ["description", "tech-stack", "acceptance-criteria", "acceptance-check", "passing-acceptance-check", "implementation-scope", "documentation"] }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: {
        kind: { const: "node-relationship", description: "Require or forbid graph relationships for nodes in scope." },
        scope: { type: "string", enum: ["attached", "flow", "subflow", "project"], description: "Graph scope. flow/subflow expand from attached anchor nodes; project needs no anchor." },
        mode: { type: "string", enum: ["required", "forbidden"] },
        direction: { type: "string", enum: ["incoming", "outgoing", "either"] },
        targetNodeTypes: { type: "array", maxItems: 32, items: { type: "string", minLength: 1 }, description: "Optional neighboring node types; empty matches any type." }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: {
        kind: { const: "no-orphan-nodes", description: "Report nodes in scope that have no graph relationships." },
        scope: { type: "string", enum: ["attached", "flow", "subflow", "project"], description: "Graph scope. flow/subflow expand from attached anchor nodes; project needs no anchor." }
      }
    }
  ]
};

const ruleWritableProperties = {
  title: { type: "string", minLength: 1, description: "Short rule title shown in agent context and violation UI." },
  body: { type: "string", minLength: 1, description: "Description of the intent, implication, and preferred corrective action." },
  kind: { type: "string", enum: ["guidance", "decision", "policy"], description: "Guidance/decision are durable agent context only. Policy adds a deterministic live check and requires constraint." },
  status: { type: "string", enum: ["active", "disabled", "superseded"], description: "Only active policies are evaluated." },
  severity: { type: "string", enum: ["info", "warning", "error"], description: "Only error can block, and only when enforcement is enforced." },
  enforcement: { type: "string", enum: ["advisory", "enforced"], description: "Advisory only reports. Enforced error policies fail source-changing runs that introduce a new violation." },
  constraint: architectureConstraintInputSchema,
  decision: ruleDecisionInputSchema,
  supersededBy: { type: "string", description: "Optional replacement rule id when status is superseded." }
};

/**
 * Research receives this mutation-capable descriptor; build/run agents receive
 * the separate read-only descriptor from archicodeInternalTools. Runtime
 * execution also requires the Research-only mutation capability above.
 */
export function archicodeResearchRulesTool(): ProviderMcpTool {
  return {
    providerToolName: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
    serverId: ARCHICODE_RESEARCH_RULES_SERVER_ID,
    serverLabel: ARCHICODE_RESEARCH_RULES_SERVER_LABEL,
    toolName: "manage_rules",
    description: [
      "Read, create, or edit ArchiCode reusable rules and their node attachments.",
      "Use list/get before changing an existing rule so its current definition and impact are understood.",
      "Guidance and decision rules add durable agent context but do not lint.",
      "Policy rules run locally and deterministically with no model call: active violations appear on the canvas; only enforced error policies can fail a source-changing run, and only for violations introduced after its baseline.",
      "File policies are project-wide. Graph policies with attached/flow/subflow scope need node attachments as anchors; project scope does not.",
      "Reads execute immediately. Every create or update is blocked until the user approves that exact proposed payload once; approval can never be remembered for later rule changes. Never claim a mutation was applied before the tool returns success."
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "get", "list_violations", "create", "update"], description: "list/get/list_violations are read-only; create/update always require explicit user approval." },
        ruleId: { type: "string", minLength: 1, description: "Required for get and update; optional violation filter." },
        flowId: { type: "string", minLength: 1, description: "Optional list/list_violations filter. nodeId requires flowId." },
        nodeId: { type: "string", minLength: 1, description: "Optional list/list_violations node filter." },
        status: { type: "string", enum: ["active", "disabled", "superseded"], description: "Optional list filter." },
        kind: { type: "string", enum: ["guidance", "decision", "policy"], description: "Optional list filter." },
        severity: { type: "string", enum: ["info", "warning", "error"], description: "Optional list_violations filter." },
        enforcement: { type: "string", enum: ["advisory", "enforced"], description: "Optional list_violations filter." },
        includeUnassigned: { type: "boolean", description: "For list_violations, include findings not mapped to a graph flow. Defaults to true." },
        maxResults: { type: "integer", minimum: 1, maximum: 500, description: "For list_violations, maximum returned findings. Group counts cover all matches. Defaults to 100." },
        rule: {
          type: "object",
          additionalProperties: false,
          required: ["title", "body"],
          description: "Required for create. The id and timestamps are generated by ArchiCode.",
          properties: ruleWritableProperties
        },
        patch: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          description: "Fields to change for update. Changing kind away from policy removes its deterministic constraint, severity, and enforcement.",
          properties: {
            ...ruleWritableProperties,
            constraint: { oneOf: [architectureConstraintInputSchema, { type: "null" }], description: "A replacement deterministic constraint, or null to remove it when changing away from policy." },
            decision: { oneOf: [ruleDecisionInputSchema, { type: "null" }] }
          }
        },
        attachTo: { type: "array", maxItems: 64, items: ruleAttachmentInputSchema, description: "Nodes to attach the created/updated reusable rule to." },
        detachFrom: { type: "array", maxItems: 64, items: ruleAttachmentInputSchema, description: "Nodes to detach the updated rule from." }
      }
    }
  };
}

export function researchRulesToolRequiresApproval(argumentsJson: string): boolean {
  const action = parseArgs(argumentsJson).action;
  return action === "create" || action === "update";
}

export function describeResearchRulesMutation(argumentsJson: string): string {
  const args = parseArgs(argumentsJson);
  if (args.action === "create") {
    const rule = recordValue(args.rule);
    return `Create rule${typeof rule?.title === "string" ? ` “${rule.title}”` : ""}`;
  }
  if (args.action === "update") return `Edit rule${typeof args.ruleId === "string" ? ` “${args.ruleId}”` : ""}`;
  return "Use rules tool";
}

export function isArchicodeInternalTool(providerToolName: string): boolean {
  return providerToolName.startsWith("archicode_project_") ||
    providerToolName.startsWith("archicode_console_") ||
    providerToolName.startsWith("archicode_web_");
}

export async function callArchicodeInternalTool(env: InternalToolEnvironment, input: InternalToolCallInput): Promise<InternalToolCallOutput> {
  const args = parseArgs(input.argumentsJson);
  const available = env.researchRules && input.providerToolName === ARCHICODE_RESEARCH_RULES_TOOL_NAME
    ? archicodeResearchRulesTool()
    : archicodeInternalTools(env.settings).find((item) => item.providerToolName === input.providerToolName);
  if (!available) throw new Error(`ArchiCode built-in tool ${input.providerToolName} is disabled or unavailable.`);
  let result: unknown;
  if (input.providerToolName === "archicode_project_list_files") result = await listFiles(env.projectRoot, args);
  else if (input.providerToolName === "archicode_project_search_files") result = await searchFiles(env.projectRoot, args);
  else if (input.providerToolName === "archicode_project_read_file") result = await readProjectFile(env.projectRoot, args);
  else if (input.providerToolName === "archicode_project_query_code_graph") result = await queryCodeGraph(env.projectRoot, args);
  else if (input.providerToolName === "archicode_project_list_runs") result = await listRuns(env, args);
  else if (input.providerToolName === "archicode_project_read_run") result = await readRun(env, args);
  else if (input.providerToolName === "archicode_project_read_artifact") result = await readArtifact(env, args);
  else if (input.providerToolName === "archicode_console_run_command") result = await runConsole(env, args);
  else if (input.providerToolName === "archicode_web_search") result = await webSearch(env, args);
  else if (input.providerToolName === "archicode_web_open_url") result = await openUrl(env, args);
  else if (input.providerToolName === ARCHICODE_RESEARCH_RULES_TOOL_NAME) result = await manageResearchRules(env, args, input.argumentsJson);
  else throw new Error(`ArchiCode built-in tool ${input.providerToolName} is not implemented.`);
  return {
    serverId: available.serverId,
    serverLabel: available.serverLabel,
    toolName: available.toolName,
    resultText: JSON.stringify(result, null, 2)
  };
}

type RuleAttachment = { flowId: string; nodeId: string };

function parseRuleAttachments(value: unknown, field: string): RuleAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  if (value.length > 64) throw new Error(`${field} supports at most 64 nodes.`);
  const unique = new Map<string, RuleAttachment>();
  for (const item of value) {
    const record = recordValue(item);
    const flowId = typeof record?.flowId === "string" ? record.flowId.trim() : "";
    const nodeId = typeof record?.nodeId === "string" ? record.nodeId.trim() : "";
    if (!flowId || !nodeId) throw new Error(`${field} entries require flowId and nodeId.`);
    unique.set(`${flowId}\0${nodeId}`, { flowId, nodeId });
  }
  return [...unique.values()];
}

function validateRuleAttachments(bundle: ProjectBundle, attachments: RuleAttachment[]): void {
  for (const attachment of attachments) {
    const flow = bundle.flows.find((item) => item.id === attachment.flowId);
    if (!flow) throw new Error(`Flow ${attachment.flowId} was not found.`);
    if (!flow.nodes.some((node) => node.id === attachment.nodeId)) {
      throw new Error(`Node ${attachment.nodeId} was not found in flow ${attachment.flowId}.`);
    }
  }
}

function ruleAttachments(bundle: ProjectBundle, ruleId: string): Array<RuleAttachment & { flowName: string; nodeTitle: string }> {
  return bundle.flows.flatMap((flow) => flow.nodes.flatMap((node) =>
    node.ruleIds?.includes(ruleId) ? [{ flowId: flow.id, flowName: flow.name, nodeId: node.id, nodeTitle: node.title }] : []
  ));
}

function ruleImplication(rule: NodeRule, attachments: RuleAttachment[]): Record<string, unknown> {
  const active = (rule.status ?? "active") === "active";
  if (!rule.constraint) {
    return {
      evaluation: "agent-context-only",
      active,
      llmCallForLinting: false,
      effect: "This rule provides durable guidance/decision context and does not create live lint violations."
    };
  }
  let scope: "attached" | "flow" | "subflow" | "project" = "project";
  if (rule.constraint.kind === "required-node-metadata" ||
    rule.constraint.kind === "node-relationship" ||
    rule.constraint.kind === "no-orphan-nodes") {
    scope = rule.constraint.scope;
  }
  const graphConstraint = scope !== "project" ||
    rule.constraint.kind === "required-node-metadata" ||
    rule.constraint.kind === "node-relationship" ||
    rule.constraint.kind === "no-orphan-nodes";
  return {
    evaluation: "local-deterministic",
    active,
    llmCallForLinting: false,
    severity: rule.severity ?? "warning",
    enforcement: rule.enforcement ?? "advisory",
    scope,
    attachmentCount: attachments.length,
    attachmentEffect: !graphConstraint
      ? "File policy matching is project-wide; attachments provide graph context but do not limit matching."
      : scope === "project"
        ? "Project scope evaluates every non-ignored node and does not require an attachment anchor."
        : attachments.length
          ? `${scope} scope is anchored by the attached node(s).`
          : `${scope} scope currently has no attached anchor, so it evaluates no nodes.`,
    runGate: active && rule.severity === "error" && rule.enforcement === "enforced"
      ? "A source-changing run fails when it introduces a new violation after the run baseline; existing baseline violations do not fail it."
      : "Violations are reported but do not fail runs."
  };
}

function policyDefinitionFingerprint(rules: readonly NodeRule[]): string {
  const definitions = rules
    .filter((rule) => (rule.status ?? "active") === "active" && Boolean(rule.constraint))
    .map((rule) => ({
      id: rule.id,
      title: rule.title,
      body: rule.body,
      kind: rule.kind ?? "policy",
      status: rule.status ?? "active",
      severity: rule.severity ?? "warning",
      enforcement: rule.enforcement ?? "advisory",
      constraint: rule.constraint
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
}

type PolicyViolation = NonNullable<ProjectBundle["policyEvaluation"]>["violations"][number];

function violationFlowIds(violation: PolicyViolation): string[] {
  return [...new Set([violation.source.flowId, violation.target?.flowId]
    .filter((flowId): flowId is string => Boolean(flowId)))];
}

function violationNodeIds(violation: PolicyViolation): string[] {
  return [...new Set([violation.source.nodeId, violation.target?.nodeId]
    .filter((nodeId): nodeId is string => Boolean(nodeId)))];
}

function listRuleViolations(bundle: ProjectBundle, args: Record<string, unknown>): Record<string, unknown> {
  const rules = bundle.project.settings.nodeRules ?? [];
  const activePolicyCount = rules.filter((rule) => (rule.status ?? "active") === "active" && Boolean(rule.constraint)).length;
  const flowId = typeof args.flowId === "string" ? args.flowId.trim() : "";
  const nodeId = typeof args.nodeId === "string" ? args.nodeId.trim() : "";
  const ruleId = typeof args.ruleId === "string" ? args.ruleId.trim() : "";
  const severity = typeof args.severity === "string" ? args.severity.trim() : "";
  const enforcement = typeof args.enforcement === "string" ? args.enforcement.trim() : "";
  const includeUnassigned = args.includeUnassigned !== false;
  const maxResults = clampInteger(args.maxResults, 100, 1, 500);
  if (nodeId && !flowId) throw new Error("flowId is required when nodeId is provided.");
  const flow = flowId ? bundle.flows.find((item) => item.id === flowId) : undefined;
  if (flowId && !flow) throw new Error(`Flow ${flowId} was not found.`);
  if (nodeId && !flow?.nodes.some((node) => node.id === nodeId)) throw new Error(`Node ${nodeId} was not found in flow ${flowId}.`);
  if (ruleId && !rules.some((rule) => rule.id === ruleId)) throw new Error(`Rule ${ruleId} was not found.`);

  const evaluation = bundle.policyEvaluation ?? null;
  const expectedFingerprint = policyDefinitionFingerprint(rules);
  const evaluationStatus = activePolicyCount === 0
    ? "current"
    : !evaluation
      ? "unavailable"
      : evaluation.policyFingerprint === expectedFingerprint
        ? "current"
        : "stale";
  const allViolations = activePolicyCount === 0 ? [] : evaluation?.violations ?? [];
  const matched = allViolations.filter((violation) => {
    const flowIds = violationFlowIds(violation);
    const nodeIds = violationNodeIds(violation);
    return (!flowId || flowIds.includes(flowId)) &&
      (!nodeId || nodeIds.includes(nodeId)) &&
      (!ruleId || violation.policyId === ruleId) &&
      (!severity || violation.severity === severity) &&
      (!enforcement || violation.enforcement === enforcement) &&
      (includeUnassigned || flowIds.length > 0);
  });
  const flowCounts = new Map<string, { count: number; blocking: number }>();
  const ruleCounts = new Map<string, { title: string; count: number; blocking: number }>();
  let unassigned = 0;
  let blocking = 0;
  for (const violation of matched) {
    const isBlocking = violation.severity === "error" && violation.enforcement === "enforced";
    if (isBlocking) blocking += 1;
    const flowIds = violationFlowIds(violation);
    if (!flowIds.length) unassigned += 1;
    for (const id of flowIds) {
      const current = flowCounts.get(id) ?? { count: 0, blocking: 0 };
      flowCounts.set(id, { count: current.count + 1, blocking: current.blocking + (isBlocking ? 1 : 0) });
    }
    const currentRule = ruleCounts.get(violation.policyId) ?? { title: violation.policyTitle, count: 0, blocking: 0 };
    ruleCounts.set(violation.policyId, { ...currentRule, count: currentRule.count + 1, blocking: currentRule.blocking + (isBlocking ? 1 : 0) });
  }
  return {
    action: "list_violations",
    evaluation: {
      available: Boolean(evaluation) || activePolicyCount === 0,
      status: evaluationStatus,
      generatedAt: evaluation?.generatedAt,
      analyzerVersion: evaluation?.analyzerVersion,
      activePolicies: activePolicyCount,
      message: evaluationStatus === "stale"
        ? "The cached evaluation predates the current policy definitions. Treat these findings as advisory until the next deterministic refresh/verification."
        : evaluationStatus === "unavailable"
          ? "No deterministic policy evaluation is available yet. The run verification phase will establish or refresh it."
          : undefined
    },
    filters: {
      flowId: flowId || undefined,
      nodeId: nodeId || undefined,
      ruleId: ruleId || undefined,
      severity: severity || undefined,
      enforcement: enforcement || undefined,
      includeUnassigned
    },
    summary: {
      matching: matched.length,
      returned: Math.min(matched.length, maxResults),
      omitted: Math.max(0, matched.length - maxResults),
      blocking,
      unassigned,
      byFlow: [...flowCounts.entries()].map(([id, counts]) => ({
        flowId: id,
        flowName: bundle.flows.find((item) => item.id === id)?.name ?? "Missing flow",
        ...counts
      })).sort((left, right) => right.blocking - left.blocking || right.count - left.count || left.flowId.localeCompare(right.flowId)),
      byRule: [...ruleCounts.entries()].map(([id, counts]) => ({ ruleId: id, ...counts }))
        .sort((left, right) => right.blocking - left.blocking || right.count - left.count || left.ruleId.localeCompare(right.ruleId))
    },
    violations: matched.slice(0, maxResults).map((violation) => ({
      ...violation,
      flowIds: violationFlowIds(violation),
      nodeIds: violationNodeIds(violation),
      blocking: violation.severity === "error" && violation.enforcement === "enforced"
    }))
  };
}

function normalizeWritableRule(
  value: Record<string, unknown>,
  base: NodeRule | undefined,
  identity: { id: string; createdAt: string; updatedAt: string }
): NodeRule {
  const allowed = new Set(["title", "body", "kind", "status", "severity", "enforcement", "constraint", "decision", "supersededBy"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported rule field ${key}.`);
  }
  const merged = { ...(base ?? {}), ...value } as Record<string, unknown>;
  const inferredKind = typeof merged.kind === "string" ? merged.kind : merged.constraint ? "policy" : "guidance";
  merged.kind = inferredKind;
  if (inferredKind !== "policy") {
    delete merged.constraint;
    delete merged.severity;
    delete merged.enforcement;
  } else {
    if (!merged.constraint) throw new Error("Policy rules require a deterministic constraint.");
    merged.severity ??= "warning";
    merged.enforcement ??= "advisory";
  }
  if (merged.decision === null) delete merged.decision;
  if (merged.constraint === null) delete merged.constraint;
  return nodeRuleSchema.parse({
    ...merged,
    id: identity.id,
    status: merged.status ?? "active",
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt
  });
}

async function applyRuleAttachmentChanges(
  env: InternalToolEnvironment,
  bundle: ProjectBundle,
  ruleId: string,
  attachTo: RuleAttachment[],
  detachFrom: RuleAttachment[]
): Promise<ProjectBundle> {
  const attachKeys = new Set(attachTo.map((item) => `${item.flowId}\0${item.nodeId}`));
  const detachKeys = new Set(detachFrom.map((item) => `${item.flowId}\0${item.nodeId}`));
  let current = bundle;
  for (const attachment of [...attachTo, ...detachFrom]) {
    const key = `${attachment.flowId}\0${attachment.nodeId}`;
    const flow = current.flows.find((item) => item.id === attachment.flowId)!;
    const node = flow.nodes.find((item) => item.id === attachment.nodeId)!;
    const existing = node.ruleIds ?? [];
    const next = attachKeys.has(key)
      ? [...new Set([...existing, ruleId])]
      : detachKeys.has(key)
        ? existing.filter((item) => item !== ruleId)
        : existing;
    if (next.length === existing.length && next.every((item, index) => item === existing[index])) continue;
    current = await env.researchRules!.updateNodeRuleIds(attachment.flowId, attachment.nodeId, next);
  }
  return current;
}

async function manageResearchRules(env: InternalToolEnvironment, args: Record<string, unknown>, argumentsJson: string): Promise<unknown> {
  const action = typeof args.action === "string" ? args.action : "";
  if (!["list", "get", "list_violations", "create", "update"].includes(action)) throw new Error("A valid rules action is required.");
  let bundle = await env.loadProject();
  const allRules = bundle.project.settings.nodeRules ?? [];

  if (action === "list_violations") return listRuleViolations(bundle, args);

  if (action === "list" || action === "get") {
    const ruleId = typeof args.ruleId === "string" ? args.ruleId.trim() : "";
    if (action === "get" && !ruleId) throw new Error("ruleId is required for get.");
    const flowId = typeof args.flowId === "string" ? args.flowId.trim() : "";
    const nodeId = typeof args.nodeId === "string" ? args.nodeId.trim() : "";
    if (nodeId && !flowId) throw new Error("flowId is required when nodeId is provided.");
    if (flowId && !bundle.flows.some((flow) => flow.id === flowId)) throw new Error(`Flow ${flowId} was not found.`);
    const attachedRuleIds = flowId
      ? new Set(bundle.flows.find((flow) => flow.id === flowId)!.nodes
        .filter((node) => !nodeId || node.id === nodeId)
        .flatMap((node) => node.ruleIds ?? []))
      : undefined;
    if (nodeId && !bundle.flows.find((flow) => flow.id === flowId)!.nodes.some((node) => node.id === nodeId)) {
      throw new Error(`Node ${nodeId} was not found in flow ${flowId}.`);
    }
    const selected = allRules.filter((rule) =>
      (!ruleId || rule.id === ruleId) &&
      (!attachedRuleIds || attachedRuleIds.has(rule.id)) &&
      (typeof args.status !== "string" || (rule.status ?? "active") === args.status) &&
      (typeof args.kind !== "string" || (rule.kind ?? (rule.constraint ? "policy" : "guidance")) === args.kind)
    );
    if (action === "get" && !selected.length) throw new Error(`Rule ${ruleId} was not found.`);
    return {
      action,
      count: selected.length,
      rules: selected.map((rule) => {
        const attachments = ruleAttachments(bundle, rule.id);
        return { rule, attachments, implication: ruleImplication(rule, attachments) };
      })
    };
  }

  const attachTo = parseRuleAttachments(args.attachTo, "attachTo");
  const detachFrom = parseRuleAttachments(args.detachFrom, "detachFrom");
  if (!env.researchRules) throw new Error("Rule mutations are available only to Research chat after exact user approval.");
  validateRuleAttachments(bundle, [...attachTo, ...detachFrom]);
  const now = new Date().toISOString();
  let rule: NodeRule;
  let idempotent = false;
  if (action === "create") {
    const inputRule = recordValue(args.rule);
    if (!inputRule) throw new Error("rule is required for create.");
    if (detachFrom.length) throw new Error("detachFrom is not supported for create.");
    const ruleId = `rule-chat-${createHash("sha256").update(argumentsJson).digest("hex").slice(0, 16)}`;
    const existing = allRules.find((item) => item.id === ruleId);
    rule = existing ?? normalizeWritableRule(inputRule, undefined, { id: ruleId, createdAt: now, updatedAt: now });
    if (!existing) {
      bundle = await env.researchRules.updateProjectSettings({
        ...bundle.project.settings,
        nodeRules: [...allRules, rule]
      });
    } else {
      idempotent = true;
    }
  } else {
    const ruleId = typeof args.ruleId === "string" ? args.ruleId.trim() : "";
    if (!ruleId) throw new Error("ruleId is required for update.");
    const current = allRules.find((item) => item.id === ruleId);
    if (!current) throw new Error(`Rule ${ruleId} was not found.`);
    const patch = recordValue(args.patch);
    if (!patch && !attachTo.length && !detachFrom.length) throw new Error("update requires patch, attachTo, or detachFrom.");
    rule = patch ? normalizeWritableRule(patch, current, { id: current.id, createdAt: current.createdAt, updatedAt: now }) : current;
    if (patch) {
      bundle = await env.researchRules.updateProjectSettings({
        ...bundle.project.settings,
        nodeRules: allRules.map((item) => item.id === rule.id ? rule : item)
      });
    }
  }
  bundle = await applyRuleAttachmentChanges(env, bundle, rule.id, attachTo, detachFrom);
  const attachments = ruleAttachments(bundle, rule.id);
  return {
    action,
    status: "applied",
    idempotent,
    rule,
    attachments,
    implication: ruleImplication(rule, attachments)
  };
}

async function queryCodeGraph(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const snapshot = await readCodeKnowledgeSnapshot(projectRoot);
  if (!snapshot) return { available: false, message: "The local code graph is not available yet. Import or refresh the code knowledge map first." };
  const action = typeof args.action === "string" ? args.action : "";
  if (!["search", "neighbors", "path", "impact"].includes(action)) throw new Error("A valid code graph action is required.");
  return {
    available: true,
    generatedAt: snapshot.generatedAt,
    snapshotStats: snapshot.stats,
    ...queryCodeKnowledgeSnapshot(snapshot, args as CodeKnowledgeQueryInput)
  };
}

export async function createArchicodeInternalMcpServer(projectRoot: string, settings: ProjectSettings, outputDir?: string): Promise<ProjectSettings["mcp"]["servers"][number]> {
  const dir = outputDir ?? await mkdtemp(path.join(tmpdir(), "archicode-tools-"));
  await mkdir(dir, { recursive: true });
  const scriptPath = path.join(dir, "archicode-internal-tools.mjs");
  await writeFile(scriptPath, internalMcpServerSource(projectRoot, settings), "utf8");
  const braveApiKey = internalSearchEnabled(settings)
    ? await (webSearchSecretResolver?.().then((value) => value?.trim() || undefined) ?? Promise.resolve(undefined))
    : undefined;
  return {
    id: ARCHICODE_INTERNAL_SERVER_ID,
    label: ARCHICODE_INTERNAL_SERVER_LABEL,
    transport: "stdio",
    command: process.execPath,
    args: [scriptPath],
    env: braveApiKey ? [{ name: BRAVE_WEB_SEARCH_API_KEY_ENV, value: braveApiKey }] : [],
    headers: [],
    enabled: true,
    trusted: true,
    source: "project",
    tools: archicodeInternalTools(settings).map((item) => ({
      name: item.providerToolName,
      description: item.description,
      inputSchema: item.inputSchema
    })),
    resources: [],
    prompts: [],
    defaultToolsApprovalMode: "approve"
  };
}

function tool(providerToolName: string, toolName: string, description: string, inputSchema: unknown): ProviderMcpTool {
  return {
    providerToolName,
    serverId: ARCHICODE_INTERNAL_SERVER_ID,
    serverLabel: ARCHICODE_INTERNAL_SERVER_LABEL,
    toolName,
    description,
    inputSchema
  };
}

function parseArgs(argumentsJson: string): Record<string, unknown> {
  if (!argumentsJson.trim()) return {};
  const parsed = JSON.parse(argumentsJson) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function collectFiles(projectRoot: string): Promise<FileInventory> {
  const root = path.resolve(projectRoot);
  const files: ProjectFile[] = [];
  let omittedFiles = 0;
  const visit = async (absoluteDir: string): Promise<void> => {
    if (files.length >= TOOL_MAX_FILES) {
      omittedFiles += 1;
      return;
    }
    const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (!relativePath || IGNORED_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await stat(absolutePath).catch(() => null);
      if (!fileStat) continue;
      files.push({ path: relativePath, size: fileStat.size, binary: await fileLooksBinary(absolutePath) });
      if (files.length >= TOOL_MAX_FILES) omittedFiles += 1;
    }
  };
  await visit(root);
  return { rootPath: root, files, omittedFiles };
}

async function fileLooksBinary(filePath: string): Promise<boolean> {
  const bytes = await readFile(filePath).catch(() => null);
  return Boolean(bytes?.subarray(0, Math.min(bytes.length, 4096)).includes(0));
}

function safeRelativePath(projectRoot: string, requested: unknown): { root: string; relativePath: string; absolutePath: string } {
  const root = path.resolve(projectRoot);
  const raw = typeof requested === "string" ? requested.trim() : "";
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const absolutePath = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(root, normalized || ".");
  const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
  if (path.isAbsolute(raw) && relativePath.startsWith("..")) throw new Error("Use a project-relative path, not an absolute path.");
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error("Path escapes the project root.");
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.some((part) => IGNORED_DIRS.has(part))) throw new Error("Path is inside an ignored directory.");
  return { root, relativePath: relativePath === "" ? "." : relativePath, absolutePath };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function redactSensitiveText(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  text = text.replace(/("(?:apiKey|api_key|token|accessToken|refreshToken|password|secret|clientSecret|authorization)"\s*:\s*")([^"]*)(")/gi, (_match, prefix: string, _value: string, suffix: string) => {
    redacted = true;
    return `${prefix}[redacted]${suffix}`;
  });
  text = text.replace(/^([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=).+$/gim, (_match, prefix: string) => {
    redacted = true;
    return `${prefix}[redacted]`;
  });
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{12,}|anthropic-[A-Za-z0-9_-]{12,})\b/g, () => {
    redacted = true;
    return "[redacted-secret]";
  });
  return { text, redacted };
}

function includeSnippet(filePath: string, size: number): boolean {
  if (size > 500_000) return false;
  if (filePath.startsWith(".archicode/")) return /\.(json|md|txt|log)$/i.test(filePath);
  return /(^|\/)(package\.json|vite\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|README\.md|AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.github\/copilot-instructions\.md|agents\.md|index\.html|Dockerfile|docker-compose\.ya?ml)$/i.test(filePath) ||
    /\.(vue|ts|tsx|js|jsx|mjs|cjs|css|scss|sass|html|json|jsonc|md|mdx|yaml|yml|toml)$/i.test(filePath);
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  return directory === "." || filePath === directory || filePath.startsWith(`${directory}/`);
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array(right.length + 1).fill(0);
  for (let row = 0; row < left.length; row += 1) {
    current[0] = row + 1;
    for (let column = 0; column < right.length; column += 1) {
      const substitutionCost = left[row] === right[column] ? 0 : 1;
      current[column + 1] = Math.min(
        current[column] + 1,
        previous[column + 1] + 1,
        previous[column] + substitutionCost
      );
    }
    for (let column = 0; column <= right.length; column += 1) previous[column] = current[column]!;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

async function resolveReadableProjectFile(projectRoot: string, requestedPath: unknown): Promise<{
  target: { root: string; relativePath: string; absolutePath: string };
  resolvedPath: string;
  fileStat: Awaited<ReturnType<typeof stat>>;
  requestedPath: string;
  aliasUsed: boolean;
}> {
  const target = safeRelativePath(projectRoot, requestedPath);
  const fileStat = await stat(target.absolutePath).catch(() => null);
  if (fileStat?.isFile()) {
    return {
      target,
      resolvedPath: target.relativePath,
      fileStat,
      requestedPath: target.relativePath,
      aliasUsed: false
    };
  }

  const requestedNormalized = target.relativePath.toLowerCase();
  const requestedDir = path.posix.dirname(requestedNormalized);
  const requestedExt = path.posix.extname(requestedNormalized);
  const requestedBase = path.posix.basename(requestedNormalized, requestedExt);
  const inventory = await collectFiles(projectRoot);
  const candidate = inventory.files
    .filter((file) => {
      const normalized = file.path.toLowerCase();
      const candidateDir = path.posix.dirname(normalized);
      const candidateExt = path.posix.extname(normalized);
      const candidateBase = path.posix.basename(normalized, candidateExt);
      const fullDistance = levenshteinDistance(requestedNormalized, normalized);
      const baseDistance = levenshteinDistance(requestedBase, candidateBase);
      const sameDir = candidateDir === requestedDir;
      return !file.binary && candidateExt === requestedExt && (fullDistance <= 3 || (sameDir && baseDistance <= 2));
    })
    .sort((left, right) => {
      const leftNormalized = left.path.toLowerCase();
      const rightNormalized = right.path.toLowerCase();
      const leftDir = path.posix.dirname(leftNormalized);
      const rightDir = path.posix.dirname(rightNormalized);
      const leftExt = path.posix.extname(leftNormalized);
      const rightExt = path.posix.extname(rightNormalized);
      const leftBase = path.posix.basename(leftNormalized, leftExt);
      const rightBase = path.posix.basename(rightNormalized, rightExt);
      const leftSameDir = leftDir === requestedDir ? 1 : 0;
      const rightSameDir = rightDir === requestedDir ? 1 : 0;
      if (leftSameDir !== rightSameDir) return rightSameDir - leftSameDir;
      const leftBaseDistance = levenshteinDistance(requestedBase, leftBase);
      const rightBaseDistance = levenshteinDistance(requestedBase, rightBase);
      if (leftBaseDistance !== rightBaseDistance) return leftBaseDistance - rightBaseDistance;
      return levenshteinDistance(requestedNormalized, leftNormalized) - levenshteinDistance(requestedNormalized, rightNormalized);
    })[0];

  if (!candidate) throw new Error(`${target.relativePath} is not a readable file.`);
  const resolvedAbsolutePath = path.join(inventory.rootPath, candidate.path);
  const resolvedStat = await stat(resolvedAbsolutePath).catch(() => null);
  if (!resolvedStat?.isFile()) throw new Error(`${target.relativePath} is not a readable file.`);
  return {
    target,
    resolvedPath: candidate.path,
    fileStat: resolvedStat,
    requestedPath: target.relativePath,
    aliasUsed: true
  };
}

async function listFiles(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const directory = safeRelativePath(projectRoot, args.directory);
  const maxResults = clampInteger(args.maxResults, 200, 1, TOOL_MAX_RESULTS);
  const recursive = args.recursive === true;
  if (!recursive) {
    const entries = await readdir(directory.absolutePath, { withFileTypes: true }).catch(() => []);
    const visible = entries
      .filter((entry) => !IGNORED_DIRS.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, maxResults)
      .map((entry) => ({
        path: path.join(directory.relativePath === "." ? "" : directory.relativePath, entry.name).split(path.sep).join("/"),
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
      }));
    return { directory: directory.relativePath, recursive, entries: visible, omitted: Math.max(0, entries.length - visible.length), ignoredDirectories: [...IGNORED_DIRS] };
  }
  const inventory = await collectFiles(projectRoot);
  const files = inventory.files.filter((file) => isInsideDirectory(file.path, directory.relativePath)).slice(0, maxResults);
  return { directory: directory.relativePath, recursive, files, omitted: Math.max(0, inventory.files.length - files.length) + inventory.omittedFiles, ignoredDirectories: [...IGNORED_DIRS] };
}

async function readProjectFile(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const resolved = await resolveReadableProjectFile(projectRoot, args.path);
  const absolutePath = path.join(resolved.target.root, resolved.resolvedPath);
  const raw = await readFile(absolutePath);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (await fileLooksBinary(absolutePath)) {
    return {
      path: resolved.resolvedPath,
      requestedPath: resolved.requestedPath,
      aliasUsed: resolved.aliasUsed,
      size: resolved.fileStat.size,
      sha256,
      binary: true,
      text: "[binary file omitted]"
    };
  }
  const maxChars = clampInteger(args.maxChars, 40_000, 1, TOOL_MAX_READ_CHARS);
  const redacted = redactSensitiveText(raw.toString("utf8"));
  const lines = redacted.text.split(/\r?\n/);
  const hasRange = args.startLine !== undefined || args.endLine !== undefined;
  const startLine = hasRange ? clampInteger(args.startLine, 1, 1, Math.max(1, lines.length)) : undefined;
  const endLine = hasRange && startLine !== undefined ? clampInteger(args.endLine, startLine, startLine, Math.max(startLine, lines.length)) : undefined;
  const selectedText = hasRange && startLine !== undefined && endLine !== undefined ? lines.slice(startLine - 1, endLine).join("\n") : redacted.text;
  return {
    path: resolved.resolvedPath,
    requestedPath: resolved.requestedPath,
    aliasUsed: resolved.aliasUsed,
    size: resolved.fileStat.size,
    sha256,
    binary: false,
    text: selectedText.slice(0, maxChars),
    startLine,
    endLine,
    totalLines: lines.length,
    truncated: selectedText.length > maxChars,
    redacted: redacted.redacted
  };
}

async function searchFiles(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("Search query is required.");
  const directory = safeRelativePath(projectRoot, args.directory);
  const maxResults = clampInteger(args.maxResults, 50, 1, 100);
  const inventory = await collectFiles(projectRoot);
  const normalizedQuery = query.toLowerCase();
  const matches: Array<{ path: string; line?: number; text?: string; match: "path" | "content"; redacted?: boolean }> = [];
  for (const file of inventory.files) {
    if (matches.length >= maxResults) break;
    if (!isInsideDirectory(file.path, directory.relativePath)) continue;
    if (file.path.toLowerCase().includes(normalizedQuery)) matches.push({ path: file.path, match: "path" });
    if (matches.length >= maxResults || file.binary || !includeSnippet(file.path, file.size)) continue;
    const raw = await readFile(path.join(inventory.rootPath, file.path)).catch(() => null);
    if (!raw) continue;
    const redacted = redactSensitiveText(raw.subarray(0, Math.min(raw.length, 500_000)).toString("utf8"));
    for (const [lineIndex, line] of redacted.text.split(/\r?\n/).entries()) {
      if (!line.toLowerCase().includes(normalizedQuery)) continue;
      matches.push({ path: file.path, line: lineIndex + 1, text: line.length > 300 ? `${line.slice(0, 300)}...` : line, match: "content", redacted: redacted.redacted });
      if (matches.length >= maxResults) break;
    }
  }
  return { query, directory: directory.relativePath, matches, omitted: Math.max(0, inventory.files.length - matches.length) + inventory.omittedFiles, note: "Search skips binary files and heavyweight ignored directories." };
}

async function listRuns(env: InternalToolEnvironment, args: Record<string, unknown>): Promise<unknown> {
  const bundle = await env.loadProject();
  const status = typeof args.status === "string" ? args.status.trim() : "";
  const maxResults = clampInteger(args.maxResults, 20, 1, 50);
  const candidates = bundle.runs.filter((run) => !status || run.status === status);
  return {
    status: status || undefined,
    runs: candidates.slice().sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, maxResults).map((run) => ({
      id: run.id,
      flowId: run.flowId,
      nodeId: run.nodeId,
      providerId: run.providerId,
      status: run.status,
      phase: run.phase,
      promptSummary: run.promptSummary,
      runProfileId: run.runProfileId,
      runTargetId: run.runTargetId,
      retryOf: run.retryOf,
      permission: run.permission,
      plannedCommands: run.plannedCommands,
      todos: run.todos,
      planArtifactIds: run.planArtifactIds,
      contextArtifacts: run.contextArtifacts,
      sourceDiffArtifactIds: run.sourceDiffArtifactIds,
      artifactIds: bundle.artifacts.filter((artifact) => artifact.runId === run.id).map((artifact) => artifact.id),
      latestLogs: run.logs.slice(-8),
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt
    })),
    omitted: Math.max(0, candidates.length - maxResults)
  };
}

async function readRun(env: InternalToolEnvironment, args: Record<string, unknown>): Promise<unknown> {
  const runId = typeof args.runId === "string" ? args.runId.trim() : "";
  if (!runId) throw new Error("runId is required.");
  const bundle = await env.loadProject();
  const run = bundle.runs.find((item) => item.id === runId);
  if (!run) throw new Error(`Run ${runId} was not found.`);
  const maxLogs = clampInteger(args.maxLogs, 80, 1, 200);
  const artifacts = bundle.artifacts
    .filter((artifact) => artifact.runId === run.id || run.contextArtifacts.includes(artifact.id) || run.planArtifactIds.includes(artifact.id) || run.sourceDiffArtifactIds.includes(artifact.id))
    .map((artifact) => ({ id: artifact.id, type: artifact.type, title: artifact.title, path: artifact.path, mediaType: artifact.mediaType, status: artifact.status, summary: artifact.summary, sizeBytes: artifact.sizeBytes, createdAt: artifact.createdAt }));
  return { ...run, logs: run.logs.slice(-maxLogs), artifacts, omittedLogs: Math.max(0, run.logs.length - maxLogs) };
}

function artifactPathStem(artifactPath: string): string {
  return path.basename(artifactPath).replace(/\.[^.]+$/, "");
}

function resolveArtifactReference(
  artifacts: ProjectBundle["artifacts"],
  artifactId: string,
  requestedPath: string
): ProjectBundle["artifacts"][number] | undefined {
  if (artifactId) {
    const exact = artifacts.find((item) => item.id === artifactId);
    if (exact) return exact;
    const byPath = artifacts.find((item) => item.path === artifactId || path.basename(item.path) === artifactId || artifactPathStem(item.path) === artifactId);
    if (byPath) return byPath;
  }
  if (requestedPath) {
    const normalizedPath = requestedPath.replace(/^\.\//, "");
    return artifacts.find((item) =>
      item.path === requestedPath ||
      item.path === normalizedPath ||
      path.basename(item.path) === requestedPath ||
      artifactPathStem(item.path) === requestedPath
    );
  }
  return undefined;
}

async function readArtifact(env: InternalToolEnvironment, args: Record<string, unknown>): Promise<unknown> {
  const bundle = await env.loadProject();
  const artifactId = typeof args.artifactId === "string" ? args.artifactId.trim() : "";
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!artifactId && !requestedPath) throw new Error("A known artifactId or artifact path is required.");
  const artifact = resolveArtifactReference(bundle.artifacts.filter((item) => item.type !== "chat-artifact"), artifactId, requestedPath);
  if (!artifact) throw new Error(artifactId ? `Artifact ${artifactId} was not found.` : "A known artifactId or artifact path is required.");
  const maxChars = clampInteger(args.maxChars, 40_000, 1, TOOL_MAX_READ_CHARS);
  const redacted = redactSensitiveText(await env.readArtifactText(artifact.path));
  return { id: artifact.id, type: artifact.type, title: artifact.title, path: artifact.path, mediaType: artifact.mediaType, nodeId: artifact.nodeId, noteId: artifact.noteId, runId: artifact.runId, status: artifact.status, summary: artifact.summary, text: redacted.text.slice(0, maxChars), truncated: redacted.text.length > maxChars, redacted: redacted.redacted };
}

async function runConsole(env: InternalToolEnvironment, args: Record<string, unknown>): Promise<unknown> {
  if (!env.settings.agentTools.console) return { status: "disabled", message: "Console tool access is disabled in project settings." };
  if (!env.runConsoleCommand) return { status: "unavailable", message: "Console command execution is not available in this context." };
  return env.runConsoleCommand(args);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown, maxItems = 5): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, maxItems);
}

async function resolveWebSearchApiKey(env: InternalToolEnvironment): Promise<string | undefined> {
  const direct = await env.resolveWebSearchApiKey?.();
  if (direct?.trim()) return direct.trim();
  const resolved = await webSearchSecretResolver?.();
  return resolved?.trim() || undefined;
}

async function braveWebSearch(env: InternalToolEnvironment, args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("query is required.");
  const maxResults = clampInteger(args.maxResults, 5, 1, 8);
  const apiKey = await resolveWebSearchApiKey(env);
  if (!apiKey) {
    return {
      enabled: true,
      provider: "brave",
      configured: false,
      query,
      results: [],
      message: "Brave web search is selected, but no Brave Search API key is saved in Preferences."
    };
  }
  const url = new URL(BRAVE_WEB_SEARCH_API_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  url.searchParams.set("extra_snippets", "true");
  url.searchParams.set("safesearch", "moderate");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json",
        "user-agent": "ArchiCode/0.1",
        "x-subscription-token": apiKey
      }
    });
    const payload = await response.json().catch(() => null);
    const web = recordValue(recordValue(payload)?.web);
    const results = Array.isArray(web?.results) ? web.results.slice(0, maxResults).flatMap((item) => {
      const record = recordValue(item);
      if (!record) return [];
      const title = typeof record.title === "string" ? record.title.trim() : "";
      const pageUrl = typeof record.url === "string" ? record.url.trim() : "";
      const description = typeof record.description === "string" ? record.description.trim() : "";
      const extraSnippets = stringArray(record.extra_snippets, 3);
      const age = typeof record.age === "string" ? record.age.trim() : undefined;
      if (!title && !pageUrl && !description && !extraSnippets.length) return [];
      return [{
        title: title || pageUrl || "Untitled result",
        url: pageUrl || undefined,
        snippet: description || extraSnippets[0] || "",
        extraSnippets,
        age
      }];
    }) : [];
    const queryRecord = recordValue(recordValue(payload)?.query);
    const errorMessage = typeof recordValue(payload)?.error === "string"
      ? String(recordValue(payload)?.error)
      : typeof recordValue(payload)?.message === "string"
        ? String(recordValue(payload)?.message)
        : undefined;
    return {
      enabled: true,
      provider: "brave",
      configured: true,
      query,
      source: BRAVE_WEB_SEARCH_API_URL,
      status: response.status,
      moreResultsAvailable: queryRecord?.more_results_available === true,
      results,
      message: response.ok
        ? undefined
        : errorMessage ?? `Brave Search returned ${response.status}.`
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function webSearch(env: InternalToolEnvironment, args: Record<string, unknown>): Promise<unknown> {
  if (!env.settings.webSearch.enabled) return { enabled: false, results: [], message: "Web search is disabled in project settings." };
  if (webSearchProvider(env.settings) !== "brave") {
    return {
      enabled: true,
      provider: webSearchProvider(env.settings),
      configured: false,
      results: [],
      message: "Internal web search is available when the project's web search provider is set to Brave."
    };
  }
  return braveWebSearch(env, args);
}

async function openUrl(env: InternalToolEnvironment, args: Record<string, unknown>): Promise<unknown> {
  if (!env.settings.webSearch.enabled) return { enabled: false, text: "", message: "Web access is disabled in project settings." };
  const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
  if (!/^https?:\/\//i.test(rawUrl)) throw new Error("Only http and https URLs are supported.");
  const parsedUrl = new URL(rawUrl);
  const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, "");
  const searchResultsPage = (
    ((host === "google.com" || host.endsWith(".google.com")) && parsedUrl.pathname === "/search")
    || ((host === "bing.com" || host.endsWith(".bing.com")) && parsedUrl.pathname === "/search")
    || ((host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) && Boolean(parsedUrl.searchParams.get("q")))
  );
  if (searchResultsPage) {
    throw new Error("Search-engine results pages cannot be opened as source documents. Use the configured web-search capability, then open the actual source URLs it returns.");
  }
  const maxChars = clampInteger(args.maxChars, 20_000, 500, TOOL_MAX_READ_CHARS);
  const page = await fetchText(rawUrl, 12_000);
  return { url: rawUrl, status: page.status, contentType: page.contentType, text: stripHtml(page.text).slice(0, maxChars), truncated: stripHtml(page.text).length > maxChars };
}

async function fetchText(url: string, timeoutMs: number): Promise<{ status: number; contentType?: string; text: string }> {
  const result = await guardedFetchText(url, (hostname) => lookup(hostname, { all: true }), {
    timeoutMs,
    headers: { "user-agent": "ArchiCode/0.1" }
  });
  return { status: result.status, contentType: result.contentType, text: result.text };
}

function stripHtml(text: string): string {
  return text.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function internalMcpServerSource(projectRoot: string, settings: ProjectSettings): string {
  const config = {
    projectRoot,
    settings,
    tools: archicodeInternalTools(settings)
  };
  const sdkServerUrl = pathToFileURL(requireFromInternalTools.resolve("@modelcontextprotocol/sdk/server/index.js")).href;
  const sdkStdioUrl = pathToFileURL(requireFromInternalTools.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
  const sdkTypesUrl = pathToFileURL(requireFromInternalTools.resolve("@modelcontextprotocol/sdk/types.js")).href;
  return `import { Server } from ${JSON.stringify(sdkServerUrl)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioUrl)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdkTypesUrl)};
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const CONFIG = ${JSON.stringify(config)};
const IGNORED_DIRS = new Set(${JSON.stringify([...IGNORED_DIRS])});
const MAX_FILES = ${TOOL_MAX_FILES};
const MAX_RESULTS = ${TOOL_MAX_RESULTS};
const MAX_READ = ${TOOL_MAX_READ_CHARS};

${standaloneHelpersSource()}

const server = new Server({ name: "archicode-internal-tools", version: "0.1.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: CONFIG.tools.map((tool) => ({
    name: tool.providerToolName,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await callTool(request.params.name, request.params.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
});

await server.connect(new StdioServerTransport());
`;
}

function standaloneHelpersSource(): string {
  return String.raw`
${embeddedClassifyCommandRiskSource("classify")}

${embeddedSubprocessEnvSource()}

${embeddedNetworkGuardSource()}

function clampInteger(value, fallback, min, max) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}
function safeRelativePath(requested) {
  const root = path.resolve(CONFIG.projectRoot);
  const raw = typeof requested === "string" ? requested.trim() : "";
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const absolutePath = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(root, normalized || ".");
  const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
  if (path.isAbsolute(raw) && relativePath.startsWith("..")) throw new Error("Use a project-relative path, not an absolute path.");
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error("Path escapes the project root.");
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.some((part) => IGNORED_DIRS.has(part))) throw new Error("Path is inside an ignored directory.");
  return { root, relativePath: relativePath === "" ? "." : relativePath, absolutePath };
}
async function fileLooksBinary(filePath) {
  const bytes = await readFile(filePath).catch(() => null);
  return Boolean(bytes?.subarray(0, Math.min(bytes.length, 4096)).includes(0));
}
function redact(text) {
  return text
    .replace(/("(?:apiKey|api_key|token|accessToken|refreshToken|password|secret|clientSecret|authorization)"\s*:\s*")([^"]*)(")/gi, "$1[redacted]$3")
    .replace(/^([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=).+$/gim, "$1[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|anthropic-[A-Za-z0-9_-]{12,})\b/g, "[redacted-secret]");
}
function includeSnippet(filePath, size) {
  if (size > 500000) return false;
  if (filePath.startsWith(".archicode/")) return /\.(json|md|txt|log)$/i.test(filePath);
  return /(^|\/)(package\.json|vite\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|README\.md|AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.github\/copilot-instructions\.md|agents\.md|index\.html|Dockerfile|docker-compose\.ya?ml)$/i.test(filePath) || /\.(vue|ts|tsx|js|jsx|mjs|cjs|css|scss|sass|html|json|jsonc|md|mdx|yaml|yml|toml)$/i.test(filePath);
}
async function collectFiles() {
  const root = path.resolve(CONFIG.projectRoot);
  const files = [];
  let omittedFiles = 0;
  async function visit(dir) {
    if (files.length >= MAX_FILES) { omittedFiles += 1; return; }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (!relativePath || IGNORED_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) { await visit(absolutePath); continue; }
      if (!entry.isFile()) continue;
      const fileStat = await stat(absolutePath).catch(() => null);
      if (!fileStat) continue;
      files.push({ path: relativePath, size: fileStat.size, binary: await fileLooksBinary(absolutePath) });
    }
  }
  await visit(root);
  return { rootPath: root, files, omittedFiles };
}
function inside(filePath, directory) {
  return directory === "." || filePath === directory || filePath.startsWith(directory + "/");
}
function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array(right.length + 1).fill(0);
  for (let row = 0; row < left.length; row += 1) {
    current[0] = row + 1;
    for (let column = 0; column < right.length; column += 1) {
      const substitutionCost = left[row] === right[column] ? 0 : 1;
      current[column + 1] = Math.min(current[column] + 1, previous[column + 1] + 1, previous[column] + substitutionCost);
    }
    for (let column = 0; column <= right.length; column += 1) previous[column] = current[column];
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}
async function resolveReadableProjectFile(requested) {
  const target = safeRelativePath(requested);
  const fileStat = await stat(target.absolutePath).catch(() => null);
  if (fileStat?.isFile()) return { target, resolvedPath: target.relativePath, fileStat, requestedPath: target.relativePath, aliasUsed: false };
  const requestedNormalized = target.relativePath.toLowerCase();
  const requestedDir = path.posix.dirname(requestedNormalized);
  const requestedExt = path.posix.extname(requestedNormalized);
  const requestedBase = path.posix.basename(requestedNormalized, requestedExt);
  const inventory = await collectFiles();
  const candidate = inventory.files
    .filter((file) => {
      const normalized = file.path.toLowerCase();
      const candidateDir = path.posix.dirname(normalized);
      const candidateExt = path.posix.extname(normalized);
      const candidateBase = path.posix.basename(normalized, candidateExt);
      const fullDistance = levenshteinDistance(requestedNormalized, normalized);
      const baseDistance = levenshteinDistance(requestedBase, candidateBase);
      const sameDir = candidateDir === requestedDir;
      return !file.binary && candidateExt === requestedExt && (fullDistance <= 3 || (sameDir && baseDistance <= 2));
    })
    .sort((left, right) => {
      const leftNormalized = left.path.toLowerCase();
      const rightNormalized = right.path.toLowerCase();
      const leftDir = path.posix.dirname(leftNormalized);
      const rightDir = path.posix.dirname(rightNormalized);
      const leftExt = path.posix.extname(leftNormalized);
      const rightExt = path.posix.extname(rightNormalized);
      const leftBase = path.posix.basename(leftNormalized, leftExt);
      const rightBase = path.posix.basename(rightNormalized, rightExt);
      const leftSameDir = leftDir === requestedDir ? 1 : 0;
      const rightSameDir = rightDir === requestedDir ? 1 : 0;
      if (leftSameDir !== rightSameDir) return rightSameDir - leftSameDir;
      const leftBaseDistance = levenshteinDistance(requestedBase, leftBase);
      const rightBaseDistance = levenshteinDistance(requestedBase, rightBase);
      if (leftBaseDistance !== rightBaseDistance) return leftBaseDistance - rightBaseDistance;
      return levenshteinDistance(requestedNormalized, leftNormalized) - levenshteinDistance(requestedNormalized, rightNormalized);
    })[0];
  if (!candidate) throw new Error(target.relativePath + " is not a readable file.");
  const resolvedAbsolutePath = path.join(inventory.rootPath, candidate.path);
  const resolvedStat = await stat(resolvedAbsolutePath).catch(() => null);
  if (!resolvedStat?.isFile()) throw new Error(target.relativePath + " is not a readable file.");
  return { target, resolvedPath: candidate.path, fileStat: resolvedStat, requestedPath: target.relativePath, aliasUsed: true };
}
async function listFiles(args) {
  const directory = safeRelativePath(args.directory);
  const recursive = args.recursive === true;
  const maxResults = clampInteger(args.maxResults, 200, 1, MAX_RESULTS);
  if (!recursive) {
    const entries = await readdir(directory.absolutePath, { withFileTypes: true }).catch(() => []);
    const visible = entries.filter((entry) => !IGNORED_DIRS.has(entry.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, maxResults).map((entry) => ({
      path: path.join(directory.relativePath === "." ? "" : directory.relativePath, entry.name).split(path.sep).join("/"),
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
    }));
    return { directory: directory.relativePath, recursive, entries: visible, omitted: Math.max(0, entries.length - visible.length), ignoredDirectories: [...IGNORED_DIRS] };
  }
  const inventory = await collectFiles();
  const files = inventory.files.filter((file) => inside(file.path, directory.relativePath)).slice(0, maxResults);
  return { directory: directory.relativePath, recursive, files, omitted: Math.max(0, inventory.files.length - files.length) + inventory.omittedFiles, ignoredDirectories: [...IGNORED_DIRS] };
}
async function readProjectFile(args) {
  const resolved = await resolveReadableProjectFile(args.path);
  const absolutePath = path.join(resolved.target.root, resolved.resolvedPath);
  if (await fileLooksBinary(absolutePath)) return { path: resolved.resolvedPath, requestedPath: resolved.requestedPath, aliasUsed: resolved.aliasUsed, size: resolved.fileStat.size, binary: true, text: "[binary file omitted]" };
  const maxChars = clampInteger(args.maxChars, 40000, 1, MAX_READ);
  const text = redact((await readFile(absolutePath)).toString("utf8"));
  const lines = text.split(/\r?\n/);
  const hasRange = args.startLine !== undefined || args.endLine !== undefined;
  const startLine = hasRange ? clampInteger(args.startLine, 1, 1, Math.max(1, lines.length)) : undefined;
  const endLine = hasRange && startLine !== undefined ? clampInteger(args.endLine, startLine, startLine, Math.max(startLine, lines.length)) : undefined;
  const selectedText = hasRange && startLine !== undefined && endLine !== undefined ? lines.slice(startLine - 1, endLine).join("\n") : text;
  return { path: resolved.resolvedPath, requestedPath: resolved.requestedPath, aliasUsed: resolved.aliasUsed, size: resolved.fileStat.size, binary: false, text: selectedText.slice(0, maxChars), startLine, endLine, totalLines: lines.length, truncated: selectedText.length > maxChars };
}
async function searchFiles(args) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("Search query is required.");
  const directory = safeRelativePath(args.directory);
  const maxResults = clampInteger(args.maxResults, 50, 1, 100);
  const inventory = await collectFiles();
  const matches = [];
  const normalized = query.toLowerCase();
  for (const file of inventory.files) {
    if (matches.length >= maxResults) break;
    if (!inside(file.path, directory.relativePath)) continue;
    if (file.path.toLowerCase().includes(normalized)) matches.push({ path: file.path, match: "path" });
    if (matches.length >= maxResults || file.binary || !includeSnippet(file.path, file.size)) continue;
    const raw = await readFile(path.join(inventory.rootPath, file.path)).catch(() => null);
    if (!raw) continue;
    for (const [lineIndex, line] of redact(raw.subarray(0, Math.min(raw.length, 500000)).toString("utf8")).split(/\r?\n/).entries()) {
      if (!line.toLowerCase().includes(normalized)) continue;
      matches.push({ path: file.path, line: lineIndex + 1, text: line.length > 300 ? line.slice(0, 300) + "..." : line, match: "content" });
      if (matches.length >= maxResults) break;
    }
  }
  return { query, directory: directory.relativePath, matches, omitted: Math.max(0, inventory.files.length - matches.length) + inventory.omittedFiles };
}
async function loadProject() {
  const project = JSON.parse(await readFile(path.join(CONFIG.projectRoot, ".archicode", "project.json"), "utf8"));
  const flowFiles = await readdir(path.join(CONFIG.projectRoot, ".archicode", "flows")).catch(() => []);
  const flows = [];
  for (const file of flowFiles.filter((item) => item.endsWith(".json"))) {
    try { flows.push(JSON.parse(await readFile(path.join(CONFIG.projectRoot, ".archicode", "flows", file), "utf8"))); } catch {}
  }
  const runFiles = await readdir(path.join(CONFIG.projectRoot, ".archicode", "runs")).catch(() => []);
  const runs = [];
  for (const file of runFiles.filter((item) => item.endsWith(".json"))) {
    try {
      const run = JSON.parse(await readFile(path.join(CONFIG.projectRoot, ".archicode", "runs", file), "utf8"));
      if (!Array.isArray(run.logs) || !run.logs.length) {
        const sidecar = await readFile(path.join(CONFIG.projectRoot, ".archicode", "runs", file.replace(/\.json$/, ".log.jsonl")), "utf8").catch(() => "");
        if (sidecar) {
          run.logs = sidecar.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
        }
      }
      runs.push(run);
    } catch {}
  }
  const artifactFiles = await readdir(path.join(CONFIG.projectRoot, ".archicode", "artifacts")).catch(() => []);
  const artifacts = [];
  for (const file of artifactFiles.filter((item) => item.endsWith(".json"))) {
    try { artifacts.push(JSON.parse(await readFile(path.join(CONFIG.projectRoot, ".archicode", "artifacts", file), "utf8"))); } catch {}
  }
  const policyEvaluation = JSON.parse(await readFile(path.join(CONFIG.projectRoot, ".archicode", "runtime", "architecture-policy-evaluation.json"), "utf8").catch(() => "null"));
  return { project, flows, runs, artifacts, policyEvaluation };
}
function ruleAttachments(bundle, ruleId) {
  return bundle.flows.flatMap((flow) => (flow.nodes || []).flatMap((node) => (node.ruleIds || []).includes(ruleId)
    ? [{ flowId: flow.id, flowName: flow.name, nodeId: node.id, nodeTitle: node.title }]
    : []));
}
function ruleImplication(rule, attachments) {
  const active = (rule.status || "active") === "active";
  if (!rule.constraint) return { evaluation: "agent-context-only", active, llmCallForLinting: false, effect: "This rule does not create live lint violations." };
  const graphKind = ["required-node-metadata", "node-relationship", "no-orphan-nodes"].includes(rule.constraint.kind);
  const scope = graphKind ? (rule.constraint.scope || "attached") : "project";
  return {
    evaluation: "local-deterministic",
    active,
    llmCallForLinting: false,
    severity: rule.severity || "warning",
    enforcement: rule.enforcement || "advisory",
    scope,
    attachmentCount: attachments.length,
    runGate: active && rule.severity === "error" && rule.enforcement === "enforced"
      ? "A source-changing run fails when it introduces a new violation after the run baseline; existing baseline violations do not fail it."
      : "Violations are reported but do not fail runs."
  };
}
function policyDefinitionFingerprint(rules) {
  const definitions = rules
    .filter((rule) => (rule.status || "active") === "active" && rule.constraint)
    .map((rule) => ({ id: rule.id, title: rule.title, body: rule.body, kind: rule.kind || "policy", status: rule.status || "active", severity: rule.severity || "warning", enforcement: rule.enforcement || "advisory", constraint: rule.constraint }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
}
function violationFlowIds(violation) {
  return [...new Set([violation.source?.flowId, violation.target?.flowId].filter(Boolean))];
}
function violationNodeIds(violation) {
  return [...new Set([violation.source?.nodeId, violation.target?.nodeId].filter(Boolean))];
}
async function manageRules(args) {
  const action = typeof args.action === "string" ? args.action : "";
  if (!["list", "get", "list_violations"].includes(action)) throw new Error("Run agents have read-only rule access. Use list, get, or list_violations.");
  const bundle = await loadProject();
  const rules = bundle.project.settings?.nodeRules || [];
  const flowId = typeof args.flowId === "string" ? args.flowId.trim() : "";
  const nodeId = typeof args.nodeId === "string" ? args.nodeId.trim() : "";
  const ruleId = typeof args.ruleId === "string" ? args.ruleId.trim() : "";
  if (nodeId && !flowId) throw new Error("flowId is required when nodeId is provided.");
  const flow = flowId ? bundle.flows.find((item) => item.id === flowId) : undefined;
  if (flowId && !flow) throw new Error("Flow " + flowId + " was not found.");
  if (nodeId && !(flow.nodes || []).some((node) => node.id === nodeId)) throw new Error("Node " + nodeId + " was not found in flow " + flowId + ".");
  if (action === "list" || action === "get") {
    if (action === "get" && !ruleId) throw new Error("ruleId is required for get.");
    const attachedRuleIds = flowId ? new Set((flow.nodes || []).filter((node) => !nodeId || node.id === nodeId).flatMap((node) => node.ruleIds || [])) : undefined;
    const selected = rules.filter((rule) => (!ruleId || rule.id === ruleId) && (!attachedRuleIds || attachedRuleIds.has(rule.id)) && (!args.status || (rule.status || "active") === args.status) && (!args.kind || (rule.kind || (rule.constraint ? "policy" : "guidance")) === args.kind));
    if (action === "get" && !selected.length) throw new Error("Rule " + ruleId + " was not found.");
    return { action, count: selected.length, rules: selected.map((rule) => { const attachments = ruleAttachments(bundle, rule.id); return { rule, attachments, implication: ruleImplication(rule, attachments) }; }) };
  }
  if (ruleId && !rules.some((rule) => rule.id === ruleId)) throw new Error("Rule " + ruleId + " was not found.");
  const activePolicyCount = rules.filter((rule) => (rule.status || "active") === "active" && rule.constraint).length;
  const evaluation = bundle.policyEvaluation;
  const evaluationStatus = activePolicyCount === 0 ? "current" : !evaluation ? "unavailable" : evaluation.policyFingerprint === policyDefinitionFingerprint(rules) ? "current" : "stale";
  const includeUnassigned = args.includeUnassigned !== false;
  const severity = typeof args.severity === "string" ? args.severity : "";
  const enforcement = typeof args.enforcement === "string" ? args.enforcement : "";
  const maxResults = clampInteger(args.maxResults, 100, 1, 500);
  const matched = (activePolicyCount === 0 ? [] : evaluation?.violations || []).filter((violation) => {
    const flowIds = violationFlowIds(violation); const nodeIds = violationNodeIds(violation);
    return (!flowId || flowIds.includes(flowId)) && (!nodeId || nodeIds.includes(nodeId)) && (!ruleId || violation.policyId === ruleId) && (!severity || violation.severity === severity) && (!enforcement || violation.enforcement === enforcement) && (includeUnassigned || flowIds.length > 0);
  });
  const flowCounts = new Map(); const ruleCounts = new Map(); let blocking = 0; let unassigned = 0;
  for (const violation of matched) {
    const isBlocking = violation.severity === "error" && violation.enforcement === "enforced"; if (isBlocking) blocking += 1;
    const ids = violationFlowIds(violation); if (!ids.length) unassigned += 1;
    for (const id of ids) { const current = flowCounts.get(id) || { count: 0, blocking: 0 }; flowCounts.set(id, { count: current.count + 1, blocking: current.blocking + (isBlocking ? 1 : 0) }); }
    const currentRule = ruleCounts.get(violation.policyId) || { title: violation.policyTitle, count: 0, blocking: 0 }; ruleCounts.set(violation.policyId, { ...currentRule, count: currentRule.count + 1, blocking: currentRule.blocking + (isBlocking ? 1 : 0) });
  }
  return {
    action,
    evaluation: { available: Boolean(evaluation) || activePolicyCount === 0, status: evaluationStatus, generatedAt: evaluation?.generatedAt, analyzerVersion: evaluation?.analyzerVersion, activePolicies: activePolicyCount, message: evaluationStatus === "stale" ? "The cached evaluation predates the current policy definitions; treat it as advisory until deterministic refresh/verification." : evaluationStatus === "unavailable" ? "No evaluation is available yet; run verification will establish or refresh it." : undefined },
    filters: { flowId: flowId || undefined, nodeId: nodeId || undefined, ruleId: ruleId || undefined, severity: severity || undefined, enforcement: enforcement || undefined, includeUnassigned },
    summary: { matching: matched.length, returned: Math.min(matched.length, maxResults), omitted: Math.max(0, matched.length - maxResults), blocking, unassigned, byFlow: [...flowCounts.entries()].map(([id, counts]) => ({ flowId: id, flowName: bundle.flows.find((flow) => flow.id === id)?.name || "Missing flow", ...counts })).sort((a, b) => b.blocking - a.blocking || b.count - a.count), byRule: [...ruleCounts.entries()].map(([id, counts]) => ({ ruleId: id, ...counts })).sort((a, b) => b.blocking - a.blocking || b.count - a.count) },
    violations: matched.slice(0, maxResults).map((violation) => ({ ...violation, flowIds: violationFlowIds(violation), nodeIds: violationNodeIds(violation), blocking: violation.severity === "error" && violation.enforcement === "enforced" }))
  };
}
function codeNodeSummary(node) {
  return { id: node.id, kind: node.kind, label: node.label, path: node.path, line: node.line, symbolKind: node.symbolKind, language: node.language, community: node.community, architectureNodeId: node.architectureNodeId };
}
function codeEdgeSummary(edge) {
  return { id: edge.id, source: edge.source, target: edge.target, kind: edge.kind, evidence: { origin: edge.evidence?.origin, confidence: edge.evidence?.confidence, verification: edge.evidence?.verification, freshness: edge.evidence?.freshness, relationKinds: (edge.evidence?.relationKinds || []).slice(0, 6), locations: (edge.evidence?.locations || []).slice(0, 2) } };
}
function codeMatches(snapshot, reference, limit) {
  const normalized = typeof reference === "string" ? reference.trim().toLowerCase() : "";
  if (!normalized) return [];
  const exactId = snapshot.nodes.find((node) => String(node.id).toLowerCase() === normalized);
  if (exactId) return [exactId];
  const exactFile = snapshot.nodes.find((node) => node.kind === "file" && String(node.path).toLowerCase() === normalized);
  if (exactFile) return [exactFile];
  const exactLabels = snapshot.nodes.filter((node) => String(node.label).toLowerCase() === normalized);
  if (exactLabels.length === 1) return exactLabels;
  return snapshot.nodes.filter((node) => [node.label, node.path, node.symbolKind, node.language].some((value) => typeof value === "string" && value.toLowerCase().includes(normalized))).slice(0, limit);
}
function codeResolve(snapshot, reference) {
  const matches = codeMatches(snapshot, reference, 10);
  if (!matches.length) return { error: "No code graph node matched " + JSON.stringify(reference || "") + "." };
  if (matches.length > 1) return { error: "The reference is ambiguous; retry with an exact node id or file path.", candidates: matches.map(codeNodeSummary) };
  return { node: matches[0] };
}
async function queryCodeGraph(args) {
  const filePath = path.join(CONFIG.projectRoot, ".archicode", "runtime", "code-knowledge.json");
  const snapshot = JSON.parse(await readFile(filePath, "utf8").catch(() => "null"));
  if (!snapshot?.nodes || !snapshot?.edges) return { available: false, message: "The local code graph is not available yet. Import or refresh the code knowledge map first." };
  const action = typeof args.action === "string" ? args.action : "";
  if (!["search", "neighbors", "path", "impact"].includes(action)) throw new Error("A valid code graph action is required.");
  const maxResults = clampInteger(args.maxResults, 20, 1, 40);
  const base = { available: true, generatedAt: snapshot.generatedAt, snapshotStats: snapshot.stats, action, limit: maxResults, bounded: true };
  if (action === "search") { const matches = codeMatches(snapshot, args.query, maxResults + 1); return { ...base, query: args.query, nodes: matches.slice(0, maxResults).map(codeNodeSummary), omitted: matches.length > maxResults }; }
  const source = codeResolve(snapshot, args.source);
  if (!source.node) return { ...base, error: source.error, candidates: source.candidates };
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  if (action === "impact") {
    const dependents = new Map();
    for (const edge of snapshot.edges) if (edge.kind !== "contains") dependents.set(edge.target, [...(dependents.get(edge.target) || []), edge.source]);
    const visited = new Set([source.node.id]);
    const queue = [source.node.id];
    for (let cursor = 0; cursor < queue.length && visited.size < maxResults; cursor += 1) {
      for (const id of dependents.get(queue[cursor]) || []) if (!visited.has(id)) { visited.add(id); queue.push(id); if (visited.size >= maxResults) break; }
    }
    return { ...base, source: codeNodeSummary(source.node), direction: "reverse-dependents", nodes: [...visited].flatMap((id) => byId.has(id) ? [codeNodeSummary(byId.get(id))] : []) };
  }
  if (action === "path") {
    const target = codeResolve(snapshot, args.target);
    if (!target.node) return { ...base, source: codeNodeSummary(source.node), error: target.error, candidates: target.candidates };
    const adjacency = new Map();
    for (const edge of snapshot.edges) { adjacency.set(edge.source, [...(adjacency.get(edge.source) || []), { id: edge.target, edge }]); adjacency.set(edge.target, [...(adjacency.get(edge.target) || []), { id: edge.source, edge }]); }
    const visited = new Set([source.node.id]); const previous = new Map(); const queue = [source.node.id];
    for (let cursor = 0; cursor < queue.length && visited.size < 1000 && !visited.has(target.node.id); cursor += 1) for (const adjacent of adjacency.get(queue[cursor]) || []) if (!visited.has(adjacent.id)) { visited.add(adjacent.id); previous.set(adjacent.id, { id: queue[cursor], edge: adjacent.edge }); queue.push(adjacent.id); }
    if (!visited.has(target.node.id)) return { ...base, source: codeNodeSummary(source.node), target: codeNodeSummary(target.node), found: false };
    const nodeIds = [target.node.id]; const edges = []; let step = target.node.id;
    while (step !== source.node.id) { const parent = previous.get(step); if (!parent) break; nodeIds.push(parent.id); edges.push(parent.edge); step = parent.id; }
    if (edges.length > 24) return { ...base, source: codeNodeSummary(source.node), target: codeNodeSummary(target.node), found: true, omitted: true, reason: "The shortest path exceeds the 24-edge response limit." };
    return { ...base, source: codeNodeSummary(source.node), target: codeNodeSummary(target.node), found: true, nodes: nodeIds.reverse().map((id) => codeNodeSummary(byId.get(id))), edges: edges.reverse().map(codeEdgeSummary) };
  }
  const direction = ["incoming", "outgoing", "both"].includes(args.direction) ? args.direction : "both";
  const maxDepth = clampInteger(args.maxDepth, 1, 1, 4);
  const kinds = new Set(Array.isArray(args.kinds) && args.kinds.length ? args.kinds : ["contains", "dependency", "calls", "runtime"]);
  const visited = new Set([source.node.id]); const edgeIds = new Set(); const queue = [{ id: source.node.id, depth: 0 }];
  for (let cursor = 0; cursor < queue.length && visited.size < maxResults; cursor += 1) { const current = queue[cursor]; if (current.depth >= maxDepth) continue; for (const edge of snapshot.edges) { if (!kinds.has(edge.kind)) continue; const outgoing = edge.source === current.id; const incoming = edge.target === current.id; if ((direction === "outgoing" && !outgoing) || (direction === "incoming" && !incoming) || (direction === "both" && !outgoing && !incoming)) continue; const adjacent = outgoing ? edge.target : edge.source; edgeIds.add(edge.id); if (!visited.has(adjacent) && byId.has(adjacent)) { visited.add(adjacent); queue.push({ id: adjacent, depth: current.depth + 1 }); if (visited.size >= maxResults) break; } } }
  return { ...base, source: codeNodeSummary(source.node), direction, depth: maxDepth, nodes: [...visited].map((id) => codeNodeSummary(byId.get(id))), edges: snapshot.edges.filter((edge) => edgeIds.has(edge.id)).slice(0, 80).map(codeEdgeSummary) };
}
async function listRuns(args) {
  const bundle = await loadProject();
  const status = typeof args.status === "string" ? args.status.trim() : "";
  const maxResults = clampInteger(args.maxResults, 20, 1, 50);
  const candidates = bundle.runs.filter((run) => !status || run.status === status);
  return { status: status || undefined, runs: candidates.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, maxResults), omitted: Math.max(0, candidates.length - maxResults) };
}
async function readRun(args) {
  const runId = typeof args.runId === "string" ? args.runId.trim() : "";
  if (!runId) throw new Error("runId is required.");
  const bundle = await loadProject();
  const run = bundle.runs.find((item) => item.id === runId);
  if (!run) throw new Error("Run " + runId + " was not found.");
  const maxLogs = clampInteger(args.maxLogs, 80, 1, 200);
  return { ...run, logs: (run.logs || []).slice(-maxLogs), omittedLogs: Math.max(0, (run.logs || []).length - maxLogs), artifacts: bundle.artifacts.filter((artifact) => artifact.runId === run.id) };
}
function artifactPathStem(artifactPath) {
  return path.basename(artifactPath).replace(/\.[^.]+$/, "");
}
function resolveArtifactReference(artifacts, artifactId, requestedPath) {
  if (artifactId) {
    const exact = artifacts.find((item) => item.id === artifactId);
    if (exact) return exact;
    const byPath = artifacts.find((item) => item.path === artifactId || path.basename(item.path) === artifactId || artifactPathStem(item.path) === artifactId);
    if (byPath) return byPath;
  }
  if (requestedPath) {
    const normalizedPath = requestedPath.replace(/^\.\//, "");
    return artifacts.find((item) => item.path === requestedPath || item.path === normalizedPath || path.basename(item.path) === requestedPath || artifactPathStem(item.path) === requestedPath);
  }
  return undefined;
}
async function readArtifact(args) {
  const bundle = await loadProject();
  const artifactId = typeof args.artifactId === "string" ? args.artifactId.trim() : "";
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!artifactId && !requestedPath) throw new Error("A known artifactId or artifact path is required.");
  const artifact = resolveArtifactReference(bundle.artifacts.filter((item) => item.type !== "chat-artifact"), artifactId, requestedPath);
  if (!artifact) throw new Error(artifactId ? "Artifact " + artifactId + " was not found." : "A known artifactId or artifact path is required.");
  const maxChars = clampInteger(args.maxChars, 40000, 1, MAX_READ);
  const text = redact(await readFile(path.join(CONFIG.projectRoot, artifact.path), "utf8"));
  return { ...artifact, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}
function runtimeCommand(command) {
  const normalized = command.toLowerCase();
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|storybook)\b/.test(normalized) || /\b(?:vite|next|nuxt|astro|remix|svelte-kit|webpack-dev-server)\b/.test(normalized) || /\b(?:flutter|cargo|go|dotnet)\s+run\b/.test(normalized) || /\b(?:--watch|watch)\b/.test(normalized);
}
async function runCommand(args) {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) throw new Error("command is required.");
  const cwdInfo = safeRelativePath(args.cwd);
  const risk = classify(command);
  if (runtimeCommand(command)) return { command, cwd: cwdInfo.relativePath, risk, status: "rejected", message: "Runtime/watch commands must be launched with Run App, not the console tool." };
  const allowed = risk === "low" || CONFIG.settings.allowedShellCommands?.includes(command) || CONFIG.settings.shellPolicies?.some((policy) => policy.reusable && policy.command === command);
  if (!allowed) return { command, cwd: cwdInfo.relativePath, risk, status: "approval-required", message: "Medium/high risk command requires approval or a reusable shell policy." };
  const timeoutMs = clampInteger(args.timeoutMs, 60000, 1000, 60000);
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: cwdInfo.absolutePath, shell: true, env: buildSubprocessEnv(process.env, { CI: "true" }) });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { stderr += "\nCommand timed out."; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); if (stdout.length > 30000) stdout = stdout.slice(-30000); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 30000) stderr = stderr.slice(-30000); });
    child.on("close", (exitCode) => { clearTimeout(timeout); resolve({ command, cwd: cwdInfo.relativePath, risk, status: exitCode === 0 ? "succeeded" : "failed", exitCode, stdout, stderr }); });
    child.on("error", (error) => { clearTimeout(timeout); resolve({ command, cwd: cwdInfo.relativePath, risk, status: "failed", stderr: error.message }); });
  });
}
async function fetchText(url) {
  const result = await guardedFetchText(url, __archicodeLookupAll, { timeoutMs: 12000, headers: { "user-agent": "ArchiCode/0.1" } });
  return { status: result.status, contentType: result.contentType, text: result.text };
}
function stripHtml(text) {
  return text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function stringArray(value, maxItems = 5) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim().length > 0).slice(0, maxItems);
}
async function webSearch(args) {
  if (!CONFIG.settings.webSearch?.enabled) return { enabled: false, results: [], message: "Web search is disabled in project settings." };
  const provider = CONFIG.settings.webSearch?.provider || "native";
  if (provider !== "brave") {
    return { enabled: true, provider, configured: false, results: [], message: "Internal web search is available when the project's web search provider is set to Brave." };
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("query is required.");
  const maxResults = clampInteger(args.maxResults, 5, 1, 8);
  const apiKey = (process.env[${JSON.stringify(BRAVE_WEB_SEARCH_API_KEY_ENV)}] || "").trim();
  if (!apiKey) {
    return { enabled: true, provider: "brave", configured: false, query, results: [], message: "Brave web search is selected, but no Brave Search API key is saved in Preferences." };
  }
  const url = new URL(${JSON.stringify(BRAVE_WEB_SEARCH_API_URL)});
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  url.searchParams.set("extra_snippets", "true");
  url.searchParams.set("safesearch", "moderate");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        "accept": "application/json",
        "user-agent": "ArchiCode/0.1",
        "x-subscription-token": apiKey
      }
    });
    const payload = await response.json().catch(() => null);
    const web = recordValue(recordValue(payload)?.web);
    const results = Array.isArray(web?.results)
      ? web.results.slice(0, maxResults).flatMap((item) => {
          const record = recordValue(item);
          if (!record) return [];
          const title = typeof record.title === "string" ? record.title.trim() : "";
          const pageUrl = typeof record.url === "string" ? record.url.trim() : "";
          const description = typeof record.description === "string" ? record.description.trim() : "";
          const extraSnippets = stringArray(record.extra_snippets, 3);
          const age = typeof record.age === "string" ? record.age.trim() : undefined;
          if (!title && !pageUrl && !description && !extraSnippets.length) return [];
          return [{ title: title || pageUrl || "Untitled result", url: pageUrl || undefined, snippet: description || extraSnippets[0] || "", extraSnippets, age }];
        })
      : [];
    return { enabled: true, provider: "brave", configured: true, query, source: ${JSON.stringify(BRAVE_WEB_SEARCH_API_URL)}, status: response.status, results };
  } finally {
    clearTimeout(timeout);
  }
}
async function openUrl(args) {
  if (!CONFIG.settings.webSearch?.enabled) return { enabled: false, text: "", message: "Web access is disabled in project settings." };
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http and https URLs are supported.");
  const maxChars = clampInteger(args.maxChars, 20000, 500, MAX_READ);
  const page = await fetchText(url);
  const text = stripHtml(page.text);
  return { url, status: page.status, contentType: page.contentType, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}
async function callTool(name, args) {
  if (name === ${JSON.stringify(ARCHICODE_RESEARCH_RULES_TOOL_NAME)}) return manageRules(args);
  if (name === "archicode_project_list_files") return listFiles(args);
  if (name === "archicode_project_search_files") return searchFiles(args);
  if (name === "archicode_project_read_file") return readProjectFile(args);
  if (name === "archicode_project_query_code_graph") return queryCodeGraph(args);
  if (name === "archicode_project_list_runs") return listRuns(args);
  if (name === "archicode_project_read_run") return readRun(args);
  if (name === "archicode_project_read_artifact") return readArtifact(args);
  if (name === "archicode_console_run_command") return runCommand(args);
  if (name === "archicode_web_search") return webSearch(args);
  if (name === "archicode_web_open_url") return openUrl(args);
  throw new Error("Unknown built-in tool: " + name);
}
`;
}
