const KNOWLEDGE_MAP_SIDEBAR_WIDTH_KEY = "archicode.knowledge-map-sidebar-width.v1";

export const KNOWLEDGE_MAP_SIDEBAR_MIN_WIDTH = 260;
export const KNOWLEDGE_MAP_SIDEBAR_MAX_WIDTH = 520;
export const KNOWLEDGE_MAP_SIDEBAR_DEFAULT_WIDTH = 304;

export function clampKnowledgeMapSidebarWidth(width: number): number {
  return Math.min(KNOWLEDGE_MAP_SIDEBAR_MAX_WIDTH, Math.max(KNOWLEDGE_MAP_SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function readKnowledgeMapSidebarWidth(): number {
  if (typeof window === "undefined") return KNOWLEDGE_MAP_SIDEBAR_DEFAULT_WIDTH;
  const stored = Number(window.localStorage.getItem(KNOWLEDGE_MAP_SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampKnowledgeMapSidebarWidth(stored) : KNOWLEDGE_MAP_SIDEBAR_DEFAULT_WIDTH;
}

export function storeKnowledgeMapSidebarWidth(width: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KNOWLEDGE_MAP_SIDEBAR_WIDTH_KEY, String(clampKnowledgeMapSidebarWidth(width)));
}
