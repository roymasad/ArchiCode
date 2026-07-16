import { Tooltip } from "./ui";
import type { CSSProperties } from "react";

type ContextSizeIndicatorProps = {
  active?: boolean;
  detail?: string;
  estimatedTokens: number;
  label?: string;
  maxTokens: number;
  // Optional LLM cost summary for the same scope (chat session or run). `text`
  // is the headline (e.g. "Cost: $0.0412" or "Cost: n/a"); `detail` carries the
  // full token/phase/subagent breakdown. Both render on new tooltip lines.
  cost?: { text: string; detail?: string } | null;
  primary?: {
    label: string;
    estimatedTokens: number;
    maxTokens?: number;
    detail?: string;
  } | null;
  showSecondaryContextLine?: boolean;
};

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

export function ContextSizeIndicator({
  active = false,
  detail,
  estimatedTokens,
  label = "Context",
  maxTokens,
  cost,
  primary,
  showSecondaryContextLine = true
}: ContextSizeIndicatorProps) {
  const primaryTokens = primary?.estimatedTokens ?? estimatedTokens;
  const safeMax = Math.max(1, primary?.maxTokens ?? maxTokens);
  const percent = Math.min(100, Math.max(0, Math.round((primaryTokens / safeMax) * 100)));
  const tone = percent >= 85 ? "danger" : percent >= 65 ? "warning" : "ok";
  const contextLine = primary && showSecondaryContextLine
    ? `${label}: ${formatTokens(estimatedTokens)} / ${formatTokens(Math.max(1, maxTokens))} tokens.`
    : undefined;
  const tooltip = [
    `${primary?.label ?? label}: ${formatTokens(primaryTokens)} / ${formatTokens(safeMax)} tokens (${percent}%).`,
    cost?.text,
    cost?.detail,
    primary?.detail,
    contextLine,
    detail
  ].filter(Boolean).join("\n");

  return (
    <Tooltip content={tooltip}>
      <span
        className={`context-size-indicator context-size-${tone}${active ? " is-active" : ""}`}
        style={{ "--context-size-percent": `${percent}%` } as CSSProperties}
        aria-label={tooltip}
        tabIndex={0}
      >
        <span aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
