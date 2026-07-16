import { exec, execFile } from "child_process";
import { promisify } from "util";
import type { ProviderMcpTool } from "./mcp";
import { callResearchProvider, type ResearchProviderOptions } from "./providers";
import type { ProjectBundle, ProjectSettings, LlmUsage } from "@shared/schema";
import { MicroRunKind, MicroRunStatus } from "@shared/schema";
import { redactSensitiveText } from "../shared/redaction";

const execAsync = promisify(exec);
// execFile (not exec) so the commit message is passed as a real argument,
// never interpolated into a shell string — avoids shell-metacharacter injection
// from an LLM-authored commit message.
const execFileAsync = promisify(execFile);

// Transport-level blips (not deterministic model/tool failures) that are worth
// one retry: undici socket drops, header/body timeouts, and aborts.
const TRANSIENT_MICRO_RUN_PATTERNS = [
  "terminated", "fetch failed", "socket hang up", "headers timeout", "body timeout",
  "econnreset", "etimedout", "eai_again", "enotfound", "econnrefused", "network timeout",
  "aborted", "und_err"
];

function isTransientMicroRunFailure(message: string): boolean {
  const text = message.toLowerCase();
  // A micro-run timeout is our own deadline, not a transport blip: do not retry it.
  if (text.includes("timed out after")) return false;
  return TRANSIENT_MICRO_RUN_PATTERNS.some((pattern) => text.includes(pattern));
}

type Provider = ProjectSettings["providers"][number];

export type MicroRunTool = ProviderMcpTool & {
  handler: (...args: any[]) => Promise<unknown>;
};

export type MicroRunResult = {
  id: string;
  kind: MicroRunKind;
  status: MicroRunStatus;
  output?: unknown;
  error?: string;
  clarificationQuestion?: string;
  // Aggregated LLM usage/cost for this subagent's own multi-turn session.
  usage?: LlmUsage;
  diagnostics?: {
    responsePreview?: string;
    responseRedacted?: boolean;
    responseTruncated?: boolean;
    repairAttempted?: boolean;
    validationErrors?: string[];
    toolCallNames?: string[];
  };
  createdAt: string;
  completedAt?: string;
};

export type MicroRunClarificationHandler = (question: string) => Promise<string>;

// One tool call the agent made during the run, surfaced to parseOutput so an
// agent can recover structured output (e.g. a proposed change set) directly
// from a tool call's arguments instead of relying on the model re-emitting it
// as final JSON text (which is lost if the model ends early or transport drops).
export type MicroRunToolInvocation = {
  providerToolName: string;
  argumentsJson: string;
  /** False when the tool handler rejected this invocation. Rejected sink
   * payloads remain diagnostic evidence but must never be assembled as output. */
  succeeded?: boolean;
};

export type MicroRunAgent = {
  kind: MicroRunKind;
  systemPrompt: (input: unknown, context: MicroRunContext) => string;
  userMessage: (input: unknown, context: MicroRunContext) => string;
  tools: (context: MicroRunContext, input: unknown) => MicroRunTool[];
  webSearchEnabled?: (input: unknown, context: MicroRunContext) => boolean;
  timeoutMs: number;
  parseOutput: (text: string, toolCalls?: MicroRunToolInvocation[]) => unknown;
  /** Return an error when a syntactically valid final answer did not satisfy the agent's evidence contract. */
  validateOutput?: (
    output: unknown,
    toolCalls: MicroRunToolInvocation[],
    input: unknown,
    context?: MicroRunContext
  ) => string | undefined | Promise<string | undefined>;
  /** One bounded semantic repair attempt after a syntactically successful but contract-invalid response. */
  repairMessage?: (
    input: unknown,
    outputText: string,
    validationError: string,
    context: MicroRunContext,
    toolCalls: MicroRunToolInvocation[]
  ) => string;
};

export type MicroRunContext = {
  projectRoot: string;
  bundle: ProjectBundle;
  provider: Provider;
  onClarification?: MicroRunClarificationHandler;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
};

const microRunRegistry = new Map<MicroRunKind, MicroRunAgent>();

export function registerMicroRunAgent(agent: MicroRunAgent): void {
  microRunRegistry.set(agent.kind, agent);
}

export function getMicroRunAgent(kind: MicroRunKind): MicroRunAgent | undefined {
  return microRunRegistry.get(kind);
}

function mergeUsage(current: LlmUsage | undefined, next: LlmUsage): LlmUsage {
  if (!current) return next;
  return {
    ...next,
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    thinkingTokens: (current.thinkingTokens ?? 0) + (next.thinkingTokens ?? 0) || undefined,
    cacheReadTokens: (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0) || undefined,
    cacheCreationTokens: (current.cacheCreationTokens ?? 0) + (next.cacheCreationTokens ?? 0) || undefined,
    calls: current.calls + next.calls,
    costUsd: current.costUsd !== undefined || next.costUsd !== undefined
      ? (current.costUsd ?? 0) + (next.costUsd ?? 0)
      : undefined,
    estimated: current.estimated || next.estimated || undefined,
    unavailable: current.unavailable || next.unavailable || undefined
  };
}

function responseDiagnostics(
  outputText: string,
  toolInvocations: MicroRunToolInvocation[],
  repairAttempted: boolean,
  validationErrors: string[]
): NonNullable<MicroRunResult["diagnostics"]> {
  const redacted = redactSensitiveText(outputText);
  const maxChars = 4_000;
  return {
    responsePreview: redacted.text.slice(0, maxChars),
    responseRedacted: redacted.redacted || undefined,
    responseTruncated: redacted.text.length > maxChars || undefined,
    repairAttempted: repairAttempted || undefined,
    validationErrors: validationErrors.length ? validationErrors : undefined,
    toolCallNames: Array.from(new Set(toolInvocations.map((call) => call.providerToolName)))
  };
}

export async function executeMicroRun(
  projectRoot: string,
  kind: MicroRunKind,
  input: unknown,
  provider: Provider,
  bundle: ProjectBundle,
  options?: {
    onClarification?: MicroRunClarificationHandler;
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
  }
): Promise<MicroRunResult> {
  const agent = getMicroRunAgent(kind);
  if (!agent) {
    return {
      id: generateMicroRunId(),
      kind,
      status: "failed",
      error: `No micro-run agent registered for kind: ${kind}`,
      createdAt: new Date().toISOString()
    };
  }

  const unresolvedClarifications: string[] = [];
  const onClarification: MicroRunClarificationHandler = options?.onClarification
    ?? (async (question) => {
      unresolvedClarifications.push(question);
      return "No user is available to answer this right now. Proceed with your best judgment and note the open question in your final report.";
    });

  const context: MicroRunContext = {
    projectRoot,
    bundle,
    provider,
    onClarification,
    onProgress: options?.onProgress,
    signal: options?.signal
  };

  const tools = agent.tools(context, input);
  const systemPrompt = [
    agent.systemPrompt(input, context),
    "LONG-RUN EXECUTION POLICY: Work in bounded, verifiable units instead of holding a large task for one final response. Use the tools incrementally—normally one file, one graph region, one evidence slice, or one coherent batch at a time—and persist each completed unit through the tool intended for it. Keep the final response compact and assemble or summarize the completed units. Do not repeat an identical inspection merely to stay active. If a submit/checkpoint/batch tool is available, use it throughout the run rather than one-shotting the entire payload at the end."
  ].join("\n\n");
  const userMessage = agent.userMessage(input, context);

  const result: MicroRunResult = {
    id: generateMicroRunId(),
    kind,
    status: "running",
    createdAt: new Date().toISOString()
  };

  let capturedUsage: LlmUsage | undefined;

  try {
    const scopeContext = JSON.stringify({
      projectRoot,
      projectId: bundle.project.id,
      projectName: bundle.project.name,
      flows: bundle.flows.map((f) => ({
        id: f.id,
        name: f.name,
        nodeCount: f.nodes.length
      }))
    }, null, 2);

    // Every tool the model invokes, in order, so parseOutput can recover
    // structured output from a tool call's args even if the final text is lost.
    const toolInvocations: MicroRunToolInvocation[] = [];
    const isFinalProposalTool = (providerToolName: string): boolean =>
      providerToolName === "propose_graph_change_set" || providerToolName === "picasso_propose_graph_change_set";
    const successfulTerminalToolCalls = new Set<string>();

  const providerOptions: ResearchProviderOptions = {
    projectRoot,
    webSearchEnabled: agent.webSearchEnabled?.(input, context) ?? false,
    signal: options?.signal,
    scopeContext,
    systemInstructionsOverride: systemPrompt,
    messages: [],
    researchMessageLimit: 20,
    researchHistoryTokenBudget: 8000,
    mcpTools: tools,
    onToken: undefined,
    onUsage: (usage) => {
      capturedUsage = mergeUsage(capturedUsage, usage);
    },
    callMcpTool: async (toolInput: { providerToolName: string; argumentsJson: string }) => {
        const tool = tools.find((t) => t.providerToolName === toolInput.providerToolName) as MicroRunTool | undefined;
        if (!tool) {
          toolInvocations.push({ providerToolName: toolInput.providerToolName, argumentsJson: toolInput.argumentsJson, succeeded: false });
          return `Tool not found: ${toolInput.providerToolName}`;
        }
        try {
          const args = toolInput.argumentsJson ? JSON.parse(toolInput.argumentsJson) : {};
          const handlerResult = await tool.handler(args);
          // Handlers may normalize a permissive provider payload in-place.
          // Persist the accepted form so parsers assemble exactly what passed
          // the tool boundary, not the model's pre-validation arguments.
          toolInvocations.push({
            providerToolName: toolInput.providerToolName,
            argumentsJson: JSON.stringify(args),
            succeeded: true
          });
          if (isFinalProposalTool(toolInput.providerToolName)) {
            successfulTerminalToolCalls.add(toolInput.providerToolName);
          }
          return JSON.stringify(handlerResult);
        } catch (error) {
          toolInvocations.push({ providerToolName: toolInput.providerToolName, argumentsJson: toolInput.argumentsJson, succeeded: false });
          return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
      // A rejected sink call is not terminal. Provider loops evaluate this
      // after the handler returns, so the model receives the concrete tool
      // error and can correct the same final batch in its existing context.
      isTerminalTool: (providerToolName) => isFinalProposalTool(providerToolName) && successfulTerminalToolCalls.has(providerToolName),
      terminalToolCompletesTurn: (providerToolName) => isFinalProposalTool(providerToolName) && successfulTerminalToolCalls.has(providerToolName)
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Micro-run timed out after ${agent.timeoutMs}ms`)), agent.timeoutMs);
    });

    // Long tool-assisted runs can hit a transient transport blip (undici
    // "terminated" / socket hang up / headers timeout) partway through the
    // stream. Retry once on those before giving up, mirroring the transient
    // verification-retry used by build runs.
    const runProvider = async (message: string): Promise<string> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await callResearchProvider(provider, message, providerOptions);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt === 0 && isTransientMicroRunFailure(message)) {
            options?.onProgress?.("Transient network interruption; retrying...");
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
          }
          throw error;
        }
      }
      throw new Error("Micro-run provider retry exhausted.");
    };

    let repairAttempted = false;
    const validationErrors: string[] = [];
    let outputText = await Promise.race([runProvider(userMessage), timeoutPromise]);
    let parsedOutput = agent.parseOutput(outputText, toolInvocations);
    let validationError = await agent.validateOutput?.(parsedOutput, toolInvocations, input, context);
    if (validationError) validationErrors.push(validationError);

    if (validationError && agent.repairMessage) {
      repairAttempted = true;
      options?.onProgress?.("The subagent response missed its completion contract; retrying once with focused repair guidance.");
      const repairMessage = agent.repairMessage(input, outputText, validationError, context, toolInvocations);
      outputText = await Promise.race([runProvider(repairMessage), timeoutPromise]);
      parsedOutput = agent.parseOutput(outputText, toolInvocations);
      validationError = await agent.validateOutput?.(parsedOutput, toolInvocations, input, context);
      if (validationError) validationErrors.push(validationError);
    }

    result.diagnostics = responseDiagnostics(outputText, toolInvocations, repairAttempted, validationErrors);
    if (validationError) {
      result.status = "failed";
      result.output = parsedOutput;
      result.error = validationError;
      result.usage = capturedUsage;
      result.completedAt = new Date().toISOString();
      return result;
    }

    result.status = unresolvedClarifications.length > 0 ? "needs-clarification" : "completed";
    result.output = parsedOutput;
    if (unresolvedClarifications.length > 0) {
      result.clarificationQuestion = unresolvedClarifications.join("\n\n");
    }
    result.usage = capturedUsage;
    result.completedAt = new Date().toISOString();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes("timed out")) {
      result.status = "failed";
      result.error = `Micro-run timed out after ${agent.timeoutMs}ms. The agent was working on a complex task.`;
    } else {
      result.status = "failed";
      result.error = errorMessage;
    }
    result.usage = capturedUsage;
    result.diagnostics ??= responseDiagnostics("", [], false, []);
    result.completedAt = new Date().toISOString();
  }

  return result;
}

function generateMicroRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `micro-${timestamp}-${random}`;
}

// Utility: Run git commands
export async function runGitCommand(projectRoot: string, args: string[], options?: { timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = options?.timeout ?? 30000;
  try {
    const { stdout, stderr } = await execAsync(`git ${args.join(" ")}`, {
      cwd: projectRoot,
      timeout,
      maxBuffer: 1024 * 1024
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: any) {
    const stdout = error.stdout ?? "";
    const stderr = error.stderr ?? "";
    const exitCode = error.code ?? 1;
    return { stdout, stderr, exitCode };
  }
}

// Utility: Run verification commands
export async function runVerificationCommand(
  projectRoot: string,
  command: string,
  args: string[] = [],
  options?: { timeout?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number; passed: boolean }> {
  const timeout = options?.timeout ?? 600000;
  const fullCommand = `${command} ${args.join(" ")}`.trim();

  try {
    const { stdout, stderr } = await execAsync(fullCommand, {
      cwd: projectRoot,
      timeout,
      maxBuffer: 10 * 1024 * 1024
    });
    return { stdout, stderr, exitCode: 0, passed: true };
  } catch (error: any) {
    const stdout = error.stdout ?? "";
    const stderr = error.stderr ?? "";
    const exitCode = error.code ?? 1;
    return { stdout, stderr, exitCode, passed: false };
  }
}

// Utility: Check if file is in conflicted state
export async function isFileConflicted(projectRoot: string, filePath: string): Promise<boolean> {
  const { stdout } = await runGitCommand(projectRoot, ["status", "--porcelain", filePath]);
  // Conflicted files show as UU, AA, DU, UD in git status --porcelain
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const status = line.slice(0, 2).trim();
    if (["UU", "AA", "DU", "UD", "AU", "UA"].includes(status)) {
      return true;
    }
  }
  return false;
}

// Utility: Get list of conflicted files
export async function getConflictedFiles(projectRoot: string): Promise<string[]> {
  const { stdout } = await runGitCommand(projectRoot, ["diff", "--name-only", "--diff-filter=U"]);
  return stdout.trim().split("\n").filter(Boolean);
}

// Utility: Finish a resolved merge by committing the already-staged resolution.
// Uses execFile (not the shell-string runGitCommand) so the commit message is
// passed as a real argument, never parsed by a shell.
export async function commitStagedResolution(
  projectRoot: string,
  message: string,
  options?: { timeout?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["commit", "-m", message], {
      cwd: projectRoot,
      timeout: options?.timeout ?? 30000,
      maxBuffer: 1024 * 1024
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: any) {
    const stdout = error.stdout ?? "";
    const stderr = error.stderr ?? "";
    const exitCode = error.code ?? 1;
    return { stdout, stderr, exitCode };
  }
}
