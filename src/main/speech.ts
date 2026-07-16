import { env, pipeline } from "@huggingface/transformers";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { SpeechModelId } from "../shared/schema";

type SpeechModelDefinition = {
  id: SpeechModelId;
  label: string;
  modelId: string;
  url: string;
  approximateSize: string;
};

export type SpeechModelStatus = SpeechModelDefinition & {
  path: string;
  downloaded: boolean;
  sizeBytes?: number;
};

export type SpeechRuntimeStatus = {
  runtimeAvailable: boolean;
  runtimePath?: string;
  runtimeError?: string;
  selectedModelId: SpeechModelId;
  models: SpeechModelStatus[];
};

export type SpeechModelDownloadProgress = {
  modelId: SpeechModelId;
  receivedBytes: number;
  totalBytes?: number;
};

export type SpeechTranscriptionResult = {
  text: string;
  modelId: SpeechModelId;
  durationMs: number;
};

type TransformersProgress = {
  status?: string;
  name?: string;
  file?: string;
  loaded?: number;
  total?: number;
};

type AutomaticSpeechRecognitionPipeline = Awaited<ReturnType<typeof pipeline<"automatic-speech-recognition">>>;

let speechDataRoot: string | null = null;
const loadedPipelines = new Map<SpeechModelId, Promise<AutomaticSpeechRecognitionPipeline>>();

const TARGET_SAMPLE_RATE = 16000;
const speechLanguageAliases: Record<string, string> = {
  auto: "english",
  en: "english",
  zh: "chinese",
  de: "german",
  es: "spanish",
  ru: "russian",
  ko: "korean",
  fr: "french",
  ja: "japanese",
  pt: "portuguese",
  tr: "turkish",
  pl: "polish",
  ca: "catalan",
  nl: "dutch",
  ar: "arabic",
  sv: "swedish",
  it: "italian",
  id: "indonesian",
  hi: "hindi",
  fi: "finnish",
  vi: "vietnamese",
  he: "hebrew",
  uk: "ukrainian",
  el: "greek",
  ms: "malay",
  cs: "czech",
  ro: "romanian",
  da: "danish",
  hu: "hungarian",
  ta: "tamil",
  no: "norwegian",
  th: "thai",
  ur: "urdu",
  fa: "persian",
  bn: "bengali"
};
const speechModels: SpeechModelDefinition[] = [
  {
    id: "base",
    label: "Whisper base multilingual",
    modelId: "Xenova/whisper-base",
    url: "https://huggingface.co/Xenova/whisper-base",
    approximateSize: "77 MB"
  },
  {
    id: "base.en",
    label: "Whisper base English optimized",
    modelId: "Xenova/whisper-base.en",
    url: "https://huggingface.co/Xenova/whisper-base.en",
    approximateSize: "77 MB"
  }
];

export function setSpeechDataRoot(rootPath: string): void {
  speechDataRoot = path.join(rootPath, "speech");
  configureTransformers();
}

function speechRoot(): string {
  if (!speechDataRoot) throw new Error("Speech service has not been initialized.");
  return speechDataRoot;
}

function modelDirectory(): string {
  return path.join(speechRoot(), "models");
}

function configureTransformers(): void {
  if (!speechDataRoot) return;
  env.cacheDir = modelDirectory();
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
}

function modelDefinition(modelId: SpeechModelId): SpeechModelDefinition {
  const model = speechModels.find((item) => item.id === modelId);
  if (!model) throw new Error(`Unsupported speech model: ${modelId}`);
  return model;
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

async function modelHasCachedWeights(model: SpeechModelDefinition): Promise<boolean> {
  const root = path.join(modelDirectory(), ...model.modelId.split("/"));
  const files = await listCachedFiles(root);
  return files.some((file) => /encoder_model.*\.onnx$/i.test(file)) &&
    files.some((file) => /decoder_model.*\.onnx$/i.test(file));
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

async function modelStatus(model: SpeechModelDefinition): Promise<SpeechModelStatus> {
  const cachePath = path.join(modelDirectory(), ...model.modelId.split("/"));
  const downloaded = await modelHasCachedWeights(model);
  const sizeBytes = downloaded ? await directorySize(cachePath) : undefined;
  return { ...model, path: cachePath, downloaded, sizeBytes };
}

export async function getSpeechRuntimeStatus(selectedModelId: SpeechModelId = "base"): Promise<SpeechRuntimeStatus> {
  configureTransformers();
  await mkdir(modelDirectory(), { recursive: true });
  return {
    runtimeAvailable: true,
    runtimePath: "@huggingface/transformers",
    selectedModelId,
    models: await Promise.all(speechModels.map(modelStatus))
  };
}

function pipelineProgress(modelId: SpeechModelId, onProgress?: (progress: SpeechModelDownloadProgress) => void) {
  return (progress: TransformersProgress) => {
    if (typeof progress.loaded !== "number") return;
    onProgress?.({
      modelId,
      receivedBytes: progress.loaded,
      totalBytes: typeof progress.total === "number" ? progress.total : undefined
    });
  };
}

async function loadSpeechPipeline(
  modelId: SpeechModelId,
  onProgress?: (progress: SpeechModelDownloadProgress) => void
): Promise<AutomaticSpeechRecognitionPipeline> {
  configureTransformers();
  await mkdir(modelDirectory(), { recursive: true });
  const model = modelDefinition(modelId);
  let existing = loadedPipelines.get(modelId);
  if (!existing) {
    existing = pipeline("automatic-speech-recognition", model.modelId, {
      cache_dir: modelDirectory(),
      dtype: "q8",
      progress_callback: pipelineProgress(modelId, onProgress)
    });
    loadedPipelines.set(modelId, existing);
  }
  return existing;
}

export async function downloadSpeechModel(
  modelId: SpeechModelId,
  onProgress?: (progress: SpeechModelDownloadProgress) => void
): Promise<SpeechModelStatus> {
  await loadSpeechPipeline(modelId, onProgress);
  const status = await modelStatus(modelDefinition(modelId));
  return { ...status, downloaded: true };
}

export async function deleteSpeechModel(modelId: SpeechModelId): Promise<SpeechModelStatus> {
  const model = modelDefinition(modelId);
  loadedPipelines.delete(modelId);
  await rm(path.join(modelDirectory(), ...model.modelId.split("/")), { recursive: true, force: true });
  return modelStatus(model);
}

function audioBufferFromInput(audio: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (audio instanceof ArrayBuffer) return audio;
  const copy = new Uint8Array(audio.byteLength);
  copy.set(new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength));
  return copy.buffer;
}

function decodeWav(audio: ArrayBuffer | ArrayBufferView): { samples: Float32Array; sampleRate: number } {
  const buffer = audioBufferFromInput(audio);
  const view = new DataView(buffer);
  const text = (offset: number, length: number) => Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join("");
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") throw new Error("Recorded audio was not a WAV file.");

  let offset = 12;
  let audioFormat = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = text(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(chunkDataOffset, true);
      channelCount = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
    }
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !channelCount || dataOffset < 0 || dataSize <= 0) throw new Error("Recorded WAV file was incomplete.");
  if (audioFormat !== 1 && audioFormat !== 3) throw new Error("Recorded WAV format is unsupported.");
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (bytesPerSample * channelCount));
  const samples = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sampleOffset = dataOffset + (frame * channelCount + channel) * bytesPerSample;
      if (audioFormat === 3 && bitsPerSample === 32) {
        sum += view.getFloat32(sampleOffset, true);
      } else if (bitsPerSample === 16) {
        sum += view.getInt16(sampleOffset, true) / 0x8000;
      } else if (bitsPerSample === 24) {
        const value = view.getUint8(sampleOffset) | (view.getUint8(sampleOffset + 1) << 8) | (view.getUint8(sampleOffset + 2) << 16);
        sum += ((value & 0x800000) ? value | 0xff000000 : value) / 0x800000;
      } else {
        throw new Error(`Recorded WAV bit depth ${bitsPerSample} is unsupported.`);
      }
    }
    samples[frame] = sum / channelCount;
  }

  return { samples, sampleRate };
}

function resampleLinear(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return samples;
  const targetLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const output = new Float32Array(targetLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < targetLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    output[index] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return output;
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeSpeechLanguage(language: string | undefined): string {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return "english";
  return speechLanguageAliases[normalized] ?? normalized;
}

export async function transcribeSpeech(input: {
  audio: ArrayBuffer | ArrayBufferView;
  modelId?: SpeechModelId;
  language?: string;
  translateToEnglish?: boolean;
  threads?: number;
}): Promise<SpeechTranscriptionResult> {
  const startedAt = Date.now();
  const modelId = input.modelId ?? "base";
  const { samples, sampleRate } = decodeWav(input.audio);
  const audio = resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE);
  const transcriber = await loadSpeechPipeline(modelId);
  const language = normalizeSpeechLanguage(input.language);
  const result = await transcriber(
    audio,
    modelId === "base.en"
      ? {}
      : {
          task: input.translateToEnglish ? "translate" : "transcribe",
          ...(language && language !== "auto" ? { language } : {})
        }
  );

  return {
    text: compactText(Array.isArray(result) ? result.map((item) => item.text).join(" ") : result.text),
    modelId,
    durationMs: Date.now() - startedAt
  };
}
