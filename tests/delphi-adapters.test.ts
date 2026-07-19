import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalizeDelphiPlaywrightActions, runDelphiPlaywrightFlow } from "../src/main/testing/playwrightAdapter";
import { runDelphiAppiumFlow } from "../src/main/testing/appiumAdapter";
import { runDelphiMobileTargetFlow } from "../src/main/testing/mobileTargetAdapter";
import { delphiManagedBrowsersPath, inspectDelphiManagedTool, setDelphiToolCacheRoot } from "../src/main/testing/toolCache";

afterEach(() => {
  vi.unstubAllGlobals();
  setDelphiToolCacheRoot(null);
});

describe("Delphi direct runtime adapters", () => {
  it("rejects unknown Playwright action names instead of silently taking blank screenshots", async () => {
    await expect(runDelphiPlaywrightFlow("/tmp/archicode-delphi-invalid-action", {
      baseUrl: "http://127.0.0.1:4173",
      capture: "key-steps",
      actions: [{ action: "hover", selector: "nav" } as never]
    })).rejects.toThrow(/Unsupported Playwright action "hover"/);
  });

  it("canonicalizes only exact safe action aliases and leaves everything else strict", () => {
    expect(canonicalizeDelphiPlaywrightActions([
      { type: "navigate", path: "/about" } as never,
      { type: "assert-url", expectedPath: "/about" } as never,
      { action: "assert-no-console-errors" } as never,
      { action: "assert-no-page-errors" } as never,
      { type: "fill", selector: "#q", value: "hello" } as never,
      { action: "goto", value: "/keep", path: "/ignored" } as never,
      { action: "hover", selector: "nav" } as never
    ])).toEqual([
      { action: "goto", value: "/about" },
      { action: "assert-url", value: "/about" },
      { action: "assert-no-runtime-errors" },
      { action: "assert-no-runtime-errors" },
      { action: "fill", selector: "#q", value: "hello" },
      { action: "goto", value: "/keep", path: "/ignored" },
      { action: "hover", selector: "nav" }
    ]);
  });

  it("executes a prompted-contract alias payload through the strict validator", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-playwright-alias-"));
    const moduleRoot = path.join(root, "node_modules", "playwright");
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }), "utf8");
    await writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ name: "playwright", version: "1.2.3", main: "index.cjs" }), "utf8");
    await writeFile(path.join(moduleRoot, "index.cjs"), `
function browserType() {
  return {
    async launch() {
      let currentUrl = "about:blank";
      const page = {
        setDefaultTimeout() {},
        on() {},
        async goto(url) { currentUrl = url; },
        locator() {
          return { async count() { return 1; }, async isVisible() { return true; } };
        },
        url() { return currentUrl; },
        async title() { return "Fixture"; }
      };
      return { async newPage() { return page; }, async close() {} };
    }
  };
}
exports.chromium = browserType(); exports.firefox = browserType(); exports.webkit = browserType();
`, "utf8");

    const result = await runDelphiPlaywrightFlow(root, {
      baseUrl: "http://127.0.0.1:4173",
      capture: "none",
      actions: [
        { type: "navigate", path: "/checkout" } as never,
        { type: "assert-url", expectedPath: "/checkout" } as never,
        { action: "assert-no-console-errors" } as never
      ]
    });

    expect(result.status).toBe("passed");
    expect(result.actions.map((action) => action.action)).toEqual(["goto", "assert-url", "assert-no-runtime-errors"]);
    expect(result.finalUrl).toBe("http://127.0.0.1:4173/checkout");
  });

  it("rejects explicit screenshot plans that cannot fit before launching a browser", async () => {
    await expect(runDelphiPlaywrightFlow("/tmp/archicode-delphi-budget", {
      baseUrl: "http://127.0.0.1:4173",
      capture: "none",
      actions: [
        { action: "screenshot" },
        { action: "screenshot" },
        { action: "screenshot" }
      ]
    }, { maxArtifacts: 2 })).rejects.toThrow(/evidence budget of 2/);
  });

  it("runs a bounded same-origin Playwright flow and persists screenshot evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-playwright-"));
    const moduleRoot = path.join(root, "node_modules", "playwright");
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }), "utf8");
    await writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ name: "playwright", version: "1.2.3", main: "index.cjs" }), "utf8");
    await writeFile(path.join(moduleRoot, "index.cjs"), `
function browserType() {
  return {
    async launch(options) {
      require("fs").writeFileSync(${JSON.stringify(path.join(root, "playwright-launch.json"))}, JSON.stringify(options));
      let currentUrl = "about:blank";
      const page = {
        setDefaultTimeout() {},
        on() {},
        async goto(url) { currentUrl = url; },
        locator(selector) {
          return {
            async click() {}, async fill() {}, async press() {}, async waitFor() {},
            async isVisible() { return true; },
            async textContent() { return selector === "h1" ? "Welcome Delphi" : ""; }
          };
        },
        async evaluate() { return { contentWidth: 390, viewportWidth: 390 }; },
        async setViewportSize() {},
        async screenshot() { return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); },
        url() { return currentUrl; },
        async title() { return "Fixture"; }
      };
      return { async newPage() { return page; }, async close() {} };
    }
  };
}
exports.chromium = browserType(); exports.firefox = browserType(); exports.webkit = browserType();
`, "utf8");

    const observed: string[] = [];
    const executionStarted = vi.fn();
    const result = await runDelphiPlaywrightFlow(root, {
      baseUrl: "http://127.0.0.1:4173",
      observationMode: "visible",
      capture: "key-steps",
      actions: [
        { action: "goto", value: "/checkout" },
        { action: "assert-url", value: "/checkout" },
        { action: "assert-text", selector: "h1", value: "Delphi" },
        { action: "set-viewport", width: 390, height: 844 },
        { action: "assert-no-horizontal-overflow" },
        { action: "assert-no-runtime-errors" },
        { action: "screenshot", label: "checkout-mobile", purpose: "Document the verified mobile checkout state" }
      ]
    }, { maxArtifacts: 2, onExecutionStart: executionStarted, onArtifact: (artifact) => observed.push(artifact.id) });

    expect(result).toMatchObject({ status: "passed", browser: "chromium", finalUrl: "http://127.0.0.1:4173/checkout", title: "Fixture" });
    expect(result.actions).toHaveLength(7);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.path).toContain(".archicode/artifacts/delphi/");
    expect(JSON.parse(await readFile(path.join(root, "playwright-launch.json"), "utf8"))).toMatchObject({ headless: false, slowMo: 120 });
    expect(observed).toEqual(result.artifacts.map((artifact) => artifact.id));
    expect(executionStarted).toHaveBeenCalledTimes(1);
    expect(result.actions.map((action) => action.action)).toEqual(expect.arrayContaining([
      "assert-url",
      "assert-no-horizontal-overflow",
      "assert-no-runtime-errors"
    ]));
    await expect(access(path.join(root, result.artifacts[0]!.path))).resolves.toBeUndefined();
    await expect(access(path.join(root, ".archicode", "artifacts", `${result.artifacts[0]!.id}.json`))).resolves.toBeUndefined();
  });

  it("fails a bounded runtime-health assertion when the page reports a broken resource", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-playwright-runtime-error-"));
    const moduleRoot = path.join(root, "node_modules", "playwright");
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }), "utf8");
    await writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ name: "playwright", main: "index.cjs" }), "utf8");
    await writeFile(path.join(moduleRoot, "index.cjs"), `
const page = {
  setDefaultTimeout() {},
  on(event, handler) { if (event === "response") handler({ status() { return 404; }, url() { return "http://127.0.0.1:4173/missing.css"; } }); },
  async goto() {}, url() { return "http://127.0.0.1:4173/"; }, async title() { return ""; }
};
const type = { async launch() { return { async newPage() { return page; }, async close() {} }; } };
exports.chromium = type; exports.firefox = type; exports.webkit = type;
`, "utf8");

    await expect(runDelphiPlaywrightFlow(root, {
      baseUrl: "http://127.0.0.1:4173",
      actions: [{ action: "goto" }, { action: "assert-no-runtime-errors" }]
    })).rejects.toThrow(/404.*missing\.css/);
  });

  it("rejects Playwright navigation away from the approved origin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-playwright-origin-"));
    const moduleRoot = path.join(root, "node_modules", "playwright");
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }), "utf8");
    await writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ name: "playwright", main: "index.cjs" }), "utf8");
    await writeFile(path.join(moduleRoot, "index.cjs"), "const t={launch:async()=>({newPage:async()=>({setDefaultTimeout(){},on(){},url(){return 'about:blank'},title:async()=>''}),close:async()=>{}})};exports.chromium=t;exports.firefox=t;exports.webkit=t;", "utf8");

    await expect(runDelphiPlaywrightFlow(root, {
      baseUrl: "http://127.0.0.1:4173",
      actions: [{ action: "goto", value: "https://example.com" }]
    })).rejects.toThrow(/approved origin/);
  });

  it("rejects an interaction that navigates away from the approved origin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-playwright-click-origin-"));
    const moduleRoot = path.join(root, "node_modules", "playwright");
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }), "utf8");
    await writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ name: "playwright", main: "index.cjs" }), "utf8");
    await writeFile(path.join(moduleRoot, "index.cjs"), `
let currentUrl = "about:blank";
const page = { setDefaultTimeout() {}, on() {}, async goto(url) { currentUrl = url; }, locator() { return { async click() { currentUrl = "https://example.com/escaped"; } }; }, url() { return currentUrl; }, async title() { return ""; } };
const type = { async launch() { return { async newPage() { return page; }, async close() {} }; } };
exports.chromium = type; exports.firefox = type; exports.webkit = type;
`, "utf8");

    await expect(runDelphiPlaywrightFlow(root, {
      baseUrl: "http://127.0.0.1:4173",
      actions: [{ action: "goto" }, { action: "click", selector: "a.external" }]
    })).rejects.toThrow(/left the approved origin/);
  });

  it("closes and rejects a popup that escapes the approved origin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-playwright-popup-origin-"));
    const moduleRoot = path.join(root, "node_modules", "playwright");
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }), "utf8");
    await writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ name: "playwright", main: "index.cjs" }), "utf8");
    await writeFile(path.join(moduleRoot, "index.cjs"), `
let currentUrl = "about:blank";
let openedPageHandler;
const page = {
  setDefaultTimeout() {},
  on() {},
  async goto(url) { currentUrl = url; },
  locator() {
    return { async click() {
      const popup = {
        url() { return "https://example.com/popup"; },
        on() {},
        async close() { require("fs").writeFileSync(${JSON.stringify(path.join(root, "popup-closed.txt"))}, "yes"); }
      };
      openedPageHandler(popup);
    } };
  },
  url() { return currentUrl; },
  async title() { return ""; }
};
const context = {
  async route() {},
  on(event, handler) { if (event === "page") openedPageHandler = handler; },
  async newPage() { return page; }
};
const type = { async launch() { return { async newContext() { return context; }, async newPage() { return page; }, async close() {} }; } };
exports.chromium = type; exports.firefox = type; exports.webkit = type;
`, "utf8");

    await expect(runDelphiPlaywrightFlow(root, {
      baseUrl: "http://127.0.0.1:4173",
      actions: [{ action: "goto" }, { action: "click", selector: "a.popup" }]
    })).rejects.toThrow(/blocked top-level navigation outside the approved origin/);
    await expect(access(path.join(root, "popup-closed.txt"))).resolves.toBeUndefined();
  });

  it("controls an explicit localhost Appium session and stores screenshot evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-appium-"));
    const screenshot = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      const value = url.endsWith("/element")
        ? { "element-6066-11e4-a52e-4f735466cecf": "element-1" }
        : url.endsWith("/text")
          ? "Welcome Delphi"
          : url.endsWith("/screenshot")
            ? screenshot
            : null;
      return new Response(JSON.stringify({ value }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runDelphiAppiumFlow(root, {
      serverUrl: "http://127.0.0.1:4723/wd/hub",
      sessionId: "session-1",
      actions: [
        { action: "click", using: "accessibility id", selector: "Continue" },
        { action: "assert-text", using: "accessibility id", selector: "Title", value: "Delphi" },
        { action: "screenshot", label: "mobile-home" }
      ]
    });

    expect(result).toMatchObject({ status: "passed", sessionId: "session-1" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await expect(access(path.join(root, result.artifacts[0]!.path))).resolves.toBeUndefined();
  });

  it("rejects non-local Appium servers", async () => {
    await expect(runDelphiAppiumFlow("/tmp/project", {
      serverUrl: "https://example.com/wd/hub",
      sessionId: "session-1",
      actions: [{ action: "source" }]
    })).rejects.toThrow(/localhost/);
  });

  it("audits an explicit Android target with native readiness, interaction, UI assertions, and screenshot evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-android-target-"));
    const calls: string[] = [];
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const result = await runDelphiMobileTargetFlow(root, {
      platform: "android",
      deviceId: "emulator-5554",
      actions: [
        { action: "assert-device-ready" },
        { action: "tap", x: 120, y: 240 },
        { action: "assert-text", value: "Welcome" },
        { action: "screenshot", label: "android-home" }
      ]
    }, {
      runStep: async (command, args) => {
        calls.push([command, ...args].join(" "));
        const stdout = args.includes("get-state")
          ? Buffer.from("device\n")
          : args.includes("uiautomator")
            ? Buffer.from('<hierarchy><node text="Welcome" /></hierarchy>')
            : args.includes("screencap")
              ? png
              : Buffer.alloc(0);
        return { exitCode: 0, stdout, stderr: "" };
      }
    });

    expect(result).toMatchObject({ status: "passed", platform: "android", deviceId: "emulator-5554" });
    expect(calls.some((call) => call.includes("input tap 120 240"))).toBe(true);
    await expect(access(path.join(root, result.artifacts[0]!.path))).resolves.toBeUndefined();
  });

  it("captures evidence from an explicit iOS simulator without requiring Appium", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-ios-target-"));
    const deviceId = "A1B2-C3D4";
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const result = await runDelphiMobileTargetFlow(root, {
      platform: "ios",
      deviceId,
      actions: [{ action: "assert-device-ready" }, { action: "screenshot", label: "ios-home" }, { action: "open-url", value: "https://example.test/path" }]
    }, {
      runStep: async (_command, args) => {
        if (args.includes("screenshot")) await writeFile(args.at(-1)!, png);
        return {
          exitCode: 0,
          stdout: Buffer.from(args.includes("booted") ? JSON.stringify({ devices: { iOS: [{ udid: deviceId, state: "Booted" }] } }) : ""),
          stderr: ""
        };
      }
    });

    expect(result).toMatchObject({ status: "passed", platform: "ios", deviceId });
    await expect(access(path.join(root, result.artifacts[0]!.path))).resolves.toBeUndefined();
  });

  it("discovers a managed adapter without changing project dependencies", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-delphi-project-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "archicode-delphi-cache-"));
    setDelphiToolCacheRoot(cacheRoot);
    const packageRoot = path.join(cacheRoot, "delphi-tools", "playwright-v1", "node_modules", "playwright");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "playwright", version: "9.9.9" }), "utf8");

    await expect(inspectDelphiManagedTool(projectRoot, "playwright")).resolves.toMatchObject({ installed: true, version: "9.9.9" });
    await expect(access(path.join(projectRoot, "package.json"))).rejects.toThrow();
  });

  it("loads managed Playwright while its private browser path is active", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-delphi-managed-project-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "archicode-delphi-managed-cache-"));
    setDelphiToolCacheRoot(cacheRoot);
    const moduleRoot = path.join(cacheRoot, "delphi-tools", "playwright-v1", "node_modules", "playwright");
    const expectedBrowsersPath = delphiManagedBrowsersPath(projectRoot);
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ name: "playwright", version: "1.2.3", main: "index.cjs" }), "utf8");
    await writeFile(path.join(moduleRoot, "index.cjs"), `
const capturedBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
function browserType() {
  return { async launch() {
    if (capturedBrowsersPath !== ${JSON.stringify(expectedBrowsersPath)}) throw new Error("managed browser path was not active during module load");
    const page = { setDefaultTimeout() {}, on() {}, async goto(url) { this.currentUrl = url; }, currentUrl: "about:blank", url() { return this.currentUrl; }, async title() { return "Managed"; } };
    return { async newPage() { return page; }, async close() {} };
  } };
}
exports.chromium = browserType(); exports.firefox = browserType(); exports.webkit = browserType();
`, "utf8");

    const result = await runDelphiPlaywrightFlow(projectRoot, {
      baseUrl: "http://127.0.0.1:4173/app",
      actions: [{ action: "goto" }]
    });

    expect(result.finalUrl).toBe("http://127.0.0.1:4173/app");
    expect(process.env.PLAYWRIGHT_BROWSERS_PATH).not.toBe(expectedBrowsersPath);
  });
});
