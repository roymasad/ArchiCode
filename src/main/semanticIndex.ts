import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AutoTokenizer, env, pipeline } from "@huggingface/transformers";
import type { ProjectBundle } from "../shared/schema";
import type { ParsedFile, ParsedSemanticSymbol, RepoScan } from "./importer/types";
import { languageForSemanticSource } from "./importer/sourceLanguages";

export const SEMANTIC_VECTOR_DIMENSIONS = 384;
export const SEMANTIC_MEMORY_PROFILE_MB = 512;

export type SemanticModelPreferenceId = "bge-small-en-v1.5" | "minilm-l6-v2";
export const DEFAULT_SEMANTIC_MODEL_PREFERENCE: SemanticModelPreferenceId = "bge-small-en-v1.5";
export const SEMANTIC_MODEL_OPTIONS = [
  { id: "bge-small-en-v1.5", label: "BGE Small · Higher quality", description: "Best semantic retrieval quality; uses a 512-token context window." },
  { id: "minilm-l6-v2", label: "MiniLM · Faster", description: "Lower CPU cost; uses a 128-token context window." }
] as const;

type SemanticModelProfile = {
  preferenceId: SemanticModelPreferenceId;
  modelId: string;
  version: string;
  maxTokens: number;
  headerTokens: number;
  overlapTokens: number;
  pooling: "cls" | "mean";
  queryPrefix: string;
};

const SEMANTIC_MODEL_PROFILES: Record<SemanticModelPreferenceId, SemanticModelProfile> = {
  "bge-small-en-v1.5": {
    preferenceId: "bge-small-en-v1.5",
    modelId: "BAAI/bge-small-en-v1.5",
    version: "bge-small-en-v1.5-q8-c5ac6c3-hierarchical-v4",
    maxTokens: 512,
    headerTokens: 72,
    overlapTokens: 32,
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: "
  },
  "minilm-l6-v2": {
    preferenceId: "minilm-l6-v2",
    modelId: "Xenova/all-MiniLM-L6-v2",
    version: "all-MiniLM-L6-v2-q8-751bff3-hierarchical-v4",
    maxTokens: 128,
    headerTokens: 44,
    overlapTokens: 12,
    pooling: "mean",
    queryPrefix: ""
  }
};

let selectedModelPreference: SemanticModelPreferenceId = DEFAULT_SEMANTIC_MODEL_PREFERENCE;
let semanticGeneration = 0;

export function isSemanticModelPreferenceId(value: unknown): value is SemanticModelPreferenceId {
  return value === "bge-small-en-v1.5" || value === "minilm-l6-v2";
}

export function getSemanticModelPreference(): SemanticModelPreferenceId {
  return selectedModelPreference;
}

function currentModel(): SemanticModelProfile {
  return SEMANTIC_MODEL_PROFILES[selectedModelPreference];
}

export type SemanticDocumentKind = "code-file" | "graph-node" | "graph-note" | "graph-rule" | "artifact";

export type SemanticDocument = {
  key: string;
  kind: SemanticDocumentKind;
  ref: string;
  text: string;
  metadata?: Record<string, string>;
};

type SemanticCacheEntry = {
  key: string;
  kind: SemanticDocumentKind;
  ref: string;
  contentHash: string;
  offset: number;
  length: number;
  preview: string;
  metadata?: Record<string, string>;
};

type SemanticCacheManifest = {
  schemaVersion: 3;
  modelId: string;
  modelVersion: string;
  dimensions: number;
  updatedAt: string;
  entries: SemanticCacheEntry[];
  coverage?: SemanticIndexCoverage;
};

type LoadedIndex = { manifest: SemanticCacheManifest; vectors: Float32Array };
type DerivedSemanticDocument = { document: SemanticDocument; vector: Float32Array; contentHash: string };
type CachedLoadedIndex = { index: LoadedIndex; manifestSignature: string; vectorSignature: string; sizeBytes: number; lastAccess: number };

export type SemanticIndexStatus = {
  state: "disabled" | "unavailable" | "empty" | "graph-only" | "indexing" | "ready" | "partial" | "stale" | "error";
  enabled: boolean;
  modelId: string;
  modelVersion: string;
  modelBundled: boolean;
  indexedItems: number;
  graphItems: number;
  codeItems: number;
  cacheSizeBytes: number;
  updatedAt?: string;
  message: string;
  error?: string;
  coverage?: SemanticIndexCoverage;
};

export type SemanticIndexCoverage = {
  eligibleFiles: number;
  indexedFiles: number;
  sourceLines: number;
  indexedSourceLines: number;
  symbols: number;
  chunks: number;
  excludedGeneratedFiles: number;
  failedFiles: Array<{ path: string; reason: string }>;
  complete: boolean;
};

export type SemanticCodeDocumentSet = { documents: SemanticDocument[]; coverage: SemanticIndexCoverage };

function semanticLanguageForFile(file: RepoScan["files"][number]): string | null {
  return languageForSemanticSource(file.relPath);
}

export type SemanticIndexProgress = {
  phase: "scanning" | "loading-model" | "embedding" | "saving" | "ready" | "error";
  completed: number;
  total: number;
  message: string;
  projectRoot?: string;
  reused?: number;
  documentTotal?: number;
};

export function semanticIndexNeedsWarmup(status: SemanticIndexStatus): boolean {
  return status.enabled && (status.state === "empty" || status.state === "graph-only" || status.state === "stale" || (status.state === "error" && status.coverage?.complete === false));
}

export type SemanticSearchResult = {
  key: string;
  kind: SemanticDocumentKind;
  ref: string;
  score: number;
  preview: string;
  metadata?: Record<string, string>;
  matches?: Array<{ score: number; preview: string; metadata?: Record<string, string> }>;
};

export type SemanticNodeContext = {
  state: "disabled" | "unavailable" | "not-indexed" | "current" | "stale" | "error";
  indexed: boolean;
  modelId: string;
  updatedAt?: string;
  message: string;
  codeItems: number;
  relatedNodes: Array<{ flowId: string; nodeId: string; title: string; score: number }>;
  relatedCode: Array<{ path: string; score: number; preview: string; symbol?: string; startLine?: number; endLine?: number }>;
};

export type SemanticCodeLineContext = {
  state: "disabled" | "unavailable" | "not-indexed" | "current" | "error";
  indexed: boolean;
  message: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  relatedNodes: Array<{
    flowId: string;
    nodeId: string;
    title: string;
    description: string;
    type: string;
    stage: string;
    score: number;
    relationship?: "own" | "share" | "cover";
    acceptanceCriteria: string[];
  }>;
  relatedCode: Array<{ path: string; symbol: string; startLine?: number; endLine?: number; score: number }>;
};

let semanticDataRoot: string | null = null;
let semanticModelRoot: string | null = null;
let featurePipeline: Promise<Awaited<ReturnType<typeof pipeline<"feature-extraction">>>> | null = null;
let semanticTokenizer: Promise<Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>> | null = null;
const activeJobs = new Map<string, { generation: number; promise: Promise<LoadedIndex> }>();
const runtimeErrors = new Map<string, string>();
const loadedIndexCache = new Map<string, CachedLoadedIndex>();
const savingProjects = new Set<string>();
const MAX_LOADED_INDEX_CACHE_BYTES = SEMANTIC_MEMORY_PROFILE_MB * 1024 * 1024;

export function setSemanticIndexRoots(dataRoot: string, modelRoot: string): void {
  semanticDataRoot = path.join(dataRoot, "semantic-index");
  semanticModelRoot = modelRoot;
  loadedIndexCache.clear();
}

function requireRoots(): { dataRoot: string; modelRoot: string } {
  if (!semanticDataRoot || !semanticModelRoot) throw new Error("Semantic index service has not been initialized.");
  return { dataRoot: semanticDataRoot, modelRoot: semanticModelRoot };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectDirectory(projectRoot: string): string {
  return path.join(requireRoots().dataRoot, sha256(path.resolve(projectRoot)).slice(0, 24));
}

function manifestPath(projectRoot: string): string {
  return path.join(projectDirectory(projectRoot), "index.json");
}

function vectorsPath(projectRoot: string): string {
  return path.join(projectDirectory(projectRoot), "vectors.f32");
}

function bundledModelPath(): string {
  return path.join(requireRoots().modelRoot, ...currentModel().modelId.split("/"), "onnx", "model_quantized.onnx");
}

async function modelBundled(): Promise<boolean> {
  return Boolean(await stat(bundledModelPath()).catch(() => null));
}

function normalize(vector: Float32Array): Float32Array {
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  const divisor = Math.sqrt(magnitude) || 1;
  const normalized = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) normalized[index] = vector[index] / divisor;
  return normalized;
}

function averageVectors(vectors: Float32Array[]): Float32Array | null {
  if (!vectors.length) return null;
  const sum = new Float32Array(SEMANTIC_VECTOR_DIMENSIONS);
  for (const vector of vectors) {
    for (let dimension = 0; dimension < sum.length; dimension += 1) sum[dimension] += vector[dimension];
  }
  return normalize(sum);
}

function deriveHierarchicalCodeDocuments(documents: SemanticDocument[], vectorsByKey: Map<string, Float32Array>): DerivedSemanticDocument[] {
  const derived: DerivedSemanticDocument[] = [];
  const sourceDocuments = documents.filter((document) => document.kind === "code-file" && document.metadata?.level === "source-chunk" && vectorsByKey.has(document.key));
  const symbolGroups = new Map<string, SemanticDocument[]>();
  for (const document of sourceDocuments) {
    const symbol = document.metadata?.symbol;
    if (!symbol) continue;
    const names = symbol.split(".").map((_part, index, parts) => parts.slice(0, index + 1).join("."));
    for (const name of names) {
      const key = `${document.ref}\0${name}`;
      const group = symbolGroups.get(key) ?? [];
      group.push(document);
      symbolGroups.set(key, group);
    }
  }
  const symbolVectorsByFile = new Map<string, Array<{ symbol: string; vector: Float32Array }>>();
  for (const [key, group] of symbolGroups) {
    const separator = key.indexOf("\0");
    const ref = key.slice(0, separator);
    const symbol = key.slice(separator + 1);
    const vector = averageVectors(group.flatMap((document) => {
      const value = vectorsByKey.get(document.key);
      return value ? [value] : [];
    }));
    if (!vector) continue;
    const startLine = Math.min(...group.map((document) => Number(document.metadata?.startLine ?? 0)).filter(Boolean));
    const endLine = Math.max(...group.map((document) => Number(document.metadata?.endLine ?? 0)).filter(Boolean));
    const signature = sha256(group.map((document) => `${document.key}:${sha256(document.text)}`).sort().join("\n"));
    const document: SemanticDocument = {
      key: `code-symbol-pool:${ref}:${sha256(symbol).slice(0, 20)}`,
      kind: "code-file",
      ref,
      text: `Hierarchical semantic representation\nFile: ${ref}\nSymbol: ${symbol}\nSource chunks: ${group.length}`,
      metadata: { level: "symbol-pool", path: ref, symbol, startLine: String(startLine), endLine: String(endLine), sourceChunks: String(group.length) }
    };
    derived.push({ document, vector, contentHash: signature });
    const values = symbolVectorsByFile.get(ref) ?? [];
    values.push({ symbol, vector });
    symbolVectorsByFile.set(ref, values);
  }

  const fileRefs = new Set(documents.filter((document) => document.kind === "code-file").map((document) => document.ref));
  for (const ref of fileRefs) {
    const summary = documents.find((document) => document.ref === ref && document.metadata?.level === "file-summary");
    const summaryVector = summary ? vectorsByKey.get(summary.key) : undefined;
    const unscopedVector = averageVectors(sourceDocuments
      .filter((document) => document.ref === ref && !document.metadata?.symbol)
      .flatMap((document) => vectorsByKey.get(document.key) ? [vectorsByKey.get(document.key)!] : []));
    const symbolVectors = symbolVectorsByFile.get(ref) ?? [];
    const leafSymbolVectors = symbolVectors.filter((candidate) => !symbolVectors.some((other) => other.symbol !== candidate.symbol && other.symbol.startsWith(`${candidate.symbol}.`)));
    const balanced = [summaryVector, unscopedVector, ...leafSymbolVectors.map((item) => item.vector)].filter((vector): vector is Float32Array => Boolean(vector));
    const vector = averageVectors(balanced);
    if (!vector) continue;
    const signature = sha256([
      summary ? `${summary.key}:${sha256(summary.text)}` : "",
      ...sourceDocuments.filter((document) => document.ref === ref).map((document) => `${document.key}:${sha256(document.text)}`).sort()
    ].join("\n"));
    const document: SemanticDocument = {
      key: `code-file-pool:${ref}`,
      kind: "code-file",
      ref,
      text: `Balanced hierarchical file representation\nFile: ${ref}\nComponents: ${leafSymbolVectors.length}\nIncludes file summary and all component/source regions.`,
      metadata: { level: "file-pool", path: ref, components: String(leafSymbolVectors.length) }
    };
    derived.push({ document, vector, contentHash: signature });
  }
  return derived;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) score += left[index] * right[index];
  return score;
}

async function loadPipeline(): Promise<Awaited<ReturnType<typeof pipeline<"feature-extraction">>>> {
  if (!featurePipeline) {
    featurePipeline = (async () => {
      const { modelRoot } = requireRoots();
      env.localModelPath = modelRoot;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      return pipeline("feature-extraction", currentModel().modelId, { dtype: "q8" });
    })();
    featurePipeline.catch(() => {
      featurePipeline = null;
    });
  }
  return featurePipeline;
}

async function loadTokenizer(): Promise<Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>> {
  if (!semanticTokenizer) {
    const { modelRoot } = requireRoots();
    env.localModelPath = modelRoot;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    semanticTokenizer = AutoTokenizer.from_pretrained(currentModel().modelId, { local_files_only: true });
    semanticTokenizer.catch(() => { semanticTokenizer = null; });
  }
  return semanticTokenizer;
}

export async function semanticTokenCount(text: string): Promise<number> {
  return (await loadTokenizer()).encode(text, { add_special_tokens: true }).length;
}

async function embedTexts(texts: string[], purpose: "document" | "query"): Promise<Float32Array[]> {
  const model = currentModel();
  const [extractor, tokenizer] = await Promise.all([loadPipeline(), loadTokenizer()]);
  const prepared = texts.map((text) => {
    const value = purpose === "query" && model.queryPrefix ? `${model.queryPrefix}${text}` : text;
    const tokens = tokenizer.encode(value, { add_special_tokens: false });
    return tokens.length <= model.maxTokens - 2
      ? value
      : tokenizer.decode(tokens.slice(0, model.maxTokens - 2), { skip_special_tokens: true, clean_up_tokenization_spaces: false });
  });
  const output = await extractor(prepared, { pooling: model.pooling, normalize: true });
  const tensor = output as unknown as { data: Float32Array | number[]; dims: number[] };
  const data = tensor.data instanceof Float32Array ? tensor.data : Float32Array.from(tensor.data);
  const dimensions = tensor.dims.at(-1) ?? SEMANTIC_VECTOR_DIMENSIONS;
  return texts.map((_, index) => normalize(data.slice(index * dimensions, (index + 1) * dimensions)));
}

class SemanticModelChangedError extends Error {
  constructor() {
    super("Semantic indexing was cancelled because the embedding model changed.");
    this.name = "SemanticModelChangedError";
  }
}

function assertCurrentGeneration(generation: number): void {
  if (generation !== semanticGeneration) throw new SemanticModelChangedError();
}

export function initializeSemanticModelPreference(preference: SemanticModelPreferenceId): void {
  selectedModelPreference = preference;
}

export async function switchSemanticModelPreference(preference: SemanticModelPreferenceId): Promise<void> {
  if (preference === selectedModelPreference) return;
  semanticGeneration += 1;
  selectedModelPreference = preference;
  const oldPipeline = featurePipeline;
  const supersededJobs = [...activeJobs.values()].map((job) => job.promise);
  featurePipeline = null;
  semanticTokenizer = null;
  await Promise.allSettled(supersededJobs);
  loadedIndexCache.clear();
  runtimeErrors.clear();
  if (semanticDataRoot) await rm(semanticDataRoot, { recursive: true, force: true });
  const loadedPipeline = await oldPipeline?.catch(() => null);
  if (loadedPipeline && "dispose" in loadedPipeline && typeof loadedPipeline.dispose === "function") await loadedPipeline.dispose();
}

function fileSignature(value: Awaited<ReturnType<typeof stat>>): string {
  return `${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

function evictLoadedIndexes(protectedProjectRoot: string): void {
  let total = [...loadedIndexCache.values()].reduce((sum, item) => sum + item.sizeBytes, 0);
  if (total <= MAX_LOADED_INDEX_CACHE_BYTES) return;
  const oldest = [...loadedIndexCache.entries()].sort((left, right) => left[1].lastAccess - right[1].lastAccess);
  for (const [projectRoot, item] of oldest) {
    if (projectRoot === protectedProjectRoot) continue;
    loadedIndexCache.delete(projectRoot);
    total -= item.sizeBytes;
    if (total <= MAX_LOADED_INDEX_CACHE_BYTES) break;
  }
}

async function cacheLoadedIndex(projectRoot: string, index: LoadedIndex): Promise<void> {
  const [manifestFile, vectorFile] = await Promise.all([stat(manifestPath(projectRoot)), stat(vectorsPath(projectRoot))]);
  loadedIndexCache.set(path.resolve(projectRoot), {
    index,
    manifestSignature: fileSignature(manifestFile),
    vectorSignature: fileSignature(vectorFile),
    sizeBytes: manifestFile.size + vectorFile.size,
    lastAccess: Date.now()
  });
  evictLoadedIndexes(path.resolve(projectRoot));
}

async function loadIndex(projectRoot: string): Promise<LoadedIndex | null> {
  const resolvedRoot = path.resolve(projectRoot);
  if (savingProjects.has(resolvedRoot)) return loadedIndexCache.get(resolvedRoot)?.index ?? null;
  const [manifestFile, vectorFile] = await Promise.all([
    stat(manifestPath(projectRoot)).catch(() => null),
    stat(vectorsPath(projectRoot)).catch(() => null)
  ]);
  if (!manifestFile || !vectorFile) {
    loadedIndexCache.delete(resolvedRoot);
    return null;
  }
  const manifestSignature = fileSignature(manifestFile);
  const vectorSignature = fileSignature(vectorFile);
  const cached = loadedIndexCache.get(resolvedRoot);
  if (cached && cached.manifestSignature === manifestSignature && cached.vectorSignature === vectorSignature) {
    cached.lastAccess = Date.now();
    return cached.index;
  }
  const [manifestText, vectorBytes] = await Promise.all([
    readFile(manifestPath(projectRoot), "utf8").catch(() => null),
    readFile(vectorsPath(projectRoot)).catch(() => null)
  ]);
  if (!manifestText || !vectorBytes) return null;
  try {
    const manifest = JSON.parse(manifestText) as SemanticCacheManifest;
    const model = currentModel();
    if (manifest.schemaVersion !== 3 || manifest.modelId !== model.modelId || manifest.modelVersion !== model.version) return null;
    const view = new Float32Array(vectorBytes.buffer, vectorBytes.byteOffset, Math.floor(vectorBytes.byteLength / 4));
    const requiredLength = manifest.entries.reduce((maximum, entry) => Math.max(maximum, entry.offset + entry.length), 0);
    if (requiredLength > view.length || manifest.dimensions !== SEMANTIC_VECTOR_DIMENSIONS) return null;
    const index = { manifest, vectors: view };
    loadedIndexCache.set(resolvedRoot, { index, manifestSignature, vectorSignature, sizeBytes: manifestFile.size + vectorFile.size, lastAccess: Date.now() });
    evictLoadedIndexes(resolvedRoot);
    return index;
  } catch {
    loadedIndexCache.delete(resolvedRoot);
    return null;
  }
}

function vectorFor(index: LoadedIndex, entry: SemanticCacheEntry): Float32Array {
  return index.vectors.slice(entry.offset, entry.offset + entry.length);
}

async function saveIndex(projectRoot: string, index: LoadedIndex): Promise<void> {
  const resolvedRoot = path.resolve(projectRoot);
  savingProjects.add(resolvedRoot);
  const directory = projectDirectory(projectRoot);
  try {
    await mkdir(directory, { recursive: true });
    const manifestTemp = `${manifestPath(projectRoot)}.tmp`;
    const vectorsTemp = `${vectorsPath(projectRoot)}.tmp`;
    await writeFile(manifestTemp, `${JSON.stringify(index.manifest, null, 2)}\n`, "utf8");
    await writeFile(vectorsTemp, Buffer.from(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength));
    await rename(manifestTemp, manifestPath(projectRoot));
    await rename(vectorsTemp, vectorsPath(projectRoot));
    await cacheLoadedIndex(projectRoot, index);
  } finally {
    savingProjects.delete(resolvedRoot);
  }
}

export async function indexSemanticDocuments(
  projectRoot: string,
  documents: SemanticDocument[],
  options: {
    replaceKinds?: SemanticDocumentKind[];
    onProgress?: (progress: SemanticIndexProgress) => void;
    deadlineMs?: number;
    coverage?: SemanticIndexCoverage;
    cancelled?: () => boolean;
  } = {}
): Promise<LoadedIndex> {
  const generation = semanticGeneration;
  const existingJob = activeJobs.get(projectRoot);
  if (existingJob?.generation === generation) return existingJob.promise;
  const model = currentModel();
  const job = (async (): Promise<LoadedIndex> => {
    assertCurrentGeneration(generation);
    runtimeErrors.delete(projectRoot);
    if (!await modelBundled()) throw new Error(`Bundled semantic model is missing at ${bundledModelPath()}.`);
    const previous = await loadIndex(projectRoot);
    const previousByKey = new Map((previous?.manifest.entries ?? []).map((entry) => [entry.key, entry]));
    const replaceKinds = new Set(options.replaceKinds ?? []);
    const retained = (previous?.manifest.entries ?? []).filter((entry) => !replaceKinds.has(entry.kind) && !documents.some((document) => document.key === entry.key));
    const vectorsByKey = new Map<string, Float32Array>();
    if (previous) for (const entry of previous.manifest.entries) vectorsByKey.set(entry.key, vectorFor(previous, entry));

    const uniqueDocuments = [...new Map(documents.map((document) => [document.key, document])).values()];
    const changed = uniqueDocuments.filter((document) => previousByKey.get(document.key)?.contentHash !== sha256(document.text));
    const reused = uniqueDocuments.length - changed.length;
    for (const document of changed) vectorsByKey.delete(document.key);
    const assembleIndex = (complete: boolean): LoadedIndex => {
      const entries: SemanticCacheEntry[] = [];
      const chunks: Float32Array[] = [];
      let offset = 0;
      const append = (document: Pick<SemanticDocument, "key" | "kind" | "ref" | "text" | "metadata">, contentHash: string): void => {
        const vector = vectorsByKey.get(document.key);
        if (!vector) return;
        entries.push({ key: document.key, kind: document.kind, ref: document.ref, contentHash, offset, length: vector.length, preview: document.text.slice(0, 280), metadata: document.metadata });
        chunks.push(vector);
        offset += vector.length;
      };
      for (const entry of retained) append({ ...entry, text: entry.preview }, entry.contentHash);
      for (const document of uniqueDocuments) append(document, sha256(document.text));
      for (const item of deriveHierarchicalCodeDocuments(uniqueDocuments, vectorsByKey)) {
        vectorsByKey.set(item.document.key, item.vector);
        append(item.document, item.contentHash);
      }
      const joined = new Float32Array(offset);
      let cursor = 0;
      for (const chunk of chunks) {
        joined.set(chunk, cursor);
        cursor += chunk.length;
      }
      const availableKeys = new Set(entries.map((entry) => entry.key));
      const codeDocuments = uniqueDocuments.filter((document) => document.kind === "code-file");
      const expectedByFile = new Map<string, string[]>();
      for (const document of codeDocuments) {
        const keys = expectedByFile.get(document.ref) ?? [];
        keys.push(document.key);
        expectedByFile.set(document.ref, keys);
      }
      const completeFiles = [...expectedByFile.values()].filter((keys) => keys.every((key) => availableKeys.has(key))).length;
      const coverage = options.coverage
        ? complete
          ? options.coverage
          : { ...options.coverage, indexedFiles: completeFiles, indexedSourceLines: 0, chunks: entries.filter((entry) => entry.metadata?.level === "source-chunk").length, complete: false }
        : previous?.manifest.coverage;
      return {
        manifest: { schemaVersion: 3, modelId: model.modelId, modelVersion: model.version, dimensions: SEMANTIC_VECTOR_DIMENSIONS, updatedAt: new Date().toISOString(), entries, coverage },
        vectors: joined
      };
    };
    if (changed.length) options.onProgress?.({ phase: "loading-model", completed: 0, total: changed.length, message: "Loading bundled semantic model", reused, documentTotal: uniqueDocuments.length });
    const batchSize = 4;
    for (let start = 0; start < changed.length; start += batchSize) {
      if (options.cancelled?.()) {
        await saveIndex(projectRoot, assembleIndex(false));
        throw new Error(`Semantic indexing was cancelled after embedding ${start} of ${changed.length} changed chunks; progress so far was saved.`);
      }
      if (options.deadlineMs && Date.now() > options.deadlineMs) throw new Error(`Semantic indexing incomplete: embedded ${start} of ${changed.length} changed chunks before the deadline.`);
      const batch = changed.slice(start, start + batchSize);
      const vectors = await embedTexts(batch.map((document) => document.text), "document");
      assertCurrentGeneration(generation);
      // Yield between batches so main-process IPC (progress events, cancel clicks) stays responsive.
      await new Promise((resolve) => setImmediate(resolve));
      batch.forEach((document, index) => vectorsByKey.set(document.key, vectors[index]));
      options.onProgress?.({ phase: "embedding", completed: Math.min(changed.length, start + batch.length), total: changed.length, message: `Embedding ${Math.min(changed.length, start + batch.length)} of ${changed.length} changed chunks`, reused, documentTotal: uniqueDocuments.length });
      const completed = Math.min(changed.length, start + batch.length);
      if (completed < changed.length && completed % 2_048 < batchSize) {
        assertCurrentGeneration(generation);
        await saveIndex(projectRoot, assembleIndex(false));
      }
    }
    assertCurrentGeneration(generation);
    const next = assembleIndex(true);
    options.onProgress?.({ phase: "saving", completed: next.manifest.entries.length, total: next.manifest.entries.length, message: "Saving local semantic index", reused, documentTotal: uniqueDocuments.length });
    await saveIndex(projectRoot, next);
    return next;
  })().catch((error) => {
    if (!(error instanceof SemanticModelChangedError)) runtimeErrors.set(projectRoot, error instanceof Error ? error.message : String(error));
    throw error;
  }).finally(() => {
    if (activeJobs.get(projectRoot)?.promise === job) activeJobs.delete(projectRoot);
  });
  activeJobs.set(projectRoot, { generation, promise: job });
  return job;
}

export async function searchSemanticIndex(
  projectRoot: string,
  query: string,
  options: { kinds?: SemanticDocumentKind[]; limit?: number; minScore?: number; excludeKeys?: string[]; aggregateCodeFiles?: boolean } = {}
): Promise<SemanticSearchResult[]> {
  const index = await loadIndex(projectRoot);
  if (!index || !query.trim()) return [];
  const [queryVector] = await embedTexts([query], "query");
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const excluded = new Set(options.excludeKeys ?? []);
  const scored = index.manifest.entries
    .filter((entry) => (!kinds || kinds.has(entry.kind)) && !excluded.has(entry.key))
    .map((entry) => ({ ...entry, score: cosineSimilarity(queryVector, vectorFor(index, entry)) }))
    .filter((entry) => entry.score >= (options.minScore ?? 0.35))
    .sort((left, right) => right.score - left.score);
  const aggregateCode = options.aggregateCodeFiles !== false && options.kinds?.length === 1 && options.kinds[0] === "code-file";
  if (aggregateCode) {
    const byFile = new Map<string, typeof scored>();
    for (const entry of scored) {
      const matches = byFile.get(entry.ref) ?? [];
      matches.push(entry);
      byFile.set(entry.ref, matches);
    }
    return [...byFile.entries()]
      .map(([ref, matches]) => {
        const best = matches[0];
        const filePool = matches.find((match) => match.metadata?.level === "file-pool");
        const symbolPool = matches.find((match) => match.metadata?.level === "symbol-pool");
        const sourceChunk = matches.find((match) => match.metadata?.level === "source-chunk");
        const supporting = [...new Map([best, filePool, symbolPool, sourceChunk].filter((match): match is typeof best => Boolean(match)).map((match) => [match.key, match])).values()];
        const located = sourceChunk ?? symbolPool ?? best;
        return {
          key: best.key,
          kind: best.kind,
          ref,
          score: best.score,
          preview: located.preview,
          metadata: located.metadata,
          matches: supporting.map((match) => ({ score: match.score, preview: match.preview, metadata: match.metadata }))
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, options.limit ?? 8);
  }
  return scored.slice(0, options.limit ?? 8).map(({ key, kind, ref, score, preview, metadata }) => ({ key, kind, ref, score, preview, metadata }));
}

export function semanticDocumentsForBundle(bundle: ProjectBundle): SemanticDocument[] {
  const documents: SemanticDocument[] = [];
  for (const flow of bundle.flows) {
    if (flow.ignored) continue;
    for (const node of flow.nodes) {
      if (node.ignored) continue;
      documents.push({
        key: `graph-node:${flow.id}:${node.id}`,
        kind: "graph-node",
        ref: `${flow.id}:${node.id}`,
        text: [node.title, node.type, node.description, ...node.acceptanceCriteria, ...node.techStack, ...Object.values(node.customProperties ?? {})].filter(Boolean).join("\n"),
        metadata: { flowId: flow.id, nodeId: node.id, title: node.title }
      });
    }
  }
  for (const note of bundle.notes.filter((item) => !item.resolved || item.pinned)) {
    documents.push({ key: `graph-note:${note.id}`, kind: "graph-note", ref: note.id, text: `${note.category}\n${note.body}`, metadata: { flowId: note.flowId, nodeId: note.nodeId } });
  }
  for (const rule of (bundle.project.settings.nodeRules ?? []).filter((item) => (item.status ?? "active") === "active")) {
    documents.push({ key: `graph-rule:${rule.id}`, kind: "graph-rule", ref: rule.id, text: `${rule.title}\n${rule.body}` });
  }
  return documents;
}

type SourceRegion = { startLine: number; endLine: number; symbol?: ParsedSemanticSymbol };

function semanticSourceRegions(lineCount: number, symbols: ParsedSemanticSymbol[]): SourceRegion[] {
  const regions: SourceRegion[] = [];
  const starts = new Map<number, ParsedSemanticSymbol[]>();
  for (const symbol of symbols) {
    const items = starts.get(symbol.startLine) ?? [];
    items.push(symbol);
    starts.set(symbol.startLine, items);
  }
  let active: ParsedSemanticSymbol[] = [];
  let current: SourceRegion | null = null;
  for (let line = 1; line <= lineCount; line += 1) {
    active = active.filter((item) => item.endLine >= line);
    active.push(...(starts.get(line) ?? []));
    const symbol = active
      .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))[0];
    const identity = symbol ? `${symbol.name}:${symbol.startLine}:${symbol.endLine}` : "file";
    const currentIdentity = current?.symbol ? `${current.symbol.name}:${current.symbol.startLine}:${current.symbol.endLine}` : "file";
    if (!current || identity !== currentIdentity) {
      current = { startLine: line, endLine: line, symbol };
      regions.push(current);
    } else {
      current.endLine = line;
    }
  }
  return regions;
}

export async function semanticDocumentsForCode(projectRoot: string, scan: RepoScan, parsed: ParsedFile[], options: { sourceReader?: import("./importer/sourceCache").ImportSourceReader } = {}): Promise<SemanticCodeDocumentSet> {
  const tokenizer = await loadTokenizer();
  const model = currentModel();
  const contentTokenLimit = model.maxTokens - 2;
  const tokenSafeText = (text: string): string => {
    const tokens = tokenizer.encode(text, { add_special_tokens: false });
    return tokens.length <= contentTokenLimit ? text : tokenizer.decode(tokens.slice(0, contentTokenLimit), { skip_special_tokens: true, clean_up_tokenization_spaces: false });
  };
  const parsedByPath = new Map(parsed.map((file) => [file.relPath, file]));
  const eligible = scan.files.flatMap((file) => {
    const language = semanticLanguageForFile(file);
    return language && file.role !== "generated" ? [{ file, language }] : [];
  });
  const documents: SemanticDocument[] = [];
  const failedFiles: Array<{ path: string; reason: string }> = [];
  let indexedFiles = 0;
  let sourceLines = 0;
  let indexedSourceLines = 0;
  let symbolCount = 0;

  for (const { file, language } of eligible) {
    const bytes = options.sourceReader ? await options.sourceReader.read(file.relPath) : await readFile(path.join(projectRoot, file.relPath)).catch(() => null);
    if (!bytes || bytes.includes(0)) {
      failedFiles.push({ path: file.relPath, reason: bytes ? "binary source" : "unreadable source" });
      continue;
    }
    const source = bytes.toString("utf8");
    const lines = source.split(/\r?\n/);
    sourceLines += lines.length;
    const parsedFile = parsedByPath.get(file.relPath);
    const componentExtension = new Set([".vue", ".svelte", ".astro"]);
    const fallbackComponentSymbol: ParsedSemanticSymbol[] = componentExtension.has(file.ext)
      ? [{ name: path.posix.basename(file.relPath, file.ext), kind: "component", startLine: 1, endLine: lines.length }]
      : [];
    const symbols = parsedFile?.semanticSymbols?.length ? parsedFile.semanticSymbols : fallbackComponentSymbol;
    symbolCount += symbols.length;
    const imports = (parsedFile?.imports ?? []).map((item) => item.specifier);
    const publicSymbols = parsedFile?.symbols ?? [];
    const baseHeader = [
      `File: ${file.relPath}`,
      `Language: ${language}`,
      `Role: ${file.role ?? "production"}`,
      imports.length ? `Imports: ${imports.slice(0, 16).join(", ")}` : ""
    ].filter(Boolean).join("\n");
    documents.push({
      key: `code-file-summary:${file.relPath}`,
      kind: "code-file",
      ref: file.relPath,
      text: tokenSafeText([baseHeader, publicSymbols.length ? `Public symbols: ${publicSymbols.join(", ")}` : "", symbols.length ? `Components: ${symbols.map((item) => item.parentName ? `${item.parentName}.${item.name}` : item.name).slice(0, 80).join(", ")}` : ""].filter(Boolean).join("\n")),
      metadata: { level: "file-summary", path: file.relPath, language, role: file.role ?? "production" }
    });

    const chunkKeyOccurrences = new Map<string, number>();
    for (const region of semanticSourceRegions(lines.length, symbols)) {
      const symbolName = region.symbol ? (region.symbol.parentName ? `${region.symbol.parentName}.${region.symbol.name}` : region.symbol.name) : undefined;
      let header = [baseHeader, symbolName ? `${region.symbol?.kind ?? "symbol"}: ${symbolName}` : "Scope: file-level source"].join("\n");
      let headerTokens = tokenizer.encode(`${header}\nSource:`, { add_special_tokens: false });
      if (headerTokens.length > model.headerTokens) {
        header = tokenizer.decode(headerTokens.slice(0, model.headerTokens), { skip_special_tokens: true, clean_up_tokenization_spaces: false });
        headerTokens = tokenizer.encode(`${header}\nSource:`, { add_special_tokens: false });
      }
      const sourceBudget = Math.max(48, contentTokenLimit - 2 - headerTokens.length);
      const pending: Array<{ text: string; line: number; tokens: number[] }> = [];
      let pendingTokens = 0;
      const emit = (items: Array<{ text: string; line: number }>): void => {
        if (!items.length) return;
        const startLine = items[0].line;
        const endLine = items[items.length - 1].line;
        const chunkSource = items.map((item) => item.text).join("\n");
        const digest = sha256(`${symbolName ?? "file"}\0${chunkSource}`).slice(0, 24);
        const occurrence = (chunkKeyOccurrences.get(digest) ?? 0) + 1;
        chunkKeyOccurrences.set(digest, occurrence);
        documents.push({
          key: `code-chunk:${file.relPath}:${digest}:${occurrence}`,
          kind: "code-file",
          ref: file.relPath,
          text: `${header}\nSource:\n${chunkSource}`,
          metadata: {
            level: "source-chunk",
            path: file.relPath,
            language,
            role: file.role ?? "production",
            startLine: String(startLine),
            endLine: String(endLine),
            ...(symbolName ? { symbol: symbolName, symbolKind: region.symbol?.kind ?? "symbol" } : {})
          }
        });
      };
      const flush = (): void => {
        emit(pending);
        pending.length = 0;
        pendingTokens = 0;
      };
      for (let line = region.startLine; line <= region.endLine; line += 1) {
        const text = lines[line - 1] ?? "";
        const tokens = tokenizer.encode(`${text}\n`, { add_special_tokens: false });
        if (tokens.length > sourceBudget) {
          flush();
          const stride = Math.max(1, sourceBudget - model.overlapTokens);
          for (let start = 0; start < tokens.length; start += stride) {
            const slice = tokens.slice(start, start + sourceBudget);
            emit([{ text: tokenizer.decode(slice, { skip_special_tokens: true, clean_up_tokenization_spaces: false }), line }]);
            if (start + sourceBudget >= tokens.length) break;
          }
          continue;
        }
        if (pending.length && pendingTokens + tokens.length > sourceBudget) {
          const overlap = pending[pending.length - 1];
          flush();
          if (overlap.tokens.length <= model.overlapTokens && overlap.line !== line) {
            pending.push(overlap);
            pendingTokens = overlap.tokens.length;
          }
        }
        pending.push({ text, line, tokens });
        pendingTokens += tokens.length;
      }
      flush();
    }
    indexedFiles += 1;
    indexedSourceLines += lines.length;
  }

  const coverage: SemanticIndexCoverage = {
    eligibleFiles: eligible.length,
    indexedFiles,
    sourceLines,
    indexedSourceLines,
    symbols: symbolCount,
    chunks: documents.filter((document) => document.metadata?.level === "source-chunk").length,
    excludedGeneratedFiles: scan.files.filter((file) => semanticLanguageForFile(file) && file.role === "generated").length,
    failedFiles,
    complete: indexedFiles === eligible.length && indexedSourceLines === sourceLines && failedFiles.length === 0 && !scan.truncated
  };
  return { documents, coverage };
}

export async function ensureGraphSemanticIndex(projectRoot: string, bundle: ProjectBundle): Promise<void> {
  if (!bundle.project.settings.semanticIndex.enabled) return;
  const documents = semanticDocumentsForBundle(bundle);
  const existing = await loadIndex(projectRoot);
  const graphKinds = new Set<SemanticDocumentKind>(["graph-node", "graph-note", "graph-rule"]);
  const existingGraphEntries = existing?.manifest.entries.filter((entry) => graphKinds.has(entry.kind)) ?? [];
  const currentByKey = new Map(documents.map((document) => [document.key, sha256(document.text)]));
  const graphIndexIsCurrent = Boolean(existing)
    && existingGraphEntries.length === documents.length
    && existingGraphEntries.every((entry) => currentByKey.get(entry.key) === entry.contentHash);
  if (graphIndexIsCurrent) return;
  await indexSemanticDocuments(projectRoot, documents, {
    replaceKinds: ["graph-node", "graph-note", "graph-rule"]
  });
}

export async function getSemanticNodeContext(
  projectRoot: string,
  bundle: ProjectBundle,
  flowId: string,
  nodeId: string,
  _refresh = false
): Promise<SemanticNodeContext> {
  const empty = (state: SemanticNodeContext["state"], message: string, updatedAt?: string): SemanticNodeContext => ({
    state,
    indexed: false,
    modelId: currentModel().modelId,
    updatedAt,
    message,
    codeItems: 0,
    relatedNodes: [],
    relatedCode: []
  });
  if (!bundle.project.settings.semanticIndex.enabled) return empty("disabled", "Local semantic indexing is disabled in Advanced Settings.");
  const flow = bundle.flows.find((item) => item.id === flowId);
  const node = flow?.nodes.find((item) => item.id === nodeId);
  if (!flow || !node) return empty("error", "This node is no longer present in the current graph.");

  try {
    // Keep graph semantics synchronized whenever they are requested. This is
    // incremental and returns immediately when the cached graph records match.
    await ensureGraphSemanticIndex(projectRoot, bundle);
    const index = await loadIndex(projectRoot);
    if (!index) {
      const status = await getSemanticIndexStatus(projectRoot, true);
      return empty(status.state === "unavailable" ? "unavailable" : "not-indexed", status.message, status.updatedAt);
    }
    const document = semanticDocumentsForBundle(bundle).find((item) => item.key === `graph-node:${flowId}:${nodeId}`);
    const ownEntry = index.manifest.entries.find((entry) => entry.key === document?.key);
    const isCurrent = Boolean(document && ownEntry?.contentHash === sha256(document.text));
    const limit = bundle.project.settings.semanticIndex.maxRelatedNodes;
    const query = document?.text ?? [node.title, node.type, node.description].filter(Boolean).join("\n");
    const nodeMatches = await searchSemanticIndex(projectRoot, query, {
      kinds: ["graph-node"],
      limit: limit + 1,
      minScore: 0.28,
      excludeKeys: [`graph-node:${flowId}:${nodeId}`]
    });
    const codeMatches = await searchSemanticIndex(projectRoot, query, { kinds: ["code-file"], limit, minScore: 0.28 });
    return {
      state: ownEntry ? (isCurrent ? "current" : "stale") : "not-indexed",
      indexed: Boolean(ownEntry),
      modelId: index.manifest.modelId,
      updatedAt: index.manifest.updatedAt,
      codeItems: index.manifest.entries.filter((entry) => entry.kind === "code-file").length,
      message: ownEntry
        ? isCurrent
          ? "This node matches its cached semantic representation."
          : "This node changed after its cached semantic representation was created."
        : "This node has not been added to the local semantic index yet.",
      relatedNodes: nodeMatches.slice(0, limit).flatMap((match) => {
        const matchFlowId = match.metadata?.flowId;
        const matchNodeId = match.metadata?.nodeId;
        if (!matchFlowId || !matchNodeId) return [];
        return [{ flowId: matchFlowId, nodeId: matchNodeId, title: match.metadata?.title ?? match.ref, score: match.score }];
      }),
      relatedCode: codeMatches.map((match) => ({
        path: match.ref,
        score: match.score,
        preview: match.preview,
        symbol: match.metadata?.symbol,
        startLine: match.metadata?.startLine ? Number(match.metadata.startLine) : undefined,
        endLine: match.metadata?.endLine ? Number(match.metadata.endLine) : undefined
      }))
    };
  } catch (error) {
    return empty("error", error instanceof Error ? error.message : String(error));
  }
}

export async function getSemanticCodeLineContext(
  projectRoot: string,
  bundle: ProjectBundle,
  relativePath: string,
  lineNumber: number
): Promise<SemanticCodeLineContext> {
  const empty = (state: SemanticCodeLineContext["state"], message: string): SemanticCodeLineContext => ({
    state,
    indexed: false,
    message,
    relatedNodes: [],
    relatedCode: []
  });
  if (!bundle.project.settings.semanticIndex.enabled) return empty("disabled", "Semantic indexing is disabled for this project.");

  try {
    await ensureGraphSemanticIndex(projectRoot, bundle);
    const index = await loadIndex(projectRoot);
    if (!index) return empty("not-indexed", "No local semantic index is available for this file yet.");
    const matchingChunk = index.manifest.entries
      .filter((entry) => {
        if (entry.kind !== "code-file" || entry.ref !== relativePath || entry.metadata?.level !== "source-chunk") return false;
        const startLine = Number(entry.metadata.startLine ?? 0);
        const endLine = Number(entry.metadata.endLine ?? 0);
        return startLine <= lineNumber && lineNumber <= endLine;
      })
      .sort((left, right) => {
        const leftSize = Number(left.metadata?.endLine ?? 0) - Number(left.metadata?.startLine ?? 0);
        const rightSize = Number(right.metadata?.endLine ?? 0) - Number(right.metadata?.startLine ?? 0);
        return leftSize - rightSize;
      })[0];
    if (!matchingChunk) return empty("not-indexed", "This line has not been indexed as semantic source context.");

    const chunkVector = vectorFor(index, matchingChunk);
    const nodesById = new Map(bundle.flows.flatMap((flow) => flow.nodes.map((node) => [`${flow.id}:${node.id}`, node] as const)));
    const relatedNodes = index.manifest.entries
      .filter((entry) => entry.kind === "graph-node")
      .flatMap((entry) => {
        const flowId = entry.metadata?.flowId;
        const nodeId = entry.metadata?.nodeId;
        if (!flowId || !nodeId) return [];
        const node = nodesById.get(`${flowId}:${nodeId}`);
        if (!node) return [];
        const relationship = node.implementationScope?.claims.find((claim) => {
          const claimPath = claim.path.replace(/^\.\//, "").replace(/\/$/, "");
          const targetPath = relativePath.replace(/^\.\//, "");
          if (claim.kind === "directory") return targetPath === claimPath || targetPath.startsWith(`${claimPath}/`);
          if (claim.kind === "file") return targetPath === claimPath;
          return Boolean(matchingChunk.metadata?.symbol && claim.symbol === matchingChunk.metadata.symbol);
        })?.relation;
        const semanticScore = cosineSimilarity(chunkVector, vectorFor(index, entry));
        const relationshipBoost = relationship === "own" ? 0.12 : relationship === "share" ? 0.08 : relationship === "cover" ? 0.05 : 0;
        return [{
          flowId,
          nodeId,
          title: node.title,
          description: node.description,
          type: node.type,
          stage: node.stage,
          score: Math.min(1, semanticScore + relationshipBoost),
          relationship,
          acceptanceCriteria: node.acceptanceCriteria.slice(0, 2)
        }];
      })
      .filter((item) => item.score >= 0.3)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(3, bundle.project.settings.semanticIndex.maxRelatedNodes));
    const relatedCode = index.manifest.entries
      .filter((entry) => entry.kind === "code-file"
        && entry.key !== matchingChunk.key
        && entry.metadata?.level === "source-chunk"
        && Boolean(entry.metadata.symbol)
        && !(entry.ref === relativePath && entry.metadata?.symbol === matchingChunk.metadata?.symbol))
      .map((entry) => ({
        path: entry.ref,
        symbol: entry.metadata!.symbol!,
        startLine: entry.metadata?.startLine ? Number(entry.metadata.startLine) : undefined,
        endLine: entry.metadata?.endLine ? Number(entry.metadata.endLine) : undefined,
        score: cosineSimilarity(chunkVector, vectorFor(index, entry))
      }))
      .filter((item) => item.score >= 0.45)
      .sort((left, right) => right.score - left.score)
      .filter((item, indexInList, items) => items.findIndex((candidate) => candidate.path === item.path && candidate.symbol === item.symbol) === indexInList)
      .slice(0, 2);

    return {
      state: "current",
      indexed: true,
      message: relatedNodes.length ? "Related graph context is available for this code section." : "No high-confidence graph context was found for this code section.",
      startLine: Number(matchingChunk.metadata?.startLine ?? lineNumber),
      endLine: Number(matchingChunk.metadata?.endLine ?? lineNumber),
      symbol: matchingChunk.metadata?.symbol,
      relatedNodes,
      relatedCode
    };
  } catch (error) {
    return empty("error", error instanceof Error ? error.message : String(error));
  }
}

export async function getSemanticCodeFileContexts(
  projectRoot: string,
  bundle: ProjectBundle,
  relativePath: string
): Promise<SemanticCodeLineContext[]> {
  if (!bundle.project.settings.semanticIndex.enabled) return [];
  await ensureGraphSemanticIndex(projectRoot, bundle);
  const index = await loadIndex(projectRoot);
  if (!index) return [];
  const startLines = [...new Set(index.manifest.entries
    .filter((entry) => entry.kind === "code-file" && entry.ref === relativePath && entry.metadata?.level === "source-chunk")
    .map((entry) => Number(entry.metadata?.startLine ?? 0))
    .filter((line) => line > 0))];
  const contexts: SemanticCodeLineContext[] = [];
  for (const startLine of startLines) {
    const context = await getSemanticCodeLineContext(projectRoot, bundle, relativePath, startLine);
    if (context.indexed) contexts.push(context);
  }
  return contexts;
}

export async function semanticRelatedNodeIds(projectRoot: string, bundle: ProjectBundle, query: string, limit?: number): Promise<Array<{ flowId: string; nodeId: string; score: number }>> {
  if (!bundle.project.settings.semanticIndex.enabled || !query.trim()) return [];
  await ensureGraphSemanticIndex(projectRoot, bundle);
  const results = await searchSemanticIndex(projectRoot, query, { kinds: ["graph-node"], limit: limit ?? bundle.project.settings.semanticIndex.maxRelatedNodes, minScore: 0.38 });
  return results.flatMap((result) => {
    const flowId = result.metadata?.flowId;
    const nodeId = result.metadata?.nodeId;
    return flowId && nodeId ? [{ flowId, nodeId, score: result.score }] : [];
  });
}

export async function getSemanticIndexStatus(projectRoot: string, enabled: boolean, currentDocuments: SemanticDocument[] = []): Promise<SemanticIndexStatus> {
  const model = currentModel();
  const bundled = await modelBundled().catch(() => false);
  const loaded = await loadIndex(projectRoot).catch(() => null);
  const [manifestStat, vectorStat] = await Promise.all([stat(manifestPath(projectRoot)).catch(() => null), stat(vectorsPath(projectRoot)).catch(() => null)]);
  const cacheSizeBytes = (manifestStat?.size ?? 0) + (vectorStat?.size ?? 0);
  const error = runtimeErrors.get(projectRoot);
  const coverage = loaded?.manifest.coverage;
  const graphItems = loaded?.manifest.entries.filter((entry) => entry.kind.startsWith("graph-")).length ?? 0;
  const codeItems = loaded?.manifest.entries.filter((entry) => entry.kind === "code-file").length ?? 0;
  const base = { enabled, modelId: model.modelId, modelVersion: model.version, modelBundled: bundled, cacheSizeBytes };
  const counts = { graphItems, codeItems };
  if (!enabled) return { ...base, ...counts, state: "disabled", indexedItems: loaded?.manifest.entries.length ?? 0, updatedAt: loaded?.manifest.updatedAt, coverage, message: "Semantic indexing is disabled for this project." };
  if (activeJobs.get(projectRoot)?.generation === semanticGeneration) return { ...base, ...counts, state: "indexing", indexedItems: loaded?.manifest.entries.length ?? 0, updatedAt: loaded?.manifest.updatedAt, coverage, message: "Updating the local semantic index." };
  if (error) return { ...base, ...counts, state: "error", indexedItems: loaded?.manifest.entries.length ?? 0, updatedAt: loaded?.manifest.updatedAt, coverage, message: "Semantic indexing encountered an error.", error };
  if (!bundled) return { ...base, ...counts, state: "unavailable", modelBundled: false, indexedItems: loaded?.manifest.entries.length ?? 0, updatedAt: loaded?.manifest.updatedAt, coverage, message: "The bundled semantic model is unavailable." };
  if (manifestStat && !loaded) return { ...base, ...counts, state: "stale", modelBundled: true, indexedItems: 0, message: "The local index uses an older format or model and should be rebuilt." };
  if (!loaded?.manifest.entries.length) return { ...base, ...counts, state: "empty", modelBundled: true, indexedItems: 0, message: "Ready to build this project's local semantic index." };
  const byKey = new Map(loaded.manifest.entries.map((entry) => [entry.key, entry]));
  const stale = currentDocuments.some((document) => byKey.get(document.key)?.contentHash !== sha256(document.text));
  if (stale) return { ...base, ...counts, state: "stale", modelBundled: true, indexedItems: loaded.manifest.entries.length, updatedAt: loaded.manifest.updatedAt, coverage, message: "Graph content changed since the local semantic index was last updated." };
  if (!codeItems && graphItems) return { ...base, ...counts, state: "graph-only", modelBundled: true, indexedItems: loaded.manifest.entries.length, updatedAt: loaded.manifest.updatedAt, coverage, message: "Graph context is indexed, but project source code has not been indexed yet." };
  if (coverage && !coverage.complete) return { ...base, ...counts, state: "partial", modelBundled: true, indexedItems: loaded.manifest.entries.length, updatedAt: loaded.manifest.updatedAt, coverage, message: `Semantic coverage is incomplete (${coverage.indexedFiles}/${coverage.eligibleFiles} eligible files).` };
  return { ...base, ...counts, state: "ready", modelBundled: true, indexedItems: loaded.manifest.entries.length, updatedAt: loaded.manifest.updatedAt, coverage, message: coverage ? `Semantic retrieval covers ${coverage.indexedFiles.toLocaleString()} files, ${coverage.symbols.toLocaleString()} symbols, and ${coverage.chunks.toLocaleString()} source chunks.` : "Semantic retrieval is ready." };
}

export async function clearSemanticIndex(projectRoot: string): Promise<void> {
  loadedIndexCache.delete(path.resolve(projectRoot));
  await rm(projectDirectory(projectRoot), { recursive: true, force: true });
  runtimeErrors.delete(projectRoot);
}

export async function semanticLinksForDocuments(projectRoot: string, keys: string[], limit = 400): Promise<Array<{ source: string; target: string; score: number }>> {
  const index = await loadIndex(projectRoot);
  if (!index) return [];
  const keySet = new Set(keys);
  const requestedRefs = new Set(index.manifest.entries.filter((entry) => keySet.has(entry.key)).map((entry) => entry.ref));
  const grouped = new Map<string, SemanticCacheEntry[]>();
  for (const entry of index.manifest.entries) {
    if (!requestedRefs.has(entry.ref) || entry.kind !== "code-file") continue;
    const entries = grouped.get(entry.ref) ?? [];
    entries.push(entry);
    grouped.set(entry.ref, entries);
  }
  const selected = [...grouped.entries()].map(([ref, entries]) => {
    const filePool = entries.find((entry) => entry.metadata?.level === "file-pool");
    if (filePool) return { ref, vector: vectorFor(index, filePool) };
    const sum = new Float32Array(SEMANTIC_VECTOR_DIMENSIONS);
    for (const entry of entries) {
      const vector = vectorFor(index, entry);
      for (let dimension = 0; dimension < sum.length; dimension += 1) sum[dimension] += vector[dimension];
    }
    return { ref, vector: normalize(sum) };
  });
  const links: Array<{ source: string; target: string; score: number }> = [];
  const candidates = new Set<string>();
  if (selected.length <= 2_000) {
    for (let left = 0; left < selected.length; left += 1) {
      for (let right = left + 1; right < selected.length; right += 1) candidates.add(`${left}:${right}`);
    }
  } else {
    for (let projection = 0; projection < 8; projection += 1) {
      const projected = selected.map((item, itemIndex) => {
        let value = 0;
        for (let sample = 0; sample < 16; sample += 1) {
          const dimension = (projection * 47 + sample * 23) % SEMANTIC_VECTOR_DIMENSIONS;
          value += item.vector[dimension] * (((projection + sample) % 2) ? -1 : 1);
        }
        return { itemIndex, value };
      }).sort((left, right) => left.value - right.value);
      for (let position = 0; position < projected.length; position += 1) {
        for (let offset = 1; offset <= 8 && position + offset < projected.length; offset += 1) {
          const left = Math.min(projected[position].itemIndex, projected[position + offset].itemIndex);
          const right = Math.max(projected[position].itemIndex, projected[position + offset].itemIndex);
          candidates.add(`${left}:${right}`);
        }
      }
    }
  }
  for (const candidate of candidates) {
    const [leftIndex, rightIndex] = candidate.split(":").map(Number);
    const left = selected[leftIndex];
    const right = selected[rightIndex];
    if (!left || !right || left.ref === right.ref) continue;
    const score = cosineSimilarity(left.vector, right.vector);
    if (score >= 0.68) {
      links.push({ source: left.ref, target: right.ref, score });
    }
  }
  return links.sort((left, right) => right.score - left.score).slice(0, limit);
}
