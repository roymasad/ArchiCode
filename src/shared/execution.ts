import type { ProjectSettings, ShellPolicy } from "./schema";

export type ShellCommandRisk = "low" | "medium" | "high";

// Credential-bearing environment variables are scrubbed before ArchiCode hands
// its process environment to a spawned build/verify command or a package
// install script. ArchiCode does not inject its own secrets into process.env,
// but the user's shell-launch environment (cloud creds, CI/registry tokens,
// provider keys) is inherited, and a malicious dependency postinstall or an
// LLM-influenced build command should not be able to read it back out.
//
// This is a scrub (denylist), not an allowlist: builds legitimately depend on a
// wide, unpredictable set of env vars, so we remove only what looks like a
// secret and pass everything else through.
const SENSITIVE_ENV_NAME_PATTERNS: RegExp[] = [
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /TOKEN/i,
  /API[_-]?KEY/i,
  /ACCESS[_-]?KEY/i,
  /PRIVATE[_-]?KEY/i,
  /CREDENTIAL/i,
  /_AUTH$/i,
  /^AUTH_/i,
  /SESSION[_-]?KEY/i
];

// Specific known-safe names that would otherwise match the patterns above and
// break tooling if removed.
const SENSITIVE_ENV_NAME_ALLOWLIST = new Set<string>([
  "SSH_AUTH_SOCK" // socket path, not a secret; needed by git over SSH
]);

export function isSensitiveEnvName(name: string): boolean {
  if (SENSITIVE_ENV_NAME_ALLOWLIST.has(name)) return false;
  return SENSITIVE_ENV_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export function buildSubprocessEnv(
  baseEnv: NodeJS.ProcessEnv,
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (isSensitiveEnvName(name)) continue;
    scrubbed[name] = value;
  }
  return { ...scrubbed, ...extra };
}

// Emits the env scrub as standalone JS for the generated stdio MCP server, so
// the embedded console tool shares one source of truth with the in-process
// spawn sites.
export function embeddedSubprocessEnvSource(): string {
  return [
    `const SENSITIVE_ENV_NAME_PATTERNS = ${JSON.stringify(SENSITIVE_ENV_NAME_PATTERNS.map((pattern) => pattern.source))}.map((source) => new RegExp(source, "i"));`,
    `const SENSITIVE_ENV_NAME_ALLOWLIST = new Set(${JSON.stringify([...SENSITIVE_ENV_NAME_ALLOWLIST])});`,
    isSensitiveEnvName.toString(),
    buildSubprocessEnv.toString()
  ].join("\n\n");
}

const VERSION_OR_HELP_FLAGS = ["-h", "--help", "-v", "-V", "--version", "help", "version"];
const LOW_RISK_BASE_COMMANDS = [
  "cat",
  "date",
  "dir",
  "du",
  "echo",
  "env",
  "false",
  "file",
  "find",
  "git",
  "grep",
  "head",
  "ls",
  "printenv",
  "printf",
  "pwd",
  "rg",
  "sed",
  "sort",
  "stat",
  "tail",
  "test",
  "tree",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami"
];
const HIGH_RISK_BASE_COMMANDS = [
  "chmod",
  "chown",
  "dd",
  "diskutil",
  "doas",
  "format",
  "halt",
  "killall",
  "mkfs",
  "mount",
  "poweroff",
  "reboot",
  "rm",
  "shutdown",
  "sudo",
  "umount"
];
const NETWORK_FETCH_COMMANDS = [
  "curl",
  "fetch",
  "gh",
  "http",
  "https",
  "scp",
  "sftp",
  "wget"
];
const PACKAGE_MANAGER_COMMANDS = [
  "bun",
  "bunx",
  "cargo",
  "composer",
  "dart",
  "flutter",
  "gem",
  "go",
  "gradle",
  "mvn",
  "npm",
  "npx",
  "pip",
  "pip3",
  "pnpm",
  "poetry",
  "yarn"
];
const HIGH_RISK_INLINE_SCRIPT_COMMANDS = [
  "bash",
  "fish",
  "node",
  "osascript",
  "perl",
  "python",
  "python3",
  "ruby",
  "sh",
  "zsh"
];
const LOW_RISK_GIT_SUBCOMMANDS = [
  "",
  "branch",
  "diff",
  "log",
  "remote",
  "rev-parse",
  "show",
  "status"
];
const HIGH_RISK_GIT_SUBCOMMANDS = ["clean", "push", "reset"];
const HIGH_RISK_GIT_FLAGS = ["--force", "--force-with-lease", "--hard"];
const HIGH_RISK_DOCKER_SUBCOMMANDS = ["compose", "container", "image", "network", "rm", "rmi", "system", "volume"];
const HIGH_RISK_KUBECTL_SUBCOMMANDS = ["delete", "drain", "scale"];
const HIGH_RISK_PUBLISH_SUBCOMMANDS = ["deploy", "publish"];

type ParsedShellCommand = {
  tokens: string[];
  sawControlSyntax: boolean;
  unterminatedQuote: boolean;
};

function parseShellCommand(command: string): ParsedShellCommand {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  let sawControlSyntax = false;

  const pushCurrent = (): void => {
    if (!current) return;
    tokens.push(current);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") {
        quote = null;
        continue;
      }
      // Command substitution still executes inside double quotes. Treat it as
      // shell control syntax rather than misclassifying the quoted text as a
      // harmless argument.
      if ((char === "$" && next === "(") || char === "`") {
        sawControlSyntax = true;
        break;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === "\"") {
      quote = "\"";
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }
    if (char === "$" && next === "(") {
      sawControlSyntax = true;
      break;
    }
    if (char === "`" || char === ";" || char === "<" || char === ">" || char === "|" || char === "&" || char === "\n" || char === "\r") {
      sawControlSyntax = true;
      break;
    }
    current += char;
  }

  if (!sawControlSyntax && !quote && !escaping) pushCurrent();

  return {
    tokens,
    sawControlSyntax,
    unterminatedQuote: Boolean(quote || escaping)
  };
}

type SimpleOutputRedirection = {
  sourceCommand: string;
  target: string;
};

/**
 * Recognizes only one trailing output redirection to one literal path. This is
 * deliberately narrow: substitutions, fd duplication, multiple redirects,
 * dynamic targets, and additional shell control syntax fall back to High.
 */
function parseSimpleOutputRedirection(command: string): SimpleOutputRedirection | null {
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  let redirectStart = -1;
  let redirectEnd = -1;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    const next = command[index + 1];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "\"") {
      if (char === "\"") quote = null;
      else if (char === "\\") escaping = true;
      else if ((char === "$" && next === "(") || char === "`") return null;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if ((char === "$" && next === "(") || char === "`") return null;
    if (char !== ">") continue;
    if (redirectStart >= 0 || next === "&" || next === "|") return null;
    redirectStart = index;
    if (index > 0 && /\d/.test(command[index - 1] as string) && (index === 1 || /\s/.test(command[index - 2] as string))) {
      redirectStart = index - 1;
    }
    redirectEnd = index + (next === ">" ? 2 : 1);
    if (next === ">") index += 1;
  }

  if (quote || escaping || redirectStart < 0 || redirectEnd < 0) return null;
  const sourceCommand = command.slice(0, redirectStart).trim();
  const targetText = command.slice(redirectEnd).trim();
  if (!sourceCommand || !targetText || /[$`*?{}()[\]\n\r]/.test(targetText)) return null;
  const source = parseShellCommand(sourceCommand);
  const target = parseShellCommand(targetText);
  if (source.sawControlSyntax || source.unterminatedQuote || source.tokens.length === 0) return null;
  if (target.sawControlSyntax || target.unterminatedQuote || target.tokens.length !== 1) return null;
  return { sourceCommand, target: target.tokens[0] as string };
}

function normalizeCommandToken(token: string): string {
  const parts = token.split(/[\\/]/);
  return (parts[parts.length - 1] || token).toLowerCase();
}

function hasShortFlag(args: string[], flag: string): boolean {
  return args.some((arg) => /^-[^-]/.test(arg) && arg.slice(1).includes(flag));
}

function hasAnyValue(args: string[], values: string[]): boolean {
  return args.some((arg) => values.includes(arg));
}

function isVersionOrHelpCommand(args: string[]): boolean {
  return args.length > 0 && args.every((arg) => VERSION_OR_HELP_FLAGS.includes(arg));
}

function gitSubcommandAndArgs(args: string[]): { subcommand: string; rest: string[] } {
  const gitOptionsWithValue = new Set(["-c", "-C", "--exec-path", "--git-dir", "--namespace", "--work-tree"]);
  let expectValue = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (expectValue) {
      expectValue = false;
      continue;
    }
    if (gitOptionsWithValue.has(arg)) {
      expectValue = true;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") || arg.startsWith("--namespace=") || arg.startsWith("--exec-path=") || arg.startsWith("-c")) {
      continue;
    }
    if (arg.startsWith("-")) continue;
    return { subcommand: arg, rest: args.slice(index + 1) };
  }
  return { subcommand: "", rest: [] };
}

function classifyGitCommand(args: string[]): ShellCommandRisk {
  if (args.length === 0 || isVersionOrHelpCommand(args)) return "low";
  const { subcommand, rest } = gitSubcommandAndArgs(args);

  if (LOW_RISK_GIT_SUBCOMMANDS.includes(subcommand)) {
    if (subcommand === "branch" && rest.length > 0 && !rest.every((arg) => arg === "--show-current")) return "medium";
    if (subcommand === "remote" && rest.length > 0 && !rest.every((arg) => arg === "-v" || arg === "--verbose")) return "medium";
    return "low";
  }

  if (HIGH_RISK_GIT_SUBCOMMANDS.includes(subcommand)) {
    if (subcommand === "push") {
      if (hasAnyValue(rest, HIGH_RISK_GIT_FLAGS) || hasShortFlag(rest, "f")) return "high";
      return "medium";
    }
    if (subcommand === "reset" && (hasAnyValue(rest, ["--hard"]) || hasShortFlag(rest, "h"))) return "high";
    if (subcommand === "clean" && hasShortFlag(rest, "f")) return "high";
    return "medium";
  }

  if (subcommand === "checkout" && rest.includes("--")) return "high";
  if (subcommand === "restore" && hasAnyValue(rest, ["--source"])) return "high";
  if (subcommand === "branch" && hasShortFlag(rest, "D")) return "high";
  if (subcommand === "tag" && hasShortFlag(rest, "d")) return "high";

  return "medium";
}

// Registry/metadata queries that read but never install, execute, or publish.
// Checked against the subcommand position only, so a package named like one of
// these (e.g. `npm install view`) never matches.
const READ_ONLY_PACKAGE_SUBCOMMANDS = [
  "info",
  "list",
  "ls",
  "outdated",
  "ping",
  "prefix",
  "root",
  "search",
  "show",
  "view",
  "why"
];

function classifyPackageManagerCommand(base: string, args: string[]): ShellCommandRisk {
  if (args.length === 0 || isVersionOrHelpCommand(args)) return "low";

  if (base === "npx" || base === "bunx") return "medium";
  if ((base === "pnpm" || base === "yarn") && args[0] === "dlx") return "medium";
  if (READ_ONLY_PACKAGE_SUBCOMMANDS.includes(args[0] ?? "")) return "low";

  if (hasAnyValue(args, HIGH_RISK_PUBLISH_SUBCOMMANDS)) return "high";
  if ((base === "npm" || base === "pnpm") && args[0] === "exec") return "medium";
  if ((base === "cargo" || base === "go") && args[0] === "run") return "medium";

  return "medium";
}

function classifyInterpreterCommand(base: string, args: string[]): ShellCommandRisk {
  if (args.length === 0 || isVersionOrHelpCommand(args)) return "low";
  if (hasAnyValue(args, ["-c", "-e", "--eval", "--command"])) return "high";
  return "medium";
}

function classifyDockerCommand(args: string[]): ShellCommandRisk {
  if (args.length === 0 || isVersionOrHelpCommand(args)) return "low";
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
  if (!subcommand) return "low";
  if (HIGH_RISK_DOCKER_SUBCOMMANDS.includes(subcommand)) {
    if (subcommand === "system" && args.includes("prune")) return "high";
    if (subcommand === "compose" && args.includes("down")) return "high";
    if (["container", "image", "network", "volume"].includes(subcommand) && args.includes("rm")) return "high";
    if (subcommand === "rm" || subcommand === "rmi") return "high";
    return "medium";
  }
  return "medium";
}

function classifyKubectlCommand(args: string[]): ShellCommandRisk {
  if (args.length === 0 || isVersionOrHelpCommand(args)) return "low";
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
  if (HIGH_RISK_KUBECTL_SUBCOMMANDS.includes(subcommand)) return "high";
  return "medium";
}

function isLowRiskBaseCommand(base: string, args: string[]): boolean {
  if (!LOW_RISK_BASE_COMMANDS.includes(base)) return false;
  if (base === "git") return false;
  if (base === "sed" && hasAnyValue(args, ["-i", "--in-place"])) return false;
  return true;
}

type CompoundSegment = { text: string; viaPipe: boolean };

/**
 * Splits a compound command on its top-level separators (&&, ||, |, ;,
 * newlines) so each simple segment can be risk-classified on its own. Returns
 * null — keeping the blanket "high" classification — whenever any other shell
 * machinery is present: substitution (`, $(), redirection (<, >), background
 * jobs (lone &), or an unterminated quote.
 */
function splitCompoundShellSegments(command: string): CompoundSegment[] | null {
  const segments: CompoundSegment[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  let viaPipe = false;
  const pushSegment = (nextViaPipe: boolean): void => {
    if (current.trim()) segments.push({ text: current.trim(), viaPipe });
    current = "";
    viaPipe = nextViaPipe;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    const next = command[index + 1];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      current += char;
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "\"") {
      current += char;
      if (char === "\"") quote = null;
      else if (char === "\\") escaping = true;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      current += char;
      continue;
    }
    if (char === "$" && next === "(") return null;
    if (char === "`" || char === "<" || char === ">") return null;
    if (char === "&") {
      if (next !== "&") return null;
      pushSegment(false);
      index += 1;
      continue;
    }
    if (char === "|") {
      if (next === "|") {
        pushSegment(false);
        index += 1;
      } else {
        pushSegment(true);
      }
      continue;
    }
    if (char === ";" || char === "\n" || char === "\r") {
      pushSegment(false);
      continue;
    }
    current += char;
  }
  if (quote || escaping) return null;
  pushSegment(false);
  return segments;
}

const RISK_SEVERITY: Record<ShellCommandRisk, number> = { low: 0, medium: 1, high: 2 };

/**
 * A compound command is as risky as its riskiest segment. Piping into an
 * interpreter stays high regardless (`curl … | sh` executes the piped stream
 * even though each segment looks tame on its own).
 */
function classifyCompoundCommandRisk(command: string): ShellCommandRisk {
  const segments = splitCompoundShellSegments(command);
  if (!segments || segments.length === 0) return "high";
  if (segments.length === 1 && segments[0]?.text === command) return "high";
  let worst: ShellCommandRisk = "low";
  for (const segment of segments) {
    const segmentBase = normalizeCommandToken(parseShellCommand(segment.text).tokens[0] ?? "");
    if (segment.viaPipe && HIGH_RISK_INLINE_SCRIPT_COMMANDS.includes(segmentBase)) return "high";
    const risk = classifyCommandRisk(segment.text);
    if (RISK_SEVERITY[risk] > RISK_SEVERITY[worst]) worst = risk;
  }
  return worst;
}

export function classifyCommandRisk(command: string): ShellCommandRisk {
  const normalized = command.trim();
  if (!normalized) return "low";

  const outputRedirection = parseSimpleOutputRedirection(normalized);
  if (outputRedirection) {
    const sourceRisk = classifyCommandRisk(outputRedirection.sourceCommand);
    return sourceRisk === "high" ? "high" : "medium";
  }

  const parsed = parseShellCommand(normalized);
  if (parsed.unterminatedQuote) return "high";
  if (parsed.sawControlSyntax) return classifyCompoundCommandRisk(normalized);
  if (parsed.tokens.length === 0) return "low";

  const [rawBase, ...rawArgs] = parsed.tokens;
  const base = normalizeCommandToken(rawBase);
  const args = rawArgs.map((arg) => arg.toLowerCase());

  if (isVersionOrHelpCommand(args)) return "low";
  if (HIGH_RISK_BASE_COMMANDS.includes(base)) return "high";
  if (HIGH_RISK_INLINE_SCRIPT_COMMANDS.includes(base)) return classifyInterpreterCommand(base, args);
  if (base === "git") return classifyGitCommand(args);
  if (base === "docker") return classifyDockerCommand(args);
  if (base === "kubectl") return classifyKubectlCommand(args);
  if (NETWORK_FETCH_COMMANDS.includes(base)) return "medium";
  if (PACKAGE_MANAGER_COMMANDS.includes(base)) return classifyPackageManagerCommand(base, args);
  if (isLowRiskBaseCommand(base, args)) return "low";
  return "medium";
}

// A command's base binary is "known" when the risk classifier recognizes it
// from one of its curated lists. An unrecognized binary is exactly the case the
// classifier can say nothing about, so it should not run unattended even under
// auto-approve. This deliberately does not change the command's risk label —
// only whether auto-approval applies — so filesystem-scope and UI behavior for
// medium-risk commands is untouched.
const KNOWN_BASE_COMMANDS = new Set<string>([
  ...LOW_RISK_BASE_COMMANDS,
  ...HIGH_RISK_BASE_COMMANDS,
  ...NETWORK_FETCH_COMMANDS,
  ...PACKAGE_MANAGER_COMMANDS,
  ...HIGH_RISK_INLINE_SCRIPT_COMMANDS,
  "git",
  "docker",
  "kubectl"
]);

export function isKnownBinary(command: string): boolean {
  const normalized = command.trim();
  const outputRedirection = parseSimpleOutputRedirection(normalized);
  if (outputRedirection) return isKnownBinary(outputRedirection.sourceCommand);
  const parsed = parseShellCommand(normalized);
  if (parsed.unterminatedQuote) return false;
  if (parsed.sawControlSyntax) {
    // A compound command is "known" only when every segment's binary is known.
    const segments = splitCompoundShellSegments(normalized);
    if (!segments || segments.length === 0) return false;
    if (segments.length === 1 && segments[0]?.text === normalized) return false;
    return segments.every((segment) => isKnownBinary(segment.text));
  }
  if (parsed.tokens.length === 0) return false;
  return KNOWN_BASE_COMMANDS.has(normalizeCommandToken(parsed.tokens[0]));
}

export function embeddedClassifyCommandRiskSource(functionName = "classify"): string {
  const constants = [
    ["VERSION_OR_HELP_FLAGS", VERSION_OR_HELP_FLAGS],
    ["LOW_RISK_BASE_COMMANDS", LOW_RISK_BASE_COMMANDS],
    ["HIGH_RISK_BASE_COMMANDS", HIGH_RISK_BASE_COMMANDS],
    ["NETWORK_FETCH_COMMANDS", NETWORK_FETCH_COMMANDS],
    ["PACKAGE_MANAGER_COMMANDS", PACKAGE_MANAGER_COMMANDS],
    ["HIGH_RISK_INLINE_SCRIPT_COMMANDS", HIGH_RISK_INLINE_SCRIPT_COMMANDS],
    ["LOW_RISK_GIT_SUBCOMMANDS", LOW_RISK_GIT_SUBCOMMANDS],
    ["HIGH_RISK_GIT_SUBCOMMANDS", HIGH_RISK_GIT_SUBCOMMANDS],
    ["HIGH_RISK_GIT_FLAGS", HIGH_RISK_GIT_FLAGS],
    ["HIGH_RISK_DOCKER_SUBCOMMANDS", HIGH_RISK_DOCKER_SUBCOMMANDS],
    ["HIGH_RISK_KUBECTL_SUBCOMMANDS", HIGH_RISK_KUBECTL_SUBCOMMANDS],
    ["HIGH_RISK_PUBLISH_SUBCOMMANDS", HIGH_RISK_PUBLISH_SUBCOMMANDS],
    ["READ_ONLY_PACKAGE_SUBCOMMANDS", READ_ONLY_PACKAGE_SUBCOMMANDS],
    ["RISK_SEVERITY", RISK_SEVERITY]
  ].map(([name, values]) => `const ${name} = ${JSON.stringify(values)};`);

  return [
    ...constants,
    parseShellCommand.toString(),
    normalizeCommandToken.toString(),
    hasShortFlag.toString(),
    hasAnyValue.toString(),
    isVersionOrHelpCommand.toString(),
    gitSubcommandAndArgs.toString(),
    classifyGitCommand.toString(),
    classifyPackageManagerCommand.toString(),
    classifyInterpreterCommand.toString(),
    classifyDockerCommand.toString(),
    classifyKubectlCommand.toString(),
    isLowRiskBaseCommand.toString(),
    parseSimpleOutputRedirection.toString(),
    splitCompoundShellSegments.toString(),
    classifyCompoundCommandRisk.toString(),
    classifyCommandRisk.toString(),
    functionName === "classifyCommandRisk" ? "" : `const ${functionName} = classifyCommandRisk;`
  ].filter(Boolean).join("\n\n");
}

export function findReusableShellPolicy(settings: ProjectSettings, command: string, cwd?: string): ShellPolicy | null {
  return settings.shellPolicies.find((policy) =>
    policy.reusable &&
    policy.command === command &&
    (!policy.cwd || !cwd || policy.cwd === cwd) &&
    policy.filesystemPolicy === settings.filesystem.policy
  ) ?? null;
}

export function commandAllowedBySettings(settings: ProjectSettings, command: string, cwd?: string): ShellPolicy | null {
  const reusable = findReusableShellPolicy(settings, command, cwd);
  if (reusable) return reusable;
  if (settings.allowedShellCommands.includes(command)) {
    return {
      id: `legacy-${command}`,
      command,
      cwd,
      env: [],
      risk: classifyCommandRisk(command),
      filesystemPolicy: settings.filesystem.policy,
      allowedRoots: settings.filesystem.allowedRoots,
      reusable: true,
      createdAt: new Date().toISOString()
    };
  }
  return null;
}
