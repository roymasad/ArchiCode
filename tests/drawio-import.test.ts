import { deflateRawSync } from "node:zlib";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportDrawioFlow, importDrawioFlow } from "../src/main/storage/flowImportExport";
import { addNote } from "../src/main/storage/notes";
import { ensureEmptyCodebaseProject, loadProject, saveFlow } from "../src/main/storage/projectStore";
import { importDrawioPageToArchicode, parseDrawioPages } from "../src/main/drawioImport";

const simpleModel = `
<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="group" value="Backend" style="swimlane=1;childLayout=stackLayout;" vertex="1" parent="1">
      <mxGeometry x="20" y="20" width="400" height="260" as="geometry"/>
    </mxCell>
    <mxCell id="api" value="API&lt;br&gt;Handles requests" style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="group">
      <mxGeometry x="60" y="80" width="180" height="90" as="geometry"/>
    </mxCell>
    <mxCell id="db" value="&lt;div&gt;trashbin&lt;/div&gt;" style="shape=cylinder3;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1">
      <mxGeometry x="320" y="92" width="160" height="110" as="geometry"/>
    </mxCell>
    <mxCell id="edge1" edge="1" parent="1" source="api" target="db">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
    <mxCell id="edge1-label" connectable="0" parent="edge1" style="edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];" value="reads" vertex="1">
      <mxGeometry relative="1" x="0.1059" y="-2" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>`;

describe("draw.io import", () => {
  it("parses compressed mxfile pages", () => {
    const encoded = deflateRawSync(encodeURIComponent(simpleModel)).toString("base64");
    const pages = parseDrawioPages(`<mxfile><diagram id="p1" name="Architecture">${encoded}</diagram></mxfile>`);

    expect(pages).toHaveLength(1);
    expect(pages[0]?.name).toBe("Architecture");
    expect(pages[0]?.modelXml).toContain("<mxGraphModel>");
  });

  it("imports a draw.io page into the active flow as nodes, edges, visuals, and notes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-drawio-import-"));
    await ensureEmptyCodebaseProject(root);
    const sourcePath = path.join(root, "diagram.drawio");
    await writeFile(sourcePath, `<mxfile><diagram id="page-1" name="Page-1">${simpleModel}</diagram></mxfile>`, "utf8");

    const bundle = await importDrawioFlow(root, sourcePath, {
      flowId: "flow-main",
      mode: "append"
    });
    const flow = bundle.flows[0]!;
    const api = flow.nodes.find((node) => node.title === "API");
    const db = flow.nodes.find((node) => node.title === "trashbin");

    expect(api?.description).toBe("Handles requests");
    expect(api?.visual.shape).toBe("rounded");
    expect(api?.position).toEqual({ x: 26, y: 48 });
    expect(db?.visual.shape).toBe("database");
    expect(db?.position).toEqual({ x: 276, y: 70 });
    expect((db?.position.x ?? 0) - (api?.position.x ?? 0)).toBe(250);
    expect((db?.position.y ?? 0) - (api?.position.y ?? 0)).toBe(22);
    expect(flow.nodes.some((node) => node.title === "reads")).toBe(false);
    expect(flow.edges).toEqual([
      expect.objectContaining({ source: api?.id, target: db?.id, label: "reads" })
    ]);
    expect(bundle.notes.some((note) =>
      note.nodeId === api?.id &&
      note.body.includes("multiline draw.io label")
    )).toBe(true);
    expect(bundle.notes.some((note) =>
      note.nodeId === api?.id &&
      note.body.includes("Backend")
    )).toBe(true);
  });

  it("replaces only the selected subflow scope and removes stale notes for deleted nodes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-drawio-replace-"));
    const initial = await ensureEmptyCodebaseProject(root);
    const flow = initial.flows[0]!;
    await saveFlow(root, {
      ...flow,
      nodes: [
        {
          id: "node-top",
          type: "component",
          title: "Top Level",
          description: "Keep this node.",
          stage: "planned",
          ignored: false,
          flags: [],
          locked: false,
          visual: {},
          position: { x: 0, y: 0 },
          customProperties: {},
          techStack: [],
          acceptanceCriteria: [],
          acceptanceChecks: [],
          attachments: [],
          todos: [],
          updatedAt: new Date().toISOString()
        },
        {
          id: "node-old-subflow",
          type: "component",
          title: "Old Subflow Node",
          description: "Replace this node.",
          stage: "planned",
          ignored: false,
          flags: [],
          locked: false,
          visual: {},
          position: { x: 100, y: 100 },
          subflowId: "subflow-import",
          customProperties: {},
          techStack: [],
          acceptanceCriteria: [],
          acceptanceChecks: [],
          attachments: [],
          todos: [],
          updatedAt: new Date().toISOString()
        }
      ],
      edges: [{ id: "edge-old", source: "node-top", target: "node-old-subflow", label: "old" }],
      subflows: [{ id: "subflow-import", name: "Import Target", ignored: false }]
    });
    await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-old-subflow",
      kind: "user-note",
      author: "user",
      body: "Remove this stale note when replacing the subflow.",
      resolved: false
    });
    const sourcePath = path.join(root, "diagram.drawio");
    await writeFile(sourcePath, simpleModel, "utf8");

    const bundle = await importDrawioFlow(root, sourcePath, {
      flowId: "flow-main",
      subflowId: "subflow-import",
      mode: "replace"
    });
    const loaded = await loadProject(root);

    expect(bundle.flows[0]?.nodes.some((node) => node.id === "node-top")).toBe(true);
    expect(bundle.flows[0]?.nodes.some((node) => node.id === "node-old-subflow")).toBe(false);
    expect(bundle.flows[0]?.edges.some((edge) => edge.id === "edge-old")).toBe(false);
    expect(bundle.flows[0]?.nodes.filter((node) => node.subflowId === "subflow-import")).toHaveLength(3);
    expect(loaded.notes.some((note) => note.nodeId === "node-old-subflow")).toBe(false);
  });

  it("maps common draw.io shapes to supported ArchiCode node shapes", () => {
    const result = importDrawioPageToArchicode({
      index: 0,
      name: "Shapes",
      modelXml: `
        <mxGraphModel>
          <root>
            <mxCell id="0"/>
            <mxCell id="1" parent="0"/>
            <mxCell id="ellipse" value="Ellipse" style="ellipse;whiteSpace=wrap;html=1;" vertex="1" parent="1">
              <mxGeometry x="0" y="0" width="120" height="80" as="geometry"/>
            </mxCell>
            <mxCell id="diamond" value="Diamond" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="1">
              <mxGeometry x="160" y="0" width="120" height="80" as="geometry"/>
            </mxCell>
            <mxCell id="hexagon" value="Hexagon" style="shape=hexagon;whiteSpace=wrap;html=1;" vertex="1" parent="1">
              <mxGeometry x="320" y="0" width="120" height="80" as="geometry"/>
            </mxCell>
            <mxCell id="parallelogram" value="Parallelogram" style="shape=parallelogram;whiteSpace=wrap;html=1;" vertex="1" parent="1">
              <mxGeometry x="480" y="0" width="120" height="80" as="geometry"/>
            </mxCell>
            <mxCell id="cloud" value="Cloud" style="shape=cloud;whiteSpace=wrap;html=1;" vertex="1" parent="1">
              <mxGeometry x="640" y="0" width="120" height="80" as="geometry"/>
            </mxCell>
            <mxCell id="actor" value="Actor" style="shape=umlActor;whiteSpace=wrap;html=1;" vertex="1" parent="1">
              <mxGeometry x="800" y="0" width="120" height="80" as="geometry"/>
            </mxCell>
          </root>
        </mxGraphModel>`
    }, {
      flowId: "flow-main",
      subflowId: null,
      now: "2026-06-26T00:00:00.000Z"
    });

    expect(Object.fromEntries(result.nodes.map((node) => [node.title, node.visual.shape]))).toEqual({
      Ellipse: "ellipse",
      Diamond: "diamond",
      Hexagon: "hexagon",
      Parallelogram: "parallelogram",
      Cloud: "cloud",
      Actor: "actor"
    });
  });

  it("exports the selected ArchiCode scope as draw.io XML", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-drawio-export-"));
    const initial = await ensureEmptyCodebaseProject(root);
    const flow = initial.flows[0]!;
    await saveFlow(root, {
      ...flow,
      nodes: [
        {
          id: "node-top",
          type: "component",
          title: "Top Level",
          description: "This should stay out of the subflow export.",
          stage: "planned",
          ignored: false,
          flags: [],
          locked: false,
          visual: { shape: "cloud", backgroundColor: "#dae8fc" },
          position: { x: 40, y: 50 },
          customProperties: {},
          techStack: [],
          acceptanceCriteria: [],
          acceptanceChecks: [],
          attachments: [],
          todos: [],
          updatedAt: "2026-06-26T00:00:00.000Z"
        },
        {
          id: "node-sub-a",
          type: "component",
          title: "Decision",
          description: "Choose a path.",
          stage: "planned",
          ignored: false,
          flags: [],
          locked: false,
          visual: { shape: "diamond", backgroundColor: "#fff2cc" },
          position: { x: 120, y: 150 },
          subflowId: "subflow-export",
          customProperties: {},
          techStack: [],
          acceptanceCriteria: [],
          acceptanceChecks: [],
          attachments: [],
          todos: [],
          updatedAt: "2026-06-26T00:00:00.000Z"
        },
        {
          id: "node-sub-b",
          type: "component",
          title: "Store",
          description: "",
          stage: "planned",
          ignored: false,
          flags: [],
          locked: false,
          visual: { shape: "database", backgroundColor: "#d5e8d4" },
          position: { x: 420, y: 170 },
          subflowId: "subflow-export",
          customProperties: {},
          techStack: [],
          acceptanceCriteria: [],
          acceptanceChecks: [],
          attachments: [],
          todos: [],
          updatedAt: "2026-06-26T00:00:00.000Z"
        }
      ],
      edges: [
        { id: "edge-sub", source: "node-sub-a", target: "node-sub-b", label: "writes" },
        { id: "edge-cross", source: "node-top", target: "node-sub-a", label: "excluded" }
      ],
      subflows: [{ id: "subflow-export", name: "Exported Detail", ignored: false }]
    });
    const exportPath = path.join(root, "export.drawio.xml");

    await exportDrawioFlow(root, "flow-main", exportPath, "subflow-export");

    const xml = await readFile(exportPath, "utf8");
    const page = parseDrawioPages(xml)[0]!;
    const imported = importDrawioPageToArchicode(page, {
      flowId: "flow-main",
      subflowId: null,
      now: "2026-06-26T00:00:00.000Z"
    });

    expect(page.name).toBe("Exported Detail");
    expect(xml).toContain("rhombus;whiteSpace=wrap");
    expect(xml).toContain("shape=cylinder3");
    expect(imported.nodes.map((node) => node.title).sort()).toEqual(["Decision", "Store"]);
    expect(imported.nodes.some((node) => node.title === "Top Level")).toBe(false);
    expect(imported.edges).toEqual([
      expect.objectContaining({ label: "writes" })
    ]);
  });
});
