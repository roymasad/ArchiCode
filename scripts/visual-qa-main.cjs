const { app, BrowserWindow } = require("electron");
const { mkdir, readdir, stat, unlink, writeFile } = require("node:fs/promises");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const rendererHtml = path.join(repoRoot, "out", "renderer", "index.html");
const outputDir = path.join(repoRoot, "artifacts", "visual-qa");
const docsAssetsDir = path.join(repoRoot, "docs", "assets");
const chatFocusOnly = process.argv.includes("--chat-focus-only");
const readmeShowcaseOnly = process.argv.includes("--readme-only");

if (!readmeShowcaseOnly) app.commandLine.appendSwitch("disable-gpu");
app.on("window-all-closed", () => {
  // Keep the QA process alive while it cycles through screenshot windows.
});

function withTimeout(label, promise, ms = 12000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}

async function capture(name, options = {}) {
  console.log(`Capturing ${name}...`);
  const win = new BrowserWindow({
    width: options.width ?? 1440,
    height: options.height ?? 960,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: `visual-qa-${name}-${Date.now()}`
    }
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`${name} failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });
  win.webContents.on("console-message", (_event, level, message) => {
    console.log(`[${name}:renderer:${level}] ${message}`);
  });

  try {
    await withTimeout(`${name} load`, win.loadFile(rendererHtml, { query: options.query ?? {} }));
    await withTimeout(`${name} theme`, win.webContents.executeJavaScript(`
      for (const key of Object.keys(localStorage)) {
        if (
          key.startsWith("archicode-layout:") ||
          key.startsWith("archicode-activity-tab:") ||
          key.startsWith("archicode-workbench:") ||
          key.startsWith("archicode-viewport:")
        ) {
          localStorage.removeItem(key);
        }
      }
      localStorage.setItem("archicode-theme", ${JSON.stringify(options.theme ?? "light")});
      document.documentElement.dataset.theme = ${JSON.stringify(options.theme ?? "light")};
    `));
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (options.script) {
      await withTimeout(`${name} scenario`, win.webContents.executeJavaScript(options.script));
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const bodyText = await withTimeout(`${name} body check`, win.webContents.executeJavaScript("document.body.innerText"));
    const expectedBodyText = options.expectedBodyText === undefined ? "ArchiCode" : options.expectedBodyText;
    if (expectedBodyText === null ? !String(bodyText).trim() : !String(bodyText).includes(expectedBodyText)) {
      throw new Error(`Visual QA failed for ${name}: renderer did not load the expected UI.`);
    }

    const image = await withTimeout(`${name} capture`, win.webContents.capturePage());
    const png = image.toPNG();
    const target = path.join(outputDir, `${name}.png`);
    await writeFile(target, png);
    const info = await stat(target);
    if (info.size < 10_000) {
      throw new Error(`Visual QA failed for ${name}: screenshot was unexpectedly small.`);
    }
    if (options.docsAsset) {
      await mkdir(docsAssetsDir, { recursive: true });
      await writeFile(path.join(docsAssetsDir, options.docsAsset), png);
    }
    return target;
  } finally {
    win.destroy();
  }
}

async function clearScreenshots() {
  await mkdir(outputDir, { recursive: true });
  const entries = await readdir(outputDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
    .map((entry) => unlink(path.join(outputDir, entry.name))));
}

app.whenReady()
  .then(async () => {
    await clearScreenshots();
    const files = [];
    const populatedPanelsScript = `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.querySelector('.node-list-row')?.click();
        await delay(250);
        if (!document.querySelector('.activity-panel.is-open')) {
          document.querySelector('button[title="Expand activity panel"]')?.click();
          await delay(250);
        }
        if (!document.querySelector('.unified-right-sidebar')) {
          document.querySelector('.collapsed-panel-restore:not(.collapsed-panel-restore-left), .toolbar-right-sidebar-restore')?.click();
          await delay(250);
        }
      })();
    `;
    const withMockPanels = (extra = "") => `
      (async () => {
        ${populatedPanelsScript}
        await new Promise((resolve) => setTimeout(resolve, 550));
        const activityPanel = document.querySelector('.activity-panel');
        if (activityPanel) activityPanel.style.height = "420px";
        ${extra}
      })();
    `;
    const activityTabScript = (tab) => withMockPanels(`
      window.dispatchEvent(new CustomEvent("archicode:set-activity-tab", { detail: ${JSON.stringify(tab)} }));
    `);
    const settingsTabScript = (tabValue, tabLabel) => withMockPanels(`
      window.dispatchEvent(new CustomEvent("archicode:open-project-settings", { detail: { tab: ${JSON.stringify(tabValue)} } }));
      await new Promise((resolve) => setTimeout(resolve, 650));
      if (!document.querySelector('.settings-modal')) {
        throw new Error("Settings modal did not open for visual QA.");
      }
      const activeTab = document.querySelector('.settings-tabs [aria-selected="true"], .settings-tabs [data-state="active"]');
      if (!activeTab?.textContent?.trim().includes(${JSON.stringify(tabLabel)})) {
        throw new Error(${JSON.stringify(`Settings tab not found: ${tabLabel}`)});
      }
    `);

    if (readmeShowcaseOnly) {
      const collapseActivity = `
        const openActivityPanel = document.querySelector('.activity-panel.is-open');
        if (openActivityPanel) {
          const activityButtons = [...document.querySelectorAll('.activity-panel-header button')];
          const collapseActivityButton = activityButtons.find((button) =>
            /Collapse activity panel/.test(button.getAttribute('title') || button.getAttribute('aria-label') || '')
          ) || activityButtons.at(-1);
          collapseActivityButton?.click();
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (document.querySelector('.activity-panel.is-open')) throw new Error('Activity panel did not collapse.');
      `;
      files.push(await capture("readme-overview", {
        theme: "dark",
        width: 1600,
        height: 1000,
        query: { visualQa: "showcase" },
        docsAsset: "archicode-overview.png",
        script: `(async () => {
          ${collapseActivity}
          document.body.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'e',
            code: 'KeyE',
            metaKey: true,
            shiftKey: true,
            bubbles: true
          }));
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (!document.querySelector('.inspector')) throw new Error('Properties tab did not activate.');
          const knowledgeRow = [...document.querySelectorAll('.node-list-row')]
            .find((row) => row.textContent?.includes('Architecture Knowledge Map'));
          knowledgeRow?.click();
          document.querySelector('button[aria-label="Fit view"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 650));
          if (!document.body.innerText.includes('Visual Architecture')) throw new Error('Showcase overview did not load.');
        })()`
      }));
      files.push(await capture("readme-3d-layers", {
        theme: "dark",
        width: 1600,
        height: 1000,
        query: { visualQa: "showcase" },
        docsAsset: "archicode-3d-layers.png",
        script: `(async () => {
          ${collapseActivity}
          document.querySelector('.canvas-3d-toggle')?.click();
          await new Promise((resolve) => setTimeout(resolve, 800));
          const overview = [...document.querySelectorAll('.flow-3d-mode-btn')]
            .find((button) => button.textContent?.trim() === 'Overview');
          overview?.click();
          document.querySelector('.flow-3d-corner-controls button')?.click();
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (!document.querySelector('.flow-3d-webgl') || !document.body.innerText.includes('All layers')) {
            throw new Error('Multi-layer 3D showcase did not load.');
          }
          if (document.querySelector('.flow-3d-fallback')) throw new Error(document.querySelector('.flow-3d-fallback').textContent);
        })()`
      }));
      files.push(await capture("readme-knowledge-map", {
        theme: "dark",
        width: 1600,
        height: 1000,
        query: { visualQa: "showcase-knowledge" },
        expectedBodyText: null,
        docsAsset: "archicode-knowledge-map.png",
        script: `(async () => {
          ${collapseActivity}
          document.querySelector('.canvas-knowledge-toggle')?.click();
          await new Promise((resolve) => setTimeout(resolve, 600));
          window.dispatchEvent(new CustomEvent('archicode:toggle-focus-mode'));
          await new Promise((resolve) => setTimeout(resolve, 600));
          const guideToggle = document.querySelector('.knowledge-map-toolbar button[aria-pressed="true"]');
          if (!guideToggle) throw new Error('Knowledge-map guide control was not available.');
          guideToggle.click();
          document.querySelector('.knowledge-map-edge')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 650));
          if (!document.body.innerText.includes('Architecture Knowledge Communities') || !document.body.innerText.includes('Communities')) {
            throw new Error('Architecture knowledge-map showcase did not load.');
          }
          if (document.querySelector('.knowledge-map-guide')) throw new Error('Knowledge-map guide did not collapse.');
        })()`
      }));
      files.push(await capture("readme-research-chat", {
        theme: "dark",
        width: 1600,
        height: 1000,
        query: { visualQa: "showcase-chat" },
        expectedBodyText: null,
        docsAsset: "archicode-research-chat.png",
        script: `(async () => {
          ${collapseActivity}
          document.querySelector('[role="tab"][aria-label="Chat"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 400));
          const focusToggle = document.querySelector('.research-focus-toggle');
          if (!focusToggle) throw new Error('Research focus control was not available.');
          focusToggle.click();
          await new Promise((resolve) => setTimeout(resolve, 800));
          if (!document.querySelector('.research-message-list') || !document.querySelector('.research-change-set')) {
            throw new Error('Populated Research showcase did not load.');
          }
        })()`
      }));
      console.log("README showcase screenshots:");
      for (const file of files) console.log(`- ${file}`);
      app.exit(0);
      return;
    }

    files.push(await capture("start-dark", { theme: "dark" }));
    files.push(await capture("mock-panels-light", {
      theme: "light",
      query: { visualQa: "dense" },
      script: populatedPanelsScript
    }));
    files.push(await capture("mock-panels-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: populatedPanelsScript
    }));
    files.push(await capture("chat-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: withMockPanels(`
        document.querySelector('[data-testid="research-button"]')?.click();
      `)
    }));
    files.push(await capture("chat-focus-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      expectedBodyText: null,
      script: withMockPanels(`
        const chatTab = document.querySelector('[role="tab"][aria-label="Chat"]');
        if (!document.querySelector('.research-focus-toggle')) {
          chatTab?.click();
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const focusToggle = document.querySelector('.research-focus-toggle');
        if (!focusToggle) throw new Error("Chat focus toggle was not available for visual QA.");
        focusToggle.click();
        await new Promise((resolve) => setTimeout(resolve, 350));
        if (!document.querySelector('.app-shell.chat-focus-mode')) {
          throw new Error("Chat focus mode did not expand the chat surface.");
        }
        if (!document.querySelector('.research-focus-history')) {
          throw new Error("Chat history rail was not visible in focus mode.");
        }
        const composer = document.querySelector('.chat-composer-input');
        if (!composer || composer.getBoundingClientRect().height > 64) {
          throw new Error("Focus-mode composer did not render at its compact height.");
        }
      `)
    }));
    if (chatFocusOnly) {
      console.log("Visual QA screenshots:");
      for (const file of files) console.log(`- ${file}`);
      app.exit(0);
      return;
    }
    files.push(await capture("queue-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: activityTabScript("runs")
    }));
    files.push(await capture("trace-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: activityTabScript("trace")
    }));
    files.push(await capture("errors-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: activityTabScript("errors")
    }));
    files.push(await capture("console-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: activityTabScript("console")
    }));
    files.push(await capture("git-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: activityTabScript("git")
    }));
    files.push(await capture("settings-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: settingsTabScript("general", "General")
    }));
    files.push(await capture("settings-llm-providers-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: settingsTabScript("providers", "LLM Providers")
    }));
    files.push(await capture("settings-llm-policy-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: settingsTabScript("policy", "LLM Policy")
    }));
    files.push(await capture("settings-capabilities-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: settingsTabScript("capabilities", "Capabilities")
    }));
    files.push(await capture("settings-advanced-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: settingsTabScript("advanced", "Advanced")
    }));
    files.push(await capture("plan-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: activityTabScript("plans")
    }));
    files.push(await capture("source-changes-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: activityTabScript("diffs")
    }));
    files.push(await capture("artifacts-dark", {
      theme: "dark",
      query: { visualQa: "dense" },
      script: activityTabScript("artifacts")
    }));

    console.log("Visual QA screenshots:");
    for (const file of files) console.log(`- ${file}`);
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
