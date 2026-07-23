import { formatDateTime } from "@renderer/i18n";
import { t } from "@renderer/i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ChevronLeft, ChevronRight, Dock, FolderOpen, GitBranch, MessageSquare, PictureInPicture2, Plus, SlidersHorizontal, Sparkles } from "lucide-react";
import { FlowCanvas } from "./components/FlowCanvas";
import { BuildQuestionCheck } from "./components/BuildQuestionCheck";
import { CodebaseOnboardingWizard } from "./components/CodebaseOnboardingWizard";
import { GlobalProviderSetup } from "./components/GlobalProviderSetup";
import { HelpPage } from "./components/HelpPage";
import { NodeInspector } from "./components/NodeInspector";
import { PermissionModal } from "./components/PermissionModal";
import { ProjectFileBrowser } from "./components/ProjectFileBrowser";
import { ProjectToolbar } from "./components/ProjectToolbar";
import { GraphHistoryBar } from "./components/GraphHistoryBar";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ResearchPanel } from "./components/ResearchPanel";
import { SettingsAndRuns } from "./components/SettingsAndRuns";
import { Button, DialogContent, DialogRoot, IconButton, MenuContent, MenuItem, MenuLabel, MenuRoot, MenuTrigger, TabsContent, TabsList, TabsRoot, TabsTrigger, TooltipProvider } from "./components/ui";
import { useArchicodeStore } from "./store/useArchicodeStore";
import { projectTemplates, type ProjectTemplateId } from "@shared/templates";
import { collectRunErrors } from "./utils/runErrors";
import { isRunBlockingNewChange } from "./utils/runStatus";
import { matches as chordMatches } from "./utils/keybindings";
import { applyRendererLocale } from "./i18n";

type PanelId = "sidebar" | "activity" | "inspector" | "research";

type FloatingPanelLayout = {
  docked: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

type StoredLayout = {
  activityOpen: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  researchPanelWidth?: number;
  researchPanelOpen: boolean;
  rightSidebarTab?: RightSidebarTab;
  activityHeight: number;
  collapsedPanels: Record<"sidebar" | "inspector", boolean>;
  panelLayouts: Record<PanelId, FloatingPanelLayout>;
};

type RightSidebarTab = "properties" | "chat";

type StickyErrorNotice = {
  details: string;
  message: string;
  raisedAt: number;
};

type FocusModeSnapshot = {
  activityOpen: boolean;
  collapsedPanels: Record<"sidebar" | "inspector", boolean>;
  workbenchView: "graph" | "files";
};

type ExpandableBannerProps = {
  title: string;
  message: string;
  tone?: "error" | "warning";
  role?: "alert" | "status";
  details?: string;
  detailsTitle: string;
  detailsDescription?: string;
  onDismiss?: () => void;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const defaultPanelLayouts: Record<PanelId, FloatingPanelLayout> = {
  sidebar: { docked: true, x: 18, y: 52, width: 330, height: 720 },
  activity: { docked: true, x: 360, y: 430, width: 820, height: 330 },
  inspector: { docked: true, x: 900, y: 52, width: 410, height: 720 },
  research: { docked: true, x: 980, y: 52, width: 440, height: 760 }
};
const defaultActivityHeight = 189;
const defaultSidePanelWidth = 300;

const activityTabByAction: Array<[string, string]> = [
  ["activity.tabRuns", "runs"],
  ["activity.tabTrace", "trace"],
  ["activity.tabErrors", "errors"],
  ["activity.tabPlans", "plans"],
  ["activity.tabDiffs", "diffs"],
  ["activity.tabGit", "git"],
  ["activity.tabQuestions", "questions"],
  ["activity.tabArtifacts", "artifacts"]
];

function layoutStorageKey(rootPath: string): string {
  return `archicode-layout:${rootPath || "default"}`;
}

function DockedPanel({
  panel,
  label,
  children,
  renderDetachButton,
  panelActionInContent = false
}: {
  panel: PanelId;
  label: string;
  children: ReactNode;
  renderDetachButton: (panel: PanelId, label: string) => ReactNode;
  panelActionInContent?: boolean;
}) {
  return (
    <section className={`dock-slot dock-slot-${panel}`}>
      {panelActionInContent ? null : renderDetachButton(panel, label)}
      {children}
    </section>
  );
}

function FloatingPanel({
  panel,
  label,
  layout,
  children,
  onDock,
  onTitlebarPointerDown
}: {
  panel: PanelId;
  label: string;
  layout: FloatingPanelLayout;
  children: ReactNode;
  onDock: () => void;
  onTitlebarPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <section
      className={`floating-panel floating-panel-${panel}`}
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height
      }}
      aria-label={label}
    >
      <div className="floating-panel-titlebar" onPointerDown={onTitlebarPointerDown}>
        <strong>{label}</strong>
        <IconButton
          type="button"
          className="panel-dock-button"
          onClick={onDock}
          title={t("Dock {{label}}", { label: label })}
        >
          <Dock size={14} />
        </IconButton>
      </div>
      <div className="floating-panel-body">{children}</div>
    </section>
  );
}

function isSupportedGitRemoteUrl(value: string): boolean {
  if (/^[^@\s]+@[^:\s]+:[^\s]+$/.test(value)) return true;
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "ssh:", "git:"].includes(parsed.protocol) && Boolean(parsed.hostname && parsed.pathname.replace(/\//g, ""));
  } catch {
    return false;
  }
}

function WelcomeScreen({ onReturnToProject }: { onReturnToProject?: () => void }) {
  const { openProjectFolder, cloneGitRepository, createProjectFromTemplate } = useArchicodeStore(useShallow((state) => ({
    openProjectFolder: state.openProjectFolder,
    cloneGitRepository: state.cloneGitRepository,
    createProjectFromTemplate: state.createProjectFromTemplate
  })));
  const [gitImportOpen, setGitImportOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [gitCloneBusy, setGitCloneBusy] = useState(false);
  const [gitUrlError, setGitUrlError] = useState<string | null>(null);
  const importFromGit = async () => {
    const remoteUrl = gitUrl.trim();
    if (!remoteUrl) {
      setGitUrlError("Enter a Git repository URL.");
      return;
    }
    if (!isSupportedGitRemoteUrl(remoteUrl)) {
      setGitUrlError("Enter a valid HTTP(S), SSH, or Git repository URL.");
      return;
    }
    setGitCloneBusy(true);
    setGitUrlError(null);
    try {
      const opened = await cloneGitRepository(remoteUrl);
      if (opened) {
        setGitImportOpen(false);
        onReturnToProject?.();
      }
    } catch (error) {
      setGitUrlError(error instanceof Error ? error.message : String(error));
    } finally {
      setGitCloneBusy(false);
    }
  };
  return (
    <>
      <section className="welcome-screen" aria-label={t("Welcome to ArchiCode")}>
        <div className="welcome-panel">
          {onReturnToProject ? (
            <Button type="button" size="sm" variant="ghost" className="welcome-return-button" onClick={onReturnToProject}>
              <ChevronLeft size={15} />
              <span>{t("Back to current project")}</span>
            </Button>
          ) : null}
          <div className="welcome-copy">
            <span className="ui-eyebrow">{t("ARCHICODE")}</span>
            <h1>{t("Start with a project")}</h1>
            <p>{t("{{value1}} {{value2}}", { value1: t("Open a local codebase, clone a Git repository, or start from a template. Configure an LLM provider when you want ArchiCode to map and reason across the project."), value2: " " })}</p>
          </div>
          <div className="welcome-actions">
            <Button type="button" variant="primary" onClick={() => void openProjectFolder().then(() => onReturnToProject?.())}>
              <FolderOpen size={16} />
              <span>{t("Open codebase")}</span>
            </Button>
            <GlobalProviderSetup />
            <Button className="welcome-git-import" type="button" onClick={() => {
              setGitUrlError(null);
              setGitImportOpen(true);
            }}>
              <GitBranch size={16} />
              <span>{t("Import from Git URL")}</span>
            </Button>
          </div>
          <div className="welcome-secondary">
            <div className="welcome-secondary-actions">
              <MenuRoot>
                <MenuTrigger asChild>
                  <Button type="button">
                    <Plus size={16} />
                    <span>{t("New project from template")}</span>
                  </Button>
                </MenuTrigger>
                <MenuContent align="center">
                  <MenuLabel>{t("Start from template")}</MenuLabel>
                  {projectTemplates.map((template) => (
                    <MenuItem key={template.id} onSelect={() => void createProjectFromTemplate(template.id as ProjectTemplateId).then(() => onReturnToProject?.())}>
                      <span className="menu-item-stack">
                        <strong>{template.name}</strong>
                        <small>{template.description}</small>
                      </span>
                    </MenuItem>
                  ))}
                </MenuContent>
              </MenuRoot>
              <HelpPage />
            </div>
          </div>
        </div>
      </section>
      <DialogRoot open={gitImportOpen} onOpenChange={(open) => {
        if (!gitCloneBusy) setGitImportOpen(open);
      }}>
        <DialogContent
          title={t("Import from Git URL")}
          description={t("Choose a repository and then a local parent folder. ArchiCode clones into a repository-named folder and opens the codebase importer.")}
          className="git-clone-dialog"
          hideCloseButton={gitCloneBusy}
          onEscapeKeyDown={(event) => { if (gitCloneBusy) event.preventDefault(); }}
          onInteractOutside={(event) => { if (gitCloneBusy) event.preventDefault(); }}
        >
          <form className="git-clone-form" onSubmit={(event) => {
            event.preventDefault();
            void importFromGit();
          }}>
            <label>
              <span>{t("Repository URL")}</span>
              <input
                className="ui-input"
                type="text"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                disabled={gitCloneBusy}
                value={gitUrl}
                placeholder="https://github.com/owner/repository.git"
                onChange={(event) => {
                  setGitUrl(event.target.value);
                  setGitUrlError(null);
                }}
              />
            </label>
            {gitUrlError ? <p className="git-clone-error" role="alert">{gitUrlError}</p> : null}
            {gitCloneBusy ? <p className="git-clone-status" role="status">{t("Cloning repository… This can take a few minutes.")}</p> : null}
            <div className="action-row git-clone-actions">
              <Button type="button" disabled={gitCloneBusy} onClick={() => setGitImportOpen(false)}>{t("Cancel")}</Button>
              <Button type="submit" variant="primary" disabled={gitCloneBusy || !gitUrl.trim()}>
                <GitBranch size={15} />
                <span>{gitCloneBusy ? t("Cloning…") : t("Choose folder and clone")}</span>
              </Button>
            </div>
          </form>
        </DialogContent>
      </DialogRoot>
    </>
  );
}

function UnifiedRightSidebar({
  activeTab,
  onActiveTabChange,
  propertiesLabelShineKey,
  panelAction,
  chatFocusMode = false,
  onToggleChatFocusMode
}: {
  activeTab: RightSidebarTab;
  onActiveTabChange: (value: RightSidebarTab) => void;
  propertiesLabelShineKey: number;
  panelAction?: ReactNode;
  chatFocusMode?: boolean;
  onToggleChatFocusMode?: () => void;
}) {
  return (
    <aside className={chatFocusMode ? "unified-right-sidebar is-chat-focus" : "unified-right-sidebar"} aria-label={chatFocusMode ? t("Chat focus mode") : t("Right sidebar")}>
      <TabsRoot value={activeTab} onValueChange={(value) => onActiveTabChange(value as RightSidebarTab)} className={chatFocusMode ? "unified-right-sidebar-tabs is-chat-focus" : "unified-right-sidebar-tabs"}>
        {!chatFocusMode ? (
          <div className="unified-right-sidebar-topbar">
            <TabsList className="ui-tabs-list compact unified-right-sidebar-tabs-list quiet-mode-switch">
              <TabsTrigger
                key={`properties-${propertiesLabelShineKey}`}
                value="properties"
                aria-label={t("Properties")}
                title={t("Properties")}
                className={propertiesLabelShineKey ? "properties-tab-attention" : undefined}
              >
                <SlidersHorizontal size={14} />
                <span>{t("Properties")}</span>
              </TabsTrigger>
              <TabsTrigger value="chat" aria-label={t("Chat")} title={t("Chat")}>
                <MessageSquare size={14} />
                <span className="chat-tab-label">{t("Chat")}</span>
                <Sparkles className="chat-tab-ai-icon" size={14} aria-hidden="true" />
              </TabsTrigger>
            </TabsList>
            {panelAction}
          </div>
        ) : null}
        <TabsContent value="properties" className="unified-right-sidebar-tab">
          <NodeInspector />
        </TabsContent>
        <TabsContent value="chat" className="unified-right-sidebar-tab">
          <ResearchPanel focusMode={chatFocusMode} onToggleFocusMode={onToggleChatFocusMode} />
        </TabsContent>
      </TabsRoot>
    </aside>
  );
}

function bannerTextOverflows(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1;
}

function ExpandableBanner({
  title,
  message,
  tone,
  role = "status",
  details,
  detailsTitle,
  detailsDescription,
  onDismiss
}: ExpandableBannerProps) {
  const messageRef = useRef<HTMLSpanElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [messageOverflowing, setMessageOverflowing] = useState(false);
  const detailText = details?.trim() || message;

  useEffect(() => {
    const target = messageRef.current;
    if (!target) return;
    const updateOverflow = () => {
      setMessageOverflowing(bannerTextOverflows(target));
    };
    updateOverflow();
    const frame = window.requestAnimationFrame(updateOverflow);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateOverflow);
    observer?.observe(target);
    window.addEventListener("resize", updateOverflow);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", updateOverflow);
    };
  }, [message, detailText, title]);

  const canShowDetails = Boolean(detailText) && (messageOverflowing || detailText !== message);

  return (
    <>
      <DialogRoot open={canShowDetails && detailsOpen} onOpenChange={setDetailsOpen}>
        {canShowDetails ? (
          <DialogContent
            title={detailsTitle}
            description={detailsDescription}
            className="error-details-dialog"
          >
            <pre className="error-details-pre">{detailText}</pre>
            <div className="error-details-actions">
              <Button type="button" variant="secondary" onClick={() => setDetailsOpen(false)}>
                <span>{t("Close")}</span>
              </Button>
              {onDismiss ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setDetailsOpen(false);
                    onDismiss();
                  }}
                >
                  <span>{t("Dismiss")}</span>
                </Button>
              ) : null}
            </div>
          </DialogContent>
        ) : null}
      </DialogRoot>
      <div className={`validation-bar${tone ? ` ${tone}` : ""}`} role={role}>
        <div className="validation-bar-copy">
          <strong>{title}</strong>
          <span ref={messageRef} className="validation-bar-message">{message}</span>
        </div>
        {canShowDetails || onDismiss ? (
          <div className="validation-bar-actions">
            {canShowDetails ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => setDetailsOpen(true)}>
                <span>{t("Details")}</span>
              </Button>
            ) : null}
            {onDismiss ? (
              <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
                <span>{t("Dismiss")}</span>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function App() {
  const observedGitHeadRef = useRef<{ rootPath: string; hash: string | null } | null>(null);
  const {
    load,
    loading,
    error,
    appNotice,
    bundle,
    rootPath,
    gitStatus,
    theme,
    uiScale,
    handleRunUpdated,
    handleResearchChatSessionUpdated,
    handleExternalProjectUpdated,
    researchPanelOpen,
    openResearchPanel,
    closeResearchPanel,
    workbenchView,
    setWorkbenchView,
    undoPresentationAction,
    redoPresentationAction,
    dismissAppNotice,
    toggleTheme,
    reload,
    createResearchChat,
    loadKeybindings,
    keybindings,
    openProjectSettings,
    loadGlobalSpeechSettings,
    loadGlobalTtsSettings,
    loadGlobalVoiceSettings,
    loadGlobalCodeIdeSettings,
    historicalInspection
  } = useArchicodeStore(useShallow((state) => ({
    load: state.load,
    loading: state.loading,
    error: state.error,
    appNotice: state.appNotice,
    bundle: state.bundle,
    rootPath: state.rootPath,
    gitStatus: state.gitStatus,
    theme: state.theme,
    uiScale: state.uiScale,
    handleRunUpdated: state.handleRunUpdated,
    handleResearchChatSessionUpdated: state.handleResearchChatSessionUpdated,
    handleExternalProjectUpdated: state.handleExternalProjectUpdated,
    researchPanelOpen: state.researchPanelOpen,
    openResearchPanel: state.openResearchPanel,
    closeResearchPanel: state.closeResearchPanel,
    workbenchView: state.workbenchView,
    setWorkbenchView: state.setWorkbenchView,
    undoPresentationAction: state.undoPresentationAction,
    redoPresentationAction: state.redoPresentationAction,
    dismissAppNotice: state.dismissAppNotice,
    toggleTheme: state.toggleTheme,
    reload: state.reload,
    createResearchChat: state.createResearchChat,
    loadKeybindings: state.loadKeybindings,
    keybindings: state.keybindings,
    openProjectSettings: state.openProjectSettings,
    loadGlobalSpeechSettings: state.loadGlobalSpeechSettings,
    loadGlobalTtsSettings: state.loadGlobalTtsSettings,
    loadGlobalVoiceSettings: state.loadGlobalVoiceSettings,
    loadGlobalCodeIdeSettings: state.loadGlobalCodeIdeSettings,
    historicalInspection: state.historicalInspection
  })));
  const [activityOpen, setActivityOpen] = useState(true);
  const [leftPanelWidth, setLeftPanelWidth] = useState(defaultSidePanelWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState(defaultSidePanelWidth);
  const [rightSidebarTab, setRightSidebarTab] = useState<RightSidebarTab>("chat");
  const [propertiesLabelShineKey, setPropertiesLabelShineKey] = useState(0);
  const [activityHeight, setActivityHeight] = useState(defaultActivityHeight);
  const [stickyError, setStickyError] = useState<StickyErrorNotice | null>(null);
  const [collapsedPanels, setCollapsedPanels] = useState<Record<"sidebar" | "inspector", boolean>>({
    sidebar: false,
    inspector: false
  });
  const [focusMode, setFocusMode] = useState(false);
  const [chatFocusMode, setChatFocusMode] = useState(false);
  const [projectLauncherOpen, setProjectLauncherOpen] = useState(false);
  const [, setLocaleRevision] = useState(0);
  const [panelLayouts, setPanelLayouts] = useState<Record<PanelId, FloatingPanelLayout>>(defaultPanelLayouts);
  const dismissedErrorMessageRef = useRef<string | null>(null);
  const manualActivityOverrideRef = useRef(false);
  const focusModeSnapshotRef = useRef<FocusModeSnapshot | null>(null);
  const appShellRef = useRef<HTMLElement | null>(null);
  const hasProject = Boolean(bundle);
  const activityNeedsAttention = Boolean(bundle && (
    bundle.runs.some(isRunBlockingNewChange) ||
    collectRunErrors(bundle.runs).length > 0 ||
    bundle.notes.some((note) => note.kind === "llm-question" && !note.resolved)
  ));

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadKeybindings();
  }, [loadKeybindings]);

  useEffect(() => {
    if (!window.archicode?.getLocale || !window.archicode?.onLocaleChanged) return;
    let disposed = false;
    void window.archicode.getLocale().then((locale) => {
      if (!disposed) void applyRendererLocale(locale).then(() => setLocaleRevision((revision) => revision + 1));
    });
    const unsubscribe = window.archicode.onLocaleChanged((locale) => {
      if (!disposed) void applyRendererLocale(locale).then(() => setLocaleRevision((revision) => revision + 1));
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    void loadGlobalSpeechSettings();
    void loadGlobalTtsSettings();
    void loadGlobalVoiceSettings();
    void loadGlobalCodeIdeSettings();
  }, [loadGlobalCodeIdeSettings, loadGlobalSpeechSettings, loadGlobalTtsSettings, loadGlobalVoiceSettings]);

  useEffect(() => {
    const onOpenPreferences = () => window.dispatchEvent(new CustomEvent("archicode:open-project-settings", { detail: { tab: "general" } }));
    window.addEventListener("archicode:open-preferences", onOpenPreferences);
    return () => window.removeEventListener("archicode:open-preferences", onOpenPreferences);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const projectName = bundle?.project.name.trim();
    document.title = projectName ? `${projectName} — ArchiCode` : "ArchiCode";
  }, [bundle?.project.name]);

  useEffect(() => {
    document.body.style.removeProperty("zoom");
    if (window.archicode?.setZoomFactor) {
      window.archicode.setZoomFactor(uiScale / 100);
      return;
    }
    document.body.style.setProperty("zoom", `${uiScale}%`);
  }, [uiScale]);

  useEffect(() => {
    if (!window.archicode?.onRunUpdated) return;
    return window.archicode.onRunUpdated(handleRunUpdated);
  }, [handleRunUpdated]);

  useEffect(() => {
    if (!window.archicode?.onResearchChatSessionUpdated) return;
    return window.archicode.onResearchChatSessionUpdated(handleResearchChatSessionUpdated);
  }, [handleResearchChatSessionUpdated]);

  useEffect(() => {
    if (!window.archicode?.onExternalProjectUpdated) return;
    return window.archicode.onExternalProjectUpdated(handleExternalProjectUpdated);
  }, [handleExternalProjectUpdated]);

  useEffect(() => {
    observedGitHeadRef.current = {
      rootPath,
      hash: gitStatus?.recentCommits[0]?.hash ?? null
    };
  }, [rootPath, gitStatus?.recentCommits]);

  useEffect(() => {
    if (!rootPath || !window.archicode?.getGitStatus) return;
    let disposed = false;
    let checking = false;
    const checkForExternalGitUpdate = async () => {
      if (disposed || checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const nextStatus = await window.archicode.getGitStatus(rootPath);
        if (disposed || !nextStatus.isRepo) return;
        const nextHash = nextStatus.recentCommits[0]?.hash ?? null;
        const observed = observedGitHeadRef.current;
        if (!observed || observed.rootPath !== rootPath || !observed.hash) {
          observedGitHeadRef.current = { rootPath, hash: nextHash };
          return;
        }
        if (nextHash && nextHash !== observed.hash) {
          const current = useArchicodeStore.getState();
          if (current.bundle?.runs.some(isRunBlockingNewChange)) return;
          observedGitHeadRef.current = { rootPath, hash: nextHash };
          await current.reload();
        }
      } catch {
        // Git status errors are surfaced by the Git panel; background detection stays quiet.
      } finally {
        checking = false;
      }
    };
    const interval = window.setInterval(() => void checkForExternalGitUpdate(), 4000);
    const onFocus = () => void checkForExternalGitUpdate();
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [rootPath]);

  useEffect(() => {
    if (!window.archicode?.onDirectUndoRequested) return;
    return window.archicode.onDirectUndoRequested(() => {
      void undoPresentationAction();
    });
  }, [undoPresentationAction]);

  useEffect(() => {
    if (!window.archicode?.onDirectRedoRequested) return;
    return window.archicode.onDirectRedoRequested(() => {
      void redoPresentationAction();
    });
  }, [redoPresentationAction]);

  useEffect(() => {
    if (!error) {
      dismissedErrorMessageRef.current = null;
      return;
    }
    if (dismissedErrorMessageRef.current === error) return;
    setStickyError((current) => current?.message === error
      ? current
      : {
          message: error,
          details: error,
          raisedAt: Date.now()
        });
  }, [dismissedErrorMessageRef, error]);

  // A latched error banner belongs to the project it was raised in; clear it
  // when the active project changes so it does not carry over to a new project.
  useEffect(() => {
    setStickyError(null);
    dismissedErrorMessageRef.current = null;
  }, [rootPath]);

  useLayoutEffect(() => {
    if (!rootPath) return;
    setRightSidebarTab("chat");
    void openResearchPanel();
    try {
      const raw = localStorage.getItem(layoutStorageKey(rootPath));
      if (!raw) {
        setActivityOpen(true);
        return;
      }
      const saved = JSON.parse(raw) as Partial<StoredLayout>;
      if (typeof saved.activityOpen === "boolean") setActivityOpen(saved.activityOpen);
      if (typeof saved.leftPanelWidth === "number") setLeftPanelWidth(saved.leftPanelWidth);
      if (typeof saved.rightPanelWidth === "number") setRightPanelWidth(saved.rightPanelWidth);
      if (typeof saved.activityHeight === "number") setActivityHeight(saved.activityHeight);
      if (saved.collapsedPanels) setCollapsedPanels(saved.collapsedPanels);
      if (saved.panelLayouts) setPanelLayouts({ ...defaultPanelLayouts, ...saved.panelLayouts });
    } catch {
      // Ignore malformed local layout state.
    }
  }, [closeResearchPanel, openResearchPanel, rootPath]);

  useEffect(() => {
    if (!rootPath) return;
    const persistedSnapshot = focusModeSnapshotRef.current;
    const layout: StoredLayout = {
      activityOpen: focusMode ? persistedSnapshot?.activityOpen ?? activityOpen : activityOpen,
      leftPanelWidth,
      rightPanelWidth,
      researchPanelOpen,
      rightSidebarTab,
      activityHeight,
      collapsedPanels: focusMode ? persistedSnapshot?.collapsedPanels ?? collapsedPanels : collapsedPanels,
      panelLayouts
    };
    localStorage.setItem(layoutStorageKey(rootPath), JSON.stringify(layout));
  }, [activityHeight, activityOpen, collapsedPanels, focusMode, leftPanelWidth, panelLayouts, researchPanelOpen, rightPanelWidth, rightSidebarTab, rootPath]);

  useEffect(() => {
    manualActivityOverrideRef.current = false;
  }, [rootPath]);

  useEffect(() => {
    setFocusMode(false);
    setChatFocusMode(false);
    focusModeSnapshotRef.current = null;
  }, [rootPath]);

  useEffect(() => {
    if (researchPanelOpen) setRightSidebarTab("chat");
  }, [researchPanelOpen]);

  useEffect(() => {
    if (!hasProject) return;
    if (focusMode) return;
    if (activityNeedsAttention && !activityOpen) {
      manualActivityOverrideRef.current = false;
      setActivityOpen(true);
      return;
    }
  }, [activityNeedsAttention, activityOpen, focusMode, hasProject]);

  const toggleFocusMode = useCallback(async () => {
    if (!hasProject) {
      await window.archicode?.maximizeWindow?.();
      return;
    }
    if (chatFocusMode) {
      setChatFocusMode(false);
      return;
    }
    if (!focusMode) {
      focusModeSnapshotRef.current = {
        activityOpen,
        collapsedPanels: { ...collapsedPanels },
        workbenchView
      };
      setFocusMode(true);
      manualActivityOverrideRef.current = true;
      setActivityOpen(false);
      setCollapsedPanels({ sidebar: true, inspector: true });
      await window.archicode?.maximizeWindow?.();
      return;
    }
    const snapshot = focusModeSnapshotRef.current;
    setFocusMode(false);
    focusModeSnapshotRef.current = null;
    if (snapshot) {
      manualActivityOverrideRef.current = !snapshot.activityOpen;
      setActivityOpen(snapshot.activityOpen);
      setCollapsedPanels(snapshot.collapsedPanels);
    }
  }, [activityOpen, chatFocusMode, collapsedPanels, focusMode, hasProject, workbenchView]);

  const toggleChatFocusMode = useCallback(async () => {
    if (!hasProject) return;
    if (chatFocusMode) {
      setChatFocusMode(false);
      return;
    }
    if (focusMode) await toggleFocusMode();
    setRightSidebarTab("chat");
    await openResearchPanel();
    setChatFocusMode(true);
    await window.archicode?.maximizeWindow?.();
  }, [chatFocusMode, focusMode, hasProject, openResearchPanel, toggleFocusMode]);

  useEffect(() => {
    if (!researchPanelOpen && chatFocusMode) setChatFocusMode(false);
  }, [chatFocusMode, researchPanelOpen]);

  useEffect(() => {
    if (!focusMode || workbenchView !== "graph" || focusModeSnapshotRef.current?.workbenchView !== "files") return;
    void toggleFocusMode();
  }, [focusMode, toggleFocusMode, workbenchView]);

  useEffect(() => {
    const handler = () => {
      void toggleFocusMode();
    };
    window.addEventListener("archicode:toggle-focus-mode", handler);
    return () => window.removeEventListener("archicode:toggle-focus-mode", handler);
  }, [toggleFocusMode]);

  useEffect(() => {
    const inputTagExpression = "INPUT, TEXTAREA, SELECT, BUTTON, [contenteditable='true'], [role='combobox']";
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(target.closest(inputTagExpression));
    };
    const triggerActivityTab = (value: string) => {
      window.dispatchEvent(new CustomEvent("archicode:set-activity-tab", { detail: value }));
    };
    const toggleActivity = () => {
      manualActivityOverrideRef.current = true;
      setActivityOpen((open) => !open);
    };
    const resetLayoutNow = () => {
      if (rootPath) {
        localStorage.removeItem(layoutStorageKey(rootPath));
        localStorage.removeItem(`archicode-activity-tab:${rootPath}`);
        localStorage.removeItem(`archicode-workbench:${rootPath}`);
        localStorage.removeItem(`archicode-viewport:${rootPath}`);
      }
      setFocusMode(false);
      setChatFocusMode(false);
      focusModeSnapshotRef.current = null;
      setActivityOpen(true);
      setLeftPanelWidth(defaultSidePanelWidth);
      setRightPanelWidth(defaultSidePanelWidth);
      setRightSidebarTab("properties");
      setActivityHeight(defaultActivityHeight);
      setCollapsedPanels({ sidebar: false, inspector: false });
      setPanelLayouts(defaultPanelLayouts);
      closeResearchPanel();
    };
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const isTyping = isTypingTarget(event.target);
      const check = (id: keyof typeof keybindings) => {
        const chord = keybindings[id];
        return chord ? chordMatches(chord, event) : false;
      };
      if (check("project.openPreferences")) {
        event.preventDefault();
        openProjectSettings("shortcuts");
        return;
      }
      if (check("project.openHelp")) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("archicode:open-help"));
        return;
      }
      if (check("project.toggleTheme")) {
        event.preventDefault();
        toggleTheme();
        return;
      }
      if (check("project.toggleWorkbench")) {
        event.preventDefault();
        setWorkbenchView(workbenchView === "files" ? "graph" : "files");
        return;
      }
      if (check("project.toggleFocusMode")) {
        event.preventDefault();
        void toggleFocusMode();
        return;
      }
      if (check("project.toggleRuntimePanel")) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("archicode:toggle-runtime-panel"));
        return;
      }
      if (check("project.openGitPanel")) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("archicode:open-git"));
        return;
      }
      if (check("project.openPatchReview")) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("archicode:open-patch-review"));
        return;
      }
      if (check("project.resetLayout")) {
        event.preventDefault();
        resetLayoutNow();
        return;
      }
      if (check("activity.toggle")) {
        event.preventDefault();
        toggleActivity();
        return;
      }
      for (const [actionId, tabValue] of activityTabByAction) {
        if (chordMatches(keybindings[actionId as keyof typeof keybindings], event)) {
          event.preventDefault();
          if (!activityOpen) toggleActivity();
          triggerActivityTab(tabValue);
          return;
        }
      }
      if (check("canvas.reload")) {
        event.preventDefault();
        if (bundle) void reload();
        return;
      }
      if (check("project.toggleChat")) {
        event.preventDefault();
        if (!researchPanelOpen) void openResearchPanel();
        else closeResearchPanel();
        return;
      }
      if (check("project.openProperties")) {
        event.preventDefault();
        setRightSidebarTab("properties");
        closeResearchPanel();
        return;
      }
      if (check("chat.newResearchChat") && !isTyping && bundle) {
        event.preventDefault();
        void createResearchChat();
        if (!researchPanelOpen) void openResearchPanel();
        return;
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown, true);
    };
  }, [activityOpen, bundle, closeResearchPanel, createResearchChat, keybindings, openProjectSettings, openResearchPanel, reload, researchPanelOpen, rootPath, setWorkbenchView, toggleFocusMode, toggleTheme, workbenchView]);

  if (loading) {
    return (
      <main className="loading-screen">
        <h1>{t("ArchiCode")}</h1>
        <p>{t("Loading the visual harness and JSON project model...")}</p>
      </main>
    );
  }

  const startHorizontalResize = (side: "left" | "right") => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    let nextWidth = side === "left" ? leftPanelWidth : rightPanelWidth;
    const onMove = (moveEvent: PointerEvent) => {
      if (side === "left") {
        nextWidth = Math.min(520, Math.max(220, moveEvent.clientX));
        appShellRef.current?.style.setProperty("--left-panel-width", `${nextWidth}px`);
      } else {
        nextWidth = Math.min(640, Math.max(280, window.innerWidth - moveEvent.clientX));
        appShellRef.current?.style.setProperty("--right-panel-width", `${nextWidth}px`);
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (side === "left") setLeftPanelWidth(nextWidth);
      else setRightPanelWidth(nextWidth);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startActivityResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    let nextHeight = activityHeight;
    const activityPanel = appShellRef.current?.querySelector<HTMLElement>(".dock-slot-activity .activity-panel") ?? null;
    const onMove = (moveEvent: PointerEvent) => {
      nextHeight = Math.min(560, Math.max(140, window.innerHeight - moveEvent.clientY));
      if (activityPanel) activityPanel.style.height = `${nextHeight}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setActivityHeight(nextHeight);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const setPanelDocked = (panel: PanelId, docked: boolean) => {
    setPanelLayouts((current) => ({
      ...current,
      [panel]: { ...current[panel], docked }
    }));
    if (panel === "sidebar" || panel === "inspector") {
      setCollapsedPanels((current) => ({ ...current, [panel]: false }));
    }
  };

  const collapsePanel = (panel: "sidebar" | "inspector") => {
    setCollapsedPanels((current) => ({ ...current, [panel]: true }));
  };

  const restorePanel = (panel: "sidebar" | "inspector") => {
    setCollapsedPanels((current) => ({ ...current, [panel]: false }));
    setPanelDocked(panel, true);
  };

  const resetLayout = () => {
    if (rootPath) {
      localStorage.removeItem(layoutStorageKey(rootPath));
      localStorage.removeItem(`archicode-activity-tab:${rootPath}`);
      localStorage.removeItem(`archicode-workbench:${rootPath}`);
      localStorage.removeItem(`archicode-viewport:${rootPath}`);
    }
    setFocusMode(false);
    setChatFocusMode(false);
    focusModeSnapshotRef.current = null;
    setActivityOpen(true);
    setLeftPanelWidth(defaultSidePanelWidth);
    setRightPanelWidth(defaultSidePanelWidth);
    setRightSidebarTab("properties");
    setActivityHeight(defaultActivityHeight);
    setCollapsedPanels({ sidebar: false, inspector: false });
    setPanelLayouts(defaultPanelLayouts);
    closeResearchPanel();
  };

  const startFloatingDrag = (panel: PanelId) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = panelLayouts[panel];
    const floatingPanel = event.currentTarget.closest<HTMLElement>(".floating-panel");
    let nextX = initial.x;
    let nextY = initial.y;
    const onMove = (moveEvent: PointerEvent) => {
      nextX = clamp(initial.x + moveEvent.clientX - startX, 8, window.innerWidth - 180);
      nextY = clamp(initial.y + moveEvent.clientY - startY, 38, window.innerHeight - 120);
      if (floatingPanel) {
        floatingPanel.style.left = `${nextX}px`;
        floatingPanel.style.top = `${nextY}px`;
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setPanelLayouts((current) => ({
        ...current,
        [panel]: { ...current[panel], x: nextX, y: nextY }
      }));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const renderDetachButton = (panel: PanelId, label: string) => (
    <IconButton
      type="button"
      className="panel-dock-button"
      onClick={() => setPanelDocked(panel, false)}
      title={t("Detach {{label}}", { label: label })}
    >
      <PictureInPicture2 size={14} />
    </IconButton>
  );

  const renderDockedSidePanelActions = (panel: "sidebar" | "inspector", label: string) => (
    <div className="panel-inline-actions">
      <IconButton
        type="button"
        className="panel-dock-button"
        onClick={() => collapsePanel(panel)}
        title={t("Collapse {{label}}", { label: label })}
      >
        {panel === "sidebar" ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </IconButton>
      {renderDetachButton(panel, label)}
    </div>
  );

  const selectRightSidebarTab = (tab: RightSidebarTab) => {
    setRightSidebarTab(tab);
    if (tab === "chat") {
      void openResearchPanel();
    } else {
      setChatFocusMode(false);
      closeResearchPanel();
    }
  };

  const shinePropertiesTabForCanvasSelection = () => {
    if (rightSidebarTab !== "properties") setPropertiesLabelShineKey((key) => key + 1);
  };

  const restoreRightSidebar = () => {
    restorePanel("inspector");
  };

  const toggleActivityOpen = () => {
    manualActivityOverrideRef.current = true;
    setActivityOpen((open) => !open);
  };

  const projectWorkspaceVisible = hasProject && !projectLauncherOpen;
  const chatFocusActive = projectWorkspaceVisible && chatFocusMode;
  const sidebarDocked = projectWorkspaceVisible && !focusMode && !chatFocusActive && panelLayouts.sidebar.docked && !collapsedPanels.sidebar;
  const activityDocked = projectWorkspaceVisible && !chatFocusActive && panelLayouts.activity.docked;
  const inspectorDocked = projectWorkspaceVisible && (chatFocusActive || (!focusMode && panelLayouts.inspector.docked && !collapsedPanels.inspector));
  const sidebarFloating = projectWorkspaceVisible && !focusMode && !chatFocusActive && !panelLayouts.sidebar.docked && !collapsedPanels.sidebar;
  const inspectorFloating = projectWorkspaceVisible && !focusMode && !chatFocusActive && !panelLayouts.inspector.docked && !collapsedPanels.inspector;
  const dismissStickyError = () => {
    dismissedErrorMessageRef.current = stickyError?.message ?? null;
    setStickyError(null);
  };

  return (
    <TooltipProvider>
      <main
        ref={appShellRef}
        className={["app-shell", chatFocusActive ? "chat-focus-mode" : "", historicalInspection ? "is-historical" : ""].filter(Boolean).join(" ")}
        style={{
          "--left-panel-width": `${leftPanelWidth}px`,
          "--right-panel-width": `${rightPanelWidth}px`,
          gridTemplateColumns: chatFocusActive
            ? "0px 0px 0px 0px minmax(0, 1fr)"
            : [
                sidebarDocked ? "var(--left-panel-width)" : "0px",
                sidebarDocked ? "4px" : "0px",
                "minmax(0, 1fr)",
                inspectorDocked ? "4px" : "0px",
                inspectorDocked ? "var(--right-panel-width)" : "0px"
              ].join(" ")
        } as CSSProperties}
      >
        {sidebarDocked ? (
          <DockedPanel panel="sidebar" label={t("Project Sidebar")} renderDetachButton={renderDetachButton} panelActionInContent>
            <ProjectSidebar
              panelAction={renderDockedSidePanelActions("sidebar", "Project Sidebar")}
              onOpenProjectLauncher={() => setProjectLauncherOpen(true)}
            />
          </DockedPanel>
        ) : null}
        {sidebarDocked ? (
          <div
            className="panel-resizer vertical panel-resizer-left"
            role="separator"
            aria-label={t("Resize project sidebar")}
            onPointerDown={startHorizontalResize("left")}
          />
        ) : null}
        <div className="workbench">
          {bundle?.validationErrors.length ? (
            <ExpandableBanner
              title={t("JSON validation")}
              message={bundle.validationErrors.join(" | ")}
              details={bundle.validationErrors.join(" | ")}
              detailsTitle={t("JSON validation details")}
            />
          ) : null}
          {stickyError ? (
            <ExpandableBanner
              title={t("Error")}
              message={stickyError.message}
              details={stickyError.details}
              detailsTitle={t("Error details")}
              detailsDescription={formatDateTime(new Date(stickyError.raisedAt))}
              tone="error"
              role="alert"
              onDismiss={dismissStickyError}
            />
          ) : null}
          {appNotice ? (
            <ExpandableBanner
              title={appNotice.title}
              message={appNotice.message}
              details={appNotice.message}
              detailsTitle={t("{{title}} details", { title: appNotice.title })}
              tone={appNotice.tone}
              role="alert"
              onDismiss={dismissAppNotice}
            />
          ) : null}
          {bundle && !projectLauncherOpen ? (
            <>
              {historicalInspection ? <GraphHistoryBar /> : null}
              <ProjectToolbar
                onResetLayout={resetLayout}
                onRestoreRightSidebar={restoreRightSidebar}
                onToggleResearchPanel={() => {
                  if (rightSidebarTab === "chat" && researchPanelOpen) selectRightSidebarTab("properties");
                  else {
                    if (collapsedPanels.inspector) restorePanel("inspector");
                    selectRightSidebarTab("chat");
                  }
                }}
                researchPanelActive={rightSidebarTab === "chat" && researchPanelOpen}
                rightSidebarCollapsed={focusMode ? false : collapsedPanels.inspector}
              />
              {workbenchView === "files" ? (
                <ProjectFileBrowser
                  expanded={focusMode}
                  onToggleExpanded={() => void toggleFocusMode()}
                />
              ) : <FlowCanvas onNodeSelected={shinePropertiesTabForCanvasSelection} />}
              {!focusMode && activityOpen && activityDocked ? (
                <div
                  className="panel-resizer horizontal"
                  role="separator"
                  aria-label={t("Resize activity panel")}
                  onPointerDown={startActivityResize}
                />
              ) : null}
              {!focusMode && activityDocked ? (
                <DockedPanel panel="activity" label={t("Activity Panel")} renderDetachButton={renderDetachButton} panelActionInContent>
                  <SettingsAndRuns
                    open={activityOpen}
                    height={activityHeight}
                    onToggleOpen={toggleActivityOpen}
                    panelAction={(
                      renderDetachButton("activity", "Activity Panel")
                    )}
                  />
                </DockedPanel>
              ) : null}
            </>
          ) : (
            <WelcomeScreen onReturnToProject={bundle ? () => setProjectLauncherOpen(false) : undefined} />
          )}
        </div>
        {inspectorDocked && !chatFocusActive ? (
          <div
            className="panel-resizer vertical panel-resizer-right"
            role="separator"
            aria-label={t("Resize node inspector")}
            onPointerDown={startHorizontalResize("right")}
          />
        ) : null}
        {inspectorDocked ? (
          <DockedPanel panel="inspector" label={t("Right Sidebar")} renderDetachButton={renderDetachButton} panelActionInContent>
            <UnifiedRightSidebar
              activeTab={rightSidebarTab}
              onActiveTabChange={selectRightSidebarTab}
              propertiesLabelShineKey={propertiesLabelShineKey}
              panelAction={chatFocusActive ? undefined : renderDockedSidePanelActions("inspector", "Right Sidebar")}
              chatFocusMode={chatFocusActive}
              onToggleChatFocusMode={toggleChatFocusMode}
            />
          </DockedPanel>
        ) : null}
        {projectWorkspaceVisible && !focusMode && collapsedPanels.sidebar ? (
          <IconButton
            type="button"
            className="collapsed-panel-restore collapsed-panel-restore-left"
            onClick={() => restorePanel("sidebar")}
            title={t("Show project sidebar")}
          >
            <ChevronRight size={16} />
          </IconButton>
        ) : null}
        {sidebarFloating ? (
          <FloatingPanel
            panel="sidebar"
            label={t("Project Sidebar")}
            layout={panelLayouts.sidebar}
            onDock={() => setPanelDocked("sidebar", true)}
            onTitlebarPointerDown={startFloatingDrag("sidebar")}
          >
            <ProjectSidebar onOpenProjectLauncher={() => setProjectLauncherOpen(true)} />
          </FloatingPanel>
        ) : null}
        {projectWorkspaceVisible && !focusMode && !chatFocusActive && !activityDocked ? (
          <FloatingPanel
            panel="activity"
            label={t("Activity Panel")}
            layout={panelLayouts.activity}
            onDock={() => setPanelDocked("activity", true)}
            onTitlebarPointerDown={startFloatingDrag("activity")}
          >
            <SettingsAndRuns
              open
              height={panelLayouts.activity.height - 35}
              onToggleOpen={toggleActivityOpen}
              showCollapseControl={false}
            />
          </FloatingPanel>
        ) : null}
        {inspectorFloating ? (
          <FloatingPanel
            panel="inspector"
            label={t("Right Sidebar")}
            layout={panelLayouts.inspector}
            onDock={() => setPanelDocked("inspector", true)}
            onTitlebarPointerDown={startFloatingDrag("inspector")}
          >
            <UnifiedRightSidebar
              activeTab={rightSidebarTab}
              onActiveTabChange={selectRightSidebarTab}
              propertiesLabelShineKey={propertiesLabelShineKey}
              onToggleChatFocusMode={toggleChatFocusMode}
            />
          </FloatingPanel>
        ) : null}
        <PermissionModal />
        <BuildQuestionCheck />
        <CodebaseOnboardingWizard />
      </main>
    </TooltipProvider>
  );
}
