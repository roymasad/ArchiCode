import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserWindow } from "electron";
import type { Flow, ProjectBundle } from "../../shared/schema";

export type ProjectDocumentExportFormat = "html" | "pdf";

const DEFAULT_NODE_WIDTH = 248;
const DEFAULT_NODE_HEIGHT = 154;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeColor(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function readableText(background: string): string {
  const hex = background.slice(1);
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > 150 ? "#17202a" : "#ffffff";
}

function wrapText(value: string, maximumCharacters: number, maximumLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maximumCharacters || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maximumLines) break;
  }
  if (lines.length < maximumLines && current) lines.push(current);
  if (lines.length === maximumLines && words.join(" ").length > lines.join(" ").length) {
    lines[maximumLines - 1] = `${lines[maximumLines - 1].slice(0, Math.max(1, maximumCharacters - 1)).trimEnd()}…`;
  }
  return lines;
}

function svgText(lines: string[], x: number, y: number, options?: { className?: string; lineHeight?: number; fill?: string }): string {
  const lineHeight = options?.lineHeight ?? 19;
  return `<text class="${options?.className ?? ""}" x="${x}" y="${y}"${options?.fill ? ` style="fill:${options.fill}"` : ""}>${lines.map((line, index) =>
    `<tspan x="${x}" dy="${index ? lineHeight : 0}">${escapeHtml(line)}</tspan>`
  ).join("")}</text>`;
}

function rectangleBoundaryPoint(
  center: { x: number; y: number },
  size: { width: number; height: number },
  toward: { x: number; y: number }
): { x: number; y: number } {
  const deltaX = toward.x - center.x;
  const deltaY = toward.y - center.y;
  if (!deltaX && !deltaY) return center;
  const scale = 1 / Math.max(Math.abs(deltaX) / (size.width / 2), Math.abs(deltaY) / (size.height / 2));
  return { x: center.x + deltaX * scale, y: center.y + deltaY * scale };
}

function flowDiagram(flow: Flow): string {
  if (!flow.nodes.length) return '<div class="empty-flow">This flow has no nodes.</div>';
  const bounds = flow.nodes.reduce((result, node) => {
    const width = node.size?.width ?? DEFAULT_NODE_WIDTH;
    const height = node.size?.height ?? DEFAULT_NODE_HEIGHT;
    return {
      minX: Math.min(result.minX, node.position.x),
      minY: Math.min(result.minY, node.position.y),
      maxX: Math.max(result.maxX, node.position.x + width),
      maxY: Math.max(result.maxY, node.position.y + height)
    };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const padding = 56;
  const viewBox = [
    bounds.minX - padding,
    bounds.minY - padding,
    Math.max(320, bounds.maxX - bounds.minX + padding * 2),
    Math.max(220, bounds.maxY - bounds.minY + padding * 2)
  ];
  const nodesById = new Map(flow.nodes.map((node) => [node.id, node]));
  const markerId = `arrow-${flow.id.replace(/[^a-z0-9_-]/gi, "-")}`;
  const edges = flow.edges.map((edge) => {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) return "";
    const sourceWidth = source.size?.width ?? DEFAULT_NODE_WIDTH;
    const sourceHeight = source.size?.height ?? DEFAULT_NODE_HEIGHT;
    const targetWidth = target.size?.width ?? DEFAULT_NODE_WIDTH;
    const targetHeight = target.size?.height ?? DEFAULT_NODE_HEIGHT;
    const sourceCenter = { x: source.position.x + sourceWidth / 2, y: source.position.y + sourceHeight / 2 };
    const targetCenter = { x: target.position.x + targetWidth / 2, y: target.position.y + targetHeight / 2 };
    const sourceBoundary = rectangleBoundaryPoint(sourceCenter, { width: sourceWidth, height: sourceHeight }, targetCenter);
    const targetBoundary = rectangleBoundaryPoint(targetCenter, { width: targetWidth, height: targetHeight }, sourceCenter);
    const { x: x1, y: y1 } = sourceBoundary;
    const { x: x2, y: y2 } = targetBoundary;
    const color = safeColor(edge.color, "#77839a");
    const dash = edge.lineStyle === "dashed" ? ' stroke-dasharray="10 7"' : edge.lineStyle === "dotted" ? ' stroke-dasharray="3 6"' : "";
    const labelX = (x1 + x2) / 2;
    const labelY = (y1 + y2) / 2 - 8;
    return `<g class="edge"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${edge.width ?? 2}"${dash} marker-end="url(#${markerId})" />${edge.label ? `<text x="${labelX}" y="${labelY}" text-anchor="middle">${escapeHtml(edge.label)}</text>` : ""}</g>`;
  }).join("");
  const nodes = flow.nodes.map((node) => {
    const width = node.size?.width ?? DEFAULT_NODE_WIDTH;
    const height = node.size?.height ?? DEFAULT_NODE_HEIGHT;
    const background = safeColor(node.visual.backgroundColor, "#f7f8fb");
    const foreground = readableText(background);
    const titleLines = wrapText(node.title || node.id, Math.max(14, Math.floor(width / 10)), 2);
    const descriptionLines = wrapText(node.description, Math.max(18, Math.floor(width / 8)), 3);
    const radius = node.visual.shape === "rectangle" ? 2 : node.visual.shape === "capsule" ? height / 2 : 16;
    return `<g class="node"><rect x="${node.position.x}" y="${node.position.y}" width="${width}" height="${height}" rx="${radius}" fill="${background}" stroke="#9aa4b5" stroke-width="2" />${svgText(titleLines, node.position.x + 18, node.position.y + 34, { className: "node-title", lineHeight: 22, fill: foreground })}${svgText(descriptionLines, node.position.x + 18, node.position.y + 82, { className: "node-description", lineHeight: 18, fill: foreground })}</g>`;
  }).join("");

  return `<div class="diagram"><svg role="img" aria-label="${escapeHtml(flow.name)} diagram" viewBox="${viewBox.join(" ")}" preserveAspectRatio="xMidYMid meet"><defs><marker id="${markerId}" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 Z" fill="#77839a" /></marker></defs>${edges}${nodes}</svg></div>`;
}

function nodeIndex(flow: Flow): string {
  if (!flow.nodes.length) return "";
  return `<div class="node-index"><h2>Node index</h2>${flow.nodes.map((node) => {
    const metadata = [node.type, node.stage, node.subflowId ? flow.subflows.find((item) => item.id === node.subflowId)?.name : null]
      .filter(Boolean)
      .map((item) => escapeHtml(String(item)))
      .join(" · ");
    return `<article class="node-detail"><h3>${escapeHtml(node.title || node.id)}</h3><p class="metadata">${metadata}</p>${node.description ? `<p>${escapeHtml(node.description)}</p>` : ""}${node.techStack.length ? `<p><strong>Tech:</strong> ${node.techStack.map(escapeHtml).join(", ")}</p>` : ""}${node.acceptanceCriteria.length ? `<ul>${node.acceptanceCriteria.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join("")}</ul>` : ""}</article>`;
  }).join("")}</div>`;
}

export function createProjectExportHtml(bundle: ProjectBundle, flowIds: string[]): string {
  const requestedIds = new Set(flowIds);
  const flows = bundle.flows.filter((flow) => requestedIds.has(flow.id));
  if (!flows.length) throw new Error("Choose at least one flow to export.");
  const generatedAt = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(bundle.project.name)} architecture export</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #eef1f6; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    .project-header { padding: 34px max(32px, calc((100vw - 1180px) / 2)); color: white; background: linear-gradient(135deg, #39247a, #6750d8); }
    .project-header h1 { margin: 0 0 8px; font-size: 30px; }
    .project-header p { margin: 0; max-width: 780px; color: #e8e3ff; }
    .export-meta { margin-top: 15px !important; font-size: 12px; opacity: .8; }
    main { width: min(1180px, calc(100% - 40px)); margin: 28px auto 60px; }
    .flow { margin: 0 0 28px; padding: 28px; break-before: page; border: 1px solid #d9dee8; border-radius: 18px; background: white; box-shadow: 0 12px 36px rgba(30, 40, 70, .08); }
    .flow:first-child { break-before: auto; }
    .flow-header { display: flex; align-items: baseline; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
    .flow h1 { margin: 0; font-size: 25px; }
    .flow-description { margin: 7px 0 0; color: #5c6678; }
    .flow-stats { white-space: nowrap; color: #667085; font-size: 12px; }
    .diagram { width: 100%; height: min(62vh, 620px); min-height: 380px; overflow: hidden; border: 1px solid #dfe3eb; border-radius: 13px; background: #f7f8fb; }
    .diagram svg { display: block; width: 100%; height: 100%; }
    .edge text { paint-order: stroke; stroke: #f7f8fb; stroke-width: 5px; fill: #4d5768; font-size: 13px; }
    .node text { pointer-events: none; }
    .node-title { fill: #17202a; font-size: 17px; font-weight: 700; }
    .node-description { fill: #465164; font-size: 13px; }
    .empty-flow { padding: 80px 24px; border: 1px dashed #c7ceda; border-radius: 13px; text-align: center; color: #667085; background: #f7f8fb; }
    .node-index { margin-top: 26px; columns: 2 340px; column-gap: 22px; }
    .node-index > h2 { column-span: all; margin: 0 0 14px; }
    .node-detail { display: inline-block; width: 100%; margin: 0 0 14px; padding: 15px; break-inside: avoid; border: 1px solid #e1e5ed; border-radius: 10px; }
    .node-detail h3 { margin: 0; font-size: 15px; }
    .node-detail p, .node-detail li { font-size: 12px; line-height: 1.45; }
    .node-detail ul { margin: 8px 0 0; padding-left: 18px; }
    .metadata { margin: 4px 0 8px !important; color: #667085; }
    @media print {
      @page { size: A4 landscape; margin: 10mm; }
      body { background: white; }
      .project-header { padding: 0 0 8mm; color: #17202a; background: none; }
      .project-header p { color: #5c6678; }
      main { width: auto; margin: 0; }
      .flow { padding: 0; border: 0; border-radius: 0; box-shadow: none; }
      .diagram { height: 145mm; min-height: 0; }
      .node-index { break-before: page; }
    }
  </style>
</head>
<body>
  <header class="project-header"><h1>${escapeHtml(bundle.project.name)}</h1>${bundle.project.description ? `<p>${escapeHtml(bundle.project.description)}</p>` : ""}<p class="export-meta">${flows.length} flow${flows.length === 1 ? "" : "s"} · Exported ${escapeHtml(generatedAt)}</p></header>
  <main>${flows.map((flow) => `<section class="flow"><div class="flow-header"><div><h1>${escapeHtml(flow.name)}</h1>${flow.description ? `<p class="flow-description">${escapeHtml(flow.description)}</p>` : ""}</div><span class="flow-stats">${flow.nodes.length} nodes · ${flow.edges.length} connections</span></div>${flowDiagram(flow)}${nodeIndex(flow)}</section>`).join("")}</main>
</body>
</html>`;
}

export async function exportProjectDocument(bundle: ProjectBundle, flowIds: string[], format: ProjectDocumentExportFormat, targetFilePath: string): Promise<void> {
  const html = createProjectExportHtml(bundle, flowIds);
  if (format === "html") {
    await writeFile(targetFilePath, html, "utf8");
    return;
  }

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "archicode-export-"));
  const htmlPath = path.join(temporaryDirectory, "project.html");
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false }
  });
  try {
    await writeFile(htmlPath, html, "utf8");
    await printWindow.loadFile(htmlPath);
    const pdf = await printWindow.webContents.printToPDF({
      printBackground: true,
      landscape: true,
      pageSize: "A4",
      preferCSSPageSize: true
    });
    await writeFile(targetFilePath, pdf);
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
