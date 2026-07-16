import path from "node:path";

const PROJECT_TOOL_PATH_KEYS = new Set(["directory", "path", "cwd"]);
const PROJECT_SCOPED_NON_PROJECT_TOOLS = new Set(["archicode_console_run_command"]);

function isProjectScopedTool(providerToolName: string): boolean {
  return providerToolName.startsWith("archicode_project_") || PROJECT_SCOPED_NON_PROJECT_TOOLS.has(providerToolName);
}

function asObject(argumentsJson: string): Record<string, unknown> | null {
  if (!argumentsJson.trim()) return {};
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function normalizeProjectRelativePath(projectRoot: string, value: string): string | null {
  const raw = value.trim();
  if (!raw || !path.isAbsolute(raw)) return null;
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(raw);
  const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return relativePath === "" ? "." : relativePath;
}

export function normalizeProjectToolArguments(
  projectRoot: string,
  providerToolName: string,
  argumentsJson: string
): { argumentsJson: string; changed: boolean } {
  if (!isProjectScopedTool(providerToolName)) {
    return { argumentsJson, changed: false };
  }
  const args = asObject(argumentsJson);
  if (!args) return { argumentsJson, changed: false };
  let changed = false;
  const normalizedArgs: Record<string, unknown> = { ...args };
  for (const key of PROJECT_TOOL_PATH_KEYS) {
    const value = normalizedArgs[key];
    if (typeof value !== "string") continue;
    const normalized = normalizeProjectRelativePath(projectRoot, value);
    if (!normalized) continue;
    normalizedArgs[key] = normalized;
    changed = true;
  }
  return changed
    ? { argumentsJson: JSON.stringify(normalizedArgs), changed: true }
    : { argumentsJson, changed: false };
}

export function isRepairableProjectToolError(providerToolName: string, error: unknown): boolean {
  if (!isProjectScopedTool(providerToolName)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return [
    /Use a project-relative path, not an absolute path\./i,
    /Use project-relative paths, not absolute paths\./i,
    /Path escapes the project root\./i,
    /Path is inside an ignored directory/i,
    /is not a readable file\./i,
    /cwd must be a project-relative directory\./i,
    /Console tool cwd must be project-relative\./i,
    /A known artifactId or artifact path is required\./i,
    /Command must be an allowlisted executable name, not a path\./i,
    /args must be an array of strings\./i,
    /Too many arguments\./i,
    /command is required\./i
  ].some((pattern) => pattern.test(message));
}

function projectToolRepairHints(providerToolName: string): string[] {
  if (providerToolName === "archicode_console_run_command") {
    return [
      "Use '.' for the project root or a project-relative cwd such as 'src'.",
      "Retry the same finite command; do not end the implementation run for this argument error."
    ];
  }
  if (providerToolName.endsWith("_list_files") || providerToolName.endsWith("_search_files")) {
    return [
      "Use '.' for the project root or a relative directory like 'src'.",
      "Do not use absolute filesystem paths."
    ];
  }
  if (providerToolName.endsWith("_read_file")) {
    return [
      "Use a file path relative to the project root, for example 'src/main.ts'.",
      "Do not use absolute filesystem paths."
    ];
  }
  if (providerToolName.endsWith("_read_artifact")) {
    return [
      "Prefer an artifactId from run/project context, or a relative artifact path like '.archicode/artifacts/...'.",
      "Do not use absolute filesystem paths."
    ];
  }
  if (providerToolName.endsWith("_inspect_cli")) {
    return [
      "Use a project-relative cwd like '.' or 'src'.",
      "Keep command args structured and project-relative."
    ];
  }
  return [
    "Retry the same tool with corrected project-relative arguments.",
    "Use '.' for the project root when you mean the whole project."
  ];
}

export function repairableProjectToolResult(providerToolName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "REPAIRABLE_TOOL_ERROR",
    `tool: ${providerToolName}`,
    `error: ${message}`,
    "fix: Retry this same tool with corrected arguments instead of ending the run.",
    "hints:",
    ...projectToolRepairHints(providerToolName).map((hint) => `- ${hint}`)
  ].join("\n");
}
