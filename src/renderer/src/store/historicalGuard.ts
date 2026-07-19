import type { ArchicodeState, StoreGet, StoreSet } from "./types";

export const historicalMutationMessage = "Historical graph inspection is read-only. Return to the current graph to make changes.";

export const historicalMutationActions = [
  // Graph and project state.
  "saveFlow", "createFlow", "createSubflow", "renameSubflow", "toggleSubflowIgnored", "reparentSubflow",
  "deleteSubflow", "setNodeLinkedSubflow", "applyResearchCanvasAction", "addNode", "cutSelectedNode", "pasteNode",
  "duplicateSelectedNode", "deleteSelectedNode", "addEdge", "rememberEdgeLabel", "updateSelectedEdge",
  "updateSelectedEdgePatch", "deleteSelectedEdge", "autoLayout", "updateNode", "importFlow", "importDrawioFlow",
  "applyPresentationAction", "undoPresentationAction", "redoPresentationAction",
  "repairProject", "deleteProjectState", "updateSettings", "updateProjectDetails", "startCodebaseOnboardingRun",
  "cancelCodebaseOnboardingRun",

  // Notes, patches, tests, runs, incidents, and runtime controls.
  "applyPatchProposal", "addNote", "updateNoteResolved", "updateNotePinned", "deleteNote", "purgeResolvedNotes",
  "purgeSystemNotes", "attachNodeReferences", "attachNodeReferenceFiles", "authorAcceptanceTests",
  "authorAcceptanceTestsForFlow", "enhanceNodeField", "clearAcceptanceTests", "runAcceptanceChecks", "runAgent",
  "runProfile", "stopRuntimeService", "restartRuntimeService", "continueQuestionBlockedRun", "approveRun", "cancelRun",
  "rejectRun", "dismissRunError", "removeRunFromQueue", "retryRun", "retryRunWithGuidance", "startDebuggingRun",
  "startRuntimeDebugRun", "reportBug", "updateBugIncident", "startIncidentDebugRun",

  // Research and project capabilities that can persist or apply changes.
  "createResearchChat", "forkResearchMessage", "startScopedResearchChat", "archiveResearchChat",
  "updateResearchChatAutoApproval", "sendResearchMessage", "retryResearchMessage", "stopResearchMessage",
  "summarizeResearchChat", "applyResearchGraphChangeSet", "respondToSubagentRun", "createProjectSkill",
  "installMcpRegistryServer", "importMcpServers", "updateMcpServer", "refreshMcpServerCapabilities",

  // Git mutations could invalidate the commit being inspected.
  "initializeGitRepository", "runGitOperation", "discardGitChanges", "stashGitChanges", "popGitStash",
  "commitGitFiles", "switchGitBranch", "createGitBranch"
] as const satisfies readonly (keyof ArchicodeState)[];

export function guardHistoricalMutations(state: ArchicodeState, set: StoreSet, get: StoreGet): ArchicodeState {
  const mutable = state as unknown as Record<string, unknown>;
  for (const actionName of historicalMutationActions) {
    const action = mutable[actionName];
    if (typeof action !== "function") continue;
    mutable[actionName] = (...args: unknown[]) => {
      if (get().historicalInspection) {
        set({ error: historicalMutationMessage });
        return undefined;
      }
      return (action as (...values: unknown[]) => unknown)(...args);
    };
  }
  return state;
}
