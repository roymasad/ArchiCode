import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectSettings } from "../shared/schema";
import { classifyCommandRisk, commandAllowedBySettings, type ShellCommandRisk } from "../shared/execution";
import { evaluateFilesystemScope } from "./storage/contextBuilder";

export type AgentCommandCapability =
  | "inspect-project"
  | "verify-project"
  | "control-runtime"
  | "modify-source";

export type AgentCommandActor = "parent-chat" | "delphi" | "sherlock" | "solomon" | "build-agent" | "other-subagent";

export type AgentCommandAuthorization = {
  actor: AgentCommandActor;
  /** One exact action approved by the user through the normal approval UI. */
  exactCommandApproved?: boolean;
  /** Goal-level capabilities already approved for this trajectory. */
  capabilities?: AgentCommandCapability[];
};

export type AgentCommandSafetyDecision = {
  decision: "execute" | "approval-required" | "redirect" | "denied";
  risk: ShellCommandRisk;
  reason: string;
  capability?: AgentCommandCapability;
};

const DEPENDENCY_MUTATION = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade|dlx)\b|(?:^|\s)(?:pip|pip3|uv|poetry)\s+(?:install|add)\b|(?:^|\s)(?:gem|bundle)\s+install\b|(?:^|\s)(?:brew|apt|apt-get|dnf|yum|choco|winget)\s+install\b|\bplaywright\s+install\b|\bappium\s+driver\s+install\b/i;
const RUNTIME_OR_WATCH = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|storybook)\b|\b(?:vite|next|nuxt|astro|remix|svelte-kit|webpack-dev-server)\s*(?:$|\s+(?:dev|start|serve|preview)\b)|\b(?:expo|react-native)\s+start\b|\b(?:flutter|cargo|go|dotnet)\s+run\b|\b(?:nodemon|ts-node-dev)\b|\btsx\s+watch\b|(?:^|\s)--watch(?:\s|=|$)/i;
const EXTERNAL_SIDE_EFFECT = /\b(?:deploy|publish|release|upload|push)\b/i;
const VERIFICATION_SEMANTICS = /\b(?:test|build|compile|bundle|check|typecheck|lint|analy[sz]e|verify|package|coverage|audit)\b/i;
const OBVIOUS_FILE_MUTATION = /(?:^|\s)(?:rm|mv|cp|touch|mkdir|rmdir|truncate|tee|patch)\b|(?:^|\s)(?:sed|perl)\s+[^\n]*(?:-i|--in-place)\b|(?:^|\s)(?:git)\s+(?:checkout|restore|reset|clean|apply)\b|(?:^|\s)(?:prettier|eslint)\b[^\n]*\b--write\b|(?:^|\s)(?:dart\s+format|go\s+fmt|rustfmt)\b|(?:^|[^<])>{1,2}(?!>)/i;
const LIKELY_SOURCE_TARGET = /(?:^|[\s"'=])(?:\.\/)?(?:(?:src|app|lib|android|ios)\/|packages\/[^\s/]+\/(?:src|app|lib)\/)|(?:^|[\s"'=])[^\s"']+\.(?:[cm]?[jt]sx?|vue|svelte|astro|py|rb|php|java|kt|kts|swift|m|mm|c|cc|cpp|cxx|h|hh|hpp|cs|go|rs|dart)(?:[\s"']|$)/i;

function hasCapability(auth: AgentCommandAuthorization, capability: AgentCommandCapability): boolean {
  return auth.capabilities?.includes(capability) ?? false;
}

function packageScriptInvocation(command: string): { manager: "npm" | "pnpm" | "yarn" | "bun"; script: string } | undefined {
  const match = command.trim().match(/^(npm|pnpm|yarn|bun)\s+(?:run\s+)?([a-z0-9:_-]+)(?:\s|$)/i);
  if (!match) return undefined;
  return { manager: match[1]!.toLowerCase() as "npm" | "pnpm" | "yarn" | "bun", script: match[2]! };
}

async function packageScriptDefinition(projectRoot: string, cwd: string, command: string): Promise<string | undefined> {
  const invocation = packageScriptInvocation(command);
  if (!invocation) return undefined;
  const roots = Array.from(new Set([cwd, projectRoot].map((entry) => path.resolve(entry))));
  for (const root of roots) {
    try {
      const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
      const definition = parsed.scripts?.[invocation.script];
      if (typeof definition === "string") return definition;
    } catch {
      // The command may target a non-JavaScript project or a nested package.
    }
  }
  return undefined;
}

function sourceMutationShouldRedirect(actor: AgentCommandActor, command: string): boolean {
  return actor === "parent-chat" && OBVIOUS_FILE_MUTATION.test(command) && LIKELY_SOURCE_TARGET.test(command);
}

async function verificationCapabilityCovers(projectRoot: string, cwd: string, command: string, risk: ShellCommandRisk): Promise<boolean> {
  if (risk === "high" || DEPENDENCY_MUTATION.test(command) || RUNTIME_OR_WATCH.test(command) || EXTERNAL_SIDE_EFFECT.test(command)) return false;
  const scriptDefinition = await packageScriptDefinition(projectRoot, cwd, command);
  if (scriptDefinition !== undefined) {
    return classifyCommandRisk(scriptDefinition) !== "high"
      && !DEPENDENCY_MUTATION.test(scriptDefinition)
      && !RUNTIME_OR_WATCH.test(scriptDefinition)
      && !EXTERNAL_SIDE_EFFECT.test(scriptDefinition)
      && !OBVIOUS_FILE_MUTATION.test(scriptDefinition);
  }
  return VERIFICATION_SEMANTICS.test(command) && !OBVIOUS_FILE_MUTATION.test(command);
}

/**
 * One policy boundary for agent-initiated commands. It evaluates the action the
 * agent actually chose; it does not preselect binaries, scripts, or tool order.
 */
export async function assessAgentCommandSafety(input: {
  projectRoot: string;
  settings: ProjectSettings;
  command: string;
  cwd: string;
  authorization: AgentCommandAuthorization;
}): Promise<AgentCommandSafetyDecision> {
  const risk = classifyCommandRisk(input.command);
  const scope = await evaluateFilesystemScope(input.projectRoot, input.settings, input.command, input.cwd, risk);
  if (!scope.allowed) {
    return {
      decision: "denied",
      risk,
      reason: `The action is outside the configured filesystem boundary: ${scope.violations.join(" ")}`
    };
  }

  if (sourceMutationShouldRedirect(input.authorization.actor, input.command)
    && !hasCapability(input.authorization, "modify-source")) {
    return {
      decision: "redirect",
      risk,
      reason: "Parent Chat does not edit project code files directly. Continue source implementation through the graph/build path; choose any other project-scoped action that advances the goal through this safety broker."
    };
  }

  if (input.authorization.exactCommandApproved || commandAllowedBySettings(input.settings, input.command, input.cwd)) {
    return { decision: "execute", risk, reason: "The user approved this exact action." };
  }

  if (hasCapability(input.authorization, "verify-project")
    && await verificationCapabilityCovers(input.projectRoot, input.cwd, input.command, risk)) {
    return {
      decision: "execute",
      risk,
      capability: "verify-project",
      reason: "The action is a finite project-local verification covered by the approved audit capability."
    };
  }

  if (hasCapability(input.authorization, "control-runtime") && RUNTIME_OR_WATCH.test(input.command) && risk !== "high") {
    return {
      decision: "execute",
      risk,
      capability: "control-runtime",
      reason: "The action is covered by the approved runtime-control capability."
    };
  }

  if (risk === "low") return { decision: "execute", risk, reason: "The action is low-risk and inside the configured project scope." };

  // Auto-approval follows the risk classification of the requested action,
  // never a list of executable names. The visible Research toggle also covers
  // Parent Chat commands; high-risk actions still require explicit approval.
  const autoApproveMediumRisk = input.authorization.actor === "parent-chat"
    ? input.settings.researchAutoApproveGraphChanges.enabled
    : input.settings.autoApproveShellCommands;
  if (autoApproveMediumRisk && risk === "medium") {
    return { decision: "execute", risk, reason: "The user enabled automatic approval for medium-risk project actions." };
  }

  return {
    decision: "approval-required",
    risk,
    reason: "This action is risky or not confidently covered by the current capability. Ask for approval, then resume the same agent trajectory with the result."
  };
}
