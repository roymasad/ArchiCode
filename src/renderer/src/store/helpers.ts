import { create } from "zustand";
import type {
  ArchicodeNode,
  Artifact,
  Note,
  DebugIncident,
  Flow,
  FlowEdge,
  LlmPatchProposal,
  NodePatch,
  NodeStage,
  PatchOperationDecision,
  PatchReviewRecord,
  ProjectBundle,
  ProjectSettings,
  ResearchChatScope,
  ResearchChatSession,
  ResearchGraphChangeDecision,
  ResearchGraphChangeResult,
  RunGuidance,
  RunEffort,
  RunScope,
  Run,
  RuntimeService,
  SpeechSettings,
  TtsSettings
} from "@shared/schema";
import type {
  GitOperationResult,
  GitStatus,
  ProjectFileBrowserData,
  ProjectFileDiff,
  ProjectFileText
} from "@shared/projectTools";
import type {
  CreateProjectSkillInput,
  McpImportSource,
  McpRefreshResult,
  McpRegistryEntry,
  McpRegistryInstallInput,
  McpRegistryInstallResult,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpServerView,
  ProjectSkill
} from "@shared/capabilities";
import type { ExternalProjectUpdatePayload, ProviderHealthResult, RecentProjectEntry } from "../../../preload";
import { applyNodePatch } from "@shared/schema";
import { createSeedProject } from "@shared/fixtures";
import {
  createReadmeShowcaseBundle,
  createReadmeShowcaseResearchSessions,
  type ReadmeShowcaseScenario
} from "@shared/readmeShowcase";
import { autoLayoutFlow, deleteSubflowFromFlow, duplicateNode, isSubflowIgnored, linkNodeToSubflow, reparentSubflowInFlow } from "@shared/graph";
import type { ProjectTemplateId } from "@shared/templates";
import { getOpenQuestionsForScope, type OpenQuestionItem } from "../utils/nodeSignals";
import { isRunBlockingNewChange } from "../utils/runStatus";
import { mergeResearchSessionsPreservingOptimistic } from "../utils/researchSessions";
import { isResearchThinkingPhrase, pickRandomResearchThinkingPhrase } from "@shared/researchPersonality";
import type { ResearchMessageNodeReference } from "@shared/schema";
import {
  DEFAULT_BINDINGS,
  isReservedAction,
  sanitizeStoredBindings,
  type ActionId,
  type KeyChord
} from "../utils/keybindings";

import type { ComposerMention, ComposerSegment, QueuedResearchMessage, ShellPrompt, AgentRunInput, RunGuidanceInput, BuildQuestionCheck, NodeClipboard, CodebaseOnboardingLevel, CodebaseOnboardingDetail, CodebaseOnboardingGranularity, ProjectSettingsTab, WorkbenchView, GitOperationName, CanvasViewport, UiScale, GraphNavigationRequest, FilePreviewRequest, GraphNavigationTarget, CodebaseOnboarding, ProjectSettingsRequest, RunProfileInput, PatchProposalView, AppNotice, ResearchStreamState, LiveSubagentActivity, LiveResearchActivity, ArchicodeState, StoreSet, StoreGet } from "./types";
import { readStoredGraphLocation } from "./graphLocation";

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function uniqueNodeIds(nodeIds: string[]): string[] {
  return Array.from(new Set(nodeIds.filter(Boolean)));
}

export function selectedNodeIdsFor(nodeId: string | null | undefined): string[] {
  return nodeId ? [nodeId] : [];
}

export function appendEdgeLabelHistory(history: string[] | undefined, label: string | null | undefined): string[] {
  const normalizedLabel = label?.trim();
  if (!normalizedLabel) return history ?? [];
  const normalizedKey = normalizedLabel.toLocaleLowerCase();
  return [
    normalizedLabel,
    ...(history ?? []).filter((item) => item.trim().toLocaleLowerCase() !== normalizedKey)
  ].slice(0, 50);
}

export const directUndoNotice: AppNotice = {
  tone: "warning",
  title: "No safe presentation change to undo",
  message: "ArchiCode only undoes node movement, layout, size, shape, and color. Semantic graph and node-property changes remain protected from realtime undo; use Git when you need to revert them."
};

export async function offerGitAttributesSetup(projectRoot: string): Promise<AppNotice | null> {
  if (!window.archicode?.getGitAttributesStatus || !window.archicode?.enableGitAttributes) return null;
  try {
    const status = await window.archicode.getGitAttributesStatus(projectRoot);
    if (status === "enabled") return null;
    if (status === "conflicting") {
      return {
        tone: "warning",
        title: "Review Git merge rules",
        message: "This project already has a conflicting .gitattributes rule for ArchiCode graph history. ArchiCode left it unchanged."
      };
    }
    const dismissedKey = projectScopedUiKey(projectRoot, "git-attributes-offer");
    if (localStorage.getItem(dismissedKey) === "dismissed") return null;
    const enabled = window.confirm(
      "Enable merge-friendly ArchiCode storage?\n\nThis appends reviewed rules to .gitattributes so concurrent ArchiCode history and note lines are kept by Git. Existing .gitattributes content is preserved. Review and commit the change."
    );
    if (!enabled) {
      localStorage.setItem(dismissedKey, "dismissed");
      return null;
    }
    const result = await window.archicode.enableGitAttributes(projectRoot);
    return result === "enabled" ? null : {
      tone: "warning",
      title: "Review Git merge rules",
      message: "ArchiCode found a conflicting .gitattributes rule and left it unchanged."
    };
  } catch (error) {
    return {
      tone: "warning",
      title: "Git merge rules check failed",
      message: `ArchiCode couldn't read or update this project's .gitattributes file: ${String(error)}. Fix the file (content or permissions) and reload the project to set up merge-friendly storage.`
    };
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function runInputKey(flowId: string, input: AgentRunInput): string {
  const envKey = (input.env ?? []).map((item) => `${item.name}=${item.value ?? ""}`).sort().join("&");
  const scopeKey = input.scope ? `${input.scope.kind}:${input.scope.flowId ?? ""}:${(input.scope.nodeIds ?? []).join(",")}` : "";
  return [
    flowId,
    input.nodeId ?? "project",
    scopeKey,
    input.purpose ?? "implement",
    input.effort ?? "high",
    input.command?.trim() ?? "ai",
    input.cwd?.trim() ?? "",
    envKey,
    input.promptSummary.trim()
  ].join("|");
}

export function runProfileKey(flowId: string, input: RunProfileInput): string {
  return [flowId, "run-profile", input.profileId, input.targetId ?? ""].join("|");
}

export function isSameRunRequest(run: Run, flowId: string, input: AgentRunInput): boolean {
  return run.flowId === flowId &&
    (run.nodeId ?? "") === (input.nodeId ?? "") &&
    (run.scope?.kind ?? "") === (input.scope?.kind ?? "") &&
    (run.scope?.flowId ?? "") === (input.scope?.flowId ?? "") &&
    (run.scope?.nodeIds ?? []).join(",") === (input.scope?.nodeIds ?? []).join(",") &&
    run.effort === (input.effort ?? "high") &&
    (run.command ?? "") === (input.command?.trim() ?? "") &&
    (run.cwd ?? "") === (input.cwd?.trim() ?? "") &&
    run.promptSummary === input.promptSummary;
}

export function isSameRunProfileRequest(run: Run, flowId: string, input: RunProfileInput): boolean {
  return run.flowId === flowId &&
    run.runProfileId === input.profileId &&
    (run.runTargetId ?? "") === (input.targetId ?? "");
}

export function runArtifactIds(run: Run): string[] {
  return [...run.contextArtifacts, ...run.planArtifactIds, ...run.sourceDiffArtifactIds];
}

export function runHasQuestionRefreshSignal(run: Run): boolean {
  return run.status === "awaiting-plan-review";
}

export function shouldRefreshQuestionsForRun(previous: Run | undefined, next: Run): boolean {
  if (!runHasQuestionRefreshSignal(next)) return false;
  if (!previous) return true;
  return previous.status !== next.status ||
    previous.logs.length !== next.logs.length ||
    previous.runInstructions !== next.runInstructions;
}

export function hasActiveRun(bundle: ProjectBundle | null): boolean {
  return Boolean(bundle?.runs.some(isRunBlockingNewChange));
}

export function editingLockedMessage(): string {
  return "Graph editing is locked while a run is active or waiting for review.";
}

export function notifyJobFinished(bundle: ProjectBundle | null, title: string, body?: string): void {
  if (!bundle?.project.settings.notifications.jobFinished) return;
  void window.archicode?.showSystemNotification?.({ title, body });
}

export function notifyReviewRequired(bundle: ProjectBundle | null, run: Run): void {
  if (!bundle?.project.settings.notifications.reviewRequired) return;
  if (run.status === "needs-permission" && run.sourceReview) {
    void window.archicode?.showSystemNotification?.({
      title: "Source deletion needs approval",
      body: run.sourceReview.paths.join(", ")
    });
  }
  if (run.status === "awaiting-plan-review") {
    void window.archicode?.showSystemNotification?.({
      title: "Plan ready for review",
      body: run.promptSummary
    });
  }
  if (run.status === "awaiting-code-review") {
    void window.archicode?.showSystemNotification?.({
      title: "Source changes ready for review",
      body: run.promptSummary
    });
  }
}

export function createOptimisticRun(flowId: string, providerId: string, input: AgentRunInput): Run {
  const createdAt = now();
  const command = input.command?.trim();
  const affectedNodeIds = input.scope?.kind === "no-scope" ? [] : input.scope?.kind === "nodes" && input.scope.nodeIds.length ? input.scope.nodeIds : input.nodeId ? [input.nodeId] : [];
  return {
    id: uid("pending-run"),
    flowId,
    nodeId: input.nodeId,
    providerId,
    status: "preparing",
    phase: "planning",
    purpose: input.purpose ?? "implement",
    effort: input.effort ?? "high",
    promptSummary: input.promptSummary,
    command,
    scope: input.scope,
    cwd: input.cwd,
    env: input.env ?? [],
    permission: {
      decision: "allowed",
      reason: "Preparing run context."
    },
    contextArtifacts: [],
    planArtifactIds: [],
    sourceDiffArtifactIds: [],
    affectedNodeIds,
    plannedCommands: command ? [command] : [],
    plannedAllowedRoots: [],
    mcpToolCalls: [],
    reviewDecisions: [],
    todos: [
      { id: uid("todo"), text: "Prepare run context", status: "doing" }
    ],
    logs: [
      { at: createdAt, stream: "system", text: "Preparing run context and plan artifact..." }
    ],
    runInstructions: "ArchiCode is preparing this run. It will update with the real queue entry shortly.",
    createdAt
  };
}

export function createOptimisticRunProfile(flowId: string, providerId: string, input: RunProfileInput): Run {
  const createdAt = now();
  return {
    id: uid("pending-run"),
    flowId,
    providerId,
    status: "queued",
    phase: "coding",
    effort: "high",
    promptSummary: `Run app profile: ${input.profileId}`,
    runProfileId: input.profileId,
    runTargetId: input.targetId,
    env: [],
    permission: {
      decision: "allowed",
      reason: "Preparing run profile."
    },
    contextArtifacts: [],
    planArtifactIds: [],
    sourceDiffArtifactIds: [],
    affectedNodeIds: [],
    plannedCommands: [],
    plannedAllowedRoots: [],
    mcpToolCalls: [],
    reviewDecisions: [],
    todos: [
      { id: uid("todo"), text: "Prepare run profile", status: "doing" }
    ],
    logs: [
      { at: createdAt, stream: "system", text: "Run App scheduled. Preparing profile..." }
    ],
    createdAt
  };
}

export const defaultNodeHalfSize = { x: 124, y: 77 };

export function getInitialTheme(): "light" | "dark" {
  const saved = localStorage.getItem("archicode-theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getInitialUiScale(): UiScale {
  const saved = Number(localStorage.getItem("archicode-ui-scale"));
  return saved === 75 || saved === 100 || saved === 125 ? saved : 100;
}

export function projectUiKey(rootPath: string, key: string): string {
  return `archicode-${key}:${rootPath || "default"}`;
}

export function projectScopedUiKey(rootPath: string, key: string, flowId?: string | null, subflowId?: string | null): string {
  return `${projectUiKey(rootPath, key)}:${flowId || "project"}:${subflowId || "root"}`;
}

export function readStoredWorkbenchView(rootPath: string): WorkbenchView {
  const saved = localStorage.getItem(projectUiKey(rootPath, "workbench"));
  return saved === "files" || saved === "graph" ? saved : "graph";
}

export async function readProjectFileBrowserState(rootPath: string): Promise<{
  fileBrowser: ProjectFileBrowserData | null;
  gitStatus: GitStatus | null;
}> {
  if (!window.archicode?.listProjectFiles) return { fileBrowser: null, gitStatus: null };
  try {
    const fileBrowser = await window.archicode.listProjectFiles(rootPath);
    return { fileBrowser, gitStatus: fileBrowser.gitStatus };
  } catch {
    const gitStatus = window.archicode.getGitStatus ? await window.archicode.getGitStatus(rootPath) : null;
    return { fileBrowser: null, gitStatus };
  }
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function readStoredViewport(rootPath: string, flowId?: string | null, subflowId?: string | null): CanvasViewport | null {
  try {
    const scoped = localStorage.getItem(projectScopedUiKey(rootPath, "viewport", flowId, subflowId));
    const legacy = localStorage.getItem(projectUiKey(rootPath, "viewport"));
    const parsed = JSON.parse(scoped ?? legacy ?? "null") as unknown;
    const candidate = parsed as Partial<CanvasViewport> | null;
    if (
      candidate &&
      typeof candidate === "object" &&
      isFiniteNumber(candidate.x) &&
      isFiniteNumber(candidate.y) &&
      isFiniteNumber(candidate.zoom)
    ) {
      return { x: candidate.x, y: candidate.y, zoom: candidate.zoom };
    }
  } catch {
    return null;
  }
  return null;
}

export function isVisualQaPreview(): boolean {
  return new URLSearchParams(window.location.search).has("visualQa");
}

function readmeShowcaseScenario(): ReadmeShowcaseScenario | null {
  const mode = new URLSearchParams(window.location.search).get("visualQa");
  if (mode === "showcase-knowledge") return "knowledge";
  if (mode === "showcase-chat") return "chat";
  if (mode === "showcase") return "overview";
  return null;
}

export function createVisualQaResearchSessions(rootPath: string): ResearchChatSession[] {
  return readmeShowcaseScenario() ? createReadmeShowcaseResearchSessions(rootPath) : [];
}

export function createFallbackBundle(rootPath = "/browser-preview"): ProjectBundle {
  const showcaseScenario = readmeShowcaseScenario();
  if (showcaseScenario) return createReadmeShowcaseBundle(rootPath, showcaseScenario);
  const seed = createSeedProject(rootPath);
  const createdAt = now();
  const denseMode = new URLSearchParams(window.location.search).get("visualQa") === "dense";
  const denseNodes = denseMode
      ? Array.from({ length: 18 }, (_, index): ArchicodeNode => ({
        id: `node-visual-${index}`,
        type: index % 3 === 0 ? "feature" : index % 3 === 1 ? "component" : "task",
        title: `Dense Node ${index + 1}`,
        description: "Visual QA node used to verify dense graph layout, dark/light theme rendering, and sidebar scrolling.",
        stage: index % 2 === 0 ? "working" : "planned",
        ignored: false,
        flags: index % 4 === 0 ? ["needs-attention"] : ["changed"],
        locked: false,
        visual: {},
        position: { x: 80 + (index % 6) * 280, y: 80 + Math.floor(index / 6) * 220 },
        customProperties: {},
        techStack: [],
        acceptanceCriteria: [],
        acceptanceChecks: [],
        attachments: [],
        todos: [],
        updatedAt: now()
      }))
    : [];
  const denseEdges = denseMode
    ? denseNodes.slice(1).map((node, index) => ({
        id: `edge-visual-${index}`,
        source: denseNodes[index].id,
        target: node.id,
        label: "flows"
      }))
    : [];
  const visualArtifacts = denseMode
    ? [
        {
          id: "visual-plan",
          type: "plan" as const,
          title: "Implementation plan",
          path: ".archicode/artifacts/visual-plan.md",
          runId: "visual-run-succeeded",
          summary: "Plan: reduce navigation clutter, keep primary graph workflows visible, and verify the app with build plus visual QA.",
          sizeBytes: 1840,
          createdAt
        },
        {
          id: "visual-diff",
          type: "diff" as const,
          title: "Source changes",
          path: ".archicode/artifacts/visual-diff.patch",
          runId: "visual-run-succeeded",
          status: "applied" as const,
          summary: "diff --git a/src/App.tsx b/src/App.tsx\n+ Move secondary activity views behind More.\n+ Keep the canvas visible while panels stay docked.",
          sizeBytes: 3120,
          createdAt
        },
        {
          id: "visual-log",
          type: "log" as const,
          title: "Verification log",
          path: ".archicode/artifacts/visual-verification.log",
          runId: "visual-run-succeeded",
          summary: "npm test passed. npm run build passed. Visual QA screenshots generated.",
          sizeBytes: 920,
          createdAt
        },
        {
          id: "visual-context",
          type: "context-manifest" as const,
          title: "Context manifest",
          path: ".archicode/artifacts/visual-context.json",
          runId: "visual-run-running",
          summary: "Current flow, selected node, recent runs, and UI shell state included for review.",
          sizeBytes: 1450,
          createdAt
        }
      ]
    : [];
  const visualRuns = denseMode
    ? [
        {
          id: "visual-run-running",
          flowId: seed.flow.id,
          nodeId: "node-canvas",
          providerId: "openai-compatible",
          status: "running" as const,
          phase: "coding" as const,
          effort: "high" as const,
          promptSummary: "Implement quieter panel hierarchy while preserving current commands.",
          permission: { decision: "allowed" as const },
          env: [],
          contextArtifacts: ["visual-context"],
          planArtifactIds: [],
          sourceDiffArtifactIds: [],
          affectedNodeIds: ["node-canvas", "node-orchestrator"],
          plannedCommands: ["npm test", "npm run build"],
          plannedAllowedRoots: [rootPath],
          mcpToolCalls: [],
          reviewDecisions: [],
          todos: [
            { id: "visual-todo-sidebar", text: "Collapse flow structure into scope control", status: "done" as const },
            { id: "visual-todo-activity", text: "Move activity utilities into More", status: "doing" as const },
            { id: "visual-todo-chat", text: "Compact chat metadata", status: "todo" as const }
          ],
          logs: [
            { at: createdAt, stream: "system" as const, text: "Run started. Preparing visual QA context." },
            { at: createdAt, stream: "stdout" as const, text: "Reading renderer panels and CSS density rules..." },
            { at: createdAt, stream: "stdout" as const, text: "Applying sidebar and activity hierarchy changes." }
          ],
          scope: { kind: "flow" as const, flowId: seed.flow.id, nodeIds: [] },
          runInstructions: "The provider is editing renderer UI components and CSS. Trace shows live progress.",
          startedAt: createdAt,
          createdAt
        },
        {
          id: "visual-run-failed",
          flowId: seed.flow.id,
          nodeId: "node-orchestrator",
          providerId: "openai-compatible",
          status: "failed" as const,
          phase: "verifying" as const,
          effort: "high" as const,
          promptSummary: "Verify visual QA screenshots after UI refactor.",
          command: "npm run visual-qa",
          permission: { decision: "allowed" as const },
          env: [],
          contextArtifacts: [],
          planArtifactIds: [],
          sourceDiffArtifactIds: [],
          affectedNodeIds: ["node-orchestrator"],
          plannedCommands: ["npm run visual-qa"],
          plannedAllowedRoots: [rootPath],
          mcpToolCalls: [],
          reviewDecisions: [],
          todos: [{ id: "visual-error-todo", text: "Fix accidental detached activity panel capture", status: "blocked" as const }],
          logs: [
            { at: createdAt, stream: "system" as const, text: "Verification command started: npm run visual-qa" },
            { at: createdAt, stream: "stderr" as const, text: "Visual QA failed: activity panel was detached by the screenshot scenario." },
            { at: createdAt, stream: "system" as const, text: "Next step: click only the explicit Expand activity panel control." }
          ],
          runInstructions: "Mock failure for visual QA error-state coverage.",
          startedAt: createdAt,
          completedAt: createdAt,
          createdAt
        },
        {
          id: "visual-run-succeeded",
          flowId: seed.flow.id,
          nodeId: "node-project",
          providerId: "openai-compatible",
          status: "succeeded" as const,
          phase: "verifying" as const,
          effort: "high" as const,
          promptSummary: "Reduce UI clutter and verify build output.",
          command: "npm test && npm run build",
          permission: { decision: "allowed" as const },
          env: [],
          contextArtifacts: ["visual-context"],
          planArtifactIds: ["visual-plan"],
          sourceDiffArtifactIds: ["visual-diff"],
          affectedNodeIds: ["node-project", "node-canvas"],
          plannedCommands: ["npm test", "npm run build"],
          plannedAllowedRoots: [rootPath],
          mcpToolCalls: [],
          reviewDecisions: [{ kind: "code" as const, decision: "accepted" as const, decidedAt: createdAt }],
          todos: [
            { id: "visual-success-plan", text: "Review plan", status: "done" as const },
            { id: "visual-success-code", text: "Apply CSS and component updates", status: "done" as const },
            { id: "visual-success-verify", text: "Run tests and build", status: "done" as const }
          ],
          logs: [
            { at: createdAt, stream: "system" as const, text: "Planning completed. Plan artifact: visual-plan." },
            { at: createdAt, stream: "stdout" as const, text: "Code changed: src/renderer/src/App.tsx, ProjectSidebar.tsx, app.css" },
            { at: createdAt, stream: "stdout" as const, text: "Verification completed with npm test && npm run build." }
          ],
          implementation: {
            currentBatch: 1,
            maxBatches: 1,
            needsMoreWork: false,
            checkpoints: [{
              id: "visual-checkpoint-1",
              phase: "coding" as const,
              batchNumber: 1,
              status: "changed" as const,
              summary: "Panels simplified and verified.",
              sourceDiffArtifactId: "visual-diff",
              warnings: [],
              quarantinedOperationsCount: 0,
              startedAt: createdAt,
              completedAt: createdAt
            }],
            tasks: [
              { id: "visual-task-plan", title: "Plan", status: "done" as const },
              { id: "visual-task-code", title: "Code", status: "done" as const },
              { id: "visual-task-verify", title: "Verify", status: "done" as const }
            ]
          },
          runInstructions: "All required visual QA stages finished.",
          startedAt: createdAt,
          completedAt: createdAt,
          createdAt
        }
      ]
    : [];
  return {
    rootPath,
    project: seed.project,
    flows: denseMode ? [{ ...seed.flow, nodes: [...seed.flow.nodes, ...denseNodes], edges: [...seed.flow.edges, ...denseEdges] }] : [seed.flow],
    notes: [
      {
        id: "note-browser-preview",
        flowId: seed.flow.id,
        nodeId: "node-orchestrator",
        kind: "system-note",
        author: "system",
        body: "Browser preview is using an in-memory project because the Electron preload bridge is unavailable.",
        category: "note",
        priority: "normal",
        attachmentIds: [],
        resolved: false,
        pinned: false,
        createdAt: now()
      }
    ],
    incidents: [],
    runs: visualRuns,
    artifacts: visualArtifacts,
    summaries: [],
    graphChanges: [],
    validationErrors: []
  };
}

// Fields tied to a specific project that must be cleared whenever the active
// project changes, so nothing leaks from the previously open project. Each
// project-entry action spreads this first, then applies freshly loaded values
// (bundle, sessions, git status, project-scoped lists) on top.
export function projectScopedResetState(): Partial<ArchicodeState> {
  return {
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedEdgeId: null,
    selectedRunId: null,
    activeSubflowId: null,
    searchQuery: "",
    nodeClipboard: null,
    error: null,
    shellPrompt: null,
    buildQuestionCheck: null,
    codebaseOnboarding: null,
    projectSettingsRequest: null,
    pendingRunKeys: [],
    providerHealth: {},
    patchProposals: [],
    runtimeServices: [],
    projectSkills: [],
    mcpServers: [],
    researchSessions: [],
    selectedResearchSessionId: null,
    researchScope: null,
    busyTestNodeIds: [],
    researchBusy: false,
    researchBusySessionIds: [],
    researchQueuedMessages: {},
    researchPendingAttachmentPaths: {},
    researchStreamStates: {},
    researchSubagentActivity: {},
    researchChatActivity: {},
    researchDraft: [],
    researchComposerFocusNonce: 0,
    canvasViewport: null,
    canvasViewportCenter: null,
    lastAddNodePosition: null,
    lastAddNodeScope: null,
    graphNavigationRequest: null,
    projectReloadNonce: 0,
    gitStatus: null,
    gitLogs: [],
    gitBusy: false,
    graphHistory: [],
    graphHistoryOpen: false,
    graphHistoryLoading: false,
    graphHistoryCursor: null,
    graphHistoryHasMore: false,
    presentationUndoStack: [],
    presentationRedoStack: [],
    presentationHistoryBusy: false,
    historicalInspection: null,
    fileBrowser: null,
    selectedFilePath: null,
    filePreviewRequest: null,
    filePreview: null,
    fileDiff: null,
    fileBusy: false,
    capabilityBusy: false
  };
}

export function clearProjectStateForBranchChange(rootPath: string, gitLogs: GitOperationResult[], projectReloadNonce: number): Partial<ArchicodeState> {
  return {
    ...projectScopedResetState(),
    rootPath,
    bundle: null,
    activeFlowId: null,
    loading: true,
    gitLogs,
    gitBusy: true,
    projectReloadNonce,
    error: null
  };
}

export async function reloadProjectStateAfterBranchChange(rootPath: string, gitLogs: GitOperationResult[], projectReloadNonce: number): Promise<Partial<ArchicodeState>> {
  if (!window.archicode) return {};
  const result = window.archicode.openRecentProject
    ? await window.archicode.openRecentProject(rootPath)
    : { bundle: await window.archicode.loadProject(rootPath), initializedMetadata: false };
  const { bundle } = result;
  const graphLocation = readStoredGraphLocation(bundle.rootPath, bundle);
  const recentProjects = await window.archicode.listRecentProjects();
  const researchSessions = await window.archicode.listResearchChats(bundle.rootPath);
  const { fileBrowser, gitStatus } = await readProjectFileBrowserState(bundle.rootPath);
  return {
    ...projectScopedResetState(),
    rootPath: bundle.rootPath,
    bundle,
    recentProjects,
    patchProposals: await window.archicode.listPatchProposals(bundle.rootPath),
    researchSessions,
    selectedResearchSessionId: selectedResearchSessionOrFallback(null, researchSessions),
    researchBusySessionIds: [],
    researchQueuedMessages: {},
    researchBusy: false,
    runtimeServices: await window.archicode.listRuntimeServices(bundle.rootPath),
    projectSkills: await window.archicode.listProjectSkills(bundle.rootPath),
    mcpServers: await window.archicode.listMcpServers(bundle.rootPath),
    gitStatus,
    gitLogs,
    gitBusy: true,
    fileBrowser,
    selectedFilePath: null,
    filePreviewRequest: null,
    filePreview: null,
    fileDiff: null,
    activeFlowId: graphLocation.activeFlowId,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedEdgeId: null,
    selectedRunId: null,
    activeSubflowId: graphLocation.activeSubflowId,
    workbenchView: readStoredWorkbenchView(bundle.rootPath),
    canvasViewport: result.initializedMetadata ? null : readStoredViewport(bundle.rootPath, graphLocation.activeFlowId, graphLocation.activeSubflowId),
    canvasViewportCenter: null,
    codebaseOnboarding: null,
    projectReloadNonce,
    loading: false,
    error: null
  };
}



export function isBuildLikeAgentRun(input: AgentRunInput): boolean {
  if (input.command) return false;
  return (input.purpose ?? "implement") !== "run-discovery";
}

export function getActiveFlow(bundle: ProjectBundle | null, activeFlowId: string | null): Flow | null {
  if (!bundle) return null;
  return bundle.flows.find((flow) => flow.id === activeFlowId) ?? bundle.flows[0] ?? null;
}

export function getSelectedNode(bundle: ProjectBundle | null, activeFlowId: string | null, selectedNodeId: string | null): ArchicodeNode | null {
  const flow = getActiveFlow(bundle, activeFlowId);
  if (!flow || !selectedNodeId) return null;
  return flow.nodes.find((node) => node.id === selectedNodeId) ?? null;
}

export function getSelectedEdge(bundle: ProjectBundle | null, activeFlowId: string | null, selectedEdgeId: string | null) {
  const flow = getActiveFlow(bundle, activeFlowId);
  if (!flow || !selectedEdgeId) return null;
  return flow.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
}

export function defaultResearchScope(
  bundle: ProjectBundle,
  activeFlowId: string | null,
  activeSubflowId: string | null,
  selectedNodeId: string | null
): ResearchChatScope {
  void activeSubflowId;
  const flow = getActiveFlow(bundle, activeFlowId);
  if (flow && selectedNodeId && flow.nodes.some((node) => node.id === selectedNodeId)) {
    return { type: "node", flowId: flow.id, nodeId: selectedNodeId };
  }
  return { type: "project", projectId: bundle.project.id };
}

export function normalizeComposerSegments(segments: ComposerSegment[]): ComposerSegment[] {
  const merged: ComposerSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") {
      const last = merged[merged.length - 1];
      if (last && last.kind === "text") {
        merged[merged.length - 1] = { kind: "text", text: last.text + segment.text };
      } else {
        merged.push(segment);
      }
    } else {
      merged.push(segment);
    }
  }
  return merged.filter((segment) => segment.kind === "mention" || segment.text.length > 0);
}

export function addResearchBusySession(sessionIds: string[], sessionId: string): string[] {
  return sessionIds.includes(sessionId) ? sessionIds : [...sessionIds, sessionId];
}

export function removeResearchBusySession(sessionIds: string[], sessionId: string): string[] {
  return sessionIds.filter((item) => item !== sessionId);
}

export function selectedResearchSessionOrFallback(
  selectedResearchSessionId: string | null,
  researchSessions: ResearchChatSession[],
  fallbackSessionId: string | null = null
): string | null {
  if (selectedResearchSessionId && researchSessions.some((session) => session.id === selectedResearchSessionId)) {
    return selectedResearchSessionId;
  }
  if (fallbackSessionId && researchSessions.some((session) => session.id === fallbackSessionId)) {
    return fallbackSessionId;
  }
  return researchSessions[0]?.id ?? null;
}


let graphNavigationRequestCounter = 0;
export function nextGraphNavigationRequestId(): number {
  return ++graphNavigationRequestCounter;
}

let filePreviewRequestCounter = 0;
export function nextFilePreviewRequestId(): number {
  return ++filePreviewRequestCounter;
}
