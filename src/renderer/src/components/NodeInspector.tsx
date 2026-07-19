import {
  AlertTriangle,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  CircleHelp,
  Loader2,
  PlayCircle,
  Copy,
  FileArchive,
  FileCode2,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  HelpCircle,
  Lock,
  Maximize2,
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
import { useShallow } from "zustand/react/shallow";
import type { ReactNode, TextareaHTMLAttributes } from "react";
import { nodeFlagSchema, nodeStageSchema, type Artifact, type Note, type NodeFlag, type NodeStage, type ProjectSettings } from "@shared/schema";
import type {
  ArchicodeNode,
  ArchitecturePolicyConstraint,
  ArchitecturePolicyConstraintKind,
  ArchitecturePolicyFileNameStyle,
  ArchitecturePolicyMetadataField,
  ArchitecturePolicyNodeScope,
  Flow,
  FlowEdge
} from "@shared/schema";
import type { GraphNodeHistory } from "@shared/graphHistory";
import { gaiaAgent } from "@shared/agentIdentities";
import { subflowDepth } from "@shared/graph";
import { getActiveFlow, getSelectedEdge, getSelectedNode, useArchicodeStore } from "../store/useArchicodeStore";
import { builtInNodeTypes } from "../utils/nodeTypes";
import { explainEdgePrompt } from "../utils/explainPrompts";
import { getNodeSignalCounts, nodePolicyViolationTooltip } from "../utils/nodeSignals";
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


import { AutoSizeTextArea, type CustomNodePropertyType, GroupColorSwatches, type NodeRule, type NoteFilter, type ReadinessItem, acceptanceCriteriaFieldHint, appendCustomNodeTypeHistory, appendLocalEdgeLabelHistory, buildQuestionAnswerThreads, clampNodeSize, createNodeRuleId, customKeysFieldHint, customPropertyId, customPropertyTypeLabels, customPropertyTypeOptions, defaultAccentColor, defaultEdgeWidth, defaultNodeSize, descriptionFieldHint, displayNoteLabel, edgeColorOptions, edgeLineStyleOptions, fileNameFromPath, flagTooltips, flags, groupFieldHint, inferRuleTitle, isBuiltInNodeType, isDefaultVisibleNote, isImageArtifact, isNonImageArtifact, isResolvableNote, isSystemGeneratedNote, mixedColorValue, mixedGroupValue, moduleProfileAutoValue, moduleProfileNoneValue, noGroupValue, nodeColorSwatches, nodeShapeOptions, nodeSizeBounds, noteFilterOptions, noteSearchText, removeCustomNodeTypeHistory, renderCustomPropertyWidget, sortNodeNotes, stageFieldHint, stages, statusTone, techStackFieldHint, titleFieldHint, typeFieldHint, uniqueArtifacts, utilityTabValues, withCustomPropertyValue, withoutCustomProperty, writeClipboardText } from "./nodeInspectorShared";

const ruleKindOptions: Array<{ value: NonNullable<NodeRule["kind"]>; label: string; hint: string; tooltip: string }> = [
  {
    value: "guidance",
    label: "Guidance",
    hint: "Agent instruction",
    tooltip: "Reusable advice included in agent context. It guides implementation but is not checked against the code automatically."
  },
  {
    value: "decision",
    label: "Decision",
    hint: "Recorded choice",
    tooltip: "A durable architecture or product choice included in agent context so later work preserves the reasoning. It is not an automatic code check."
  },
  {
    value: "policy",
    label: "Live policy",
    hint: "Deterministic check",
    tooltip: "A machine-checkable rule evaluated locally from repository and graph facts. Choose the specific deterministic check below; no AI model is called during evaluation."
  }
];

const ruleSeverityOptions: Array<{ value: NonNullable<NodeRule["severity"]>; label: string; hint: string; tooltip: string }> = [
  {
    value: "info",
    label: "Info",
    hint: "Low urgency",
    tooltip: "Records the violation as useful architecture information. It is visible but never blocks a run."
  },
  {
    value: "warning",
    label: "Warning",
    hint: "Needs review",
    tooltip: "Highlights an architecture concern that should be reviewed. Warnings remain non-blocking, even when enforcement is set to Enforced."
  },
  {
    value: "error",
    label: "Error",
    hint: "Can block",
    tooltip: "Marks a serious architecture violation. When paired with Enforced, newly introduced violations fail source-changing runs."
  }
];

const ruleEnforcementOptions: Array<{ value: NonNullable<NodeRule["enforcement"]>; label: string; hint: string; tooltip: string }> = [
  {
    value: "advisory",
    label: "Advisory",
    hint: "Report only",
    tooltip: "Reports matching violations in the graph and issue panel, but never fails a run."
  },
  {
    value: "enforced",
    label: "Enforced",
    hint: "Gate new errors",
    tooltip: "With Error severity, fails a source-changing run only when it introduces a new violation. Existing baseline violations do not block the run."
  }
];

function RuleControl({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="node-rule-control">
      <span className="node-rule-control-label">
        <span>{label}</span>
        <Tooltip content={help}>
          <span className="ui-field-hint-button" tabIndex={0} aria-label={`${label} help`}>
            <HelpCircle size={13} aria-hidden="true" />
          </span>
        </Tooltip>
      </span>
      {children}
    </div>
  );
}

type PolicyConstraintDraft = {
  kind: ArchitecturePolicyConstraintKind;
  sourcePaths: string;
  targetPaths: string;
  importedNames: string;
  nodeScope: ArchitecturePolicyNodeScope;
  metadataField: ArchitecturePolicyMetadataField;
  relationshipMode: "required" | "forbidden";
  relationshipDirection: "incoming" | "outgoing" | "either";
  targetNodeTypes: string;
  fileNameStyle: ArchitecturePolicyFileNameStyle | "none";
  requiredSuffix: string;
  companionMatch: "same-stem" | "any";
};

const defaultPolicyConstraintDraft: PolicyConstraintDraft = {
  kind: "forbidden-dependency",
  sourcePaths: "",
  targetPaths: "",
  importedNames: "",
  nodeScope: "attached",
  metadataField: "acceptance-criteria",
  relationshipMode: "required",
  relationshipDirection: "either",
  targetNodeTypes: "",
  fileNameStyle: "none",
  requiredSuffix: "",
  companionMatch: "same-stem"
};

const policyCheckOptions: Array<{ value: ArchitecturePolicyConstraintKind; label: string; hint: string; tooltip: string }> = [
  { value: "forbidden-dependency", label: "Forbidden dependency", hint: "Block A → B", tooltip: "Reports any dependency from selected source files to forbidden target files." },
  { value: "required-dependency", label: "Required dependency", hint: "Require A → B", tooltip: "Reports each selected source file that does not depend on at least one required target." },
  { value: "allowed-dependency", label: "Allowed dependencies only", hint: "Module boundary", tooltip: "Reports dependencies from selected source files to anything outside the allowed target areas. This can enforce layer direction and public module boundaries." },
  { value: "no-cycles", label: "No dependency cycles", hint: "Acyclic area", tooltip: "Finds circular file dependencies within the selected repository area." },
  { value: "forbidden-import", label: "Forbidden package or API", hint: "Block imports", tooltip: "Reports imports of selected packages, modules, or named imported APIs." },
  { value: "file-convention", label: "File placement and naming", hint: "Repository convention", tooltip: "Checks selected files for allowed locations, a naming style, or a required suffix." },
  { value: "required-companion-file", label: "Required test or documentation", hint: "Companion file", tooltip: "Requires each selected source file to have a matching test, documentation, or other companion file." },
  { value: "required-node-metadata", label: "Required node metadata", hint: "Graph completeness", tooltip: "Requires graph nodes to contain acceptance criteria, checks, documentation, implementation scope, or other structured metadata." },
  { value: "node-relationship", label: "Graph relationship", hint: "Required or forbidden edge", tooltip: "Requires or forbids incoming or outgoing relationships between selected graph nodes and optional node types." },
  { value: "no-orphan-nodes", label: "No orphan graph nodes", hint: "Connected graph", tooltip: "Reports selected graph nodes that have no incoming or outgoing relationship." }
];

const nodeScopeOptions: Array<{ value: ArchitecturePolicyNodeScope; label: string; hint: string }> = [
  { value: "attached", label: "Attached nodes", hint: "Only nodes carrying this rule" },
  { value: "subflow", label: "Attached subflows", hint: "Every node beside attached nodes" },
  { value: "flow", label: "Attached flows", hint: "Every node in those flows" },
  { value: "project", label: "Whole project", hint: "Every graph node" }
];

const metadataFieldOptions: Array<{ value: ArchitecturePolicyMetadataField; label: string; hint: string }> = [
  { value: "description", label: "Description", hint: "Non-empty node description" },
  { value: "tech-stack", label: "Technology tag", hint: "At least one technology" },
  { value: "acceptance-criteria", label: "Acceptance criteria", hint: "At least one criterion" },
  { value: "acceptance-check", label: "Acceptance test/check", hint: "At least one check" },
  { value: "passing-acceptance-check", label: "Passing acceptance check", hint: "At least one verified check" },
  { value: "implementation-scope", label: "Implementation scope", hint: "At least one linked code claim" },
  { value: "documentation", label: "Documentation", hint: "Linked documentation artifact" }
];

function parsePolicyList(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function policyDraftFromConstraint(constraint?: ArchitecturePolicyConstraint): PolicyConstraintDraft {
  if (!constraint) return { ...defaultPolicyConstraintDraft };
  const draft = { ...defaultPolicyConstraintDraft, kind: constraint.kind };
  if (constraint.kind === "forbidden-dependency" || constraint.kind === "required-dependency") {
    return { ...draft, sourcePaths: constraint.fromPathGlobs.join("\n"), targetPaths: constraint.toPathGlobs.join("\n") };
  }
  if (constraint.kind === "allowed-dependency") {
    return { ...draft, sourcePaths: constraint.fromPathGlobs.join("\n"), targetPaths: constraint.allowedPathGlobs.join("\n") };
  }
  if (constraint.kind === "no-cycles") return { ...draft, sourcePaths: constraint.pathGlobs.join("\n") };
  if (constraint.kind === "forbidden-import") {
    return { ...draft, sourcePaths: constraint.fromPathGlobs.join("\n"), targetPaths: constraint.importGlobs.join("\n"), importedNames: constraint.importedNames.join("\n") };
  }
  if (constraint.kind === "file-convention") {
    return { ...draft, sourcePaths: constraint.pathGlobs.join("\n"), targetPaths: constraint.allowedPathGlobs.join("\n"), fileNameStyle: constraint.fileNameStyle ?? "none", requiredSuffix: constraint.requiredSuffix ?? "" };
  }
  if (constraint.kind === "required-companion-file") {
    return { ...draft, sourcePaths: constraint.sourcePathGlobs.join("\n"), targetPaths: constraint.companionPathGlobs.join("\n"), companionMatch: constraint.match };
  }
  if (constraint.kind === "required-node-metadata") return { ...draft, nodeScope: constraint.scope, metadataField: constraint.field };
  if (constraint.kind === "node-relationship") {
    return { ...draft, nodeScope: constraint.scope, relationshipMode: constraint.mode, relationshipDirection: constraint.direction, targetNodeTypes: constraint.targetNodeTypes.join("\n") };
  }
  return { ...draft, nodeScope: constraint.scope };
}

function buildPolicyConstraint(draft: PolicyConstraintDraft): ArchitecturePolicyConstraint | null {
  const source = parsePolicyList(draft.sourcePaths);
  const target = parsePolicyList(draft.targetPaths);
  if (draft.kind === "forbidden-dependency") return source.length && target.length ? { kind: draft.kind, fromPathGlobs: source, toPathGlobs: target, includeRuntime: false } : null;
  if (draft.kind === "required-dependency") return source.length && target.length ? { kind: draft.kind, fromPathGlobs: source, toPathGlobs: target, includeRuntime: false } : null;
  if (draft.kind === "allowed-dependency") return source.length && target.length ? { kind: draft.kind, fromPathGlobs: source, allowedPathGlobs: target, includeRuntime: false } : null;
  if (draft.kind === "no-cycles") return source.length ? { kind: draft.kind, pathGlobs: source, includeRuntime: false } : null;
  if (draft.kind === "forbidden-import") return source.length && target.length ? { kind: draft.kind, fromPathGlobs: source, importGlobs: target, importedNames: parsePolicyList(draft.importedNames) } : null;
  if (draft.kind === "file-convention") {
    const requiredSuffix = draft.requiredSuffix.trim();
    if (!source.length || (!target.length && draft.fileNameStyle === "none" && !requiredSuffix)) return null;
    return { kind: draft.kind, pathGlobs: source, allowedPathGlobs: target, ...(draft.fileNameStyle !== "none" ? { fileNameStyle: draft.fileNameStyle } : {}), ...(requiredSuffix ? { requiredSuffix } : {}) };
  }
  if (draft.kind === "required-companion-file") return source.length && target.length ? { kind: draft.kind, sourcePathGlobs: source, companionPathGlobs: target, match: draft.companionMatch } : null;
  if (draft.kind === "required-node-metadata") return { kind: draft.kind, scope: draft.nodeScope, field: draft.metadataField };
  if (draft.kind === "node-relationship") return { kind: draft.kind, scope: draft.nodeScope, mode: draft.relationshipMode, direction: draft.relationshipDirection, targetNodeTypes: parsePolicyList(draft.targetNodeTypes) };
  return { kind: draft.kind, scope: draft.nodeScope };
}

function policyConstraintSummary(constraint: ArchitecturePolicyConstraint): string[] {
  if (constraint.kind === "forbidden-dependency") return [`From ${constraint.fromPathGlobs.join(", ")}`, `Must not depend on ${constraint.toPathGlobs.join(", ")}`];
  if (constraint.kind === "required-dependency") return [`From ${constraint.fromPathGlobs.join(", ")}`, `Must depend on ${constraint.toPathGlobs.join(", ")}`];
  if (constraint.kind === "allowed-dependency") return [`From ${constraint.fromPathGlobs.join(", ")}`, `May depend only on ${constraint.allowedPathGlobs.join(", ")}`];
  if (constraint.kind === "no-cycles") return [`No cycles within ${constraint.pathGlobs.join(", ")}`];
  if (constraint.kind === "forbidden-import") return [`From ${constraint.fromPathGlobs.join(", ")}`, `Must not import ${constraint.importGlobs.join(", ")}${constraint.importedNames.length ? `: ${constraint.importedNames.join(", ")}` : ""}`];
  if (constraint.kind === "file-convention") return [`Files ${constraint.pathGlobs.join(", ")}`, [constraint.allowedPathGlobs.length ? `locations: ${constraint.allowedPathGlobs.join(", ")}` : "", constraint.fileNameStyle ? `names: ${constraint.fileNameStyle}` : "", constraint.requiredSuffix ? `suffix: ${constraint.requiredSuffix}` : ""].filter(Boolean).join(" · ")];
  if (constraint.kind === "required-companion-file") return [`Files ${constraint.sourcePathGlobs.join(", ")}`, `Need ${constraint.companionPathGlobs.join(", ")} (${constraint.match === "same-stem" ? "same name" : "any match"})`];
  if (constraint.kind === "required-node-metadata") return [`${constraint.scope} nodes require ${metadataFieldOptions.find((item) => item.value === constraint.field)?.label ?? constraint.field}`];
  if (constraint.kind === "node-relationship") return [`${constraint.scope} nodes: ${constraint.mode} ${constraint.direction} relationship${constraint.targetNodeTypes.length ? ` with ${constraint.targetNodeTypes.join(", ")}` : ""}`];
  return [`No orphan nodes in ${constraint.scope} scope`];
}

function PolicyConstraintEditor({ draft, onChange }: { draft: PolicyConstraintDraft; onChange: (draft: PolicyConstraintDraft) => void }) {
  const set = <K extends keyof PolicyConstraintDraft>(key: K, value: PolicyConstraintDraft[K]) => onChange({ ...draft, [key]: value });
  const pathHelp = "Enter exact project-relative files or patterns. ** includes everything in subfolders. Separate multiple entries with new lines or commas.";
  const dependencyKind = draft.kind === "forbidden-dependency" || draft.kind === "required-dependency" || draft.kind === "allowed-dependency";
  return (
    <>
      <RuleControl label="Deterministic check" help="The exact local rule that will be evaluated continuously. Hover each option for its behavior and required inputs.">
        <Select ariaLabel="Deterministic policy check" value={draft.kind} onValueChange={(value) => set("kind", value as ArchitecturePolicyConstraintKind)} options={policyCheckOptions} />
      </RuleControl>
      {dependencyKind ? <>
        <RuleControl label="Source files or patterns" help={pathHelp}>
          <TextArea aria-label="Source files or patterns" value={draft.sourcePaths} rows={2} placeholder="src/renderer/**" onChange={(event) => set("sourcePaths", event.target.value)} />
        </RuleControl>
        <RuleControl label={draft.kind === "allowed-dependency" ? "Allowed dependencies or patterns" : draft.kind === "required-dependency" ? "Required dependencies or patterns" : "Forbidden dependencies or patterns"} help={pathHelp}>
          <TextArea aria-label="Target files or patterns" value={draft.targetPaths} rows={2} placeholder="src/shared/**" onChange={(event) => set("targetPaths", event.target.value)} />
        </RuleControl>
      </> : null}
      {draft.kind === "no-cycles" ? <RuleControl label="Files included in the cycle check" help={pathHelp}>
        <TextArea aria-label="Files included in the cycle check" value={draft.sourcePaths} rows={2} placeholder="src/**" onChange={(event) => set("sourcePaths", event.target.value)} />
      </RuleControl> : null}
      {draft.kind === "forbidden-import" ? <>
        <RuleControl label="Source files or patterns" help={pathHelp}>
          <TextArea aria-label="Source files or patterns" value={draft.sourcePaths} rows={2} placeholder="src/**" onChange={(event) => set("sourcePaths", event.target.value)} />
        </RuleControl>
        <RuleControl label="Forbidden packages or modules" help="Enter import names or patterns such as electron, node:fs, lodash/**, or @company/private-package.">
          <TextArea aria-label="Forbidden packages or modules" value={draft.targetPaths} rows={2} placeholder="node:fs" onChange={(event) => set("targetPaths", event.target.value)} />
        </RuleControl>
        <RuleControl label="Forbidden imported APIs (optional)" help="Limit the rule to named imports such as readFile or exec. Leave empty to forbid the whole package or module.">
          <TextArea aria-label="Forbidden imported APIs" value={draft.importedNames} rows={2} placeholder="readFile" onChange={(event) => set("importedNames", event.target.value)} />
        </RuleControl>
      </> : null}
      {draft.kind === "file-convention" ? <>
        <RuleControl label="Files to check" help={pathHelp}>
          <TextArea aria-label="Files to check" value={draft.sourcePaths} rows={2} placeholder="src/components/**/*.tsx" onChange={(event) => set("sourcePaths", event.target.value)} />
        </RuleControl>
        <RuleControl label="Allowed locations (optional)" help={`${pathHelp} Leave empty when only checking names or suffixes.`}>
          <TextArea aria-label="Allowed file locations" value={draft.targetPaths} rows={2} placeholder="src/components/**" onChange={(event) => set("targetPaths", event.target.value)} />
        </RuleControl>
        <div className="node-rule-policy-options">
          <RuleControl label="File naming" help="Optionally require the file name, before its extension, to follow a common naming style.">
            <Select ariaLabel="File naming style" value={draft.fileNameStyle} onValueChange={(value) => set("fileNameStyle", value as PolicyConstraintDraft["fileNameStyle"])} options={[{ value: "none", label: "No naming check" }, { value: "kebab-case", label: "kebab-case" }, { value: "camelCase", label: "camelCase" }, { value: "PascalCase", label: "PascalCase" }, { value: "snake_case", label: "snake_case" }]} />
          </RuleControl>
          <RuleControl label="Required suffix (optional)" help="Text that must appear at the end of the file name before its extension, such as .service or Controller.">
            <TextInput aria-label="Required file suffix" value={draft.requiredSuffix} placeholder=".service" onChange={(event) => set("requiredSuffix", event.target.value)} />
          </RuleControl>
        </div>
      </> : null}
      {draft.kind === "required-companion-file" ? <>
        <RuleControl label="Source files or patterns" help={pathHelp}>
          <TextArea aria-label="Source files requiring companions" value={draft.sourcePaths} rows={2} placeholder="src/**/*.ts" onChange={(event) => set("sourcePaths", event.target.value)} />
        </RuleControl>
        <RuleControl label="Required test, documentation, or companion patterns" help={`${pathHelp} For tests, examples include **/*.test.ts and **/*.spec.ts.`}>
          <TextArea aria-label="Required companion file patterns" value={draft.targetPaths} rows={2} placeholder="tests/**/*.test.ts" onChange={(event) => set("targetPaths", event.target.value)} />
        </RuleControl>
        <RuleControl label="Matching" help="Same file name requires each source and companion to share a base name. Any matching file only checks that at least one companion exists.">
          <Select ariaLabel="Companion file matching" value={draft.companionMatch} onValueChange={(value) => set("companionMatch", value as PolicyConstraintDraft["companionMatch"])} options={[{ value: "same-stem", label: "Same file name", hint: "Recommended for tests" }, { value: "any", label: "Any matching file", hint: "Useful for shared docs" }]} />
        </RuleControl>
      </> : null}
      {draft.kind === "required-node-metadata" || draft.kind === "node-relationship" || draft.kind === "no-orphan-nodes" ? <RuleControl label="Graph scope" help="Choose which graph nodes this rule evaluates, starting from the nodes where the rule is attached.">
        <Select ariaLabel="Graph rule scope" value={draft.nodeScope} onValueChange={(value) => set("nodeScope", value as ArchitecturePolicyNodeScope)} options={nodeScopeOptions} />
      </RuleControl> : null}
      {draft.kind === "required-node-metadata" ? <RuleControl label="Required metadata" help="The structured node information that must be present for every node in scope.">
        <Select ariaLabel="Required node metadata" value={draft.metadataField} onValueChange={(value) => set("metadataField", value as ArchitecturePolicyMetadataField)} options={metadataFieldOptions} />
      </RuleControl> : null}
      {draft.kind === "node-relationship" ? <>
        <div className="node-rule-policy-options">
          <RuleControl label="Behavior" help="Require a matching relationship or report every matching relationship as forbidden.">
            <Select ariaLabel="Graph relationship behavior" value={draft.relationshipMode} onValueChange={(value) => set("relationshipMode", value as PolicyConstraintDraft["relationshipMode"])} options={[{ value: "required", label: "Required" }, { value: "forbidden", label: "Forbidden" }]} />
          </RuleControl>
          <RuleControl label="Direction" help="Check incoming relationships, outgoing relationships, or either direction.">
            <Select ariaLabel="Graph relationship direction" value={draft.relationshipDirection} onValueChange={(value) => set("relationshipDirection", value as PolicyConstraintDraft["relationshipDirection"])} options={[{ value: "either", label: "Either" }, { value: "outgoing", label: "Outgoing" }, { value: "incoming", label: "Incoming" }]} />
          </RuleControl>
        </div>
        <RuleControl label="Other node types (optional)" help="Limit matching relationships to node types such as service, database, feature, or task. Leave empty to match any node type.">
          <TextArea aria-label="Graph relationship node types" value={draft.targetNodeTypes} rows={2} placeholder="service" onChange={(event) => set("targetNodeTypes", event.target.value)} />
        </RuleControl>
      </> : null}
    </>
  );
}

export function NodeInspector({ panelAction }: { panelAction?: ReactNode }) {
  const {
    bundle,
    activeFlowId,
    selectedNodeId,
    selectedNodeIds,
    selectedEdgeId,
    updateNode,
    updateSettings,
    saveFlow,
    selectNodes,
    setActiveFlow,
    setNodeLinkedSubflow,
    setActiveSubflow,
    rememberEdgeLabel,
    updateSelectedEdge,
    updateSelectedEdgePatch,
    deleteSelectedEdge,
    addNote,
    updateNoteResolved,
    updateNotePinned,
    deleteNote,
    purgeResolvedNotes,
    purgeSystemNotes,
    attachNodeReferenceFiles,
    runAgent,
    dismissRunError,
    authorAcceptanceTests,
    clearAcceptanceTests,
    runAcceptanceChecks,
    enhanceNodeField,
    startScopedResearchChat,
    setWorkbenchView,
    selectProjectFile,
    theme,
    error,
    rootPath,
    gitStatus,
    historicalInspection
  } = useArchicodeStore(useShallow((state) => ({
    bundle: state.bundle,
    activeFlowId: state.activeFlowId,
    selectedNodeId: state.selectedNodeId,
    selectedNodeIds: state.selectedNodeIds,
    selectedEdgeId: state.selectedEdgeId,
    updateNode: state.updateNode,
    updateSettings: state.updateSettings,
    saveFlow: state.saveFlow,
    selectNodes: state.selectNodes,
    setActiveFlow: state.setActiveFlow,
    setNodeLinkedSubflow: state.setNodeLinkedSubflow,
    setActiveSubflow: state.setActiveSubflow,
    rememberEdgeLabel: state.rememberEdgeLabel,
    updateSelectedEdge: state.updateSelectedEdge,
    updateSelectedEdgePatch: state.updateSelectedEdgePatch,
    deleteSelectedEdge: state.deleteSelectedEdge,
    addNote: state.addNote,
    updateNoteResolved: state.updateNoteResolved,
    updateNotePinned: state.updateNotePinned,
    deleteNote: state.deleteNote,
    purgeResolvedNotes: state.purgeResolvedNotes,
    purgeSystemNotes: state.purgeSystemNotes,
    attachNodeReferenceFiles: state.attachNodeReferenceFiles,
    runAgent: state.runAgent,
    dismissRunError: state.dismissRunError,
    authorAcceptanceTests: state.authorAcceptanceTests,
    clearAcceptanceTests: state.clearAcceptanceTests,
    runAcceptanceChecks: state.runAcceptanceChecks,
    enhanceNodeField: state.enhanceNodeField,
    startScopedResearchChat: state.startScopedResearchChat,
    setWorkbenchView: state.setWorkbenchView,
    selectProjectFile: state.selectProjectFile,
    theme: state.theme,
    error: state.error,
    rootPath: state.rootPath,
    gitStatus: state.gitStatus,
    historicalInspection: state.historicalInspection
  })));
  const [isGeneratingChecks, setIsGeneratingChecks] = useState(false);
  const [isRunningChecks, setIsRunningChecks] = useState(false);
  const [isClearingChecks, setIsClearingChecks] = useState(false);
  const [dismissingRunId, setDismissingRunId] = useState<string | null>(null);
  const [confirmGenerateOpen, setConfirmGenerateOpen] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [enhancingField, setEnhancingField] = useState<"description" | "acceptanceCriteria" | null>(null);
  const [enhancePreview, setEnhancePreview] = useState<{ field: "description" | "acceptanceCriteria"; original: string; suggested: string; draft: string } | null>(null);
  const [largeTextEditor, setLargeTextEditor] = useState<{
    field: "description" | "acceptanceCriteria";
    nodeId: string;
    draft: string;
  } | null>(null);
  const flow = getActiveFlow(bundle, activeFlowId);
  const node = getSelectedNode(bundle, activeFlowId, selectedNodeId);
  const edge = getSelectedEdge(bundle, activeFlowId, selectedEdgeId);
  const nodePolicyViolationCount = node && flow
    ? getNodeSignalCounts(bundle, node.id, flow.id).policyViolations
    : 0;
  const subjectAppearances = useMemo(() => {
    if (!bundle || !node?.subjectRef) return [];
    return bundle.flows.flatMap((candidateFlow) => candidateFlow.nodes
      .filter((candidate) => candidate.subjectRef?.id === node.subjectRef?.id)
      .map((candidate) => ({ flow: candidateFlow, node: candidate })));
  }, [bundle, node?.subjectRef?.id]);
  const otherSubjectAppearances = useMemo(() => subjectAppearances.filter((appearance) =>
    appearance.flow.id !== flow?.id || appearance.node.id !== node?.id
  ), [flow?.id, node?.id, subjectAppearances]);
  const selectedNodes = useMemo(() => {
    if (!flow) return [];
    const ids = selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : [];
    const idSet = new Set(ids);
    return flow.nodes.filter((item) => idSet.has(item.id));
  }, [flow, selectedNodeId, selectedNodeIds]);
  const [noteBody, setNoteBody] = useState("");
  const [noteCategory, setNoteCategory] = useState<Note["category"]>("note");
  const [notePriority, setNotePriority] = useState<Note["priority"]>("normal");
  const [noteFilter, setNoteFilter] = useState<NoteFilter>("all");
  const [noteSearch, setNoteSearch] = useState("");
  const [noteAnswers, setNoteAnswers] = useState<Record<string, string>>({});
  const [pendingReferencePaths, setPendingReferencePaths] = useState<string[]>([]);
  const [artifactImagePreviews, setArtifactImagePreviews] = useState<Record<string, string>>({});
  const [noteComposerCollapsed, setNoteComposerCollapsed] = useState(true);
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [focusedRuleTarget, setFocusedRuleTarget] = useState<{ ruleId: string; nodeId?: string } | null>(null);
  const focusedRuleCardRef = useRef<HTMLElement | null>(null);
  const [inspectorTab, setInspectorTab] = useState("details");
  const [implementationScopeExpanded, setImplementationScopeExpanded] = useState(false);
  const [semanticContextExpanded, setSemanticContextExpanded] = useState(false);
  const [subjectPerspectivesExpanded, setSubjectPerspectivesExpanded] = useState(false);
  const [semanticContext, setSemanticContext] = useState<Awaited<ReturnType<typeof window.archicode.getNodeSemanticContext>> | null>(null);
  const [semanticContextBusy, setSemanticContextBusy] = useState(false);
  const [nodeHistory, setNodeHistory] = useState<GraphNodeHistory | null>(null);
  const [nodeHistoryBusy, setNodeHistoryBusy] = useState(false);
  const [nodeHistoryExpanded, setNodeHistoryExpanded] = useState(false);
  const [semanticContextError, setSemanticContextError] = useState<string | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [groupColorDraft, setGroupColorDraft] = useState(nodeColorSwatches[0]);
  const [customPropertyNameDraft, setCustomPropertyNameDraft] = useState("");
  const [customPropertyTypeDraft, setCustomPropertyTypeDraft] = useState<CustomNodePropertyType>("text");
  const [ruleTitleDraft, setRuleTitleDraft] = useState("");
  const [ruleBodyDraft, setRuleBodyDraft] = useState("");
  const [ruleKindDraft, setRuleKindDraft] = useState<NonNullable<NodeRule["kind"]>>("guidance");
  const [rulePolicyDraft, setRulePolicyDraft] = useState<PolicyConstraintDraft>({ ...defaultPolicyConstraintDraft });
  const [ruleSeverityDraft, setRuleSeverityDraft] = useState<NonNullable<NodeRule["severity"]>>("warning");
  const [ruleEnforcementDraft, setRuleEnforcementDraft] = useState<NonNullable<NodeRule["enforcement"]>>("advisory");
  const [ruleAttachDraft, setRuleAttachDraft] = useState("");
  const [ruleEditingId, setRuleEditingId] = useState<string | null>(null);
  const [ruleEditTitleDraft, setRuleEditTitleDraft] = useState("");
  const [ruleEditBodyDraft, setRuleEditBodyDraft] = useState("");
  const [ruleEditKindDraft, setRuleEditKindDraft] = useState<NonNullable<NodeRule["kind"]>>("guidance");
  const [ruleEditPolicyDraft, setRuleEditPolicyDraft] = useState<PolicyConstraintDraft>({ ...defaultPolicyConstraintDraft });
  const [ruleEditSeverityDraft, setRuleEditSeverityDraft] = useState<NonNullable<NodeRule["severity"]>>("warning");
  const [ruleEditEnforcementDraft, setRuleEditEnforcementDraft] = useState<NonNullable<NodeRule["enforcement"]>>("advisory");
  const [ruleComposerCollapsed, setRuleComposerCollapsed] = useState(true);
  const [utilityTabsExpandedOverride, setUtilityTabsExpandedOverride] = useState<boolean | null>(null);
  const [nodeAppearanceExpandedOverride, setNodeAppearanceExpandedOverride] = useState<boolean | null>(null);
  const [edgeLabelHistoryExpanded, setEdgeLabelHistoryExpanded] = useState(false);
  const [edgeLabelSessionHistory, setEdgeLabelSessionHistory] = useState<string[]>([]);
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [typePickerQuery, setTypePickerQuery] = useState("");
  const [detailFlowPickerOpen, setDetailFlowPickerOpen] = useState(false);
  const [detailFlowPickerQuery, setDetailFlowPickerQuery] = useState("");
  const [typeDraft, setTypeDraft] = useState("");
  const [techStackDraft, setTechStackDraft] = useState("");
  const [acceptanceCriteriaDraft, setAcceptanceCriteriaDraft] = useState("");
  const typeDraftLastSyncedRef = useRef<string | null>(null);
  const techStackDraftLastSyncedRef = useRef<string | null>(null);
  const acceptanceCriteriaDraftLastSyncedRef = useRef<string | null>(null);
  const detailsScrollViewportRef = useRef<HTMLDivElement | null>(null);
  const detailsScrollTopRef = useRef(0);
  const lastDetailsNodeIdRef = useRef<string | null>(null);
  const focusedEdgeLabelRef = useRef<string | null>(null);
  const semanticContextRequestRef = useRef(0);
  const semanticContextHasData = Boolean(semanticContext?.indexed || semanticContext?.relatedNodes.length || semanticContext?.relatedCode.length);
  const buildCommand = bundle?.project.settings.defaultBuildCommand.trim() ?? "";
  const persistedUtilityTabsExpanded = bundle?.project.settings.inspectorUtilityTabsExpanded ?? false;
  const persistedNodeAppearanceExpanded = bundle?.project.settings.inspectorNodeAppearanceExpanded ?? false;
  const utilityTabsExpanded = utilityTabsExpandedOverride ?? persistedUtilityTabsExpanded;
  const nodeAppearanceExpanded = nodeAppearanceExpandedOverride ?? persistedNodeAppearanceExpanded;
  const moduleProfileSelectValue = node
    ? node.moduleProfileMode === "none"
      ? moduleProfileNoneValue
      : node.moduleProfileId || moduleProfileAutoValue
    : moduleProfileAutoValue;

  useEffect(() => {
    setNodeHistoryExpanded(false);
    if (!rootPath || !flow || !node || !window.archicode?.getGraphNodeHistory) {
      setNodeHistory(null);
      setNodeHistoryBusy(false);
      return;
    }
    if (gitStatus && !gitStatus.isRepo) {
      setNodeHistory({ available: false, flowId: flow.id, nodeId: node.id, changes: [], message: "Git attribution is unavailable until this graph is committed." });
      setNodeHistoryBusy(false);
      return;
    }
    let cancelled = false;
    const revision = historicalInspection?.entry.commit ?? gitStatus?.recentCommits[0]?.hash ?? "HEAD";
    setNodeHistory(null);
    setNodeHistoryBusy(true);
    void window.archicode.getGraphNodeHistory(rootPath, revision, flow.id, node.id)
      .then((history) => { if (!cancelled) setNodeHistory(history); })
      .catch((historyError: unknown) => {
        if (!cancelled) setNodeHistory({
          available: false,
          flowId: flow.id,
          nodeId: node.id,
          changes: [],
          message: historyError instanceof Error ? historyError.message : String(historyError)
        });
      })
      .finally(() => { if (!cancelled) setNodeHistoryBusy(false); });
    return () => { cancelled = true; };
  }, [flow?.id, gitStatus?.isRepo, gitStatus?.recentCommits[0]?.hash, historicalInspection?.entry.commit, node?.id, rootPath]);

  const loadSemanticContext = useCallback(async (refresh = false) => {
    const requestId = ++semanticContextRequestRef.current;
    if (!bundle || !flow || !node || !bundle.project.settings.semanticIndex.enabled) {
      setSemanticContext(null);
      setSemanticContextError(null);
      return;
    }
    setSemanticContextBusy(true);
    setSemanticContextError(null);
    try {
      const context = await window.archicode.getNodeSemanticContext(bundle.rootPath, flow.id, node.id, refresh);
      if (semanticContextRequestRef.current === requestId) setSemanticContext(context);
    } catch (loadError) {
      if (semanticContextRequestRef.current === requestId) setSemanticContextError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (semanticContextRequestRef.current === requestId) setSemanticContextBusy(false);
    }
  }, [bundle, flow, node]);

  useEffect(() => {
    setUtilityTabsExpandedOverride(null);
    setNodeAppearanceExpandedOverride(null);
  }, [bundle?.project.id]);

  useEffect(() => {
    if (utilityTabsExpandedOverride === persistedUtilityTabsExpanded) setUtilityTabsExpandedOverride(null);
  }, [persistedUtilityTabsExpanded, utilityTabsExpandedOverride]);

  useEffect(() => {
    if (nodeAppearanceExpandedOverride === persistedNodeAppearanceExpanded) setNodeAppearanceExpandedOverride(null);
  }, [persistedNodeAppearanceExpanded, nodeAppearanceExpandedOverride]);

  useEffect(() => {
    setEdgeLabelHistoryExpanded(false);
  }, [edge?.id]);

  useEffect(() => {
    if (inspectorTab !== "advanced") {
      setImplementationScopeExpanded(false);
      setSemanticContextExpanded(false);
      setSubjectPerspectivesExpanded(false);
    }
  }, [inspectorTab]);

  useEffect(() => {
    if (inspectorTab !== "advanced" || !semanticContextExpanded) return;
    void loadSemanticContext();
  }, [inspectorTab, loadSemanticContext, semanticContextExpanded]);

  useEffect(() => {
    setTypePickerOpen(false);
    setTypePickerQuery("");
    setDetailFlowPickerOpen(false);
    setDetailFlowPickerQuery("");
  }, [node?.id]);

  useEffect(() => {
    const value = node?.type ?? "";
    typeDraftLastSyncedRef.current = value;
    setTypeDraft(value);
  }, [node?.id]);

  useEffect(() => {
    if (!node) return;
    if (node.type === typeDraftLastSyncedRef.current) return;
    typeDraftLastSyncedRef.current = node.type;
    setTypeDraft(node.type);
  }, [node?.type]);

  useEffect(() => {
    const value = node?.techStack.join(", ") ?? "";
    techStackDraftLastSyncedRef.current = value;
    setTechStackDraft(value);
  }, [node?.id]);

  useEffect(() => {
    if (!node) return;
    const fromStore = node.techStack.join(", ");
    if (fromStore === techStackDraftLastSyncedRef.current) return;
    techStackDraftLastSyncedRef.current = fromStore;
    setTechStackDraft(fromStore);
  }, [node?.techStack]);

  useEffect(() => {
    const value = node?.acceptanceCriteria.join("\n") ?? "";
    acceptanceCriteriaDraftLastSyncedRef.current = value;
    setAcceptanceCriteriaDraft(value);
  }, [node?.id]);

  useEffect(() => {
    if (!node) return;
    const fromStore = node.acceptanceCriteria.join("\n");
    if (fromStore === acceptanceCriteriaDraftLastSyncedRef.current) return;
    acceptanceCriteriaDraftLastSyncedRef.current = fromStore;
    setAcceptanceCriteriaDraft(fromStore);
  }, [node?.acceptanceCriteria]);

  const updateProjectUiSetting = (patch: Partial<ProjectSettings>) => {
    if (!bundle) return;
    void updateSettings({
      ...bundle.project.settings,
      ...patch
    });
  };

  const restoreDetailsScroll = (scrollTop = detailsScrollTopRef.current) => {
    detailsScrollTopRef.current = scrollTop;
    requestAnimationFrame(() => {
      if (inspectorTab === "details" && detailsScrollViewportRef.current) {
        detailsScrollViewportRef.current.scrollTop = scrollTop;
      }
      requestAnimationFrame(() => {
        if (inspectorTab === "details" && detailsScrollViewportRef.current) {
          detailsScrollViewportRef.current.scrollTop = scrollTop;
        }
      });
    });
  };

  const updateNodeKeepingDetailsScroll = (patch: Parameters<typeof updateNode>[0]) => {
    const scrollTop = detailsScrollViewportRef.current?.scrollTop ?? detailsScrollTopRef.current;
    detailsScrollTopRef.current = scrollTop;
    void updateNode(patch).finally(() => restoreDetailsScroll(scrollTop));
  };

  const requestFieldEnhancement = async (field: "description" | "acceptanceCriteria") => {
    if (!node || enhancingField) return;
    const original = field === "description" ? node.description : node.acceptanceCriteria.join("\n");
    setEnhancingField(field);
    try {
      const suggested = await enhanceNodeField(node.id, field);
      if (suggested && suggested.trim() && suggested.trim() !== original.trim()) {
        setEnhancePreview({ field, original, suggested: suggested.trim(), draft: suggested.trim() });
      }
    } finally {
      setEnhancingField(null);
    }
  };

  const applyFieldEnhancement = () => {
    if (!node || !enhancePreview) return;
    if (enhancePreview.field === "description") {
      updateNodeKeepingDetailsScroll({ id: node.id, description: enhancePreview.draft });
    } else {
      updateNodeKeepingDetailsScroll({
        id: node.id,
        acceptanceCriteria: enhancePreview.draft.split("\n").map((item) => item.trim()).filter(Boolean)
      });
    }
    setEnhancePreview(null);
  };

  const openLargeTextEditor = (field: "description" | "acceptanceCriteria") => {
    if (!node) return;
    setLargeTextEditor({
      field,
      nodeId: node.id,
      draft: field === "description" ? node.description : acceptanceCriteriaDraft
    });
  };

  const saveLargeTextEditor = () => {
    if (!node || !largeTextEditor || largeTextEditor.nodeId !== node.id) return;
    if (largeTextEditor.field === "description") {
      updateNodeKeepingDetailsScroll({ id: node.id, description: largeTextEditor.draft });
    } else {
      const parsed = largeTextEditor.draft.split("\n").map((item) => item.trim()).filter(Boolean);
      const joined = parsed.join("\n");
      acceptanceCriteriaDraftLastSyncedRef.current = joined;
      setAcceptanceCriteriaDraft(joined);
      updateNodeKeepingDetailsScroll({ id: node.id, acceptanceCriteria: parsed });
    }
    setLargeTextEditor(null);
  };

  const saveFlowKeepingDetailsScroll = async (nextFlow: Flow) => {
    const scrollTop = detailsScrollViewportRef.current?.scrollTop ?? detailsScrollTopRef.current;
    detailsScrollTopRef.current = scrollTop;
    const nextBundle = await saveFlow(nextFlow).finally(() => restoreDetailsScroll(scrollTop));
    return nextBundle?.flows.find((item) => item.id === nextFlow.id) ?? null;
  };

  const setLinkedSubflowKeepingDetailsScroll = (subflowId: string | null) => {
    const scrollTop = detailsScrollViewportRef.current?.scrollTop ?? detailsScrollTopRef.current;
    detailsScrollTopRef.current = scrollTop;
    void setNodeLinkedSubflow(node!.id, subflowId).finally(() => restoreDetailsScroll(scrollTop));
  };

  useLayoutEffect(() => {
    const currentNodeId = node?.id ?? null;
    if (lastDetailsNodeIdRef.current !== currentNodeId) {
      detailsScrollTopRef.current = 0;
      lastDetailsNodeIdRef.current = currentNodeId;
    }
    if (inspectorTab === "details" && detailsScrollViewportRef.current) {
      detailsScrollViewportRef.current.scrollTop = detailsScrollTopRef.current;
    }
  }, [inspectorTab, node?.id]);

  useLayoutEffect(() => {
    if (!utilityTabsExpanded && utilityTabValues.includes(inspectorTab)) setInspectorTab("details");
  }, [inspectorTab, utilityTabsExpanded, utilityTabValues]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId?: string; nodeId?: string }>).detail;
      if (!detail?.noteId) return;
      setInspectorTab("notes");
      setNoteFilter("agent-questions");
      setFocusedNoteId(detail.noteId);
    };
    window.addEventListener("archicode:focus-note", listener);
    return () => window.removeEventListener("archicode:focus-note", listener);
  }, []);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ ruleId?: string; nodeId?: string }>).detail;
      if (!detail?.ruleId) return;
      setInspectorTab("rules");
      setRuleComposerCollapsed(true);
      setRuleEditingId(null);
      setFocusedRuleTarget({ ruleId: detail.ruleId, nodeId: detail.nodeId });
    };
    window.addEventListener("archicode:focus-rule", listener);
    return () => window.removeEventListener("archicode:focus-rule", listener);
  }, []);

  useLayoutEffect(() => {
    if (inspectorTab !== "rules" || !focusedRuleTarget || focusedRuleTarget.nodeId !== node?.id) return;
    focusedRuleCardRef.current?.scrollIntoView({ block: "nearest" });
  }, [focusedRuleTarget, inspectorTab, node?.id]);

  const toggleUtilityTabs = () => {
    if (!bundle) return;
    const nextExpanded = !utilityTabsExpanded;
    setUtilityTabsExpandedOverride(nextExpanded);
    if (!nextExpanded && utilityTabValues.includes(inspectorTab)) setInspectorTab("details");
    updateProjectUiSetting({
      inspectorUtilityTabsExpanded: nextExpanded
    });
  };

  const toggleNodeAppearance = () => {
    const nextExpanded = !nodeAppearanceExpanded;
    setNodeAppearanceExpandedOverride(nextExpanded);
    updateProjectUiSetting({
      inspectorNodeAppearanceExpanded: nextExpanded
    });
  };

  const notes = useMemo(() => {
    if (!bundle || !node) return [];
    return bundle.notes.filter((note) => note.nodeId === node.id).sort(sortNodeNotes);
  }, [bundle, node]);
  const nodeArtifacts = useMemo(() => {
    if (!bundle || !node) return [];
    return [...bundle.artifacts, ...bundle.summaries].filter((artifact) => artifact.nodeId === node.id);
  }, [bundle, node]);
  const nodeReferenceArtifacts = useMemo(() => nodeArtifacts.filter((artifact) => artifact.type === "attachment"), [nodeArtifacts]);
  const nodeReferenceImageArtifacts = useMemo(() => nodeReferenceArtifacts.filter(isImageArtifact), [nodeReferenceArtifacts]);
  const legacyAttachmentNoteIds = useMemo(() => {
    const byArtifactId = new Map<string, string>();
    const chronologicalNotes = [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const artifact of nodeReferenceArtifacts) {
      if (artifact.noteId) continue;
      const candidate = [...chronologicalNotes]
        .reverse()
        .find((note) => note.createdAt <= artifact.createdAt);
      if (candidate) byArtifactId.set(artifact.id, candidate.id);
    }
    return byArtifactId;
  }, [notes, nodeReferenceArtifacts]);
  const standaloneReferenceArtifacts = useMemo(() => nodeReferenceArtifacts.filter((artifact) =>
    !artifact.noteId && !legacyAttachmentNoteIds.has(artifact.id)
  ), [legacyAttachmentNoteIds, nodeReferenceArtifacts]);
  const noteAttachmentsById = useMemo(() => {
    const byNoteId = new Map<string, Artifact[]>();
    for (const note of notes) {
      byNoteId.set(note.id, uniqueArtifacts([
        ...nodeReferenceArtifacts.filter((artifact) => artifact.noteId === note.id),
        ...nodeReferenceArtifacts.filter((artifact) => legacyAttachmentNoteIds.get(artifact.id) === note.id),
        ...note.attachmentIds.flatMap((attachmentId) => {
          const artifact = nodeReferenceArtifacts.find((item) => item.id === attachmentId);
          return artifact ? [artifact] : [];
        })
      ]));
    }
    return byNoteId;
  }, [notes, legacyAttachmentNoteIds, nodeReferenceArtifacts]);

  useEffect(() => {
    const projectRoot = bundle?.project.rootPath;
    if (!projectRoot || !nodeReferenceImageArtifacts.length || !window.archicode?.readArtifactDataUrl) {
      setArtifactImagePreviews({});
      return;
    }
    let cancelled = false;
    const imageIds = new Set(nodeReferenceImageArtifacts.map((artifact) => artifact.id));
    setArtifactImagePreviews((current) => Object.fromEntries(
      Object.entries(current).filter(([artifactId]) => imageIds.has(artifactId))
    ));
    void Promise.all(nodeReferenceImageArtifacts.map(async (artifact) => {
      try {
        return [artifact.id, await window.archicode.readArtifactDataUrl(projectRoot, artifact.path)] as const;
      } catch {
        return [artifact.id, ""] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setArtifactImagePreviews(Object.fromEntries(entries.filter(([, dataUrl]) => dataUrl)));
    });
    return () => {
      cancelled = true;
    };
  }, [bundle?.project.rootPath, nodeReferenceImageArtifacts]);
  const filteredNotes = useMemo(() => {
    if (noteFilter === "pinned") return notes.filter((note) => note.pinned);
    if (noteFilter === "open") return notes.filter((note) => isResolvableNote(note) && !note.resolved);
    if (noteFilter === "resolved") return notes.filter((note) => isResolvableNote(note) && note.resolved);
    if (noteFilter === "bugs") return notes.filter((note) => note.category === "bug");
    if (noteFilter === "agent-questions") return notes.filter((note) => note.kind === "llm-question");
    if (noteFilter === "my-notes") return notes.filter((note) => note.author === "user");
    if (noteFilter === "system-notes") return notes.filter(isSystemGeneratedNote);
    return notes.filter(isDefaultVisibleNote);
  }, [noteFilter, notes]);
  const searchedNotes = useMemo(() => {
    const query = noteSearch.trim().toLocaleLowerCase();
    if (!query) return filteredNotes;
    return filteredNotes.filter((note) => {
      const attachmentTitles = (noteAttachmentsById.get(note.id) ?? []).map((artifact) => artifact.title);
      return noteSearchText(note, attachmentTitles).includes(query);
    });
  }, [noteSearch, noteAttachmentsById, filteredNotes]);
  const questionAnswerThreads = useMemo(() => buildQuestionAnswerThreads(notes), [notes]);
  const visibleNotes = useMemo(() => {
    const visibleIds = new Set(searchedNotes.map((note) => note.id));
    return searchedNotes.filter((note) => {
      const parentQuestionId = questionAnswerThreads.answerToQuestionId.get(note.id);
      return !parentQuestionId || !visibleIds.has(parentQuestionId);
    });
  }, [searchedNotes, questionAnswerThreads]);

  useEffect(() => {
    if (!focusedNoteId || inspectorTab !== "notes") return;
    requestAnimationFrame(() => {
      document.querySelector(`[data-note-id="${focusedNoteId}"]`)?.scrollIntoView({
        block: "center",
        behavior: "smooth"
      });
    });
  }, [focusedNoteId, visibleNotes, inspectorTab]);

  const nodeRuns = useMemo(() => {
    if (!bundle || !node) return [];
    return bundle.runs.filter((run) => run.nodeId === node.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [bundle, node]);

  const openQuestionCount = notes.filter((note) => note.kind === "llm-question" && !note.resolved).length;
  const purgeableResolvedNoteCount = notes.filter((note) => isResolvableNote(note) && note.resolved && !note.pinned).length;
  const purgeableSystemNoteCount = notes.filter((note) => isSystemGeneratedNote(note) && !note.pinned).length;
  const lastRun = nodeRuns[0];
  const dismissReadinessError = async (runId: string) => {
    if (dismissingRunId) return;
    setDismissingRunId(runId);
    try {
      await dismissRunError(runId);
    } finally {
      setDismissingRunId(null);
    }
  };
  const linkedSubflowId = flow?.subflows.find((subflow) => subflow.parentNodeId === node?.id)?.id ?? "";
  const detailFlowOptions = useMemo(() => {
    if (!flow) return [];
    return flow.subflows.map((subflow) => ({
      subflow,
      label: `${"  ".repeat(subflowDepth(flow, subflow.id))}${subflow.name}`
    }));
  }, [flow]);
  const normalizedDetailFlowQuery = detailFlowPickerQuery.trim().toLocaleLowerCase();
  const filteredDetailFlowOptions = useMemo(() => detailFlowOptions.filter(({ subflow, label }) => {
    if (!normalizedDetailFlowQuery) return true;
    return label.toLocaleLowerCase().includes(normalizedDetailFlowQuery) || subflow.name.toLocaleLowerCase().includes(normalizedDetailFlowQuery);
  }), [detailFlowOptions, normalizedDetailFlowQuery]);
  const flowGroups = flow?.groups ?? [];
  const groupOptions = useMemo(() => [
    { value: noGroupValue, label: "No group" },
    ...flowGroups.map((group) => ({ value: group.id, label: group.name }))
  ], [flowGroups]);
  const customNodeTypes = bundle?.project.settings.customNodeTypes ?? [];
  const normalizedTypePickerQuery = typePickerQuery.trim().toLocaleLowerCase();
  const filteredBuiltInNodeTypes = useMemo(() => builtInNodeTypes.filter((type) => (
    !normalizedTypePickerQuery || type.toLocaleLowerCase().includes(normalizedTypePickerQuery)
  )), [normalizedTypePickerQuery]);
  const filteredCustomNodeTypes = useMemo(() => customNodeTypes.filter((type) => (
    !normalizedTypePickerQuery || type.toLocaleLowerCase().includes(normalizedTypePickerQuery)
  )), [customNodeTypes, normalizedTypePickerQuery]);
  const canCreateTypeFromQuery = Boolean(
    typePickerQuery.trim() &&
    !isBuiltInNodeType(typePickerQuery) &&
    !customNodeTypes.some((type) => type.trim().toLocaleLowerCase() === typePickerQuery.trim().toLocaleLowerCase())
  );
  const customNodeProperties = bundle?.project.settings.customNodeProperties ?? [];
  const linkedDetailFlowLabel = detailFlowOptions.find(({ subflow }) => subflow.id === linkedSubflowId)?.label ?? "No linked flow";
  const nodeRules = bundle?.project.settings.nodeRules ?? [];
  const attachedRuleIds = node?.ruleIds ?? [];
  const attachedRuleIdSet = new Set(attachedRuleIds);
  const attachedRules = attachedRuleIds.flatMap((ruleId) => {
    const rule = nodeRules.find((item) => item.id === ruleId);
    return rule ? [rule] : [];
  });
  const ruleUsageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const projectFlow of bundle?.flows ?? []) {
      for (const projectNode of projectFlow.nodes) {
        for (const ruleId of projectNode.ruleIds ?? []) {
          counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
        }
      }
    }
    return counts;
  }, [bundle?.flows]);
  const attachableRules = nodeRules.filter((rule) => !attachedRuleIdSet.has(rule.id));
  const selectedAttachRule = nodeRules.find((rule) => rule.id === ruleAttachDraft) ?? null;
  const editingRule = nodeRules.find((rule) => rule.id === ruleEditingId) ?? null;
  const updateRulesLibrary = (rules: NodeRule[]) => {
    if (!bundle) return;
    void updateSettings({
      ...bundle.project.settings,
      nodeRules: rules
    });
  };
  const persistCustomNodeType = (type: string | null | undefined) => {
    if (!bundle) return;
    const nextHistory = appendCustomNodeTypeHistory(customNodeTypes, type);
    if (
      nextHistory.length === customNodeTypes.length &&
      nextHistory.every((item, index) => item === customNodeTypes[index])
    ) return;
    updateProjectUiSetting({ customNodeTypes: nextHistory });
  };
  const forgetCustomNodeType = (type: string) => {
    if (!bundle) return;
    const nextHistory = removeCustomNodeTypeHistory(customNodeTypes, type);
    if (
      nextHistory.length === customNodeTypes.length &&
      nextHistory.every((item, index) => item === customNodeTypes[index])
    ) return;
    updateProjectUiSetting({ customNodeTypes: nextHistory });
  };
  const applyNodeTypeSelection = (type: string) => {
    if (!node) return;
    const trimmed = type.trim();
    if (!trimmed) return;
    typeDraftLastSyncedRef.current = trimmed;
    setTypeDraft(trimmed);
    updateNodeKeepingDetailsScroll({ id: node.id, type: trimmed });
    persistCustomNodeType(trimmed);
    setTypePickerQuery(trimmed);
    setTypePickerOpen(false);
  };
  const createAndAttachRule = async () => {
    if (!bundle || !node) return;
    const body = ruleBodyDraft.trim();
    if (!body) return;
    const policyConstraint = ruleKindDraft === "policy" ? buildPolicyConstraint(rulePolicyDraft) : null;
    if (ruleKindDraft === "policy" && !policyConstraint) return;
    const title = ruleTitleDraft.trim() || inferRuleTitle(body);
    const nowValue = new Date().toISOString();
    const rule: NodeRule = {
      id: createNodeRuleId(title, new Set(nodeRules.map((item) => item.id))),
      title,
      body,
      kind: ruleKindDraft,
      status: "active",
      ...(ruleKindDraft === "policy" ? {
        severity: ruleSeverityDraft,
        enforcement: ruleEnforcementDraft,
        constraint: policyConstraint!
      } : {}),
      createdAt: nowValue,
      updatedAt: nowValue
    };
    await updateSettings({
      ...bundle.project.settings,
      nodeRules: [...nodeRules, rule]
    });
    await updateNode({ id: node.id, ruleIds: [...new Set([...attachedRuleIds, rule.id])] });
    setRuleTitleDraft("");
    setRuleBodyDraft("");
    setRuleKindDraft("guidance");
    setRulePolicyDraft({ ...defaultPolicyConstraintDraft });
    setRuleSeverityDraft("warning");
    setRuleEnforcementDraft("advisory");
  };
  const attachRuleToNode = async (ruleId = ruleAttachDraft) => {
    if (!node || !ruleId || attachedRuleIdSet.has(ruleId)) return;
    await updateNode({ id: node.id, ruleIds: [...attachedRuleIds, ruleId] });
    setRuleAttachDraft("");
  };
  const detachRuleFromNode = (ruleId: string) => {
    if (!node) return;
    void updateNode({ id: node.id, ruleIds: attachedRuleIds.filter((item) => item !== ruleId) });
  };
  const beginRuleSourceEdit = (rule: NodeRule) => {
    setRuleEditingId(rule.id);
    setRuleEditTitleDraft(rule.title);
    setRuleEditBodyDraft(rule.body);
    setRuleEditKindDraft(rule.kind ?? (rule.constraint ? "policy" : "guidance"));
    setRuleEditPolicyDraft(policyDraftFromConstraint(rule.constraint));
    setRuleEditSeverityDraft(rule.severity ?? "warning");
    setRuleEditEnforcementDraft(rule.enforcement ?? "advisory");
  };
  const cancelRuleSourceEdit = () => {
    setRuleEditingId(null);
    setRuleEditTitleDraft("");
    setRuleEditBodyDraft("");
    setRuleEditKindDraft("guidance");
    setRuleEditPolicyDraft({ ...defaultPolicyConstraintDraft });
    setRuleEditSeverityDraft("warning");
    setRuleEditEnforcementDraft("advisory");
  };
  const saveRuleSourceEdit = () => {
    if (!editingRule) return;
    const title = ruleEditTitleDraft.trim();
    const body = ruleEditBodyDraft.trim();
    if (!title || !body) return;
    const policyConstraint = ruleEditKindDraft === "policy" ? buildPolicyConstraint(ruleEditPolicyDraft) : null;
    if (ruleEditKindDraft === "policy" && !policyConstraint) return;
    updateRule(editingRule.id, {
      title,
      body,
      kind: ruleEditKindDraft,
      status: editingRule.status ?? "active",
      severity: ruleEditKindDraft === "policy" ? ruleEditSeverityDraft : undefined,
      enforcement: ruleEditKindDraft === "policy" ? ruleEditEnforcementDraft : undefined,
      constraint: ruleEditKindDraft === "policy" ? policyConstraint! : undefined
    });
    cancelRuleSourceEdit();
  };
  const copyRuleSource = async (rule: NodeRule) => {
    await writeClipboardText(`${rule.title}\n\n${rule.body}`);
  };
  const deleteRuleSource = async (rule: NodeRule) => {
    if (!bundle) return;
    const usageCount = ruleUsageCounts.get(rule.id) ?? 0;
    const attachmentMessage = usageCount
      ? ` This will also remove it from ${usageCount} node${usageCount === 1 ? "" : "s"}.`
      : "";
    if (!window.confirm(`Delete source rule "${rule.title}"?${attachmentMessage}`)) return;
    await updateSettings({
      ...bundle.project.settings,
      nodeRules: nodeRules.filter((item) => item.id !== rule.id)
    });
    if (ruleAttachDraft === rule.id) setRuleAttachDraft("");
    if (ruleEditingId === rule.id) cancelRuleSourceEdit();
  };
  const updateRule = (ruleId: string, patch: Partial<Omit<NodeRule, "id" | "createdAt">>) => {
    if (!bundle) return;
    const nowValue = new Date().toISOString();
    updateRulesLibrary(nodeRules.map((rule) => rule.id === ruleId
      ? { ...rule, ...patch, updatedAt: nowValue }
      : rule));
  };
  const createCustomNodeProperty = () => {
    if (!bundle) return;
    const label = customPropertyNameDraft.trim();
    if (!label) return;
    const existingIds = new Set(customNodeProperties.map((property) => property.id));
    const existingLabel = customNodeProperties.find((property) => property.label.trim().toLowerCase() === label.toLowerCase());
    if (existingLabel) {
      setCustomPropertyNameDraft("");
      return;
    }
    setCustomPropertyNameDraft("");
    updateProjectUiSetting({
      customNodeProperties: [
        ...customNodeProperties,
        { id: customPropertyId(label, existingIds), label, type: customPropertyTypeDraft }
      ]
    });
  };
  const deleteCustomNodeProperty = (propertyId: string) => {
    if (!bundle) return;
    if (runChangeBlocked) return;
    void (async () => {
      await updateSettings({
        ...bundle.project.settings,
        customNodeProperties: customNodeProperties.filter((property) => property.id !== propertyId)
      });
      for (const projectFlow of bundle.flows) {
        const nextNodes = projectFlow.nodes.map((projectNode) => ({
          ...projectNode,
          customProperties: withoutCustomProperty(projectNode.customProperties, propertyId),
          updatedAt: new Date().toISOString()
        }));
        await saveFlow({ ...projectFlow, nodes: nextNodes });
      }
      restoreDetailsScroll();
    })();
  };
  const addSessionEdgeLabel = (label: string | null | undefined) => {
    const normalizedLabel = label?.trim();
    if (!normalizedLabel) return;
    setEdgeLabelSessionHistory((current) => appendLocalEdgeLabelHistory(current, normalizedLabel));
  };
  const edgeLabelHistory = useMemo(() => {
    if (!bundle) return [];
    const normalizedHistoryKeys = new Set<string>();
    const savedHistory = [...edgeLabelSessionHistory, ...bundle.project.settings.edgeLabelHistory].flatMap((label) => {
      const normalizedLabel = label.trim();
      const key = normalizedLabel.toLocaleLowerCase();
      if (!normalizedLabel || normalizedHistoryKeys.has(key)) return [];
      normalizedHistoryKeys.add(key);
      return [normalizedLabel];
    });
    const graphLabels = new Map<string, { label: string; count: number; activeFlowCount: number }>();
    for (const projectFlow of bundle.flows) {
      for (const projectEdge of projectFlow.edges) {
        const label = projectEdge.label?.trim();
        if (!label) continue;
        const key = label.toLocaleLowerCase();
        if (normalizedHistoryKeys.has(key)) continue;
        const current = graphLabels.get(key);
        graphLabels.set(key, {
          label: current?.label ?? label,
          count: (current?.count ?? 0) + 1,
          activeFlowCount: (current?.activeFlowCount ?? 0) + (projectFlow.id === activeFlowId ? 1 : 0)
        });
      }
    }
    return [
      ...savedHistory,
      ...[...graphLabels.values()]
      .sort((a, b) => b.activeFlowCount - a.activeFlowCount || b.count - a.count || a.label.localeCompare(b.label))
      .map((item) => item.label)
    ].slice(0, 18);
  }, [activeFlowId, bundle, edgeLabelSessionHistory]);
  const runChangeBlocked = Boolean(bundle?.runs.some(isRunBlockingNewChange));
  const multipleNodesSelected = selectedNodes.length > 1;

  const assignNodesToGroup = (nodesToAssign: ArchicodeNode[], groupId: string | null) => {
    if (!flow || !nodesToAssign.length) return;
    const selectedIdSet = new Set(nodesToAssign.map((selectedNode) => selectedNode.id));
    const normalizedGroupId = groupId ?? undefined;
    const now = new Date().toISOString();
    void saveFlowKeepingDetailsScroll({
      ...flow,
      nodes: flow.nodes.map((candidate) => selectedIdSet.has(candidate.id)
        ? { ...candidate, groupId: normalizedGroupId, updatedAt: now }
        : candidate),
      updatedAt: now
    }).catch(() => undefined);
  };

  const createGroupForNodes = async (nodesToGroup: ArchicodeNode[]) => {
    if (!flow || !nodesToGroup.length) return;
    const now = new Date().toISOString();
    const group = {
      id: `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: groupNameDraft.trim() || `Group ${(flow.groups ?? []).length + 1}`,
      color: groupColorDraft
    };
    const selectedIdSet = new Set(nodesToGroup.map((selectedNode) => selectedNode.id));
    const savedFlow = await saveFlowKeepingDetailsScroll({
      ...flow,
      groups: [...(flow.groups ?? []), group],
      nodes: flow.nodes.map((candidate) => selectedIdSet.has(candidate.id)
        ? { ...candidate, groupId: group.id, updatedAt: now }
        : candidate),
      updatedAt: now
    }).catch(() => null);
    if (!savedFlow?.groups.some((savedGroup) => savedGroup.id === group.id)) return;
    selectNodes(nodesToGroup.map((selectedNode) => selectedNode.id), nodesToGroup[nodesToGroup.length - 1]?.id ?? null);
    setGroupNameDraft("");
    setGroupColorDraft(nodeColorSwatches[((flow.groups ?? []).length + 1) % nodeColorSwatches.length]);
  };

  const renameGroup = (groupId: string, name: string) => {
    if (!flow) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const now = new Date().toISOString();
    void saveFlowKeepingDetailsScroll({
      ...flow,
      groups: flowGroups.map((group) => group.id === groupId ? { ...group, name: trimmedName } : group),
      updatedAt: now
    }).catch(() => undefined);
  };

  const updateGroupColor = (groupId: string, color: string) => {
    if (!flow) return;
    const now = new Date().toISOString();
    void saveFlowKeepingDetailsScroll({
      ...flow,
      groups: flowGroups.map((group) => group.id === groupId ? { ...group, color } : group),
      updatedAt: now
    }).catch(() => undefined);
  };

  const ungroup = (groupId: string) => {
    if (!flow) return;
    const now = new Date().toISOString();
    void saveFlowKeepingDetailsScroll({
      ...flow,
      groups: flowGroups.filter((group) => group.id !== groupId),
      nodes: flow.nodes.map((candidate) => candidate.groupId === groupId
        ? { ...candidate, groupId: undefined, updatedAt: now }
        : candidate),
      updatedAt: now
    }).catch(() => undefined);
  };

  if (!bundle) {
    return (
      <aside className="inspector" aria-label="Project inspector">
        <PanelHeader
          eyebrow="project"
          title="Inspector"
          action={panelAction}
        />
        <EmptyState icon={<HelpCircle size={24} />} title="No project open">
          Open a folder or create a project to inspect nodes, runs, notes, and artifacts.
        </EmptyState>
      </aside>
    );
  }

  if (edge && flow) {
    const source = flow.nodes.find((item) => item.id === edge.source);
    const target = flow.nodes.find((item) => item.id === edge.target);
    const legacyAnimated = edge.label === "feeds context" || edge.label === "guards edits";
    const currentEdgeWidth = edge.width ?? defaultEdgeWidth;
    const currentEdgeLineStyle = edge.lineStyle ?? "solid";
    const currentEdgeColor = edge.color ?? null;
    const currentEdgeAnimated = edge.animated ?? legacyAnimated;
    const edgeStrokeOptions = edgeColorOptions(theme);
    return (
      <aside className="inspector" aria-label="Edge inspector">
        <PanelHeader
          eyebrow="edge"
          title={`${source?.title ?? edge.source} -> ${target?.title ?? edge.target}`}
          action={
            <div className="panel-header-actions">
              <GitBranch size={20} />
              {panelAction}
            </div>
          }
        />
        {error ? (
          <div className="alert-line">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="action-row">
          <Button
            type="button"
            size="sm"
            onClick={() => void startScopedResearchChat(
              { type: "flow", flowId: flow.id },
              explainEdgePrompt({
                edgeId: edge.id,
                flowName: flow.name,
                sourceTitle: source?.title ?? edge.source,
                targetTitle: target?.title ?? edge.target,
                label: edge.label
              })
            )}
          >
            <CircleHelp size={15} />
            <span>Explain this</span>
          </Button>
        </div>
        <Field label="Label">
          <TextInput
            value={edge.label ?? ""}
            onFocus={(event) => {
              focusedEdgeLabelRef.current = event.currentTarget.value.trim();
              addSessionEdgeLabel(focusedEdgeLabelRef.current);
            }}
            onBlur={(event) => {
              const previousLabel = focusedEdgeLabelRef.current;
              const nextLabel = event.currentTarget.value;
              focusedEdgeLabelRef.current = null;
              void (async () => {
                await rememberEdgeLabel(previousLabel);
                await rememberEdgeLabel(nextLabel);
              })();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.currentTarget.blur();
            }}
            onChange={(event) => updateSelectedEdge(event.target.value)}
          />
        </Field>
        {edgeLabelHistory.length ? (
          <section className="collapsible-field">
            <button
              type="button"
              className={edgeLabelHistoryExpanded ? "collapsible-field-trigger is-expanded" : "collapsible-field-trigger"}
              aria-expanded={edgeLabelHistoryExpanded}
              onClick={() => setEdgeLabelHistoryExpanded((current) => !current)}
            >
              <ChevronRight size={15} />
              <span>Recent labels</span>
            </button>
            {edgeLabelHistoryExpanded ? (
              <div className="collapsible-field-body edge-label-history" aria-label="Edge label history">
                {edgeLabelHistory.map((label) => {
                  const isActive = label === (edge.label ?? "").trim();
                  return (
                    <button
                      key={label}
                      type="button"
                      className={isActive ? "is-active" : ""}
                      aria-pressed={isActive}
                      onClick={() => {
                        void rememberEdgeLabel(label);
                        void updateSelectedEdge(label);
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </section>
        ) : null}
        <div className="meta-grid">
          <small>Source: {source?.title ?? edge.source}</small>
          <small>Target: {target?.title ?? edge.target}</small>
        </div>
        {edge.evidence ? (
          <section className="edge-evidence" aria-label="Relationship evidence">
            <div className="edge-evidence-heading">
              <span>Relationship evidence</span>
              <div>
                <Badge>{edge.evidence.origin}</Badge>
                <Badge>{Math.round(edge.evidence.confidence * 100)}%</Badge>
                <Badge>{edge.evidence.verification}</Badge>
                <Badge>{edge.evidence.freshness}</Badge>
              </div>
            </div>
            {edge.evidence.relationKinds.length ? (
              <small>{edge.evidence.relationKinds.join(" · ")}</small>
            ) : null}
            {edge.evidence.locations.length ? (
              <div className="edge-evidence-locations">
                {edge.evidence.locations.map((location, index) => (
                  <button
                    type="button"
                    key={`${location.path}:${location.line ?? index}`}
                    title={location.fact}
                    onClick={() => void selectProjectFile(location.path, location.line ? { lineNumber: location.line } : undefined)}
                  >
                    <FileCode2 size={14} />
                    <span>{location.path}{location.line ? `:${location.line}` : ""}</span>
                  </button>
                ))}
              </div>
            ) : <small>No source location was retained for this aggregated relationship.</small>}
            {edge.evidence.checkedAt ? <small>Checked {new Date(edge.evidence.checkedAt).toLocaleString()}</small> : null}
          </section>
        ) : null}
        <section className="edge-visual-editor" aria-label="Edge visual settings">
          <div className="edge-visual-group">
            <span>Color</span>
            <div className="node-color-swatches edge-color-swatches" aria-label="Edge color presets">
              {edgeStrokeOptions.map((option) => {
                const isActive = option.value === null ? currentEdgeColor === null : currentEdgeColor === option.value;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={[option.className, isActive ? "is-active" : ""].filter(Boolean).join(" ")}
                    style={option.value ? { backgroundColor: option.value } : undefined}
                    aria-label={option.value ? `Use ${option.label} edge color` : "Use default edge color"}
                    title={option.value ?? "Default"}
                    onClick={() => void updateSelectedEdgePatch({ color: option.value ?? undefined })}
                  />
                );
              })}
            </div>
          </div>
          <div className="edge-visual-group">
            <span>Width</span>
            <div className="edge-width-presets" aria-label="Edge width presets">
              {[defaultEdgeWidth, 3, 4, 6].map((width, index) => {
                const isDefault = index === 0;
                const isActive = isDefault ? edge.width === undefined : edge.width === width;
                return (
                  <button
                    key={width}
                    type="button"
                    className={isActive ? "is-active" : ""}
                    onClick={() => void updateSelectedEdgePatch({ width: isDefault ? undefined : width })}
                  >
                    {isDefault ? "Default" : width}
                  </button>
                );
              })}
            </div>
            <small>Current: {currentEdgeWidth}px</small>
          </div>
          <div className="edge-visual-group">
            <span>Style</span>
            <div className="edge-style-grid" aria-label="Edge line style">
              {edgeLineStyleOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={currentEdgeLineStyle === option.value ? "is-active" : ""}
                  onClick={() => void updateSelectedEdgePatch({ lineStyle: option.value === "solid" ? undefined : option.value })}
                >
                  <span className={`edge-style-preview ${option.value}`} aria-hidden="true" />
                  <small>{option.label}</small>
                </button>
              ))}
            </div>
            <Switch
              checked={currentEdgeAnimated}
              onCheckedChange={(checked) => void updateSelectedEdgePatch({ animated: checked })}
              label="Animate"
            />
            <Switch
              checked={edge.bidirectional ?? false}
              onCheckedChange={(checked) => void updateSelectedEdgePatch({ bidirectional: checked ? true : undefined })}
              label="Bidirectional (arrowheads on both ends)"
            />
          </div>
        </section>
        <Button type="button" variant="danger" onClick={deleteSelectedEdge}>
          <Trash2 size={16} />
          <span>Delete edge</span>
        </Button>
      </aside>
    );
  }

  if (multipleNodesSelected && flow) {
    const updateSelectedNodes = (patchForNode: (selectedNode: ArchicodeNode) => Parameters<typeof updateNode>[0]) => {
      void (async () => {
        for (const selectedNode of selectedNodes) {
          await updateNode(patchForNode(selectedNode));
        }
      })();
    };
    const updateSelectedNodeVisual = (patch: Partial<NonNullable<ArchicodeNode["visual"]>>) => {
      updateSelectedNodes((selectedNode) => ({
        id: selectedNode.id,
        visual: {
          ...(selectedNode.visual ?? {}),
          ...patch
        }
      }));
    };
    const clearSelectedNodeBackground = () => {
      updateSelectedNodes((selectedNode) => {
        const { backgroundColor: _backgroundColor, ...visual } = selectedNode.visual ?? {};
        return { id: selectedNode.id, visual };
      });
    };
    const updateSelectedNodeSize = (axis: keyof typeof nodeSizeBounds, rawValue: number) => {
      if (!Number.isFinite(rawValue)) return;
      updateSelectedNodes((selectedNode) => {
        const currentSize = selectedNode.size ?? defaultNodeSize;
        return {
          id: selectedNode.id,
          size: {
            ...currentSize,
            [axis]: clampNodeSize(rawValue, axis)
          }
        };
      });
    };
    const resetSelectedNodeSize = () => {
      updateSelectedNodes((selectedNode) => ({ id: selectedNode.id, size: defaultNodeSize }));
    };
    const clearSelectedNodeVisual = () => {
      updateSelectedNodes((selectedNode) => ({ id: selectedNode.id, visual: {} }));
    };
    const selectedShape = selectedNodes.every((selectedNode) => (selectedNode.visual?.shape ?? "rounded") === (selectedNodes[0].visual?.shape ?? "rounded"))
      ? selectedNodes[0].visual?.shape ?? "rounded"
      : null;
    const selectedBackgroundColor = selectedNodes.every((selectedNode) => (selectedNode.visual?.backgroundColor ?? null) === (selectedNodes[0].visual?.backgroundColor ?? null))
      ? selectedNodes[0].visual?.backgroundColor ?? null
      : mixedColorValue;
    const selectedWidth = selectedNodes.every((selectedNode) => (selectedNode.size ?? defaultNodeSize).width === (selectedNodes[0].size ?? defaultNodeSize).width)
      ? (selectedNodes[0].size ?? defaultNodeSize).width
      : "";
    const selectedHeight = selectedNodes.every((selectedNode) => (selectedNode.size ?? defaultNodeSize).height === (selectedNodes[0].size ?? defaultNodeSize).height)
      ? (selectedNodes[0].size ?? defaultNodeSize).height
      : "";
    const selectedGroupId = selectedNodes.every((selectedNode) => (selectedNode.groupId ?? noGroupValue) === (selectedNodes[0].groupId ?? noGroupValue))
      ? selectedNodes[0].groupId ?? noGroupValue
      : mixedGroupValue;
    const selectedGroup = selectedGroupId !== mixedGroupValue && selectedGroupId !== noGroupValue
      ? flowGroups.find((group) => group.id === selectedGroupId)
      : null;

    return (
      <aside className="inspector" aria-label="Selected nodes inspector">
        <PanelHeader
          eyebrow="nodes"
          title={`${selectedNodes.length} nodes selected`}
          action={panelAction}
        />

        {error ? (
          <div className="alert-line">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="multi-selection-note">
          Multiple nodes are selected. Only visual settings are available, and changes apply to all selected nodes.
        </div>

        <ScrollArea className="inspector-scroll">
          <div className="node-group-editor">
            <Field label="Group">
              <Select
                value={selectedGroupId}
                onValueChange={(value) => {
                  if (value === mixedGroupValue) return;
                  assignNodesToGroup(selectedNodes, value === noGroupValue ? null : value);
                }}
                options={[
                  ...(selectedGroupId === mixedGroupValue ? [{ value: mixedGroupValue, label: "Mixed", disabled: true }] : []),
                  ...groupOptions
                ]}
              />
            </Field>
            <div className="node-group-create-row">
              <TextInput
                value={groupNameDraft}
                placeholder={`Group ${(flow.groups ?? []).length + 1}`}
                onChange={(event) => setGroupNameDraft(event.target.value)}
              />
              <Button type="button" size="sm" onClick={() => createGroupForNodes(selectedNodes)}>
                Create group
              </Button>
            </div>
            <GroupColorSwatches label="New group accent" value={groupColorDraft} onChange={setGroupColorDraft} />
            {selectedGroup ? (
              <>
                <GroupColorSwatches
                  label="Selected group accent"
                  value={selectedGroup.color ?? defaultAccentColor}
                  onChange={(color) => updateGroupColor(selectedGroup.id, color)}
                />
                <div className="node-group-actions">
                  <Button type="button" size="sm" onClick={() => assignNodesToGroup(selectedNodes, null)}>
                    Remove from group
                  </Button>
                  <Button type="button" size="sm" variant="danger" onClick={() => ungroup(selectedGroup.id)}>
                    Ungroup
                  </Button>
                </div>
              </>
            ) : null}
          </div>
          <div className="node-color-editor multi-node-visual-editor">
            <div className="node-shape-grid" aria-label="Node shape">
              {nodeShapeOptions.map((shape) => (
                <button
                  key={shape.value}
                  type="button"
                  className={selectedShape === shape.value ? "is-active" : ""}
                  aria-label={`Use ${shape.label} shape`}
                  title={shape.label}
                  onClick={() => updateSelectedNodeVisual({ shape: shape.value })}
                >
                  <span className={`node-shape-preview shape-${shape.value}`} />
                  <small>{shape.label}</small>
                </button>
              ))}
            </div>
            <div className="node-size-editor">
              <label>
                <span>Width</span>
                <TextInput
                  type="number"
                  min={nodeSizeBounds.width.min}
                  max={nodeSizeBounds.width.max}
                  step={8}
                  value={selectedWidth}
                  placeholder="Mixed"
                  onChange={(event) => updateSelectedNodeSize("width", event.target.valueAsNumber)}
                />
              </label>
              <label>
                <span>Height</span>
                <TextInput
                  type="number"
                  min={nodeSizeBounds.height.min}
                  max={nodeSizeBounds.height.max}
                  step={8}
                  value={selectedHeight}
                  placeholder="Mixed"
                  onChange={(event) => updateSelectedNodeSize("height", event.target.valueAsNumber)}
                />
              </label>
            </div>
            <div className="node-color-palette">
              <span>Background</span>
              <div className="node-color-swatches" aria-label="Background color presets">
                <button
                  type="button"
                  className={selectedBackgroundColor === null ? "is-active is-default" : "is-default"}
                  aria-label="Use default background"
                  title="Default background"
                  onClick={clearSelectedNodeBackground}
                />
                {nodeColorSwatches.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={selectedBackgroundColor === color ? "is-active" : ""}
                    style={{ backgroundColor: color }}
                    aria-label={`Use ${color} background`}
                    onClick={() => updateSelectedNodeVisual({ backgroundColor: color })}
                  />
                ))}
              </div>
            </div>
            <div className="node-visual-actions">
              <Button type="button" size="sm" onClick={resetSelectedNodeSize}>
                Reset size
              </Button>
              <Button type="button" size="sm" onClick={clearSelectedNodeVisual}>
                Reset visual
              </Button>
            </div>
          </div>
        </ScrollArea>
      </aside>
    );
  }

  if (!node || !flow) {
    return (
      <aside className="inspector" aria-label="Node inspector">
        <PanelHeader
          eyebrow="node"
          title="Inspector"
          action={panelAction}
        />
        <EmptyState icon={<HelpCircle size={24} />} title="Select a node">
          Inspect architecture, notes, flags, approvals, runs, and artifacts from the graph or node list.
        </EmptyState>
      </aside>
    );
  }

  const readinessItems: ReadinessItem[] = [];
  if (nodePolicyViolationCount) {
    readinessItems.push({
      label: `${nodePolicyViolationCount} policy violation${nodePolicyViolationCount === 1 ? "" : "s"}`,
      tone: "danger",
      tooltip: nodePolicyViolationTooltip(nodePolicyViolationCount)
    });
  }
  if (openQuestionCount) {
    const openQuestions = notes.filter((note) => note.kind === "llm-question" && !note.resolved);
    readinessItems.push({
      label: openQuestionCount === 1 ? "needs answer" : `${openQuestionCount} answers needed`,
      tone: "warning",
      tooltip: [
        openQuestionCount === 1 ? "The agent asked a clarification question:" : `The agent asked ${openQuestionCount} clarification questions:`,
        ...openQuestions.map((note) => `\n- ${note.body}`)
      ].join("")
    });
  }
  if (node.stage === "draft-rejected") {
    readinessItems.push({ label: "rejected", tone: "danger", tooltip: "This node's draft was rejected and needs revision before it can move forward." });
  }
  if (node.flags.includes("modified-not-built")) {
    readinessItems.push({ label: "not built", tone: "warning", tooltip: flagTooltips["modified-not-built"] });
  }
  if (lastRun?.status === "needs-permission") {
    readinessItems.push({ label: "permission needed", tone: "warning", tooltip: "The last run is paused waiting for you to approve a command or permission request." });
  } else if (lastRun?.status === "awaiting-plan-review") {
    readinessItems.push({ label: "review plan", tone: "warning", tooltip: "The agent produced a plan for this node and is waiting for you to review it." });
  } else if (lastRun?.status === "awaiting-code-review") {
    readinessItems.push({ label: "review code", tone: "warning", tooltip: "The agent produced code changes for this node and is waiting for you to review them." });
  } else if ((lastRun?.status === "failed" || lastRun?.status === "cancelled") && !lastRun.errorDismissedAt) {
    const details = lastRun ? runFailureDetails(lastRun, bundle?.runs ?? []) : null;
    readinessItems.push({
      label: lastRun.status === "failed" ? "run failed" : "run cancelled",
      tone: "danger",
      tooltip: details?.message ?? `The last run ${lastRun.status === "failed" ? "failed" : "was cancelled"}. Open Queue to see what happened.`,
      dismissLabel: `Dismiss ${lastRun.status === "failed" ? "run failure" : "run cancellation"}`,
      onDismiss: () => dismissReadinessError(lastRun.id)
    });
  }
  if (node.flags.includes("needs-attention") && readinessItems.length === 0) {
    const failingChecks = node.acceptanceChecks.filter((check) => check.status === "failing");
    const tooltip = failingChecks.length
      ? [
          failingChecks.length === 1
            ? "1 acceptance check is failing:"
            : `${failingChecks.length} acceptance checks are failing:`,
          ...failingChecks.map((check) => `\n- ${check.criterion}${check.evidence ? `: ${check.evidence}` : ""}`)
        ].join("")
      : flagTooltips["needs-attention"];
    readinessItems.push({ label: "needs attention", tone: "warning", tooltip });
  }

  const headerStatus = node.locked ? <Lock size={20} /> : null;

  const toggleFlag = (flag: NodeFlag) => {
    const set = new Set(node.flags);
    if (set.has(flag)) set.delete(flag);
    else set.add(flag);
    void updateNode({ id: node.id, flags: Array.from(set) });
  };

  const updateNodeVisual = (patch: Partial<NonNullable<typeof node.visual>>) => {
    updateNodeKeepingDetailsScroll({
      id: node.id,
      visual: {
        ...(node.visual ?? {}),
        ...patch
      }
    });
  };

  const clearNodeBackground = () => {
    const { backgroundColor: _backgroundColor, ...visual } = node.visual ?? {};
    updateNodeKeepingDetailsScroll({ id: node.id, visual });
  };

  const updateNodeSize = (axis: keyof typeof nodeSizeBounds, rawValue: number) => {
    if (!Number.isFinite(rawValue)) return;
    const currentSize = node.size ?? defaultNodeSize;
    updateNodeKeepingDetailsScroll({
      id: node.id,
      size: {
        ...currentSize,
        [axis]: clampNodeSize(rawValue, axis)
      }
    });
  };

  const resetNodeSize = () => {
    updateNodeKeepingDetailsScroll({ id: node.id, size: defaultNodeSize });
  };

  const clearNodeVisual = () => {
    updateNodeKeepingDetailsScroll({ id: node.id, visual: {} });
  };

  const submitNote = async () => {
    const body = noteBody.trim();
    if (!body && pendingReferencePaths.length === 0) return;
    const beforeIds = new Set(notes.map((note) => note.id));
    const nextBundle = await addNote({
      flowId: flow.id,
      nodeId: node.id,
      kind: "user-note",
      author: "user",
      body: body || "Reference attachment.",
      category: noteCategory,
      priority: notePriority,
      resolved: false
    });
    const nextNote = nextBundle?.notes
      .filter((note) => !beforeIds.has(note.id) && note.flowId === flow.id && note.nodeId === node.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (nextNote && pendingReferencePaths.length) {
      await attachNodeReferenceFiles(node.id, nextNote.id, pendingReferencePaths);
      setFocusedNoteId(nextNote.id);
    }
    setNoteBody("");
    setNoteCategory("note");
    setNotePriority("normal");
    setPendingReferencePaths([]);
  };

  const stageReferenceForDraft = async () => {
    if (!window.archicode?.pickReferenceFiles) return;
    const filePaths = await window.archicode.pickReferenceFiles();
    if (!filePaths.length) return;
    setPendingReferencePaths((current) => [...new Set([...current, ...filePaths])]);
  };

  const answerQuestionNote = async (question: Note) => {
    const answer = noteAnswers[question.id]?.trim();
    if (!answer) return;
    await addNote({
      flowId: question.flowId,
      nodeId: question.nodeId,
      kind: "user-answer",
      author: "user",
      body: answer,
      category: "decision",
      priority: question.priority,
      replyToNoteId: question.id,
      resolved: true
    });
    await updateNoteResolved(question.id, true);
    setNoteAnswers((current) => {
      const next = { ...current };
      delete next[question.id];
      return next;
    });
    setFocusedNoteId(null);
  };

  const letAiDecideQuestionNote = async (question: Note) => {
    await addNote({
      flowId: question.flowId,
      nodeId: question.nodeId,
      kind: "user-answer",
      author: "user",
      body: "Let the agent decide. Make a reasonable assumption and continue.",
      category: "decision",
      priority: question.priority,
      replyToNoteId: question.id,
      resolved: true
    });
    await updateNoteResolved(question.id, true);
    setNoteAnswers((current) => {
      const next = { ...current };
      delete next[question.id];
      return next;
    });
    setFocusedNoteId(null);
  };

  const currentNodeSize = node.size ?? defaultNodeSize;
  const nodeGroup = node.groupId ? flowGroups.find((group) => group.id === node.groupId) ?? null : null;
  const implementationScope = node.implementationScope ?? { claims: [] };
  const implementationScopeGroups = (["own", "share", "cover"] as const)
    .map((relation) => ({ relation, claims: implementationScope.claims.filter((claim) => claim.relation === relation) }))
    .filter((group) => group.claims.length > 0);
  const implementationScopeTone = { own: "accent", share: "warning", cover: "neutral" } as const;

  return (
    <aside className="inspector" aria-label="Node inspector">
      <PanelHeader
        eyebrow={node.type}
        action={
          <div className="panel-header-actions">
            {headerStatus}
            {panelAction}
          </div>
        }
      />

      {error ? (
        <div className="alert-line">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <section className="node-git-attribution" aria-label="Git graph attribution">
        <div className="node-git-attribution-heading">
          <span><GitCommitHorizontal size={14} /> Committed graph history</span>
          {nodeHistoryBusy ? <Loader2 size={14} className="is-spinning" /> : null}
        </div>
        {!nodeHistoryBusy && nodeHistory?.available ? (
          <>
            <div className="node-git-attribution-summary">
              {nodeHistory.introduced ? (
                <div title={nodeHistory.introduced.author.email}>
                  <small>Introduced in graph by</small>
                  <strong>{nodeHistory.introduced.author.name}</strong>
                  <span>{nodeHistory.introduced.shortCommit} · {new Date(nodeHistory.introduced.committedAt).toLocaleDateString()}</span>
                </div>
              ) : null}
              {nodeHistory.lastSemanticChange ? (
                <div title={nodeHistory.lastSemanticChange.author.email}>
                  <small>Last graph change by</small>
                  <strong>{nodeHistory.lastSemanticChange.author.name}</strong>
                  <span>{nodeHistory.lastSemanticChange.shortCommit} · {new Date(nodeHistory.lastSemanticChange.committedAt).toLocaleDateString()}</span>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="node-git-history-toggle"
              onClick={() => setNodeHistoryExpanded((current) => !current)}
              aria-expanded={nodeHistoryExpanded}
            >
              <ChevronRight size={13} className={nodeHistoryExpanded ? "is-expanded" : ""} />
              {nodeHistory.changes.length} committed graph change{nodeHistory.changes.length === 1 ? "" : "s"}
            </button>
            {nodeHistoryExpanded ? (
              <div className="node-git-history-list">
                {[...nodeHistory.changes].reverse().map((change) => (
                  <div key={`${change.commit}:${change.kind}`} className="node-git-history-change">
                    <span className={`node-git-change-kind is-${change.kind}`}>{change.kind}</span>
                    <div>
                      <strong title={change.author.email}>{change.author.name}</strong>
                      <span>{change.subject}</span>
                      <small>{change.shortCommit} · {new Date(change.committedAt).toLocaleString()}</small>
                      {change.changedFields.length ? <small>Changed: {change.changedFields.join(", ")}</small> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : !nodeHistoryBusy ? <small className="node-git-attribution-empty">{nodeHistory?.message ?? "No committed graph attribution is available."}</small> : null}
      </section>

      {readinessItems.length ? (
        <div className="readiness-strip" aria-label="Node needs attention">
          {readinessItems.map((item) => {
            const pill = <StatusPill tone={item.tone}>{item.label}</StatusPill>;
            return (
              <span key={item.label} className="readiness-item">
                {item.tooltip ? (
                  <Tooltip content={<span style={{ whiteSpace: "pre-line" }}>{item.tooltip}</span>}>
                    <span>{pill}</span>
                  </Tooltip>
                ) : pill}
                {item.onDismiss && item.dismissLabel ? (
                  <IconButton
                    className="readiness-dismiss"
                    title={item.dismissLabel}
                    disabled={dismissingRunId === lastRun?.id}
                    onClick={() => void item.onDismiss?.()}
                  >
                    <X size={14} />
                  </IconButton>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}

      <TabsRoot value={inspectorTab} onValueChange={setInspectorTab} className="inspector-tabs">
        <TabsList className="ui-tabs-list compact">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          {utilityTabsExpanded ? (
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          ) : null}
          <button
            type="button"
            className="activity-more-tabs-trigger inspector-more-tabs-trigger"
            aria-label={utilityTabsExpanded ? "Hide run, artifact, and advanced tabs" : "Show run, artifact, and advanced tabs"}
            aria-expanded={utilityTabsExpanded}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleUtilityTabs();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              toggleUtilityTabs();
            }}
          >
            <MoreHorizontal size={15} />
            <span>More</span>
          </button>
        </TabsList>

        <TabsContent value="details" className="inspector-tab">
          <ScrollArea
            className="inspector-scroll"
            viewportRef={detailsScrollViewportRef}
            onScroll={(event) => {
              detailsScrollTopRef.current = event.currentTarget.scrollTop;
            }}
          >
            <div className="action-grid">
              <Tooltip content="Mark this node as production approved and lock it from agent edits.">
                <Button type="button" variant="success" onClick={() => updateNodeKeepingDetailsScroll({ id: node.id, stage: "draft-approved-production" })}>
                  <CheckCircle2 size={16} />
                  <span>Approve</span>
                </Button>
              </Tooltip>
              <Tooltip content="Reject this node's current draft state and keep it editable.">
                <Button type="button" variant="danger" onClick={() => updateNodeKeepingDetailsScroll({ id: node.id, stage: "draft-rejected", locked: false })}>
                  <XCircle size={16} />
                  <span>Reject</span>
                </Button>
              </Tooltip>
              <Tooltip content="Reopen this node for changes and remove its approval lock.">
                <Button
                  type="button"
                  onClick={() => updateNodeKeepingDetailsScroll({ id: node.id, stage: "draft", locked: false, flags: node.flags.filter((flag) => flag !== "user-approved"), forceUnlockRevision: true })}
                >
                  <RotateCcw size={16} />
                  <span>Revise</span>
                </Button>
              </Tooltip>
            </div>

            <Field label="Title" hint={titleFieldHint}>
              <TextInput value={node.title} onChange={(event) => updateNodeKeepingDetailsScroll({ id: node.id, title: event.target.value })} />
            </Field>

            <Field label="Type" hint={typeFieldHint}>
              <div className="type-editor">
                <TextInput
                  value={typeDraft}
                  onChange={(event) => setTypeDraft(event.target.value)}
                  onBlur={(event) => {
                    const trimmed = event.target.value.trim();
                    typeDraftLastSyncedRef.current = trimmed;
                    setTypeDraft(trimmed);
                    persistCustomNodeType(trimmed);
                    if (trimmed === node.type) return;
                    void updateNode({ id: node.id, type: trimmed });
                  }}
                />
                <PopoverRoot
                  open={typePickerOpen}
                  onOpenChange={(open) => {
                    setTypePickerOpen(open);
                    if (open) setTypePickerQuery("");
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button type="button" className="type-picker-trigger">
                      <Search size={14} />
                      <span>Browse</span>
                      <ChevronDown size={14} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="type-picker-popover"
                    align="end"
                    side="bottom"
                    sideOffset={6}
                    onOpenAutoFocus={(event) => event.preventDefault()}
                  >
                    <div className="type-picker-head">
                      <TextInput
                        autoFocus
                        value={typePickerQuery}
                        onChange={(event) => setTypePickerQuery(event.target.value)}
                        placeholder="Search or create a type"
                        aria-label="Search or create a node type"
                      />
                    </div>
                    {canCreateTypeFromQuery ? (
                      <button type="button" className="type-picker-create" onClick={() => applyNodeTypeSelection(typePickerQuery.trim())}>
                        <Plus size={14} />
                        <span>Use custom type "{typePickerQuery.trim()}"</span>
                      </button>
                    ) : null}
                    <ScrollArea className="type-picker-scroll">
                      {filteredBuiltInNodeTypes.length ? (
                        <div className="type-picker-section">
                          <span>Presets</span>
                          {filteredBuiltInNodeTypes.map((type) => (
                            <button
                              key={type}
                              type="button"
                              className={node.type.trim().toLocaleLowerCase() === type.toLocaleLowerCase() ? "type-picker-item is-active" : "type-picker-item"}
                              onClick={() => applyNodeTypeSelection(type)}
                            >
                              <span>{type}</span>
                              <small>Preset</small>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {filteredCustomNodeTypes.length ? (
                        <div className="type-picker-section">
                          <span>Project custom</span>
                          {filteredCustomNodeTypes.map((type) => (
                            <div key={type} className="type-picker-custom-row">
                              <button
                                type="button"
                                className={node.type.trim().toLocaleLowerCase() === type.trim().toLocaleLowerCase() ? "type-picker-item is-active" : "type-picker-item"}
                                onClick={() => applyNodeTypeSelection(type)}
                              >
                                <span>{type}</span>
                                <small>Custom</small>
                              </button>
                              <button
                                type="button"
                                className="type-picker-remove"
                                aria-label={`Remove ${type} from custom type history`}
                                title={`Remove ${type} from custom type history`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  forgetCustomNodeType(type);
                                }}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {!filteredBuiltInNodeTypes.length && !filteredCustomNodeTypes.length && !canCreateTypeFromQuery ? (
                        <div className="type-picker-empty">No matching types yet.</div>
                      ) : null}
                    </ScrollArea>
                  </PopoverContent>
                </PopoverRoot>
              </div>
            </Field>

            <Field
              label="Description"
              hint={descriptionFieldHint}
              action={
                <span className="inspector-field-actions">
                  <IconButton
                    className="inspector-field-action-button"
                    title="Open description in large editor"
                    onClick={() => openLargeTextEditor("description")}
                  >
                    <Maximize2 size={13} />
                  </IconButton>
                  <IconButton
                    className="inspector-field-action-button"
                    title="Enhance with AI"
                    disabled={enhancingField === "description"}
                    onClick={() => void requestFieldEnhancement("description")}
                  >
                    {enhancingField === "description" ? <Loader2 size={13} className="is-spinning" /> : <Sparkles size={13} />}
                  </IconButton>
                </span>
              }
            >
              <AutoSizeTextArea
                className="inspector-long-text"
                minRows={3}
                maxRows={12}
                value={node.description}
                onChange={(event) => updateNodeKeepingDetailsScroll({ id: node.id, description: event.target.value })}
              />
            </Field>

            <Field label="Stage" hint={stageFieldHint}>
              <Select
                value={node.stage}
                onValueChange={(value) => updateNodeKeepingDetailsScroll({ id: node.id, stage: value as NodeStage })}
                options={stages.map((stage) => ({ value: stage, label: stage }))}
              />
            </Field>

            <Field label="Agent working set" hint="Ignored nodes stay visible in the graph, but chat and build agents treat them as outside the current working set.">
              <Switch
                checked={!node.ignored}
                onCheckedChange={(checked) => updateNodeKeepingDetailsScroll({ id: node.id, ignored: !checked })}
                label="Include"
              />
            </Field>

            <Field label="Opens detail flow" hint="Choose a subflow this node opens/links for more detail.">
              <div className="detail-flow-picker">
                <PopoverRoot
                  open={detailFlowPickerOpen}
                  onOpenChange={(open) => {
                    setDetailFlowPickerOpen(open);
                    if (open) setDetailFlowPickerQuery("");
                  }}
                >
                  <PopoverTrigger asChild>
                    <button type="button" className="ui-select-trigger detail-flow-trigger" aria-label="Choose linked detail flow">
                      <span>{linkedDetailFlowLabel}</span>
                      <ChevronDown size={14} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="detail-flow-popover"
                    align="start"
                    side="bottom"
                    sideOffset={6}
                    onOpenAutoFocus={(event) => event.preventDefault()}
                  >
                    <div className="detail-flow-popover-head">
                      <TextInput
                        autoFocus
                        value={detailFlowPickerQuery}
                        onChange={(event) => setDetailFlowPickerQuery(event.target.value)}
                        placeholder="Search flows"
                        aria-label="Search flows"
                      />
                    </div>
                    <ScrollArea className="detail-flow-scroll">
                      <div className="detail-flow-section">
                        <button
                          type="button"
                          className={!linkedSubflowId ? "detail-flow-item is-active" : "detail-flow-item"}
                          onClick={() => {
                            setLinkedSubflowKeepingDetailsScroll(null);
                            setDetailFlowPickerOpen(false);
                          }}
                        >
                          <span>No linked flow</span>
                        </button>
                        {filteredDetailFlowOptions.map(({ subflow, label }) => (
                          <button
                            key={subflow.id}
                            type="button"
                            className={linkedSubflowId === subflow.id ? "detail-flow-item is-active" : "detail-flow-item"}
                            onClick={() => {
                              setLinkedSubflowKeepingDetailsScroll(subflow.id);
                              setDetailFlowPickerOpen(false);
                            }}
                          >
                            <span>{label}</span>
                          </button>
                        ))}
                        {!filteredDetailFlowOptions.length ? (
                          <div className="detail-flow-empty">No matching flows.</div>
                        ) : null}
                      </div>
                    </ScrollArea>
                  </PopoverContent>
                </PopoverRoot>
                <Button type="button" size="sm" disabled={!linkedSubflowId} onClick={() => setActiveSubflow(linkedSubflowId || null)}>
                  <MoveUpRight size={15} />
                  <span>Open</span>
                </Button>
              </div>
            </Field>

            <Field
              label="Acceptance criteria"
              hint={acceptanceCriteriaFieldHint}
              action={
                <span className="inspector-field-actions">
                  <IconButton
                    className="inspector-field-action-button"
                    title="Open acceptance criteria in large editor"
                    onClick={() => openLargeTextEditor("acceptanceCriteria")}
                  >
                    <Maximize2 size={13} />
                  </IconButton>
                  <IconButton
                    className="inspector-field-action-button"
                    title="Enhance with AI"
                    disabled={enhancingField === "acceptanceCriteria"}
                    onClick={() => void requestFieldEnhancement("acceptanceCriteria")}
                  >
                    {enhancingField === "acceptanceCriteria" ? <Loader2 size={13} className="is-spinning" /> : <Sparkles size={13} />}
                  </IconButton>
                </span>
              }
            >
              <AutoSizeTextArea
                className="inspector-long-text"
                minRows={3}
                maxRows={12}
                value={acceptanceCriteriaDraft}
                onChange={(event) => setAcceptanceCriteriaDraft(event.target.value)}
                onBlur={(event) => {
                  const parsed = event.target.value.split("\n").map((item) => item.trim()).filter(Boolean);
                  const joined = parsed.join("\n");
                  acceptanceCriteriaDraftLastSyncedRef.current = joined;
                  setAcceptanceCriteriaDraft(joined);
                  updateNodeKeepingDetailsScroll({ id: node.id, acceptanceCriteria: parsed });
                }}
              />
            </Field>

            <DialogRoot open={Boolean(largeTextEditor)} onOpenChange={(open) => { if (!open) setLargeTextEditor(null); }}>
              <DialogContent
                className="node-large-text-editor-dialog"
                title={largeTextEditor?.field === "acceptanceCriteria" ? "Edit acceptance criteria" : "Edit description"}
                description={largeTextEditor?.field === "acceptanceCriteria"
                  ? "Keep one concrete, verifiable outcome per line."
                  : "Use the larger workspace for a clear, detailed description."}
                resizable
              >
                <div className="node-large-text-editor-body">
                  <TextArea
                    autoFocus
                    className="node-large-text-editor-input"
                    aria-label={largeTextEditor?.field === "acceptanceCriteria" ? "Acceptance criteria large editor" : "Description large editor"}
                    value={largeTextEditor?.draft ?? ""}
                    placeholder={largeTextEditor?.field === "acceptanceCriteria" ? "One acceptance criterion per line" : "Describe this node"}
                    onChange={(event) => setLargeTextEditor((current) => current ? { ...current, draft: event.target.value } : current)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        saveLargeTextEditor();
                      }
                    }}
                  />
                  <div className="node-large-text-editor-footer">
                    <small>
                      {largeTextEditor?.field === "acceptanceCriteria"
                        ? `${largeTextEditor.draft.split("\n").filter((item) => item.trim()).length} criteria`
                        : `${largeTextEditor?.draft.length ?? 0} characters`}
                      <span aria-hidden="true"> · </span>Ctrl/Cmd+Enter to save
                    </small>
                    <div className="dialog-actions">
                      <DialogClose asChild>
                        <Button type="button" size="sm">Cancel</Button>
                      </DialogClose>
                      <Button type="button" size="sm" variant="primary" onClick={saveLargeTextEditor}>Save</Button>
                    </div>
                  </div>
                </div>
              </DialogContent>
            </DialogRoot>

            <DialogRoot open={Boolean(enhancePreview)} onOpenChange={(open) => { if (!open) setEnhancePreview(null); }}>
              <DialogContent
                title={enhancePreview?.field === "description" ? "Review enhanced description" : "Review enhanced acceptance criteria"}
                description="AI suggested a revision. Edit it as needed, then apply it to this node."
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <small>Current</small>
                    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", opacity: 0.7 }}>
                      {enhancePreview?.original.trim() || "(empty)"}
                    </p>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <small>Suggested (editable)</small>
                    <AutoSizeTextArea
                      className="inspector-long-text"
                      minRows={3}
                      maxRows={16}
                      value={enhancePreview?.draft ?? ""}
                      onChange={(event) => setEnhancePreview((current) => current ? { ...current, draft: event.target.value } : current)}
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <DialogClose asChild>
                      <Button type="button" size="sm">Cancel</Button>
                    </DialogClose>
                    <Button type="button" size="sm" variant="primary" disabled={!enhancePreview?.draft.trim()} onClick={applyFieldEnhancement}>
                      <Sparkles size={15} />
                      <span>Apply</span>
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </DialogRoot>

            <Field label="Build module" hint="This tells ArchiCode which runnable part of the project this node belongs to when it needs to build, run, or test work for this feature. In a single-target project, Auto usually just works. In a multi-target project, Auto leaves it open until Gaia's AI Implement run can confidently map the node once. Choose None to opt out, or pick a specific module to lock the node to that target manually.">
              <Select
                value={moduleProfileSelectValue}
                onValueChange={(value) => {
                  if (value === moduleProfileAutoValue) {
                    updateNodeKeepingDetailsScroll({ id: node.id, moduleProfileMode: "auto", moduleProfileId: undefined });
                    return;
                  }
                  if (value === moduleProfileNoneValue) {
                    updateNodeKeepingDetailsScroll({ id: node.id, moduleProfileMode: "none", moduleProfileId: undefined });
                    return;
                  }
                  updateNodeKeepingDetailsScroll({ id: node.id, moduleProfileMode: "manual", moduleProfileId: value || undefined });
                }}
                options={[
                  { value: moduleProfileAutoValue, label: "Auto" },
                  { value: moduleProfileNoneValue, label: "None" },
                  ...bundle.project.settings.runTargetProfiles.map((profile) => ({ value: profile.id, label: profile.label }))
                ]}
              />
            </Field>

            <Field label="Acceptance checks" hint="Tests derived from the acceptance criteria above. Green = passing, red = failing, grey = not run yet. Generate tests syncs this list to the criteria and writes the test files; Run all tests executes them and updates status. Hover a row to see which criterion it verifies.">
              <div className="acceptance-checks">
                {node.acceptanceChecks.length === 0 ? (
                  <small className="acceptance-checks-empty">No tests yet. Write acceptance criteria above, then Generate tests.</small>
                ) : (
                  <div className="acceptance-check-list" style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
                    {node.acceptanceChecks.map((check) => {
                      const color = check.status === "passing" ? "#22c55e" : check.status === "failing" ? "#ef4444" : "#9ca3af";
                      const StatusIcon = check.status === "passing" ? CheckCircle2 : check.status === "failing" ? XCircle : Circle;
                      const tooltip = [
                        check.criterion,
                        check.testName ? `\nTest: ${check.testName}` : "",
                        check.testFilePath ? `\nFile: ${check.testFilePath}` : "",
                        check.evidence ? `\n\n${check.evidence}` : ""
                      ].join("");
                      return (
                        <button
                          key={check.id}
                          type="button"
                          className="acceptance-check-row"
                          title={check.testFilePath ? `${tooltip}\n\nClick to open in the file previewer.` : tooltip}
                          disabled={!check.testFilePath}
                          onClick={() => {
                            if (!check.testFilePath) return;
                            setWorkbenchView("files");
                            void selectProjectFile(check.testFilePath, {
                              matchText: check.testName ?? check.criterion,
                              searchQuery: check.testName ?? check.criterion
                            });
                          }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                            background: "transparent", border: "none", padding: "2px 0",
                            cursor: check.testFilePath ? "pointer" : "default", color: "inherit"
                          }}
                        >
                          <StatusIcon size={15} style={{ color, flexShrink: 0 }} aria-label={check.status} />
                          <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {check.criterion}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button
                    type="button"
                    size="sm"
                    disabled={node.acceptanceCriteria.length === 0 || isGeneratingChecks || isRunningChecks || isClearingChecks}
                    title={node.acceptanceCriteria.length === 0
                      ? "Add acceptance criteria first"
                      : "Run an AI agent that writes real (failing) test files for these criteria and syncs this list to the criteria"}
                    onClick={() => setConfirmGenerateOpen(true)}
                  >
                    {isGeneratingChecks ? <Loader2 size={15} className="is-spinning" /> : <Sparkles size={15} />}
                    <span>{isGeneratingChecks ? "Authoring tests…" : "Generate tests"}</span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={node.acceptanceChecks.every((check) => !check.testCommand) || isGeneratingChecks || isRunningChecks || isClearingChecks}
                    title={node.acceptanceChecks.every((check) => !check.testCommand)
                      ? "Generate tests first"
                      : "Run every test and update its status (green/red) on this node"}
                    onClick={async () => {
                      setIsRunningChecks(true);
                      try {
                        await runAcceptanceChecks(node.id);
                      } finally {
                        setIsRunningChecks(false);
                      }
                    }}
                  >
                    {isRunningChecks ? <Loader2 size={15} className="is-spinning" /> : <PlayCircle size={15} />}
                    <span>{isRunningChecks ? "Running…" : "Run all tests"}</span>
                  </Button>
                  {node.acceptanceChecks.length ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={isGeneratingChecks || isRunningChecks || isClearingChecks}
                      title="Delete the generated acceptance tests for this node and clear the checklist"
                      onClick={() => setConfirmClearOpen(true)}
                    >
                      {isClearingChecks ? <Loader2 size={15} className="is-spinning" /> : <Trash2 size={15} />}
                      <span>{isClearingChecks ? "Clearing…" : "Clear tests"}</span>
                    </Button>
                  ) : null}
                </div>

                <DialogRoot open={confirmGenerateOpen} onOpenChange={setConfirmGenerateOpen}>
                  <DialogContent title="Generate tests" description="Author automated tests from this node's acceptance criteria.">
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                        This runs an AI agent that writes real test files for the {node.acceptanceCriteria.length} acceptance {node.acceptanceCriteria.length === 1 ? "criterion" : "criteria"} into
                        {" "}<code>.archicode/tests/</code> and syncs this checklist to the criteria. The tests are expected to fail until the feature is implemented.
                      </p>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                        <DialogClose asChild>
                          <Button type="button" size="sm">Cancel</Button>
                        </DialogClose>
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          onClick={async () => {
                            setConfirmGenerateOpen(false);
                            setIsGeneratingChecks(true);
                            try {
                              await authorAcceptanceTests(node.id);
                            } finally {
                              setIsGeneratingChecks(false);
                            }
                          }}
                        >
                          <Sparkles size={15} />
                          <span>Generate tests</span>
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </DialogRoot>

                <DialogRoot open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
                  <DialogContent title="Clear generated tests" description="Remove the generated acceptance tests for this node.">
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                        This clears the acceptance-check list for this node and deletes generated files from <code>.archicode/tests/</code> for this feature. Acceptance criteria will be kept.
                      </p>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                        <DialogClose asChild>
                          <Button type="button" size="sm">Cancel</Button>
                        </DialogClose>
                        <Button
                          type="button"
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            setConfirmClearOpen(false);
                            setIsClearingChecks(true);
                            try {
                              await clearAcceptanceTests(node.id);
                            } finally {
                              setIsClearingChecks(false);
                            }
                          }}
                        >
                          <Trash2 size={15} />
                          <span>Clear tests</span>
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </DialogRoot>
              </div>
            </Field>

            <Field label="Tech stack" hint={techStackFieldHint}>
              <TextInput
                value={techStackDraft}
                onChange={(event) => setTechStackDraft(event.target.value)}
                onBlur={(event) => {
                  const parsed = event.target.value.split(",").map((item) => item.trim()).filter(Boolean);
                  const joined = parsed.join(", ");
                  techStackDraftLastSyncedRef.current = joined;
                  setTechStackDraft(joined);
                  updateNodeKeepingDetailsScroll({ id: node.id, techStack: parsed });
                }}
              />
            </Field>

            <div className="custom-node-properties">
              <div className="custom-node-properties-create">
                <Field label="Custom Keys" hint={customKeysFieldHint}>
                  <div className="custom-node-properties-create-row">
                    <TextInput
                      value={customPropertyNameDraft}
                      placeholder="Key name"
                      onChange={(event) => setCustomPropertyNameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        createCustomNodeProperty();
                      }}
                    />
                    <Select
                      value={customPropertyTypeDraft}
                      onValueChange={(value) => setCustomPropertyTypeDraft(value as CustomNodePropertyType)}
                      options={customPropertyTypeOptions}
                    />
                    <Tooltip content="Add custom key">
                      <Button type="button" size="sm" disabled={!customPropertyNameDraft.trim()} onClick={createCustomNodeProperty} aria-label="Add custom key">
                        <Plus size={15} />
                      </Button>
                    </Tooltip>
                  </div>
                </Field>
              </div>
              {customNodeProperties.length ? (
                <div className="custom-node-properties-list">
                  {customNodeProperties.map((property) => (
                    <Field key={property.id} label={property.label} hint={customPropertyTypeLabels[property.type]}>
                      <div className="custom-node-property-row">
                        <div className="custom-node-property-widget">
                          {renderCustomPropertyWidget(node, property, (value) => updateNodeKeepingDetailsScroll({
                            id: node.id,
                            customProperties: withCustomPropertyValue(node, property.id, value)
                          }))}
                        </div>
                        <Tooltip content={`Delete ${property.label}`}>
                          <Button
                            type="button"
                            size="sm"
                            className="custom-node-property-delete"
                            aria-label={`Delete ${property.label}`}
                            onClick={() => deleteCustomNodeProperty(property.id)}
                          >
                            <Trash2 size={15} />
                          </Button>
                        </Tooltip>
                      </div>
                    </Field>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="node-group-editor">
              <Field label="Group" hint={groupFieldHint}>
                <Select
                  value={node.groupId ?? noGroupValue}
                  onValueChange={(value) => assignNodesToGroup([node], value === noGroupValue ? null : value)}
                  options={groupOptions}
                />
              </Field>
              {nodeGroup ? (
                <>
                  <GroupColorSwatches
                    label="Group accent"
                    value={nodeGroup.color ?? defaultAccentColor}
                    onChange={(color) => updateGroupColor(nodeGroup.id, color)}
                  />
                  <div className="node-group-actions">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        const name = window.prompt("Rename group", nodeGroup.name);
                        if (name !== null) renameGroup(nodeGroup.id, name);
                      }}
                    >
                      Rename group
                    </Button>
                    <Button type="button" size="sm" onClick={() => assignNodesToGroup([node], null)}>
                      Remove
                    </Button>
                    <Button type="button" size="sm" variant="danger" onClick={() => ungroup(nodeGroup.id)}>
                      Ungroup
                    </Button>
                  </div>
                </>
              ) : null}
            </div>

            <section className="collapsible-field node-appearance-field">
              <button
                type="button"
                className={nodeAppearanceExpanded ? "collapsible-field-trigger is-expanded" : "collapsible-field-trigger"}
                aria-expanded={nodeAppearanceExpanded}
                onClick={toggleNodeAppearance}
              >
                <ChevronRight size={15} />
                <span>Visual</span>
              </button>
              {nodeAppearanceExpanded ? (
                <div className="collapsible-field-body node-color-editor">
                  <div className="node-shape-grid" aria-label="Node shape">
                    {nodeShapeOptions.map((shape) => (
                      <button
                        key={shape.value}
                        type="button"
                        className={node.visual?.shape === shape.value || (!node.visual?.shape && shape.value === "rounded") ? "is-active" : ""}
                        aria-label={`Use ${shape.label} shape`}
                        title={shape.label}
                        onClick={() => updateNodeVisual({ shape: shape.value })}
                      >
                        <span className={`node-shape-preview shape-${shape.value}`} />
                        <small>{shape.label}</small>
                      </button>
                    ))}
                  </div>
                  <div className="node-size-editor">
                    <label>
                      <span>Width</span>
                      <TextInput
                        type="number"
                        min={nodeSizeBounds.width.min}
                        max={nodeSizeBounds.width.max}
                        step={8}
                        value={currentNodeSize.width}
                        onChange={(event) => updateNodeSize("width", event.target.valueAsNumber)}
                      />
                    </label>
                    <label>
                      <span>Height</span>
                      <TextInput
                        type="number"
                        min={nodeSizeBounds.height.min}
                        max={nodeSizeBounds.height.max}
                        step={8}
                        value={currentNodeSize.height}
                        onChange={(event) => updateNodeSize("height", event.target.valueAsNumber)}
                      />
                    </label>
                  </div>
                  <div className="node-color-palette">
                    <span>Background</span>
                    <div className="node-color-swatches" aria-label="Background color presets">
                      <button
                        type="button"
                        className={!node.visual?.backgroundColor ? "is-active is-default" : "is-default"}
                        aria-label="Use default background"
                        title="Default background"
                        onClick={clearNodeBackground}
                      />
                      {nodeColorSwatches.map((color) => (
                        <button
                          key={color}
                          type="button"
                          className={node.visual?.backgroundColor === color ? "is-active" : ""}
                          style={{ backgroundColor: color }}
                          aria-label={`Use ${color} background`}
                          onClick={() => updateNodeVisual({ backgroundColor: color })}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="node-visual-actions">
                    <Button type="button" size="sm" onClick={resetNodeSize}>
                      Reset size
                    </Button>
                    <Button type="button" size="sm" onClick={clearNodeVisual}>
                      Reset visual
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>

          </ScrollArea>
        </TabsContent>

        <TabsContent value="notes" className="inspector-tab notes-tab">
          <div className="notes-panel-layout">
            <ScrollArea className="notes-main-scroll">
              <div className="notes-panel-main">
                <div className="note-guidance">
                  <strong>Node notes</strong>
                  <span>Use short questions, answers, decisions, and references. This is shared context with the AI Agent, not a chat transcript.</span>
                </div>
                <label className="note-filter-row">
                  <span>Show</span>
                  <select className="ui-input" value={noteFilter} onChange={(event) => setNoteFilter(event.target.value as NoteFilter)}>
                    {noteFilterOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="note-search-row">
                  <span>
                    <Search size={14} />
                    Search
                  </span>
                  <input
                    className="ui-input"
                    type="search"
                    value={noteSearch}
                    onChange={(event) => setNoteSearch(event.target.value)}
                  />
                </label>
                <div className="note-maintenance-row">
                  <MenuRoot>
                    <MenuTrigger asChild>
                      <Button type="button" size="sm" variant="ghost">
                        <Trash2 size={14} />
                        <span>Purge</span>
                        <ChevronDown size={13} />
                      </Button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      <MenuLabel>Notes</MenuLabel>
                      <MenuItem
                        disabled={purgeableSystemNoteCount === 0}
                        tooltip="Deletes unpinned system-generated notes from this node. Agent handoff and bookkeeping notes are removed."
                        onSelect={() => {
                          if (!flow || !node || purgeableSystemNoteCount === 0) return;
                          const suffix = purgeableSystemNoteCount === 1 ? "" : "s";
                          if (window.confirm(`Delete ${purgeableSystemNoteCount} unpinned system note${suffix} from this node? This removes agent handoff and bookkeeping notes.`)) {
                            void purgeSystemNotes({ flowId: flow.id, nodeId: node.id });
                          }
                        }}
                      >
                        <Trash2 size={14} />
                        <span>Purge system</span>
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        disabled={purgeableResolvedNoteCount === 0}
                        tooltip="Deletes resolved notes from this node. Pinned notes stay until manually deleted."
                        onSelect={() => {
                          if (!flow || !node || purgeableResolvedNoteCount === 0) return;
                          const suffix = purgeableResolvedNoteCount === 1 ? "" : "s";
                          if (window.confirm(`Purge ${purgeableResolvedNoteCount} resolved note${suffix} from this node? Pinned notes will stay until deleted.`)) {
                            void purgeResolvedNotes({ flowId: flow.id, nodeId: node.id });
                          }
                        }}
                      >
                        <Trash2 size={14} />
                        <span>Purge resolved</span>
                      </MenuItem>
                    </MenuContent>
                  </MenuRoot>
                </div>
                <div className="note-list">
                  {notes.length === 0 ? <EmptyState title="No notes yet">Capture decisions, answer agent questions, or attach reference material for this node.</EmptyState> : null}
                  {notes.length > 0 && visibleNotes.length === 0 ? <EmptyState title="No matching notes">Change the filter or search to view more node context.</EmptyState> : null}
                  {visibleNotes.map((note) => {
                    const nestedAnswers = note.kind === "llm-question"
                      ? questionAnswerThreads.answersByQuestionId.get(note.id) ?? []
                      : [];
                    const noteAttachments = noteAttachmentsById.get(note.id) ?? [];
                    const noteImageAttachments = noteAttachments.filter(isImageArtifact);
                    return (
                      <article
                        key={note.id}
                        data-note-id={note.id}
                        className={`note-item ${note.kind} ${note.pinned ? "is-pinned" : ""} ${focusedNoteId === note.id ? "is-focused" : ""}`}
                      >
                        <div className="note-head">
                          <strong>{displayNoteLabel(note)}</strong>
                          <span className="note-status-row">
                            {note.pinned ? (
                              <StatusPill tone="accent">pinned</StatusPill>
                            ) : null}
                            {isResolvableNote(note) ? (
                              <StatusPill tone={note.resolved ? "success" : "warning"}>
                                {note.resolved ? "resolved" : "open"}
                              </StatusPill>
                            ) : null}
                          </span>
                        </div>
                      {note.category !== "note" || note.priority !== "normal" ? (
                        <div className="note-attachments">
                          {note.category !== "note" ? (
                            <Badge tone={note.category === "bug" ? "danger" : note.category === "task" ? "warning" : "accent"}>
                              {note.category}
                            </Badge>
                          ) : null}
                          {note.priority !== "normal" ? (
                            <Badge tone={note.priority === "urgent" || note.priority === "high" ? "danger" : "neutral"}>
                              {note.priority}
                            </Badge>
                          ) : null}
                        </div>
                      ) : null}
                      <p>{note.body}</p>
                      {note.kind === "llm-question" && !note.resolved ? (
                        <div className="note-answer-box">
                          <TextArea
                            rows={2}
                            value={noteAnswers[note.id] ?? ""}
                            placeholder="Answer this question"
                            onChange={(event) => setNoteAnswers((current) => ({
                              ...current,
                              [note.id]: event.target.value
                            }))}
                          />
                          <Button type="button" size="sm" variant="primary" disabled={!noteAnswers[note.id]?.trim()} onClick={() => void answerQuestionNote(note)}>
                            <CheckCircle2 size={14} />
                            <span>Answer</span>
                          </Button>
                          <Button type="button" size="sm" onClick={() => void letAiDecideQuestionNote(note)}>
                            <span>Let AI decide</span>
                          </Button>
                        </div>
                      ) : null}
                      {nestedAnswers.length ? (
                        <div className="note-thread-answers" aria-label="Answers">
                          {nestedAnswers.map((answer) => (
                            <div key={answer.id} data-note-id={answer.id} className="note-thread-answer">
                              <div className="note-head">
                                <strong>{displayNoteLabel(answer)}</strong>
                              </div>
                              {answer.category !== "note" || answer.priority !== "normal" ? (
                                <div className="note-attachments">
                                  {answer.category !== "note" ? (
                                    <Badge tone={answer.category === "bug" ? "danger" : answer.category === "task" ? "warning" : "accent"}>
                                      {answer.category}
                                    </Badge>
                                  ) : null}
                                  {answer.priority !== "normal" ? (
                                    <Badge tone={answer.priority === "urgent" || answer.priority === "high" ? "danger" : "neutral"}>
                                      {answer.priority}
                                    </Badge>
                                  ) : null}
                                </div>
                              ) : null}
                              <p>{answer.body}</p>
                              <div className="note-meta-row">
                                <small>{new Date(answer.createdAt).toLocaleString()}</small>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {noteAttachments.length ? (
                        <>
                          {noteImageAttachments.length ? (
                            <div className="note-image-previews" aria-label="Image attachments">
                              {noteImageAttachments.map((artifact) => {
                                const previewUrl = artifactImagePreviews[artifact.id];
                                if (!previewUrl) return null;
                                return (
                                  <button
                                    key={artifact.id}
                                    type="button"
                                    className="note-image-preview"
                                    title={artifact.title}
                                    onClick={() => {
                                      if (bundle?.project.rootPath) void window.archicode.openProjectFile(bundle.project.rootPath, artifact.path);
                                    }}
                                  >
                                    <img src={previewUrl} alt={artifact.title} />
                                    <span className="note-image-tooltip" aria-hidden="true">
                                      <img src={previewUrl} alt="" />
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                          {noteAttachments.some(isNonImageArtifact) ? (
                            <div className="note-attachments">
                              {noteAttachments.filter(isNonImageArtifact).map((artifact) => {
                                const isDocument = artifact.mediaType?.startsWith("text/") ||
                                  artifact.mediaType === "application/pdf" ||
                                  artifact.mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
                                return (
                                  <button
                                    key={artifact.id}
                                    type="button"
                                    className="research-message-file-chip note-file-chip"
                                    title={artifact.title}
                                    onClick={() => {
                                      if (bundle?.project.rootPath) void window.archicode.openProjectFile(bundle.project.rootPath, artifact.path);
                                    }}
                                  >
                                    {isDocument ? <FileText size={14} /> : <Paperclip size={14} />}
                                    <span>{artifact.title}</span>
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                      <div className="note-meta-row">
                        <small>{new Date(note.createdAt).toLocaleString()}</small>
                        <div className="note-actions">
                          <Tooltip content={note.pinned ? "Unpin this note so it no longer stays at the top of relevant notes." : "Pin this note as durable context for this node."}>
                            <Button
                              type="button"
                              size="sm"
                              variant={note.pinned ? "secondary" : "ghost"}
                              aria-pressed={note.pinned}
                              onClick={() => updateNotePinned(note.id, !note.pinned)}
                            >
                              <Pin size={14} />
                              <span>{note.pinned ? "Pinned" : "Pin"}</span>
                            </Button>
                          </Tooltip>
                          {isResolvableNote(note) ? (
                            <Tooltip content={note.resolved ? "Reopen this note so it becomes active context again." : "Mark this note handled. Resolved notes can be hidden or purged later."}>
                              <Button type="button" size="sm" onClick={() => updateNoteResolved(note.id, !note.resolved)}>
                                <CheckCircle2 size={14} />
                                <span>{note.resolved ? "Reopen" : note.kind === "llm-question" ? "Dismiss" : "Resolve"}</span>
                              </Button>
                            </Tooltip>
                          ) : null}
                          <Tooltip content="Delete this note and remove it from the node context.">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                if (window.confirm("Delete this note?")) void deleteNote(note.id);
                              }}
                            >
                              <Trash2 size={14} />
                              <span>Delete</span>
                            </Button>
                          </Tooltip>
                        </div>
                      </div>
                    </article>
                    );
                  })}
                </div>
                {standaloneReferenceArtifacts.length ? (
                  <section className="reference-strip" aria-label="Node references">
                    <strong>References</strong>
                    {standaloneReferenceArtifacts.map((artifact) => (
                      <Badge key={artifact.id} tone="accent">
                        <Paperclip size={12} />
                        {artifact.title}
                      </Badge>
                    ))}
                  </section>
                ) : null}
              </div>
            </ScrollArea>
            <div className={`notes-compose-panel ${noteComposerCollapsed ? "is-collapsed" : ""}`}>
              {noteComposerCollapsed ? (
                <Tooltip content="Open the note composer. Nothing is saved until you add the note.">
                  <button type="button" className="compose-collapse-strip" onClick={() => setNoteComposerCollapsed(false)}>
                    <MessageSquare size={15} />
                    <span>New note</span>
                    <ChevronRight size={15} />
                  </button>
                </Tooltip>
              ) : (
                <>
                <Field label="New note" hint={openQuestionCount ? "This node has an open agent question. Write the answer naturally; the agent will read it with the rest of the node context." : "Keep it concise: requirement, decision, or correction. The agent will read this as node context."}>
                  <div className="note-compose-row">
                    <Select
                      value={noteCategory}
                      onValueChange={(value) => setNoteCategory(value as Note["category"])}
                      options={[
                        { value: "note", label: "Note" },
                        { value: "bug", label: "Bug" },
                        { value: "task", label: "Task" },
                        { value: "decision", label: "Decision" }
                      ]}
                    />
                    <Select
                      value={notePriority}
                      onValueChange={(value) => setNotePriority(value as Note["priority"])}
                      options={[
                        { value: "low", label: "Low" },
                        { value: "normal", label: "Normal" },
                        { value: "high", label: "High" },
                        { value: "urgent", label: "Urgent" }
                      ]}
                    />
                  </div>
                  <TextArea value={noteBody} rows={3} onChange={(event) => setNoteBody(event.target.value)} />
                  {pendingReferencePaths.length ? (
                    <div className="pending-reference-list" aria-label="Pending reference attachments">
                      {pendingReferencePaths.map((filePath) => (
                        <Badge key={filePath} tone="accent">
                          <Paperclip size={12} />
                          {fileNameFromPath(filePath)}
                        </Badge>
                      ))}
                      <Tooltip content="Remove staged attachments from this draft note. No files are deleted.">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setPendingReferencePaths([])}>
                          Clear
                        </Button>
                      </Tooltip>
                    </div>
                  ) : null}
                </Field>
                <div className="action-row">
                  <Tooltip content="Save this draft as a node note. Staged references are attached only after this click.">
                    <Button type="button" variant="primary" onClick={submitNote}>
                      <MessageSquare size={16} />
                      <span>Add note</span>
                    </Button>
                  </Tooltip>
                  <Tooltip content="Choose reference files for this draft note. They stay staged until you click Add note.">
                    <Button type="button" onClick={() => void stageReferenceForDraft()}>
                      <Paperclip size={16} />
                      <span>Attach reference</span>
                    </Button>
                  </Tooltip>
                  <Tooltip content="Hide the composer. Draft text and staged references stay here until changed.">
                    <Button type="button" size="sm" variant="ghost" className="compose-panel-collapse" onClick={() => setNoteComposerCollapsed(true)}>
                      <ChevronDown size={15} />
                      <span>Collapse</span>
                    </Button>
                  </Tooltip>
                </div>
                </>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="rules" className="inspector-tab rules-tab">
          <div className={`node-rules-panel-layout${ruleComposerCollapsed ? "" : " has-expanded-composer"}`}>
            <ScrollArea className="inspector-scroll node-rules-main-scroll">
              <section className="node-rules-panel">
                <div className="note-guidance node-rules-guidance">
                  <strong>Rules & decisions</strong>
                  <span>Durable guidance, decisions, and deterministic architecture policies included in agent context.</span>
                </div>

                <div className="node-rules-list">
                  {attachedRules.length ? attachedRules.map((rule) => {
                    const isFocusedRule = focusedRuleTarget?.ruleId === rule.id && (!focusedRuleTarget.nodeId || focusedRuleTarget.nodeId === node?.id);
                    return (
                    <article
                      key={rule.id}
                      ref={isFocusedRule ? focusedRuleCardRef : undefined}
                      className={`node-rule-card${isFocusedRule ? " is-focused-rule" : ""}`}
                    >
                      <div className="node-rule-card-header">
                        <strong>{rule.title}</strong>
                        <div className="node-rule-card-actions">
                          <IconButton title="Copy rule text" onClick={() => void copyRuleSource(rule)}>
                            <Copy size={15} />
                          </IconButton>
                          <IconButton title="Edit source rule" onClick={() => beginRuleSourceEdit(rule)}>
                            <Pencil size={15} />
                          </IconButton>
                        </div>
                      </div>
                      <div className="node-rule-badges">
                        <Badge tone={(rule.kind ?? (rule.constraint ? "policy" : "guidance")) === "policy" ? "danger" : (rule.kind ?? "guidance") === "decision" ? "accent" : "neutral"}>
                          {rule.kind ?? (rule.constraint ? "policy" : "guidance")}
                        </Badge>
                        {rule.constraint ? <Badge tone={rule.severity === "error" ? "danger" : "warning"}>{rule.severity ?? "warning"}</Badge> : null}
                        {rule.constraint ? <Badge>{rule.enforcement ?? "advisory"}</Badge> : null}
                      </div>
                      <p className="node-rule-body">{rule.body}</p>
                      {rule.constraint ? (
                        <div className="node-rule-policy-scope">
                          {policyConstraintSummary(rule.constraint).map((summary) => <small key={summary}>{summary}</small>)}
                        </div>
                      ) : null}
                      <div className="action-row end node-rule-detach-row">
                        <Button type="button" size="sm" onClick={() => detachRuleFromNode(rule.id)}>
                          Detach
                        </Button>
                      </div>
                    </article>
                    );
                  }) : (
                    <EmptyState title="No rules attached">Attach reusable guidance for agents working from this node.</EmptyState>
                  )}
                </div>

                <Field label="Attach rule">
                  <div className="node-rule-attach-row">
                    <Select
                      value={ruleAttachDraft}
                      onValueChange={setRuleAttachDraft}
                      options={attachableRules.length
                        ? attachableRules.map((rule) => ({ value: rule.id, label: rule.title }))
                        : [{ value: "__none__", label: "No available rules", disabled: true }]}
                      placeholder="Select rule"
                      disabled={!attachableRules.length}
                    />
                    <Button type="button" size="sm" disabled={!ruleAttachDraft || ruleAttachDraft === "__none__"} onClick={() => void attachRuleToNode()}>
                      Attach
                    </Button>
                    <IconButton
                      title="Edit source rule"
                      disabled={!selectedAttachRule}
                      onClick={() => selectedAttachRule && beginRuleSourceEdit(selectedAttachRule)}
                    >
                      <Pencil size={15} />
                    </IconButton>
                    <IconButton
                      title="Copy rule text"
                      disabled={!selectedAttachRule}
                      onClick={() => selectedAttachRule && void copyRuleSource(selectedAttachRule)}
                    >
                      <Copy size={15} />
                    </IconButton>
                  </div>
                </Field>

                {editingRule ? (
                  <Field label="Edit source rule">
                    <div className="node-rule-source-editor">
                      <RuleControl label="Title" help="A short name shown on the node, in issue results, and in agent context.">
                        <TextInput
                          aria-label="Rule title"
                          value={ruleEditTitleDraft}
                          placeholder="Rule title"
                          onChange={(event) => setRuleEditTitleDraft(event.target.value)}
                        />
                      </RuleControl>
                      <RuleControl label="Description" help="Explain the intent and what developers or agents should do instead. This text accompanies violations and agent context.">
                        <TextArea
                          aria-label="Rule description"
                          value={ruleEditBodyDraft}
                          rows={5}
                          placeholder="Explain the guidance, decision, or policy..."
                          onChange={(event) => setRuleEditBodyDraft(event.target.value)}
                        />
                      </RuleControl>
                      <RuleControl label="Type" help="Choose whether this is prose guidance, a recorded decision, or a deterministic code policy. Hover each option for its behavior.">
                        <Select
                          ariaLabel="Rule type"
                          value={ruleEditKindDraft}
                          onValueChange={(value) => setRuleEditKindDraft(value as NonNullable<NodeRule["kind"]>)}
                          options={ruleKindOptions}
                        />
                      </RuleControl>
                      {ruleEditKindDraft === "policy" ? (
                        <div className="node-rule-policy-editor">
                          <PolicyConstraintEditor draft={ruleEditPolicyDraft} onChange={setRuleEditPolicyDraft} />
                          <div className="node-rule-policy-options">
                            <RuleControl label="Severity" help="Controls how serious the violation appears. Only Error severity can block a run. Hover each option for details.">
                              <Select
                                ariaLabel="Policy severity"
                                value={ruleEditSeverityDraft}
                                onValueChange={(value) => setRuleEditSeverityDraft(value as NonNullable<NodeRule["severity"]>)}
                                options={ruleSeverityOptions}
                              />
                            </RuleControl>
                            <RuleControl label="Enforcement" help="Controls whether the check only reports findings or can gate newly introduced errors. Hover each option for details.">
                              <Select
                                ariaLabel="Policy enforcement"
                                value={ruleEditEnforcementDraft}
                                onValueChange={(value) => setRuleEditEnforcementDraft(value as NonNullable<NodeRule["enforcement"]>)}
                                options={ruleEnforcementOptions}
                              />
                            </RuleControl>
                          </div>
                        </div>
                      ) : null}
                      <div className="action-row end">
                        <Button type="button" size="sm" variant="danger" onClick={() => void deleteRuleSource(editingRule)}>
                          <Trash2 size={14} />
                          <span>Delete</span>
                        </Button>
                        <Button type="button" size="sm" onClick={cancelRuleSourceEdit}>
                          Cancel
                        </Button>
                        <Button type="button" size="sm" variant="primary" disabled={!ruleEditTitleDraft.trim() || !ruleEditBodyDraft.trim() || (ruleEditKindDraft === "policy" && !buildPolicyConstraint(ruleEditPolicyDraft))} onClick={saveRuleSourceEdit}>
                          Save source
                        </Button>
                      </div>
                    </div>
                  </Field>
                ) : null}
              </section>
            </ScrollArea>

            <div className={`node-rules-compose-panel ${ruleComposerCollapsed ? "is-collapsed" : ""}`}>
              {ruleComposerCollapsed ? (
                <button type="button" className="compose-collapse-strip" onClick={() => setRuleComposerCollapsed(false)}>
                  <Plus size={15} />
                  <span>New rule</span>
                  <ChevronRight size={15} />
                </button>
              ) : (
                <div className="node-rules-compose-expanded">
                  <ScrollArea className="node-rules-compose-scroll">
                    <Field label="New rule">
                      <div className="node-rule-create">
                  <RuleControl label="Type" help="Choose whether this is prose guidance, a recorded decision, or a deterministic code policy. Hover each option for its behavior.">
                    <Select
                      ariaLabel="Rule type"
                      value={ruleKindDraft}
                      onValueChange={(value) => setRuleKindDraft(value as NonNullable<NodeRule["kind"]>)}
                      options={ruleKindOptions}
                    />
                  </RuleControl>
                  <RuleControl label="Title" help="A short name shown on the node, in issue results, and in agent context.">
                    <TextInput
                      aria-label="Rule title"
                      value={ruleTitleDraft}
                      placeholder="Rule title"
                      onChange={(event) => setRuleTitleDraft(event.target.value)}
                    />
                  </RuleControl>
                  <RuleControl label="Description" help="Explain the intent and what developers or agents should do instead. This text accompanies violations and agent context.">
                    <TextArea
                      aria-label="Rule description"
                      value={ruleBodyDraft}
                      rows={5}
                      placeholder="Explain the guidance, decision, or policy..."
                      onChange={(event) => setRuleBodyDraft(event.target.value)}
                    />
                  </RuleControl>
                  {ruleKindDraft === "policy" ? (
                    <div className="node-rule-policy-editor">
                      <PolicyConstraintEditor draft={rulePolicyDraft} onChange={setRulePolicyDraft} />
                      <div className="node-rule-policy-options">
                        <RuleControl label="Severity" help="Controls how serious the violation appears. Only Error severity can block a run. Hover each option for details.">
                          <Select
                            ariaLabel="Policy severity"
                            value={ruleSeverityDraft}
                            onValueChange={(value) => setRuleSeverityDraft(value as NonNullable<NodeRule["severity"]>)}
                            options={ruleSeverityOptions}
                          />
                        </RuleControl>
                        <RuleControl label="Enforcement" help="Controls whether the check only reports findings or can gate newly introduced errors. Hover each option for details.">
                          <Select
                            ariaLabel="Policy enforcement"
                            value={ruleEnforcementDraft}
                            onValueChange={(value) => setRuleEnforcementDraft(value as NonNullable<NodeRule["enforcement"]>)}
                            options={ruleEnforcementOptions}
                          />
                        </RuleControl>
                      </div>
                      <small>This check runs locally from repository and graph facts. It adds no AI-model latency or token cost.</small>
                    </div>
                  ) : null}
                      </div>
                    </Field>
                  </ScrollArea>
                  <div className="action-row end node-rules-compose-actions">
                    <Button
                      type="button"
                      variant="primary"
                      disabled={!ruleBodyDraft.trim() || (ruleKindDraft === "policy" && !buildPolicyConstraint(rulePolicyDraft))}
                      onClick={() => void createAndAttachRule()}
                    >
                      <Plus size={16} />
                      <span>Create and attach</span>
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="compose-panel-collapse" onClick={() => setRuleComposerCollapsed(true)}>
                      <ChevronDown size={15} />
                      <span>Collapse</span>
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="runs" className="inspector-tab">
          <ScrollArea className="inspector-scroll">
            <div className="scoped-action-block">
              <div className="scoped-action-label">
                <span>Node-scoped AI</span>
                <Tooltip content={`${gaiaAgent.title}. Runs AI implementation with this node as the anchor. Gaia still reads related graph context, but prioritizes this node's stage, notes, acceptance criteria, artifacts, and connected edges.`}>
                  <HelpCircle size={14} className="hint-icon" aria-label="Node-scoped AI help" />
                </Tooltip>
              </div>
              <div className="action-grid">
                <Button
                  type="button"
                  variant="primary"
                  title={runChangeBlocked
                    ? "A run is already active or waiting for review."
                    : buildCommand
                      ? `Ask the LLM to plan, code, test, and verify from this node with: ${buildCommand}`
                      : "Ask the LLM to plan, code, and identify the right tests/verification from this node. No project verification command is configured yet."}
                  disabled={runChangeBlocked}
                  onClick={() => runAgent({
                    nodeId: node.id,
                    promptSummary: buildCommand
                      ? `Plan from node "${node.title}" using its stage, flags, diff/artifact state, notes, edges, acceptance criteria, and related graph context. If required info is missing, abort coding and ask clarification questions as node notes. If sufficient, code, add or update appropriate unit/integration/renderer tests for changed behavior, and verify with: ${buildCommand}. If tests cannot be added or run, explain why and mark this node as needing attention.`
                      : `Plan from node "${node.title}" using its stage, flags, diff/artifact state, notes, edges, acceptance criteria, and related graph context. If required info is missing, abort coding and ask clarification questions as node notes. If sufficient, code, add or update appropriate unit/integration/renderer tests for changed behavior, and identify the correct verification command if needed. If tests cannot be added or run, explain why and mark this node as needing attention.`
                  })}
                >
                  <Sparkles size={16} />
                  <span>AI Implement</span>
                </Button>
              </div>
            </div>
            <div className="record-list">
              {nodeRuns.length === 0 ? <EmptyState title="No node runs">Use AI Implement to ask Gaia for a node-scoped run.</EmptyState> : null}
              {nodeRuns.map((run) => (
                <article key={run.id} className="record-card">
                  <StatusPill tone={statusTone(run.status)}>{run.status}</StatusPill>
                  <strong>{run.promptSummary}</strong>
                  <small>{new Date(run.createdAt).toLocaleString()}</small>
                  {run.runInstructions ? <p>{run.runInstructions}</p> : null}
                </article>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="artifacts" className="inspector-tab">
          <ScrollArea className="inspector-scroll">
            <div className="record-list">
              {nodeArtifacts.length === 0 ? (
                <EmptyState icon={<FileArchive size={20} />} title="No node artifacts">
                  Logs, diffs, summaries, screenshots, and attachments linked to this node will appear here.
                </EmptyState>
              ) : null}
              {nodeArtifacts.map((artifact) => (
                <article key={artifact.id} className="record-card">
                  <Badge>{artifact.type}</Badge>
                  <strong>{artifact.title}</strong>
                  <small>{artifact.path}</small>
                  {artifact.summary ? <p>{artifact.summary}</p> : null}
                </article>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="advanced" className="inspector-tab">
          <ScrollArea className="inspector-scroll">
            <section className="subpanel semantic-context-panel">
              <div className="subpanel-title semantic-context-title">
                <button
                  type="button"
                  className={semanticContextExpanded ? "semantic-context-trigger is-expanded" : "semantic-context-trigger"}
                  aria-expanded={semanticContextExpanded}
                  onClick={() => setSemanticContextExpanded((current) => !current)}
                >
                  <ChevronRight size={15} />
                  <BrainCircuit size={16} />
                  <span>Semantic context</span>
                  {semanticContext ? (
                    <Badge tone={semanticContextHasData ? "success" : semanticContext.state === "stale" ? "warning" : semanticContext.state === "error" || semanticContext.state === "unavailable" ? "danger" : "neutral"}>
                      {semanticContextHasData ? "available" : semanticContext.state.replace("-", " ")}
                    </Badge>
                  ) : null}
                </button>
                <Tooltip content="Local cached meaning matches. Similarity suggests useful context, not a proven code dependency, implementation claim, or graph edge.">
                  <HelpCircle size={14} className="hint-icon" aria-label="Semantic context help" />
                </Tooltip>
                {semanticContextExpanded ? (
                  <IconButton
                    title="Refresh semantic matches"
                    size="sm"
                    disabled={semanticContextBusy || !bundle.project.settings.semanticIndex.enabled}
                    onClick={() => void loadSemanticContext(true)}
                  >
                    {semanticContextBusy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                  </IconButton>
                ) : null}
              </div>
              {semanticContextExpanded ? <p className="debug-guidance">Local-only advisory matches from the semantic cache. They are never saved into the graph or committed to Git.</p> : null}
              {semanticContextExpanded && !bundle.project.settings.semanticIndex.enabled ? (
                <div className="meta-grid"><small>Enable local semantic indexing in Settings → Advanced to see meaning-based context.</small></div>
              ) : semanticContextExpanded && semanticContextError ? (
                <div className="meta-grid"><small>{semanticContextError}</small></div>
              ) : semanticContextExpanded && semanticContextBusy && !semanticContext ? (
                <div className="semantic-context-loading"><Loader2 size={14} className="spin" /><small>Reading local semantic context…</small></div>
              ) : semanticContextExpanded && semanticContext ? (
                <div className="semantic-context-body">
                  <div className="meta-grid semantic-context-meta">
                    {!semanticContextHasData ? <small>{semanticContext.message}</small> : null}
                    <small>Model: {semanticContext.modelId}</small>
                    <small>Cached: {semanticContext.updatedAt ? new Date(semanticContext.updatedAt).toLocaleString() : "not yet"}</small>
                  </div>
                  <div className="semantic-context-group">
                    <div className="semantic-context-group-head"><strong>Related graph nodes</strong><small>{semanticContext.relatedNodes.length}</small></div>
                    {semanticContext.relatedNodes.length ? semanticContext.relatedNodes.map((match) => (
                      <button
                        key={`${match.flowId}:${match.nodeId}`}
                        type="button"
                        className="semantic-context-match semantic-context-node-match"
                        title={`Open ${match.title}`}
                        onClick={() => {
                          if (match.flowId !== flow.id) setActiveFlow(match.flowId);
                          selectNodes([match.nodeId], match.nodeId);
                        }}
                      >
                        <div><strong>{match.title}</strong><small>{match.flowId === flow.id ? "This flow" : `Flow: ${match.flowId}`}</small></div>
                        <Badge>{Math.round(match.score * 100)}% match</Badge>
                      </button>
                    )) : <small>No strong graph-node matches are cached.</small>}
                  </div>
                  <div className="semantic-context-group">
                    <div className="semantic-context-group-head"><strong>Possible semantic matches</strong><small>{semanticContext.relatedCode.length}</small></div>
                    {semanticContext.relatedCode.length ? semanticContext.relatedCode.map((match) => (
                      <button
                        key={match.path}
                        type="button"
                        className="semantic-context-match semantic-context-code-match"
                        title={match.preview}
                        onClick={() => {
                          setWorkbenchView("files");
                          void selectProjectFile(match.path, { lineNumber: match.startLine });
                        }}
                      >
                        <span className="semantic-code-location">
                          <code>{match.path}</code>
                          {match.symbol || match.startLine ? <small>{[match.symbol, match.startLine ? `lines ${match.startLine}${match.endLine && match.endLine !== match.startLine ? `–${match.endLine}` : ""}` : ""].filter(Boolean).join(" · ")}</small> : null}
                        </span>
                        <Badge>{Math.round(match.score * 100)}% match</Badge>
                      </button>
                    )) : <small>{semanticContext.codeItems > 0
                      ? "No indexed source-code matches cleared the similarity threshold for this node."
                      : "No source code is indexed yet. Rebuild the Semantic Code Index in Settings → Advanced."}</small>}
                    <small>Generated from indexed source code only; graph matches and the Architecture Lens Map do not populate this list.</small>
                  </div>
                </div>
              ) : null}
            </section>
            <section className="subpanel subject-perspectives-panel">
              <div className="subpanel-title subject-perspectives-title">
                  <button
                    type="button"
                    className={subjectPerspectivesExpanded ? "subject-perspectives-trigger is-expanded" : "subject-perspectives-trigger"}
                    aria-expanded={subjectPerspectivesExpanded}
                    onClick={() => setSubjectPerspectivesExpanded((current) => !current)}
                  >
                    <ChevronRight size={15} />
                    <GitBranch size={16} />
                    <span>Same subject across flows</span>
                    <Badge tone={otherSubjectAppearances.length ? "accent" : "neutral"}>{otherSubjectAppearances.length}</Badge>
                  </button>
                  <Tooltip content="Shows the same stable subject identity when it appears in another flow. This is not semantic matching, code ownership, or a Leiden community.">
                    <HelpCircle size={14} className="hint-icon" aria-label="Shared subject help" />
                  </Tooltip>
              </div>
              {subjectPerspectivesExpanded ? <div className="subject-perspective-list">
                {otherSubjectAppearances.length ? otherSubjectAppearances.map((appearance) => (
                      <button
                        key={`${appearance.flow.id}:${appearance.node.id}`}
                        type="button"
                        className="subject-perspective-row"
                        title={`Open ${appearance.flow.name}`}
                        onClick={() => {
                          setActiveFlow(appearance.flow.id);
                          setActiveSubflow(appearance.node.subflowId ?? null);
                          selectNodes([appearance.node.id], appearance.node.id);
                        }}
                      >
                        <span><strong>{appearance.flow.name}</strong><small>{appearance.flow.perspective?.question ?? "Evidence structure"}</small></span>
                        <Badge tone={appearance.flow.perspective?.confidence === "high" ? "success" : appearance.flow.perspective?.confidence === "exploratory" ? "warning" : "accent"}>
                          {appearance.flow.perspective?.confidence ?? "evidence"}
                        </Badge>
                      </button>
                )) : <small>No matching subject identity appears in another flow.</small>}
              </div> : null}
            </section>
            <section className="subpanel implementation-scope-panel">
              <div className="subpanel-title">
                <button
                  type="button"
                  className={implementationScopeExpanded ? "implementation-scope-trigger is-expanded" : "implementation-scope-trigger"}
                  aria-expanded={implementationScopeExpanded}
                  onClick={() => setImplementationScopeExpanded((current) => !current)}
                >
                  <ChevronRight size={15} />
                  <FileText size={16} />
                  <span>Implementation scope</span>
                  <small>{implementationScope.claims.length} hint{implementationScope.claims.length === 1 ? "" : "s"}</small>
                </button>
                <Tooltip content="Compact, deterministic best-effort hints inferred from code analysis. They may be incomplete, inaccurate, or stale and are not edit permissions or authoritative ownership.">
                  <HelpCircle size={14} className="hint-icon" aria-label="Implementation scope help" />
                </Tooltip>
              </div>
              {implementationScopeExpanded ? (
                <div className="implementation-scope-body">
                  <p className="debug-guidance">
                    Navigation hints only. Agents verify these against the current codebase before acting; missing hints mean unknown, not necessarily no implementation.
                  </p>
                  {implementationScopeGroups.length ? (
                    <div className="implementation-scope-groups" aria-label="Best-effort implementation scope hints">
                      {implementationScopeGroups.map((group) => (
                        <div key={group.relation} className="implementation-scope-group">
                          <div className="implementation-scope-group-head">
                            <Badge tone={implementationScopeTone[group.relation]}>{group.relation}</Badge>
                            <small>{group.claims.length} hint{group.claims.length === 1 ? "" : "s"}</small>
                          </div>
                          <div className="implementation-scope-list">
                            {group.claims.map((claim, index) => {
                              const key = `${claim.relation}-${claim.kind}-${claim.path}-${claim.symbol ?? ""}-${index}`;
                              const content = (
                                <>
                                  <span className="implementation-scope-kind">{claim.kind}</span>
                                  <code>{claim.path}{claim.symbol ? ` · ${claim.symbol}` : ""}</code>
                                </>
                              );
                              return claim.kind === "directory" ? (
                                <div key={key} className="implementation-scope-row">{content}</div>
                              ) : (
                                <button
                                  key={key}
                                  type="button"
                                  className="implementation-scope-row is-clickable"
                                  title={`Open ${claim.path}`}
                                  onClick={() => {
                                    setWorkbenchView("files");
                                    void selectProjectFile(claim.path);
                                  }}
                                >
                                  {content}
                                  <MoveUpRight size={13} aria-hidden="true" />
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="meta-grid"><small>No implementation hints are available for this node.</small></div>
                  )}
                  {implementationScope.source ? (
                    <small className="implementation-scope-source">
                      Source: {implementationScope.source.replaceAll("-", " ")}
                      {implementationScope.analyzerVersion ? ` · analyzer v${implementationScope.analyzerVersion}` : ""}
                      {implementationScope.updatedByRunId ? ` · run ${implementationScope.updatedByRunId}` : ""}
                    </small>
                  ) : null}
                  <small className="implementation-scope-checked-at">
                    Checked as of: {implementationScope.checkedAt ? new Date(implementationScope.checkedAt).toLocaleString() : "unknown (legacy metadata)"}
                  </small>
                </div>
              ) : null}
            </section>
            <section className="subpanel">
              <div className="subpanel-title">
                <HelpCircle size={16} />
                <span>Flags</span>
              </div>
              <p className="debug-guidance">Listed for debugging. Leave these flags as they are unless you are sure the harness inferred them incorrectly.</p>
              <div className="flag-grid" aria-label="Node flags">
                {flags.map((flag) => (
                  <label key={flag} className="check-row">
                    <input type="checkbox" checked={node.flags.includes(flag)} onChange={() => toggleFlag(flag)} />
                    <span>{flag}</span>
                    <Tooltip content={flagTooltips[flag]}>
                      <HelpCircle size={14} className="hint-icon" aria-label={`${flag} help`} />
                    </Tooltip>
                  </label>
                ))}
              </div>
            </section>
            <section className="subpanel">
              <div className="subpanel-title">
                <HelpCircle size={16} />
                <span>Internal todos</span>
                <Tooltip content="Node-scoped work items used by the harness and LLM runs.">
                  <HelpCircle size={14} className="hint-icon" aria-label="Internal todos help" />
                </Tooltip>
              </div>
              <div className="todo-list">
                {node.todos.length === 0 ? <small>No node todos yet.</small> : null}
                {node.todos.map((todo) => (
                  <label key={todo.id} className="check-row">
                    <input
                      type="checkbox"
                      checked={todo.done}
                      onChange={() => updateNode({
                        id: node.id,
                        todos: node.todos.map((item) => item.id === todo.id ? { ...item, done: !item.done } : item)
                      })}
                    />
                    <span>{todo.text}</span>
                  </label>
                ))}
              </div>
            </section>
            <section className="subpanel">
              <div className="subpanel-title">
                <HelpCircle size={16} />
                <span>Graph state</span>
                <Tooltip content="Readable node metadata. The full JSON still lives in the project files for LLM clarity.">
                  <HelpCircle size={14} className="hint-icon" aria-label="Graph state help" />
                </Tooltip>
              </div>
              <div className="meta-grid">
                <small>ID: {node.id}</small>
                <small>Type: {node.type}</small>
                <small>Locked: {node.locked ? "yes" : "no"}</small>
                <small>Position: {Math.round(node.position.x)}, {Math.round(node.position.y)}</small>
                <small>Attachments: {node.attachments.length ? node.attachments.length : "none"}</small>
              </div>
            </section>
          </ScrollArea>
        </TabsContent>
      </TabsRoot>
    </aside>
  );
}
