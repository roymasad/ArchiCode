import { formatDateTime } from "@renderer/i18n";
import { t } from "@renderer/i18n";
import { Archive, FileDiff, GitBranch, GitCommit, GitPullRequestArrow, Loader2, Plus, RefreshCw, SendHorizontal, Sparkles, Trash2, Undo2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { isConflictedGitFileStatus, type GitFileStatus, type ProjectFileDiff } from "@shared/projectTools";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { Badge, Button, DialogContent, DialogRoot, DialogTrigger, Field, IconButton, ScrollArea, Select, TextArea, TextInput, Tooltip } from "./ui";

const gitScopeHelp = "ArchiCode supports a small Git subset: local init, status, selected-file commits, pull, push, switching or creating local branches, and discard. Use your Git client or terminal for remotes, merge, rebase, conflict resolution, tags, and stashes.";
const initGitHelp = "Creates a local .git repository in this project folder. This does not create a GitHub repository, add a remote, publish code, make an initial commit, or configure branch strategy.";

function statusText(change: GitFileStatus): string {
  if (isConflictedGitFileStatus(change)) return "conflict — needs resolution";
  if (change.index === "?" && change.workingTree === "?") return "untracked";
  if (change.index === "D" || change.workingTree === "D") return "deleted";
  if (change.index === "R") return "renamed";
  if (change.index !== " " && change.workingTree !== " ") return "staged + modified";
  if (change.index !== " ") return "staged";
  return "modified";
}

function diffLineClassName(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "diff-line diff-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "diff-line diff-remove";
  if (line.startsWith("@@")) return "diff-line diff-hunk";
  if (line.startsWith("#")) return "diff-line diff-note";
  return "diff-line";
}

function ChangeLineCounts({ change }: { change: GitFileStatus }) {
  const additions = change.additions ?? 0;
  const deletions = change.deletions ?? 0;
  if (!additions && !deletions) return null;
  return (
    <span className="git-line-counts" aria-label={t("{{additions}} lines added, {{deletions}} lines removed", { additions: additions, deletions: deletions })}>
      {additions ? <span className="git-lines-added">{t("+ {{additions}}", { additions: additions })}</span> : null}
      {deletions ? <span className="git-lines-removed">{t("- {{deletions}}", { deletions: deletions })}</span> : null}
    </span>
  );
}

export function GitPanel() {
  const {
    rootPath,
    bundle,
    gitStatus,
    gitBusy,
    gitLogs,
    refreshGitStatus,
    runGitOperation,
    discardGitChanges,
    stashGitChanges,
    popGitStash,
    commitGitFiles,
    generateCommitMessage,
    switchGitBranch,
    createGitBranch,
    initializeGitRepository,
    startScopedResearchChat
  } = useArchicodeStore(useShallow((state) => ({
    rootPath: state.rootPath,
    bundle: state.bundle,
    gitStatus: state.gitStatus,
    gitBusy: state.gitBusy,
    gitLogs: state.gitLogs,
    refreshGitStatus: state.refreshGitStatus,
    runGitOperation: state.runGitOperation,
    discardGitChanges: state.discardGitChanges,
    stashGitChanges: state.stashGitChanges,
    popGitStash: state.popGitStash,
    commitGitFiles: state.commitGitFiles,
    generateCommitMessage: state.generateCommitMessage,
    switchGitBranch: state.switchGitBranch,
    createGitBranch: state.createGitBranch,
    initializeGitRepository: state.initializeGitRepository,
    startScopedResearchChat: state.startScopedResearchChat
  })));
  const [open, setOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [isGeneratingCommitMessage, setIsGeneratingCommitMessage] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [branchDraft, setBranchDraft] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [stashName, setStashName] = useState("ArchiCode manual stash");
  const [pendingStashBranch, setPendingStashBranch] = useState<string | null>(null);
  const [activeGitTool, setActiveGitTool] = useState<"switch" | "create" | "stash" | null>(null);
  const [diffOpenPath, setDiffOpenPath] = useState<string | null>(null);
  const [diffLoadingPath, setDiffLoadingPath] = useState<string | null>(null);
  const [diffCache, setDiffCache] = useState<Record<string, ProjectFileDiff>>({});
  const changedFiles = gitStatus?.changes ?? [];
  const recentCommits = gitStatus?.recentCommits ?? [];
  const stashes = gitStatus?.stashes ?? [];
  const branchOptions = useMemo(() => (gitStatus?.branches ?? []).map((branch) => ({ value: branch, label: branch })), [gitStatus]);

  useEffect(() => {
    if (open) void refreshGitStatus();
  }, [open, refreshGitStatus]);

  useEffect(() => {
    const onOpenGit = () => setOpen(true);
    window.addEventListener("archicode:open-git", onOpenGit);
    return () => window.removeEventListener("archicode:open-git", onOpenGit);
  }, []);

  useEffect(() => {
    setSelectedFiles((current) => current.filter((file) => changedFiles.some((change) => change.path === file)));
    setDiffOpenPath(null);
    setDiffCache({});
  }, [changedFiles]);

  useEffect(() => {
    if (gitStatus?.currentBranch) setBranchDraft(gitStatus.currentBranch);
  }, [gitStatus?.currentBranch]);

  const toggleFile = (path: string) => {
    setSelectedFiles((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  };

  const toggleDiff = async (path: string) => {
    if (diffOpenPath === path) {
      setDiffOpenPath(null);
      return;
    }
    setDiffOpenPath(path);
    if (diffCache[path] || !rootPath || !window.archicode?.readProjectFileDiff) return;
    setDiffLoadingPath(path);
    try {
      const diff = await window.archicode.readProjectFileDiff(rootPath, path);
      setDiffCache((current) => ({ ...current, [path]: diff }));
    } catch {
      setDiffCache((current) => ({ ...current, [path]: { path, diff: "" } }));
    } finally {
      setDiffLoadingPath(null);
    }
  };

  const commitMessageFiles = selectedFiles.length ? selectedFiles : changedFiles.map((change) => change.path);
  const canGenerateCommitMessage = Boolean(commitMessageFiles.length && !isGeneratingCommitMessage);

  const requestCommitMessage = async () => {
    if (!canGenerateCommitMessage) return;
    setIsGeneratingCommitMessage(true);
    try {
      const message = await generateCommitMessage(commitMessageFiles);
      if (message && message.trim()) setCommitMessage(message.trim());
    } finally {
      setIsGeneratingCommitMessage(false);
    }
  };

  const canCommit = Boolean(commitMessage.trim() && selectedFiles.length && gitStatus?.isRepo && !gitBusy);
  const currentBranch = gitStatus?.currentBranch ?? "no branch";
  const changedCount = gitStatus?.changes.length ?? 0;
  const canDiscardChanges = Boolean(changedCount && recentCommits.length && !gitBusy);
  const archicodeApi = window.archicode as unknown as Record<string, unknown> | undefined;
  const canUseStash = typeof archicodeApi?.gitStashChanges === "function" && typeof archicodeApi?.gitPopStash === "function";
  const canStashChanges = Boolean(changedCount && !gitBusy && canUseStash);
  const canInitializeGit = Boolean(window.archicode?.gitInit);
  const noRepoMessage = canInitializeGit
    ? `${gitStatus?.message ?? "This project folder is not currently a Git repository."} ArchiCode can create a local-only repo here; connect remotes or GitHub outside the app.`
    : "This running app window has not loaded local Git initialization yet. Restart ArchiCode to enable the button, or run git init in your terminal. Connect remotes or GitHub outside the app.";
  const askResearchAboutConflict = () => {
    if (!bundle) return;
    setOpen(false);
    void startScopedResearchChat(
      { type: "project", projectId: bundle.project.id },
      "Check if there's a merge conflict in the repo, and let me know what needs resolving."
    );
  };

  const confirmDiscardChanges = () => {
    const confirmed = window.confirm(
      "Discard all Git changes?\n\nThis will reset tracked files to HEAD and delete untracked files. This cannot be undone."
    );
    if (confirmed) void discardGitChanges();
  };

  const toggleGitTool = (tool: "switch" | "create" | "stash") => {
    setActiveGitTool((current) => {
      const next = current === tool ? null : tool;
      if (next !== "stash") setPendingStashBranch(null);
      return next;
    });
  };

  const runNamedStash = async (): Promise<void> => {
    const name = stashName.trim();
    if (!name) return;
    const targetBranch = pendingStashBranch;
    const stashed = await stashGitChanges(name);
    if (!stashed) return;
    setStashName("ArchiCode manual stash");
    setPendingStashBranch(null);
    if (targetBranch) await switchGitBranch(targetBranch);
  };

  const requestBranchSwitch = async (branch: string) => {
    if (!gitStatus || !branch || branch === gitStatus.currentBranch) return;
    if (gitStatus.changes.length) {
      if (!canUseStash) {
        window.alert("Restart ArchiCode to load Git stash support before switching branches with uncommitted changes.");
        setBranchDraft(gitStatus.currentBranch ?? "");
        return;
      }
      setPendingStashBranch(branch);
      setStashName(`ArchiCode branch switch: ${gitStatus.currentBranch ?? "unknown"} -> ${branch}`);
      setActiveGitTool("stash");
      setBranchDraft(gitStatus.currentBranch ?? "");
      return;
    }
    await switchGitBranch(branch);
  };

  return (
    <DialogRoot open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <IconButton title={t("Open Git")} className="toolbar-git-button">
          <GitBranch size={16} />
          {changedCount ? <span className="toolbar-git-count">{changedCount}</span> : null}
        </IconButton>
      </DialogTrigger>
      <DialogContent
        title={t("Git")}
        description={t("Basic Git controls for local project work. Use your Git client or terminal for advanced flows such as remotes, merge, rebase, conflict resolution, tags, and stashes.")}
        className={gitStatus?.isRepo ? "git-dialog is-populated" : "git-dialog"}
        draggable
        resizable
      >
        {!rootPath ? (
          <strong>{t("No project open.")}</strong>
        ) : !gitStatus?.isRepo ? (
          <div className="git-empty-state">
            <strong>{t("No Git repository found.")}</strong>
            <p>{noRepoMessage}</p>
            <div className="git-empty-actions">
              <Tooltip content={canInitializeGit ? initGitHelp : t("Restart ArchiCode to load the local Git initialization bridge for this app window.")}>
                <span className="git-empty-action">
                  <Button type="button" variant="primary" onClick={() => void initializeGitRepository()} disabled={gitBusy || !canInitializeGit}>
                    <GitBranch size={14} />
                    <span>{t("Initialize local Git")}</span>
                  </Button>
                </span>
              </Tooltip>
              <Button type="button" onClick={() => void refreshGitStatus()} disabled={gitBusy}>
                <RefreshCw size={14} />
                <span>{t("Check again")}</span>
              </Button>
            </div>
          </div>
        ) : (
          <div className="git-panel">
            <section className="git-summary-row">
              <div>
                <span className="ui-eyebrow">{t("Branch")}</span>
                <strong>{currentBranch}</strong>
                {gitStatus.upstream ? <small>{gitStatus.upstream}</small> : null}
              </div>
              <div className="git-summary-badges">
                <Badge>{t("{{changedCount}} changed", { changedCount: changedCount })}</Badge>
                <Tooltip content={gitScopeHelp}>
                  <span>
                    <Badge>{t("basic Git")}</Badge>
                  </span>
                </Tooltip>
                {gitStatus.ahead ? <Badge tone="accent">{t("ahead {{ahead}}", { ahead: gitStatus.ahead })}</Badge> : null}
                {gitStatus.behind ? <Badge tone="warning">{t("behind {{behind}}", { behind: gitStatus.behind })}</Badge> : null}
              </div>
            </section>

            {gitStatus.merging ? (
              <section className="git-merge-banner">
                <strong>{t("Merge in progress")}</strong>
                <p>
                  {changedFiles.some(isConflictedGitFileStatus)
                    ? t("Some files still have unresolved conflicts (marked below). Resolve them in your Git client, terminal, or ask Solomon — Merge Arbiter through Research chat, then commit here to finish the merge.")
                    : t("All conflicts are resolved and staged. Commit below to finish the merge.")}
                </p>
              </section>
            ) : null}

            <section className="git-action-grid">
              <Button type="button" size="sm" onClick={() => void refreshGitStatus()} disabled={gitBusy}>
                <RefreshCw size={15} />
                <span>{t("Refresh")}</span>
              </Button>
              <Button type="button" size="sm" onClick={() => void runGitOperation("pull")} disabled={gitBusy}>
                <GitPullRequestArrow size={15} />
                <span>{t("Pull")}</span>
              </Button>
              <Button type="button" size="sm" onClick={() => void runGitOperation("push")} disabled={gitBusy}>
                <SendHorizontal size={15} />
                <span>{t("Push")}</span>
              </Button>
              <Button type="button" size="sm" onClick={() => toggleGitTool("switch")} disabled={!branchOptions.length}>
                <GitBranch size={15} />
                <span>{t("Switch")}</span>
              </Button>
              <Button type="button" size="sm" onClick={() => toggleGitTool("create")}>
                <Plus size={15} />
                <span>{t("Branch")}</span>
              </Button>
              <Button type="button" size="sm" onClick={() => toggleGitTool("stash")}>
                <Archive size={15} />
                <span>{t("Stashes {{value1}}", { value1: stashes.length ? `(${stashes.length})` : "" })}</span>
              </Button>
              <Button type="button" size="sm" variant="danger" onClick={confirmDiscardChanges} disabled={!canDiscardChanges}>
                <Trash2 size={15} />
                <span>{t("Disregard changes")}</span>
              </Button>
            </section>

            {activeGitTool === "switch" && branchOptions.length ? (
              <section className="git-branch-box">
                <Field label={t("Switch branch")} hint={t("Only local branches are shown. Branch changes reload the project data from disk. Merge, rebase, resolve conflicts, and manage remotes in your Git client or terminal.")}>
                  <div className="git-branch-row">
                    <Select value={branchDraft} onValueChange={setBranchDraft} options={branchOptions} />
                    <Button
                      type="button"
                      onClick={() => void requestBranchSwitch(branchDraft)}
                      disabled={gitBusy || !branchDraft || branchDraft === gitStatus.currentBranch}
                    >
                      <GitBranch size={14} />
                      <span>{t("Switch")}</span>
                    </Button>
                  </div>
                </Field>
              </section>
            ) : null}

            {activeGitTool === "create" ? (
              <section className="git-branch-box">
                <Field label={t("Create branch")}>
                  <div className="git-branch-row">
                    <TextInput
                      value={newBranchName}
                      onChange={(event) => setNewBranchName(event.target.value)}
                      placeholder={t("feature/my-change")}
                      disabled={gitBusy}
                    />
                    <Button
                      type="button"
                      onClick={() => {
                        const branch = newBranchName.trim();
                        if (!branch) return;
                        void createGitBranch(branch);
                        setNewBranchName("");
                      }}
                      disabled={gitBusy || !newBranchName.trim()}
                    >
                      <Plus size={14} />
                      <span>{t("Create")}</span>
                    </Button>
                  </div>
                </Field>
              </section>
            ) : null}

            {activeGitTool === "stash" ? (
              <section className="git-stash-box">
                <div className="git-section-head">
                  <span className="ui-eyebrow">{t("Stashes")}</span>
                  <div className="git-stash-head-actions">
                    <Badge>{stashes.length}</Badge>
                  </div>
                </div>
                <div className="git-stash-create-row">
                  <TextInput
                    value={stashName}
                    onChange={(event) => setStashName(event.target.value)}
                    placeholder={t("Name this stash")}
                    disabled={gitBusy || !canUseStash}
                  />
                  <Tooltip content={canUseStash ? t("Stash current uncommitted changes.") : t("Restart ArchiCode to load Git stash support in this app window.")}>
                    <span className="git-stash-action-wrap">
                      <Button type="button" size="sm" onClick={() => void runNamedStash()} disabled={!canStashChanges || !stashName.trim()}>
                        <Archive size={14} />
                        <span>{pendingStashBranch ? t("Stash and switch") : t("Stash changes")}</span>
                      </Button>
                    </span>
                  </Tooltip>
                  {pendingStashBranch ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setPendingStashBranch(null);
                        setStashName("ArchiCode manual stash");
                      }}
                    >
                      <span>{t("Cancel switch")}</span>
                    </Button>
                  ) : null}
                </div>
                {pendingStashBranch ? (
                  <small>{t("Stash these changes before switching to {{pendingStashBranch}}.", { pendingStashBranch: pendingStashBranch })}</small>
                ) : null}
                {stashes.length ? (
                  <div className="git-stash-list">
                    {stashes.map((stash) => (
                      <article key={stash.ref} className="git-stash-row">
                        <div>
                          <strong>{stash.ref}</strong>
                          <small>{t("{{message}} · {{relativeTime}}", { message: stash.message, relativeTime: stash.relativeTime })}</small>
                        </div>
                        <Tooltip content={canUseStash ? t("Apply and remove this stash.") : t("Restart ArchiCode to load Git stash support in this app window.")}>
                          <span className="git-stash-action-wrap">
                            <Button type="button" size="sm" onClick={() => void popGitStash(stash.ref)} disabled={gitBusy || !canUseStash}>
                              <Undo2 size={14} />
                              <span>{t("Pop")}</span>
                            </Button>
                          </span>
                        </Tooltip>
                      </article>
                    ))}
                  </div>
                ) : (
                  <small>{t("No stashes yet.")}</small>
                )}
              </section>
            ) : null}

            <section className="git-commit-box">
              <div className="git-section-head">
                <span className="ui-eyebrow">{t("Commit")}</span>
                <Button type="button" size="sm" onClick={() => setSelectedFiles(changedFiles.map((change) => change.path))} disabled={!changedFiles.length}>
                  <span>{t("Select all")}</span>
                </Button>
              </div>
              <ScrollArea className="git-change-scroll">
                {changedFiles.length ? changedFiles.map((change) => {
                  const isDiffOpen = diffOpenPath === change.path;
                  const diffLines = diffCache[change.path]?.diff ? diffCache[change.path].diff.split(/\r?\n/) : [];
                  return (
                    <Fragment key={`${change.path}-${change.index}-${change.workingTree}`}>
                      <label className="git-change-row">
                        <input
                          type="checkbox"
                          checked={selectedFiles.includes(change.path)}
                          onChange={() => toggleFile(change.path)}
                        />
                        <span>{change.path}</span>
                        <ChangeLineCounts change={change} />
                        {isConflictedGitFileStatus(change) ? (
                          <button
                            type="button"
                            className="git-conflict-badge-button"
                            title={t("Ask Research chat to check this merge conflict")}
                            onClick={() => askResearchAboutConflict()}
                          >
                            <Badge tone="warning">{statusText(change)}</Badge>
                          </button>
                        ) : (
                          <Badge tone={change.index === "?" ? "warning" : "neutral"}>{statusText(change)}</Badge>
                        )}
                        <IconButton
                          title={isDiffOpen ? t("Hide diff") : t("View diff")}
                          className={isDiffOpen ? "git-diff-toggle is-active" : "git-diff-toggle"}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void toggleDiff(change.path);
                          }}
                        >
                          <FileDiff size={13} />
                        </IconButton>
                      </label>
                      {isDiffOpen ? (
                        <div className="git-diff-preview">
                          {diffLoadingPath === change.path ? (
                            <small>{t("Loading diff...")}</small>
                          ) : diffLines.length ? (
                            <pre className="diff-view">
                              {diffLines.map((line, index) => (
                                <span key={index} className={diffLineClassName(line)}>{line || " "}</span>
                              ))}
                            </pre>
                          ) : (
                            <small>{t("No tracked Git diff is available for this file.")}</small>
                          )}
                        </div>
                      ) : null}
                    </Fragment>
                  );
                }) : <strong>{t("No uncommitted changes.")}</strong>}
              </ScrollArea>
              <Field
                label={t("Commit message")}
                action={
                  <IconButton
                    className="inspector-field-enhance-button"
                    title={commitMessageFiles.length ? t("Write a commit message from the diff") : t("Select changed files first")}
                    disabled={!canGenerateCommitMessage}
                    onClick={() => void requestCommitMessage()}
                  >
                    {isGeneratingCommitMessage ? <Loader2 size={13} className="is-spinning" /> : <Sparkles size={13} />}
                  </IconButton>
                }
              >
                <TextArea
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder={t("Describe this change")}
                />
              </Field>
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  void commitGitFiles(commitMessage, selectedFiles);
                  setCommitMessage("");
                }}
                disabled={!canCommit}
              >
                <GitCommit size={16} />
                <span>{t("Stage selected and commit")}</span>
              </Button>
            </section>

            <section className="git-dialog-log">
              <span className="ui-eyebrow">{t("Latest output")}</span>
              {gitLogs[0] ? (
                <pre>{[gitLogs[0].command, gitLogs[0].stdout, gitLogs[0].stderr].filter(Boolean).join("\n") || t("No output.")}</pre>
              ) : (
                <small>{t("No Git operations run this session.")}</small>
              )}
            </section>

            <section className="git-history-box">
              <span className="ui-eyebrow">{t("Commit history")}</span>
              <ScrollArea className="git-history-scroll">
                {recentCommits.length ? recentCommits.map((commit) => (
                  <article key={commit.hash} className="git-history-row">
                    <code>{commit.shortHash}</code>
                    <div>
                      <strong>{commit.subject}</strong>
                      <small>{t("{{authorName}} · {{value2}}", { authorName: commit.authorName, value2: formatDateTime(new Date(commit.authoredAt)) })}</small>
                    </div>
                  </article>
                )) : <strong>{t("No commits yet.")}</strong>}
              </ScrollArea>
            </section>
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
