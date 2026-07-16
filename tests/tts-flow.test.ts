import { existsSync } from "node:fs";
import { availableParallelism, homedir, platform } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getTtsRuntimeStatus,
  setTtsDataRoot,
  shutdownTtsWorkers,
  streamSpeech,
  warmTtsModel,
  type TtsSpeechStreamChunk
} from "../src/main/tts";

function appDataRoot(): string {
  if (process.env.ARCHICODE_TTS_TEST_ROOT) return process.env.ARCHICODE_TTS_TEST_ROOT;
  if (platform() === "darwin") return path.join(homedir(), "Library", "Application Support", "archicode");
  if (platform() === "win32") return path.join(process.env.APPDATA ?? homedir(), "archicode");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "archicode");
}

const ttsRoot = appDataRoot();
const downloadedKokoroModelPath = path.join(
  ttsRoot,
  "tts",
  "models",
  "onnx-community",
  "Kokoro-82M-v1.0-ONNX",
  "onnx",
  "model_quantized.onnx"
);

const describeWithDownloadedKokoro = existsSync(downloadedKokoroModelPath) ? describe : describe.skip;

describeWithDownloadedKokoro("downloaded Kokoro TTS flow", () => {
  afterEach(() => {
    shutdownTtsWorkers();
  });

  it("streams playable audio through the real app model cache", async () => {
    setTtsDataRoot(ttsRoot);

    const status = await getTtsRuntimeStatus("kokoro-82m");
    expect(status.models.find((model) => model.id === "kokoro-82m")?.downloaded).toBe(true);

    await warmTtsModel("kokoro-82m", "af_heart");

    const chunks: TtsSpeechStreamChunk[] = [];
    const result = await streamSpeech({
      modelId: "kokoro-82m",
      voiceId: "af_heart",
      text: "Hello from Archy Code. This is a local Kokoro smoke test.",
      speed: 1
    }, (chunk) => chunks.push(chunk));

    expect(result.cacheHit).toBe(false);
    expect(result.durationMs).toBeGreaterThan(500);
    expect(result.diagnostics?.workerCount).toBeGreaterThanOrEqual(1);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].sampleRate).toBe(24000);
    expect(chunks[0].audio.byteLength).toBeGreaterThan(44);
  }, 120_000);

  it("keeps a renderer prepare unit as one playback chunk", async () => {
    setTtsDataRoot(ttsRoot);
    await warmTtsModel("kokoro-82m", "af_heart");

    const chunks: TtsSpeechStreamChunk[] = [];
    const result = await streamSpeech({
      modelId: "kokoro-82m",
      singleSegment: true,
      text: "This prepare unit should stay as one playback chunk, even though it has a comma and several words.",
      voiceId: "af_heart",
      speed: 1
    }, (chunk) => chunks.push(chunk));

    expect(result.segmentCount).toBe(1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].total).toBe(1);
  }, 120_000);

  it("dispatches concurrent speech requests across the warm worker pool", async () => {
    setTtsDataRoot(ttsRoot);
    await warmTtsModel("kokoro-82m", "af_heart");

    const requests = [
      "First parallel Kokoro request.",
      "Second parallel Kokoro request.",
      "Third parallel Kokoro request."
    ];
    const jobs = await Promise.all(requests.map(async (text) => {
      const chunks: TtsSpeechStreamChunk[] = [];
      const result = await streamSpeech({ modelId: "kokoro-82m", voiceId: "af_heart", text, speed: 1 }, (chunk) => chunks.push(chunk));
      return { chunks, result };
    }));

    const workerIndexes = new Set<number>();
    for (const job of jobs) {
      expect(job.chunks.length).toBeGreaterThan(0);
      expect(job.result.durationMs).toBeGreaterThan(250);
      for (const chunk of job.chunks) {
        if (typeof chunk.workerIndex === "number") workerIndexes.add(chunk.workerIndex);
      }
    }

    const expectedMinimumWorkers = availableParallelism() >= 3 ? 2 : 1;
    expect(workerIndexes.size).toBeGreaterThanOrEqual(expectedMinimumWorkers);
  }, 120_000);
});
