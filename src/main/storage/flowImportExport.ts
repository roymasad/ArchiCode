import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { flowSchema, noteSchema, projectBundleSchema } from "../../shared/schema";
import type { Flow, ProjectBundle } from "../../shared/schema";
import { importDrawioPageToArchicode, parseDrawioPages, type DrawioPage } from "../drawioImport";
import { exportArchicodeScopeToDrawioXml } from "../drawioExport";
import { loadProject, touchProject } from "./projectStore";
import { exists, id, iso, projectStatePath, writeJson } from "./persistence";
import { writeNotes } from "./ledgers";

export const RENDERED_NODE_BOUNDS = { width: 248, height: 154 };

export type DrawioImportMode = "replace" | "append";

export type DrawioImportOptions = {
  flowId: string;
  subflowId?: string | null;
  mode: DrawioImportMode;
  pageIndex?: number;
};

export async function importFlow(projectRoot: string, sourceFilePath: string): Promise<ProjectBundle> {
  const raw = JSON.parse(await readFile(sourceFilePath, "utf8")) as unknown;
  const parsed = flowSchema.parse(raw);
  await writeJson(projectStatePath(projectRoot, "flows", `${parsed.id}.json`), {
    ...parsed,
    updatedAt: iso()
  });
  await touchProject(projectRoot);
  return loadProject(projectRoot);
}

export async function listDrawioPages(sourceFilePath: string): Promise<Array<Pick<DrawioPage, "index" | "name">>> {
  const source = await readFile(sourceFilePath, "utf8");
  return parseDrawioPages(source).map((page) => ({ index: page.index, name: page.name }));
}

export function scopedNodeIds(flow: Flow, subflowId: string | null): Set<string> {
  return new Set(flow.nodes.filter((node) =>
    subflowId ? node.subflowId === subflowId : !node.subflowId
  ).map((node) => node.id));
}

export function graphBounds(nodes: Flow["nodes"]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!nodes.length) return null;
  return nodes.reduce((bounds, node) => {
    return {
      minX: Math.min(bounds.minX, node.position.x),
      minY: Math.min(bounds.minY, node.position.y),
      maxX: Math.max(bounds.maxX, node.position.x + RENDERED_NODE_BOUNDS.width),
      maxY: Math.max(bounds.maxY, node.position.y + RENDERED_NODE_BOUNDS.height)
    };
  }, {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  });
}

export function boundsOverlap(
  first: NonNullable<ReturnType<typeof graphBounds>>,
  second: NonNullable<ReturnType<typeof graphBounds>>
): boolean {
  return first.minX <= second.maxX && first.maxX >= second.minX && first.minY <= second.maxY && first.maxY >= second.minY;
}

export async function importDrawioFlow(projectRoot: string, sourceFilePath: string, options: DrawioImportOptions): Promise<ProjectBundle> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === options.flowId);
  if (!flow) throw new Error(`Flow ${options.flowId} was not found.`);
  const subflowId = options.subflowId ?? null;
  if (subflowId && !flow.subflows.some((subflow) => subflow.id === subflowId)) {
    throw new Error(`Subflow ${subflowId} was not found.`);
  }

  const pages = parseDrawioPages(await readFile(sourceFilePath, "utf8"));
  if (!pages.length) throw new Error("No draw.io mxGraphModel pages were found in this file.");
  const page = pages.find((item) => item.index === (options.pageIndex ?? 0)) ?? pages[0];
  const replacingNodeIds = options.mode === "replace" ? scopedNodeIds(flow, subflowId) : new Set<string>();
  const retainedNodes = options.mode === "replace" ? flow.nodes.filter((node) => !replacingNodeIds.has(node.id)) : flow.nodes;
  const retainedEdges = options.mode === "replace"
    ? flow.edges.filter((edge) => !replacingNodeIds.has(edge.source) && !replacingNodeIds.has(edge.target))
    : flow.edges;
  const stamp = iso();
  const draft = importDrawioPageToArchicode(page, {
    flowId: flow.id,
    subflowId,
    existingNodeIds: retainedNodes.map((node) => node.id),
    existingEdgeIds: retainedEdges.map((edge) => edge.id),
    now: stamp
  });

  let importedNodes = draft.nodes;
  if (options.mode === "append") {
    const existingBounds = graphBounds(flow.nodes.filter((node) =>
      subflowId ? node.subflowId === subflowId : !node.subflowId
    ));
    const importedBounds = graphBounds(importedNodes);
    if (existingBounds && importedBounds && boundsOverlap(existingBounds, importedBounds)) {
      const offset = {
        x: existingBounds.maxX - importedBounds.minX + 96,
        y: existingBounds.minY - importedBounds.minY
      };
      importedNodes = importedNodes.map((node) => ({
        ...node,
        position: { x: node.position.x + offset.x, y: node.position.y + offset.y }
      }));
    }
  }

  const nextFlow = flowSchema.parse({
    ...flow,
    nodes: [...retainedNodes, ...importedNodes],
    edges: [...retainedEdges, ...draft.edges],
    updatedAt: stamp
  });
  await writeJson(projectStatePath(projectRoot, "flows", `${nextFlow.id}.json`), nextFlow);

  const retainedNotes = options.mode === "replace"
    ? bundle.notes.filter((note) => note.flowId !== flow.id || !replacingNodeIds.has(note.nodeId))
    : bundle.notes;
  const importNotes = draft.notes.map((note) => noteSchema.parse({
    id: id("note"),
    flowId: flow.id,
    nodeId: note.nodeId,
    kind: "system-note",
    author: "system",
    body: note.body,
    category: "note",
    priority: "normal",
    attachmentIds: [],
    resolved: false,
    createdAt: stamp
  }));
  const scopeLabel = subflowId
    ? `subflow "${flow.subflows.find((subflow) => subflow.id === subflowId)?.name ?? subflowId}"`
    : `flow "${flow.name}"`;
  const summaryNotes = importedNodes.length
    ? [noteSchema.parse({
      id: id("note"),
      flowId: flow.id,
      nodeId: importedNodes[0].id,
      kind: "system-note",
      author: "system",
      body: `Import note: imported draw.io page "${draft.pageName}" into ${scopeLabel} using ${options.mode} mode. Review generated nodes and any unresolved import notes before treating the diagram as canonical.`,
      category: "note",
      priority: "normal",
      attachmentIds: [],
      resolved: false,
      createdAt: stamp
    })]
    : [];
  await writeNotes(projectRoot, [...retainedNotes, ...summaryNotes, ...importNotes]);
  await touchProject(projectRoot);
  return loadProject(projectRoot);
}

export async function exportFlow(projectRoot: string, flowId: string, targetFilePath: string): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  await writeJson(targetFilePath, flow);
}

export async function exportDrawioFlow(projectRoot: string, flowId: string, targetFilePath: string, subflowId?: string | null): Promise<void> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  const normalizedSubflowId = subflowId ?? null;
  if (normalizedSubflowId && !flow.subflows.some((subflow) => subflow.id === normalizedSubflowId)) {
    throw new Error(`Subflow ${normalizedSubflowId} was not found.`);
  }
  const nodeIds = scopedNodeIds(flow, normalizedSubflowId);
  const subflow = normalizedSubflowId ? flow.subflows.find((item) => item.id === normalizedSubflowId) : null;
  const xml = exportArchicodeScopeToDrawioXml({
    pageName: subflow?.name ?? flow.name,
    nodes: flow.nodes.filter((node) => nodeIds.has(node.id)),
    edges: flow.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    modifiedAt: iso()
  });
  await writeFile(targetFilePath, xml, "utf8");
}

export async function exportProjectBundle(projectRoot: string, targetFilePath: string): Promise<void> {
  const bundle = await loadProject(projectRoot);
  await writeJson(targetFilePath, bundle);
}
