import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GraphReconciliationOutput, MergeResolutionOutput, PicassoGraphOutput, ProjectBundle, ProjectSettings, ResearchChatMessage, ResearchChatSession, SherlockResearchOutput } from "../../shared/schema";
import { runStatusSchema } from "../../shared/schema";
import { normalizeProjectToolArguments } from "../../shared/toolRepair";
import type { MicroRunResult } from "../microRuns";
import { readArtifactText } from "../storage/patches";
import { loadProject } from "../storage/projectStore";
import { listRuntimeServices } from "../storage/runtimeServices";
import type { ProviderMcpTool } from "../mcp";

export const RESEARCH_FILE_IGNORE_DIRS = new Set([
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
export const RESEARCH_FILE_MAX_FILES = 900;
export const RESEARCH_TOOL_MAX_RESULTS = 500;
export const RESEARCH_TOOL_MAX_READ_CHARS = 80_000;
export const RESEARCH_CLI_MAX_ARGS = 64;
export const RESEARCH_CLI_MAX_OUTPUT_CHARS = 60_000;
export const RESEARCH_CLI_TIMEOUT_MS = 15_000;
export const RESEARCH_PROJECT_FILE_SERVER_ID = "archicode-project-files";
export const RESEARCH_CLI_SERVER_LABEL = "Project Inspection CLI";

export const RESEARCH_CLI_ALLOWED_COMMANDS = [
  "git", "rg",
  "node", "npm", "pnpm", "yarn", "bun", "deno",
  "python", "python3", "pip", "pip3", "uv", "poetry",
  "go", "rustc", "cargo",
  "java", "javac", "mvn", "gradle", "./gradlew",
  "dotnet",
  "php", "composer", "ruby", "bundle",
  "vite", "tsc", "eslint", "prettier", "next", "astro", "svelte-kit", "vue-tsc",
  "flutter", "dart",
  "xcodebuild", "swift", "pod", "adb", "emulator",
  "docker", "kubectl", "terraform", "helm",
  "ls", "find", "wc", "file", "du", "cat", "head", "tail",
  "sw_vers", "xcrun", "plutil", "defaults",
  "where", "dir", "type", "findstr", "msbuild"
];

export const RESEARCH_CLI_ALLOWLIST_SUMMARY = [
  "git: status, diff, log, show, branch, rev-parse, ls-files, describe, remote, blame, grep",
  "search/file metadata: rg, ls, find without exec/delete, wc, file, du, cat/head/tail with project-relative paths",
  "JS/Python/Ruby/PHP/.NET/Go/Rust/Java package metadata and version commands",
  "frontend tool config/version inspection such as tsc --showConfig, eslint --print-config, prettier --find-config-path",
  "mobile/desktop inspection such as flutter doctor, dart pub deps, xcodebuild -list, swift package describe, adb devices",
  "infra read-only inspection such as docker ps/images/compose config, kubectl get/describe, terraform providers/state list, helm list/template",
  "macOS/Windows read-only utility commands such as sw_vers, xcrun simctl list, plutil -p, defaults read, where, findstr"
];

// Internal "sink" tools: API-capable providers deliver structured output by
// calling these instead of embedding JSON in prose. They never execute
// anything or leave the process — the tool loop captures their arguments.
export const RESEARCH_INTERNAL_SERVER_ID = "archicode-research-internal";
export const RESEARCH_CHANGE_SET_TOOL = "archicode_propose_graph_change_set";
export const RESEARCH_CANVAS_CONTROL_TOOL = "archicode_control_canvas";
export const RESEARCH_MEMORY_TOOL = "archicode_update_memory";
export const RESEARCH_MEMORY_UNCHANGED_TOOL = "archicode_leave_memory_unchanged";
export const RESEARCH_CONTEXT_SERVER_ID = "archicode-research-context";
export const RESEARCH_CONTEXT_EXPANSION_TOOL = "archicode_read_research_context";
export const RESEARCH_CHAT_HISTORY_SERVER_ID = "archicode-research-chat-history";
export const RESEARCH_CHAT_HISTORY_TOOL = "archicode_read_chat_history";
export const RESEARCH_CHAT_HISTORY_MAX_MESSAGES = 24;
export const RESEARCH_CHAT_HISTORY_DEFAULT_MESSAGES = 12;
export const RESEARCH_CHAT_HISTORY_MAX_CHARS = 16_000;
export const RESEARCH_CHAT_HISTORY_DEFAULT_CHARS = 8_000;

export function researchSinkTools(): ProviderMcpTool[] {
  const memoryArray = (description: string) => ({ type: "array", items: { type: "object", additionalProperties: true }, description });
  const memoryObjectArray = (description: string, properties: Record<string, unknown>) => ({
    type: "array",
    items: { type: "object", additionalProperties: true, properties },
    description
  });
  return [
    {
      providerToolName: RESEARCH_CHANGE_SET_TOOL,
      serverId: RESEARCH_INTERNAL_SERVER_ID,
      serverLabel: "Research",
      toolName: "propose_graph_change_set",
      description: "Deliver a reviewable ArchiCode graph change set directly only for a confirmed simple, quick, tightly bounded graph edit whose operations are already obvious and require no architecture/design synthesis. Keep the visible answer in normal prose and never apply changes directly. Substantial graph design—multiple nodes or flows, populated subflows, attachment/spec decomposition, coordinated relationships/criteria, broad refinement, architecture, or reconciliation—must use spawn_picasso instead.",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["operations"],
        properties: {
          summary: { type: "string", description: "One-line summary of the proposed graph changes." },
          operations: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            description: "Ordered changeSet operations exactly as defined by the archicodeResearch changeSet contract."
          }
        }
      }
    },
    {
      providerToolName: RESEARCH_CANVAS_CONTROL_TOOL,
      serverId: RESEARCH_INTERNAL_SERVER_ID,
      serverLabel: "Research",
      toolName: "control_canvas",
      description: "Perform a reversible canvas-only action when the user explicitly asks you to select or focus nodes/groups, switch the visible flow/detail flow, pan, center, or zoom. This is not a graph edit and needs no graph review card. Never call it merely because you mention or inspect a graph item.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["flowId", "viewport"],
        properties: {
          flowId: { type: "string", description: "Existing target flow id." },
          subflowId: { type: ["string", "null"], description: "Existing detail-flow id, null for the root layer, or omit to infer it from the targeted nodes/groups or current canvas." },
          nodeIds: { type: "array", items: { type: "string" }, description: "Existing nodes to select or focus together." },
          groupIds: { type: "array", items: { type: "string" }, description: "Existing groups whose visible member nodes should be selected or focused together." },
          selection: { type: "string", enum: ["replace", "clear", "preserve"], description: "Replace the visual selection with targets, clear it, or preserve the current selection." },
          viewport: {
            type: "object",
            additionalProperties: false,
            required: ["mode"],
            properties: {
              mode: { type: "string", enum: ["fit", "center", "pan", "zoom-to", "zoom-by", "preserve"] },
              padding: { type: "number", minimum: 0, maximum: 1 },
              maxZoom: { type: "number", minimum: 0.035, maximum: 1.35 },
              x: { type: "number", description: "Flow-space x coordinate for center mode." },
              y: { type: "number", description: "Flow-space y coordinate for center mode." },
              zoom: { type: "number", minimum: 0.035, maximum: 1.35, description: "Optional center-mode zoom or required zoom-to level." },
              dx: { type: "number", description: "Flow-space horizontal pan amount; positive moves the view toward content on the right." },
              dy: { type: "number", description: "Flow-space vertical pan amount; positive moves the view toward content below." },
              factor: { type: "number", minimum: 0.1, maximum: 10, description: "Relative zoom factor for zoom-by; greater than 1 zooms in." }
            }
          }
        }
      }
    },
    {
      providerToolName: RESEARCH_MEMORY_TOOL,
      serverId: RESEARCH_INTERNAL_SERVER_ID,
      serverLabel: "Research",
      toolName: "update_memory",
      description: "Record this turn's durable research memory delta. Call this in the same turn when the user assigns or changes a task/goal/requirement, asks about a key matter worth retaining, establishes a decision or direction, receives a durable result/fact/finding/failure, leaves work pending/blocked/unclear/awaiting confirmation, or when the cumulative summary materially needs refresh. Omit it only when no durable state changed. Never paste raw file or image dumps here; field shapes follow the researchMemoryDelta contract.",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          summary: { type: "string", description: "Updated cumulative meeting-note summary for future turns." },
          decisions: memoryArray("Durable decisions with sourceMessageIds."),
          todos: memoryObjectArray("Todos with title/status/notes/sourceMessageIds.", {
            title: { type: "string" },
            status: { type: "string", enum: ["open", "awaiting-approval", "doing", "blocked", "done", "cancelled"] },
            notes: { type: "string" },
            sourceMessageIds: { type: "array", items: { type: "string" } }
          }),
          openQuestions: memoryObjectArray("Open questions with question/status/answer.", {
            question: { type: "string" },
            status: { type: "string", enum: ["open", "answered", "resolved"] },
            answer: { type: "string" },
            sourceMessageIds: { type: "array", items: { type: "string" } }
          }),
          links: memoryArray("Useful links with url/title/note."),
          facts: memoryArray("Durable facts with text/sourceMessageIds."),
          assumptions: memoryArray("Working assumptions with text/sourceMessageIds."),
          graphRefs: memoryArray("Graph references (project/flow/subflow/node)."),
          runRefs: memoryArray("Run references with runId/status/note."),
          fileRefs: memoryArray("File references with path/note."),
          artifactRefs: memoryArray("Artifact references with artifactId/type/note."),
          imageRefs: memoryArray("Image references with visualSummary/extractedText."),
          debugFindings: memoryArray("Debug findings with text/sourceMessageIds.")
        }
      }
    },
    {
      providerToolName: RESEARCH_MEMORY_UNCHANGED_TOOL,
      serverId: RESEARCH_INTERNAL_SERVER_ID,
      serverLabel: "Research",
      toolName: "leave_memory_unchanged",
      description: "Explicitly record the model's semantic decision that this non-empty turn created no durable state worth retaining. Use this only when no task, goal, requirement, key context, decision, result, fact, pending work, blocker, uncertainty, or cumulative-summary change should persist. This is the alternative to archicode_update_memory; call exactly one of the two on every non-empty turn.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["reason"],
        properties: {
          reason: { type: "string", description: "Short semantic reason the turn is ephemeral and memory should remain unchanged." }
        }
      }
    }
  ];
}

export function researchContextExpansionTool(): ProviderMcpTool {
  return {
    providerToolName: RESEARCH_CONTEXT_EXPANSION_TOOL,
    serverId: RESEARCH_CONTEXT_SERVER_ID,
    serverLabel: "Research Context",
    toolName: "read_context",
    description: "Read fuller ArchiCode project context when the compact briefing is insufficient. Use this before answering questions that require exact full node bodies, complete current-scope graph detail, recent run traces/logs, or project graph detail.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        detail: {
          type: "string",
          enum: ["full-current-scope", "node-detail", "run-trace", "project-graph"],
          description: "The kind of context needed. The current implementation returns the relevant full scoped ArchiCode context."
        },
        reason: {
          type: "string",
          description: "Short reason this extra detail is needed."
        }
      }
    }
  };
}

export function researchChatHistoryTool(): ProviderMcpTool {
  return {
    providerToolName: RESEARCH_CHAT_HISTORY_TOOL,
    serverId: RESEARCH_CHAT_HISTORY_SERVER_ID,
    serverLabel: "Chat History",
    toolName: "read_chat_history",
    description: "Search or read older messages from this Research chat when the recent window, summary, and memory are insufficient. Use this for continuity questions about earlier user instructions, decisions, answers, or details that may have fallen out of the prompt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: {
          type: "string",
          enum: ["search", "slice"],
          description: "search finds messages containing query text. slice reads a bounded chronological window."
        },
        query: {
          type: "string",
          description: "Case-insensitive text to search for when mode is search."
        },
        beforeMessageId: {
          type: "string",
          description: "For slice mode, return messages before this message id. If omitted, returns messages just before the normal recent-message window."
        },
        afterMessageId: {
          type: "string",
          description: "For slice mode, return messages after this message id."
        },
        aroundMessageId: {
          type: "string",
          description: "For slice mode, center the returned window around this message id."
        },
        roles: {
          type: "array",
          items: { type: "string", enum: ["user", "assistant", "system"] },
          description: "Optional role filter."
        },
        maxMessages: {
          type: "integer",
          minimum: 1,
          maximum: RESEARCH_CHAT_HISTORY_MAX_MESSAGES,
          description: "Maximum messages to return."
        },
        maxChars: {
          type: "integer",
          minimum: 500,
          maximum: RESEARCH_CHAT_HISTORY_MAX_CHARS,
          description: "Maximum total content characters to return."
        }
      }
    }
  };
}

export function isResearchChangeSetTool(providerToolName: string): boolean {
  return providerToolName === RESEARCH_CHANGE_SET_TOOL;
}

export function isResearchMemoryTool(providerToolName: string): boolean {
  return providerToolName === RESEARCH_MEMORY_TOOL;
}

export function isResearchMemoryUnchangedTool(providerToolName: string): boolean {
  return providerToolName === RESEARCH_MEMORY_UNCHANGED_TOOL;
}

export function isResearchCanvasControlTool(providerToolName: string): boolean {
  return providerToolName === RESEARCH_CANVAS_CONTROL_TOOL;
}

export function isResearchSinkTool(providerToolName: string): boolean {
  return isResearchChangeSetTool(providerToolName) || isResearchCanvasControlTool(providerToolName) || isResearchMemoryTool(providerToolName) || isResearchMemoryUnchangedTool(providerToolName);
}

export function isResearchContextExpansionTool(providerToolName: string): boolean {
  return providerToolName === RESEARCH_CONTEXT_EXPANSION_TOOL;
}

export function isResearchChatHistoryTool(providerToolName: string): boolean {
  return providerToolName === RESEARCH_CHAT_HISTORY_TOOL;
}

export function microRunResultText(result: MicroRunResult): string {
  if (result.status === "failed") {
    return JSON.stringify({
      status: "failed",
      error: result.error ?? "The subagent failed.",
      partialOutput: result.output
    });
  }
  const base = result.output ?? "Micro-run completed.";
  if (result.status === "needs-clarification" && base && typeof base === "object") {
    return JSON.stringify({ ...base, unresolvedClarifications: result.clarificationQuestion });
  }
  return JSON.stringify(base);
}

// Human-readable one-liner for the activity card. Unlike microRunResultText
// (raw JSON fed back to the model), this is prose the user actually reads — and
// deliberately does NOT dump the proposed change set, which becomes its own
// approvable review card below the activity card.
export function microRunHumanSummary(result: MicroRunResult): string {
  if (result.status === "failed") return result.error ?? "The subagent failed.";
  const clarify = result.status === "needs-clarification" && result.clarificationQuestion
    ? ` (Proceeded without clarification: ${result.clarificationQuestion})`
    : "";
  if (result.kind === "merge-resolution") {
    const output = result.output as MergeResolutionOutput | undefined;
    const files = output?.resolvedFiles?.length ? output.resolvedFiles.join(", ") : "the conflicted files";
    const verified = output?.verificationPassed ? "verification passed" : "verification did not pass";
    return `Resolved ${files}; ${verified}.${output?.summary ? ` ${output.summary}` : ""}${clarify}`.slice(0, 1000);
  }
  if (result.kind === "sherlock-research") {
    const output = result.output as SherlockResearchOutput | undefined;
    const findingCount = output?.findings.length ?? 0;
    return `${output?.summary ?? "Investigation completed."}${findingCount ? ` ${findingCount} evidence-backed finding${findingCount === 1 ? "" : "s"}.` : ""}${clarify}`.slice(0, 1000);
  }
  const output = result.output as GraphReconciliationOutput | undefined;
  const changeSet = output?.graphChangeSet as { summary?: string; operations?: unknown[] } | undefined;
  if (changeSet?.operations?.length) {
    const count = changeSet.operations.length;
    return `Proposed ${count} graph update${count === 1 ? "" : "s"} — review the change-set card below.${changeSet.summary ? ` ${changeSet.summary}` : ""}${clarify}`.slice(0, 1000);
  }
  const designReport = (result.output as PicassoGraphOutput | undefined)?.designReport;
  return `${designReport ?? output?.reconciliationReport ?? "Picasso completed."}${clarify}`.slice(0, 1000);
}

export const RESEARCH_SPAWN_MERGE_RESOLUTION_TOOL = "archicode_spawn_merge_resolution_agent";
export const RESEARCH_SPAWN_GRAPH_RECONCILIATION_TOOL = "archicode_spawn_picasso";
export const RESEARCH_SPAWN_LEGACY_GRAPH_RECONCILIATION_TOOL = "archicode_spawn_graph_reconciliation_agent";
export const RESEARCH_SPAWN_SHERLOCK_TOOL = "archicode_spawn_sherlock";

export function researchSubagentTools(options: {
  mergeResolutionToolEnabled: boolean;
  graphReconciliationToolEnabled: boolean;
  sherlockResearchToolEnabled: boolean;
}): ProviderMcpTool[] {
  const tools: ProviderMcpTool[] = [];
  if (options.mergeResolutionToolEnabled) {
    tools.push({
      providerToolName: RESEARCH_SPAWN_MERGE_RESOLUTION_TOOL,
      serverId: "archicode-subagents",
      serverLabel: "Subagents",
      toolName: "spawn_merge_resolution_agent",
      description: "Spawn a subagent to resolve git merge conflicts and verify the code. The subagent will resolve conflicts, run verification, and perform a final comprehensive check before returning. Use this when the user requests help with merge conflicts.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["conflictedFiles"],
        properties: {
          conflictedFiles: {
            type: "array",
            items: { type: "string" },
            description: "List of files with merge conflicts (from git status)"
          },
          resolutionStrategy: {
            type: "string",
            description: "High-level guidance (e.g., 'prefer main branch', 'merge both sides')"
          },
          verificationCommands: {
            type: "array",
            items: { type: "string" },
            description: "Commands to run for verification (default: auto-detected from project)"
          }
        }
      }
    });
  }
  if (options.graphReconciliationToolEnabled) {
    tools.push({
      providerToolName: RESEARCH_SPAWN_GRAPH_RECONCILIATION_TOOL,
      serverId: "archicode-subagents",
      serverLabel: "Subagents",
      toolName: "spawn_picasso",
      description: "Spawn Picasso, the required graph architect for any substantial graph assessment or edit: creating/restructuring flows, decomposing features into multiple nodes, populated subflows, attachment/spec-derived graphs, coordinated multi-node or cross-flow changes, acceptance criteria/relationships design, broad refinement, architecture, or reconciliation. Use assess for read-only work. After a substantial edit scope is confirmed, call Picasso in that same turn; its proposal becomes the normal review card and is never applied directly. ArchiCode edges cannot cross top-level flows: express cross-flow dependencies in descriptions, acceptance criteria, or node-scoped notes, and let Picasso create enough meaningful intra-flow edges that every generated node participates in its local topology.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: {
          objective: { type: "string", description: "The graph design or update objective." },
          mode: { type: "string", enum: ["assess", "design", "refine", "reconcile"], description: "Picasso's working mode. Use assess for read-only evaluation when no graph edits were requested." },
          scope: {
            type: "object",
            additionalProperties: false,
            properties: {
              flowId: { type: "string" },
              nodeIds: { type: "array", items: { type: "string" } }
            }
          },
          evidenceSummary: { type: "string", description: "Compact evidence or a Sherlock report for Picasso to use." },
          constraints: {
            type: "array",
            items: { type: "string" },
            description: "Optional design constraints. Never request cross-flow edges; translate those dependencies into descriptions, acceptance criteria, or node-scoped notes. Do not suppress the meaningful intra-flow edges needed to connect every generated node."
          },
          detailLevel: { type: "string", enum: ["focused", "detailed", "exhaustive"] }
        }
      }
    });
  }
  if (options.sherlockResearchToolEnabled) {
    tools.push({
      providerToolName: RESEARCH_SPAWN_SHERLOCK_TOOL,
      serverId: "archicode-subagents",
      serverLabel: "Subagents",
      toolName: "spawn_sherlock",
      description: "Spawn Sherlock, a read-only private-detective subagent, in a fresh context for codebase, online, or topic research. Returns a compact evidence dossier rather than a long transcript.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: {
          objective: { type: "string", description: "The precise question or investigation objective." },
          mode: { type: "string", enum: ["codebase", "online", "topic", "mixed"] },
          scope: { type: "string", description: "Optional bounded scope description." },
          codePaths: { type: "array", items: { type: "string" } },
          evidenceRequirements: { type: "array", items: { type: "string" } }
        }
      }
    });
  }
  return tools;
}

export function isResearchSpawnMergeTool(providerToolName: string): boolean {
  return providerToolName === RESEARCH_SPAWN_MERGE_RESOLUTION_TOOL;
}

export function isResearchSpawnGraphReconciliationTool(providerToolName: string): boolean {
  return providerToolName === RESEARCH_SPAWN_GRAPH_RECONCILIATION_TOOL ||
    providerToolName === RESEARCH_SPAWN_LEGACY_GRAPH_RECONCILIATION_TOOL;
}

export function isResearchSpawnSherlockTool(providerToolName: string): boolean {
  return providerToolName === RESEARCH_SPAWN_SHERLOCK_TOOL;
}

export type ResearchProjectFile = { path: string; size: number; binary: boolean; truncated?: boolean };

export type ResearchFileInventory = {
  rootPath: string;
  files: ResearchProjectFile[];
  omittedFiles: number;
};

export function researchProjectFileTools(): ProviderMcpTool[] {
  return [
    {
      providerToolName: "archicode_project_list_files",
      serverId: RESEARCH_PROJECT_FILE_SERVER_ID,
      serverLabel: "Project Files",
      toolName: "list_files",
      description: "List files and directories inside the current project root. Use this before reading unknown paths.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          directory: { type: "string", description: "Project-relative directory to list. Defaults to the project root." },
          recursive: { type: "boolean", description: "Whether to list files recursively. Defaults to false." },
          maxResults: { type: "integer", minimum: 1, maximum: RESEARCH_TOOL_MAX_RESULTS, description: "Maximum entries to return." }
        }
      }
    },
    {
      providerToolName: "archicode_project_search_files",
      serverId: RESEARCH_PROJECT_FILE_SERVER_ID,
      serverLabel: "Project Files",
      toolName: "search_files",
      description: "Search readable project files by path and text content. Results include matching line snippets.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, description: "Text or path fragment to search for." },
          directory: { type: "string", description: "Optional project-relative directory to restrict the search." },
          maxResults: { type: "integer", minimum: 1, maximum: 100, description: "Maximum matches to return." }
        }
      }
    },
    {
      providerToolName: "archicode_project_read_file",
      serverId: RESEARCH_PROJECT_FILE_SERVER_ID,
      serverLabel: "Project Files",
      toolName: "read_file",
      description: "Read a readable project file by project-relative path. Secrets are redacted and long files are truncated.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1, description: "Project-relative file path to read." },
          startLine: { type: "integer", minimum: 1, description: "Optional 1-based first line to read." },
          endLine: { type: "integer", minimum: 1, description: "Optional 1-based last line to read." },
          maxChars: { type: "integer", minimum: 1, maximum: RESEARCH_TOOL_MAX_READ_CHARS, description: "Maximum characters to return." }
        }
      }
    },
    {
      providerToolName: "archicode_project_list_runs",
      serverId: RESEARCH_PROJECT_FILE_SERVER_ID,
      serverLabel: "Project Files",
      toolName: "list_runs",
      description: "List recent ArchiCode queue runs, including status, phase, todos, planned commands, and artifact ids.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: runStatusSchema.options, description: "Optional run status filter." },
          maxResults: { type: "integer", minimum: 1, maximum: 50, description: "Maximum runs to return." }
        }
      }
    },
    {
      providerToolName: "archicode_project_read_run",
      serverId: RESEARCH_PROJECT_FILE_SERVER_ID,
      serverLabel: "Project Files",
      toolName: "read_run",
      description: "Read one ArchiCode run with logs, todos, planned commands, traces, plan artifact ids, and produced artifact ids.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId"],
        properties: {
          runId: { type: "string", minLength: 1, description: "Run id to inspect." },
          maxLogs: { type: "integer", minimum: 1, maximum: 200, description: "Maximum trailing log entries to include." }
        }
      }
    },
    {
      providerToolName: "archicode_project_read_artifact",
      serverId: RESEARCH_PROJECT_FILE_SERVER_ID,
      serverLabel: "Project Files",
      toolName: "read_artifact",
      description: "Read a known ArchiCode artifact by artifact id or artifact path. Use this for run plans, traces, diffs, and generated reports.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          artifactId: { type: "string", minLength: 1, description: "Artifact id from run or project context." },
          path: { type: "string", minLength: 1, description: "Artifact path from run or project context." },
          maxChars: { type: "integer", minimum: 1, maximum: RESEARCH_TOOL_MAX_READ_CHARS, description: "Maximum characters to return." }
        }
      }
    },
    {
      providerToolName: "archicode_project_list_runtime_services",
      serverId: RESEARCH_PROJECT_FILE_SERVER_ID,
      serverLabel: "Project Files",
      toolName: "list_runtime_services",
      description: "List active Run App/runtime services with status, command, profile id, and recent logs.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxLogs: { type: "integer", minimum: 0, maximum: 100, description: "Maximum trailing log entries per service." }
        }
      }
    },
    {
      providerToolName: "archicode_project_inspect_cli",
      serverId: RESEARCH_PROJECT_FILE_SERVER_ID,
      serverLabel: RESEARCH_CLI_SERVER_LABEL,
      toolName: "inspect_cli",
      description: "Run a whitelisted read-only project inspection CLI command with structured args. Use this for Git diffs/history, dependency metadata, framework info, platform diagnostics, and other safe local inspection. It cannot run shells, install dependencies, start services, or mutate Git/project state.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: {
            type: "string",
            enum: RESEARCH_CLI_ALLOWED_COMMANDS,
            description: "Executable name from the read-only inspection allowlist."
          },
          args: {
            type: "array",
            items: { type: "string" },
            maxItems: RESEARCH_CLI_MAX_ARGS,
            description: "Structured command arguments. Do not include shell operators, pipes, redirection, absolute paths, or parent-directory paths."
          },
          cwd: {
            type: "string",
            description: "Optional project-relative working directory. Defaults to the project root."
          },
          timeoutMs: {
            type: "integer",
            minimum: 1000,
            maximum: RESEARCH_CLI_TIMEOUT_MS,
            description: "Maximum execution time. Defaults to 10000 ms."
          },
          maxChars: {
            type: "integer",
            minimum: 1000,
            maximum: RESEARCH_CLI_MAX_OUTPUT_CHARS,
            description: "Maximum stdout/stderr characters to return per stream."
          }
        }
      }
    }
  ];
}

export function isResearchProjectFileTool(providerToolName: string): boolean {
  return researchProjectFileTools().some((tool) => tool.providerToolName === providerToolName);
}

export async function callResearchProjectFileTool(projectRoot: string, input: { providerToolName: string; argumentsJson: string }): Promise<{
  serverId: string;
  serverLabel: string;
  toolName: string;
  resultText: string;
}> {
  const normalized = normalizeProjectToolArguments(projectRoot, input.providerToolName, input.argumentsJson);
  let args: Record<string, unknown> = {};
  if (normalized.argumentsJson.trim()) {
    const parsed = JSON.parse(normalized.argumentsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  }
  const tool = researchProjectFileTools().find((item) => item.providerToolName === input.providerToolName);
  if (!tool) throw new Error(`Project file tool ${input.providerToolName} is not available.`);
  let result: unknown;
  if (tool.toolName === "list_files") result = await researchToolListFiles(projectRoot, args);
  else if (tool.toolName === "search_files") result = await researchToolSearchFiles(projectRoot, args);
  else if (tool.toolName === "read_file") result = await researchToolReadFile(projectRoot, args);
  else if (tool.toolName === "list_runs") result = await researchToolListRuns(projectRoot, args);
  else if (tool.toolName === "read_run") result = await researchToolReadRun(projectRoot, args);
  else if (tool.toolName === "read_artifact") result = await researchToolReadArtifact(projectRoot, args);
  else if (tool.toolName === "list_runtime_services") result = await researchToolListRuntimeServices(projectRoot, args);
  else result = await researchToolInspectCli(projectRoot, args);
  return {
    serverId: RESEARCH_PROJECT_FILE_SERVER_ID,
    serverLabel: tool.serverLabel,
    toolName: tool.toolName,
    resultText: JSON.stringify(result, null, 2)
  };
}

export async function collectResearchProjectFiles(projectRoot: string): Promise<ResearchFileInventory> {
  const root = path.resolve(projectRoot);
  const files: ResearchProjectFile[] = [];
  let omittedFiles = 0;

  const visit = async (absoluteDir: string): Promise<void> => {
    if (files.length >= RESEARCH_FILE_MAX_FILES) {
      omittedFiles += 1;
      return;
    }
    const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of sorted) {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (!relativePath || RESEARCH_FILE_IGNORE_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= RESEARCH_FILE_MAX_FILES) {
        omittedFiles += 1;
        continue;
      }
      const fileStat = await stat(absolutePath).catch(() => null);
      if (!fileStat) continue;
      const binary = await fileLooksBinary(absolutePath);
      files.push({ path: relativePath, size: fileStat.size, binary });
    }
  };

  await visit(root);
  return { rootPath: root, files, omittedFiles };
}

export async function fileLooksBinary(filePath: string): Promise<boolean> {
  const bytes = await readFile(filePath).catch(() => null);
  if (!bytes) return false;
  return bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0);
}

export function shouldIncludeResearchSnippet(filePath: string, size: number): boolean {
  if (size > 500_000) return false;
  const base = path.basename(filePath).toLowerCase();
  if (/^\.env(\.|$)/i.test(base)) return true;
  if (filePath.startsWith(".archicode/")) return /\.(json|md|txt|log)$/i.test(filePath);
  return (
    /(^|\/)(package\.json|vite\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|README\.md|AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.github\/copilot-instructions\.md|agents\.md|index\.html|Dockerfile|docker-compose\.ya?ml)$/i.test(filePath) ||
    /\.(vue|ts|tsx|js|jsx|mjs|cjs|css|scss|sass|html|json|jsonc|md|mdx|yaml|yml|toml)$/i.test(filePath)
  );
}

export function redactSensitiveText(text: string): { text: string; redacted: boolean } {
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

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

export function safeResearchRelativePath(projectRoot: string, requested: unknown): { root: string; relativePath: string; absolutePath: string } {
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
  if (parts.some((part) => RESEARCH_FILE_IGNORE_DIRS.has(part))) {
    throw new Error(`Path is inside an ignored directory (${parts.find((part) => RESEARCH_FILE_IGNORE_DIRS.has(part))}).`);
  }
  return { root, relativePath: relativePath === "" ? "." : relativePath, absolutePath };
}

export function cliCommandName(value: unknown): string {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command) throw new Error("command is required.");
  if (command !== "./gradlew" && /[\\/]/.test(command)) throw new Error("Command must be an allowlisted executable name, not a path.");
  if (!RESEARCH_CLI_ALLOWED_COMMANDS.includes(command)) throw new Error(`${command} is not in the read-only CLI inspection allowlist.`);
  return command;
}

export function cliArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("args must be an array of strings.");
  if (value.length > RESEARCH_CLI_MAX_ARGS) throw new Error(`Too many arguments. Maximum is ${RESEARCH_CLI_MAX_ARGS}.`);
  return value.map((arg) => {
    if (typeof arg !== "string") throw new Error("args must be an array of strings.");
    if (arg.includes("\0")) throw new Error("Arguments cannot contain NUL bytes.");
    if (arg.length > 500) throw new Error("One argument is too long for the read-only CLI tool.");
    if (/^[A-Za-z]:[\\/]/.test(arg) || path.posix.isAbsolute(arg) || path.win32.isAbsolute(arg)) {
      throw new Error("Use project-relative paths, not absolute paths.");
    }
    const normalized = arg.replace(/\\/g, "/");
    if (normalized.split("/").includes("..")) throw new Error("Parent-directory paths are not allowed.");
    return arg;
  });
}

export function firstCliVerb(args: string[]): string {
  return args.find((arg) => arg && !arg.startsWith("-"))?.toLowerCase() ?? "";
}

export function hasAnyArg(args: string[], denied: string[]): boolean {
  const lowered = args.map((arg) => arg.toLowerCase());
  return denied.some((item) => lowered.includes(item));
}

export function startsWithAnyArg(args: string[], deniedPrefixes: string[]): boolean {
  const lowered = args.map((arg) => arg.toLowerCase());
  return lowered.some((arg) => deniedPrefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`)));
}

export function requireVerb(command: string, args: string[], allowed: string[], denied: string[] = []): string {
  const verb = firstCliVerb(args);
  if (!verb) throw new Error(`${command} requires a read-only subcommand or version flag.`);
  if (denied.includes(verb)) throw new Error(`${command} ${verb} is not allowed in the read-only CLI tool.`);
  if (!allowed.includes(verb)) throw new Error(`${command} ${verb} is not in the read-only CLI allowlist.`);
  return verb;
}

export function isVersionOnlyArgs(args: string[]): boolean {
  return args.length === 1 && ["--version", "-version", "-v", "-V"].includes(args[0] ?? "");
}

export function validateResearchCliCommand(command: string, args: string[]): void {
  const deniedCommonVerbs = ["add", "apply", "build", "clean", "create", "delete", "deploy", "destroy", "exec", "install", "kill", "login", "logout", "publish", "push", "remove", "restart", "restore", "run", "start", "stop", "test", "uninstall", "update", "upgrade", "write"];
  const commandKey = command.toLowerCase();

  if (commandKey === "git") {
    const deniedGitArgs = ["-c", "-C", "--git-dir", "--work-tree", "--exec-path", "--output", "--upload-pack", "--receive-pack", "--ext-diff", "--textconv"];
    if (startsWithAnyArg(args, deniedGitArgs)) throw new Error("This git flag is not allowed in the read-only CLI tool.");
    requireVerb(command, args, ["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "describe", "remote", "blame", "grep"], ["add", "am", "apply", "bisect", "checkout", "cherry-pick", "clean", "clone", "commit", "config", "fetch", "gc", "init", "merge", "mv", "pull", "push", "rebase", "reset", "restore", "rm", "stash", "submodule", "switch", "tag", "worktree"]);
    return;
  }

  if (commandKey === "rg") {
    if (startsWithAnyArg(args, ["--pre", "--pre-glob"])) throw new Error("ripgrep preprocessors are not allowed.");
    return;
  }

  if (["node", "rustc", "java", "javac", "php", "ruby", "vite", "next", "astro", "svelte-kit", "vue-tsc", "sw_vers", "msbuild"].includes(commandKey)) {
    if (commandKey === "next" && args.length === 1 && args[0] === "info") return;
    if (commandKey === "msbuild" && args.length === 1 && ["-version", "--version"].includes(args[0] ?? "")) return;
    if (commandKey === "sw_vers" && args.length === 0) return;
    if (!isVersionOnlyArgs(args)) throw new Error(`${command} is limited to version/info inspection.`);
    return;
  }

  if (commandKey === "tsc") {
    if (!isVersionOnlyArgs(args) && !(args.length === 1 && args[0] === "--showConfig")) throw new Error("tsc is limited to --version or --showConfig.");
    return;
  }

  if (commandKey === "eslint") {
    if (!isVersionOnlyArgs(args) && args[0] !== "--print-config") throw new Error("eslint is limited to --version or --print-config <file>.");
    return;
  }

  if (commandKey === "prettier") {
    if (!isVersionOnlyArgs(args) && args[0] !== "--find-config-path") throw new Error("prettier is limited to --version or --find-config-path <file>.");
    return;
  }

  if (commandKey === "npm") {
    if (args.length === 1 && args[0] === "--version") return;
    const verb = requireVerb(command, args, ["version", "pkg", "ls", "list", "root"], deniedCommonVerbs.concat(["audit", "ci", "config", "dedupe", "exec", "explore", "fund", "init", "link", "outdated", "pack", "prefix", "rebuild", "repo", "restart", "set", "shrinkwrap", "star", "stars", "token", "unpublish"]));
    if (verb === "pkg" && args[1] !== "get") throw new Error("npm pkg is limited to pkg get.");
    return;
  }

  if (commandKey === "pnpm") {
    if (isVersionOnlyArgs(args)) return;
    requireVerb(command, args, ["list", "ls", "why"], deniedCommonVerbs.concat(["add", "approve-builds", "audit", "config", "deploy", "dlx", "exec", "fetch", "import", "init", "install", "link", "outdated", "patch", "publish", "rebuild", "remove", "run", "setup", "store", "unlink"]));
    return;
  }

  if (commandKey === "yarn") {
    if (isVersionOnlyArgs(args)) return;
    requireVerb(command, args, ["list", "why", "info"], deniedCommonVerbs.concat(["add", "audit", "config", "create", "dlx", "exec", "init", "install", "link", "node", "npm", "pack", "patch", "plugin", "rebuild", "remove", "run", "set", "unlink", "up", "upgrade"]));
    return;
  }

  if (commandKey === "bun") {
    if (isVersionOnlyArgs(args)) return;
    const verb = requireVerb(command, args, ["pm"], deniedCommonVerbs.concat(["add", "build", "create", "install", "link", "publish", "remove", "run", "test", "update", "upgrade", "x"]));
    if (verb === "pm" && !["ls", "why"].includes((args[1] ?? "").toLowerCase())) throw new Error("bun pm is limited to pm ls or pm why.");
    return;
  }

  if (commandKey === "deno") {
    if (!isVersionOnlyArgs(args) && firstCliVerb(args) !== "info") throw new Error("deno is limited to --version or info.");
    return;
  }

  if (["python", "python3"].includes(commandKey)) {
    if (!isVersionOnlyArgs(args)) throw new Error(`${command} is limited to --version.`);
    return;
  }

  if (["pip", "pip3"].includes(commandKey)) {
    requireVerb(command, args, ["list", "show", "freeze"], deniedCommonVerbs.concat(["cache", "config", "download", "install", "uninstall", "wheel"]));
    return;
  }

  if (commandKey === "uv") {
    if (isVersionOnlyArgs(args)) return;
    const verb = requireVerb(command, args, ["pip"], deniedCommonVerbs.concat(["add", "build", "cache", "init", "lock", "publish", "remove", "run", "sync", "tool", "venv"]));
    if (verb === "pip" && !["list", "show", "freeze"].includes((args[1] ?? "").toLowerCase())) throw new Error("uv pip is limited to list/show/freeze.");
    return;
  }

  if (commandKey === "poetry") {
    if (isVersionOnlyArgs(args)) return;
    requireVerb(command, args, ["show", "check"], deniedCommonVerbs.concat(["add", "build", "config", "env", "export", "init", "install", "lock", "new", "publish", "remove", "run", "self", "shell", "update"]));
    return;
  }

  if (commandKey === "go") {
    const verb = requireVerb(command, args, ["version", "env", "list"], deniedCommonVerbs.concat(["build", "clean", "doc", "fmt", "generate", "get", "install", "mod", "run", "test", "tool", "work"]));
    if (verb === "env") {
      const allowedEnvKeys = new Set(["GOMOD", "GOWORK", "GOOS", "GOARCH", "GOVERSION", "GOPATH", "GOROOT"]);
      for (const item of args.slice(1).filter((arg) => !arg.startsWith("-"))) {
        if (!allowedEnvKeys.has(item)) throw new Error(`go env ${item} is not allowed.`);
      }
    }
    return;
  }

  if (commandKey === "cargo") {
    if (isVersionOnlyArgs(args)) return;
    requireVerb(command, args, ["metadata", "tree", "locate-project", "pkgid"], deniedCommonVerbs.concat(["add", "bench", "build", "check", "clean", "doc", "fix", "generate-lockfile", "install", "login", "new", "owner", "package", "publish", "remove", "run", "search", "test", "update", "vendor", "yank"]));
    return;
  }

  if (commandKey === "mvn") {
    if (isVersionOnlyArgs(args) || (args.length === 1 && args[0] === "--version")) return;
    requireVerb(command, args, ["help:evaluate", "dependency:tree", "dependency:list", "validate"], deniedCommonVerbs.concat(["clean", "compile", "deploy", "exec:java", "install", "package", "site", "spring-boot:run", "test", "verify"]));
    return;
  }

  if (commandKey === "gradle" || command === "./gradlew") {
    if (isVersionOnlyArgs(args) || (args.length === 1 && args[0] === "--version")) return;
    requireVerb(command, args, ["projects", "dependencies", "properties", "tasks"], deniedCommonVerbs.concat(["assemble", "build", "clean", "compilejava", "init", "install", "publish", "run", "test", "wrapper"]));
    return;
  }

  if (commandKey === "dotnet") {
    if (args[0]?.startsWith("--")) {
      if (!["--info", "--version", "--list-sdks", "--list-runtimes"].includes(args[0])) throw new Error("dotnet flag is not in the read-only allowlist.");
      return;
    }
    const verb = requireVerb(command, args, ["list", "sln", "workload"], deniedCommonVerbs.concat(["add", "build", "clean", "new", "nuget", "pack", "publish", "remove", "restore", "run", "test", "tool"]));
    if (verb === "list" && !["package", "reference"].includes((args[1] ?? "").toLowerCase())) throw new Error("dotnet list is limited to package/reference.");
    if (verb === "sln" && (args[1] ?? "").toLowerCase() !== "list") throw new Error("dotnet sln is limited to sln list.");
    if (verb === "workload" && (args[1] ?? "").toLowerCase() !== "list") throw new Error("dotnet workload is limited to workload list.");
    return;
  }

  if (commandKey === "composer") {
    if (isVersionOnlyArgs(args)) return;
    requireVerb(command, args, ["show", "validate", "licenses"], deniedCommonVerbs.concat(["archive", "clear-cache", "config", "create-project", "dump-autoload", "exec", "global", "init", "install", "reinstall", "remove", "require", "run-script", "update"]));
    return;
  }

  if (commandKey === "bundle") {
    if (isVersionOnlyArgs(args)) return;
    requireVerb(command, args, ["list", "info", "show", "platform"], deniedCommonVerbs.concat(["add", "cache", "clean", "config", "exec", "gem", "init", "install", "inject", "lock", "open", "remove", "update"]));
    return;
  }

  if (commandKey === "flutter") {
    if (isVersionOnlyArgs(args)) return;
    const verb = requireVerb(command, args, ["doctor", "pub"], deniedCommonVerbs.concat(["assemble", "attach", "build", "clean", "config", "create", "devices", "drive", "emulators", "gen-l10n", "install", "precache", "run", "screenshot", "test", "upgrade"]));
    if (verb === "pub" && !["deps", "outdated"].includes((args[1] ?? "").toLowerCase())) throw new Error("flutter pub is limited to deps/outdated.");
    return;
  }

  if (commandKey === "dart") {
    if (isVersionOnlyArgs(args)) return;
    const verb = requireVerb(command, args, ["pub"], deniedCommonVerbs.concat(["analyze", "compile", "create", "doc", "fix", "format", "run", "test"]));
    if (verb === "pub" && !["deps", "outdated"].includes((args[1] ?? "").toLowerCase())) throw new Error("dart pub is limited to deps/outdated.");
    return;
  }

  if (commandKey === "xcodebuild") {
    const allowed = ["-version", "-list", "-showbuildsettings", "-showsdks"];
    if (!args.length || !allowed.includes(args[0]?.toLowerCase() ?? "")) throw new Error("xcodebuild is limited to -version, -list, -showBuildSettings, or -showsdks.");
    return;
  }

  if (commandKey === "swift") {
    if (isVersionOnlyArgs(args)) return;
    const verb = requireVerb(command, args, ["package"], deniedCommonVerbs.concat(["build", "run", "test"]));
    if (verb === "package" && !["describe", "dump-package", "show-dependencies"].includes((args[1] ?? "").toLowerCase())) throw new Error("swift package is limited to describe/dump-package/show-dependencies.");
    return;
  }

  if (commandKey === "pod") {
    if (isVersionOnlyArgs(args)) return;
    requireVerb(command, args, ["ipc", "env", "list"], deniedCommonVerbs.concat(["cache", "deintegrate", "init", "install", "lib", "outdated", "repo", "setup", "spec", "trunk", "try", "update"]));
    return;
  }

  if (commandKey === "adb") {
    requireVerb(command, args, ["version", "devices"], deniedCommonVerbs.concat(["install", "push", "pull", "reboot", "remount", "root", "shell", "sideload", "sync", "uninstall"]));
    return;
  }

  if (commandKey === "emulator") {
    if (!(args.length === 1 && args[0] === "-list-avds")) throw new Error("emulator is limited to -list-avds.");
    return;
  }

  if (commandKey === "docker") {
    if (isVersionOnlyArgs(args)) return;
    const verb = requireVerb(command, args, ["version", "info", "ps", "images", "inspect", "compose"], deniedCommonVerbs.concat(["attach", "build", "commit", "container", "cp", "create", "exec", "export", "image", "import", "kill", "load", "login", "logout", "network", "pause", "plugin", "pull", "push", "rename", "restart", "rm", "rmi", "run", "save", "start", "stop", "swarm", "system", "tag", "unpause", "volume"]));
    if (verb === "compose" && !["version", "config", "ls", "ps"].includes((args[1] ?? "").toLowerCase())) throw new Error("docker compose is limited to version/config/ls/ps.");
    return;
  }

  if (commandKey === "kubectl") {
    requireVerb(command, args, ["version", "config", "get", "describe", "api-resources", "api-versions", "explain"], deniedCommonVerbs.concat(["annotate", "apply", "attach", "auth", "autoscale", "cluster-info", "completion", "cordon", "cp", "create", "delete", "drain", "edit", "exec", "expose", "label", "logs", "patch", "port-forward", "proxy", "replace", "rollout", "run", "scale", "set", "taint", "top", "uncordon"]));
    return;
  }

  if (commandKey === "terraform") {
    if (isVersionOnlyArgs(args) || firstCliVerb(args) === "version") return;
    const verb = requireVerb(command, args, ["providers", "state", "show"], deniedCommonVerbs.concat(["apply", "destroy", "fmt", "force-unlock", "get", "import", "init", "login", "logout", "output", "plan", "refresh", "taint", "untaint", "validate", "workspace"]));
    if (verb === "state" && (args[1] ?? "").toLowerCase() !== "list") throw new Error("terraform state is limited to state list.");
    return;
  }

  if (commandKey === "helm") {
    requireVerb(command, args, ["version", "list", "template", "show"], deniedCommonVerbs.concat(["create", "dependency", "env", "get", "history", "install", "lint", "package", "plugin", "pull", "push", "registry", "repo", "rollback", "status", "test", "uninstall", "upgrade"]));
    return;
  }

  if (commandKey === "find") {
    if (hasAnyArg(args, ["-exec", "-execdir", "-delete", "-ok", "-okdir"])) throw new Error("find exec/delete actions are not allowed.");
    return;
  }

  if (["ls", "wc", "file", "du", "cat", "head", "tail", "where", "dir", "type", "findstr"].includes(commandKey)) {
    return;
  }

  if (commandKey === "xcrun") {
    if (isVersionOnlyArgs(args)) return;
    const verb = requireVerb(command, args, ["simctl"], deniedCommonVerbs);
    if (verb === "simctl" && (args[1] ?? "").toLowerCase() !== "list") throw new Error("xcrun simctl is limited to simctl list.");
    return;
  }

  if (commandKey === "plutil") {
    if (!["-p", "-lint"].includes(args[0] ?? "")) throw new Error("plutil is limited to -p or -lint.");
    return;
  }

  if (commandKey === "defaults") {
    if ((args[0] ?? "").toLowerCase() !== "read") throw new Error("defaults is limited to read.");
    return;
  }

  throw new Error(`${command} is not implemented in the read-only CLI validator.`);
}

export function isExpectedNoGitRepositoryResult(command: string, args: string[], stderr: string): boolean {
  if (command.toLowerCase() !== "git") return false;
  const verb = firstCliVerb(args);
  if (!["status", "rev-parse", "branch", "log", "diff", "show", "ls-files"].includes(verb)) return false;
  return /not a git repository|not a git repo|no git repository/i.test(stderr);
}

export async function researchToolInspectCli(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const command = cliCommandName(args.command);
  const commandArgs = cliArgs(args.args);
  validateResearchCliCommand(command, commandArgs);
  const cwd = safeResearchRelativePath(projectRoot, args.cwd);
  const cwdStat = await stat(cwd.absolutePath).catch(() => null);
  if (!cwdStat?.isDirectory()) throw new Error("cwd must be a project-relative directory.");
  const timeoutMs = clampInteger(args.timeoutMs, 10_000, 1000, RESEARCH_CLI_TIMEOUT_MS);
  const maxChars = clampInteger(args.maxChars, 30_000, 1000, RESEARCH_CLI_MAX_OUTPUT_CHARS);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const child = spawn(command, commandArgs, {
      cwd: cwd.absolutePath,
      shell: false,
      env: {
        ...process.env,
        CI: "true",
        NO_COLOR: "1",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0"
      }
    });
    const append = (current: string, chunk: Buffer, markTruncated: () => void): string => {
      if (current.length >= maxChars) {
        markTruncated();
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > maxChars) {
        markTruncated();
        return next.slice(0, maxChars);
      }
      return next;
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk, () => { stdoutTruncated = true; });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk, () => { stderrTruncated = true; });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        command,
        args: commandArgs,
        cwd: cwd.relativePath,
        status: "failed",
        message: error.message,
        stdout: "",
        stderr: error.message,
        exitCode: null,
        timedOut: false
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      const redactedStdout = redactSensitiveText(stdout);
      const redactedStderr = redactSensitiveText(stderr);
      const expectedNoRepo = !timedOut && exitCode !== 0 && isExpectedNoGitRepositoryResult(command, commandArgs, redactedStderr.text);
      resolve({
        command,
        args: commandArgs,
        cwd: cwd.relativePath,
        status: timedOut ? "timed-out" : exitCode === 0 || expectedNoRepo ? "succeeded" : "failed",
        exitCode,
        timedOut,
        stdout: redactedStdout.text,
        stderr: expectedNoRepo ? "" : redactedStderr.text,
        stdoutTruncated,
        stderrTruncated,
        redacted: redactedStdout.redacted || redactedStderr.redacted,
        note: expectedNoRepo
          ? "Git repository is not initialized in this project folder. This expected inspection result was normalized to avoid noisy tool-router failures."
          : "Read-only inspection command run without a shell. Output is capped and secrets are redacted."
      });
    });
  });
}

export function isInsideResearchDirectory(filePath: string, directory: string): boolean {
  if (directory === ".") return true;
  return filePath === directory || filePath.startsWith(`${directory}/`);
}

export function levenshteinDistance(left: string, right: string): number {
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

export async function resolveResearchReadableFile(projectRoot: string, requestedPath: unknown): Promise<{
  target: { root: string; relativePath: string; absolutePath: string };
  resolvedPath: string;
  fileStat: Awaited<ReturnType<typeof stat>>;
  requestedPath: string;
  aliasUsed: boolean;
}> {
  const target = safeResearchRelativePath(projectRoot, requestedPath);
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
  const inventory = await collectResearchProjectFiles(projectRoot);
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

export async function researchToolListFiles(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const directory = safeResearchRelativePath(projectRoot, args.directory);
  const maxResults = clampInteger(args.maxResults, 200, 1, RESEARCH_TOOL_MAX_RESULTS);
  const recursive = args.recursive === true;
  if (!recursive) {
    const entries = await readdir(directory.absolutePath, { withFileTypes: true }).catch(() => []);
    const visible = entries
      .filter((entry) => !RESEARCH_FILE_IGNORE_DIRS.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, maxResults)
      .map((entry) => {
        const relativePath = path.join(directory.relativePath === "." ? "" : directory.relativePath, entry.name).split(path.sep).join("/");
        return {
          path: relativePath,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
        };
      });
    return {
      directory: directory.relativePath,
      recursive,
      entries: visible,
      omitted: Math.max(0, entries.length - visible.length),
      ignoredDirectories: [...RESEARCH_FILE_IGNORE_DIRS]
    };
  }

  const inventory = await collectResearchProjectFiles(projectRoot);
  const files = inventory.files
    .filter((file) => isInsideResearchDirectory(file.path, directory.relativePath))
    .slice(0, maxResults);
  return {
    directory: directory.relativePath,
    recursive,
    files,
    omitted: Math.max(0, inventory.files.filter((file) => isInsideResearchDirectory(file.path, directory.relativePath)).length - files.length) + inventory.omittedFiles,
    ignoredDirectories: [...RESEARCH_FILE_IGNORE_DIRS]
  };
}

export async function researchToolReadFile(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const resolved = await resolveResearchReadableFile(projectRoot, args.path);
  const absolutePath = path.join(resolved.target.root, resolved.resolvedPath);
  const binary = await fileLooksBinary(absolutePath);
  if (binary) {
    return {
      path: resolved.resolvedPath,
      requestedPath: resolved.requestedPath,
      aliasUsed: resolved.aliasUsed,
      size: resolved.fileStat.size,
      binary: true,
      text: "[binary file omitted]"
    };
  }
  const maxChars = clampInteger(args.maxChars, 40_000, 1, RESEARCH_TOOL_MAX_READ_CHARS);
  const raw = await readFile(absolutePath);
  const text = raw.toString("utf8");
  const redacted = redactSensitiveText(text);
  const lines = redacted.text.split(/\r?\n/);
  const hasRange = args.startLine !== undefined || args.endLine !== undefined;
  const startLine = hasRange ? clampInteger(args.startLine, 1, 1, Math.max(1, lines.length)) : undefined;
  const endLine = hasRange && startLine !== undefined ? clampInteger(args.endLine, startLine, startLine, Math.max(startLine, lines.length)) : undefined;
  const selectedText = hasRange && startLine !== undefined && endLine !== undefined
    ? lines.slice(startLine - 1, endLine).join("\n")
    : redacted.text;
  return {
    path: resolved.resolvedPath,
    requestedPath: resolved.requestedPath,
    aliasUsed: resolved.aliasUsed,
    size: resolved.fileStat.size,
    binary: false,
    text: selectedText.slice(0, maxChars),
    startLine,
    endLine,
    totalLines: lines.length,
    truncated: selectedText.length > maxChars,
    redacted: redacted.redacted
  };
}

export async function researchToolSearchFiles(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("Search query is required.");
  const directory = safeResearchRelativePath(projectRoot, args.directory);
  const maxResults = clampInteger(args.maxResults, 50, 1, 100);
  const inventory = await collectResearchProjectFiles(projectRoot);
  const normalizedQuery = query.toLowerCase();
  const matches: Array<{ path: string; line?: number; text?: string; match: "path" | "content"; redacted?: boolean }> = [];

  for (const file of inventory.files) {
    if (matches.length >= maxResults) break;
    if (!isInsideResearchDirectory(file.path, directory.relativePath)) continue;
    if (file.path.toLowerCase().includes(normalizedQuery)) {
      matches.push({ path: file.path, match: "path" });
      if (matches.length >= maxResults) break;
    }
    if (file.binary || !shouldIncludeResearchSnippet(file.path, file.size)) continue;
    const absolutePath = path.join(inventory.rootPath, file.path);
    const raw = await readFile(absolutePath).catch(() => null);
    if (!raw) continue;
    const redacted = redactSensitiveText(raw.subarray(0, Math.min(raw.length, 500_000)).toString("utf8"));
    const lines = redacted.text.split(/\r?\n/);
    for (const [lineIndex, line] of lines.entries()) {
      if (!line.toLowerCase().includes(normalizedQuery)) continue;
      matches.push({
        path: file.path,
        line: lineIndex + 1,
        text: line.length > 300 ? `${line.slice(0, 300)}...` : line,
        match: "content",
        redacted: redacted.redacted
      });
      if (matches.length >= maxResults) break;
    }
  }

  return {
    query,
    directory: directory.relativePath,
    matches,
    omitted: Math.max(0, inventory.files.length - matches.length) + inventory.omittedFiles,
    note: "Search skips binary files and heavyweight ignored directories."
  };
}

export async function researchToolListRuns(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const bundle = await loadProject(projectRoot);
  const status = typeof args.status === "string" ? args.status.trim() : "";
  const maxResults = clampInteger(args.maxResults, 20, 1, 50);
  const runs = bundle.runs
    .filter((run) => !status || run.status === status)
    .slice()
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, maxResults)
    .map((run) => ({
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
    }));
  return {
    status: status || undefined,
    runs,
    omitted: Math.max(0, bundle.runs.filter((run) => !status || run.status === status).length - runs.length)
  };
}

export async function researchToolReadRun(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const runId = typeof args.runId === "string" ? args.runId.trim() : "";
  if (!runId) throw new Error("runId is required.");
  const bundle = await loadProject(projectRoot);
  const run = bundle.runs.find((item) => item.id === runId);
  if (!run) throw new Error(`Run ${runId} was not found.`);
  const maxLogs = clampInteger(args.maxLogs, 80, 1, 200);
  const artifacts = bundle.artifacts
    .filter((artifact) => artifact.runId === run.id || run.contextArtifacts.includes(artifact.id) || run.planArtifactIds.includes(artifact.id) || run.sourceDiffArtifactIds.includes(artifact.id))
    .map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      path: artifact.path,
      status: artifact.status,
      summary: artifact.summary,
      sizeBytes: artifact.sizeBytes,
      createdAt: artifact.createdAt
    }));
  return {
    ...run,
    logs: run.logs.slice(-maxLogs),
    artifacts,
    omittedLogs: Math.max(0, run.logs.length - maxLogs)
  };
}

export async function researchToolReadArtifact(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const bundle = await loadProject(projectRoot);
  const artifactId = typeof args.artifactId === "string" ? args.artifactId.trim() : "";
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!artifactId && !requestedPath) throw new Error("A known artifactId or artifact path is required.");
  const artifact = artifactId
    ? bundle.artifacts.find((item) => item.id === artifactId)
    : bundle.artifacts.find((item) => item.path === requestedPath);
  if (!artifact) throw new Error(artifactId ? `Artifact ${artifactId} was not found.` : "A known artifactId or artifact path is required.");
  const maxChars = clampInteger(args.maxChars, 40_000, 1, RESEARCH_TOOL_MAX_READ_CHARS);
  const text = await readArtifactText(projectRoot, artifact.path);
  const redacted = redactSensitiveText(text);
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    path: artifact.path,
    runId: artifact.runId,
    status: artifact.status,
    summary: artifact.summary,
    text: redacted.text.slice(0, maxChars),
    truncated: redacted.text.length > maxChars,
    redacted: redacted.redacted
  };
}

export async function researchToolListRuntimeServices(projectRoot: string, args: Record<string, unknown>): Promise<unknown> {
  const maxLogs = clampInteger(args.maxLogs, 20, 0, 100);
  const services = await listRuntimeServices(projectRoot);
  return {
    services: services.map((service) => ({
      id: service.id,
      profileId: service.profileId,
      label: service.label,
      status: service.status,
      command: service.command,
      relativeCwd: service.relativeCwd,
      url: service.url,
      startedAt: service.startedAt,
      stoppedAt: service.stoppedAt,
      logs: service.logs.slice(-maxLogs),
      omittedLogs: Math.max(0, service.logs.length - maxLogs)
    }))
  };
}

export function researchProjectFileAccessContext(projectRoot: string): Record<string, unknown> {
  return {
    rootPath: path.resolve(projectRoot),
    access: "Use project file and read-only CLI inspection tools on demand instead of assuming all file contents or command output are in context.",
    tools: researchProjectFileTools().map((tool) => ({
      name: tool.providerToolName,
      description: tool.description
    })),
    cliInspection: {
      tool: "archicode_project_inspect_cli",
      safety: "Runs an allowlisted command with structured args, no shell, project-confined cwd, capped output, and read-only verb validation. It must not install packages, start servers, write files, or change Git/project state.",
      allowedCommands: RESEARCH_CLI_ALLOWED_COMMANDS,
      allowedUseSummary: RESEARCH_CLI_ALLOWLIST_SUMMARY
    },
    ignoredDirectories: [...RESEARCH_FILE_IGNORE_DIRS],
    limits: {
      maxListedFiles: RESEARCH_FILE_MAX_FILES,
      maxToolResults: RESEARCH_TOOL_MAX_RESULTS,
      maxReadChars: RESEARCH_TOOL_MAX_READ_CHARS
    }
  };
}
