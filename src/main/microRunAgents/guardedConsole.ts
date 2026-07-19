import type { MicroRunContext, MicroRunTool } from "../microRuns";
import { archicodeInternalTools } from "../internalTools";

type GuardedConsoleOptions = {
  description: string;
  progressLabel: string;
  unavailableWhen?: boolean;
  beforeRun?: (command: string) => void | Promise<void>;
  /** Delphi needs executed evidence; investigative agents may receive an
   * approval/denial result and adapt or report that boundary themselves. */
  requireExecution?: boolean;
};

/**
 * Shared CLI surface for autonomous micro-run agents. The agent chooses the
 * action; the caller-provided runner applies the common scope/risk/approval
 * broker. This intentionally does not encode executable or workflow lists.
 */
export function createGuardedConsoleTool(
  context: MicroRunContext,
  options: GuardedConsoleOptions
): MicroRunTool | undefined {
  const runConsoleCommand = context.runConsoleCommand;
  if (options.unavailableWhen || !context.bundle.project.settings.agentTools.console || !runConsoleCommand) return undefined;
  const definition = archicodeInternalTools(context.bundle.project.settings)
    .find((tool) => tool.providerToolName === "archicode_console_run_command");
  if (!definition) return undefined;

  return {
    ...definition,
    description: options.description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: {
          type: "string",
          minLength: 1,
          description: "A finite project-scoped command chosen to advance the assigned objective."
        },
        cwd: { type: "string", description: "Optional project-relative working directory." },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 600000,
          description: "Optional finite timeout, up to ten minutes."
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command) throw new Error("command is required.");
      await options.beforeRun?.(command);
      context.onProgress?.(`${options.progressLabel}: ${command}`);
      const result = await runConsoleCommand({ ...args, command });
      if (!options.requireExecution) return result;

      const record = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : undefined;
      if (record?.status === "succeeded" || record?.status === "failed") return result;
      throw new Error(typeof record?.message === "string"
        ? record.message
        : "The guarded console did not execute this command.");
    }
  };
}
