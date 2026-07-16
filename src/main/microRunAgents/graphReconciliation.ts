import * as fs from "fs/promises";
import * as path from "path";
import type { MicroRunTool, MicroRunToolInvocation } from "../microRuns";
import type { ProjectSettings } from "@shared/schema";
import type { MicroRunContext, MicroRunAgent } from "../microRuns";
import type { GraphReconciliationInput, GraphReconciliationOutput, GraphReconciliationDiscrepancy, ArchicodeNode } from "@shared/schema";

type Provider = ProjectSettings["providers"][number];

const GRAPH_RECONCILIATION_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

function matchesPathPattern(relativePath: string, pattern: string): boolean {
  // Plain filenames/fragments (no glob metacharacters) match anywhere in the path.
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return relativePath.includes(pattern);
  }
  return globToRegExp(pattern).test(relativePath);
}

function createGraphReconciliationTools(context: MicroRunContext): MicroRunTool[] {
  const { projectRoot, bundle, onProgress } = context;

  const readResolvedFileTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "read_resolved_file",
    toolName: "read_resolved_file",
    description: "Read a file that was resolved during merge conflict resolution.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the resolved file (relative to project root)" }
      },
      required: ["filePath"]
    },
    handler: async (args: { filePath: string }) => {
      onProgress?.(`Reading resolved file: ${args.filePath}`);
      const filePath = path.join(projectRoot, args.filePath);
      const content = await fs.readFile(filePath, "utf8");
      return {
        filePath: args.filePath,
        content,
        lineCount: content.split("\n").length
      };
    }
  };

  const listProjectFilesTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "list_project_files",
    toolName: "list_project_files",
    description: "List files in a project directory.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to list (relative to project root, default: '.')" }
      }
    },
    handler: async (args?: { directory?: string }) => {
      onProgress?.(`Listing files in: ${args?.directory ?? "."}`);
      const dir = path.join(projectRoot, args?.directory ?? ".");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return {
        directory: args?.directory ?? ".",
        files: entries.filter((e) => e.isFile()).map((e) => e.name),
        directories: entries.filter((e) => e.isDirectory()).map((e) => e.name)
      };
    }
  };

  const searchFilesTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "search_files",
    toolName: "search_files",
    description: "Search for files by path pattern or content.",
    inputSchema: {
      type: "object",
      properties: {
        pathPattern: { type: "string", description: "Glob pattern for file paths (e.g., '**/*.ts')" },
        contentPattern: { type: "string", description: "Text to search for in file contents" }
      }
    },
    handler: async (args?: { pathPattern?: string; contentPattern?: string }) => {
      onProgress?.(`Searching files${args?.pathPattern ? ` matching ${args.pathPattern}` : ""}${args?.contentPattern ? ` for "${args.contentPattern}"` : ""}...`);
      const results: Array<{ path: string; match?: string }> = [];

      async function searchDir(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
              await searchDir(fullPath);
            }
          } else if (entry.isFile()) {
            const relativePath = path.relative(projectRoot, fullPath).split(path.sep).join("/");
            if (args?.pathPattern && !matchesPathPattern(relativePath, args.pathPattern)) {
              continue;
            }
            if (args?.contentPattern) {
              try {
                const content = await fs.readFile(fullPath, "utf8");
                if (content.includes(args.contentPattern)) {
                  results.push({ path: relativePath, match: "content match" });
                }
              } catch {
                // Skip binary files
              }
            } else {
              results.push({ path: relativePath });
            }
          }
        }
      }

      await searchDir(projectRoot);
      return { files: results.slice(0, 100) };
    }
  };

  const getFullGraphContextTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "get_full_graph_context",
    toolName: "get_full_graph_context",
    description: "Get the full graph context including all flows, nodes, edges, groups, and subflows. Use this to find nodes associated with resolved files.",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async () => {
      onProgress?.("Reading full graph context (flows, nodes, edges)...");
      const flows = bundle.flows.map((flow) => ({
        id: flow.id,
        name: flow.name,
        description: flow.description,
        nodes: flow.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          title: node.title,
          description: node.description,
          acceptanceCriteria: node.acceptanceCriteria,
          customProperties: node.customProperties,
          ruleIds: node.ruleIds,
          subflowId: node.subflowId,
          groupId: node.groupId,
          techStack: node.techStack
        })),
        edges: flow.edges,
        groups: flow.groups,
        subflows: flow.subflows
      }));

      return { flows, flowCount: flows.length };
    }
  };

  const proposeGraphChangeSetTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "propose_graph_change_set",
    toolName: "propose_graph_change_set",
    description: "Propose a graph change set to update nodes, edges, notes, or other graph elements. This is used to reconcile the graph with code changes.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Summary of the change set" },
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", description: "Operation kind (update-node, update-flow, add-note, etc.)" },
              flowId: { type: "string" },
              nodeId: { type: "string" },
              patch: { type: "object" },
              note: {
                type: "object",
                description:
                  "For add-note operations. Include pinned: true only for important durable context the user should see by default; use pinned: false for traceability or log-style notes."
              }
            }
          }
        }
      },
      required: ["summary", "operations"]
    },
    handler: async (args: { summary: string; operations: unknown[] }) => {
      onProgress?.(`Proposing graph changes: ${args.summary}`);
      // This is a "sink" tool - it captures the proposed changes but doesn't execute them
      // The changes will be presented to the user for approval
      return {
        captured: true,
        summary: args.summary,
        operationCount: args.operations.length,
        operations: args.operations,
        note: "Change set captured. It will be presented to the user for approval."
      };
    }
  };

  const askClarificationTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "ask_clarification",
    toolName: "ask_clarification",
    description: "Ask the user for clarification on graph reconciliation. Use when node association is ambiguous.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The clarification question" },
        context: { type: "string", description: "Additional context" }
      },
      required: ["question"]
    },
    handler: async (args: { question: string; context?: string }) => {
      if (context.onClarification) {
        const fullQuestion = args.context ? `${args.question}\n\nContext: ${args.context}` : args.question;
        const answer = await context.onClarification(fullQuestion);
        return { question: args.question, answer };
      }
      return {
        question: args.question,
        answer: "No clarification available. Proceed with best judgment.",
        note: "Clarification handler not available"
      };
    }
  };

  return [
    readResolvedFileTool,
    listProjectFilesTool,
    searchFilesTool,
    getFullGraphContextTool,
    proposeGraphChangeSetTool,
    askClarificationTool
  ];
}

function buildGraphReconciliationSystemPrompt(input: unknown, context: MicroRunContext): string {
  const typedInput = input as GraphReconciliationInput;
  const resolvedFilesList = typedInput.resolvedFiles.join(", ");

  return `You are a graph reconciliation specialist. Your task is to ensure the ArchiCode graph stays synchronized with code changes after merge conflict resolution.

## Context
The following files were resolved during merge conflict resolution:
${resolvedFilesList}

Resolution summary: ${typedInput.resolutionSummary}

Verification result: ${typedInput.verificationResult}

## Your Task
1. Read all resolved files to understand what changed
2. Find ALL graph nodes associated with these files (thorough search, no blindspots):
   - Direct association: nodes whose acceptanceCriteria mention the file
   - Direct association: nodes whose description mentions the file/functionality
   - Direct association: nodes with customProperties referencing the file
   - Direct association: nodes with techStack matching the file's language
   - Indirect association: nodes that depend on associated nodes
   - Indirect association: nodes in the same flow as associated nodes
   - Indirect association: nodes connected by edges to associated nodes
3. Compare resolved code against node specifications:
   - Does the code still match the acceptance criteria?
   - Is the description still accurate?
   - Are there new features not reflected in the graph?
   - Are there removed features still in the graph?
4. Identify ALL discrepancies (be thorough):
   - Behavior changed but spec unchanged
   - New functionality not in graph
   - Removed functionality still in graph
   - Acceptance criteria no longer accurate
   - Node relationships shown by edges changed
   - Tech stack assumptions changed
5. Propose graph updates via the propose_graph_change_set tool:
   - Update node descriptions if behavior changed
   - Update acceptance criteria if they no longer match
   - Add notes flagging that implementation changed
   - Pin notes only when they contain important durable context the user should see by default
   - Create new nodes if new functionality was introduced
   - Update edges or edge labels if the relationship changed
6. Generate a comprehensive reconciliation report

## Important Rules
- Be thorough - check direct AND indirect associations
- Don't miss any discrepancies
- Ask for clarification if the association is ambiguous
- Propose conservative updates (better to flag than assume)
- Note pinning policy: use pinned: true for important decisions, unresolved risks, user-actionable follow-ups, or durable architectural context that should stay visible on the node. Use pinned: false for traceability, audit/log notes, routine merge-resolution summaries, and low-value bookkeeping. Never say a note is pinned unless the add-note operation sets pinned: true.
- The graph is the source of truth - code changes must be reflected in the graph
- Even if no discrepancies are found, report that explicitly

## Change Set Operations
You can propose these operation kinds:
- update-node: Update node fields (title, description, acceptanceCriteria, etc.)
- update-flow: Update flow name or description
- add-note: Add a note to a node
- create-node: Create a new node
- create-edge: Create a new edge
- delete-node: Delete a node
- delete-edge: Delete an edge

## Return Format
Return a JSON object with this exact structure:
{
  "graphChangeSet": {
    "summary": "Summary of proposed changes",
    "operations": [...]
  },
  "nodesAffected": ["nodeId1", "nodeId2", ...],
  "reconciliationReport": "Comprehensive report of what was checked and what changes are proposed",
  "discrepancies": [
    {
      "nodeId": "node-id",
      "nodeTitle": "Node Title",
      "issue": "Description of the discrepancy",
      "proposedFix": "Description of the proposed fix"
    }
  ]
}

If no discrepancies are found:
{
  "graphChangeSet": null,
  "nodesAffected": [],
  "reconciliationReport": "No discrepancies found. The graph is synchronized with the resolved code.",
  "discrepancies": []
}

Remember: The graph is the source of truth. Your job is to ensure the graph accurately reflects the current state of the codebase after merge resolution.`;
}

function buildGraphReconciliationUserMessage(input: unknown, context: MicroRunContext): string {
  const typedInput = input as GraphReconciliationInput;
  return `Reconcile the graph after the following files were resolved during merge conflict resolution:

Resolved files: ${typedInput.resolvedFiles.join(", ")}

Resolution summary: ${typedInput.resolutionSummary}

Verification result: ${typedInput.verificationResult}

Start by reading the resolved files, then find all associated graph nodes, compare the code against node specs, and propose any necessary graph updates.`;
}

// Recover the proposed change set from the last propose_graph_change_set tool
// call. This is more reliable than the model re-emitting the same JSON in its
// final text: if it ends early or transport drops after the tool call, the
// final text may be missing but the tool args survive.
function changeSetFromToolCalls(toolCalls?: MicroRunToolInvocation[]): { summary: string; operations: unknown[] } | undefined {
  if (!toolCalls?.length) return undefined;
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    if (toolCalls[i].succeeded === false) continue;
    if (toolCalls[i].providerToolName !== "propose_graph_change_set") continue;
    try {
      const args = JSON.parse(toolCalls[i].argumentsJson || "{}");
      if (Array.isArray(args.operations) && args.operations.length > 0) {
        return { summary: typeof args.summary === "string" ? args.summary : "Graph reconciliation updates", operations: args.operations };
      }
    } catch {
      // Try an earlier tool call.
    }
  }
  return undefined;
}

function parseGraphReconciliationOutput(text: string, toolCalls?: MicroRunToolInvocation[]): GraphReconciliationOutput {
  const capturedChangeSet = changeSetFromToolCalls(toolCalls);
  let parsed: Record<string, unknown> = {};
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // Keep the empty object; fall back to the captured tool call below.
    }
  }

  const graphChangeSet = (parsed.graphChangeSet as GraphReconciliationOutput["graphChangeSet"]) ?? capturedChangeSet ?? undefined;
  const parsedIsEmpty = !jsonMatch || Object.keys(parsed).length === 0;

  return {
    graphChangeSet,
    nodesAffected: (parsed.nodesAffected as string[]) ?? [],
    reconciliationReport: (parsed.reconciliationReport as string)
      ?? (capturedChangeSet
        ? "Reconciliation proposed graph updates (recovered from the proposed change set; the final report text was unavailable)."
        : parsedIsEmpty
          ? "Failed to parse reconciliation output."
          : "Reconciliation completed."),
    discrepancies: (parsed.discrepancies as GraphReconciliationDiscrepancy[]) ?? []
  };
}

export const graphReconciliationAgent: MicroRunAgent = {
  kind: "graph-reconciliation",
  systemPrompt: buildGraphReconciliationSystemPrompt,
  userMessage: buildGraphReconciliationUserMessage,
  tools: createGraphReconciliationTools,
  timeoutMs: GRAPH_RECONCILIATION_TIMEOUT_MS,
  parseOutput: parseGraphReconciliationOutput
};
