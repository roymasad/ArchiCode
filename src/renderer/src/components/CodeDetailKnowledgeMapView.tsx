import { Activity, ArrowLeft, ChevronDown, ChevronRight, CircleHelp, Crosshair, Eye, EyeOff, FileCode2, Network, RefreshCw, Route, Search, X } from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import { codeKnowledgeImpact, shortestCodeKnowledgePath, type CodeKnowledgeEdge, type CodeKnowledgeNode, type CodeKnowledgeSnapshot } from "@shared/codeKnowledge";
import { zoomGraphAtPoint } from "@shared/knowledgeGraph";
import { Tooltip } from "./ui";
import { clampKnowledgeMapSidebarWidth, readKnowledgeMapSidebarWidth, storeKnowledgeMapSidebarWidth } from "./knowledgeMapUi";

const COLORS = ["#5b9cf6", "#ff9a3d", "#ef6262", "#70c7bd", "#a987d4", "#f0ca4d", "#72bd68", "#ef8fa2", "#b99479", "#72a9d8", "#c17eb0", "#8ea765"];
const MAX_RENDERED_NODES = 1800;
const MAX_RENDERED_EDGES = 6000;
const VIEWBOX_WIDTH = 920;
const VIEWBOX_HEIGHT = 830;

type Position = { x: number; y: number; color: string; node: CodeKnowledgeNode };
type CommunityMeta = { id: string; label: string; count: number; description: string };
type HoverCard = { x: number; y: number; kicker: string; title: string; detail: string };

function edgePriority(edge: CodeKnowledgeEdge): number { return edge.kind === "runtime" ? 0 : edge.kind === "calls" ? 1 : edge.kind === "dependency" ? 2 : 3; }
function titleCase(value: string): string { return value.replace(/^subflow-/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

export function CodeDetailKnowledgeMapView({ snapshot, refreshState, onRefresh, onBack, onOpenSource, onSelectArchitectureNode }: {
  snapshot: CodeKnowledgeSnapshot;
  refreshState: { status: "idle" | "refreshing" | "complete" | "failed"; label: string };
  onRefresh: () => void;
  onBack: () => void;
  onOpenSource: (path: string, line?: number) => void;
  onSelectArchitectureNode: (nodeId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [communityQuery, setCommunityQuery] = useState("");
  const [hiddenCommunities, setHiddenCommunities] = useState<Set<string>>(new Set());
  const [focusedCommunityId, setFocusedCommunityId] = useState<string | null>(null);
  const [communitiesExpanded, setCommunitiesExpanded] = useState(true);
  const [showGuide, setShowGuide] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [impactRootId, setImpactRootId] = useState<string | null>(null);
  const [pathStartId, setPathStartId] = useState<string | null>(null);
  const [pathResult, setPathResult] = useState<{ nodeIds: string[]; edgeIds: string[] } | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoverCard, setHoverCard] = useState<HoverCard | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [sidebarWidth, setSidebarWidth] = useState(readKnowledgeMapSidebarWidth);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  const nodeById = useMemo(() => new Map(snapshot.nodes.map((node) => [node.id, node])), [snapshot.nodes]);
  const communityMeta = useMemo<CommunityMeta[]>(() => snapshot.communities.filter((community) => community.nodeCount > 0).map((community) => {
    const members = snapshot.nodes.filter((node) => node.community === community.id);
    if (/^community-\d+$/i.test(community.label) || /^community-\d+$/i.test(community.id)) {
      const degree = new Map<string, number>();
      for (const edge of snapshot.edges) { degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1); degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1); }
      const representative = [...members].sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || Number(left.kind === "symbol") - Number(right.kind === "symbol") || left.label.localeCompare(right.label))[0];
      return { id: community.id, label: representative ? `Around ${representative.label}` : "Related code", count: community.nodeCount, description: `A detected file/symbol relationship cluster${representative ? ` centered on ${representative.path}` : ""}.` };
    }
    return { id: community.id, label: titleCase(community.label), count: community.nodeCount, description: "Files and symbols assigned to the same architecture area." };
  }).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)), [snapshot.communities, snapshot.edges, snapshot.nodes]);
  const communityById = useMemo(() => new Map(communityMeta.map((community) => [community.id, community])), [communityMeta]);
  const colorByCommunity = useMemo(() => new Map(communityMeta.map((community, index) => [community.id, COLORS[index % COLORS.length]])), [communityMeta]);
  const normalizedQuery = query.trim().toLowerCase();
  const renderedNodes = useMemo(() => {
    const eligible = snapshot.nodes.filter((node) => {
      if (hiddenCommunities.has(node.community)) return false;
      if (!normalizedQuery) return true;
      const community = communityById.get(node.community);
      return [node.label, node.path, node.kind, node.symbolKind, node.language, community?.label, community?.description].filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery);
    });
    const priorityIds = new Set([selectedNodeId, impactRootId, pathStartId, ...(pathResult?.nodeIds ?? [])].filter((id): id is string => Boolean(id)));
    return [...eligible].sort((left, right) => Number(priorityIds.has(right.id)) - Number(priorityIds.has(left.id)) || Number(left.kind === "symbol") - Number(right.kind === "symbol") || left.path.localeCompare(right.path) || left.label.localeCompare(right.label)).slice(0, MAX_RENDERED_NODES);
  }, [communityById, hiddenCommunities, impactRootId, normalizedQuery, pathResult?.nodeIds, pathStartId, selectedNodeId, snapshot.nodes]);
  const renderedNodeIds = useMemo(() => new Set(renderedNodes.map((node) => node.id)), [renderedNodes]);
  const renderedEdges = useMemo(() => snapshot.edges.filter((edge) => renderedNodeIds.has(edge.source) && renderedNodeIds.has(edge.target)).sort((left, right) => edgePriority(left) - edgePriority(right) || left.id.localeCompare(right.id)).slice(0, MAX_RENDERED_EDGES), [renderedNodeIds, snapshot.edges]);
  const positions = useMemo(() => {
    const grouped = new Map<string, CodeKnowledgeNode[]>();
    for (const node of renderedNodes) grouped.set(node.community, [...(grouped.get(node.community) ?? []), node]);
    const groups = [...grouped].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));
    const result = new Map<string, Position>();
    groups.forEach(([community, members], groupIndex) => {
      const angle = (groupIndex / Math.max(1, groups.length)) * Math.PI * 2 - Math.PI / 2;
      const orbit = groups.length === 1 ? 0 : 300;
      const cx = 450 + Math.cos(angle) * orbit; const cy = 415 + Math.sin(angle) * orbit;
      members.forEach((node, index) => { const spiral = index * 2.399963229728653; const radius = index ? 14 + Math.sqrt(index) * Math.min(17, 125 / Math.sqrt(Math.max(1, members.length))) : 0; result.set(node.id, { node, color: colorByCommunity.get(community) ?? COLORS[0], x: cx + Math.cos(spiral) * radius, y: cy + Math.sin(spiral) * radius }); });
    });
    return result;
  }, [colorByCommunity, renderedNodes]);
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? snapshot.edges.find((edge) => edge.id === selectedEdgeId) ?? null : null;
  const focusedCommunity = focusedCommunityId ?? selectedNode?.community ?? null;
  const focusedCommunityMeta = focusedCommunity ? communityById.get(focusedCommunity) : null;
  const impactIds = useMemo(() => impactRootId ? codeKnowledgeImpact(snapshot, impactRootId, 300) : new Set<string>(), [impactRootId, snapshot]);
  const pathNodeIds = useMemo(() => new Set(pathResult?.nodeIds ?? []), [pathResult]);
  const pathEdgeIds = useMemo(() => new Set(pathResult?.edgeIds ?? []), [pathResult]);
  const filteredCommunities = communityMeta.filter((community) => !communityQuery.trim() || `${community.label} ${community.description}`.toLowerCase().includes(communityQuery.trim().toLowerCase()));

  const clearSelection = () => { setSelectedNodeId(null); setSelectedEdgeId(null); setFocusedCommunityId(null); };
  const selectNode = (id: string) => { setSelectedNodeId(id); setSelectedEdgeId(null); setFocusedCommunityId(nodeById.get(id)?.community ?? null); setShowGuide(false); if (pathStartId && pathStartId !== id) setPathResult(shortestCodeKnowledgePath(snapshot, pathStartId, id, 1200)); };
  const toggleCommunityVisibility = (community: string) => {
    const hiding = !hiddenCommunities.has(community);
    setHiddenCommunities((current) => { const next = new Set(current); if (next.has(community)) next.delete(community); else next.add(community); return next; });
    if (hiding && focusedCommunity === community) clearSelection();
  };
  const focusCommunity = (community: string) => {
    setHiddenCommunities((current) => { const next = new Set(current); next.delete(community); return next; });
    setFocusedCommunityId((current) => current === community ? null : community);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setShowGuide(false);
  };
  const showAllCommunities = () => { setHiddenCommunities(new Set()); clearSelection(); };
  const hideAllCommunities = () => { setHiddenCommunities(new Set(communityMeta.map((community) => community.id))); clearSelection(); };
  const resizeSidebar = (width: number) => {
    const next = clampKnowledgeMapSidebarWidth(width);
    setSidebarWidth(next);
    storeKnowledgeMapSidebarWidth(next);
  };
  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (moveEvent: PointerEvent) => resizeSidebar(startWidth + startX - moveEvent.clientX);
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const adjustSidebarWidth = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") { event.preventDefault(); resizeSidebar(sidebarWidth + step); }
    if (event.key === "ArrowRight") { event.preventDefault(); resizeSidebar(sidebarWidth - step); }
  };
  const updateHover = (event: ReactPointerEvent<SVGElement>, card: Omit<HoverCard, "x" | "y">) => { const rect = rootRef.current?.getBoundingClientRect(); if (!rect) return; setHoverCard({ ...card, x: Math.min(rect.width - 250, event.clientX - rect.left + 14), y: Math.min(rect.height - 90, event.clientY - rect.top + 14) }); };
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => { if (event.button !== 0 || event.target !== event.currentTarget) return; dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: transform.x, oy: transform.y }; event.currentTarget.setPointerCapture(event.pointerId); };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => { const drag = dragRef.current; if (!drag || drag.id !== event.pointerId) return; const rect = event.currentTarget.getBoundingClientRect(); setTransform((current) => ({ ...current, x: drag.ox + (event.clientX - drag.x) * VIEWBOX_WIDTH / rect.width, y: drag.oy + (event.clientY - drag.y) * VIEWBOX_HEIGHT / rect.height })); };
  const onWheel = (event: WheelEvent<SVGSVGElement>) => { const rect = event.currentTarget.getBoundingClientRect(); const pointerX = (event.clientX - rect.left) * VIEWBOX_WIDTH / rect.width; const pointerY = (event.clientY - rect.top) * VIEWBOX_HEIGHT / rect.height; setTransform((current) => zoomGraphAtPoint(current, { x: pointerX, y: pointerY }, event.deltaY > 0 ? .9 : 1.1, { min: .3, max: 3.2 })); };

  return <div ref={rootRef} className="knowledge-map-view code-detail-map" aria-label="Project-wide code knowledge map" style={{ "--knowledge-map-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    <div className="knowledge-map-toolbar"><div><strong>Code Knowledge Map</strong><small>Whole project · {snapshot.stats.files} files · {snapshot.stats.symbols} symbols · {snapshot.stats.dependencies} dependencies · {snapshot.stats.calls} resolved calls</small></div><label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files, symbols, languages, or communities…" />{query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear code knowledge search"><X size={14} /></button> : null}</label><Tooltip content="Explain files, symbols, relationships, quality, impact, and path tracing."><button type="button" className={`knowledge-map-reset${showGuide ? " is-active" : ""}`} aria-label="Explain this code map" aria-pressed={showGuide} onClick={() => setShowGuide((current) => !current)}><CircleHelp size={15} /></button></Tooltip><Tooltip content="Return to the complete map at its default zoom."><button type="button" className="knowledge-map-reset" aria-label="Center and reset zoom" onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}><Crosshair size={15} /></button></Tooltip><Tooltip content="Re-scan the project and rebuild local file, symbol, dependency, call, and runtime evidence."><button type="button" className="knowledge-map-reset" aria-label="Refresh code knowledge" disabled={refreshState.status === "refreshing"} onClick={onRefresh}><RefreshCw size={15} className={refreshState.status === "refreshing" ? "is-spinning" : ""} /></button></Tooltip><Tooltip content="Return to the selected architecture lens."><button type="button" className="knowledge-map-reset" aria-label="Return to architecture lens map" onClick={onBack}><ArrowLeft size={15} /></button></Tooltip></div>
    <div className="knowledge-map-search-summary">{normalizedQuery ? `${renderedNodes.length} matching files or symbols shown` : "Search matches file paths, symbol names, languages, kinds, and community names."}</div>
    {refreshState.label ? <div className={`knowledge-map-refresh-status is-${refreshState.status}`}>{refreshState.label}</div> : null}
    <svg className="knowledge-map-graph" viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`} onClick={(event) => { if (event.target === event.currentTarget) clearSelection(); }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} onWheel={onWheel}><g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
      {renderedEdges.map((edge) => { const source = positions.get(edge.source); const target = positions.get(edge.target); if (!source || !target) return null; const highlighted = pathEdgeIds.has(edge.id) || Boolean(impactRootId && impactIds.has(edge.source) && impactIds.has(edge.target)); const connected = Boolean(selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId)); const communityEdge = Boolean(focusedCommunity && source.node.community === focusedCommunity && target.node.community === focusedCommunity); const analysisDimmed = Boolean((pathResult || impactRootId) && !highlighted); const focusDimmed = Boolean(focusedCommunity && !communityEdge && !connected); return <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} className={`knowledge-map-edge kind-${edge.kind}${highlighted ? " is-highlighted" : ""}${connected ? " is-connected" : ""}${communityEdge ? " is-community-edge" : ""}${analysisDimmed ? " is-dimmed" : ""}${focusDimmed ? " is-focus-dimmed" : ""}${selectedEdgeId === edge.id ? " is-selected" : ""}`} onPointerEnter={(event) => updateHover(event, { kicker: edge.kind, title: edge.evidence.relationKinds.join(" · ") || edge.kind, detail: `${source.node.label} → ${target.node.label}` })} onPointerMove={(event) => updateHover(event, { kicker: edge.kind, title: edge.evidence.relationKinds.join(" · ") || edge.kind, detail: `${source.node.label} → ${target.node.label}` })} onPointerLeave={() => setHoverCard(null)} onClick={(event) => { event.stopPropagation(); setSelectedEdgeId(edge.id); setSelectedNodeId(null); setFocusedCommunityId(null); setShowGuide(false); }} />; })}
      {[...positions.values()].map(({ node, x, y, color }) => { const highlighted = pathNodeIds.has(node.id) || impactIds.has(node.id); const communityPeer = Boolean(focusedCommunity && node.community === focusedCommunity); const analysisDimmed = Boolean((pathResult || impactRootId) && !highlighted); const focusDimmed = Boolean(focusedCommunity && !communityPeer); const communityLabel = communityById.get(node.community)?.label ?? node.community; return <g key={node.id} transform={`translate(${x} ${y})`} className={`knowledge-map-node kind-${node.kind}${selectedNodeId === node.id ? " is-selected" : ""}${highlighted ? " is-highlighted" : ""}${communityPeer && selectedNodeId !== node.id ? " is-community-peer" : ""}${analysisDimmed ? " is-dimmed" : ""}${focusDimmed ? " is-focus-dimmed" : ""}`} onPointerEnter={(event) => { setHoveredNodeId(node.id); updateHover(event, { kicker: node.symbolKind || node.kind, title: node.label, detail: `${node.path}${node.line ? `:${node.line}` : ""} · ${communityLabel}` }); }} onPointerMove={(event) => updateHover(event, { kicker: node.symbolKind || node.kind, title: node.label, detail: `${node.path}${node.line ? `:${node.line}` : ""} · ${communityLabel}` })} onPointerLeave={() => { setHoveredNodeId(null); setHoverCard(null); }} onClick={(event) => { event.stopPropagation(); selectNode(node.id); }}><circle r={node.kind === "file" ? 5.5 : 3.2} fill={color} />{(selectedNodeId === node.id || hoveredNodeId === node.id || (normalizedQuery && node.kind === "file")) ? <text x="9" y="4">{node.label}</text> : null}</g>; })}
    </g></svg>
    {hoverCard ? <div className="knowledge-map-hover-card" style={{ left: hoverCard.x, top: hoverCard.y }}><span>{hoverCard.kicker}</span><strong>{hoverCard.title}</strong><small>{hoverCard.detail}</small></div> : null}
    <div className="knowledge-map-sidebar-resizer" role="separator" aria-label="Resize knowledge map sidebar" aria-orientation="vertical" tabIndex={0} onPointerDown={startSidebarResize} onKeyDown={adjustSidebarWidth} />
    <aside className="knowledge-map-sidebar">
      {selectedNode ? <section className="knowledge-map-detail knowledge-map-primary-detail"><span className="knowledge-map-kicker">{selectedNode.kind}{selectedNode.symbolKind ? ` · ${selectedNode.symbolKind}` : ""}</span><h3>{selectedNode.label}</h3><p>{selectedNode.path}{selectedNode.line ? `:${selectedNode.line}` : ""}</p><small>{communityById.get(selectedNode.community)?.label ?? selectedNode.community} is highlighted; connected lines show how this item participates in the code graph.</small><button type="button" className="knowledge-map-source" onClick={() => onOpenSource(selectedNode.path, selectedNode.line)}><FileCode2 size={14} /> Open source</button>{selectedNode.architectureNodeId ? <button type="button" className="knowledge-map-source" onClick={() => onSelectArchitectureNode(selectedNode.architectureNodeId!)}><Network size={14} /> Open architecture concept</button> : null}<button type="button" className="knowledge-map-source" onClick={() => { setImpactRootId(impactRootId === selectedNode.id ? null : selectedNode.id); setPathResult(null); }}><Activity size={14} /> {impactRootId === selectedNode.id ? "Clear impact" : "Show potential impact"}</button><button type="button" className="knowledge-map-source" onClick={() => { setPathStartId(pathStartId === selectedNode.id ? null : selectedNode.id); setPathResult(null); }}><Route size={14} /> {pathStartId === selectedNode.id ? "Clear path start" : pathStartId ? "Replace path start" : "Start path here"}</button>{pathStartId && pathStartId !== selectedNode.id ? <small>{pathResult ? `${pathResult.edgeIds.length} relationship path` : "No bounded path found"} from {nodeById.get(pathStartId)?.label ?? "start"}.</small> : null}</section> : null}
      {selectedEdge ? <section className="knowledge-map-detail knowledge-map-primary-detail"><span className="knowledge-map-kicker">{selectedEdge.kind}</span><h3>{selectedEdge.evidence.relationKinds.join(" · ") || selectedEdge.kind}</h3><p>{nodeById.get(selectedEdge.source)?.label} → {nodeById.get(selectedEdge.target)?.label}</p><div className="knowledge-map-evidence-badges"><span>{selectedEdge.evidence.origin}</span><span>{Math.round(selectedEdge.evidence.confidence * 100)}%</span><span>{selectedEdge.evidence.verification}</span></div>{selectedEdge.evidence.locations.map((location, index) => <button type="button" className="knowledge-map-source" key={`${location.path}:${location.line ?? index}`} onClick={() => onOpenSource(location.path, location.line)}><FileCode2 size={14} />{location.path}{location.line ? `:${location.line}` : ""}</button>)}</section> : null}
      {!selectedNode && !selectedEdge && focusedCommunityMeta ? <section className="knowledge-map-detail knowledge-map-primary-detail"><span className="knowledge-map-kicker">Community focus</span><h3>{focusedCommunityMeta.label}</h3><p>{focusedCommunityMeta.description}</p><small>{focusedCommunityMeta.count} files or symbols highlighted; other visible communities are softened.</small></section> : null}
      {(showGuide || (!selectedNode && !selectedEdge && !focusedCommunity)) ? <section className="knowledge-map-guide"><span className="knowledge-map-kicker">How to read code knowledge</span><h3>Project-wide files, symbols, and structural relationships</h3><p><strong>Larger dots</strong> are files; <strong>smaller dots</strong> are symbols. Lines represent containment, imports, resolved calls, or runtime links.</p><ul><li>This map covers the project rather than only the selected architecture lens.</li><li>Hover for identity and source path.</li><li>Select an item to open source, trace impact, or start a path.</li><li>The full snapshot remains local and agents query only bounded results.</li></ul></section> : null}
      <section className="code-detail-quality"><h3>Truth quality</h3><div><span>Import resolution</span><strong>{Math.round(snapshot.stats.resolutionRate * 100)}%</strong></div><div><span>Unresolved imports</span><strong>{snapshot.stats.unresolvedImports}</strong></div><div><span>Snapshot</span><strong>{snapshot.stats.truncated ? "bounded" : "complete"}</strong></div>{snapshot.stats.truncated ? <small>Showing a safe local cap of {snapshot.nodes.length} nodes and {snapshot.edges.length} edges.</small> : null}</section>
      <section className="knowledge-map-communities"><button type="button" className="knowledge-map-section-toggle" aria-expanded={communitiesExpanded} onClick={() => setCommunitiesExpanded((current) => !current)}>{communitiesExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span><strong>Communities</strong><small>Eye controls visibility; name focuses a community</small></span></button>{communitiesExpanded ? <><label className="knowledge-map-community-search"><Search size={13} /><input value={communityQuery} onChange={(event) => setCommunityQuery(event.target.value)} placeholder="Search communities…" />{communityQuery ? <button type="button" aria-label="Clear community search" onClick={() => setCommunityQuery("")}><X size={12} /></button> : null}</label><div className="knowledge-map-filter-actions"><button type="button" onClick={showAllCommunities}>Show all</button><button type="button" onClick={hideAllCommunities}>Hide all</button></div><div className="knowledge-map-community-list">{filteredCommunities.map((community) => { const visible = !hiddenCommunities.has(community.id); const focused = community.id === focusedCommunity; return <div key={community.id} className={`knowledge-map-community-row${focused ? " is-selected-community" : ""}${visible ? "" : " is-hidden-community"}`}><Tooltip content={`${visible ? "Hide" : "Show"} ${community.label}`}><button type="button" className="knowledge-map-community-eye" aria-label={`${visible ? "Hide" : "Show"} community ${community.label}`} aria-pressed={visible} onClick={() => toggleCommunityVisibility(community.id)}>{visible ? <Eye size={13} /> : <EyeOff size={13} />}</button></Tooltip><span className="knowledge-map-community-color" style={{ backgroundColor: colorByCommunity.get(community.id) }} /><Tooltip content={community.description}><button type="button" className="knowledge-map-community-name" aria-label={`Focus community ${community.label}`} aria-pressed={focused} onClick={() => focusCommunity(community.id)}><strong>{community.label}</strong><small>{community.count}</small></button></Tooltip></div>; })}</div></> : null}</section>
    </aside>
    <div className="code-detail-render-limit">Rendering {renderedNodes.length}/{snapshot.nodes.length} nodes · {renderedEdges.length}/{snapshot.edges.length} edges</div>
  </div>;
}
