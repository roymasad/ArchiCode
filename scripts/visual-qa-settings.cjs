const { app, BrowserWindow } = require("electron");
const { mkdir, readdir, stat, unlink, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const rendererHtml = path.join(repoRoot, "out", "renderer", "index.html");
const outputDir = path.join(repoRoot, "artifacts", "visual-qa", "settings");
const electronDataDir = path.join(repoRoot, "artifacts", "visual-qa", "electron-user-data", "settings");

const tabs = [
  { value: "general", label: "General", file: "settings-general-dark.png" },
  { value: "providers", label: "LLM Providers", file: "settings-llm-providers-dark.png" },
  { value: "commands", label: "Build Targets", file: "settings-build-targets-dark.png" },
  { value: "agent-memory", label: "Agent Instructions", file: "settings-agent-instructions-dark.png" },
  { value: "security", label: "Security", file: "settings-security-dark.png" },
  { value: "context", label: "Context", file: "settings-context-dark.png" },
  { value: "policy", label: "LLM Policy", file: "settings-llm-policy-dark.png" },
  { value: "capabilities", label: "Capabilities", file: "settings-capabilities-dark.png" },
  { value: "advanced", label: "Advanced", file: "settings-advanced-dark.png" }
];

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

async function captureTab(win, tab) {
  await withTimeout(`open ${tab.label}`, win.webContents.executeJavaScript(`
    (async () => {
      window.dispatchEvent(new CustomEvent("archicode:open-project-settings", { detail: { tab: ${JSON.stringify(tab.value)} } }));
      await new Promise((resolve) => setTimeout(resolve, 650));
      const activeTab = document.querySelector('.settings-tabs [aria-selected="true"], .settings-tabs [data-state="active"][role="tab"]');
      if (!document.querySelector('.settings-modal')) throw new Error("Settings modal did not open.");
      if (!activeTab?.textContent?.trim().includes(${JSON.stringify(tab.label)})) {
        throw new Error(${JSON.stringify(`Expected active settings tab: ${tab.label}`)});
      }
    })();
  `));
  await wait(250);

  const metrics = await withTimeout(`measure ${tab.label}`, win.webContents.executeJavaScript(`
    (() => {
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      };
      const modal = document.querySelector('.settings-modal');
      const tabList = document.querySelector('.settings-tabs [role="tablist"]');
      const activePanel = document.querySelector('.settings-tab-content[data-state="active"]') ?? Array.from(document.querySelectorAll('.settings-tab-content'))
        .find((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        });
      if (!modal || !tabList || !activePanel) throw new Error("Settings QA could not find the active tab panel.");
      const nestedScrollables = Array.from(activePanel.querySelectorAll("*"))
        .filter((element) => {
          const tag = element.tagName.toLowerCase();
          if (tag === "textarea") return false;
          const style = window.getComputedStyle(element);
          const overflow = [style.overflow, style.overflowX, style.overflowY].join(" ");
          if (!/(auto|scroll)/.test(overflow)) return false;
          return element.scrollHeight > element.clientHeight + 2 || element.scrollWidth > element.clientWidth + 2;
        })
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          className: String(element.className || ""),
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth
        }));
      return {
        label: ${JSON.stringify(tab.label)},
        modal: rectOf(modal),
        tabsRoot: rectOf(document.querySelector('.settings-tabs')),
        tabList: rectOf(tabList),
        panel: rectOf(activePanel),
        panelParent: activePanel.parentElement ? {
          className: String(activePanel.parentElement.className || ""),
          rect: rectOf(activePanel.parentElement)
        } : null,
        computed: {
          tabsDisplay: window.getComputedStyle(document.querySelector('.settings-tabs')).display,
          panelDisplay: window.getComputedStyle(activePanel).display,
          panelFlex: window.getComputedStyle(activePanel).flex,
          panelHeight: window.getComputedStyle(activePanel).height,
          panelPosition: window.getComputedStyle(activePanel).position
        },
        scrollHeight: activePanel.scrollHeight,
        clientHeight: activePanel.clientHeight,
        nestedScrollables
      };
    })();
  `));

  let image = await withTimeout(`capture ${tab.label}`, win.webContents.capturePage());
  for (let attempt = 0; attempt < 3 && image.toPNG().length === 0; attempt += 1) {
    await wait(350);
    image = await withTimeout(`capture retry ${tab.label}`, win.webContents.capturePage());
  }
  const target = path.join(outputDir, tab.file);
  await writeFile(target, image.toPNG());
  const info = await stat(target);
  if (info.size < 10_000) {
    throw new Error(`Screenshot for ${tab.label} was unexpectedly small.`);
  }
  return { ...metrics, file: target };
}

function assertUnified(metrics) {
  const failures = [];
  const [baseline] = metrics;
  for (const item of metrics) {
    for (const key of ["top", "left", "right", "bottom", "width", "height"]) {
      if (Math.abs(item.panel[key] - baseline.panel[key]) > 2) {
        failures.push(`${item.label} panel ${key}=${item.panel[key]} differs from ${baseline.label} ${baseline.panel[key]}`);
      }
    }
    if (item.nestedScrollables.length > 0) {
      failures.push(`${item.label} has nested scroll containers: ${item.nestedScrollables.map((entry) => entry.className || entry.tag).join(", ")}`);
    }
    if (item.panel.height < 260) {
      failures.push(`${item.label} panel height=${item.panel.height} is too short for a settings tab`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Settings visual QA failed:\n${failures.join("\n")}`);
  }
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
        partition: `visual-qa-settings-${Date.now()}`
      }
    });

    win.webContents.on("console-message", (_event, level, message) => {
      console.log(`[settings-qa:renderer:${level}] ${message}`);
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

      const metrics = [];
      for (const tab of tabs) {
        console.log(`Capturing ${tab.label}...`);
        metrics.push(await captureTab(win, tab));
      }
      const reportFile = path.join(outputDir, "settings-tabs-report.json");
      await writeFile(reportFile, JSON.stringify({ capturedAt: new Date().toISOString(), metrics }, null, 2));
      assertUnified(metrics);

      console.log("Settings visual QA screenshots:");
      for (const item of metrics) console.log(`- ${item.file}`);
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
