import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import path from "node:path";
import type { TtsModelId, TtsVoiceId } from "../shared/schema";

type TtsModelDefinition = {
  id: TtsModelId;
  label: string;
  modelId: string;
  onnxFileName: string;
  url: string;
  approximateSize: string;
};

export type TtsVoiceDefinition = {
  id: TtsVoiceId;
  label: string;
  description: string;
  file: string;
};

export type TtsModelStatus = TtsModelDefinition & {
  path: string;
  downloaded: boolean;
  sizeBytes?: number;
};

export type TtsRuntimeStatus = {
  runtimeAvailable: boolean;
  runtimePath?: string;
  runtimeError?: string;
  selectedModelId: TtsModelId;
  models: TtsModelStatus[];
  voices: TtsVoiceDefinition[];
};

export type TtsModelDownloadProgress = {
  modelId: TtsModelId;
  receivedBytes: number;
  totalBytes?: number;
};

export type TtsSynthesisResult = {
  audio: ArrayBuffer;
  mimeType: "audio/wav";
  modelId: TtsModelId;
  voiceId: TtsVoiceId;
  sampleRate: number;
  durationMs: number;
  generationMs: number;
  diagnostics?: TtsSynthesisDiagnostics;
};

export type TtsSpeechStreamChunk = {
  audio: ArrayBuffer;
  chars?: number;
  durationMs: number;
  index: number;
  mimeType: "audio/wav";
  sampleRate: number;
  synthMs?: number;
  text?: string;
  total: number;
  workerIndex?: number;
};

export type TtsSpeechStreamResult = {
  cacheHit: boolean;
  diagnostics?: TtsSynthesisDiagnostics;
  durationMs: number;
  generationMs: number;
  modelId: TtsModelId;
  segmentCount: number;
  voiceId: TtsVoiceId;
};

export type TtsSynthesisDiagnostics = {
  cacheHit: boolean;
  textChars: number;
  segmentCount: number;
  segmentChars: number[];
  workerAlreadyLoaded?: boolean;
  modelLoadMs?: number;
  segmentMs?: number[];
  mergeMs?: number;
  encodeMs?: number;
  workerMs?: number;
  workerCount?: number;
  workerIndex?: number;
};

type TtsWorkerInput = {
  mode: "download" | "stream" | "synthesize";
  cacheDir: string;
  moduleBasePath: string;
  modelName: string;
  voiceId: TtsVoiceId;
  text?: string;
  segments?: string[];
  speed?: number;
};

type TtsWorkerResult = {
  audioBase64?: string;
  sampleRate?: number;
  durationMs?: number;
  diagnostics?: Omit<TtsSynthesisDiagnostics, "cacheHit" | "textChars" | "workerMs">;
  workerIndex?: number;
};

type PendingTtsWorkerRequest = {
  debugStartedAtMs?: number;
  onChunk?: (chunk: Omit<TtsSpeechStreamChunk, "audio" | "mimeType"> & { audioBase64: string }) => void;
  onProgress?: (progress: TtsModelDownloadProgress) => void;
  reject: (error: Error) => void;
  resolve: (result: TtsWorkerResult) => void;
};

type TtsWorkerProcess = {
  child: ChildProcessWithoutNullStreams;
  modelId: TtsModelId;
  workerIndex: number;
  stdoutBuffer: string;
  stderrBuffer: string;
  stderrLog: string;
  pending: Map<string, PendingTtsWorkerRequest>;
};

type CachedTtsAudio = {
  audioBuffer: Buffer;
  diagnostics: TtsSynthesisDiagnostics;
  durationMs: number;
  generationMs: number;
  sampleRate: number;
};

let ttsDataRoot: string | null = null;
const require = createRequire(import.meta.url);
let nextTtsWorkerRequestId = 0;
const maxCachedTtsAudioEntries = 2;
const ttsChunkPauseMs = 250;
const earlySpeechSingleSegmentCount = 3;
const maxSpeechClauseChars = 110;
const maxParallelTtsWorkers = Math.min(3, Math.max(1, Math.floor(availableParallelism() * 0.75)));
let parallelTtsWorkerLimit = maxParallelTtsWorkers;
const activeTtsWorkers = new Map<TtsModelId, TtsWorkerProcess[]>();
const nextTtsWorkerIndex = new Map<TtsModelId, number>();
const ttsWorkerPoolWarmups = new Map<TtsModelId, Promise<void>>();
const ttsAudioCache = new Map<string, CachedTtsAudio>();
const workerChunkPrefix = "__ARCHICODE_TTS_CHUNK__";
const workerResultPrefix = "__ARCHICODE_TTS_RESULT__";
const workerProgressPrefix = "__ARCHICODE_TTS_PROGRESS__";
const ttsConsoleDebugEnabled = false;

function ttsConsoleInfo(message: string): void {
  if (ttsConsoleDebugEnabled) console.info(message);
}

function ttsConsoleWarn(message: string): void {
  if (ttsConsoleDebugEnabled) console.warn(message);
}

const ttsWorkerScript = `
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const chunkPrefix = "${workerChunkPrefix}";
const resultPrefix = "${workerResultPrefix}";
const progressPrefix = "${workerProgressPrefix}";
let configured = false;
let synthesizerPromise = null;
let synthesizerReady = false;
let synthesizerLoadMs = 0;

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const buffer = Buffer.alloc(44 + samples.length * bytesPerSample);
  const writeString = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) buffer.writeUInt8(value.charCodeAt(index), offset + index);
  };
  writeString(0, "RIFF");
  buffer.writeUInt32LE(36 + samples.length * bytesPerSample, 4);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(8 * bytesPerSample, 34);
  writeString(36, "data");
  buffer.writeUInt32LE(samples.length * bytesPerSample, 40);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    buffer.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), offset);
    offset += bytesPerSample;
  }
  return buffer;
}

function mergeAudio(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function silence(sampleRate, durationMs) {
  return new Float32Array(Math.round(sampleRate * durationMs / 1000));
}

function writeStdoutLine(line) {
  return new Promise((resolve, reject) => {
    process.stdout.write(line + "\\n", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function emitResult(requestId, result) {
  await writeStdoutLine(resultPrefix + JSON.stringify({ requestId, ...result }));
}

function emitProgress(requestId, progress) {
  if (typeof progress?.loaded !== "number") return;
  process.stderr.write(progressPrefix + JSON.stringify({
    requestId,
    loaded: progress.loaded,
    total: typeof progress.total === "number" ? progress.total : undefined
  }) + "\\n");
}

async function emitChunk(requestId, chunk) {
  await writeStdoutLine(chunkPrefix + JSON.stringify({ requestId, ...chunk }));
}

async function configure(input) {
  if (configured) return;
  const require = createRequire(input.moduleBasePath);
  const kokoroPackagePath = path.dirname(path.dirname(require.resolve("kokoro-js")));
  const transformersEntry = path.join(
    kokoroPackagePath,
    "node_modules",
    "@huggingface",
    "transformers",
    "dist",
    "transformers.node.mjs"
  );
  const transformers = await import(pathToFileURL(transformersEntry).href);
  if (transformers.env) {
    transformers.env.cacheDir = input.cacheDir;
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = true;
  }
  configured = true;
}

async function getSynthesizer(input) {
  await configure(input);
  const alreadyLoaded = synthesizerReady;
  if (!synthesizerPromise) {
    const loadStartedAt = Date.now();
    synthesizerPromise = (async () => {
      const { KokoroTTS } = await import("kokoro-js");
      return KokoroTTS.from_pretrained(input.modelName, {
        dtype: "q8",
        device: "cpu",
        progress_callback: (progress) => emitProgress(input.requestId, progress)
      });
    })().then((synthesizer) => {
      synthesizerReady = true;
      synthesizerLoadMs = Date.now() - loadStartedAt;
      return synthesizer;
    });
  }
  return {
    synthesizer: await synthesizerPromise,
    alreadyLoaded,
    loadMs: alreadyLoaded ? 0 : synthesizerLoadMs
  };
}

async function handleRequest(input) {
  try {
    const loaded = await getSynthesizer(input);
    const synthesizer = loaded.synthesizer;

  if (input.mode === "download") {
      await emitResult(input.requestId, {
        ok: true,
        diagnostics: {
          workerAlreadyLoaded: loaded.alreadyLoaded,
          modelLoadMs: loaded.loadMs,
          segmentCount: 0,
          segmentChars: [],
          segmentMs: [],
          mergeMs: 0,
          encodeMs: 0
        }
      });
      return;
    }

    const segments = Array.isArray(input.segments) && input.segments.length ? input.segments : [input.text ?? ""];
    const audioChunks = [];
    const segmentChars = [];
    const segmentMs = [];
    let sampleRate = 24000;
    let emittedIndex = 0;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index].trim();
      if (!segment) continue;
      const segmentStartedAt = Date.now();
      const output = await synthesizer.generate(segment, {
      voice: input.voiceId,
      speed: input.speed
    });
      segmentMs.push(Date.now() - segmentStartedAt);
      segmentChars.push(segment.length);
      sampleRate = output.sampling_rate ?? output.samplingRate ?? sampleRate;
      const needsPause = index < segments.length - 1;
      const chunkSamples = needsPause ? mergeAudio([output.audio, silence(sampleRate, ${ttsChunkPauseMs})]) : output.audio;
      audioChunks.push(chunkSamples);
      if (input.mode === "stream") {
        await emitChunk(input.requestId, {
          audioBase64: encodeWav(chunkSamples, sampleRate).toString("base64"),
          chars: segment.length,
          durationMs: Math.round(chunkSamples.length / sampleRate * 1000),
          index: emittedIndex,
          sampleRate,
          synthMs: segmentMs[segmentMs.length - 1],
          text: segment,
          total: segments.length
        });
        emittedIndex += 1;
      }
    }
    const mergeStartedAt = Date.now();
    const samples = mergeAudio(audioChunks);
    const mergeMs = Date.now() - mergeStartedAt;
    const encodeStartedAt = Date.now();
    const encodedAudio = encodeWav(samples, sampleRate).toString("base64");
    const encodeMs = Date.now() - encodeStartedAt;
    await emitResult(input.requestId, {
      ok: true,
      audioBase64: encodedAudio,
      sampleRate,
      durationMs: Math.round(samples.length / sampleRate * 1000),
      diagnostics: {
        workerAlreadyLoaded: loaded.alreadyLoaded,
        modelLoadMs: loaded.loadMs,
        segmentCount: segmentChars.length,
        segmentChars,
        segmentMs,
        mergeMs,
        encodeMs
      }
    });
  } catch (error) {
    await emitResult(input.requestId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }
}

let inputBuffer = "";
let requestQueue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split(/\\r?\\n/);
  inputBuffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line);
      requestQueue = requestQueue.then(() => handleRequest(request));
    } catch (error) {
      process.stderr.write(String(error) + "\\n");
    }
  }
  });
`;

const ttsModels: TtsModelDefinition[] = [
  {
    id: "kokoro-82m",
    label: "Kokoro 82M q8",
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    onnxFileName: "model_quantized.onnx",
    url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
    approximateSize: "92 MB"
  }
];

const ttsVoices: TtsVoiceDefinition[] = [
  { id: "af_heart", label: "Heart", description: "Warm American female", file: "af_heart.bin" },
  { id: "af_bella", label: "Bella", description: "Clear American female", file: "af_bella.bin" },
  { id: "af_nicole", label: "Nicole", description: "Soft American female", file: "af_nicole.bin" },
  { id: "af_sarah", label: "Sarah", description: "Balanced American female", file: "af_sarah.bin" },
  { id: "am_adam", label: "Adam", description: "Steady American male", file: "am_adam.bin" },
  { id: "am_puck", label: "Puck", description: "Bright American male", file: "am_puck.bin" },
  { id: "bf_emma", label: "Emma", description: "Natural British female", file: "bf_emma.bin" },
  { id: "bm_daniel", label: "Daniel", description: "Natural British male", file: "bm_daniel.bin" }
];

export function setTtsDataRoot(rootPath: string): void {
  ttsDataRoot = path.join(rootPath, "tts");
}

function ttsRoot(): string {
  if (!ttsDataRoot) throw new Error("Text-to-speech service has not been initialized.");
  return ttsDataRoot;
}

function modelDirectory(): string {
  return path.join(ttsRoot(), "models");
}

function modelDefinition(modelId: TtsModelId): TtsModelDefinition {
  const model = ttsModels.find((item) => item.id === modelId);
  if (!model) throw new Error(`Unsupported text-to-speech model: ${modelId}`);
  return model;
}

function voiceDefinition(voiceId: TtsVoiceId): TtsVoiceDefinition {
  const voice = ttsVoices.find((item) => item.id === voiceId);
  if (!voice) throw new Error(`Unsupported text-to-speech voice: ${voiceId}`);
  return voice;
}

async function directorySize(directoryPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) total += await directorySize(entryPath);
      else if (entry.isFile()) total += (await stat(entryPath)).size;
    }
  } catch {
    return total;
  }
  return total;
}

async function listCachedFiles(directoryPath: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) files.push(...await listCachedFiles(entryPath));
      else if (entry.isFile()) files.push(entryPath);
    }
  } catch {
    return files;
  }
  return files;
}

function modelCachePath(model: TtsModelDefinition): string {
  return path.join(modelDirectory(), ...model.modelId.split("/"));
}

function readyMarkerPath(model: TtsModelDefinition): string {
  return path.join(modelCachePath(model), `.archicode-${model.id}-ready.json`);
}

function legacyReadyMarkerPath(model: TtsModelDefinition): string {
  return path.join(modelCachePath(model), ".archicode-kokoro-ready.json");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function modelHasCachedWeights(model: TtsModelDefinition): Promise<boolean> {
  if (await fileExists(readyMarkerPath(model))) return true;
  if (model.id === "kokoro-82m" && await fileExists(legacyReadyMarkerPath(model))) return true;
  return modelHasCachedVariantFiles(model);
}

async function cachedVariantFiles(model: TtsModelDefinition): Promise<string[]> {
  const root = modelCachePath(model);
  const files = await listCachedFiles(root);
  return files.filter((file) => path.basename(file) === model.onnxFileName);
}

async function modelHasCachedVariantFiles(model: TtsModelDefinition): Promise<boolean> {
  return (await cachedVariantFiles(model)).length > 0;
}

async function modelVariantSize(model: TtsModelDefinition): Promise<number> {
  let total = 0;
  for (const file of await cachedVariantFiles(model)) {
    try {
      total += (await stat(file)).size;
    } catch {
      // Ignore files removed while status is refreshing.
    }
  }
  return total;
}

async function modelStatus(model: TtsModelDefinition): Promise<TtsModelStatus> {
  const cachePath = modelCachePath(model);
  const downloaded = await modelHasCachedWeights(model);
  const variantSize = await modelVariantSize(model);
  const sizeBytes = variantSize || downloaded ? variantSize || await directorySize(cachePath) : undefined;
  return { ...model, path: cachePath, downloaded, sizeBytes };
}

export async function getTtsRuntimeStatus(selectedModelId: TtsModelId = "kokoro-82m"): Promise<TtsRuntimeStatus> {
  await mkdir(modelDirectory(), { recursive: true });
  return {
    runtimeAvailable: true,
    runtimePath: "kokoro-js isolated worker",
    selectedModelId,
    models: await Promise.all(ttsModels.map(modelStatus)),
    voices: ttsVoices
  };
}

function nodeExecutable(): string {
  return process.env.npm_node_execpath ?? process.env.NODE ?? "node";
}

function kokoroModuleBasePath(): string {
  return require.resolve("kokoro-js");
}

function trimWorkerLog(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .map((line) => line.length > 600 ? `${line.slice(0, 600)}...` : line)
    .join("\n");
}

function rejectPendingWorkerRequests(worker: TtsWorkerProcess, error: Error): void {
  for (const request of worker.pending.values()) request.reject(error);
  worker.pending.clear();
}

function handleWorkerResultLine(worker: TtsWorkerProcess, line: string): void {
  const payload = JSON.parse(line.slice(workerResultPrefix.length)) as {
    requestId?: string;
    ok?: boolean;
    error?: string;
  } & TtsWorkerResult;
  if (!payload.requestId) return;
  const request = worker.pending.get(payload.requestId);
  if (!request) return;
  worker.pending.delete(payload.requestId);
  if (!payload.ok) {
    request.reject(new Error(payload.error ?? "Text-to-speech worker failed."));
    return;
  }
  request.resolve(payload);
}

function handleWorkerProgressLine(worker: TtsWorkerProcess, line: string): void {
  const progress = JSON.parse(line.slice(workerProgressPrefix.length)) as { requestId?: string; loaded?: number; total?: number };
  if (!progress.requestId || typeof progress.loaded !== "number") return;
  const request = worker.pending.get(progress.requestId);
  request?.onProgress?.({
    modelId: worker.modelId,
    receivedBytes: progress.loaded,
    totalBytes: typeof progress.total === "number" ? progress.total : undefined
  });
}

function handleWorkerChunkLine(worker: TtsWorkerProcess, line: string): void {
  const payload = JSON.parse(line.slice(workerChunkPrefix.length)) as {
    audioBase64?: string;
    chars?: number;
    durationMs?: number;
    index?: number;
    requestId?: string;
    sampleRate?: number;
    synthMs?: number;
    text?: string;
    total?: number;
  };
  if (!payload.requestId || typeof payload.audioBase64 !== "string") return;
  const request = worker.pending.get(payload.requestId);
  request?.onChunk?.({
    audioBase64: payload.audioBase64,
    chars: payload.chars,
    durationMs: payload.durationMs ?? 0,
    index: payload.index ?? 0,
    sampleRate: payload.sampleRate ?? 24000,
    synthMs: payload.synthMs,
    text: payload.text,
    total: payload.total ?? 1,
    workerIndex: worker.workerIndex
  });
  ttsConsoleInfo(
    `[archicode:tts] ${ttsElapsed(request?.debugStartedAtMs)}chunk emitted model=${worker.modelId} worker=${worker.workerIndex + 1}/${parallelTtsWorkerLimit} index=${payload.index ?? 0}/${payload.total ?? 1} ` +
    `chars=${payload.chars ?? 0} audio=${((payload.durationMs ?? 0) / 1000).toFixed(1)}s synth=${payload.synthMs ?? 0}ms`
  );
}

function ttsWorkerPool(modelId: TtsModelId): TtsWorkerProcess[] {
  const pool = activeTtsWorkers.get(modelId);
  if (!pool) {
    const nextPool: TtsWorkerProcess[] = [];
    activeTtsWorkers.set(modelId, nextPool);
    return nextPool;
  }
  return pool;
}

function removeTtsWorker(worker: TtsWorkerProcess): void {
  const pool = activeTtsWorkers.get(worker.modelId);
  if (!pool) return;
  const nextPool = pool.filter((item) => item !== worker);
  if (nextPool.length) activeTtsWorkers.set(worker.modelId, nextPool);
  else activeTtsWorkers.delete(worker.modelId);
}

async function spawnTtsWorker(modelId: TtsModelId, workerIndex: number): Promise<TtsWorkerProcess> {
  await mkdir(modelDirectory(), { recursive: true });
  const pool = ttsWorkerPool(modelId);
  const existing = pool.find((worker) => worker.workerIndex === workerIndex && !worker.child.killed);
  if (existing) return existing;

  const child = spawn(nodeExecutable(), ["--input-type=module", "-e", ttsWorkerScript], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const worker: TtsWorkerProcess = {
    child,
    modelId,
    workerIndex,
    stdoutBuffer: "",
    stderrBuffer: "",
    stderrLog: "",
    pending: new Map()
  };
  pool.push(worker);

  child.stdout.on("data", (chunk: Buffer) => {
    worker.stdoutBuffer += chunk.toString("utf8");
    const lines = worker.stdoutBuffer.split(/\r?\n/);
    worker.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(workerResultPrefix) && !line.startsWith(workerChunkPrefix)) continue;
      try {
        if (line.startsWith(workerChunkPrefix)) handleWorkerChunkLine(worker, line);
        else handleWorkerResultLine(worker, line);
      } catch (error) {
        rejectPendingWorkerRequests(worker, error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    worker.stderrLog += text;
    worker.stderrLog = trimWorkerLog(worker.stderrLog);
    worker.stderrBuffer += text;
    const lines = worker.stderrBuffer.split(/\r?\n/);
    worker.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(workerProgressPrefix)) continue;
      try {
        handleWorkerProgressLine(worker, line);
      } catch {
        // Ignore malformed worker progress lines; the final result still determines success.
      }
    }
  });

  child.on("error", (error) => {
    removeTtsWorker(worker);
    rejectPendingWorkerRequests(worker, error instanceof Error ? error : new Error(String(error)));
  });

  child.on("close", (code, signal) => {
    removeTtsWorker(worker);
    const detail = worker.stderrLog ? `\n${worker.stderrLog}` : "";
    rejectPendingWorkerRequests(worker, new Error(`Text-to-speech worker exited unexpectedly (${signal ?? code}).${detail}`));
  });

  return worker;
}

async function getTtsWorker(modelId: TtsModelId, preferredWorkerIndex?: number): Promise<TtsWorkerProcess> {
  await mkdir(modelDirectory(), { recursive: true });
  if (typeof preferredWorkerIndex === "number") return spawnTtsWorker(modelId, preferredWorkerIndex);
  const pool = ttsWorkerPool(modelId).filter((worker) => !worker.child.killed);
  if (pool.length < parallelTtsWorkerLimit) return spawnTtsWorker(modelId, pool.length);
  const minPending = Math.min(...pool.map((worker) => worker.pending.size));
  const candidates = pool.filter((worker) => worker.pending.size === minPending);
  const startIndex = nextTtsWorkerIndex.get(modelId) ?? 0;
  const chosen = candidates.reduce((best, worker) => {
    const bestDistance = (best.workerIndex - startIndex + parallelTtsWorkerLimit) % parallelTtsWorkerLimit;
    const workerDistance = (worker.workerIndex - startIndex + parallelTtsWorkerLimit) % parallelTtsWorkerLimit;
    return workerDistance < bestDistance ? worker : best;
  }, candidates[0]);
  nextTtsWorkerIndex.set(modelId, (chosen.workerIndex + 1) % parallelTtsWorkerLimit);
  return chosen;
}

async function warmTtsWorkerPool(
  modelId: TtsModelId,
  model: TtsModelDefinition,
  voiceId: TtsVoiceId,
  debugStartedAtMs?: number
): Promise<void> {
  const existing = ttsWorkerPoolWarmups.get(modelId);
  if (existing) return existing;
  const warmup = (async () => {
    const startedAt = Date.now();
    const results: TtsWorkerResult[] = [];
    for (let workerIndex = 0; workerIndex < parallelTtsWorkerLimit; workerIndex += 1) {
      try {
        const result = await runTtsWorker(modelId, {
          mode: "download",
          cacheDir: modelDirectory(),
          moduleBasePath: kokoroModuleBasePath(),
          modelName: model.modelId,
          voiceId
        }, undefined, undefined, debugStartedAtMs, workerIndex);
        results.push(result);
      } catch (error) {
        if (workerIndex === 0) throw error;
        parallelTtsWorkerLimit = Math.max(1, workerIndex);
        ttsConsoleWarn(
          `[archicode:tts] parallel warm fallback model=${modelId} workers=${parallelTtsWorkerLimit}/${maxParallelTtsWorkers} ` +
          `reason=${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
        );
        break;
      }
    }
    ttsConsoleInfo(
      `[archicode:tts] warm model=${modelId} voice=${voiceId} ` +
      `workers=${parallelTtsWorkerLimit}/${maxParallelTtsWorkers} ` +
      `load=${results.map((result) => result.diagnostics?.modelLoadMs ?? 0).join(",")}ms ` +
      `loaded=${results.map((result) => result.diagnostics?.workerAlreadyLoaded ? "yes" : "no").join(",")} ` +
      `total=${Date.now() - startedAt}ms`
    );
  })().finally(() => {
    ttsWorkerPoolWarmups.delete(modelId);
  });
  ttsWorkerPoolWarmups.set(modelId, warmup);
  return warmup;
}

async function runTtsWorker(
  modelId: TtsModelId,
  input: TtsWorkerInput,
  onProgress?: (progress: TtsModelDownloadProgress) => void,
  onChunk?: PendingTtsWorkerRequest["onChunk"],
  debugStartedAtMs?: number,
  preferredWorkerIndex?: number
): Promise<TtsWorkerResult> {
  const worker = await getTtsWorker(modelId, preferredWorkerIndex);
  const requestId = String(++nextTtsWorkerRequestId);
  return new Promise<TtsWorkerResult>((resolve, reject) => {
    worker.pending.set(requestId, { debugStartedAtMs, onChunk, onProgress, reject, resolve });
    worker.child.stdin.write(`${JSON.stringify({ ...input, requestId })}\n`, (error) => {
      if (!error) return;
      worker.pending.delete(requestId);
      reject(error);
    });
  }).then((result) => ({ ...result, workerIndex: worker.workerIndex }));
}

export async function downloadTtsModel(
  modelId: TtsModelId,
  voiceId: TtsVoiceId = "af_heart",
  onProgress?: (progress: TtsModelDownloadProgress) => void
): Promise<TtsModelStatus> {
  const model = modelDefinition(modelId);
  voiceDefinition(voiceId);
  await runTtsWorker(modelId, {
    mode: "download",
    cacheDir: modelDirectory(),
    moduleBasePath: kokoroModuleBasePath(),
    modelName: model.modelId,
    voiceId
  }, onProgress);
  await mkdir(modelCachePath(model), { recursive: true });
  await writeFile(readyMarkerPath(model), JSON.stringify({
    modelId,
    voiceId,
    downloadedAt: new Date().toISOString(),
    runtime: "kokoro-js",
    worker: "node"
  }, null, 2));
  const status = await modelStatus(model);
  return { ...status, downloaded: true };
}

export async function warmTtsModel(
  modelId: TtsModelId,
  voiceId: TtsVoiceId = "af_heart"
): Promise<TtsModelStatus> {
  const model = modelDefinition(modelId);
  voiceDefinition(voiceId);
  const status = await modelStatus(model);
  if (!status.downloaded) return status;
  await warmTtsWorkerPool(modelId, model, voiceId);
  return modelStatus(model);
}

export async function deleteTtsModel(modelId: TtsModelId): Promise<TtsModelStatus> {
  const model = modelDefinition(modelId);
  stopTtsWorker(modelId);
  clearTtsAudioCache(modelId);
  await rm(readyMarkerPath(model), { force: true });
  if (model.id === "kokoro-82m") await rm(legacyReadyMarkerPath(model), { force: true });
  await Promise.all((await cachedVariantFiles(model)).map((file) => rm(file, { force: true })));
  return modelStatus(model);
}

function clampSpeed(speed: number | undefined): number {
  if (typeof speed !== "number" || Number.isNaN(speed)) return 1;
  return Math.min(1.2, Math.max(0.8, speed));
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const buffer = Buffer.alloc(44 + samples.length * bytesPerSample);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) buffer.writeUInt8(value.charCodeAt(index), offset + index);
  };
  writeString(0, "RIFF");
  buffer.writeUInt32LE(36 + samples.length * bytesPerSample, 4);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(8 * bytesPerSample, 34);
  writeString(36, "data");
  buffer.writeUInt32LE(samples.length * bytesPerSample, 40);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    buffer.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), offset);
    offset += bytesPerSample;
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function compactSpeechText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeSpeechText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ttsAudioCacheKey(input: {
  modelId: TtsModelId;
  speed: number;
  text: string;
  voiceId: TtsVoiceId;
}): string {
  const hash = createHash("sha256").update(input.text).digest("hex");
  return `${input.modelId}:${input.voiceId}:${input.speed}:${hash}`;
}

function getCachedTtsAudio(cacheKey: string): CachedTtsAudio | null {
  const cached = ttsAudioCache.get(cacheKey);
  if (!cached) return null;
  ttsAudioCache.delete(cacheKey);
  ttsAudioCache.set(cacheKey, cached);
  return cached;
}

function setCachedTtsAudio(cacheKey: string, audio: CachedTtsAudio): void {
  ttsAudioCache.set(cacheKey, audio);
  while (ttsAudioCache.size > maxCachedTtsAudioEntries) {
    const oldestKey = ttsAudioCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    ttsAudioCache.delete(oldestKey);
  }
}

function clearTtsAudioCache(modelId?: TtsModelId): void {
  if (!modelId) {
    ttsAudioCache.clear();
    return;
  }
  for (const key of Array.from(ttsAudioCache.keys())) {
    if (key.startsWith(`${modelId}:`)) ttsAudioCache.delete(key);
  }
}

function ttsArrayBuffer(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer;
}

function ttsElapsed(startedAtMs?: number): string {
  return typeof startedAtMs === "number" ? `+${Math.max(0, Date.now() - startedAtMs)}ms ` : "";
}

function logTtsDiagnostics(input: {
  cacheHit: boolean;
  diagnostics?: TtsSynthesisDiagnostics;
  durationMs: number;
  generationMs: number;
  modelId: TtsModelId;
  sampleRate: number;
  textChars: number;
  voiceId: TtsVoiceId;
}): void {
  const diagnostics = input.diagnostics;
  const segmentMs = diagnostics?.segmentMs?.reduce((sum, value) => sum + value, 0) ?? 0;
  ttsConsoleInfo(
    `[archicode:tts] cache=${input.cacheHit ? "hit" : "miss"} model=${input.modelId} voice=${input.voiceId} ` +
    `chars=${input.textChars} segments=${diagnostics?.segmentCount ?? 0} audio=${(input.durationMs / 1000).toFixed(1)}s ` +
    `total=${input.generationMs}ms worker=${diagnostics?.workerMs ?? 0}ms load=${diagnostics?.modelLoadMs ?? 0}ms ` +
    `loaded=${diagnostics?.workerAlreadyLoaded ? "yes" : "no"} workerSlot=${typeof diagnostics?.workerIndex === "number" ? diagnostics.workerIndex + 1 : "?"}/${diagnostics?.workerCount ?? parallelTtsWorkerLimit} ` +
    `synth=${segmentMs}ms encode=${diagnostics?.encodeMs ?? 0}ms ` +
    `sampleRate=${input.sampleRate}`
  );
}

function splitSpeechSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const line of text.split(/\n+/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    const lineSentences = trimmedLine.match(/[^.!?]+[.!?]+["')\]]?|[^.!?]+$/g) ?? [trimmedLine];
    for (const sentence of lineSentences) {
      const trimmed = compactSpeechText(sentence);
      if (trimmed) sentences.push(trimmed);
    }
  }
  return sentences.length ? sentences : [compactSpeechText(text)];
}

function splitLongSpeechSentence(sentence: string): string[] {
  const compact = compactSpeechText(sentence);
  if (compact.length <= maxSpeechClauseChars) return [compact];

  const clauses = compact.split(/(?<=[,;:])\s+/);
  if (clauses.length <= 1) return [compact];

  const segments: string[] = [];
  let current = "";
  for (const clause of clauses) {
    const candidate = current ? `${current} ${clause}` : clause;
    if (current && candidate.length > maxSpeechClauseChars) {
      segments.push(current);
      current = clause;
    } else {
      current = candidate;
    }
  }
  if (current) segments.push(current);

  return segments.length ? segments : [compact];
}

function splitSpeechSegments(text: string): string[] {
  const segments: string[] = [];
  for (const block of normalizeSpeechText(text).split(/\n+/)) {
    const speechUnits = splitSpeechSentences(block).flatMap(splitLongSpeechSentence);
    for (let index = 0; index < speechUnits.length;) {
      if (segments.length < earlySpeechSingleSegmentCount) {
        segments.push(speechUnits[index]);
        index += 1;
        continue;
      }

      const first = speechUnits[index];
      const second = speechUnits[index + 1];
      const pair = second ? compactSpeechText(`${first} ${second}`) : "";
      if (second && pair.length <= maxSpeechClauseChars * 2) {
        segments.push(pair);
        index += 2;
      } else {
        segments.push(first);
        index += 1;
      }
    }
  }

  return segments.length ? segments : [compactSpeechText(text)];
}

function stopTtsWorker(modelId: TtsModelId): void {
  const workers = activeTtsWorkers.get(modelId);
  if (!workers?.length) return;
  activeTtsWorkers.delete(modelId);
  nextTtsWorkerIndex.delete(modelId);
  for (const worker of workers) {
    rejectPendingWorkerRequests(worker, new Error("Text-to-speech worker was stopped."));
    worker.child.kill();
  }
}

export function shutdownTtsWorkers(): void {
  clearTtsAudioCache();
  for (const modelId of Array.from(activeTtsWorkers.keys())) stopTtsWorker(modelId);
}

export async function synthesizeSpeech(input: {
  text: string;
  modelId?: TtsModelId;
  voiceId?: TtsVoiceId;
  speed?: number;
}): Promise<TtsSynthesisResult> {
  const startedAt = Date.now();
  const text = normalizeSpeechText(input.text);
  if (!text) throw new Error("Text-to-speech input cannot be empty.");
  const segments = splitSpeechSegments(text);
  const modelId = input.modelId ?? "kokoro-82m";
  const voiceId = input.voiceId ?? "af_heart";
  const speed = clampSpeed(input.speed);
  const cacheKey = ttsAudioCacheKey({ modelId, voiceId, speed, text });
  const cached = getCachedTtsAudio(cacheKey);
  if (cached) {
    const generationMs = Date.now() - startedAt;
    const diagnostics = {
      ...cached.diagnostics,
      cacheHit: true,
      workerMs: 0
    };
    logTtsDiagnostics({
      cacheHit: true,
      diagnostics,
      durationMs: cached.durationMs,
      generationMs,
      modelId,
      sampleRate: cached.sampleRate,
      textChars: text.length,
      voiceId
    });
    return {
      audio: ttsArrayBuffer(cached.audioBuffer),
      mimeType: "audio/wav",
      modelId,
      voiceId,
      sampleRate: cached.sampleRate,
      durationMs: cached.durationMs,
      generationMs,
      diagnostics
    };
  }
  const model = modelDefinition(modelId);
  voiceDefinition(voiceId);
  await warmTtsWorkerPool(modelId, model, voiceId);
  const workerStartedAt = Date.now();
  const output = await runTtsWorker(modelId, {
    mode: "synthesize",
    cacheDir: modelDirectory(),
    moduleBasePath: kokoroModuleBasePath(),
    modelName: model.modelId,
    voiceId,
    text,
    segments,
    speed
  });
  if (!output.audioBase64) throw new Error("Text-to-speech worker did not return audio.");
  const audioBuffer = Buffer.from(output.audioBase64, "base64");
  const sampleRate = output.sampleRate ?? 24000;
  const durationMs = output.durationMs ?? 0;
  const generationMs = Date.now() - startedAt;
  const diagnostics: TtsSynthesisDiagnostics = {
    cacheHit: false,
    textChars: text.length,
    segmentCount: segments.length,
    segmentChars: segments.map((segment) => segment.length),
    ...output.diagnostics,
    workerCount: parallelTtsWorkerLimit,
    workerIndex: output.workerIndex,
    workerMs: Date.now() - workerStartedAt
  };
  setCachedTtsAudio(cacheKey, {
    audioBuffer,
    diagnostics,
    durationMs,
    generationMs,
    sampleRate
  });
  logTtsDiagnostics({
    cacheHit: false,
    diagnostics,
    durationMs,
    generationMs,
    modelId,
    sampleRate,
    textChars: text.length,
    voiceId
  });
  return {
    audio: ttsArrayBuffer(audioBuffer),
    mimeType: "audio/wav",
    modelId,
    voiceId,
    sampleRate,
    durationMs,
    generationMs,
    diagnostics
  };
}

export async function streamSpeech(
  input: {
    debugStartedAtMs?: number;
    text: string;
    modelId?: TtsModelId;
    singleSegment?: boolean;
    voiceId?: TtsVoiceId;
    speed?: number;
  },
  onChunk: (chunk: TtsSpeechStreamChunk) => void
): Promise<TtsSpeechStreamResult> {
  const startedAt = Date.now();
  const text = normalizeSpeechText(input.text);
  if (!text) throw new Error("Text-to-speech input cannot be empty.");
  const segments = input.singleSegment ? [text] : splitSpeechSegments(text);
  const modelId = input.modelId ?? "kokoro-82m";
  const voiceId = input.voiceId ?? "af_heart";
  const speed = clampSpeed(input.speed);
  const cacheKey = ttsAudioCacheKey({ modelId, voiceId, speed, text });
  const cached = getCachedTtsAudio(cacheKey);
  if (cached) {
    const generationMs = Date.now() - startedAt;
    const diagnostics = {
      ...cached.diagnostics,
      cacheHit: true,
      workerCount: parallelTtsWorkerLimit,
      workerMs: 0
    };
    onChunk({
      audio: ttsArrayBuffer(cached.audioBuffer),
      durationMs: cached.durationMs,
      index: 0,
      mimeType: "audio/wav",
      sampleRate: cached.sampleRate,
      text,
      total: 1,
      workerIndex: cached.diagnostics.workerIndex
    });
    ttsConsoleInfo(
      `[archicode:tts] ${ttsElapsed(input.debugStartedAtMs)}cache chunk emitted model=${modelId} index=0/1 ` +
      `audio=${(cached.durationMs / 1000).toFixed(1)}s`
    );
    logTtsDiagnostics({
      cacheHit: true,
      diagnostics,
      durationMs: cached.durationMs,
      generationMs,
      modelId,
      sampleRate: cached.sampleRate,
      textChars: text.length,
      voiceId
    });
    return {
      cacheHit: true,
      diagnostics,
      durationMs: cached.durationMs,
      generationMs,
      modelId,
      segmentCount: 1,
      voiceId
    };
  }

  const model = modelDefinition(modelId);
  voiceDefinition(voiceId);
  await warmTtsWorkerPool(modelId, model, voiceId, input.debugStartedAtMs);
  const workerStartedAt = Date.now();
  let emittedChunkCount = 0;
  const output = await runTtsWorker(modelId, {
    mode: "stream",
    cacheDir: modelDirectory(),
    moduleBasePath: kokoroModuleBasePath(),
    modelName: model.modelId,
    voiceId,
    text,
    segments,
    speed
  }, undefined, (chunk) => {
    const audioBuffer = Buffer.from(chunk.audioBase64, "base64");
    emittedChunkCount += 1;
    onChunk({
      audio: ttsArrayBuffer(audioBuffer),
      chars: chunk.chars,
      durationMs: chunk.durationMs,
      index: chunk.index,
      mimeType: "audio/wav",
      sampleRate: chunk.sampleRate,
      synthMs: chunk.synthMs,
      text: chunk.text ?? segments[chunk.index],
      total: chunk.total,
      workerIndex: chunk.workerIndex
    });
  }, input.debugStartedAtMs);
  if (!output.audioBase64) throw new Error("Text-to-speech worker did not return audio.");
  const audioBuffer = Buffer.from(output.audioBase64, "base64");
  const sampleRate = output.sampleRate ?? 24000;
  const durationMs = output.durationMs ?? 0;
  if (emittedChunkCount === 0) {
    onChunk({
      audio: ttsArrayBuffer(audioBuffer),
      chars: text.length,
      durationMs,
      index: 0,
      mimeType: "audio/wav",
      sampleRate,
      synthMs: output.diagnostics?.segmentMs?.reduce((sum, value) => sum + value, 0),
      text,
      total: 1,
      workerIndex: output.workerIndex
    });
    ttsConsoleInfo(
      `[archicode:tts] ${ttsElapsed(input.debugStartedAtMs)}final audio emitted model=${modelId} index=0/1 ` +
      `audio=${(durationMs / 1000).toFixed(1)}s worker=${typeof output.workerIndex === "number" ? output.workerIndex + 1 : "?"}`
    );
  }
  const generationMs = Date.now() - startedAt;
  const diagnostics: TtsSynthesisDiagnostics = {
    cacheHit: false,
    textChars: text.length,
    segmentCount: segments.length,
    segmentChars: segments.map((segment) => segment.length),
    ...output.diagnostics,
    workerCount: parallelTtsWorkerLimit,
    workerIndex: output.workerIndex,
    workerMs: Date.now() - workerStartedAt
  };
  setCachedTtsAudio(cacheKey, {
    audioBuffer,
    diagnostics,
    durationMs,
    generationMs,
    sampleRate
  });
  logTtsDiagnostics({
    cacheHit: false,
    diagnostics,
    durationMs,
    generationMs,
    modelId,
    sampleRate,
    textChars: text.length,
    voiceId
  });
  return {
    cacheHit: false,
    diagnostics,
    durationMs,
    generationMs,
    modelId,
    segmentCount: segments.length,
    voiceId
  };
}
