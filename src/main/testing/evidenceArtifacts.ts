import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifactSchema } from "../../shared/schema";

export type DelphiObservationArtifact = { id: string; label: string; path: string; mediaType: "image/png" };

export async function persistDelphiScreenshot(projectRoot: string, label: string, data: Uint8Array): Promise<DelphiObservationArtifact> {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.byteLength < pngSignature.length || pngSignature.some((byte, index) => data[index] !== byte)) {
    throw new Error("Delphi received invalid PNG screenshot data; no evidence artifact was created.");
  }
  const artifactId = `artifact-${randomUUID()}`;
  const artifactDir = path.join(projectRoot, ".archicode", "artifacts", "delphi");
  await mkdir(artifactDir, { recursive: true });
  const fileName = `${artifactId}.png`;
  const absolutePath = path.join(artifactDir, fileName);
  await writeFile(absolutePath, data);
  const relativePath = path.relative(projectRoot, absolutePath).split(path.sep).join("/");
  const artifact = artifactSchema.parse({
    id: artifactId,
    type: "screenshot",
    title: `Delphi evidence — ${label}`,
    path: relativePath,
    mediaType: "image/png",
    summary: `Screenshot captured by Delphi during a direct runtime audit: ${label}`,
    sizeBytes: data.byteLength,
    createdAt: new Date().toISOString()
  });
  await writeFile(path.join(projectRoot, ".archicode", "artifacts", `${artifactId}.json`), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return { id: artifact.id, label, path: artifact.path, mediaType: "image/png" };
}
