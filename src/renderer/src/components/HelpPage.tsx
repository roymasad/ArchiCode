import { BookOpen, CheckCircle2, ExternalLink, FolderOpen, GitBranch, Keyboard, Lock, MessageSquare, Play, SlidersHorizontal, Sparkles } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { gaiaAgent, pandoraAgent } from "@shared/agentIdentities";
import { Button, DialogContent, DialogRoot, DialogTrigger, ScrollArea } from "./ui";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { ACTION_DESCRIPTORS, formatChord, type ActionId } from "../utils/keybindings";
import { openRuntimeUrl } from "./projectToolbarShared";

const ARCHICODE_WEBSITE_URL = "https://archicode.pixel-hat.com";

const helpLiveBindingOrder: ActionId[] = [
  "canvas.addNode",
  "canvas.toggleMinimap",
  "canvas.delete",
  "canvas.copy",
  "canvas.cut",
  "canvas.paste",
  "canvas.duplicate",
  "canvas.autoLayout",
  "canvas.undo",
  "canvas.reload",
  "project.focusSidebarSearch",
  "project.toggleWorkbench",
  "project.toggleChat",
  "project.openPreferences"
];

const helpSections = [
  {
    icon: <FolderOpen size={18} />,
    title: "Start with a real folder",
    body: "Open an existing codebase or create a template project. ArchiCode stores its own readable project model in `.archicode/` alongside the files it is helping you plan and change."
  },
  {
    icon: <GitBranch size={18} />,
    title: "Map the work as a graph",
    body: "Use flows, subflows, nodes, edges, stages, flags, todos, notes, attachments, and acceptance criteria to describe the system and the work that should happen next."
  },
  {
    icon: <Sparkles size={18} />,
    title: "Let Archi work from context",
    body: `Run AI Implement with ${gaiaAgent.name} for the whole diagram, or use node-scoped actions from the inspector. Archi, the chat research agent, can research questions, edit or create graph nodes and groups, execute builds, help verify results, and sync the graph to code after external edits when you ask.`
  },
  {
    icon: <MessageSquare size={18} />,
    title: "Answer questions on nodes",
    body: "When required product or technical details are missing, the model should stop and add focused LLM questions as node notes. Answer there so future runs keep the clarification attached to the right work."
  },
  {
    icon: <Play size={18} />,
    title: "Build, run, and debug",
    body: `Configure build commands and run targets in Settings. ${gaiaAgent.title} handles implementation, while ${pandoraAgent.title} handles focused debugging. Their runs, runtime logs, bug reports, failed checks, artifacts, and diffs stay visible in the activity panel for review and follow-up.`
  },
  {
    icon: <Lock size={18} />,
    title: "Review risky changes",
    body: "Shell commands are permission-gated, source-file proposals are validated, and locked production nodes cannot be silently changed by the model. Keep review mode on when you want every proposal to wait for approval."
  }
];

const helpShortcuts = [
  {
    keys: "Space over empty canvas",
    action: "Open the add-node menu at the pointer."
  },
  {
    keys: "Tab",
    action: "Toggle the minimap."
  },
  {
    keys: "Ctrl/Cmd + F",
    action: "Focus the current-scope search field in the left sidebar."
  },
  {
    keys: "Ctrl/Cmd + drag empty canvas",
    action: "Draw a marquee around nodes to select them together."
  },
  {
    keys: "Shift/Ctrl/Cmd + click node",
    action: "Add a node to the current selection, or remove it from the selection."
  },
  {
    keys: "Delete or Backspace",
    action: "Delete the selected node or nodes after confirmation."
  },
  {
    keys: "Ctrl/Cmd + C/X/V",
    action: "Copy, cut, and paste selected nodes."
  },
  {
    keys: "Ctrl/Cmd + D",
    action: "Duplicate selected nodes."
  },
  {
    keys: "Ctrl/Cmd + L",
    action: "Auto-layout the active graph view."
  }
];

export function HelpPage({ trigger }: { trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openProjectSettings = useArchicodeStore((state) => state.openProjectSettings);
  const keybindings = useArchicodeStore((state) => state.keybindings);
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
            <span>Help</span>
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        title="ArchiCode Help"
        description="A concise guide to what this project is for and how to use it."
        className="help-dialog"
      >
        <ScrollArea className="help-page-scroll">
          <div className="help-page">
            <section className="help-intro" aria-label="What ArchiCode is">
              <span className="ui-eyebrow">What it is</span>
              <p>
                ArchiCode is a visual-first harness for designing and evolving software projects with node-based architecture diagrams and LLM-guided workflows. It is meant to make the diagram, not a long chat thread, the durable planning surface for a project.
              </p>
            </section>

            <section className="help-quick-start" aria-label="Quick start">
              <span className="ui-eyebrow">Quick start</span>
              <ol>
                <li>Configure an LLM provider. It is required for model-assisted planning and code changes, which are the core workflow.</li>
                <li>Open a project folder or create a project from a template.</li>
                <li>Create nodes for features, components, tasks, settings, artifacts, or subflows.</li>
                <li>Add acceptance criteria, edges, notes, and attachments to the nodes that need work.</li>
                <li>Run AI Implement with Gaia, Build, Run App, or AI Debug with Pandora from the toolbar when the graph has enough context.</li>
                <li>Review questions, logs, artifacts, diffs, and proposed changes before treating work as done.</li>
              </ol>
            </section>

            <section className="help-section-grid" aria-label="Core workflow">
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

            <section className="help-shortcuts" aria-label="Keyboard shortcuts">
              <div className="help-shortcuts-heading">
                <Keyboard size={18} aria-hidden="true" />
                <div>
                  <span className="ui-eyebrow">Shortcuts</span>
                  <h3>Canvas shortcuts</h3>
                </div>
              </div>
              <dl className="help-shortcut-list">
                {helpShortcuts.map((shortcut) => (
                  <div key={shortcut.keys}>
                    <dt><kbd>{shortcut.keys}</kbd></dt>
                    <dd>{shortcut.action}</dd>
                  </div>
                ))}
              </dl>
              <div className="help-shortcuts-live">
                <span className="ui-eyebrow">Current key bindings</span>
                <p>These reflect your current key bindings. Customize them in Preferences :</p>
                <ul className="help-shortcut-list">
                  {helpLiveBindingOrder.map((id) => {
                    const descriptor = ACTION_DESCRIPTORS.find((item) => item.id === id);
                    if (!descriptor) return null;
                    const chord = keybindings[id];
                    return (
                      <li key={id}>
                        <kbd>{chord ? formatChord(chord) : descriptor.default ? formatChord(descriptor.default) : ""}</kbd>
                        <span>{descriptor.label}</span>
                      </li>
                    );
                  })}
                </ul>
                <Button type="button" size="sm" variant="secondary" onClick={() => { setOpen(false); openProjectSettings("shortcuts"); }}>
                  <SlidersHorizontal size={14} />
                  <span>Open Shortcuts</span>
                </Button>
              </div>
            </section>

            <section className="help-footer-note" aria-label="Working model">
              <CheckCircle2 size={18} aria-hidden="true" />
              <p>
                The intended rhythm is: model the system visually, clarify uncertainty on the relevant nodes, run focused agent work, verify the result, then keep the graph updated as the shared source of project intent.
                If code changed outside ArchiCode, ask Archi to sync graph to code; it should first ask whether to compare uncommitted changes, changes since a commit you name, or the full codebase.
              </p>
            </section>

            <section className="help-footer-link" aria-label="ArchiCode website">
              <a
                href={ARCHICODE_WEBSITE_URL}
                onClick={(event) => {
                  event.preventDefault();
                  openRuntimeUrl(ARCHICODE_WEBSITE_URL);
                }}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span>archicode.pixel-hat.com</span>
              </a>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </DialogRoot>
  );
}
