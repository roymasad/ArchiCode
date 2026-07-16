import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import { Plus, RotateCcw, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { Button, IconButton } from "./ui";

type ConsoleTab = {
  id: string;
  revision: number;
  title: string;
  status: string;
  sessionId?: string;
  cwd?: string;
  shell?: string;
  exited?: boolean;
};

type TerminalResources = {
  terminal: Terminal;
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  disposables: IDisposable[];
};

const consoleStoragePrefix = "archicode-console-tabs";
const maxHistoryChars = 250_000;
const maxSerializeRows = 1000;
const persistDebounceMs = 400;

type PersistedConsoleTab = {
  id: string;
  revision: number;
  title: string;
  status: string;
  cwd?: string;
  shell?: string;
  exited?: boolean;
};

type PersistedConsoleState = {
  activeTabId: string | null;
  history: Record<string, string>;
  tabs: PersistedConsoleTab[];
};

function consoleStorageKey(rootPath: string): string {
  return `${consoleStoragePrefix}:${rootPath || "default"}`;
}

function readConsoleState(rootPath: string): PersistedConsoleState | null {
  try {
    const raw = localStorage.getItem(consoleStorageKey(rootPath));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedConsoleState;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeConsoleState(rootPath: string, state: PersistedConsoleState): void {
  const key = consoleStorageKey(rootPath);
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    try {
      localStorage.setItem(key, JSON.stringify({ activeTabId: state.activeTabId, history: {}, tabs: state.tabs }));
    } catch {
      // Ignore storage quota or serialization errors.
    }
  }
}

function tabId(): string {
  return `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shellLabel(shellPath: string): string {
  return shellPath.split(/[\\/]/).filter(Boolean).at(-1) || shellPath;
}

function terminalTheme(): NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"] {
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: value("--field", "#0f1117"),
    foreground: value("--text", "#e5e7eb"),
    cursor: value("--accent-strong", "#7c3aed"),
    selectionBackground: value("--accent-muted", "#3b2f63"),
    black: "#0f1117",
    blue: "#5b8def",
    cyan: "#37b7b4",
    green: "#4fb06d",
    magenta: "#b36be2",
    red: "#d95f5f",
    white: "#d8dde8",
    yellow: "#d2a84d",
    brightBlack: "#5b6472",
    brightBlue: "#84aaff",
    brightCyan: "#6edbd8",
    brightGreen: "#75cc8f",
    brightMagenta: "#d196f0",
    brightRed: "#ee8585",
    brightWhite: "#ffffff",
    brightYellow: "#e6c56f"
  };
}

export function ProjectConsole() {
  const { rootPath } = useArchicodeStore();
  const [tabs, setTabs] = useState<ConsoleTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabsRef = useRef<ConsoleTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const terminalRefs = useRef(new Map<string, TerminalResources>());
  const sessionToTabRef = useRef(new Map<string, string>());
  const terminalFrameRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const restoredHistoryRef = useRef(new Map<string, string>());
  const persistTimerRef = useRef<number | null>(null);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const persistConsoles = useCallback(() => {
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const history: Record<string, string> = {};
    for (const tab of tabsRef.current) {
      const resources = terminalRefs.current.get(tab.id);
      if (!resources) continue;
      try {
        const serialized = resources.serializeAddon.serialize({ scrollback: maxSerializeRows });
        history[tab.id] = serialized.length > maxHistoryChars ? serialized.slice(serialized.length - maxHistoryChars) : serialized;
      } catch {
        continue;
      }
    }
    writeConsoleState(rootPath, {
      activeTabId: activeTabIdRef.current,
      history,
      tabs: tabsRef.current.map((tab) => ({
        id: tab.id,
        revision: tab.revision,
        title: tab.title,
        status: tab.status,
        cwd: tab.cwd,
        shell: tab.shell,
        exited: tab.exited
      }))
    });
  }, [rootPath]);

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(persistConsoles, persistDebounceMs);
  }, [persistConsoles]);

  const updateTab = useCallback((id: string, patch: Partial<ConsoleTab>) => {
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...patch } : tab));
  }, []);

  const resizeTab = useCallback((id: string | null) => {
    if (!id) return;
    const resources = terminalRefs.current.get(id);
    if (!resources) return;
    try {
      resources.fitAddon.fit();
    } catch {
      return;
    }
    const tab = tabsRef.current.find((item) => item.id === id);
    if (tab?.sessionId) {
      void window.archicode?.resizeConsole?.(tab.sessionId, {
        cols: resources.terminal.cols,
        rows: resources.terminal.rows
      });
    }
  }, []);

  const focusTab = useCallback((id: string | null) => {
    if (!id) return;
    window.requestAnimationFrame(() => {
      resizeTab(id);
      terminalRefs.current.get(id)?.terminal.focus();
    });
  }, [resizeTab]);

  const disposeTerminal = useCallback((id: string, stopSession: boolean) => {
    const tab = tabsRef.current.find((item) => item.id === id);
    if (stopSession && tab?.sessionId) {
      void window.archicode?.stopConsole?.(tab.sessionId);
    }
    if (tab?.sessionId) {
      sessionToTabRef.current.delete(tab.sessionId);
    }

    const resources = terminalRefs.current.get(id);
    if (!resources) return;
    for (const disposable of resources.disposables) {
      disposable.dispose();
    }
    resources.terminal.dispose();
    terminalRefs.current.delete(id);
  }, []);

  const cleanupAllTerminals = useCallback(() => {
    for (const tab of tabsRef.current) {
      disposeTerminal(tab.id, true);
    }
    sessionToTabRef.current.clear();
    terminalRefs.current.clear();
  }, [disposeTerminal]);

  const createTab = useCallback(() => {
    if (!rootPath) return;
    const id = tabId();
    setTabs((current) => [
      ...current,
      {
        id,
        revision: 0,
        title: `Terminal ${current.length + 1}`,
        status: "Starting terminal..."
      }
    ]);
    setActiveTabId(id);
  }, [rootPath]);

  const closeTab = useCallback((id: string) => {
    disposeTerminal(id, true);
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      if (activeTabIdRef.current === id) {
        setActiveTabId(next[Math.min(index, next.length - 1)]?.id ?? null);
      }
      return next;
    });
  }, [disposeTerminal]);

  const stopActiveTab = useCallback(() => {
    const id = activeTabIdRef.current;
    if (!id) return;
    const tab = tabsRef.current.find((item) => item.id === id);
    if (!tab?.sessionId) return;
    void window.archicode?.stopConsole?.(tab.sessionId);
    updateTab(id, { exited: true, status: "Terminal stopped." });
  }, [updateTab]);

  const restartActiveTab = useCallback(() => {
    const id = activeTabIdRef.current;
    if (!id) return;
    disposeTerminal(id, true);
    updateTab(id, {
      cwd: undefined,
      exited: false,
      sessionId: undefined,
      shell: undefined,
      status: "Starting terminal...",
      revision: (tabsRef.current.find((tab) => tab.id === id)?.revision ?? 0) + 1
    });
  }, [disposeTerminal, updateTab]);

  const clearActiveTab = useCallback(() => {
    const id = activeTabIdRef.current;
    if (!id) return;
    terminalRefs.current.get(id)?.terminal.clear();
  }, []);

  const attachTerminal = useCallback((id: string, element: HTMLDivElement | null) => {
    if (!element || terminalRefs.current.has(id) || !rootPath) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: terminalTheme()
    });
    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    const disposables: IDisposable[] = [];
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(serializeAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(element);
    terminalRefs.current.set(id, { terminal, fitAddon, serializeAddon, disposables });
    resizeTab(id);

    const savedHistory = restoredHistoryRef.current.get(id);
    if (savedHistory) {
      terminal.write(savedHistory);
      terminal.write("\r\n");
      restoredHistoryRef.current.delete(id);
    }

    let sessionId: string | null = null;
    disposables.push(terminal.onData((data) => {
      if (sessionId) void window.archicode?.writeConsole?.(sessionId, data);
    }));

    void window.archicode?.startConsole?.(rootPath, { cols: terminal.cols, rows: terminal.rows })
      .then((session) => {
        sessionId = session.sessionId;
        sessionToTabRef.current.set(session.sessionId, id);
        updateTab(id, {
          cwd: session.cwd,
          exited: false,
          sessionId: session.sessionId,
          shell: session.shell,
          status: `${shellLabel(session.shell)} in ${session.cwd}`,
          title: shellLabel(session.shell)
        });
        resizeTab(id);
        if (activeTabIdRef.current === id) terminal.focus();
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        updateTab(id, { exited: true, status: message, title: "Terminal failed" });
        terminal.writeln(message);
        schedulePersist();
      });
  }, [resizeTab, rootPath, updateTab]);

  useEffect(() => {
    const dispose = window.archicode?.onConsoleOutput?.((payload) => {
      const tabIdForSession = sessionToTabRef.current.get(payload.sessionId);
      if (!tabIdForSession) return;
      const resources = terminalRefs.current.get(tabIdForSession);
      if (resources) resources.terminal.write(payload.text);
      if (payload.stream === "system") {
        updateTab(tabIdForSession, {
          exited: true,
          sessionId: undefined,
          status: payload.exitCode === 0 || payload.exitCode === null ? "Terminal exited." : `Terminal exited with code ${payload.exitCode}.`
        });
        sessionToTabRef.current.delete(payload.sessionId);
      }
      schedulePersist();
    });
    return () => dispose?.();
  }, [schedulePersist, updateTab]);

  useEffect(() => {
    cleanupAllTerminals();
    if (!rootPath) {
      setTabs([]);
      setActiveTabId(null);
      restoredHistoryRef.current.clear();
      return cleanupAllTerminals;
    }

    const restored = readConsoleState(rootPath);
    if (restored && restored.tabs.length) {
      restoredHistoryRef.current = new Map(Object.entries(restored.history ?? {}));
      const restoredTabs: ConsoleTab[] = restored.tabs.map((tab) => ({
        cwd: tab.cwd,
        exited: false,
        id: tab.id,
        revision: tab.revision,
        shell: tab.shell,
        status: "Starting terminal...",
        title: tab.title
      }));
      const activeId = restored.activeTabId && restored.tabs.some((tab) => tab.id === restored.activeTabId)
        ? restored.activeTabId
        : restoredTabs[0]?.id ?? null;
      setTabs(restoredTabs);
      setActiveTabId(activeId);
    } else {
      const id = tabId();
      setTabs([{ id, revision: 0, title: "Terminal 1", status: "Starting terminal..." }]);
      setActiveTabId(id);
    }
    return cleanupAllTerminals;
  }, [cleanupAllTerminals, rootPath]);

  useEffect(() => {
    schedulePersist();
  }, [tabs, schedulePersist]);

  useEffect(() => {
    const flush = () => persistConsoles();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") persistConsoles();
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [persistConsoles]);

  useEffect(() => {
    focusTab(activeTabId);
  }, [activeTabId, focusTab]);

  useEffect(() => {
    resizeObserverRef.current?.disconnect();
    const frame = terminalFrameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => resizeTab(activeTabIdRef.current));
    observer.observe(frame);
    resizeObserverRef.current = observer;
    return () => observer.disconnect();
  }, [resizeTab]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const canUseConsole = Boolean(rootPath && window.archicode?.startConsole);
  const status = !rootPath
    ? "Open a project folder to use the terminal."
    : !canUseConsole
      ? "Terminal access is available in the Electron app."
      : activeTab?.status ?? "No terminal open.";

  return (
    <section className="project-console" aria-label="Project terminal">
      <div className="console-controls-row">
        <div className="console-tab-strip" role="tablist" aria-label="Terminal tabs">
          {tabs.map((tab) => (
            <div key={tab.id} className={tab.id === activeTabId ? "console-tab active" : "console-tab"}>
              <button
                type="button"
                className="console-tab-button"
                role="tab"
                aria-selected={tab.id === activeTabId}
                onClick={() => setActiveTabId(tab.id)}
                title={tab.status}
              >
                <span>{tab.title}</span>
              </button>
              <IconButton
                aria-label={`Close ${tab.title}`}
                size="sm"
                title={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
          {!tabs.length ? <span className="console-empty-tab">No terminal open</span> : null}
        </div>
        <div className="console-toolbar">
          <Button type="button" size="sm" onClick={createTab} disabled={!canUseConsole}>
            <Plus size={14} />
            <span>New</span>
          </Button>
          <Button type="button" size="sm" onClick={clearActiveTab} disabled={!activeTab}>
            <Trash2 size={14} />
            <span>Clear</span>
          </Button>
          <Button type="button" size="sm" onClick={stopActiveTab} disabled={!activeTab?.sessionId || activeTab.exited}>
            <Square size={14} />
            <span>Stop</span>
          </Button>
          <Button type="button" size="sm" onClick={restartActiveTab} disabled={!activeTab || !canUseConsole}>
            <RotateCcw size={14} />
            <span>Restart</span>
          </Button>
        </div>
      </div>
      <div ref={terminalFrameRef} className="console-terminal-frame">
        {tabs.map((tab) => (
          <div
            key={`${tab.id}-${tab.revision}`}
            ref={(element) => attachTerminal(tab.id, element)}
            className={tab.id === activeTabId ? "console-terminal-pane active" : "console-terminal-pane"}
            role="tabpanel"
            aria-hidden={tab.id !== activeTabId}
          />
        ))}
      </div>
    </section>
  );
}
