import * as fs from "fs/promises";
import * as path from "path";
import type { MicroRunTool, MicroRunToolInvocation } from "../microRuns";
import type { MicroRunContext, MicroRunAgent } from "../microRuns";
import { runGitCommand, isFileConflicted, getConflictedFiles } from "../microRuns";
import { detectTechStack } from "../techStack";
import { createGuardedConsoleTool } from "./guardedConsole";
import {
  mergeResolutionInputSchema,
  mergeResolutionOutputSchema,
  type ProjectSettings,
  type MergeResolutionInput,
  type MergeResolutionOutput
} from "../../shared/schema";

type Provider = ProjectSettings["providers"][number];

const MERGE_RESOLUTION_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

function createMergeResolutionTools(context: MicroRunContext): MicroRunTool[] {
  const { projectRoot, bundle, onProgress } = context;

  const detectTechStackTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "detect_tech_stack",
    toolName: "detect_tech_stack",
    description: "Detect the project's tech stack and infer verification commands. Returns language, package manager, build tool, auto-detected suggested commands, and any project-configured verification commands (configuredVerificationCommands) which take precedence over the suggested ones.",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async () => {
      const stack = await detectTechStack(projectRoot);
      const verificationSettings = bundle.project.settings.verification;
      const autoDetect = verificationSettings?.autoDetect ?? true;
      const configuredVerificationCommands = (verificationSettings?.commands ?? []).map((cmd) => ({
        name: cmd.name,
        command: [cmd.command, ...cmd.args].join(" ").trim(),
        required: cmd.required,
        timeoutMs: cmd.timeout
      }));
      return {
        primaryLanguage: stack.primaryLanguage,
        languages: stack.languages,
        packageManager: stack.packageManager,
        buildTool: stack.buildTool,
        testFramework: stack.testFramework,
        lintTool: stack.lintTool,
        typecheckTool: stack.typecheckTool,
        suggestedCommands: autoDetect ? stack.suggestedCommands : {},
        configFiles: stack.configFiles,
        configuredVerificationCommands,
        note: configuredVerificationCommands.length > 0
          ? "configuredVerificationCommands are set by the project owner and take precedence over suggestedCommands. Commands marked required must pass; others are best-effort."
          : undefined
      };
    }
  };

  const readConflictedFileTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "read_conflicted_file",
    toolName: "read_conflicted_file",
    description: "Read a file that has merge conflicts. Returns the file content with conflict markers.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the conflicted file (relative to project root)" }
      },
      required: ["filePath"]
    },
    handler: async (args: { filePath: string }) => {
      const filePath = path.join(projectRoot, args.filePath);
      const content = await fs.readFile(filePath, "utf8");
      const isConflicted = await isFileConflicted(projectRoot, args.filePath);
      return {
        filePath: args.filePath,
        content,
        isConflicted,
        lineCount: content.split("\n").length
      };
    }
  };

  const writeConflictedFileTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "write_conflicted_file",
    toolName: "write_conflicted_file",
    description: "Write a resolved version of a conflicted file. ONLY works for files that are currently in a conflicted state. After writing, the file is staged.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the conflicted file (relative to project root)" },
        content: { type: "string", description: "Resolved file content (without conflict markers)" },
        resolutionExplanation: { type: "string", description: "Explanation of how the conflict was resolved" }
      },
      required: ["filePath", "content", "resolutionExplanation"]
    },
    handler: async (args: { filePath: string; content: string; resolutionExplanation: string }) => {
      const isConflicted = await isFileConflicted(projectRoot, args.filePath);
      if (!isConflicted) {
        return {
          success: false,
          error: `File "${args.filePath}" is not in a conflicted state. Only conflicted files can be written.`
        };
      }

      const filePath = path.join(projectRoot, args.filePath);
      await fs.writeFile(filePath, args.content, "utf8");

      // Stage the resolved file
      await runGitCommand(projectRoot, ["add", args.filePath]);

      onProgress?.(`Resolved: ${args.filePath}`);

      return {
        success: true,
        filePath: args.filePath,
        resolutionExplanation: args.resolutionExplanation
      };
    }
  };

  const runGitStatusTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "run_git_status",
    toolName: "run_git_status",
    description: "Run git status to see current conflict state. Returns list of conflicted files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional specific file path to check" }
      }
    },
    handler: async (args?: { path?: string }) => {
      const gitArgs = args?.path ? ["status", "--porcelain", args.path] : ["status", "--porcelain"];
      const result = await runGitCommand(projectRoot, gitArgs);

      const conflictedFiles = await getConflictedFiles(projectRoot);

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        conflictedFiles,
        conflictCount: conflictedFiles.length
      };
    }
  };

  const runGitDiffTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "run_git_diff",
    toolName: "run_git_diff",
    description: "Run git diff to see changes. Useful for understanding both sides of a conflict.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Optional specific file to diff" },
        base: { type: "string", description: "Optional base commit/branch (e.g., 'HEAD', 'main', 'ours')" },
        target: { type: "string", description: "Optional target commit/branch (e.g., 'MERGE_HEAD', 'theirs')" }
      }
    },
    handler: async (args?: { filePath?: string; base?: string; target?: string }) => {
      const gitArgs = ["diff"];
      if (args?.base) gitArgs.push(args.base);
      if (args?.target) gitArgs.push(args.target);
      if (args?.filePath) gitArgs.push("--", args.filePath);

      const result = await runGitCommand(projectRoot, gitArgs);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    }
  };

  const runVerificationCommandTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "run_verification_command",
    toolName: "run_verification_command",
    description: "Run a verification command (test, lint, typecheck, build). Returns exit code, stdout, stderr, and pass/fail status.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run (e.g., 'npm test', 'cargo check', 'pytest')" },
        args: { type: "array", items: { type: "string" }, description: "Command arguments" },
        timeout: { type: "number", description: "Timeout in milliseconds (default: 600000)" }
      },
      required: ["command"]
    },
    handler: async (args: { command: string; args?: string[]; timeout?: number }) => {
      if (!context.runConsoleCommand) {
        return { passed: false, status: "unavailable", message: "The guarded CLI is unavailable in this merge-resolution context." };
      }
      const quotedArgs = (args.args ?? []).map((value) => `'${value.replace(/'/g, `'\\''`)}'`);
      const command = [args.command.trim(), ...quotedArgs].filter(Boolean).join(" ");
      onProgress?.(`Running verification: ${command}`);
      const result = await context.runConsoleCommand({ command, timeoutMs: args.timeout ?? 600000 });
      const record = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : {};
      return {
        ...record,
        command,
        args: args.args ?? [],
        passed: record.status === "succeeded"
      };
    }
  };

  const askClarificationTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "ask_clarification",
    toolName: "ask_clarification",
    description: "Ask the user for clarification on an ambiguous conflict. Use this when the resolution strategy is unclear.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The clarification question for the user" },
        context: { type: "string", description: "Additional context about the conflict" }
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

  const guardedConsole = createGuardedConsoleTool(context, {
    description: "Run a finite project-scoped inspection, conflict diagnostic, or verification chosen for Solomon's assigned merge resolution. The shared safety broker evaluates the actual action. Use the dedicated conflict writer—not shell commands—for file resolution.",
    progressLabel: "Running guarded merge command"
  });

  return [
    detectTechStackTool,
    readConflictedFileTool,
    writeConflictedFileTool,
    runGitStatusTool,
    runGitDiffTool,
    runVerificationCommandTool,
    askClarificationTool,
    ...(guardedConsole ? [guardedConsole] : [])
  ];
}

function buildMergeResolutionSystemPrompt(input: unknown, context: MicroRunContext): string {
  const typedInput = input as MergeResolutionInput;
  return `You are Solomon, ArchiCode's Merge Arbiter. You resolve merge conflicts carefully and fairly across ANY programming language or tech stack.

## Your Task
Resolve merge conflicts in the following files: ${typedInput.conflictedFiles.join(", ")}

${typedInput.resolutionStrategy ? `Resolution strategy: ${typedInput.resolutionStrategy}` : "Use your best judgment to resolve conflicts."}

## Operating Contract
Own the resolution tactics and iteration. Inspect enough repository and conflict evidence to understand both sides, preserve compatible intent, write only files that are currently conflicted, and use relevant verification evidence before reporting completion. If verification fails, adapt while a useful corrective action remains; do not repeat an unchanged attempt.

You also have a shared guarded CLI for project-scoped inspection, diagnostics, and verification. Choose useful commands yourself; the host evaluates their actual scope and risk. Resolve files only through the dedicated conflicted-file writer so the assigned write boundary remains explicit.

## Important Rules
- You can ONLY write files that are currently in a conflicted state
- If a file is not conflicted, you cannot modify it
- Ask for clarification if a conflict is ambiguous
- Work with any file type or language - do not assume a specific tech stack
- Detect and adapt to the project's tooling
- Be thorough - resolve ALL conflicts before completing
- For .archicode/flows/*.json, treat nodes, edges, groups, and subflows as deterministic ID-keyed collections. Match graph entities by stable id, not textual position.
- Legacy updatedAt conflicts are generated metadata, never a user decision. Resolve or remove them automatically after preserving meaningful changes; never ask the user to choose a timestamp.
- Ask the user only about genuine content or structural disagreements, such as both sides changing the same field differently, or one side deleting an entity that the other side edited.
- Preserve independent changes to different fields or different graph entity IDs. Never choose one whole flow version when the changes can be combined.
- After resolving an ArchiCode flow, verify valid JSON and ensure every edge endpoint, node group/subflow reference, and subflow parent reference points to an existing entity. Dangling references mean the resolution is incomplete.
- For .archicode ledger files (graph-changes.jsonl, graph-changes-archive.jsonl, notes.jsonl), preserve distinct valid events from both sides and ensure every non-empty line is one complete JSON object. Notes are append-only upsert/delete events keyed by eventId; never discard a note tombstone or choose a whole-file side.

## Verification
After resolving all conflicts, run verification commands:
${typedInput.verificationCommands?.map((cmd) => `- ${cmd}`).join("\n") ?? "Call detect_tech_stack. If it returns configuredVerificationCommands, run those (commands marked required must pass); otherwise run its suggestedCommands (typecheck, lint, test)."}

## Final Comprehensive Check
Before completing, confirm that all assigned conflicts are resolved and report the relevant syntax, test, lint, or typecheck evidence that is available for this project. If any coverage remains incomplete, say so precisely.

## Return Format
Return a JSON object with this exact structure:
{
  "resolvedFiles": ["file1.ts", "file2.py", ...],
  "verificationPassed": true/false,
  "verificationOutput": "Output from verification commands",
  "summary": "Brief summary of what was resolved",
  "finalCheck": {
    "syntaxValid": true/false,
    "testsPassed": true/false,
    "lintPassed": true/false,
    "typecheckPassed": true/false,
    "issues": ["issue1", "issue2", ...]
  }
}

Remember: The graph is the source of truth. Your job is to resolve conflicts so the codebase is consistent. After you complete, a graph reconciliation agent will ensure the graph stays synchronized with the resolved code.`;
}

function buildMergeResolutionUserMessage(input: unknown, context: MicroRunContext): string {
  const typedInput = input as MergeResolutionInput;
  return `Resolve the merge conflicts in these files: ${typedInput.conflictedFiles.join(", ")}

${typedInput.resolutionStrategy ? `Preferred resolution strategy: ${typedInput.resolutionStrategy}` : ""}

Choose the evidence and tools needed to understand the conflicts, resolve them safely, and verify the result.`;
}

function parseMergeResolutionOutput(text: string): MergeResolutionOutput {
  // Try to extract JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = mergeResolutionOutputSchema.safeParse(JSON.parse(jsonMatch[0]));
      if (parsed.success) return parsed.data;
    } catch {
      // Fall through to default
    }
  }

  return {
    resolvedFiles: [],
    verificationPassed: false,
    verificationOutput: "",
    summary: "Failed to parse merge resolution output.",
    finalCheck: {
      syntaxValid: false,
      testsPassed: false,
      lintPassed: false,
      typecheckPassed: false,
      issues: ["Failed to parse output"]
    }
  };
}

async function validateMergeResolutionOutput(
  output: unknown,
  _toolCalls: MicroRunToolInvocation[],
  input: unknown,
  context?: MicroRunContext
): Promise<string | undefined> {
  const task = mergeResolutionInputSchema.parse(input);
  const parsed = mergeResolutionOutputSchema.safeParse(output);
  if (!parsed.success || parsed.data.summary === "Failed to parse merge resolution output.") {
    return "Solomon completed without a valid structured merge-resolution report.";
  }
  const report = parsed.data;
  const missingReportedFiles = task.conflictedFiles.filter((file) => !report.resolvedFiles.includes(file));
  if (missingReportedFiles.length) {
    return `Solomon's report omitted assigned conflicted files: ${missingReportedFiles.join(", ")}`;
  }
  if (!context) return undefined;

  const remainingConflicts = await getConflictedFiles(context.projectRoot);
  const assignedStillConflicted = task.conflictedFiles.filter((file) => remainingConflicts.includes(file));
  if (assignedStillConflicted.length) {
    return `Solomon completed while conflicts remained in: ${assignedStillConflicted.join(", ")}`;
  }

  // The host verifies the outcome boundary (assigned files are no longer
  // conflicted) instead of prescribing Solomon's internal tool order. A
  // truthful verification failure remains useful output for the parent to
  // handle; it is not converted into a blind repair loop.
  return undefined;
}

function repairMessage(_input: unknown, outputText: string, validationError: string): string {
  return [
    "Your previous response did not satisfy Solomon's verified merge-resolution contract.",
    `Validation error: ${validationError}`,
    "Inspect the current conflict state, complete any missing read/write/status/verification steps with the available tools, and then return exactly the required merge-resolution JSON report. Do not claim verification passed unless the repository state and checks support it.",
    outputText.trim() ? `Previous response for repair context:\n${outputText.slice(0, 4_000)}` : ""
  ].filter(Boolean).join("\n\n");
}

export const mergeResolutionAgent: MicroRunAgent = {
  kind: "merge-resolution",
  systemPrompt: buildMergeResolutionSystemPrompt,
  userMessage: buildMergeResolutionUserMessage,
  tools: createMergeResolutionTools,
  timeoutMs: MERGE_RESOLUTION_TIMEOUT_MS,
  parseOutput: parseMergeResolutionOutput,
  validateOutput: validateMergeResolutionOutput,
  repairMessage
};
