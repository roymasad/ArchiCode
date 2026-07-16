import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { artifactSchema } from "../../shared/schema";
import type { Artifact, Note, ProjectBundle, Run } from "../../shared/schema";
import type { ProviderImageAttachment, ProviderTextAttachment } from "../providers";
import { isSupportedTextDocumentMediaType } from "../documentText";
import { id, iso, projectStatePath, safeFileName, writeJson } from "./persistence";
import { shouldIncludeNoteInLlmContext } from "./ledgers";

export function mediaTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".txt" || ext === ".text" || ext === ".log") return "text/plain";
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".json") return "application/json";
  if (ext === ".jsonl" || ext === ".ndjson") return "application/x-ndjson";
  if (ext === ".csv") return "text/csv";
  if (ext === ".tsv") return "text/tab-separated-values";
  if (ext === ".yaml" || ext === ".yml") return "application/yaml";
  if (ext === ".toml") return "application/toml";
  if (ext === ".ini" || ext === ".conf" || ext === ".cfg") return "text/plain";
  if (ext === ".xml") return "application/xml";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if ([".css", ".scss", ".sass", ".less"].includes(ext)) return "text/css";
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) return "text/javascript";
  if ([".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh", ".fish", ".sql"].includes(ext)) return "text/plain";
  return "application/octet-stream";
}

export function isSupportedTextAttachmentMediaType(mediaType: string): boolean {
  return isSupportedTextDocumentMediaType(mediaType);
}

export function isSupportedAttachmentMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/") || isSupportedTextAttachmentMediaType(mediaType);
}

export async function createAttachmentArtifacts(
  projectRoot: string,
  filePaths: string[],
  options: { nodeId?: string; noteId?: string; runId?: string; summary?: string } = {}
): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  if (!filePaths.length) return artifacts;
  await mkdir(projectStatePath(projectRoot, "artifacts", "attachments"), { recursive: true });
  for (const filePath of filePaths) {
    const mediaType = mediaTypeForFile(filePath);
    if (!isSupportedAttachmentMediaType(mediaType)) continue;
    const fileStats = await stat(filePath);
    const artifactId = id("attachment");
    const fileName = safeFileName(path.basename(filePath));
    const relativePath = `.archicode/artifacts/attachments/${artifactId}-${fileName}`;
    await copyFile(filePath, path.join(projectRoot, relativePath));
    const artifact = artifactSchema.parse({
      id: artifactId,
      type: "attachment",
      title: path.basename(filePath),
      path: relativePath,
      nodeId: options.nodeId,
      noteId: options.noteId,
      runId: options.runId,
      mediaType,
      summary: options.summary ?? (mediaType.startsWith("image/") ? "Image attachment." : "Text document attachment."),
      sizeBytes: fileStats.size,
      createdAt: iso()
    });
    await writeJson(projectStatePath(projectRoot, "artifacts", `${artifactId}.json`), artifact);
    artifacts.push(artifact);
  }
  return artifacts;
}

export async function createImageArtifacts(
  projectRoot: string,
  filePaths: string[],
  options: { nodeId?: string; noteId?: string; runId?: string; summary?: string } = {}
): Promise<Artifact[]> {
  return (await createAttachmentArtifacts(projectRoot, filePaths, options)).filter((artifact) => artifact.mediaType?.startsWith("image/"));
}

export function providerImageAttachmentForArtifact(projectRoot: string, artifact: Artifact): ProviderImageAttachment | null {
  if (!artifact.mediaType?.startsWith("image/")) return null;
  return {
    title: artifact.title,
    path: path.join(projectRoot, artifact.path),
    mediaType: artifact.mediaType
  };
}

export function providerTextAttachmentForArtifact(projectRoot: string, artifact: Artifact): ProviderTextAttachment | null {
  if (!artifact.mediaType || !isSupportedTextAttachmentMediaType(artifact.mediaType)) return null;
  return {
    title: artifact.title,
    path: path.join(projectRoot, artifact.path),
    mediaType: artifact.mediaType
  };
}

export function uniqueProviderImageAttachments(attachments: ProviderImageAttachment[]): ProviderImageAttachment[] {
  const seen = new Set<string>();
  const unique: ProviderImageAttachment[] = [];
  for (const attachment of attachments) {
    const key = `${attachment.path}\0${attachment.mediaType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(attachment);
  }
  return unique;
}

export function uniqueProviderTextAttachments(attachments: ProviderTextAttachment[]): ProviderTextAttachment[] {
  const seen = new Set<string>();
  const unique: ProviderTextAttachment[] = [];
  for (const attachment of attachments) {
    const key = `${attachment.path}\0${attachment.mediaType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(attachment);
  }
  return unique;
}

export function imageAttachmentsForArtifacts(projectRoot: string, bundle: ProjectBundle, artifactIds: string[]): ProviderImageAttachment[] {
  if (!artifactIds.length) return [];
  const artifactIdSet = new Set(artifactIds);
  return uniqueProviderImageAttachments(bundle.artifacts
    .filter((artifact) => artifactIdSet.has(artifact.id))
    .flatMap((artifact) => {
      const attachment = providerImageAttachmentForArtifact(projectRoot, artifact);
      return attachment ? [attachment] : [];
    }));
}

export function textAttachmentsForArtifacts(projectRoot: string, bundle: ProjectBundle, artifactIds: string[]): ProviderTextAttachment[] {
  if (!artifactIds.length) return [];
  const artifactIdSet = new Set(artifactIds);
  return uniqueProviderTextAttachments(bundle.artifacts
    .filter((artifact) => artifactIdSet.has(artifact.id))
    .flatMap((artifact) => {
      const attachment = providerTextAttachmentForArtifact(projectRoot, artifact);
      return attachment ? [attachment] : [];
    }));
}

export function imageAttachmentsForNodeNotes(
  projectRoot: string,
  bundle: ProjectBundle,
  scope: { flowId?: string; nodeIds?: string[]; includeAllFlows?: boolean }
): ProviderImageAttachment[] {
  const nodeIds = scope.nodeIds?.length ? new Set(scope.nodeIds) : null;
  const noteArtifactIds = bundle.notes
    .filter((note) =>
      shouldIncludeNoteInLlmContext(note) &&
      (scope.includeAllFlows || !scope.flowId || note.flowId === scope.flowId) &&
      (!nodeIds || nodeIds.has(note.nodeId))
    )
    .flatMap((note) => note.attachmentIds);
  return imageAttachmentsForArtifacts(projectRoot, bundle, noteArtifactIds);
}

export function textAttachmentsForNodeNotes(
  projectRoot: string,
  bundle: ProjectBundle,
  scope: { flowId?: string; nodeIds?: string[]; includeAllFlows?: boolean }
): ProviderTextAttachment[] {
  const nodeIds = scope.nodeIds?.length ? new Set(scope.nodeIds) : null;
  const noteArtifactIds = bundle.notes
    .filter((note) =>
      shouldIncludeNoteInLlmContext(note) &&
      (scope.includeAllFlows || !scope.flowId || note.flowId === scope.flowId) &&
      (!nodeIds || nodeIds.has(note.nodeId))
    )
    .flatMap((note) => note.attachmentIds);
  return textAttachmentsForArtifacts(projectRoot, bundle, noteArtifactIds);
}

export function runImageAttachments(projectRoot: string, bundle: ProjectBundle, run: Run): ProviderImageAttachment[] {
  const explicitArtifactImages = imageAttachmentsForArtifacts(projectRoot, bundle, [
    ...run.contextArtifacts,
    ...run.planArtifactIds,
    ...run.sourceDiffArtifactIds
  ]);
  return uniqueProviderImageAttachments(explicitArtifactImages).slice(0, 6);
}

export function compactAttachmentArtifact(artifact: Artifact): Pick<Artifact, "id" | "type" | "title" | "path" | "nodeId" | "noteId" | "runId" | "mediaType" | "summary" | "sizeBytes" | "createdAt"> {
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    path: artifact.path,
    nodeId: artifact.nodeId,
    noteId: artifact.noteId,
    runId: artifact.runId,
    mediaType: artifact.mediaType,
    summary: artifact.summary,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt
  };
}

export function noteAttachmentMetadata(bundle: ProjectBundle, note: Note): Array<ReturnType<typeof compactAttachmentArtifact> & { source: "node-note-attachment" }> {
  if (!note.attachmentIds.length) return [];
  const artifactsById = new Map(bundle.artifacts.map((artifact) => [artifact.id, artifact]));
  return note.attachmentIds.flatMap((attachmentId) => {
    const artifact = artifactsById.get(attachmentId);
    return artifact ? [{ ...compactAttachmentArtifact(artifact), source: "node-note-attachment" as const }] : [];
  });
}
