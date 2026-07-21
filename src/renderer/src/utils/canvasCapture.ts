import type { CanvasCaptureDestination, CanvasCaptureResult } from "../../../preload";

export type CanvasCaptureStatus = { tone: "success" | "error"; message: string };

export function canvasCaptureFileName(projectName: string, graphLabel: string, revisionLabel = "current"): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `archicode-${projectName}-${graphLabel}-${revisionLabel}-${timestamp}.png`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForExportStyles(): Promise<void> {
  await nextFrame();
  await nextFrame();
}

function visibleCanvasShell(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(".canvas-shell"))
    .find((item) => {
      const bounds = item.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    }) ?? null;
}

export async function captureCleanCanvasViewport(
  suggestedName: string,
  options?: { destination?: CanvasCaptureDestination },
  target?: HTMLElement | null
): Promise<CanvasCaptureResult> {
  const canvas = target ?? visibleCanvasShell();
  if (!canvas || !window.archicode?.captureCanvasViewport) {
    throw new Error("The canvas viewport is not available to capture.");
  }
  document.documentElement.classList.add("is-canvas-capture-exporting");
  document.body.classList.add("is-canvas-capture-exporting");
  canvas.classList.add("is-canvas-capture-exporting");
  try {
    await waitForExportStyles();
    const bounds = canvas.getBoundingClientRect();
    return await window.archicode.captureCanvasViewport(
      { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      suggestedName,
      options
    );
  } finally {
    document.documentElement.classList.remove("is-canvas-capture-exporting");
    document.body.classList.remove("is-canvas-capture-exporting");
    canvas.classList.remove("is-canvas-capture-exporting");
  }
}

export async function captureVisibleCanvasViewport(suggestedName: string, target?: HTMLElement | null): Promise<CanvasCaptureStatus | null> {
  const result = await captureCleanCanvasViewport(suggestedName, undefined, target);
  if (result.canceled) return null;
  if (result.destination === "clipboard") {
    void window.archicode.showSystemNotification?.({
      title: "Canvas capture copied",
      body: "The visible canvas capture is on the clipboard."
    });
    return { tone: "success", message: "Copied to clipboard" };
  }
  if (result.destination === "data") {
    return { tone: "success", message: "Canvas capture returned" };
  }
  const place = result.destination === "custom" ? "selected folder" : "Downloads";
  void window.archicode.showSystemNotification?.({
    title: "Canvas capture saved",
    body: `Saved ${result.fileName} to ${place}.`
  });
  return { tone: "success", message: `Saved to ${place} · ${result.fileName}` };
}
