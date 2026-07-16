import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { touchProject } from "./projectStore";
import { exists, readTextIfExists } from "./persistence";

export const AGENT_INSTRUCTION_FILE_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  "agents.md",
  "claude.md",
  "gemini.md"
] as const;
export type AgentInstructionFilePath = (typeof AGENT_INSTRUCTION_FILE_CANDIDATES)[number];
export type AgentInstructionFile = {
  path: AgentInstructionFilePath;
  text: string;
  exists: boolean;
};
export type AgentInstructionFileSummary = Omit<AgentInstructionFile, "text"> & {
  preferred: boolean;
};

export function assertAgentInstructionPath(filePath: string): AgentInstructionFilePath {
  const normalizedPath = filePath.replaceAll("\\", "/");
  if (!AGENT_INSTRUCTION_FILE_CANDIDATES.includes(normalizedPath as AgentInstructionFilePath)) {
    throw new Error(`Agent instruction files are limited to ${AGENT_INSTRUCTION_FILE_CANDIDATES.join(", ")}.`);
  }
  return normalizedPath as AgentInstructionFilePath;
}

export async function listAgentInstructionFiles(projectRoot: string): Promise<AgentInstructionFileSummary[]> {
  const files = await Promise.all(AGENT_INSTRUCTION_FILE_CANDIDATES.map(async (candidate) => ({
    path: candidate,
    exists: await exists(path.join(projectRoot, candidate))
  })));
  const preferredPath = files.find((file) => file.exists)?.path ?? "AGENTS.md";
  return files.map((file) => ({ ...file, preferred: file.path === preferredPath }));
}

export async function readAgentInstructionFile(projectRoot: string, filePath?: string): Promise<AgentInstructionFile> {
  const summaries = await listAgentInstructionFiles(projectRoot);
  const selectedPath = filePath
    ? assertAgentInstructionPath(filePath)
    : summaries.find((file) => file.preferred)?.path ?? "AGENTS.md";
  const fullPath = path.join(projectRoot, selectedPath);
  if (await exists(fullPath)) {
    return { path: selectedPath, text: await readFile(fullPath, "utf8"), exists: true };
  }
  return { path: selectedPath, text: "", exists: false };
}

export async function writeAgentInstructionFile(projectRoot: string, filePath: string, text: string): Promise<AgentInstructionFile> {
  const selectedPath = assertAgentInstructionPath(filePath);
  const normalizedText = text.endsWith("\n") || text.length === 0 ? text : `${text}\n`;
  const fullPath = path.join(projectRoot, selectedPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, normalizedText, "utf8");
  await touchProject(projectRoot);
  return { path: selectedPath, text: normalizedText, exists: true };
}

export async function readAgentMemory(projectRoot: string): Promise<AgentInstructionFile> {
  return readAgentInstructionFile(projectRoot);
}

export async function writeAgentMemory(projectRoot: string, text: string): Promise<AgentInstructionFile> {
  const current = await readAgentInstructionFile(projectRoot);
  return writeAgentInstructionFile(projectRoot, current.path, text);
}
