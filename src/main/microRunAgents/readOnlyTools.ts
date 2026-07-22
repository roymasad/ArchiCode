import type { MicroRunContext, MicroRunTool } from "../microRuns";
import { archicodeInternalTools, callArchicodeInternalTool } from "../internalTools";

const readOnlyToolNames = new Set([
  "archicode_project_list_files",
  "archicode_project_search_files",
  "archicode_project_read_file",
  "archicode_web_search",
  "archicode_web_open_url"
]);

export function investigationToolProgressMessage(providerToolName: string, args: Record<string, unknown>): string {
  const text = (key: string): string => typeof args[key] === "string" ? args[key].trim() : "";
  if (providerToolName === "archicode_project_read_file") {
    const path = text("path") || "an unspecified file";
    const start = typeof args.startLine === "number" ? args.startLine : undefined;
    const end = typeof args.endLine === "number" ? args.endLine : undefined;
    const lines = start ? ` (lines ${start}${end ? `–${end}` : "+"})` : "";
    return `Reading ${path}${lines}`;
  }
  if (providerToolName === "archicode_project_list_files") {
    return `Listing ${text("path") || text("directory") || "project root"}${args.recursive === true ? " recursively" : ""}`;
  }
  if (providerToolName === "archicode_project_search_files") {
    return `Searching ${text("path") || text("directory") || "project"} for “${text("query") || "unspecified query"}”`;
  }
  if (providerToolName === "archicode_web_search") {
    return `Searching the web for “${text("query") || "unspecified query"}”`;
  }
  if (providerToolName === "archicode_web_open_url") {
    return `Opening ${text("url") || "an unspecified URL"}`;
  }
  if (providerToolName === "archicode_scratchpad_repl") {
    return "Calculating in the ephemeral scratchpad";
  }
  if (providerToolName === "archicode_project_start_runtime_service") {
    return `Starting Run App profile ${text("profileId") || "unspecified"}`;
  }
  if (providerToolName === "archicode_project_stop_runtime_service") {
    return `Stopping Run App service ${text("serviceId") || "unspecified"}`;
  }
  if (providerToolName === "archicode_project_restart_runtime_service") {
    return `Restarting Run App service ${text("serviceId") || "unspecified"}`;
  }
  return `Using ${providerToolName}`;
}

export function createReadOnlyInvestigationTools(
  context: MicroRunContext,
  options: { includeWeb: boolean }
): MicroRunTool[] {
  const settings = context.bundle.project.settings;
  if (!settings) return [];
  return archicodeInternalTools(settings)
    .filter((tool) => readOnlyToolNames.has(tool.providerToolName))
    .filter((tool) => options.includeWeb || !tool.providerToolName.startsWith("archicode_web_"))
    .map((tool) => ({
      ...tool,
      handler: async (args: Record<string, unknown>) => {
        context.onProgress?.(investigationToolProgressMessage(tool.providerToolName, args ?? {}));
        const output = await callArchicodeInternalTool({
          projectRoot: context.projectRoot,
          settings: context.bundle.project.settings,
          loadProject: async () => context.bundle,
          readArtifactText: async () => {
            throw new Error("Artifact reads are not available to this subagent.");
          }
        }, {
          providerToolName: tool.providerToolName,
          argumentsJson: JSON.stringify(args ?? {})
        });
        try {
          return JSON.parse(output.resultText) as unknown;
        } catch {
          return output.resultText;
        }
      }
    }));
}

export function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [fenced, text.trim(), text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Keep trying narrower candidates.
    }
  }
  return {};
}
