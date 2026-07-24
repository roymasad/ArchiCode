import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserWindow } from "electron";
import type PptxGenJSImport from "pptxgenjs";
import type { ProjectBriefing, ProjectBriefingVisualItem } from "../shared/projectBriefing";

export type ProjectBriefingExportFormat = "pdf" | "pptx";

const requireFromProjectBriefingExport = createRequire(import.meta.url);
const PptxGenJS = requireFromProjectBriefingExport("pptxgenjs") as typeof PptxGenJSImport;

const tones: Record<ProjectBriefingVisualItem["tone"], { fill: string; line: string }> = {
  cyan: { fill: "173C46", line: "22D3EE" },
  violet: { fill: "302C49", line: "A78BFA" },
  green: { fill: "203D31", line: "4ADE80" },
  amber: { fill: "41391D", line: "FBBF24" },
  rose: { fill: "45252D", line: "FB7185" },
  neutral: { fill: "263239", line: "8F9AA2" }
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function briefingExportHtml(briefing: ProjectBriefing): string {
  const slides = briefing.slides.map((slide, slideIndex) => {
    const connections = slide.visual.connections.map((connection) => {
      const from = slide.visual.items.find((item) => item.id === connection.from)?.label ?? connection.from;
      const to = slide.visual.items.find((item) => item.id === connection.to)?.label ?? connection.to;
      return `<span>${escapeHtml(from)} <b>→</b> ${connection.label ? `<em>${escapeHtml(connection.label)}</em> ` : ""}${escapeHtml(to)}</span>`;
    }).join("");
    const items = slide.visual.items.map((item) => `
      <article class="visual-item tone-${item.tone}">
        <small>${escapeHtml(item.kind)}</small>
        <h3>${escapeHtml(item.label)}</h3>
        ${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}
      </article>
    `).join("");
    const evidence = slide.evidence.map((item) => `
      <li><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(item.excerpt)} <code>${escapeHtml(item.reference)}</code></li>
    `).join("");
    return `
      <section class="slide">
        <header>
          <div><span>${escapeHtml(slide.kicker)}</span><small>${slideIndex + 1} / ${briefing.slides.length}</small></div>
          <h1>${escapeHtml(slide.title)}</h1>
          <p>${escapeHtml(slide.body)}</p>
        </header>
        <main>
          <div class="visual visual-${slide.visual.kind}">${items}</div>
          ${connections ? `<div class="connections">${connections}</div>` : ""}
        </main>
        <footer>
          <b>Evidence</b>
          <ul>${evidence}</ul>
        </footer>
      </section>
    `;
  }).join("");
  return `<!doctype html>
  <html><head><meta charset="utf-8"><title>${escapeHtml(briefing.title)}</title>
  <style>
    @page { size: 13.333in 7.5in; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #0d1519; color: #f4f7f8; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .slide { position: relative; display: grid; grid-template-rows: auto 1fr auto; gap: 22px; width: 13.333in; height: 7.5in; overflow: hidden; padding: .46in .58in .34in; page-break-after: always; background: radial-gradient(circle at 12% 10%, #14333b, transparent 38%), radial-gradient(circle at 90% 82%, #2d2744, transparent 34%), #0d1519; }
    .slide:last-child { page-break-after: auto; }
    header > div { display: flex; justify-content: space-between; color: #83dbea; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    header h1 { max-width: 10.8in; margin: 11px 0 6px; font-size: 34px; line-height: 1.05; letter-spacing: -.035em; }
    header > p { max-width: 10.5in; margin: 0; color: #b9c3c9; font-size: 16px; line-height: 1.45; }
    main { display: grid; align-content: center; gap: 14px; min-height: 0; }
    .visual { display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch; justify-content: center; }
    .visual-item { width: 2.35in; min-height: 1.35in; padding: 16px; border: 1.5px solid #516069; border-radius: 18px; background: #172126; }
    .visual-item small { color: #8f9aa2; font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .visual-item h3 { margin: 9px 0 5px; font-size: 18px; line-height: 1.1; }
    .visual-item p { margin: 0; color: #b9c3c9; font-size: 11px; line-height: 1.35; }
    .tone-cyan { border-color: #22d3ee; background: #173c46; } .tone-violet { border-color: #a78bfa; background: #302c49; }
    .tone-green { border-color: #4ade80; background: #203d31; } .tone-amber { border-color: #fbbf24; background: #41391d; }
    .tone-rose { border-color: #fb7185; background: #45252d; }
    .connections { display: flex; flex-wrap: wrap; gap: 7px; justify-content: center; }
    .connections span { padding: 5px 9px; border: 1px solid #34434b; border-radius: 99px; color: #b9c3c9; background: #111b20; font-size: 9px; }
    .connections b, .connections em { color: #83dbea; font-style: normal; }
    footer { padding-top: 8px; border-top: 1px solid #34434b; color: #96a3aa; font-size: 8px; }
    footer > b { color: #83dbea; text-transform: uppercase; letter-spacing: .08em; }
    footer ul { display: flex; gap: 14px; margin: 5px 0 0; padding: 0; list-style: none; }
    footer li { flex: 1; line-height: 1.28; } footer code { display: block; margin-top: 2px; color: #69777e; font-size: 7px; }
  </style></head><body>${slides}</body></html>`;
}

async function exportPdf(briefing: ProjectBriefing, targetFilePath: string): Promise<void> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "archicode-briefing-export-"));
  const htmlPath = path.join(temporaryDirectory, "briefing.html");
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false }
  });
  try {
    await writeFile(htmlPath, briefingExportHtml(briefing), "utf8");
    await printWindow.loadFile(htmlPath);
    const pdf = await printWindow.webContents.printToPDF({
      printBackground: true,
      landscape: true,
      preferCSSPageSize: true
    });
    await writeFile(targetFilePath, pdf);
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function itemPositions(count: number): Array<{ x: number; y: number; w: number; h: number }> {
  const columns = Math.min(count, count <= 4 ? count : Math.ceil(count / 2));
  const rows = Math.ceil(count / columns);
  const frame = { x: 0.55, y: 2.25, w: 7.2, h: 3.65 };
  const gapX = 0.18;
  const gapY = 0.18;
  const width = (frame.w - gapX * (columns - 1)) / columns;
  const height = Math.min(1.65, (frame.h - gapY * (rows - 1)) / rows);
  const usedHeight = height * rows + gapY * (rows - 1);
  const startY = frame.y + (frame.h - usedHeight) / 2;
  return Array.from({ length: count }, (_, index) => ({
    x: frame.x + (index % columns) * (width + gapX),
    y: startY + Math.floor(index / columns) * (height + gapY),
    w: width,
    h: height
  }));
}

async function exportPptx(briefing: ProjectBriefing, targetFilePath: string): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "ArchiCode";
  pptx.company = "ArchiCode";
  pptx.subject = briefing.subtitle;
  pptx.title = briefing.title;
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos"
  };

  for (const [slideIndex, briefingSlide] of briefing.slides.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: "0D1519" };
    slide.addShape(pptx.ShapeType.ellipse, { x: 0, y: 0, w: 3.85, h: 3.15, fill: { color: "14333B", transparency: 38 }, line: { color: "14333B", transparency: 100 } });
    slide.addShape(pptx.ShapeType.ellipse, { x: 10.58, y: 5.08, w: 2.75, h: 2.42, fill: { color: "2D2744", transparency: 36 }, line: { color: "2D2744", transparency: 100 } });
    slide.addText(briefingSlide.kicker.toUpperCase(), { x: 0.58, y: 0.35, w: 5.8, h: 0.22, fontFace: "Aptos", fontSize: 10, bold: true, color: "83DBEA", charSpacing: 1.2, margin: 0 });
    slide.addText(`${slideIndex + 1} / ${briefing.slides.length}`, { x: 11.75, y: 0.35, w: 0.95, h: 0.22, fontFace: "Aptos", fontSize: 10, color: "96A3AA", align: "right", margin: 0 });
    slide.addText(briefingSlide.title, { x: 0.58, y: 0.7, w: 7.05, h: 1.05, fontFace: "Aptos Display", fontSize: 35, bold: true, color: "F4F7F8", breakLine: false, margin: 0, valign: "middle", fit: "shrink" });
    slide.addText(briefingSlide.body, { x: 8.25, y: 1.25, w: 4.42, h: 2.25, fontFace: "Aptos", fontSize: 20, color: "B9C3C9", breakLine: false, margin: 0.02, valign: "top", fit: "shrink", paraSpaceAfter: 8, lineSpacingMultiple: 1.05 });

    const positions = itemPositions(briefingSlide.visual.items.length);
    const positionsById = new Map(briefingSlide.visual.items.map((item, index) => [item.id, positions[index]]));
    for (const connection of briefingSlide.visual.connections) {
      const from = positionsById.get(connection.from);
      const to = positionsById.get(connection.to);
      if (!from || !to) continue;
      slide.addShape(pptx.ShapeType.line, {
        x: from.x + from.w / 2,
        y: from.y + from.h / 2,
        w: to.x + to.w / 2 - (from.x + from.w / 2),
        h: to.y + to.h / 2 - (from.y + from.h / 2),
        line: { color: "5C9EAA", width: 1.6, endArrowType: "triangle", transparency: 18 }
      });
    }
    for (const [itemIndex, item] of briefingSlide.visual.items.entries()) {
      const position = positions[itemIndex];
      const tone = tones[item.tone];
      slide.addShape(pptx.ShapeType.roundRect, {
        ...position,
        rectRadius: 0.08,
        fill: { color: tone.fill, transparency: 4 },
        line: { color: tone.line, width: 1.2, transparency: 12 },
        shadow: { type: "outer", color: "000000", opacity: 0.18, blur: 2, angle: 45, offset: 1 }
      });
      slide.addText(item.kind.toUpperCase(), { x: position.x + 0.15, y: position.y + 0.14, w: position.w - 0.3, h: 0.17, fontFace: "Aptos", fontSize: 8, bold: true, color: tone.line, charSpacing: 0.8, margin: 0 });
      slide.addText(item.label, { x: position.x + 0.15, y: position.y + 0.42, w: position.w - 0.3, h: 0.46, fontFace: "Aptos Display", fontSize: 17, bold: true, color: "F4F7F8", margin: 0, valign: "middle", fit: "shrink" });
      if (item.detail) {
        slide.addText(item.detail, { x: position.x + 0.15, y: position.y + 0.95, w: position.w - 0.3, h: Math.max(0.28, position.h - 1.08), fontFace: "Aptos", fontSize: 10, color: "B9C3C9", margin: 0, fit: "shrink" });
      }
    }

    slide.addShape(pptx.ShapeType.line, { x: 8.25, y: 4.06, w: 4.42, h: 0, line: { color: "34434B", width: 1 } });
    slide.addText("EVIDENCE", { x: 8.25, y: 4.23, w: 1.2, h: 0.18, fontFace: "Aptos", fontSize: 9, bold: true, color: "83DBEA", charSpacing: 1, margin: 0 });
    const evidenceText = briefingSlide.evidence
      .slice(0, 3)
      .map((item) => `• ${item.label}: ${item.excerpt}`)
      .join("\n");
    slide.addText(evidenceText, { x: 8.25, y: 4.55, w: 4.42, h: 1.35, fontFace: "Aptos", fontSize: 10, color: "96A3AA", breakLine: false, margin: 0, fit: "shrink", bullet: false });
    slide.addText(briefing.title, { x: 0.58, y: 7.08, w: 5.2, h: 0.16, fontFace: "Aptos", fontSize: 8, color: "69777E", margin: 0 });
    slide.addText("Generated by ArchiCode", { x: 10.5, y: 7.08, w: 2.17, h: 0.16, fontFace: "Aptos", fontSize: 8, color: "69777E", align: "right", margin: 0 });
    slide.addNotes([
      briefingSlide.narration,
      "",
      "[Sources]",
      ...briefingSlide.evidence.map((item) => `- ${item.reference} — ${item.label}: ${item.excerpt}`),
      "[/Sources]"
    ].join("\n"));
  }

  await pptx.writeFile({ fileName: targetFilePath, compression: true });
}

async function validateExport(targetFilePath: string, format: ProjectBriefingExportFormat): Promise<void> {
  const file = await stat(targetFilePath);
  if (file.size < 2_000) throw new Error(`The generated ${format.toUpperCase()} file is unexpectedly small.`);
  const prefix = (await readFile(targetFilePath)).subarray(0, 4);
  if (format === "pdf" && prefix.toString("ascii") !== "%PDF") throw new Error("The generated file is not a valid PDF.");
  if (format === "pptx" && prefix.subarray(0, 2).toString("ascii") !== "PK") throw new Error("The generated file is not a valid PowerPoint package.");
}

export async function exportProjectBriefing(
  briefing: ProjectBriefing,
  format: ProjectBriefingExportFormat,
  targetFilePath: string
): Promise<void> {
  if (format === "pdf") await exportPdf(briefing, targetFilePath);
  else await exportPptx(briefing, targetFilePath);
  await validateExport(targetFilePath, format);
}

export { briefingExportHtml };
