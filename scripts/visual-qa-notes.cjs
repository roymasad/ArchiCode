const { app, BrowserWindow } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const rendererHtml = path.join(repoRoot, "out", "renderer", "index.html");
const outputDir = path.join(repoRoot, "artifacts", "visual-qa");
const outputFile = path.join(outputDir, "notes-focused-dark.png");

app.commandLine.appendSwitch("disable-gpu");
app.on("window-all-closed", () => {});

function withTimeout(label, promise, ms = 12000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}

app.whenReady()
  .then(async () => {
    await mkdir(outputDir, { recursive: true });
    const win = new BrowserWindow({
      width: 1440,
      height: 960,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: `visual-qa-notes-${Date.now()}`
      }
    });

    win.webContents.on("console-message", (_event, level, message) => {
      console.log(`[notes-focused:renderer:${level}] ${message}`);
    });

    try {
      await withTimeout("load", win.loadFile(rendererHtml, { query: { visualQa: "dense" } }));
      await withTimeout("setup", win.webContents.executeJavaScript(`
        (async () => {
          const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          localStorage.setItem("archicode-theme", "dark");
          document.documentElement.dataset.theme = "dark";
          await delay(700);
          document.querySelector('.node-list-row')?.click();
          await delay(250);
          if (!document.querySelector('.unified-right-sidebar')) {
            document.querySelector('.collapsed-panel-restore:not(.collapsed-panel-restore-left), .toolbar-right-sidebar-restore')?.click();
            await delay(250);
          }
          const inspector = document.querySelector('.inspector');
          const notesTab = Array.from(inspector?.querySelectorAll('button, [role="tab"]') ?? [])
            .find((item) => item.textContent?.trim() === "Notes");
          if (!notesTab) {
            throw new Error("Notes tab trigger not found.");
          }
          notesTab.focus();
          notesTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
          notesTab.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
          notesTab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
          notesTab.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
          notesTab.click();
          await delay(450);
          const activeTab = Array.from(inspector.querySelectorAll('[role="tab"]'))
            .find((item) => item.getAttribute("aria-selected") === "true" || item.getAttribute("data-state") === "active");
          if (!activeTab?.textContent?.includes("Notes")) {
            throw new Error("Notes tab did not become active. Active tab: " + (activeTab?.textContent?.trim() ?? "none"));
          }
        })();
      `));

      const metrics = await withTimeout("metrics", win.webContents.executeJavaScript(`
        (() => {
          const tab = document.querySelector('.notes-tab');
          const layout = document.querySelector('.notes-panel-layout');
          const main = document.querySelector('.notes-main-scroll');
          const composer = document.querySelector('.notes-compose-panel');
          const actionRow = document.querySelector('.notes-compose-panel .action-row');
          const dock = document.querySelector('.dock-slot-inspector');
          const unified = document.querySelector('.unified-right-sidebar');
          const inspector = document.querySelector('.inspector');
          const inspectorTabs = document.querySelector('.inspector-tabs');
          const rect = (element) => {
            if (!element) return null;
            const box = element.getBoundingClientRect();
            return {
              top: Math.round(box.top),
              bottom: Math.round(box.bottom),
              height: Math.round(box.height),
              left: Math.round(box.left),
              right: Math.round(box.right),
              width: Math.round(box.width)
            };
          };
          const tabRect = rect(tab);
          const composerRect = rect(composer);
          return {
            tab: tabRect,
            dock: rect(dock),
            unified: rect(unified),
            inspector: rect(inspector),
            inspectorTabs: rect(inspectorTabs),
            layout: rect(layout),
            main: rect(main),
            composer: composerRect,
            actionRow: rect(actionRow),
            bottomGap: tabRect && composerRect ? Math.round(tabRect.bottom - composerRect.bottom) : null,
            visibleText: document.body.innerText.includes("New note")
          };
        })();
      `));

      console.log(JSON.stringify(metrics, null, 2));
      const image = await withTimeout("capture", win.webContents.capturePage());
      await writeFile(outputFile, image.toPNG());
      console.log(outputFile);
      app.exit(metrics.bottomGap !== null && metrics.bottomGap <= 18 ? 0 : 2);
    } finally {
      win.destroy();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
