import type { ArchicodeNode, FlowEdge } from "../shared/schema";

export const DRAWIO_EXPORTED_NODE_SIZE = {
  width: 248,
  height: 154
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function styleParts(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(";");
}

function drawioShapeStyle(node: ArchicodeNode): string {
  const shape = node.visual?.shape ?? "rounded";
  const base = ["whiteSpace=wrap", "html=1"];
  const shapeStyle: Record<typeof shape, string[]> = {
    rounded: ["rounded=1"],
    rectangle: [],
    capsule: ["rounded=1", "arcSize=50"],
    document: ["shape=document", "boundedLbl=1"],
    database: ["shape=cylinder3", "boundedLbl=1", "backgroundOutline=1", "size=15"],
    note: ["shape=note"],
    ellipse: ["ellipse"],
    diamond: ["rhombus"],
    hexagon: ["shape=hexagon"],
    parallelogram: ["shape=parallelogram"],
    cloud: ["shape=cloud"],
    actor: ["shape=umlActor", "verticalLabelPosition=bottom", "verticalAlign=top", "outlineConnect=0"]
  };
  return styleParts([
    ...shapeStyle[shape],
    ...base,
    node.visual?.backgroundColor ? `fillColor=${node.visual.backgroundColor}` : undefined
  ]);
}

function nodeLabel(node: ArchicodeNode): string {
  const description = node.description.trim();
  if (!description || description.startsWith("Imported from draw.io shape ")) return node.title;
  return `${node.title}\n${description}`;
}

export function exportArchicodeScopeToDrawioXml(input: {
  pageName: string;
  nodes: ArchicodeNode[];
  edges: FlowEdge[];
  modifiedAt?: string;
}): string {
  const modifiedAt = input.modifiedAt ?? new Date().toISOString();
  const visibleIds = new Set(input.nodes.map((node) => node.id));
  const cells = [
    "        <mxCell id=\"0\" />",
    "        <mxCell id=\"1\" parent=\"0\" />",
    ...input.nodes.map((node) => {
      const width = DRAWIO_EXPORTED_NODE_SIZE.width;
      const height = DRAWIO_EXPORTED_NODE_SIZE.height;
      return [
        `        <mxCell id="${escapeXml(node.id)}" value="${escapeXml(nodeLabel(node))}" style="${escapeXml(drawioShapeStyle(node))}" vertex="1" parent="1">`,
        `          <mxGeometry x="${node.position.x}" y="${node.position.y}" width="${width}" height="${height}" as="geometry" />`,
        "        </mxCell>"
      ].join("\n");
    }),
    ...input.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map((edge) => [
      `        <mxCell id="${escapeXml(edge.id)}" value="${escapeXml(edge.label ?? "")}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;" edge="1" parent="1" source="${escapeXml(edge.source)}" target="${escapeXml(edge.target)}">`,
      "          <mxGeometry relative=\"1\" as=\"geometry\" />",
      "        </mxCell>"
    ].join("\n"))
  ].join("\n");

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    `<mxfile host="app.archicode.desktop" modified="${escapeXml(modifiedAt)}">`,
    `  <diagram name="${escapeXml(input.pageName)}" id="${escapeXml(`archicode-${input.pageName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "flow"}`)}">`,
    "    <mxGraphModel dx=\"1200\" dy=\"800\" grid=\"1\" gridSize=\"10\" guides=\"1\" tooltips=\"1\" connect=\"1\" arrows=\"1\" fold=\"1\" page=\"1\" pageScale=\"1\" pageWidth=\"1600\" pageHeight=\"1200\" math=\"0\" shadow=\"0\">",
    "      <root>",
    cells,
    "      </root>",
    "    </mxGraphModel>",
    "  </diagram>",
    "</mxfile>",
    ""
  ].join("\n");
}
