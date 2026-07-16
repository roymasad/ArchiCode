import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, powerSaveBlocker, safeStorage, session, shell } from "electron";
import type { MenuItemConstructorOptions, OpenDialogOptions, SaveDialogOptions } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, watch as watchFs, type FSWatcher } from "node:fs";
import { appendFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { authorAcceptanceTestsScoped, clearNodeAcceptanceTests, enhanceNodeField, generateGitCommitMessage, runNodeAcceptanceChecks } from "./storage/acceptanceChecks";
import { listAgentInstructionFiles, readAgentInstructionFile, readAgentMemory, writeAgentInstructionFile, writeAgentMemory } from "./storage/agentFiles";
import { exportDrawioFlow, exportFlow, exportProjectBundle, importDrawioFlow, importFlow, listDrawioPages } from "./storage/flowImportExport";
import { exportProjectDocument, type ProjectDocumentExportFormat } from "./storage/projectDocumentExport";
import { checkProjectProvider, createProjectSkill, importProjectMcpServers, installProjectMcpRegistryServer, listMcpServers, listProjectSkills, refreshProjectMcpServerCapabilities, searchMcpRegistry, updateMcpServer } from "./storage/mcpSettings";
import { addNote, attachNodeReferences, deleteNote, purgeResolvedNotes, purgeSystemNotes, updateNotePinned, updateNoteResolved } from "./storage/notes";
import { applyPatchProposal, listPatchProposals, readArtifactDataUrl, readArtifactText } from "./storage/patches";
import { archicodeGitAttributesStatus, checkGlobalProvider, createProject, deleteProjectState, enableArchicodeGitAttributes, ensureEmptyCodebaseProject, ensureProject, loadProject, repairProject, saveFlow, setGlobalMcpSettingsStore, setGlobalProviderSettingsStore, updateNode, updateProjectDetails, updateProjectSettings } from "./storage/projectStore";
import { approveRun, cancelRun, dismissRunError, rejectRun, removeRunFromQueue, reportBug, retryRun, runAgent, startAgentRun, startDebuggingRun, startIncidentDebugRun, startRunProfile, startRuntimeDebugRun, updateBugIncident } from "./storage/runEngine";
import { setRunUpdatePublisher } from "./storage/runLogs";
import { listRuntimeServices, restartRuntimeService, startRuntimeService, stopRuntimeService } from "./storage/runtimeServices";
import { setWebSearchSecretResolver } from "./internalTools";
import {
  clearSemanticIndex,
  getSemanticCodeFileContexts,
  getSemanticCodeLineContext,
  getSemanticNodeContext,
  getSemanticIndexStatus,
  indexSemanticDocuments,
  semanticDocumentsForBundle,
  semanticDocumentsForCode,
  semanticIndexNeedsWarmup,
  setSemanticIndexRoots,
  initializeSemanticModelPreference,
  isSemanticModelPreferenceId,
  switchSemanticModelPreference,
  DEFAULT_SEMANTIC_MODEL_PREFERENCE,
  type SemanticModelPreferenceId,
  type SemanticIndexProgress,
  type SemanticIndexStatus,
  type SemanticNodeContext
} from "./semanticIndex";
import { roleForFile, scanRepository } from "./importer/scanner";
import { parseFiles } from "./importer/parsers";
import { languageForSemanticSource } from "./importer/sourceLanguages";
import type { ParsedFile, RepoScan } from "./importer/types";
import { refreshProjectGraphEvidence, type GraphEvidenceRefreshProgress, type GraphEvidenceRefreshResult } from "./importer/evidenceRefresh";
import { codeKnowledgeSnapshotNeedsRefresh, readCodeKnowledgeSnapshot } from "./importer/knowledgeSnapshot";
import { readInitialCodebaseImportReport } from "./importer/importReports";
import { readLatestResyncReport, readResyncReports } from "./importer/resyncReports";
import type { ResyncProgress } from "./importer/resyncTypes";
import {
  mcpSettingsSchema,
  providerSettingsSchema,
  speechSettingsSchema,
  ttsSettingsSchema,
  type ProjectBundle,
  type ProjectSettings,
  type Run,
  type SpeechSettings,
  type TtsSettings
} from "../shared/schema";
import { createSeedProject } from "../shared/fixtures";
import { checkForAppUpdate } from "./updater";
import { applyResearchGraphChangeSet, type CodebaseMappingProgress, cancelResearchChatMessage, mapExistingCodebase, resyncExistingCodebase, respondToSubagentRun, sendResearchChatMessage, summarizeResearchChat, setGlobalResearchPersonalityResolver, setGlobalResearchVerbosityResolver } from "./research";
import { archiveResearchChat, createResearchChat, forkResearchChat, listResearchChats, renameResearchChat, updateResearchChatAutoApproval, setResearchStorageRoot } from "./research/chatStore";
import {
  getExternalMcpHostStatus,
  regenerateExternalMcpHostAuth,
  setExternalMcpProjectUpdatePublisher,
  stopExternalMcpHost,
  syncExternalMcpHost,
  type ExternalMcpHostStatus
} from "./mcpHost";
import {
  getGitStatus,
  gitCloneRepository,
  gitCommit,
  gitCreateBranch,
  gitDiscardChanges,
  gitInit,
  gitPopStash,
  gitPull,
  gitPush,
  gitStashChanges,
  gitSwitchBranch,
  listProjectFiles,
  readProjectFile,
  readProjectFileDiff
} from "./projectTools";
import {
  deleteSpeechModel,
  downloadSpeechModel,
  getSpeechRuntimeStatus,
  setSpeechDataRoot,
  transcribeSpeech
} from "./speech";
import {
  deleteTtsModel,
  downloadTtsModel,
  getTtsRuntimeStatus,
  setTtsDataRoot,
  shutdownTtsWorkers,
  streamSpeech,
  synthesizeSpeech,
  warmTtsModel
} from "./tts";
import { parseGlobalResearchPersonality, parseGlobalResearchVerbosity, type GlobalResearchPersonality, type GlobalResearchVerbosity } from "../shared/researchPersonality";
import { shutdownLocalProviderProcesses } from "./providers/localCli";
import { projectStatePath, readJson, sha256File, writeJson } from "./storage/persistence";
import {
  mergeProjectMaintenanceChanges,
  projectMaintenanceChangesBetweenHashes,
  type ProjectMaintenanceChangedFile,
  type ProjectMaintenanceReason,
  type ProjectMaintenanceStatus,
  type ProjectMaintenanceTask
} from "../shared/projectMaintenance";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const APP_NAME = "ArchiCode";
const sleepBlockingRunStatuses = new Set<Run["status"]>([
  "preparing",
  "running",
  "planning",
  "coding",
  "debugging",
  "verifying"
]);
const sleepBlockingRunKeys = new Set<string>();
const sleepBlockingTaskKeys = new Set<string>();
let sleepBlockerId: number | null = null;
const notifiedRunStatuses = new Map<string, Run["status"]>();
const semanticWarmupJobs = new Map<string, Promise<void>>();
let semanticWarmupGeneration = 0;
const activeCodebaseMappings = new Map<string, { cancelled: boolean }>();
const activeCodebaseResyncs = new Map<string, { cancelled: boolean }>();

class SemanticWarmupCancelledError extends Error {}

function runNotificationKey(projectRoot: string, runId: string): string {
  return `${path.resolve(projectRoot)}\0${runId}`;
}

function runIsTerminal(run: Run): boolean {
  return run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
}

function runNotificationTitle(run: Run): string {
  if (run.status === "succeeded") return "ArchiCode job completed";
  if (run.status === "failed") return "ArchiCode job failed";
  return "ArchiCode job cancelled";
}

function showSystemNotification(input: { title: string; body?: string }, source: string): boolean {
  if (!Notification.isSupported()) {
    console.warn(`[archicode] system notification skipped (${source}): notifications are not supported.`);
    return false;
  }
  try {
    new Notification({
      title: input.title,
      body: input.body
    }).show();
    return true;
  } catch (error) {
    console.warn(`[archicode] system notification failed (${source}): ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function notifyRunFinishedIfNeeded(projectRoot: string, run: Run, previousStatus: Run["status"] | undefined): Promise<void> {
  if (!runIsTerminal(run) || previousStatus === run.status) return;
  const bundle = await loadProject(projectRoot).catch(() => null);
  if (!bundle?.project.settings.notifications.jobFinished) return;
  showSystemNotification({
    title: runNotificationTitle(run),
    body: run.runInstructions?.trim() || run.promptSummary
  }, `run ${run.id}`);
}

function appIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "../../build/icon.png"),
    path.join(process.resourcesPath ?? "", "icon.png")
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function installAppBranding(): void {
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    iconPath: appIconPath()
  });
}

function sleepBlockingRunKey(projectRoot: string, runId: string): string {
  return `${path.resolve(projectRoot)}\0${runId}`;
}

function shouldBlockSleepForRun(run: Run): boolean {
  return sleepBlockingRunStatuses.has(run.status) && !run.queueRemovedAt;
}

function updateSleepBlocker(): void {
  const shouldBlockSleep = sleepBlockingRunKeys.size > 0 || sleepBlockingTaskKeys.size > 0;
  if (shouldBlockSleep) {
    if (sleepBlockerId === null || !powerSaveBlocker.isStarted(sleepBlockerId)) {
      sleepBlockerId = powerSaveBlocker.start("prevent-display-sleep");
      console.log(`[archicode] sleep blocker started for active agent work (${sleepBlockerId}).`);
    }
    return;
  }

  if (sleepBlockerId === null) return;
  if (powerSaveBlocker.isStarted(sleepBlockerId)) {
    powerSaveBlocker.stop(sleepBlockerId);
  }
  console.log(`[archicode] sleep blocker stopped (${sleepBlockerId}).`);
  sleepBlockerId = null;
}

function trackRunSleepBlocker(projectRoot: string, run: Run): void {
  const key = sleepBlockingRunKey(projectRoot, run.id);
  if (shouldBlockSleepForRun(run)) {
    sleepBlockingRunKeys.add(key);
  } else {
    sleepBlockingRunKeys.delete(key);
  }
  updateSleepBlocker();
}

function syncProjectSleepBlocker(projectRoot: string, runs: Run[]): void {
  const prefix = `${path.resolve(projectRoot)}\0`;
  for (const key of [...sleepBlockingRunKeys]) {
    if (key.startsWith(prefix)) sleepBlockingRunKeys.delete(key);
  }
  for (const run of runs) {
    if (shouldBlockSleepForRun(run)) sleepBlockingRunKeys.add(sleepBlockingRunKey(projectRoot, run.id));
  }
  updateSleepBlocker();
}

function beginSleepBlockingTask(label: string): () => void {
  const key = `${label}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  sleepBlockingTaskKeys.add(key);
  updateSleepBlocker();
  return () => {
    sleepBlockingTaskKeys.delete(key);
    updateSleepBlocker();
  };
}

async function withSleepBlocked<T>(label: string, task: () => Promise<T>): Promise<T> {
  const endTask = beginSleepBlockingTask(label);
  try {
    return await task();
  } finally {
    endTask();
  }
}

function syncBundleSleepBlocker(bundle: ProjectBundle): ProjectBundle {
  syncProjectSleepBlocker(bundle.rootPath, bundle.runs);
  return bundle;
}

async function syncBundleExternalMcpHost(bundle: ProjectBundle): Promise<ProjectBundle> {
  await syncExternalMcpHost(bundle.rootPath, bundle.project.settings);
  return bundle;
}

type StoredKeyChord = {
  key: string;
  cmd?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

type AppState = {
  lastProjectRoot?: string;
  recentProjectRoots?: string[];
  globalProviders?: ProjectSettings["providers"];
  globalResearchPersonality?: GlobalResearchPersonality;
  globalResearchVerbosity?: GlobalResearchVerbosity;
  providerSecrets?: Record<string, string>;
  webSearchSecrets?: Record<string, string>;
  migrations?: Record<string, boolean>;
  keybindings?: Record<string, StoredKeyChord>;
  speech?: SpeechSettings;
  tts?: TtsSettings;
  semanticModelPreference?: SemanticModelPreferenceId;
  // Sanitized (secret-free) server configs; auth material lives encrypted in
  // mcpServerSecrets, keyed by server id, the same split providers/apiKeys use.
  globalMcpServers?: ProjectSettings["mcp"]["servers"];
  /** Legacy cap settings are ignored and removed the next time MCP settings are saved. */
  globalMcpToolSettings?: unknown;
  mcpServerSecrets?: Record<string, string>;
};

async function globalSemanticModelPreference(): Promise<SemanticModelPreferenceId> {
  const state = await readAppState();
  return isSemanticModelPreferenceId(state.semanticModelPreference)
    ? state.semanticModelPreference
    : DEFAULT_SEMANTIC_MODEL_PREFERENCE;
}

async function rememberSemanticModelPreference(preference: SemanticModelPreferenceId): Promise<SemanticModelPreferenceId> {
  if (!isSemanticModelPreferenceId(preference)) throw new Error("Unsupported semantic embedding model.");
  const state = await readAppState();
  await writeAppState({ ...state, semanticModelPreference: preference });
  await switchSemanticModelPreference(preference);
  return preference;
}

type RecentProjectEntry = {
  rootPath: string;
  name: string;
};

const MAX_RECENT_PROJECTS = 8;

function detectCodebaseHints(projectRoot: string): string[] {
  const checks: Array<[string, string]> = [
    ["package.json", "JavaScript/TypeScript package"],
    ["vite.config.ts", "Vite"],
    ["vite.config.js", "Vite"],
    ["next.config.js", "Next.js"],
    ["next.config.mjs", "Next.js"],
    ["tsconfig.json", "TypeScript"],
    ["pubspec.yaml", "Flutter/Dart"],
    ["Cargo.toml", "Rust"],
    ["go.mod", "Go"],
    ["pom.xml", "Maven/Java"],
    ["build.gradle", "Gradle/JVM"],
    ["build.gradle.kts", "Gradle/JVM"],
    ["prisma/schema.prisma", "Prisma"],
    ["src", "source directory"],
    ["app", "app directory"]
  ];
  const hints = checks.filter(([relativePath]) => existsSync(path.join(projectRoot, relativePath))).map(([, label]) => label);
  return Array.from(new Set(hints));
}

type ConsoleOutputPayload = {
  sessionId: string;
  stream: "data" | "system";
  text: string;
  exitCode?: number | null;
  signal?: number | null;
};

type ResearchChatTokenPayload = {
  projectRoot: string;
  sessionId: string;
  text: string;
  kind?: "answer" | "thinking";
  reset?: boolean;
};

type ResearchSubagentProgressPayload = {
  projectRoot: string;
  sessionId: string;
  runId: string;
  kind: "merge-resolution" | "graph-reconciliation" | "test-authoring" | "sherlock-research";
  title: string;
  message: string;
  status?: "running" | "completed" | "failed";
};

type ConsoleSession = {
  id: string;
  projectRoot: string;
  ptyProcess: IPty;
};

type TtsDebugLogInput = {
  events?: Array<Record<string, unknown>>;
  logId?: string | null;
  messageId?: string | null;
  playbackRunId?: number | null;
  sessionId?: string | null;
};

const consoleSessions = new Map<string, ConsoleSession>();

function appStatePath(): string {
  return path.join(app.getPath("userData"), "archicode-state.json");
}

function safeLogFilePart(value: unknown): string {
  const cleaned = String(value ?? "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return cleaned || "unknown";
}

function ttsDebugLogPath(input: TtsDebugLogInput): string {
  const day = new Date().toISOString().slice(0, 10);
  const fallbackLogId = `${Date.now()}-${input.sessionId ?? "session"}-${input.messageId ?? "message"}-${input.playbackRunId ?? "run"}`;
  return path.join(app.getPath("userData"), "tts-logs", day, `${safeLogFilePart(input.logId ?? fallbackLogId)}.ndjson`);
}

async function writeTtsDebugLog(input: TtsDebugLogInput): Promise<{ path: string }> {
  const events = Array.isArray(input.events) ? input.events : [];
  const logPath = ttsDebugLogPath(input);
  await mkdir(path.dirname(logPath), { recursive: true });
  if (events.length) {
    const writtenAt = new Date().toISOString();
    const lines = events.map((event) => JSON.stringify({
      writtenAt,
      sessionId: input.sessionId ?? null,
      messageId: input.messageId ?? null,
      playbackRunId: input.playbackRunId ?? null,
      ...event
    }));
    await appendFile(logPath, `${lines.join("\n")}\n`, "utf8");
  }
  return { path: logPath };
}

async function readAppState(): Promise<AppState> {
  let raw: string;
  try {
    raw = await readFile(appStatePath(), "utf8");
  } catch {
    // No state file yet (fresh install): a genuinely empty state is correct.
    return {};
  }
  try {
    const state = JSON.parse(raw) as AppState;
    return await migrateAppState(state);
  } catch (error) {
    // The file exists but is unreadable/corrupt (historically a torn write).
    // Never silently reset to {} and let the next write persist it — that
    // permanently destroys providers, MCP servers, and recent projects. Keep a
    // timestamped backup so the data is recoverable, and surface the problem.
    const backupPath = `${appStatePath()}.corrupt-${Date.now()}`;
    try {
      await writeFile(backupPath, raw, "utf8");
    } catch {
      // If we cannot even back it up there is nothing more to do here.
    }
    console.error(`Failed to parse app state; backed up corrupt file to ${backupPath}.`, error);
    return {};
  }
}

function defaultCodexLocalSandbox(): ProjectSettings["providers"][number]["localSandbox"] {
  return process.platform === "win32" ? "danger-full-access" : "workspace-write";
}

function isBuiltinCodexLocalProvider(provider: ProjectSettings["providers"][number]): boolean {
  return (
    provider.id === "codex-local" &&
    provider.kind === "codex-local" &&
    provider.label === "Codex Local CLI" &&
    (provider.localCommand ?? "codex") === "codex"
  );
}

function applyPlatformCodexLocalDefaults(providers: ProjectSettings["providers"]): ProjectSettings["providers"] {
  const defaultSandbox = defaultCodexLocalSandbox();
  return providers.map((provider) => {
    if (!isBuiltinCodexLocalProvider(provider)) return provider;
    if (defaultSandbox === "danger-full-access") {
      return provider.localSandbox === "danger-full-access" ? provider : { ...provider, localSandbox: defaultSandbox };
    }
    return provider.localSandbox === "read-only" || !provider.localSandbox
      ? { ...provider, localSandbox: defaultSandbox }
      : provider;
  });
}

async function migrateAppState(state: AppState): Promise<AppState> {
  const migrationKey = "codex-local-platform-sandbox-default-v2";
  const normalizedPersonality = parseGlobalResearchPersonality(state.globalResearchPersonality);
  const normalizedVerbosity = parseGlobalResearchVerbosity(state.globalResearchVerbosity);
  const alreadyMigrated = Boolean(state.migrations?.[migrationKey]);
  let changed = normalizedPersonality !== state.globalResearchPersonality || normalizedVerbosity !== state.globalResearchVerbosity;
  if (alreadyMigrated && !changed) return state;
  const globalProviders = state.globalProviders
    ? applyPlatformCodexLocalDefaults(state.globalProviders)
    : undefined;
  changed = changed || JSON.stringify(globalProviders) !== JSON.stringify(state.globalProviders);
  const nextState = {
    ...state,
    globalProviders,
    globalResearchPersonality: normalizedPersonality,
    globalResearchVerbosity: normalizedVerbosity,
    migrations: {
      ...(state.migrations ?? {}),
      [migrationKey]: true
    }
  };
  if (changed) await writeAppState(nextState);
  return nextState;
}

// All app-state writes serialize through this chain so overlapping callers
// (project open, settings save, keybindings, MCP/provider global stores) can
// never interleave a partial file or clobber each other with a stale base.
let appStateWriteChain: Promise<void> = Promise.resolve();

async function writeAppState(state: AppState): Promise<void> {
  const run = appStateWriteChain.then(async () => {
    await mkdir(path.dirname(appStatePath()), { recursive: true });
    // Write to a unique temp file then atomically rename over the target, so a
    // reader (or a crash mid-write) never sees a truncated/torn JSON file.
    const tempPath = `${appStatePath()}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tempPath, appStatePath());
  });
  // Keep the chain alive even if this write fails, so one failure does not wedge
  // every future write.
  appStateWriteChain = run.catch(() => undefined);
  return run;
}

function looksLikeEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function encryptSecret(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:v1:${safeStorage.encryptString(trimmed).toString("base64")}`;
  }
  return undefined;
}

function decryptSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    if (value.startsWith("safe:v1:")) {
      if (!safeStorage.isEncryptionAvailable()) return undefined;
      return safeStorage.decryptString(Buffer.from(value.slice("safe:v1:".length), "base64"));
    }
    if (value.startsWith("plain:v1:")) {
      return Buffer.from(value.slice("plain:v1:".length), "base64").toString("utf8");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function rawKeyFromProvider(provider: ProjectSettings["providers"][number]): string | undefined {
  const direct = provider.apiKey?.trim();
  if (direct) return direct;
  const legacyValue = provider.apiKeyEnv?.trim();
  if (legacyValue && !looksLikeEnvironmentVariableName(legacyValue)) return legacyValue;
  return undefined;
}

function providerForAppState(provider: ProjectSettings["providers"][number]): ProjectSettings["providers"][number] {
  const apiKeyEnv = provider.apiKeyEnv?.trim();
  return providerSettingsSchema.parse({
    ...provider,
    apiKey: undefined,
    apiKeyEnv: apiKeyEnv && looksLikeEnvironmentVariableName(apiKeyEnv) ? apiKeyEnv : undefined
  });
}

async function lastProjectRoot(): Promise<string | null> {
  const roots = await recentProjectRoots();
  return roots[0] ?? null;
}

async function rememberProjectRoot(projectRoot: string): Promise<void> {
  const state = await readAppState();
  const normalizedRoot = path.resolve(projectRoot);
  const recentRoots = [
    normalizedRoot,
    ...[state.lastProjectRoot, ...(state.recentProjectRoots ?? [])]
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => path.resolve(candidate))
      .filter((candidate) => candidate !== normalizedRoot)
  ].slice(0, MAX_RECENT_PROJECTS);
  await writeAppState({
    ...state,
    lastProjectRoot: normalizedRoot,
    recentProjectRoots: recentRoots
  });
}

async function recentProjectRoots(): Promise<string[]> {
  const state = await readAppState();
  const recentRoots = [state.lastProjectRoot, ...(state.recentProjectRoots ?? [])]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => path.resolve(candidate));
  const seen = new Set<string>();
  const validRoots = recentRoots.filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return existsSync(candidate);
  }).slice(0, MAX_RECENT_PROJECTS);
  const normalizedLastRoot = validRoots[0];
  const currentRecentRoots = state.recentProjectRoots ?? [];
  const changed = state.lastProjectRoot !== normalizedLastRoot ||
    currentRecentRoots.length !== validRoots.length ||
    currentRecentRoots.some((candidate, index) => path.resolve(candidate) !== validRoots[index]);
  if (changed) {
    await writeAppState({
      ...state,
      lastProjectRoot: normalizedLastRoot,
      recentProjectRoots: validRoots
    });
  }
  return validRoots;
}

async function listRecentProjects(): Promise<RecentProjectEntry[]> {
  return (await recentProjectRoots()).map((rootPath) => ({
    rootPath,
    name: path.basename(rootPath) || rootPath
  }));
}

async function globalProviders(options: { includeSecrets?: boolean } = {}): Promise<ProjectSettings["providers"] | null> {
  const state = await readAppState();
  const providers = state.globalProviders;
  if (!providers?.length) return null;
  return providers.flatMap((provider) => {
    const result = providerSettingsSchema.safeParse(provider);
    if (!result.success) return [];
    const secret = options.includeSecrets ? decryptSecret(state.providerSecrets?.[result.data.id]) : undefined;
    return [secret ? { ...result.data, apiKey: secret } : result.data];
  });
}

async function globalProviderSecret(providerId: string): Promise<string | undefined> {
  const state = await readAppState();
  return decryptSecret(state.providerSecrets?.[providerId]);
}

async function globalProviderSecretStatus(): Promise<Record<string, boolean>> {
  const state = await readAppState();
  return Object.fromEntries(Object.keys(state.providerSecrets ?? {}).map((providerId) => [providerId, true]));
}

async function webSearchSecret(provider: "brave"): Promise<string | undefined> {
  const state = await readAppState();
  return decryptSecret(state.webSearchSecrets?.[provider]);
}

async function webSearchSecretStatus(): Promise<Record<"brave", boolean>> {
  const state = await readAppState();
  return {
    brave: Boolean(state.webSearchSecrets?.brave)
  };
}

async function rememberWebSearchSecrets(
  secrets: { braveApiKey?: string },
  options: { preserveMissingSecrets?: boolean } = {}
): Promise<Record<"brave", boolean>> {
  const state = await readAppState();
  const nextSecrets = { ...(state.webSearchSecrets ?? {}) };
  const rawBraveKey = secrets.braveApiKey?.trim();
  if (rawBraveKey) {
    const encrypted = encryptSecret(rawBraveKey);
    if (encrypted) nextSecrets.brave = encrypted;
    else delete nextSecrets.brave;
  } else if (!options.preserveMissingSecrets) {
    delete nextSecrets.brave;
  }
  await writeAppState({
    ...state,
    webSearchSecrets: nextSecrets
  });
  return {
    brave: Boolean(nextSecrets.brave)
  };
}

async function rememberGlobalProviders(
  providers: ProjectSettings["providers"],
  options: { preserveMissingSecrets?: boolean } = {}
): Promise<void> {
  const state = await readAppState();
  const providerSecrets = { ...(state.providerSecrets ?? {}) };
  const providerIds = new Set(providers.map((provider) => provider.id));
  for (const providerId of Object.keys(providerSecrets)) {
    if (!providerIds.has(providerId)) delete providerSecrets[providerId];
  }
  for (const provider of providers) {
    const rawKey = rawKeyFromProvider(provider);
    if (rawKey) {
      const encrypted = encryptSecret(rawKey);
      if (encrypted) providerSecrets[provider.id] = encrypted;
      else delete providerSecrets[provider.id];
    }
    else if (!options.preserveMissingSecrets) delete providerSecrets[provider.id];
  }
  await writeAppState({
    ...state,
    providerSecrets,
    globalProviders: providers.map(providerForAppState)
  });
}

async function forgetProjectRoot(projectRoot: string): Promise<void> {
  const state = await readAppState();
  const normalizedRoot = path.resolve(projectRoot);
  const remainingRoots = [state.lastProjectRoot, ...(state.recentProjectRoots ?? [])]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => path.resolve(candidate))
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .filter((candidate) => candidate !== normalizedRoot);
  await writeAppState({
    ...state,
    lastProjectRoot: remainingRoots[0],
    recentProjectRoots: remainingRoots
  });
}

async function openProjectRoot(projectRoot: string): Promise<{ bundle: ProjectBundle; initializedMetadata: boolean; codebaseHints: string[] }> {
  const normalizedRoot = path.resolve(projectRoot);
  if (!existsSync(normalizedRoot)) {
    await forgetProjectRoot(normalizedRoot);
    throw new Error("Project folder was not found.");
  }
  const hadProjectMetadata = existsSync(path.join(normalizedRoot, ".archicode", "project.json"));
  const codebaseHints = detectCodebaseHints(normalizedRoot);
  const bundle = await syncBundleExternalMcpHost(syncBundleSleepBlocker(
    hadProjectMetadata ? await ensureProject(normalizedRoot) : await ensureEmptyCodebaseProject(normalizedRoot)
  ));
  await initializeProjectMaintenance(bundle);
  scheduleCodeKnowledgeSnapshotRefresh(bundle);
  await rememberProjectRoot(bundle.rootPath);
  return { bundle, initializedMetadata: !hadProjectMetadata, codebaseHints };
}

function publishSemanticIndexProgress(payload: SemanticIndexProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("archicode:semantic-index-progress", payload);
  }
}

async function rebuildSemanticIndexForBundle(
  projectRoot: string,
  bundle: ProjectBundle,
  onProgress?: (progress: SemanticIndexProgress) => void,
  cancelled?: () => boolean,
  prepared?: { scan: RepoScan; parsed: ParsedFile[] }
): Promise<void> {
  const assertActive = (): void => {
    if (cancelled?.()) throw new SemanticWarmupCancelledError("Semantic warmup superseded by a model change.");
  };
  onProgress?.({ phase: "scanning", completed: 0, total: 0, message: "Scanning graph and code…", projectRoot });
  const scan = prepared?.scan ?? await scanRepository(projectRoot);
  assertActive();
  const parsed = prepared?.parsed ?? await parseFiles(projectRoot, scan.files);
  assertActive();
  const semanticCode = await semanticDocumentsForCode(projectRoot, scan, parsed);
  assertActive();
  await indexSemanticDocuments(projectRoot, [...semanticDocumentsForBundle(bundle), ...semanticCode.documents], {
    replaceKinds: ["code-file", "graph-node", "graph-note", "graph-rule", "artifact"],
    coverage: semanticCode.coverage,
    onProgress: (progress) => onProgress?.({ ...progress, projectRoot })
  });
}

function scheduleSemanticIndexWarmup(bundle: ProjectBundle, force = false): void {
  if (!bundle.project.settings.semanticIndex.enabled) return;
  const projectRoot = path.resolve(bundle.rootPath);
  if (!force && semanticWarmupJobs.has(projectRoot)) return;
  const generation = semanticWarmupGeneration;
  const job = (async () => {
    const status = await getSemanticIndexStatus(projectRoot, true, semanticDocumentsForBundle(bundle));
    if (!semanticIndexNeedsWarmup(status)) return;
    await rebuildSemanticIndexForBundle(projectRoot, bundle, publishSemanticIndexProgress, () => generation !== semanticWarmupGeneration);
    const ready = await getSemanticIndexStatus(projectRoot, true, semanticDocumentsForBundle(bundle));
    publishSemanticIndexProgress({
      phase: "ready",
      completed: ready.indexedItems,
      total: ready.indexedItems,
      message: `Semantic index ready with ${ready.indexedItems.toLocaleString()} items.`,
      projectRoot
    });
  })().catch((error) => {
    if (error instanceof SemanticWarmupCancelledError || (error instanceof Error && error.name === "SemanticModelChangedError")) return;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[archicode] automatic semantic indexing failed for ${projectRoot}: ${message}`);
    publishSemanticIndexProgress({ phase: "error", completed: 0, total: 0, message, projectRoot });
  }).finally(() => {
    if (semanticWarmupJobs.get(projectRoot) === job) semanticWarmupJobs.delete(projectRoot);
  });
  semanticWarmupJobs.set(projectRoot, job);
}

function publishConsoleOutput(payload: ConsoleOutputPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("archicode:console-output", payload);
  }
}

function publishCodebaseMappingProgress(payload: CodebaseMappingProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("archicode:codebase-mapping-progress", payload);
  }
}

function publishCodebaseResyncProgress(payload: ResyncProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("archicode:codebase-resync-progress", payload);
  }
}

function publishResearchChatToken(payload: ResearchChatTokenPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("archicode:research-chat-token", payload);
  }
}

function publishResearchChatActivity(payload: {
  projectRoot: string;
  sessionId: string;
  message: string;
  status?: "running" | "completed" | "failed";
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("archicode:research-chat-activity", payload);
  }
}

function publishResearchSubagentProgress(payload: ResearchSubagentProgressPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("archicode:research-subagent-progress", payload);
  }
}

function shellCommand(): { command: string; args: string[] } {
  if (process.platform === "win32") return { command: process.env.ComSpec || "cmd.exe", args: [] };
  return { command: process.env.SHELL || "/bin/sh", args: [] };
}

function startConsole(projectRoot: string, size?: { cols?: number; rows?: number }): { sessionId: string; cwd: string; shell: string } {
  if (!projectRoot || !existsSync(projectRoot)) {
    throw new Error("Open a project folder before starting the console.");
  }

  const { command, args } = shellCommand();
  const sessionId = `console-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const cols = Math.max(20, Math.floor(size?.cols ?? 80));
  const rows = Math.max(6, Math.floor(size?.rows ?? 24));
  const ptyProcess = pty.spawn(command, args, {
    cols,
    rows,
    cwd: projectRoot,
    env: {
      ...process.env,
      COLORTERM: process.env.COLORTERM || "truecolor",
      FORCE_COLOR: process.env.FORCE_COLOR || "1",
      TERM: "xterm-256color"
    }
  });

  consoleSessions.set(sessionId, { id: sessionId, projectRoot, ptyProcess });
  ptyProcess.onData((data) => {
    publishConsoleOutput({ sessionId, stream: "data", text: data });
  });
  ptyProcess.onExit(({ exitCode, signal }) => {
    consoleSessions.delete(sessionId);
    publishConsoleOutput({
      sessionId,
      stream: "system",
      text: `\r\nConsole exited${typeof exitCode === "number" ? ` with code ${exitCode}` : signal ? ` by signal ${signal}` : ""}.\r\n`,
      exitCode,
      signal: signal ?? null
    });
  });

  return { sessionId, cwd: projectRoot, shell: command };
}

function writeConsole(sessionId: string, text: string): boolean {
  const sessionItem = consoleSessions.get(sessionId);
  if (!sessionItem) return false;
  try {
    sessionItem.ptyProcess.write(text);
    return true;
  } catch {
    return false;
  }
}

function resizeConsole(sessionId: string, size: { cols?: number; rows?: number }): boolean {
  const sessionItem = consoleSessions.get(sessionId);
  if (!sessionItem) return false;
  const cols = Math.floor(size.cols ?? 0);
  const rows = Math.floor(size.rows ?? 0);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return false;
  try {
    sessionItem.ptyProcess.resize(cols, rows);
    return true;
  } catch {
    return false;
  }
}

function stopConsole(sessionId: string): boolean {
  const sessionItem = consoleSessions.get(sessionId);
  if (!sessionItem) return false;
  sessionItem.ptyProcess.kill();
  consoleSessions.delete(sessionId);
  return true;
}

function stopAllConsoles(): void {
  for (const sessionItem of consoleSessions.values()) {
    try {
      sessionItem.ptyProcess.kill();
    } catch {
      // Session is already gone.
    }
  }
  consoleSessions.clear();
}

function contentSecurityPolicy(): string {
  if (devServerUrl) {
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join("; ");
  }

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}

function installContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy()]
      }
    });
  });
}

function isAppRendererUrl(url: string): boolean {
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

function installMediaPermissionHandlers(): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const win = BrowserWindow.fromWebContents(webContents);
    const mediaTypes = "mediaTypes" in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const wantsAudio = mediaTypes.length === 0 || mediaTypes.includes("audio");
    const allowed = Boolean(win && permission === "media" && wantsAudio && isAppRendererUrl(webContents.getURL()));
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!webContents) return false;
    const win = webContents ? BrowserWindow.fromWebContents(webContents) : null;
    const mediaType = details?.mediaType;
    const wantsAudio = !mediaType || mediaType === "audio";
    return Boolean(win && permission === "media" && wantsAudio && isAppRendererUrl(requestingOrigin || webContents.getURL()));
  });
}

function isExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

async function resolveProjectLocalPath(projectRoot: string, relativePath: string): Promise<{ absolutePath: string; isDirectory: boolean }> {
  if (!projectRoot || !existsSync(projectRoot)) {
    throw new Error("Project folder was not found.");
  }
  if (typeof relativePath !== "string" || relativePath.includes("\0")) {
    throw new Error("Project path is invalid.");
  }
  const root = await realpath(projectRoot);
  const candidate = path.resolve(root, relativePath || ".");
  const candidateRealPath = await realpath(candidate);
  const projectRelative = path.relative(root, candidateRealPath);
  if (projectRelative.startsWith("..") || path.isAbsolute(projectRelative)) {
    throw new Error("Path is outside the project folder.");
  }
  const entryStat = await stat(candidateRealPath);
  return { absolutePath: candidateRealPath, isDirectory: entryStat.isDirectory() };
}

async function openProjectPath(projectRoot: string, relativePath: string): Promise<boolean> {
  const target = await resolveProjectLocalPath(projectRoot, relativePath);
  if (target.isDirectory) {
    const error = await shell.openPath(target.absolutePath);
    if (error) throw new Error(error);
    return true;
  }
  shell.showItemInFolder(target.absolutePath);
  return true;
}

async function openProjectFile(projectRoot: string, relativePath: string): Promise<boolean> {
  const target = await resolveProjectLocalPath(projectRoot, relativePath);
  if (target.isDirectory) {
    throw new Error("Expected a file path.");
  }
  const error = await shell.openPath(target.absolutePath);
  if (error) throw new Error(error);
  return true;
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function osascriptEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function openProjectFileWithAppChooser(projectRoot: string, relativePath: string): Promise<boolean> {
  const target = await resolveProjectLocalPath(projectRoot, relativePath);
  if (target.isDirectory) {
    throw new Error("Expected a file path.");
  }

  if (process.platform === "win32") {
    const child = spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", target.absolutePath], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return true;
  }

  if (process.platform === "darwin") {
    const escapedPath = osascriptEscape(target.absolutePath);
    try {
      await execFileAsync("osascript", [
        "-e",
        `set targetPath to "${escapedPath}"`,
        "-e",
        "set openChoice to choose from list {\"Default application\", \"Choose another application…\"} with title \"Open file\" with prompt \"Open this file with:\" default items {\"Default application\"} OK button name \"OK\" cancel button name \"Cancel\"",
        "-e",
        "if openChoice is false then error number -128",
        "-e",
        "if item 1 of openChoice is \"Default application\" then",
        "-e",
        "  do shell script \"open \" & quoted form of targetPath",
        "-e",
        "else",
        "-e",
        "  set chosenApp to choose application as alias with prompt \"Open file with:\"",
        "-e",
        "  do shell script \"open -a \" & quoted form of POSIX path of chosenApp & \" \" & quoted form of targetPath",
        "-e",
        "end if"
      ]);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/User canceled|cancelled|-128/i.test(message)) return false;
      throw new Error(message);
    }
  }

  const openError = await shell.openPath(target.absolutePath);
  if (openError) throw new Error(openError);
  return true;
}

const SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const SUPPORTED_TEXT_ATTACHMENT_EXTENSIONS = [
  "txt", "text", "log", "md", "markdown", "pdf", "docx", "json", "jsonl", "ndjson", "csv", "tsv",
  "yaml", "yml", "toml", "ini", "conf", "cfg", "xml", "html", "htm", "css", "scss",
  "sass", "less", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs",
  "java", "kt", "kts", "swift", "c", "cc", "cpp", "h", "hpp", "cs", "php", "sh",
  "bash", "zsh", "fish", "sql"
];

function attachmentFileDialogOptions(title: string, options: { includeImages: boolean }): OpenDialogOptions {
  const filters: OpenDialogOptions["filters"] = [
    { name: "Text documents", extensions: SUPPORTED_TEXT_ATTACHMENT_EXTENSIONS }
  ];
  if (options.includeImages) {
    filters.unshift({ name: "Images and text documents", extensions: [...SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS, ...SUPPORTED_TEXT_ATTACHMENT_EXTENSIONS] });
    filters.splice(1, 0, { name: "Images", extensions: SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS });
  }
  return {
    title,
    properties: ["openFile", "multiSelections"],
    filters
  };
}

function referenceFileDialogOptions(): OpenDialogOptions {
  return {
    ...attachmentFileDialogOptions("Attach Node References", { includeImages: true }),
    filters: [
      { name: "Reference files", extensions: [...SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS, ...SUPPORTED_TEXT_ATTACHMENT_EXTENSIONS] },
      { name: "Images", extensions: SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS },
      { name: "Text documents", extensions: SUPPORTED_TEXT_ATTACHMENT_EXTENSIONS }
    ]
  };
}

async function createWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, "../preload/index.mjs");
  const legacyPreloadPath = path.join(__dirname, "../preload/index.js");

  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 640,
    minHeight: 480,
    title: "ArchiCode",
    backgroundColor: "#f7f6f2",
    show: false,
    webPreferences: {
      preload: existsSync(preloadPath) ? preloadPath : legacyPreloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[archicode] failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });

  win.webContents.on("did-finish-load", () => {
    console.log(`[archicode] renderer loaded: ${win.webContents.getURL()}`);
  });

  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[archicode:renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("context-menu", (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];
    const hasSelection = params.selectionText.trim().length > 0;
    const hasEditableAction = params.isEditable || hasSelection;

    if (hasEditableAction) {
      if (params.isEditable) template.push({ role: "undo" }, { role: "redo" }, { type: "separator" });
      if (params.editFlags.canCut) template.push({ role: "cut" });
      if (params.editFlags.canCopy || hasSelection) template.push({ role: "copy" });
      if (params.isEditable && params.editFlags.canPaste) template.push({ role: "paste" });
      if (params.isEditable && params.editFlags.canDelete) template.push({ role: "delete" });
      template.push({ type: "separator" }, { role: "selectAll" });
    } else if (params.linkURL && isExternalUrl(params.linkURL)) {
      template.push({ label: "Open Link", click: () => void shell.openExternal(params.linkURL) });
    }

    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  if (devServerUrl) {
    await win.loadURL(devServerUrl);
  } else {
    await win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  win.maximize();
  win.show();
}

async function globalResearchPersonality(): Promise<GlobalResearchPersonality> {
  const state = await readAppState();
  return parseGlobalResearchPersonality(state.globalResearchPersonality);
}

async function globalResearchVerbosity(): Promise<GlobalResearchVerbosity> {
  const state = await readAppState();
  return parseGlobalResearchVerbosity(state.globalResearchVerbosity);
}

async function rememberGlobalResearchPersonality(personality: GlobalResearchPersonality): Promise<GlobalResearchPersonality> {
  const state = await readAppState();
  const nextPersonality = parseGlobalResearchPersonality(personality);
  await writeAppState({
    ...state,
    globalResearchPersonality: nextPersonality
  });
  return nextPersonality;
}

async function rememberGlobalResearchVerbosity(verbosity: GlobalResearchVerbosity): Promise<GlobalResearchVerbosity> {
  const state = await readAppState();
  const nextVerbosity = parseGlobalResearchVerbosity(verbosity);
  await writeAppState({
    ...state,
    globalResearchVerbosity: nextVerbosity
  });
  return nextVerbosity;
}

async function globalSpeechSettings(): Promise<SpeechSettings> {
  const state = await readAppState();
  return speechSettingsSchema.parse(state.speech);
}

async function rememberGlobalSpeechSettings(settings: SpeechSettings): Promise<SpeechSettings> {
  const state = await readAppState();
  const nextSettings = speechSettingsSchema.parse(settings);
  await writeAppState({
    ...state,
    speech: nextSettings
  });
  return nextSettings;
}

async function globalTtsSettings(): Promise<TtsSettings> {
  const state = await readAppState();
  return ttsSettingsSchema.parse(state.tts);
}

async function rememberGlobalTtsSettings(settings: TtsSettings): Promise<TtsSettings> {
  const state = await readAppState();
  const nextSettings = ttsSettingsSchema.parse(settings);
  await writeAppState({
    ...state,
    tts: nextSettings
  });
  return nextSettings;
}

type McpServerSettings = ProjectSettings["mcp"]["servers"][number];
type McpSecretPayload = {
  env: Array<{ name: string; value: string }>;
  headers: Array<{ name: string; value: string }>;
};

function mcpServerForAppState(server: McpServerSettings): McpServerSettings {
  return {
    ...server,
    env: server.env.map((entry) => ({ name: entry.name, value: undefined })),
    headers: server.headers.map((entry) => ({ name: entry.name, value: undefined }))
  };
}

function mcpServerSecretPayload(server: McpServerSettings): McpSecretPayload | undefined {
  const env = server.env.filter((entry): entry is { name: string; value: string } => entry.value !== undefined);
  const headers = server.headers.filter((entry): entry is { name: string; value: string } => entry.value !== undefined);
  return env.length || headers.length ? { env, headers } : undefined;
}

function hydrateMcpServerSecret(server: McpServerSettings, encrypted: string | undefined): McpServerSettings {
  const decrypted = decryptSecret(encrypted);
  if (!decrypted) return server;
  try {
    const payload = JSON.parse(decrypted) as Partial<McpSecretPayload>;
    const envByName = new Map((payload.env ?? []).map((entry) => [entry.name, entry.value]));
    const headersByName = new Map((payload.headers ?? []).map((entry) => [entry.name, entry.value]));
    return {
      ...server,
      env: server.env.map((entry) => envByName.has(entry.name) ? { ...entry, value: envByName.get(entry.name) } : entry),
      headers: server.headers.map((entry) => headersByName.has(entry.name) ? { ...entry, value: headersByName.get(entry.name) } : entry)
    };
  } catch {
    return server;
  }
}

async function globalMcpSettings(options: { includeSecrets?: boolean } = {}): Promise<ProjectSettings["mcp"]> {
  const state = await readAppState();
  const servers = state.globalMcpServers ?? [];
  return mcpSettingsSchema.parse({
    servers: options.includeSecrets
      ? servers.map((server) => hydrateMcpServerSecret(server, state.mcpServerSecrets?.[server.id]))
      : servers
  });
}

async function globalMcpSettingsOrNull(options: { includeSecrets?: boolean } = {}): Promise<ProjectSettings["mcp"] | null> {
  const state = await readAppState();
  if (state.globalMcpServers === undefined) return null;
  return globalMcpSettings(options);
}

async function rememberGlobalMcpSettings(
  settings: ProjectSettings["mcp"],
  options: { preserveMissingSecrets?: boolean } = {}
): Promise<void> {
  const state = await readAppState();
  const nextSettings = mcpSettingsSchema.parse(settings);
  const mcpServerSecrets = { ...(state.mcpServerSecrets ?? {}) };
  const serverIds = new Set(nextSettings.servers.map((server) => server.id));
  for (const serverId of Object.keys(mcpServerSecrets)) {
    if (!serverIds.has(serverId)) delete mcpServerSecrets[serverId];
  }
  for (const server of nextSettings.servers) {
    const payload = mcpServerSecretPayload(server);
    if (payload) {
      const encrypted = encryptSecret(JSON.stringify(payload));
      if (encrypted) mcpServerSecrets[server.id] = encrypted;
      else if (!options.preserveMissingSecrets) delete mcpServerSecrets[server.id];
    } else if (!options.preserveMissingSecrets) {
      delete mcpServerSecrets[server.id];
    }
  }
  const { globalMcpToolSettings: _discardedLegacyCaps, ...stateWithoutLegacyCaps } = state;
  await writeAppState({
    ...stateWithoutLegacyCaps,
    mcpServerSecrets,
    globalMcpServers: nextSettings.servers.map(mcpServerForAppState)
  });
}

async function readStoredKeybindings(): Promise<Record<string, StoredKeyChord>> {
  const state = await readAppState();
  return state.keybindings ?? {};
}

async function rememberStoredKeybindings(next: Record<string, StoredKeyChord>): Promise<Record<string, StoredKeyChord>> {
  const state = await readAppState();
  const cleaned: Record<string, StoredKeyChord> = {};
  for (const [key, value] of Object.entries(next ?? {})) {
    if (!value || typeof value !== "object" || typeof value.key !== "string") continue;
    cleaned[key] = {
      key: value.key,
      cmd: Boolean(value.cmd),
      ctrl: Boolean(value.ctrl),
      shift: Boolean(value.shift),
      alt: Boolean(value.alt)
    };
  }
  await writeAppState({ ...state, keybindings: cleaned });
  return cleaned;
}

function installApplicationMenu(): void {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: APP_NAME,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "quit" }
        ]
      },
      {
        label: "Edit",
        submenu: [
          {
            label: "Undo",
            accelerator: "CmdOrCtrl+Z",
            click: () => {
              BrowserWindow.getFocusedWindow()?.webContents.send("archicode:direct-undo-requested");
            }
          },
          {
            label: "Redo",
            accelerator: "Shift+CmdOrCtrl+Z",
            enabled: false
          },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" }
        ]
      }
    ]));
    return;
  }

  Menu.setApplicationMenu(null);
}

function windowsVsCodePaths(): string[] {
  return [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe") : null,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Microsoft VS Code", "Code.exe") : null,
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Microsoft VS Code", "Code.exe") : null
  ].filter((item): item is string => Boolean(item));
}

function launchDetached(command: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.unref();
      finish({ ok: true });
    }, 1200);
    child.once("error", (error) => finish({ ok: false, error: error.message }));
    child.once("exit", (code) => {
      child.unref();
      finish({ ok: code === 0, error: code === 0 ? undefined : `${command} exited with code ${code ?? "unknown"}` });
    });
  });
}

async function openProjectInVsCode(projectRoot: string): Promise<boolean> {
  if (!projectRoot || !existsSync(projectRoot)) {
    throw new Error("Project folder was not found.");
  }
  const candidates: Array<{ command: string; args: string[] }> = [];
  if (process.platform === "darwin") {
    candidates.push(
      { command: "open", args: ["-b", "com.microsoft.VSCode", projectRoot] },
      { command: "open", args: ["-a", "Visual Studio Code", projectRoot] },
      { command: "code", args: [projectRoot] }
    );
  } else if (process.platform === "win32") {
    candidates.push(
      ...windowsVsCodePaths().filter((candidate) => existsSync(candidate)).map((command) => ({ command, args: [projectRoot] })),
      { command: "code.cmd", args: [projectRoot] },
      { command: "code", args: [projectRoot] }
    );
  } else {
    candidates.push({ command: "code", args: [projectRoot] });
  }

  const errors: string[] = [];
  for (const candidate of candidates) {
    const result = await launchDetached(candidate.command, candidate.args);
    if (result.ok) return true;
    if (result.error) errors.push(`${candidate.command}: ${result.error}`);
  }
  throw new Error(`Visual Studio Code could not be opened. Install VS Code or enable the "code" command in PATH. ${errors.join(" ")}`.trim());
}

const scheduledGraphEvidenceRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
const activeGraphEvidenceRefreshes = new Map<string, Promise<GraphEvidenceRefreshResult>>();

function graphEvidenceRefreshProgress(projectRoot: string, progress: GraphEvidenceRefreshProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("archicode:graph-evidence-refresh-progress", { projectRoot, ...progress });
  }
}

function publishGraphEvidenceRefresh(projectRoot: string, result: GraphEvidenceRefreshResult): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("archicode:external-project-updated", {
      projectRoot,
      source: "knowledge-refresh",
      action: result.policyEvaluationChanged ? "architecture-policies-evaluated" : "relationship-evidence-refreshed",
      refreshedEdges: result.refreshedEdges,
      unresolvedEdges: result.unresolvedEdges,
      policyViolations: result.policyViolations
    });
  }
}

function startGraphEvidenceRefresh(
  projectRoot: string,
  options: {
    flowId?: string;
    staleOnly?: boolean;
    refreshCodeKnowledge?: boolean;
    refreshCodeKnowledgeOnly?: boolean;
    preparedScan?: RepoScan;
    preparedFiles?: ParsedFile[];
    onProgress?: (progress: GraphEvidenceRefreshProgress) => void;
  } = {}
): Promise<GraphEvidenceRefreshResult> {
  const key = path.resolve(projectRoot);
  const active = activeGraphEvidenceRefreshes.get(key);
  if (active) return active;
  const refresh = refreshProjectGraphEvidence(projectRoot, options)
    .then((result) => {
      if (result.refreshedEdges || result.policyEvaluationChanged) publishGraphEvidenceRefresh(projectRoot, result);
      return result;
    })
    .finally(() => {
      activeGraphEvidenceRefreshes.delete(key);
    });
  activeGraphEvidenceRefreshes.set(key, refresh);
  return refresh;
}

function scheduleStaleGraphEvidenceRefresh(bundle: ProjectBundle, snapshotStale = false): void {
  const evidenceStale = bundle.flows.some((flow) => flow.edges.some((edge) =>
    edge.evidence?.freshness === "stale" && edge.evidence.verification === "verified"
  ));
  if (!evidenceStale && !snapshotStale) return;
  const key = path.resolve(bundle.rootPath);
  const previous = scheduledGraphEvidenceRefreshes.get(key);
  if (previous) clearTimeout(previous);
  scheduledGraphEvidenceRefreshes.set(key, setTimeout(() => {
    scheduledGraphEvidenceRefreshes.delete(key);
    void startGraphEvidenceRefresh(bundle.rootPath, {
      staleOnly: !snapshotStale,
      refreshCodeKnowledge: snapshotStale,
      onProgress: (progress) => graphEvidenceRefreshProgress(bundle.rootPath, progress)
    }).catch((error) => {
      console.warn(`[archicode] relationship evidence refresh failed for ${bundle.rootPath}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 1200));
}

function scheduleCodeKnowledgeSnapshotRefresh(bundle: ProjectBundle): void {
  void initializeProjectMaintenance(bundle).then(async () => {
    const snapshot = await readCodeKnowledgeSnapshot(bundle.rootPath);
    const snapshotStale = snapshot ? await codeKnowledgeSnapshotNeedsRefresh(bundle.rootPath, snapshot) : true;
    const semanticStatus = bundle.project.settings.semanticIndex.enabled
      ? await getSemanticIndexStatus(bundle.rootPath, true, semanticDocumentsForBundle(bundle))
      : null;
    const semanticNeedsRefresh = Boolean(semanticStatus && semanticIndexNeedsWarmup(semanticStatus));
    if (!snapshotStale && !semanticNeedsRefresh) return;
    const snapshotTime = snapshot ? Date.parse(snapshot.generatedAt) : 0;
    const ownSourceChangeAfterSnapshot = bundle.runs.some((run) =>
      run.status === "succeeded" &&
      run.sourceDiffArtifactIds.length > 0 &&
      Date.parse(run.completedAt ?? run.createdAt) > snapshotTime
    );
    scheduleProjectMaintenance(bundle.rootPath, ownSourceChangeAfterSnapshot ? "ai-run" : snapshotStale && snapshot ? "external-change" : "initial", 900);
  }).catch(() => undefined);
}

const MAINTENANCE_STATE_FILE = "project-maintenance.json";
const SOURCE_BASELINE_FILE = "source-analysis-baseline.json";
const maintenanceStatuses = new Map<string, ProjectMaintenanceStatus>();
const maintenanceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const maintenanceJobs = new Map<string, Promise<void>>();
const maintenancePendingReasons = new Map<string, Set<ProjectMaintenanceReason>>();
const maintenanceWatchers = new Map<string, FSWatcher>();
const maintenanceSemanticEnabled = new Map<string, boolean>();
const deferredRunSourceEvents = new Set<string>();
const deferredRunSourcePaths = new Map<string, Set<string>>();
const analyzedSourceHashes = new Map<string, Map<string, string>>();
const sourceVerificationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sourceVerificationPaths = new Map<string, Set<string>>();

function defaultMaintenanceStatus(projectRoot: string, graphAnalysisMayBeOutdated = false): ProjectMaintenanceStatus {
  return {
    projectRoot: path.resolve(projectRoot),
    state: "idle",
    tasks: [],
    message: graphAnalysisMayBeOutdated ? "Code changed since graph analysis." : "Background code data is current.",
    graphAnalysisMayBeOutdated,
    changedFiles: [],
    updatedAt: new Date().toISOString()
  };
}

function publishProjectMaintenance(status: ProjectMaintenanceStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("archicode:project-maintenance-updated", status);
  }
}

function updateProjectMaintenanceStatus(
  projectRoot: string,
  patch: Partial<Omit<ProjectMaintenanceStatus, "projectRoot">>
): ProjectMaintenanceStatus {
  const key = path.resolve(projectRoot);
  const current = maintenanceStatuses.get(key) ?? defaultMaintenanceStatus(key);
  const next: ProjectMaintenanceStatus = {
    ...current,
    ...patch,
    projectRoot: key,
    updatedAt: new Date().toISOString()
  };
  maintenanceStatuses.set(key, next);
  publishProjectMaintenance(next);
  return next;
}

async function persistGraphAnalysisFreshness(
  projectRoot: string,
  graphAnalysisMayBeOutdated: boolean,
  changedFiles?: ProjectMaintenanceChangedFile[]
): Promise<void> {
  const persistedFiles = graphAnalysisMayBeOutdated
    ? changedFiles ?? maintenanceStatuses.get(path.resolve(projectRoot))?.changedFiles ?? []
    : [];
  await writeJson(projectStatePath(projectRoot, "runtime", MAINTENANCE_STATE_FILE), {
    graphAnalysisMayBeOutdated,
    changedFiles: persistedFiles,
    updatedAt: new Date().toISOString()
  });
}

async function initializeProjectMaintenance(bundle: ProjectBundle): Promise<ProjectMaintenanceStatus> {
  const key = path.resolve(bundle.rootPath);
  maintenanceSemanticEnabled.set(key, bundle.project.settings.semanticIndex.enabled);
  if (!maintenanceStatuses.has(key)) {
    const persisted = await readJson<{ graphAnalysisMayBeOutdated?: boolean; changedFiles?: ProjectMaintenanceChangedFile[] } | null>(
      projectStatePath(key, "runtime", MAINTENANCE_STATE_FILE),
      null
    );
    const status = defaultMaintenanceStatus(key, persisted?.graphAnalysisMayBeOutdated === true);
    status.changedFiles = Array.isArray(persisted?.changedFiles)
      ? persisted.changedFiles.filter((item) => item && typeof item.path === "string" && ["added", "modified", "deleted"].includes(item.change))
      : [];
    maintenanceStatuses.set(key, status);
  }
  if (!analyzedSourceHashes.has(key)) {
    const baseline = await readJson<{ files?: Record<string, string> } | null>(
      projectStatePath(key, "runtime", SOURCE_BASELINE_FILE),
      null
    );
    analyzedSourceHashes.set(key, new Map(Object.entries(baseline?.files ?? {})));
  }
  ensureProjectSourceWatcher(key);
  return maintenanceStatuses.get(key)!;
}

function projectHasActiveRun(projectRoot: string): boolean {
  const prefix = `${path.resolve(projectRoot)}\0`;
  return [...sleepBlockingRunKeys].some((key) => key.startsWith(prefix));
}

function maintenanceTasks(projectRoot: string): ProjectMaintenanceTask[] {
  return maintenanceSemanticEnabled.get(path.resolve(projectRoot)) === false
    ? ["code-knowledge"]
    : ["semantic-index", "code-knowledge"];
}

function maintenanceMessage(tasks: ProjectMaintenanceTask[], phase: "scheduled" | "running"): string {
  const label = tasks.length === 2
    ? "semantic index and Code Knowledge Map"
    : tasks[0] === "semantic-index"
      ? "semantic index"
      : "Code Knowledge Map";
  return phase === "scheduled" ? `Waiting to update ${label}…` : `Updating ${label}…`;
}

function selectMaintenanceReason(reasons: Set<ProjectMaintenanceReason>): ProjectMaintenanceReason {
  if (reasons.has("external-change")) return "external-change";
  if (reasons.has("ai-run")) return "ai-run";
  if (reasons.has("retry")) return "retry";
  return "initial";
}

function scheduleProjectMaintenance(projectRoot: string, reason: ProjectMaintenanceReason, delayMs = 1800): void {
  const key = path.resolve(projectRoot);
  const reasons = maintenancePendingReasons.get(key) ?? new Set<ProjectMaintenanceReason>();
  reasons.add(reason);
  maintenancePendingReasons.set(key, reasons);
  const current = maintenanceStatuses.get(key) ?? defaultMaintenanceStatus(key);
  const graphAnalysisMayBeOutdated = current.graphAnalysisMayBeOutdated || reason === "external-change";
  if (graphAnalysisMayBeOutdated !== current.graphAnalysisMayBeOutdated) {
    void persistGraphAnalysisFreshness(key, true).catch(() => undefined);
  }
  if (maintenanceJobs.has(key)) {
    updateProjectMaintenanceStatus(key, {
      graphAnalysisMayBeOutdated,
      message: reason === "external-change" ? "Source changed again; background refresh will rerun with the latest files." : current.message
    });
    return;
  }
  const tasks = maintenanceTasks(key);
  updateProjectMaintenanceStatus(key, {
    state: "scheduled",
    tasks,
    reason,
    error: undefined,
    graphAnalysisMayBeOutdated,
    message: maintenanceMessage(tasks, "scheduled")
  });
  const previous = maintenanceTimers.get(key);
  if (previous) clearTimeout(previous);
  maintenanceTimers.set(key, setTimeout(() => {
    maintenanceTimers.delete(key);
    void runProjectMaintenance(key);
  }, delayMs));
}

async function runProjectMaintenance(projectRoot: string): Promise<void> {
  const key = path.resolve(projectRoot);
  if (maintenanceJobs.has(key)) return maintenanceJobs.get(key);
  if (projectHasActiveRun(key)) {
    scheduleProjectMaintenance(key, selectMaintenanceReason(maintenancePendingReasons.get(key) ?? new Set(["initial"])), 1500);
    return;
  }
  const reasons = maintenancePendingReasons.get(key) ?? new Set<ProjectMaintenanceReason>(["initial"]);
  maintenancePendingReasons.delete(key);
  const reason = selectMaintenanceReason(reasons);
  const job = (async () => {
    const bundle = await loadProject(key);
    maintenanceSemanticEnabled.set(key, bundle.project.settings.semanticIndex.enabled);
    const tasks = maintenanceTasks(key);
    updateProjectMaintenanceStatus(key, {
      state: "running",
      tasks,
      reason,
      error: undefined,
      message: maintenanceMessage(tasks, "running")
    });
    const scan = await scanRepository(key);
    const sourceHashes = await collectAnalyzedSourceHashes(key, scan);
    const previousHashes = analyzedSourceHashes.get(key) ?? new Map<string, string>();
    if (reason === "external-change" && previousHashes.size) {
      recordProjectSourceChanges(key, projectMaintenanceChangesBetweenHashes(previousHashes, sourceHashes));
    }
    const parsed = await parseFiles(key, scan.files);
    if (bundle.project.settings.semanticIndex.enabled) {
      await rebuildSemanticIndexForBundle(key, bundle, publishSemanticIndexProgress, undefined, { scan, parsed });
      const ready = await getSemanticIndexStatus(key, true, semanticDocumentsForBundle(bundle));
      publishSemanticIndexProgress({
        phase: "ready",
        completed: ready.indexedItems,
        total: ready.indexedItems,
        message: `Semantic index ready with ${ready.codeItems.toLocaleString()} code records and ${ready.graphItems.toLocaleString()} graph records.`,
        projectRoot: key
      });
    }
    await startGraphEvidenceRefresh(key, {
      staleOnly: false,
      refreshCodeKnowledge: true,
      refreshCodeKnowledgeOnly: true,
      preparedScan: scan,
      preparedFiles: parsed,
      onProgress: (progress) => updateProjectMaintenanceStatus(key, {
        state: "running",
        tasks,
        reason,
        message: progress.label
      })
    });
    await rememberAnalyzedSourceHashes(key, sourceHashes);
    const current = maintenanceStatuses.get(key) ?? defaultMaintenanceStatus(key);
    updateProjectMaintenanceStatus(key, {
      state: "idle",
      tasks: [],
      reason,
      error: undefined,
      message: current.graphAnalysisMayBeOutdated
        ? "Derived code data is current. Code changed since graph analysis."
        : "Background code data is current."
    });
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    updateProjectMaintenanceStatus(key, {
      state: "error",
      tasks: maintenanceTasks(key),
      reason,
      error: message,
      message: "Background code-data refresh failed."
    });
    console.warn(`[archicode] project maintenance failed for ${key}: ${message}`);
  }).finally(() => {
    if (maintenanceJobs.get(key) === job) maintenanceJobs.delete(key);
    const pending = maintenancePendingReasons.get(key);
    if (pending?.size) scheduleProjectMaintenance(key, selectMaintenanceReason(pending), 900);
  });
  maintenanceJobs.set(key, job);
  return job;
}

function isMaintenanceSourcePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith(".git/") || normalized.startsWith(".archicode/")) return false;
  if (/(^|\/)(node_modules|out|release|dist|build|coverage|\.cache|\.vite|\.next|\.turbo)(\/|$)/.test(normalized)) return false;
  return Boolean(languageForSemanticSource(normalized)) || roleForFile(normalized) === "config";
}

async function collectAnalyzedSourceHashes(projectRoot: string, scan: RepoScan): Promise<Map<string, string>> {
  const files = scan.files.map((file) => file.relPath).filter(isMaintenanceSourcePath);
  const hashes = new Map<string, string>();
  for (let offset = 0; offset < files.length; offset += 32) {
    await Promise.all(files.slice(offset, offset + 32).map(async (relativePath) => {
      const hash = await sha256File(path.resolve(projectRoot, relativePath)).catch(() => null);
      if (hash) hashes.set(relativePath, hash);
    }));
  }
  return hashes;
}

async function rememberAnalyzedSourceHashes(projectRoot: string, hashes: Map<string, string>): Promise<void> {
  analyzedSourceHashes.set(path.resolve(projectRoot), hashes);
  await writeJson(projectStatePath(projectRoot, "runtime", SOURCE_BASELINE_FILE), {
    analyzedAt: new Date().toISOString(),
    files: Object.fromEntries(hashes)
  });
}

function recordProjectSourceChanges(projectRoot: string, changes: ProjectMaintenanceChangedFile[]): void {
  if (!changes.length) return;
  const key = path.resolve(projectRoot);
  const current = maintenanceStatuses.get(key) ?? defaultMaintenanceStatus(key);
  const changedFiles = mergeProjectMaintenanceChanges(current.changedFiles, changes);
  updateProjectMaintenanceStatus(key, { graphAnalysisMayBeOutdated: true, changedFiles });
  void persistGraphAnalysisFreshness(key, true, changedFiles).catch(() => undefined);
}

function markProjectSourceDrift(projectRoot: string, changes: ProjectMaintenanceChangedFile[] = []): void {
  const key = path.resolve(projectRoot);
  if (projectHasActiveRun(key)) {
    deferredRunSourceEvents.add(key);
    for (const change of changes) deferProjectSourcePath(key, change.path);
    return;
  }
  recordProjectSourceChanges(key, changes);
  scheduleProjectMaintenance(key, "external-change");
}

function deferProjectSourcePath(projectRoot: string, relativePath: string): void {
  const key = path.resolve(projectRoot);
  deferredRunSourceEvents.add(key);
  const paths = deferredRunSourcePaths.get(key) ?? new Set<string>();
  paths.add(relativePath.replaceAll("\\", "/").replace(/^\.\//, ""));
  deferredRunSourcePaths.set(key, paths);
}

function queueProjectSourceDriftVerification(projectRoot: string, changedPaths: string[]): void {
  const key = path.resolve(projectRoot);
  const paths = sourceVerificationPaths.get(key) ?? new Set<string>();
  for (const changedPath of changedPaths) {
    const normalized = changedPath.replaceAll("\\", "/").replace(/^\.\//, "");
    if (isMaintenanceSourcePath(normalized)) paths.add(normalized);
  }
  if (!paths.size) return;
  sourceVerificationPaths.set(key, paths);
  const previous = sourceVerificationTimers.get(key);
  if (previous) clearTimeout(previous);
  sourceVerificationTimers.set(key, setTimeout(() => {
    sourceVerificationTimers.delete(key);
    const candidates = [...(sourceVerificationPaths.get(key) ?? [])];
    sourceVerificationPaths.delete(key);
    void (async () => {
      const baseline = analyzedSourceHashes.get(key) ?? new Map<string, string>();
      const current = new Map<string, string>();
      for (const relativePath of candidates) {
        const currentHash = await sha256File(path.resolve(key, relativePath)).catch(() => null);
        if (currentHash) current.set(relativePath, currentHash);
      }
      const changes = projectMaintenanceChangesBetweenHashes(baseline, current, new Set(candidates));
      if (changes.length) markProjectSourceDrift(key, changes);
    })();
  }, 1200));
}

function reportProjectSourceDrift(projectRoot: string, changedPaths: string[] = ["*"]): void {
  if (changedPaths.includes("*")) {
    markProjectSourceDrift(projectRoot);
    return;
  }
  queueProjectSourceDriftVerification(projectRoot, changedPaths);
}

function ensureProjectSourceWatcher(projectRoot: string): void {
  const key = path.resolve(projectRoot);
  if (maintenanceWatchers.has(key)) return;
  try {
    const watcher = watchFs(key, { recursive: true }, (_eventType, fileName) => {
      if (!fileName) return;
      const relativePath = fileName.toString();
      if (!isMaintenanceSourcePath(relativePath)) return;
      if (projectHasActiveRun(key)) {
        deferProjectSourcePath(key, relativePath);
        return;
      }
      queueProjectSourceDriftVerification(key, [relativePath]);
    });
    watcher.on("error", (error) => {
      console.warn(`[archicode] source watcher stopped for ${key}: ${error.message}`);
      maintenanceWatchers.delete(key);
    });
    maintenanceWatchers.set(key, watcher);
  } catch (error) {
    console.warn(`[archicode] recursive source watcher unavailable for ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function noteRunMaintenanceTransition(projectRoot: string, run: Run, previousStatus: Run["status"] | undefined): void {
  const key = path.resolve(projectRoot);
  if (!runIsTerminal(run) || previousStatus === run.status) return;
  const hadDeferredEvents = deferredRunSourceEvents.delete(key);
  const deferredPaths = [...(deferredRunSourcePaths.get(key) ?? [])];
  deferredRunSourcePaths.delete(key);
  if (run.sourceDiffArtifactIds.length > 0) {
    scheduleProjectMaintenance(key, "ai-run", 500);
  } else if (hadDeferredEvents) {
    if (deferredPaths.length) queueProjectSourceDriftVerification(key, deferredPaths);
    else markProjectSourceDrift(key);
  }
}

async function markGraphAnalysisCurrent(projectRoot: string): Promise<void> {
  const key = path.resolve(projectRoot);
  const current = maintenanceStatuses.get(key) ?? defaultMaintenanceStatus(key);
  updateProjectMaintenanceStatus(key, {
    graphAnalysisMayBeOutdated: false,
    changedFiles: [],
    message: current.state === "idle" ? "Background code data is current." : current.message
  });
  await persistGraphAnalysisFreshness(key, false);
}

async function dismissProjectMaintenanceWarning(projectRoot: string): Promise<ProjectMaintenanceStatus> {
  const key = path.resolve(projectRoot);
  const current = maintenanceStatuses.get(key) ?? defaultMaintenanceStatus(key);
  const next = updateProjectMaintenanceStatus(key, {
    graphAnalysisMayBeOutdated: false,
    changedFiles: [],
    message: current.state === "idle" ? "Background code data is current." : current.message
  });
  await persistGraphAnalysisFreshness(key, false);
  return next;
}

function registerIpc(): void {
  setRunUpdatePublisher((projectRoot, run) => {
    const key = runNotificationKey(projectRoot, run.id);
    const previousStatus = notifiedRunStatuses.get(key);
    notifiedRunStatuses.set(key, run.status);
    void notifyRunFinishedIfNeeded(projectRoot, run, previousStatus);
    trackRunSleepBlocker(projectRoot, run);
    noteRunMaintenanceTransition(projectRoot, run, previousStatus);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("archicode:run-updated", { projectRoot, run });
    }
  });
  setExternalMcpProjectUpdatePublisher((projectRoot, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("archicode:external-project-updated", { projectRoot, ...payload });
    }
  });

  ipcMain.handle("archicode:app-version", () => app.getVersion());
  ipcMain.handle("archicode:default-root", () => lastProjectRoot());
  ipcMain.handle("archicode:list-recent-projects", () => listRecentProjects());
  ipcMain.handle("archicode:check-for-updates", () => checkForAppUpdate(app.getVersion()));
  ipcMain.handle("archicode:get-global-providers", async () =>
    (await globalProviders({ includeSecrets: true })) ?? applyPlatformCodexLocalDefaults(createSeedProject("").project.settings.providers)
  );
  ipcMain.handle("archicode:get-global-research-personality", () => globalResearchPersonality());
  ipcMain.handle("archicode:get-global-research-verbosity", () => globalResearchVerbosity());
  ipcMain.handle("archicode:get-semantic-model-preference", () => globalSemanticModelPreference());
  ipcMain.handle("archicode:set-semantic-model-preference", async (_event, preference: SemanticModelPreferenceId, projectRoot?: string) => {
    semanticWarmupGeneration += 1;
    const selected = await rememberSemanticModelPreference(preference);
    if (projectRoot) {
      const bundle = await loadProject(projectRoot);
      scheduleSemanticIndexWarmup(bundle, true);
    }
    return selected;
  });
  ipcMain.handle("archicode:get-keybindings", () => readStoredKeybindings());
  ipcMain.handle("archicode:save-keybindings", async (_event, next: Record<string, StoredKeyChord>) =>
    rememberStoredKeybindings(next ?? {})
  );
  ipcMain.handle("archicode:get-global-provider-secret-status", () => globalProviderSecretStatus());
  ipcMain.handle("archicode:get-web-search-secret-status", () => webSearchSecretStatus());
  ipcMain.handle("archicode:save-global-providers", async (_event, providers: ProjectSettings["providers"], options?: { preserveMissingSecrets?: boolean; includeSecrets?: boolean }) => {
    await rememberGlobalProviders(providers, options);
    return globalProviders({ includeSecrets: options?.includeSecrets ?? true });
  });
  ipcMain.handle("archicode:save-web-search-secrets", async (_event, secrets: { braveApiKey?: string }, options?: { preserveMissingSecrets?: boolean }) =>
    rememberWebSearchSecrets(secrets ?? {}, options)
  );
  ipcMain.handle("archicode:save-global-research-personality", async (_event, personality: GlobalResearchPersonality) =>
    rememberGlobalResearchPersonality(personality)
  );
  ipcMain.handle("archicode:save-global-research-verbosity", async (_event, verbosity: GlobalResearchVerbosity) =>
    rememberGlobalResearchVerbosity(verbosity)
  );
  ipcMain.handle("archicode:get-global-speech-settings", () => globalSpeechSettings());
  ipcMain.handle("archicode:save-global-speech-settings", async (_event, settings: SpeechSettings) =>
    rememberGlobalSpeechSettings(settings)
  );
  ipcMain.handle("archicode:get-global-tts-settings", () => globalTtsSettings());
  ipcMain.handle("archicode:save-global-tts-settings", async (_event, settings: TtsSettings) =>
    rememberGlobalTtsSettings(settings)
  );
  ipcMain.handle("archicode:ensure-project", async (_event, projectRoot: string) =>
    syncBundleExternalMcpHost(syncBundleSleepBlocker(await ensureProject(projectRoot)))
  );
  ipcMain.handle("archicode:get-git-attributes-status", async (_event, projectRoot: string) =>
    archicodeGitAttributesStatus(projectRoot)
  );
  ipcMain.handle("archicode:enable-git-attributes", async (_event, projectRoot: string) =>
    enableArchicodeGitAttributes(projectRoot)
  );
  ipcMain.handle("archicode:load-project", async (_event, projectRoot: string) => {
    const bundle = await syncBundleExternalMcpHost(syncBundleSleepBlocker(await loadProject(projectRoot)));
    await initializeProjectMaintenance(bundle);
    scheduleStaleGraphEvidenceRefresh(bundle);
    scheduleCodeKnowledgeSnapshotRefresh(bundle);
    return bundle;
  });
  ipcMain.handle("archicode:refresh-graph-evidence", async (event, projectRoot: string, flowId?: string): Promise<GraphEvidenceRefreshResult> => {
    const result = await startGraphEvidenceRefresh(projectRoot, {
      flowId,
      staleOnly: false,
      onProgress: (progress) => event.sender.send("archicode:graph-evidence-refresh-progress", { projectRoot, ...progress })
    });
    return result;
  });
  ipcMain.handle("archicode:get-code-knowledge-snapshot", async (_event, projectRoot: string) =>
    readCodeKnowledgeSnapshot(projectRoot)
  );
  ipcMain.handle("archicode:open-project-folder", async () => {
    const result = await dialog.showOpenDialog({
      title: "Open ArchiCode Project Folder",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return openProjectRoot(result.filePaths[0]);
  });
  ipcMain.handle("archicode:clone-git-repository", async (_event, remoteUrl: string) => {
    const result = await dialog.showOpenDialog({
      title: "Choose Git Clone Destination",
      buttonLabel: "Clone here",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const clonedRoot = await gitCloneRepository(remoteUrl, result.filePaths[0]);
    return openProjectRoot(clonedRoot);
  });
  ipcMain.handle("archicode:open-recent-project", async (_event, projectRoot: string) => openProjectRoot(projectRoot));
  ipcMain.handle("archicode:reveal-project-folder", async (_event, projectRoot: string) => {
    if (!projectRoot || !existsSync(projectRoot)) {
      throw new Error("Project folder was not found.");
    }
    const error = await shell.openPath(projectRoot);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle("archicode:open-project-path", async (_event, projectRoot: string, relativePath: string) =>
    openProjectPath(projectRoot, relativePath)
  );
  ipcMain.handle("archicode:open-project-file", async (_event, projectRoot: string, relativePath: string) =>
    openProjectFile(projectRoot, relativePath)
  );
  ipcMain.handle("archicode:open-project-file-with-app", async (_event, projectRoot: string, relativePath: string) =>
    openProjectFileWithAppChooser(projectRoot, relativePath)
  );
  ipcMain.handle("archicode:maximize-window", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) return false;
    if (!win.isMaximized()) win.maximize();
    win.focus();
    return true;
  });
  ipcMain.handle("archicode:open-project-in-vscode", async (_event, projectRoot: string) => openProjectInVsCode(projectRoot));
  ipcMain.handle("archicode:open-external-url", async (_event, url: string) => {
    const parsed = new URL(url);
    if (!isExternalUrl(parsed.toString())) {
      throw new Error("Only external http, https, and mailto links can be opened from ArchiCode.");
    }
    await shell.openExternal(parsed.toString());
    return true;
  });
  ipcMain.handle("archicode:show-system-notification", async (_event, input: { title: string; body?: string }) => {
    return showSystemNotification(input, "renderer request");
  });
  ipcMain.handle("archicode:pick-image-files", async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS }]
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("archicode:pick-research-attachment-files", async (_event, includeImages: boolean = true) => {
    const win = BrowserWindow.getFocusedWindow();
    const options = attachmentFileDialogOptions("Attach Research Files", { includeImages });
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("archicode:pick-reference-files", async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options = referenceFileDialogOptions();
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("archicode:create-project", async (_event, templateId) => {
    const result = await dialog.showOpenDialog({
      title: "Create ArchiCode Project Folder",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const bundle = await syncBundleExternalMcpHost(await createProject(result.filePaths[0], templateId));
    await rememberProjectRoot(bundle.rootPath);
    return bundle;
  });
  ipcMain.handle("archicode:save-flow", async (_event, projectRoot, flow) => saveFlow(projectRoot, flow, { recordGraphChanges: true, actor: "user" }));
  ipcMain.handle("archicode:import-flow", async (_event, projectRoot) => {
    const win = BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      title: "Import ArchiCode Flow JSON",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return importFlow(projectRoot, result.filePaths[0]);
  });
  ipcMain.handle("archicode:import-drawio-flow", async (_event, projectRoot, options) => {
    const win = BrowserWindow.getFocusedWindow();
    const openOptions: OpenDialogOptions = {
      title: "Import draw.io Diagram",
      properties: ["openFile"],
      filters: [
        { name: "draw.io / diagrams.net", extensions: ["drawio", "xml"] },
        { name: "All Files", extensions: ["*"] }
      ]
    };
    const result = win ? await dialog.showOpenDialog(win, openOptions) : await dialog.showOpenDialog(openOptions);
    if (result.canceled || !result.filePaths[0]) return null;
    const sourceFilePath = result.filePaths[0];
    const pages = await listDrawioPages(sourceFilePath);
    if (!pages.length) throw new Error("No draw.io pages were found in this file.");
    let pageIndex = pages[0].index;
    if (pages.length > 1) {
      const buttons = [...pages.map((page) => page.name), "Cancel"];
      const choice = win
        ? await dialog.showMessageBox(win, {
          type: "question",
          title: "Choose draw.io Page",
          message: "Choose one draw.io page to import into the current ArchiCode scope.",
          buttons,
          cancelId: buttons.length - 1,
          defaultId: 0,
          noLink: true
        })
        : await dialog.showMessageBox({
          type: "question",
          title: "Choose draw.io Page",
          message: "Choose one draw.io page to import into the current ArchiCode scope.",
          buttons,
          cancelId: buttons.length - 1,
          defaultId: 0,
          noLink: true
        });
      if (choice.response === buttons.length - 1) return null;
      pageIndex = pages[choice.response]?.index ?? pages[0].index;
    }
    return importDrawioFlow(projectRoot, sourceFilePath, { ...options, pageIndex });
  });
  ipcMain.handle("archicode:export-flow", async (_event, projectRoot, flowId) => {
    const win = BrowserWindow.getFocusedWindow();
    const options: SaveDialogOptions = {
      title: "Export ArchiCode Flow JSON",
      defaultPath: `${flowId}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }]
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    await exportFlow(projectRoot, flowId, result.filePath);
    return true;
  });
  ipcMain.handle("archicode:export-drawio-flow", async (_event, projectRoot, flowId, subflowId) => {
    const win = BrowserWindow.getFocusedWindow();
    const defaultName = subflowId ? `${flowId}-${subflowId}.drawio.xml` : `${flowId}.drawio.xml`;
    const options: SaveDialogOptions = {
      title: "Export draw.io Diagram",
      defaultPath: defaultName,
      filters: [
        { name: "draw.io / diagrams.net XML", extensions: ["drawio.xml", "drawio", "xml"] },
        { name: "All Files", extensions: ["*"] }
      ]
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    await exportDrawioFlow(projectRoot, flowId, result.filePath, subflowId);
    return true;
  });
  ipcMain.handle("archicode:export-project-bundle", async (_event, projectRoot) => {
    const win = BrowserWindow.getFocusedWindow();
    const options: SaveDialogOptions = {
      title: "Export ArchiCode Project Bundle",
      defaultPath: "archicode-project-bundle.json",
      filters: [{ name: "JSON", extensions: ["json"] }]
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    await exportProjectBundle(projectRoot, result.filePath);
    return true;
  });
  ipcMain.handle("archicode:export-project-document", async (_event, projectRoot: string, flowIds: string[], format: ProjectDocumentExportFormat) => {
    if (format !== "pdf" && format !== "html") throw new Error(`Unsupported project export format: ${format}`);
    const bundle = await loadProject(projectRoot);
    const selectedFlowIds = [...new Set(flowIds)].filter((flowId) => bundle.flows.some((flow) => flow.id === flowId));
    if (!selectedFlowIds.length) throw new Error("Choose at least one flow to export.");
    const win = BrowserWindow.getFocusedWindow();
    const extension = format === "pdf" ? "pdf" : "html";
    const safeProjectName = bundle.project.name.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "archicode-project";
    const options: SaveDialogOptions = {
      title: `Export ArchiCode Project ${format.toUpperCase()}`,
      defaultPath: `${safeProjectName}.${extension}`,
      filters: [{ name: format === "pdf" ? "PDF document" : "HTML document", extensions: [extension] }]
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    await exportProjectDocument(bundle, selectedFlowIds, format, result.filePath);
    return true;
  });
  ipcMain.handle("archicode:repair-project", async (_event, projectRoot) =>
    syncBundleSleepBlocker(await repairProject(projectRoot))
  );
  ipcMain.handle("archicode:delete-project-state", async (_event, projectRoot: string) => {
    await stopExternalMcpHost();
    const result = await deleteProjectState(projectRoot);
    syncProjectSleepBlocker(projectRoot, []);
    await forgetProjectRoot(projectRoot);
    return result;
  });
  ipcMain.handle("archicode:add-note", async (_event, projectRoot, note) => addNote(projectRoot, note));
  ipcMain.handle("archicode:update-note-resolved", async (_event, projectRoot, noteId, resolved) =>
    updateNoteResolved(projectRoot, noteId, resolved)
  );
  ipcMain.handle("archicode:update-note-pinned", async (_event, projectRoot, noteId, pinned) =>
    updateNotePinned(projectRoot, noteId, pinned)
  );
  ipcMain.handle("archicode:delete-note", async (_event, projectRoot, noteId) => deleteNote(projectRoot, noteId));
  ipcMain.handle("archicode:purge-resolved-notes", async (_event, projectRoot, scope) => purgeResolvedNotes(projectRoot, scope));
  ipcMain.handle("archicode:purge-system-notes", async (_event, projectRoot, scope) => purgeSystemNotes(projectRoot, scope));
  ipcMain.handle("archicode:attach-node-references", async (_event, projectRoot, flowId, nodeId, noteId) => {
    const win = BrowserWindow.getFocusedWindow();
    const options = referenceFileDialogOptions();
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return attachNodeReferences(projectRoot, { flowId, nodeId, noteId, filePaths: result.filePaths });
  });
  ipcMain.handle("archicode:attach-node-reference-files", async (_event, projectRoot, flowId, nodeId, noteId, filePaths) =>
    attachNodeReferences(projectRoot, { flowId, nodeId, noteId, filePaths })
  );
  ipcMain.handle("archicode:update-node", async (_event, projectRoot, flowId, patch, actor) => updateNode(projectRoot, flowId, patch, actor));
  ipcMain.handle("archicode:author-acceptance-tests", async (_event, projectRoot, flowId, nodeId, providerId) =>
    withSleepBlocked(`author-tests:${projectRoot}:${nodeId ?? flowId}`, async () => (await authorAcceptanceTestsScoped(projectRoot, flowId, nodeId, providerId)).bundle));
  ipcMain.handle("archicode:author-acceptance-tests-flow", async (_event, projectRoot, flowId, providerId) =>
    withSleepBlocked(`author-tests-flow:${projectRoot}:${flowId}`, async () => (await authorAcceptanceTestsScoped(projectRoot, flowId, undefined, providerId)).bundle));
  ipcMain.handle("archicode:clear-acceptance-tests", async (_event, projectRoot, flowId, nodeId) =>
    withSleepBlocked(`clear-tests:${projectRoot}:${nodeId}`, async () => clearNodeAcceptanceTests(projectRoot, flowId, nodeId)));
  ipcMain.handle("archicode:enhance-node-field", async (_event, projectRoot, flowId, nodeId, field, providerId) =>
    withSleepBlocked(`enhance-node-field:${projectRoot}:${nodeId}:${field}`, async () => enhanceNodeField(projectRoot, flowId, nodeId, field, providerId)));
  ipcMain.handle("archicode:run-acceptance-checks", async (_event, projectRoot, flowId, nodeId) =>
    withSleepBlocked(`run-checks:${projectRoot}:${nodeId}`, async () => (await runNodeAcceptanceChecks(projectRoot, flowId, nodeId)).bundle));
  ipcMain.handle("archicode:update-project-details", async (_event, projectRoot, patch) => updateProjectDetails(projectRoot, patch));
  ipcMain.handle("archicode:update-project-settings", async (_event, projectRoot, settings) => {
    const previous = await loadProject(projectRoot);
    const bundle = await syncBundleExternalMcpHost(await updateProjectSettings(projectRoot, settings));
    await initializeProjectMaintenance(bundle);
    if (JSON.stringify(previous.project.settings.nodeRules ?? []) !== JSON.stringify(bundle.project.settings.nodeRules ?? [])) {
      scheduleProjectMaintenance(bundle.rootPath, "initial", 250);
    }
    if (!previous.project.settings.semanticIndex.enabled && bundle.project.settings.semanticIndex.enabled) {
      scheduleProjectMaintenance(bundle.rootPath, "initial", 500);
    }
    return bundle;
  });
  ipcMain.handle("archicode:get-project-maintenance-status", async (_event, projectRoot: string): Promise<ProjectMaintenanceStatus> => {
    const bundle = await loadProject(projectRoot);
    return initializeProjectMaintenance(bundle);
  });
  ipcMain.handle("archicode:retry-project-maintenance", async (_event, projectRoot: string): Promise<ProjectMaintenanceStatus> => {
    const bundle = await loadProject(projectRoot);
    await initializeProjectMaintenance(bundle);
    scheduleProjectMaintenance(projectRoot, "retry", 100);
    return maintenanceStatuses.get(path.resolve(projectRoot)) ?? defaultMaintenanceStatus(projectRoot);
  });
  ipcMain.handle("archicode:dismiss-project-maintenance-warning", async (_event, projectRoot: string): Promise<ProjectMaintenanceStatus> => {
    const bundle = await loadProject(projectRoot);
    await initializeProjectMaintenance(bundle);
    return dismissProjectMaintenanceWarning(projectRoot);
  });
  ipcMain.handle("archicode:report-project-source-drift", async (_event, projectRoot: string, changedPaths?: string[]) => {
    const bundle = await loadProject(projectRoot);
    await initializeProjectMaintenance(bundle);
    reportProjectSourceDrift(projectRoot, changedPaths?.length ? changedPaths : ["*"]);
    return maintenanceStatuses.get(path.resolve(projectRoot)) ?? defaultMaintenanceStatus(projectRoot);
  });
  ipcMain.handle("archicode:get-semantic-index-status", async (_event, projectRoot: string): Promise<SemanticIndexStatus> => {
    const bundle = await loadProject(projectRoot);
    return getSemanticIndexStatus(projectRoot, bundle.project.settings.semanticIndex.enabled, semanticDocumentsForBundle(bundle));
  });
  ipcMain.handle("archicode:get-node-semantic-context", async (
    _event,
    projectRoot: string,
    flowId: string,
    nodeId: string,
    refresh = false
  ): Promise<SemanticNodeContext> => {
    const bundle = await loadProject(projectRoot);
    return getSemanticNodeContext(projectRoot, bundle, flowId, nodeId, refresh);
  });
  ipcMain.handle("archicode:get-semantic-code-line-context", async (_event, projectRoot: string, relativePath: string, lineNumber: number) => {
    const bundle = await loadProject(projectRoot);
    return getSemanticCodeLineContext(projectRoot, bundle, relativePath, lineNumber);
  });
  ipcMain.handle("archicode:get-semantic-code-file-contexts", async (_event, projectRoot: string, relativePath: string) => {
    const bundle = await loadProject(projectRoot);
    return getSemanticCodeFileContexts(projectRoot, bundle, relativePath);
  });
  ipcMain.handle("archicode:rebuild-semantic-index", async (event, projectRoot: string): Promise<SemanticIndexStatus> => {
    const bundle = await loadProject(projectRoot);
    if (!bundle.project.settings.semanticIndex.enabled) return getSemanticIndexStatus(projectRoot, false);
    await rebuildSemanticIndexForBundle(projectRoot, bundle, (progress) => event.sender.send("archicode:semantic-index-progress", progress));
    return getSemanticIndexStatus(projectRoot, true, semanticDocumentsForBundle(bundle));
  });
  ipcMain.handle("archicode:clear-semantic-index", async (_event, projectRoot: string): Promise<SemanticIndexStatus> => {
    const bundle = await loadProject(projectRoot);
    await clearSemanticIndex(projectRoot);
    return getSemanticIndexStatus(projectRoot, bundle.project.settings.semanticIndex.enabled, semanticDocumentsForBundle(bundle));
  });
  ipcMain.handle("archicode:get-external-mcp-host-status", async (_event, projectRoot: string): Promise<ExternalMcpHostStatus> =>
    getExternalMcpHostStatus(projectRoot)
  );
  ipcMain.handle("archicode:regenerate-external-mcp-host-token", async (_event, projectRoot: string): Promise<ExternalMcpHostStatus> =>
    regenerateExternalMcpHostAuth(projectRoot)
  );
  ipcMain.handle("archicode:get-speech-status", async (_event, modelId) => getSpeechRuntimeStatus(modelId));
  ipcMain.handle("archicode:download-speech-model", async (event, modelId) =>
    downloadSpeechModel(modelId, (progress) => event.sender.send("archicode:speech-model-download-progress", progress))
  );
  ipcMain.handle("archicode:delete-speech-model", async (_event, modelId) => deleteSpeechModel(modelId));
  ipcMain.handle("archicode:transcribe-speech", async (_event, input) =>
    withSleepBlocked("speech-transcription", () => transcribeSpeech(input))
  );
  ipcMain.handle("archicode:get-tts-status", async (_event, modelId) => getTtsRuntimeStatus(modelId));
  ipcMain.handle("archicode:download-tts-model", async (event, modelId, voiceId) =>
    downloadTtsModel(modelId, voiceId, (progress) => event.sender.send("archicode:tts-model-download-progress", progress))
  );
  ipcMain.handle("archicode:delete-tts-model", async (_event, modelId) => deleteTtsModel(modelId));
  ipcMain.handle("archicode:warm-tts-model", async (_event, modelId, voiceId) => warmTtsModel(modelId, voiceId));
  ipcMain.handle("archicode:synthesize-speech", async (_event, input) =>
    withSleepBlocked("speech-synthesis", () => synthesizeSpeech(input))
  );
  ipcMain.handle("archicode:stream-speech", async (event, input) =>
    withSleepBlocked("speech-synthesis", () =>
      streamSpeech(input, (chunk) => event.sender.send("archicode:tts-speech-stream-chunk", {
        streamId: input.streamId,
        ...chunk
      }))
    )
  );
  ipcMain.handle("archicode:write-tts-debug-log", async (_event, input) => writeTtsDebugLog(input));
  ipcMain.handle("archicode:list-agent-instruction-files", async (_event, projectRoot: string) => listAgentInstructionFiles(projectRoot));
  ipcMain.handle("archicode:read-agent-instruction-file", async (_event, projectRoot: string, filePath?: string) =>
    readAgentInstructionFile(projectRoot, filePath)
  );
  ipcMain.handle("archicode:write-agent-instruction-file", async (_event, projectRoot: string, filePath: string, text: string) =>
    writeAgentInstructionFile(projectRoot, filePath, text)
  );
  ipcMain.handle("archicode:read-agent-memory", async (_event, projectRoot: string) => readAgentMemory(projectRoot));
  ipcMain.handle("archicode:write-agent-memory", async (_event, projectRoot: string, text: string) => writeAgentMemory(projectRoot, text));
  ipcMain.handle("archicode:check-provider", async (_event, projectRoot, providerId) => checkProjectProvider(projectRoot, providerId));
  ipcMain.handle("archicode:check-global-provider", async (_event, providerId) => checkGlobalProvider(providerId));
  ipcMain.handle("archicode:list-project-skills", async (_event, projectRoot: string) => listProjectSkills(projectRoot));
  ipcMain.handle("archicode:create-project-skill", async (_event, projectRoot: string, input) => createProjectSkill(projectRoot, input));
  ipcMain.handle("archicode:list-mcp-servers", async (_event, projectRoot: string) => listMcpServers(projectRoot));
  ipcMain.handle("archicode:search-mcp-registry", async (_event, input) => searchMcpRegistry(input));
  ipcMain.handle("archicode:install-mcp-registry-server", async (_event, projectRoot: string, input) =>
    installProjectMcpRegistryServer(projectRoot, input)
  );
  ipcMain.handle("archicode:import-mcp-servers", async (_event, projectRoot: string, source) => importProjectMcpServers(projectRoot, source));
  ipcMain.handle("archicode:update-mcp-server", async (_event, projectRoot: string, server) => updateMcpServer(projectRoot, server));
  ipcMain.handle("archicode:refresh-mcp-server-capabilities", async (_event, projectRoot: string, serverId: string) =>
    refreshProjectMcpServerCapabilities(projectRoot, serverId)
  );
  ipcMain.handle("archicode:list-patch-proposals", async (_event, projectRoot) => listPatchProposals(projectRoot));
  ipcMain.handle("archicode:read-artifact-text", async (_event, projectRoot, artifactPath) => readArtifactText(projectRoot, artifactPath));
  ipcMain.handle("archicode:read-artifact-data-url", async (_event, projectRoot, artifactPath) => readArtifactDataUrl(projectRoot, artifactPath));
  ipcMain.handle("archicode:get-git-status", async (_event, projectRoot: string) => getGitStatus(projectRoot));
  ipcMain.handle("archicode:git-init", async (_event, projectRoot: string) => gitInit(projectRoot));
  ipcMain.handle("archicode:git-pull", async (_event, projectRoot: string) => gitPull(projectRoot));
  ipcMain.handle("archicode:git-push", async (_event, projectRoot: string) => gitPush(projectRoot));
  ipcMain.handle("archicode:git-discard-changes", async (_event, projectRoot: string) => gitDiscardChanges(projectRoot));
  ipcMain.handle("archicode:git-stash-changes", async (_event, projectRoot: string, message?: string) => gitStashChanges(projectRoot, message));
  ipcMain.handle("archicode:git-pop-stash", async (_event, projectRoot: string, stashRef: string) => gitPopStash(projectRoot, stashRef));
  ipcMain.handle("archicode:git-switch-branch", async (_event, projectRoot: string, branch: string) => gitSwitchBranch(projectRoot, branch));
  ipcMain.handle("archicode:git-create-branch", async (_event, projectRoot: string, branch: string) => gitCreateBranch(projectRoot, branch));
  ipcMain.handle("archicode:git-commit", async (_event, projectRoot: string, message: string, files: string[]) =>
    gitCommit(projectRoot, message, files)
  );
  ipcMain.handle("archicode:generate-git-commit-message", async (_event, projectRoot: string, files: string[], providerId?: string) =>
    withSleepBlocked(`generate-commit-message:${projectRoot}`, async () => generateGitCommitMessage(projectRoot, files, providerId))
  );
  ipcMain.handle("archicode:list-project-files", async (_event, projectRoot: string) => listProjectFiles(projectRoot));
  ipcMain.handle("archicode:read-project-file", async (_event, projectRoot: string, relativePath: string) =>
    readProjectFile(projectRoot, relativePath)
  );
  ipcMain.handle("archicode:read-project-file-diff", async (_event, projectRoot: string, relativePath: string) =>
    readProjectFileDiff(projectRoot, relativePath)
  );
  ipcMain.handle("archicode:apply-patch-proposal", async (_event, projectRoot, proposalArtifactId, decisions) =>
    applyPatchProposal(projectRoot, proposalArtifactId, decisions)
  );
  ipcMain.handle("archicode:run-agent", async (_event, input) => runAgent(input));
ipcMain.handle("archicode:start-agent-run", async (_event, input) => startAgentRun(input));
ipcMain.handle("archicode:start-run-profile", async (_event, input) => startRunProfile(input));
ipcMain.handle("archicode:list-runtime-services", async (_event, projectRoot) => listRuntimeServices(projectRoot));
ipcMain.handle("archicode:start-runtime-service", async (_event, input) => startRuntimeService(input));
ipcMain.handle("archicode:stop-runtime-service", async (_event, projectRoot, serviceId) => stopRuntimeService(projectRoot, serviceId));
ipcMain.handle("archicode:restart-runtime-service", async (_event, projectRoot, serviceId) => restartRuntimeService(projectRoot, serviceId));
ipcMain.handle("archicode:approve-run", async (_event, input) => approveRun(input));
  ipcMain.handle("archicode:cancel-run", async (_event, projectRoot, runId) => cancelRun(projectRoot, runId));
  ipcMain.handle("archicode:reject-run", async (_event, projectRoot, runId, reason) => rejectRun(projectRoot, runId, reason));
ipcMain.handle("archicode:dismiss-run-error", async (_event, projectRoot, runId) => dismissRunError(projectRoot, runId));
ipcMain.handle("archicode:remove-run-from-queue", async (_event, projectRoot, runId) => removeRunFromQueue(projectRoot, runId));
ipcMain.handle("archicode:retry-run", async (_event, projectRoot, runId, guidance) => retryRun(projectRoot, runId, guidance));
  ipcMain.handle("archicode:start-debugging-run", async (_event, projectRoot, runId, guidance) => startDebuggingRun(projectRoot, runId, guidance));
  ipcMain.handle("archicode:start-runtime-debug-run", async (_event, input) => startRuntimeDebugRun(input));
  ipcMain.handle("archicode:report-bug", async (_event, input) => reportBug(input));
  ipcMain.handle("archicode:update-bug-incident", async (_event, input) => updateBugIncident(input));
  ipcMain.handle("archicode:start-incident-debug-run", async (_event, input) => startIncidentDebugRun(input));
  ipcMain.handle("archicode:start-console", async (_event, projectRoot: string, size?: { cols?: number; rows?: number }) =>
    startConsole(projectRoot, size)
  );
  ipcMain.handle("archicode:write-console", async (_event, sessionId: string, text: string) => writeConsole(sessionId, text));
  ipcMain.handle("archicode:resize-console", async (_event, sessionId: string, size: { cols?: number; rows?: number }) =>
    resizeConsole(sessionId, size)
  );
  ipcMain.handle("archicode:stop-console", async (_event, sessionId: string) => stopConsole(sessionId));
  ipcMain.handle("archicode:list-research-chats", async (_event, projectRoot: string) => listResearchChats(projectRoot));
  ipcMain.handle("archicode:create-research-chat", async (_event, input) => createResearchChat(input));
  ipcMain.handle("archicode:fork-research-chat", async (_event, input) => forkResearchChat(input));
  ipcMain.handle("archicode:rename-research-chat", async (_event, projectRoot: string, sessionId: string, title: string) =>
    renameResearchChat(projectRoot, sessionId, title)
  );
  ipcMain.handle("archicode:archive-research-chat", async (_event, projectRoot: string, sessionId: string) =>
    archiveResearchChat(projectRoot, sessionId)
  );
  ipcMain.handle("archicode:update-research-chat-auto-approval", async (_event, input) =>
    updateResearchChatAutoApproval(input)
  );
  ipcMain.handle("archicode:send-research-chat-message", async (_event, input) =>
    withSleepBlocked(`research-chat:${input.projectRoot}:${input.sessionId}`, () => sendResearchChatMessage({
      ...input,
      onToken: (text, kind) => publishResearchChatToken({
        projectRoot: input.projectRoot,
        sessionId: input.sessionId,
        text,
        kind
      }),
      onTokenReset: () => publishResearchChatToken({
        projectRoot: input.projectRoot,
        sessionId: input.sessionId,
        text: "",
        reset: true
      }),
      onActivity: (message, status) => publishResearchChatActivity({
        projectRoot: input.projectRoot,
        sessionId: input.sessionId,
        message,
        status
      }),
      onSubagentProgress: ({ runId, kind, title, message, status }) => publishResearchSubagentProgress({
        projectRoot: input.projectRoot,
        sessionId: input.sessionId,
        runId,
        kind,
        title,
        message,
        status
      })
    }))
  );
  ipcMain.handle("archicode:cancel-research-chat-message", async (_event, sessionId: string) =>
    cancelResearchChatMessage(sessionId)
  );
  ipcMain.handle("archicode:respond-subagent-run", async (_event, input) =>
    withSleepBlocked(`subagent-run:${input.projectRoot}:${input.sessionId}:${input.runId}`, () => respondToSubagentRun({
      ...input,
      onProgress: ({ runId, kind, title, message, status }) => publishResearchSubagentProgress({
        projectRoot: input.projectRoot,
        sessionId: input.sessionId,
        runId,
        kind,
        title,
        message,
        status
      })
    }))
  );
  ipcMain.handle("archicode:summarize-research-chat", async (_event, input) =>
    withSleepBlocked(`research-summary:${input.projectRoot}:${input.sessionId}`, () => summarizeResearchChat(input))
  );
  ipcMain.handle("archicode:apply-research-graph-change-set", async (_event, input) => applyResearchGraphChangeSet(input));
  ipcMain.handle("archicode:map-existing-codebase", async (_event, input) => {
    const projectRoot = path.resolve(input.projectRoot);
    const token = { cancelled: false };
    activeCodebaseMappings.set(projectRoot, token);
    try {
      const result = await withSleepBlocked(`codebase-map:${input.projectRoot}`, () => mapExistingCodebase({
        ...input,
        shouldCancel: () => token.cancelled,
        onProgress: publishCodebaseMappingProgress
      }));
      await markGraphAnalysisCurrent(projectRoot);
      return result;
    } finally {
      if (activeCodebaseMappings.get(projectRoot) === token) activeCodebaseMappings.delete(projectRoot);
    }
  });
  ipcMain.handle("archicode:get-initial-codebase-import-report", async (_event, projectRoot: string) =>
    readInitialCodebaseImportReport(path.resolve(projectRoot))
  );
  ipcMain.handle("archicode:resync-codebase", async (_event, input) => {
    const projectRoot = path.resolve(input.projectRoot);
    if (activeCodebaseResyncs.has(projectRoot)) throw new Error("A codebase resync is already running for this project.");
    const token = { cancelled: false };
    activeCodebaseResyncs.set(projectRoot, token);
    try {
      const result = await withSleepBlocked(`codebase-resync:${projectRoot}`, () => resyncExistingCodebase({
        ...input,
        projectRoot,
        shouldCancel: () => token.cancelled,
        onProgress: publishCodebaseResyncProgress
      }));
      await markGraphAnalysisCurrent(projectRoot);
      return result;
    } finally {
      if (activeCodebaseResyncs.get(projectRoot) === token) activeCodebaseResyncs.delete(projectRoot);
    }
  });
  ipcMain.handle("archicode:cancel-codebase-resync", async (_event, projectRoot: string) => {
    const token = activeCodebaseResyncs.get(path.resolve(projectRoot));
    if (token) token.cancelled = true;
    return Boolean(token);
  });
  ipcMain.handle("archicode:get-latest-resync-report", async (_event, projectRoot: string) =>
    readLatestResyncReport(path.resolve(projectRoot))
  );
  ipcMain.handle("archicode:list-resync-reports", async (_event, projectRoot: string) =>
    readResyncReports(path.resolve(projectRoot))
  );
  ipcMain.handle("archicode:cancel-codebase-mapping", async (_event, projectRoot: string) => {
    const token = activeCodebaseMappings.get(path.resolve(projectRoot));
    if (token) token.cancelled = true;
    return Boolean(token);
  });
}

app.whenReady().then(async () => {
  installAppBranding();
  installApplicationMenu();
  setResearchStorageRoot(app.getPath("userData"));
  setGlobalResearchPersonalityResolver(globalResearchPersonality);
  setGlobalResearchVerbosityResolver(globalResearchVerbosity);
  setSpeechDataRoot(app.getPath("userData"));
  setTtsDataRoot(app.getPath("userData"));
  setSemanticIndexRoots(
    app.getPath("userData"),
    app.isPackaged ? path.join(process.resourcesPath, "semantic-model") : path.join(app.getAppPath(), "resources", "semantic-model")
  );
  initializeSemanticModelPreference(await globalSemanticModelPreference());
  installContentSecurityPolicy();
  installMediaPermissionHandlers();
  setGlobalProviderSettingsStore({
    load: globalProviders,
    loadSecret: globalProviderSecret,
    save: rememberGlobalProviders
  });
  setGlobalMcpSettingsStore({
    load: globalMcpSettingsOrNull,
    save: rememberGlobalMcpSettings
  });
  setWebSearchSecretResolver(() => webSearchSecret("brave"));
  registerIpc();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  for (const watcher of maintenanceWatchers.values()) watcher.close();
  maintenanceWatchers.clear();
  for (const timer of maintenanceTimers.values()) clearTimeout(timer);
  for (const timer of sourceVerificationTimers.values()) clearTimeout(timer);
  stopAllConsoles();
  shutdownLocalProviderProcesses();
  void stopExternalMcpHost();
  shutdownTtsWorkers();
});
