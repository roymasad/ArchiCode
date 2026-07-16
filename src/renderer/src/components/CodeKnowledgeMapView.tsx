import { Braces, ChevronDown, ChevronRight, CircleHelp, Crosshair, Eye, EyeOff, FileCode2, RefreshCw, Search, X } from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import type { ArchicodeNode, Flow, FlowEdge } from "@shared/schema";
import { knowledgeImpact, zoomGraphAtPoint } from "@shared/knowledgeGraph";
import { Tooltip } from "./ui";
import { clampKnowledgeMapSidebarWidth, readKnowledgeMapSidebarWidth, storeKnowledgeMapSidebarWidth } from "./knowledgeMapUi";

type PositionedNode = { node: ArchicodeNode; community: string; color: string; x: number; y: number };
type CommunityMeta = { id: string; label: string; description: string; count: number };
type HoverCard = { x: number; y: number; kicker: string; title: string; detail: string };

const VIEWBOX_WIDTH = 920;
const VIEWBOX_HEIGHT = 820;
const COMMUNITY_COLORS = ["#5b9cf6", "#ff9a3d", "#ef6262", "#70c7bd", "#a987d4", "#f0ca4d", "#72bd68", "#ef8fa2", "#b99479", "#72a9d8", "#c17eb0", "#8ea765"];

function communityFor(node: ArchicodeNode): string {
  if (node.groupId) return `group:${node.groupId}`;
  if (node.subflowId) return `scope:${node.subflowId}`;
  const imported = node.customProperties?.["Dependency community"]?.trim();
  if (imported && imported !== "isolated") return `dependency:${imported}`;
  return `type:${node.type || "other"}`;
}

function edgeSearchText(edge: FlowEdge, nodeById: Map<string, ArchicodeNode>): string {
  return [edge.label, nodeById.get(edge.source)?.title, nodeById.get(edge.target)?.title, edge.evidence?.origin, ...(edge.evidence?.relationKinds ?? []), ...(edge.evidence?.locations.flatMap((location) => [location.path, location.symbol, location.fact]) ?? [])].filter(Boolean).join(" ").toLowerCase();
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortTitle(value: string): string {
  return value.length <= 34 ? value : `${value.slice(0, 31).trim()}…`;
}

export function CodeKnowledgeMapView({ flow, searchQuery, onSelectNode, onSelectEdge, onOpenSource, refreshState, onRefresh, codeDetailAvailable, onOpenCodeDetail }: {
  flow: Flow;
  searchQuery: string;
  onSelectNode: (nodeId: string | null) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onOpenSource: (path: string, line?: number) => void;
  refreshState: { status: "idle" | "refreshing" | "complete" | "failed"; label: string };
  onRefresh: () => void;
  codeDetailAvailable: boolean;
  onOpenCodeDetail: () => void;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const [communityQuery, setCommunityQuery] = useState("");
  const [hiddenCommunities, setHiddenCommunities] = useState<Set<string>>(new Set());
  const [focusedCommunityId, setFocusedCommunityId] = useState<string | null>(null);
  const [communitiesExpanded, setCommunitiesExpanded] = useState(true);
  const [showGuide, setShowGuide] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoverCard, setHoverCard] = useState<HoverCard | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [sidebarWidth, setSidebarWidth] = useState(readKnowledgeMapSidebarWidth);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const nodeById = useMemo(() => new Map(flow.nodes.map((node) => [node.id, node])), [flow.nodes]);
  const degreeByNode = useMemo(() => {
    const result = new Map<string, number>();
    for (const edge of flow.edges) {
      result.set(edge.source, (result.get(edge.source) ?? 0) + 1);
      result.set(edge.target, (result.get(edge.target) ?? 0) + 1);
    }
    return result;
  }, [flow.edges]);
  const communities = useMemo<CommunityMeta[]>(() => {
    const members = new Map<string, ArchicodeNode[]>();
    for (const node of flow.nodes) members.set(communityFor(node), [...(members.get(communityFor(node)) ?? []), node]);
    return [...members].map(([id, nodes]) => {
      if (id.startsWith("group:")) {
        const groupId = id.slice("group:".length);
        const label = flow.groups.find((group) => group.id === groupId)?.name ?? titleCase(groupId);
        return { id, label, description: "An explicit architecture group from the main canvas.", count: nodes.length };
      }
      if (id.startsWith("scope:")) {
        const scopeId = id.slice("scope:".length);
        const label = flow.subflows.find((subflow) => subflow.id === scopeId)?.name ?? titleCase(scopeId.replace(/^subflow-/, ""));
        return { id, label, description: "Concepts that belong to the same architecture detail flow.", count: nodes.length };
      }
      if (id.startsWith("dependency:")) {
        const representative = [...nodes].sort((left, right) => (degreeByNode.get(right.id) ?? 0) - (degreeByNode.get(left.id) ?? 0) || left.title.localeCompare(right.title))[0];
        const label = representative ? `Around ${shortTitle(representative.title)}` : "Related code concepts";
        return { id, label, description: `A detected relationship cluster${representative ? ` centered on ${representative.title}` : ""}.`, count: nodes.length };
      }
      const type = id.slice("type:".length);
      return { id, label: `${titleCase(type)} concepts`, description: "Concepts grouped by their architecture type because no stronger relationship cluster was available.", count: nodes.length };
    }).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  }, [degreeByNode, flow.groups, flow.nodes, flow.subflows]);
  const communityById = useMemo(() => new Map(communities.map((community) => [community.id, community])), [communities]);
  const colorByCommunity = useMemo(() => new Map(communities.map((community, index) => [community.id, COMMUNITY_COLORS[index % COMMUNITY_COLORS.length]])), [communities]);
  const positions = useMemo(() => {
    const byCommunity = new Map<string, ArchicodeNode[]>();
    for (const node of flow.nodes) byCommunity.set(communityFor(node), [...(byCommunity.get(communityFor(node)) ?? []), node]);
    const result = new Map<string, PositionedNode>();
    communities.forEach((community, communityIndex) => {
      const members = (byCommunity.get(community.id) ?? []).sort((left, right) => left.title.localeCompare(right.title));
      const orbit = communities.length === 1 ? 0 : 285;
      const communityAngle = (communityIndex / Math.max(1, communities.length)) * Math.PI * 2 - Math.PI / 2;
      const centerX = 455 + Math.cos(communityAngle) * orbit;
      const centerY = 410 + Math.sin(communityAngle) * orbit;
      members.forEach((node, index) => {
        const angle = index * 2.399963229728653;
        const radius = index === 0 ? 0 : 18 + Math.sqrt(index) * Math.min(20, 110 / Math.sqrt(Math.max(1, members.length)));
        result.set(node.id, { node, community: community.id, color: colorByCommunity.get(community.id) ?? COMMUNITY_COLORS[0], x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius });
      });
    });
    return result;
  }, [colorByCommunity, communities, flow.nodes]);
  const query = `${searchQuery} ${localQuery}`.trim().toLowerCase();
  const visibleNodeIds = useMemo(() => new Set([...positions.values()].filter((item) => !hiddenCommunities.has(item.community)).map((item) => item.node.id)), [hiddenCommunities, positions]);
  const visibleEdges = useMemo(() => flow.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)), [flow.edges, visibleNodeIds]);
  const selectedEdge = flow.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedNode = flow.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedNodeCommunity = selectedNode ? communityFor(selectedNode) : null;
  const focusedCommunity = focusedCommunityId ?? selectedNodeCommunity;
  const focusedCommunityMeta = focusedCommunity ? communityById.get(focusedCommunity) : null;
  const selectedImpact = useMemo(() => selectedNodeId ? knowledgeImpact(flow, selectedNodeId, 64) : null, [flow, selectedNodeId]);
  const neighborIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    return new Set(flow.edges.flatMap((edge) => edge.source === selectedNodeId ? [edge.target] : edge.target === selectedNodeId ? [edge.source] : []));
  }, [flow.edges, selectedNodeId]);
  const matchingNodeIds = useMemo(() => new Set([...positions.values()].filter((item) => !query || [item.node.title, item.node.description, item.node.type, communityById.get(item.community)?.label, communityById.get(item.community)?.description, ...Object.values(item.node.customProperties ?? {})].filter(Boolean).join(" ").toLowerCase().includes(query)).map((item) => item.node.id)), [communityById, positions, query]);
  const matchingEdgeIds = useMemo(() => new Set(flow.edges.filter((edge) => !query || edgeSearchText(edge, nodeById).includes(query)).map((edge) => edge.id)), [flow.edges, nodeById, query]);
  const filteredCommunities = communities.filter((community) => !communityQuery.trim() || `${community.label} ${community.description}`.toLowerCase().includes(communityQuery.trim().toLowerCase()));
  const directRelationships = selectedNodeId ? flow.edges.filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId).length : 0;

  const clearSelection = () => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setFocusedCommunityId(null);
    onSelectNode(null);
    onSelectEdge(null);
  };
  const toggleCommunityVisibility = (community: string) => {
    const hiding = !hiddenCommunities.has(community);
    setHiddenCommunities((current) => {
      const next = new Set(current);
      if (next.has(community)) next.delete(community); else next.add(community);
      return next;
    });
    if (hiding && focusedCommunity === community) clearSelection();
  };
  const focusCommunity = (community: string) => {
    setHiddenCommunities((current) => { const next = new Set(current); next.delete(community); return next; });
    setFocusedCommunityId((current) => current === community ? null : community);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setShowGuide(false);
    onSelectNode(null);
    onSelectEdge(null);
  };
  const showAllCommunities = () => {
    setHiddenCommunities(new Set());
    clearSelection();
  };
  const hideAllCommunities = () => {
    setHiddenCommunities(new Set(communities.map((community) => community.id)));
    clearSelection();
  };
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
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const adjustSidebarWidth = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") { event.preventDefault(); resizeSidebar(sidebarWidth + step); }
    if (event.key === "ArrowRight") { event.preventDefault(); resizeSidebar(sidebarWidth - step); }
  };
  const updateHover = (event: ReactPointerEvent<SVGElement>, card: Omit<HoverCard, "x" | "y">) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHoverCard({ ...card, x: Math.min(rect.width - 250, event.clientX - rect.left + 14), y: Math.min(rect.height - 90, event.clientY - rect.top + 14) });
  };
  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: transform.x, originY: transform.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setTransform((current) => ({ ...current, x: drag.originX + (event.clientX - drag.x) * VIEWBOX_WIDTH / rect.width, y: drag.originY + (event.clientY - drag.y) * VIEWBOX_HEIGHT / rect.height }));
  };
  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => { if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null; };
  const handleWheel = (event: WheelEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = (event.clientX - rect.left) * VIEWBOX_WIDTH / rect.width;
    const pointerY = (event.clientY - rect.top) * VIEWBOX_HEIGHT / rect.height;
    setTransform((current) => zoomGraphAtPoint(current, { x: pointerX, y: pointerY }, event.deltaY > 0 ? .9 : 1.1, { min: .35, max: 3 }));
  };

  return <div ref={rootRef} className="knowledge-map-view" aria-label={`Architecture lens map for ${flow.name}`} style={{ "--knowledge-map-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    <div className="knowledge-map-toolbar">
      <div><strong>Architecture Lens Map</strong><small>{flow.name} · {flow.nodes.length} concepts · {flow.edges.length} relationships · {communities.length} communities</small></div>
      <label><Search size={15} /><input value={localQuery} onChange={(event) => setLocalQuery(event.target.value)} placeholder="Search concepts, communities, relationships, or source paths…" />{localQuery ? <button type="button" onClick={() => setLocalQuery("")} aria-label="Clear knowledge map search"><X size={14} /></button> : null}</label>
      <Tooltip content="Explain dots, lines, colors, highlighting, and search."><button type="button" className={`knowledge-map-reset${showGuide ? " is-active" : ""}`} aria-label="Explain this map" aria-pressed={showGuide} onClick={() => setShowGuide((current) => !current)}><CircleHelp size={15} /></button></Tooltip>
      <Tooltip content="Return to the complete map at its default zoom."><button type="button" className="knowledge-map-reset" aria-label="Center and reset zoom" onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}><Crosshair size={15} /></button></Tooltip>
      <Tooltip content="Re-scan local source and verify whether imported relationships are still supported."><button type="button" className="knowledge-map-reset" aria-label="Refresh relationship evidence" disabled={refreshState.status === "refreshing"} onClick={onRefresh}><RefreshCw size={15} className={refreshState.status === "refreshing" ? "is-spinning" : ""} /></button></Tooltip>
      <Tooltip content={codeDetailAvailable ? "Open the project-wide file, symbol, import, call, and runtime knowledge map." : "Refresh evidence first to build the project-wide code knowledge map."}><button type="button" className="knowledge-map-reset" disabled={!codeDetailAvailable} aria-label="Open project-wide code knowledge map" onClick={onOpenCodeDetail}><Braces size={15} /></button></Tooltip>
    </div>
    <div className="knowledge-map-search-summary">{query ? `${matchingNodeIds.size} concepts and ${matchingEdgeIds.size} relationships match` : "Search includes concept names, descriptions, community names, relationship types, and source evidence."}</div>
    {refreshState.label ? <div className={`knowledge-map-refresh-status is-${refreshState.status}`}>{refreshState.label}</div> : null}
    <svg className="knowledge-map-graph" viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`} onClick={(event) => { if (event.target === event.currentTarget) clearSelection(); }} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onWheel={handleWheel}>
      <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
        {visibleEdges.map((edge) => {
          const source = positions.get(edge.source); const target = positions.get(edge.target); if (!source || !target) return null;
          const connected = Boolean(selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId));
          const insideCommunity = Boolean(focusedCommunity && source.community === focusedCommunity && target.community === focusedCommunity);
          const searchDimmed = Boolean(query && !matchingEdgeIds.has(edge.id) && !matchingNodeIds.has(edge.source) && !matchingNodeIds.has(edge.target));
          const focusDimmed = Boolean(focusedCommunity && !insideCommunity && !connected);
          return <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} className={`knowledge-map-edge origin-${edge.evidence?.origin ?? "unknown"}${edge.id === selectedEdgeId ? " is-selected" : ""}${connected ? " is-connected" : ""}${insideCommunity ? " is-community-edge" : ""}${searchDimmed ? " is-dimmed" : ""}${focusDimmed ? " is-focus-dimmed" : ""}`} onPointerEnter={(event) => updateHover(event, { kicker: "Relationship", title: edge.label || "Connected concepts", detail: `${source.node.title} → ${target.node.title}` })} onPointerMove={(event) => updateHover(event, { kicker: "Relationship", title: edge.label || "Connected concepts", detail: `${source.node.title} → ${target.node.title}` })} onPointerLeave={() => setHoverCard(null)} onClick={(event) => { event.stopPropagation(); setSelectedEdgeId(edge.id); setSelectedNodeId(null); setFocusedCommunityId(null); onSelectNode(null); onSelectEdge(edge.id); }} />;
        })}
        {[...positions.values()].filter((item) => visibleNodeIds.has(item.node.id)).map((item) => {
          const matches = matchingNodeIds.has(item.node.id);
          const selected = item.node.id === selectedNodeId;
          const communityPeer = Boolean(focusedCommunity && item.community === focusedCommunity);
          const neighbor = neighborIds.has(item.node.id);
          const searchDimmed = Boolean(query && !matches);
          const focusDimmed = Boolean(focusedCommunity && !communityPeer && !neighbor);
          const communityLabel = communityById.get(item.community)?.label ?? "Other concepts";
          return <g key={item.node.id} className={`knowledge-map-node${selected ? " is-selected" : ""}${communityPeer && !selected ? " is-community-peer" : ""}${neighbor ? " is-neighbor" : ""}${searchDimmed ? " is-dimmed" : ""}${focusDimmed ? " is-focus-dimmed" : ""}`} transform={`translate(${item.x} ${item.y})`} onPointerEnter={(event) => { setHoveredNodeId(item.node.id); updateHover(event, { kicker: item.node.type || "Concept", title: item.node.title, detail: communityLabel }); }} onPointerMove={(event) => updateHover(event, { kicker: item.node.type || "Concept", title: item.node.title, detail: communityLabel })} onPointerLeave={() => { setHoveredNodeId(null); setHoverCard(null); }} onClick={(event) => { event.stopPropagation(); setSelectedNodeId(item.node.id); setSelectedEdgeId(null); setFocusedCommunityId(item.community); setShowGuide(false); onSelectEdge(null); onSelectNode(item.node.id); }}>
            <circle r={selected ? 8 : 5} fill={item.color} />
            {(selected || hoveredNodeId === item.node.id || (matches && query)) ? <text x="10" y="4">{item.node.title}</text> : null}
          </g>;
        })}
      </g>
    </svg>
    {hoverCard ? <div className="knowledge-map-hover-card" style={{ left: hoverCard.x, top: hoverCard.y }}><span>{hoverCard.kicker}</span><strong>{hoverCard.title}</strong><small>{hoverCard.detail}</small></div> : null}
    <div className="knowledge-map-sidebar-resizer" role="separator" aria-label="Resize knowledge map sidebar" aria-orientation="vertical" tabIndex={0} onPointerDown={startSidebarResize} onKeyDown={adjustSidebarWidth} />
    <aside className="knowledge-map-sidebar">
      {selectedNode ? <section className="knowledge-map-detail knowledge-map-primary-detail"><span className="knowledge-map-kicker">Concept</span><h3>{selectedNode.title}</h3><p>{selectedNode.description || "No concept description has been added yet."}</p><small>{selectedNode.type} · {focusedCommunityMeta?.label ?? "Other concepts"}</small><small><strong>{directRelationships}</strong> directly connected relationships are highlighted; the rest of this community has a colored halo.</small>{selectedImpact ? <small>{Math.max(0, selectedImpact.nodeIds.length - 1)} potential dependents{selectedImpact.truncated ? " (bounded preview)" : ""}.</small> : null}</section> : null}
      {!selectedNode && !selectedEdge && focusedCommunityMeta ? <section className="knowledge-map-detail knowledge-map-primary-detail"><span className="knowledge-map-kicker">Community focus</span><h3>{focusedCommunityMeta.label}</h3><p>{focusedCommunityMeta.description}</p><small>{focusedCommunityMeta.count} concepts highlighted; other visible communities are softened.</small></section> : null}
      {selectedEdge ? <section className="knowledge-map-detail knowledge-map-primary-detail"><span className="knowledge-map-kicker">Relationship evidence</span><h3>{selectedEdge.label || "Relationship"}</h3><p>{nodeById.get(selectedEdge.source)?.title} → {nodeById.get(selectedEdge.target)?.title}</p><div className="knowledge-map-evidence-badges"><span>{selectedEdge.evidence?.origin ?? "unverified"}</span><span>{Math.round((selectedEdge.evidence?.confidence ?? 0) * 100)}%</span><span>{selectedEdge.evidence?.verification ?? "unresolved"}</span><span>{selectedEdge.evidence?.freshness ?? "unknown"}</span></div>{selectedEdge.evidence?.relationKinds.length ? <p>{selectedEdge.evidence.relationKinds.join(" · ")}</p> : null}{selectedEdge.evidence?.locations.map((location, index) => <button type="button" className="knowledge-map-source" key={`${location.path}:${location.line ?? index}`} onClick={() => onOpenSource(location.path, location.line)}><FileCode2 size={14} /><span>{location.path}{location.line ? `:${location.line}` : ""}</span></button>)}</section> : null}
      {(showGuide || (!selectedNode && !selectedEdge && !focusedCommunity)) ? <section className="knowledge-map-guide"><span className="knowledge-map-kicker">How to read this lens</span><h3>Architecture concepts in the selected perspective</h3><p><strong>Dots</strong> are architecture concepts in <strong>{flow.name}</strong>. <strong>Lines</strong> are relationships. <strong>Colors</strong> group concepts that belong together.</p><ul><li>Changing the top-level flow changes this architecture lens.</li><li>Hover for a name; select for its full description.</li><li>Solid lines are extracted or resolved; dashed lines are inferred.</li><li>Open Code Knowledge Map for project-wide files, symbols, imports, calls, and runtime links.</li></ul></section> : null}
      <section className="knowledge-map-communities"><button type="button" className="knowledge-map-section-toggle" aria-expanded={communitiesExpanded} onClick={() => setCommunitiesExpanded((current) => !current)}>{communitiesExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span><strong>Communities</strong><small>Eye controls visibility; name focuses a community</small></span></button>{communitiesExpanded ? <><label className="knowledge-map-community-search"><Search size={13} /><input value={communityQuery} onChange={(event) => setCommunityQuery(event.target.value)} placeholder="Search communities…" />{communityQuery ? <button type="button" aria-label="Clear community search" onClick={() => setCommunityQuery("")}><X size={12} /></button> : null}</label><div className="knowledge-map-filter-actions"><button type="button" onClick={showAllCommunities}>Show all</button><button type="button" onClick={hideAllCommunities}>Hide all</button></div><div className="knowledge-map-community-list">{filteredCommunities.map((community) => { const visible = !hiddenCommunities.has(community.id); const focused = community.id === focusedCommunity; return <div key={community.id} className={`knowledge-map-community-row${focused ? " is-selected-community" : ""}${visible ? "" : " is-hidden-community"}`}><Tooltip content={`${visible ? "Hide" : "Show"} ${community.label}`}><button type="button" className="knowledge-map-community-eye" aria-label={`${visible ? "Hide" : "Show"} community ${community.label}`} aria-pressed={visible} onClick={() => toggleCommunityVisibility(community.id)}>{visible ? <Eye size={13} /> : <EyeOff size={13} />}</button></Tooltip><span className="knowledge-map-community-color" style={{ backgroundColor: colorByCommunity.get(community.id) }} /><Tooltip content={community.description}><button type="button" className="knowledge-map-community-name" aria-label={`Focus community ${community.label}`} aria-pressed={focused} onClick={() => focusCommunity(community.id)}><strong>{community.label}</strong><small>{community.count}</small></button></Tooltip></div>; })}</div></> : null}</section>
    </aside>
  </div>;
}
