import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { delphiAdapterCacheRoot, delphiManagedBrowsersPath, inspectDelphiManagedTool } from "./toolCache";
import { persistDelphiScreenshot, type DelphiObservationArtifact } from "./evidenceArtifacts";

export type DelphiPlaywrightAction = {
  action: "goto" | "click" | "fill" | "press" | "wait-for" | "assert-text" | "assert-visible" | "assert-url" | "assert-no-runtime-errors" | "assert-no-horizontal-overflow" | "screenshot" | "set-viewport";
  selector?: string;
  value?: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  label?: string;
  purpose?: string;
  fullPage?: boolean;
  width?: number;
  height?: number;
};

export type DelphiPlaywrightFlowInput = {
  baseUrl: string;
  browser?: "chromium" | "firefox" | "webkit";
  actions: DelphiPlaywrightAction[];
  timeoutMs?: number;
  observationMode?: "visible" | "headless";
  capture?: "key-steps" | "final" | "none";
};

export type DelphiPlaywrightFlowResult = {
  status: "passed";
  browser: "chromium" | "firefox" | "webkit";
  finalUrl: string;
  title: string;
  actions: Array<{ index: number; action: DelphiPlaywrightAction["action"]; detail: string }>;
  artifacts: Array<{ id: string; label: string; path: string; mediaType: "image/png" }>;
  consoleErrors: string[];
  pageErrors: string[];
  requestErrors: string[];
};

type PlaywrightBrowser = {
  newPage: (options?: Record<string, unknown>) => Promise<any>;
  newContext?: (options?: Record<string, unknown>) => Promise<any>;
  close: () => Promise<void>;
};

type PlaywrightApi = Record<"chromium" | "firefox" | "webkit", { launch: (options: Record<string, unknown>) => Promise<PlaywrightBrowser> }>;
type ResolvedPlaywright = {
  load: () => Promise<PlaywrightApi>;
  browsersPath?: string;
  source: string;
};

const PLAYWRIGHT_ACTIONS = new Set<DelphiPlaywrightAction["action"]>([
  "goto", "click", "fill", "press", "wait-for", "assert-text", "assert-visible",
  "assert-url", "assert-no-runtime-errors", "assert-no-horizontal-overflow", "screenshot", "set-viewport"
]);

// Exact syntactic equivalents that prompted JSON tool contracts commonly emit.
// assert-no-console-errors/assert-no-page-errors map to the combined runtime
// assertion, which also covers failed resources: it can only fail more, never
// silently pass a flow the narrower assertion would have failed.
const PLAYWRIGHT_ACTION_NAME_ALIASES = new Map<string, DelphiPlaywrightAction["action"]>([
  ["navigate", "goto"],
  ["assert-no-console-errors", "assert-no-runtime-errors"],
  ["assert-no-page-errors", "assert-no-runtime-errors"]
]);

/**
 * Canonicalizes only safe, deterministic action aliases (`type` for the
 * `action` key, `navigate` for `goto`, `path`/`expectedPath` for a missing
 * URL `value`) into the strict action shape. Anything else is left untouched
 * for the strict validator to reject, so unknown behavior is never accepted.
 */
export function canonicalizeDelphiPlaywrightActions(actions: DelphiPlaywrightAction[]): DelphiPlaywrightAction[] {
  return actions.map((value) => {
    if (!value || typeof value !== "object") return value;
    const action = { ...(value as Record<string, unknown>) };
    if (action.action === undefined && typeof action.type === "string") {
      action.action = action.type;
      delete action.type;
    }
    if (typeof action.action === "string" && PLAYWRIGHT_ACTION_NAME_ALIASES.has(action.action)) {
      action.action = PLAYWRIGHT_ACTION_NAME_ALIASES.get(action.action)!;
    }
    if (action.action === "goto" || action.action === "assert-url") {
      for (const alias of ["path", "expectedPath"] as const) {
        if (action.value === undefined && typeof action[alias] === "string") {
          action.value = action[alias];
          delete action[alias];
        }
      }
    }
    return action as DelphiPlaywrightAction;
  });
}

let playwrightEnvironmentQueue: Promise<void> = Promise.resolve();

async function withPlaywrightEnvironment<T>(browsersPath: string | undefined, operation: () => Promise<T>): Promise<T> {
  const previous = playwrightEnvironmentQueue;
  let release!: () => void;
  playwrightEnvironmentQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const original = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersPath) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  try {
    return await operation();
  } finally {
    if (original === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = original;
    release();
  }
}

function playwrightApi(value: unknown): PlaywrightApi | undefined {
  if (!value || typeof value !== "object") return undefined;
  const module = value as Record<string, unknown>;
  const merged = module.default && typeof module.default === "object"
    ? { ...(module.default as Record<string, unknown>), ...module }
    : module;
  if (["chromium", "firefox", "webkit"].every((name) => {
    const browser = merged[name];
    return browser && typeof browser === "object" && typeof (browser as { launch?: unknown }).launch === "function";
  })) return merged as PlaywrightApi;
  return undefined;
}

async function loadPlaywright(resolvedPath: string): Promise<PlaywrightApi> {
  const api = playwrightApi(await import(pathToFileURL(resolvedPath).href));
  if (!api) throw new Error(`The Playwright module at ${resolvedPath} did not expose supported browser APIs.`);
  return api;
}

async function resolvePlaywright(projectRoot: string): Promise<ResolvedPlaywright> {
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  for (const packageName of ["playwright", "@playwright/test"]) {
    try {
      const resolved = projectRequire.resolve(packageName);
      return { load: () => loadPlaywright(resolved), source: `project:${packageName}` };
    } catch {
      // Try the next project or managed-cache package.
    }
  }
  const managed = await inspectDelphiManagedTool(projectRoot, "playwright");
  if (managed.installed) {
    const managedRequire = createRequire(path.join(delphiAdapterCacheRoot(projectRoot, "playwright"), "package.json"));
    const resolved = managedRequire.resolve("playwright");
    return {
      load: () => loadPlaywright(resolved),
      browsersPath: delphiManagedBrowsersPath(projectRoot),
      source: `managed:${managed.version ?? "unknown"}`
    };
  }
  throw new Error("Playwright is not installed in the project or ArchiCode's managed Delphi cache.");
}

function validatedBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Playwright baseUrl must use http or https.");
  if (url.username || url.password) throw new Error("Playwright baseUrl must not contain credentials.");
  return url;
}

function sameOriginUrl(baseUrl: URL, value: string | undefined): string {
  const target = value === undefined || value.trim() === "" ? new URL(baseUrl) : new URL(value, baseUrl);
  if (target.origin !== baseUrl.origin) throw new Error(`Playwright navigation must remain on the approved origin ${baseUrl.origin}.`);
  return target.toString();
}

function requiredSelector(action: DelphiPlaywrightAction): string {
  const selector = action.selector?.trim();
  if (!selector) throw new Error(`${action.action} requires a selector.`);
  return selector;
}

function boundedTimeout(timeoutMs: number | undefined): number {
  return Math.min(10 * 60_000, Math.max(1_000, Math.floor(timeoutMs ?? 60_000)));
}

function safeLabel(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}

function assertApprovedPageOrigin(baseUrl: URL, currentUrl: string): void {
  if (!currentUrl || currentUrl === "about:blank") return;
  const current = new URL(currentUrl);
  if (current.origin !== baseUrl.origin) throw new Error(`Playwright left the approved origin ${baseUrl.origin} and reached ${current.origin}.`);
}

function navigationOriginViolation(baseUrl: URL, request: any): string | undefined {
  if (typeof request?.isNavigationRequest !== "function" || !request.isNavigationRequest()) return undefined;
  const frame = typeof request.frame === "function" ? request.frame() : undefined;
  if (!frame || typeof frame.parentFrame !== "function" || frame.parentFrame() !== null) return undefined;
  const rawUrl = typeof request.url === "function" ? String(request.url()) : "";
  if (!rawUrl || rawUrl === "about:blank") return undefined;
  try {
    const target = new URL(rawUrl);
    return target.origin === baseUrl.origin ? undefined : target.origin;
  } catch {
    return "an invalid navigation target";
  }
}

function validatePlaywrightActions(baseUrl: URL, actions: DelphiPlaywrightAction[]): void {
  if (!actions.length || actions.length > 80) throw new Error("A Playwright flow must contain between 1 and 80 actions.");
  for (const action of actions) {
    if (!action || typeof action !== "object" || !PLAYWRIGHT_ACTIONS.has(action.action)) {
      const received = action && typeof action === "object" ? String((action as { action?: unknown }).action ?? "missing") : typeof action;
      throw new Error(`Unsupported Playwright action ${JSON.stringify(received)}. Use one of: ${[...PLAYWRIGHT_ACTIONS].join(", ")}.`);
    }
    if (["click", "fill", "press", "wait-for", "assert-text", "assert-visible"].includes(action.action)) requiredSelector(action);
    if ((action.action === "press" || action.action === "assert-text" || action.action === "assert-url") && !action.value) {
      throw new Error(`${action.action} requires a value.`);
    }
    if (action.action === "goto" || action.action === "assert-url") sameOriginUrl(baseUrl, action.value);
    if (action.action === "set-viewport" && (
      (action.width !== undefined && !Number.isFinite(action.width))
      || (action.height !== undefined && !Number.isFinite(action.height))
    )) throw new Error("set-viewport requires finite width and height values.");
  }
}

async function uniqueLocator(page: any, selector: string, action: string): Promise<any> {
  const locator = page.locator(selector);
  if (typeof locator.count !== "function") return locator;
  const count = await locator.count();
  if (count === 1) return locator;
  if (count === 0) throw new Error(`SELECTOR_NOT_FOUND: ${action} selector ${JSON.stringify(selector)} matched no elements.`);
  let candidates = "";
  try {
    const texts = await locator.allTextContents?.();
    if (Array.isArray(texts)) candidates = texts.slice(0, 4).map((text: unknown) => String(text).trim().slice(0, 80)).filter(Boolean).join(" | ");
  } catch {
    // Candidate text is advisory only.
  }
  throw new Error(`SELECTOR_AMBIGUOUS: ${action} selector ${JSON.stringify(selector)} matched ${count} elements.${candidates ? ` Candidate text: ${candidates}.` : ""} Refine the selector and retry this browser lane.`);
}

export async function runDelphiPlaywrightFlow(
  projectRoot: string,
  input: DelphiPlaywrightFlowInput,
  options?: { signal?: AbortSignal; onProgress?: (message: string) => void; onArtifact?: (artifact: DelphiObservationArtifact) => void; maxArtifacts?: number; onExecutionStart?: () => void }
): Promise<DelphiPlaywrightFlowResult> {
  const baseUrl = validatedBaseUrl(input.baseUrl);
  const browserName = input.browser ?? "chromium";
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const capture = input.capture ?? "none";
  const plannedActions = canonicalizeDelphiPlaywrightActions(input.actions);
  validatePlaywrightActions(baseUrl, plannedActions);
  const explicitArtifacts = plannedActions.filter((action) => action.action === "screenshot").length;
  const finalArtifact = capture === "final" && plannedActions.at(-1)?.action !== "screenshot" ? 1 : 0;
  const maxArtifacts = options?.maxArtifacts ?? Number.POSITIVE_INFINITY;
  if (explicitArtifacts + finalArtifact > maxArtifacts) {
    throw new Error(`This Playwright flow requires ${explicitArtifacts + finalArtifact} explicit/final screenshots, exceeding the remaining Delphi evidence budget of ${maxArtifacts}. Remove explicit screenshots or use capture none.`);
  }
  const resolved = await resolvePlaywright(projectRoot);
  options?.onExecutionStart?.();
  options?.onProgress?.(`Launching ${browserName} through ${resolved.source}`);
  if (options?.signal?.aborted) throw new Error("Playwright audit was cancelled before browser launch.");
  const visible = input.observationMode !== "headless";
  // PLAYWRIGHT_BROWSERS_PATH is process-global, but Playwright only needs it
  // while resolving and launching the browser process. Release the mutex as
  // soon as launch completes so concurrent audits can interact independently.
  const browser = await withPlaywrightEnvironment(resolved.browsersPath, async () => {
    if (options?.signal?.aborted) throw new Error("Playwright audit was cancelled before browser launch.");
    const api = await resolved.load();
    return api[browserName].launch({ headless: !visible, ...(visible ? { slowMo: 120 } : {}) });
  });
  let blockedOrigin: string | undefined;
  const blockForeignTopLevelNavigation = async (route: any): Promise<void> => {
    const request = typeof route?.request === "function" ? route.request() : undefined;
    const violation = navigationOriginViolation(baseUrl, request);
    if (violation) {
      blockedOrigin = violation;
      await route.abort?.("blockedbyclient");
      return;
    }
    await route.continue?.();
  };
  const context = typeof browser.newContext === "function" ? await browser.newContext() : undefined;
  if (context && typeof context.route === "function") await context.route("**/*", blockForeignTopLevelNavigation);
  const page = context ? await context.newPage() : await browser.newPage();
  if (!context && typeof page.route === "function") await page.route("**/*", blockForeignTopLevelNavigation);
  page.setDefaultTimeout(timeoutMs);
  const assertNoBlockedOrigin = (): void => {
    if (!blockedOrigin) return;
    throw new Error(`Playwright blocked top-level navigation outside the approved origin ${baseUrl.origin}: ${blockedOrigin}.`);
  };
  const inspectPopup = (popup: any): void => {
    const inspect = (): void => {
      const currentUrl = typeof popup?.url === "function" ? String(popup.url()) : "";
      if (!currentUrl || currentUrl === "about:blank") return;
      try {
        const origin = new URL(currentUrl).origin;
        if (origin === baseUrl.origin) return;
        blockedOrigin = origin;
        void popup.close?.().catch?.(() => undefined);
      } catch {
        blockedOrigin = "an invalid popup target";
        void popup.close?.().catch?.(() => undefined);
      }
    };
    inspect();
    popup?.on?.("framenavigated", inspect);
  };
  page.on?.("popup", inspectPopup);
  if (context && typeof context.on === "function") {
    context.on("page", (openedPage: any) => {
      if (openedPage !== page) inspectPopup(openedPage);
    });
  }
  try {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const requestErrors: string[] = [];
    page.on("console", (message: any) => {
      if (message.type?.() === "error") consoleErrors.push(String(message.text?.() ?? message));
    });
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    page.on("response", (response: any) => {
      const status = Number(response.status?.());
      if (Number.isFinite(status) && status >= 400) requestErrors.push(`${status} ${String(response.url?.() ?? "unknown resource")}`);
    });
    page.on("requestfailed", (request: any) => {
      const failure = request.failure?.();
      requestErrors.push(`${String(request.url?.() ?? "unknown resource")}: ${String(failure?.errorText ?? "request failed")}`);
    });
    const actions: DelphiPlaywrightFlowResult["actions"] = [];
    const artifacts: DelphiPlaywrightFlowResult["artifacts"] = [];
    const captureObservation = async (label: string, fullPage = false): Promise<DelphiObservationArtifact> => {
      const artifact = await persistDelphiScreenshot(projectRoot, safeLabel(label, "browser-observation"), await page.screenshot({ fullPage }));
      artifacts.push(artifact);
      options?.onArtifact?.(artifact);
      options?.onProgress?.(`Observation captured: ${artifact.path}`);
      return artifact;
    };
    const abort = (): void => { void browser.close(); };
    options?.signal?.addEventListener("abort", abort, { once: true });
    try {
      for (let index = 0; index < plannedActions.length; index += 1) {
        if (options?.signal?.aborted) throw new Error("Playwright audit was cancelled.");
        const action = plannedActions[index]!;
        options?.onProgress?.(`Playwright ${index + 1}/${plannedActions.length}: ${action.action}`);
        try {
          if (action.action === "goto") {
            const url = sameOriginUrl(baseUrl, action.value);
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
            actions.push({ index, action: action.action, detail: url });
          } else if (action.action === "click") {
            const selector = requiredSelector(action);
            await (await uniqueLocator(page, selector, action.action)).click();
            actions.push({ index, action: action.action, detail: selector });
          } else if (action.action === "fill") {
            const selector = requiredSelector(action);
            await (await uniqueLocator(page, selector, action.action)).fill(action.value ?? "");
            actions.push({ index, action: action.action, detail: selector });
          } else if (action.action === "press") {
            const selector = requiredSelector(action);
            if (!action.value) throw new Error("press requires a key value.");
            await (await uniqueLocator(page, selector, action.action)).press(action.value);
            actions.push({ index, action: action.action, detail: `${selector} -> ${action.value}` });
          } else if (action.action === "wait-for") {
            const selector = requiredSelector(action);
            await page.locator(selector).waitFor({ state: action.state ?? "visible", timeout: timeoutMs });
            actions.push({ index, action: action.action, detail: `${selector} (${action.state ?? "visible"})` });
          } else if (action.action === "assert-text") {
            const selector = requiredSelector(action);
            const actual = String(await (await uniqueLocator(page, selector, action.action)).textContent() ?? "");
            if (!actual.includes(action.value ?? "")) throw new Error(`Text assertion failed for ${selector}: expected to contain ${JSON.stringify(action.value ?? "")}, received ${JSON.stringify(actual.slice(0, 500))}.`);
            actions.push({ index, action: action.action, detail: `${selector} contains ${JSON.stringify(action.value ?? "")}` });
          } else if (action.action === "assert-visible") {
            const selector = requiredSelector(action);
            if (!await (await uniqueLocator(page, selector, action.action)).isVisible()) throw new Error(`Visibility assertion failed for ${selector}.`);
            actions.push({ index, action: action.action, detail: `${selector} is visible` });
          } else if (action.action === "assert-url") {
            const expected = sameOriginUrl(baseUrl, action.value);
            const actual = String(page.url());
            if (actual !== expected) throw new Error(`URL assertion failed: expected ${expected}, received ${actual}.`);
            actions.push({ index, action: action.action, detail: `URL is ${expected}` });
          } else if (action.action === "assert-no-runtime-errors") {
            const errors = [
              ...consoleErrors.map((message) => `console: ${message}`),
              ...pageErrors.map((message) => `page: ${message}`),
              ...requestErrors.map((message) => `request: ${message}`)
            ];
            if (errors.length) throw new Error(`Runtime error assertion failed:\n${errors.slice(-20).join("\n")}`);
            actions.push({ index, action: action.action, detail: "No console, page, or failed-resource errors observed" });
          } else if (action.action === "assert-no-horizontal-overflow") {
            const dimensions = await page.evaluate(() => {
              const root = document.documentElement;
              const body = document.body;
              const contentWidth = Math.max(root?.scrollWidth ?? 0, body?.scrollWidth ?? 0);
              const viewportWidth = window.innerWidth || root?.clientWidth || 0;
              return { contentWidth, viewportWidth };
            });
            const contentWidth = Number(dimensions?.contentWidth ?? 0);
            const viewportWidth = Number(dimensions?.viewportWidth ?? 0);
            if (contentWidth > viewportWidth + 1) throw new Error(`Horizontal overflow assertion failed: content width ${contentWidth}px exceeds viewport width ${viewportWidth}px.`);
            actions.push({ index, action: action.action, detail: `No horizontal overflow (${contentWidth}px content within ${viewportWidth}px viewport)` });
          } else if (action.action === "set-viewport") {
            const width = Math.min(3840, Math.max(240, Math.floor(action.width ?? 1280)));
            const height = Math.min(2160, Math.max(240, Math.floor(action.height ?? 720)));
            await page.setViewportSize({ width, height });
            actions.push({ index, action: action.action, detail: `${width}x${height}` });
          } else if (action.action === "screenshot") {
            const label = safeLabel(action.label, `screenshot-${index + 1}`);
            const data = await page.screenshot({ fullPage: action.fullPage ?? true });
            const artifact = await persistDelphiScreenshot(projectRoot, label, data);
            artifacts.push(artifact);
            options?.onArtifact?.(artifact);
            options?.onProgress?.(`Observation captured: ${artifact.path}`);
            actions.push({ index, action: action.action, detail: `${artifact.path}${action.purpose ? ` — ${action.purpose}` : ""}` });
          } else {
            throw new Error(`Unsupported Playwright action ${JSON.stringify((action as { action?: unknown }).action)}.`);
          }
        } catch (error) {
          assertNoBlockedOrigin();
          throw error;
        }
        assertNoBlockedOrigin();
        assertApprovedPageOrigin(baseUrl, String(page.url()));
      }
      if (capture === "final" && plannedActions.at(-1)?.action !== "screenshot") {
        await captureObservation("browser-final");
      }
      return {
        status: "passed",
        browser: browserName,
        finalUrl: String(page.url()),
        title: String(await page.title()),
        actions,
        artifacts,
        consoleErrors: consoleErrors.slice(-50),
        pageErrors: pageErrors.slice(-50),
        requestErrors: requestErrors.slice(-50)
      };
    } finally {
      options?.signal?.removeEventListener("abort", abort);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}
