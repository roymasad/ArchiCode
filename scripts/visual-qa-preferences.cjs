const { app, BrowserWindow } = require("electron");
const { mkdir, readdir, stat, unlink, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const rendererHtml = path.join(repoRoot, "out", "renderer", "index.html");
const outputDir = path.join(repoRoot, "artifacts", "visual-qa", "preferences");
const electronDataDir = path.join(repoRoot, "artifacts", "visual-qa", "electron-user-data", "preferences");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.setPath("userData", electronDataDir);
app.setPath("sessionData", path.join(electronDataDir, "session"));
app.on("window-all-closed", () => {});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(label, promise, ms = 15000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}

async function clearOutput() {
  await mkdir(outputDir, { recursive: true });
  const entries = await readdir(outputDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".png") || entry.name.endsWith(".json")))
    .map((entry) => unlink(path.join(outputDir, entry.name))));
}

async function openPreferences(win) {
  await withTimeout("open Shortcuts tab", win.webContents.executeJavaScript(`
    (async () => {
      window.dispatchEvent(new CustomEvent("archicode:open-project-settings", { detail: { tab: "shortcuts" } }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (!document.querySelector('.settings-modal')) throw new Error("Settings modal did not open.");
      const triggers = Array.from(document.querySelectorAll('[role="tab"]'));
      const shortcutsTab = triggers.find((tab) => tab.textContent?.includes("Shortcuts"));
      if (!shortcutsTab) throw new Error("Shortcuts tab trigger not found in Settings modal.");
      const activeTab = document.querySelector('[role="tab"][data-state="active"], [role="tab"][aria-selected="true"]');
      if (!activeTab?.textContent?.includes("Shortcuts")) throw new Error("Shortcuts tab is not active.");
    })();
  `));
  await wait(300);
}

async function captureGroups(win) {
  const metrics = await withTimeout("measure groups", win.webContents.executeJavaScript(`
    (() => {
      const modal = document.querySelector('.settings-modal');
      if (!modal) throw new Error("Settings modal missing.");
      const groups = Array.from(document.querySelectorAll('.preferences-group')).map((group) => ({
        label: group.querySelector('h3')?.textContent?.trim() ?? "(untitled)",
        rows: group.querySelectorAll('.preferences-row').length
      }));
      const rows = document.querySelectorAll('.preferences-row').length;
      const filterInput = modal.querySelector('.preferences-filter-input');
      return {
        modalWidth: Math.round(modal.getBoundingClientRect().width),
        modalHeight: Math.round(modal.getBoundingClientRect().height),
        groupCount: groups.length,
        rows,
        groups,
        filterPresent: Boolean(filterInput)
      };
    })();
  `));
  return metrics;
}

app.whenReady()
  .then(async () => {
    await clearOutput();
    const win = new BrowserWindow({
      width: 1440,
      height: 960,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: `visual-qa-preferences-${Date.now()}`
      }
    });

    win.webContents.on("console-message", (_event, level, message) => {
      console.log(`[preferences-qa:renderer:${level}] ${message}`);
    });

    try {
      await withTimeout("load", win.loadURL(`${pathToFileURL(rendererHtml).toString()}?visualQa=dense`));
      await withTimeout("prepare", win.webContents.executeJavaScript(`
        for (const key of Object.keys(localStorage)) {
          if (
            key.startsWith("archicode-layout:") ||
            key.startsWith("archicode-activity-tab:") ||
            key.startsWith("archicode-workbench:") ||
            key.startsWith("archicode-viewport:") ||
            key === "archicode-ui-scale"
          ) {
            localStorage.removeItem(key);
          }
        }
        localStorage.setItem("archicode-theme", "dark");
        document.documentElement.dataset.theme = "dark";
      `));
      await wait(800);

      const bodyText = await withTimeout("body check", win.webContents.executeJavaScript("document.body.innerText"));
      if (!String(bodyText).includes("ArchiCode")) {
        throw new Error("Renderer did not load ArchiCode UI.");
      }

      await openPreferences(win);
      const metrics = await captureGroups(win);

      if (metrics.groupCount < 5) {
        throw new Error(`Expected at least 5 shortcut groups; found ${metrics.groupCount}.`);
      }
      if (metrics.rows < 30) {
        throw new Error(`Expected at least 30 shortcut rows; found ${metrics.rows}.`);
      }
      if (!metrics.filterPresent) {
        throw new Error("Filter input is missing from the Shortcuts tab.");
      }

      let image = await withTimeout("capture preferences", win.webContents.capturePage());
      for (let attempt = 0; attempt < 3 && image.toPNG().length === 0; attempt += 1) {
        await wait(350);
        image = await withTimeout(`capture retry`, win.webContents.capturePage());
      }
      const target = path.join(outputDir, "preferences-shortcuts-dark.png");
      await writeFile(target, image.toPNG());
      const info = await stat(target);
      if (info.size < 10_000) {
        throw new Error("Screenshot for Preferences Shortcuts tab was unexpectedly small.");
      }

      const reportFile = path.join(outputDir, "preferences-report.json");
      await writeFile(reportFile, JSON.stringify({ capturedAt: new Date().toISOString(), metrics }, null, 2));

      console.log("Preferences visual QA metrics:");
      console.log(JSON.stringify(metrics, null, 2));
      console.log(`Screenshot: ${target}`);
      console.log(`Report: ${reportFile}`);
      app.exit(0);
    } finally {
      win.destroy();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });