import type { Dirent } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { llmPatchProposalSchema, projectSchema, runTargetProfileSchema } from "../../shared/schema";
import type { Artifact, Project, ProjectBundle, ProjectSettings, Run } from "../../shared/schema";
import { extractArchicodePatch } from "../../shared/patchExtraction";
import { flutterRunTargetProfiles } from "../../shared/templates";
import { callProvider } from "../providers";
import { type ProviderCommandResult, isFiniteVerificationCommand, isRuntimeOrWatchCommand, looksLikePatchHandoff, persistAndMaybeApplyPatchProposal } from "./runEngine";
import {
  ensureProjectGitignoreDefaults,
  hydrateProviderForUse,
  loadProject,
  writeProjectFiles
} from "./projectStore";
import type { PersistedPatchProposal } from "./patches";
import { exists, id, iso, projectStatePath, readJson, readTextIfExists, writeJson } from "./persistence";

export async function inferProjectCommands(projectRoot: string, bundle: ProjectBundle | null): Promise<{
  install?: string;
  run?: string;
  verify: string[];
}> {
  const packageJson = await readJson<{ scripts?: Record<string, string> } | null>(path.join(projectRoot, "package.json"), null);
  const scripts = packageJson?.scripts ?? {};
  const hasPackageJson = Boolean(packageJson);
  const hasPnpmLock = await exists(path.join(projectRoot, "pnpm-lock.yaml"));
  const hasYarnLock = await exists(path.join(projectRoot, "yarn.lock"));
  const hasBunLock = await exists(path.join(projectRoot, "bun.lockb"));
  const packageManager = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : hasBunLock ? "bun" : "npm";
  const runCommand = bundle?.project.settings.defaultRunCommand.trim() ||
    (scripts.dev ? `${packageManager} run dev` : scripts.start ? `${packageManager} run start` : undefined);
  const testCommand = finitePackageVerificationCommand(packageManager, "test", scripts.test);
  const buildCommand = finitePackageVerificationCommand(packageManager, "build", scripts.build);
  const configuredBuildCommand = bundle?.project.settings.defaultBuildCommand.trim();
  const verify = [
    testCommand,
    configuredBuildCommand && isFiniteVerificationCommand(configuredBuildCommand) ? configuredBuildCommand : "",
    buildCommand
  ].filter((command, index, commands): command is string => Boolean(command) && commands.indexOf(command) === index);

  return {
    install: hasPackageJson ? (packageManager === "yarn" ? "yarn install" : packageManager === "bun" ? "bun install" : `${packageManager} install`) : undefined,
    run: runCommand,
    verify
  };
}

export function finitePackageVerificationCommand(packageManager: string, scriptName: string, script: string | undefined): string {
  if (!script) return "";
  if (!/^(test|build|check|typecheck|lint|analy[sz]e|verify|package)$/.test(scriptName)) return "";
  if (isRuntimeOrWatchCommand(script) && !(scriptName === "test" && canForceNonInteractiveTest(script))) return "";
  const suffix = scriptName === "test" ? nonInteractiveTestArgs(script) : "";
  return `${packageManager} run ${scriptName}${suffix}`;
}

export function canForceNonInteractiveTest(script: string): boolean {
  return /\b(vitest|react-scripts|jest)\b/.test(script);
}

export function nonInteractiveTestArgs(script: string): string {
  if (vitestNeedsRunFlag(script)) return " -- --run";
  if (/\breact-scripts\s+test\b/.test(script) && !/--watchAll(?:=|\s+)false\b/i.test(script)) return " -- --watchAll=false";
  if (/\bjest\b/.test(script) && /\b--watch(?:All)?\b/i.test(script) && !/--watch(?:All)?(?:=|\s+)false\b/i.test(script)) return " -- --watch=false";
  return "";
}

export function vitestNeedsRunFlag(script: string): boolean {
  return /\bvitest\b/.test(script) &&
    !/(\bvitest\s+run\b|(?:^|\s)--run(?:\s|$)|(?:^|\s)--watch(?:=|\s+)false(?:\s|$))/.test(script);
}

export async function normalizeVerificationCommandForProject(projectRoot: string, command: string): Promise<string> {
  const packageJson = await readJson<{ scripts?: Record<string, string> } | null>(path.join(projectRoot, "package.json"), null);
  if (!packageJson?.scripts?.test) return command;
  const testArgs = nonInteractiveTestArgs(packageJson.scripts.test);
  if (!testArgs) return command;
  const hasPnpmLock = await exists(path.join(projectRoot, "pnpm-lock.yaml"));
  const hasYarnLock = await exists(path.join(projectRoot, "yarn.lock"));
  const hasBunLock = await exists(path.join(projectRoot, "bun.lockb"));
  const packageManager = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : hasBunLock ? "bun" : "npm";
  return command.replace(
    new RegExp(`\\b${packageManager}\\s+run\\s+test(?!\\s+--)(?=\\s*(?:&&|\\|\\||;|$))`, "g"),
    `${packageManager} run test${testArgs}`
  );
}

export async function hasInstalledDependencies(projectRoot: string): Promise<boolean> {
  return (await dependencyInstallState(projectRoot)).ready;
}

export type DependencyInstallState = {
  ready: boolean;
  installCommand?: string;
  missingPackages: string[];
  ecosystem: "node" | "php" | "python" | "ruby" | "dotnet" | "java" | "unknown";
  confidence: "high" | "low";
};

export async function projectRootEntries(projectRoot: string): Promise<Set<string>> {
  return new Set(await readdir(projectRoot).catch(() => []));
}

export function commandAlreadyIncludesSetup(command: string, setupCommand: string): boolean {
  const normalizedCommand = command.trim().toLowerCase();
  const normalizedSetup = setupCommand.trim().toLowerCase();
  return normalizedCommand === normalizedSetup || normalizedCommand.startsWith(`${normalizedSetup} &&`);
}

export async function nodeDependencyState(projectRoot: string): Promise<DependencyInstallState> {
  const packageJson = await readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  } | null>(path.join(projectRoot, "package.json"), null);
  const commands = await inferProjectCommands(projectRoot, null);
  const declaredPackages = [
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(packageJson?.devDependencies ?? {}),
    ...Object.keys(packageJson?.optionalDependencies ?? {})
  ].filter((pkg, index, list) => pkg && list.indexOf(pkg) === index);
  const nodeModulesRoot = path.join(projectRoot, "node_modules");
  if (!(await exists(nodeModulesRoot))) {
    return {
      ready: false,
      installCommand: commands.install,
      missingPackages: declaredPackages,
      ecosystem: "node",
      confidence: "high"
    };
  }

  const checks = await Promise.all(declaredPackages.map(async (pkg) => ({
    pkg,
    installed: await exists(path.join(nodeModulesRoot, ...pkg.split("/"), "package.json"))
  })));
  const missingPackages = checks.filter((item) => !item.installed).map((item) => item.pkg);
  return {
    ready: missingPackages.length === 0,
    installCommand: commands.install,
    missingPackages,
    ecosystem: "node",
    confidence: "high"
  };
}

export async function dependencyInstallState(projectRoot: string): Promise<DependencyInstallState> {
  const entries = await projectRootEntries(projectRoot);
  if (entries.has("package.json")) {
    return nodeDependencyState(projectRoot);
  }
  if (entries.has("composer.json")) {
    return {
      ready: await exists(path.join(projectRoot, "vendor")),
      installCommand: "composer install",
      missingPackages: [],
      ecosystem: "php",
      confidence: "high"
    };
  }
  if (entries.has("poetry.lock")) {
    return {
      ready: true,
      installCommand: "poetry install",
      missingPackages: [],
      ecosystem: "python",
      confidence: "low"
    };
  }
  if (entries.has("Pipfile")) {
    return {
      ready: true,
      installCommand: "pipenv install",
      missingPackages: [],
      ecosystem: "python",
      confidence: "low"
    };
  }
  if (entries.has("uv.lock")) {
    return {
      ready: true,
      installCommand: "uv sync",
      missingPackages: [],
      ecosystem: "python",
      confidence: "low"
    };
  }
  if (entries.has("requirements.txt")) {
    return {
      ready: true,
      installCommand: "python -m pip install -r requirements.txt",
      missingPackages: [],
      ecosystem: "python",
      confidence: "low"
    };
  }
  if (entries.has("Gemfile")) {
    return {
      ready: true,
      installCommand: "bundle install",
      missingPackages: [],
      ecosystem: "ruby",
      confidence: "low"
    };
  }
  if ([...entries].some((entry) => entry.endsWith(".sln") || entry.endsWith(".csproj"))) {
    return {
      ready: true,
      installCommand: "dotnet restore",
      missingPackages: [],
      ecosystem: "dotnet",
      confidence: "low"
    };
  }
  if (entries.has("pom.xml")) {
    return {
      ready: true,
      installCommand: undefined,
      missingPackages: [],
      ecosystem: "java",
      confidence: "low"
    };
  }
  return {
    ready: true,
    installCommand: undefined,
    missingPackages: [],
    ecosystem: "unknown",
    confidence: "low"
  };
}

export async function dependencyInstallPlanForCommand(projectRoot: string, command: string): Promise<DependencyInstallState> {
  const normalized = command.toLowerCase();
  if (/\b(npm|pnpm|yarn|bun)\b/.test(normalized)) {
    return nodeDependencyState(projectRoot);
  }
  const base = await dependencyInstallState(projectRoot);
  if (base.installCommand) return base;
  if (/\bcomposer\b|\bphpunit\b|\bartisan\b/.test(normalized)) {
    return { ready: await exists(path.join(projectRoot, "vendor")), installCommand: "composer install", missingPackages: [], ecosystem: "php", confidence: "high" };
  }
  if (/\bpoetry\b/.test(normalized)) {
    return { ready: true, installCommand: "poetry install", missingPackages: [], ecosystem: "python", confidence: "low" };
  }
  if (/\bpipenv\b/.test(normalized)) {
    return { ready: true, installCommand: "pipenv install", missingPackages: [], ecosystem: "python", confidence: "low" };
  }
  if (/\buv\b/.test(normalized)) {
    return { ready: true, installCommand: "uv sync", missingPackages: [], ecosystem: "python", confidence: "low" };
  }
  if (/\b(pytest|python|tox|nox|ruff|mypy)\b/.test(normalized)) {
    return { ready: true, installCommand: "python -m pip install -r requirements.txt", missingPackages: [], ecosystem: "python", confidence: "low" };
  }
  if (/\bbundle\b|\brspec\b|\brake\b/.test(normalized)) {
    return { ready: true, installCommand: "bundle install", missingPackages: [], ecosystem: "ruby", confidence: "low" };
  }
  if (/\bdotnet\b/.test(normalized)) {
    return { ready: true, installCommand: "dotnet restore", missingPackages: [], ecosystem: "dotnet", confidence: "low" };
  }
  return base;
}

export async function prependInstallCommandIfNeeded(projectRoot: string, command: string): Promise<string> {
  const dependencyState = await dependencyInstallPlanForCommand(projectRoot, command);
  if (!dependencyState.installCommand || dependencyState.ready || dependencyState.confidence !== "high") return command;
  if (commandAlreadyIncludesSetup(command, dependencyState.installCommand)) return command;
  return `${dependencyState.installCommand} && ${command}`;
}

export async function dependencyRecoveryInstruction(projectRoot: string, verificationFailures: ProviderCommandResult[]): Promise<string> {
  const failedCommands = verificationFailures.map((result) => result.command).filter(Boolean);
  const dependencyState = await dependencyInstallPlanForCommand(projectRoot, failedCommands[0] ?? "");
  const inferredCommands = (await inferProjectCommands(projectRoot, null)).verify;
  const rerunText = inferredCommands.length
    ? inferredCommands.map((command) => `\`${command}\``).join(" and ")
    : failedCommands.length
      ? failedCommands.map((command) => `\`${command}\``).join(" and ")
      : "the project's verification commands";
  if (dependencyState.installCommand) {
    return `Run the project's dependency/toolchain sync step first (\`${dependencyState.installCommand}\`), then rerun ${rerunText}.`;
  }
  return `Restore or sync the project's dependencies/toolchain prerequisites, then rerun ${rerunText}.`;
}

export async function inferredVerificationCommand(projectRoot: string, bundle: ProjectBundle): Promise<string> {
  const commands = await inferProjectCommands(projectRoot, bundle);
  const parts = [
    commands.install && !(await hasInstalledDependencies(projectRoot)) ? commands.install : "",
    ...commands.verify
  ].filter(Boolean);
  return [...new Set(parts)].join(" && ");
}

export function humanizeProjectName(packageName: string | undefined, projectRoot: string): string {
  const rawName = packageName?.trim() || path.basename(projectRoot);
  const spaced = rawName.replace(/^@[^/]+\//, "").replace(/[-_]+/g, " ").trim();
  return spaced ? `${spaced[0]?.toUpperCase()}${spaced.slice(1)}` : "Generated app";
}

export function formatCommandList(commands: string[]): string {
  return commands.length ? commands.map((command) => `\`${command}\``).join(", ") : "the configured verification command";
}

export function compactSummary(text: string, maxLength = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function recordedProjectTechnology(bundle: Pick<ProjectBundle, "project" | "flows">): string[] {
  const technologies = [
    ...bundle.project.settings.stackAssumptions,
    ...bundle.flows.flatMap((flow) => flow.nodes.flatMap((node) => node.techStack))
  ];
  return [...new Set(technologies.map((technology) => technology.trim()).filter(Boolean))].slice(0, 24);
}

export function generatedTargetProjectAgentInstructions(
  bundle: Pick<ProjectBundle, "project" | "flows">,
  verifyCommands: string[]
): string {
  const technologies = recordedProjectTechnology(bundle);
  const technologyInstruction = technologies.length
    ? `- Recorded technology choices for this project: ${technologies.join(", ")}. Keep implementation within these choices and the repository's established patterns unless the project requirements explicitly call for a change.`
    : "- No technology stack is recorded yet. Use evidence from this repository and explicit project requirements; ask before introducing a language, framework, package manager, build tool, or runtime.";
  return [
    "# Project Agent Instructions",
    "",
    `These instructions are for agents changing ${bundle.project.name}, the target project represented by this repository and its ArchiCode graph. They are not instructions for developing the ArchiCode application itself.`,
    "",
    "- Keep implementation aligned with this target project's graph, selected node, acceptance criteria, and explicit user requirements.",
    technologyInstruction,
    "- Prefer this repository's existing file layout, naming, component, dependency, and testing conventions before introducing new patterns or tools.",
    "- Add or update meaningful tests for changed behavior; do not add placeholder tests that only prove the test harness ran.",
    `- Before handoff, run this project's finite verification commands when available: ${formatCommandList(verifyCommands)}. Record any blocker.`,
    "- During automated implementation and verification, do not start long-running development servers, preview processes, or watch commands. Use a configured Run App target when runtime inspection is requested.",
    "- Do not introduce new subsystems, services, data stores, authentication, deployment targets, or other major scope unless this project's graph or explicit requirements call for them.",
    "- When the target project's requirements or technology choices are materially ambiguous, ask for clarification instead of importing assumptions from ArchiCode or from unrelated projects."
  ].join("\n");
}

export function isUntouchedLegacyGeneratedAgentInstructions(text: string): boolean {
  const lines = text.replaceAll("\r", "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 8 || lines[0] !== "# Agent Instructions") return false;
  return lines[1] === "- Keep implementation aligned with the ArchiCode graph, selected node, and acceptance criteria." &&
    lines[2] === "- Prefer the existing stack, file layout, and component patterns before adding new tools." &&
    lines[3] === "- Treat ArchiCode as stack-neutral: derive languages, frameworks, package/build tools, commands, and generated files from this project and its graph; never default to a familiar stack." &&
    lines[4].startsWith("- Add or update meaningful tests for changed behavior;") &&
    lines[5].startsWith("- Before handoff, run finite verification commands when available:") &&
    lines[5].endsWith("Record any blocker.") &&
    lines[6] === "- Do not start app/runtime/dev/serve/preview/watch commands during ArchiCode verification; runtime launch belongs to Run App targets." &&
    lines[7] === "- Do not add backend services, authentication, databases, or new deployment targets unless the graph asks for them.";
}

async function migrateLegacyGeneratedAgentInstructionsWithCommands(
  projectRoot: string,
  bundle: Pick<ProjectBundle, "project" | "flows">,
  verifyCommands: string[]
): Promise<boolean> {
  for (const fileName of ["AGENTS.md", "agents.md"]) {
    const fullPath = path.join(projectRoot, fileName);
    if (!(await exists(fullPath))) continue;
    const existingText = await readFile(fullPath, "utf8");
    if (!isUntouchedLegacyGeneratedAgentInstructions(existingText)) return false;
    await writeFile(fullPath, `${generatedTargetProjectAgentInstructions(bundle, verifyCommands)}\n`, "utf8");
    return true;
  }
  return false;
}

export async function migrateLegacyGeneratedAgentInstructions(
  projectRoot: string,
  bundle: ProjectBundle
): Promise<boolean> {
  const commands = await inferProjectCommands(projectRoot, bundle);
  const verifyCommands = commands.verify.length
    ? commands.verify
    : [bundle.project.settings.defaultBuildCommand.trim()].filter(Boolean);
  return migrateLegacyGeneratedAgentInstructionsWithCommands(projectRoot, bundle, verifyCommands);
}

export async function ensureManagerialProjectFiles(projectRoot: string, bundle: ProjectBundle): Promise<string[]> {
  const packageJson = await readJson<{ name?: string; scripts?: Record<string, string> } | null>(path.join(projectRoot, "package.json"), null);
  const commands = await inferProjectCommands(projectRoot, bundle);
  const projectName = humanizeProjectName(packageJson?.name, projectRoot);
  const verifyCommands = commands.verify.length ? commands.verify : [bundle.project.settings.defaultBuildCommand.trim()].filter(Boolean);
  const created: string[] = [];

  async function createIfMissing(fileName: string, content: string, alternates: string[] = []): Promise<void> {
    const candidates = [fileName, ...alternates];
    for (const candidate of candidates) {
      if (await exists(path.join(projectRoot, candidate))) return;
    }
    await writeFile(path.join(projectRoot, fileName), content.endsWith("\n") ? content : `${content}\n`, "utf8");
    created.push(fileName);
  }

  if (await ensureProjectGitignoreDefaults(projectRoot)) created.push(".gitignore");

  const targetAgentInstructions = generatedTargetProjectAgentInstructions(bundle, verifyCommands);
  await migrateLegacyGeneratedAgentInstructionsWithCommands(projectRoot, bundle, verifyCommands).catch(() => false);
  let foundAgentInstructionsPath: string | null = null;
  for (const fileName of ["AGENTS.md", "agents.md"]) {
    if (await exists(path.join(projectRoot, fileName))) {
      foundAgentInstructionsPath = fileName;
      break;
    }
  }
  if (foundAgentInstructionsPath) {
    // Existing project instructions are user-owned. The only automatic replacement
    // happens above when the file exactly matches ArchiCode's untouched legacy template.
  } else {
    await writeFile(path.join(projectRoot, "AGENTS.md"), `${targetAgentInstructions}\n`, "utf8");
    created.push("AGENTS.md");
  }

  await createIfMissing("README.md", [
    `# ${projectName}`,
    "",
    "Generated and maintained from an ArchiCode plan.",
    "",
    "## Getting Started",
    "",
    commands.install ? `1. Install dependencies: \`${commands.install}\`` : "1. Install dependencies with the package manager used by this project.",
    commands.run ? `2. Preview through ArchiCode Run App or start locally with: \`${commands.run}\`` : "2. Preview through the configured ArchiCode Run App target when one is available.",
    "",
    "## Verification",
    "",
    ...verifyCommands.map((command) => `- \`${command}\``),
    "",
    "## Project Notes",
    "",
    "- Keep source changes tied to the ArchiCode nodes and acceptance criteria.",
    "- Update this README when commands, routes, or setup requirements change.",
    "- Keep tests close to the behavior they cover."
  ].join("\n"), ["readme.md"]);

  return created;
}

export async function refreshInferredProjectCommands(projectRoot: string): Promise<ProjectBundle> {
  const bundle = await loadProject(projectRoot);
  if (bundle.project.settings.buildTargetsLocked) return bundle;
  const inferred = await inferCommandSettings(projectRoot);
  const settings = bundle.project.settings;
  const nextDefaultBuildCommand = settings.defaultBuildCommand.trim() || inferred.defaultBuildCommand;
  const nextDefaultRunCommand = settings.defaultRunCommand.trim() || inferred.defaultRunCommand;
  const nextRunTargetProfiles = mergeRunTargetProfiles(settings.runTargetProfiles, inferred.runTargetProfiles);
  if (
    nextDefaultBuildCommand === settings.defaultBuildCommand &&
    nextDefaultRunCommand === settings.defaultRunCommand &&
    nextRunTargetProfiles === settings.runTargetProfiles
  ) {
    return bundle;
  }

  await writeProjectFiles(projectRoot, projectSchema.parse({
    ...bundle.project,
    settings: {
      ...settings,
      defaultBuildCommand: nextDefaultBuildCommand,
      defaultRunCommand: nextDefaultRunCommand,
      runTargetProfiles: nextRunTargetProfiles
    },
    updatedAt: iso()
  }));
  return loadProject(projectRoot);
}

export type InferredCommandSettings = Pick<ProjectSettings, "defaultBuildCommand" | "defaultRunCommand" | "runTargetProfiles" | "allowedShellCommands">;

export async function inferCommandSettings(projectRoot: string): Promise<InferredCommandSettings> {
  const empty: InferredCommandSettings = {
    defaultBuildCommand: "",
    defaultRunCommand: "",
    runTargetProfiles: [],
    allowedShellCommands: []
  };

  const packageJsonText = await readTextIfExists(path.join(projectRoot, "package.json"));
  if (packageJsonText) {
    try {
      const packageJson = JSON.parse(packageJsonText) as PackageJsonForInference;
      const scripts = packageJson.scripts ?? {};
      const packageManager = await detectPackageManager(projectRoot);
      const defaultRunCommand = typeof scripts.dev === "string"
        ? `${packageManager} run dev`
        : typeof scripts.start === "string"
          ? `${packageManager} run start`
          : "";
      const runTargetProfiles = await inferPackageRuntimeProfiles(projectRoot, packageJson, packageManager);
      const buildScript = typeof scripts.build === "string" ? scripts.build : "";
      return {
        defaultBuildCommand: buildScript && !isRuntimeOrWatchCommand(buildScript) ? `${packageManager} run build` : "",
        defaultRunCommand,
        runTargetProfiles,
        allowedShellCommands: []
      };
    } catch {
      return empty;
    }
  }

  if (await exists(path.join(projectRoot, "pubspec.yaml"))) {
    return {
      defaultBuildCommand: await exists(path.join(projectRoot, "web")) ? "flutter build web" : "",
      defaultRunCommand: "flutter run",
      runTargetProfiles: flutterRunTargetProfiles,
      allowedShellCommands: []
    };
  }

  if (await exists(path.join(projectRoot, "Cargo.toml"))) {
    return {
      defaultBuildCommand: "cargo build",
      defaultRunCommand: "cargo run",
      runTargetProfiles: [],
      allowedShellCommands: []
    };
  }

  if (await exists(path.join(projectRoot, "go.mod"))) {
    return {
      defaultBuildCommand: "go build ./...",
      defaultRunCommand: "go run .",
      runTargetProfiles: [],
      allowedShellCommands: []
    };
  }

  if (await exists(path.join(projectRoot, "pom.xml"))) {
    return {
      defaultBuildCommand: "mvn package",
      defaultRunCommand: "",
      runTargetProfiles: [],
      allowedShellCommands: []
    };
  }

  if (
    await exists(path.join(projectRoot, "gradlew")) ||
    await exists(path.join(projectRoot, "build.gradle")) ||
    await exists(path.join(projectRoot, "build.gradle.kts")) ||
    await exists(path.join(projectRoot, "settings.gradle")) ||
    await exists(path.join(projectRoot, "settings.gradle.kts"))
  ) {
    return {
      defaultBuildCommand: await exists(path.join(projectRoot, "gradlew")) ? "./gradlew build" : "gradle build",
      defaultRunCommand: "",
      runTargetProfiles: [],
      allowedShellCommands: []
    };
  }

  return empty;
}

export async function detectPackageManager(projectRoot: string): Promise<"npm" | "pnpm" | "yarn"> {
  if (await exists(path.join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(projectRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

export type PackageJsonForInference = {
  name?: string;
  scripts?: Record<string, unknown>;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

export function scriptCommand(packageManager: "npm" | "pnpm" | "yarn", scriptName: string): string {
  return `${packageManager} run ${scriptName}`;
}

export function runnableScriptName(scripts: Record<string, unknown>): string | null {
  for (const name of ["dev", "start", "serve", "storybook"]) {
    if (typeof scripts[name] === "string") return name;
  }
  return null;
}

export function setupScriptName(scripts: Record<string, unknown>): string | undefined {
  for (const name of ["setup", "prepare:dev", "db:setup", "db:migrate", "migrate", "prisma:migrate", "prisma:generate"]) {
    if (typeof scripts[name] === "string") return name;
  }
  return undefined;
}

export function inferRuntimeKind(packageJson: PackageJsonForInference, scripts: Record<string, unknown>, cwd: string, hint = ""): string {
  const hintText = hint.toLowerCase();
  if (hintText.includes("storybook")) return "storybook";
  if (hintText.includes("api") || hintText.includes("server")) return "api";
  if (hintText.includes("worker") || hintText.includes("queue")) return "worker";
  if (hintText.includes("web") || hintText.includes("vite") || hintText.includes("next")) return "web";
  const deps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  };
  const text = `${hint} ${packageJson.name ?? ""} ${cwd} ${Object.keys(scripts).join(" ")} ${Object.keys(deps).join(" ")}`.toLowerCase();
  if (text.includes("storybook")) return "storybook";
  if (text.includes("express") || text.includes("fastify") || text.includes("koa") || text.includes("api") || text.includes("server")) return "api";
  if (text.includes("worker") || text.includes("queue")) return "worker";
  if (text.includes("react") || text.includes("vue") || text.includes("next") || text.includes("vite") || text.includes("web")) return "web";
  return "generic";
}

export function profileIdFromCwd(cwd: string, fallback: string): string {
  const source = cwd || fallback || "root";
  const normalized = source.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "root";
}

export function labelFromPackage(packageJson: PackageJsonForInference, cwd: string): string {
  const raw = packageJson.name?.split("/").pop() || (cwd ? path.basename(cwd) : "Local Browser");
  return raw.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function labelFromScriptName(scriptName: string): string {
  const raw = scriptName.split(":").slice(1).join(" ") || scriptName;
  return raw.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function profileForPackage(
  packageJson: PackageJsonForInference,
  cwd: string,
  packageManager: "npm" | "pnpm" | "yarn"
): ProjectSettings["runTargetProfiles"][number] | null {
  const scripts = packageJson.scripts ?? {};
  const runScript = runnableScriptName(scripts);
  if (!runScript) return null;
  const setupScript = setupScriptName(scripts);
  const kind = inferRuntimeKind(packageJson, scripts, cwd);
  return {
    id: cwd ? profileIdFromCwd(cwd, packageJson.name ?? "") : "web-local-browser",
    label: labelFromPackage(packageJson, cwd),
    kind,
    cwd,
    description: cwd ? `Run ${labelFromPackage(packageJson, cwd)} from ${cwd}.` : "Start the local app runtime from the project root.",
    runCommand: scriptCommand(packageManager, runScript),
    setupCommand: setupScript ? scriptCommand(packageManager, setupScript) : undefined,
    buildCommand: typeof scripts.build === "string" ? scriptCommand(packageManager, "build") : undefined,
    testCommand: typeof scripts.test === "string" ? scriptCommand(packageManager, "test") : undefined,
    inferred: true,
    targetRequired: false,
    diagnosticCommands: [],
    recoveryCommands: [],
    retryAfterRecovery: true,
    readyPattern: kind === "web" || kind === "storybook" ? "localhost|127\\.0\\.0\\.1|Local:" : undefined,
    timeoutSeconds: 120
  };
}

export function profileForRootScript(
  packageJson: PackageJsonForInference,
  scriptName: string,
  packageManager: "npm" | "pnpm" | "yarn"
): ProjectSettings["runTargetProfiles"][number] {
  const scripts = packageJson.scripts ?? {};
  const label = labelFromScriptName(scriptName);
  const setupScript = setupScriptName(scripts);
  const kind = inferRuntimeKind(packageJson, scripts, "", `${scriptName} ${String(scripts[scriptName] ?? "")}`);
  return {
    id: `script-${profileIdFromCwd(scriptName, scriptName)}`,
    label,
    kind,
    cwd: "",
    description: `Run the ${label} runtime from the project root.`,
    runCommand: scriptCommand(packageManager, scriptName),
    setupCommand: setupScript ? scriptCommand(packageManager, setupScript) : undefined,
    buildCommand: typeof scripts.build === "string" ? scriptCommand(packageManager, "build") : undefined,
    testCommand: typeof scripts.test === "string" ? scriptCommand(packageManager, "test") : undefined,
    inferred: true,
    targetRequired: false,
    diagnosticCommands: [],
    recoveryCommands: [],
    retryAfterRecovery: true,
    readyPattern: kind === "web" || kind === "storybook" ? "localhost|127\\.0\\.0\\.1|Local:" : undefined,
    timeoutSeconds: 120
  };
}

export function rootRuntimeScriptNames(scripts: Record<string, unknown>): string[] {
  const prefixes = ["dev", "start", "serve", "storybook"];
  return Object.keys(scripts)
    .filter((scriptName) =>
      typeof scripts[scriptName] === "string" &&
      prefixes.some((prefix) => scriptName.startsWith(`${prefix}:`))
    )
    .sort();
}

export function workspacePatterns(packageJson: PackageJsonForInference): string[] {
  const workspaces = packageJson.workspaces;
  if (Array.isArray(workspaces)) return workspaces;
  return workspaces?.packages ?? [];
}

export async function expandWorkspacePattern(projectRoot: string, pattern: string): Promise<string[]> {
  const normalized = pattern.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized || normalized.includes("**")) return [];
  if (!normalized.includes("*")) {
    return (await exists(path.join(projectRoot, normalized, "package.json"))) ? [normalized] : [];
  }
  const starIndex = normalized.indexOf("*");
  const prefix = normalized.slice(0, starIndex).replace(/\/+$/g, "");
  const suffix = normalized.slice(starIndex + 1).replace(/^\/+/g, "");
  const baseDir = path.join(projectRoot, prefix || ".");
  if (!(await exists(baseDir))) return [];
  const entries = await readdir(baseDir);
  const matches: string[] = [];
  for (const entry of entries) {
    const relative = [prefix, entry, suffix].filter(Boolean).join("/");
    if (await exists(path.join(projectRoot, relative, "package.json"))) matches.push(relative);
  }
  return matches;
}

export const PACKAGE_DISCOVERY_IGNORE_DIRS = new Set([
  ".archicode",
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "release"
]);

export async function discoverShallowPackageDirs(projectRoot: string, maxDepth = 2): Promise<string[]> {
  const dirs = new Set<string>();
  const visit = async (relativeDir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const absoluteDir = path.join(projectRoot, relativeDir || ".");
    let entries: Dirent[];
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || PACKAGE_DISCOVERY_IGNORE_DIRS.has(entry.name)) continue;
      const childRelative = [relativeDir, entry.name].filter(Boolean).join("/");
      if (await exists(path.join(projectRoot, childRelative, "package.json"))) dirs.add(childRelative);
      await visit(childRelative, depth + 1);
    }
  };
  await visit("", 1);
  return [...dirs].sort();
}

export async function discoverPackageDirs(projectRoot: string, packageJson: PackageJsonForInference): Promise<string[]> {
  const dirs = new Set<string>();
  for (const pattern of workspacePatterns(packageJson)) {
    for (const dir of await expandWorkspacePattern(projectRoot, pattern)) dirs.add(dir);
  }
  for (const base of ["apps", "services", "packages"]) {
    const basePath = path.join(projectRoot, base);
    if (!(await exists(basePath))) continue;
    for (const entry of await readdir(basePath)) {
      const relative = `${base}/${entry}`;
      if (await exists(path.join(projectRoot, relative, "package.json"))) dirs.add(relative);
    }
  }
  for (const dir of await discoverShallowPackageDirs(projectRoot)) dirs.add(dir);
  return [...dirs].sort();
}

export async function inferPackageRuntimeProfiles(
  projectRoot: string,
  packageJson: PackageJsonForInference,
  packageManager: "npm" | "pnpm" | "yarn"
): Promise<ProjectSettings["runTargetProfiles"]> {
  const profiles: ProjectSettings["runTargetProfiles"] = [];
  const rootProfile = profileForPackage(packageJson, "", packageManager);
  if (rootProfile) profiles.push(rootProfile);
  for (const scriptName of rootRuntimeScriptNames(packageJson.scripts ?? {})) {
    profiles.push(profileForRootScript(packageJson, scriptName, packageManager));
  }
  for (const dir of await discoverPackageDirs(projectRoot, packageJson)) {
    const childJson = await readJson<PackageJsonForInference | null>(path.join(projectRoot, dir, "package.json"), null);
    if (!childJson) continue;
    const profile = profileForPackage(childJson, dir, packageManager);
    if (profile) profiles.push(profile);
  }
  const seenIds = new Set<string>();
  return profiles.map((profile) => {
    if (!seenIds.has(profile.id)) {
      seenIds.add(profile.id);
      return profile;
    }
    let suffix = 2;
    let nextId = `${profile.id}-${suffix}`;
    while (seenIds.has(nextId)) {
      suffix += 1;
      nextId = `${profile.id}-${suffix}`;
    }
    seenIds.add(nextId);
    return { ...profile, id: nextId };
  });
}

export function applyCommandSettings(project: Project, commandSettings: InferredCommandSettings): Project {
  if (project.settings.buildTargetsLocked) return project;
  const runTargetProfiles = mergeRunTargetProfiles(project.settings.runTargetProfiles, commandSettings.runTargetProfiles);
  return projectSchema.parse({
    ...project,
    settings: {
      ...project.settings,
      defaultBuildCommand: commandSettings.defaultBuildCommand || project.settings.defaultBuildCommand,
      defaultRunCommand: commandSettings.defaultRunCommand || project.settings.defaultRunCommand,
      runTargetProfiles,
      allowedShellCommands: commandSettings.allowedShellCommands
    },
    updatedAt: iso()
  });
}

export function mergeRunTargetProfiles(
  existingProfiles: ProjectSettings["runTargetProfiles"],
  inferredProfiles: ProjectSettings["runTargetProfiles"]
): ProjectSettings["runTargetProfiles"] {
  if (!existingProfiles.length) return inferredProfiles;
  const inferredById = new Map(inferredProfiles.map((profile) => [profile.id, profile]));
  let changed = false;
  const enrichedProfiles = existingProfiles.map((profile) => {
    const inferred = inferredById.get(profile.id);
    if (!inferred) return profile;
    const enriched = runTargetProfileSchema.parse({
      ...profile,
      cwd: profile.cwd ?? inferred.cwd,
      installCommand: profile.installCommand ?? inferred.installCommand,
      setupCommand: profile.setupCommand ?? inferred.setupCommand,
      buildCommand: profile.buildCommand ?? inferred.buildCommand,
      testCommand: profile.testCommand ?? inferred.testCommand,
      stopCommand: profile.stopCommand ?? inferred.stopCommand,
      healthCommand: profile.healthCommand ?? inferred.healthCommand,
      url: profile.url ?? inferred.url,
      ports: profile.ports ?? inferred.ports,
      groupId: profile.groupId ?? inferred.groupId,
      dependsOn: profile.dependsOn ?? inferred.dependsOn,
      inferred: profile.inferred ?? inferred.inferred
    });
    if (JSON.stringify(enriched) !== JSON.stringify(profile)) changed = true;
    return enriched;
  });
  const existingIds = new Set(enrichedProfiles.map((profile) => profile.id));
  const missingProfiles = inferredProfiles.filter((profile) => !existingIds.has(profile.id));
  return changed || missingProfiles.length ? [...enrichedProfiles, ...missingProfiles] : existingProfiles;
}

export async function collectRuntimePackageDescriptors(projectRoot: string): Promise<Array<{
  path: string;
  name?: string;
  scripts?: Record<string, unknown>;
  workspaces?: PackageJsonForInference["workspaces"];
  dependencies?: string[];
  devDependencies?: string[];
}>> {
  const descriptors: Array<{
    path: string;
    name?: string;
    scripts?: Record<string, unknown>;
    workspaces?: PackageJsonForInference["workspaces"];
    dependencies?: string[];
    devDependencies?: string[];
  }> = [];
  const rootText = await readTextIfExists(path.join(projectRoot, "package.json"));
  if (!rootText) return descriptors;

  try {
    const rootPackage = JSON.parse(rootText) as PackageJsonForInference;
    const packageDirs = ["", ...await discoverPackageDirs(projectRoot, rootPackage)];
    for (const dir of packageDirs) {
      const packagePath = path.join(projectRoot, dir, "package.json");
      const packageJson = await readJson<PackageJsonForInference | null>(packagePath, null);
      if (!packageJson) continue;
      descriptors.push({
        path: dir ? `${dir}/package.json` : "package.json",
        name: packageJson.name,
        scripts: packageJson.scripts,
        workspaces: packageJson.workspaces,
        dependencies: Object.keys(packageJson.dependencies ?? {}).sort(),
        devDependencies: Object.keys(packageJson.devDependencies ?? {}).sort()
      });
    }
  } catch {
    return descriptors;
  }

  return descriptors;
}

export function isRunnableProviderForReconciliation(provider: ProjectSettings["providers"][number] | undefined): boolean {
  return Boolean(provider && provider.kind !== "offline-manual");
}

export const runProfilePatchJsonContract = [
  "Runtime profile handoff JSON contract:",
  "When run target profile changes are needed, return exactly one machine-readable JSON object, preferably in a fenced ```json block, with this top-level shape: { \"archicodePatch\": { ... } }.",
  "Do not return the bare patch object with schemaVersion at the top level; schemaVersion, runId, summary, and operations belong inside archicodePatch.",
  "archicodePatch runtime profile schema:",
  "{",
  "  \"archicodePatch\": {",
  "    \"schemaVersion\": 1,",
  "    \"runId\": string,",
  "    \"summary\": string,",
  "    \"operations\": [",
  "      {",
  "        \"kind\": \"propose-run-profile\",",
  "        \"mode\": \"create\" | \"replace\",",
  "        \"reason\": string,",
  "        \"profile\": {",
  "          \"id\": string,",
  "          \"label\": string,",
  "          \"kind\": string,",
  "          \"cwd\": string,",
  "          \"description\": string,",
  "          \"installCommand\": string,",
  "          \"setupCommand\": string,",
  "          \"buildCommand\": string,",
  "          \"testCommand\": string,",
  "          \"runCommand\": string,",
  "          \"url\": string,",
  "          \"ports\": number[],",
  "          \"groupId\": string,",
  "          \"dependsOn\": string[],",
  "          \"inferred\": boolean",
  "        }",
  "      }",
  "    ]",
  "  }",
  "}",
  "Only schemaVersion, runId, summary, and operations are required at archicodePatch level; profile.id, profile.label, and profile.runCommand are required for runnable targets.",
  "Use cwd for module directories; do not embed cd ... && ... in commands.",
  "If no changes are needed, return prose only and no JSON.",
  "Valid create example:",
  "{",
  "  \"archicodePatch\": {",
  "    \"schemaVersion\": 1,",
  "    \"runId\": \"run-current-runtime-reconcile\",",
  "    \"summary\": \"Add a web dev run profile.\",",
  "    \"operations\": [",
  "      {",
  "        \"kind\": \"propose-run-profile\",",
  "        \"mode\": \"create\",",
  "        \"reason\": \"The project exposes a web dev script.\",",
  "        \"profile\": {",
  "          \"id\": \"web-dev\",",
  "          \"label\": \"Web Dev\",",
  "          \"kind\": \"web\",",
  "          \"cwd\": \"\",",
  "          \"runCommand\": \"npm run dev\",",
  "          \"url\": \"http://localhost:5173\",",
  "          \"ports\": [5173],",
  "          \"inferred\": true",
  "        }",
  "      }",
  "    ]",
  "  }",
  "}"
].join("\n");

export const RUNTIME_PROFILE_RECONCILIATION_MAX_ATTEMPTS = 2;

export type RuntimeProfileReconciliationValidation = {
  proposal: PersistedPatchProposal | null;
  repairableError?: string;
};

export async function writeInvalidRuntimeProfileReconciliationArtifact(
  projectRoot: string,
  runId: string,
  output: string,
  error: string,
  artifactSuffix?: string
): Promise<Artifact> {
  const suffix = artifactSuffix ? `-${artifactSuffix.replace(/[^a-z0-9-]/gi, "-")}` : "";
  const artifact: Artifact = {
    id: id("artifact"),
    type: "generated-file",
    title: `Unusable runtime profile reconciliation handoff for ${runId}`,
    path: `.archicode/artifacts/${runId}-invalid-runtime-profile-reconciliation${suffix}.json`,
    runId,
    status: "pending-review",
    summary: "ArchiCode could not safely use the runtime profile reconciliation output.",
    createdAt: iso()
  };
  await writeJson(path.join(projectRoot, artifact.path), {
    ...artifact,
    rawProviderOutput: output,
    error,
    recovery: "Retry runtime profile reconciliation with the run-profile-only contract."
  });
  return artifact;
}

export async function validateRuntimeProfileReconciliationOutput(
  projectRoot: string,
  runId: string,
  output: string,
  artifactSuffix?: string
): Promise<RuntimeProfileReconciliationValidation> {
  const extraction = extractArchicodePatch(output, runId, { phase: "review" });
  if (!extraction.proposal) {
    if (!extraction.errors.length || !looksLikePatchHandoff(output)) {
      return { proposal: null };
    }
    const error = extraction.errors.join(" | ") || "Runtime profile reconciliation output did not match the archicodePatch contract.";
    await writeInvalidRuntimeProfileReconciliationArtifact(projectRoot, runId, output, error, artifactSuffix);
    return { proposal: null, repairableError: error };
  }

  const parsedProposal = llmPatchProposalSchema.safeParse(extraction.proposal);
  if (!parsedProposal.success) {
    const error = parsedProposal.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join(" | ");
    await writeInvalidRuntimeProfileReconciliationArtifact(projectRoot, runId, output, error, artifactSuffix);
    return { proposal: null, repairableError: error };
  }

  const invalidOperation = parsedProposal.data.operations.find((operation) => operation.kind !== "propose-run-profile");
  if (invalidOperation) {
    const error = `Runtime profile reconciliation may only return propose-run-profile operations, but received ${invalidOperation.kind}.`;
    await writeInvalidRuntimeProfileReconciliationArtifact(projectRoot, runId, output, error, artifactSuffix);
    return { proposal: null, repairableError: error };
  }

  const proposal = await persistAndMaybeApplyPatchProposal(projectRoot, runId, output, { artifactSuffix });
  if (proposal && !proposal.valid) {
    return {
      proposal,
      repairableError: "Runtime profile reconciliation output was not a valid ArchiCode patch handoff."
    };
  }
  return { proposal };
}

export async function reconcileRuntimeProfilesWithLlm(
  projectRoot: string,
  providerId: string | undefined,
  reason: "post-implementation" | "pre-build" | "codebase-import",
  runId: string,
  signal?: AbortSignal,
  onProviderEvent?: (event: { kind: "succeeded" | "failed" | "rejected"; retry: boolean }) => void
): Promise<{ bundle: ProjectBundle; proposal: PersistedPatchProposal | null; output?: string; skippedReason?: string; repairSummary?: string }> {
  const currentBundle = await loadProject(projectRoot);
  if (currentBundle.project.settings.buildTargetsLocked) {
    return {
      bundle: currentBundle,
      proposal: null,
      skippedReason: "Build targets are locked in Project Settings; runtime profile reconciliation was skipped."
    };
  }
  const refreshedBundle = await refreshInferredProjectCommands(projectRoot);
  const provider = providerId ? refreshedBundle.project.settings.providers.find((item) => item.id === providerId) : undefined;
  if (!isRunnableProviderForReconciliation(provider)) {
    return {
      bundle: refreshedBundle,
      proposal: null,
      skippedReason: "No runnable LLM provider is configured for runtime profile reconciliation."
    };
  }

  const inferred = await inferCommandSettings(projectRoot);
  const context = {
    task: "Reconcile ArchiCode runtime/build profile settings for this project.",
    reason,
    constraints: [
      "Do not edit source files.",
      "Do not propose source-file, node, edge, subflow, approval, or project-file operations.",
      "Return an archicodePatch JSON object only when runTargetProfiles need to be created or replaced.",
      "Use only propose-run-profile operations.",
      runProfilePatchJsonContract,
      "Use cwd for module directories; do not embed cd ... && ... in commands.",
      "Use mode=create for missing profile ids and mode=replace for corrections to existing ids.",
      "For root package split scripts such as dev:web and dev:api, use cwd \"\" and runCommand \"npm run dev:web\" style commands.",
      "Include setupCommand, buildCommand, testCommand, url, ports, groupId, dependsOn, and inferred when known."
    ],
    project: {
      id: refreshedBundle.project.id,
      name: refreshedBundle.project.name,
      description: refreshedBundle.project.description,
      stackAssumptions: refreshedBundle.project.settings.stackAssumptions,
      defaultBuildCommand: refreshedBundle.project.settings.defaultBuildCommand,
      defaultRunCommand: refreshedBundle.project.settings.defaultRunCommand,
      runTargetProfiles: refreshedBundle.project.settings.runTargetProfiles
    },
    deterministicInference: inferred,
    packageDescriptors: await collectRuntimePackageDescriptors(projectRoot)
  };
  const prompt = [
    "Review the project runtime/build model and correct only the run target profiles if needed.",
    "If the current profiles already cover the runnable modules and root scripts, reply that no profile changes are needed.",
    "When changes are needed, return machine-readable JSON with archicodePatch.operations containing only propose-run-profile operations.",
    runProfilePatchJsonContract
  ].join(" ");
  const runnableProvider = await hydrateProviderForUse(provider!);
  const contextJson = JSON.stringify(context, null, 2);
  let lastOutput = "";
  let repairSummary: string | undefined;
  for (let attempt = 1; attempt <= RUNTIME_PROFILE_RECONCILIATION_MAX_ATTEMPTS; attempt += 1) {
    const providerContext = attempt === 1
      ? contextJson
      : [
          contextJson,
          "",
          "## Runtime Profile Reconciliation Repair Request",
          "Your previous output was rejected by the runtime profile reconciliation validator.",
          "Return either plain prose saying no profile changes are needed, or exactly one archicodePatch JSON object whose operations are only propose-run-profile.",
          "Do not return source-file, node, edge, subflow, approval, or project-file operations.",
          `Validator error: ${repairSummary ?? "Unknown reconciliation contract error."}`,
          "",
          "Previous rejected output:",
          lastOutput
        ].join("\n");
    try {
      lastOutput = await callProvider(runnableProvider, providerContext, prompt, {
        projectRoot,
        webSearchEnabled: false,
        phase: "review",
        signal
      });
      onProviderEvent?.({ kind: "succeeded", retry: attempt > 1 });
    } catch (error) {
      onProviderEvent?.({ kind: "failed", retry: attempt > 1 });
      throw error;
    }
    const validation = await validateRuntimeProfileReconciliationOutput(
      projectRoot,
      runId,
      lastOutput,
      attempt === 1 ? undefined : `repair-${attempt}`
    );
    if (!validation.repairableError) {
      return {
        bundle: await loadProject(projectRoot),
        proposal: validation.proposal,
        output: lastOutput,
        repairSummary: attempt > 1 ? `Runtime profile reconciliation recovered after ${attempt - 1} repair attempt${attempt - 1 === 1 ? "" : "s"}.` : undefined
      };
    }
    onProviderEvent?.({ kind: "rejected", retry: attempt > 1 });
    repairSummary = validation.repairableError;
  }
  return {
    bundle: await loadProject(projectRoot),
    proposal: null,
    output: lastOutput,
    skippedReason: `Runtime profile reconciliation could not produce a valid run-profile-only handoff after ${RUNTIME_PROFILE_RECONCILIATION_MAX_ATTEMPTS} attempts: ${repairSummary ?? "unknown validation error"}.`
  };
}
