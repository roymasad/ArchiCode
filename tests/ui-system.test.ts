import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..");

const storeSourceFiles = [
  "src/renderer/src/store/useArchicodeStore.ts",
  "src/renderer/src/store/types.ts",
  "src/renderer/src/store/helpers.ts",
  "src/renderer/src/store/projectSlice.ts",
  "src/renderer/src/store/graphSlice.ts",
  "src/renderer/src/store/runsSlice.ts",
  "src/renderer/src/store/gitFilesSlice.ts",
  "src/renderer/src/store/capabilitiesSlice.ts",
  "src/renderer/src/store/researchSlice.ts",
  "src/renderer/src/store/notesSlice.ts",
  "src/renderer/src/store/uiSlice.ts"
];
const researchPanelSourceFiles = [
  "src/renderer/src/components/ResearchPanel.tsx",
  "src/renderer/src/components/researchContent.ts",
  "src/renderer/src/components/researchTts.ts",
  "src/renderer/src/components/researchTranscript.ts",
  "src/renderer/src/components/ResearchTodoCapsule.tsx",
  "src/renderer/src/components/ResearchMarkdown.tsx",
  "src/renderer/src/components/ResearchMemoryPanel.tsx"
];
function readNodeInspectorSource(): string {
  return ["src/renderer/src/components/NodeInspector.tsx", "src/renderer/src/components/nodeInspectorShared.tsx"]
    .map((file) => readFileSync(resolve(repoRoot, file), "utf8")).join("\n");
}
function readProjectToolbarSource(): string {
  return ["src/renderer/src/components/ProjectToolbar.tsx", "src/renderer/src/components/projectToolbarShared.tsx"]
    .map((file) => readFileSync(resolve(repoRoot, file), "utf8")).join("\n");
}
function readResearchPanelSource(): string {
  return researchPanelSourceFiles.map((file) => readFileSync(resolve(repoRoot, file), "utf8")).join("\n");
}
function readStoreSource(): string {
  return storeSourceFiles.map((file) => readFileSync(resolve(repoRoot, file), "utf8")).join("\n");
}

describe("renderer UI system", () => {
  it("keeps planning and policy violation badges distinct on nodes and in properties", () => {
    const nodeCard = readFileSync(resolve(repoRoot, "src/renderer/src/components/ArchicodeNodeCard.tsx"), "utf8");
    const inspector = readNodeInspectorSource();
    const primarySignal = nodeCard.slice(
      nodeCard.indexOf("function primaryNodeSignal"),
      nodeCard.indexOf("export function ArchicodeNodeCard")
    );

    expect(primarySignal).toContain("This node has changed planning state. Requires implementation.");
    expect(primarySignal).not.toContain("policyViolations");
    expect(nodeCard).toContain("<NodeSignalTip label={nodePolicyViolationTooltip(signals.policyViolations)}>");
    expect(inspector).toContain("getNodeSignalCounts(bundle, node.id, flow.id).policyViolations");
    expect(inspector).toContain('tone: "danger"');
    expect(inspector).toContain("nodePolicyViolationTooltip(nodePolicyViolationCount)");
  });

  it("starts a scoped chat review of flow logic from AI Debug", () => {
    const toolbar = readProjectToolbarSource();
    const prompt = readFileSync(resolve(repoRoot, "src/renderer/src/utils/logicReview.ts"), "utf8");

    expect(toolbar).toContain("Review flow logic…");
    expect(toolbar).toContain('title="Review flow logic"');
    expect(toolbar).toContain("Current flow");
    expect(toolbar).toContain("All project flows");
    expect(toolbar).toContain("startScopedResearchChat(scope, buildLogicReviewPrompt(target))");
    expect(prompt).toContain("contradict one another");
    expect(prompt).toContain("Do not edit the graph");
  });

  it("offers read-only AI explanations from graph and project contexts", () => {
    const toolbar = readProjectToolbarSource();
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const nodeCard = readFileSync(resolve(repoRoot, "src/renderer/src/components/ArchicodeNodeCard.tsx"), "utf8");
    const inspector = readNodeInspectorSource();
    const fileBrowser = readFileSync(resolve(repoRoot, "src/renderer/src/components/ProjectFileBrowser.tsx"), "utf8");
    const runConsole = readFileSync(resolve(repoRoot, "src/renderer/src/components/RunConsole.tsx"), "utf8");
    const artifactBrowser = readFileSync(resolve(repoRoot, "src/renderer/src/components/ArtifactBrowser.tsx"), "utf8");

    expect(toolbar).toContain("<SearchCheck size={15} /> Review flow logic…");
    expect(canvas).toContain("Explain Selected Nodes");
    expect(canvas).toContain("explainNodesPrompt(nodes, flow!.name)");
    expect(canvas).toContain("explainPolicyViolationsPrompt(violations, preferredNode?.title)");
    expect(nodeCard).toContain("onExplainPolicyViolations");
    expect(inspector).toContain("explainEdgePrompt");
    expect(fileBrowser).toContain("explainFilePrompt(selectedFilePath)");
    expect(runConsole).toContain("explainRunPrompt(selected)");
    expect(artifactBrowser).toContain("explainArtifactPrompt(selected)");
  });

  it("keeps the importer open on a truthful completion summary", () => {
    const wizard = readFileSync(resolve(repoRoot, "src/renderer/src/components/CodebaseOnboardingWizard.tsx"), "utf8");
    const store = readFileSync(resolve(repoRoot, "src/renderer/src/store/projectSlice.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/research.ts"), "utf8");
    const mainProcess = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const toolbar = readFileSync(resolve(repoRoot, "src/renderer/src/components/ProjectToolbar.tsx"), "utf8");

    expect(wizard).toContain("Codebase import summary");
    expect(wizard).toContain("Map ready to explore");
    expect(wizard).toContain("No action is required");
    expect(wizard).toContain("Total time");
    expect(wizard).toContain("Repository coverage");
    expect(wizard).toContain("Generated map");
    expect(wizard).toContain("Architecture review");
    expect(wizard).toContain("Estimated accuracy");
    expect(wizard).toContain("Accuracy estimate factors");
    expect(wizard).toContain("source files deeply reviewed");
    expect(wizard).toContain("Provider or graph errors");
    expect(wizard).toContain("Technical import report");
    expect(wizard).toContain("Automated protections applied");
    expect(wizard).toContain("Coverage and review notes");
    expect(wizard).toContain("Unverified suggestions omitted");
    expect(wizard).toContain("Additional implementation details");
    expect(wizard).toContain("invalid suggestions safely ignored");
    expect(wizard).toContain("runtime setup");
    expect(wizard).toContain("Phase timing breakdown");
    expect(wizard).toContain("Explore graph");
    expect(store).toContain("result: result.summary");
    expect(store).toContain("openInitialCodebaseImportReport");
    expect(store).toContain("getInitialCodebaseImportReport");
    expect(main).toContain("summary: CodebaseMappingSummary");
    expect(main).toContain("durationMs: Date.now() - mappingStartedAtMs");
    expect(mainProcess).toContain("archicode:get-initial-codebase-import-report");
    expect(preload).toContain("export type CodebaseMappingSummary");
    expect(preload).toContain("getInitialCodebaseImportReport");
    expect(toolbar).toContain("Initial import report");
  });

  it("shows local semantic cache context in the node Advanced tab", () => {
    const inspector = readNodeInspectorSource();
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const toolbar = readProjectToolbarSource();

    expect(inspector).toContain("Semantic context");
    expect(inspector).toContain("Related graph nodes");
    expect(inspector).toContain("Possible semantic matches");
    expect(inspector).toContain("never saved into the graph or committed to Git");
    expect(preload).toContain("getNodeSemanticContext");
    expect(main).toContain('archicode:get-node-semantic-context');
    // Semantic indexing must NOT auto-start when a project opens; it runs inside the
    // codebase import (with progress + cancel) and on explicit model changes only.
    expect(main).not.toContain("scheduleSemanticIndexWarmup(bundle);");
    expect(main).toContain("scheduleSemanticIndexWarmup(bundle, true)");
    expect(main).toContain("archicode:cancel-codebase-mapping");
    expect(main).toContain("semanticIndexNeedsWarmup(status)");
    expect(toolbar).toContain("Code coverage");
    expect(toolbar).toContain("Source chunks");
    expect(toolbar).toContain("Components indexed");
    expect(toolbar).toContain("Source lines covered");
  });

  it("keeps same-subject appearances collapsed by default in the node Advanced tab", () => {
    const inspector = readNodeInspectorSource();
    const styles = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(inspector).toContain("const [subjectPerspectivesExpanded, setSubjectPerspectivesExpanded] = useState(false)");
    expect(inspector).toContain("aria-expanded={subjectPerspectivesExpanded}");
    expect(inspector).toContain("setSubjectPerspectivesExpanded((current) => !current)");
    expect(inspector).toContain("subjectPerspectivesExpanded ? <div className=\"subject-perspective-list\"");
    expect(inspector).toContain("setSubjectPerspectivesExpanded(false)");
    expect(styles).toContain(".subject-perspectives-trigger");
    expect(styles).toContain(".subject-perspectives-trigger.is-expanded > svg:first-child");
  });

  it("declares the Radix primitives used by the ArchiCode UI layer", () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(manifest.dependencies["@radix-ui/react-dialog"]).toBeTruthy();
    expect(manifest.dependencies["@radix-ui/react-dropdown-menu"]).toBeTruthy();
    expect(manifest.dependencies["@radix-ui/react-tabs"]).toBeTruthy();
    expect(manifest.dependencies["@radix-ui/react-tooltip"]).toBeTruthy();
    expect(manifest.dependencies["@radix-ui/react-select"]).toBeTruthy();
    expect(manifest.dependencies["@radix-ui/react-switch"]).toBeTruthy();
    expect(manifest.dependencies["@radix-ui/react-scroll-area"]).toBeTruthy();
  });

  it("keeps light and dark themes on the same semantic token contract", () => {
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");
    const tokens = [
      "app",
      "canvas",
      "surface",
      "surface-raised",
      "surface-muted",
      "field",
      "text",
      "text-muted",
      "text-subtle",
      "border",
      "border-strong",
      "accent",
      "accent-muted",
      "danger",
      "warning",
      "success",
      "focus"
    ];

    for (const token of tokens) {
      expect(css).toContain(`--${token}:`);
    }
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain(".react-flow__minimap");
    expect(css).toContain(".ui-dialog-content");
  });

  it("includes a concise in-app help page for project orientation", () => {
    const helpPage = readFileSync(resolve(repoRoot, "src/renderer/src/components/HelpPage.tsx"), "utf8");

    expect(helpPage).toContain("ArchiCode Help");
    expect(helpPage).toContain("What it is");
    expect(helpPage).toContain("visual-first harness");
    expect(helpPage).not.toContain("local, visual-first Electron harness");
    expect(helpPage).toContain("Quick start");
    expect(helpPage).toContain("It is required for model-assisted planning and code changes");
    expect(helpPage).toContain("Map the work as a graph");
    expect(helpPage).toContain("Review risky changes");
    expect(helpPage).toContain("Archi, the chat research agent");
    expect(helpPage).toContain("edit or create graph nodes and groups");
    expect(helpPage).toContain("execute builds");
    expect(helpPage).toContain("Canvas shortcuts");
    expect(helpPage).toContain("Space over empty canvas");
    expect(helpPage).toContain("Toggle the minimap.");
    expect(helpPage).toContain("Ctrl/Cmd + F");
    expect(helpPage).toContain("Ctrl/Cmd + drag empty canvas");
  });

  it("mounts the read-only CLI inspector for Codex Local research chats", () => {
    const providers = readFileSync(resolve(repoRoot, "src/main/providers.ts"), "utf8")
      + readFileSync(resolve(repoRoot, "src/main/providers/localCli.ts"), "utf8");

    expect(providers).toContain("archicode_project_inspect_cli");
    expect(providers).toContain("server.registerTool(\"archicode_project_inspect_cli\"");
    expect(providers).toContain("Project files and read-only CLI inspection are available through structured tools in this chat");
    expect(providers).toContain("Before proposing any new queue start, check activeQueue, queue, recentRuns, runtimeServices, and orchestration todos already in context.");
    expect(providers).toContain("graph-to-code sync only as one brief capability");
    expect(providers).toContain("Do not explain sync options, comparison scopes, or the approval flow unless the user specifically asks");
  });

  it("keeps local layout persistence and reset affordance in the app shell", () => {
    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");
    const toolbar = readProjectToolbarSource();
    const store = readStoreSource();
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");

    expect(app).toContain("archicode-layout:");
    expect(app).toContain("researchPanelOpen");
    expect(app).toContain("onResetLayout={resetLayout}");
    expect(app).not.toContain(">Reset layout<");
    expect(toolbar).toContain("Reset layout");
    expect(toolbar).toContain("onResetLayout");
    expect(toolbar).toContain("UI scale");
    expect(toolbar).toContain("setUiScale");
    expect(preload).toContain("setZoomFactor");
    expect(app).toContain('document.body.style.setProperty("zoom"');
    expect(app).toContain("window.archicode.setZoomFactor");
    expect(store).toContain("projectUiKey");
    expect(store).toContain("archicode-ui-scale");
    expect(store).toContain('"workbench"');
    expect(store).toContain('"viewport"');
  });

  it("resets project-scoped state when entering a different project", () => {
    const store = readStoreSource();
    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");
    // Every project-entry action clears the previous project's state via the
    // shared reset (openProjectFolder + openRecentProject + createProjectFromTemplate).
    expect((store.match(/\.\.\.projectScopedResetState\(\),/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // The shared reset covers the fields that previously leaked between projects.
    const resetBody = store.slice(store.indexOf("function projectScopedResetState"), store.indexOf("function clearProjectStateForBranchChange"));
    for (const field of ["selectedResearchSessionId", "researchScope", "researchStreamStates", "gitLogs", "searchQuery", "nodeClipboard", "pendingRunKeys", "providerHealth", "graphNavigationRequest", "shellPrompt", "buildQuestionCheck"]) {
      expect(resetBody).toContain(`${field}:`);
    }
    // Project-scoped lists are refreshed with the new project's data on entry.
    expect((store.match(/runtimeServices: await window\.archicode\.listRuntimeServices\(bundle\.rootPath\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // The latched error banner clears when the active project changes.
    expect(app).toContain("A latched error banner belongs to the project it was raised in");
  });

  it("allows settings and Git dialogs to be moved and resized", () => {
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");
    const toolbar = readProjectToolbarSource();
    const gitPanel = readFileSync(resolve(repoRoot, "src/renderer/src/components/GitPanel.tsx"), "utf8");
    const ui = readFileSync(resolve(repoRoot, "src/renderer/src/components/ui.tsx"), "utf8");

    expect(ui).toContain("draggable?: boolean");
    expect(ui).toContain("resizable?: boolean");
    expect(css).toContain(".ui-dialog-content.is-draggable .ui-dialog-header");
    expect(css).toContain(".ui-dialog-content.is-resizable");
    expect(toolbar).toContain('className="settings-modal"');
    expect(toolbar).toContain("draggable");
    expect(toolbar).toContain("resizable");
    expect(gitPanel).toContain("draggable");
    expect(gitPanel).toContain("resizable");
  });

  it("routes unsupported direct undo into a warning banner instead of undoing", () => {
    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const store = readStoreSource();
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(store).toContain("showDirectUndoNotice");
    expect(store).toContain("Undo unavailable");
    expect(store).toContain("ArchiCode doesn't support realtime undo due to risk of graph/code desyncs.");
    expect(store).toContain("discard them with Git");
    expect(canvas).toContain('event.key.toLowerCase() === "z"');
    expect(canvas).toContain("showDirectUndoNotice();");
    expect(canvas).toContain("event.stopPropagation();");
    expect(app).toContain("window.archicode?.onDirectUndoRequested");
    expect(app).toContain("function ExpandableBanner");
    expect(app).toContain("detailsTitle={`${appNotice.title} details`}");
    expect(app).toContain("dismissAppNotice");
    expect(preload).toContain("onDirectUndoRequested");
    expect(preload).toContain("archicode:direct-undo-requested");
    expect(main).toContain('label: "Undo"');
    expect(main).toContain('accelerator: "CmdOrCtrl+Z"');
    expect(main).toContain('webContents.send("archicode:direct-undo-requested")');
    expect(css).toContain(".validation-bar.warning");
  });

  it("persists and restores canvas pan and zoom for existing projects", () => {
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const store = readStoreSource();

    expect(store).toContain("CanvasViewport");
    expect(store).toContain("projectScopedUiKey(rootPath, \"viewport\"");
    expect(store).toContain("zoom");
    expect(store).toContain("setCanvasViewport");
    expect(canvas).toContain("instance.getViewport()");
    expect(canvas).toContain("defaultViewport={canvasViewport ?? undefined}");
    expect(canvas).toContain("fitView={!canvasViewport}");
  });

  it("does not auto-select the first canvas node when opening a project", () => {
    const store = readStoreSource();

    expect(store).not.toContain("selectedNodeId: bundle.flows[0]?.nodes[0]?.id");
    expect(store).not.toContain("selectedNodeIds: selectedNodeIdsFor(bundle.flows[0]?.nodes[0]?.id)");
    expect(store).not.toContain("selectedNodeId: result.bundle.flows[0]?.nodes[0]?.id");
    expect(store).not.toContain("selectedNodeIds: selectedNodeIdsFor(result.bundle.flows[0]?.nodes[0]?.id)");
  });

  it("keeps streaming research replies visible across chat refreshes", () => {
    const store = readStoreSource();
    const researchSessions = readFileSync(resolve(repoRoot, "src/renderer/src/utils/researchSessions.ts"), "utf8");

    expect(store).toContain("mergeResearchSessionsPreservingOptimistic");
    expect(store).toContain("research-waiting");
    expect(store).toContain("foundOptimisticAssistant");
    expect(store).toContain("messages: foundOptimisticAssistant");
    expect(store).toContain("researchBusySessionIds");
    expect(store).toContain("selectedResearchSessionOrFallback");
    expect(store).toContain("optimisticAssistantMessageId: optimisticAssistantId");
    expect(store).toContain("researchStreamStates");
    expect(store).toContain("mergeResearchSessionsPreservingOptimistic(researchSessions, state.researchSessions)");
    expect(researchSessions).toContain("isOptimisticResearchMessage");
    expect(researchSessions).toContain("hasResolvedAssistantAfterOptimistic");
    expect(researchSessions).toContain("existing.createdAt >= message.createdAt");

    const panel = readResearchPanelSource();
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");
    expect(panel).toContain("researchBusySessionIds.includes(selected.id)");
    expect(panel).toContain("research-message-thinking-draft");
    expect(panel).toContain("Thinking");
    expect(panel).toContain("research-message-image-grid");
    expect(panel).toContain("research-message-image-thumb");
    expect(panel).toContain("researchPendingAttachmentPaths[message.id]");
    expect(panel).toContain("pendingTextAttachmentNames");
    expect(panel).toContain("attachmentFileName");
    expect(panel).toContain('aria-label="Text document attachments"');
    expect(css).toContain(".research-message-thinking-draft");
    expect(css).toContain(".research-message-thinking-draft .research-markdown");
    expect(css).toContain(".research-message-image-thumb");
    expect(css).toContain(".research-message-file-chip.is-pending");
  });

  it("shows exact one-shot approval details for Research rule mutations", () => {
    const panel = readResearchPanelSource();
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(panel).toContain('RESEARCH_RULES_TOOL_NAME = "archicode_project_manage_rules"');
    expect(panel).toContain("Review exact proposed change");
    expect(panel).toContain("This approval applies only to this exact change");
    expect(panel).toContain('ruleApproval ? "Approve change" : "Approve"');
    expect(panel).toContain('ruleApproval ? "Rule change requires approval"');
    expect(panel).toContain("ruleApproval ? (");
    expect(panel).toContain('className="research-mcp-remember"');
    expect(css).toContain(".research-mcp-request.is-rule-change");
    expect(css).toContain(".research-rule-approval-proposal pre");
  });

  it("renders research messages with CommonMark and GitHub-flavored Markdown", () => {
    const panel = readResearchPanelSource();
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(manifest.dependencies["react-markdown"]).toBeTruthy();
    expect(manifest.dependencies["remark-gfm"]).toBeTruthy();
    expect(manifest.dependencies["rehype-highlight"]).toBeTruthy();
    expect(panel).toContain("<Markdown");
    expect(panel).toContain("remarkPlugins={[remarkGfm]}");
    expect(panel).toContain("rehypeHighlight");
    expect(css).toContain("--code-surface: #f6f8fa");
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("--code-surface: #171d21");
    expect(css).toContain("background: var(--code-surface)");
    expect(panel).toContain("skipHtml");
    expect(panel).toContain("transformMarkdownUrl");
  });

  it("keeps research chat history as one list with a simple scope filter", () => {
    const panel = readResearchPanelSource();
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(panel).toContain('useState<"all" | "scope">("all")');
    expect(panel).toContain('aria-label="Chat history filter"');
    expect(panel).toContain("<span>All</span>");
    expect(panel).toContain('<span>{focusMode ? "Scope" : "This scope"}</span>');
    expect(panel).toContain("visibleHistoryChats");
    expect(panel).not.toContain("Parent scopes");
    expect(panel).not.toContain("Other recent");
    expect(panel).not.toContain("isInheritedScope");
    expect(css).toContain(".research-history-filter");
    expect(css).toContain(".research-history-list");
  });

  it("confirms chat archival from the shared normal and focus-mode history list", () => {
    const panel = readResearchPanelSource();

    expect(panel).toContain("onArchive={requestResearchChatArchive}");
    expect(panel).toContain("setArchiveConfirmationSessionId(sessionId)");
    expect(panel).toContain("DialogRoot open={Boolean(archiveConfirmationSession)}");
    expect(panel).toContain('title="Archive this chat?"');
    expect(panel).toContain("The chat will no longer appear in All or Scope history.");
    expect(panel).toContain("await archiveResearchChat(archiveConfirmationSessionId)");
    expect(panel).toContain("<span>Archive chat</span>");
    expect(panel).toContain(">Cancel</Button>");
  });

  it("keeps top-level app errors visible with details and dismiss controls", () => {
    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(app).toContain("stickyError");
    expect(app).toContain("Error details");
    expect(app).toContain("bannerTextOverflows");
    expect(app).toContain("messageOverflowing");
    expect(app).toContain("validation-bar-message");
    expect(app).toContain("ResizeObserver");
    expect(app).toContain("<span>Details</span>");
    expect(app).toContain("<span>Dismiss</span>");
    expect(css).toContain(".validation-bar-actions");
    expect(css).toContain(".validation-bar-message");
    expect(css).toContain("-webkit-line-clamp: 2");
    expect(css).toContain(".error-details-pre");
  });

  it("exposes a project action to open the workspace in Visual Studio Code", () => {
    const toolbar = readProjectToolbarSource();
    const store = readStoreSource();
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");

    expect(toolbar).toContain("Open in VS Code");
    expect(toolbar).toContain("openProjectInVsCode");
    expect(store).toContain("openProjectInVsCode");
    expect(preload).toContain("archicode:open-project-in-vscode");
    expect(main).toContain("openProjectInVsCode");
    expect(main).toContain("com.microsoft.VSCode");
    expect(main).toContain("Microsoft VS Code");
    expect(main).toContain("code.cmd");
  });

  it("offers recent projects from the sidebar open menu", () => {
    const sidebar = readFileSync(resolve(repoRoot, "src/renderer/src/components/ProjectSidebar.tsx"), "utf8");
    const store = readStoreSource();
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(sidebar).toContain("Choose Folder...");
    expect(sidebar).toContain("Recent");
    expect(sidebar).toContain("openRecentProject");
    expect(sidebar).toContain("recentProjectOptions");
    expect(store).toContain("recentProjects: RecentProjectEntry[]");
    expect(store).toContain("listRecentProjects");
    expect(preload).toContain("archicode:list-recent-projects");
    expect(preload).toContain("archicode:open-recent-project");
    expect(main).toContain("recentProjectRoots?: string[]");
    expect(main).toContain("MAX_RECENT_PROJECTS = 8");
    expect(main).toContain("ipcMain.handle(\"archicode:list-recent-projects\"");
    expect(main).toContain("ipcMain.handle(\"archicode:open-recent-project\"");
    expect(sidebar).toContain("Project menu");
    expect(css).toContain(".project-menu-button");
  });

  it("copies the project path through the Electron clipboard bridge", () => {
    const sidebar = readFileSync(resolve(repoRoot, "src/renderer/src/components/ProjectSidebar.tsx"), "utf8");
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");

    expect(sidebar).toContain("copyTextToClipboard(rootPath)");
    expect(sidebar).toContain("pathCopyFailed");
    expect(sidebar).toContain("navigator.clipboard?.writeText");
    expect(preload).toContain("clipboard.writeText(text)");
    expect(preload).toContain("copyTextToClipboard");
  });

  it("lets users manage named LLM provider profiles on existing adapters", () => {
    const toolbar = readProjectToolbarSource();
    const globalSetup = readFileSync(resolve(repoRoot, "src/renderer/src/components/GlobalProviderSetup.tsx"), "utf8");
    const profileUtils = readFileSync(resolve(repoRoot, "src/renderer/src/utils/providerProfiles.ts"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");

    expect(toolbar).toContain("New Provider");
    expect(toolbar).toContain("Profile name");
    expect(toolbar).toContain("API compatibility");
    expect(toolbar).toContain("Duplicate provider profile");
    expect(toolbar).toContain("Delete provider profile");
    expect(toolbar).toContain("createProviderProfile");
    expect(toolbar).toContain("changeProviderCompatibility");
    expect(toolbar).toContain("pendingProviderRevealId");
    expect(toolbar).toContain("data-provider-name-input");
    expect(globalSetup).toContain("New Provider");
    expect(globalSetup).toContain("API compatibility");
    expect(globalSetup).toContain("checkGlobalProvider");
    expect(globalSetup).toContain("Checking...");
    expect(globalSetup).toContain("Context window");
    expect(globalSetup).toContain("Saved API key (hidden)");
    expect(globalSetup).toContain("Use throwaway Codex sessions");
    expect(globalSetup).toContain("Output verbosity");
    expect(globalSetup).toContain("model_verbosity");
    expect(globalSetup).toContain("text.verbosity");
    expect(globalSetup).toContain("Chat Completions");
    expect(globalSetup).toContain("duplicateProviderProfile");
    expect(globalSetup).toContain("pendingProviderRevealId");
    expect(globalSetup).toContain("data-provider-name-input");
    expect(toolbar).toContain("Saved API key (hidden)");
    expect(toolbar).toContain("Output verbosity");
    expect(toolbar).toContain("model_verbosity");
    expect(toolbar).toContain("text.verbosity");
    expect(toolbar).toContain("The enabled card supplies the default model for chat and build agents");
    expect(toolbar).toContain('details className="settings-keychain-disclosure"');
    expect(toolbar).toContain("macOS Keychain");
    expect(toolbar).not.toContain("API keys are scrubbed from project JSON");
    expect(toolbar).toContain("preserveMissingSecrets: true");
    expect(toolbar).toContain("refreshes available models when the provider exposes a model catalog");
    expect(globalSetup).toContain("refreshes available models when the provider exposes a model catalog");
    expect(toolbar).toContain("isOfficialOpenAiCompatibleProvider");
    expect(globalSetup).toContain("isOfficialOpenAiCompatibleProvider");
    expect(toolbar).toContain("Loaded ${provider.detectedAvailableModels.length} models from OpenAI's models endpoint.");
    expect(globalSetup).toContain("Loaded ${provider.detectedAvailableModels.length} models from OpenAI's models endpoint.");
    expect(toolbar).toContain("if (provider.model && options.includes(provider.model)) return provider;");
    expect(toolbar).toContain("await refreshCheckedProviderDraft(providerId)");
    expect(toolbar).toContain("mergeProviderCapabilityMetadata(current.providers, checkedProvider)");
    expect(globalSetup).toContain("if (provider.model && options.includes(provider.model)) return provider;");
    expect(main).toContain("archicode:check-global-provider");
    expect(preload).toContain("checkGlobalProvider");
    expect(preload).toContain("archicode:get-global-provider-secret-status");
    expect(main).toContain("globalProviderSecretStatus");
    expect(profileUtils).toContain("providerKindOptions");
    expect(profileUtils).toContain("openai-compatible");
    expect(profileUtils).toContain("anthropic-compatible");
    expect(profileUtils).toContain("codex-local");
    expect(profileUtils).toContain("apiKey: undefined");
    expect(profileUtils).toContain("Model default");
    expect(css).toContain(".provider-profile-toolbar");
    expect(css).toContain(".provider-settings-intro");
    expect(css).toContain(".settings-keychain-disclosure");
    expect(css).toContain("flex-direction: column");
    expect(css).toContain("z-index: 1");
    expect(css).toContain("flex: 1 1 auto");
    expect(css).toContain(".provider-card-actions");
    expect(css).toContain(".settings-keychain-note");
    expect(main).toContain("if (!providerIds.has(providerId)) delete providerSecrets[providerId]");
  });

  it("opens editable local model pickers with the full suggestion list", () => {
    const picker = readFileSync(resolve(repoRoot, "src/renderer/src/components/ModelCombobox.tsx"), "utf8");
    const toolbar = readProjectToolbarSource();
    const globalSetup = readFileSync(resolve(repoRoot, "src/renderer/src/components/GlobalProviderSetup.tsx"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(picker).toContain("setFilter(\"\");");
    expect(picker).toContain("onFocus={showAllOptions}");
    expect(picker).toContain("Show model options");
    expect(toolbar).toContain("<ModelCombobox");
    expect(globalSetup).toContain("<ModelCombobox");
    expect(toolbar).toContain("catalogMode={provider.detectedAvailableModels.length > 0}");
    expect(globalSetup).toContain("catalogMode={provider.detectedAvailableModels.length > 0}");
    expect(picker).toContain('placeholder={catalogMode && open ? "Search models…" : placeholder}');
    expect(picker).toContain("Showing {visibleOptions.length} of {filteredOptions.length} matches");
    expect(picker).toContain('event.key === "ArrowUp"');
    expect(picker).toContain('event.key === "Enter"');
    expect(picker).toContain("event.preventDefault();");
    expect(picker).toContain("refocusing the input and reopening the list");
    expect(css).toContain(".model-combobox-options");
  });

  it("quits the Electron app when the last window closes on macOS too", () => {
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");

    expect(main).toContain('app.on("window-all-closed"');
    expect(main).toContain("app.quit();");
    expect(main).not.toContain('process.platform !== "darwin"');
  });

  it("refreshes artifact lists when live run updates add new artifact references", () => {
    const store = readStoreSource();

    expect(store).toContain("runArtifactIds");
    expect(store).toContain("shouldRefreshArtifacts");
    expect(store).toContain("window.archicode.loadProject(payload.projectRoot)");
    expect(store).toContain("window.archicode.listPatchProposals(payload.projectRoot)");
  });

  it("keeps toolbar review actions contextual and horizontally scrollable", () => {
    const patchReview = readFileSync(resolve(repoRoot, "src/renderer/src/components/PatchReviewPanel.tsx"), "utf8");
    const toolbar = readProjectToolbarSource();
    const ui = readFileSync(resolve(repoRoot, "src/renderer/src/components/ui.tsx"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(patchReview).toContain('run.status === "awaiting-plan-review"');
    expect(patchReview).toContain("hasActivePlanReviewRun");
    expect(patchReview).toContain("activePlanReviewRunIds.has(item.artifact.runId)");
    expect(patchReview).toContain("if (!manualReview || !hasActivePlanReviewRun) return null;");
    expect(toolbar).toContain("toolbarActionsRef");
    expect(toolbar).toContain("scrollToolbarHorizontally");
    expect(toolbar).toContain("target.scrollLeft + event.deltaY");
    expect(toolbar).toContain("onWheel={scrollToolbarHorizontally}");
    expect(ui).toContain("forwardRef<HTMLDivElement");
    expect(ui).toContain('type = "button"');
    expect(css).toContain("flex-wrap: nowrap");
    expect(css).toContain("overflow-x: auto");
    expect(css).toContain("overscroll-behavior-inline: contain");
    expect(css).toContain("min-width: max-content");
  });

  it("notifies when manual review gates need attention", () => {
    const toolbar = readProjectToolbarSource();
    const store = readStoreSource();

    expect(toolbar).toContain("Show system notifications when reviews need attention");
    expect(store).toContain("notifyReviewRequired");
    expect(store).toContain('run.status === "awaiting-plan-review"');
    expect(store).toContain('run.status === "awaiting-code-review"');
    expect(store).toContain("Plan ready for review");
    expect(store).toContain("Source changes ready for review");
    expect(store).toContain("previous?.status !== payload.run.status");
  });

  it("keeps activity recovery affordances small and task-focused", () => {
    const trace = readFileSync(resolve(repoRoot, "src/renderer/src/components/RunTrace.tsx"), "utf8");
    const toolbar = readProjectToolbarSource();
    const consolePanel = readFileSync(resolve(repoRoot, "src/renderer/src/components/RunConsole.tsx"), "utf8");
    const settingsAndRuns = readFileSync(resolve(repoRoot, "src/renderer/src/components/SettingsAndRuns.tsx"), "utf8");
    const artifacts = readFileSync(resolve(repoRoot, "src/renderer/src/components/ArtifactBrowser.tsx"), "utf8");
    const store = readStoreSource();
    const runStages = readFileSync(resolve(repoRoot, "src/renderer/src/utils/runStages.ts"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(trace).toContain('placeholder="Search trace"');
    expect(trace).toContain("run-trace-search");
    expect(trace).toContain('"Show all"');
    expect(trace).toContain('"Clear"');
    expect(trace).toContain("archicode-trace-cleared-before");
    expect(trace).toContain("archicode-trace-column-widths");
    expect(trace).toContain("run-trace-column-resizer");
    expect(trace).toContain("runs.filter((run) => !run.queueRemovedAt)");
    expect(trace).toContain("const showStatusPill = !hasStoredClear || visibleLogs.length > 0;");
    expect(toolbar).toContain("runChangeBlocked");
    expect(toolbar).toContain("Run App");
    expect(consolePanel).toContain("Open Plan");
    expect(consolePanel).toContain("Open Prompt");
    expect(consolePanel).toContain("selected.planArtifactIds.length");
    expect(consolePanel).toContain('selectedHasGeneratedPlan ? "Open Plan" : "Open Prompt"');
    expect(consolePanel).toContain('selected.status === "awaiting-plan-review" && !selectedOpenQuestionCount');
    expect(consolePanel).toContain("run-review-document");
    expect(consolePanel).toContain("Plan awaiting approval");
    expect(consolePanel).toContain("runPlanText");
    expect(consolePanel).toContain("const selectedPromptText = selected ? runSummary(selected, runs) : null;");
    expect(consolePanel).toContain('<b className="run-label-success">Status</b>');
    expect(consolePanel).toContain("Open Source Changes");
    expect(consolePanel).not.toContain("Review Source Proposal");
    expect(css).toContain(".run-trace-column-guides");
    expect(css).toContain(".run-trace-column-resizer");
    expect(consolePanel).toContain("No source-change artifact was recorded");
    expect(settingsAndRuns).toContain("Source Changes");
    expect(settingsAndRuns).toContain('artifact.type === "diff"');
    expect(settingsAndRuns).not.toContain("isSourceProposalArtifact");
    expect(settingsAndRuns).not.toContain("No code diffs or source proposals yet.");
    expect(runStages).toContain("verificationRunning");
    expect(consolePanel).toContain("Implementation history");
    expect(consolePanel).toContain("historical batch/task snapshot");
    expect(consolePanel).toContain('batch${visibleBatch === 1 ? "" : "es"} used');
    expect(runStages).toContain('run.status === "running"');
    expect(consolePanel).toContain("runElapsedLabel");
    expect(consolePanel).toContain("run-queue-duration");
    expect(consolePanel).toContain("Add optional direction and evidence, then run.");
    expect(consolePanel).toContain("run-guidance-heading-actions");
    expect(consolePanel).toContain('"Options"');
    expect(consolePanel).toContain("scrollIntoView");
    expect(consolePanel).toContain("Run Retry");
    expect(consolePanel).toContain("Run Debug");
    expect(css).toContain(".run-guidance-heading-actions");
    expect(css).toContain(".run-stage");
    expect(runStages).toContain('label: "Plan review"');
    expect(runStages).toContain('label: "Code review"');
    expect(css).toContain("grid-template-rows: auto auto");
    expect(css).toContain("white-space: nowrap");
    expect(consolePanel).not.toContain("Retry Now");
    expect(consolePanel).not.toContain("Debug Now");
    expect(consolePanel).not.toContain("Retry with Guidance");
    expect(consolePanel).not.toContain("Debug with Guidance");
    expect(consolePanel).not.toContain('guidanceTarget === "retry" ? "Run Retry" : "Retry"');
    expect(consolePanel).not.toContain("Guide Retry");
    expect(consolePanel).not.toContain("Guide Debug");
    expect(consolePanel).not.toContain("run-context-summary");
    expect(artifacts).toContain("planArtifactBadgeLabel");
    expect(settingsAndRuns).toContain("planArtifactListLabel");
    expect(artifacts).toContain("diff-file-section");
    expect(artifacts).toContain("formatPlanArtifactText");
    expect(artifacts).toContain("Raw plan artifact");
    expect(artifacts).toContain("DiffSummaryBar");
    expect(artifacts).toContain("diffStats");
    expect(css).toContain(".diff-summary-bar");
    expect(css).toContain(".diff-stat-added");
    expect(css).toContain(".diff-stat-removed");
    expect(artifacts).toContain('"plan"');
    expect(store).toContain("Graph editing is locked while a run is active or waiting for review.");
  });

  it("lets node-level run warnings be dismissed from the inspector", () => {
    const inspector = readNodeInspectorSource();
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(inspector).toContain("Open Queue to see what happened.");
    expect(inspector).toContain("dismissReadinessError");
    expect(inspector).toContain("dismissLabel:");
    expect(inspector).toContain('"run cancellation"');
    expect(inspector).toContain('className="readiness-dismiss"');
    expect(css).toContain(".readiness-dismiss.ui-icon-button");
  });

  it("keeps Build and Run App available for AI target discovery when setup is missing", () => {
    const toolbar = readProjectToolbarSource();
    const store = readStoreSource();

    expect(toolbar).toContain("Ask AI to detect the build or verification target");
    expect(toolbar).toContain("then actually build or run that finite verification command");
    expect(toolbar).toContain('purpose: "build-discovery"');
    expect(toolbar).toContain("Ask AI to detect or create a Run App target");
    expect(toolbar).toContain('purpose: "run-discovery"');
    expect(toolbar).toContain("Detect the app runtime target and create or update an ArchiCode Run App profile");
    expect(toolbar).toContain("Project build command");
    expect(toolbar).toContain("Editable JSON run target profiles");
    expect(toolbar).toContain("Trusted command allowlist");
    expect(toolbar).not.toContain("Project run command");
    expect(toolbar).not.toContain('updateDraft({ defaultRunCommand: event.target.value })');
    expect(toolbar).not.toContain("disabled={!bundle || runChangeBlocked || !buildCommand}");
    expect(toolbar).not.toContain("disabled={!bundle || runChangeBlocked || !runCommand}");
    expect(store).toContain('(input.purpose ?? "implement") !== "run-discovery"');
    expect(store).not.toContain('prompt.includes("code")');
    expect(store).not.toContain('prompt.includes("build")');
  });

  it("does not brand verified no-change Build runs as failures", () => {
    const consolePanel = readFileSync(resolve(repoRoot, "src/renderer/src/components/RunConsole.tsx"), "utf8");
    const runStages = readFileSync(resolve(repoRoot, "src/renderer/src/utils/runStages.ts"), "utf8");

    expect(consolePanel).toContain("function hasBenignNoSourceChanges");
    expect(consolePanel).toContain("function hasProblemNoSourceChanges");
    expect(runStages).toContain('codingNoopBenign ? "success"');
    expect(consolePanel).toContain("hasProblemNoSourceChanges(run)) return \"No code changes\"");
    expect(consolePanel).toContain("hasProblemNoSourceChanges(run)) return \"danger\"");
    expect(runStages).not.toContain('hasNoSourceChanges(run)) return "danger"');
  });

  it("keeps planning questions directly answerable and navigable", () => {
    const activity = readFileSync(resolve(repoRoot, "src/renderer/src/components/SettingsAndRuns.tsx"), "utf8");
    const consolePanel = readFileSync(resolve(repoRoot, "src/renderer/src/components/RunConsole.tsx"), "utf8");
    const inspector = readNodeInspectorSource();
    const store = readStoreSource();
    const storage = readFileSync(resolve(repoRoot, "src/main/storage/runEngine.ts"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(activity).toContain("openQuestionTarget");
    expect(activity).toContain("answerQuestion");
    expect(activity).toContain("letAiDecideQuestion");
    expect(activity).toContain("Let AI decide");
    expect(activity).toContain("replyToNoteId: question.id");
    expect(activity).toContain("archicode:focus-note");
    expect(activity).toContain("<Badge tone=\"warning\">{openQuestions.length}</Badge>");
    expect(activity).toContain('placeholder="Answer this question"');
    expect(consolePanel).toContain("openQuestionsForRun");
    expect(consolePanel).toContain("Open Questions");
    expect(consolePanel).toContain("approvalLabel(selected)");
    expect(consolePanel).not.toContain('selected.status === "awaiting-plan-review" ? "Resume"');
    expect(store).toContain("runHasQuestionRefreshSignal");
    expect(store).toContain("shouldRefreshQuestionsForRun");
    expect(store).toContain("shouldRefreshProject");
    expect(inspector).toContain("answerQuestionNote");
    expect(inspector).toContain("letAiDecideQuestionNote");
    expect(inspector).toContain("isResolvableNote");
    expect(inspector).toContain('note.kind !== "system-note"');
    expect(inspector).toContain("buildQuestionAnswerThreads");
    expect(inspector).toContain("note-thread-answers");
    expect(inspector).toContain("replyToNoteId: question.id");
    expect(inspector).not.toContain("<StatusPill tone=\"success\">resolved</StatusPill>");
    expect(inspector).not.toContain("updateNoteResolved(answer.id");
    expect(inspector).toContain("Dismiss");
    expect(inspector).toContain("data-note-id");
    expect(inspector).toContain('placeholder="Answer this question"');
    expect(css).toContain(".question-record-list");
    expect(css).toContain(".note-thread-answers");
    expect(css).toContain(".note-thread-answer");
    expect(css).toContain("overflow: auto");
    expect(storage).toContain("Approval blocked until");
    expect(storage).not.toContain("startDebuggingRun(projectRoot, latest.id)");
  });

  it("preserves base input classes when components receive custom class names", () => {
    const ui = readFileSync(resolve(repoRoot, "src/renderer/src/components/ui.tsx"), "utf8");

    expect(ui).toContain("TextInput({ className, ...props }");
    expect(ui).toContain('className={cx("ui-input", className)}');
    expect(ui).toContain('className={cx("ui-textarea", className)}');
  });

  it("keeps new research chat drafts from auto-selecting old chats on scope changes", () => {
    const panel = readResearchPanelSource();

    expect(panel).toContain("composingNewChat");
    expect(panel).toContain("setComposingNewChat(true)");
    expect(panel).toContain("selectResearchChat(null)");
    expect(panel).toContain("requestResearchComposerFocus()");
    expect(panel).toContain("if (composingNewChat)");
    expect(panel).not.toContain("void createResearchChat(scope)");
  });

  it("shows the active provider catalog for existing chats without replacing their saved model", () => {
    const panel = readResearchPanelSource();
    const store = readStoreSource();

    expect(panel).toContain("const chatProvider = provider;");
    expect(panel).toContain("persistedResearchModelId(selected, chatProvider)");
    expect(panel).not.toContain("const chatProvider = selected?.providerId ? selectedSessionProvider : provider;");
    expect(panel).toContain("if (selected?.messages.length)");
    expect(panel).toContain("may not be fully compatible with this existing chat");
    expect(store).toContain("providerId: bundle.project.settings.providers.find((provider) => provider.enabled)?.id");
    expect(store).not.toContain("providerId: session.providerId ?? bundle.project.settings.providers.find((provider) => provider.enabled)?.id");
  });

  it("defaults generic research chat scope to project unless a node is selected", () => {
    const panel = readResearchPanelSource();
    const store = readStoreSource();

    expect(store).toContain("void activeSubflowId;");
    expect(store).toContain("return { type: \"node\", flowId: flow.id, nodeId: selectedNodeId };");
    expect(store).toContain("return { type: \"project\", projectId: bundle.project.id };");
    expect(store).toContain("get().createResearchChat(get().researchScope ?? undefined)");
    expect(store).not.toContain("return { type: \"subflow\", flowId: flow.id, subflowId: activeSubflowId };");
    expect(store).not.toContain("if (flow) return { type: \"flow\", flowId: flow.id };");
    expect(panel).toContain("if (defaultScope) setResearchScope(defaultScope);");
  });

  it("uses latest sent context, not session token spend, for the chat context radial", () => {
    const panel = readResearchPanelSource();

    expect(panel).toContain("Latest sent context");
    expect(panel).toContain("Latest context lifecycle");
    expect(panel).toContain("Lifecycle notes");
    expect(panel).toContain("Session LLM cost");
    expect(panel).toContain("localProviderUsageUnavailableDetail(selectedSessionProvider)");
    expect(panel).toContain("Recent messages included before send");
    expect(panel).toContain("showSecondaryContextLine={false}");
    expect(panel).not.toContain("Cumulative sent context estimate");
    expect(panel).not.toContain("Pre-send estimate for draft");
    expect(panel).not.toContain("Graph, files, web, images, and tool context are added dynamically at send time");
    expect(panel).not.toContain("label=\"Draft prompt context\"");
    expect(panel).not.toContain("Chat LLM tokens used");
  });

  it("shows direct chat subagent activity before the research turn finishes", () => {
    const store = readStoreSource();
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const panel = readResearchPanelSource();
    const styles = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");
    const picasso = readFileSync(resolve(repoRoot, "src/main/microRunAgents/picassoGraph.ts"), "utf8");

    expect(store).toContain("disposeSubagentProgressStream = window.archicode.onResearchSubagentProgress");
    expect(store).toContain("disposeActivityStream = window.archicode.onResearchChatActivity");
    expect(store).toContain("[optimisticAssistantId]: nextRuns");
    expect(store).toContain("Archi is continuing with the collected evidence");
    expect(main).toContain("onSubagentProgress: ({ runId, kind, title, message, status })");
    expect(main).toContain("onActivity: (message, status) => publishResearchChatActivity");
    expect(panel).toContain("Archi — Parent investigation");
    expect(panel).toContain("streamingStructuredActivityLabel");
    expect(panel).toContain("researchHasNewActivity");
    expect(panel).toContain("New activity");
    expect(panel).toContain("successfulSubagentBatchCount");
    expect(panel).toContain("research-subagent-batch-count");
    expect(panel).toContain("B{successfulBatchCount}");
    expect(panel).toContain("copiedSubagentRunId");
    expect(panel).toContain("Copy full subagent log");
    expect(panel).toContain('progressLines.join("\\n")');
    expect(panel).toContain("research-subagent-copy-button");
    expect(panel).toContain('Create node "${operation.node.title}" in subflow');
    expect(panel).toContain('Create node "${operation.node.title}" on root flow');
    expect(panel).toContain("flowTitleMap");
    expect(panel).toContain('operation.kind === "update-flow" && operation.patch.name?.trim()');
    expect(panel).toContain('Update flow "${flowTitleLabel(operation.flowId, flowTitles)}"');
    expect(panel).toContain("subflowTitleMap");
    expect(picasso).toContain("every child create-node operation must keep flowId set to the containing top-level flow id");
    expect(picasso).toContain("Never put a subflow id in operation.flowId");
    expect(picasso).toContain("nodes without node.subflowId are created on the root canvas");
    expect(styles).toContain(".research-message-has-subagents > .research-subagent-runs");
    expect(styles).toContain(".research-message-has-subagents > .research-parent-activity");
    expect(styles).toContain(".research-message-has-subagents > .research-markdown");
    expect(styles).toContain(".research-subagent-batch-count");
    expect(styles).toContain(".research-subagent-copy-button.ui-icon-button");
  });

  it("uses latest run context, not run token spend, for the run context radial", () => {
    const runConsole = readFileSync(resolve(repoRoot, "src/renderer/src/components/RunConsole.tsx"), "utf8");

    expect(runConsole).toContain("Latest run context");
    expect(runConsole).toContain("Run LLM cost");
    expect(runConsole).toContain("localProviderUsageUnavailableDetail(provider)");
    expect(runConsole).toContain("Run LLM usage");
    expect(runConsole).not.toContain("Run LLM tokens used");
  });

  it("guards empty activity artifact previews before reading preview text", () => {
    const settingsAndRuns = readFileSync(resolve(repoRoot, "src/renderer/src/components/SettingsAndRuns.tsx"), "utf8");

    expect(settingsAndRuns).toContain("preview && preview.artifactId === selected?.id ? preview.text : null");
    expect(settingsAndRuns).not.toContain("preview?.artifactId === selected?.id ? preview.text : null");
  });

  it("translates mouse-wheel input into horizontal activity-tab scrolling", () => {
    const settingsAndRuns = readFileSync(resolve(repoRoot, "src/renderer/src/components/SettingsAndRuns.tsx"), "utf8");

    expect(settingsAndRuns).toContain("onWheel={scrollActivityTabs}");
    expect(settingsAndRuns).toContain("tabList.scrollLeft + delta");
    expect(settingsAndRuns).toContain("event.preventDefault()");
  });

  it("shows background code-data work beside the Activity detach control", () => {
    const activity = readFileSync(resolve(repoRoot, "src/renderer/src/components/SettingsAndRuns.tsx"), "utf8");
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");

    expect(activity).toContain("activity-maintenance-indicator");
    expect(activity).toContain("retryProjectMaintenance");
    expect(activity).toContain("graphAnalysisMayBeOutdated");
    expect(activity).toContain("Code change detected since ArchiCode last analyzed the architecture graph.");
    expect(activity).toContain("Graph nodes cannot be changed automatically; they require review.");
    expect(activity).toContain("maintenancePopoverOpen ? false : maintenanceTooltipOpen");
    expect(activity).toContain("if (nextOpen) setMaintenanceTooltipOpen(false)");
    expect(activity).toContain("Click to review the changed files, open them, resync the codebase, or ignore this warning.");
    expect(activity).toContain("The Code Knowledge Map and enabled semantic index are current. The architecture graph was left unchanged.");
    expect(activity).toContain("maintenance.changedFiles.map");
    expect(activity).toContain("activity-maintenance-file-list");
    expect(activity).toContain("onCloseAutoFocus={(event) => event.preventDefault()}");
    expect(activity).toContain("selectProjectFile(changedFile.path");
    expect(activity).toContain('preferredTab: changedFile.change === "deleted" ? "diff" : "preview"');
    expect(activity).toContain("dismissProjectMaintenanceWarning");
    expect(activity).toContain("Resync codebase");
    expect(activity).toContain("Ignore");
    expect(activity.indexOf("activity-maintenance-indicator")).toBeLessThan(activity.indexOf("{panelAction}"));
    expect(preload).toContain("onProjectMaintenanceUpdated");
    expect(preload).toContain("dismissProjectMaintenanceWarning");
    expect(main).toContain("watchFs(key, { recursive: true }");
    expect(main).toContain("projectMaintenanceChangesBetweenHashes");
    expect(main).toContain("queueProjectSourceDriftVerification(key, deferredPaths)");
    expect(main).toContain('scheduleProjectMaintenance(key, "ai-run", 500)');
    expect(main).toContain("refreshCodeKnowledgeOnly: true");
    const toolbar = readProjectToolbarSource();
    expect(toolbar).toContain("archicode:open-codebase-resync");
  });

  it("requires advisory node attribution on every coding source handoff", () => {
    const providers = readFileSync(resolve(repoRoot, "src/main/providers.ts"), "utf8");
    const contextBuilder = readFileSync(resolve(repoRoot, "src/main/storage/contextBuilder.ts"), "utf8");
    const runEngine = readFileSync(resolve(repoRoot, "src/main/storage/runEngine.ts"), "utf8");

    expect(providers).toContain("Every source operation must include nodeIds");
    expect(contextBuilder).toContain("sourceAttribution");
    expect(contextBuilder).toContain("Existing implementationScope and semanticRetrieval.codeMatches are bounded discovery hints");
    expect(runEngine).toContain('required: ["path", "action", "nodeIds"]');
    expect(runEngine).toContain("Source attribution is required");
    expect(runEngine).toContain("sourceAttributionRetryGuidance");
  });

  it("does not race node-type preset selection against an unchanged blur save", () => {
    const inspector = readFileSync(resolve(repoRoot, "src/renderer/src/components/NodeInspector.tsx"), "utf8");

    expect(inspector).toContain("if (trimmed === node.type) return;");
    expect(inspector).toContain("typeDraftLastSyncedRef.current = trimmed;");
    expect(inspector).toContain("setTypeDraft(trimmed);");
  });

  it("reveals and scrolls to the active file-preview path in the file tree", () => {
    const browser = readFileSync(resolve(repoRoot, "src/renderer/src/components/ProjectFileBrowser.tsx"), "utf8");
    const filesSlice = readFileSync(resolve(repoRoot, "src/renderer/src/store/gitFilesSlice.ts"), "utf8");

    expect(browser).toContain("if (containsSelectedPath) setOpen(true)");
    expect(browser).toContain('aria-current={active ? "true" : undefined}');
    expect(browser).toContain('scrollIntoView({ behavior: "smooth", block: "nearest" })');
    expect(browser).toContain('setFileTreeSearchQuery("")');
    expect(browser).toContain('setPreviewTab(filePreviewRequest.preferredTab ?? "preview")');
    expect(filesSlice).toContain('fileDiff.diff || options?.preferredTab === "diff" ? {');
    expect(filesSlice).toContain("preferredTab: options?.preferredTab");
  });

  it("restores panels when an expanded file preview is closed", () => {
    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");

    expect(app).toContain("workbenchView: \"graph\" | \"files\"");
    expect(app).toContain("focusModeSnapshotRef.current?.workbenchView !== \"files\"");
    expect(app).toContain("void toggleFocusMode()");
  });

  it("distinguishes panel detach controls from fullscreen controls", () => {
    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");

    expect(app).toContain("<PictureInPicture2 size={14} />");
    expect(app).not.toContain("<Maximize2 size={14} />");
  });

  it("offers a dedicated full-window focus mode from chat", () => {
    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");
    const panel = readFileSync(resolve(repoRoot, "src/renderer/src/components/ResearchPanel.tsx"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(app).toContain('className={chatFocusActive ? "app-shell chat-focus-mode" : "app-shell"}');
    expect(app).toContain("chatFocusMode={chatFocusActive}");
    expect(panel).toContain('title={focusMode ? "Exit chat focus mode" : "Enter chat focus mode"}');
    expect(panel).toContain("focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />");
    expect(panel).toContain('className="research-focus-history"');
    expect(panel).toContain("focusMode ? (focusHistoryOpen ? <PanelLeftClose");
    expect(css).toContain(".research-panel.is-focus-mode");
    expect(css).toContain("grid-template-columns: clamp(208px, 16.5vw, 246px) minmax(0, 1fr)");
    expect(css).toContain(".research-panel.is-focus-mode .chat-composer-input");
    expect(css).toContain("min-height: 46px");
  });

  it("shows the active project name in the native app title", () => {
    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");

    expect(app).toContain('document.title = projectName ? `${projectName} — ArchiCode` : "ArchiCode";');
    expect(app).toContain("[bundle?.project.name]");
  });

  it("keeps multi-node selection in canvas AI context actions", () => {
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");

    expect(canvas).toContain("selectedNodeIdSet.has(nodeId) && selectedNodeIdSet.size > 1");
    expect(canvas).toContain("selectNodes(nodes.map((node) => node.id), nodeId)");
    expect(canvas).toContain("for (const node of nodes) appendResearchDraftMention");
    expect(canvas).toContain("multiNodeSpecReviewPrompt(nodes, flow!)");
    expect(canvas).toContain("multiNodeBugIssuePrompt");
    expect(canvas).toContain("multiNodeRefinePrompt(nodes, flow!)");
    expect(canvas).toContain("multiNodeBreakdownPrompt(nodes, flow!)");
    expect(canvas).toContain("Refine Selected Nodes");
    expect(canvas).toContain("Break Down Selected Nodes");
    expect(canvas).toContain("Keep this as one node. Do not split it");
    expect(canvas).toContain("Then break its responsibilities into a linked detail flow");
    expect(canvas).toContain("Do not split, combine, replace, create, delete, or rewire nodes");
    expect(canvas).not.toContain("Refine / Breakdown");
  });

  it("sends id-backed tagged nodes with every canvas AI action", () => {
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");

    expect(canvas).toContain("function taggedNodeContext");
    expect(canvas).toContain("archicode://node/${encodeURIComponent(flowId)}/${encodeURIComponent(node.id)}");
    expect(canvas).toContain("messageForNodes(nodes)}\\n\\n${taggedNodeContext(nodes, flow.id)}");
    expect(canvas).toContain("combineNodesPrompt(nodes, flow)}\\n\\n${taggedNodeContext(nodes, flow.id)}");
    expect(canvas).toContain("const refs = nodes.map((node) => ({ flowId: flow.id, nodeId: node.id }))");
  });

  it("offers the shared focus-mode toggle in the 3D canvas", () => {
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const canvas3d = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas3DView.tsx"), "utf8");

    expect(canvas).toContain("onToggleFocusMode={toggleFocusMode}");
    expect(canvas3d).toContain('className="flow-3d-corner-controls"');
    expect(canvas3d).toContain('aria-label="Toggle full screen mode"');
  });

  it("prompts users to zoom in while nodes are rendered as overview capsules", () => {
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const nodeCard = readFileSync(resolve(repoRoot, "src/renderer/src/components/ArchicodeNodeCard.tsx"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(nodeCard).toContain("export const nodeDetailZoomThreshold = 0.42");
    expect(nodeCard).toContain('zoom < nodeDetailZoomThreshold ? "overview" : "full"');
    expect(canvas).toContain("currentCanvasZoom < nodeDetailZoomThreshold && visibleNodes.length > 0");
    expect(canvas).toContain("Zoom in to see node details");
    expect(css).toContain(".canvas-node-detail-hint");
    expect(css).toContain("pointer-events: none");
    expect(css).not.toContain("animation: canvas-node-detail-hint-in");
  });

  it("requires custom confirmation before cleaning a graph layout", () => {
    const toolbar = readFileSync(resolve(repoRoot, "src/renderer/src/components/ProjectToolbar.tsx"), "utf8");

    expect(toolbar).toContain("onSelect={() => setCleanLayoutConfirmOpen(true)}");
    expect(toolbar).toContain('title="Clean this layout?"');
    expect(toolbar).toContain("Existing node positions will be overwritten, and there is no undo.");
    expect(toolbar).toContain("setCleanLayoutConfirmOpen(false);\n                void autoLayout();");
  });

  it("explains that all existing agent instruction files are loaded", () => {
    const toolbar = readFileSync(resolve(repoRoot, "src/renderer/src/components/ProjectToolbar.tsx"), "utf8");

    expect(toolbar).toContain("loads every existing instruction file into both Chat and Build context");
    expect(toolbar).toContain("regardless of the selected LLM provider");
    expect(toolbar).toContain("avoid repeating or contradicting rules across files");
    expect(toolbar).not.toContain("they do not describe development of ArchiCode itself");
    expect(toolbar).toContain("does not control which files agents receive");
  });

  it("uses one project-wide research auto-approve toggle in the chat panel", () => {
    const panel = readResearchPanelSource();
    const schema = readFileSync(resolve(repoRoot, "src/shared/schema.ts"), "utf8");

    expect(panel).toContain("bundle?.project.settings.researchAutoApproveGraphChanges");
    expect(panel).not.toContain("checked={selected.autoApproveGraphChanges.enabled}");
    expect(schema).toContain("researchAutoApproveGraphChanges: researchAutoApproveGraphChangesSchema");
  });

  it("renders research graph links as in-app navigation targets", () => {
    const panel = readResearchPanelSource();
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const store = readStoreSource();
    const providers = readFileSync(resolve(repoRoot, "src/main/providers.ts"), "utf8");
    const research = readFileSync(resolve(repoRoot, "src/main/research.ts"), "utf8")
      + readFileSync(resolve(repoRoot, "src/main/research/contextAssembly.ts"), "utf8")
      + readFileSync(resolve(repoRoot, "src/main/research/inspectionTools.ts"), "utf8");

    expect(panel).toContain("parseArchicodeGraphHref");
    expect(panel).toContain("archicode:\\/\\/");
    expect(panel).toContain("onGraphLink");
    expect(panel).toContain("navigateGraphLink");
    expect(panel).toContain("navigateToGraphTarget(target)");
    expect(panel).not.toContain("setResearchScope({ type: \"node\"");
    expect(panel).not.toContain("selectNode(target.nodeId)");
    expect(canvas).toContain("graphNavigationRequest");
    expect(canvas).toContain("instance.fitView");
    expect(canvas).toContain("nodes: [{ id: request.nodeId }]");
    expect(store).toContain("navigateToGraphTarget");
    expect(store).toContain("graphNavigationRequest");
    expect(providers).toContain("When pointing the user to graph locations");
    expect(research).toContain("graphNodeLink");
    expect(research).toContain("graphLink");
  });

  it("lets explicitly requested research actions select targets and control the 2D canvas", () => {
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const store = readStoreSource();
    const researchSlice = readFileSync(resolve(repoRoot, "src/renderer/src/store/researchSlice.ts"), "utf8");
    const providers = readFileSync(resolve(repoRoot, "src/main/providers.ts"), "utf8");
    const inspectionTools = readFileSync(resolve(repoRoot, "src/main/research/inspectionTools.ts"), "utf8");

    expect(inspectionTools).toContain("archicode_control_canvas");
    expect(providers).toContain("explicitly asks you to select/focus nodes or groups");
    expect(store).toContain("applyResearchCanvasAction");
    expect(store).toContain("groupNodes");
    expect(store).toContain('kind: "canvas" as const');
    expect(researchSlice).toContain("newResearchCanvasAction");
    expect(researchSlice).toContain("get().applyResearchCanvasAction(canvasAction)");
    expect(canvas).toContain('request.kind === "canvas"');
    expect(canvas).toContain("instance.fitView");
    expect(canvas).toContain("instance.setCenter");
    expect(canvas).toContain("instance.zoomTo");
  });

  it("renders project-local research links through a guarded app opener", () => {
    const panel = readResearchPanelSource();
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const providers = readFileSync(resolve(repoRoot, "src/main/providers.ts"), "utf8");
    const research = readFileSync(resolve(repoRoot, "src/main/research.ts"), "utf8")
      + readFileSync(resolve(repoRoot, "src/main/research/contextAssembly.ts"), "utf8")
      + readFileSync(resolve(repoRoot, "src/main/research/inspectionTools.ts"), "utf8");

    expect(panel).toContain("parseArchicodeProjectPathHref");
    expect(panel).toContain("archicode:\" || url.hostname !== \"project-file");
    expect(panel).toContain("window.archicode.openProjectPath(rootPath, target.relativePath)");
    expect(preload).toContain("archicode:open-project-path");
    expect(main).toContain("resolveProjectLocalPath");
    expect(main).toContain("shell.showItemInFolder");
    expect(main).toContain("Path is outside the project folder.");
    expect(providers).toContain("archicode://project-file/src/main/index.ts");
    expect(research).toContain("projectFileLinks");
    expect(research).toContain("archicode://project-file/{projectRelativePath}");
  });

  it("enables keyboard-modified marquee selection on the canvas", () => {
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(canvas).toContain("type DragSelection");
    expect(canvas).toContain("const [dragSelection, setDragSelection]");
    expect(canvas).toContain("selectionKeyCode={null}");
    expect(canvas).toContain('keybindings["canvas.addNode"]');
    expect(canvas).toContain('keybindings["canvas.toggleMinimap"]');
    expect(canvas).toContain("matchesChord");
    expect(canvas).toContain("lastCanvasPointerRef");
    expect(canvas).toContain("openPaneMenuAtPointer");
    expect(canvas).toContain("document.elementFromPoint(pointer.x, pointer.y)");
    expect(canvas).toContain("if (!event.repeat) openPaneMenuAtPointer();");
    expect(canvas).toContain("toggleMinimap();");
    expect(canvas).toContain("onPointerDownCapture");
    expect(canvas).toContain("isEmptyPanePointerTarget(event.target)");
    expect(canvas).toContain("setDragSelection({");
    expect(canvas).toContain("canvas-drag-selection");
    expect(canvas).toContain("nodeMaxX >= minX");
    expect(canvas).toContain("onPointerMoveCapture");
    expect(canvas).toContain('kind: "pane"');
    expect(canvas).toContain("instance.screenToFlowPosition({ x: clientX, y: clientY })");
    expect(canvas).toContain("if (event.ctrlKey || event.metaKey) return;");
    expect(canvas).toContain("panActivationKeyCode={null}");
    expect(canvas).toContain("deleteKeyCode={null}");
    expect(canvas).toContain("openDeleteConfirm");
    expect(canvas).toContain("DialogRoot open={deleteConfirmOpen}");
    expect(canvas).toContain("minZoom={0.035}");
    expect(canvas).toContain('const multiSelectionKeyCode = ["Shift", "Meta", "Control"]');
    expect(canvas).toContain("multiSelectionKeyCode={multiSelectionKeyCode}");
    expect(canvas).toContain("onSelectionChange={handleSelectionChange}");
    expect(canvas).toContain("const minimapContextScale = 4");
    expect(canvas).toContain("offsetScale={minimapOffsetScale}");
    expect(canvas).toContain("style={minimapSize}");
    expect(canvas).toContain("maskStrokeWidth={2}");
    expect(css).toContain(".canvas-drag-selection");
  });

  it("lets group labels select all nodes in the group with larger label typography", () => {
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(canvas).toContain("nodeIds: groupedNodes.map((node) => node.id)");
    expect(canvas).toContain("const selectGroupNodes = useCallback");
    expect(canvas).toContain("selectNodes(groupBox.nodeIds");
    expect(canvas).toContain("handleGroupLabelPointerDown");
    expect(canvas).toContain("handleGroupLabelPointerMove");
    expect(canvas).toContain("handleGroupLabelPointerUp");
    expect(canvas).toContain("groupDragRef");
    expect(canvas).toContain("draggingGroupId");
    expect(canvas).toContain('className="flow-group-label"');
    expect(canvas).toContain('className="flow-group-label-name"');
    expect(css).toContain("pointer-events: auto;");
    expect(css).toContain("font-size: 22px;");
    expect(css).toContain(".flow-group-label-name");
    expect(css).toContain("user-select: none;");
    expect(css).toContain("touch-action: none;");
  });

  it("adds a read-only WebGL 3D flow mode under the minimap toggle", () => {
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const threeDView = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas3DView.tsx"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(canvas).toContain("FlowCanvas3DView");
    expect(canvas).toContain("const [canvas3dVisible, setCanvas3dVisible]");
    expect(canvas).toContain("const toggleCanvas3d = useCallback");
    expect(canvas).toContain("if (canvas3dVisible) return;");
    expect(canvas).toContain('className={`canvas-3d-toggle${canvas3dVisible ? " is-active" : ""}`}');
    expect(canvas).toContain('title={canvas3dVisible ? "Show editable 2D canvas" : "Show read-only 3D flow"}');
    expect(canvas).toContain("const canvas3dFocusedNodeId = selectedNodeIds.length > 1 ? null : selectedNodeIds[0] ?? selectedNodeId ?? null");
    expect(canvas).toContain("const selectNodeIn3d = useCallback");
    expect(canvas).toContain("setActiveSubflow(targetSubflowId)");
    expect(canvas).toContain("activeSubflowId={activeSubflowId}");
    expect(canvas).toContain("onSelectNode={selectNodeIn3d}");
    expect(canvas).toContain("onSelectScope={selectScopeIn3d}");
    expect(threeDView).toContain('canvas.getContext("webgl"');
    expect(threeDView).toContain("visibleNodesForFlow(flow, layerId, searchQuery)");
    expect(threeDView).toContain("visibleEdgesForNodes(flow, visibleNodeIds)");
    expect(threeDView).toContain("function colorFromHex");
    expect(threeDView).toContain("luma + (channel - luma) * 1.65");
    expect(threeDView).toContain("node.visual.backgroundColor ? colorFromHex(node.visual.backgroundColor, 0.96) : null");
    expect(threeDView).toContain("const floorPadding = 120");
    expect(threeDView).toContain("const layerFloorBounds = Array.from");
    expect(threeDView).toContain("const layerNodes = nodes.filter((node) => node.layer === layer)");
    expect(threeDView).toContain("node.x - node.width / 2");
    expect(threeDView).toContain("const layerFill: [number, number, number, number] = [0, 0.38, 0.24, 0.05]");
    expect(threeDView).toContain("const layer = maxLayer - logicalLayer");
    expect(threeDView).toContain("floorVertices: new Float32Array(floorPanels)");
    expect(threeDView).toContain("gl.depthMask(false)");
    expect(threeDView).toContain("bindGeometry(gl, floorBuffer, scene.floorVertices");
    expect(threeDView).toContain("gl.depthMask(true)");
    expect(threeDView).toContain("gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)");
    expect(threeDView).toContain("function projectScenePoint");
    expect(threeDView).toContain("focusedNodeId?: string | null");
    expect(threeDView).toContain("activeSubflowId?: string | null");
    expect(threeDView).toContain('type ViewMode = "active" | "overview"');
    expect(threeDView).toContain('useState<ViewMode>("active")');
    expect(threeDView).toContain("onSelectNode?: (nodeId: string | null) => void");
    expect(threeDView).toContain("function rayFromScreenPoint");
    expect(threeDView).toContain("function intersectRayAabb");
    expect(threeDView).toContain("function pickNodeFromPointer");
    expect(threeDView).toContain("const pickedNodeId = pickNodeFromPointer");
    expect(threeDView).toContain("onSelectNode?.(pickedNodeId)");
    expect(threeDView).toContain("Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)");
    expect(threeDView).toContain("type CameraTween");
    expect(threeDView).toContain("const cameraTweenRef = useRef<CameraTween | null>(null)");
    expect(threeDView).toContain("const node = scene.nodes.find((item) => item.id === focusedNodeId)");
    expect(threeDView).toContain("const target: [number, number, number] = [node.x, node.y + node.height * 0.82, node.z]");
    expect(threeDView).toContain("y: target[1] + Math.max(58, node.height * 1.75)");
    expect(threeDView).toContain("cameraAnglesForTarget(position, target)");
    expect(threeDView).toContain("function easeInOutCubic");
    expect(threeDView).toContain("function lerpAngle");
    expect(threeDView).toContain("stepCameraTween(now)");
    expect(threeDView).toContain("if (cameraTweenRef.current) return;");
    expect(threeDView).toContain("cameraTweenRef.current = null;");
    expect(threeDView).toContain("const labelRefs = useRef(new Map<string, HTMLSpanElement>())");
    expect(threeDView).toContain("projectScenePoint(viewProjection, [node.x, node.y + node.height * 0.58, node.z])");
    expect(threeDView).toContain("showLabel");
    expect(threeDView).toContain("addQuietEdge");
    expect(threeDView).toContain("nodeMatchesActiveLayer");
    expect(threeDView).toContain("flow-3d-toolbar");
    expect(threeDView).toContain("flow-3d-mode-btn");
    expect(threeDView).toContain("{node.title}");
    expect(threeDView).toContain("const detailLogicalLayerByNodeId = new Map");
    expect(threeDView).toContain("subflow.parentNodeId");
    expect(threeDView).toContain("type SceneScope");
    expect(threeDView).toContain("const scopeLabelRefs = useRef(new Map<string, HTMLButtonElement>())");
    expect(threeDView).toContain("for (const scope of scene.scopes)");
    expect(threeDView).toContain("if (!scope.parentId) continue");
    expect(threeDView).toContain("addThickEdgeBeam(panels, lines, parent.labelPoint, scope.labelPoint");
    expect(threeDView).toContain('className={`flow-3d-scope-label');
    expect(threeDView).toContain("focusScope(scope)");
    expect(threeDView).toContain("cameraLookingAt(scope.focusPoint, scope.focusRadius, false)");
    expect(threeDView).toContain("onSelectScope?.(scope.scopeId)");
    expect(threeDView).toContain('scope.isRoot ? "FLOW" : `L${scope.depth}`');
    expect(threeDView).toContain('"--flow-scope-hue": scope.hue');
    expect(threeDView).toContain("const activeHierarchyGlow:");
    expect(threeDView).toContain("const activeHierarchyCore:");
    expect(threeDView).toContain("const touchesActiveScope = scope.isActive || parent.isActive");
    expect(threeDView).toContain("if (!touchesActiveScope) continue");
    expect(threeDView).toContain("scope.isRoot ? 0.8 : 0.7");
    expect(threeDView).toContain("function sideCenterPointForNode");
    expect(threeDView).toContain("node.y + node.height / 2");
    expect(threeDView).toContain("function addThickEdgeBeam");
    expect(threeDView).toContain("const axisA = normalize(cross(direction, reference))");
    expect(threeDView).toContain("addQuad(panels, bottom, fill)");
    expect(threeDView).toContain("[[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]]");
    expect(threeDView).toContain('["w", "a", "s", "d", "shift", "space", "control", "meta"]');
    expect(threeDView).toContain("camera.y += forward[1] * speed");
    expect(threeDView).toContain('event.code === "Space"');
    expect(threeDView).toContain('keysRef.current.has("control") || keysRef.current.has("meta")');
    expect(threeDView).toContain("normalize(cross(forward, [0, 1, 0]))");
    expect(threeDView).toContain("onPointerMove");
    expect(threeDView).toContain("onWheel");
    expect(css).toContain(".canvas-3d-toggle");
    expect(css).toContain("top: 52px;");
    expect(css).toContain(".flow-3d-view");
    expect(css).toContain(".flow-3d-webgl");
    expect(css).toContain(".flow-3d-toolbar");
    expect(css).toContain(".flow-3d-mode-btn");
    expect(css).toContain(".flow-3d-label-layer");
    expect(css).toContain(".flow-3d-node-label");
    expect(css).toContain(".flow-3d-scope-label");
    expect(css).toContain(".flow-3d-scope-label.is-root");
    expect(css).toContain(".flow-3d-scope-label.is-active");
    expect(css).toContain("pointer-events: auto;");
    expect(css).toContain(".flow-3d-scope-label:not(.is-active):focus-visible");
    expect(css).toContain("hsl(var(--flow-scope-hue)");
    expect(css).toContain("text-overflow: ellipsis;");
    expect(css).toContain("white-space: nowrap;");
    expect(css).toContain(".flow-3d-node-label.is-focused");
    expect(css).toContain("border-color: rgb(255 243 128 / 92%);");
    expect(css).toContain("pointer-events: none;");
  });

  it("separates the selected architecture lens from the project-wide code knowledge map", () => {
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const map = readFileSync(resolve(repoRoot, "src/renderer/src/components/CodeKnowledgeMapView.tsx"), "utf8");
    const detailMap = readFileSync(resolve(repoRoot, "src/renderer/src/components/CodeDetailKnowledgeMapView.tsx"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(canvas).toContain("CodeKnowledgeMapView");
    expect(canvas).toContain("const [knowledgeMapVisible, setKnowledgeMapVisible]");
    expect(canvas).toContain("canvas-knowledge-toggle");
    expect(canvas).toContain("Show architecture lens map");
    expect(map).toContain("Architecture Lens Map");
    expect(map).toContain("Communities");
    expect(map).toContain("Relationship evidence");
    expect(map).toContain("Refresh evidence");
    expect(map).toContain("edge.evidence?.origin");
    expect(map).toContain("selectedEdge.evidence?.verification");
    expect(map).toContain("onOpenSource(location.path, location.line)");
    expect(canvas).toContain("refreshGraphEvidence");
    expect(canvas).toContain("getCodeKnowledgeSnapshot");
    expect(map).toContain("Open project-wide code knowledge map");
    expect(map).toContain("Search concepts, communities, relationships, or source paths");
    expect(map).toContain("How to read this lens");
    expect(map).toContain("Search communities");
    expect(map).toContain("Hide all");
    expect(map).toContain("showAllCommunities");
    expect(map).toContain("setFocusedCommunityId(null)");
    expect(map).toContain("Focus community");
    expect(map).toContain('visible ? "Hide" : "Show"');
    expect(map).toContain("is-focus-dimmed");
    expect(map).toContain("Resize knowledge map sidebar");
    expect(map).toContain("zoomGraphAtPoint");
    expect(map).toContain("knowledge-map-hover-card");
    expect(detailMap).toContain("Code Knowledge Map");
    expect(detailMap).toContain("Whole project");
    expect(detailMap).toContain("Truth quality");
    expect(detailMap).toContain("Show potential impact");
    expect(detailMap).toContain("Start path here");
    expect(detailMap).toContain("MAX_RENDERED_NODES = 1800");
    expect(detailMap).toContain("Search files, symbols, languages, or communities");
    expect(detailMap).toContain("How to read code knowledge");
    expect(detailMap).toContain("showAllCommunities");
    expect(detailMap).toContain("Focus community");
    expect(detailMap).toContain("Resize knowledge map sidebar");
    expect(css).toContain(".canvas-knowledge-toggle");
    expect(css).toContain("top: 92px;");
    expect(css).toContain(".knowledge-map-view");
    expect(css).toContain(".knowledge-map-sidebar-resizer");
    expect(css).toContain(".knowledge-map-community-eye");
    expect(css).toContain(".knowledge-map-community-name");
    expect(css).toContain(".knowledge-map-node.is-focus-dimmed");
  });

  it("focuses the left sidebar search from the standard find shortcut", () => {
    const sidebar = readFileSync(resolve(repoRoot, "src/renderer/src/components/ProjectSidebar.tsx"), "utf8");
    const ui = readFileSync(resolve(repoRoot, "src/renderer/src/components/ui.tsx"), "utf8");

    expect(sidebar).toContain("searchInputRef");
    expect(sidebar).toContain('project.focusSidebarSearch');
    expect(sidebar).toContain("sidebar-scope-trigger");
    expect(sidebar).toContain("searchInputRef.current?.focus()");
    expect(sidebar).toContain("searchInputRef.current?.select()");
    expect(sidebar).toContain("ref={searchInputRef}");
    expect(ui).toContain("forwardRef<HTMLInputElement");
  });

  it("supports modifier-click multi-selection in the left sidebar node list", () => {
    const sidebar = readFileSync(resolve(repoRoot, "src/renderer/src/components/ProjectSidebar.tsx"), "utf8");

    expect(sidebar).toContain("selectNodes,");
    expect(sidebar).toContain("toggleNodeSelection,");
    expect(sidebar).toContain("sidebarSelectionAnchorRef");
    expect(sidebar).toContain("if (event.metaKey || event.ctrlKey)");
    expect(sidebar).toContain("toggleNodeSelection(nodeId)");
    expect(sidebar).toContain("if (!event.shiftKey)");
    expect(sidebar).toContain("const nodeIds = filteredNodes.map((node) => node.id)");
    expect(sidebar).toContain("selectNodes(nodeIds.slice(start, end + 1), nodeId)");
    expect(sidebar).toContain("onClick={(event) => selectSidebarNode(event, node.id)}");
  });

  it("shows rich implementation context when hovering 2D canvas nodes", () => {
    const nodeCard = readFileSync(resolve(repoRoot, "src/renderer/src/components/ArchicodeNodeCard.tsx"), "utf8");
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(nodeCard).toContain("NodeContextTooltip");
    expect(nodeCard).toContain("Related implementation");
    expect(nodeCard).toContain("Top files, classes, or symbols");
    expect(nodeCard).toContain("useState(false)");
    expect(nodeCard).toContain("aria-expanded={implementationExpanded}");
    expect(nodeCard).toContain("node-context-related-items");
    expect(nodeCard).toContain("Tech stack");
    expect(nodeCard).toContain("pinned note");
    expect(nodeCard).toContain("Badges & notifications");
    expect(nodeCard).toContain("Source diff linked");
    expect(nodeCard).toContain("Build not verified");
    expect(nodeCard).toContain("Ignored by agents");
    expect(nodeCard).toContain("nodeContextTargets(node)");
    expect(canvas).toContain("getNodeSignalCounts(bundle, node.id, flow?.id)");
    expect(css).toContain(".node-context-tooltip .node-context-target");
    expect(css).toContain('.node-context-section-toggle[aria-expanded="true"]');
    expect(css).toContain(".node-context-pinned");
    expect(css).toContain(".node-context-badge.tone-warning");
  });

  it("supports root-flow creation, Git URL onboarding, scope breadcrumbs, and node color accents", () => {
    const sidebar = readFileSync(resolve(repoRoot, "src/renderer/src/components/ProjectSidebar.tsx"), "utf8");
    const canvas = readFileSync(resolve(repoRoot, "src/renderer/src/components/FlowCanvas.tsx"), "utf8");
    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const contextBuilder = readFileSync(resolve(repoRoot, "src/main/storage/contextBuilder.ts"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(sidebar).toContain("createFlow");
    expect(sidebar).toContain("Add top-level flow");
    expect(sidebar).toContain("sort(compareTopLevelFlows)");
    expect(sidebar).toContain("sort(compareSiblingSubflows)");
    expect(sidebar).toContain("subflow-depth-${Math.min(depth, 5)}");
    expect(sidebar).toContain("renderSubflowRows(item, subflow.id, depth + 1)");
    expect(sidebar).toContain("flowDisplayName(item)");
    expect(sidebar).toContain("editableFlowName(item)");
    expect(sidebar).toContain("flowIconOptions");
    expect(sidebar).toContain("renderFlowIdentityPicker(item)");
    expect(sidebar).toContain("updateFlowVisual");
    expect(sidebar).toContain("Choose a custom flow icon color");
    expect(sidebar).toContain("--node-list-accent");
    expect(sidebar).toContain('className="node-list sidebar-node-list"');
    expect(sidebar).toContain("centerSidebarNodeOnCanvas");
    expect(sidebar).toContain('navigateToGraphTarget({ kind: "node", flowId: flow.id, nodeId })');
    expect(sidebar).toContain("onDoubleClick={() => centerSidebarNodeOnCanvas(node.id)}");
    expect(css).toContain(':root[data-theme="dark"] .project-sidebar .node-list-row.has-custom-color');
    expect(css).toContain("var(--node-list-accent) 70%, var(--border)");
    expect(css).toContain("var(--node-list-accent) 88%, var(--border)");
    expect(css).toContain(".sidebar-node-list .node-list-row");
    expect(css).toContain("gap: 4.8px");
    expect(css).toContain("min-height: 43px");
    expect(css).toContain("padding: 6px 8px");
    expect(canvas).toContain("canvas-scope-breadcrumb");
    expect(canvas).toContain("flowScopeBreadcrumb");
    expect(css).toContain(".subflow-nav-row.subflow-depth-1");
    expect(css).toContain("--subflow-level-background");
    expect(css).toContain("--subflow-label-color");
    expect(css).toContain(".flow-identity-popover");
    expect(css).toContain(".flow-icon-grid");
    expect(css).toContain(".flow-color-grid");
    expect(css).toContain(".subflow-nav-row > span");
    expect(css).toContain(".subflow-nav-row.is-active > span");
    expect(app).toContain("Import from Git URL");
    expect(app).toContain("Choose folder and clone");
    expect(preload).toContain("cloneGitRepository");
    expect(main).toContain("archicode:clone-git-repository");
    expect(contextBuilder).toContain("projectGraphForRunContext");
  });

  it("reopens the project launcher from the project sidebar without unloading the current project", () => {
    const sidebar = readFileSync(resolve(repoRoot, "src/renderer/src/components/ProjectSidebar.tsx"), "utf8");
    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");

    expect(sidebar).toContain("Open project launcher");
    expect(sidebar).toContain("onOpenProjectLauncher");
    expect(app).toContain("projectLauncherOpen");
    expect(app).toContain("Back to current project");
    expect(app).toContain("bundle && !projectLauncherOpen");
  });

  it("shows and exports structured research chat memory", () => {
    const panel = readResearchPanelSource();
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");

    expect(panel).toContain("ResearchMemoryPanel");
    expect(panel).toContain("## Research Memory");
    expect(panel).toContain("appendMemoryList(lines, \"Decisions\"");
    expect(panel).toContain("session.memory");
    expect(panel).toContain("openExternalMarkdownHref");
    expect(panel).toContain("PopoverTrigger asChild");
    expect(panel).toContain("research-memory-popover");
    expect(panel).toContain("research-status-cluster");
    expect(panel).toContain("ResearchTodoCapsule");
    expect(panel).toContain("researchTodosForSession");
    expect(panel).toContain("<ResearchTodoCapsule items={researchTodosForSession(selected)} />");
    const todoCapsuleSource = panel.slice(
      panel.indexOf("function ResearchTodoCapsule"),
      panel.indexOf("export function ResearchMarkdown")
    );
    expect(todoCapsuleSource).toContain("onClick={toggle}");
    expect(todoCapsuleSource).not.toContain("title={label}");
    expect(todoCapsuleSource).not.toContain("onFocus={show}");
    expect(css).toContain(".research-memory-panel");
    expect(css).toContain(".research-memory-popover");
    expect(css).toContain(".research-todo-capsule");
    expect(css).toContain(".research-todo-popover");
    expect(css).toContain(".research-status-cluster");
    expect(css).toContain("border-radius: 999px");
    expect(main).toContain("setWindowOpenHandler");
    expect(main).toContain("shell.openExternal(url)");
  });

  it("derives research graph review UI state from applied versus failed review summaries", () => {
    const panel = readResearchPanelSource();
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(panel).toContain("function reviewSummaryAfterChangeSet");
    expect(panel).toContain("function reviewStatusPresentation");
    expect(panel).toContain("Graph changes reviewed|Graph changes retry reviewed|Auto-approved graph changes");
    expect(panel).toContain('badgeLabel: "Failed"');
    expect(panel).toContain('actionLabel: "Apply Failed"');
    expect(panel).toContain("canRetryFailedReview");
    expect(panel).toContain('"Repair & Apply"');
    expect(panel).toContain("retryReviewed");
    expect(panel).toContain("graphReviewReportPresentation(message.content)");
    expect(panel).toContain('className="research-graph-review-report"');
    expect(panel).toContain("Operation details");
    expect(css).toContain(".research-graph-review-report");
    expect(css).toContain(".research-graph-review-report-details");
    expect(panel).toContain('badgeLabel: "Partial"');
    expect(panel).toContain('badgeLabel: summary.autoApproved ? "Auto-applied" : "Applied"');
    expect(panel).toContain('reviewPresentation?.actionLabel ?? "Applied"');
    expect(panel).toContain('reviewed ? "Reviewed" : "Reject"');
  });

  it("adds optional local speech transcription to research chat input", () => {
    const panel = readResearchPanelSource();
    const toolbar = readProjectToolbarSource();
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const speech = readFileSync(resolve(repoRoot, "src/main/speech.ts"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(panel).toContain("encodeWav");
    expect(panel).toContain("navigator.mediaDevices.getUserMedia");
    expect(panel).toContain("window.archicode.transcribeSpeech");
    expect(panel).toContain("research-speech-button");
    expect(panel).toContain("speechLevel");
    expect(panel).toContain("research-speech-meter");
    expect(panel).toContain("research-recording-send");
    expect(panel).toContain("research-recording-done");
    expect(panel).toContain('stopSpeechRecording("send")');
    expect(panel).toContain('aria-label="Done"');
    expect(panel).toContain("Download the active speech model in Advanced settings before recording.");
    expect(panel).toContain("onSpeechModelDownloadProgress");
    expect(toolbar).toContain("Voice input (STT)");
    expect(toolbar).toContain("Multilingual base");
    expect(toolbar).toContain("English optimized base");
    expect(toolbar).toContain("window.archicode.downloadSpeechModel");
    expect(toolbar).toContain("window.archicode.deleteSpeechModel");
    expect(toolbar).toContain("window.archicode.transcribeSpeech");
    expect(toolbar).toContain("selectSpeechModel");
    expect(toolbar).toContain('role="button"');
    expect(toolbar).toContain("event.stopPropagation()");
    expect(toolbar).toContain("Transformers.js Whisper does not auto-detect language yet");
    expect(toolbar).toContain('{ value: "arabic", label: "Arabic" }');
    expect(toolbar).toContain('{ value: "french", label: "French" }');
    expect(toolbar).toContain("Record test");
    expect(toolbar).toContain("Stop and transcribe");
    expect(toolbar).toContain("Delete downloaded speech model");
    expect(preload).toContain("archicode:get-speech-status");
    expect(preload).toContain("archicode:download-speech-model");
    expect(preload).toContain("archicode:delete-speech-model");
    expect(preload).toContain("archicode:transcribe-speech");
    expect(main).toContain("setSpeechDataRoot");
    expect(main).toContain("archicode:speech-model-download-progress");
    expect(main).toContain("archicode:delete-speech-model");
    expect(main).toContain("setPermissionRequestHandler");
    expect(main).toContain('permission === "media"');
    expect(speech).toContain("@huggingface/transformers");
    expect(speech).toContain("pipeline(\"automatic-speech-recognition\"");
    expect(speech).toContain("Xenova/whisper-base");
    expect(speech).toContain("Whisper base multilingual");
    expect(speech).toContain("Whisper base English optimized");
    expect(speech).toContain("export async function deleteSpeechModel");
    expect(speech).toContain("normalizeSpeechLanguage");
    expect(speech).toContain('auto: "english"');
    expect(speech).toContain('modelId === "base.en"');
    expect(speech).toContain('? {}');
    expect(speech).not.toContain("whisper-cli");
    expect(css).toContain(".research-speech-status");
    expect(css).toContain(".research-speech-meter");
    expect(css).toContain(".research-recording-done");
    expect(css).toContain("speech-recording-pulse");
    expect(css).toContain(".speech-settings-panel");
    expect(css).toContain(".speech-test-result");
    expect(css).toContain(".speech-model-row:hover");
    expect(css).toContain(".settings-tab-content:hover::-webkit-scrollbar-thumb");
  });

  it("exposes hosted MCP controls in advanced settings", () => {
    const toolbar = readProjectToolbarSource();
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");

    expect(toolbar).toContain("Hosted MCP");
    expect(toolbar).toContain("Host ArchiCode MCP on localhost");
    expect(toolbar).toContain("Copy Codex App Setup");
    expect(toolbar).toContain("Copy Claude Config");
    expect(toolbar).toContain("Regenerate Token");
    expect(toolbar).toContain("Codex app setup");
    expect(toolbar).toContain("leave bearer token env var empty");
    expect(toolbar).toContain("direct headers");
    expect(toolbar).toContain("default_tools_approval_mode");
    expect(toolbar).not.toContain("Available MCP prompts");
    expect(preload).toContain("archicode:get-external-mcp-host-status");
    expect(preload).toContain("archicode:regenerate-external-mcp-host-token");
    expect(preload).toContain("onExternalProjectUpdated");
    expect(preload).toContain("archicode:external-project-updated");
    expect(main).toContain("syncExternalMcpHost");
    expect(main).toContain("setExternalMcpProjectUpdatePublisher");

    const host = readFileSync(resolve(repoRoot, "src/main/mcpHost.ts"), "utf8");
    expect(host).toContain("archicode_get_scoped_change_context");
    expect(host).toContain("persistArtifacts");
    expect(host).toContain("default_tools_approval_mode: auto");
    expect(host).toContain("default_tools_approval_mode, mcp-session-id");
    expect(host).toContain("archicode://about");
    expect(host).toContain("archicode_coding_orientation");
    expect(host).toContain("build-run context builder");

    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");
    const store = readStoreSource();
    expect(app).toContain("onExternalProjectUpdated");
    expect(store).toContain("handleExternalProjectUpdated");
  });

  it("exposes local semantic index health and controls in advanced settings", () => {
    const toolbar = readProjectToolbarSource();
    expect(toolbar).toContain("Semantic Index");
    expect(toolbar).toContain("Use local semantic indexing");
    expect(toolbar).toContain("Rebuild Code Index");
    expect(toolbar).toContain("Refresh Status");
    expect(toolbar).toContain("Graph records");
    expect(toolbar).toContain("Code records");
    expect(toolbar).toContain('semanticIndexStatus?.state === "graph-only"');
    expect(toolbar).toContain("Clear Cache");
    expect(toolbar).toContain("getSemanticIndexStatus");
    expect(toolbar).toContain("onSemanticIndexProgress");
    expect(toolbar).toContain("BGE Small · Higher quality (Default)");
    expect(toolbar).toContain("MiniLM · Faster");
    expect(toolbar).toContain("setSemanticModelPreference");
    const inspector = readNodeInspectorSource();
    expect(inspector).toContain('semanticContextHasData ? "available"');
    expect(inspector).toContain("!semanticContextHasData ? <small>{semanticContext.message}</small> : null");
    expect(inspector).toContain("Same subject across flows");
    expect(inspector).toContain("No matching subject identity appears in another flow.");
    expect(inspector).toContain("No source code is indexed yet");
  });

  it("explains which MCP tools a chat message used when its capsule is hovered", () => {
    const panel = readResearchPanelSource();

    expect(panel).toContain("mcpToolUsageTooltip(message.mcpToolCalls)");
    expect(panel).toContain("call.serverLabel?.trim() || call.serverId");
    expect(panel).toContain("`${server}: ${tool}${count > 1 ? ` ×${count}` : \"\"}`");
  });

  it("adds optional Kokoro text-to-speech playback to research chat output", () => {
    const panel = readResearchPanelSource();
    const toolbar = readProjectToolbarSource();
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const tts = readFileSync(resolve(repoRoot, "src/main/tts.ts"), "utf8");
    const viteConfig = readFileSync(resolve(repoRoot, "electron.vite.config.ts"), "utf8");
    const css = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(panel).toContain("window.archicode.streamSpeech");
    expect(panel).toContain("window.archicode.writeTtsDebugLog");
    expect(panel).toContain("ttsFileDebugEnabled = false");
    expect(panel).toContain("window.archicode.warmTtsModel");
    expect(panel).toContain("playMessageSpeech");
    expect(panel).toContain("playNextTtsChunk");
    expect(panel).toContain("ttsDebugContextRef");
    expect(panel).toContain("writeTtsDebugEvent");
    expect(panel).toContain("stream-prefix-extracted");
    expect(panel).toContain("stream-prefix-waiting");
    expect(panel).toContain("stream-message-observed");
    expect(panel).toContain("stream-status-waiting");
    expect(panel).toContain("stream-status-blocked");
    expect(panel).toContain("inspectStreamingSpeechPrefix");
    expect(panel).toContain("streamingTtsMinPrepareUnitChars");
    expect(panel).toContain("maxActiveTtsSpeechJobs = 3");
    expect(panel).toContain("splitTtsPrepareUnits");
    expect(panel).toContain("prepare-units-created");
    expect(panel).toContain("pumpTtsSpeechJobStarts");
    expect(panel).toContain("waitForTtsSpeechJobStart");
    expect(panel).toContain("stream-start-waiting");
    expect(panel).toContain("stream-started");
    expect(panel).toContain("stream-zero-chunk-fallback-started");
    expect(panel).toContain("stream-zero-chunk-fallback-decoded");
    expect(panel).toContain("stream-zero-chunk-fallback-error");
    expect(panel).toContain("singleSegment: true");
    expect(panel).toContain("message-id-migrated");
    expect(panel).toContain("speechJobIndex");
    expect(panel).toContain("chunk-ordered");
    expect(panel).toContain("ttsSpeechJobsRef");
    expect(panel).toContain("jobForChunk && jobForChunk.total === null");
    expect(panel).toContain("jobForChunk.total = chunk.total");
    expect(panel).toContain("chunk.total > 1 ? displayTtsHighlightText(chunk.text) : input.highlightText ?? displayTtsHighlightText(chunk.text)");
    expect(panel).toContain('replace(/\\bArchy Code\\b/g, "ArchiCode")');
    expect(panel).toContain("ttsAudioChunksRef");
    expect(panel).toContain("ttsNextChunkIndexRef");
    expect(panel).toContain("ttsHighlight");
    expect(panel).toContain("highlightResearchContent");
    expect(panel).toContain("substantialFragment");
    expect(panel).toContain("highlightText: decision.result.spoken");
    expect(panel).toContain("research-tts-highlight");
    expect(panel).toContain("highlightText={ttsHighlight?.messageId === message.id ? ttsHighlight.text : null}");
    expect(panel).toContain("ttsQueuedChunkCountRef.current += 1");
    expect(panel).toContain("playback waiting");
    expect(panel).toContain("decodeAudioData");
    expect(panel).toContain("createBufferSource");
    expect(panel).toContain("chunk ipc");
    expect(panel).toContain("chunk decoded");
    expect(panel).toContain("source.start called");
    expect(panel).toContain("playback ended");
    expect(panel).toContain("debugStartedAtMs");
    expect(panel).toContain("speechResearchContent");
    expect(panel).toContain("There is no readable text to play.");
    expect(panel).toContain('.replace(/\\bArchiCode\\b/g, "Archy Code")');
    expect(panel).toContain('.replace(/\\bArchi\\b/g, "Archy")');
    expect(panel).toContain(".replace(/[`*]+/g, \"\")");
    expect(panel).toContain(".replace(/`([^`\\n]+)`/g, \"$1\")");
    expect(panel).toContain(".replace(/\\[([^\\]\\n]+)\\]\\([^) \\n]+\\)/g, \"$1\")");
    expect(panel).toContain("lastAutoplayMessageIdRef");
    expect(panel).toContain("streamingAutoplayRef");
    expect(panel).toContain("takeStreamingSpeechPrefix");
    expect(panel).toContain("consumedContentChars");
    expect(panel).toContain("pendingContent");
    expect(panel).toContain("activeTtsMessageId");
    expect(panel).toContain("currentState.messageId = finalAssistantMessage.id");
    expect(panel).toContain("streaming autoplay started");
    expect(panel).toContain("queueTtsSpeechText");
    expect(panel).toContain("finalizeTtsSpeechQueue");
    expect(panel).toContain("writeClipboardText");
    expect(panel).toContain("Read message aloud");
    expect(panel).toContain("Download the active text-to-speech model in Advanced settings before playback.");
    expect(panel).toContain("research-message-actions");
    expect(toolbar).toContain("Voice output (TTS)");
    expect(toolbar).toContain("Kokoro 82M");
    expect(toolbar).toContain("Autoplay assistant replies");
    expect(toolbar).toContain("window.archicode.downloadTtsModel");
    expect(toolbar).toContain("window.archicode.deleteTtsModel");
    expect(toolbar).toContain("window.archicode.synthesizeSpeech");
    expect(toolbar).toContain("Play test");
    expect(preload).toContain("archicode:get-tts-status");
    expect(preload).toContain("archicode:download-tts-model");
    expect(preload).toContain("archicode:delete-tts-model");
    expect(preload).toContain("archicode:warm-tts-model");
    expect(preload).toContain("archicode:synthesize-speech");
    expect(preload).toContain("archicode:stream-speech");
    expect(preload).toContain("singleSegment?: boolean");
    expect(preload).toContain("archicode:write-tts-debug-log");
    expect(preload).toContain("archicode:tts-speech-stream-chunk");
    expect(preload).toContain("archicode:tts-model-download-progress");
    expect(main).toContain("setTtsDataRoot");
    expect(main).toContain("archicode:synthesize-speech");
    expect(main).toContain("archicode:warm-tts-model");
    expect(main).toContain("archicode:stream-speech");
    expect(main).toContain("writeTtsDebugLog");
    expect(main).toContain("tts-logs");
    expect(main).toContain("archicode:tts-speech-stream-chunk");
    expect(main).toContain("media-src 'self' blob:");
    expect(viteConfig).toContain("media-src 'self' blob:");
    expect(tts).toContain("ttsWorkerScript");
    expect(tts).toContain("activeTtsWorkers");
    expect(tts).toContain("TtsWorkerProcess[]");
    expect(tts).toContain("const maxParallelTtsWorkers");
    expect(tts).toContain("nextTtsWorkerIndex");
    expect(tts).toContain("worker.pending.size === minPending");
    expect(tts).toContain("workerSlot=");
    expect(tts).toContain("ttsAudioCache");
    expect(tts).toContain("const maxCachedTtsAudioEntries = 2");
    expect(tts).toContain("const ttsChunkPauseMs = 250");
    expect(tts).toContain('input.cacheHit ? "hit" : "miss"');
    expect(tts).toContain("logTtsDiagnostics");
    expect(tts).toContain("workerAlreadyLoaded");
    expect(tts).toContain("normalizeSpeechText");
    expect(tts).toContain("chunk emitted");
    expect(tts).toContain("final audio emitted");
    expect(tts).toContain("splitSpeechSentences");
    expect(tts).toContain("splitLongSpeechSentence");
    expect(tts).toContain("splitSpeechSegments");
    expect(tts).toContain("const earlySpeechSingleSegmentCount = 3");
    expect(tts).toContain("const maxSpeechClauseChars = 110");
    expect(tts).toContain("shutdownTtsWorkers");
    expect(tts).toContain("requestQueue");
    expect(tts).toContain("workerChunkPrefix");
    expect(tts).toContain("streamSpeech");
    expect(tts).toContain("warmTtsModel");
    expect(tts).toContain("segments");
    expect(tts).toContain("spawn(nodeExecutable()");
    expect(tts).toContain("KokoroTTS.from_pretrained");
    expect(tts).toContain("model_quantized.onnx");
    expect(tts).toContain('device: "cpu"');
    expect(tts).toContain('runtime: "kokoro-js"');
    expect(tts).toContain("onnx-community/Kokoro-82M-v1.0-ONNX");
    expect(tts).toContain("af_heart.bin");
    expect(tts).toContain("synthesizer.generate");
    expect(tts).toContain("encodeWav");
    expect(css).toContain(".research-message-actions");
    expect(css).toContain(".research-copy-button.ui-icon-button.is-speaking");
    expect(css).toContain(".research-tts-highlight");
  });

  it("exposes project agent instructions as editable settings files", () => {
    const toolbar = readProjectToolbarSource();
    const store = readStoreSource();
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const storage = readFileSync(resolve(repoRoot, "src/main/storage/agentFiles.ts"), "utf8");

    expect(store).toContain('| "agent-memory"');
    expect(toolbar).toContain('TabsTrigger value="agent-memory"');
    expect(toolbar).toContain('TabsContent value="agent-memory"');
    expect(toolbar).toContain("Agent Instructions");
    expect(toolbar).toContain("window.archicode.listAgentInstructionFiles");
    expect(toolbar).toContain("window.archicode.readAgentInstructionFile");
    expect(toolbar).toContain("window.archicode.writeAgentInstructionFile");
    expect(preload).toContain("listAgentInstructionFiles");
    expect(preload).toContain("readAgentInstructionFile");
    expect(preload).toContain("writeAgentInstructionFile");
    expect(main).toContain("archicode:list-agent-instruction-files");
    expect(main).toContain("archicode:read-agent-instruction-file");
    expect(main).toContain("archicode:write-agent-instruction-file");
    expect(storage).toContain("AGENT_INSTRUCTION_FILE_CANDIDATES");
    expect(storage).toContain("CLAUDE.md");
    expect(storage).toContain(".github/copilot-instructions.md");
    expect(toolbar).toContain("Put shared guidance in <code>AGENTS.md</code>");
    expect(toolbar).toContain("# Project Agent Instructions");
  });

  it("distinguishes note cleanup from removing a project from ArchiCode", () => {
    const toolbar = readProjectToolbarSource();
    const styles = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");
    const projectStore = readFileSync(resolve(repoRoot, "src/renderer/src/store/projectSlice.ts"), "utf8");

    expect(toolbar).toContain('<section className="settings-maintenance-row">');
    expect(toolbar.match(/className="danger-zone"/g)).toHaveLength(1);
    expect(toolbar).toContain("Remove this project from ArchiCode");
    expect(toolbar).toContain("Your source code and regular project files will stay untouched");
    expect(toolbar).toContain("Opening this folder in ArchiCode later will require importing it again");
    expect(toolbar).toContain("Remove from ArchiCode");
    expect(styles).toContain(".settings-maintenance-row {");
    expect(styles).toContain("border: 1px solid var(--border)");
    expect(projectStore).toContain("If you open this folder in ArchiCode again, you'll need to import it again");
  });

  it("exposes a global Archi personality selector in General settings", () => {
    const toolbar = readProjectToolbarSource();
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");
    const shared = readFileSync(resolve(repoRoot, "src/shared/researchPersonality.ts"), "utf8");

    expect(toolbar).toContain("Archi personality");
    expect(toolbar).toContain("Verbosity");
    expect(toolbar).toContain("Chatty");
    expect(toolbar).toContain("Stored on this machine across all projects");
    expect(toolbar).toContain("window.archicode.getGlobalResearchPersonality");
    expect(toolbar).toContain("window.archicode.saveGlobalResearchPersonality");
    expect(toolbar).toContain("window.archicode.getGlobalResearchVerbosity");
    expect(toolbar).toContain("window.archicode.saveGlobalResearchVerbosity");
    expect(preload).toContain("getGlobalResearchPersonality");
    expect(preload).toContain("saveGlobalResearchPersonality");
    expect(preload).toContain("getGlobalResearchVerbosity");
    expect(preload).toContain("saveGlobalResearchVerbosity");
    expect(main).toContain("archicode:get-global-research-personality");
    expect(main).toContain("archicode:save-global-research-personality");
    expect(main).toContain("archicode:get-global-research-verbosity");
    expect(main).toContain("archicode:save-global-research-verbosity");
    expect(shared).toContain('"cat-waifu"');
    expect(shared).toContain('"claptrap"');
    expect(shared).toContain('"jar-jar-binks"');
    expect(shared).toContain('"groot"');
    expect(shared).toContain('GLOBAL_RESEARCH_VERBOSITY_IDS = ["default", "chatty"]');
    expect(shared).toContain("researchPersonalitySharedDirective");
    expect(toolbar).toContain('contentClassName="ui-select-content-personality"');
    expect(toolbar).toContain("showScrollIndicator");
    const styles = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");
    expect(styles).toContain(".ui-select-content-personality:hover .ui-select-viewport");
    expect(styles).toContain(".ui-select-content-personality .ui-select-viewport::-webkit-scrollbar-thumb");
    expect(styles).toContain(".ui-select-scroll-indicator");
  });

  it("keeps visual group creation tied to a confirmed flow save", () => {
    const inspector = readNodeInspectorSource();
    const store = readStoreSource();

    expect(inspector).toContain("const savedFlow = await saveFlowKeepingDetailsScroll");
    expect(inspector).toContain("savedFlow?.groups.some");
    expect(inspector).toContain("setGroupNameDraft(\"\")");
    expect(inspector).toContain("groupColorDraft");
    expect(inspector).toContain("GroupColorSwatches");
    expect(inspector).toContain("New group accent");
    expect(inspector).toContain("Selected group accent");
    expect(inspector).toContain("const updateGroupColor");
    expect(inspector).toContain("selectNodes(nodesToGroup.map");
    expect(store).toContain("saveFlow: (flow: Flow) => Promise<ProjectBundle | null>");
    expect(store).toContain("return bundle;");
  });

  it("offers a large, resizable editor for node description and acceptance criteria", () => {
    const inspector = readFileSync(resolve(repoRoot, "src/renderer/src/components/NodeInspector.tsx"), "utf8");
    const ui = readFileSync(resolve(repoRoot, "src/renderer/src/components/ui.tsx"), "utf8");
    const styles = readFileSync(resolve(repoRoot, "src/renderer/src/styles/app.css"), "utf8");

    expect(inspector).toContain('title="Open description in large editor"');
    expect(inspector).toContain('title="Open acceptance criteria in large editor"');
    expect(inspector).toContain('className="node-large-text-editor-dialog"');
    expect(inspector).toContain("resizable");
    expect(inspector).toContain("Ctrl/Cmd+Enter to save");
    expect(inspector).toContain('largeTextEditor.draft.split("\\n").map((item) => item.trim()).filter(Boolean)');
    expect(styles).toContain(".node-large-text-editor-input.ui-textarea");
    expect(styles).toContain("height: min(720px, calc(100vh - 64px));");
    expect(ui).toContain('className="ui-field-action-label"');
    expect(ui).toContain('className="ui-field-action-slot"');
    expect(styles).toContain(".ui-field-action-label > :not(.ui-field-label-row)");
  });

  it("ships a rebindable, global Shortcuts tab inside the Settings dialog", () => {
    const keybindings = readFileSync(resolve(repoRoot, "src/renderer/src/utils/keybindings.ts"), "utf8");
    const store = readStoreSource();
    const app = readFileSync(resolve(repoRoot, "src/renderer/src/App.tsx"), "utf8");
    const toolbar = readProjectToolbarSource();
    const shortcutsTab = readFileSync(resolve(repoRoot, "src/renderer/src/components/ShortcutsSettingsTab.tsx"), "utf8");
    const help = readFileSync(resolve(repoRoot, "src/renderer/src/components/HelpPage.tsx"), "utf8");
    const preload = readFileSync(resolve(repoRoot, "src/preload/index.ts"), "utf8");
    const main = readFileSync(resolve(repoRoot, "src/main/index.ts"), "utf8");

    expect(keybindings).toContain("DEFAULT_BINDINGS");
    expect(keybindings).toContain("ACTION_DESCRIPTORS");
    expect(keybindings).toContain("formatChord");
    expect(keybindings).toContain("isReservedChord");
    expect(keybindings).toContain("isReservedFor3dCamera");
    expect(keybindings).toContain("isReservedAction");
    expect(keybindings).toContain("RESERVED_ACTION_IDS");
    expect(keybindings).toContain("reserved: true");
    expect(keybindings).toContain('"canvas.reload"');
    expect(keybindings).toContain('"project.openPreferences"');
    expect(keybindings).toContain('"activity.tabRuns"');
    expect(keybindings).toContain('"run.retry"');
    expect(keybindings).toContain('"chat.newResearchChat"');
    // Persisted in the global app-state JSON near global research personality.
    expect(store).toContain("keybindings: Record<ActionId, KeyChord>");
    expect(store).toContain("setKeybinding:");
    expect(store).toContain("resetAllKeybindings:");
    expect(store).toContain("isReservedAction(id)) return");
    // Shortcuts tab is part of the project settings dialog's tab set.
    expect(store).toContain('"shortcuts"');
    expect(toolbar).toContain('<TabsTrigger value="shortcuts">Shortcuts</TabsTrigger>');
    expect(toolbar).toContain("ShortcutsSettingsTab");
    // App routes app-global chords (settings, theme, workbench, activity tabs).
    expect(app).toContain("project.openPreferences");
    expect(app).toContain("openProjectSettings");
    expect(app).toContain("activity.tabRuns");
    expect(app).toContain("archicode:set-activity-tab");
    // ShortcutsSettingsTab exposes capture + conflict handling.
    expect(shortcutsTab).toContain("preferences-row");
    expect(shortcutsTab).toContain("is-drafting");
    expect(shortcutsTab).toContain("preferences-row-warning");
    expect(shortcutsTab).toContain("Reset all to defaults");
    expect(shortcutsTab).toContain("Apply");
    expect(shortcutsTab).toContain("findConflicts");
    // Live bindings are surfaced in Help, and a Shortcuts link is present.
    expect(help).toContain("Current key bindings");
    expect(help).toContain("Open Shortcuts");
    expect(help).toContain("archicode:open-help");
    // IPC bridge for persisting bindings globally.
    expect(preload).toContain("getKeybindings");
    expect(preload).toContain("saveKeybindings");
    expect(main).toContain("archicode:get-keybindings");
    expect(main).toContain("archicode:save-keybindings");
  });
});
