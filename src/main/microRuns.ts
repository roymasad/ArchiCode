import { exec, execFile } from "child_process";
import path from "node:path";
import { promisify } from "util";
import type { ProviderMcpTool } from "./mcp";
import { availableProviderModelOverride, callProvider, callResearchProvider, resolvePhaseModelPolicy, type ResearchProviderOptions } from "./providers";
import { defaultSubagentModelPolicies, type LlmUsage, type MicroRunKind, type MicroRunStatus, type ProjectBundle, type ProjectSettings, type SubagentModelProfile } from "../shared/schema";
import { redactSensitiveText } from "../shared/redaction";
import { providerImageInputSupportStatus, type ProviderImageInputSupportStatus } from "../shared/providerCapabilities";
import { mergeReasoningReplayStates } from "../shared/llmPricing";
import { isTimeoutFailureMessage, type AgentFailureKind } from "../shared/failureSemantics";
import type { DelphiObservationArtifact } from "./testing/evidenceArtifacts";

const execAsync = promisify(exec);
// execFile (not exec) so the commit message is passed as a real argument,
// never interpolated into a shell string — avoids shell-metacharacter injection
// from an LLM-authored commit message.
const execFileAsync = promisify(execFile);

export function visualAnalysisUnavailable(text: string): boolean {
  const value = text.trim();
  return /\bno (?:capture(?: image)?|image|screenshot) (?:is )?available\b/i.test(value)
    || /\b(?:cannot|can't|could not|unable to) (?:access|view|inspect|analy[sz]e|load) (?:the )?(?:image|capture|screenshot|pixels?)\b/i.test(value)
    || /\b(?:image|capture|screenshot|pixels?)\b.{0,80}\b(?:unavailable|not available|not provided|not attached|not accessible|failed to load)\b/i.test(value);
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
  failureKind?: AgentFailureKind;
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
    toolRejections?: Array<{ providerToolName: string; argumentsJson: string; error?: string }>;
    visuallyAnalyzedArtifactIds?: string[];
  };
  createdAt: string;
  completedAt?: string;
};

export type DelphiObservationAnalysisEvent = {
  artifact: DelphiObservationArtifact;
  status: "started" | "completed" | "failed";
  analysis?: string;
  error?: string;
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
  /** Serialized host result/error so evidence-first agents can assemble their
   * final report from what actually ran instead of trusting model retyping. */
  resultJson?: string;
  error?: string;
  /** True only after a guarded command/adapter crossed its execution boundary. */
  executionStarted?: boolean;
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
  /** Build contract feedback that is returned inside the same live trajectory. */
  repairMessage?: (
    input: unknown,
    outputText: string,
    validationError: string,
    context: MicroRunContext,
    toolCalls: MicroRunToolInvocation[]
  ) => string;
  /** Preserve host-observed tool evidence if the provider dies before its final answer. */
  preservePartialOutputOnFailure?: boolean;
};

export type MicroRunContext = {
  projectRoot: string;
  bundle: ProjectBundle;
  provider: Provider;
  onClarification?: MicroRunClarificationHandler;
  onProgress?: (message: string) => void;
  onArtifact?: (artifact: DelphiObservationArtifact) => void;
  runConsoleCommand?: (args: Record<string, unknown>) => Promise<unknown>;
  imageInputSupport?: ProviderImageInputSupportStatus;
  analyzeObservation?: (input: { artifact: DelphiObservationArtifact; question: string }) => Promise<{ status: "analyzed"; analysis: string }>;
  signal?: AbortSignal;
};

const microRunRegistry = new Map<MicroRunKind, MicroRunAgent>();

const microRunSubagentProfiles: Partial<Record<MicroRunKind, SubagentModelProfile>> = {
  "graph-reconciliation": "picasso",
  "sherlock-research": "sherlock",
  "merge-resolution": "solomon",
  "delphi-testing": "delphi"
};

export function resolveMicroRunProvider(provider: Provider, kind: MicroRunKind): Provider {
  const profile = microRunSubagentProfiles[kind];
  if (!profile) return provider;
  const configuredPolicy = {
    ...defaultSubagentModelPolicies[profile],
    ...(provider.subagentModelPolicies?.[profile] ?? {})
  };
  return {
    ...provider,
    phaseModelPolicies: {
      ...provider.phaseModelPolicies,
      brainstorming: {
        ...configuredPolicy,
        modelOverride: availableProviderModelOverride(provider, configuredPolicy.modelOverride)
      }
    }
  };
}

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
    reasoningReplayState: mergeReasoningReplayStates([current.reasoningReplayState, next.reasoningReplayState]),
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
  const visuallyAnalyzedArtifactIds = toolInvocations.flatMap((call) => {
    if (call.providerToolName !== "delphi_analyze_observation" || call.succeeded === false) return [];
    try {
      const args = JSON.parse(call.argumentsJson || "{}") as { artifactId?: unknown };
      return typeof args.artifactId === "string" && args.artifactId.trim() ? [args.artifactId.trim()] : [];
    } catch {
      return [];
    }
  });
  const toolRejections = toolInvocations.filter((call) => call.succeeded === false).slice(-8).map((call) => {
    const redactedArguments = redactSensitiveText(call.argumentsJson || "{}").text;
    const redactedError = call.error ? redactSensitiveText(call.error).text : undefined;
    return {
      providerToolName: call.providerToolName,
      argumentsJson: redactedArguments.slice(0, 4_000),
      error: redactedError?.slice(0, 2_000)
    };
  });
  return {
    responsePreview: redacted.text.slice(0, maxChars),
    responseRedacted: redacted.redacted || undefined,
    responseTruncated: redacted.text.length > maxChars || undefined,
    repairAttempted: repairAttempted || undefined,
    validationErrors: validationErrors.length ? validationErrors : undefined,
    toolCallNames: Array.from(new Set(toolInvocations.map((call) => call.providerToolName))),
    toolRejections: toolRejections.length ? toolRejections : undefined,
    visuallyAnalyzedArtifactIds: Array.from(new Set(visuallyAnalyzedArtifactIds))
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
    onArtifact?: (artifact: DelphiObservationArtifact) => void;
    onObservationAnalysis?: (event: DelphiObservationAnalysisEvent) => void | Promise<void>;
    runConsoleCommand?: (args: Record<string, unknown>) => Promise<unknown>;
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
  const microRunProvider = resolveMicroRunProvider(provider, kind);
  const microRunId = generateMicroRunId();
  let capturedUsage: LlmUsage | undefined;
  const modelPolicy = resolvePhaseModelPolicy(microRunProvider, "brainstorming");
  const imageInputSupport = providerImageInputSupportStatus(microRunProvider, modelPolicy.modelOverride).status;
  const runAbortController = new AbortController();
  const parentSignal = options?.signal;
  const abortFromParent = (): void => runAbortController.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const runSignal = runAbortController.signal;

  const unresolvedClarifications: string[] = [];
  const onClarification: MicroRunClarificationHandler = options?.onClarification
    ?? (async (question) => {
      unresolvedClarifications.push(question);
      return "No user is available to answer this right now. Proceed with your best judgment and note the open question in your final report.";
    });

  const context: MicroRunContext = {
    projectRoot,
    bundle,
    provider: microRunProvider,
    onClarification,
    onProgress: options?.onProgress,
    onArtifact: options?.onArtifact,
    runConsoleCommand: options?.runConsoleCommand,
    imageInputSupport,
    analyzeObservation: imageInputSupport === "supported" ? async ({ artifact, question }) => {
      const absolutePath = path.resolve(projectRoot, artifact.path);
      const relative = path.relative(path.resolve(projectRoot), absolutePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Delphi observation analysis is limited to evidence inside the current project.");
      const publishAnalysisEvent = async (event: DelphiObservationAnalysisEvent): Promise<void> => {
        try {
          await options?.onObservationAnalysis?.(event);
        } catch (error) {
          // Observation persistence/telemetry must never turn a successful
          // vision call into a false model-analysis failure.
          console.warn(`[delphi-testing] Could not publish observation-analysis state: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      options?.onProgress?.(`Sending ${artifact.label} for model visual inspection`);
      await publishAnalysisEvent({ artifact, status: "started" });
      try {
        const analysis = await callProvider(microRunProvider, [
          "Analyze the attached Delphi runtime observation as visual QA evidence.",
          `Artifact label: ${artifact.label}.`,
          `Question: ${question}`,
          "Report only what is visibly supported by the pixels. Separate visible facts from uncertainty. Note clipping, overlap, unreadable text, broken layout, incorrect screen state, or clear accessibility contrast issues when present. Do not infer behavior that is not visible. Return concise plain text."
        ].join("\n"), "Analyze one bounded Delphi screenshot", {
          phase: "brainstorming",
          bareExtraction: true,
          signal: runSignal,
          cacheSessionId: `${microRunId}:vision`,
          imageAttachments: [{
            title: artifact.label,
            path: absolutePath,
            mediaType: artifact.mediaType,
            source: "context",
            sourceLabel: "Delphi runtime observation"
          }],
          onUsage: (usage) => {
            capturedUsage = mergeUsage(capturedUsage, usage);
          }
        });
        const visualEvidence = analysis.trim();
        if (!visualEvidence) throw new Error("The selected model returned no visual analysis for this observation.");
        if (visualAnalysisUnavailable(visualEvidence)) {
          throw new Error(`The selected model did not receive usable screenshot pixels: ${visualEvidence.slice(0, 500)}`);
        }
        options?.onProgress?.(`Model inspected ${artifact.label}`);
        await publishAnalysisEvent({ artifact, status: "completed", analysis: visualEvidence });
        return { status: "analyzed", analysis: visualEvidence };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options?.onProgress?.(`Model visual inspection failed for ${artifact.label}: ${message}`);
        await publishAnalysisEvent({ artifact, status: "failed", error: message });
        throw error;
      }
    } : undefined,
    signal: runSignal
  };

  const tools = agent.tools(context, input);
  const systemPrompt = [
    agent.systemPrompt(input, context),
    "AUTONOMOUS SUBAGENT CONTRACT: Own the tactics and iteration for this objective. Use the available tools and collected evidence as you judge appropriate, continue until the output contract is satisfied or a concrete blocker remains, and never claim an action or observation that the host did not confirm. If the host rejects a final answer against the output contract, use that feedback in this same trajectory and choose the corrective action yourself."
  ].join("\n\n");
  const userMessage = agent.userMessage(input, context);

  const result: MicroRunResult = {
    id: microRunId,
    kind,
    status: "running",
    createdAt: new Date().toISOString()
  };

  let outputText = "";
  let repairAttempted = false;
  const validationErrors: string[] = [];
  const toolInvocations: MicroRunToolInvocation[] = [];
  let parsedOutput: unknown;

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

    // These tools are explicit output sinks, not prescribed tactics. A
    // successful sink can finish immediately once the same output contract
    // validator accepts the captured arguments.
    const isFinalProposalTool = (providerToolName: string): boolean =>
      providerToolName === "propose_graph_change_set" || providerToolName === "picasso_propose_graph_change_set";
    const successfulTerminalToolCalls = new Set<string>();

  const providerOptions: ResearchProviderOptions = {
    projectRoot,
    webSearchEnabled: agent.webSearchEnabled?.(input, context) ?? false,
    signal: runSignal,
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
    onTransientRetry: () => {
      options?.onProgress?.("Transient provider interruption; retrying the current turn without restarting the subagent.");
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
          const serializedResult = JSON.stringify(handlerResult);
          const executionStarted = [
            "archicode_console_run_command",
            "delphi_run_playwright_flow",
            "delphi_run_appium_flow",
            "delphi_run_mobile_target_flow"
          ].includes(toolInput.providerToolName);
          // Handlers may normalize a permissive provider payload in-place.
          // Persist the accepted form so parsers assemble exactly what passed
          // the tool boundary, not the model's pre-validation arguments.
          toolInvocations.push({
            providerToolName: toolInput.providerToolName,
            argumentsJson: JSON.stringify(args),
            succeeded: true,
            resultJson: serializedResult,
            executionStarted
          });
          if (isFinalProposalTool(toolInput.providerToolName)) successfulTerminalToolCalls.add(toolInput.providerToolName);
          return serializedResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const partialResult = error && typeof error === "object" && "partialResult" in error
            ? (error as { partialResult?: unknown }).partialResult
            : undefined;
          let partialResultJson: string | undefined;
          try {
            if (partialResult !== undefined) partialResultJson = JSON.stringify(partialResult);
          } catch {
            // A tool error must still be reported even if its advisory partial
            // result is not serializable.
          }
          toolInvocations.push({
            providerToolName: toolInput.providerToolName,
            argumentsJson: toolInput.argumentsJson,
            succeeded: false,
            resultJson: partialResultJson,
            error: message,
            executionStarted: Boolean(error && typeof error === "object" && "executionStarted" in error && (error as { executionStarted?: unknown }).executionStarted)
          });
          return `Tool error: ${message}${partialResultJson ? `\nPartial result: ${partialResultJson}` : ""}`;
        }
      },
      isTerminalTool: (providerToolName) => isFinalProposalTool(providerToolName) && successfulTerminalToolCalls.has(providerToolName),
      terminalToolCompletesTurn: (providerToolName) => isFinalProposalTool(providerToolName) && successfulTerminalToolCalls.has(providerToolName),
      validateFinalAnswer: async (candidateText) => {
        outputText = candidateText;
        let candidateOutput: unknown;
        let validationError: string | undefined;
        try {
          candidateOutput = agent.parseOutput(candidateText, toolInvocations);
        } catch (error) {
          validationError = `The subagent response did not match its output schema: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (!validationError) {
          validationError = await agent.validateOutput?.(candidateOutput, toolInvocations, input, context);
        }
        if (!validationError) {
          parsedOutput = candidateOutput;
          return undefined;
        }
        repairAttempted = true;
        validationErrors.push(validationError);
        options?.onProgress?.("The subagent's final answer missed its contract; returning the exact validation result to the same trajectory.");
        return agent.repairMessage?.(input, candidateText, validationError, context, toolInvocations) ?? [
          "Your final answer did not satisfy the subagent output contract.",
          `Validation error: ${validationError}`,
          "Continue this same task from the evidence and completed tool actions already in context. Choose the corrective action yourself, then return a corrected final answer. Do not repeat accepted work."
        ].join("\n\n");
      },
      // Transport retry belongs to the shared runtime and preserves this live
      // provider transcript; it never restarts the subagent from its user prompt.
    };

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        runAbortController.abort(new Error(`Micro-run timed out after ${agent.timeoutMs}ms`));
        reject(new Error(`Micro-run timed out after ${agent.timeoutMs}ms`));
      }, agent.timeoutMs);
    });

    try {
      outputText = await Promise.race([callResearchProvider(microRunProvider, userMessage, providerOptions), timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    // validateFinalAnswer runs inside the provider-independent loop and stores
    // the accepted parsed value. This fallback covers transports with no tools.
    if (parsedOutput === undefined) {
      parsedOutput = agent.parseOutput(outputText, toolInvocations);
      const validationError = await agent.validateOutput?.(parsedOutput, toolInvocations, input, context);
      if (validationError) {
        validationErrors.push(validationError);
        throw new Error(validationError);
      }
    }

    result.diagnostics = responseDiagnostics(outputText, toolInvocations, repairAttempted, validationErrors);
    result.status = unresolvedClarifications.length > 0 ? "needs-clarification" : "completed";
    result.output = parsedOutput;
    if (unresolvedClarifications.length > 0) {
      result.clarificationQuestion = unresolvedClarifications.join("\n\n");
    }
    result.usage = capturedUsage;
    result.completedAt = new Date().toISOString();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const timedOut = isTimeoutFailureMessage(errorMessage);

    if (agent.preservePartialOutputOnFailure && toolInvocations.some((call) => call.executionStarted)) {
      try {
        result.output = agent.parseOutput(outputText, toolInvocations);
      } catch {
        // The terminal provider error remains authoritative. Partial output is
        // best-effort and must never hide or replace that failure.
      }
    }

    result.failureKind = timedOut ? "timeout" : "error";
    if (/Micro-run timed out after/i.test(errorMessage)) {
      result.status = "failed";
      result.error = `Micro-run timed out after ${agent.timeoutMs}ms. The agent was working on a complex task.`;
    } else {
      result.status = "failed";
      result.error = errorMessage;
    }
    result.usage = capturedUsage;
    result.diagnostics ??= responseDiagnostics(outputText, toolInvocations, repairAttempted, validationErrors);
    result.completedAt = new Date().toISOString();
  }

  parentSignal?.removeEventListener("abort", abortFromParent);
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
