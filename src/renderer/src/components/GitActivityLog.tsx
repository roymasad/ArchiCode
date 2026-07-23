import { formatDateTime } from "@renderer/i18n";
import { t } from "@renderer/i18n";
import { GitBranch, GitCommit, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { FormEvent } from "react";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { Badge, Button, EmptyState, IconButton, ScrollArea, Select, TextInput } from "./ui";

export function GitActivityLog() {
  const {
    gitBusy,
    gitLogs,
    gitStatus,
    createGitBranch,
    switchGitBranch
  } = useArchicodeStore(useShallow((state) => ({
    gitBusy: state.gitBusy,
    gitLogs: state.gitLogs,
    gitStatus: state.gitStatus,
    createGitBranch: state.createGitBranch,
    switchGitBranch: state.switchGitBranch
  })));
  const [branchDraft, setBranchDraft] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const recentCommits = gitStatus?.recentCommits ?? [];
  const branchOptions = useMemo(() => (gitStatus?.branches ?? []).map((branch) => ({ value: branch, label: branch })), [gitStatus?.branches]);
  const currentBranch = gitStatus?.currentBranch ?? "branch unknown";

  useEffect(() => {
    if (gitStatus?.currentBranch) setBranchDraft(gitStatus.currentBranch);
  }, [gitStatus?.currentBranch]);

  const chooseBranch = async (branch: string) => {
    setBranchDraft(branch);
    if (!branch || branch === gitStatus?.currentBranch) return;
    if (gitStatus?.changes.length) {
      window.alert("You have uncommitted changes. Open the Git page to commit or stash before switching branches.");
      window.dispatchEvent(new CustomEvent("archicode:open-git"));
      setBranchDraft(gitStatus.currentBranch ?? "");
      return;
    }
    await switchGitBranch(branch);
  };

  const submitNewBranch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const branch = newBranchName.trim();
    if (!branch) return;
    await createGitBranch(branch);
    setNewBranchName("");
    setCreatingBranch(false);
  };

  if (!gitStatus?.isRepo && !gitLogs.length && !recentCommits.length) {
    return (
      <EmptyState icon={<GitBranch size={20} />} title={t("No Git activity yet")}>{t("{{value1}} {{value2}}", { value1: t("Recent commit messages and Git operation output will appear here."), value2: " " })}</EmptyState>
    );
  }

  return (
    <ScrollArea className="git-activity-scroll">
      <div className="git-activity-log">
        {gitStatus?.isRepo ? (
          <div className="git-activity-header">
            <div className="git-activity-summary">
              <Badge>{currentBranch}</Badge>
              <Badge>{t("{{length}} changed", { length: gitStatus.changes.length })}</Badge>
              {gitStatus.ahead ? <Badge tone="accent">{t("ahead {{ahead}}", { ahead: gitStatus.ahead })}</Badge> : null}
              {gitStatus.behind ? <Badge tone="warning">{t("behind {{behind}}", { behind: gitStatus.behind })}</Badge> : null}
            </div>
            <div className="git-activity-branch-controls">
              {branchOptions.length ? (
                <Select
                  value={branchDraft}
                  onValueChange={chooseBranch}
                  options={branchOptions}
                  disabled={gitBusy}
                />
              ) : (
                <Badge>{currentBranch}</Badge>
              )}
              {creatingBranch ? (
                <form className="git-activity-new-branch" onSubmit={submitNewBranch}>
                  <TextInput
                    value={newBranchName}
                    onChange={(event) => setNewBranchName(event.target.value)}
                    placeholder={t("new-branch")}
                    disabled={gitBusy}
                    aria-label={t("New branch name")}
                  />
                  <IconButton title={t("Create branch")} type="submit" disabled={gitBusy || !newBranchName.trim()}>
                    <Plus size={14} />
                  </IconButton>
                  <IconButton title={t("Cancel branch creation")} onClick={() => {
                    setCreatingBranch(false);
                    setNewBranchName("");
                  }}>
                    <X size={14} />
                  </IconButton>
                </form>
              ) : (
                <Button type="button" size="sm" onClick={() => setCreatingBranch(true)} disabled={gitBusy}>
                  <Plus size={14} />
                  <span>{t("Branch")}</span>
                </Button>
              )}
            </div>
          </div>
        ) : null}
        {recentCommits.length ? (
          <section className="git-history-activity">
            <div className="record-card-head">
              <strong>{t("Recent commits")}</strong>
              <Badge>{recentCommits.length}</Badge>
            </div>
            {recentCommits.map((commit) => (
              <article key={commit.hash} className="git-history-row">
                <GitCommit size={15} />
                <div>
                  <strong>{commit.subject}</strong>
                  <small>{t("{{shortHash}} · {{authorName}} · {{value3}}", { shortHash: commit.shortHash, authorName: commit.authorName, value3: formatDateTime(new Date(commit.authoredAt)) })}</small>
                </div>
              </article>
            ))}
          </section>
        ) : gitStatus?.isRepo ? <strong>{t("No commits yet.")}</strong> : null}
        {gitLogs.map((log) => (
          <article key={`${log.at}-${log.command}`} className={log.ok ? "git-log-entry" : "git-log-entry is-failed"}>
            <div className="record-card-head">
              <Badge tone={log.ok ? "success" : "danger"}>{log.ok ? t("ok") : t("failed")}</Badge>
              <small>{formatDateTime(new Date(log.at))}</small>
            </div>
            <strong>{log.command}</strong>
            <pre>{[log.stdout, log.stderr].filter(Boolean).join("\n") || t("No output.")}</pre>
          </article>
        ))}
      </div>
    </ScrollArea>
  );
}
