import type { ArchitectureLensPlan, GraphProjection, ModuleCluster, ModuleGraph } from "./types";

const CONCRETE_DURABLE_TECH_PATTERN = /\b(sqlite|postgres(?:ql)?|mysql|mariadb|mongodb?|redis|prisma|sequelize|typeorm|drizzle|coredata|firestore|dynamodb|realm|sharedpreferences|userdefaults|localstorage|indexeddb)\b/i;
const STRONG_DURABLE_PATH_PATTERN = /(?:^|[\/_\-.])(db|database|persistence|schemas?|migrations?)(?:[\/_\-.]|$)/i;
const GENERIC_DURABLE_PATH_PATTERN = /(?:^|[\/_\-.])(storage|repositories?)(?:[\/_\-.]|$)/i;
const DURABLE_OPERATION_PATTERN = /\b(insert|upsert|commit|transaction|migrate|persist|writefile|appendfile|setitem|savewidgetdata|save|store|database|repository)\w*\b/i;
const EXTERNAL_EFFECT_KINDS = new Set(["http-call", "ipc-send", "event-publish", "shared-write"]);
const EFFECT_SYMBOL_PATTERN = /\b(?:submit|publish|send|dispatch|register|persist|save|charge|refund|deploy|book|finali[sz])\w*\b/i;
const EFFECT_TERM_PATTERN = /^(?:submit|publish|send|dispatch|register|persist|save|charg|refund|deploy|book|final|complet|write|commit)$/i;
const UNSUPPORTED_COMPLETION_PATTERN = /\b(?:persist(?:s|ed|ing|ence|ent)?|register(?:s|ed|ing)?|submit(?:s|ted|ting)?|dispatch(?:es|ed|ing)?|publish(?:es|ed|ing)?|deploy(?:s|ed|ing)?|book(?:s|ed|ing)?|paid|(?:order|payment|booking|registration|deployment|transaction)\s+(?:is\s+)?completed|finali[sz](?:e|es|ed|ing))\b/i;
const SEMANTIC_BOUNDARY_PATTERN = /\s*Repository evidence does not (?:prove durable persistence or completion outside the observed (?:conversation\/workflow|process)|show this concept as a durable dataset or completed external write)\.?/gi;
const DURABLE_EDGE_VERB_PATTERN = /\b(?:persist(?:s|ed|ing)?|sav(?:e|es|ed|ing)|stor(?:e|es|ed|ing)|writ(?:e|es|ten|ing)|commit(?:s|ted|ting)?)\b/i;
const TERM_STOPWORDS = new Set([
  "about", "after", "again", "against", "also", "before", "being", "between", "complete", "concept", "could", "current", "data", "does", "during", "each", "every", "from", "have", "into", "itself", "more", "only", "other", "process", "repository", "source", "step", "system", "that", "their", "there", "these", "they", "this", "through", "under", "using", "when", "where", "which", "while", "with", "without"
]);

function semanticText(cluster: ModuleCluster): string {
  return [
    cluster.path,
    cluster.title,
    cluster.role ?? "",
    cluster.boundary?.manifest ?? "",
    ...cluster.files,
    ...cluster.symbols,
    ...cluster.externalDeps,
    ...(cluster.routes ?? []),
    ...(cluster.interactions ?? []).flatMap((interaction) => [interaction.kind, interaction.target, interaction.reference ?? ""])
  ].join(" ").toLowerCase();
}

export function clusterHasDurablePersistenceEvidence(cluster: ModuleCluster): boolean {
  if (cluster.role === "migration") return true;
  if ((cluster.interactions ?? []).some((interaction) => interaction.kind === "shared-write")) return true;
  const text = semanticText(cluster);
  if (CONCRETE_DURABLE_TECH_PATTERN.test(text) || STRONG_DURABLE_PATH_PATTERN.test(text)) return true;
  // Generic "storage" and "repository" labels need a read/write operation so
  // UI state stores are not silently promoted to durable databases.
  return GENERIC_DURABLE_PATH_PATTERN.test(text) && DURABLE_OPERATION_PATTERN.test(text);
}

export function graphHasDurablePersistenceEvidence(graph: ModuleGraph, clusterIds?: Iterable<string>): boolean {
  const selected = clusterIds ? new Set(clusterIds) : null;
  return graph.clusters.some((cluster) => (!selected || selected.has(cluster.id)) && clusterHasDurablePersistenceEvidence(cluster));
}

function stem(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]s$/, "")
    .replace(/(?:ations?|ments?|ness|ingly|edly|ing|ied|ies|ed|es|s)$/i, "")
    .replace(/([b-df-hj-np-tv-z])\1$/i, "$1")
    .slice(0, 24);
}

export function semanticTerms(value: string): Set<string> {
  const separated = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return new Set((separated.toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) ?? [])
    .filter((term) => !TERM_STOPWORDS.has(term.replace(/['’]s$/, "")))
    .map(stem)
    .filter((term) => term.length >= 3 && !TERM_STOPWORDS.has(term)));
}

function overlapCount(left: Set<string>, right: Set<string>): number {
  return [...left].filter((term) => right.has(term)).length;
}

export function relevantBehavioralContracts(input: {
  projection: GraphProjection;
  sourcePaths: string[];
  title: string;
  description: string;
}): NonNullable<GraphProjection["behavioralContracts"]> {
  const paths = new Set(input.sourcePaths);
  const candidateTerms = semanticTerms(`${input.title} ${input.description}`);
  return [...(input.projection.behavioralContracts ?? [])]
    .filter((contract) => paths.has(contract.file))
    .map((contract) => ({ contract, score: overlapCount(candidateTerms, new Set(contract.terms.map(stem))) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.contract.sequence - right.contract.sequence)
    .slice(0, 3)
    .map((item) => item.contract);
}

function hasRelevantExternalEffect(clusters: ModuleCluster[], value: string): boolean {
  const claimTerms = new Set([...semanticTerms(value)].filter((term) => !EFFECT_TERM_PATTERN.test(term)));
  if (!claimTerms.size) return false;
  return clusters.some((cluster) => {
    // Keep the effect verb and its subject in the same evidence unit. Joining a
    // whole cluster would let `submitPayment` plus `orderSummary` incorrectly
    // prove that an order is submitted.
    const codeUnits = [...cluster.symbols, ...(cluster.routes ?? [])];
    if (codeUnits.some((unit) => EFFECT_SYMBOL_PATTERN.test(unit) && overlapCount(claimTerms, semanticTerms(unit)) > 0)) return true;
    return (cluster.interactions ?? []).some((interaction) => {
      if (!EXTERNAL_EFFECT_KINDS.has(interaction.kind)) return false;
      const unit = `${interaction.kind} ${interaction.target} ${interaction.reference ?? ""}`;
      return overlapCount(claimTerms, semanticTerms(unit)) > 0;
    });
  });
}

/**
 * Durable edge verbs are provider prose, not evidence. When a repository has
 * no durable sink, retain the relationship while making its runtime scope
 * explicit. The replacement is deliberately stable so post-review enforcement
 * can run repeatedly without changing already-hardened output.
 */
export function normalizeTransientDataEdgeLabel(value: string): string {
  return DURABLE_EDGE_VERB_PATTERN.test(value)
    ? "updates transient in-memory state"
    : value;
}

function withoutSemanticBoundary(value: string): string {
  return value.replace(SEMANTIC_BOUNDARY_PATTERN, " ").replace(/\s+/g, " ").trim();
}

function preserveInitialCase(original: string, replacement: string): string {
  return /^[A-Z]/.test(original) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}

function saferOutcomeTitle(value: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/\bfinali[sz](?:e|es|ed|ing)\b/gi, "confirmed in the conversation"],
    [/\bregister(?:s|ed|ing)?\b/gi, "captured"],
    [/\bsubmit(?:s|ted|ting)?\b/gi, "prepared for handoff"],
    [/\bdispatch(?:es|ed|ing)?\b/gi, "prepared for dispatch"],
    [/\bpublish(?:es|ed|ing)?\b/gi, "prepared for publication"],
    [/\bdeploy(?:s|ed|ing)?\b/gi, "prepared for deployment"],
    [/\bpersist(?:s|ed|ing)?\b/gi, "retained during the observed flow"],
    [/\bcompleted\b/gi, "handled in the observed flow"],
    [/\b(?:sav(?:e|es|ed|ing)|stor(?:e|es|ed|ing)|record(?:s|ed|ing)?|log(?:s|ged|ging)?)\b/gi, "captured"]
  ];
  return replacements.reduce((title, [pattern, replacement]) => title.replace(pattern, (match) => preserveInitialCase(match, replacement)), value)
    .replace(/\s+/g, " ")
    .trim();
}

export type SemanticClaimNormalization = {
  title: string;
  description: string;
  status: "implemented-durable" | "implemented-effect" | "prompt-defined" | "transient-or-conceptual" | "evidence-bounded";
  corrections: string[];
  relevantContracts: NonNullable<GraphProjection["behavioralContracts"]>;
};

/**
 * Enforce the difference between source text that *describes* desired behavior
 * and code that proves a durable write or externally completed effect. This is
 * intentionally language-neutral: concrete parser facts improve the evidence,
 * but unsupported stacks still receive the same conservative truth boundary.
 */
export function normalizeSemanticLensClaim(input: {
  lensId: ArchitectureLensPlan["id"];
  projection: GraphProjection;
  title: string;
  description: string;
  type: string;
  sourcePaths: string[];
  anchorClusters: ModuleCluster[];
}): SemanticClaimNormalization {
  const relevantContracts = relevantBehavioralContracts(input);
  const hasDurableAnchor = input.anchorClusters.some(clusterHasDurablePersistenceEvidence);
  const matchingEffect = hasRelevantExternalEffect(input.anchorClusters, `${input.title} ${input.description}`);
  // A database somewhere in the same cluster does not prove every product or
  // journey outcome. Broad durable evidence is sufficient only for a data-store
  // concept; every other persisted/completed claim needs a matching operation.
  const durableClaim = input.lensId === "data"
    && hasDurableAnchor
    && (input.type === "data-store" || matchingEffect);
  // Our own truth boundary mentions words such as "persistence" and
  // "completion". Exclude that boundary from the next pass so enforcing after
  // provider review is idempotent instead of appending/rephrasing it again.
  const unsafeCompletion = UNSUPPORTED_COMPLETION_PATTERN.test(withoutSemanticBoundary(`${input.title} ${input.description}`));
  const promptDefined = relevantContracts.length > 0;
  const corrections: string[] = [];
  let title = input.title.trim();
  let description = input.description.trim();

  const promptScopedData = input.lensId === "data"
    && promptDefined
    && !durableClaim
    && !matchingEffect
    && /^(?:data-owner|data-entity|data-store|data-sync|migration)$/.test(input.type);
  if (promptScopedData) {
    const evidence = relevantContracts[0];
    description = `Prompt-defined concept observed in ${evidence.file}:${evidence.line}: ${evidence.text} Repository evidence does not show this concept as a durable dataset or completed external write.`;
    corrections.push("Reframed prompt-defined data as declared behavior rather than implemented persistence.");
  } else if (unsafeCompletion && !durableClaim && !matchingEffect) {
    title = saferOutcomeTitle(title);
    const evidence = relevantContracts[0];
    description = evidence
      ? `Prompt-defined or conversational outcome observed in ${evidence.file}:${evidence.line}: ${evidence.text} Repository evidence does not prove durable persistence or completion outside the observed conversation/workflow.`
      : `${description.replace(UNSUPPORTED_COMPLETION_PATTERN, "handled")} Repository evidence does not prove durable persistence or completion outside the observed process.`;
    corrections.push("Downgraded an unsupported durable or externally completed outcome.");
  }

  const status: SemanticClaimNormalization["status"] = durableClaim
    ? "implemented-durable"
    : matchingEffect
      ? "implemented-effect"
      : promptDefined
        ? "prompt-defined"
        : input.lensId === "data"
          ? "transient-or-conceptual"
          : "evidence-bounded";
  return { title, description, status, corrections, relevantContracts };
}

export function normalizeProjectionSemanticScope(projection: GraphProjection, graph: ModuleGraph): GraphProjection {
  if (projection.id !== "data" || graphHasDurablePersistenceEvidence(graph, projection.clusterIds)) return projection;
  return {
    ...projection,
    title: "Data Ownership & Runtime State",
    question: "Where is runtime data owned, transformed, and passed through the system?",
    description: "Evidence-backed transient state, data concepts, transformations, and movement. No durable persistence sink was observed in this repository.",
    evidenceBasis: [...new Set([...projection.evidenceBasis.filter((item) => !/persistence|migration|schema/i.test(item)), "application-state signals", "prompt-defined data contracts", "no durable persistence sink observed"])],
    confidence: projection.confidence === "high" ? "medium" : projection.confidence
  };
}
