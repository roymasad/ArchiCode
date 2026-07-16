import type { ImplementationScope } from "./schema";

export const implementationScopeAdvisory = {
  authority: "advisory-best-effort" as const,
  deterministicMeaning: "The same repository snapshot and analyzer version should produce the same hints; deterministic output does not guarantee semantic correctness.",
  guidance: "Implementation-scope claims are compact structural navigation hints inferred from static analysis or prior agent activity. They may be incomplete, inaccurate, or stale. Use them before semantic matches when orienting code inspection, but verify both against current source before acting, and never treat them as permissions, hard edit boundaries, or a replacement for node intent and acceptance criteria. Use checkedAt to judge when the claims were last evaluated. An absent hint means unknown, not necessarily no implementation."
};

export const semanticRetrievalAdvisory = {
  authority: "discovery-candidate" as const,
  evidenceOrder: "Current inspected source is authoritative. Implementation Scope is stronger structural orientation than semantic similarity. Semantic matches are secondary discovery candidates.",
  guidance: "Use semantic matches to discover potentially relevant files or nodes that structural mapping may have missed. Similarity does not prove implementation, dependency, ownership, edit scope, or graph truth. Verify every match against current source before relying on it, and never treat a match as permission."
};

export function compactImplementationScope(scope: ImplementationScope | undefined, limit = 6): Record<string, unknown> | undefined {
  if (!scope?.claims.length) return undefined;
  return {
    source: scope.source,
    analyzerVersion: scope.analyzerVersion,
    checkedAt: scope.checkedAt,
    totalClaims: scope.claims.length,
    relationCounts: {
      own: scope.claims.filter((claim) => claim.relation === "own").length,
      share: scope.claims.filter((claim) => claim.relation === "share").length,
      cover: scope.claims.filter((claim) => claim.relation === "cover").length
    },
    hints: scope.claims.slice(0, limit),
    omittedHints: Math.max(0, scope.claims.length - limit)
  };
}
