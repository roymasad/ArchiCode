import type { ProjectBundle } from "../../../shared/schema";

export type GraphLocation = {
  activeFlowId: string;
  activeSubflowId: string | null;
};

function graphLocationKey(rootPath: string): string {
  return `archicode-graph-location:${rootPath || "default"}`;
}

export function resolveGraphLocation(
  bundle: ProjectBundle,
  flowId?: string | null,
  subflowId?: string | null
): GraphLocation {
  const requestedFlow = bundle.flows.find((item) => item.id === flowId);
  const flow = requestedFlow
    ?? bundle.flows.find((item) => item.id === bundle.project.activeFlowId)
    ?? bundle.flows[0];
  const activeFlowId = flow?.id ?? bundle.project.activeFlowId;
  const activeSubflowId = requestedFlow && subflowId && requestedFlow.subflows.some((item) => item.id === subflowId)
    ? subflowId
    : null;
  return { activeFlowId, activeSubflowId };
}

export function readStoredGraphLocation(rootPath: string, bundle: ProjectBundle): GraphLocation {
  try {
    const saved = localStorage.getItem(graphLocationKey(rootPath));
    const parsed = JSON.parse(saved ?? "null") as Partial<GraphLocation> | null;
    if (parsed && typeof parsed === "object") {
      return resolveGraphLocation(
        bundle,
        typeof parsed.activeFlowId === "string" ? parsed.activeFlowId : null,
        typeof parsed.activeSubflowId === "string" ? parsed.activeSubflowId : null
      );
    }
  } catch {
    // Ignore corrupt renderer preferences and fall back to project metadata.
  }
  return resolveGraphLocation(bundle, bundle.project.activeFlowId, null);
}

export function storeGraphLocation(rootPath: string, flowId: string | null, subflowId: string | null): void {
  if (!rootPath || !flowId) return;
  localStorage.setItem(graphLocationKey(rootPath), JSON.stringify({
    activeFlowId: flowId,
    activeSubflowId: subflowId
  } satisfies GraphLocation));
}
