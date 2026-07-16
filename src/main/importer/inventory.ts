import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FileDependencyGraph, RepoScan, ScannedFile } from "./types";
import type { ImportSourceReader } from "./sourceCache";

export type CatalogItem = {
  /** Stable reference: "<file>::<key>" */
  id: string;
  key: string;
  title: string;
  note?: string;
};

export type Catalog = {
  file: string;
  callee: string;
  items: CatalogItem[];
};

export type ContentInventory = {
  catalogs: Catalog[];
  routes: Array<{ file: string; route: string; method?: string; line?: number }>;
  interactions: ContentInteraction[];
  entrypoints: string[];
  /** Bounded excerpts from high-value product and deployment declarations. */
  architectureDocuments?: Array<{ file: string; role?: ScannedFile["role"]; excerpt: string }>;
  /** Language-neutral behavioral evidence routed to architecture and lens review prompts. */
  evidenceHotspots?: Array<{
    file: string;
    categories: string[];
    line: number;
    offset: number;
    excerpt: string;
  }>;
  /** Distinct source-observed human/product behaviors, kept separate for coverage contracts. */
  behavioralContracts?: Array<{
    file: string;
    line: number;
    text: string;
    title: string;
    terms: string[];
    sequence: number;
    kind?: "outcome" | "constraint" | "journey-step" | "decision";
    /** Natural-language prompts, policies, and workflow declarations describe intended behavior; they do not prove an implementation side effect. */
    evidenceMode?: "declared";
  }>;
  coverage?: {
    eligibleFiles: number;
    inspectedFiles: number;
    excludedFiles: number;
    strategy: "priority-diverse";
  };
};

export type ContentInteraction = {
  file: string;
  kind: "ipc-handle" | "ipc-send" | "http-call" | "http-url" | "http-route" | "event-publish" | "event-subscribe" | "platform-host" | "shared-write" | "shared-read";
  target: string;
  method?: string;
  reference?: string;
  line?: number;
  confidence?: number;
};

const MAX_CANDIDATE_FILES = 60;
const MAX_FILE_BYTES = 200_000;
const MAX_ITEMS_PER_CATALOG = 40;
const MIN_ITEMS_FOR_CATALOG = 3;
const MAX_ROUTES = 30;
const MAX_SEMANTIC_FILES = 480;
const MAX_INTERACTIONS = 200;
const MAX_ARCHITECTURE_DOCUMENTS = 12;
const MAX_ARCHITECTURE_DOCUMENT_CHARS = 2_400;
const MAX_EVIDENCE_HOTSPOTS = 24;
const MAX_HOTSPOT_EXCERPT_CHARS = 700;
const MAX_HOTSPOT_CANDIDATES_PER_FILE = 160;
const MAX_BEHAVIORAL_CONTRACTS = 48;
const MAX_BEHAVIORAL_OUTCOMES_PER_FILE = 8;
const MAX_BEHAVIORAL_CONSTRAINTS_PER_FILE = 12;
const MAX_BEHAVIORAL_JOURNEY_STEPS_PER_FILE = 16;
const MAX_ROUTES_PER_FILE = 8;
const MAX_INTERACTIONS_PER_FILE = 16;

const CANDIDATE_NAME = /registr|catalog|scene|route|template|example|manifest|collection|gallery|preset|command|data|config|index/i;
const ENTRYPOINT_NAME = /^(index|main|app|server|cli|entry)\.(ts|tsx|js|jsx|mjs|py|go|rs|php|cs|dart|kt|swift|zig|sh|bash|zsh|m|mm)$/i;
const ENTRYPOINT_MAX_DEPTH = 4;
const INFRASTRUCTURE_TOKEN = /^(?:get|post|put|patch|delete|options|head|connect|trace|content-type|authorization|accept|origin|user-agent|access-control-[\w-]+|application\/[\w.+-]+|text\/[\w.+-]+|multipart\/[\w.+-]+)$/i;
const ARCHITECTURE_DOCUMENT_NAME = /(?:^|\/)(?:readme(?:\.[^/]+)?|architecture(?:\.[^/]+)?|package\.json|pubspec\.ya?ml|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|dockerfile|docker-compose[^/]*\.ya?ml|wrangler\.toml|netlify\.toml|vercel\.json|serverless\.ya?ml|[^/]*(?:deploy|deployment|workflow|terraform|pulumi|cloudformation|helm|kubernetes|k8s)[^/]*)$/i;

const CONTRACT_STOPWORDS = new Set("a an and are as at be before but by can do does for from has have he her his i if in into is it its me my never not of on only or our she should so that the their them then they this to unless us we when will with you your always make sure important very".split(" "));

function behavioralTerms(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])
    .filter((term) => !CONTRACT_STOPWORDS.has(term) && !/^\d+$/.test(term)))].slice(0, 12);
}

function behavioralTitle(value: string): string {
  const cleaned = value
    .replace(/^.*?=\s*[`"']\s*/, "")
    .replace(/^(?:\s*(?:[-*•]+|\([^)]*\)\s*->|condition\s*:|(?:very\s+)?important\s*[:,]?))+\s*/i, "")
    .replace(/^(?:the\s+assistant\s+)?(?:always|never|only|please|must|should)\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.;:,]+$/, "")
    .trim();
  const words = cleaned.split(" ").slice(0, 9);
  const title = words.join(" ");
  return title ? title[0].toUpperCase() + title.slice(1) : "Observed product behavior";
}

function extractBehavioralContracts(file: string, text: string): Array<NonNullable<ContentInventory["behavioralContracts"]>[number] & { score: number }> {
  const result: Array<NonNullable<ContentInventory["behavioralContracts"]>[number] & { score: number }> = [];
  const action = /\b(?:answer|ask|allow|approve|authenticate|authorize|cancel|capture|choose|collect|complete|confirm|connect|create|delete|display|download|edit|explain|export|extract|feedback|handoff|import|introduce|invite|load|login|migrate|notify|offer|order|pay|process|publish|rate|recap|recommend|reject|reply|request|retry|save|search|select|send|share|show|sign|start|stop|submit|sync|thank|tell|track|update|upload|validate|view|welcome|write)\w*\b/i;
  const human = /\b(?:actor|admin|customer|operator|person|reader|recipient|restaurant|team|user|visitor|waiter|workflow|journey|menu|order|feedback|preference|allerg|confirmation|outcome|rating|survey|dish|meal|service)\w*\b/i;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index].trim().replace(/^\s*(?:\/\/|#|\/\*+|\*+)\s*/, "").replace(/\s*\*\/$/, "");
    // Prompt/policy constants frequently place their first rule after the
    // assignment. Analyze the string content, not the declaration wrapper.
    const raw = sourceLine.replace(/^\s*(?:const|let|var)\s+[\w$]+\s*=\s*[`"']\s*/i, "");
    if (raw.length < 24 || raw.length > 360 || !action.test(raw)) continue;
    if (/^(?:import\b|(?:const|let|var|class|function|if|for|while|type)\b|@param\b|<!--|<\w)|console\s*\.|.*\bconsole\.log\s*\(|.*url\s*\(\s*['"]?data:|.*<svg\b/i.test(raw)) continue;
    if (/^[\w$.[\]]+\s*(?:={1,3}|!={1,2})|^[\w$]+(?:\.[\w$]+)+\s*\(|\b(?:JSON|stringify)\s*\./i.test(raw)) continue;
    if (/^(?:function|regex)\s+to\b/i.test(raw)) continue;
    const explicitJourney = /^\([^)]*\)\s*->/i.test(raw);
    const explicitDecision = /^condition\s*:/i.test(raw);
    const explicitBullet = /^[-*•]/.test(raw);
    const explicitSequence = explicitJourney || explicitDecision || explicitBullet;
    const explicitRule = /\b(?:always|never|must|should|only after|unless|when|before|after)\b/i.test(raw);
    // Free-form implementation comments are not product contracts merely because
    // they contain an action verb. Outside a prompt/list/sequence, require an
    // explicit human-facing signal.
    if (!explicitSequence && !human.test(raw)) continue;
    if ((explicitBullet || explicitDecision) && !human.test(raw)) continue;
    if (!explicitSequence && /[{};]\s*$/.test(raw)) continue;
    const terms = behavioralTerms(raw);
    if (terms.length < 2) continue;
    const textValue = raw.slice(0, 320);
    result.push({
      file,
      line: index + 1,
      text: textValue,
      title: behavioralTitle(textValue),
      terms,
      sequence: index + 1,
      kind: explicitJourney ? "journey-step" : explicitDecision ? "decision" : explicitRule ? "constraint" : "outcome",
      evidenceMode: "declared",
      score: (explicitJourney ? 70 : explicitSequence ? 40 : 0) + (explicitRule ? 20 : 0) + (human.test(raw) ? 25 : 0) + Math.min(20, terms.length)
    });
  }
  const unique = result
    .sort((left, right) => right.score - left.score || left.line - right.line)
    .filter((contract, index, all) => all.findIndex((candidate) => candidate.title.toLowerCase() === contract.title.toLowerCase()) === index);
  // Preserve both independent outcomes/rules and an ordered journey. A single
  // global top-N list lets dense rules crowd out lower-scored sequence steps.
  const outcomes = unique.filter((contract) => contract.kind === "outcome").slice(0, MAX_BEHAVIORAL_OUTCOMES_PER_FILE);
  const constraints = unique.filter((contract) => contract.kind === "constraint").slice(0, MAX_BEHAVIORAL_CONSTRAINTS_PER_FILE);
  const journey = unique.filter((contract) => contract.kind === "journey-step" || contract.kind === "decision").slice(0, MAX_BEHAVIORAL_JOURNEY_STEPS_PER_FILE);
  return [...outcomes, ...constraints, ...journey].sort((left, right) => left.line - right.line);
}

function inventoryCandidateScore(file: ScannedFile, degree: Map<string, number>): number {
  const basename = path.posix.basename(file.relPath);
  const role = file.role ?? "production";
  const roleScore = role === "production" ? 160 : role === "migration" ? 130 : role === "config" ? 80 : role === "tooling" ? 40 : role === "test" || role === "fixture" ? 15 : 5;
  const pathSignal = /(?:^|\/)(?:api|app|bootstrap|client|controller|handler|main|page|route|router|screen|server|service|store|view|worker)(?:\/|\.|$)/i.test(file.relPath) ? 90 : 0;
  return roleScore
    + (ENTRYPOINT_NAME.test(basename) ? 1_000 : 0)
    + Math.min(500, (degree.get(file.relPath) ?? 0) * 20)
    + pathSignal
    + Math.min(40, Math.log2(Math.max(1, file.sizeBytes)) * 3);
}

function selectInventoryCandidates(scan: RepoScan, fileGraph?: FileDependencyGraph): { candidates: ScannedFile[]; eligible: number } {
  const eligible = scan.files.filter((file) => Boolean(file.detectedLanguage ?? file.language) && file.role !== "generated");
  const degree = new Map<string, number>();
  for (const edge of fileGraph?.edges ?? []) {
    const weight = edge.occurrences ?? 1;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + weight);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + weight);
  }
  const ranked = [...eligible].sort((left, right) => inventoryCandidateScore(right, degree) - inventoryCandidateScore(left, degree) || left.relPath.localeCompare(right.relPath));
  if (ranked.length <= MAX_SEMANTIC_FILES) return { candidates: ranked, eligible: eligible.length };
  const directoryKey = (file: ScannedFile): string => {
    const parts = file.relPath.split("/");
    return parts.length <= 2 ? parts[0] : parts.slice(0, 2).join("/");
  };
  const groups = new Map<string, ScannedFile[]>();
  for (const file of ranked) {
    const key = directoryKey(file);
    const list = groups.get(key) ?? [];
    list.push(file);
    groups.set(key, list);
  }
  const selected: ScannedFile[] = [];
  const selectedPaths = new Set<string>();
  const diversityBudget = Math.floor(MAX_SEMANTIC_FILES * 0.4);
  const orderedGroups = [...groups.entries()].sort((left, right) => inventoryCandidateScore(right[1][0], degree) - inventoryCandidateScore(left[1][0], degree));
  let depth = 0;
  while (selected.length < diversityBudget && orderedGroups.some(([, files]) => depth < files.length)) {
    for (const [, files] of orderedGroups) {
      const file = files[depth];
      if (!file || selectedPaths.has(file.relPath)) continue;
      selected.push(file);
      selectedPaths.add(file.relPath);
      if (selected.length >= diversityBudget) break;
    }
    depth += 1;
  }
  for (const file of ranked) {
    if (selected.length >= MAX_SEMANTIC_FILES) break;
    if (selectedPaths.has(file.relPath)) continue;
    selected.push(file);
    selectedPaths.add(file.relPath);
  }
  return { candidates: selected, eligible: eligible.length };
}

function isCandidate(file: ScannedFile): boolean {
  return Boolean(file.detectedLanguage ?? file.language) && CANDIDATE_NAME.test(path.posix.basename(file.relPath));
}

/** Repeated call patterns like scene("id", "Title", ...) — the shape of hand-rolled registries. */
function looksLikeCatalogEntry(key: string, title: string): boolean {
  // Keys are slug-like identifiers; titles read like human text — not colors, paths, or numbers.
  if (!/^[a-z0-9][\w.\- ]*$/i.test(key)) return false;
  if (/^#|^\d+$|^(rgb|hsl)/i.test(title) || !/[A-Za-z]{3}/.test(title)) return false;
  if (INFRASTRUCTURE_TOKEN.test(key.trim()) || INFRASTRUCTURE_TOKEN.test(title.trim())) return false;
  if (/^(?:https?:\/\/|\/api\/|\/v\d+\/)/i.test(key) || /^(?:https?:\/\/|\/api\/|\/v\d+\/)/i.test(title)) return false;
  return key !== title;
}

function extractCallCatalogs(file: string, text: string): Catalog[] {
  const byCallee = new Map<string, CatalogItem[]>();
  const callPattern = /\b([a-zA-Z_$][\w$]*)\(\s*["'`]([^"'`\n]{1,80})["'`]\s*,\s*["'`]([^"'`\n]{1,120})["'`]/g;
  for (const match of text.matchAll(callPattern)) {
    const [whole, callee, key, title] = match;
    if (["require", "import", "expect", "describe", "it", "test", "console", "t"].includes(callee)) continue;
    if (!looksLikeCatalogEntry(key, title)) continue;
    // Look for a descriptive note string among the next arguments of the same call.
    const tail = text.slice((match.index ?? 0) + whole.length, (match.index ?? 0) + whole.length + 400);
    const note = [...tail.matchAll(/["'`]([^"'`\n]{25,200})["'`]/g)].map((noteMatch) => noteMatch[1])[0];
    const items = byCallee.get(callee) ?? [];
    if (items.length < MAX_ITEMS_PER_CATALOG && !items.some((item) => item.key === key)) {
      items.push({ id: `${file}::${key}`, key, title, ...(note ? { note } : {}) });
    }
    byCallee.set(callee, items);
  }
  return [...byCallee.entries()]
    .filter(([, items]) => items.length >= MIN_ITEMS_FOR_CATALOG)
    .map(([callee, items]) => ({ file, callee, items }));
}

/** Repeated object-literal entries like { id: "x", title: "Y", ... }. */
function extractObjectCatalogs(file: string, text: string): Catalog[] {
  const items: CatalogItem[] = [];
  const objectPattern = /\{\s*["']?(?:id|key|slug|name)["']?\s*:\s*["'`]([^"'`\n]{1,80})["'`][^{}]*?["']?(?:title|label|name|description)["']?\s*:\s*["'`]([^"'`\n]{1,160})["'`]/g;
  for (const match of text.matchAll(objectPattern)) {
    const [, key, title] = match;
    if (!looksLikeCatalogEntry(key, title)) continue;
    if (items.length < MAX_ITEMS_PER_CATALOG && !items.some((item) => item.key === key)) {
      items.push({ id: `${file}::${key}`, key, title });
    }
  }
  return items.length >= MIN_ITEMS_FOR_CATALOG ? [{ file, callee: "entries", items }] : [];
}

function lineForOffset(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function offsetForLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return Math.max(0, text.length - 1);
    offset = next + 1;
  }
  return offset;
}

function hotspotExcerpt(text: string, offset: number): string {
  const half = Math.floor(MAX_HOTSPOT_EXCERPT_CHARS / 2);
  const start = Math.max(0, offset - half);
  const end = Math.min(text.length, start + MAX_HOTSPOT_EXCERPT_CHARS);
  return text.slice(start, end).trim();
}

function extractEvidenceHotspots(
  file: ScannedFile,
  text: string,
  fileInteractions: ContentInteraction[],
  detectedRoutes: ContentInventory["routes"]
): Array<NonNullable<ContentInventory["evidenceHotspots"]>[number] & { score: number }> {
  const candidates: Array<{ offset: number; category: string; score: number }> = [];
  const add = (offset: number, category: string, score: number): void => {
    if (candidates.length >= MAX_HOTSPOT_CANDIDATES_PER_FILE || !Number.isFinite(offset) || offset < 0) return;
    candidates.push({ offset, category, score });
  };
  for (const interaction of fileInteractions) {
    add(offsetForLine(text, interaction.line ?? 1), interaction.kind === "http-route" || interaction.kind === "ipc-handle" ? "runtime-boundary" : "runtime-contract", 110);
  }
  for (const route of detectedRoutes) add(offsetForLine(text, route.line ?? 1), "route", 105);
  if (ENTRYPOINT_NAME.test(path.posix.basename(file.relPath))) add(0, "entrypoint", 100);

  // Long human-facing strings often contain the product rules, prompts, domain
  // vocabulary, or protocol contracts that imports and symbols cannot reveal.
  const classifyHumanContract = (value: string): "business-rule" | "human-facing-contract" =>
    /\b(?:must|should|never|always|only|when|if|unless|require|allow|forbid|policy|rule|instruction|prompt)\b/i.test(value)
      ? "business-rule"
      : "human-facing-contract";
  const longString = /(["'])([^\n]{100,1200})\1/g;
  for (const match of text.matchAll(longString)) {
    if (candidates.length >= MAX_HOTSPOT_CANDIDATES_PER_FILE) break;
    const value = match[2];
    if (!/[A-Za-z]{4}/.test(value) || /^(?:https?:\/\/|data:)/i.test(value.trim())) continue;
    add(match.index ?? 0, classifyHumanContract(value), 82);
  }
  // Multiline templates/prompts frequently encode the actual product workflow.
  // Cover common language-neutral delimiter shapes without parsing stack syntax.
  const multilineStrings = [/`([\s\S]{100,12000}?)`/g, /"""([\s\S]{100,12000}?)"""/g, /'''([\s\S]{100,12000}?)'''/g];
  for (const pattern of multilineStrings) {
    for (const match of text.matchAll(pattern)) {
      if (candidates.length >= MAX_HOTSPOT_CANDIDATES_PER_FILE) break;
      const value = match[1];
      if (!/[A-Za-z]{4}/.test(value)) continue;
      add(match.index ?? 0, classifyHumanContract(value), 88);
    }
  }

  const behavioral = /\b(?:workflow|journey|transition|state|action|command|handler|submit|connect|disconnect|start|stop|create|update|delete|save|load|send|receive|validate|authorize|authenticate|approve|reject|retry|cancel)\w*\b/gi;
  for (const match of text.matchAll(behavioral)) {
    if (candidates.length >= MAX_HOTSPOT_CANDIDATES_PER_FILE) break;
    add(match.index ?? 0, "behavior", 55);
  }
  if (/(?:^|\/)(?:ui|view|views|screen|screens|page|pages|component|components|widget|widgets|store|stores|state)(?:\/|\.)/i.test(file.relPath)) {
    add(0, /(?:store|state)(?:\/|\.)/i.test(file.relPath) ? "application-state" : "user-interface", 70);
  }

  const ranked = candidates.sort((left, right) => right.score - left.score || left.offset - right.offset);
  const selected: typeof ranked = [];
  for (const candidate of ranked) {
    const near = selected.find((item) => Math.abs(item.offset - candidate.offset) < MAX_HOTSPOT_EXCERPT_CHARS);
    if (near) {
      if (!near.category.split(",").includes(candidate.category)) near.category += `,${candidate.category}`;
      continue;
    }
    if (selected.length < 2) selected.push({ ...candidate });
  }
  return selected.map((candidate) => ({
    file: file.relPath,
    categories: candidate.category.split(","),
    line: lineForOffset(text, candidate.offset),
    offset: candidate.offset,
    excerpt: hotspotExcerpt(text, candidate.offset),
    score: candidate.score
  }));
}

function extractRoutes(file: string, text: string): ContentInventory["routes"] {
  const routes: ContentInventory["routes"] = [];
  const routePattern = /\b(?:path|route)\s*[:=]\s*["'`](\/[^"'`\s]*)["'`]/g;
  for (const match of text.matchAll(routePattern)) {
    if (!routes.some((entry) => entry.route === match[1])) routes.push({ file, route: match[1], line: lineForOffset(text, match.index ?? 0) });
  }
  return routes;
}

function extractInteractions(file: string, text: string): ContentInventory["interactions"] {
  const found: ContentInventory["interactions"] = [];
  const add = (interaction: Omit<ContentInteraction, "file">): void => {
    if (!found.some((item) => item.kind === interaction.kind && item.target === interaction.target && item.method === interaction.method)) {
      found.push({ file, ...interaction });
    }
  };
  const patterns: Array<{ kind: ContentInteraction["kind"]; regex: RegExp; confidence?: number }> = [
    { kind: "ipc-handle", regex: /\bipcMain\s*\.\s*(?:handle|on)\s*\(\s*["'`]([^"'`]+)["'`]/g, confidence: 1 },
    { kind: "ipc-send", regex: /\bipcRenderer\s*\.\s*(?:invoke|send)\s*\(\s*["'`]([^"'`]+)["'`]/g, confidence: 1 },
    // Native shells embedding a Flutter runtime are literal, unambiguous host evidence.
    { kind: "platform-host", regex: /\b(FlutterActivity|FlutterFragmentActivity|FlutterAppDelegate|GeneratedPluginRegistrant)\b/g, confidence: 0.97 }
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      add({ kind: pattern.kind, target: match[1], line: lineForOffset(text, match.index ?? 0), confidence: pattern.confidence });
    }
  }

  // Ecosystem detectors are additive adapters over the language-neutral scanner.
  // Unsupported stacks still retain imports, symbols, manifests, routes, and literals.
  const channelVariables = new Map<string, string>();
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:const\s+)?(?:MethodChannel|EventChannel)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    channelVariables.set(match[1], match[2]);
  }
  for (const [variable, channel] of channelVariables) {
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of text.matchAll(new RegExp(`\\b${escaped}\\s*\\.\\s*invokeMethod(?:<[^>]+>)?\\s*\\(\\s*["']([^"']+)["']`, "g"))) {
      add({ kind: "ipc-send", target: `${channel}#${match[1]}`, line: lineForOffset(text, match.index ?? 0), confidence: 0.99 });
    }
  }
  for (const match of text.matchAll(/\b(?:MethodChannel|FlutterMethodChannel)\s*\([^\n]{0,180}?(?:name\s*:\s*)?["'`]([^"'`]+)["'`][\s\S]{0,240}?(?:setMethodCallHandler|setMethodCallHandlerWithResult)/g)) {
    add({ kind: "ipc-handle", target: `${match[1]}#*`, line: lineForOffset(text, match.index ?? 0), confidence: 0.97 });
  }
  for (const match of text.matchAll(/\bHomeWidget\s*\.\s*saveWidgetData(?:<[^>]+>)?\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    add({ kind: "shared-write", target: match[1], line: lineForOffset(text, match.index ?? 0), confidence: 0.99 });
  }
  for (const match of text.matchAll(/\bHomeWidget\s*\.\s*getWidgetData(?:<[^>]+>)?\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    add({ kind: "shared-read", target: match[1], line: lineForOffset(text, match.index ?? 0), confidence: 0.99 });
  }
  for (const match of text.matchAll(/\b(?:getString|getBoolean|getInt|getLong|getFloat|getDouble)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    add({ kind: "shared-read", target: match[1], line: lineForOffset(text, match.index ?? 0), confidence: 0.92 });
  }
  for (const match of text.matchAll(/\b(?:string|bool|integer|double|object)\s*\(\s*forKey\s*:\s*["'`]([^"'`]+)["'`]/g)) {
    add({ kind: "shared-read", target: match[1], line: lineForOffset(text, match.index ?? 0), confidence: 0.94 });
  }

  for (const match of text.matchAll(/\baxios\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) {
    add({ kind: "http-call", target: match[2], method: match[1].toUpperCase(), line: lineForOffset(text, match.index ?? 0), confidence: 0.98 });
  }
  for (const match of text.matchAll(/\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    const tail = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 300);
    const method = tail.match(/\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/i)?.[1]?.toUpperCase() ?? "GET";
    add({ kind: "http-call", target: match[1], method, line: lineForOffset(text, match.index ?? 0), confidence: 0.96 });
  }
  const literalUrls = new Map<string, string>();
  for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`](https?:\/\/[^"'`\s]+)["'`]/g)) {
    literalUrls.set(match[1], match[2]);
  }
  for (const [variable, target] of literalUrls) {
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of text.matchAll(new RegExp(`\\bfetch\\s*\\(\\s*${escaped}\\b`, "g"))) {
      const tail = text.slice(match.index ?? 0, (match.index ?? 0) + 360);
      const method = tail.match(/\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/i)?.[1]?.toUpperCase() ?? "GET";
      add({ kind: "http-call", target, method, reference: variable, line: lineForOffset(text, match.index ?? 0), confidence: 0.97 });
    }
  }
  for (const match of text.matchAll(/\b(?:requests|httpx)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/gi)) {
    add({ kind: "http-call", target: match[2], method: match[1].toUpperCase(), line: lineForOffset(text, match.index ?? 0), confidence: 0.98 });
  }
  for (const match of text.matchAll(/\b(?:http|client|dio)\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*(?:Uri\.parse\s*\(\s*)?["'`]([^"'`]+)["'`]/gi)) {
    add({ kind: "http-call", target: match[2], method: match[1].toUpperCase(), line: lineForOffset(text, match.index ?? 0), confidence: 0.96 });
  }
  for (const match of text.matchAll(/(?:Future\s*<\s*Uri\s*>|Uri)\s+([A-Za-z_$][\w$]*Uri)\s*\([^)]*\)[\s\S]{0,500}?Uri\.parse\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    add({ kind: "http-url", target: match[2], reference: match[1], line: lineForOffset(text, match.index ?? 0), confidence: 0.97 });
  }
  // Cross-file endpoint factories (for example AppConfig.getReportUri()) are a
  // high-confidence URL reference even when the eventual HTTP helper receives a variable.
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9_$]*\s*\.\s*([A-Za-z_$][\w$]*Uri)\s*\(/g)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 100), match.index ?? 0);
    const method = prefix.match(/\b(?:http|client|dio)\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*(?:await\s+)?$/i)?.[1]?.toUpperCase();
    add({ kind: "http-call", target: `@uri:${match[1]}`, method, line: lineForOffset(text, match.index ?? 0), confidence: 0.94 });
  }
  for (const match of text.matchAll(/\b(?:app|router|server|fastify)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) {
    add({ kind: "http-route", target: match[2], method: match[1].toUpperCase(), line: lineForOffset(text, match.index ?? 0), confidence: 0.99 });
  }
  for (const match of text.matchAll(/@(?:app|router)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) {
    add({ kind: "http-route", target: match[2], method: match[1].toUpperCase(), line: lineForOffset(text, match.index ?? 0), confidence: 0.99 });
  }
  for (const match of text.matchAll(/@(?:app|blueprint|bp)\s*\.\s*route\s*\(\s*["']([^"']+)["']([^)]*)\)/gi)) {
    const methods = match[2].match(/methods\s*=\s*\[([^\]]+)\]/i)?.[1].match(/["']([A-Z]+)["']/i)?.[1]?.toUpperCase();
    add({ kind: "http-route", target: match[1], method: methods, line: lineForOffset(text, match.index ?? 0), confidence: 0.99 });
  }
  for (const match of text.matchAll(/\b(?:path|re_path)\s*\(\s*["']([^"']+)["']/g)) {
    add({ kind: "http-route", target: `/${match[1].replace(/^\^?\//, "").replace(/\$$/, "")}`, line: lineForOffset(text, match.index ?? 0), confidence: 0.97 });
  }
  for (const match of text.matchAll(/\bRoute\s*::\s*(get|post|put|patch|delete|options)\s*\(\s*["']([^"']+)["']/gi)) {
    add({ kind: "http-route", target: match[2], method: match[1].toUpperCase(), line: lineForOffset(text, match.index ?? 0), confidence: 0.99 });
  }
  for (const match of text.matchAll(/\b(?:http\s*\.\s*HandleFunc|[A-Za-z_$][\w$]*\s*\.\s*(Get|Post|Put|Patch|Delete|Options))\s*\(\s*["`]([^"`]+)["`]/g)) {
    add({ kind: "http-route", target: match[2], method: match[1]?.toUpperCase(), line: lineForOffset(text, match.index ?? 0), confidence: 0.98 });
  }
  for (const match of text.matchAll(/^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/gim)) {
    add({ kind: "http-route", target: match[2], method: match[1].toUpperCase(), line: lineForOffset(text, match.index ?? 0), confidence: 0.96 });
  }
  for (const match of text.matchAll(/^\s*resources\s+:([A-Za-z_][\w]*)/gim)) {
    add({ kind: "http-route", target: `/${match[1]}`, line: lineForOffset(text, match.index ?? 0), confidence: 0.94 });
  }
  for (const match of text.matchAll(/@(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g)) {
    add({ kind: "http-route", target: match[2], method: match[1].toUpperCase(), line: lineForOffset(text, match.index ?? 0), confidence: 0.99 });
  }
  // Worker-style routers often dispatch by comparing URL.pathname and request.method.
  // The literal path is strong evidence; only attach a method when it is stated nearby.
  for (const match of text.matchAll(/\b(?:url\s*\.\s*)?pathname\s*={2,3}\s*["'`]([^"'`]+)["'`]/gi)) {
    add({ kind: "http-route", target: match[1], line: lineForOffset(text, match.index ?? 0), confidence: 0.92 });
  }
  return found;
}

export async function buildContentInventory(projectRoot: string, scan: RepoScan, options: { sourceReader?: ImportSourceReader; fileGraph?: FileDependencyGraph } = {}): Promise<ContentInventory> {
  const catalogCandidates = new Set(scan.files.filter(isCandidate).slice(0, MAX_CANDIDATE_FILES).map((file) => file.relPath));
  const selection = selectInventoryCandidates(scan, options.fileGraph);
  const candidates = selection.candidates;
  const catalogs: Catalog[] = [];
  const routeCandidates: ContentInventory["routes"] = [];
  const interactionCandidates: ContentInventory["interactions"] = [];
  const architectureDocuments: NonNullable<ContentInventory["architectureDocuments"]> = [];
  const evidenceHotspots: Array<NonNullable<ContentInventory["evidenceHotspots"]>[number] & { score: number }> = [];
  const behavioralContracts: Array<NonNullable<ContentInventory["behavioralContracts"]>[number] & { score: number }> = [];
  const candidatePriority = new Map(candidates.map((file, index) => [file.relPath, candidates.length - index]));

  for (const file of candidates) {
    const bytes = options.sourceReader ? await options.sourceReader.read(file.relPath) : await readFile(path.join(projectRoot, file.relPath)).catch(() => null);
    if (!bytes || bytes.length > MAX_FILE_BYTES || bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (catalogCandidates.has(file.relPath)) {
      const callCatalogs = extractCallCatalogs(file.relPath, text);
      // Prefer call-style catalogs; object-literal scan only when calls found nothing in this file.
      catalogs.push(...(callCatalogs.length ? callCatalogs : extractObjectCatalogs(file.relPath, text)));
    }
    const fileInteractions = extractInteractions(file.relPath, text);
    const detectedRoutes = [
        ...extractRoutes(file.relPath, text),
        ...fileInteractions.filter((item) => item.kind === "http-route").map((item) => ({ file: item.file, route: item.target, method: item.method, line: item.line }))
      ];
    for (const route of detectedRoutes) if (!routeCandidates.some((item) => item.file === route.file && item.route === route.route && item.method === route.method)) routeCandidates.push(route);
    interactionCandidates.push(...fileInteractions);
    evidenceHotspots.push(...extractEvidenceHotspots(file, text, fileInteractions, detectedRoutes));
    behavioralContracts.push(...extractBehavioralContracts(file.relPath, text));
  }

  const boundedPerFile = <T extends { file: string }>(items: T[], limit: number, perFile: number, score: (item: T) => number): T[] => {
    const counts = new Map<string, number>();
    return [...items].sort((left, right) => score(right) - score(left) || left.file.localeCompare(right.file)).filter((item) => {
      const count = counts.get(item.file) ?? 0;
      if (count >= perFile) return false;
      counts.set(item.file, count + 1);
      return true;
    }).slice(0, limit);
  };
  const routes = boundedPerFile(routeCandidates, MAX_ROUTES, MAX_ROUTES_PER_FILE, (item) => candidatePriority.get(item.file) ?? 0);
  const interactions = boundedPerFile(interactionCandidates, MAX_INTERACTIONS, MAX_INTERACTIONS_PER_FILE, (item) => (candidatePriority.get(item.file) ?? 0) + Math.round((item.confidence ?? 0.8) * 100));

  // Product READMEs and deployment/config declarations often explain the big
  // picture that cannot be reconstructed from imports alone. Keep this generic
  // across stacks and bounded so the architecture provider receives evidence,
  // not an unbounded repository dump.
  const documentCandidates = scan.files
    .filter((file) => ARCHITECTURE_DOCUMENT_NAME.test(file.relPath))
    .sort((left, right) => {
      const rank = (file: ScannedFile): number => /(?:^|\/)readme/i.test(file.relPath) ? 3 : /deploy|workflow|docker|wrangler|netlify|serverless|terraform|pulumi|cloudformation|helm|kubernetes|k8s/i.test(file.relPath) ? 2 : 1;
      return rank(right) - rank(left) || left.relPath.localeCompare(right.relPath);
    })
    .slice(0, MAX_ARCHITECTURE_DOCUMENTS);
  for (const file of documentCandidates) {
    const bytes = options.sourceReader ? await options.sourceReader.read(file.relPath) : await readFile(path.join(projectRoot, file.relPath)).catch(() => null);
    if (!bytes || bytes.includes(0)) continue;
    const excerpt = bytes.toString("utf8", 0, Math.min(bytes.length, MAX_ARCHITECTURE_DOCUMENT_CHARS)).trim();
    if (excerpt) architectureDocuments.push({ file: file.relPath, role: file.role, excerpt });
  }

  // Keep the strongest catalog per file (most items) to avoid double-reporting helper wrappers.
  const bestByFile = new Map<string, Catalog>();
  for (const catalog of catalogs) {
    const existing = bestByFile.get(catalog.file);
    if (!existing || catalog.items.length > existing.items.length) bestByFile.set(catalog.file, catalog);
  }

  const entrypoints = scan.files
    .filter((file) => ENTRYPOINT_NAME.test(path.posix.basename(file.relPath))
      && file.relPath.split("/").length <= ENTRYPOINT_MAX_DEPTH
      && file.role !== "test" && file.role !== "fixture")
    .map((file) => file.relPath)
    .slice(0, 20);

  return {
    catalogs: [...bestByFile.values()].slice(0, 8),
    routes,
    interactions,
    entrypoints,
    architectureDocuments,
    evidenceHotspots: evidenceHotspots
      .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file) || left.offset - right.offset)
      .slice(0, MAX_EVIDENCE_HOTSPOTS)
      .map(({ score: _score, ...hotspot }) => hotspot),
    behavioralContracts: behavioralContracts
      .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file) || left.line - right.line)
      .filter((contract, index, all) => all.findIndex((candidate) => candidate.file === contract.file && candidate.title.toLowerCase() === contract.title.toLowerCase()) === index)
      .slice(0, MAX_BEHAVIORAL_CONTRACTS)
      .sort((left, right) => left.file.localeCompare(right.file) || left.sequence - right.sequence)
      .map(({ score: _score, ...contract }) => contract),
    coverage: {
      eligibleFiles: selection.eligible,
      inspectedFiles: candidates.length,
      excludedFiles: Math.max(0, selection.eligible - candidates.length),
      strategy: "priority-diverse"
    }
  };
}
