import { inflateRawSync, inflateSync } from "node:zlib";
import type { ArchicodeNode, FlowEdge } from "../shared/schema";

export type DrawioPage = {
  index: number;
  name: string;
  modelXml: string;
};

export type DrawioImportNote = {
  nodeId: string;
  body: string;
};

export type DrawioImportResult = {
  pageName: string;
  nodes: ArchicodeNode[];
  edges: FlowEdge[];
  notes: DrawioImportNote[];
};

type XmlElement = {
  attributes: Record<string, string>;
  body: string;
};

type DrawioCell = {
  id: string;
  value: string;
  style: string;
  parent?: string;
  source?: string;
  target?: string;
  vertex: boolean;
  edge: boolean;
  geometry: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

const ARCHICODE_RENDERED_NODE_SIZE = {
  width: 248,
  height: 154
};

type XmlTagMatch = {
  index: number;
  end: number;
  rawAttributes: string;
  selfClosing: boolean;
};

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) => String.fromCharCode(parseInt(code, 16)));
}

function textFromDrawioValue(value: string): string {
  const decoded = decodeXmlEntities(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>\s*<div[^>]*>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00a0/g, " ");
  return decoded
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matcher = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(raw))) {
    attributes[match[1]] = decodeXmlEntities(match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function xmlElements(xml: string, tagName: string): XmlElement[] {
  const elements: XmlElement[] = [];
  const matcher = new RegExp(`<${tagName}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tagName}>)`, "g");
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(xml))) {
    elements.push({
      attributes: parseAttributes(match[1] ?? ""),
      body: match[2] ?? ""
    });
  }
  return elements;
}

function nextStartTag(xml: string, tagName: string, fromIndex: number): XmlTagMatch | null {
  const matcher = new RegExp(`<${tagName}\\b([^>]*?)(\\/?)>`, "g");
  matcher.lastIndex = fromIndex;
  const match = matcher.exec(xml);
  if (!match) return null;
  return {
    index: match.index,
    end: matcher.lastIndex,
    rawAttributes: match[1] ?? "",
    selfClosing: match[2] === "/" || /\/\s*$/.test(match[0])
  };
}

function xmlNestedElements(xml: string, tagName: string): XmlElement[] {
  const elements: XmlElement[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = nextStartTag(xml, tagName, cursor);
    if (!start) break;
    if (start.selfClosing) {
      elements.push({ attributes: parseAttributes(start.rawAttributes), body: "" });
      cursor = start.end;
      continue;
    }

    let depth = 1;
    let searchFrom = start.end;
    let bodyEnd = start.end;
    while (depth > 0) {
      const nextOpen = nextStartTag(xml, tagName, searchFrom);
      const nextClose = xml.indexOf(`</${tagName}>`, searchFrom);
      if (nextClose === -1) {
        bodyEnd = xml.length;
        searchFrom = xml.length;
        break;
      }
      if (nextOpen && nextOpen.index < nextClose) {
        if (!nextOpen.selfClosing) depth += 1;
        searchFrom = nextOpen.end;
        continue;
      }
      depth -= 1;
      bodyEnd = nextClose;
      searchFrom = nextClose + tagName.length + 3;
    }

    const body = xml.slice(start.end, bodyEnd);
    elements.push({
      attributes: parseAttributes(start.rawAttributes),
      body
    });
    elements.push(...xmlNestedElements(body, tagName));
    cursor = searchFrom;
  }
  return elements;
}

function decodeDiagramPayload(payload: string): string | null {
  const rawTrimmed = payload.trim();
  if (!rawTrimmed) return null;
  if (rawTrimmed.includes("<mxGraphModel")) return rawTrimmed;

  const trimmed = decodeXmlEntities(payload).trim();
  if (!trimmed) return null;
  if (trimmed.includes("<mxGraphModel")) return trimmed;

  try {
    const buffer = Buffer.from(trimmed, "base64");
    for (const inflate of [inflateRawSync, inflateSync]) {
      try {
        const inflated = inflate(buffer).toString("utf8");
        try {
          return decodeURIComponent(inflated);
        } catch {
          return inflated;
        }
      } catch {
        // Try the next compression wrapper.
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function parseDrawioPages(source: string): DrawioPage[] {
  const diagrams = xmlElements(source, "diagram");
  if (diagrams.length) {
    return diagrams.flatMap((diagram, index) => {
      const modelXml = decodeDiagramPayload(diagram.body);
      if (!modelXml?.includes("<mxGraphModel")) return [];
      return [{
        index,
        name: diagram.attributes.name?.trim() || `Page ${index + 1}`,
        modelXml
      }];
    });
  }

  const directModel = source.match(/<mxGraphModel\b[\s\S]*?<\/mxGraphModel>/)?.[0];
  return directModel ? [{ index: 0, name: "Diagram", modelXml: directModel }] : [];
}

function numberAttribute(attributes: Record<string, string>, name: string, fallback: number): number {
  const value = Number(attributes[name]);
  return Number.isFinite(value) ? value : fallback;
}

function styleMap(style: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const part of style.split(";")) {
    const [key, value] = part.split("=");
    if (key && value) entries[key] = value;
    else if (key) entries[key] = "1";
  }
  return entries;
}

function hexColor(value: string | undefined): string | undefined {
  if (!value || value === "none") return undefined;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  if (/^[0-9a-fA-F]{6}$/.test(value)) return `#${value}`;
  return undefined;
}

function visualShapeForStyle(style: Record<string, string>): NonNullable<ArchicodeNode["visual"]["shape"]> {
  const shape = (style.shape ?? "").toLowerCase();
  if (shape.includes("cylinder")) return "database";
  if (shape.includes("document") || style.document === "1") return "document";
  if (shape.includes("note") || style.note === "1") return "note";
  if (style.ellipse === "1" || shape.includes("ellipse")) return "ellipse";
  if (style.rhombus === "1" || shape.includes("rhombus") || shape.includes("diamond") || shape.includes("decision")) return "diamond";
  if (style.hexagon === "1" || shape.includes("hexagon")) return "hexagon";
  if (style.parallelogram === "1" || shape.includes("parallelogram") || shape.includes("data")) return "parallelogram";
  if (style.cloud === "1" || shape.includes("cloud")) return "cloud";
  if (style.actor === "1" || shape.includes("actor") || shape.includes("umlactor")) return "actor";
  if (style.rounded === "1") return "rounded";
  if (style.arcSize === "50" || shape.includes("pill") || shape.includes("terminator")) return "capsule";
  if (style.triangle === "1" || shape.includes("triangle")) return "diamond";
  if (style.process === "1" || shape.includes("process") || shape === "rectangle" || !shape) return "rectangle";
  return "rectangle";
}

function cellId(prefix: string, sourceId: string, taken: Set<string>): string {
  const safe = sourceId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shape";
  let candidate = `${prefix}-${safe}`;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${prefix}-${safe}-${counter}`;
    counter += 1;
  }
  taken.add(candidate);
  return candidate;
}

function parseCell(element: XmlElement): DrawioCell | null {
  const id = element.attributes.id?.trim();
  if (!id) return null;
  const geometryAttrs = parseAttributes(element.body.match(/<mxGeometry\b([^>]*?)\/?>/)?.[1] ?? "");
  return {
    id,
    value: element.attributes.value ?? "",
    style: element.attributes.style ?? "",
    parent: element.attributes.parent,
    source: element.attributes.source,
    target: element.attributes.target,
    vertex: element.attributes.vertex === "1",
    edge: element.attributes.edge === "1",
    geometry: {
      x: numberAttribute(geometryAttrs, "x", 0),
      y: numberAttribute(geometryAttrs, "y", 0),
      width: numberAttribute(geometryAttrs, "width", 220),
      height: numberAttribute(geometryAttrs, "height", 120)
    }
  };
}

function isEdgeLabelCell(cell: DrawioCell, bySourceId: Map<string, DrawioCell>): boolean {
  const style = styleMap(cell.style);
  const parent = cell.parent ? bySourceId.get(cell.parent) : undefined;
  return Boolean(cell.vertex && (style.edgeLabel !== undefined || cell.style.split(";").includes("edgeLabel") || parent?.edge));
}

function edgeLabelForCell(cell: DrawioCell, cells: DrawioCell[]): string | undefined {
  const direct = textFromDrawioValue(cell.value);
  if (direct) return direct;
  const childLabel = cells.find((candidate) => candidate.parent === cell.id && isEdgeLabelCell(candidate, new Map(cells.map((item) => [item.id, item]))));
  const label = childLabel ? textFromDrawioValue(childLabel.value) : "";
  return label || undefined;
}

export function importDrawioPageToArchicode(
  page: DrawioPage,
  options: {
    flowId: string;
    subflowId: string | null;
    existingNodeIds?: Iterable<string>;
    existingEdgeIds?: Iterable<string>;
    positionOffset?: { x: number; y: number };
    now?: string;
  }
): DrawioImportResult {
  const now = options.now ?? new Date().toISOString();
  const takenNodeIds = new Set(options.existingNodeIds ?? []);
  const takenEdgeIds = new Set(options.existingEdgeIds ?? []);
  const cells = xmlNestedElements(page.modelXml, "mxCell").flatMap((element) => {
    const cell = parseCell(element);
    return cell ? [cell] : [];
  });
  const bySourceId = new Map(cells.map((cell) => [cell.id, cell]));
  const sourceToNodeId = new Map<string, string>();
  const notes: DrawioImportNote[] = [];

  const nodes = cells.filter((cell) => cell.vertex && !isEdgeLabelCell(cell, bySourceId)).map((cell) => {
    const importedId = cellId("node-drawio", cell.id, takenNodeIds);
    sourceToNodeId.set(cell.id, importedId);
    const style = styleMap(cell.style);
    const text = textFromDrawioValue(cell.value);
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const shape = visualShapeForStyle(style);
    const visual = {
      backgroundColor: hexColor(style.fillColor),
      shape
    };
    const node: ArchicodeNode = {
      id: importedId,
      type: "imported",
      title: lines[0] || `Imported shape ${cell.id}`,
      description: lines.slice(1).join("\n") || `Imported from draw.io shape ${cell.id}.`,
      stage: "planned",
      ignored: false,
      flags: ["changed"],
      locked: false,
      visual,
      position: {
        x: cell.geometry.x + cell.geometry.width / 2 - ARCHICODE_RENDERED_NODE_SIZE.width / 2 + (options.positionOffset?.x ?? 0),
        y: cell.geometry.y + cell.geometry.height / 2 - ARCHICODE_RENDERED_NODE_SIZE.height / 2 + (options.positionOffset?.y ?? 0)
      },
      size: {
        width: Math.max(120, cell.geometry.width),
        height: Math.max(72, cell.geometry.height)
      },
      subflowId: options.subflowId ?? undefined,
      customProperties: {},
      techStack: [],
      acceptanceCriteria: [],
      acceptanceChecks: [],
      attachments: [],
      todos: [],
      updatedAt: now
    };

    const nodeNotes: string[] = [];
    if (!lines.length) nodeNotes.push(`Import note: draw.io shape ${cell.id} had no visible label, so ArchiCode generated a placeholder title.`);
    if (lines.length > 1) nodeNotes.push("Import note: multiline draw.io label was split into the node title and description. Review for accuracy.");
    if (/<[^>]+>/.test(decodeXmlEntities(cell.value))) nodeNotes.push("Import note: draw.io label contained HTML formatting. ArchiCode kept only plain text.");
    if (style.swimlane === "1" || style.childLayout) nodeNotes.push("Import note: this draw.io container/swimlane was imported as a regular node. Verify whether it should become a subflow.");
    const parent = cell.parent ? bySourceId.get(cell.parent) : undefined;
    if (parent?.vertex) {
      const parentLabel = textFromDrawioValue(parent.value) || parent.id;
      nodeNotes.push(`Import note: this shape was inside draw.io group/container "${parentLabel}". Verify whether that grouping should be modeled as a subflow, tag, or ordinary relationship.`);
    }
    notes.push(...nodeNotes.map((body) => ({ nodeId: importedId, body })));
    return node;
  });

  const edges = cells.filter((cell) => cell.edge).flatMap((cell) => {
    const source = cell.source ? sourceToNodeId.get(cell.source) : undefined;
    const target = cell.target ? sourceToNodeId.get(cell.target) : undefined;
    if (!source || !target) {
      const anchor = source ?? target;
      if (anchor) {
        notes.push({
          nodeId: anchor,
          body: `Import note: draw.io connector ${cell.id} could not be imported because one endpoint was missing or was not a supported shape.`
        });
      }
      return [];
    }
    return [{
      id: cellId("edge-drawio", cell.id, takenEdgeIds),
      source,
      target,
      label: edgeLabelForCell(cell, cells)
    }];
  });

  return {
    pageName: page.name,
    nodes,
    edges,
    notes
  };
}
