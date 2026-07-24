import { t } from "@renderer/i18n";
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
import type { ExternalProjectUpdatePayload, ProviderHealthResult, RecentProjectEntry, ResearchSubagentProgressPayload } from "../../../preload";
import { applyNodePatch } from "@shared/schema";
import { createSeedProject } from "@shared/fixtures";
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
import { uid, uniqueNodeIds, selectedNodeIdsFor, appendEdgeLabelHistory, directUndoNotice, offerGitAttributesSetup, now, runInputKey, runProfileKey, isSameRunRequest, isSameRunProfileRequest, runArtifactIds, runHasQuestionRefreshSignal, shouldRefreshQuestionsForRun, hasActiveRun, editingLockedMessage, notifyJobFinished, notifyReviewRequired, createOptimisticRun, createOptimisticRunProfile, defaultNodeHalfSize, getInitialTheme, getInitialUiScale, projectUiKey, projectScopedUiKey, readStoredWorkbenchView, readProjectFileBrowserState, isFiniteNumber, readStoredViewport, isVisualQaPreview, createFallbackBundle, projectScopedResetState, clearProjectStateForBranchChange, reloadProjectStateAfterBranchChange, isBuildLikeAgentRun, getActiveFlow, getSelectedNode, getSelectedEdge, defaultResearchScope, normalizeComposerSegments, addResearchBusySession, removeResearchBusySession, selectedResearchSessionOrFallback, nextGraphNavigationRequestId, nextFilePreviewRequestId } from "./helpers";

function newResearchCanvasAction(session: ResearchChatSession, knownMessageIds: Set<string>) {
  return [...session.messages].reverse().find((message) => (
    message.role === "assistant" && !knownMessageIds.has(message.id) && Boolean(message.canvasAction)
  ))?.canvasAction;
}

type BatchedResearchStateUpdate = (state: ArchicodeState) => Partial<ArchicodeState> | ArchicodeState;

function createResearchUpdateBatch(set: StoreSet) {
  let pendingUpdates: BatchedResearchStateUpdate[] = [];
  const latestUpdates = new Map<string, BatchedResearchStateUpdate>();
  let timerId: number | null = null;

  const scheduleFlush = () => {
    if (timerId === null) timerId = window.setTimeout(flush, 16);
  };

  function flush() {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
    if (!pendingUpdates.length && !latestUpdates.size) return;
    const updates = [...pendingUpdates, ...latestUpdates.values()];
    pendingUpdates = [];
    latestUpdates.clear();
    set((state) => {
      let nextState = state;
      for (const update of updates) {
        const patch = update(nextState);
        if (patch === nextState) continue;
        nextState = { ...nextState, ...patch };
      }
      return nextState;
    });
  }

  return {
    schedule(update: BatchedResearchStateUpdate) {
      pendingUpdates.push(update);
      scheduleFlush();
    },
    scheduleLatest(key: string, update: BatchedResearchStateUpdate) {
      latestUpdates.set(key, update);
      scheduleFlush();
    },
    flush,
    cancel() {
      if (timerId !== null) window.clearTimeout(timerId);
      timerId = null;
      pendingUpdates = [];
      latestUpdates.clear();
    }
  };
}

function mergeLiveSubagentProgress(
  existing: LiveSubagentActivity[],
  payload: ResearchSubagentProgressPayload
): LiveSubagentActivity[] {
  const found = existing.find((entry) => entry.id === payload.runId);
  const status = payload.status ?? found?.status ?? "running";
  if (!found) {
    return [...existing, {
      id: payload.runId,
      kind: payload.kind,
      title: payload.title,
      status,
      lines: payload.message ? [payload.message] : [],
      artifacts: payload.artifact ? [payload.artifact] : [],
      visuallyAnalyzedArtifactIds: payload.observationAnalysis?.status === "completed"
        ? [payload.observationAnalysis.artifactId]
        : []
    }];
  }
  return existing.map((entry) => {
    if (entry.id !== payload.runId) return entry;
    const artifacts = entry.artifacts ?? [];
    const visuallyAnalyzedArtifactIds = entry.visuallyAnalyzedArtifactIds ?? [];
    return {
      ...entry,
      status,
      lines: payload.message ? [...entry.lines, payload.message].slice(-30) : entry.lines,
      artifacts: payload.artifact && !artifacts.some((artifact) => artifact.id === payload.artifact!.id)
        ? [...artifacts, payload.artifact]
        : artifacts,
      visuallyAnalyzedArtifactIds: payload.observationAnalysis?.status === "completed" && !visuallyAnalyzedArtifactIds.includes(payload.observationAnalysis.artifactId)
        ? [...visuallyAnalyzedArtifactIds, payload.observationAnalysis.artifactId]
        : visuallyAnalyzedArtifactIds
    };
  });
}

export const createResearchSlice = (set: StoreSet, get: StoreGet): Pick<ArchicodeState, "openResearchPanel" | "closeResearchPanel" | "setResearchScope" | "setResearchDraft" | "appendResearchDraftMention" | "appendResearchDraftText" | "clearResearchDraft" | "requestResearchComposerFocus" | "handleResearchChatSessionUpdated" | "refreshResearchChats" | "createResearchChat" | "forkResearchMessage" | "startScopedResearchChat" | "selectResearchChat" | "archiveResearchChat" | "renameResearchChat" | "updateResearchChatAutoApproval" | "sendResearchMessage" | "stopResearchMessage" | "dequeueResearchMessage" | "reorderQueuedResearchMessage" | "retryResearchMessage" | "summarizeResearchChat" | "applyResearchGraphChangeSet" | "respondToSubagentRun"> => ({
  openResearchPanel: async (scope) => {
    const { rootPath, bundle } = get();
    const defaultScope = bundle ? defaultResearchScope(bundle, get().activeFlowId, get().activeSubflowId, get().selectedNodeId) : null;
    set({ researchPanelOpen: true, researchScope: scope ?? defaultScope ?? get().researchScope });
    if (rootPath && window.archicode) await get().refreshResearchChats();
  },

  closeResearchPanel: () => set({ researchPanelOpen: false }),

  handleResearchChatSessionUpdated: (payload) => set((state) => {
    if (state.rootPath !== payload.projectRoot) return state;
    if (payload.session.origin?.type === "project-briefing") return state;
    const sessions = state.researchSessions.some((session) => session.id === payload.session.id)
      ? state.researchSessions.map((session) => session.id === payload.session.id ? payload.session : session)
      : [payload.session, ...state.researchSessions];
    return { researchSessions: sessions };
  }),

  setResearchScope: (researchScope) => set({ researchScope }),

  setResearchDraft: (segments) => set({ researchDraft: normalizeComposerSegments(segments) }),

  appendResearchDraftMention: (mention) => set((state) => {
    const last = state.researchDraft[state.researchDraft.length - 1];
    const needsLeadingSpace = last?.kind === "mention" || (last?.kind === "text" && last.text.length > 0 && !/\s$/.test(last.text));
    const needsTrailingSpace = true;
    const segments = normalizeComposerSegments([
      ...state.researchDraft,
      ...(needsLeadingSpace ? [{ kind: "text" as const, text: " " }] : []),
      { kind: "mention" as const, flowId: mention.flowId, nodeId: mention.nodeId },
      ...(needsTrailingSpace ? [{ kind: "text" as const, text: " " }] : [])
    ]);
    return { researchDraft: segments, researchComposerFocusNonce: state.researchComposerFocusNonce + 1 };
  }),

  appendResearchDraftText: (text) => set((state) => {
    const trimmedTranscript = text.trim();
    if (!trimmedTranscript) return {};
    const last = state.researchDraft[state.researchDraft.length - 1];
    let leadingSegment: ComposerSegment[] = [];
    if (last?.kind === "text" && /\S$/.test(last.text)) leadingSegment = [{ kind: "text", text: "" }];
    const segments = normalizeComposerSegments([
      ...state.researchDraft,
      ...leadingSegment,
      { kind: "text", text: `${trimmedTranscript}\n\n` }
    ]);
    return { researchDraft: segments, researchComposerFocusNonce: state.researchComposerFocusNonce + 1 };
  }),

  clearResearchDraft: () => set({ researchDraft: [] }),

  requestResearchComposerFocus: () => set((state) => ({ researchComposerFocusNonce: state.researchComposerFocusNonce + 1 })),

  refreshResearchChats: async () => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode) return;
    const researchSessions = await window.archicode.listResearchChats(rootPath);
    set((state) => {
      const mergedResearchSessions = mergeResearchSessionsPreservingOptimistic(researchSessions, state.researchSessions);
      return {
        researchSessions: mergedResearchSessions,
        selectedResearchSessionId: selectedResearchSessionOrFallback(state.selectedResearchSessionId, mergedResearchSessions)
      };
    });
  },

  createResearchChat: async (scope, modelId) => {
    const { rootPath, bundle, researchScope } = get();
    if (!rootPath || !bundle || !window.archicode) return null;
    const selectedScope = scope ?? researchScope ?? defaultResearchScope(bundle, get().activeFlowId, get().activeSubflowId, get().selectedNodeId);
    const session = await window.archicode.createResearchChat({
      projectRoot: rootPath,
      scope: selectedScope,
      providerId: bundle.project.settings.providers.find((provider) => provider.enabled)?.id,
      modelId: modelId?.trim() || undefined
    });
    const researchSessions = await window.archicode.listResearchChats(rootPath);
    set({ researchSessions, selectedResearchSessionId: session.id, researchPanelOpen: true, researchScope: selectedScope });
    return session;
  },

  forkResearchMessage: async (messageId) => {
    const { rootPath, selectedResearchSessionId } = get();
    if (!rootPath || !selectedResearchSessionId || !window.archicode) return;
    const session = await window.archicode.forkResearchChat({
      projectRoot: rootPath,
      sessionId: selectedResearchSessionId,
      uptoMessageId: messageId
    });
    const researchSessions = await window.archicode.listResearchChats(rootPath);
    set({ researchSessions, selectedResearchSessionId: session.id, researchPanelOpen: true });
  },

  startScopedResearchChat: async (scope, message) => {
    const session = await get().createResearchChat(scope);
    if (!session) return;
    set({ selectedResearchSessionId: session.id, researchPanelOpen: true, researchScope: scope });
    await get().sendResearchMessage(message);
  },

  selectResearchChat: (selectedResearchSessionId) => set({ selectedResearchSessionId }),

  archiveResearchChat: async (sessionId) => {
    const { rootPath } = get();
    if (!rootPath || !window.archicode) return;
    await window.archicode.archiveResearchChat(rootPath, sessionId);
    await get().refreshResearchChats();
  },

  renameResearchChat: async (sessionId, title) => {
    const { rootPath } = get();
    const trimmed = title.trim();
    if (!rootPath || !trimmed || !window.archicode) return;
    await window.archicode.renameResearchChat(rootPath, sessionId, trimmed);
    await get().refreshResearchChats();
  },

  updateResearchChatAutoApproval: async (autoApproveGraphChanges) => {
    const { bundle } = get();
    if (!bundle) return;
    await get().updateSettings({
      ...bundle.project.settings,
      researchAutoApproveGraphChanges: autoApproveGraphChanges
    });
    await get().refreshResearchChats();
  },

  sendResearchMessage: async (content, filePaths = [], approvedMcpServerIds = [], rejectedMcpServerIds = [], resumeApprovalMessageId, referencedNodeIds, modelId) => {
    const { rootPath, selectedResearchSessionId, bundle } = get();
    if (!rootPath || !bundle || !window.archicode) return;
    const trimmed = content.trim();
    if (!trimmed) return;
    let sessionId = selectedResearchSessionId;
    if (!sessionId) {
      const session = typeof modelId === "string"
        ? await get().createResearchChat(get().researchScope ?? undefined, modelId)
        : await get().createResearchChat(get().researchScope ?? undefined);
      sessionId = session?.id ?? null;
    }
    if (!sessionId) return;
    const approvalResumeMessage = resumeApprovalMessageId
      ? get().researchSessions.find((session) => session.id === sessionId)?.messages.find((message) => message.id === resumeApprovalMessageId)
      : undefined;
    const isApprovalResume = Boolean(approvalResumeMessage?.mcpApprovalRequest);
    const internalContinuation = Boolean(approvalResumeMessage?.mcpApprovalRequest?.internalContinuation);
    // Never start a second concurrent turn on the same session while one is
    // already streaming (which would clobber persisted messages and render
    // optimistic messages out of order). Queue it instead so it sends
    // automatically once the in-flight turn finishes; the user can reorder or
    // drop queued messages before they go out.
    if (get().researchBusySessionIds.includes(sessionId)) {
      const queuedMessage: QueuedResearchMessage = {
        id: uid("research-queued"),
        content: trimmed,
        filePaths,
        referencedNodeIds: referencedNodeIds ?? [],
        modelId,
        createdAt: now()
      };
      set((state) => ({
        researchQueuedMessages: {
          ...state.researchQueuedMessages,
          [sessionId]: [...(state.researchQueuedMessages[sessionId] ?? []), queuedMessage]
        }
      }));
      return;
    }
    const knownMessageIds = new Set(
      get().researchSessions.find((session) => session.id === sessionId)?.messages.map((message) => message.id) ?? []
    );
    const optimisticUserId = uid("research-user");
    const optimisticAssistantId = uid("research-waiting");
    const thinkingPlaceholder = pickRandomResearchThinkingPhrase();
    set((state) => ({
      researchBusySessionIds: addResearchBusySession(state.researchBusySessionIds, sessionId),
      researchBusy: true,
      researchPendingAttachmentPaths: filePaths.length && !isApprovalResume
        ? { ...state.researchPendingAttachmentPaths, [optimisticUserId]: [...filePaths] }
        : state.researchPendingAttachmentPaths,
      researchStreamStates: {
        ...state.researchStreamStates,
        [optimisticAssistantId]: { kind: "thinking" }
      },
      researchSessions: state.researchSessions.map((session) => session.id === sessionId
        ? {
            ...session,
            modelId: modelId === null ? null : modelId?.trim() || session.modelId,
            title: session.messages.length || isApprovalResume ? session.title : trimmed.length > 56 ? `${trimmed.slice(0, 55)}...` : trimmed,
            messages: [
              ...session.messages,
              ...(!isApprovalResume ? [{
                id: optimisticUserId,
                role: "user" as const,
                content: trimmed,
                createdAt: now(),
                attachmentIds: [],
                webUsed: false,
                mcpToolCalls: [],
                subagentRuns: []
              }] : []),
              {
                id: optimisticAssistantId,
                role: "assistant" as const,
                content: thinkingPlaceholder,
                createdAt: now(),
                attachmentIds: [],
                webUsed: Boolean(bundle.project.settings.webSearch.enabled),
                mcpToolCalls: [],
                subagentRuns: []
              }
            ],
            updatedAt: now()
          }
        : session),
      selectedResearchSessionId: sessionId
    }));
    let disposeTokenStream: (() => void) | undefined;
    let disposeActivityStream: (() => void) | undefined;
    let disposeSubagentProgressStream: (() => void) | undefined;
    const streamUpdates = createResearchUpdateBatch(set);
    try {
      let streamedAnswerText = "";
      let streamedThinkingText = "";
      // The last non-empty text shown, kept across tool rounds so the preview never drops
      // back to the random placeholder once anything real has streamed. A tool-round
      // boundary just freezes it (with a "used a tool" hint) until the next round streams.
      let lastVisibleText = "";
      let awaitingRoundResume = false;
      disposeTokenStream = window.archicode.onResearchChatToken?.((payload) => {
        if (payload.projectRoot !== rootPath || payload.sessionId !== sessionId) return;
        if (payload.reset) {
          streamedAnswerText = "";
          streamedThinkingText = "";
          awaitingRoundResume = true;
        } else {
          const kind = payload.kind === "thinking" ? "thinking" : "answer";
          if (kind === "answer") streamedAnswerText += payload.text;
          else streamedThinkingText += payload.text;
          awaitingRoundResume = false;
        }
        const roundText = streamedAnswerText || streamedThinkingText;
        if (roundText) lastVisibleText = roundText;
        const visibleStreamText = roundText || lastVisibleText || thinkingPlaceholder;
        const visibleKind = streamedAnswerText ? "answer" : "thinking";
        streamUpdates.scheduleLatest("token", (state) => ({
          researchStreamStates: {
            ...state.researchStreamStates,
            [optimisticAssistantId]: { kind: visibleKind, usedTool: awaitingRoundResume }
          },
          researchSessions: state.researchSessions.map((session) => {
            if (session.id !== sessionId) return session;
            let foundOptimisticAssistant = false;
            const messages = session.messages.map((message) => {
              if (message.id !== optimisticAssistantId) return message;
              foundOptimisticAssistant = true;
              return { ...message, content: visibleStreamText || thinkingPlaceholder };
            });
            return {
              ...session,
              messages: foundOptimisticAssistant
                ? messages
                : [
                    ...messages,
                    {
                      id: optimisticAssistantId,
                      role: "assistant" as const,
                      content: visibleStreamText || thinkingPlaceholder,
                      createdAt: now(),
                      attachmentIds: [],
                      webUsed: Boolean(bundle.project.settings.webSearch.enabled),
                      mcpToolCalls: [],
                      subagentRuns: []
                    }
                  ],
              updatedAt: now()
            };
          })
        }));
      });
      disposeActivityStream = window.archicode.onResearchChatActivity?.((payload) => {
        if (payload.projectRoot !== rootPath || payload.sessionId !== sessionId) return;
        streamUpdates.schedule((state) => {
          const existing = state.researchChatActivity[optimisticAssistantId] ?? { status: "running" as const, lines: [] };
          const lines = payload.message && existing.lines[existing.lines.length - 1] !== payload.message
            ? [...existing.lines, payload.message].slice(-40)
            : existing.lines;
          return {
            researchChatActivity: {
              ...state.researchChatActivity,
              [optimisticAssistantId]: { status: payload.status ?? existing.status, lines }
            }
          };
        });
      });
      disposeSubagentProgressStream = window.archicode.onResearchSubagentProgress?.((payload) => {
        if (payload.projectRoot !== rootPath || payload.sessionId !== sessionId) return;
        streamUpdates.schedule((state) => {
          const existing = state.researchSubagentActivity[optimisticAssistantId] ?? [];
          return {
            researchSubagentActivity: {
              ...state.researchSubagentActivity,
              [optimisticAssistantId]: mergeLiveSubagentProgress(existing, payload)
            }
          };
        });
      });
      const session = await window.archicode.sendResearchChatMessage({
        projectRoot: rootPath,
        sessionId,
        content: trimmed,
        providerId: bundle.project.settings.providers.find((provider) => provider.enabled)?.id,
        modelId,
        filePaths,
        approvedMcpServerIds,
        rejectedMcpServerIds,
        referencedNodeIds,
        selectedNodeIds: get().selectedNodeIds.length > 0 ? get().selectedNodeIds : (get().selectedNodeId ? [get().selectedNodeId!] : []),
        activeFlowId: get().activeFlowId,
        activeSubflowId: get().activeSubflowId,
        resumeApprovalMessageId,
        internalContinuation,
        optimisticUserMessageId: optimisticUserId,
        optimisticAssistantMessageId: optimisticAssistantId
      });
      streamUpdates.flush();
      const nextBundle = await window.archicode.loadProject(rootPath);
      const researchSessions = await window.archicode.listResearchChats(rootPath);
      set((state) => {
        const { [optimisticAssistantId]: _finishedStream, ...researchStreamStates } = state.researchStreamStates;
        const { [optimisticAssistantId]: _finishedSubagent, ...researchSubagentActivity } = state.researchSubagentActivity;
        const { [optimisticAssistantId]: _finishedActivity, ...researchChatActivity } = state.researchChatActivity;
        const { [optimisticUserId]: _finishedAttachments, ...researchPendingAttachmentPaths } = state.researchPendingAttachmentPaths;
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, sessionId);
        const mergedResearchSessions = mergeResearchSessionsPreservingOptimistic(researchSessions, state.researchSessions);
        return {
          bundle: nextBundle,
          researchSessions: mergedResearchSessions,
          selectedResearchSessionId: selectedResearchSessionOrFallback(state.selectedResearchSessionId, mergedResearchSessions, session.id),
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0,
          researchStreamStates,
          researchSubagentActivity,
          researchChatActivity,
          researchPendingAttachmentPaths,
          error: null
        };
      });
      const canvasAction = newResearchCanvasAction(session, knownMessageIds);
      if (canvasAction) get().applyResearchCanvasAction(canvasAction);
    } catch (error) {
      streamUpdates.cancel();
      set((state) => {
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, sessionId);
        const { [optimisticAssistantId]: _finishedStream, ...researchStreamStates } = state.researchStreamStates;
        const { [optimisticAssistantId]: _finishedSubagent, ...researchSubagentActivity } = state.researchSubagentActivity;
        const { [optimisticAssistantId]: _finishedActivity, ...researchChatActivity } = state.researchChatActivity;
        return {
          error: error instanceof Error ? error.message : String(error),
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0,
          researchStreamStates,
          researchSubagentActivity,
          researchChatActivity
        };
      });
    } finally {
      disposeTokenStream?.();
      disposeActivityStream?.();
      disposeSubagentProgressStream?.();
      streamUpdates.cancel();
      set((state) => {
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, sessionId);
        const { [optimisticAssistantId]: _finishedStream, ...researchStreamStates } = state.researchStreamStates;
        const { [optimisticAssistantId]: _finishedSubagent, ...researchSubagentActivity } = state.researchSubagentActivity;
        const { [optimisticAssistantId]: _finishedActivity, ...researchChatActivity } = state.researchChatActivity;
        return {
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0,
          researchStreamStates,
          researchSubagentActivity,
          researchChatActivity
        };
      });
      const queued = get().researchQueuedMessages[sessionId];
      if (queued?.length) {
        const [next, ...rest] = queued;
        set((state) => ({
          researchQueuedMessages: { ...state.researchQueuedMessages, [sessionId]: rest }
        }));
        void get().sendResearchMessage(next.content, next.filePaths, [], [], undefined, next.referencedNodeIds, next.modelId);
      }
    }
  },

  stopResearchMessage: async (sessionId) => {
    if (!window.archicode) return;
    await window.archicode.cancelResearchChatMessage?.(sessionId);
  },

  dequeueResearchMessage: (sessionId, queuedMessageId) => set((state) => ({
    researchQueuedMessages: {
      ...state.researchQueuedMessages,
      [sessionId]: (state.researchQueuedMessages[sessionId] ?? []).filter((item) => item.id !== queuedMessageId)
    }
  })),

  reorderQueuedResearchMessage: (sessionId, queuedMessageId, direction) => set((state) => {
    const queue = state.researchQueuedMessages[sessionId] ?? [];
    const index = queue.findIndex((item) => item.id === queuedMessageId);
    const swapWith = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || swapWith < 0 || swapWith >= queue.length) return {};
    const next = [...queue];
    [next[index], next[swapWith]] = [next[swapWith], next[index]];
    return { researchQueuedMessages: { ...state.researchQueuedMessages, [sessionId]: next } };
  }),

  retryResearchMessage: async (assistantMessageId, approvedMcpServerIds = [], modelId) => {
    const { rootPath, selectedResearchSessionId, bundle, researchSessions } = get();
    if (!rootPath || !bundle || !window.archicode || !selectedResearchSessionId) return;
    const session = researchSessions.find((item) => item.id === selectedResearchSessionId);
    if (!session) return;
    const retryMessageIndex = session.messages.findIndex((message) => message.id === assistantMessageId);
    const retryMessage = retryMessageIndex >= 0 ? session.messages[retryMessageIndex] : null;
    if (!retryMessage || retryMessage.role !== "assistant" || !retryMessage.error) return;
    if (retryMessageIndex !== session.messages.length - 1) return;
    const sourceMessage = [...session.messages.slice(0, retryMessageIndex)].reverse().find((message) => message.role === "user");
    if (!sourceMessage) return;
    const knownMessageIds = new Set(session.messages.map((message) => message.id));

    const optimisticAssistantId = uid("research-waiting");
    const thinkingPlaceholder = pickRandomResearchThinkingPhrase();
    set((state) => ({
      researchBusySessionIds: addResearchBusySession(state.researchBusySessionIds, selectedResearchSessionId),
      researchBusy: true,
      researchStreamStates: {
        ...state.researchStreamStates,
        [optimisticAssistantId]: { kind: "thinking" }
      },
      researchSessions: state.researchSessions.map((item) => {
        if (item.id !== selectedResearchSessionId) return item;
        let replaced = false;
        const messages = item.messages.map((message) => {
          if (message.id !== assistantMessageId) return message;
          replaced = true;
          return {
            id: optimisticAssistantId,
            role: "assistant" as const,
            content: thinkingPlaceholder,
            createdAt: now(),
            attachmentIds: [],
            webUsed: Boolean(bundle.project.settings.webSearch.enabled),
            mcpToolCalls: [],
            subagentRuns: []
          };
        });
        return {
          ...item,
          modelId: modelId === null ? null : modelId?.trim() || item.modelId,
          messages: replaced
            ? messages
            : [
                ...messages,
                {
                  id: optimisticAssistantId,
                  role: "assistant" as const,
                  content: thinkingPlaceholder,
                  createdAt: now(),
                  attachmentIds: [],
                  webUsed: Boolean(bundle.project.settings.webSearch.enabled),
                  mcpToolCalls: [],
                  subagentRuns: []
                }
              ],
          updatedAt: now()
        };
      }),
      selectedResearchSessionId
    }));

    let disposeTokenStream: (() => void) | undefined;
    let disposeActivityStream: (() => void) | undefined;
    let disposeSubagentProgressStream: (() => void) | undefined;
    const streamUpdates = createResearchUpdateBatch(set);
    try {
      let streamedAnswerText = "";
      let streamedThinkingText = "";
      let lastVisibleText = "";
      let awaitingRoundResume = false;
      disposeTokenStream = window.archicode.onResearchChatToken?.((payload) => {
        if (payload.projectRoot !== rootPath || payload.sessionId !== selectedResearchSessionId) return;
        if (payload.reset) {
          streamedAnswerText = "";
          streamedThinkingText = "";
          awaitingRoundResume = true;
        } else {
          const kind = payload.kind === "thinking" ? "thinking" : "answer";
          if (kind === "answer") streamedAnswerText += payload.text;
          else streamedThinkingText += payload.text;
          awaitingRoundResume = false;
        }
        const roundText = streamedAnswerText || streamedThinkingText;
        if (roundText) lastVisibleText = roundText;
        const visibleStreamText = roundText || lastVisibleText || thinkingPlaceholder;
        const visibleKind = streamedAnswerText ? "answer" : "thinking";
        streamUpdates.scheduleLatest("token", (state) => ({
          researchStreamStates: {
            ...state.researchStreamStates,
            [optimisticAssistantId]: { kind: visibleKind, usedTool: awaitingRoundResume }
          },
          researchSessions: state.researchSessions.map((item) => {
            if (item.id !== selectedResearchSessionId) return item;
            let foundOptimisticAssistant = false;
            const messages = item.messages.map((message) => {
              if (message.id !== optimisticAssistantId) return message;
              foundOptimisticAssistant = true;
              return { ...message, content: visibleStreamText || thinkingPlaceholder };
            });
            return {
              ...item,
              messages: foundOptimisticAssistant
                ? messages
                : [
                    ...messages,
                    {
                      id: optimisticAssistantId,
                      role: "assistant" as const,
                      content: visibleStreamText || thinkingPlaceholder,
                      createdAt: now(),
                      attachmentIds: [],
                      webUsed: Boolean(bundle.project.settings.webSearch.enabled),
                      mcpToolCalls: [],
                      subagentRuns: []
                    }
                  ],
              updatedAt: now()
            };
          })
        }));
      });
      disposeActivityStream = window.archicode.onResearchChatActivity?.((payload) => {
        if (payload.projectRoot !== rootPath || payload.sessionId !== selectedResearchSessionId) return;
        streamUpdates.schedule((state) => {
          const existing = state.researchChatActivity[optimisticAssistantId] ?? { status: "running" as const, lines: [] };
          const lines = payload.message && existing.lines[existing.lines.length - 1] !== payload.message
            ? [...existing.lines, payload.message].slice(-40)
            : existing.lines;
          return {
            researchChatActivity: {
              ...state.researchChatActivity,
              [optimisticAssistantId]: { status: payload.status ?? existing.status, lines }
            }
          };
        });
      });
      disposeSubagentProgressStream = window.archicode.onResearchSubagentProgress?.((payload) => {
        if (payload.projectRoot !== rootPath || payload.sessionId !== selectedResearchSessionId) return;
        streamUpdates.schedule((state) => {
          const existing = state.researchSubagentActivity[optimisticAssistantId] ?? [];
          return {
            researchSubagentActivity: {
              ...state.researchSubagentActivity,
              [optimisticAssistantId]: mergeLiveSubagentProgress(existing, payload)
            }
          };
        });
      });

      const updatedSession = await window.archicode.sendResearchChatMessage({
        projectRoot: rootPath,
        sessionId: selectedResearchSessionId,
        content: sourceMessage.content,
        providerId: bundle.project.settings.providers.find((provider) => provider.enabled)?.id,
        modelId,
        approvedMcpServerIds,
        selectedNodeIds: get().selectedNodeIds.length > 0 ? get().selectedNodeIds : (get().selectedNodeId ? [get().selectedNodeId!] : []),
        activeFlowId: get().activeFlowId,
        activeSubflowId: get().activeSubflowId,
        retryAssistantMessageId: assistantMessageId,
        optimisticAssistantMessageId: optimisticAssistantId
      });
      streamUpdates.flush();
      const nextBundle = await window.archicode.loadProject(rootPath);
      const researchSessions = await window.archicode.listResearchChats(rootPath);
      set((state) => {
        const { [optimisticAssistantId]: _finishedStream, ...researchStreamStates } = state.researchStreamStates;
        const { [optimisticAssistantId]: _finishedSubagent, ...researchSubagentActivity } = state.researchSubagentActivity;
        const { [optimisticAssistantId]: _finishedActivity, ...researchChatActivity } = state.researchChatActivity;
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, selectedResearchSessionId);
        const mergedResearchSessions = mergeResearchSessionsPreservingOptimistic(researchSessions, state.researchSessions);
        return {
          bundle: nextBundle,
          researchSessions: mergedResearchSessions,
          selectedResearchSessionId: selectedResearchSessionOrFallback(
            state.selectedResearchSessionId,
            mergedResearchSessions,
            updatedSession.id
          ),
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0,
          researchStreamStates,
          researchSubagentActivity,
          researchChatActivity,
          error: null
        };
      });
      const canvasAction = newResearchCanvasAction(updatedSession, knownMessageIds);
      if (canvasAction) get().applyResearchCanvasAction(canvasAction);
    } catch (error) {
      streamUpdates.cancel();
      set((state) => {
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, selectedResearchSessionId);
        const { [optimisticAssistantId]: _finishedStream, ...researchStreamStates } = state.researchStreamStates;
        const { [optimisticAssistantId]: _finishedSubagent, ...researchSubagentActivity } = state.researchSubagentActivity;
        const { [optimisticAssistantId]: _finishedActivity, ...researchChatActivity } = state.researchChatActivity;
        return {
          error: error instanceof Error ? error.message : String(error),
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0,
          researchStreamStates,
          researchSubagentActivity,
          researchChatActivity
        };
      });
    } finally {
      disposeTokenStream?.();
      disposeActivityStream?.();
      disposeSubagentProgressStream?.();
      streamUpdates.cancel();
      set((state) => {
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, selectedResearchSessionId);
        const { [optimisticAssistantId]: _finishedStream, ...researchStreamStates } = state.researchStreamStates;
        const { [optimisticAssistantId]: _finishedSubagent, ...researchSubagentActivity } = state.researchSubagentActivity;
        const { [optimisticAssistantId]: _finishedActivity, ...researchChatActivity } = state.researchChatActivity;
        return {
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0,
          researchStreamStates,
          researchSubagentActivity,
          researchChatActivity
        };
      });
    }
  },

  summarizeResearchChat: async (sessionId) => {
    const { rootPath, bundle } = get();
    if (!rootPath || !bundle || !window.archicode) return;
    const optimisticAssistantId = uid("research-summary");
    set((state) => ({
      researchBusySessionIds: addResearchBusySession(state.researchBusySessionIds, sessionId),
      researchBusy: true,
      researchSessions: state.researchSessions.map((session) => session.id === sessionId
        ? {
            ...session,
            messages: [
              ...session.messages,
              {
                id: optimisticAssistantId,
                role: "assistant" as const,
                content: t("Summarizing chat..."),
                createdAt: now(),
                attachmentIds: [],
                webUsed: false,
                mcpToolCalls: [],
                subagentRuns: []
              }
            ],
            updatedAt: now()
          }
        : session),
      selectedResearchSessionId: sessionId
    }));
    try {
      const session = await window.archicode.summarizeResearchChat({
        projectRoot: rootPath,
        sessionId,
        providerId: bundle.project.settings.providers.find((provider) => provider.enabled)?.id
      });
      const researchSessions = await window.archicode.listResearchChats(rootPath);
      set((state) => {
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, sessionId);
        const mergedResearchSessions = mergeResearchSessionsPreservingOptimistic(researchSessions, state.researchSessions);
        return {
          researchSessions: mergedResearchSessions,
          selectedResearchSessionId: selectedResearchSessionOrFallback(state.selectedResearchSessionId, mergedResearchSessions, session.id),
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0,
          error: null
        };
      });
    } catch (error) {
      set((state) => ({
        error: error instanceof Error ? error.message : String(error),
        researchBusySessionIds: removeResearchBusySession(state.researchBusySessionIds, sessionId),
        researchBusy: removeResearchBusySession(state.researchBusySessionIds, sessionId).length > 0,
        researchSessions: state.researchSessions.map((session) => session.id === sessionId
          ? {
              ...session,
              messages: session.messages.map((message) => message.id === optimisticAssistantId
                ? {
                    ...message,
                    content: t("Chat summary failed."),
                    error: error instanceof Error ? error.message : String(error)
                  }
                : message)
            }
          : session)
      }));
    } finally {
      set((state) => {
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, sessionId);
        return {
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0
        };
      });
    }
  },

  applyResearchGraphChangeSet: async (sessionId, messageId, changeSetId, decisions, retryReviewed = false) => {
    const { rootPath, bundle } = get();
    if (!rootPath || !window.archicode) return [];
    const activeRun = decisions.some((decision) => decision.decision === "accepted")
      ? bundle?.runs.find(isRunBlockingNewChange)
      : undefined;
    if (activeRun) {
      set({ error: `Graph editing is locked while run ${activeRun.id} (${activeRun.status}) is active or waiting for review.` });
      return [];
    }
    set((state) => {
      const researchBusySessionIds = addResearchBusySession(state.researchBusySessionIds, sessionId);
      return {
        researchBusySessionIds,
        researchBusy: true
      };
    });
    try {
      const result = await window.archicode.applyResearchGraphChangeSet({
        projectRoot: rootPath,
        sessionId,
        messageId,
        changeSetId,
        decisions,
        retryReviewed
      });
      const researchSessions = await window.archicode.listResearchChats(rootPath);
      set((state) => {
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, sessionId);
        const mergedResearchSessions = mergeResearchSessionsPreservingOptimistic(researchSessions, state.researchSessions);
        return {
          bundle: result.bundle,
          researchSessions: mergedResearchSessions,
          selectedResearchSessionId: selectedResearchSessionOrFallback(state.selectedResearchSessionId, mergedResearchSessions, result.session.id),
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0,
          error: null
        };
      });
      return result.results;
    } catch (error) {
      set((state) => {
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, sessionId);
        return {
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0,
          error: error instanceof Error ? error.message : String(error)
        };
      });
      return [];
    }
  },

  respondToSubagentRun: async (sessionId, messageId, runId, decision, resolutionStrategy, runtimeTargetProfileIds) => {
    const { rootPath, researchSessions } = get();
    if (!rootPath || !window.archicode) return;
    // Seed a live "running" card for the approved run immediately, so the card
    // flips out of its awaiting-approval state the instant the user clicks
    // Approve — before the first progress event arrives.
    const approvedRun = decision === "approved"
      ? researchSessions.find((item) => item.id === sessionId)?.messages.find((item) => item.id === messageId)?.subagentRuns.find((item) => item.id === runId)
      : undefined;
    set((state) => ({
      researchBusySessionIds: addResearchBusySession(state.researchBusySessionIds, sessionId),
      researchBusy: true,
      researchSubagentActivity: approvedRun
        ? { ...state.researchSubagentActivity, [messageId]: [{ id: runId, kind: approvedRun.kind, title: approvedRun.title, status: "running", lines: [], artifacts: approvedRun.artifacts ?? [], visuallyAnalyzedArtifactIds: approvedRun.diagnostics?.visuallyAnalyzedArtifactIds ?? [] }] }
        : state.researchSubagentActivity
    }));
    const clearActivity = (state: ArchicodeState) => {
      const { [messageId]: _done, ...researchSubagentActivity } = state.researchSubagentActivity;
      return researchSubagentActivity;
    };
    const clearParentActivity = (state: ArchicodeState) => {
      const { [messageId]: _done, ...researchChatActivity } = state.researchChatActivity;
      return researchChatActivity;
    };
    const liveUpdates = createResearchUpdateBatch(set);
    const disposeProgressStream = window.archicode.onResearchSubagentProgress?.((payload) => {
      if (payload.projectRoot !== rootPath || payload.sessionId !== sessionId) return;
      liveUpdates.schedule((state) => {
        const existing = state.researchSubagentActivity[messageId] ?? [];
        return {
          researchSubagentActivity: {
            ...state.researchSubagentActivity,
            [messageId]: mergeLiveSubagentProgress(existing, payload)
          }
        };
      });
    });
    const disposeActivityStream = window.archicode.onResearchChatActivity?.((payload) => {
      if (payload.projectRoot !== rootPath || payload.sessionId !== sessionId) return;
      liveUpdates.schedule((state) => {
        const existing = state.researchChatActivity[messageId] ?? { status: "running" as const, lines: [] };
        const lines = payload.message && existing.lines[existing.lines.length - 1] !== payload.message
          ? [...existing.lines, payload.message].slice(-40)
          : existing.lines;
        return {
          researchChatActivity: {
            ...state.researchChatActivity,
            [messageId]: { status: payload.status ?? existing.status, lines }
          }
        };
      });
    });
    try {
      const session = await window.archicode.respondToSubagentRun({
        projectRoot: rootPath,
        sessionId,
        messageId,
        runId,
        decision,
        resolutionStrategy,
        runtimeTargetProfileIds
      });
      liveUpdates.flush();
      const nextBundle = await window.archicode.loadProject(rootPath);
      const nextSessions = await window.archicode.listResearchChats(rootPath);
      set((state) => {
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, sessionId);
        const mergedResearchSessions = mergeResearchSessionsPreservingOptimistic(nextSessions, state.researchSessions);
        return {
          bundle: nextBundle,
          researchSessions: mergedResearchSessions,
          selectedResearchSessionId: selectedResearchSessionOrFallback(state.selectedResearchSessionId, mergedResearchSessions, session.id),
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0,
          researchSubagentActivity: clearActivity(state),
          researchChatActivity: clearParentActivity(state),
          error: null
        };
      });
    } catch (error) {
      liveUpdates.cancel();
      set((state) => {
        const researchBusySessionIds = removeResearchBusySession(state.researchBusySessionIds, sessionId);
        return {
          researchBusySessionIds,
          researchBusy: researchBusySessionIds.length > 0,
          researchSubagentActivity: clearActivity(state),
          researchChatActivity: clearParentActivity(state),
          error: error instanceof Error ? error.message : String(error)
        };
      });
    } finally {
      disposeProgressStream?.();
      disposeActivityStream?.();
      liveUpdates.cancel();
    }
  },

});
