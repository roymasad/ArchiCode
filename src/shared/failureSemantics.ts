export type AgentFailureKind = "timeout" | "error";

/**
 * Recognizes host/provider inactivity deadlines as timeouts without depending
 * on one transport's exact wording. This also keeps older persisted chats,
 * which predate `failureKind`, presentable with the correct terminal cause.
 */
export function isTimeoutFailureMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /\btimed?[- ]?out\b/i.test(message)
    || /\bproduced no (?:output|activity) for\b/i.test(message);
}

