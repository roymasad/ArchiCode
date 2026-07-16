import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type ProjectConventionRecord = {
  path: string;
  exists: boolean;
  summary: string;
  excerpt?: string;
};

export type ProjectConventions = {
  files: ProjectConventionRecord[];
  missingRecommended: string[];
  guidance: string[];
};

export function compactProjectConventions(
  conventions: ProjectConventions,
  maxExcerptChars = 1600
): ProjectConventions {
  return {
    files: conventions.files.map((file) => ({
      path: file.path,
      exists: file.exists,
      summary: file.summary,
      excerpt: file.excerpt
        ? file.excerpt.length <= maxExcerptChars
          ? file.excerpt
          : `${file.excerpt.slice(0, maxExcerptChars)}\n... compacted convention excerpt ...`
        : undefined
    })),
    missingRecommended: conventions.missingRecommended,
    guidance: conventions.guidance
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  if (!(await exists(filePath))) return null;
  return readFile(filePath, "utf8");
}

export async function readProjectConventions(projectRoot: string): Promise<ProjectConventions> {
  const files: ProjectConventionRecord[] = [];

  const agentInstructionFileNames = [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".github/copilot-instructions.md",
    "agents.md",
    "claude.md",
    "gemini.md"
  ];

  for (const fileName of [".gitignore", ...agentInstructionFileNames, "README.md"]) {
    const text = await readTextIfExists(path.join(projectRoot, fileName));
    files.push({
      path: fileName,
      exists: text !== null,
      summary: text ? summarizeConventionText(fileName, text) : `${fileName} is not present.`,
      excerpt: text ? truncateText(text, 5000) : undefined
    });
  }

  const packageJsonText = await readTextIfExists(path.join(projectRoot, "package.json"));
  if (packageJsonText) {
    files.push({
      path: "package.json",
      exists: true,
      summary: summarizePackageJson(packageJsonText),
      excerpt: truncateText(packageJsonText, 3000)
    });
  }

  const hasGitignore = files.some((file) => file.path === ".gitignore" && file.exists);
  const hasAgentInstructions = files.some((file) => agentInstructionFileNames.includes(file.path) && file.exists);
  const hasReadme = files.some((file) => file.path.toLowerCase() === "readme.md" && file.exists);
  return {
    files,
    missingRecommended: [
      ...(!hasGitignore ? [".gitignore"] : []),
      ...(!hasAgentInstructions ? ["AGENTS.md"] : []),
      ...(!hasReadme ? ["README.md"] : [])
    ],
    guidance: [
      "Respect existing project convention files before proposing code or graph changes.",
      "Use .gitignore to avoid generated, dependency, build, log, environment, and ArchiCode local runtime artifacts entering source control.",
      "Keep .archicode/project.json, .archicode/flows/, .archicode/notes.jsonl, and .archicode/graph-changes.jsonl shareable; ignore .archicode/local.json, runs, artifacts, summaries, manifests, memory, reviews, runtime, tmp, and repair backups.",
      "Use AGENTS.md for shared durable local agent instructions; honor tool-specific files such as CLAUDE.md, GEMINI.md, and .github/copilot-instructions.md when present.",
      "Use README.md for setup, run, verification, and handoff instructions so generated projects are usable outside ArchiCode.",
      "For implementation work, add or update unit, integration, renderer, or visual tests that match the affected layer and existing project test patterns.",
      "Map node acceptance criteria to test coverage when practical; if tests cannot be added or run, record why and mark the node as needing attention.",
      "If .gitignore, AGENTS.md, or README.md is missing and would improve the project, propose it with propose-project-file instead of silently writing it."
    ]
  };
}

function summarizeConventionText(fileName: string, text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (fileName.toLowerCase().endsWith("gitignore")) {
    return `${lines.length} ignore entries/notes.`;
  }
  const headings = lines.filter((line) => line.startsWith("#")).slice(0, 5);
  return headings.length ? `Headings: ${headings.join(" | ")}` : `${lines.length} non-empty lines.`;
}

function summarizePackageJson(text: string): string {
  try {
    const packageJson = JSON.parse(text) as { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    const scripts = Object.keys(packageJson.scripts ?? {});
    const dependencyCount = Object.keys(packageJson.dependencies ?? {}).length;
    const devDependencyCount = Object.keys(packageJson.devDependencies ?? {}).length;
    return `Scripts: ${scripts.join(", ") || "none"}. Dependencies: ${dependencyCount}; devDependencies: ${devDependencyCount}.`;
  } catch {
    return "package.json exists but could not be parsed.";
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n... truncated ${text.length - maxLength} characters ...`;
}
