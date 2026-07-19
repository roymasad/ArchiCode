import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  flowSchema,
  presentationPatchRequestSchema,
  projectBundleSchema,
  projectSchema,
  providerSettingsSchema,
  defaultPhaseModelPolicies
} from "../../shared/schema";
import type { Artifact, DebugIncident, Flow, GraphChangeRecord, ImplementationScopeClaim, NodePatch, Note, PresentationNodeMutation, PresentationPatchRequest, PresentationPatchResult, Project, ProjectBundle, ProjectSettings, Run } from "../../shared/schema";
import {
  applyNodePatch,
  archicodeNodeSchema,
  canvasBackgroundSchema,
  canvasEdgeStyleSchema,
  debugIncidentSchema,
  graphChangeRecordSchema,
  noteSchema,
  notificationSettingsSchema,
  runSchema
} from "../../shared/schema";
import { createSeedProject } from "../../shared/fixtures";
import { normalizeEvidenceFlow } from "../../shared/graph";
import { createProjectFromTemplate, flutterRunTargetProfiles, type ProjectTemplateId } from "../../shared/templates";
import { applyCommandSettings, inferCommandSettings, mergeRunTargetProfiles, migrateLegacyGeneratedAgentInstructions } from "./commandInference";
import { reconcileObsoleteGraphChanges, reconcileOrphanedInProgressRuns, reconcileVerifiedNodeBuildFlags } from "./runEngine";
import { hydrateRunLogs, readRun } from "./runLogs";
import { compactGraphChangeLedger } from "./runEngine";
import { checkProviderHealth, type ProviderHealthResult } from "../providers";
import {
  PROJECT_STATE_DIR,
  definedOnly,
  exists,
  id,
  iso,
  projectStatePath,
  readJson,
  readJsonDirectory,
  readTextIfExists,
  safeParseMany,
  safeParseOne,
  safeParseOptional,
  writeJson
} from "./persistence";
import {
  type GraphChangeActor,
  graphChangeSnippets,
  readGraphChanges,
  readNotes,
  recordFlowShapeChanges,
  writeGraphChangeRecord,
  writeNotes
} from "./ledgers";
import { finalizeNodeNotesForApproval, isNoteAutoResolveNodeState } from "./notes";
import { proposedSourceContent } from "./patches";
import { hydrateGraphEvidenceLocalState } from "./graphEvidenceLocalState";
import { recoverPendingResyncTransactions } from "../importer/resyncPersistence";
import { readArchitecturePolicyEvaluation, refreshGraphArchitecturePolicyEvaluation } from "../policies/architecturePolicies";
import { computeGraphVersion } from "./graphVersion";

export const LOCAL_PROJECT_STATE_FILE = "local.json";
// Every shared append-only ledger gets merge=union so concurrent branch
// appends combine without conflicts; readers dedup by record id afterwards.
export const ARCHICODE_GIT_ATTRIBUTES_RULES = [
  ".archicode/graph-changes.jsonl merge=union",
  ".archicode/graph-changes-archive.jsonl merge=union",
  ".archicode/notes.jsonl merge=union"
];
export const LEGACY_NPM_COMMANDS = ["npm run build", "npm run test", "npm run dev"];

const presentationMutationTails = new Map<string, Promise<void>>();

function withPresentationMutationLock<T>(projectRoot: string, flowId: string, task: () => Promise<T>): Promise<T> {
  const key = `${projectRoot}\0${flowId}`;
  const previous = presentationMutationTails.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(task);
  const tail = result.then(() => undefined, () => undefined);
  presentationMutationTails.set(key, tail);
  void tail.finally(() => {
    if (presentationMutationTails.get(key) === tail) presentationMutationTails.delete(key);
  });
  return result;
}

export const PROJECT_STATE_LOCAL_GITIGNORE_PATTERNS = [
  ".archicode/local.json",
  ".archicode/runs/",
  ".archicode/incidents/",
  ".archicode/artifacts/",
  ".archicode/summaries/",
  ".archicode/manifests/",
  ".archicode/memory/",
  ".archicode/memory-notes/",
  ".archicode/reviews/",
  ".archicode/repair-backup-*/",
  ".archicode/runtime/",
  ".archicode/tmp/"
];
export const DEFAULT_PROJECT_GITIGNORE_PATTERNS = [
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".vite/",
  ".cache/",
  "*.log",
  "npm-debug.log*",
  "yarn-debug.log*",
  "yarn-error.log*",
  "pnpm-debug.log*",
  "*.tsbuildinfo",
  ".DS_Store",
  ".env",
  ".env.*",
  "!.env.example"
];

export type GlobalProviderLoadOptions = {
  includeSecrets?: boolean;
};

export type GlobalProviderSaveOptions = {
  preserveMissingSecrets?: boolean;
};

export let globalProviderSettingsStore: {
  load: (options?: GlobalProviderLoadOptions) => Promise<ProjectSettings["providers"] | null>;
  loadSecret?: (providerId: string) => Promise<string | undefined>;
  save: (providers: ProjectSettings["providers"], options?: GlobalProviderSaveOptions) => Promise<void>;
} | null = null;

// MCP servers are an app/workstation preference (which tools a developer has
// wired up), not a fact about the codebase: one shared list across every
// project, the same way speech/tts settings became app-wide.
export let globalMcpSettingsStore: {
  load: (options?: { includeSecrets?: boolean }) => Promise<ProjectSettings["mcp"] | null>;
  save: (settings: ProjectSettings["mcp"], options?: { preserveMissingSecrets?: boolean }) => Promise<void>;
} | null = null;

// Providers are an app/workstation preference (which model a developer wants
// to run this project through), not a fact about the codebase, so the full
// config (everything except the secret key, which never leaves the global
// secret store) lives only in local.json, never in the committed project.json.
export type LocalProviderState = Omit<ProjectSettings["providers"][number], "apiKey">;

export type ProjectLocalState = {
  schemaVersion: 1;
  rootPath: string;
  settings: {
    localEnvironment?: ProjectSettings["localEnvironment"];
    filesystem: ProjectSettings["filesystem"];
    autoApproveShellCommands?: ProjectSettings["autoApproveShellCommands"];
    allowedShellCommands: ProjectSettings["allowedShellCommands"];
    shellPolicies: ProjectSettings["shellPolicies"];
    providers: LocalProviderState[];
    // Personal/workstation preferences, not project facts: kept out of the
    // committed project.json the same way filesystem/shell trust already is.
    notifications?: ProjectSettings["notifications"];
    autoFocusSelectedNode?: ProjectSettings["autoFocusSelectedNode"];
    inspectorUtilityTabsExpanded?: ProjectSettings["inspectorUtilityTabsExpanded"];
    inspectorNodeAppearanceExpanded?: ProjectSettings["inspectorNodeAppearanceExpanded"];
    activityArtifactTabsExpanded?: ProjectSettings["activityArtifactTabsExpanded"];
    canvasBackground?: ProjectSettings["canvasBackground"];
    canvasEdgeStyle?: ProjectSettings["canvasEdgeStyle"];
    edgeLabelHistory?: ProjectSettings["edgeLabelHistory"];
    externalMcpHost?: {
      token?: string;
      updatedAt?: string;
    };
  };
  updatedAt: string;
};

export function setGlobalProviderSettingsStore(store: typeof globalProviderSettingsStore): void {
  globalProviderSettingsStore = store;
}

export function setGlobalMcpSettingsStore(store: typeof globalMcpSettingsStore): void {
  globalMcpSettingsStore = store;
}

export async function hydrateProviderForUse(
  provider: ProjectSettings["providers"][number]
): Promise<ProjectSettings["providers"][number]> {
  if (!globalProviderSettingsStore || provider.apiKey?.trim()) return provider;
  if (provider.kind !== "openai-compatible" && provider.kind !== "anthropic-compatible") return provider;
  const directSecret = await globalProviderSettingsStore.loadSecret?.(provider.id);
  if (directSecret) return { ...provider, apiKey: directSecret };
  const globalProviders = await globalProviderSettingsStore.load({ includeSecrets: true });
  const globalProvider = globalProviders?.find((item) => item.id === provider.id);
  return globalProvider?.apiKey?.trim() ? { ...provider, apiKey: globalProvider.apiKey } : provider;
}

export function defaultAgentShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  if (process.platform === "darwin") return "/bin/zsh";
  return process.env.SHELL || "/bin/bash";
}

export function defaultOperatingSystemLabel(): string {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "linux") return "Linux";
  return process.platform;
}

export function defaultLocalEnvironment(projectRoot: string): NonNullable<ProjectSettings["localEnvironment"]> {
  return {
    operatingSystem: defaultOperatingSystemLabel(),
    agentShell: defaultAgentShell(),
    projectRoot
  };
}

export function readLocalEnvironment(projectRoot: string, value: unknown): ProjectSettings["localEnvironment"] {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  return {
    operatingSystem: typeof candidate.operatingSystem === "string" && candidate.operatingSystem.trim()
      ? candidate.operatingSystem
      : defaultOperatingSystemLabel(),
    agentShell: typeof candidate.agentShell === "string" && candidate.agentShell.trim()
      ? candidate.agentShell
      : defaultAgentShell(),
    projectRoot: typeof candidate.projectRoot === "string" && candidate.projectRoot.trim()
      ? candidate.projectRoot
      : projectRoot
  };
}

export function defaultCodexLocalSandbox(): ProjectSettings["providers"][number]["localSandbox"] {
  return process.platform === "win32" ? "danger-full-access" : "workspace-write";
}

export function codexLocalSandboxDisplayLabel(value?: ProjectSettings["providers"][number]["localSandbox"]): string {
  if (value === "danger-full-access") return "full access";
  if (value === "workspace-write") return "workspace write";
  if (value === "read-only") return "read only";
  return "configured";
}

export function applyRuntimeProviderDefaults(project: Project): Project {
  return {
    ...project,
    settings: {
      ...project.settings,
      providers: project.settings.providers.map((provider) => {
        if (
          provider.id === "codex-local" &&
          provider.kind === "codex-local" &&
           provider.label === "Codex Local CLI" &&
          (provider.localCommand ?? "codex") === "codex"
        ) {
          return { ...provider, localSandbox: defaultCodexLocalSandbox() };
        }
        return provider;
      })
    }
  };
}

export function createEmptyCodebaseProject(projectRoot: string): { project: Project; flow: Flow } {
  const seed = createSeedProject(projectRoot);
  const createdAt = iso();
  const folderName = path.basename(projectRoot) || "Codebase";
  return {
    project: applyRuntimeProviderDefaults({
      ...seed.project,
      id: `project-${folderName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "codebase"}`,
      name: folderName,
      description: "Imported codebase workspace. Generate a map with AI or add nodes manually.",
      rootPath: projectRoot,
      activeFlowId: "flow-main",
      createdAt,
      updatedAt: createdAt
    }),
    flow: {
      id: "flow-main",
      name: "Codebase Map",
      description: "Empty map for an existing codebase.",
      ignored: false,
      nodes: [],
      edges: [],
      subflows: [],
      groups: [],
      updatedAt: createdAt
    }
  };
}

export function sharedProjectForDisk(project: Project): Project {
  return projectSchema.parse({
    ...project,
    rootPath: ".",
    settings: {
      ...project.settings,
      localEnvironment: undefined,
      filesystem: {
        ...project.settings.filesystem,
        allowedRoots: []
      },
      autoApproveShellCommands: true,
      allowedShellCommands: [],
      shellPolicies: [],
      // Which providers/models a developer runs this project through is a
      // workstation preference, not a fact about the codebase.
      providers: [],
      // MCP servers are an app-wide preference (see globalMcpSettingsStore),
      // not a project fact: never written to the shared file.
      mcp: undefined,
      // Personal app preferences: never dictated by the repo.
      notifications: undefined,
      autoFocusSelectedNode: undefined,
      inspectorUtilityTabsExpanded: undefined,
      inspectorNodeAppearanceExpanded: undefined,
      activityArtifactTabsExpanded: undefined,
      canvasBackground: undefined,
      canvasEdgeStyle: undefined,
      edgeLabelHistory: undefined
    }
  });
}

export function localProviderStateForDisk(provider: ProjectSettings["providers"][number]): LocalProviderState {
  const { apiKey, ...rest } = provider;
  return rest;
}

export function localProjectStateForDisk(projectRoot: string, project: Project, previous?: ProjectLocalState | null): ProjectLocalState {
  return {
    schemaVersion: 1,
    rootPath: projectRoot,
    settings: {
      localEnvironment: project.settings.localEnvironment ?? previous?.settings.localEnvironment ?? defaultLocalEnvironment(projectRoot),
      filesystem: project.settings.filesystem,
      autoApproveShellCommands: project.settings.autoApproveShellCommands,
      allowedShellCommands: project.settings.allowedShellCommands,
      shellPolicies: project.settings.shellPolicies,
      providers: project.settings.providers.map(localProviderStateForDisk),
      notifications: project.settings.notifications,
      autoFocusSelectedNode: project.settings.autoFocusSelectedNode,
      inspectorUtilityTabsExpanded: project.settings.inspectorUtilityTabsExpanded,
      inspectorNodeAppearanceExpanded: project.settings.inspectorNodeAppearanceExpanded,
      activityArtifactTabsExpanded: project.settings.activityArtifactTabsExpanded,
      canvasBackground: project.settings.canvasBackground,
      canvasEdgeStyle: project.settings.canvasEdgeStyle,
      edgeLabelHistory: project.settings.edgeLabelHistory,
      externalMcpHost: previous?.settings.externalMcpHost
    },
    updatedAt: iso()
  };
}


// Providers written by an older app version only carried a handful of runtime
// fields (no kind/label/model); those fail this full-shape validation and are
// dropped here, falling back to the shared project.json copy for that id
// until the next save re-derives the full local record (see applyLocalProjectState).
export const localProviderStateSchema = providerSettingsSchema.omit({ apiKey: true });

export function readLocalProviders(value: unknown): LocalProviderState[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => localProviderStateSchema.safeParse(item))
    .filter((result): result is { success: true; data: LocalProviderState } => result.success)
    .map((result) => result.data);
}

export async function readLocalProjectState(projectRoot: string): Promise<ProjectLocalState | null> {
  const raw = await readJson<Partial<ProjectLocalState> | null>(projectStatePath(projectRoot, LOCAL_PROJECT_STATE_FILE), null);
  if (!raw || raw.schemaVersion !== 1 || !raw.settings) return null;
  return {
    schemaVersion: 1,
    rootPath: typeof raw.rootPath === "string" ? raw.rootPath : projectRoot,
    settings: {
      localEnvironment: readLocalEnvironment(projectRoot, raw.settings.localEnvironment),
      filesystem: raw.settings.filesystem ?? {
        policy: "project-write",
        allowedRoots: [],
        blockOutsideProjectPaths: true
      },
      autoApproveShellCommands: typeof raw.settings.autoApproveShellCommands === "boolean" ? raw.settings.autoApproveShellCommands : undefined,
      allowedShellCommands: Array.isArray(raw.settings.allowedShellCommands) ? raw.settings.allowedShellCommands : [],
      shellPolicies: Array.isArray(raw.settings.shellPolicies) ? raw.settings.shellPolicies : [],
      providers: readLocalProviders(raw.settings.providers),
      notifications: safeParseOptional(notificationSettingsSchema, raw.settings.notifications),
      autoFocusSelectedNode: typeof raw.settings.autoFocusSelectedNode === "boolean" ? raw.settings.autoFocusSelectedNode : undefined,
      inspectorUtilityTabsExpanded: typeof raw.settings.inspectorUtilityTabsExpanded === "boolean" ? raw.settings.inspectorUtilityTabsExpanded : undefined,
      inspectorNodeAppearanceExpanded: typeof raw.settings.inspectorNodeAppearanceExpanded === "boolean" ? raw.settings.inspectorNodeAppearanceExpanded : undefined,
      activityArtifactTabsExpanded: typeof raw.settings.activityArtifactTabsExpanded === "boolean" ? raw.settings.activityArtifactTabsExpanded : undefined,
      canvasBackground: safeParseOptional(canvasBackgroundSchema, raw.settings.canvasBackground),
      canvasEdgeStyle: safeParseOptional(canvasEdgeStyleSchema, raw.settings.canvasEdgeStyle),
      edgeLabelHistory: Array.isArray(raw.settings.edgeLabelHistory) ? raw.settings.edgeLabelHistory : undefined,
      externalMcpHost: raw.settings.externalMcpHost && typeof raw.settings.externalMcpHost === "object"
        ? {
            token: typeof raw.settings.externalMcpHost.token === "string" ? raw.settings.externalMcpHost.token : undefined,
            updatedAt: typeof raw.settings.externalMcpHost.updatedAt === "string" ? raw.settings.externalMcpHost.updatedAt : undefined
          }
        : undefined
    },
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : iso()
  };
}

export function applyLocalProjectState(projectRoot: string, project: Project, local: ProjectLocalState | null): Project {
  const diskProviderById = new Map(project.settings.providers.map((provider) => [provider.id, provider]));
  const localProviderById = new Map((local?.settings.providers ?? []).map((provider) => [provider.id, provider]));
  const providerIds = [...new Set([...diskProviderById.keys(), ...localProviderById.keys()])];
  const providers = providerIds.map((providerId) => ({
    ...diskProviderById.get(providerId),
    ...definedOnly(localProviderById.get(providerId) ?? {})
  })) as unknown as ProjectSettings["providers"];

  return projectSchema.parse({
    ...project,
    rootPath: projectRoot,
    settings: {
      ...project.settings,
      filesystem: local?.settings.filesystem ?? project.settings.filesystem,
      localEnvironment: local?.settings.localEnvironment ?? defaultLocalEnvironment(projectRoot),
      autoApproveShellCommands: local?.settings.autoApproveShellCommands ?? project.settings.autoApproveShellCommands,
      allowedShellCommands: local?.settings.allowedShellCommands ?? project.settings.allowedShellCommands,
      shellPolicies: local?.settings.shellPolicies ?? project.settings.shellPolicies,
      providers,
      notifications: local?.settings.notifications ?? project.settings.notifications,
      autoFocusSelectedNode: local?.settings.autoFocusSelectedNode ?? project.settings.autoFocusSelectedNode,
      inspectorUtilityTabsExpanded: local?.settings.inspectorUtilityTabsExpanded ?? project.settings.inspectorUtilityTabsExpanded,
      inspectorNodeAppearanceExpanded: local?.settings.inspectorNodeAppearanceExpanded ?? project.settings.inspectorNodeAppearanceExpanded,
      activityArtifactTabsExpanded: local?.settings.activityArtifactTabsExpanded ?? project.settings.activityArtifactTabsExpanded,
      canvasBackground: local?.settings.canvasBackground ?? project.settings.canvasBackground,
      canvasEdgeStyle: local?.settings.canvasEdgeStyle ?? project.settings.canvasEdgeStyle,
      edgeLabelHistory: local?.settings.edgeLabelHistory ?? project.settings.edgeLabelHistory
    }
  });
}

export async function writeProjectFiles(projectRoot: string, project: Project): Promise<void> {
  const parsed = projectSchema.parse({
    ...project,
    rootPath: projectRoot
  });
  const previousLocal = await readLocalProjectState(projectRoot);
  await writeJson(projectStatePath(projectRoot, "project.json"), sharedProjectForDisk(parsed));
  await writeJson(projectStatePath(projectRoot, LOCAL_PROJECT_STATE_FILE), localProjectStateForDisk(projectRoot, parsed, previousLocal));
}

export function createExternalMcpHostToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function writeExternalMcpHostLocalState(
  projectRoot: string,
  patch: NonNullable<ProjectLocalState["settings"]["externalMcpHost"]>
): Promise<NonNullable<ProjectLocalState["settings"]["externalMcpHost"]>> {
  const bundle = await loadProject(projectRoot);
  const current = await readLocalProjectState(projectRoot);
  const next = localProjectStateForDisk(projectRoot, bundle.project, current);
  next.settings.externalMcpHost = {
    ...current?.settings.externalMcpHost,
    ...patch,
    updatedAt: iso()
  };
  await writeJson(projectStatePath(projectRoot, LOCAL_PROJECT_STATE_FILE), next);
  return next.settings.externalMcpHost;
}

export async function ensureExternalMcpHostToken(projectRoot: string): Promise<string> {
  await ensureProject(projectRoot);
  const current = await readLocalProjectState(projectRoot);
  const token = current?.settings.externalMcpHost?.token;
  if (token) return token;
  return (await writeExternalMcpHostLocalState(projectRoot, { token: createExternalMcpHostToken() })).token!;
}

export async function regenerateExternalMcpHostToken(projectRoot: string): Promise<string> {
  await ensureProject(projectRoot);
  return (await writeExternalMcpHostLocalState(projectRoot, { token: createExternalMcpHostToken() })).token!;
}

export async function ensureProjectDirectories(projectRoot: string): Promise<void> {
  await mkdir(projectStatePath(projectRoot, "flows"), { recursive: true });
  await mkdir(projectStatePath(projectRoot, "runs"), { recursive: true });
  await mkdir(projectStatePath(projectRoot, "incidents"), { recursive: true });
  await mkdir(projectStatePath(projectRoot, "artifacts"), { recursive: true });
  await mkdir(projectStatePath(projectRoot, "references"), { recursive: true });
  await mkdir(projectStatePath(projectRoot, "summaries"), { recursive: true });
  await mkdir(projectStatePath(projectRoot, "memory"), { recursive: true });
  await mkdir(projectStatePath(projectRoot, "memory-notes"), { recursive: true });
  await mkdir(projectStatePath(projectRoot, "manifests"), { recursive: true });
  await mkdir(projectStatePath(projectRoot, "reviews"), { recursive: true });
}

export async function ensureArchicodeGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const block = ["# ArchiCode local state", ...PROJECT_STATE_LOCAL_GITIGNORE_PATTERNS];
  if (!(await exists(gitignorePath))) {
    await writeFile(gitignorePath, `${[...DEFAULT_PROJECT_GITIGNORE_PATTERNS, "", ...block].join("\n")}\n`, "utf8");
    return;
  }

  const content = await readFile(gitignorePath, "utf8");
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = PROJECT_STATE_LOCAL_GITIGNORE_PATTERNS.filter((pattern) => !lines.has(pattern));
  if (!missing.length) return;
  const prefix = content.endsWith("\n") ? "" : "\n";
  const heading = lines.has("# ArchiCode local state") ? [] : ["", "# ArchiCode local state"];
  await writeFile(gitignorePath, `${content}${prefix}${[...heading, ...missing].join("\n")}\n`, "utf8");
}

export async function archicodeGitAttributesStatus(projectRoot: string): Promise<"enabled" | "missing" | "conflicting"> {
  const attributesPath = path.join(projectRoot, ".gitattributes");
  if (!(await exists(attributesPath))) return "missing";
  const content = await readFile(attributesPath, "utf8");
  const rules = content.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  let missing = false;
  for (const rule of ARCHICODE_GIT_ATTRIBUTES_RULES) {
    const rulePath = rule.split(/\s+/)[0]!;
    const matching = rules.filter((line) => line.split(/\s+/)[0] === rulePath);
    if (matching.some((line) => line !== rule)) return "conflicting";
    if (!matching.length) missing = true;
  }
  return missing ? "missing" : "enabled";
}

export async function enableArchicodeGitAttributes(projectRoot: string): Promise<"enabled" | "conflicting"> {
  const status = await archicodeGitAttributesStatus(projectRoot);
  if (status === "conflicting") return status;
  const attributesPath = path.join(projectRoot, ".gitattributes");
  if (status !== "enabled") {
    const content = (await exists(attributesPath)) ? await readFile(attributesPath, "utf8") : "";
    const existing = new Set(content.split(/\r?\n/).map((line) => line.trim()));
    const missing = ARCHICODE_GIT_ATTRIBUTES_RULES.filter((rule) => !existing.has(rule));
    const prefix = content && !content.endsWith("\n") ? "\n" : "";
    const heading = content.includes("# ArchiCode merge rules") ? "" : `${content ? "\n" : ""}# ArchiCode merge rules\n`;
    await writeFile(attributesPath, `${content}${prefix}${heading}${missing.join("\n")}\n`, "utf8");
  }
  return "enabled";
}

export async function ensureProjectGitignoreDefaults(projectRoot: string): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const patterns = [...DEFAULT_PROJECT_GITIGNORE_PATTERNS, ...PROJECT_STATE_LOCAL_GITIGNORE_PATTERNS];
  if (!(await exists(gitignorePath))) {
    await writeFile(gitignorePath, `${patterns.join("\n")}\n`, "utf8");
    return true;
  }

  const content = await readFile(gitignorePath, "utf8");
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = patterns.filter((pattern) => !lines.has(pattern));
  if (!missing.length) return false;
  const prefix = content.endsWith("\n") ? "" : "\n";
  await writeFile(gitignorePath, `${content}${prefix}${missing.join("\n")}\n`, "utf8");
  return false;
}

export async function deleteProjectState(projectRoot: string): Promise<boolean> {
  const projectDir = path.resolve(projectRoot);
  const stateDir = path.resolve(projectDir, PROJECT_STATE_DIR);
  if (stateDir !== path.join(projectDir, PROJECT_STATE_DIR)) {
    throw new Error("Refusing to delete anything except the project .archicode folder.");
  }
  await rm(stateDir, { recursive: true, force: true });
  const { deleteResearchProjectState } = await import("../research/chatStore");
  await deleteResearchProjectState(projectRoot);
  return true;
}

export function mergeProvidersWithGlobal(
  projectProviders: ProjectSettings["providers"],
  globalProviders: ProjectSettings["providers"]
): ProjectSettings["providers"] {
  const globalById = new Map(globalProviders.map((provider) => [provider.id, provider]));
  const projectIds = new Set(projectProviders.map((provider) => provider.id));
  return [
    ...projectProviders.map((provider) => globalById.get(provider.id) ? { ...provider, ...globalById.get(provider.id) } : provider),
    ...globalProviders.filter((provider) => !projectIds.has(provider.id))
  ];
}

export async function applyGlobalProviderSettings(project: Project): Promise<Project> {
  if (!globalProviderSettingsStore) return project;
  const globalProviders = await globalProviderSettingsStore.load({ includeSecrets: false });
  if (!globalProviders?.length) {
    return project;
  }
  const providers = mergeProvidersWithGlobal(project.settings.providers, globalProviders);
  if (JSON.stringify(providers) === JSON.stringify(project.settings.providers)) return project;
  return projectSchema.parse({
    ...project,
    settings: {
      ...project.settings,
      providers
    }
  });
}

// MCP servers are a single app-wide list (unlike providers, which merge
// project-local entries with global ones). If nothing has been saved to the
// global store yet, this project's existing servers become the seed for it
// so upgrading doesn't silently drop configured servers; from then on every
// project's mcp settings are a full replace from the global store.
export async function applyGlobalMcpSettings(project: Project): Promise<Project> {
  if (!globalMcpSettingsStore) return project;
  const globalMcp = await globalMcpSettingsStore.load({ includeSecrets: true });
  if (!globalMcp) {
    if (project.settings.mcp.servers.length) {
      await globalMcpSettingsStore.save(project.settings.mcp, { preserveMissingSecrets: true });
    }
    return project;
  }
  if (JSON.stringify(globalMcp) === JSON.stringify(project.settings.mcp)) return project;
  return projectSchema.parse({
    ...project,
    settings: {
      ...project.settings,
      mcp: globalMcp
    }
  });
}

export async function ensureProject(projectRoot: string): Promise<ProjectBundle> {
  await ensureProjectDirectories(projectRoot);
  await ensureArchicodeGitignore(projectRoot);

  const projectFile = projectStatePath(projectRoot, "project.json");
  if (!(await exists(projectFile))) {
    const seed = createSeedProject(projectRoot);
    const project = applyCommandSettings(applyRuntimeProviderDefaults(seed.project), await inferCommandSettings(projectRoot));
    await writeProjectFiles(projectRoot, project);
    await writeJson(projectStatePath(projectRoot, "flows", `${seed.flow.id}.json`), seed.flow);
    await writeNotes(projectRoot, [
      {
        id: "note-seed-question",
        flowId: "flow-main",
        nodeId: "node-orchestrator",
        kind: "llm-question",
        author: "llm",
        body: "Which provider should be made active first: direct OpenAI-compatible calls or a local/offline review workflow?",
        category: "note",
	        priority: "normal",
	        attachmentIds: [],
	        resolved: false,
	        pinned: false,
	        createdAt: iso()
	      }
    ] satisfies Note[]);
    await enableArchicodeGitAttributes(projectRoot);
  }

  const bundle = await loadProject(projectRoot);
  await migrateLegacyGeneratedAgentInstructions(projectRoot, bundle).catch(() => false);
  return bundle;
}

export async function ensureEmptyCodebaseProject(projectRoot: string): Promise<ProjectBundle> {
  await ensureProjectDirectories(projectRoot);
  await ensureArchicodeGitignore(projectRoot);

  const projectFile = projectStatePath(projectRoot, "project.json");
  if (!(await exists(projectFile))) {
    const empty = createEmptyCodebaseProject(projectRoot);
    const project = applyCommandSettings(empty.project, await inferCommandSettings(projectRoot));
    await writeProjectFiles(projectRoot, project);
    await writeJson(projectStatePath(projectRoot, "flows", `${empty.flow.id}.json`), empty.flow);
    await enableArchicodeGitAttributes(projectRoot);
  }

  const bundle = await loadProject(projectRoot);
  await migrateLegacyGeneratedAgentInstructions(projectRoot, bundle).catch(() => false);
  return bundle;
}

export async function createProject(projectRoot: string, templateId: ProjectTemplateId): Promise<ProjectBundle> {
  await ensureProjectDirectories(projectRoot);
  await ensureArchicodeGitignore(projectRoot);

  const projectFile = projectStatePath(projectRoot, "project.json");
  if (await exists(projectFile)) {
    throw new Error("This folder already contains an ArchiCode project. Open it or choose an empty folder.");
  }

  const template = createProjectFromTemplate(projectRoot, templateId);
  const project = applyCommandSettings(template.project, await inferCommandSettings(projectRoot));
  await writeProjectFiles(projectRoot, project);
  await writeJson(projectStatePath(projectRoot, "flows", `${template.flow.id}.json`), template.flow);
  await writeNotes(projectRoot, [
    {
      id: "note-first-run",
      flowId: template.flow.id,
      nodeId: template.flow.nodes[0]?.id ?? "node-project",
      kind: "system-note",
      author: "system",
      body: `Project created from the ${templateId} template.`,
      category: "note",
	      priority: "normal",
	      attachmentIds: [],
	      resolved: false,
	      pinned: false,
	      createdAt: iso()
	    }
  ] satisfies Note[]);
  await enableArchicodeGitAttributes(projectRoot);
  const bundle = await loadProject(projectRoot);
  await migrateLegacyGeneratedAgentInstructions(projectRoot, bundle).catch(() => false);
  return bundle;
}

export type ImplementationFileMapping = {
  nodeId: string;
  path: string;
  action: "create" | "replace" | "delete";
  expectedContent?: string;
};

export function normalizeImplementationFilePath(value: string): string | null {
  const candidate = value.trim().replaceAll("\\", "/");
  if (!candidate || candidate.startsWith("/") || /^[a-z]:\//i.test(candidate)) return null;
  const normalized = path.posix.normalize(candidate).replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../") || normalized === ".archicode" || normalized.startsWith(".archicode/")) return null;
  return normalized;
}

export function applyImplementationFileMappings(
  flow: Flow,
  runId: string,
  rawMappings: ImplementationFileMapping[],
  options: { coverProjectRoot?: boolean; checkedAt?: string } = {}
): Flow {
  const checkedAt = options.checkedAt ?? iso();
  const validNodeIds = new Set(flow.nodes.map((node) => node.id));
  const latestByNodePath = new Map<string, ImplementationFileMapping>();
  for (const mapping of rawMappings) {
    const normalizedPath = normalizeImplementationFilePath(mapping.path);
    if (!normalizedPath || !validNodeIds.has(mapping.nodeId)) continue;
    const normalized = { ...mapping, path: normalizedPath };
    latestByNodePath.set(`${mapping.nodeId}\u0000${normalizedPath}`, normalized);
  }
  const mappings = [...latestByNodePath.values()];
  if (!mappings.length && !options.coverProjectRoot) return flow;

  const affectedPaths = new Set(mappings.map((mapping) => mapping.path));
  const ownersByPath = new Map<string, Set<string>>();
  const ownerSet = (filePath: string): Set<string> => {
    const existing = ownersByPath.get(filePath) ?? new Set<string>();
    ownersByPath.set(filePath, existing);
    return existing;
  };
  for (const node of flow.nodes) {
    for (const claim of node.implementationScope?.claims ?? []) {
      if (affectedPaths.has(claim.path)) ownerSet(claim.path).add(node.id);
    }
  }
  for (const mapping of mappings) {
    if (mapping.action === "delete") ownerSet(mapping.path).delete(mapping.nodeId);
    else ownerSet(mapping.path).add(mapping.nodeId);
  }

  const mappingsByNode = new Map<string, ImplementationFileMapping[]>();
  for (const mapping of mappings) {
    const entries = mappingsByNode.get(mapping.nodeId) ?? [];
    entries.push(mapping);
    mappingsByNode.set(mapping.nodeId, entries);
  }

  let changed = false;
  const nodes = flow.nodes.map((node) => {
    const nodeMappings = mappingsByNode.get(node.id) ?? [];
    const coversProjectRoot = options.coverProjectRoot === true && node.type === "project";
    const existingScope = node.implementationScope;
    const existingClaims = existingScope?.claims ?? [];
    const deletedPaths = new Set(nodeMappings.filter((mapping) => mapping.action === "delete").map((mapping) => mapping.path));
    const addedPaths = [...new Set(nodeMappings.filter((mapping) => mapping.action !== "delete").map((mapping) => mapping.path))];
    const retained = existingClaims
      .filter((claim) => !deletedPaths.has(claim.path))
      .filter((claim) => !(addedPaths.includes(claim.path) && claim.kind === "file"))
      .map((claim) => affectedPaths.has(claim.path) && claim.kind === "file"
        ? { ...claim, relation: (ownersByPath.get(claim.path)?.size ?? 0) > 1 ? "share" as const : claim.relation === "cover" ? "cover" as const : "own" as const }
        : claim);
    const newClaims: ImplementationScopeClaim[] = addedPaths.map((filePath) => ({
      relation: (ownersByPath.get(filePath)?.size ?? 0) > 1 ? "share" : "own",
      kind: "file",
      path: filePath
    }));
    const projectClaims: ImplementationScopeClaim[] = coversProjectRoot
      ? [{ relation: "cover", kind: "directory", path: "." }]
      : [];
    const claims = [...projectClaims, ...newClaims, ...retained]
      .filter((claim, index, all) => all.findIndex((candidate) => candidate.kind === claim.kind && candidate.path === claim.path && candidate.symbol === claim.symbol) === index)
      .slice(0, 24);
    const nodeChanged = JSON.stringify(claims) !== JSON.stringify(existingClaims) ||
      ((nodeMappings.length > 0 || coversProjectRoot) && (
        existingScope?.source !== "implementation-agent" ||
        existingScope.updatedByRunId !== runId ||
        existingScope.checkedAt !== checkedAt
      ));
    if (!nodeChanged) return node;
    changed = true;
    return {
      ...node,
      implementationScope: {
        source: "implementation-agent" as const,
        updatedByRunId: runId,
        checkedAt,
        claims
      },
      updatedAt: iso()
    };
  });
  return changed ? flowSchema.parse({ ...flow, nodes, updatedAt: iso() }) : flow;
}

export function implementationMappingsFromAppliedArtifact(value: unknown): { runId: string; mappings: ImplementationFileMapping[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.status !== "applied") return null;
  const patch = record.archicodePatch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return null;
  const patchRecord = patch as Record<string, unknown>;
  if (typeof patchRecord.runId !== "string" || !Array.isArray(patchRecord.operations)) return null;
  const mappings = patchRecord.operations.flatMap((operation): ImplementationFileMapping[] => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return [];
    const item = operation as Record<string, unknown>;
    if (item.kind !== "propose-source-file" || typeof item.path !== "string") return [];
    if (item.action !== "create" && item.action !== "replace" && item.action !== "delete") return [];
    const filePath = item.path;
    const action = item.action;
    const nodeIds = [...new Set([
      ...(Array.isArray(item.nodeIds) ? item.nodeIds.filter((value): value is string => typeof value === "string") : []),
      ...(typeof item.nodeId === "string" ? [item.nodeId] : [])
    ])];
    return nodeIds.map((nodeId) => ({
      nodeId,
      path: filePath,
      action,
      expectedContent: typeof item.content === "string" ? item.content : undefined
    }));
  });
  return mappings.length ? { runId: patchRecord.runId, mappings } : null;
}

export async function backfillImplementationScopesFromArtifacts(projectRoot: string, flows: Flow[], runs: Run[], artifactValues: unknown[]): Promise<Flow[]> {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const originalById = new Map(flows.map((flow) => [flow.id, flow]));
  const nextById = new Map(flows.map((flow) => [flow.id, flow]));
  // Recovery is intentionally narrower than normal run-time maintenance. Only
  // nodes with no scope object at all are eligible: an importer, agent, chat,
  // user, or even explicit empty scope is treated as healthy existing data and
  // never overwritten by historical artifacts during project load.
  const eligibleNodeIdsByFlow = new Map(flows.map((flow) => [
    flow.id,
    new Set(flow.nodes
      .filter((node) => node.implementationScope === undefined)
      .map((node) => node.id))
  ]));
  const checkedAt = iso();
  const orderedArtifacts = [...artifactValues].sort((left, right) => {
    const leftAt = left && typeof left === "object" && !Array.isArray(left) && typeof (left as Record<string, unknown>).createdAt === "string" ? (left as Record<string, unknown>).createdAt as string : "";
    const rightAt = right && typeof right === "object" && !Array.isArray(right) && typeof (right as Record<string, unknown>).createdAt === "string" ? (right as Record<string, unknown>).createdAt as string : "";
    return leftAt.localeCompare(rightAt);
  });
  for (const artifact of orderedArtifacts) {
    const extracted = implementationMappingsFromAppliedArtifact(artifact);
    if (!extracted) continue;
    const run = runById.get(extracted.runId);
    if (!run || run.status !== "succeeded") continue;
    const flow = nextById.get(run.flowId);
    if (!flow) continue;
    const eligibleNodeIds = eligibleNodeIdsByFlow.get(flow.id) ?? new Set<string>();
    const mappings = (await Promise.all(extracted.mappings.map(async (mapping): Promise<ImplementationFileMapping | null> => {
      if (!eligibleNodeIds.has(mapping.nodeId) || mapping.action === "delete" || mapping.expectedContent === undefined) return null;
      const normalizedPath = normalizeImplementationFilePath(mapping.path);
      if (!normalizedPath) return null;
      try {
        const currentContent = await readFile(path.resolve(projectRoot, normalizedPath), "utf8");
        return currentContent === proposedSourceContent(mapping.expectedContent) ? mapping : null;
      } catch {
        return null;
      }
    }))).filter((mapping): mapping is ImplementationFileMapping => Boolean(mapping));
    const projectNode = flow.nodes.find((node) => node.type === "project");
    const coverProjectRoot = run.scope?.kind === "project" && mappings.length > 0 && Boolean(projectNode && eligibleNodeIds.has(projectNode.id));
    if (!mappings.length && !coverProjectRoot) continue;
    nextById.set(flow.id, applyImplementationFileMappings(flow, run.id, mappings, { coverProjectRoot, checkedAt }));
  }
  const nextFlows = flows.map((flow) => nextById.get(flow.id) ?? flow);
  for (const flow of nextFlows) {
    if (JSON.stringify(flow) === JSON.stringify(originalById.get(flow.id))) continue;
    await writeJson(projectStatePath(projectRoot, "flows", `${flow.id}.json`), flowSchema.parse(flow));
  }
  return nextFlows;
}

export async function persistImplementationFileMappings(projectRoot: string, runId: string, mappings: ImplementationFileMapping[]): Promise<void> {
  const run = await readRun(projectRoot, runId).catch(() => null);
  if (!run) return;
  if (!mappings.length && run.scope?.kind !== "project") return;
  const flowPath = projectStatePath(projectRoot, "flows", `${run.flowId}.json`);
  const flow = flowSchema.safeParse(await readJson(flowPath, null));
  if (!flow.success) return;
  const nextFlow = applyImplementationFileMappings(flow.data, run.id, mappings, {
    coverProjectRoot: run.scope?.kind === "project",
    checkedAt: iso()
  });
  if (nextFlow === flow.data) return;
  await writeJson(flowPath, nextFlow);
}

export async function refreshEdgeEvidenceFreshness(projectRoot: string, flows: Flow[]): Promise<Flow[]> {
  const normalizedRoot = path.resolve(projectRoot);
  const paths = [...new Set(flows.flatMap((flow) => flow.edges.flatMap((edge) =>
    edge.evidence?.locations.map((location) => location.path) ?? []
  )))];
  const changedAfter = new Map<string, number | null>();
  for (let offset = 0; offset < paths.length; offset += 64) {
    await Promise.all(paths.slice(offset, offset + 64).map(async (relativePath) => {
      const absolutePath = path.resolve(normalizedRoot, relativePath);
      if (absolutePath !== normalizedRoot && !absolutePath.startsWith(`${normalizedRoot}${path.sep}`)) {
        changedAfter.set(relativePath, null);
        return;
      }
      try {
        changedAfter.set(relativePath, (await stat(absolutePath)).mtimeMs);
      } catch {
        changedAfter.set(relativePath, null);
      }
    }));
  }
  return flows.map((flow) => ({
    ...flow,
    edges: flow.edges.map((edge) => {
      const evidence = edge.evidence;
      if (!evidence?.checkedAt || !evidence.locations.length) return edge;
      const checkedAt = Date.parse(evidence.checkedAt);
      const stale = evidence.locations.some((location) => {
        const modifiedAt = changedAfter.get(location.path);
        return modifiedAt === null || (modifiedAt !== undefined && modifiedAt > checkedAt);
      });
      const freshness = stale || evidence.verification !== "verified" ? "stale" as const : "current" as const;
      return evidence.freshness === freshness ? edge : { ...edge, evidence: { ...evidence, freshness } };
    })
  }));
}

export async function loadProject(projectRoot: string): Promise<ProjectBundle> {
  await recoverPendingResyncTransactions(projectRoot);
  const validationErrors: string[] = [];
  const projectRaw = await readJson<Project | null>(projectStatePath(projectRoot, "project.json"), null);

  if (!projectRaw) {
    return ensureProject(projectRoot);
  }

  const flowsRaw = await readJsonDirectory<Flow>(projectStatePath(projectRoot, "flows"));
  const flowsNeedDependencyMigration = flowsRaw.some((flow) =>
    Array.isArray((flow as { nodes?: unknown[] }).nodes) &&
    (flow as { nodes: unknown[] }).nodes.some((node) =>
      Boolean(node) &&
      typeof node === "object" &&
      Object.prototype.hasOwnProperty.call(node as Record<string, unknown>, "dependencies")
    )
  );
  const notesRaw = await readNotes(projectRoot);
  const incidentsRaw = await readJsonDirectory<DebugIncident>(projectStatePath(projectRoot, "incidents"));
  const runsRaw = await readJsonDirectory<Run>(projectStatePath(projectRoot, "runs"));
  const artifactsRaw = await readJsonDirectory<Artifact>(projectStatePath(projectRoot, "artifacts"));
  // Committed, shareable node-note reference attachments live outside the
  // ignored artifacts bucket; merge them into bundle.artifacts so readers
  // resolve them the same way (see createAttachmentArtifacts destination).
  const referencesRaw = await readJsonDirectory<Artifact>(projectStatePath(projectRoot, "references"));
  const summariesRaw = await readJsonDirectory<Artifact>(projectStatePath(projectRoot, "summaries"));
  const graphChangesRaw = await readGraphChanges(projectRoot);
  const policyEvaluation = await readArchitecturePolicyEvaluation(projectRoot);

  const fallback = createSeedProject(projectRoot);
  const diskProject = safeParseOne("project.json", projectSchema, projectRaw, validationErrors) ?? fallback.project;
  const localProjectState = await readLocalProjectState(projectRoot);
  let project = applyLocalProjectState(projectRoot, diskProject, localProjectState);
  let migratedProject = migrateProject(project, fallback.project);
  migratedProject = await migrateLegacyCommandDefaults(projectRoot, migratedProject);
  migratedProject = await migrateMissingRunProfiles(projectRoot, migratedProject);
  migratedProject = migrateKnownRunProfiles(migratedProject);
  migratedProject = await applyGlobalProviderSettings(migratedProject);
  migratedProject = await applyGlobalMcpSettings(migratedProject);
  migratedProject = projectSchema.parse({
    ...migratedProject,
    settings: {
      ...migratedProject.settings,
      providers: migratedProject.settings.providers.map(migrateDefaultPhaseModelPolicies)
    }
  });
  if (
    JSON.stringify(sharedProjectForDisk(migratedProject)) !== JSON.stringify(sharedProjectForDisk(diskProject)) ||
    !localProjectState ||
    JSON.stringify(localProjectStateForDisk(projectRoot, migratedProject).settings) !== JSON.stringify(localProjectState.settings)
  ) {
    project = migratedProject;
    await writeProjectFiles(projectRoot, project);
  } else {
    project = migratedProject;
  }
  const parsedFlows = flowsRaw
    .flatMap((flow, index) => safeParseMany(`flows/${index}`, flowSchema, flow, validationErrors))
    .map(normalizeEvidenceFlow);
  const notes = notesRaw.flatMap((note, index) => safeParseMany(`notes.jsonl:${index + 1}`, noteSchema, note, validationErrors));
  const incidents = incidentsRaw.flatMap((incident, index) => safeParseMany(`incidents/${index}`, debugIncidentSchema, incident, validationErrors));
  const parsedRuns = runsRaw.flatMap((run, index) => safeParseMany(`runs/${index}`, runSchema, run, validationErrors));
  const runs: Run[] = [];
  for (const parsedRun of parsedRuns) runs.push(await hydrateRunLogs(projectRoot, parsedRun));
  const flows = await refreshEdgeEvidenceFreshness(
    projectRoot,
    await hydrateGraphEvidenceLocalState(
      projectRoot,
      await backfillImplementationScopesFromArtifacts(projectRoot, parsedFlows, runs, artifactsRaw)
    )
  );
  const graphChanges = graphChangesRaw.flatMap((change, index) => safeParseMany(`graph-changes.jsonl:${index + 1}`, graphChangeRecordSchema, change, validationErrors));
  const reconciledRuns = await reconcileOrphanedInProgressRuns(projectRoot, runs);
  const reconciledFlows = await reconcileVerifiedNodeBuildFlags(projectRoot, flows.length ? flows : [fallback.flow], reconciledRuns);
  const sweptGraphChanges = await reconcileObsoleteGraphChanges(projectRoot, reconciledFlows, graphChanges);
  const reconciledGraphChanges = await compactGraphChangeLedger(projectRoot, sweptGraphChanges, project.settings.graphChangeRetention);
  if (flowsNeedDependencyMigration) {
    for (const flow of reconciledFlows) {
      await writeJson(projectStatePath(projectRoot, "flows", `${flow.id}.json`), flowSchema.parse(flow));
    }
  }

  const graphVersion = computeGraphVersion(reconciledFlows);
  if (project.graphVersion !== graphVersion) {
    project = projectSchema.parse({ ...project, graphVersion });
    await writeProjectFiles(projectRoot, project);
  }

  return projectBundleSchema.parse({
    rootPath: projectRoot,
    project,
    flows: reconciledFlows,
    notes,
    incidents,
    runs: reconciledRuns,
    artifacts: [...artifactsRaw, ...referencesRaw],
    summaries: summariesRaw,
    graphChanges: reconciledGraphChanges,
    policyEvaluation,
    validationErrors
  });
}

export async function migrateLegacyCommandDefaults(projectRoot: string, project: Project): Promise<Project> {
  const settings = project.settings;
  const hasLegacyNpmDefaults = settings.defaultBuildCommand === "npm run build" &&
    settings.defaultRunCommand === "npm run dev" &&
    JSON.stringify(settings.allowedShellCommands) === JSON.stringify(LEGACY_NPM_COMMANDS);

  if (!hasLegacyNpmDefaults) return project;

  return applyCommandSettings(project, await inferCommandSettings(projectRoot));
}

export async function migrateMissingRunProfiles(projectRoot: string, project: Project): Promise<Project> {
  if (project.settings.buildTargetsLocked) return project;
  const inferred = await inferCommandSettings(projectRoot);
  if (!inferred.runTargetProfiles.length) return project;
  const runTargetProfiles = mergeRunTargetProfiles(project.settings.runTargetProfiles, inferred.runTargetProfiles);
  if (runTargetProfiles === project.settings.runTargetProfiles) return project;
  return projectSchema.parse({
    ...project,
    settings: {
      ...project.settings,
      runTargetProfiles
    },
    updatedAt: iso()
  });
}

export function migrateKnownRunProfiles(project: Project): Project {
  if (project.settings.buildTargetsLocked) return project;
  const builtIns = new Map([...flutterRunTargetProfiles].map((profile) => [profile.id, profile]));
  let changed = false;
  const runTargetProfiles = project.settings.runTargetProfiles.map((profile) => {
    const builtIn = builtIns.get(profile.id);
    if (!builtIn) return profile;
    const upgraded = {
      ...builtIn,
      label: profile.label || builtIn.label,
      description: profile.description || builtIn.description
    };
    if (JSON.stringify(upgraded) !== JSON.stringify(profile)) changed = true;
    return upgraded;
  });
  if (!changed) return project;
  return projectSchema.parse({
    ...project,
    settings: {
      ...project.settings,
      runTargetProfiles
    },
    updatedAt: iso()
  });
}

export const legacyPhaseModelPolicies = [
  {
    planning: { temperature: 0.2, reasoningMode: "high", maxOutputTokens: 2400, enabledTools: [] },
    coding: { temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 3200, enabledTools: [] },
    debugging: { temperature: 0.0, reasoningMode: "high", maxOutputTokens: 3200, enabledTools: [] },
    review: { temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 2200, enabledTools: [] },
    verifying: { temperature: 0.0, reasoningMode: "low", maxOutputTokens: 1200, enabledTools: [] },
    summarizing: { temperature: 0.1, reasoningMode: "low", maxOutputTokens: 1600, enabledTools: [] },
    brainstorming: { temperature: 0.6, reasoningMode: "medium", maxOutputTokens: 2600, enabledTools: [] }
  },
  {
    planning: { temperature: 0.2, reasoningMode: "high", maxOutputTokens: 6000, enabledTools: [] },
    coding: { temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 16000, enabledTools: [] },
    debugging: { temperature: 0.0, reasoningMode: "high", maxOutputTokens: 12000, enabledTools: [] },
    review: { temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 5000, enabledTools: [] },
    verifying: { temperature: 0.0, reasoningMode: "low", maxOutputTokens: 2000, enabledTools: [] },
    summarizing: { temperature: 0.1, reasoningMode: "low", maxOutputTokens: 2400, enabledTools: [] },
    brainstorming: { temperature: 0.6, reasoningMode: "medium", maxOutputTokens: 5000, enabledTools: [] }
  },
  {
    planning: { temperature: 0.2, reasoningMode: "high", maxOutputTokens: 8000, enabledTools: [] },
    coding: { temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 32000, enabledTools: [] },
    debugging: { temperature: 0.0, reasoningMode: "high", maxOutputTokens: 24000, enabledTools: [] },
    review: { temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 8000, enabledTools: [] },
    verifying: { temperature: 0.0, reasoningMode: "low", maxOutputTokens: 3000, enabledTools: [] },
    summarizing: { temperature: 0.1, reasoningMode: "low", maxOutputTokens: 4000, enabledTools: [] },
    brainstorming: { temperature: 0.6, reasoningMode: "medium", maxOutputTokens: 8000, enabledTools: [] }
  },
  {
    planning: { temperature: 0.2, reasoningMode: "high", maxOutputTokens: 16000, enabledTools: [] },
    coding: { temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 64000, enabledTools: [] },
    debugging: { temperature: 0.0, reasoningMode: "high", maxOutputTokens: 32000, enabledTools: [] },
    review: { temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 12000, enabledTools: [] },
    verifying: { temperature: 0.0, reasoningMode: "low", maxOutputTokens: 4000, enabledTools: [] },
    summarizing: { temperature: 0.1, reasoningMode: "low", maxOutputTokens: 4000, enabledTools: [] },
    brainstorming: { temperature: 0.6, reasoningMode: "medium", maxOutputTokens: 12000, enabledTools: [] }
  },
  {
    planning: { temperature: 0.2, reasoningMode: "high", maxOutputTokens: 16000, enabledTools: [] },
    coding: { temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 64000, enabledTools: [] },
    debugging: { temperature: 0.0, reasoningMode: "high", maxOutputTokens: 32000, enabledTools: [] },
    review: { temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 12000, enabledTools: [] },
    verifying: { temperature: 0.0, reasoningMode: "low", maxOutputTokens: 4000, enabledTools: [] },
    summarizing: { temperature: 0.1, reasoningMode: "low", maxOutputTokens: 4000, enabledTools: [] },
    brainstorming: { temperature: 0.6, reasoningMode: "medium", maxOutputTokens: 24000, enabledTools: [] }
  }
] as const;

export const phasePolicyKeys = ["planning", "coding", "debugging", "review", "verifying", "summarizing", "brainstorming"] as const;

export function isUntouchedLegacyPhasePolicy(phase: (typeof phasePolicyKeys)[number], policy: ProjectSettings["providers"][number]["phaseModelPolicies"][typeof phase]): boolean {
  return legacyPhaseModelPolicies.some((legacyPolicies) => JSON.stringify(policy) === JSON.stringify(legacyPolicies[phase]));
}

export function migrateDefaultPhaseModelPolicies(provider: ProjectSettings["providers"][number]): ProjectSettings["providers"][number] {
  const policies = provider.phaseModelPolicies ?? defaultPhaseModelPolicies;
  let changed = false;
  const nextPolicies = { ...policies };
  for (const phase of phasePolicyKeys) {
    if (!isUntouchedLegacyPhasePolicy(phase, policies[phase])) continue;
    nextPolicies[phase] = defaultPhaseModelPolicies[phase];
    changed = true;
  }
  return changed ? { ...provider, phaseModelPolicies: nextPolicies } : provider;
}

export function migrateProject(project: Project, fallback: Project): Project {
  const existingProviderIds = new Set(project.settings.providers.map((provider) => provider.id));
  const missingProviders = fallback.settings.providers.filter((provider) => !existingProviderIds.has(provider.id));
  const existingToolIds = new Set(project.settings.tools.map((tool) => tool.id));
  const missingTools = fallback.settings.tools.filter((tool) => !existingToolIds.has(tool.id));
  const providers = project.settings.providers.flatMap((provider) => {
    if (provider.id === "offline-manual") return [];
    if (
      provider.id === "offline-manual" &&
      (provider.label === "Offline Manual Harness" || provider.label === "Manual / No Provider")
    ) {
      const { model: _model, ...rest } = provider;
      return [{ ...rest, label: "Manual / Offline" }];
    }
    if (provider.id === "offline-manual" && provider.model === "human-in-the-loop") {
      const { model: _model, ...rest } = provider;
      return [rest];
    }
    if (provider.id === "openai-compatible" && provider.label === "OpenAI Compatible") {
      return [{ ...provider, label: "Custom OpenAI-Compatible" }];
    }
    if (provider.id === "openai-compatible" && provider.model === "gpt-4.1") {
      return [{ ...provider, model: "gpt-5.5" }];
    }
    if (provider.id === "anthropic-compatible" && provider.model === "claude-sonnet-4") {
      return [{ ...provider, model: "claude-sonnet-4-6" }];
    }
    return [provider];
  });
  const mergedProviders = [...providers.map(migrateDefaultPhaseModelPolicies), ...missingProviders];
  const activeProviderExists = mergedProviders.some((provider) => provider.enabled);
  const normalizedProviders = activeProviderExists
    ? mergedProviders
    : mergedProviders.map((provider) => ({ ...provider, enabled: provider.id === "openai-compatible" }));

  if (
    missingProviders.length === 0 &&
    missingTools.length === 0 &&
    JSON.stringify(normalizedProviders) === JSON.stringify(project.settings.providers)
  ) return project;

  return projectSchema.parse({
    ...project,
    settings: {
      ...project.settings,
      providers: normalizedProviders,
      tools: [...project.settings.tools, ...missingTools]
    },
    updatedAt: iso()
  });
}

export async function saveFlow(
  projectRoot: string,
  flow: Flow,
  options: { recordGraphChanges?: boolean; actor?: GraphChangeActor; graphChangeStatus?: GraphChangeRecord["status"] } = {}
): Promise<ProjectBundle> {
  const parsed = normalizeEvidenceFlow(flowSchema.parse(flow));
  const previous = options.recordGraphChanges
    ? (await loadProject(projectRoot).catch(() => null))?.flows.find((item) => item.id === parsed.id) ?? null
    : null;
  await writeJson(projectStatePath(projectRoot, "flows", `${parsed.id}.json`), {
    ...parsed,
    updatedAt: iso()
  });
  if (options.recordGraphChanges) {
    await recordFlowShapeChanges(projectRoot, previous, parsed, options.actor ?? "user", { status: options.graphChangeStatus });
  }
  await touchProject(projectRoot);
  const bundle = await loadProject(projectRoot);
  const policyResult = await refreshGraphArchitecturePolicyEvaluation(projectRoot, bundle);
  return policyResult?.changed ? loadProject(projectRoot) : bundle;
}

const PRESENTATION_BLOCKING_RUN_STATUSES = new Set<Run["status"]>([
  "preparing",
  "queued",
  "needs-permission",
  "running",
  "planning",
  "awaiting-plan-review",
  "coding",
  "awaiting-code-review",
  "debugging",
  "needs-replan",
  "verifying"
]);

function presentationMutationCurrentValue(node: Flow["nodes"][number], mutation: PresentationNodeMutation): unknown {
  if (mutation.field === "size") return node.size ?? null;
  return node[mutation.field];
}

function presentationValuesEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

/**
 * Applies presentation-only node fields after validating their exact current
 * values. The entire batch is rejected before writing if any target changed,
 * so an inverse command can never restore a stale whole-flow snapshot.
 */
export async function applyPresentationPatch(
  projectRoot: string,
  request: PresentationPatchRequest
): Promise<PresentationPatchResult> {
  const parsed = presentationPatchRequestSchema.parse(request);
  return withPresentationMutationLock(projectRoot, parsed.flowId, async () => {
    const current = await loadProject(projectRoot);
    if (current.runs.some((run) => PRESENTATION_BLOCKING_RUN_STATUSES.has(run.status))) {
      return {
        status: "conflict",
        bundle: current,
        message: "Presentation history is unavailable while a run is active or waiting for review."
      };
    }
    const flow = current.flows.find((item) => item.id === parsed.flowId);
    if (!flow) {
      return { status: "conflict", bundle: current, message: "The canvas no longer exists." };
    }
    const nodesById = new Map(flow.nodes.map((node) => [node.id, node]));
    for (const mutation of parsed.mutations) {
      const node = nodesById.get(mutation.nodeId);
      if (!node) {
        return { status: "conflict", bundle: current, message: "A node in this presentation change no longer exists." };
      }
      if (!presentationValuesEqual(presentationMutationCurrentValue(node, mutation), mutation.expected)) {
        return {
          status: "conflict",
          bundle: current,
          message: `Cannot apply presentation history because ${mutation.field} changed after the recorded action.`
        };
      }
    }

    const mutationsByNodeId = new Map<string, PresentationNodeMutation[]>();
    for (const mutation of parsed.mutations) {
      const mutations = mutationsByNodeId.get(mutation.nodeId) ?? [];
      mutations.push(mutation);
      mutationsByNodeId.set(mutation.nodeId, mutations);
    }
    const updatedAt = iso();
    const nextFlow = flowSchema.parse({
      ...flow,
      nodes: flow.nodes.map((node) => {
        const mutations = mutationsByNodeId.get(node.id);
        if (!mutations) return node;
        let next = { ...node };
        for (const mutation of mutations) {
          if (mutation.field === "size") {
            if (mutation.value === null) {
              const { size: _size, ...withoutSize } = next;
              next = withoutSize as typeof next;
            } else {
              next = { ...next, size: mutation.value };
            }
          } else if (mutation.field === "position") {
            next = { ...next, position: mutation.value };
          } else {
            next = { ...next, visual: mutation.value };
          }
        }
        return { ...next, updatedAt };
      }),
      updatedAt
    });
    await writeJson(projectStatePath(projectRoot, "flows", `${flow.id}.json`), nextFlow);
    await touchProject(projectRoot);
    return { status: "applied", bundle: await loadProject(projectRoot) };
  });
}

/** Persist independent flow files as one project transaction and reload once. */
export async function saveFlows(
  projectRoot: string,
  flows: Flow[],
  options: { recordGraphChanges?: boolean; actor?: GraphChangeActor; graphChangeStatus?: GraphChangeRecord["status"] } = {}
): Promise<ProjectBundle> {
  const parsed = flows.map((flow) => normalizeEvidenceFlow(flowSchema.parse(flow)));
  const ids = new Set<string>();
  for (const flow of parsed) {
    if (ids.has(flow.id)) throw new Error(`Flow ${flow.id} was included more than once in a batch save.`);
    ids.add(flow.id);
  }
  const previousBundle = options.recordGraphChanges ? await loadProject(projectRoot).catch(() => null) : null;
  const previousById = new Map(previousBundle?.flows.map((flow) => [flow.id, flow]) ?? []);
  const stamped = parsed.map((flow) => ({ ...flow, updatedAt: iso() }));
  await Promise.all(stamped.map((flow) => writeJson(projectStatePath(projectRoot, "flows", `${flow.id}.json`), flow)));
  if (options.recordGraphChanges) {
    // Ledger ordering stays deterministic even though distinct flow files were written concurrently.
    for (const flow of stamped) {
      await recordFlowShapeChanges(projectRoot, previousById.get(flow.id) ?? null, flow, options.actor ?? "user", { status: options.graphChangeStatus });
    }
  }
  await touchProject(projectRoot);
  const bundle = await loadProject(projectRoot);
  const policyResult = await refreshGraphArchitecturePolicyEvaluation(projectRoot, bundle);
  return policyResult?.changed ? loadProject(projectRoot) : bundle;
}

export async function repairProject(projectRoot: string): Promise<ProjectBundle> {
  const repairedRoot = projectStatePath(projectRoot);
  await mkdir(repairedRoot, { recursive: true });
  const backupRoot = projectStatePath(projectRoot, `repair-backup-${Date.now().toString(36)}`);
  await mkdir(backupRoot, { recursive: true });

  for (const fileName of ["project.json"]) {
    const filePath = projectStatePath(projectRoot, fileName);
    if (await exists(filePath)) {
      await copyFile(filePath, path.join(backupRoot, fileName));
    }
  }

  const bundle = await loadProject(projectRoot);
  await writeProjectFiles(projectRoot, bundle.project);
  for (const flow of bundle.flows) {
    await writeJson(projectStatePath(projectRoot, "flows", `${flow.id}.json`), flowSchema.parse(flow));
  }
  return loadProject(projectRoot);
}

export async function updateProjectSettings(projectRoot: string, settings: ProjectSettings): Promise<ProjectBundle> {
  const bundle = await loadProject(projectRoot);
  const project = bundle.project;
  assertCustomNodePropertyTypesUnchanged(project.settings, settings);
  const nextRuleIds = new Set((settings.nodeRules ?? []).map((rule) => rule.id));
  const deletedRuleIds = new Set((project.settings.nodeRules ?? [])
    .map((rule) => rule.id)
    .filter((ruleId) => !nextRuleIds.has(ruleId)));
  if (globalProviderSettingsStore) {
    await globalProviderSettingsStore.save(settings.providers, { preserveMissingSecrets: true });
  }
  if (globalMcpSettingsStore) {
    await globalMcpSettingsStore.save(settings.mcp, { preserveMissingSecrets: true });
  }
  await writeProjectFiles(projectRoot, projectSchema.parse({
    ...project,
    settings,
    updatedAt: iso()
  }));
  if (deletedRuleIds.size) {
    const updatedAt = iso();
    for (const flow of bundle.flows) {
      let changed = false;
      const nodes = flow.nodes.map((node) => {
        const ruleIds = node.ruleIds ?? [];
        const nextNodeRuleIds = ruleIds.filter((ruleId) => !deletedRuleIds.has(ruleId));
        if (nextNodeRuleIds.length === ruleIds.length) return node;
        changed = true;
        return {
          ...node,
          ruleIds: nextNodeRuleIds.length ? nextNodeRuleIds : undefined,
          updatedAt
        };
      });
      if (changed) {
        await writeJson(projectStatePath(projectRoot, "flows", `${flow.id}.json`), flowSchema.parse({
          ...flow,
          nodes,
          updatedAt
        }));
      }
    }
  }
  return loadProject(projectRoot);
}

export function assertCustomNodePropertyTypesUnchanged(current: ProjectSettings, next: ProjectSettings): void {
  const currentById = new Map(current.customNodeProperties.map((property) => [property.id, property]));
  for (const property of next.customNodeProperties) {
    const existing = currentById.get(property.id);
    if (existing && existing.type !== property.type) {
      throw new Error(`Custom key "${existing.label}" type cannot be changed after creation.`);
    }
  }
}

export async function updateProjectDetails(projectRoot: string, patch: Pick<Project, "name">): Promise<ProjectBundle> {
  const project = (await loadProject(projectRoot)).project;
  const name = patch.name.trim();
  if (!name) throw new Error("Project name cannot be empty.");
  await writeProjectFiles(projectRoot, projectSchema.parse({
    ...project,
    name,
    updatedAt: iso()
  }));
  return loadProject(projectRoot);
}

export async function updateProjectMetadata(
  projectRoot: string,
  patch: Partial<Pick<Project, "name" | "description">> & Partial<Pick<ProjectSettings, "stackAssumptions" | "environmentNotes">>
): Promise<ProjectBundle> {
  const project = (await loadProject(projectRoot)).project;
  const name = patch.name === undefined ? project.name : patch.name.trim();
  if (!name) throw new Error("Project name cannot be empty.");
  await writeProjectFiles(projectRoot, projectSchema.parse({
    ...project,
    name,
    description: patch.description === undefined ? project.description : patch.description.trim(),
    settings: {
      ...project.settings,
      stackAssumptions: patch.stackAssumptions === undefined ? project.settings.stackAssumptions : patch.stackAssumptions,
      environmentNotes: patch.environmentNotes === undefined ? project.settings.environmentNotes : patch.environmentNotes
    },
    updatedAt: iso()
  }));
  return loadProject(projectRoot);
}


export async function updateNode(
  projectRoot: string,
  flowId: string,
  patch: NodePatch,
  actor: "user" | "llm",
  options: { graphChangeActor?: GraphChangeActor } = {}
): Promise<ProjectBundle> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  const node = flow.nodes.find((item) => item.id === patch.id);
  if (!node) throw new Error(`Node ${patch.id} was not found.`);
  if (patch.groupId !== undefined && !flow.groups.some((group) => group.id === patch.groupId)) {
    throw new Error(`Group ${patch.groupId} was not found.`);
  }

  const effectivePatch: NodePatch = patch.implementationScope === undefined
    ? patch
    : { ...patch, implementationScope: { ...patch.implementationScope, checkedAt: iso() } };
  const updated = applyNodePatch(archicodeNodeSchema.parse(node), effectivePatch, actor);
  const graphChangeActor = options.graphChangeActor ?? (actor === "user" ? "user" : undefined);
  const ignoredFieldPaths = new Set(["id", "forceUnlockRevision", "visual", "position", "size", "ignored", "groupId", "updatedAt"]);
  const nodeFieldPaths = Object.keys(patch).filter((fieldPath) => !ignoredFieldPaths.has(fieldPath));
  const isPureApprovalStageChange = nodeFieldPaths.length === 1 &&
    nodeFieldPaths[0] === "stage" &&
    (updated.stage === "plan-approved" || updated.stage === "draft-approved-production");
  const shouldRecordGraphChange = Boolean(
    graphChangeActor &&
    nodeFieldPaths.length &&
    !isPureApprovalStageChange
  );
  const shouldAutoResolveNotes = !isNoteAutoResolveNodeState(node) && isNoteAutoResolveNodeState(updated);
  const nextFlow = {
    ...flow,
    nodes: flow.nodes.map((item) => item.id === updated.id ? updated : item),
    updatedAt: iso()
  };

  let saved = await saveFlow(projectRoot, nextFlow);
  if (shouldRecordGraphChange && graphChangeActor) {
    await writeGraphChangeRecord(projectRoot, {
      flowId,
      actor: graphChangeActor,
      kind: "node-updated",
      summary: `Updated node "${updated.title}" (${nodeFieldPaths.join(", ")}).`,
      nodeIds: [updated.id],
      fieldPaths: nodeFieldPaths,
      snippets: graphChangeSnippets(
        node as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
        nodeFieldPaths
      )
    });
    saved = await loadProject(projectRoot);
  }
  if (!shouldAutoResolveNotes) return saved;
  return finalizeNodeNotesForApproval(projectRoot, flowId, updated.id, bundle.project.settings.purgeResolvedNotesOnApproval);
}

// System-actor data path for recording the build-time verdict of a node's
// acceptance checks (the LLM authors/runs the linked tests, then writes results
// here). Bypasses applyNodePatch's dirty-flag logic: this is verification state,
// not a graph edit. Once every check on a node reads "passing", the next verified
// build clears the node (see updateRunNodeOutcome / nodeAcceptanceChecksSatisfied).
export async function touchProject(projectRoot: string): Promise<void> {
  const project = (await loadProject(projectRoot)).project;
  await writeProjectFiles(projectRoot, projectSchema.parse({
    ...project,
    updatedAt: iso()
  }));
}

export async function checkGlobalProvider(providerId: string): Promise<ProviderHealthResult> {
  const providers = await globalProviderSettingsStore?.load({ includeSecrets: true });
  if (!providers?.length) {
    return {
      providerId,
      ok: false,
      status: "failed",
      checkedAt: iso(),
      message: `Provider ${providerId} was not found.`
    };
  }
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) {
    return {
      providerId,
      ok: false,
      status: "failed",
      checkedAt: iso(),
      message: `Provider ${providerId} was not found.`
    };
  }
  const health = await checkProviderHealth(await hydrateProviderForUse(provider));
  if (health.detectedContextWindowTokens || health.availableModels?.length || health.detectedOpenAiEndpointMode) {
    await globalProviderSettingsStore?.save(providers.map((item) => item.id === providerId
      ? {
          ...item,
          detectedContextWindowTokens: health.detectedContextWindowTokens ?? item.detectedContextWindowTokens,
          detectedAvailableModels: health.availableModels?.length ? health.availableModels : item.detectedAvailableModels,
          detectedModelCapabilities: health.detectedModelCapabilities && Object.keys(health.detectedModelCapabilities).length
            ? health.detectedModelCapabilities
            : item.detectedModelCapabilities,
          detectedOpenAiEndpointMode: health.detectedOpenAiEndpointMode ?? item.detectedOpenAiEndpointMode
        }
      : item));
  }
  return health;
}
