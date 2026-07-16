import { Check, ChevronDown, ChevronRight, CircleHelp, ExternalLink, FileCode2, FileDiff, Folder, FolderOpen, Loader2, Maximize2, Minimize2, Palette, RefreshCw, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { GitFileStatus, ProjectFileTreeNode } from "@shared/projectTools";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { explainFilePrompt } from "../utils/explainPrompts";
import { findPreviewStartLine, findSearchMatches, lineHasSearchMatch } from "../utils/projectFilePreview";
import { Badge, Button, EmptyState, IconButton, MenuContent, MenuItem, MenuLabel, MenuRoot, MenuTrigger, ScrollArea, TabsContent, TabsList, TabsRoot, TabsTrigger, TextInput, Tooltip } from "./ui";

const defaultSidebarWidth = 300;
const minSidebarWidth = 180;
const maxSidebarWidth = 520;
const minPreviewWidth = 320;

const fileReaderThemes = [
  { value: "slate", label: "Slate", swatch: "#5d7d8f" },
  { value: "ocean", label: "Ocean", swatch: "#38a8c6" },
  { value: "forest", label: "Forest", swatch: "#62b689" },
  { value: "violet", label: "Violet", swatch: "#a98df7" },
  { value: "ember", label: "Ember", swatch: "#f08a61" },
  { value: "paper", label: "Paper", swatch: "#d6c2a4" }
] as const;

type FileReaderTheme = (typeof fileReaderThemes)[number]["value"];
const fileReaderThemeStorageKey = "archicode-file-reader-theme";

function readStoredFileReaderTheme(): FileReaderTheme {
  const saved = localStorage.getItem(fileReaderThemeStorageKey);
  return fileReaderThemes.some((theme) => theme.value === saved) ? saved as FileReaderTheme : "slate";
}

type CodeTokenSegment = {
  text: string;
  className?: string;
};

type SemanticCodeLineContext = {
  state: "disabled" | "unavailable" | "not-indexed" | "current" | "error";
  indexed: boolean;
  message: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  relatedNodes: Array<{
    flowId: string;
    nodeId: string;
    title: string;
    description: string;
    type: string;
    stage: string;
    score: number;
    relationship?: "own" | "share" | "cover";
    acceptanceCriteria: string[];
  }>;
  relatedCode: Array<{ path: string; symbol: string; startLine?: number; endLine?: number; score: number }>;
};

function SemanticMatchRadial({ score }: { score: number }) {
  const percentage = Math.max(0, Math.min(100, Math.round(score * 100)));
  return (
    <span
      className="semantic-match-radial"
      style={{ "--semantic-match-angle": `${percentage * 3.6}deg` } as CSSProperties}
      title={`${percentage}% semantic similarity`}
      aria-label={`${percentage}% semantic similarity`}
    >
      <span>{percentage}</span>
    </span>
  );
}

function fileBrowserSidebarWidthStorageKey(rootPath: string): string {
  return `archicode-file-browser-sidebar-width:${rootPath || "default"}`;
}

function lastPreviewFileStorageKey(rootPath: string): string {
  return `archicode-last-file-preview:${rootPath || "default"}`;
}

function clampSidebarWidth(width: number, containerWidth = window.innerWidth): number {
  const availableMax = Math.max(minSidebarWidth, containerWidth - minPreviewWidth);
  return Math.min(maxSidebarWidth, availableMax, Math.max(minSidebarWidth, Math.round(width)));
}

function readStoredSidebarWidth(rootPath: string): number {
  const saved = Number(localStorage.getItem(fileBrowserSidebarWidthStorageKey(rootPath)));
  return Number.isFinite(saved) ? clampSidebarWidth(saved) : defaultSidebarWidth;
}

function statusLabel(status: GitFileStatus): string {
  if (status.index === "?" && status.workingTree === "?") return "new";
  if (status.index === "D" || status.workingTree === "D") return "deleted";
  if (status.index === "R") return "renamed";
  if (status.index !== " " && status.workingTree !== " ") return "staged + modified";
  if (status.index !== " ") return "staged";
  return "modified";
}

function nodeHasChange(node: ProjectFileTreeNode, changedPaths: Set<string>): boolean {
  if (node.type === "file") return changedPaths.has(node.path);
  const prefix = node.path ? `${node.path}/` : "";
  return [...changedPaths].some((changedPath) => changedPath.startsWith(prefix));
}

function filterFileTree(node: ProjectFileTreeNode, query: string): ProjectFileTreeNode | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return node;
  const children = node.children
    ?.map((child) => filterFileTree(child, normalizedQuery))
    .filter((child): child is ProjectFileTreeNode => child !== null);
  const matches = `${node.name} ${node.path}`.toLowerCase().includes(normalizedQuery);
  if (!matches && !children?.length) return null;
  return { ...node, children };
}

function fileTreeContainsPath(node: ProjectFileTreeNode | null, path: string): boolean {
  if (!node) return false;
  if (node.type === "file" && node.path === path) return true;
  return node.children?.some((child) => fileTreeContainsPath(child, path)) ?? false;
}

function tokenizeCodeLine(line: string, language: string): CodeTokenSegment[] {
  if (/^\s*(\/\/|#|--|\/\*)/.test(line)) return [{ text: line, className: "code-token-comment" }];
  const keywordPattern = language === "json"
    ? /\b(true|false|null)\b/g
    : /\b(import|export|from|as|const|let|var|function|return|if|else|for|while|do|of|in|class|type|interface|enum|async|await|try|catch|finally|throw|new|extends|implements|switch|case|break|continue|default|public|private|protected|static|readonly|abstract|declare|keyof|typeof|void|yield|delete|instanceof)\b/g;
  const pattern = /(\/\/.*$|#.*$|\/\*.*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b(true|false|null|undefined)\b|(<\/?)([A-Za-z][\w:.-]*)|([A-Za-z_:][\w:.-]*)(?=\s*=)|([A-Za-z_$][\w$]*)(?=\s*:)|([A-Za-z_$][\w$]*)(?=\s*\()|([{}()[\],.;:+\-*/=<>!&|]+)/g;
  const parts: CodeTokenSegment[] = [];
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const before = line.slice(cursor, match.index);
    if (before) parts.push(...tokenizeKeywords(before, keywordPattern));
    const className = match[1]
      ? "code-token-comment"
      : match[2]
        ? "code-token-string"
        : match[3]
          ? "code-token-number"
          : match[4]
            ? "code-token-boolean"
            : match[5] || match[6]
              ? "code-token-tag"
              : match[7]
                ? "code-token-attribute"
                : match[8]
                  ? "code-token-property"
                  : match[9]
                    ? "code-token-function"
                    : "code-token-operator";
    parts.push({ text: match[0], className });
    cursor = match.index + match[0].length;
  }
  const after = line.slice(cursor);
  if (after) parts.push(...tokenizeKeywords(after, keywordPattern));
  return parts.length ? parts : [{ text: line }];
}

function tokenizeKeywords(text: string, pattern: RegExp): CodeTokenSegment[] {
  const parts: CodeTokenSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index) });
    parts.push({ text: match[0], className: "code-token-keyword" });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

function renderSearchHighlightedText(text: string, query: string, keyBase: string): ReactNode[] {
  const trimmed = query.trim();
  if (!trimmed) return [text];
  const lower = text.toLowerCase();
  const needle = trimmed.toLowerCase();
  const parts: ReactNode[] = [];
  let start = 0;
  while (start < text.length) {
    const index = lower.indexOf(needle, start);
    if (index < 0) {
      if (start < text.length) parts.push(text.slice(start));
      break;
    }
    if (index > start) parts.push(text.slice(start, index));
    parts.push(<mark key={`${keyBase}-${index}-${start}`} className="code-search-hit">{text.slice(index, index + needle.length)}</mark>);
    start = index + needle.length;
  }
  return parts.length ? parts : [text];
}

function renderCodeLine(line: string, language: string, query: string): ReactNode {
  const segments = tokenizeCodeLine(line, language);
  return segments.map((segment, index) => {
    const content = renderSearchHighlightedText(segment.text, query, `segment-${index}`);
    return segment.className
      ? <span key={`segment-${index}`} className={segment.className}>{content}</span>
      : <span key={`segment-${index}`}>{content}</span>;
  });
}

function TreeRow({
  node,
  depth,
  changedPaths,
  selectedPath,
  searchQuery,
  onSelect
}: {
  node: ProjectFileTreeNode;
  depth: number;
  changedPaths: Set<string>;
  selectedPath: string | null;
  searchQuery: string;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const changed = nodeHasChange(node, changedPaths);
  const isDirectory = node.type === "directory";
  const active = node.type === "file" && node.path === selectedPath;
  const containsSelectedPath = Boolean(selectedPath && isDirectory && (
    !node.path || selectedPath === node.path || selectedPath.startsWith(`${node.path}/`)
  ));
  const searching = Boolean(searchQuery.trim());
  const visible = open || searching;

  useEffect(() => {
    if (containsSelectedPath) setOpen(true);
  }, [containsSelectedPath]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      activeRowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div className="file-tree-node">
      <button
        ref={activeRowRef}
        type="button"
        className={active ? "file-tree-row is-active" : "file-tree-row"}
        aria-current={active ? "true" : undefined}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          if (isDirectory) setOpen((value) => !value);
          else onSelect(node.path);
        }}
      >
        {isDirectory ? <ChevronRight size={13} className={visible ? "tree-chevron is-open" : "tree-chevron"} /> : <span className="tree-spacer" />}
        {isDirectory ? (visible ? <FolderOpen size={15} /> : <Folder size={15} />) : <FileCode2 size={15} />}
        <span>{renderSearchHighlightedText(node.name, searchQuery, `tree-${node.path || node.name}`)}</span>
        {changed ? <Badge tone="warning" className="file-change-badge">changed</Badge> : null}
      </button>
      {isDirectory && visible && node.children?.length ? (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.path || child.name}
              node={child}
              depth={depth + 1}
              changedPaths={changedPaths}
              selectedPath={selectedPath}
              searchQuery={searchQuery}
              onSelect={onSelect}
            />
          ))}
          {node.truncated ? <small className="file-tree-truncated">More files hidden.</small> : null}
        </div>
      ) : null}
    </div>
  );
}

export function ProjectFileBrowser({ expanded = false, onToggleExpanded }: { expanded?: boolean; onToggleExpanded?: () => void }) {
  const {
    rootPath,
    bundle,
    fileBrowser,
    filePreviewRequest,
    filePreview,
    fileDiff,
    fileBusy,
    selectedFilePath,
    refreshProjectFiles,
    selectProjectFile,
    startScopedResearchChat
  } = useArchicodeStore();
  const [previewTab, setPreviewTab] = useState("preview");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const [readerTheme, setReaderTheme] = useState<FileReaderTheme>(readStoredFileReaderTheme);
  const [fileTreeSearchQuery, setFileTreeSearchQuery] = useState("");
  const [semanticLensEnabled, setSemanticLensEnabled] = useState(false);
  const [semanticHover, setSemanticHover] = useState<{ lineNumber: number; context: SemanticCodeLineContext | null } | null>(null);
  const [semanticFileContextState, setSemanticFileContextState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredSidebarWidth(rootPath));
  const changedByPath = useMemo(() => {
    const map = new Map<string, GitFileStatus>();
    for (const change of fileBrowser?.gitStatus.changes ?? []) map.set(change.path, change);
    return map;
  }, [fileBrowser]);
  const changedPaths = useMemo(() => new Set(changedByPath.keys()), [changedByPath]);
  const filteredFileTree = useMemo(
    () => fileBrowser ? filterFileTree(fileBrowser.tree, fileTreeSearchQuery) : null,
    [fileBrowser, fileTreeSearchQuery]
  );
  const selectedStatus = selectedFilePath ? changedByPath.get(selectedFilePath) : undefined;
  const lines = filePreview?.content.split(/\r?\n/) ?? [];
  const diffLines = fileDiff?.diff.split(/\r?\n/) ?? [];
  const searchMatches = useMemo(() => findSearchMatches(lines, searchQuery), [lines, searchQuery]);
  const currentSearchMatch = searchMatches[activeSearchMatchIndex] ?? null;
  const browserRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const codeViewportRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Record<number, HTMLSpanElement | null>>({});
  const autoLoadedRootRef = useRef<string | null>(null);
  const restoredPreviewRootRef = useRef<string | null>(null);
  const lastHandledPreviewRequestRef = useRef<number>(0);
  const semanticContextCacheRef = useRef(new Map<number, SemanticCodeLineContext>());
  const semanticLensStorageKey = `archicode-semantic-file-lens:${rootPath || "default"}`;
  const semanticLensAvailable = Boolean(bundle?.project.settings.semanticIndex.enabled);

  useEffect(() => {
    setSidebarWidth(readStoredSidebarWidth(rootPath));
  }, [rootPath]);

  useEffect(() => {
    setSemanticLensEnabled(localStorage.getItem(semanticLensStorageKey) === "true");
    setSemanticHover(null);
    setSemanticFileContextState("idle");
    semanticContextCacheRef.current.clear();
  }, [rootPath, semanticLensStorageKey, selectedFilePath]);

  useEffect(() => {
    if (!semanticLensEnabled || !semanticLensAvailable || !rootPath || !selectedFilePath || !window.archicode?.getSemanticCodeFileContexts) return;
    let cancelled = false;
    setSemanticFileContextState("loading");
    void window.archicode.getSemanticCodeFileContexts(rootPath, selectedFilePath).then((contexts) => {
      if (cancelled) return;
      semanticContextCacheRef.current.clear();
      for (const context of contexts) {
        const startLine = context.startLine ?? 0;
        const endLine = context.endLine ?? startLine;
        for (let line = startLine; line <= endLine; line += 1) semanticContextCacheRef.current.set(line, context);
      }
      setSemanticFileContextState("ready");
      setSemanticHover((current) => current
        ? { lineNumber: current.lineNumber, context: semanticContextCacheRef.current.get(current.lineNumber) ?? null }
        : current);
    }).catch(() => {
      if (!cancelled) setSemanticFileContextState("error");
    });
    return () => {
      cancelled = true;
    };
  }, [rootPath, selectedFilePath, semanticLensAvailable, semanticLensEnabled]);

  useEffect(() => {
    if (!rootPath || fileBusy || autoLoadedRootRef.current === rootPath) return;
    autoLoadedRootRef.current = rootPath;
    void refreshProjectFiles();
  }, [fileBusy, refreshProjectFiles, rootPath]);

  useEffect(() => {
    if (!rootPath || !fileBrowser || selectedFilePath || restoredPreviewRootRef.current === rootPath) return;
    restoredPreviewRootRef.current = rootPath;
    const lastPreviewedFile = localStorage.getItem(lastPreviewFileStorageKey(rootPath));
    if (lastPreviewedFile) void selectProjectFile(lastPreviewedFile);
  }, [fileBrowser, rootPath, selectProjectFile, selectedFilePath]);

  useEffect(() => {
    if (!selectedFilePath || !fileTreeSearchQuery || fileTreeContainsPath(filteredFileTree, selectedFilePath)) return;
    setFileTreeSearchQuery("");
  }, [fileTreeSearchQuery, filteredFileTree, selectedFilePath]);

  useEffect(() => {
    if (!filePreviewRequest || !filePreview || filePreview.path !== filePreviewRequest.path) return;
    if (lastHandledPreviewRequestRef.current === filePreviewRequest.requestId) return;
    lastHandledPreviewRequestRef.current = filePreviewRequest.requestId;
    setPreviewTab(filePreviewRequest.preferredTab ?? "preview");
    setSearchQuery(filePreviewRequest.searchQuery ?? "");
    setActiveSearchMatchIndex(0);
    const targetLine = findPreviewStartLine(lines, filePreviewRequest);
    if (!targetLine) return;
    window.requestAnimationFrame(() => {
      lineRefs.current[targetLine]?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [filePreview, filePreviewRequest, lines]);

  useEffect(() => {
    if (!searchMatches.length) return;
    const nextIndex = Math.max(0, Math.min(activeSearchMatchIndex, searchMatches.length - 1));
    if (nextIndex !== activeSearchMatchIndex) {
      setActiveSearchMatchIndex(nextIndex);
      return;
    }
    window.requestAnimationFrame(() => {
      lineRefs.current[searchMatches[nextIndex]?.lineNumber ?? 0]?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [activeSearchMatchIndex, searchMatches]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      if (!selectedFilePath) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable='true']") && target !== searchInputRef.current) return;
      event.preventDefault();
      setPreviewTab("preview");
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedFilePath]);

  const scrollToSearchMatch = (index: number) => {
    if (!searchMatches.length) return;
    const normalizedIndex = (index + searchMatches.length) % searchMatches.length;
    setActiveSearchMatchIndex(normalizedIndex);
    setPreviewTab("preview");
    lineRefs.current[searchMatches[normalizedIndex]?.lineNumber ?? 0]?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const resizeSidebar = (width: number) => {
    const nextWidth = clampSidebarWidth(width, browserRef.current?.getBoundingClientRect().width);
    localStorage.setItem(fileBrowserSidebarWidthStorageKey(rootPath), String(nextWidth));
    setSidebarWidth(nextWidth);
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      const bounds = browserRef.current?.getBoundingClientRect();
      if (!bounds) return;
      resizeSidebar(moveEvent.clientX - bounds.left);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const adjustSidebarWidth = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeSidebar(sidebarWidth - step);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeSidebar(sidebarWidth + step);
    }
  };

  const openSelectedFileExternally = async () => {
    if (!rootPath || !selectedFilePath) return;
    if (window.archicode?.openProjectFileWithApp) {
      await window.archicode.openProjectFileWithApp(rootPath, selectedFilePath);
      return;
    }
    if (window.archicode?.openProjectFile) await window.archicode.openProjectFile(rootPath, selectedFilePath);
  };

  const selectReaderTheme = (theme: FileReaderTheme) => {
    setReaderTheme(theme);
    localStorage.setItem(fileReaderThemeStorageKey, theme);
  };

  const toggleSemanticLens = () => {
    const next = !semanticLensEnabled;
    setSemanticLensEnabled(next);
    localStorage.setItem(semanticLensStorageKey, String(next));
    if (!next) setSemanticHover(null);
  };

  const hoverSemanticLine = (lineNumber: number) => {
    if (!semanticLensEnabled) return;
    const cached = semanticContextCacheRef.current.get(lineNumber);
    setSemanticHover({ lineNumber, context: cached ?? null });
  };

  const semanticTooltip = (context: SemanticCodeLineContext): ReactNode => {
    if (!context.relatedNodes.length && !context.relatedCode.length) return context.message;
    const rangeLabel = context.startLine && context.endLine
      ? context.startLine === context.endLine ? `line ${context.startLine}` : `lines ${context.startLine}–${context.endLine}`
      : null;
    return (
      <span className="semantic-lens-tooltip">
        <span className="semantic-lens-tooltip-heading">
          <span><Sparkles size={13} aria-hidden="true" /><strong>Semantic lens</strong></span>
          <small>{context.symbol ?? "Code section"}{rangeLabel ? ` · ${rangeLabel}` : ""}</small>
        </span>
        <span className="semantic-lens-section-title">
          <b>Related graph nodes</b>
          <small>How this code aligns with the project graph</small>
        </span>
        {context.relatedNodes.slice(0, 2).map((node) => (
          <span className="semantic-lens-node" key={`${node.flowId}:${node.nodeId}`}>
            <SemanticMatchRadial score={node.score} />
            <span className="semantic-lens-node-copy">
              <span className="semantic-lens-node-heading">
                <b>{node.title}</b>
                <small>{node.relationship ? `${node.relationship}s this code` : "Graph node"}</small>
              </span>
              <span>{node.description.length > 180 ? `${node.description.slice(0, 177)}…` : node.description}</span>
              {node.acceptanceCriteria[0] ? <em>Criterion: {node.acceptanceCriteria[0]}</em> : null}
            </span>
          </span>
        ))}
        {context.relatedCode.length ? (
          <span className="semantic-lens-related-code">
            <span className="semantic-lens-section-title">
              <b>Related code files</b>
              <small>Other indexed code with similar meaning</small>
            </span>
            {context.relatedCode.map((item) => (
              <span className="semantic-lens-related-file" key={`${item.path}:${item.symbol}`}>
                <SemanticMatchRadial score={item.score} />
                <span>
                  <b>{item.symbol}</b>
                  <small>{item.path}{item.startLine ? `:${item.startLine}` : ""}</small>
                </span>
              </span>
            ))}
          </span>
        ) : null}
        <small className="semantic-lens-score-note">Percentages are local embedding similarity scores. They suggest relevance; they do not prove ownership or dependency.</small>
      </span>
    );
  };

  if (!fileBrowser) {
    return (
      <div className="file-browser-empty">
        <EmptyState icon={<Loader2 size={24} className="is-spinning" />} title="Project files">
          {fileBusy ? "Loading project files…" : "Preparing the project file browser…"}
        </EmptyState>
      </div>
    );
  }

  return (
    <section
      ref={browserRef}
      className="file-browser"
      aria-label="Project file browser"
      style={{ "--file-browser-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <aside className="file-browser-sidebar">
        <div className="file-browser-header">
          <div>
            <strong>Files</strong>
            <small>{fileBrowser.gitStatus.isRepo ? `${fileBrowser.gitStatus.changes.length} changed` : "No Git repo"}</small>
          </div>
          <div className="file-browser-header-actions">
            <IconButton type="button" title="Refresh" aria-label="Refresh files" onClick={() => void refreshProjectFiles()} disabled={fileBusy}>
              <RefreshCw size={15} className={fileBusy ? "is-spinning" : undefined} />
            </IconButton>
            <IconButton
              type="button"
              title={expanded ? "Show sidebars and activity panel" : "Hide sidebars and activity panel"}
              aria-label={expanded ? "Show sidebars and activity panel" : "Hide sidebars and activity panel"}
              aria-pressed={expanded}
              onClick={onToggleExpanded}
            >
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
          </div>
        </div>
        <div className="file-tree-search">
          <Search size={14} aria-hidden="true" />
          <TextInput
            value={fileTreeSearchQuery}
            onChange={(event) => setFileTreeSearchQuery(event.target.value)}
            placeholder="Search files and folders"
            aria-label="Search files and folders"
          />
        </div>
        <ScrollArea className="file-tree-scroll">
          {filteredFileTree ? (
            <TreeRow
              node={filteredFileTree}
              depth={0}
              changedPaths={changedPaths}
              selectedPath={selectedFilePath}
              searchQuery={fileTreeSearchQuery}
              onSelect={(path) => void selectProjectFile(path)}
            />
          ) : <div className="file-tree-empty">No files or folders match.</div>}
        </ScrollArea>
      </aside>

      <div
        className="file-browser-resizer"
        role="separator"
        aria-label="Resize file browser columns"
        aria-orientation="vertical"
        aria-valuemin={minSidebarWidth}
        aria-valuemax={maxSidebarWidth}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onKeyDown={adjustSidebarWidth}
        onPointerDown={startSidebarResize}
      />

      <section className="file-browser-main">
        {!selectedFilePath ? (
          <EmptyState icon={<FileCode2 size={24} />} title="Select a file">
            Code preview and Git diff will appear here.
          </EmptyState>
        ) : (
          <>
            <div className="file-preview-header">
              <div>
                <strong>{selectedFilePath}</strong>
                <small>
                  {filePreviewRequest?.preferredTab === "diff" && filePreview?.size === 0
                    ? "Deleted file"
                    : filePreview ? `${filePreview.language} · ${filePreview.size.toLocaleString()} bytes` : "Loading..."}
                </small>
              </div>
              <div className="file-preview-actions">
                {!filePreview?.binary ? (
                  <div className="file-preview-search">
                    <Search size={14} />
                    <TextInput
                      ref={searchInputRef}
                      value={searchQuery}
                      onChange={(event) => {
                        setSearchQuery(event.target.value);
                        setActiveSearchMatchIndex(0);
                      }}
                      placeholder="Search in file"
                      aria-label="Search in file"
                    />
                    <small>{searchMatches.length ? `${activeSearchMatchIndex + 1}/${searchMatches.length}` : "0 matches"}</small>
                    <Button type="button" size="sm" disabled={!searchMatches.length} onClick={() => scrollToSearchMatch(activeSearchMatchIndex - 1)}>
                      <ChevronRight size={14} style={{ transform: "rotate(-90deg)" }} />
                      <span>Prev</span>
                    </Button>
                    <Button type="button" size="sm" disabled={!searchMatches.length} onClick={() => scrollToSearchMatch(activeSearchMatchIndex + 1)}>
                      <ChevronDown size={14} />
                      <span>Next</span>
                    </Button>
                  </div>
                ) : null}
                <div className="file-preview-external-actions">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => bundle && selectedFilePath && void startScopedResearchChat(
                      { type: "project", projectId: bundle.project.id },
                      explainFilePrompt(selectedFilePath)
                    )}
                    disabled={!bundle || !selectedFilePath}
                  >
                    <CircleHelp size={14} />
                    <span>Explain this</span>
                  </Button>
                  <Button type="button" size="sm" className="file-preview-open-with" onClick={() => void openSelectedFileExternally()} disabled={!rootPath || !selectedFilePath}>
                    <ExternalLink size={14} />
                    <span>Open with…</span>
                  </Button>
                  <MenuRoot>
                    <MenuTrigger asChild>
                      <Button type="button" size="sm" className="file-reader-theme-trigger" aria-label="Choose file reader theme">
                        <Palette size={14} />
                        <span>Theme</span>
                        <ChevronDown size={14} />
                      </Button>
                    </MenuTrigger>
                    <MenuContent className="file-reader-theme-menu">
                      <MenuLabel>File reader theme</MenuLabel>
                      {fileReaderThemes.map((theme) => (
                        <MenuItem key={theme.value} onSelect={() => selectReaderTheme(theme.value)}>
                          <span className="file-reader-theme-option">
                            <span className="file-reader-theme-swatch" style={{ background: theme.swatch }} aria-hidden="true" />
                            <span>{theme.label}</span>
                            {readerTheme === theme.value ? <Check size={14} aria-label="Selected" /> : null}
                          </span>
                        </MenuItem>
                      ))}
                    </MenuContent>
                  </MenuRoot>
                </div>
                {selectedStatus ? <Badge tone="warning">{statusLabel(selectedStatus)}</Badge> : null}
              </div>
            </div>
            <TabsRoot value={previewTab} onValueChange={setPreviewTab} className={`file-preview-tabs file-reader-theme-${readerTheme}`}>
              <div className="file-preview-tabs-header">
                <TabsList className="ui-tabs-list compact">
                  <TabsTrigger value="preview">
                    <FileCode2 size={14} />
                    Preview
                  </TabsTrigger>
                  <TabsTrigger value="diff">
                    <FileDiff size={14} />
                    Diff
                  </TabsTrigger>
                </TabsList>
                <IconButton
                  className={semanticLensEnabled ? "semantic-lens-toggle is-active" : "semantic-lens-toggle"}
                  title={semanticLensAvailable
                    ? semanticLensEnabled ? "Disable semantic lens" : "Enable semantic lens"
                    : "Enable semantic indexing in Advanced Settings to use the semantic lens"}
                  aria-pressed={semanticLensEnabled}
                  disabled={!semanticLensAvailable}
                  onClick={toggleSemanticLens}
                >
                  {semanticFileContextState === "loading" ? <Loader2 size={14} className="is-spinning" /> : <Sparkles size={14} />}
                </IconButton>
              </div>
              <TabsContent value="preview" className="file-preview-tab">
                {filePreview?.binary ? (
                  <EmptyState title="Binary file">This file is binary and cannot be displayed as text.</EmptyState>
                ) : (
                  <ScrollArea className="code-view-scroll" viewportRef={codeViewportRef}>
                    {filePreview?.truncated ? <div className="file-warning">Large file preview truncated.</div> : null}
                    <pre className="code-view">
                      {lines.map((line, index) => {
                        const lineNumber = index + 1;
                        const hasSearchMatch = lineHasSearchMatch(searchMatches, lineNumber);
                        const isActiveSearchMatch = currentSearchMatch?.lineNumber === lineNumber;
                        const semanticRangeActive = semanticLensEnabled && semanticHover?.context?.startLine !== undefined
                          && semanticHover.context.endLine !== undefined
                          && lineNumber >= semanticHover.context.startLine
                          && lineNumber <= semanticHover.context.endLine;
                        const semanticLineContext = semanticContextCacheRef.current.get(lineNumber);
                        const lineElement = (
                          <span
                            key={lineNumber}
                            ref={(node) => {
                              lineRefs.current[lineNumber] = node;
                            }}
                            className={[
                              "code-line",
                              hasSearchMatch ? "has-search-match" : "",
                              isActiveSearchMatch ? "is-active-search-match" : "",
                              semanticRangeActive ? "has-semantic-context" : ""
                            ].filter(Boolean).join(" ")}
                            onMouseEnter={() => hoverSemanticLine(lineNumber)}
                          >
                            <span className="code-line-number">{lineNumber}</span>
                            <span className="code-line-text">
                              {renderCodeLine(line, filePreview?.language ?? "text", searchQuery)}
                            </span>
                          </span>
                        );
                        return semanticLensEnabled && semanticLineContext
                          ? <Tooltip key={lineNumber} content={semanticTooltip(semanticLineContext)}>{lineElement}</Tooltip>
                          : lineElement;
                      })}
                    </pre>
                  </ScrollArea>
                )}
              </TabsContent>
              <TabsContent value="diff" className="file-preview-tab">
                <ScrollArea className="code-view-scroll">
                  {diffLines.length && fileDiff?.diff ? (
                    <pre className="diff-view">
                      {diffLines.map((line, index) => {
                        const className = line.startsWith("+") && !line.startsWith("+++")
                          ? "diff-line diff-add"
                          : line.startsWith("-") && !line.startsWith("---")
                            ? "diff-line diff-remove"
                            : line.startsWith("@@")
                              ? "diff-line diff-hunk"
                              : line.startsWith("#")
                                ? "diff-line diff-note"
                                : "diff-line";
                        return <span key={index} className={className}>{line || " "}</span>;
                      })}
                    </pre>
                  ) : (
                    <EmptyState title="No diff">{filePreviewRequest?.preferredTab === "diff"
                      ? "This file no longer exists and no working-tree Git diff is available."
                      : "No tracked Git diff is available for this file."}</EmptyState>
                  )}
                </ScrollArea>
              </TabsContent>
            </TabsRoot>
          </>
        )}
      </section>
    </section>
  );
}
