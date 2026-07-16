import { CircleHelp, FileArchive, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Artifact } from "@shared/schema";
import { useArchicodeStore } from "../store/useArchicodeStore";
import { explainArtifactPrompt } from "../utils/explainPrompts";
import { formatPlanArtifactText, planArtifactBadgeLabel, planArtifactDerivedDisplay, planArtifactListLabel } from "../utils/planArtifacts";
import { Badge, Button, DialogContent, DialogRoot, EmptyState, ScrollArea, TextInput } from "./ui";

type ArtifactBrowserProps = {
  embedded?: boolean;
};

export function ArtifactBrowser({ embedded = false }: ArtifactBrowserProps) {
  const { bundle, rootPath, startScopedResearchChat } = useArchicodeStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const artifacts = useMemo(() => [...(bundle?.artifacts ?? []), ...(bundle?.summaries ?? [])], [bundle]);
  const types = useMemo(() => Array.from(new Set(artifacts.map((artifact) => artifact.type))).sort(), [artifacts]);
  const filtered = artifacts.filter((artifact) => {
    const value = `${artifact.type} ${artifact.title} ${artifact.path} ${artifact.summary ?? ""} ${artifact.promptSummary ?? ""} ${artifact.providerSummary ?? ""}`.toLowerCase();
    const matchesQuery = value.includes(query.trim().toLowerCase());
    const matchesType = typeFilter === "all" || artifact.type === typeFilter;
    return matchesQuery && matchesType;
  });
  const selected: Artifact | null = filtered.find((artifact) => artifact.id === selectedId) ?? filtered[0] ?? null;
  const explainSelectedArtifact = () => {
    if (!bundle || !selected) return;
    const linkedRun = selected.runId ? bundle.runs.find((run) => run.id === selected.runId) : undefined;
    const linkedFlow = linkedRun
      ? bundle.flows.find((flow) => flow.id === linkedRun.flowId)
      : selected.nodeId
        ? bundle.flows.find((flow) => flow.nodes.some((node) => node.id === selected.nodeId))
        : undefined;
    const linkedNodeId = linkedRun?.nodeId ?? selected.nodeId;
    const scope = linkedFlow && linkedNodeId && linkedFlow.nodes.some((node) => node.id === linkedNodeId)
      ? { type: "node" as const, flowId: linkedFlow.id, nodeId: linkedNodeId }
      : linkedFlow
        ? { type: "flow" as const, flowId: linkedFlow.id }
        : { type: "project" as const, projectId: bundle.project.id };
    void startScopedResearchChat(scope, explainArtifactPrompt(selected));
  };

  const browser = (
    <ArtifactSplitView
      artifacts={filtered}
      selected={selected}
      query={query}
      typeFilter={typeFilter}
      types={types}
      onQueryChange={setQuery}
      onTypeChange={setTypeFilter}
      onSelect={setSelectedId}
      projectRoot={rootPath}
      onExplain={explainSelectedArtifact}
    />
  );

  if (embedded) {
    return (
      <div className="artifact-browser embedded">
        {browser}
      </div>
    );
  }

  return (
    <>
      <Button type="button" data-testid="artifact-browser-button" onClick={() => setOpen(true)}>
        <FileArchive size={16} />
        <span>Artifacts</span>
      </Button>

      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Artifacts"
          description="Browse generated logs, patch proposals, summaries, screenshots, diffs, and attachments."
          className="artifact-modal"
        >
          {browser}
        </DialogContent>
      </DialogRoot>
    </>
  );
}

function ArtifactSplitView({
  artifacts,
  selected,
  query,
  typeFilter,
  types,
  onQueryChange,
  onTypeChange,
  onSelect,
  projectRoot,
  onExplain
}: {
  artifacts: Artifact[];
  selected: Artifact | null;
  query: string;
  typeFilter: string;
  types: string[];
  onQueryChange: (query: string) => void;
  onTypeChange: (type: string) => void;
  onSelect: (id: string) => void;
  projectRoot: string;
  onExplain: () => void;
}) {
  const [preview, setPreview] = useState<{ artifactId: string; text: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const canPreview = Boolean(selected && ["diff", "generated-file", "chat-artifact", "log", "instructions", "context-manifest", "memory", "summary", "plan"].includes(selected.type));
  const selectedPreviewText = preview && preview.artifactId === selected?.id ? preview.text : null;
  const selectedPlanDisplay = selected
    ? planArtifactDerivedDisplay(selected, selected.type === "plan" ? selectedPreviewText : null)
    : null;

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    if (!selected || !projectRoot || !canPreview || !window.archicode?.readArtifactText) return;
    window.archicode.readArtifactText(projectRoot, selected.path)
      .then((text) => {
        if (!cancelled) setPreview({ artifactId: selected.id, text });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPreviewError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [canPreview, projectRoot, selected]);

  return (
    <>
      <div className="artifact-filters">
        <label className="search-row">
          <Search size={15} />
          <TextInput value={query} placeholder="Search artifacts" onChange={(event) => onQueryChange(event.target.value)} />
        </label>
        <select className="ui-input" value={typeFilter} onChange={(event) => onTypeChange(event.target.value)}>
          <option value="all">All types</option>
          {types.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>
      <div className="artifact-grid">
        <ScrollArea className="artifact-list">
          {artifacts.length === 0 ? <EmptyState title="No artifacts">Run builds or agent jobs to create logs, summaries, diffs, and instructions.</EmptyState> : null}
          {artifacts.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              className={artifact.id === selected?.id ? "artifact-row is-active" : "artifact-row"}
              onClick={() => onSelect(artifact.id)}
            >
              <span>{artifact.title}</span>
              <small>{artifact.type === "plan" && artifact.id === selected?.id && selectedPlanDisplay ? selectedPlanDisplay.badgeLabel : artifact.type === "plan" ? planArtifactBadgeLabel(artifact) : artifact.type}</small>
            </button>
          ))}
        </ScrollArea>
        <section className="artifact-detail">
          {selected ? (
            <>
              <Badge>{selected.type === "plan" && selectedPlanDisplay ? selectedPlanDisplay.badgeLabel : planArtifactBadgeLabel(selected)}</Badge>
              <strong>{selected.title}</strong>
              <Button type="button" size="sm" onClick={onExplain}>
                <CircleHelp size={14} />
                <span>Explain this</span>
              </Button>
              <span>{selected.status ?? "recorded"}</span>
              <small>{selected.path}</small>
              {(selected.type === "plan" ? (selectedPlanDisplay?.listLabel ?? planArtifactListLabel(selected)) : selected.summary) ? <p>{selected.type === "plan" ? (selectedPlanDisplay?.listLabel ?? planArtifactListLabel(selected)) : selected.summary}</p> : null}
              {selected.sizeBytes ? <small>{selected.sizeBytes.toLocaleString()} bytes</small> : null}
              {selected.runId ? <small>Run: {selected.runId}</small> : null}
              {selected.nodeId ? <small>Node: {selected.nodeId}</small> : null}
              {canPreview ? (
                <ArtifactPreview
                  artifact={selected}
                  text={preview?.artifactId === selected.id ? preview.text : previewError ?? selected.summary ?? "Preview unavailable in this environment."}
                />
              ) : null}
            </>
          ) : (
            <EmptyState icon={<FileArchive size={20} />} title="Select an artifact" />
          )}
        </section>
      </div>
    </>
  );
}

export function ArtifactPreview({ artifact, text }: { artifact: Artifact; text: string }) {
  if (artifact.type === "plan") {
    const formatted = formatPlanArtifactText(text);
    const showRaw = formatted.trim() !== text.trim();
    return (
      <div className="artifact-plan-preview" role="region" aria-label="Plan preview">
        <pre className="artifact-preview">{formatted}</pre>
        {showRaw ? (
          <details className="artifact-plan-raw">
            <summary>Raw plan artifact</summary>
            <pre className="artifact-preview">{text}</pre>
          </details>
        ) : null}
      </div>
    );
  }

  const isDiff = artifact.type === "diff" || looksLikeDiff(text);
  if (!isDiff) {
    return <pre className="artifact-preview">{text}</pre>;
  }
  const showSummary = looksLikeDiff(text);
  const files = splitDiffByFile(text);
  if (files.length > 1) {
    return (
      <div className="artifact-preview diff-preview diff-file-preview" role="region" aria-label="Diff preview">
        {showSummary ? <DiffSummaryBar text={text} /> : null}
        {files.map((file, fileIndex) => (
          <details key={`${fileIndex}-${file.title}`} className="diff-file-section" open>
            <summary>{file.title}</summary>
            {file.lines.map((line, index) => {
              const tone = diffLineTone(line);
              return (
                <div key={`${index}-${line}`} className={`diff-line ${tone}`}>
                  <span className="diff-gutter">{index + 1}</span>
                  <code>{line || " "}</code>
                </div>
              );
            })}
          </details>
        ))}
      </div>
    );
  }

  return (
    <div className="artifact-preview diff-preview" role="region" aria-label="Diff preview">
      {showSummary ? <DiffSummaryBar text={text} /> : null}
      {text.split("\n").map((line, index) => {
        const tone = diffLineTone(line);
        return (
          <div key={`${index}-${line}`} className={`diff-line ${tone}`}>
            <span className="diff-gutter">{index + 1}</span>
            <code>{line || " "}</code>
          </div>
        );
      })}
    </div>
  );
}

function DiffSummaryBar({ text }: { text: string }) {
  const stats = diffStats(text);
  return (
    <div className="diff-summary-bar" aria-label="Diff summary">
      <span>{stats.filesChanged} {stats.filesChanged === 1 ? "file" : "files"}</span>
      <strong className="diff-stat-added">+{stats.added}</strong>
      <strong className="diff-stat-removed">-{stats.removed}</strong>
    </div>
  );
}

function diffStats(text: string): { filesChanged: number; added: number; removed: number } {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      files.add(match?.[2] ?? line.replace(/^diff --git /, ""));
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!line.includes("/dev/null")) files.add(line.replace(/^\+\+\+\s+(?:b\/)?/, ""));
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added += 1;
    if (line.startsWith("-")) removed += 1;
  }
  return { filesChanged: files.size, added, removed };
}

function splitDiffByFile(text: string): Array<{ title: string; lines: string[] }> {
  const sections: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) sections.push(current);
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { title: match?.[2] ?? line.replace(/^diff --git /, ""), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function looksLikeDiff(text: string): boolean {
  return /^diff --git /m.test(text) || /^@@ /m.test(text) || /^(\+\+\+|---) /m.test(text);
}

function diffLineTone(line: string): "add" | "remove" | "hunk" | "file" | "context" {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff --git") || line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}
