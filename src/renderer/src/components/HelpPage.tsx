import { t } from "@renderer/i18n";
import { BookOpen, Bot, Bug, CheckCircle2, Earth, ExternalLink, FolderOpen, GitBranch, GitMerge, Hammer, Lock, MessageSquare, Network, Play, Search, SlidersHorizontal, Sparkles, TestTube2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { gaiaAgent, pandoraAgent } from "@shared/agentIdentities";
import { Button, DialogContent, DialogRoot, DialogTrigger, ScrollArea } from "./ui";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { openRuntimeUrl } from "./projectToolbarShared";

const ARCHICODE_WEBSITE_URL = "https://archicode.pixel-hat.com";

const helpSections = [
  {
    icon: <FolderOpen size={18} />,
    title: t("Start with a real folder"),
    body: "Open an existing codebase or create a template project. ArchiCode stores its own readable project model in `.archicode/` alongside the files it is helping you plan and change."
  },
  {
    icon: <GitBranch size={18} />,
    title: t("Map the work as a graph"),
    body: "Use flows, subflows, nodes, edges, stages, flags, todos, notes, attachments, and acceptance criteria to describe the system and the work that should happen next."
  },
  {
    icon: <Sparkles size={18} />,
    title: t("Let Archi work from context"),
    body: `Run AI Implement with ${gaiaAgent.name} for the whole diagram, or use node-scoped actions from the inspector. Archi, the chat research agent, can research questions, edit or create graph nodes and groups, execute builds, help verify results, and sync the graph to code after external edits when you ask.`
  },
  {
    icon: <MessageSquare size={18} />,
    title: t("Answer questions on nodes"),
    body: "When required product or technical details are missing, the model should stop and add focused LLM questions as node notes. Answer there so future runs keep the clarification attached to the right work."
  },
  {
    icon: <Play size={18} />,
    title: t("Build, run, and debug"),
    body: `Configure build commands and run targets in Settings. ${gaiaAgent.title} handles implementation, while ${pandoraAgent.title} handles focused debugging. Their runs, runtime logs, bug reports, failed checks, artifacts, and diffs stay visible in the activity panel for review and follow-up.`
  },
  {
    icon: <Lock size={18} />,
    title: t("Review risky changes"),
    body: "Shell commands are permission-gated, source-file proposals are validated, and locked production nodes cannot be silently changed by the model. Keep review mode on when you want every proposal to wait for approval."
  }
];

const helpAgents = [
  {
    icon: <Bot size={18} />,
    name: "Archi",
    role: "Research & project companion",
    body: "Your main conversational partner for understanding the project, investigating questions, and coordinating focused work."
  },
  {
    icon: <Earth size={18} />,
    name: "Atlas",
    role: "Briefing curator",
    body: "Guides generated project briefings, explains the current slide, and answers grounded follow-up questions without editing the project."
  },
  {
    icon: <Hammer size={18} />,
    name: "Gaia",
    role: "Build & implementation",
    body: "Plans and implements approved project changes, then carries the work through verification."
  },
  {
    icon: <Bug size={18} />,
    name: "Pandora",
    role: "Debug & recovery",
    body: "Investigates failures and incidents, makes focused repairs, and verifies that the project recovered."
  },
  {
    icon: <Network size={18} />,
    name: "Picasso",
    role: "Graph architect",
    body: "Assesses and redesigns graph structure. Picasso proposes graph changes for review and never applies them silently."
  },
  {
    icon: <Search size={18} />,
    name: "Sherlock",
    role: "Research detective",
    body: "Performs bounded, evidence-led investigations when Archi needs deeper research before answering."
  },
  {
    icon: <GitMerge size={18} />,
    name: "Solomon",
    role: "Merge arbiter",
    body: "Helps resolve Git merge conflicts after approval, then verifies the resulting resolution."
  },
  {
    icon: <TestTube2 size={18} />,
    name: "Delphi",
    role: "Test & runtime oracle",
    body: "Runs bounded test, runtime, emulator, and visual audits using the targets you approve."
  }
];

export function HelpPage({ trigger }: { trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openProjectSettings = useArchicodeStore((state) => state.openProjectSettings);
  useEffect(() => {
    const onOpenHelp = () => setOpen(true);
    window.addEventListener("archicode:open-help", onOpenHelp);
    return () => window.removeEventListener("archicode:open-help", onOpenHelp);
  }, []);
  return (
    <DialogRoot open={open} onOpenChange={setOpen}>
      <DialogTrigger id="archicode-help-trigger" asChild>
        {trigger ?? (
          <Button type="button">
            <BookOpen size={16} />
            <span>{t("Help")}</span>
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        title={t("ArchiCode Help")}
        description={t("A concise guide to what this project is for and how to use it.")}
        className="help-dialog"
      >
        <ScrollArea className="help-page-scroll">
          <div className="help-page">
            <section className="help-intro" aria-label={t("What ArchiCode is")}>
              <span className="ui-eyebrow">{t("What it is")}</span>
              <p>{t("{{value1}} {{value2}}", { value1: t("ArchiCode is a visual-first harness for designing and evolving software projects with node-based architecture diagrams and LLM-guided workflows. It is meant to make the diagram, not a long chat thread, the durable planning surface for a project."), value2: " " })}</p>
            </section>

            <section className="help-quick-start" aria-label={t("Quick start")}>
              <span className="ui-eyebrow">{t("Quick start")}</span>
              <ol>
                <li>{t("Configure an LLM provider. It is required for model-assisted planning and code changes, which are the core workflow.")}</li>
                <li>{t("Open a project folder or create a project from a template.")}</li>
                <li>{t("Create nodes for features, components, tasks, settings, artifacts, or subflows.")}</li>
                <li>{t("Add acceptance criteria, edges, notes, and attachments to the nodes that need work.")}</li>
                <li>{t("Run AI Implement with Gaia, Build, Run App, or AI Debug with Pandora from the toolbar when the graph has enough context.")}</li>
                <li>{t("Review questions, logs, artifacts, diffs, and proposed changes before treating work as done.")}</li>
              </ol>
            </section>

            <section className="help-section-grid" aria-label={t("Core workflow")}>
              {helpSections.map((section) => (
                <article key={section.title} className="help-section">
                  <div className="help-section-icon" aria-hidden="true">{section.icon}</div>
                  <div>
                    <h3>{section.title}</h3>
                    <p>{section.body}</p>
                  </div>
                </article>
              ))}
            </section>

            <section className="help-agents" aria-label={t("AI agents")}>
              <div className="help-agents-heading">
                <div>
                  <span className="ui-eyebrow">{t("AI agents")}</span>
                  <h3>{t("Meet ArchiCode’s AI team")}</h3>
                </div>
                <p>{t("Each agent has a focused role, so you always know who is helping and what kind of work to expect.")}</p>
              </div>
              <div className="help-agent-grid">
                {helpAgents.map((agent) => (
                  <article key={agent.name} className="help-agent-card">
                    <div className="help-agent-icon" aria-hidden="true">{agent.icon}</div>
                    <div>
                      <h4>{agent.name}</h4>
                      <strong>{t(agent.role)}</strong>
                      <p>{t(agent.body)}</p>
                    </div>
                  </article>
                ))}
              </div>
              <Button type="button" size="sm" variant="secondary" onClick={() => { setOpen(false); openProjectSettings("shortcuts"); }}>
                <SlidersHorizontal size={14} />
                <span>{t("Open Shortcuts")}</span>
              </Button>
            </section>

            <section className="help-footer-note" aria-label={t("Working model")}>
              <CheckCircle2 size={18} aria-hidden="true" />
              <p>{t("{{value1}} {{value2}}", { value1: t("The intended rhythm is: model the system visually, clarify uncertainty on the relevant nodes, run focused agent work, verify the result, then keep the graph updated as the shared source of project intent. If code changed outside ArchiCode, ask Archi to sync graph to code; it should first ask whether to compare uncommitted changes, changes since a commit you name, or the full codebase."), value2: " " })}</p>
            </section>

            <section className="help-footer-link" aria-label={t("ArchiCode website")}>
              <a
                href={ARCHICODE_WEBSITE_URL}
                onClick={(event) => {
                  event.preventDefault();
                  openRuntimeUrl(ARCHICODE_WEBSITE_URL);
                }}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span>{t("archicode.pixel-hat.com")}</span>
              </a>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </DialogRoot>
  );
}
