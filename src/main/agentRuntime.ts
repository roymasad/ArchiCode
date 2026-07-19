export type AgentToolCall = {
  id: string;
  providerToolName: string;
  argumentsJson: string;
};

export type AgentToolResult = {
  toolCall: AgentToolCall;
  /** Exact executor output, before any host no-progress guidance is appended. */
  rawResult: string;
  /** Provider-visible result, including host guidance when applicable. */
  result: string;
};

export type AgentProviderTurn<RawTurn = unknown> = {
  text: string;
  toolCalls: AgentToolCall[];
  raw: RawTurn;
};

export type AgentLoopAdapter<RawTurn = unknown> = {
  nextTurn: () => Promise<AgentProviderTurn<RawTurn>>;
  commitToolResults: (turn: AgentProviderTurn<RawTurn>, results: AgentToolResult[]) => void | Promise<void>;
  /** Append a rejected final answer plus host validation feedback to this same provider transcript. */
  commitInvalidAnswer?: (turn: AgentProviderTurn<RawTurn>, feedback: string) => void | Promise<void>;
  /** Append host feedback after the current tool turn has already been committed. */
  commitFeedback?: (feedback: string) => void | Promise<void>;
  attachApprovalContinuation?: (input: {
    turn: AgentProviderTurn<RawTurn>;
    completedResults: AgentToolResult[];
    pendingToolCall: AgentToolCall;
    error: unknown;
  }) => void;
  requestFinalAnswer?: (turn: AgentProviderTurn<RawTurn>, results: AgentToolResult[]) => void | Promise<void>;
  onLaterRound?: () => void;
};

export type AgentLoopCompletion = {
  complete: boolean;
  fallbackText?: string;
  requireVisibleAnswer?: boolean;
};

export type AgentLoopOptions<RawTurn = unknown> = {
  adapter: AgentLoopAdapter<RawTurn>;
  executeTool?: (toolCall: AgentToolCall) => Promise<string>;
  isApprovalError?: (error: unknown) => boolean;
  completionAfterTools?: (input: {
    turn: AgentProviderTurn<RawTurn>;
    results: AgentToolResult[];
  }) => AgentLoopCompletion | undefined;
  /** Caller-owned sink classification, applied uniformly across provider adapters. */
  isTerminalTool?: (providerToolName: string) => boolean;
  /** A terminal sink whose successful call is itself the visible completion. */
  terminalToolCompletesTurn?: (providerToolName: string) => boolean;
  /** Return feedback to keep the same trajectory alive, or undefined to accept the final answer. */
  validateFinalAnswer?: (text: string) => string | undefined | Promise<string | undefined>;
  signal?: AbortSignal;
  emptyAnswer?: string;
  maxConsecutiveIdenticalCalls?: number;
  maxTransientRetries?: number;
  isTransientError?: (error: unknown) => boolean;
  onTransientRetry?: (error: unknown) => void;
};

const TRANSIENT_AGENT_ERROR_PATTERNS = [
  "terminated", "fetch failed", "socket hang up", "headers timeout", "body timeout",
  "econnreset", "etimedout", "eai_again", "enotfound", "econnrefused", "network timeout",
  "und_err"
];

export function isTransientAgentTransportError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (text.includes("cancelled") || text.includes("aborted")) return false;
  return TRANSIENT_AGENT_ERROR_PATTERNS.some((pattern) => text.includes(pattern));
}

function canonicalToolArgumentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalToolArgumentValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalToolArgumentValue(entry)])
  );
}

function canonicalToolArguments(argumentsJson: string): string {
  try {
    return JSON.stringify(canonicalToolArgumentValue(JSON.parse(argumentsJson || "{}")));
  } catch {
    return argumentsJson.trim();
  }
}

/**
 * Repair prompts may echo the rejected answer for context, so comparing the
 * whole feedback string misses semantic no-progress whenever the model merely
 * rephrases the same invalid result. The contract reason before that echo is
 * the stable identity of the failure.
 */
export function finalAnswerValidationFingerprint(feedback: string): string {
  return feedback
    .split(/\n\nPrevious response:/i, 1)[0]!
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A narrow no-progress guard, not a task-step budget. It only reacts when the
 * model repeats the exact same tool call back-to-back with identical arguments.
 */
export function createConsecutiveToolCallLoopDetector(maxConsecutiveIdenticalCalls = 3): {
  record: (providerToolName: string, argumentsJson: string) => string | undefined;
} {
  let previousSignature: string | undefined;
  let consecutiveCount = 0;
  return {
    record(providerToolName, argumentsJson) {
      const signature = `${providerToolName}\n${canonicalToolArguments(argumentsJson)}`;
      if (signature === previousSignature) consecutiveCount += 1;
      else {
        previousSignature = signature;
        consecutiveCount = 1;
      }
      if (consecutiveCount >= maxConsecutiveIdenticalCalls) {
        throw new Error(`Consecutive identical tool-call loop detected for ${providerToolName}; stopped on attempt ${consecutiveCount}.`);
      }
      if (consecutiveCount === maxConsecutiveIdenticalCalls - 1) {
        return `ArchiCode loop guard: this ${providerToolName} call is identical to your previous one, which already executed — repeating it changes nothing. One more identical call aborts the run. Change the arguments or content, try a different approach, or state what is blocking you.`;
      }
      return undefined;
    }
  };
}

/**
 * The single provider-independent agent/tool loop. Provider adapters own wire
 * formats and continuation snapshots; the runtime owns iteration, tool
 * execution, approval pausing, cancellation, and no-progress feedback.
 */
export async function runAgentLoop<RawTurn = unknown>(options: AgentLoopOptions<RawTurn>): Promise<string> {
  const emptyAnswer = options.emptyAnswer ?? "Provider returned no content.";
  const loopDetector = createConsecutiveToolCallLoopDetector(options.maxConsecutiveIdenticalCalls);
  const maxConsecutiveIdenticalAnswers = options.maxConsecutiveIdenticalCalls ?? 3;
  let previousRejectedAnswer: string | undefined;
  let consecutiveRejectedAnswerCount = 0;
  let previousValidationFingerprint: string | undefined;
  let consecutiveValidationFailureCount = 0;
  let round = 0;

  const rejectFinalAnswer = async (turn: AgentProviderTurn<RawTurn>, answer: string, feedback: string): Promise<void> => {
    const normalizedAnswer = answer.trim();
    if (normalizedAnswer === previousRejectedAnswer) consecutiveRejectedAnswerCount += 1;
    else {
      previousRejectedAnswer = normalizedAnswer;
      consecutiveRejectedAnswerCount = 1;
    }
    if (consecutiveRejectedAnswerCount >= maxConsecutiveIdenticalAnswers) {
      throw new Error(`Consecutive identical invalid final-answer loop detected; stopped on attempt ${consecutiveRejectedAnswerCount}.`);
    }
    const validationFingerprint = finalAnswerValidationFingerprint(feedback);
    if (validationFingerprint === previousValidationFingerprint) consecutiveValidationFailureCount += 1;
    else {
      previousValidationFingerprint = validationFingerprint;
      consecutiveValidationFailureCount = 1;
    }
    if (consecutiveValidationFailureCount >= maxConsecutiveIdenticalAnswers) {
      throw new Error(`Repeated final-answer validation loop detected for the same contract failure with no new tool evidence; stopped on attempt ${consecutiveValidationFailureCount}.`);
    }
    const repeatedAnswerWarning = consecutiveRejectedAnswerCount === maxConsecutiveIdenticalAnswers - 1
      ? "ArchiCode loop guard: this final answer is identical to the one the host just rejected. Repeating it again changes nothing and will abort the run. Use the validation feedback to change the answer or perform another useful action."
      : undefined;
    const visibleFeedback = repeatedAnswerWarning ? `${feedback}\n\n${repeatedAnswerWarning}` : feedback;
    if (!options.adapter.commitInvalidAnswer) {
      throw new Error(`Agent final answer failed validation: ${visibleFeedback}`);
    }
    await options.adapter.commitInvalidAnswer(turn, visibleFeedback);
  };

  while (true) {
    if (options.signal?.aborted) throw new Error("Provider call was cancelled.");
    if (round > 0) options.adapter.onLaterRound?.();
    let turn: AgentProviderTurn<RawTurn>;
    let transientAttempt = 0;
    while (true) {
      try {
        turn = await options.adapter.nextTurn();
        break;
      } catch (error) {
        const retryLimit = options.maxTransientRetries ?? 1;
        const transient = (options.isTransientError ?? isTransientAgentTransportError)(error);
        if (options.signal?.aborted || !transient || transientAttempt >= retryLimit) throw error;
        transientAttempt += 1;
        options.onTransientRetry?.(error);
      }
    }
    if (!turn.toolCalls.length) {
      const answer = turn.text.trim() || emptyAnswer;
      const feedback = await options.validateFinalAnswer?.(answer);
      if (!feedback) return answer;
      await rejectFinalAnswer(turn, answer, feedback);
      round += 1;
      continue;
    }
    if (!options.executeTool) return turn.text.trim() || emptyAnswer;

    const completedResults: AgentToolResult[] = [];
    // Preserve the model's declared call order. Tool batches often mix writes
    // with a final submit/finish call; concurrent execution can let the finish
    // race ahead of the writes. It also makes an approval pause ambiguous by
    // allowing later side effects to run after the first blocked call.
    for (const toolCall of turn.toolCalls) {
      const warning = loopDetector.record(toolCall.providerToolName, toolCall.argumentsJson);
      try {
        const rawResult = await options.executeTool(toolCall);
        completedResults.push({
          toolCall,
          rawResult,
          result: warning ? `${rawResult}\n\n${warning}` : rawResult
        });
      } catch (error) {
        if (options.isApprovalError?.(error)) {
          options.adapter.attachApprovalContinuation?.({
            turn,
            completedResults,
            pendingToolCall: toolCall,
            error
          });
        }
        throw error;
      }
    }
    // A real tool execution changed the trajectory's evidence. A later repeat
    // of the same validation reason is therefore a fresh correction attempt,
    // not continuation of the previous no-progress sequence.
    previousValidationFingerprint = undefined;
    consecutiveValidationFailureCount = 0;

    const completion = options.completionAfterTools?.({ turn, results: completedResults }) ??
      (turn.toolCalls.every((toolCall) => options.isTerminalTool?.(toolCall.providerToolName))
        ? {
            complete: true,
            fallbackText: turn.toolCalls.some((toolCall) => options.terminalToolCompletesTurn?.(toolCall.providerToolName))
              ? "Prepared the requested update for review."
              : undefined,
            requireVisibleAnswer: !turn.toolCalls.some((toolCall) => options.terminalToolCompletesTurn?.(toolCall.providerToolName))
          }
        : undefined);
    if (completion?.complete) {
      const terminalAnswer = turn.text.trim() || completion.fallbackText || emptyAnswer;
      if (!completion.requireVisibleAnswer) {
        const feedback = await options.validateFinalAnswer?.(terminalAnswer);
        if (!feedback) return terminalAnswer;
        await options.adapter.commitToolResults(turn, completedResults);
        if (!options.adapter.commitFeedback) throw new Error(`Agent final answer failed validation: ${feedback}`);
        await options.adapter.commitFeedback(feedback);
        round += 1;
        continue;
      }
      if (turn.text.trim()) {
        const feedback = await options.validateFinalAnswer?.(turn.text.trim());
        if (!feedback) return turn.text.trim();
        await options.adapter.commitToolResults(turn, completedResults);
        if (!options.adapter.commitFeedback) throw new Error(`Agent final answer failed validation: ${feedback}`);
        await options.adapter.commitFeedback(feedback);
        round += 1;
        continue;
      }
      await options.adapter.commitToolResults(turn, completedResults);
      if (!options.adapter.requestFinalAnswer) return completion.fallbackText ?? emptyAnswer;
      await options.adapter.requestFinalAnswer(turn, completedResults);
      round += 1;
      continue;
    }

    await options.adapter.commitToolResults(turn, completedResults);
    round += 1;
  }
}
