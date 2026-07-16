import { humanizeSegment } from "./aggregate";
import type { ModuleCluster } from "./types";

/**
 * Zoom coherence: opening a node must decompose it, not restate it. These passes run on
 * final titles (LLM or deterministic) right before emission, so every producer is covered.
 */

const TITLE_STOPWORDS = new Set(["the", "and", "of", "for", "a", "an", "to", "in", "on", "with", "amp"]);

function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !TITLE_STOPWORDS.has(word));
}

function connectorWord(word: string): boolean {
  return /^[&,\-–—/]$/.test(word) || /^(and|or|of|for|the|a|an|with|to|in)$/i.test(word);
}

function fileBasename(cluster: ModuleCluster): string | null {
  const top = cluster.topFiles[0] ?? cluster.files[0];
  if (!top) return null;
  return top.split("/").pop() ?? null;
}

/** Rebuild an echoing child title from the words its parent does not already claim. */
function dedupeAgainstParent(childTitle: string, parentTokens: Set<string>, cluster: ModuleCluster): string {
  const words = childTitle.split(/\s+/).filter((word) => {
    const key = word.toLowerCase().replace(/[^a-z0-9]/g, "");
    return key && !parentTokens.has(key);
  });
  while (words.length && connectorWord(words[0])) words.shift();
  while (words.length && connectorWord(words[words.length - 1])) words.pop();
  let candidate = words.join(" ").replace(/\s{2,}/g, " ").trim();
  if (titleTokens(candidate).length < 2) {
    const base = fileBasename(cluster);
    const humanized = base ? humanizeSegment(base) : "";
    if (candidate && humanized && candidate.toLowerCase() !== humanized.toLowerCase()) candidate = `${candidate} — ${humanized}`;
    else if (humanized) candidate = `${humanized} Core`;
    else candidate = candidate ? `${candidate} Core` : `${childTitle} Internals`;
  }
  return candidate;
}

/**
 * Resolve final titles for every cluster with two guarantees:
 * 1. No parent echo: a child whose title mostly repeats its parent's is rebuilt from its
 *    own distinguishing words (or its dominant file) so drill-down always reveals new terms.
 * 2. No twin siblings: siblings whose token sets are identical or subset-nested get a
 *    clarifying file-based suffix so users can tell the doors apart.
 */
export function coherentClusterTitles(
  clusters: ModuleCluster[],
  titleFor: (cluster: ModuleCluster) => string
): Map<string, string> {
  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const result = new Map<string, string>();
  for (const cluster of clusters) result.set(cluster.id, titleFor(cluster).trim() || cluster.title);

  // Parent-echo pass, parents first so children compare against final parent titles.
  for (const cluster of [...clusters].sort((a, b) => a.tier - b.tier)) {
    const parent = cluster.parentClusterId ? byId.get(cluster.parentClusterId) : undefined;
    if (!parent) continue;
    const parentTokens = new Set(titleTokens(result.get(parent.id) ?? parent.title));
    if (!parentTokens.size) continue;
    const childTitle = result.get(cluster.id) as string;
    const childTokens = titleTokens(childTitle);
    if (!childTokens.length) continue;
    const shared = childTokens.filter((token) => parentTokens.has(token)).length;
    if (shared / childTokens.length < 0.6) continue;
    let candidate = dedupeAgainstParent(childTitle, parentTokens, cluster);
    if (candidate.toLowerCase() === (result.get(parent.id) ?? "").toLowerCase()) candidate = `${candidate} Internals`;
    result.set(cluster.id, candidate);
  }

  // Twin-sibling pass: only the unambiguous cases (equal or subset token sets) are renamed
  // deterministically; softer near-duplicates are left to the provider prompt rules.
  const byParent = new Map<string, ModuleCluster[]>();
  for (const cluster of clusters) {
    const key = cluster.parentClusterId ?? "(root)";
    byParent.set(key, [...(byParent.get(key) ?? []), cluster]);
  }
  for (const siblings of byParent.values()) {
    for (let i = 0; i < siblings.length; i += 1) {
      for (let j = i + 1; j < siblings.length; j += 1) {
        const left = siblings[i];
        const right = siblings[j];
        const leftTokens = new Set(titleTokens(result.get(left.id) as string));
        const rightTokens = new Set(titleTokens(result.get(right.id) as string));
        if (!leftTokens.size || !rightTokens.size) continue;
        const leftInRight = [...leftTokens].every((token) => rightTokens.has(token));
        const rightInLeft = [...rightTokens].every((token) => leftTokens.has(token));
        if (!leftInRight && !rightInLeft) continue;
        const clarify = (cluster: ModuleCluster): void => {
          const title = result.get(cluster.id) as string;
          if (/\(/.test(title)) return;
          const base = fileBasename(cluster);
          if (base && !title.toLowerCase().includes(base.toLowerCase())) result.set(cluster.id, `${title} (${base})`);
        };
        // The subset title is the ambiguous one; identical sets clarify both.
        if (leftInRight && rightInLeft) {
          clarify(left);
          clarify(right);
        } else if (leftInRight) {
          clarify(left);
        } else {
          clarify(right);
        }
      }
    }
  }
  return result;
}

/**
 * Provider edge labels must read as complete verb phrases. Labels that end mid-thought
 * ("accesses trusted device contacts through") are rejected so the deterministic
 * evidence label takes over.
 */
const DANGLING_LABEL_ENDING = /(?:\b(?:through|with|via|to|from|and|or|but|over|into|onto|for|by|on|at|of|the|a|an|that|which|as|per|its|their)|[,&\-–—:;(])$/i;

export function lintedEdgeLabel(label: string | null | undefined): string | null {
  const trimmed = (label ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").trim();
  if (!trimmed) return null;
  if (DANGLING_LABEL_ENDING.test(trimmed)) return null;
  return trimmed;
}
