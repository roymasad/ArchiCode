import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type DelphiManagedAdapter = "playwright" | "appium";

export type DelphiManagedToolStatus = {
  adapter: DelphiManagedAdapter;
  installed: boolean;
  root: string;
  version?: string;
  browsersPath?: string;
};

export type DelphiManagedSetupRequest = {
  adapter: DelphiManagedAdapter;
  playwrightBrowsers?: Array<"chromium" | "firefox" | "webkit">;
  appiumDrivers?: Array<"uiautomator2" | "xcuitest">;
};

export type DelphiManagedSetupResult = DelphiManagedToolStatus & {
  steps: Array<{ label: string; exitCode: number | null; output: string }>;
};

let configuredToolCacheRoot: string | null = null;

export function setDelphiToolCacheRoot(rootPath: string | null): void {
  configuredToolCacheRoot = rootPath ? path.resolve(rootPath) : null;
}

export function delphiToolCacheRoot(projectRoot: string): string {
  return configuredToolCacheRoot
    ? path.join(configuredToolCacheRoot, "delphi-tools")
    : path.join(projectRoot, ".archicode", "tool-cache", "delphi-tools");
}

export function delphiAdapterCacheRoot(projectRoot: string, adapter: DelphiManagedAdapter): string {
  return path.join(delphiToolCacheRoot(projectRoot), adapter === "playwright" ? "playwright-v1" : "appium-v2");
}

export function delphiManagedBrowsersPath(projectRoot: string): string {
  return path.join(delphiAdapterCacheRoot(projectRoot, "playwright"), "browsers");
}

export function delphiManagedAppiumHome(projectRoot: string): string {
  return path.join(delphiAdapterCacheRoot(projectRoot, "appium"), "appium-home");
}

async function readPackageVersion(packagePath: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : undefined;
  } catch {
    return undefined;
  }
}

export async function inspectDelphiManagedTool(projectRoot: string, adapter: DelphiManagedAdapter): Promise<DelphiManagedToolStatus> {
  const root = delphiAdapterCacheRoot(projectRoot, adapter);
  const packageName = adapter === "playwright" ? "playwright" : "appium";
  const packagePath = path.join(root, "node_modules", packageName, "package.json");
  const installed = await access(packagePath).then(() => true, () => false);
  return {
    adapter,
    installed,
    root,
    version: installed ? await readPackageVersion(packagePath) : undefined,
    browsersPath: adapter === "playwright" ? delphiManagedBrowsersPath(projectRoot) : undefined
  };
}

async function ensureCachePackage(root: string, adapter: DelphiManagedAdapter): Promise<void> {
  await mkdir(root, { recursive: true });
  const packagePath = path.join(root, "package.json");
  const exists = await access(packagePath).then(() => true, () => false);
  if (exists) return;
  await writeFile(packagePath, `${JSON.stringify({ name: `archicode-delphi-${adapter}-cache`, private: true, version: "1.0.0" }, null, 2)}\n`, "utf8");
}

async function runSetupStep(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<{ label: string; exitCode: number | null; output: string }> {
  if (input.signal?.aborted) throw new Error(`${input.label} was cancelled before it started.`);
  input.onProgress?.(input.label);
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      env: input.env ?? process.env
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > 80_000) output = output.slice(-80_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 10 * 60_000);
    const abort = (): void => { child.kill("SIGTERM"); };
    input.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode) => {
      cleanup();
      const suffix = timedOut ? "\nSetup step timed out." : input.signal?.aborted ? "\nSetup step cancelled." : "";
      resolve({ label: input.label, exitCode, output: `${output}${suffix}`.trim() });
    });
  });
}

export async function installDelphiManagedTool(
  projectRoot: string,
  request: DelphiManagedSetupRequest,
  options?: {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    runStep?: typeof runSetupStep;
  }
): Promise<DelphiManagedSetupResult> {
  const root = delphiAdapterCacheRoot(projectRoot, request.adapter);
  await ensureCachePackage(root, request.adapter);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const steps: DelphiManagedSetupResult["steps"] = [];
  const packageName = request.adapter === "playwright" ? "playwright" : "appium";
  const executeStep = options?.runStep ?? runSetupStep;
  const install = await executeStep({
    command: npmCommand,
    args: ["install", "--save-exact", "--no-audit", "--no-fund", packageName],
    cwd: root,
    label: `Installing ${packageName} in ArchiCode's managed Delphi cache`,
    signal: options?.signal,
    onProgress: options?.onProgress
  });
  steps.push(install);
  if (install.exitCode !== 0) throw new Error(`${install.label} failed. ${install.output.slice(-4000)}`);

  if (request.adapter === "playwright") {
    const browsers = request.playwrightBrowsers?.length ? request.playwrightBrowsers : ["chromium"];
    const nodeCommand = process.env.npm_node_execpath || process.execPath;
    const browserInstall = await executeStep({
      command: nodeCommand,
      args: [path.join(root, "node_modules", "playwright", "cli.js"), "install", ...browsers],
      cwd: root,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: delphiManagedBrowsersPath(projectRoot),
        ...(process.versions.electron && nodeCommand === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {})
      },
      label: `Downloading managed Playwright browser${browsers.length === 1 ? "" : "s"}: ${browsers.join(", ")}`,
      signal: options?.signal,
      onProgress: options?.onProgress
    });
    steps.push(browserInstall);
    if (browserInstall.exitCode !== 0) throw new Error(`${browserInstall.label} failed. ${browserInstall.output.slice(-4000)}`);
  } else {
    for (const driver of request.appiumDrivers ?? []) {
      const appiumBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "appium.cmd" : "appium");
      const driverInstall = await executeStep({
        command: appiumBin,
        args: ["driver", "install", driver],
        cwd: root,
        env: { ...process.env, APPIUM_HOME: delphiManagedAppiumHome(projectRoot) },
        label: `Installing managed Appium ${driver} driver`,
        signal: options?.signal,
        onProgress: options?.onProgress
      });
      steps.push(driverInstall);
      if (driverInstall.exitCode !== 0 && !/already installed/i.test(driverInstall.output)) {
        throw new Error(`${driverInstall.label} failed. ${driverInstall.output.slice(-4000)}`);
      }
    }
  }

  return { ...(await inspectDelphiManagedTool(projectRoot, request.adapter)), steps };
}
