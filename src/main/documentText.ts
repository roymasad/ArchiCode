import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PDFParse } from "pdf-parse";

const requireFromDocumentText = createRequire(import.meta.url);

type MammothModule = {
  extractRawText(input: { path: string } | { buffer: Buffer }): Promise<{ value: string; messages?: Array<{ message?: string; type?: string }> }>;
};

const utf8TextMediaTypes = new Set([
  "application/json",
  "application/x-ndjson",
  "application/yaml",
  "application/toml",
  "application/xml"
]);

const extractedTextMediaTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);

export function isDirectUtf8TextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || utf8TextMediaTypes.has(mediaType);
}

export function isSupportedTextDocumentMediaType(mediaType: string): boolean {
  return isDirectUtf8TextMediaType(mediaType) || extractedTextMediaTypes.has(mediaType);
}

export async function extractTextDocument(filePath: string, mediaType: string): Promise<{ text: string; warnings: string[]; extracted: boolean }> {
  if (isDirectUtf8TextMediaType(mediaType)) {
    return { text: await readFile(filePath, "utf8"), warnings: [], extracted: false };
  }
  if (mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = requireFromDocumentText("mammoth") as MammothModule;
    const result = await mammoth.extractRawText({ path: filePath });
    return {
      text: result.value,
      warnings: (result.messages ?? []).map((message) => message.message ?? message.type ?? "Mammoth warning."),
      extracted: true
    };
  }
  if (mediaType === "application/pdf") {
    const data = await readFile(filePath);
    const parser = new PDFParse({ data });
    try {
      const result = await parser.getText();
      return { text: result.text, warnings: [], extracted: true };
    } finally {
      await parser.destroy();
    }
  }
  throw new Error(`Unsupported text document media type: ${mediaType}`);
}
