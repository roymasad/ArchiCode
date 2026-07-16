import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const files = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "vocab.txt",
  "onnx/model_quantized.onnx"
];

const models = [
  { modelId: "BAAI/bge-small-en-v1.5", revision: "c5ac6c397e27c80e0229ec647987f2e553fc0ba9" },
  { modelId: "Xenova/all-MiniLM-L6-v2", revision: "751bff37182d3f1213fa05d7196b954e230abad9" }
];

for (const { modelId, revision } of models) {
  const destination = path.resolve("resources", "semantic-model", ...modelId.split("/"));
  for (const file of files) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    const url = `https://huggingface.co/${modelId}/resolve/${revision}/${file}`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(target, bytes);
    process.stdout.write(`Fetched ${modelId}/${file} (${bytes.byteLength.toLocaleString()} bytes)\n`);
  }
}
