import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LlmPhase, McpServer, PhaseModelPolicy } from "../../shared/schema";
import { gaiaAgent, pandoraAgent } from "../../shared/agentIdentities";
import { type Provider, type ProviderCallOptions, type ProviderHealthResult, type ProviderProgressEvent, type ProviderTokenKind, type ResearchProviderOptions, codingSourceHandoffInstructions, emitUnavailableUsage, extractContextWindowFromModels, extractLocalResearchTurn, extractModelIdsFromModels, extractionSystemPrompt, formatLocalResearchTranscript, imageAttachmentText, inferModelCapabilityProfile, localAskModeMcpRequestInstructions, localResearchToolLoopInstructions, localResearchTranscriptFromContinuation, localResearchTurnValidationFeedback, orchestratorSystemPrompt, phasePolicyText, planningPatchJsonContract, planningQuestionGateInstructions, researchSystemInstructions, researchUserPromptText, resolvePhaseModelPolicy, sourceProposalBatchingInstructions, textAttachmentText } from "../providers";
import { attachProviderContinuation } from "./anthropic";
import { runAgentLoop, type AgentToolResult } from "../agentRuntime";

export const requireFromProviders = createRequire(import.meta.url);
export const localCommandCache = new Map<string, { command: string; env: NodeJS.ProcessEnv }>();
export const activeLocalProviderProcesses = new Map<number, ChildProcessWithoutNullStreams>();
export const LOCAL_PROVIDER_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

export function isCodexLocalProvider(provider: Provider): provider is Provider & { kind: "codex-local" } {
  return provider.kind === "codex-local";
}

export function isClaudeLocalProvider(provider: Provider): provider is Provider & { kind: "claude-local" } {
  return provider.kind === "claude-local";
}

export function isOpenCodeLocalProvider(provider: Provider): provider is Provider & { kind: "opencode-local" } {
  return provider.kind === "opencode-local";
}

export function isAntigravityLocalProvider(provider: Provider): provider is Provider & { kind: "antigravity-local" } {
  return provider.kind === "antigravity-local";
}

export function isGrokLocalProvider(provider: Provider): provider is Provider & { kind: "grok-local" } {
  return provider.kind === "grok-local";
}

export function isKimiLocalProvider(provider: Provider): provider is Provider & { kind: "kimi-local" } {
  return provider.kind === "kimi-local";
}

export function localCliCommand(provider: Pick<Provider, "kind" | "localCommand">): string {
  return provider.localCommand?.trim() || (provider.kind === "claude-local"
    ? "claude"
    : provider.kind === "opencode-local"
      ? "opencode"
      : provider.kind === "antigravity-local"
        ? "agy"
        : provider.kind === "grok-local"
          ? "grok"
        : provider.kind === "kimi-local"
          ? "kimi"
        : "codex");
}

export async function callCodexLocal(provider: Provider, contextText: string, promptSummary: string, options: ProviderCallOptions, policy: PhaseModelPolicy): Promise<string> {
  const command = provider.localCommand?.trim() || "codex";
  const outputDir = await mkdtemp(path.join(tmpdir(), "archicode-codex-"));
  const outputPath = path.join(outputDir, "last-message.txt");
  const args = buildCodexLocalArgs(provider, options, outputPath);

  const phase = options.phase ?? "planning";
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  const writeCapable = provider.localSandbox !== "read-only";
  const phaseInstructions = phase === "coding"
    ? [
        `You are ${gaiaAgent.title}, ArchiCode's implementation agent.`,
        "This is the coding phase after an ArchiCode plan artifact has been created.",
        writeCapable
          ? "You may edit files in the project only within the configured sandbox and folder policy."
          : "The configured Codex Local sandbox is read-only, so do not attempt filesystem edits; return source changes as archicodePatch propose-source-file operations that ArchiCode can apply.",
        "If the project folder has no app scaffold and the graph provides stack and acceptance criteria, create the smallest runnable scaffold instead of blocking on missing files.",
        "Use Gaia's AI Implement role as a project-creation or project-update pass depending on the current files; in both cases, align code with the latest graph/node state and durable notes/artifacts.",
        "For a new frontend scaffold, include complete file contents for package.json, index.html, src entry files, routes/views/components, styles, and any minimal config needed by the selected stack.",
        "Use concrete editable placeholder copy when product identity is unspecified; do not ask a question solely for naming, branding, or marketing copy in a starter template.",
        "Implement the smallest useful change from the selected node or diagram context, and add/update tests when the stack already supports them and the task warrants it.",
        "Do not run build, test, lint, or typecheck commands just to prove the handoff; ArchiCode owns finite verification after source changes. Run a finite verification command only when you need its failure output to repair your own change before returning.",
        "Do not run the app, dev server, preview server, simulator, emulator, or watch process. Runtime launch belongs to the Run App button and run profiles.",
        "When adding a new scaffold or runnable module, note missing local browser, desktop, mobile, Docker, or module-specific run targets in the run summary; do not return run-profile operations during coding.",
        writeCapable
          ? "Do not return graph metadata operations, questions, node updates, graph proposals, run profiles, propose-project-file, or source-file proposal JSON during direct-write coding."
          : codingSourceHandoffInstructions,
        writeCapable
          ? "Return a concise summary of files changed, tests run, and any follow-up notes; do not return graph metadata operations during coding."
          : "Return complete propose-source-file operations with path, action, content, nodeId when known, reason, and testIntent; do not summarize code in prose instead of providing file contents.",
        writeCapable ? "" : sourceProposalBatchingInstructions
      ]
    : phase === "debugging"
      ? [
          `You are ${pandoraAgent.title}, ArchiCode's debugging agent.`,
          "This is the debugging phase after a failed coding or verification run.",
          "Prioritize failure logs, recent diffs, changed files, and affected nodes before broad context.",
          "Repair code so the implementation still matches the latest graph/node source of truth, not just the immediate error log.",
          writeCapable
            ? "Make the smallest repair, update tests if needed, and return concise finite verification guidance. Do not launch the app/runtime; use logs and source evidence instead. Do not return graph metadata operations or source-file proposal JSON during direct-write debugging."
            : "The configured Codex Local sandbox is read-only, so return the smallest repair as complete propose-source-file operations instead of attempting filesystem edits.",
          writeCapable ? "" : codingSourceHandoffInstructions,
          writeCapable ? "" : sourceProposalBatchingInstructions
        ]
    : [
        `You are ${gaiaAgent.title}, ArchiCode's implementation agent.`,
        "This is the mandatory planning phase before coding.",
        "Do not edit project files during planning.",
        planningQuestionGateInstructions,
        planningPatchJsonContract,
        "If missing user input or material ambiguity remains, return focused llm-question notes.",
        "If sufficient, produce a concrete user-facing plan with goal, approach, assumptions, implementation steps, verification, and risks. Return graph proposals as archicodePatch JSON when useful."
      ];

  const prompt = options.bareExtraction
    ? [extractionSystemPrompt, "", contextText].join("\n")
    : [
    orchestratorSystemPrompt,
    "",
    "You are being called as ArchiCode's local Codex provider through the user's installed Codex app/CLI.",
    localAskModeMcpRequestInstructions,
    ...phaseInstructions,
    phasePolicyText(phase, policy, profile),
    options.selectedSkillsPrompt?.trim() ? options.selectedSkillsPrompt.trim() : "",
    imageAttachmentText(options.imageAttachments),
    await textAttachmentText(options.textAttachments),
    options.webSearchEnabled
      ? "Web search is enabled for this run. Use it only when current external information is needed, and cite sources in your final response."
      : "Web search is disabled for this run. Use only the provided project context and local knowledge.",
    writeCapable && (phase === "coding" || phase === "debugging")
      ? "Return concise guidance. Do not include archicodePatch JSON unless explicitly asked for non-source metadata in a non-coding phase."
      : "Return concise guidance and, when useful, an archicodePatch JSON object.",
    "",
    `Prompt summary: ${promptSummary}`,
    "",
    "Project JSON context:",
    contextText
  ].join("\n");

  const { stdout, stderr, exitCode } = await runLocalProcess(command, args, prompt, options.projectRoot, options.onProgress, options.signal);
  let finalMessage = "";
  try {
    finalMessage = await readFile(outputPath, "utf8");
  } catch {
    finalMessage = stdout.trim();
  }

  if (exitCode !== 0) {
    throw new Error(`Codex local provider failed with exit code ${exitCode}.\n${stderr || stdout}`);
  }

  emitUnavailableUsage(provider, policy, options.onUsage);
  return finalMessage.trim() || stdout.trim() || "Codex local provider returned no content.";
}

export async function callLocalResearchProvider(
  transport: "codex-local" | "claude-local" | "opencode-local" | "antigravity-local" | "grok-local" | "kimi-local",
  provider: Provider,
  userMessage: string,
  options: ResearchProviderOptions,
  policy: PhaseModelPolicy,
  runTurn: (prompt: string, onToken?: (text: string, kind?: ProviderTokenKind) => void) => Promise<string>
): Promise<string> {
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  const transcript = options.resumeContinuation
    ? localResearchTranscriptFromContinuation(options.resumeContinuation, transport)
    : [];
  const providerLabel = transport === "codex-local"
    ? "Codex"
    : transport === "claude-local"
      ? "Claude"
      : transport === "opencode-local"
        ? "OpenCode"
        : transport === "antigravity-local"
          ? "Antigravity"
          : transport === "grok-local"
            ? "Grok Build"
            : "Kimi Code";
  const askModeNote = (options.mcpTools ?? []).some((tool) => !options.isTerminalTool?.(tool.providerToolName))
    ? "Enabled Ask-mode MCP servers remain visible through the structured tool list. If an Ask-mode tool is requested, ArchiCode will pause for approval and then resume this same turn with the tool result."
    : "";
  const projectFilesNote = options.projectRoot
    ? `Project files and bounded project CLI actions are available through structured tools in this chat. Choose whichever exposed tool best advances the goal. Actions follow the shared risk classifier and the user's approval settings, then resume this trajectory when approval is needed. Parent Chat's sole CLI role restriction is that it must not edit project code files directly; route source implementation through the graph/build path. Use query_code_graph for bounded file/symbol search, dependency neighbors, shortest paths, or reverse impact without loading the full local graph. If the compact project briefing is not enough for exact architecture/run context, request archicode_read_research_context.`
    : "";
  const isolatedSubagent = Boolean(options.systemInstructionsOverride?.trim());

  let finalAnswerRequested = false;
  const toolValidationFailures = new Map<string, number>();
  const transcriptResults = (results: AgentToolResult[]) => results.map(({ toolCall, result }) => ({
    role: "tool" as const,
    toolCallId: toolCall.id,
    providerToolName: toolCall.providerToolName,
    result
  }));

  return runAgentLoop({
    signal: options.signal,
    emptyAnswer: "Provider returned no content.",
    adapter: {
      nextTurn: async () => {
        const prompt = [
          researchSystemInstructions(options),
          "",
          isolatedSubagent
            ? `You are being called as an isolated ArchiCode subagent through the local ${providerLabel} CLI. Follow the subagent system instructions above; do not adopt the parent Research-chat identity or confirmation flow. Still follow the local transport's archicodeResearchTurn envelope when it is required below.`
            : `You are being called for an ArchiCode Research chat through the local ${providerLabel} CLI, not a build run.`,
          isolatedSubagent
            ? "Use only the structured tools and permissions exposed to this isolated run. Do not infer additional restrictions or output wrappers from the parent Research chat."
            : "Do not edit project code files directly. Otherwise use the exposed structured tools and guarded console autonomously for any project-scoped action that advances the goal; normal risk classification and approval settings apply. Route source implementation through ArchiCode's graph/build path. Graph changes must only be returned as pending archicodeResearch changeSet JSON or the structured graph change-set sink tool.",
          isolatedSubagent
            ? ""
            : "When the user asks to edit or update the graph, first inspect the affected nodes, edges, descriptions, acceptance criteria, and nearby responsibilities. If the user explicitly asks to propose, prepare, or show the review card directly and the scope is concrete, treat that request as confirmation and deliver the card in this same turn after inspection. Otherwise, state the coherent change, ask every needed clarification, and ask once whether this is the scope they want prepared for review; do not return the pending changeSet until they affirm. The card's own buttons or auto-approve setting still decide whether it is applied.",
          isolatedSubagent
            ? ""
            : "If the user greets you or asks what you can do, the first sentence must sound clearly like the active persona rather than a generic assistant greeting. Include graph-to-code sync only as one brief capability alongside other capabilities. Do not explain sync options, comparison scopes, or the approval flow unless the user specifically asks about syncing, drift, or external edits.",
          isolatedSubagent
            ? ""
            : "When the user asks you to propose or brainstorm, use normal conversation unless they explicitly ask to prepare/show the review card now. For a concrete graph edit with that direct-card request, inspect the graph and return the pending changeSet in the same turn; otherwise describe and confirm the scope first, then return the card after the user affirms it.",
          projectFilesNote,
          phasePolicyText("brainstorming", policy, profile),
          options.webSearchEnabled
            ? transport === "claude-local"
              ? "Web search is enabled for this chat. Use Claude's built-in web tools only when current external information is needed, and cite sources when web results inform the answer."
              : transport === "opencode-local"
                ? "Web search is enabled for this chat. Use OpenCode's configured web tools only when current external information is needed, and cite sources when web results inform the answer."
                : transport === "antigravity-local"
                  ? "Web search is enabled for this chat. Use Antigravity's built-in web tools only when current external information is needed, and cite sources when web results inform the answer."
                  : transport === "grok-local"
                    ? "Web search is enabled for this chat. Use Grok Build's web tools only when current external information is needed, and cite sources when web results inform the answer."
                    : transport === "kimi-local"
                      ? "Web search is enabled for this chat. Use Kimi Code's built-in web tools only when current external information is needed, and cite sources when web results inform the answer."
                    : "Web search is enabled for this chat. Use Codex web search only when current external information is needed, and cite sources when web results inform the answer."
            : "Web search is disabled by project settings. Use only provided context and local model knowledge.",
          askModeNote,
          transport === "codex-local"
            ? "CODEX LOCAL OUTPUT CONTRACT: Every generation is constrained to one archicodeResearchTurn object. Put the visible response in answer, put requested tools in toolCalls, use an empty array when no tool is needed, and encode each tool call's arguments as a JSON string. Never return prose outside that object."
            : "",
          localResearchToolLoopInstructions(options),
          transcript.length
            ? "Continue the same task from the structured transcript below. Assistant text beside tool calls is progress from this same trajectory; use both it and the returned evidence, then choose the next useful action yourself."
            : "",
          finalAnswerRequested
            ? "The terminal sink action already succeeded. Return the concise visible answer now without another tool call."
            : "",
          transcript.length
            ? ["Structured tool transcript so far:", formatLocalResearchTranscript(transcript)].join("\n")
            : "",
          "",
          await researchUserPromptText(userMessage, options)
        ].filter(Boolean).join("\n");
        const output = await runTurn(prompt, options.onToken);
        const parsedTurn = extractLocalResearchTurn(output);
        return {
          text: parsedTurn ? parsedTurn.answer ?? "" : output,
          toolCalls: parsedTurn?.toolCalls ?? [],
          raw: { output, parsedTurn }
        };
      },
      commitToolResults: (turn, results) => {
        const parsedTurn = turn.raw.parsedTurn;
        if (!parsedTurn) return;
        transcript.push({
          role: "assistant",
          answer: parsedTurn.answer,
          toolCalls: parsedTurn.toolCalls
        }, ...transcriptResults(results));
      },
      commitInvalidAnswer: (turn, feedback) => {
        transcript.push({
          role: "assistant",
          answer: turn.text,
          toolCalls: []
        }, {
          role: "feedback",
          content: feedback
        });
      },
      commitFeedback: (feedback) => {
        transcript.push({ role: "feedback", content: feedback });
      },
      attachApprovalContinuation: ({ turn, completedResults, pendingToolCall, error }) => {
        const parsedTurn = turn.raw.parsedTurn;
        const continuationTranscript = parsedTurn
          ? [...transcript, {
              role: "assistant" as const,
              answer: parsedTurn.answer,
              toolCalls: parsedTurn.toolCalls
            }, ...transcriptResults(completedResults)]
          : [...transcript];
        attachProviderContinuation(error, {
          transport,
          messages: continuationTranscript,
          pendingToolCall
        });
      },
      requestFinalAnswer: () => { finalAnswerRequested = true; },
      onLaterRound: () => options.onTokenReset?.()
    },
    executeTool: options.callMcpTool
      ? async (toolCall) => {
          try {
            const result = await options.callMcpTool!({
              providerToolName: toolCall.providerToolName,
              argumentsJson: toolCall.argumentsJson
            });
            toolValidationFailures.delete(toolCall.providerToolName);
            return result;
          } catch (error) {
            if (options.isApprovalError?.(error)) throw error;
            const failures = (toolValidationFailures.get(toolCall.providerToolName) ?? 0) + 1;
            toolValidationFailures.set(toolCall.providerToolName, failures);
            if (failures > 2) throw error;
            const message = error instanceof Error ? error.message : String(error);
            return JSON.stringify({
              ok: false,
              error: "tool_call_failed",
              message,
              repair: "Use the error message and the tool's argumentsSchema to correct the call. Include required fields, valid enum values, correct nested shapes, and no undeclared fields when additionalProperties is false. If the failure is not repairable, explain the concrete blocker instead of repeating the call.",
              attemptsRemaining: 2 - failures
            });
          }
        }
      : undefined,
    isApprovalError: options.isApprovalError,
    onTransientRetry: options.onTransientRetry,
    onTurnDiagnostics: options.onTurnDiagnostics,
    isTerminalTool: options.isTerminalTool,
    terminalToolCompletesTurn: options.terminalToolCompletesTurn,
    validateFinalAnswer: async (answer) => {
      const transportFeedback = localResearchTurnValidationFeedback(answer);
      if (transportFeedback) return transportFeedback;
      return options.validateFinalAnswer?.(answer);
    }
  });
}

export async function callCodexLocalResearch(provider: Provider, userMessage: string, options: ResearchProviderOptions, policy: PhaseModelPolicy): Promise<string> {
  const result = await callLocalResearchProvider(
    "codex-local",
    provider,
    userMessage,
    options,
    policy,
    async (prompt, onToken) => {
      const command = provider.localCommand?.trim() || "codex";
      const outputDir = await mkdtemp(path.join(tmpdir(), "archicode-research-codex-"));
      const outputPath = path.join(outputDir, "last-message.txt");
      const outputSchemaPath = path.join(outputDir, "research-turn.schema.json");
      await writeFile(outputSchemaPath, JSON.stringify(codexLocalResearchOutputSchema, null, 2), "utf8");
      const projectFileServers = options.projectRoot ? [await createCodexProjectFilesMcpServer(options.projectRoot, outputDir)] : [];
      const args = buildCodexLocalResearchArgs(provider, {
        ...options,
        mcpServers: projectFileServers
      }, outputPath, outputSchemaPath);
      const streamCodexToken = createCodexLocalTokenStreamer(onToken);
      const { stdout, stderr, exitCode } = await runLocalProcess(command, args, prompt, options.projectRoot, onToken
        ? (event) => {
            if (event.stream === "stdout") streamCodexToken(event.text);
          }
        : undefined, options.signal);
      let outputFileMessage = "";
      try {
        outputFileMessage = await readFile(outputPath, "utf8");
      } catch {
        // Some Codex CLI versions leave --output-last-message empty after an
        // intermediate agent_message item. Recover the last non-empty message
        // from the JSONL stream before treating stdout as plain text.
      }
      if (exitCode !== 0) {
        throw new Error(`Codex local research provider failed with exit code ${exitCode}.\n${stderr || stdout}`);
      }
      return codexLocalFinalMessage(outputFileMessage, stdout) || "Codex local research provider returned no content.";
    }
  );
  emitUnavailableUsage(provider, policy, options.onUsage);
  return result;
}

export type ClaudeMcpConfigBuild = {
  config: { mcpServers: Record<string, Record<string, unknown>> };
  allowedToolPatterns: string[];
};

export async function callClaudeLocal(provider: Provider, contextText: string, promptSummary: string, options: ProviderCallOptions, policy: PhaseModelPolicy): Promise<string> {
  const command = localCliCommand(provider);
  const outputDir = await mkdtemp(path.join(tmpdir(), "archicode-claude-"));
  const mcpConfig = claudeMcpConfig(options.mcpServers);
  const mcpConfigPath = await writeClaudeMcpConfig(outputDir, mcpConfig);
  const args = buildClaudeLocalArgs(provider, options, {
    mcpConfigPath,
    allowedToolPatterns: mcpConfig.allowedToolPatterns
  });

  const phase = options.phase ?? "planning";
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  const writeCapable = provider.localSandbox !== "read-only";
  const phaseInstructions = phase === "coding"
    ? [
        `You are ${gaiaAgent.title}, ArchiCode's implementation agent.`,
        "This is the coding phase after an ArchiCode plan artifact has been created.",
        writeCapable
          ? "You may edit files in the project only within the configured local provider access mode and ArchiCode-mounted tools."
          : "The configured Claude Code access mode is read-only here, so do not attempt filesystem edits; return source changes as archicodePatch propose-source-file operations that ArchiCode can apply.",
        "If the project folder has no app scaffold and the graph provides stack and acceptance criteria, create the smallest runnable scaffold instead of blocking on missing files.",
        "Use Gaia's AI Implement role as a project-creation or project-update pass depending on the current files; in both cases, align code with the latest graph/node state and durable notes/artifacts.",
        "For a new frontend scaffold, include complete file contents for package.json, index.html, src entry files, routes/views/components, styles, and any minimal config needed by the selected stack.",
        "Use concrete editable placeholder copy when product identity is unspecified; do not ask a question solely for naming, branding, or marketing copy in a starter template.",
        "Implement the smallest useful change from the selected node or diagram context, and add/update tests when the stack already supports them and the task warrants it.",
        "Do not run build, test, lint, or typecheck commands just to prove the handoff; ArchiCode owns finite verification after source changes. Run a finite verification command only when you need its failure output to repair your own change before returning.",
        "Do not run the app, dev server, preview server, simulator, emulator, or watch process. Runtime launch belongs to the Run App button and run profiles.",
        "When adding a new scaffold or runnable module, note missing local browser, desktop, mobile, Docker, or module-specific run targets in the run summary; do not return run-profile operations during coding.",
        writeCapable
          ? "Do not return graph metadata operations, questions, node updates, graph proposals, run profiles, propose-project-file, or source-file proposal JSON during direct-write coding."
          : codingSourceHandoffInstructions,
        writeCapable
          ? "Return a concise summary of files changed, tests run, and any follow-up notes; do not return graph metadata operations during coding."
          : "Return complete propose-source-file operations with path, action, content, nodeId when known, reason, and testIntent; do not summarize code in prose instead of providing file contents.",
        writeCapable ? "" : sourceProposalBatchingInstructions
      ]
    : phase === "debugging"
      ? [
          `You are ${pandoraAgent.title}, ArchiCode's debugging agent.`,
          "This is the debugging phase after a failed coding or verification run.",
          "Prioritize failure logs, recent diffs, changed files, and affected nodes before broad context.",
          "Repair code so the implementation still matches the latest graph/node source of truth, not just the immediate error log.",
          writeCapable
            ? "Make the smallest repair, update tests if needed, and return concise finite verification guidance. Do not launch the app/runtime; use logs and source evidence instead. Do not return graph metadata operations or source-file proposal JSON during direct-write debugging."
            : "The configured Claude Code access mode is read-only here, so return the smallest repair as complete propose-source-file operations instead of attempting filesystem edits.",
          writeCapable ? "" : codingSourceHandoffInstructions,
          writeCapable ? "" : sourceProposalBatchingInstructions
        ]
      : [
          `You are ${gaiaAgent.title}, ArchiCode's implementation agent.`,
          "This is the mandatory planning phase before coding.",
          "Do not edit project files during planning.",
          planningQuestionGateInstructions,
          planningPatchJsonContract,
          "If missing user input or material ambiguity remains, return focused llm-question notes.",
          "If sufficient, produce a concrete user-facing plan with goal, approach, assumptions, implementation steps, verification, and risks. Return graph proposals as archicodePatch JSON when useful."
        ];

  const prompt = options.bareExtraction
    ? [extractionSystemPrompt, "", contextText].join("\n")
    : [
    orchestratorSystemPrompt,
    "",
    "You are being called as ArchiCode's local Claude Code provider through the user's installed Claude Code CLI.",
    localAskModeMcpRequestInstructions,
    ...phaseInstructions,
    phasePolicyText(phase, policy, profile),
    options.selectedSkillsPrompt?.trim() ? options.selectedSkillsPrompt.trim() : "",
    imageAttachmentText(options.imageAttachments),
    await textAttachmentText(options.textAttachments),
    options.webSearchEnabled
      ? "Web search is enabled for this run. Use the mounted ArchiCode web tools when available; otherwise use Claude's web tools only when current external information is needed, and cite sources in your final response."
      : "Web search is disabled for this run. Use only the provided project context, mounted tools, and local knowledge.",
    writeCapable && (phase === "coding" || phase === "debugging")
      ? "Return concise guidance. Do not include archicodePatch JSON unless explicitly asked for non-source metadata in a non-coding phase."
      : "Return concise guidance and, when useful, an archicodePatch JSON object.",
    "",
    `Prompt summary: ${promptSummary}`,
    "",
    "Project JSON context:",
    contextText
  ].join("\n");

  const { stdout, stderr, exitCode } = await runLocalProcess(command, args, prompt, options.projectRoot, options.onProgress, options.signal);
  if (exitCode !== 0) {
    throw new Error(`Claude Code local provider failed with exit code ${exitCode}.\n${stderr || stdout}`);
  }
  emitUnavailableUsage(provider, policy, options.onUsage);
  return stdout.trim() || "Claude Code local provider returned no content.";
}

export async function callClaudeLocalResearch(provider: Provider, userMessage: string, options: ResearchProviderOptions, policy: PhaseModelPolicy): Promise<string> {
  const result = await callLocalResearchProvider(
    "claude-local",
    provider,
    userMessage,
    options,
    policy,
    async (prompt, onToken) => {
      const command = localCliCommand(provider);
      const outputDir = await mkdtemp(path.join(tmpdir(), "archicode-research-claude-"));
      const projectFileServers = options.projectRoot ? [await createCodexProjectFilesMcpServer(options.projectRoot, outputDir)] : [];
      const mcpConfig = claudeMcpConfig(projectFileServers);
      const mcpConfigPath = await writeClaudeMcpConfig(outputDir, mcpConfig);
      const args = buildClaudeLocalResearchArgs(provider, {
        ...options,
        mcpServers: projectFileServers
      }, {
        mcpConfigPath,
        allowedToolPatterns: mcpConfig.allowedToolPatterns
      });
      const streamClaudeToken = createClaudeLocalTokenStreamer(onToken);
      const { stdout, stderr, exitCode } = await runLocalProcess(
        command,
        args,
        prompt,
        options.projectRoot,
        onToken
          ? (event) => {
              if (event.stream === "stdout") streamClaudeToken(event.text);
            }
          : undefined,
        options.signal
      );
      if (exitCode !== 0) {
        throw new Error(`Claude Code local research provider failed with exit code ${exitCode}.\n${stderr || stdout}`);
      }
      return streamClaudeToken.finalText() || stdout.trim() || "Claude Code local research provider returned no content.";
    }
  );
  emitUnavailableUsage(provider, policy, options.onUsage);
  return result;
}

export function buildOpenCodeLocalArgs(
  provider: Provider,
  options: Pick<ProviderCallOptions, "phase" | "projectRoot" | "imageAttachments">
): string[] {
  const phase = options.phase ?? "planning";
  const args = ["run", "--format", "json"];
  if (options.projectRoot) args.push("--dir", options.projectRoot);
  const model = resolvePhaseModelPolicy(provider, phase).modelOverride?.trim() || provider.model?.trim();
  if (model) args.push("--model", model);
  if (provider.localProfile?.trim()) args.push("--agent", provider.localProfile.trim());
  for (const imagePath of [...new Set((options.imageAttachments ?? []).map((image) => image.path.trim()).filter(Boolean))]) {
    args.push("--file", imagePath);
  }
  if (provider.localSandbox !== "read-only" && (phase === "coding" || phase === "debugging" || phase === "verifying")) {
    args.push("--auto");
  }
  return args;
}

export function openCodeProcessEnv(provider: Provider, phase: LlmPhase): NodeJS.ProcessEnv | undefined {
  const writeAllowed = provider.localSandbox !== "read-only" && (phase === "coding" || phase === "debugging" || phase === "verifying");
  if (writeAllowed && provider.localSandbox === "danger-full-access") return undefined;
  const permission = writeAllowed
    ? { external_directory: "deny" }
    : { edit: "deny", bash: "deny", external_directory: "deny" };
  const agentName = provider.localProfile?.trim() || "build";
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission,
      agent: {
        build: { permission },
        plan: { permission },
        [agentName]: { permission }
      }
    })
  };
}

function localCodingPhaseInstructions(provider: Provider, phase: LlmPhase, providerName: string): string[] {
  const writeCapable = provider.localSandbox !== "read-only";
  if (phase === "coding") return [
    `You are ${gaiaAgent.title}, ArchiCode's implementation agent.`,
    writeCapable
      ? "Implement the requested change directly in the project. Keep edits bounded to the project and do not start a server, watcher, simulator, or other long-running process."
      : `${providerName} is configured read-only. Do not edit files; return complete source changes using ArchiCode's propose-source-file operations.`,
    writeCapable ? "Return a concise summary of changed files and finite checks run." : codingSourceHandoffInstructions,
    writeCapable ? "" : sourceProposalBatchingInstructions
  ];
  if (phase === "debugging") return [
    `You are ${pandoraAgent.title}, ArchiCode's debugging agent.`,
    "Use the supplied failures and project evidence to make the smallest correct repair.",
    writeCapable
      ? "Edit the project directly and run only finite checks needed to validate the repair."
      : "Do not edit files; return complete repairs using ArchiCode's propose-source-file operations."
  ];
  return [
    `You are ${gaiaAgent.title}, ArchiCode's implementation agent.`,
    "This is a planning or review phase. Do not edit project files.",
    planningQuestionGateInstructions,
    planningPatchJsonContract
  ];
}

export async function callOpenCodeLocal(provider: Provider, contextText: string, promptSummary: string, options: ProviderCallOptions, policy: PhaseModelPolicy): Promise<string> {
  const command = localCliCommand(provider);
  const phase = options.phase ?? "planning";
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  const args = buildOpenCodeLocalArgs(provider, options);
  const prompt = options.bareExtraction
    ? [extractionSystemPrompt, "", contextText].join("\n")
    : [
        orchestratorSystemPrompt,
        "",
        "You are being called as ArchiCode's local OpenCode provider through a one-shot OpenCode CLI process.",
        ...localCodingPhaseInstructions(provider, phase, "OpenCode"),
        phasePolicyText(phase, policy, profile),
        options.selectedSkillsPrompt?.trim() ?? "",
        imageAttachmentText(options.imageAttachments),
        await textAttachmentText(options.textAttachments),
        options.webSearchEnabled
          ? "Use OpenCode's configured web tools only when current external information is needed, and cite sources."
          : "Web search is disabled. Use the supplied project context and local knowledge.",
        "",
        `Prompt summary: ${promptSummary}`,
        "",
        "Project JSON context:",
        contextText
      ].filter(Boolean).join("\n");
  const stream = createOpenCodeLocalTokenStreamer(options.onProgress
    ? (text, kind) => options.onProgress?.({ stream: kind === "thinking" ? "system" : "stdout", text })
    : undefined);
  const result = await runLocalProcess(command, args, prompt, options.projectRoot, (event) => {
    if (event.stream === "stdout") stream(event.text);
    else options.onProgress?.(event);
  }, options.signal, { env: openCodeProcessEnv(provider, phase) });
  const finalText = stream.finalText();
  await cleanupOpenCodeSession(command, stream.sessionId(), options.projectRoot, provider.ephemeral !== false);
  if (result.exitCode !== 0) {
    throw new Error(`OpenCode local provider failed with exit code ${result.exitCode}.\n${result.stderr || result.stdout}`);
  }
  emitUnavailableUsage(provider, policy, options.onUsage);
  return finalText || result.stdout.trim() || "OpenCode local provider returned no content.";
}

export async function callOpenCodeLocalResearch(provider: Provider, userMessage: string, options: ResearchProviderOptions, policy: PhaseModelPolicy): Promise<string> {
  const result = await callLocalResearchProvider(
    "opencode-local",
    provider,
    userMessage,
    options,
    policy,
    async (prompt, onToken) => {
      const command = localCliCommand(provider);
      const args = buildOpenCodeLocalArgs(provider, { ...options, phase: "brainstorming" });
      const stream = createOpenCodeLocalTokenStreamer(onToken);
      const processResult = await runLocalProcess(command, args, prompt, options.projectRoot, (event) => {
        if (event.stream === "stdout") stream(event.text);
      }, options.signal, { env: openCodeProcessEnv(provider, "brainstorming") });
      const finalText = stream.finalText();
      await cleanupOpenCodeSession(command, stream.sessionId(), options.projectRoot, provider.ephemeral !== false);
      if (processResult.exitCode !== 0) {
        throw new Error(`OpenCode local research provider failed with exit code ${processResult.exitCode}.\n${processResult.stderr || processResult.stdout}`);
      }
      return finalText || processResult.stdout.trim() || "OpenCode local research provider returned no content.";
    }
  );
  emitUnavailableUsage(provider, policy, options.onUsage);
  return result;
}

export function buildAntigravityLocalArgs(provider: Provider, phase: LlmPhase, prompt: string): string[] {
  const writeCapable = provider.localSandbox !== "read-only" && (phase === "coding" || phase === "debugging" || phase === "verifying");
  const args = ["--print", prompt, "--print-timeout", "5m", "--mode", writeCapable ? "accept-edits" : "plan"];
  const model = resolvePhaseModelPolicy(provider, phase).modelOverride?.trim() || provider.model?.trim();
  if (model) args.push("--model", model);
  if (provider.localProfile?.trim()) args.push("--agent", provider.localProfile.trim());
  if (provider.localSandbox !== "danger-full-access") args.push("--sandbox");
  args.push("--dangerously-skip-permissions");
  return args;
}

function antigravityAttachmentReferences(options: Pick<ProviderCallOptions, "imageAttachments" | "textAttachments">): string {
  const paths = [...new Set([
    ...(options.imageAttachments ?? []).map((attachment) => attachment.path.trim()),
    ...(options.textAttachments ?? []).map((attachment) => attachment.path.trim())
  ].filter(Boolean))];
  if (!paths.length) return "";
  return [
    "Antigravity file references for the supplied attachments:",
    ...paths.map((attachmentPath) => `@${attachmentPath}`)
  ].join("\n");
}

export async function callAntigravityLocal(provider: Provider, contextText: string, promptSummary: string, options: ProviderCallOptions, policy: PhaseModelPolicy): Promise<string> {
  const command = localCliCommand(provider);
  const phase = options.phase ?? "planning";
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  const prompt = options.bareExtraction
    ? [extractionSystemPrompt, "", contextText].join("\n")
    : [
        orchestratorSystemPrompt,
        "",
        "You are being called as ArchiCode's local Google Antigravity provider through a one-shot agy --print process.",
        ...localCodingPhaseInstructions(provider, phase, "Antigravity"),
        phasePolicyText(phase, policy, profile),
        options.selectedSkillsPrompt?.trim() ?? "",
        imageAttachmentText(options.imageAttachments),
        await textAttachmentText(options.textAttachments),
        antigravityAttachmentReferences(options),
        options.webSearchEnabled
          ? "Use Antigravity's built-in web tools only when current external information is needed, and cite sources."
          : "Web search is disabled. Use the supplied project context and local knowledge.",
        "",
        `Prompt summary: ${promptSummary}`,
        "",
        "Project JSON context:",
        contextText
      ].filter(Boolean).join("\n");
  const args = buildAntigravityLocalArgs(provider, phase, prompt);
  const result = await runLocalProcess(command, args, "", options.projectRoot, options.onProgress, options.signal);
  if (result.exitCode !== 0) {
    throw new Error(`Antigravity local provider failed with exit code ${result.exitCode}.\n${result.stderr || result.stdout}`);
  }
  emitUnavailableUsage(provider, policy, options.onUsage);
  return result.stdout.trim() || "Antigravity local provider returned no content.";
}

export async function callAntigravityLocalResearch(provider: Provider, userMessage: string, options: ResearchProviderOptions, policy: PhaseModelPolicy): Promise<string> {
  const result = await callLocalResearchProvider(
    "antigravity-local",
    provider,
    userMessage,
    options,
    policy,
    async (prompt, onToken) => {
      const command = localCliCommand(provider);
      const attachmentReferences = antigravityAttachmentReferences(options);
      const finalPrompt = attachmentReferences ? `${prompt}\n\n${attachmentReferences}` : prompt;
      const args = buildAntigravityLocalArgs(provider, "brainstorming", finalPrompt);
      const processResult = await runLocalProcess(command, args, "", options.projectRoot, onToken
        ? (event) => {
            if (event.stream === "stdout") onToken(event.text, "answer");
          }
        : undefined, options.signal);
      if (processResult.exitCode !== 0) {
        throw new Error(`Antigravity local research provider failed with exit code ${processResult.exitCode}.\n${processResult.stderr || processResult.stdout}`);
      }
      return processResult.stdout.trim() || "Antigravity local research provider returned no content.";
    }
  );
  emitUnavailableUsage(provider, policy, options.onUsage);
  return result;
}

export function buildKimiLocalArgs(provider: Provider, phase: LlmPhase, prompt: string): string[] {
  const args = ["--prompt", prompt, "--output-format", "stream-json"];
  const model = resolvePhaseModelPolicy(provider, phase).modelOverride?.trim() || provider.model?.trim();
  if (model) args.push("--model", model);
  return args;
}

function kimiContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(kimiContentText).filter(Boolean).join("");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  return kimiContentText(record.content ?? record.parts ?? record.delta);
}

export function kimiJsonEvent(line: string): { text?: { kind: "delta" | "full"; tokenKind: ProviderTokenKind; value: string } } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = event.message && typeof event.message === "object" ? event.message as Record<string, unknown> : undefined;
  const role = typeof event.role === "string"
    ? event.role.toLowerCase()
    : typeof message?.role === "string"
      ? message.role.toLowerCase()
      : "";
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  if (role !== "assistant" && !type.includes("assistant")) return {};
  const value = kimiContentText(message?.content ?? event.content ?? event.delta ?? event.text);
  if (!value) return {};
  return {
    text: {
      kind: type.includes("delta") || type.includes("chunk") ? "delta" : "full",
      tokenKind: type.includes("thinking") || type.includes("reason") ? "thinking" : "answer",
      value
    }
  };
}

export function createKimiLocalTokenStreamer(onToken?: (text: string, kind?: ProviderTokenKind) => void): {
  (chunk: string): void;
  finalText(): string;
} {
  let buffer = "";
  let answer = "";
  let thinking = "";
  const processLines = (lines: string[]): void => {
    for (const line of lines) {
      const event = kimiJsonEvent(line);
      if (!event?.text) continue;
      if (event.text.tokenKind === "thinking") thinking = emitLocalCliJsonText(event.text, thinking, onToken);
      else answer = emitLocalCliJsonText(event.text, answer, onToken);
    }
  };
  const push = (chunk: string): void => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    processLines(lines);
  };
  push.finalText = () => {
    if (buffer.trim()) processLines([buffer]);
    buffer = "";
    return (answer || thinking).trim();
  };
  return push;
}

function kimiAttachmentReferences(options: Pick<ProviderCallOptions, "imageAttachments" | "textAttachments">): string {
  const paths = [...new Set([
    ...(options.imageAttachments ?? []).map((attachment) => attachment.path.trim()),
    ...(options.textAttachments ?? []).map((attachment) => attachment.path.trim())
  ].filter(Boolean))];
  return paths.length ? ["Kimi Code attachment references:", ...paths.map((attachmentPath) => `@${attachmentPath}`)].join("\n") : "";
}

function kimiPermissionInstructions(provider: Provider, phase: LlmPhase): string {
  const writeCapable = provider.localSandbox !== "read-only" && (phase === "coding" || phase === "debugging" || phase === "verifying");
  if (!writeCapable) {
    return "This Kimi one-shot must remain read-only. Do not call Write or Edit, and do not run shell commands or tools with side effects. Static deny rules configured in Kimi Code remain authoritative.";
  }
  if (provider.localSandbox === "workspace-write") {
    return "Limit all file operations and commands to the current project workspace. Do not access parent, home, credential, or external directories. Kimi Code static permission rules remain authoritative.";
  }
  return "Full local command access is enabled for this trusted Kimi Code run. Keep every action necessary and directly related to the requested project task.";
}

function kimiPermissionRule(decision: "allow" | "deny", pattern: string, reason: string): string {
  return [
    "[[permission.rules]]",
    `decision = ${JSON.stringify(decision)}`,
    'scope = "session-runtime"',
    `pattern = ${JSON.stringify(pattern)}`,
    `reason = ${JSON.stringify(reason)}`
  ].join("\n");
}

export function kimiArchiCodePermissionConfig(provider: Provider, phase: LlmPhase, projectRoot: string): string {
  const writeCapable = provider.localSandbox !== "read-only" && (phase === "coding" || phase === "debugging" || phase === "verifying");
  if (provider.localSandbox === "danger-full-access" && writeCapable) return "";
  const rules: string[] = [];
  if (writeCapable) {
    const root = path.resolve(projectRoot).replace(/\\/g, "/").replace(/\/$/, "");
    rules.push(kimiPermissionRule("allow", `Write(${root}/**)`, "ArchiCode workspace write"));
    rules.push(kimiPermissionRule("allow", `Edit(${root}/**)`, "ArchiCode workspace edit"));
  }
  rules.push(kimiPermissionRule("deny", "Write", writeCapable ? "Outside the ArchiCode workspace" : "ArchiCode read-only phase"));
  rules.push(kimiPermissionRule("deny", "Edit", writeCapable ? "Outside the ArchiCode workspace" : "ArchiCode read-only phase"));
  rules.push(kimiPermissionRule("deny", "Bash", "ArchiCode owns finite command verification"));
  rules.push(kimiPermissionRule("deny", "Shell", "ArchiCode owns finite command verification"));
  rules.push(kimiPermissionRule("deny", "Agent", "Prevent delegated tools from bypassing ArchiCode access boundaries"));
  rules.push(kimiPermissionRule("deny", "AgentSwarm", "Prevent delegated tools from bypassing ArchiCode access boundaries"));
  rules.push(kimiPermissionRule("deny", "mcp__*", "Use ArchiCode's permissioned MCP tool loop instead"));
  rules.push(kimiPermissionRule("deny", "CronCreate", "Scheduled background work is outside a one-shot provider call"));
  return `${rules.join("\n\n")}\n`;
}

async function prepareKimiProcessEnvironment(provider: Provider, phase: LlmPhase, projectRoot: string | undefined): Promise<{
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}> {
  const sourceHome = path.resolve(process.env.KIMI_CODE_HOME?.trim() || path.join(homedir(), ".kimi-code"));
  const isolatedHome = await mkdtemp(path.join(tmpdir(), "archicode-kimi-"));
  let config = "";
  try {
    config = await readFile(path.join(sourceHome, "config.toml"), "utf8");
  } catch {
    // Kimi will report its normal missing-configuration/login error.
  }
  const permissionConfig = kimiArchiCodePermissionConfig(provider, phase, projectRoot ?? process.cwd());
  await writeFile(path.join(isolatedHome, "config.toml"), `${permissionConfig}${config.replace(/^\uFEFF/, "")}`, { encoding: "utf8", mode: 0o600 });
  const credentialsSource = path.join(sourceHome, "credentials");
  try {
    await access(credentialsSource, constants.R_OK);
    await symlink(credentialsSource, path.join(isolatedHome, "credentials"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    await mkdir(path.join(isolatedHome, "credentials"), { recursive: true, mode: 0o700 });
  }
  return {
    env: {
      KIMI_CODE_HOME: isolatedHome,
      KIMI_DISABLE_TELEMETRY: "1",
      KIMI_CODE_NO_AUTO_UPDATE: "1"
    },
    cleanup: async () => {
      await rm(isolatedHome, { recursive: true, force: true });
    }
  };
}

export async function callKimiLocal(provider: Provider, contextText: string, promptSummary: string, options: ProviderCallOptions, policy: PhaseModelPolicy): Promise<string> {
  const command = localCliCommand(provider);
  const phase = options.phase ?? "planning";
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  const prompt = options.bareExtraction
    ? [extractionSystemPrompt, "", contextText].join("\n")
    : [
        orchestratorSystemPrompt,
        "",
        "You are being called as ArchiCode's local Kimi Code provider through a fresh one-shot kimi --prompt process.",
        ...localCodingPhaseInstructions(provider, phase, "Kimi Code"),
        kimiPermissionInstructions(provider, phase),
        phasePolicyText(phase, policy, profile),
        options.selectedSkillsPrompt?.trim() ?? "",
        imageAttachmentText(options.imageAttachments),
        await textAttachmentText(options.textAttachments),
        kimiAttachmentReferences(options),
        options.webSearchEnabled
          ? "Use Kimi Code's built-in web tools only when current external information is needed, and cite sources."
          : "Web search is disabled. Use the supplied project context and local knowledge.",
        "",
        `Prompt summary: ${promptSummary}`,
        "",
        "Project JSON context:",
        contextText
      ].filter(Boolean).join("\n");
  const args = buildKimiLocalArgs(provider, phase, prompt);
  const processEnvironment = await prepareKimiProcessEnvironment(provider, phase, options.projectRoot);
  const stream = createKimiLocalTokenStreamer(options.onProgress
    ? (text, kind) => options.onProgress?.({ stream: kind === "thinking" ? "system" : "stdout", text })
    : undefined);
  let result: Awaited<ReturnType<typeof runLocalProcess>>;
  try {
    result = await runLocalProcess(command, args, "", options.projectRoot, (event) => {
      if (event.stream === "stdout") stream(event.text);
      else options.onProgress?.(event);
    }, options.signal, { env: processEnvironment.env });
  } finally {
    await processEnvironment.cleanup();
  }
  const finalText = stream.finalText();
  if (result.exitCode !== 0) {
    throw new Error(`Kimi Code local provider failed with exit code ${result.exitCode}.\n${result.stderr || result.stdout}`);
  }
  emitUnavailableUsage(provider, policy, options.onUsage);
  return finalText || result.stdout.trim() || "Kimi Code local provider returned no content.";
}

export async function callKimiLocalResearch(provider: Provider, userMessage: string, options: ResearchProviderOptions, policy: PhaseModelPolicy): Promise<string> {
  const result = await callLocalResearchProvider(
    "kimi-local",
    provider,
    userMessage,
    options,
    policy,
    async (prompt, onToken) => {
      const command = localCliCommand(provider);
      const attachmentReferences = kimiAttachmentReferences(options);
      const finalPrompt = [prompt, attachmentReferences, kimiPermissionInstructions(provider, "brainstorming")].filter(Boolean).join("\n\n");
      const args = buildKimiLocalArgs(provider, "brainstorming", finalPrompt);
      const stream = createKimiLocalTokenStreamer(onToken);
      const processEnvironment = await prepareKimiProcessEnvironment(provider, "brainstorming", options.projectRoot);
      let processResult: Awaited<ReturnType<typeof runLocalProcess>>;
      try {
        processResult = await runLocalProcess(command, args, "", options.projectRoot, (event) => {
          if (event.stream === "stdout") stream(event.text);
        }, options.signal, { env: processEnvironment.env });
      } finally {
        await processEnvironment.cleanup();
      }
      const finalText = stream.finalText();
      if (processResult.exitCode !== 0) {
        throw new Error(`Kimi Code local research provider failed with exit code ${processResult.exitCode}.\n${processResult.stderr || processResult.stdout}`);
      }
      return finalText || processResult.stdout.trim() || "Kimi Code local research provider returned no content.";
    }
  );
  emitUnavailableUsage(provider, policy, options.onUsage);
  return result;
}

export function buildGrokLocalArgs(provider: Provider, phase: LlmPhase, prompt: string, webSearchEnabled = false): string[] {
  const writeCapable = provider.localSandbox !== "read-only" && (phase === "coding" || phase === "debugging" || phase === "verifying");
  const args = [
    "--output-format", "streaming-json",
    "--no-memory",
    "--no-subagents",
    "--permission-mode", writeCapable ? "bypassPermissions" : "dontAsk",
    "--sandbox", writeCapable && provider.localSandbox === "danger-full-access" ? "off" : writeCapable ? "workspace" : "read-only"
  ];
  const policy = resolvePhaseModelPolicy(provider, phase);
  const model = policy.modelOverride?.trim() || provider.model?.trim();
  if (model) args.push("--model", model);
  if (policy.reasoningMode !== "off") args.push("--reasoning-effort", policy.reasoningMode);
  if (provider.localProfile?.trim()) args.push("--agent", provider.localProfile.trim());
  if (!webSearchEnabled) args.push("--disable-web-search");
  args.push("-p", prompt);
  return args;
}

function grokContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(grokContentText).filter(Boolean).join("");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  return grokContentText(record.content ?? record.parts ?? record.delta);
}

export function grokJsonEvent(line: string): {
  text?: { kind: "delta" | "full"; tokenKind: ProviderTokenKind; value: string };
  sessionId?: string;
} | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const session = event.session && typeof event.session === "object" ? event.session as Record<string, unknown> : undefined;
  const sessionId = [event.session_id, event.sessionId, event.sessionID, session?.id]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  const message = event.message && typeof event.message === "object" ? event.message as Record<string, unknown> : undefined;
  const role = typeof event.role === "string"
    ? event.role.toLowerCase()
    : typeof message?.role === "string"
      ? message.role.toLowerCase()
      : "";
  const update = event.update && typeof event.update === "object" ? event.update as Record<string, unknown> : undefined;
  const updateType = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : "";
  const thinking = type.includes("reason") || type.includes("thinking");
  let value = "";
  let kind: "delta" | "full" = "delta";
  if (type === "result" || type.endsWith("_result")) {
    value = grokContentText(event.result ?? event.response ?? event.output ?? event.content ?? event.text);
    kind = "full";
  } else if (updateType === "agent_message_chunk") {
    value = grokContentText(update?.content);
  } else if (role === "assistant" || type.includes("assistant")) {
    value = grokContentText(message?.content ?? event.content ?? event.delta ?? event.text);
    kind = type.includes("complete") || type.includes("final") ? "full" : "delta";
  } else if (type.includes("delta")) {
    value = grokContentText(event.delta ?? event.content ?? event.text);
  } else if (type === "message" && !role) {
    value = grokContentText(event.content ?? event.delta ?? event.text);
  }
  return {
    sessionId,
    ...(value ? { text: { kind, tokenKind: thinking ? "thinking" : "answer", value } } : {})
  };
}

export function createGrokLocalTokenStreamer(onToken?: (text: string, kind?: ProviderTokenKind) => void): {
  (chunk: string): void;
  finalText(): string;
  sessionId(): string | undefined;
} {
  let buffer = "";
  let answer = "";
  let thinking = "";
  let currentSessionId: string | undefined;
  const processLines = (lines: string[]): void => {
    for (const line of lines) {
      const event = grokJsonEvent(line);
      if (!event) continue;
      if (event.sessionId) currentSessionId = event.sessionId;
      if (!event.text) continue;
      if (event.text.tokenKind === "thinking") thinking = emitLocalCliJsonText(event.text, thinking, onToken);
      else answer = emitLocalCliJsonText(event.text, answer, onToken);
    }
  };
  const push = (chunk: string): void => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    processLines(lines);
  };
  const flush = (): void => {
    if (!buffer.trim()) return;
    processLines([buffer]);
    buffer = "";
  };
  push.finalText = () => {
    flush();
    return (answer || thinking).trim();
  };
  push.sessionId = () => {
    flush();
    return currentSessionId;
  };
  return push;
}

async function cleanupGrokSession(command: string, sessionId: string | undefined, cwd: string | undefined, enabled: boolean): Promise<void> {
  if (!enabled || !sessionId) return;
  try {
    await runLocalProcess(command, ["sessions", "delete", sessionId], "", cwd, undefined, undefined, { inactivityTimeoutMs: 30_000 });
  } catch {
    // Session cleanup is best-effort and must not hide a completed provider response.
  }
}

function grokAttachmentReferences(options: Pick<ProviderCallOptions, "imageAttachments" | "textAttachments">): string {
  const paths = [...new Set([
    ...(options.imageAttachments ?? []).map((attachment) => attachment.path.trim()),
    ...(options.textAttachments ?? []).map((attachment) => attachment.path.trim())
  ].filter(Boolean))];
  return paths.length ? ["Grok Build attachment references:", ...paths.map((attachmentPath) => `@${attachmentPath}`)].join("\n") : "";
}

export async function callGrokLocal(provider: Provider, contextText: string, promptSummary: string, options: ProviderCallOptions, policy: PhaseModelPolicy): Promise<string> {
  const command = localCliCommand(provider);
  const phase = options.phase ?? "planning";
  const profile = inferModelCapabilityProfile(provider, policy.modelOverride);
  const prompt = options.bareExtraction
    ? [extractionSystemPrompt, "", contextText].join("\n")
    : [
        orchestratorSystemPrompt,
        "",
        "You are being called as ArchiCode's local Grok Build provider through a one-shot grok process.",
        ...localCodingPhaseInstructions(provider, phase, "Grok Build"),
        phasePolicyText(phase, policy, profile),
        options.selectedSkillsPrompt?.trim() ?? "",
        imageAttachmentText(options.imageAttachments),
        await textAttachmentText(options.textAttachments),
        grokAttachmentReferences(options),
        options.webSearchEnabled
          ? "Use Grok Build's web tools only when current external information is needed, and cite sources."
          : "Web search is disabled. Use the supplied project context and local knowledge.",
        "",
        `Prompt summary: ${promptSummary}`,
        "",
        "Project JSON context:",
        contextText
      ].filter(Boolean).join("\n");
  const args = buildGrokLocalArgs(provider, phase, prompt, options.webSearchEnabled);
  const stream = createGrokLocalTokenStreamer(options.onProgress
    ? (text, kind) => options.onProgress?.({ stream: kind === "thinking" ? "system" : "stdout", text })
    : undefined);
  const result = await runLocalProcess(command, args, "", options.projectRoot, (event) => {
    if (event.stream === "stdout") stream(event.text);
    else options.onProgress?.(event);
  }, options.signal);
  const finalText = stream.finalText();
  await cleanupGrokSession(command, stream.sessionId(), options.projectRoot, provider.ephemeral !== false);
  if (result.exitCode !== 0) {
    throw new Error(`Grok Build local provider failed with exit code ${result.exitCode}.\n${result.stderr || result.stdout}`);
  }
  emitUnavailableUsage(provider, policy, options.onUsage);
  return finalText || result.stdout.trim() || "Grok Build local provider returned no content.";
}

export async function callGrokLocalResearch(provider: Provider, userMessage: string, options: ResearchProviderOptions, policy: PhaseModelPolicy): Promise<string> {
  const result = await callLocalResearchProvider(
    "grok-local",
    provider,
    userMessage,
    options,
    policy,
    async (prompt, onToken) => {
      const command = localCliCommand(provider);
      const attachmentReferences = grokAttachmentReferences(options);
      const finalPrompt = attachmentReferences ? `${prompt}\n\n${attachmentReferences}` : prompt;
      const args = buildGrokLocalArgs(provider, "brainstorming", finalPrompt, options.webSearchEnabled);
      const stream = createGrokLocalTokenStreamer(onToken);
      const processResult = await runLocalProcess(command, args, "", options.projectRoot, (event) => {
        if (event.stream === "stdout") stream(event.text);
      }, options.signal);
      const finalText = stream.finalText();
      await cleanupGrokSession(command, stream.sessionId(), options.projectRoot, provider.ephemeral !== false);
      if (processResult.exitCode !== 0) {
        throw new Error(`Grok Build local research provider failed with exit code ${processResult.exitCode}.\n${processResult.stderr || processResult.stdout}`);
      }
      return finalText || processResult.stdout.trim() || "Grok Build local research provider returned no content.";
    }
  );
  emitUnavailableUsage(provider, policy, options.onUsage);
  return result;
}

export async function createCodexProjectFilesMcpServer(projectRoot: string, outputDir: string): Promise<McpServer> {
  const serverPath = path.join(outputDir, "archicode-project-files-mcp.mjs");
  const mcpModulePath = requireFromProviders.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const stdioModulePath = requireFromProviders.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  const zodModulePath = requireFromProviders.resolve("zod/v4");
  await writeFile(serverPath, codexProjectFilesMcpSource({
    projectRoot: path.resolve(projectRoot),
    mcpModuleUrl: pathToFileURL(mcpModulePath).href,
    stdioModuleUrl: pathToFileURL(stdioModulePath).href,
    zodModuleUrl: pathToFileURL(zodModulePath).href
  }), "utf8");
  return {
    id: "archicode-project-files",
    label: "Project Files",
    transport: "stdio",
    command: process.execPath,
    args: [serverPath],
    cwd: outputDir,
    env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
    headers: [],
    enabled: true,
    trusted: true,
    source: "project",
    tools: [],
    resources: [],
    prompts: [],
    defaultToolsApprovalMode: "approve"
  };
}

export function codexProjectFilesMcpSource(input: { projectRoot: string; mcpModuleUrl: string; stdioModuleUrl: string; zodModuleUrl: string }): string {
  return `import { McpServer } from ${JSON.stringify(input.mcpModuleUrl)};
import { StdioServerTransport } from ${JSON.stringify(input.stdioModuleUrl)};
import { z } from ${JSON.stringify(input.zodModuleUrl)};
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const PROJECT_ROOT = ${JSON.stringify(input.projectRoot)};
export const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"]);
export const MAX_RESULTS = 500;
export const MAX_READ_CHARS = 80000;
export const MAX_CLI_ARGS = 64;
export const MAX_CLI_OUTPUT_CHARS = 60000;
export const MAX_CLI_TIMEOUT_MS = 15000;
export const CLI_COMMANDS = ${JSON.stringify([
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
])};

export function clampInteger(value, fallback, min, max) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

export function safeRelativePath(requested) {
  const raw = typeof requested === "string" ? requested.trim() : "";
  const normalized = raw.replace(/\\\\/g, "/").replace(/^\\.\\/+/, "");
  const absolutePath = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(PROJECT_ROOT, normalized || ".");
  const relativePath = path.relative(PROJECT_ROOT, absolutePath).split(path.sep).join("/");
  if (path.isAbsolute(raw) && relativePath.startsWith("..")) throw new Error("Use a project-relative path, not an absolute path.");
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error("Path escapes the project root.");
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.some((part) => IGNORE_DIRS.has(part))) throw new Error("Path is inside an ignored directory.");
  return { relativePath: relativePath === "" ? "." : relativePath, absolutePath };
}

export async function fileLooksBinary(filePath) {
  const bytes = await readFile(filePath).catch(() => null);
  if (!bytes) return false;
  return bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0);
}

export function redactSensitiveText(text) {
  let redacted = false;
  text = text.replace(/("(?:apiKey|api_key|token|accessToken|refreshToken|password|secret|clientSecret|authorization)"\\s*:\\s*")([^"]*)(")/gi, (_match, prefix, _value, suffix) => {
    redacted = true;
    return \`\${prefix}[redacted]\${suffix}\`;
  });
  text = text.replace(/^([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=).+$/gim, (_match, prefix) => {
    redacted = true;
    return \`\${prefix}[redacted]\`;
  });
  text = text.replace(/\\b(sk-[A-Za-z0-9_-]{12,}|anthropic-[A-Za-z0-9_-]{12,})\\b/g, () => {
    redacted = true;
    return "[redacted-secret]";
  });
  return { text, redacted };
}

export async function collectFiles(rootPath = PROJECT_ROOT, prefix = "") {
  const files = [];
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const absolutePath = path.join(rootPath, entry.name);
    const relativePath = path.join(prefix, entry.name).split(path.sep).join("/");
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat) continue;
    files.push({ path: relativePath, size: fileStat.size, binary: await fileLooksBinary(absolutePath) });
    if (files.length >= 900) break;
  }
  return files;
}

export function isInsideDirectory(filePath, directory) {
  return directory === "." || filePath === directory || filePath.startsWith(\`\${directory}/\`);
}

export async function listFiles({ directory, recursive, maxResults } = {}) {
  const target = safeRelativePath(directory);
  const limit = clampInteger(maxResults, 200, 1, MAX_RESULTS);
  if (!recursive) {
    const entries = await readdir(target.absolutePath, { withFileTypes: true }).catch(() => []);
    const visible = entries
      .filter((entry) => !IGNORE_DIRS.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, limit)
      .map((entry) => ({
        path: path.join(target.relativePath === "." ? "" : target.relativePath, entry.name).split(path.sep).join("/"),
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
      }));
    return { directory: target.relativePath, recursive: false, entries: visible, omitted: Math.max(0, entries.length - visible.length), ignoredDirectories: [...IGNORE_DIRS] };
  }
  const files = (await collectFiles()).filter((file) => isInsideDirectory(file.path, target.relativePath));
  return { directory: target.relativePath, recursive: true, files: files.slice(0, limit), omitted: Math.max(0, files.length - limit), ignoredDirectories: [...IGNORE_DIRS] };
}

export async function readProjectFile({ path: requestedPath, startLine, endLine, maxChars } = {}) {
  const target = safeRelativePath(requestedPath);
  const fileStat = await stat(target.absolutePath).catch(() => null);
  if (!fileStat?.isFile()) throw new Error(\`\${target.relativePath} is not a readable file.\`);
  const raw = await readFile(target.absolutePath);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (await fileLooksBinary(target.absolutePath)) return { path: target.relativePath, size: fileStat.size, sha256, binary: true, text: "[binary file omitted]" };
  const limit = clampInteger(maxChars, 40000, 1, MAX_READ_CHARS);
  const source = raw.toString("utf8");
  const redacted = redactSensitiveText(source);
  const allLines = redacted.text.split(/\\r?\\n/);
  const hasRange = startLine !== undefined || endLine !== undefined;
  const from = hasRange ? clampInteger(startLine, 1, 1, Math.max(1, allLines.length)) : 1;
  const to = hasRange ? clampInteger(endLine, from, from, Math.max(from, allLines.length)) : allLines.length;
  const selectedText = hasRange ? allLines.slice(from - 1, to).join("\\n") : redacted.text;
  return {
    path: target.relativePath,
    size: fileStat.size,
    sha256,
    binary: false,
    text: selectedText.slice(0, limit),
    startLine: hasRange ? from : undefined,
    endLine: hasRange ? to : undefined,
    totalLines: allLines.length,
    truncated: selectedText.length > limit,
    redacted: redacted.redacted
  };
}

export async function searchFiles({ query, directory, maxResults } = {}) {
  const textQuery = typeof query === "string" ? query.trim() : "";
  if (!textQuery) throw new Error("Search query is required.");
  const target = safeRelativePath(directory);
  const limit = clampInteger(maxResults, 50, 1, 100);
  const files = (await collectFiles()).filter((file) => isInsideDirectory(file.path, target.relativePath));
  const lowerQuery = textQuery.toLowerCase();
  const matches = [];
  for (const file of files) {
    if (matches.length >= limit) break;
    if (file.path.toLowerCase().includes(lowerQuery)) matches.push({ path: file.path, match: "path" });
    if (matches.length >= limit || file.binary || file.size > 500000) continue;
    const raw = await readFile(path.join(PROJECT_ROOT, file.path)).catch(() => null);
    if (!raw) continue;
    const redacted = redactSensitiveText(raw.subarray(0, Math.min(raw.length, 500000)).toString("utf8"));
    const lines = redacted.text.split(/\\r?\\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(lowerQuery)) continue;
      matches.push({ path: file.path, line: index + 1, text: line.length > 300 ? \`\${line.slice(0, 300)}...\` : line, match: "content", redacted: redacted.redacted });
      if (matches.length >= limit) break;
    }
  }
  return { query: textQuery, directory: target.relativePath, matches, omitted: Math.max(0, files.length - matches.length), note: "Search skips binary files and heavyweight ignored directories." };
}

export function cliArgs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("args must be an array of strings.");
  if (value.length > MAX_CLI_ARGS) throw new Error("Too many arguments.");
  return value.map((arg) => {
    if (typeof arg !== "string") throw new Error("args must be an array of strings.");
    if (arg.includes("\\0")) throw new Error("Arguments cannot contain NUL bytes.");
    if (/^[A-Za-z]:[\\\\/]/.test(arg) || path.posix.isAbsolute(arg) || path.win32.isAbsolute(arg)) throw new Error("Use project-relative paths, not absolute paths.");
    if (arg.replace(/\\\\/g, "/").split("/").includes("..")) throw new Error("Parent-directory paths are not allowed.");
    if (arg.length > 500) throw new Error("One argument is too long.");
    return arg;
  });
}

export function firstVerb(args) {
  return args.find((arg) => arg && !arg.startsWith("-"))?.toLowerCase() || "";
}

export function versionOnly(args) {
  return args.length === 1 && ["--version", "-version", "-v", "-V"].includes(args[0] || "");
}

export function denyArgs(args, denied) {
  const lowered = args.map((arg) => arg.toLowerCase());
  for (const item of denied) {
    if (lowered.some((arg) => arg === item || arg.startsWith(item + "="))) throw new Error("Argument " + item + " is not allowed in the read-only CLI inspector.");
  }
}

export function requireAllowedVerb(command, args, allowed, denied = []) {
  const verb = firstVerb(args);
  if (!verb) throw new Error(command + " requires a read-only subcommand or version flag.");
  if (denied.includes(verb)) throw new Error(command + " " + verb + " is not allowed in the read-only CLI inspector.");
  if (!allowed.includes(verb)) throw new Error(command + " " + verb + " is not in the read-only CLI allowlist.");
  return verb;
}

export function validateCli(command, args) {
  if (!CLI_COMMANDS.includes(command)) throw new Error(command + " is not in the read-only CLI allowlist.");
  if (command !== "./gradlew" && /[\\\\/]/.test(command)) throw new Error("Command must be an allowlisted executable name, not a path.");
  const key = command.toLowerCase();
  const deniedWrites = ["add", "apply", "build", "clean", "create", "delete", "deploy", "destroy", "exec", "install", "kill", "login", "logout", "publish", "push", "remove", "restart", "restore", "run", "start", "stop", "test", "uninstall", "update", "upgrade", "write"];

  if (key === "git") {
    denyArgs(args, ["-c", "-C", "--git-dir", "--work-tree", "--exec-path", "--output", "--upload-pack", "--receive-pack", "--ext-diff", "--textconv"]);
    requireAllowedVerb(command, args, ["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "describe", "remote", "blame", "grep"], ["add", "am", "apply", "bisect", "checkout", "cherry-pick", "clean", "clone", "commit", "config", "fetch", "gc", "init", "merge", "mv", "pull", "push", "rebase", "reset", "restore", "rm", "stash", "submodule", "switch", "tag", "worktree"]);
    return;
  }
  if (key === "rg") {
    denyArgs(args, ["--pre", "--pre-glob"]);
    return;
  }
  if (["node", "rustc", "java", "javac", "php", "ruby", "vite", "astro", "svelte-kit", "vue-tsc"].includes(key)) {
    if (!versionOnly(args)) throw new Error(command + " is limited to version inspection.");
    return;
  }
  if (key === "next") {
    if (!versionOnly(args) && !(args.length === 1 && args[0] === "info")) throw new Error("next is limited to --version or info.");
    return;
  }
  if (key === "tsc") {
    if (!versionOnly(args) && !(args.length === 1 && args[0] === "--showConfig")) throw new Error("tsc is limited to --version or --showConfig.");
    return;
  }
  if (key === "eslint") {
    if (!versionOnly(args) && args[0] !== "--print-config") throw new Error("eslint is limited to --version or --print-config.");
    return;
  }
  if (key === "prettier") {
    if (!versionOnly(args) && args[0] !== "--find-config-path") throw new Error("prettier is limited to --version or --find-config-path.");
    return;
  }
  if (key === "npm") {
    if (args.length === 1 && args[0] === "--version") return;
    const verb = requireAllowedVerb(command, args, ["version", "pkg", "ls", "list", "root"], deniedWrites.concat(["audit", "ci", "config", "dedupe", "exec", "explore", "fund", "init", "link", "outdated", "pack", "prefix", "rebuild", "repo", "set", "shrinkwrap", "star", "stars", "token", "unpublish"]));
    if (verb === "pkg" && args[1] !== "get") throw new Error("npm pkg is limited to pkg get.");
    return;
  }
  if (key === "pnpm") {
    if (versionOnly(args)) return;
    requireAllowedVerb(command, args, ["list", "ls", "why"], deniedWrites.concat(["add", "audit", "config", "deploy", "dlx", "exec", "fetch", "import", "init", "install", "link", "outdated", "patch", "publish", "rebuild", "remove", "setup", "store", "unlink"]));
    return;
  }
  if (key === "yarn") {
    if (versionOnly(args)) return;
    requireAllowedVerb(command, args, ["list", "why", "info"], deniedWrites.concat(["add", "audit", "config", "create", "dlx", "exec", "init", "install", "link", "node", "npm", "pack", "patch", "plugin", "rebuild", "remove", "run", "set", "unlink", "up", "upgrade"]));
    return;
  }
  if (key === "bun") {
    if (versionOnly(args)) return;
    const verb = requireAllowedVerb(command, args, ["pm"], deniedWrites.concat(["add", "build", "create", "install", "link", "publish", "remove", "run", "test", "update", "upgrade", "x"]));
    if (verb === "pm" && !["ls", "why"].includes((args[1] || "").toLowerCase())) throw new Error("bun pm is limited to ls/why.");
    return;
  }
  if (key === "deno") {
    if (!versionOnly(args) && firstVerb(args) !== "info") throw new Error("deno is limited to --version or info.");
    return;
  }
  if (["python", "python3"].includes(key)) {
    if (!versionOnly(args)) throw new Error(command + " is limited to --version.");
    return;
  }
  if (["pip", "pip3"].includes(key)) {
    requireAllowedVerb(command, args, ["list", "show", "freeze"], deniedWrites.concat(["cache", "config", "download", "install", "uninstall", "wheel"]));
    return;
  }
  if (key === "uv") {
    if (versionOnly(args)) return;
    const verb = requireAllowedVerb(command, args, ["pip"], deniedWrites.concat(["add", "build", "cache", "init", "lock", "publish", "remove", "run", "sync", "tool", "venv"]));
    if (verb === "pip" && !["list", "show", "freeze"].includes((args[1] || "").toLowerCase())) throw new Error("uv pip is limited to list/show/freeze.");
    return;
  }
  if (key === "poetry") {
    if (versionOnly(args)) return;
    requireAllowedVerb(command, args, ["show", "check"], deniedWrites.concat(["add", "build", "config", "env", "export", "init", "install", "lock", "new", "publish", "remove", "run", "self", "shell", "update"]));
    return;
  }
  if (key === "go") {
    requireAllowedVerb(command, args, ["version", "env", "list"], deniedWrites.concat(["build", "clean", "doc", "fmt", "generate", "get", "install", "mod", "run", "test", "tool", "work"]));
    return;
  }
  if (key === "cargo") {
    if (versionOnly(args)) return;
    requireAllowedVerb(command, args, ["metadata", "tree", "locate-project", "pkgid"], deniedWrites.concat(["add", "bench", "build", "check", "clean", "doc", "fix", "generate-lockfile", "install", "login", "new", "owner", "package", "publish", "remove", "run", "search", "test", "update", "vendor", "yank"]));
    return;
  }
  if (key === "mvn") {
    if (versionOnly(args) || (args.length === 1 && args[0] === "--version")) return;
    requireAllowedVerb(command, args, ["help:evaluate", "dependency:tree", "dependency:list", "validate"], deniedWrites.concat(["clean", "compile", "deploy", "exec:java", "install", "package", "site", "spring-boot:run", "test", "verify"]));
    return;
  }
  if (key === "gradle" || command === "./gradlew") {
    if (versionOnly(args) || (args.length === 1 && args[0] === "--version")) return;
    requireAllowedVerb(command, args, ["projects", "dependencies", "properties", "tasks"], deniedWrites.concat(["assemble", "build", "clean", "compilejava", "init", "install", "publish", "run", "test", "wrapper"]));
    return;
  }
  if (key === "dotnet") {
    if (args[0]?.startsWith("--")) {
      if (!["--info", "--version", "--list-sdks", "--list-runtimes"].includes(args[0])) throw new Error("dotnet flag is not allowed.");
      return;
    }
    const verb = requireAllowedVerb(command, args, ["list", "sln", "workload"], deniedWrites.concat(["add", "build", "clean", "new", "nuget", "pack", "publish", "remove", "restore", "run", "test", "tool"]));
    if (verb === "list" && !["package", "reference"].includes((args[1] || "").toLowerCase())) throw new Error("dotnet list is limited to package/reference.");
    if (verb === "sln" && (args[1] || "").toLowerCase() !== "list") throw new Error("dotnet sln is limited to sln list.");
    if (verb === "workload" && (args[1] || "").toLowerCase() !== "list") throw new Error("dotnet workload is limited to workload list.");
    return;
  }
  if (key === "composer") {
    if (versionOnly(args)) return;
    requireAllowedVerb(command, args, ["show", "validate", "licenses"], deniedWrites.concat(["archive", "clear-cache", "config", "create-project", "dump-autoload", "exec", "global", "init", "install", "reinstall", "remove", "require", "run-script", "update"]));
    return;
  }
  if (key === "bundle") {
    if (versionOnly(args)) return;
    requireAllowedVerb(command, args, ["list", "info", "show", "platform"], deniedWrites.concat(["add", "cache", "clean", "config", "exec", "gem", "init", "install", "inject", "lock", "open", "remove", "update"]));
    return;
  }
  if (key === "flutter") {
    if (versionOnly(args)) return;
    const verb = requireAllowedVerb(command, args, ["doctor", "pub"], deniedWrites.concat(["assemble", "attach", "build", "clean", "config", "create", "devices", "drive", "emulators", "gen-l10n", "install", "precache", "run", "screenshot", "test", "upgrade"]));
    if (verb === "pub" && !["deps", "outdated"].includes((args[1] || "").toLowerCase())) throw new Error("flutter pub is limited to deps/outdated.");
    return;
  }
  if (key === "dart") {
    if (versionOnly(args)) return;
    const verb = requireAllowedVerb(command, args, ["pub"], deniedWrites.concat(["analyze", "compile", "create", "doc", "fix", "format", "run", "test"]));
    if (verb === "pub" && !["deps", "outdated"].includes((args[1] || "").toLowerCase())) throw new Error("dart pub is limited to deps/outdated.");
    return;
  }
  if (key === "xcodebuild") {
    if (!args.length || !["-version", "-list", "-showbuildsettings", "-showsdks"].includes((args[0] || "").toLowerCase())) throw new Error("xcodebuild is limited to read-only info flags.");
    return;
  }
  if (key === "swift") {
    if (versionOnly(args)) return;
    const verb = requireAllowedVerb(command, args, ["package"], deniedWrites.concat(["build", "run", "test"]));
    if (verb === "package" && !["describe", "dump-package", "show-dependencies"].includes((args[1] || "").toLowerCase())) throw new Error("swift package is limited to describe/dump-package/show-dependencies.");
    return;
  }
  if (key === "pod") {
    if (versionOnly(args)) return;
    requireAllowedVerb(command, args, ["ipc", "env", "list"], deniedWrites.concat(["cache", "deintegrate", "init", "install", "lib", "outdated", "repo", "setup", "spec", "trunk", "try", "update"]));
    return;
  }
  if (key === "adb") {
    requireAllowedVerb(command, args, ["version", "devices"], deniedWrites.concat(["install", "push", "pull", "reboot", "remount", "root", "shell", "sideload", "sync", "uninstall"]));
    return;
  }
  if (key === "emulator") {
    if (!(args.length === 1 && args[0] === "-list-avds")) throw new Error("emulator is limited to -list-avds.");
    return;
  }
  if (key === "docker") {
    if (versionOnly(args)) return;
    const verb = requireAllowedVerb(command, args, ["version", "info", "ps", "images", "inspect", "compose"], deniedWrites.concat(["attach", "build", "commit", "container", "cp", "create", "exec", "export", "image", "import", "kill", "load", "login", "logout", "network", "pause", "plugin", "pull", "push", "rename", "restart", "rm", "rmi", "run", "save", "start", "stop", "swarm", "system", "tag", "unpause", "volume"]));
    if (verb === "compose" && !["version", "config", "ls", "ps"].includes((args[1] || "").toLowerCase())) throw new Error("docker compose is limited to version/config/ls/ps.");
    return;
  }
  if (key === "kubectl") {
    requireAllowedVerb(command, args, ["version", "config", "get", "describe", "api-resources", "api-versions", "explain"], deniedWrites.concat(["annotate", "apply", "attach", "auth", "autoscale", "completion", "cordon", "cp", "create", "delete", "drain", "edit", "exec", "expose", "label", "logs", "patch", "port-forward", "proxy", "replace", "rollout", "run", "scale", "set", "taint", "top", "uncordon"]));
    return;
  }
  if (key === "terraform") {
    if (versionOnly(args) || firstVerb(args) === "version") return;
    const verb = requireAllowedVerb(command, args, ["providers", "state", "show"], deniedWrites.concat(["apply", "destroy", "fmt", "force-unlock", "get", "import", "init", "login", "logout", "output", "plan", "refresh", "taint", "untaint", "validate", "workspace"]));
    if (verb === "state" && (args[1] || "").toLowerCase() !== "list") throw new Error("terraform state is limited to state list.");
    return;
  }
  if (key === "helm") {
    requireAllowedVerb(command, args, ["version", "list", "template", "show"], deniedWrites.concat(["create", "dependency", "env", "get", "history", "install", "lint", "package", "plugin", "pull", "push", "registry", "repo", "rollback", "status", "test", "uninstall", "upgrade"]));
    return;
  }
  if (key === "find") {
    if (args.some((arg) => ["-exec", "-execdir", "-delete", "-ok", "-okdir"].includes(arg))) throw new Error("find exec/delete actions are not allowed.");
    return;
  }
  if (["ls", "wc", "file", "du", "cat", "head", "tail", "where", "dir", "type", "findstr"].includes(key)) return;
  if (key === "sw_vers") {
    if (args.length) throw new Error("sw_vers takes no arguments here.");
    return;
  }
  if (key === "xcrun") {
    if (versionOnly(args)) return;
    const verb = requireAllowedVerb(command, args, ["simctl"], deniedWrites);
    if (verb === "simctl" && (args[1] || "").toLowerCase() !== "list") throw new Error("xcrun simctl is limited to list.");
    return;
  }
  if (key === "plutil") {
    if (!["-p", "-lint"].includes(args[0] || "")) throw new Error("plutil is limited to -p or -lint.");
    return;
  }
  if (key === "defaults") {
    if ((args[0] || "").toLowerCase() !== "read") throw new Error("defaults is limited to read.");
    return;
  }
  if (key === "msbuild") {
    if (!versionOnly(args)) throw new Error("msbuild is limited to version inspection.");
    return;
  }
  throw new Error(command + " is not implemented in the read-only CLI validator.");
}

export async function inspectCli({ command, args, cwd, timeoutMs, maxChars } = {}) {
  const executable = typeof command === "string" ? command.trim() : "";
  if (!executable) throw new Error("command is required.");
  const commandArgs = cliArgs(args);
  validateCli(executable, commandArgs);
  const targetCwd = safeRelativePath(cwd);
  const cwdStat = await stat(targetCwd.absolutePath).catch(() => null);
  if (!cwdStat?.isDirectory()) throw new Error("cwd must be a project-relative directory.");
  const timeout = clampInteger(timeoutMs, 10000, 1000, MAX_CLI_TIMEOUT_MS);
  const limit = clampInteger(maxChars, 30000, 1000, MAX_CLI_OUTPUT_CHARS);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const child = spawn(executable, commandArgs, {
      cwd: targetCwd.absolutePath,
      shell: false,
      env: { ...process.env, CI: "true", NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" }
    });
    const append = (current, chunk, markTruncated) => {
      if (current.length >= limit) {
        markTruncated();
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > limit) {
        markTruncated();
        return next.slice(0, limit);
      }
      return next;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, () => { stdoutTruncated = true; }); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, () => { stderrTruncated = true; }); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command: executable, args: commandArgs, cwd: targetCwd.relativePath, status: "failed", exitCode: null, timedOut: false, stdout: "", stderr: error.message });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const redactedStdout = redactSensitiveText(stdout);
      const redactedStderr = redactSensitiveText(stderr);
      const verb = commandArgs.find((arg) => arg && !arg.startsWith("-"))?.toLowerCase() || "";
      const expectedNoRepo = !timedOut &&
        exitCode !== 0 &&
        executable.toLowerCase() === "git" &&
        ["status", "rev-parse", "branch", "log", "diff", "show", "ls-files"].includes(verb) &&
        /not a git repository|not a git repo|no git repository/i.test(redactedStderr.text);
      resolve({
        command: executable,
        args: commandArgs,
        cwd: targetCwd.relativePath,
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

export function asContent(result) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export const server = new McpServer({ name: "archicode-project-files", version: "1.0.0" });
server.registerTool("archicode_project_list_files", {
  description: "List files and directories inside the current project root.",
  inputSchema: {
    directory: z.string().optional(),
    recursive: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(MAX_RESULTS).optional()
  }
}, async (args) => asContent(await listFiles(args)));
server.registerTool("archicode_project_search_files", {
  description: "Search readable project files by path and text content.",
  inputSchema: {
    query: z.string().min(1),
    directory: z.string().optional(),
    maxResults: z.number().int().min(1).max(100).optional()
  }
}, async (args) => asContent(await searchFiles(args)));
server.registerTool("archicode_project_read_file", {
  description: "Read a project-relative file, optionally from startLine to endLine. Returns the current file sha256 for replace operations. Secrets are redacted and long files are truncated.",
  inputSchema: {
    path: z.string().min(1),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    maxChars: z.number().int().min(1).max(MAX_READ_CHARS).optional()
  }
}, async (args) => asContent(await readProjectFile(args)));
await server.connect(new StdioServerTransport());
`;
}

export function createCodexLocalTokenStreamer(onToken: ((text: string, kind?: ProviderTokenKind) => void) | undefined): (chunk: string) => void {
  if (!onToken) return () => undefined;
  let buffer = "";
  let lastFullText = "";
  let lastFullKind: ProviderTokenKind = "answer";
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = codexJsonEventText(line);
      if (!text) continue;
      if (text.kind === "delta") {
        onToken(text.value, text.tokenKind);
        continue;
      }
      if (text.tokenKind === lastFullKind && text.value.startsWith(lastFullText)) {
        const delta = text.value.slice(lastFullText.length);
        if (delta) onToken(delta, text.tokenKind);
      } else {
        onToken(text.value, text.tokenKind);
      }
      lastFullText = text.value;
      lastFullKind = text.tokenKind;
    }
  };
}

/**
 * Codex --json emits agent messages as item.completed events. A CLI turn can
 * finish with an empty agent_message even though an earlier message contains
 * ArchiCode's structured tool envelope, so --output-last-message may be empty.
 * Recover the last non-empty agent message before falling back to raw stdout.
 */
export function codexLocalFinalMessage(outputFile: string, stdout: string): string {
  const stored = outputFile.trim();
  const parseJsonl = (value: string): { lastAgentMessage: string; sawCodexEvent: boolean } => {
    let lastAgentMessage = "";
    let sawCodexEvent = false;
    for (const line of value.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const eventType = typeof event.type === "string" ? event.type : "";
        if (eventType === "thread.started" || eventType === "turn.started" || eventType === "turn.completed" || eventType === "item.completed") {
          sawCodexEvent = true;
        }
        if (event.type !== "item.completed" || !event.item || typeof event.item !== "object") continue;
        const item = event.item as Record<string, unknown>;
        if (item.type !== "agent_message" || typeof item.text !== "string" || !item.text.trim()) continue;
        lastAgentMessage = item.text.trim();
      } catch {
        // Plain-text output is handled by the caller's fallback.
      }
    }
    return { lastAgentMessage, sawCodexEvent };
  };

  const storedJsonl = parseJsonl(stored);
  if (storedJsonl.lastAgentMessage) return storedJsonl.lastAgentMessage;
  if (stored && !storedJsonl.sawCodexEvent) return stored;

  const stdoutJsonl = parseJsonl(stdout);
  if (stdoutJsonl.lastAgentMessage) return stdoutJsonl.lastAgentMessage;
  return stdoutJsonl.sawCodexEvent ? "" : stdout.trim();
}

export function createClaudeLocalTokenStreamer(onToken?: (text: string, kind?: ProviderTokenKind) => void): {
  (chunk: string): void;
  finalText(): string;
} {
  let buffer = "";
  let latestAnswerText = "";
  let latestThinkingText = "";

  const processLines = (lines: string[]): void => {
    for (const line of lines) {
      const text = claudeJsonEventText(line);
      if (!text) continue;
      if (text.tokenKind === "thinking") {
        latestThinkingText = emitLocalCliJsonText(text, latestThinkingText, onToken);
      } else {
        latestAnswerText = emitLocalCliJsonText(text, latestAnswerText, onToken);
      }
    }
  };

  const push = (chunk: string): void => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    processLines(lines);
  };

  push.finalText = (): string => {
    if (buffer.trim()) {
      processLines([buffer]);
      buffer = "";
    }
    return latestAnswerText || latestThinkingText;
  };
  return push;
}

export function openCodeJsonEvent(line: string): { text?: { tokenKind: ProviderTokenKind; value: string }; sessionId?: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const event = JSON.parse(trimmed) as Record<string, unknown>;
    const sessionId = typeof event.sessionID === "string" ? event.sessionID : undefined;
    const type = typeof event.type === "string" ? event.type : "";
    if (type !== "text" && type !== "reasoning") return sessionId ? { sessionId } : null;
    const part = event.part && typeof event.part === "object" ? event.part as Record<string, unknown> : undefined;
    const value = typeof part?.text === "string" ? part.text : typeof event.text === "string" ? event.text : "";
    return {
      sessionId,
      ...(value ? { text: { tokenKind: type === "reasoning" ? "thinking" : "answer", value } } : {})
    };
  } catch {
    return null;
  }
}

export function createOpenCodeLocalTokenStreamer(onToken?: (text: string, kind?: ProviderTokenKind) => void): {
  (chunk: string): void;
  finalText(): string;
  sessionId(): string | undefined;
} {
  let buffer = "";
  let answer = "";
  let thinking = "";
  let currentSessionId: string | undefined;
  const processLines = (lines: string[]): void => {
    for (const line of lines) {
      const event = openCodeJsonEvent(line);
      if (!event) continue;
      if (event.sessionId) currentSessionId = event.sessionId;
      if (!event.text) continue;
      if (event.text.tokenKind === "thinking") thinking += event.text.value;
      else answer += event.text.value;
      onToken?.(event.text.value, event.text.tokenKind);
    }
  };
  const push = (chunk: string): void => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    processLines(lines);
  };
  const flush = (): void => {
    if (!buffer.trim()) return;
    processLines([buffer]);
    buffer = "";
  };
  push.finalText = () => {
    flush();
    return (answer || thinking).trim();
  };
  push.sessionId = () => {
    flush();
    return currentSessionId;
  };
  return push;
}

export async function cleanupOpenCodeSession(command: string, sessionId: string | undefined, cwd: string | undefined, enabled: boolean): Promise<void> {
  if (!enabled || !sessionId) return;
  try {
    await runLocalProcess(command, ["session", "delete", sessionId], "", cwd, undefined, undefined, { inactivityTimeoutMs: 30_000 });
  } catch {
    // Session cleanup is best-effort and must not hide a completed provider response.
  }
}

export function emitLocalCliJsonText(
  text: { kind: "delta" | "full"; tokenKind: ProviderTokenKind; value: string },
  current: string,
  onToken?: (text: string, kind?: ProviderTokenKind) => void
): string {
  if (text.kind === "delta") {
    if (text.value) onToken?.(text.value, text.tokenKind);
    return current + text.value;
  }
  if (current && current.startsWith(text.value)) {
    return current;
  }
  const delta = text.value.startsWith(current) ? text.value.slice(current.length) : text.value;
  if (delta) onToken?.(delta, text.tokenKind);
  return text.value;
}

export function codexJsonEventText(line: string): { kind: "delta" | "full"; tokenKind: ProviderTokenKind; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  return codexJsonEventTextFromValue(parsed, "");
}

export function claudeJsonEventText(line: string): { kind: "delta" | "full"; tokenKind: ProviderTokenKind; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  return claudeJsonEventTextFromValue(parsed, "");
}

export function claudeJsonEventTextFromValue(value: unknown, inheritedType: string): { kind: "delta" | "full"; tokenKind: ProviderTokenKind; value: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const eventType = [
    inheritedType,
    typeof record.type === "string" ? record.type : "",
    typeof record.subtype === "string" ? record.subtype : "",
    typeof record.role === "string" ? record.role : ""
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const thinkingLike = /(reasoning|thought|thinking)/.test(eventType);
  const tokenKind: ProviderTokenKind = thinkingLike ? "thinking" : "answer";
  const assistantLike = thinkingLike || (
    /(assistant|message|result|output|content|text)/.test(eventType) &&
    !/(tool|permission|error|stderr|user|system|hook|mcp)/.test(eventType)
  );
  const deltaLike = /(delta|chunk|partial)/.test(eventType) || /content[_ ]?block[_ ]?start/.test(eventType);
  const fieldNames = deltaLike
    ? ["delta", "text_delta", "content_delta", "message_delta", "content_block", "contentBlock", "text", "content", "message", "result"]
    : ["text", "content", "message", "result", "output", "content_block", "contentBlock"];

  if (assistantLike) {
    for (const field of fieldNames) {
      const fieldValue = record[field];
      if (typeof fieldValue === "string" && fieldValue) {
        return { kind: deltaLike ? "delta" : "full", tokenKind, value: fieldValue };
      }
      const nestedText = textFromContentParts(fieldValue);
      if (nestedText) return { kind: deltaLike ? "delta" : "full", tokenKind, value: nestedText };
      const nestedRecordText = textFromNestedTextRecord(fieldValue);
      if (nestedRecordText) return { kind: deltaLike ? "delta" : "full", tokenKind, value: nestedRecordText };
    }
  }

  for (const field of ["message", "delta", "result", "content", "content_block", "contentBlock", "content_blocks", "data", "payload", "item", "event"]) {
    const nested = record[field];
    const text = claudeJsonEventTextFromValue(nested, eventType);
    if (text) return text;
  }
  return null;
}

export function codexJsonEventTextFromValue(value: unknown, inheritedType: string): { kind: "delta" | "full"; tokenKind: ProviderTokenKind; value: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const eventType = [inheritedType, typeof record.type === "string" ? record.type : "", typeof record.role === "string" ? record.role : ""]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const thinkingLike = /(reasoning|thought|thinking)/.test(eventType);
  const assistantLike = thinkingLike || (/(assistant|agent|answer|output|message)/.test(eventType) && !/(command|exec|tool|stderr|error)/.test(eventType));
  const deltaLike = /(delta|chunk)/.test(eventType);
  const fieldNames = deltaLike
    ? ["delta", "text_delta", "content_delta", "message_delta", "text", "content", "message"]
    : ["text", "content", "message", "output"];
  const tokenKind: ProviderTokenKind = "thinking";

  if (assistantLike) {
    for (const field of fieldNames) {
      const fieldValue = record[field];
      if (typeof fieldValue === "string" && fieldValue) {
        return { kind: deltaLike ? "delta" : "full", tokenKind, value: fieldValue };
      }
      const nestedText = textFromContentParts(fieldValue);
      if (nestedText) return { kind: deltaLike ? "delta" : "full", tokenKind, value: nestedText };
    }
  }

  for (const field of ["msg", "event", "item", "data", "payload", "message", "delta"]) {
    const nested = record[field];
    const text = codexJsonEventTextFromValue(nested, eventType);
    if (text) return text;
  }
  return null;
}

export function textFromContentParts(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object") {
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
    }
    return "";
  }).join("");
}

export function textFromNestedTextRecord(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (typeof record.message === "string") return record.message;
  if (typeof record.result === "string") return record.result;
  return textFromContentParts(record.content);
}

function codexLocalImageArgs(images: ProviderCallOptions["imageAttachments"]): string[] {
  const paths = [...new Set((images ?? []).map((image) => image.path.trim()).filter(Boolean))];
  return paths.flatMap((imagePath) => ["--image", imagePath]);
}

export function buildCodexLocalArgs(provider: Provider, options: ProviderCallOptions, outputPath: string): string[] {
  const args = [
    "--ask-for-approval",
    "never",
    ...(options.webSearchEnabled ? ["--search"] : ["--config", "web_search=\"disabled\""]),
    ...(provider.outputVerbosity ? ["--config", `model_verbosity="${provider.outputVerbosity}"`] : []),
    ...disableInheritedArchicodeMcpArgs(),
    ...codexMcpConfigArgs(options.mcpServers),
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--color",
    "never",
    "--sandbox",
    provider.localSandbox ?? "read-only",
    "--output-last-message",
    outputPath,
    ...codexLocalImageArgs(options.imageAttachments)
  ];

  if (provider.ephemeral !== false) args.push("--ephemeral");
  const model = resolvePhaseModelPolicy(provider, options.phase ?? "planning").modelOverride?.trim() || provider.model?.trim();
  if (model) args.push("--model", model);
  if (provider.localProfile?.trim()) args.push("--profile", provider.localProfile.trim());
  if (options.projectRoot) args.push("--cd", options.projectRoot);
  args.push("-");
  return args;
}

export const codexLocalResearchOutputSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["archicodeResearchTurn"],
  properties: {
    archicodeResearchTurn: {
      type: "object",
      additionalProperties: false,
      required: ["answer", "toolCalls"],
      properties: {
        answer: { type: "string" },
        toolCalls: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "providerToolName", "arguments"],
            properties: {
              id: { type: "string" },
              providerToolName: { type: "string" },
              arguments: {
                type: "string",
                description: "A JSON-encoded object satisfying the selected tool's arguments schema."
              }
            }
          }
        }
      }
    }
  }
} as const;

export function buildCodexLocalResearchArgs(
  provider: Provider,
  options: ResearchProviderOptions,
  outputPath: string,
  outputSchemaPath?: string
): string[] {
  const args = [
    "--ask-for-approval",
    "never",
    ...(options.webSearchEnabled ? ["--search"] : ["--config", "web_search=\"disabled\""]),
    ...(provider.outputVerbosity ? ["--config", `model_verbosity="${provider.outputVerbosity}"`] : []),
    ...disableInheritedArchicodeMcpArgs(),
    ...codexMcpConfigArgs(options.mcpServers),
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputPath,
    ...(outputSchemaPath ? ["--output-schema", outputSchemaPath] : []),
    ...codexLocalImageArgs(options.imageAttachments)
  ];

  if (provider.ephemeral !== false) args.push("--ephemeral");
  const model = resolvePhaseModelPolicy(provider, "brainstorming").modelOverride?.trim() || provider.model?.trim();
  if (model) args.push("--model", model);
  if (provider.localProfile?.trim()) args.push("--profile", provider.localProfile.trim());
  if (options.projectRoot) args.push("--cd", options.projectRoot);
  args.push("-");
  return args;
}

export type ClaudeLocalArgOptions = {
  mcpConfigPath?: string;
  allowedToolPatterns?: string[];
};

export function claudePermissionMode(provider: Provider, phase: LlmPhase | "research"): "acceptEdits" | "bypassPermissions" | "dontAsk" {
  if (phase === "planning" || phase === "review" || phase === "summarizing" || phase === "brainstorming" || phase === "research") {
    return "dontAsk";
  }
  if (provider.localSandbox === "danger-full-access") return "bypassPermissions";
  if (provider.localSandbox === "workspace-write") return "acceptEdits";
  return "dontAsk";
}

export function claudeLocalWriteAllowed(provider: Provider, phase: LlmPhase): boolean {
  return (phase === "coding" || phase === "debugging" || phase === "verifying") && provider.localSandbox !== "read-only";
}

export function claudeCodingAllowedTools(mcpToolPatterns: string[], phase: LlmPhase, writeAllowed: boolean): string[] {
  const readOnlyTools = ["Read", "Glob", "NotebookRead", "Bash"];
  if (!writeAllowed) return [...readOnlyTools, ...mcpToolPatterns];
  if (phase === "planning" || phase === "review" || phase === "summarizing") return [...readOnlyTools, ...mcpToolPatterns];
  return ["Read", "Write", "Edit", "Glob", "NotebookRead", "NotebookEdit", "Bash", ...mcpToolPatterns];
}

export function claudeResearchAllowedTools(mcpToolPatterns: string[], webSearchEnabled: boolean): string[] {
  return [
    ...mcpToolPatterns,
    ...(webSearchEnabled ? ["WebSearch", "WebFetch(domain:*)"] : [])
  ];
}

export function buildClaudeLocalArgs(provider: Provider, options: ProviderCallOptions, localOptions: ClaudeLocalArgOptions = {}): string[] {
  const phase = options.phase ?? "planning";
  const permissionMode = claudePermissionMode(provider, phase);
  const args = [
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    permissionMode
  ];

  if (permissionMode === "bypassPermissions") args.push("--allow-dangerously-skip-permissions");
  if (provider.ephemeral !== false) args.push("--no-session-persistence");
  if (localOptions.mcpConfigPath) {
    args.push("--mcp-config", localOptions.mcpConfigPath, "--strict-mcp-config");
  }
  const allowedTools = claudeCodingAllowedTools(localOptions.allowedToolPatterns ?? [], phase, claudeLocalWriteAllowed(provider, phase));
  if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
  const model = resolvePhaseModelPolicy(provider, phase).modelOverride?.trim() || provider.model?.trim();
  if (model) args.push("--model", model);
  if (provider.localProfile?.trim()) args.push("--settings", provider.localProfile.trim());
  if (options.projectRoot) {
    args.push("--add-dir", options.projectRoot);
  }
  args.push("-");
  return args;
}

export function buildClaudeLocalResearchArgs(provider: Provider, options: ResearchProviderOptions, localOptions: ClaudeLocalArgOptions = {}): string[] {
  const args = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    claudePermissionMode(provider, "research")
  ];

  if (provider.ephemeral !== false) args.push("--no-session-persistence");
  if (localOptions.mcpConfigPath) {
    args.push("--mcp-config", localOptions.mcpConfigPath, "--strict-mcp-config");
  }
  const allowedTools = claudeResearchAllowedTools(localOptions.allowedToolPatterns ?? [], Boolean(options.webSearchEnabled));
  if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
  const model = resolvePhaseModelPolicy(provider, "brainstorming").modelOverride?.trim() || provider.model?.trim();
  if (model) args.push("--model", model);
  if (provider.localProfile?.trim()) args.push("--settings", provider.localProfile.trim());
  if (options.projectRoot) {
    args.push("--add-dir", options.projectRoot);
  }
  args.push("-");
  return args;
}

export function codexMcpConfigArgs(servers: McpServer[] | undefined): string[] {
  const args: string[] = [];
  const usedNames = new Set<string>();
  for (const server of servers ?? []) {
    if (!server.enabled || !server.trusted) continue;
    const name = uniqueCodexMcpName(server.id || server.label, usedNames);
    if (server.transport === "streamable-http") {
      if (!server.url?.trim()) continue;
      args.push("--config", `mcp_servers.${name}.url=${tomlValue(server.url.trim())}`);
      if (server.defaultToolsApprovalMode) {
        args.push("--config", `mcp_servers.${name}.default_tools_approval_mode=${tomlValue(server.defaultToolsApprovalMode)}`);
      }
      continue;
    }
    if (!server.command?.trim()) continue;
    args.push("--config", `mcp_servers.${name}.command=${tomlValue(server.command.trim())}`);
    args.push("--config", `mcp_servers.${name}.args=${tomlValue(server.args ?? [])}`);
    if (server.cwd?.trim()) args.push("--config", `mcp_servers.${name}.cwd=${tomlValue(server.cwd.trim())}`);
    if (server.defaultToolsApprovalMode) {
      args.push("--config", `mcp_servers.${name}.default_tools_approval_mode=${tomlValue(server.defaultToolsApprovalMode)}`);
    }
    const envEntries = (server.env ?? []).filter((entry) => entry.name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name));
    for (const entry of envEntries) {
      args.push("--config", `mcp_servers.${name}.env.${entry.name}=${tomlValue(entry.value ?? "")}`);
    }
  }
  return args;
}

export function disableInheritedArchicodeMcpArgs(): string[] {
  // Codex CLI also loads ~/.codex/config.toml. ArchiCode mounts per-run tools
  // explicitly, so a globally configured ArchiCode HTTP MCP server must not
  // leak into provider runs and spam transport errors when that host is off.
  //
  // Disabling alone is not enough: Codex validates transport presence while
  // parsing config.toml (see openai/codex#29396). A server entry that has no
  // `command` or `url` field throws "invalid transport in `mcp_servers.archicode`"
  // at load time, before the disabled flag is honored. Supplying a harmless
  // dummy url keeps the entry parseable as a valid (but disabled) HTTP
  // transport so the inherited ArchiCode MCP server never actually starts.
  return [
    "--config", "mcp_servers.archicode.enabled=false",
    "--config", "mcp_servers.archicode.url=\"http://127.0.0.1:9/disabled\""
  ];
}

export function claudeMcpConfig(servers: McpServer[] | undefined): ClaudeMcpConfigBuild {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  const allowedToolPatterns: string[] = [];
  const usedNames = new Set<string>();
  for (const server of servers ?? []) {
    if (!server.enabled || !server.trusted) continue;
    const name = uniqueClaudeMcpName(server.id || server.label, usedNames);
    if (server.transport === "streamable-http") {
      if (!server.url?.trim()) continue;
      const headers = Object.fromEntries((server.headers ?? [])
        .filter((header) => header.name && typeof header.value === "string")
        .map((header) => [header.name, header.value as string]));
      mcpServers[name] = Object.keys(headers).length
        ? { type: "http", url: server.url.trim(), headers }
        : { type: "http", url: server.url.trim() };
    } else {
      if (!server.command?.trim()) continue;
      const env = Object.fromEntries((server.env ?? [])
        .filter((entry) => entry.name && typeof entry.value === "string")
        .map((entry) => [entry.name, entry.value as string]));
      mcpServers[name] = {
        type: "stdio",
        command: server.command.trim(),
        args: server.args ?? [],
        ...(Object.keys(env).length ? { env } : {})
      };
    }
    allowedToolPatterns.push(`mcp__${name}__*`);
  }
  return { config: { mcpServers }, allowedToolPatterns };
}

export async function writeClaudeMcpConfig(outputDir: string, build: ClaudeMcpConfigBuild): Promise<string | undefined> {
  if (!Object.keys(build.config.mcpServers).length) return undefined;
  const configPath = path.join(outputDir, "claude-mcp.json");
  await writeFile(configPath, JSON.stringify(build.config, null, 2), "utf8");
  return configPath;
}

export function uniqueClaudeMcpName(seed: string, usedNames: Set<string>): string {
  const base = seed.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "mcp_server";
  let name = base;
  let suffix = 2;
  while (usedNames.has(name)) {
    name = `${base}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(name);
  return name;
}

export function uniqueCodexMcpName(seed: string, usedNames: Set<string>): string {
  const base = seed.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "mcp_server";
  let name = base;
  let suffix = 2;
  while (usedNames.has(name)) {
    name = `${base}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(name);
  return name;
}

export function tomlValue(value: unknown): string {
  return JSON.stringify(value);
}

export async function checkCodexLocal(provider: Provider, checkedAt: string): Promise<ProviderHealthResult> {
  const command = localCliCommand(provider);
  try {
    const result = await runLocalProcess(command, ["--version"], "", undefined);
    if (result.exitCode !== 0) {
      return {
        providerId: provider.id,
        ok: false,
        status: "failed",
        checkedAt,
        message: `Codex CLI check failed: ${result.stderr || result.stdout}`
      };
    }

    const loginStatus = await runLocalProcess(command, ["login", "status"], "", undefined);
    const models = await readCodexLocalModels(command, provider.model);
    const modelDetails = models.detectedContextWindowTokens
      ? ` Detected ${models.detectedContextWindowTokens.toLocaleString()} token context window${models.availableModels.length ? ` across ${models.availableModels.length} local models.` : "."}`
      : "";
    return {
      providerId: provider.id,
      ok: loginStatus.exitCode === 0,
      status: loginStatus.exitCode === 0 ? "ready" : "failed",
      checkedAt,
      message: loginStatus.exitCode === 0
        ? `Codex CLI available and authenticated: ${(loginStatus.stdout || loginStatus.stderr).trim()}${modelDetails}`
        : `Codex CLI is installed (${(result.stdout || result.stderr).trim()}) but login status failed: ${loginStatus.stderr || loginStatus.stdout}`,
      detectedContextWindowTokens: models.detectedContextWindowTokens,
      contextWindowSource: models.detectedContextWindowTokens ? "codex debug models" : undefined,
      availableModels: models.availableModels.length ? models.availableModels : undefined,
      modelListSource: models.availableModels.length ? "codex debug models" : undefined
    };
  } catch (error) {
    return {
      providerId: provider.id,
      ok: false,
      status: "failed",
      checkedAt,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function checkClaudeLocal(provider: Provider, checkedAt: string): Promise<ProviderHealthResult> {
  const command = localCliCommand(provider);
  try {
    const result = await runLocalProcess(command, ["--version"], "", undefined);
    if (result.exitCode !== 0) {
      return {
        providerId: provider.id,
        ok: false,
        status: "failed",
        checkedAt,
        message: `Claude Code CLI check failed: ${result.stderr || result.stdout}`
      };
    }

    const authStatus = await runLocalProcess(command, ["auth", "status"], "", undefined);
    const statusText = (authStatus.stdout || authStatus.stderr).trim();
    let loggedIn = false;
    let authMethod = "";
    try {
      const payload = JSON.parse(statusText) as { loggedIn?: boolean; authMethod?: string };
      loggedIn = Boolean(payload.loggedIn);
      authMethod = payload.authMethod ?? "";
    } catch {
      loggedIn = authStatus.exitCode === 0 && /logged.?in|authenticated|subscription|oauth|token/i.test(statusText);
    }
    return {
      providerId: provider.id,
      ok: loggedIn,
      status: loggedIn ? "ready" : "failed",
      checkedAt,
      message: loggedIn
        ? `Claude Code CLI available and authenticated${authMethod ? ` via ${authMethod}` : ""}. ArchiCode keeps curated fallback model suggestions because the Claude CLI does not expose a machine-readable local model catalog or context window endpoint.`
        : `Claude Code CLI is installed (${(result.stdout || result.stderr).trim()}) but auth status indicates it is not signed in: ${statusText || "unknown auth status"}.`
    };
  } catch (error) {
    return {
      providerId: provider.id,
      ok: false,
      status: "failed",
      checkedAt,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function parseOpenCodeModels(output: string): string[] {
  const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  return [...new Set(output
    .replace(ansi, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(line)))]
    .sort((a, b) => a.localeCompare(b));
}

export async function checkOpenCodeLocal(provider: Provider, checkedAt: string): Promise<ProviderHealthResult> {
  const command = localCliCommand(provider);
  try {
    const version = await runLocalProcess(command, ["--version"], "", undefined, undefined, undefined, { inactivityTimeoutMs: 30_000 });
    if (version.exitCode !== 0) {
      return {
        providerId: provider.id,
        ok: false,
        status: "failed",
        checkedAt,
        message: `OpenCode CLI check failed: ${version.stderr || version.stdout}`
      };
    }
    const catalog = await runLocalProcess(command, ["models"], "", undefined, undefined, undefined, { inactivityTimeoutMs: 60_000 });
    const availableModels = catalog.exitCode === 0 ? parseOpenCodeModels(catalog.stdout) : [];
    return {
      providerId: provider.id,
      ok: catalog.exitCode === 0,
      status: catalog.exitCode === 0 ? "ready" : "failed",
      checkedAt,
      message: catalog.exitCode === 0
        ? `OpenCode CLI is available (${(version.stdout || version.stderr).trim()}) with ${availableModels.length} configured model${availableModels.length === 1 ? "" : "s"}. Authentication is managed by OpenCode.`
        : `OpenCode CLI is installed (${(version.stdout || version.stderr).trim()}) but its model catalog failed: ${catalog.stderr || catalog.stdout}`,
      availableModels: availableModels.length ? availableModels : undefined,
      modelListSource: availableModels.length ? "opencode models" : undefined
    };
  } catch (error) {
    return {
      providerId: provider.id,
      ok: false,
      status: "failed",
      checkedAt,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function parseAntigravityModels(output: string): string[] {
  const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  return [...new Set(output
    .replace(ansi, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length <= 200 && !/^[IEWF]\d{4}\s/.test(line)))]
    .sort((a, b) => a.localeCompare(b));
}

export async function checkAntigravityLocal(provider: Provider, checkedAt: string): Promise<ProviderHealthResult> {
  const command = localCliCommand(provider);
  try {
    const version = await runLocalProcess(command, ["--version"], "", undefined, undefined, undefined, { inactivityTimeoutMs: 30_000 });
    if (version.exitCode !== 0) {
      return {
        providerId: provider.id,
        ok: false,
        status: "failed",
        checkedAt,
        message: `Antigravity CLI check failed: ${version.stderr || version.stdout}`
      };
    }
    const catalog = await runLocalProcess(command, ["models"], "", undefined, undefined, undefined, { inactivityTimeoutMs: 60_000 });
    const availableModels = catalog.exitCode === 0 ? parseAntigravityModels(catalog.stdout) : [];
    return {
      providerId: provider.id,
      ok: catalog.exitCode === 0 && availableModels.length > 0,
      status: catalog.exitCode === 0 && availableModels.length > 0 ? "ready" : "failed",
      checkedAt,
      message: catalog.exitCode === 0 && availableModels.length > 0
        ? `Antigravity CLI is available (${(version.stdout || version.stderr).trim()}) with ${availableModels.length} model${availableModels.length === 1 ? "" : "s"}. Authentication is managed by agy through Google Sign-In or the configured Google Cloud project.`
        : `Antigravity CLI is installed (${(version.stdout || version.stderr).trim()}) but its model catalog failed or returned no models: ${catalog.stderr || catalog.stdout}`,
      availableModels: availableModels.length ? availableModels : undefined,
      modelListSource: availableModels.length ? "agy models" : undefined
    };
  } catch (error) {
    return {
      providerId: provider.id,
      ok: false,
      status: "failed",
      checkedAt,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function parseKimiModels(output: string): string[] {
  try {
    const payload = JSON.parse(output) as { models?: unknown };
    if (Array.isArray(payload.models)) {
      return [...new Set(payload.models.map((model) => {
        if (typeof model === "string") return model;
        if (!model || typeof model !== "object") return "";
        const record = model as Record<string, unknown>;
        return [record.alias, record.id, record.name, record.model].find((value): value is string => typeof value === "string") ?? "";
      }).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    }
    if (payload.models && typeof payload.models === "object") {
      return Object.keys(payload.models).sort((a, b) => a.localeCompare(b));
    }
  } catch {
    // Fall back to the human-readable provider list for older Kimi releases.
  }
  const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  return [...new Set(output
    .replace(ansi, "")
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)/)?.[1] ?? "")
    .filter((model) => model.includes("/")))]
    .sort((a, b) => a.localeCompare(b));
}

export async function checkKimiLocal(provider: Provider, checkedAt: string): Promise<ProviderHealthResult> {
  const command = localCliCommand(provider);
  try {
    const version = await runLocalProcess(command, ["--version"], "", undefined, undefined, undefined, { inactivityTimeoutMs: 30_000 });
    if (version.exitCode !== 0) {
      return {
        providerId: provider.id,
        ok: false,
        status: "failed",
        checkedAt,
        message: `Kimi Code CLI check failed: ${version.stderr || version.stdout}`
      };
    }
    const catalog = await runLocalProcess(command, ["provider", "list", "--json"], "", undefined, undefined, undefined, { inactivityTimeoutMs: 60_000 });
    const availableModels = catalog.exitCode === 0 ? parseKimiModels(catalog.stdout) : [];
    const ready = catalog.exitCode === 0 && availableModels.length > 0;
    return {
      providerId: provider.id,
      ok: ready,
      status: ready ? "ready" : "failed",
      checkedAt,
      message: ready
        ? `Kimi Code CLI is available (${(version.stdout || version.stderr).trim()}) with ${availableModels.length} configured model${availableModels.length === 1 ? "" : "s"}. Authentication is managed by Kimi Code; run kimi login if the saved membership or API credentials need refreshing.`
        : `Kimi Code CLI is installed (${(version.stdout || version.stderr).trim()}) but its configured model catalog failed or returned no models: ${catalog.stderr || catalog.stdout}`,
      availableModels: availableModels.length ? availableModels : undefined,
      modelListSource: availableModels.length ? "kimi provider list --json" : undefined
    };
  } catch (error) {
    return {
      providerId: provider.id,
      ok: false,
      status: "failed",
      checkedAt,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function parseGrokModels(output: string): string[] {
  const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  const ignored = new Set(["available", "model", "models", "id", "name", "default", "no", "none", "error", "failed"]);
  return [...new Set(output
    .replace(ansi, "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[*+>✓✔●○◆◇•-]+\s*/, ""))
    .map((line) => line.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)/)?.[1] ?? "")
    .filter((model) => model.length > 0 && model.length <= 200 && !ignored.has(model.toLowerCase())))]
    .sort((a, b) => a.localeCompare(b));
}

export function grokCatalogLooksUnauthenticated(output: string): boolean {
  return /not authenticated|no auth credentials|re-authentication required|token expired|run [`']?grok login/i.test(output);
}

export async function checkGrokLocal(provider: Provider, checkedAt: string): Promise<ProviderHealthResult> {
  const command = localCliCommand(provider);
  try {
    const version = await runLocalProcess(command, ["--version"], "", undefined, undefined, undefined, { inactivityTimeoutMs: 30_000 });
    if (version.exitCode !== 0) {
      return {
        providerId: provider.id,
        ok: false,
        status: "failed",
        checkedAt,
        message: `Grok Build CLI check failed: ${version.stderr || version.stdout}`
      };
    }
    const catalog = await runLocalProcess(command, ["models"], "", undefined, undefined, undefined, { inactivityTimeoutMs: 60_000 });
    const availableModels = catalog.exitCode === 0 ? parseGrokModels(catalog.stdout) : [];
    const catalogOutput = [catalog.stdout, catalog.stderr].filter(Boolean).join("\n");
    const authenticated = !grokCatalogLooksUnauthenticated(catalogOutput);
    const ready = catalog.exitCode === 0 && availableModels.length > 0 && authenticated;
    return {
      providerId: provider.id,
      ok: ready,
      status: ready ? "ready" : "failed",
      checkedAt,
      message: ready
        ? `Grok Build CLI is available (${(version.stdout || version.stderr).trim()}) with ${availableModels.length} model${availableModels.length === 1 ? "" : "s"}. Authentication is managed by Grok Build through its signed-in account or configured API keys.`
        : !authenticated
          ? `Grok Build CLI is installed (${(version.stdout || version.stderr).trim()}) but is not authenticated. Run grok login or configure an API key, then check again.`
          : `Grok Build CLI is installed (${(version.stdout || version.stderr).trim()}) but its model catalog failed or returned no models: ${catalog.stderr || catalog.stdout}`,
      availableModels: availableModels.length ? availableModels : undefined,
      modelListSource: availableModels.length ? "grok models" : undefined
    };
  } catch (error) {
    return {
      providerId: provider.id,
      ok: false,
      status: "failed",
      checkedAt,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function readCodexLocalModels(command: string, modelId?: string): Promise<{ detectedContextWindowTokens?: number; availableModels: string[] }> {
  const result = await runLocalProcess(command, ["debug", "models"], "", undefined);
  if (result.exitCode !== 0) return { availableModels: [] };
  const jsonStart = result.stdout.indexOf("{");
  if (jsonStart < 0) return { availableModels: [] };
  try {
    const payload = JSON.parse(result.stdout.slice(jsonStart)) as unknown;
    const selectedModel = modelId?.trim() || "gpt-5.5";
    return {
      detectedContextWindowTokens: extractContextWindowFromModels(payload, selectedModel),
      availableModels: extractModelIdsFromModels(payload)
    };
  } catch {
    return { availableModels: [] };
  }
}

export function augmentedExecutablePath(extraPath?: string): string {
  const home = homedir();
  const entries = [
    extraPath,
    process.env.PATH,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin")
  ].filter(Boolean) as string[];
  return Array.from(new Set(entries.flatMap((entry) => entry.split(path.delimiter)).filter(Boolean))).join(path.delimiter);
}

export function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

export function windowsExecutableCandidates(
  command: string,
  platform: NodeJS.Platform = process.platform,
  pathExt: string = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"
): string[] {
  if (platform !== "win32" || path.extname(command)) return [command];
  const extensions = pathExt.split(";").filter(Boolean);
  return [
    ...extensions.map((extension) => `${command}${extension.toLowerCase()}`),
    ...extensions.map((extension) => `${command}${extension.toUpperCase()}`),
    command
  ];
}

export async function firstExecutable(command: string, executablePath: string): Promise<string | undefined> {
  if (path.isAbsolute(command) || hasPathSeparator(command)) {
    for (const candidate of windowsExecutableCandidates(command)) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next candidate for Windows extension shims.
      }
    }
    return undefined;
  }
  for (const directory of executablePath.split(path.delimiter).filter(Boolean)) {
    for (const candidate of windowsExecutableCandidates(command)) {
      const fullPath = path.join(directory, candidate);
      try {
        await access(fullPath, constants.X_OK);
        return fullPath;
      } catch {
        // Keep searching other PATH entries.
      }
    }
  }
  return undefined;
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function resolveFromUserShell(command: string): Promise<{ command?: string; path?: string }> {
  if (process.platform !== "darwin" || path.isAbsolute(command) || hasPathSeparator(command)) return {};
  return new Promise((resolve) => {
    const shell = spawn("/bin/zsh", ["-lic", `found=$(command -v -- ${shellSingleQuote(command)} 2>/dev/null || true); print -r -- "__ARCHICODE_CMD__$found"; print -r -- "__ARCHICODE_PATH__$PATH"`], {
      shell: false,
      env: { ...process.env, PATH: augmentedExecutablePath() }
    });
    let stdout = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      const lines = stdout.split(/\r?\n/);
      const foundCommand = lines.find((line) => line.startsWith("__ARCHICODE_CMD__"))?.slice("__ARCHICODE_CMD__".length).trim();
      const foundPath = lines.find((line) => line.startsWith("__ARCHICODE_PATH__"))?.slice("__ARCHICODE_PATH__".length).trim();
      resolve({ command: foundCommand || undefined, path: foundPath || undefined });
    };
    const timer = setTimeout(() => {
      shell.kill();
      finish();
    }, 5000);
    shell.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    shell.on("error", finish);
    shell.on("close", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

export async function resolveLocalCommand(command: string): Promise<{ command: string; env: NodeJS.ProcessEnv }> {
  const cached = localCommandCache.get(command);
  if (cached) return cached;
  const basePath = augmentedExecutablePath();
  const direct = await firstExecutable(command, basePath);
  if (direct) {
    const resolved = { command: direct, env: { ...process.env, PATH: basePath } };
    localCommandCache.set(command, resolved);
    return resolved;
  }
  const shellResult = await resolveFromUserShell(command);
  const shellPath = augmentedExecutablePath(shellResult.path);
  if (shellResult.command) {
    const resolved = { command: shellResult.command, env: { ...process.env, PATH: shellPath } };
    localCommandCache.set(command, resolved);
    return resolved;
  }
  const unresolved = { command, env: { ...process.env, PATH: basePath } };
  localCommandCache.set(command, unresolved);
  return unresolved;
}

export async function readShebang(command: string): Promise<string | undefined> {
  try {
    const content = await readFile(command, "utf8");
    const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
    return firstLine?.startsWith("#!") ? firstLine : undefined;
  } catch {
    return undefined;
  }
}

export function windowsCmdQuote(value: string): string {
  if (!value.length) return "\"\"";
  return `"${value.replace(/"/g, "\"\"")}"`;
}

export function windowsBatchCommandLine(command: string, args: string[]): string {
  return `call ${windowsCmdQuote(command)}${args.length ? ` ${args.map(windowsCmdQuote).join(" ")}` : ""}`;
}

export async function windowsSpawnPlan(
  command: string,
  args: string[]
): Promise<{ command: string; args: string[]; shell: boolean; windowsVerbatimArguments?: boolean }> {
  if (process.platform !== "win32") {
    return { command, args, shell: false };
  }
  const ext = path.extname(command).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", windowsBatchCommandLine(command, args)],
      shell: false,
      windowsVerbatimArguments: true
    };
  }
  if (ext === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
      shell: false
    };
  }
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    return { command: process.execPath, args: [command, ...args], shell: false };
  }
  if (!ext) {
    const shebang = await readShebang(command);
    if (shebang?.includes("node")) {
      return { command: process.execPath, args: [command, ...args], shell: false };
    }
    if (shebang?.includes("pwsh") || shebang?.includes("powershell")) {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
        shell: false
      };
    }
  }
  return { command, args, shell: false };
}

export async function runLocalProcess(
  command: string,
  args: string[],
  stdin: string,
  cwd?: string,
  onProgress?: (event: ProviderProgressEvent) => void,
  signal?: AbortSignal,
  options?: { inactivityTimeoutMs?: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const resolved = await resolveLocalCommand(command);
  const spawnPlan = await windowsSpawnPlan(resolved.command, args);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Provider call was cancelled."));
      return;
    }
    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd,
      shell: spawnPlan.shell,
      windowsVerbatimArguments: spawnPlan.windowsVerbatimArguments,
      env: { ...resolved.env, ...options?.env },
      detached: process.platform !== "win32"
    });
    if (child.pid) activeLocalProviderProcesses.set(child.pid, child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const inactivityTimeoutMs = Number.isFinite(options?.inactivityTimeoutMs) && Number(options?.inactivityTimeoutMs) > 0
      ? Math.floor(Number(options?.inactivityTimeoutMs))
      : LOCAL_PROVIDER_INACTIVITY_TIMEOUT_MS;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanupChild = (killProcessGroup = false): void => {
      if (child.pid) {
        activeLocalProviderProcesses.delete(child.pid);
        if (killProcessGroup) terminateLocalProviderProcess(child.pid);
      }
    };

    const appendStreamError = (stream: string, error: Error & { code?: string }): void => {
      const code = error.code ? ` (${error.code})` : "";
      stderr += `${stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n"}${stream} stream error${code}: ${error.message}`;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      resetInactivityTimer();
      const text = chunk.toString();
      stdout += text;
      onProgress?.({ stream: "stdout", text });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      resetInactivityTimer();
      const text = chunk.toString();
      stderr += text;
      onProgress?.({ stream: "stderr", text });
    });
    child.stdin.on("error", (error: Error & { code?: string }) => {
      appendStreamError("stdin", error);
    });
    child.stdout.on("error", (error: Error & { code?: string }) => {
      appendStreamError("stdout", error);
    });
    child.stderr.on("error", (error: Error & { code?: string }) => {
      appendStreamError("stderr", error);
    });
    function abort(): void {
      if (settled) return;
      settled = true;
      cleanupChild(true);
      cleanupControls();
      reject(new Error("Provider call was cancelled."));
    }
    function timeout(): void {
      if (settled) return;
      settled = true;
      cleanupChild(true);
      cleanupControls();
      const minutes = inactivityTimeoutMs / 60_000;
      const duration = Number.isInteger(minutes) ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${inactivityTimeoutMs}ms`;
      reject(new Error(`Local provider call produced no output for ${duration}. The CLI process and its child processes were stopped.`));
    }
    function resetInactivityTimer(): void {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(timeout, inactivityTimeoutMs);
    }
    const cleanupControls = (): void => {
      signal?.removeEventListener("abort", abort);
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = undefined;
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    resetInactivityTimer();

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanupControls();
      cleanupChild(true);
      if ((error as Error & { code?: string }).code === "ENOENT") {
        reject(new Error(`Unable to find local command "${command}". Set it to the full CLI path, or make sure it is available from your login shell PATH.`));
      } else {
        reject(error);
      }
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanupControls();
      cleanupChild(true);
      resolve({ stdout, stderr, exitCode });
    });

    try {
      if (stdin) {
        child.stdin.end(stdin);
      } else {
        child.stdin.end();
      }
    } catch (error) {
      appendStreamError("stdin", error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function terminateLocalProviderProcess(pid: number): void {
  try {
    if (process.platform === "win32") {
      process.kill(pid, "SIGTERM");
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}

export function shutdownLocalProviderProcesses(): void {
  for (const pid of [...activeLocalProviderProcesses.keys()]) {
    terminateLocalProviderProcess(pid);
    activeLocalProviderProcesses.delete(pid);
  }
}
