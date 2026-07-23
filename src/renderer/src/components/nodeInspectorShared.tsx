import { t } from "@renderer/i18n";
import {
  AlertTriangle,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  Loader2,
  PlayCircle,
  Copy,
  FileArchive,
  FileText,
  GitBranch,
  HelpCircle,
  Lock,
  MessageSquare,
  MoreHorizontal,
  MoveUpRight,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
  XCircle
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, TextareaHTMLAttributes } from "react";
import { nodeFlagSchema, nodeStageSchema, type Artifact, type Note, type NodeFlag, type NodeStage, type ProjectSettings } from "@shared/schema";
import type { ArchicodeNode, Flow, FlowEdge } from "@shared/schema";
import { subflowDepth } from "@shared/graph";
import { getActiveFlow, getSelectedEdge, getSelectedNode, useArchicodeStore } from "../store/useArchicodeStore";
import { builtInNodeTypes } from "../utils/nodeTypes";
import { isRunBlockingNewChange } from "../utils/runStatus";
import { runFailureDetails } from "../utils/runErrors";
import {
  Badge,
  Button,
  DialogRoot,
  DialogContent,
  DialogClose,
  EmptyState,
  Field,
  IconButton,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  PanelHeader,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  ScrollArea,
  Select,
  StatusPill,
  Switch,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
  TextArea,
  TextInput,
  Tooltip
} from "./ui";


export const stages = nodeStageSchema.options;
export const flags = nodeFlagSchema.options;
export const nodeColorSwatches = ["#7bc6d5", "#8bd39e", "#f0c66b", "#f08a7a", "#b7a7ff", "#f3f6f8", "#58a6ff", "#ff9f43", "#e056a7"];
export const noGroupValue = "__none__";
export const mixedGroupValue = "__mixed__";
export const mixedColorValue = "__mixed_color__";
export const defaultAccentColor = "#7bc6d5";
export const defaultNodeSize = { width: 248, height: 154 };
export const defaultEdgeWidth = 2.35;
export const nodeSizeBounds = {
  width: { min: 180, max: 420 },
  height: { min: 116, max: 300 }
};
export const edgeWidthBounds = { min: 1, max: 8 };
export const edgeLineStyleOptions: Array<{ value: NonNullable<FlowEdge["lineStyle"]>; label: string }> = [
  { value: "solid", label: t("Solid") },
  { value: "dashed", label: t("Dashed") },
  { value: "dotted", label: t("Dotted") }
];
export const nodeShapeOptions: Array<{ value: NonNullable<ArchicodeNode["visual"]["shape"]>; label: string }> = [
  { value: "rounded", label: t("Rounded") },
  { value: "rectangle", label: t("Rectangle") },
  { value: "capsule", label: t("Capsule") },
  { value: "document", label: t("Folded corner") },
  { value: "database", label: t("Stacked") },
  { value: "note", label: t("Cut corner") },
  { value: "ellipse", label: t("Ellipse") },
  { value: "diamond", label: t("Diamond") },
  { value: "hexagon", label: t("Hexagon") },
  { value: "parallelogram", label: t("Parallelogram") },
  { value: "cloud", label: t("Cloud") },
  { value: "actor", label: t("Actor") }
];

export function GroupColorSwatches({ label, value, onChange }: { label: string; value: string; onChange: (color: string) => void }) {
  return (
    <div className="node-color-palette node-group-color-palette">
      <span>{label}</span>
      <div className="node-color-swatches" aria-label={t("{{label}} presets", { label: label })}>
        {nodeColorSwatches.map((color) => (
          <button
            key={color}
            type="button"
            className={value === color ? "is-active" : ""}
            style={{ backgroundColor: color }}
            aria-label={t("Use {{color}} group accent", { color: color })}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
    </div>
  );
}

export type ReadinessItem = {
  label: string;
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  tooltip?: string;
  dismissLabel?: string;
  onDismiss?: () => Promise<void>;
};

export function clampEdgeWidth(value: number): number {
  return Math.min(edgeWidthBounds.max, Math.max(edgeWidthBounds.min, Math.round(value * 10) / 10));
}

export function edgeColorOptions(theme: "light" | "dark") {
  const palette = theme === "dark"
    ? ["#7bc6d5", "#8bd39e", "#f0c66b", "#f08a7a", "#b7a7ff", "#d7dee3", "#58a6ff", "#ffb067", "#f28fc2"]
    : ["#287282", "#2e7445", "#9a680d", "#b84032", "#7258d8", "#667784", "#1f69d2", "#bd6f14", "#b24486"];
  return [
    { id: "default", label: t("Default"), value: null, className: "is-default" },
    ...palette.map((color) => ({ id: color, label: color, value: color, className: undefined }))
  ] as Array<{ id: string; label: string; value: string | null; className?: string }>;
}

export type NoteFilter = "all" | "pinned" | "open" | "resolved" | "bugs" | "agent-questions" | "my-notes" | "system-notes";

export const noteFilterOptions: Array<{ value: NoteFilter; label: string }> = [
  { value: "all", label: t("Relevant notes") },
  { value: "pinned", label: t("Pinned") },
  { value: "open", label: t("Open") },
  { value: "resolved", label: t("Resolved") },
  { value: "bugs", label: t("Bugs") },
  { value: "agent-questions", label: t("Agent questions") },
  { value: "my-notes", label: t("My notes") },
  { value: "system-notes", label: t("System notes") }
];
export const utilityTabValues = ["advanced"];
export type CustomNodeType = ProjectSettings["customNodeTypes"][number];
export type CustomNodeProperty = ProjectSettings["customNodeProperties"][number];
export type CustomNodePropertyType = CustomNodeProperty["type"];
export type NodeRule = NonNullable<ProjectSettings["nodeRules"]>[number];
export const customPropertyTypeOptions: Array<{ value: CustomNodePropertyType; label: string }> = [
  { value: "text", label: t("Text") },
  { value: "long-text", label: t("Long text") },
  { value: "number", label: t("Number") },
  { value: "checkbox", label: t("Checkbox") },
  { value: "date", label: t("Date") },
  { value: "color", label: t("Color") },
  { value: "url", label: t("URL") }
];
export const customPropertyTypeLabels = Object.fromEntries(customPropertyTypeOptions.map((option) => [option.value, option.label])) as Record<CustomNodePropertyType, string>;
export const fallbackCustomColor = "#7bc6d5";
export const moduleProfileAutoValue = "__auto__";
export const moduleProfileNoneValue = "__none__";
export const titleFieldHint = "Use a short, stable name for the thing this node owns so users and agents can refer to it unambiguously.";
export const typeFieldHint = "Type classifies the node's role in the graph and AI context. You can use the built-in presets or create your own custom types for this project, and custom types are saved so they can be reused later.";
export const descriptionFieldHint = "Description is the shared brief for this node. Explain what it owns, why it exists, key constraints, and what success looks like.";
export const acceptanceCriteriaFieldHint = "List concrete, verifiable checks that tell users and agents when this node's work is correct. Keep one testable outcome per line.";
export const techStackFieldHint = "List the main technologies, frameworks, runtimes, or platforms this node depends on. Use short comma-separated names so users and agents can quickly understand the implementation context.";
export const customKeysFieldHint = "Custom keys let you add reusable project-specific fields to every node, such as owner, priority, team, milestone, or URL. Create the key once here, then fill values on individual nodes below.";
export const groupFieldHint = "Groups are lightweight visual clusters inside the current flow. Use them to organize related nodes without changing ownership, stage, or graph behavior.";
export const stageFieldHint = (
  <div style={{ display: "grid", gap: 6 }}>
    <div>{t("Stage tracks where this node sits in the workflow. Agents usually update it as work moves forward, unless you want to override the lifecycle manually.")}</div>
    <div><strong>{t("planned")}</strong>{t(": work is identified but not yet in active implementation.")}</div>
    <div><strong>{t("plan-approved")}</strong>{t(": the intended approach is approved and ready to be carried out.")}</div>
    <div><strong>{t("working")}</strong>{t(": implementation or investigation is actively in progress.")}</div>
    <div><strong>{t("draft")}</strong>{t(": a draft result exists and still needs review or iteration.")}</div>
    <div><strong>{t("draft-rejected")}</strong>{t(": the last draft was rejected and needs revision.")}</div>
    <div><strong>{t("draft-approved-production")}</strong>{t(": the draft is accepted as production truth and becomes locked until revised.")}</div>
  </div>
);

export function createNodeRuleId(label: string, existingIds: Set<string>): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "rule";
  let candidate = `rule-${base}`;
  let index = 2;
  while (existingIds.has(candidate)) {
    candidate = `rule-${base}-${index}`;
    index += 1;
  }
  return candidate;
}

export function inferRuleTitle(body: string): string {
  return body.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 56) || "New rule";
}

export async function writeClipboardText(text: string): Promise<void> {
  if (window.archicode?.copyTextToClipboard) {
    window.archicode.copyTextToClipboard(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

export function customPropertyId(label: string, existingIds: Set<string>): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom-key";
  let candidate = `custom-${base}`;
  let index = 2;
  while (existingIds.has(candidate)) {
    candidate = `custom-${base}-${index}`;
    index += 1;
  }
  return candidate;
}

export function withCustomPropertyValue(node: ArchicodeNode, propertyId: string, rawValue: string): ArchicodeNode["customProperties"] {
  const next = { ...(node.customProperties ?? {}) };
  if (rawValue.trim()) next[propertyId] = rawValue;
  else delete next[propertyId];
  return next;
}

export function withoutCustomProperty(values: ArchicodeNode["customProperties"] | undefined, propertyId: string): ArchicodeNode["customProperties"] {
  const next = { ...(values ?? {}) };
  delete next[propertyId];
  return next;
}

export function renderCustomPropertyWidget(
  node: ArchicodeNode,
  property: CustomNodeProperty,
  onChange: (value: string) => void
): ReactNode {
  const value = node.customProperties?.[property.id] ?? "";
  if (property.type === "long-text") {
    return (
      <AutoSizeTextArea
        className="custom-node-property-textarea"
        minRows={2}
        maxRows={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (property.type === "checkbox") {
    return (
      <Switch
        checked={value === "true"}
        onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
        label={value === "true" ? t("Yes") : t("No")}
      />
    );
  }
  if (property.type === "color") {
    const pickerValue = isHexColor(value) ? value : fallbackCustomColor;
    return (
      <div className="custom-node-property-color">
        <input
          type="color"
          value={pickerValue}
          aria-label={t("{{label}} color", { label: property.label })}
          onChange={(event) => onChange(event.target.value)}
        />
        <TextInput
          value={value}
          placeholder={t("#7bc6d5")}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }
  return (
    <TextInput
      type={property.type === "number" ? "number" : property.type === "date" ? "date" : property.type === "url" ? "url" : "text"}
      value={value}
      placeholder={property.type === "url" ? "https://example.com" : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function isResolvableNote(note: Note): boolean {
  return note.kind !== "system-note";
}

export function isSystemGeneratedNote(note: Note): boolean {
  return note.kind === "system-note" || note.author === "system";
}

export function isImageArtifact(artifact: Artifact | undefined): artifact is Artifact {
  return Boolean(artifact?.mediaType?.startsWith("image/"));
}

export function isNonImageArtifact(artifact: Artifact): boolean {
  return !artifact.mediaType?.startsWith("image/");
}

export function uniqueArtifacts(artifacts: Artifact[]): Artifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.id)) return false;
    seen.add(artifact.id);
    return true;
  });
}

export function newestNote(notes: Note[]): Note | undefined {
  return [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

export function isDefaultVisibleNote(note: Note): boolean {
  return note.pinned || !isSystemGeneratedNote(note);
}

export function noteSearchText(note: Note, attachmentTitles: string[]): string {
  return [
    displayNoteLabel(note),
    note.body,
    note.category,
    note.priority,
    note.author,
    note.createdAt,
    ...attachmentTitles
  ].join(" ").toLocaleLowerCase();
}

export type AutoSizeTextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  maxRows?: number;
  minRows?: number;
  value: string;
};

export function AutoSizeTextArea({ className, maxRows = 14, minRows = 3, onInput, value, ...props }: AutoSizeTextAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const resizeTextarea = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const style = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(style.lineHeight) || 18;
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const border = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    const minHeight = lineHeight * minRows + padding + border;
    const maxHeight = lineHeight * maxRows + padding + border;

    textarea.style.height = "auto";
    const nextHeight = Math.max(minHeight, Math.min(textarea.scrollHeight + border, maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight + border > maxHeight ? "auto" : "hidden";
  };

  useLayoutEffect(() => {
    resizeTextarea();
  }, [value, minRows, maxRows]);

  return (
    <TextArea
      {...props}
      ref={textareaRef}
      className={["inspector-auto-textarea", className].filter(Boolean).join(" ")}
      value={value}
      onInput={(event) => {
        resizeTextarea();
        onInput?.(event);
      }}
    />
  );
}

export function statusTone(status: string): "neutral" | "accent" | "success" | "warning" | "danger" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "needs-permission") return "warning";
  if (status === "preparing" || status === "running" || status === "queued") return "accent";
  return "neutral";
}

export function noteLabel(kind: Note["kind"]): string {
  if (kind === "llm-question") return "Agent question";
  if (kind === "user-answer") return "Answer";
  if (kind === "system-note") return "System note";
  return "Note";
}

export function clampNodeSize(value: number, axis: keyof typeof nodeSizeBounds): number {
  const bounds = nodeSizeBounds[axis];
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

export function displayNoteLabel(note: Note): string {
  if (note.category === "bug") return "Bug";
  if (note.category === "task") return "Task";
  if (note.category === "decision") return "Decision";
  if (note.author === "llm" && note.kind === "system-note") return "LLM handoff";
  return noteLabel(note.kind);
}

export function sortNodeNotes(a: Note, b: Note): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt);
}

export function appendLocalEdgeLabelHistory(history: string[], label: string | null | undefined): string[] {
  const normalizedLabel = label?.trim();
  if (!normalizedLabel) return history;
  const normalizedKey = normalizedLabel.toLocaleLowerCase();
  return [
    normalizedLabel,
    ...history.filter((item) => item.trim().toLocaleLowerCase() !== normalizedKey)
  ].slice(0, 50);
}

export function isBuiltInNodeType(type: string): boolean {
  const normalized = type.trim().toLocaleLowerCase();
  return builtInNodeTypes.some((item) => item.toLocaleLowerCase() === normalized);
}

export function appendCustomNodeTypeHistory(history: CustomNodeType[], type: string | null | undefined): CustomNodeType[] {
  const normalizedType = type?.trim();
  if (!normalizedType || isBuiltInNodeType(normalizedType)) return history;
  const normalizedKey = normalizedType.toLocaleLowerCase();
  return [
    normalizedType,
    ...history.filter((item) => item.trim().toLocaleLowerCase() !== normalizedKey)
  ].slice(0, 100);
}

export function removeCustomNodeTypeHistory(history: CustomNodeType[], type: string): CustomNodeType[] {
  const normalizedKey = type.trim().toLocaleLowerCase();
  return history.filter((item) => item.trim().toLocaleLowerCase() !== normalizedKey);
}

export function buildQuestionAnswerThreads(notes: Note[]): {
  answersByQuestionId: Map<string, Note[]>;
  answerToQuestionId: Map<string, string>;
} {
  const questions = new Map<string, Note>();
  const implicitQueues = new Map<string, Note[]>();
  const implicitlyAnswered = new Set<string>();
  const answersByQuestionId = new Map<string, Note[]>();
  const answerToQuestionId = new Map<string, string>();

  for (const note of notes) {
    if (note.kind === "llm-question") {
      questions.set(note.id, note);
      implicitQueues.set(note.nodeId, [...(implicitQueues.get(note.nodeId) ?? []), note]);
      continue;
    }
    if (note.kind !== "user-answer") continue;
    const explicitQuestionId = note.replyToNoteId && questions.has(note.replyToNoteId)
      ? note.replyToNoteId
      : null;
    const inferredQuestionId = explicitQuestionId ?? (implicitQueues.get(note.nodeId) ?? [])
      .find((question) => question.createdAt <= note.createdAt && !implicitlyAnswered.has(question.id))?.id ?? null;
    if (!inferredQuestionId) continue;
    if (!explicitQuestionId) implicitlyAnswered.add(inferredQuestionId);
    answerToQuestionId.set(note.id, inferredQuestionId);
    answersByQuestionId.set(inferredQuestionId, [
      ...(answersByQuestionId.get(inferredQuestionId) ?? []),
      note
    ]);
  }

  return { answersByQuestionId, answerToQuestionId };
}

export const flagTooltips: Record<NodeFlag, string> = {
  changed: "The node has new or edited planning state.",
  "has-diff": "A code or JSON diff is linked to this node.",
  "needs-attention": "The harness needs user attention before continuing safely.",
  "has-attachments": "Files, logs, screenshots, or other artifacts are attached.",
  "llm-question": "The LLM asked a clarification question for this node.",
  "modified-not-built": "The node changed but has not been verified by a build run yet.",
  "user-approved": "The user approved this node state."
};

