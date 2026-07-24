import { t } from "@renderer/i18n";
import {
  Boxes,
  ChevronDown,
  Check,
  Cloud,
  Compass,
  Copy,
  Cpu,
  Database,
  Eye,
  EyeOff,
  GitBranch,
  History,
  Layers3,
  MoreHorizontal,
  Network,
  Package,
  Plus,
  Route,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  Workflow
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ArchicodeNode, Flow, FlowSubflow } from "@shared/schema";
import { projectTemplates, type ProjectTemplateId } from "@shared/templates";
import { getActiveFlow, useArchicodeStore } from "../store/useArchicodeStore";
import {
  Badge,
  Button,
  CommandGroup,
  EmptyState,
  IconButton,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  ScrollArea,
  TextInput,
  Tooltip
} from "./ui";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { getOpenQuestionsForScope } from "../utils/nodeSignals";
import { builtInNodeTypes } from "../utils/nodeTypes";
import { isRunBlockingNewChange } from "../utils/runStatus";
import { childSubflowsForFlow, compareSiblingSubflows, compareTopLevelFlows, editableFlowName, flowDisplayName, isSubflowIgnored, normalizeEvidenceFlow, visibleNodesForFlow } from "@shared/graph";
import { matches as chordMatches } from "../utils/keybindings";
import { proposedFlowsForGraphPreview } from "../utils/graphChangePreview";
import { ProjectBriefing } from "./ProjectBriefing";

const sidebarStageLabels: Record<ArchicodeNode["stage"], string> = {
  planned: "planned",
  "plan-approved": "plan ok",
  working: "working",
  draft: "draft",
  "draft-rejected": "rejected",
  "draft-approved-production": "production"
};

type FlowVisualIcon = NonNullable<NonNullable<Flow["visual"]>["icon"]>;
type FlowVisual = NonNullable<Flow["visual"]>;

const flowIconOptions: Array<{ value: FlowVisualIcon; label: string; icon: LucideIcon }> = [
  { value: "workflow", label: t("Workflow"), icon: Workflow },
  { value: "route", label: t("Route"), icon: Route },
  { value: "network", label: t("Network"), icon: Network },
  { value: "boxes", label: t("Modules"), icon: Boxes },
  { value: "layers", label: t("Layers"), icon: Layers3 },
  { value: "database", label: t("Data"), icon: Database },
  { value: "cloud", label: t("Cloud"), icon: Cloud },
  { value: "users", label: t("Users"), icon: Users },
  { value: "shield", label: t("Security"), icon: ShieldCheck },
  { value: "cpu", label: t("Runtime"), icon: Cpu },
  { value: "package", label: t("Package"), icon: Package },
  { value: "sparkles", label: t("Ideas"), icon: Sparkles },
  { value: "compass", label: t("Journey"), icon: Compass }
];

const flowIconColors = ["#7bc6d5", "#8bd39e", "#f0c66b", "#f08a7a", "#b7a7ff", "#58a6ff", "#ff9f43", "#e056a7"];

function flowIconComponent(icon?: FlowVisualIcon): LucideIcon {
  return flowIconOptions.find((option) => option.value === icon)?.icon ?? GitBranch;
}

function FlowIdentityIcon({ visual, size = 16 }: { visual?: Flow["visual"]; size?: number }) {
  const Icon = flowIconComponent(visual?.icon);
  return <Icon size={size} style={visual?.color ? { color: visual.color } : undefined} />;
}

function perspectiveLabel(flow: Flow): string | undefined {
  if (!flow.perspective) return undefined;
  return flow.perspective.kind.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function subflowLinkedTitle(flow: Flow, subflow: FlowSubflow): string | undefined {
  if (!subflow.parentNodeId) return undefined;
  const nodeTitle = flow.nodes.find((node) => node.id === subflow.parentNodeId)?.title ?? subflow.parentNodeId;
  return `Linked from ${nodeTitle}`;
}

function subflowMatchesFlowSearch(flow: Flow, subflow: FlowSubflow, query: string): boolean {
  if (!query) return true;
  const nameMatches = subflow.name.toLowerCase().includes(query);
  const linkedTitle = subflowLinkedTitle(flow, subflow)?.toLowerCase() ?? "";
  if (nameMatches || linkedTitle.includes(query)) return true;
  return childSubflowsForFlow(flow, subflow.id).some((child) => subflowMatchesFlowSearch(flow, child, query));
}

export function ProjectSidebar({
  panelAction,
  onOpenProjectLauncher
}: {
  panelAction?: ReactNode;
  onOpenProjectLauncher?: () => void;
}) {
  const {
    bundle,
    activeFlowId,
    activeSubflowId,
    searchQuery,
    selectedNodeId,
    selectedNodeIds,
    selectNode,
    selectNodes,
    toggleNodeSelection,
    navigateToGraphTarget,
    setActiveFlow,
    setActiveSubflow,
    setSearchQuery,
    rootPath,
    addNode,
    createFlow,
    createSubflow,
    renameSubflow,
    toggleSubflowIgnored,
    reparentSubflow,
    deleteSubflow,
    saveFlow,
    openProjectFolder,
    openRecentProject,
    revealProjectFolder,
    createProjectFromTemplate,
    recentProjects,
    keybindings,
    historicalInspection,
    graphPreview,
    setGraphPreviewFlow
  } = useArchicodeStore(useShallow((state) => ({
    bundle: state.bundle,
    activeFlowId: state.activeFlowId,
    activeSubflowId: state.activeSubflowId,
    searchQuery: state.searchQuery,
    selectedNodeId: state.selectedNodeId,
    selectedNodeIds: state.selectedNodeIds,
    selectNode: state.selectNode,
    selectNodes: state.selectNodes,
    toggleNodeSelection: state.toggleNodeSelection,
    navigateToGraphTarget: state.navigateToGraphTarget,
    setActiveFlow: state.setActiveFlow,
    setActiveSubflow: state.setActiveSubflow,
    setSearchQuery: state.setSearchQuery,
    rootPath: state.rootPath,
    addNode: state.addNode,
    createFlow: state.createFlow,
    createSubflow: state.createSubflow,
    renameSubflow: state.renameSubflow,
    toggleSubflowIgnored: state.toggleSubflowIgnored,
    reparentSubflow: state.reparentSubflow,
    deleteSubflow: state.deleteSubflow,
    saveFlow: state.saveFlow,
    openProjectFolder: state.openProjectFolder,
    openRecentProject: state.openRecentProject,
    revealProjectFolder: state.revealProjectFolder,
    createProjectFromTemplate: state.createProjectFromTemplate,
    recentProjects: state.recentProjects,
    keybindings: state.keybindings,
    historicalInspection: state.historicalInspection,
    graphPreview: state.graphPreview,
    setGraphPreviewFlow: state.setGraphPreviewFlow
  })));
  const [flowsExpanded, setFlowsExpanded] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [pathCopyFailed, setPathCopyFailed] = useState(false);
  const [flowSearchQuery, setFlowSearchQuery] = useState("");
  const [renamingFlow, setRenamingFlow] = useState<{ id: string; name: string } | null>(null);
  const [renamingSubflow, setRenamingSubflow] = useState<{ id: string; name: string } | null>(null);
  const [draggingSubflowId, setDraggingSubflowId] = useState<string | null>(null);
  const [flowVisualDrafts, setFlowVisualDrafts] = useState<Record<string, FlowVisual>>({});
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarSelectionAnchorRef = useRef<string | null>(null);
  const flowVisualDraftsRef = useRef<Record<string, FlowVisual>>({});
  const flowVisualSaveQueuesRef = useRef<Record<string, Promise<unknown>>>({});
  const proposedPreviewFlows = useMemo(
    () => graphPreview ? proposedFlowsForGraphPreview(graphPreview.operations) : [],
    [graphPreview]
  );
  const activeProposedFlow = graphPreview?.activeProposedFlowId
    ? proposedPreviewFlows.find((item) => item.id === graphPreview.activeProposedFlowId) ?? null
    : null;
  const flow = activeProposedFlow ?? getActiveFlow(bundle, activeFlowId);
  const activeSubflow = flow?.subflows.find((subflow) => subflow.id === activeSubflowId) ?? null;
  const runChangeBlocked = Boolean(activeProposedFlow) || Boolean(historicalInspection) || Boolean(bundle?.runs.some(isRunBlockingNewChange));

  const filteredNodes = flow ? visibleNodesForFlow(flow, activeSubflowId, searchQuery) : [];
  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : []), [selectedNodeId, selectedNodeIds]);
  const openQuestions = getOpenQuestionsForScope(bundle, activeFlowId, undefined, activeSubflowId);
  const toggleFlowIgnored = (item: Flow) => {
    if (runChangeBlocked) return;
    void saveFlow({ ...item, ignored: !item.ignored, updatedAt: new Date().toISOString() });
  };
  const commitFlowRename = (item: Flow) => {
    if (historicalInspection) return;
    const nextName = renamingFlow?.id === item.id ? renamingFlow.name.trim() : "";
    setRenamingFlow(null);
    if (nextName && nextName !== editableFlowName(item)) {
      void saveFlow(normalizeEvidenceFlow({ ...item, name: nextName, updatedAt: new Date().toISOString() }));
    }
  };
  const commitSubflowRename = (subflow: FlowSubflow) => {
    if (historicalInspection) return;
    const nextName = renamingSubflow?.id === subflow.id ? renamingSubflow.name.trim() : "";
    setRenamingSubflow(null);
    if (nextName && nextName !== subflow.name) void renameSubflow(subflow.id, nextName);
  };
  const effectiveFlowVisual = (item?: Flow | null): FlowVisual | undefined => item
    ? flowVisualDrafts[item.id] ?? item.visual
    : undefined;
  const updateFlowVisual = (item: Flow, patch: { icon?: FlowVisualIcon | null; color?: string | null }) => {
    const next: FlowVisual = { ...(flowVisualDraftsRef.current[item.id] ?? item.visual ?? {}) };
    if ("icon" in patch) {
      if (patch.icon) next.icon = patch.icon;
      else delete next.icon;
    }
    if ("color" in patch) {
      if (patch.color) next.color = patch.color;
      else delete next.color;
    }
    flowVisualDraftsRef.current[item.id] = next;
    setFlowVisualDrafts((current) => ({ ...current, [item.id]: next }));
    const persistedVisual = next.icon || next.color ? next : undefined;
    const saveRequest = (flowVisualSaveQueuesRef.current[item.id] ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        const latestFlow = useArchicodeStore.getState().bundle?.flows.find((flowItem) => flowItem.id === item.id) ?? item;
        return saveFlow({ ...latestFlow, visual: persistedVisual, updatedAt: new Date().toISOString() });
      });
    flowVisualSaveQueuesRef.current[item.id] = saveRequest;
    void saveRequest
      .catch(() => undefined)
      .finally(() => {
        if (flowVisualSaveQueuesRef.current[item.id] !== saveRequest || flowVisualDraftsRef.current[item.id] !== next) return;
        delete flowVisualSaveQueuesRef.current[item.id];
        delete flowVisualDraftsRef.current[item.id];
        setFlowVisualDrafts((current) => {
          if (current[item.id] !== next) return current;
          const remaining = { ...current };
          delete remaining[item.id];
          return remaining;
        });
      });
  };
  const selectSidebarNode = (event: MouseEvent<HTMLButtonElement>, nodeId: string) => {
    if (event.metaKey || event.ctrlKey) {
      sidebarSelectionAnchorRef.current = nodeId;
      toggleNodeSelection(nodeId);
      return;
    }
    if (!event.shiftKey) {
      sidebarSelectionAnchorRef.current = nodeId;
      selectNode(nodeId);
      return;
    }
    const nodeIds = filteredNodes.map((node) => node.id);
    const targetIndex = nodeIds.indexOf(nodeId);
    const anchorId = sidebarSelectionAnchorRef.current && nodeIds.includes(sidebarSelectionAnchorRef.current)
      ? sidebarSelectionAnchorRef.current
      : selectedNodeId && nodeIds.includes(selectedNodeId)
        ? selectedNodeId
        : selectedNodeIds.find((selectedId) => nodeIds.includes(selectedId)) ?? null;
    const anchorIndex = anchorId ? nodeIds.indexOf(anchorId) : -1;
    if (targetIndex < 0 || anchorIndex < 0) {
      sidebarSelectionAnchorRef.current = nodeId;
      selectNode(nodeId);
      return;
    }
    const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    selectNodes(nodeIds.slice(start, end + 1), nodeId);
  };
  const centerSidebarNodeOnCanvas = (nodeId: string) => {
    if (!flow) return;
    navigateToGraphTarget({ kind: "node", flowId: flow.id, nodeId });
  };

  useEffect(() => {
    const focusSidebarSearch = (event: KeyboardEvent) => {
      const chord = keybindings["project.focusSidebarSearch"];
      if (!chord || !chordMatches(chord, event)) return;
      event.preventDefault();
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", focusSidebarSearch);
    return () => window.removeEventListener("keydown", focusSidebarSearch);
  }, [keybindings]);
  const dropSubflow = (parentSubflowId: string | null) => {
    if (!draggingSubflowId) return;
    void reparentSubflow(draggingSubflowId, parentSubflowId);
    setDraggingSubflowId(null);
  };
  const copyRootPath = async () => {
    if (!rootPath) return;
    try {
      if (window.archicode?.copyTextToClipboard) {
        window.archicode.copyTextToClipboard(rootPath);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(rootPath);
      } else {
        throw new Error("Clipboard API is unavailable.");
      }
      setPathCopyFailed(false);
      setPathCopied(true);
      window.setTimeout(() => setPathCopied(false), 1200);
    } catch (error) {
      console.error("Failed to copy project path.", error);
      setPathCopied(false);
      setPathCopyFailed(true);
      window.setTimeout(() => setPathCopyFailed(false), 1600);
    }
  };
  const recentProjectOptions = recentProjects.filter((project) => project.rootPath !== rootPath);
  const activeScopeLabel = activeSubflow ? activeSubflow.name : flow ? flowDisplayName(flow) : "No flow";
  const flowTreeItems = [
    ...(bundle?.flows ?? []),
    ...proposedPreviewFlows.filter((proposed) => !bundle?.flows.some((persisted) => persisted.id === proposed.id))
  ];
  const normalizedFlowSearchQuery = flowSearchQuery.trim().toLowerCase();
  const renderFlowIdentityPicker = (item: Flow): ReactNode => {
    const visual = effectiveFlowVisual(item);
    const CurrentIcon = flowIconComponent(visual?.icon);
    return (
      <PopoverRoot>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flow-icon-trigger"
            style={visual?.color ? { color: visual.color } : undefined}
            aria-label={t("Customize icon and color for {{value1}}", { value1: flowDisplayName(item) })}
            title={runChangeBlocked ? t("A run is active, so flow appearance cannot be changed.") : t("Customize flow icon and color")}
            disabled={runChangeBlocked}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <CurrentIcon size={16} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="flow-identity-popover"
          align="start"
          side="right"
          sideOffset={8}
          collisionPadding={10}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flow-identity-section">
            <span>{t("Icon")}</span>
            <div className="flow-icon-grid" aria-label={t("Icon for {{value1}}", { value1: flowDisplayName(item) })}>
              <button
                type="button"
                className={!visual?.icon ? "is-active" : ""}
                aria-label={t("Use default flow icon")}
                title={t("Default")}
                onClick={() => updateFlowVisual(item, { icon: null })}
              >
                <GitBranch size={17} />
              </button>
              {flowIconOptions.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  className={visual?.icon === value ? "is-active" : ""}
                  aria-label={t("Use {{label}} flow icon", { label: label })}
                  title={label}
                  onClick={() => updateFlowVisual(item, { icon: value })}
                >
                  <Icon size={17} />
                </button>
              ))}
            </div>
          </div>
          <div className="flow-identity-section">
            <span>{t("Color")}</span>
            <div className="flow-color-grid" aria-label={t("Icon color for {{value1}}", { value1: flowDisplayName(item) })}>
              <button
                type="button"
                className={!visual?.color ? "flow-color-default is-active" : "flow-color-default"}
                aria-label={t("Use default flow icon color")}
                title={t("Default color")}
                onClick={() => updateFlowVisual(item, { color: null })}
              >
                <span />
              </button>
              {flowIconColors.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={visual?.color === color ? "is-active" : ""}
                  style={{ backgroundColor: color }}
                  aria-label={t("Use {{color}} flow icon color", { color: color })}
                  title={color}
                  onClick={() => updateFlowVisual(item, { color })}
                />
              ))}
              <label className="flow-color-custom" title={t("Choose a custom color")}>
                <input
                  type="color"
                  value={visual?.color ?? "#7bc6d5"}
                  aria-label={t("Choose a custom flow icon color")}
                  onChange={(event) => updateFlowVisual(item, { color: event.target.value })}
                />
                <span>{t("Custom")}</span>
              </label>
            </div>
          </div>
        </PopoverContent>
      </PopoverRoot>
    );
  };
  const renderSubflowRows = (item: Flow, parentSubflowId: string | null = null, depth = 0): ReactNode => {
    const children = childSubflowsForFlow(item, parentSubflowId)
      .filter((subflow) => subflowMatchesFlowSearch(item, subflow, normalizedFlowSearchQuery))
      .sort(compareSiblingSubflows);
    if (!children.length) return null;
    return (
      <div className={parentSubflowId ? "subflow-tree-children" : "flow-tree-children"}>
        {children.map((subflow) => {
          const nodeCount = item.nodes.filter((node) => node.subflowId === subflow.id).length;
          const subflowIgnored = isSubflowIgnored(item, subflow.id);
          return (
            <div key={subflow.id} className={subflowIgnored ? "subflow-tree-item is-ignored" : "subflow-tree-item"}>
              <div className="subflow-list-row">
                {renamingSubflow?.id === subflow.id ? (
                  <label className="subflow-rename-row">
                    <GitBranch size={15} />
                    <input
                      className="ui-input subflow-rename-input"
                      value={renamingSubflow.name}
                      autoFocus
                      onChange={(event) => setRenamingSubflow({ id: subflow.id, name: event.target.value })}
                      onBlur={() => commitSubflowRename(subflow)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitSubflowRename(subflow);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setRenamingSubflow(null);
                        }
                      }}
                    />
                    <small>{nodeCount}</small>
                  </label>
                ) : (
                  <button
                    className={[
                      subflow.id === activeSubflowId ? "nav-row subflow-nav-row is-active" : "nav-row subflow-nav-row",
                      `subflow-depth-${Math.min(depth, 5)}`,
                      draggingSubflowId === subflow.id ? "is-dragging" : ""
                    ].filter(Boolean).join(" ")}
                    type="button"
                    draggable={!historicalInspection}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/x-archicode-subflow", subflow.id);
                      event.dataTransfer.effectAllowed = "move";
                      setDraggingSubflowId(subflow.id);
                    }}
                    onDragEnd={() => setDraggingSubflowId(null)}
                    onDragOver={(event) => {
                      if (!draggingSubflowId || draggingSubflowId === subflow.id) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggingSubflowId !== subflow.id) dropSubflow(subflow.id);
                    }}
                    onClick={() => setActiveSubflow(subflow.id)}
                    onDoubleClick={() => { if (!historicalInspection) setRenamingSubflow({ id: subflow.id, name: subflow.name }); }}
                    title={subflowLinkedTitle(item, subflow) ?? t("Drag to nest, double-click to rename")}
                  >
                    <GitBranch size={15} />
                    <span>{subflow.name}</span>
                    <small>{subflowIgnored ? t("ignored") : nodeCount}</small>
                  </button>
                )}
                <div className="subflow-actions">
                  <IconButton
                    title={subflow.ignored ? t("Restore subflow to agent working set") : subflowIgnored ? t("Parent subflow is ignored") : t("Ignore subflow for agents")}
                    disabled={runChangeBlocked || (subflowIgnored && !subflow.ignored)}
                    onClick={() => void toggleSubflowIgnored(subflow.id)}
                  >
                    {subflow.ignored ? <Eye size={14} /> : <EyeOff size={14} />}
                  </IconButton>
                  <IconButton
                    title={t("Delete {{name}}", { name: subflow.name })}
                    onClick={() => {
                      if (window.confirm(`Delete "${subflow.name}"? Nodes and child detail flows will move up one level.`)) {
                        void deleteSubflow(subflow.id);
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
              {renderSubflowRows(item, subflow.id, depth + 1)}
            </div>
          );
        })}
      </div>
    );
  };
  const renderFlowTree = () => (
    <div className="flow-tree">
      {flowTreeItems
        .slice()
        .sort(compareTopLevelFlows)
        .filter((item) => {
          if (!normalizedFlowSearchQuery) return true;
          if (flowDisplayName(item).toLowerCase().includes(normalizedFlowSearchQuery)) return true;
          return childSubflowsForFlow(item, null).some((subflow) => subflowMatchesFlowSearch(item, subflow, normalizedFlowSearchQuery));
        })
        .map((item) => {
        const isProposedFlow = proposedPreviewFlows.some((proposed) => proposed.id === item.id);
        const isActiveFlow = item.id === (graphPreview?.activeProposedFlowId ?? activeFlowId);
        const topLevelCount = item.nodes.filter((node) => !node.subflowId).length;
        return (
          <div key={item.id} className={[
            "flow-tree-item",
            item.ignored ? "is-ignored" : "",
            isProposedFlow ? "is-proposed" : ""
          ].filter(Boolean).join(" ")}>
            <div className="flow-root-entry">
              {!isProposedFlow && renamingFlow?.id === item.id ? (
                <label className="flow-rename-row">
                  <FlowIdentityIcon visual={effectiveFlowVisual(item)} size={15} />
                  <input
                    className="ui-input flow-rename-input"
                    aria-label={t("Rename {{value1}}", { value1: flowDisplayName(item) })}
                    value={renamingFlow.name}
                    autoFocus
                    onChange={(event) => setRenamingFlow({ id: item.id, name: event.target.value })}
                    onBlur={() => commitFlowRename(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitFlowRename(item);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setRenamingFlow(null);
                      }
                    }}
                  />
                  <small>{topLevelCount}</small>
                </label>
              ) : (
                <div
                  className={isActiveFlow && !activeSubflowId ? "nav-row flow-root-row is-active" : "nav-row flow-root-row"}
                  role="button"
                  tabIndex={0}
                  onDragOver={(event) => {
                    if (isProposedFlow || !draggingSubflowId) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    if (isProposedFlow) return;
                    event.preventDefault();
                    dropSubflow(null);
                  }}
                  onClick={() => {
                    if (isProposedFlow) setGraphPreviewFlow(item.id);
                    else {
                      setGraphPreviewFlow(null);
                      setActiveFlow(item.id);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    if (isProposedFlow) setGraphPreviewFlow(item.id);
                    else {
                      setGraphPreviewFlow(null);
                      setActiveFlow(item.id);
                    }
                  }}
                  onDoubleClick={() => { if (!isProposedFlow && !historicalInspection) setRenamingFlow({ id: item.id, name: editableFlowName(item) }); }}
                  title={isProposedFlow
                    ? t("Preview this proposed flow. It has not been added to the project yet.")
                    : item.perspective
                    ? `${item.perspective.question} Confidence: ${item.perspective.confidence}. Double-click to rename.`
                    : t("Show this flow's top-level nodes. Drop a subflow here to move it to top level. Double-click to rename.")}
                >
                  {isProposedFlow ? <FlowIdentityIcon visual={item.visual} size={16} /> : renderFlowIdentityPicker(item)}
                  <span className="flow-name-stack">
                    <span>{flowDisplayName(item)}</span>
                    {isProposedFlow
                      ? <em>{t("Proposed · preview only")}</em>
                      : item.perspective
                        ? <em>{t("{{value1}} · {{confidence}}", { value1: perspectiveLabel(item), confidence: item.perspective.confidence })}</em>
                        : null}
                  </span>
                  <small>{item.ignored ? t("ignored") : topLevelCount}</small>
                </div>
              )}
              {isProposedFlow ? (
                <span className="flow-proposed-badge">{t("Preview")}</span>
              ) : (
                <IconButton
                  className="flow-ignore-toggle"
                  title={item.ignored ? t("Restore flow to agent working set") : t("Ignore flow for agents")}
                  disabled={runChangeBlocked}
                  onClick={() => toggleFlowIgnored(item)}
                >
                  {item.ignored ? <Eye size={15} /> : <EyeOff size={15} />}
                </IconButton>
              )}
            </div>
            {isActiveFlow && !isProposedFlow ? (
              <>
                {renderSubflowRows(item)}
                <Button
                  type="button"
                  size="sm"
                  className="structure-add-subflow"
                  title={runChangeBlocked ? t("A run is already active or waiting for review.") : t("Add subflow")}
                  disabled={runChangeBlocked}
                  onClick={createSubflow}
                >
                  <Plus size={14} />
                  <span>{t("Subflow")}</span>
                </Button>
              </>
            ) : null}
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        className="structure-add-flow"
        title={runChangeBlocked ? t("A run is already active or waiting for review.") : t("Add top-level flow")}
        disabled={runChangeBlocked}
        onClick={() => void createFlow()}
      >
        <Plus size={14} />
        <span>{t("Flow")}</span>
      </Button>
    </div>
  );

  return (
    <aside className="project-sidebar" aria-label={t("Project navigation")}>
      <div className="brand-row">
        <Boxes size={24} />
        <div className="brand-title">
          <h1>{t("ArchiCode")}</h1>
        </div>
        {panelAction}
      </div>
      {historicalInspection ? (
        <div className="sidebar-historical-label"><History size={14} /> {" "}{t("Flows at")}{" "}{historicalInspection.entry.shortCommit}</div>
      ) : null}

      <div className="project-switcher">
        <ProjectBriefing />
        <MenuRoot>
          <MenuTrigger asChild>
            <IconButton title={t("Project menu")} className="project-menu-button">
              <MoreHorizontal size={16} />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuSub>
              <MenuSubTrigger>
                <Plus size={15} />
                <span>{t("New project")}</span>
              </MenuSubTrigger>
              <MenuSubContent>
                <MenuItem disabled={!onOpenProjectLauncher} onSelect={onOpenProjectLauncher}>
                  <span className="menu-item-stack">
                    <strong>{t("Open project launcher")}</strong>
                    <small>{t("Open a folder, clone from Git, or choose a template.")}</small>
                  </span>
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>{t("Start from template")}</MenuLabel>
                {projectTemplates.map((template) => (
                  <MenuItem
                    key={template.id}
                    onSelect={() => void createProjectFromTemplate(template.id as ProjectTemplateId)}
                  >
                    <span className="menu-item-stack">
                      <strong>{template.name}</strong>
                      <small>{template.description}</small>
                    </span>
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
            <MenuSeparator />
            <MenuLabel>{t("Current project")}</MenuLabel>
            <MenuItem disabled={!rootPath} onSelect={() => void revealProjectFolder()}>
              <span className="menu-item-stack" title={rootPath}>
                <strong>{bundle?.project.name ?? t("No project selected")}</strong>
                <small>{rootPath || t("Open a folder to begin.")}</small>
              </span>
            </MenuItem>
            <MenuItem disabled={!rootPath} onSelect={() => void copyRootPath()}>
              {pathCopied ? <Check size={15} /> : <Copy size={15} />}
              {pathCopyFailed ? t("Could not copy path") : pathCopied ? t("Copied path") : t("Copy path")}
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>{t("Open project")}</MenuLabel>
            <MenuItem onSelect={() => void openProjectFolder()}>
              <span className="menu-item-stack">
                <strong>{t("Choose Folder...")}</strong>
                <small>{t("Pick any local folder to open in ArchiCode.")}</small>
              </span>
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>{t("Recent")}</MenuLabel>
            {recentProjectOptions.length ? recentProjectOptions.map((project) => (
              <MenuItem key={project.rootPath} onSelect={() => void openRecentProject(project.rootPath)}>
                <span className="menu-item-stack" title={project.rootPath}>
                  <strong>{project.name}</strong>
                  <small>{project.rootPath}</small>
                </span>
              </MenuItem>
            )) : (
              <MenuItem disabled>
                <span className="menu-item-stack">
                  <strong>{t("No recent projects yet")}</strong>
                  <small>{t("Opened projects will show up here.")}</small>
                </span>
              </MenuItem>
            )}
          </MenuContent>
        </MenuRoot>
      </div>

      <section className="sidebar-scope-section">
        <button
          type="button"
          className={flowsExpanded ? "sidebar-scope-trigger is-expanded" : "sidebar-scope-trigger"}
          aria-expanded={flowsExpanded}
          onClick={() => setFlowsExpanded((expanded) => !expanded)}
        >
          <FlowIdentityIcon visual={effectiveFlowVisual(flow)} size={15} />
          <span>
            <strong>{activeScopeLabel}</strong>
            <small>{activeProposedFlow
              ? t("Proposed preview · not yet applied")
              : activeSubflow
                ? flow?.name
                : flow?.perspective
                  ? t("{{value1}} · {{confidence}}", { value1: perspectiveLabel(flow), confidence: flow.perspective.confidence })
                  : t("Current scope")}</small>
          </span>
          <ChevronDown size={15} />
        </button>
        {flowsExpanded ? (
          <div className="sidebar-scope-body">
            {!bundle ? <EmptyState title={t("No project open")}>{t("Create a project or open an existing folder.")}</EmptyState> : (
              <>
                <label className="search-row scope-search-row">
                  <Search size={15} />
                  <TextInput
                    value={flowSearchQuery}
                    placeholder={t("Search flows and subflows")}
                    onChange={(event) => setFlowSearchQuery(event.target.value)}
                  />
                </label>
                {renderFlowTree()}
                {normalizedFlowSearchQuery && !flowTreeItems.some((item) => {
                  if (item.name.toLowerCase().includes(normalizedFlowSearchQuery)) return true;
                  return childSubflowsForFlow(item, null).some((subflow) => subflowMatchesFlowSearch(item, subflow, normalizedFlowSearchQuery));
                }) ? (
                  <EmptyState title={t("No flows found")}>{t("Try a different search.")}</EmptyState>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </section>

      <div className="sidebar-tabs">
        <ScrollArea className="sidebar-scroll">
            {openQuestions.length ? (
              <CommandGroup title={t("Needs Reply")}>
                <div className="node-list compact">
                  {openQuestions.map((question) => (
                    <button
                      key={question.noteId}
                      className={question.nodeId === selectedNodeId ? "node-list-row is-active" : "node-list-row"}
                      type="button"
                      onClick={() => selectNode(question.nodeId)}
                    >
                      <span>
                        <strong>{question.nodeTitle}</strong>
                        <small>{question.body}</small>
                      </span>
                      <Badge tone="warning">{t("Q")}</Badge>
                    </button>
                  ))}
                </div>
              </CommandGroup>
            ) : null}

            <CommandGroup>
              <label className="search-row">
                <Search size={15} />
                <TextInput
                  ref={searchInputRef}
                  value={searchQuery}
                  placeholder={t("Search current scope")}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </label>
              <div className="add-node-row">
                <Tooltip
                  content={
                    <span>{t("Adds a generic node centered on the current view. Customize its type and details after creating. Examples you can set: {{value1}}.", { value1: builtInNodeTypes.join(", ") })}</span>
                  }
                >
                  <Button
                    type="button"
                    size="sm"
                    title={runChangeBlocked ? t("A run is already active or waiting for review.") : t("Add node")}
                    disabled={runChangeBlocked}
                    onClick={() => void addNode()}
                  >
                    <Plus size={14} />
                    <span>{t("Node")}</span>
                  </Button>
                </Tooltip>
              </div>
              <div className="node-list sidebar-node-list">
                {filteredNodes.length === 0 ? (
                  <EmptyState title={t("No nodes found")}>{t("Try a different search or add a node to this scope.")}</EmptyState>
                ) : null}
                {filteredNodes.map((node) => (
                  <button
                    key={node.id}
                    className={[
                      "node-list-row",
                      selectedNodeIdSet.has(node.id) ? "is-active" : "",
                      node.ignored ? "is-ignored" : "",
                      node.visual.backgroundColor ? "has-custom-color" : ""
                    ].filter(Boolean).join(" ")}
                    style={node.visual.backgroundColor ? { "--node-list-accent": node.visual.backgroundColor } as CSSProperties : undefined}
                    type="button"
                    onClick={(event) => selectSidebarNode(event, node.id)}
                    onDoubleClick={() => centerSidebarNodeOnCanvas(node.id)}
                    title={t("Double-click to center this node on the canvas")}
                  >
                    <span>
                      <strong>{node.title}</strong>
                      <small>{node.description}</small>
                    </span>
                    <div className="node-row-badges">
                      <Badge
                        className="node-stage-badge"
                        tone={node.ignored ? "neutral" : node.flags.includes("needs-attention") ? "warning" : node.locked ? "success" : "neutral"}
                    >
                        <span title={node.ignored ? t("Ignored by agents") : node.stage}>{node.ignored ? t("ignored") : sidebarStageLabels[node.stage]}</span>
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>
            </CommandGroup>
        </ScrollArea>
      </div>
    </aside>
  );
}
