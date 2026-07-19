import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { delphiTestingInputSchema, type DelphiTestingInput, type DelphiToolchainPlan } from "../../shared/schema";
import { inspectDelphiManagedTool } from "./toolCache";
import { loadProject } from "../storage/projectStore";
import { listRuntimeServices } from "../storage/runtimeServices";

export type DelphiTestEnvironment = {
  ecosystems: string[];
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  /** Project scripts/checks visible at inspection time. Delphi chooses among them for the objective. */
  discoveredCommands: string[];
  discoveredCommandDetails: Array<{ command: string; definition?: string }>;
  /** @deprecated Retained for stored-report compatibility; authorization is capability-based. */
  authorizedCommands: string[];
  toolchains: DelphiToolchainPlan[];
  runtimeProfiles: Array<{ id: string; label: string; kind: string; targetRequired: boolean; defaultTargetId?: string }>;
  activeRuntimeServices: Array<{ id: string; profileId?: string; label: string; kind: string; status: string; targetId?: string; runTargetId?: string; url?: string }>;
};

async function exists(projectRoot: string, relativePath: string): Promise<boolean> {
  return access(path.join(projectRoot, relativePath)).then(() => true, () => false);
}

async function readJson(projectRoot: string, relativePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function packageManagerCommand(manager: DelphiTestEnvironment["packageManager"], script: string): string {
  if (manager === "yarn") return `yarn ${script}`;
  if (manager === "bun") return `bun run ${script}`;
  return `${manager ?? "npm"} run ${script}`;
}

function managedInstallPlan(adapter: "playwright" | "appium", packages: string[], actions: string[]): DelphiToolchainPlan["installPlan"] {
  return {
    scope: "managed-cache",
    packages,
    actions,
    requiresApproval: true
  };
}

export function isDependencySetupCommand(command: string): boolean {
  return /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade|dlx)\b|(?:^|\s)(?:pip|pip3|uv|poetry)\s+(?:install|add)\b|(?:^|\s)(?:gem|bundle)\s+install\b|(?:^|\s)(?:brew|apt|apt-get|dnf|yum|choco|winget)\s+install\b|\bplaywright\s+install\b|\bappium\s+driver\s+install\b/i.test(command);
}

export function pinDelphiAuthorizedCommands(input: DelphiTestingInput, environment: DelphiTestEnvironment): DelphiTestingInput {
  // Compatibility shim for older callers/stored inputs. Command authorization
  // is no longer pinned here: the approved Delphi audit grants a bounded
  // verification capability and the shared safety broker evaluates the actual
  // command Delphi chooses at execution time.
  void environment;
  return delphiTestingInputSchema.parse(input);
}

function runtimeProfileMatchesPlatforms(profile: DelphiTestEnvironment["runtimeProfiles"][number], platforms: DelphiTestingInput["platforms"]): boolean {
  const kind = profile.kind.toLowerCase();
  if (platforms.includes("generic")) return true;
  return platforms.some((platform) => {
    if (platform === "web") return kind === "web" || kind === "browser";
    if (platform === "electron") return kind === "electron" || kind === "desktop";
    if (platform === "flutter") return kind === "flutter";
    if (platform === "android") return kind === "android" || kind === "flutter" || kind === "mobile";
    if (platform === "ios") return kind === "ios" || kind === "flutter" || kind === "mobile";
    return false;
  });
}

export function compatibleDelphiRuntimeProfiles(
  input: DelphiTestingInput,
  environment: DelphiTestEnvironment
): DelphiTestEnvironment["runtimeProfiles"] {
  if (input.mode === "plan" || input.target?.profileId || input.target?.baseUrl || input.target?.appiumServerUrl || input.target?.launch === "never") return [];
  return environment.runtimeProfiles.filter((profile) => runtimeProfileMatchesPlatforms(profile, input.platforms));
}

/**
 * Pins one unambiguous compatible Run App profile into the reviewed Delphi
 * lifecycle. The profile/launch/cleanup remain visible on the approval card;
 * ambiguous profile choices still require the user or parent agent to choose.
 */
export function pinDelphiRuntimeTarget(input: DelphiTestingInput, environment: DelphiTestEnvironment): DelphiTestingInput {
  if (input.mode === "plan" || input.mode === "setup") return input;
  const candidates = compatibleDelphiRuntimeProfiles(input, environment);
  if (candidates.length !== 1) return input;
  return delphiTestingInputSchema.parse({
    ...input,
    target: {
      ...input.target,
      profileId: candidates[0]!.id,
      launch: "if-needed",
      cleanup: input.target?.cleanup ?? "stop-if-started"
    }
  });
}

export async function inspectDelphiTestEnvironment(projectRoot: string, input: DelphiTestingInput): Promise<DelphiTestEnvironment> {
  const projectBundle = await loadProject(projectRoot).catch(() => undefined);
  const runtimeServices = projectBundle ? await listRuntimeServices(projectRoot) : [];
  const packageJson = await readJson(projectRoot, "package.json");
  const scripts = stringRecord(packageJson?.scripts);
  const dependencies = {
    ...stringRecord(packageJson?.dependencies),
    ...stringRecord(packageJson?.devDependencies)
  };
  const fileChecks = await Promise.all([
    exists(projectRoot, "pnpm-lock.yaml"),
    exists(projectRoot, "yarn.lock"),
    exists(projectRoot, "bun.lock"),
    exists(projectRoot, "bun.lockb"),
    exists(projectRoot, "pubspec.yaml"),
    exists(projectRoot, "integration_test"),
    exists(projectRoot, "android"),
    exists(projectRoot, "ios"),
    exists(projectRoot, "playwright.config.ts"),
    exists(projectRoot, "playwright.config.js"),
    exists(projectRoot, "appium.yml"),
    exists(projectRoot, ".appiumrc.json")
  ]);
  const [pnpmLock, yarnLock, bunLock, bunLockb, flutterProject, flutterIntegrationTests, androidProject, iosProject, playwrightTs, playwrightJs, appiumYml, appiumRc] = fileChecks;
  const [projectPlaywrightPackage, projectPlaywrightTestPackage, projectAppiumPackage] = await Promise.all([
    exists(projectRoot, "node_modules/playwright/package.json"),
    exists(projectRoot, "node_modules/@playwright/test/package.json"),
    exists(projectRoot, "node_modules/appium/package.json")
  ]);
  const packageManager: DelphiTestEnvironment["packageManager"] = pnpmLock ? "pnpm" : yarnLock ? "yarn" : bunLock || bunLockb ? "bun" : packageJson ? "npm" : undefined;
  const discoveredCommands = Object.keys(scripts)
    .filter((name) => /^[a-z0-9:_-]+$/i.test(name))
    .map((name) => packageManagerCommand(packageManager, name));
  const discoveredCommandDetails = Object.keys(scripts)
    .filter((name) => /^[a-z0-9:_-]+$/i.test(name))
    .map((name) => ({ command: packageManagerCommand(packageManager, name), definition: scripts[name]?.slice(0, 2000) }));
  if (flutterProject) discoveredCommands.push("flutter test");
  if (flutterProject) discoveredCommandDetails.push({ command: "flutter test", definition: "Flutter project test runner" });
  if (flutterProject && flutterIntegrationTests && input.target?.deviceId && /^[a-z0-9._:-]+$/i.test(input.target.deviceId)) {
    discoveredCommands.push(`flutter test integration_test -d ${input.target.deviceId}`);
    discoveredCommandDetails.push({ command: `flutter test integration_test -d ${input.target.deviceId}`, definition: "Flutter integration_test suite on the selected target" });
  }

  const requested = new Set(input.platforms);
  const webRelevant = requested.has("web") || requested.has("electron") || (!requested.size && Boolean(packageJson));
  const mobileRelevant = requested.has("flutter") || requested.has("android") || requested.has("ios") || (!requested.size && (flutterProject || androidProject || iosProject));
  const [managedPlaywright, managedAppium] = await Promise.all([
    inspectDelphiManagedTool(projectRoot, "playwright"),
    inspectDelphiManagedTool(projectRoot, "appium")
  ]);
  const projectPlaywrightDeclared = Boolean(dependencies["@playwright/test"] || dependencies.playwright || playwrightTs || playwrightJs);
  const projectAppiumDeclared = Boolean(dependencies.appium || appiumYml || appiumRc);
  const projectPlaywright = projectPlaywrightPackage || projectPlaywrightTestPackage;
  const projectAppium = projectAppiumPackage;
  const hasPlaywright = projectPlaywright || managedPlaywright.installed;
  const hasExplicitAppiumSession = Boolean(input.target?.appiumServerUrl && input.target?.appiumSessionId);
  const hasInstalledAppium = projectAppium || managedAppium.installed;
  const toolchains: DelphiToolchainPlan[] = [];

  if (webRelevant) {
    toolchains.push({
      adapter: "playwright",
      status: hasPlaywright ? "ready" : "missing",
      evidence: [
        projectPlaywright
          ? "An installed Playwright package was detected in the project."
          : managedPlaywright.installed
            ? `Playwright ${managedPlaywright.version ?? "(version unknown)"} is ready in ArchiCode's managed Delphi cache.`
            : projectPlaywrightDeclared
              ? "Playwright is declared or configured by the project, but no installed project package or managed adapter was found."
              : "No project or managed Playwright installation was detected.",
        packageManager ? `Package manager: ${packageManager}.` : "No JavaScript package manager was detected."
      ],
      installPlan: hasPlaywright ? undefined : managedInstallPlan(
        "playwright",
        ["playwright", "playwright browser binaries"],
        ["Install the Playwright adapter in ArchiCode's versioned managed-tool cache.", "Download only the browser engines required by the selected audit target.", "Keep generated test specs ephemeral unless the user approves adding durable project tests."]
      )
    });
  }

  if (flutterProject || requested.has("flutter")) {
    toolchains.push({
      adapter: "flutter-integration-test",
      status: flutterProject ? "ready" : "missing",
      evidence: [flutterProject ? "pubspec.yaml detected; Flutter's project-native test runner is available for validation." : "No pubspec.yaml was detected."],
      installPlan: flutterProject ? undefined : {
        scope: "project",
        packages: ["Flutter SDK", "integration_test"],
        actions: ["Configure a Flutter project and its integration_test dependency before device or emulator automation."],
        requiresApproval: true
      }
    });
  }

  const nativePlatform = requested.has("android") ? "Android" : requested.has("ios") ? "iOS" : undefined;
  if (nativePlatform && input.target?.deviceId) {
    toolchains.push({
      adapter: "project-native",
      status: "ready",
      evidence: [
        `${nativePlatform} target ${input.target.deviceId} was explicitly selected.`,
        nativePlatform === "Android"
          ? "Delphi's built-in ADB adapter can check readiness, inspect UI text, interact, assert, and capture screenshots without adding a project dependency."
          : "Delphi's built-in simctl adapter can check readiness, open URLs, and capture screenshots; richer iOS interaction requires an explicit Appium session."
      ]
    });
  }

  if (mobileRelevant && !flutterProject) {
    toolchains.push({
      adapter: "appium",
      status: hasExplicitAppiumSession ? "ready" : hasInstalledAppium ? "unsupported" : "missing",
      evidence: [
        hasExplicitAppiumSession
          ? "An explicit existing Appium server and session were supplied; Delphi can use the built-in WebDriver client without installing Appium."
          : projectAppium
            ? "An installed Appium package is present in the project, but Delphi still needs an explicit running localhost server and session id before it can use the WebDriver adapter."
            : managedAppium.installed
              ? `Appium ${managedAppium.version ?? "(version unknown)"} is installed in ArchiCode's managed Delphi cache, but no running localhost server/session was supplied.`
              : projectAppiumDeclared
                ? "Appium is declared or configured by the project, but no installed project package or managed adapter was found."
                : "No project or managed Appium installation was detected.",
        androidProject ? "Android project directory detected." : "Android project directory not detected.",
        iosProject ? "iOS project directory detected." : "iOS project directory not detected."
      ],
      installPlan: hasExplicitAppiumSession || hasInstalledAppium ? undefined : managedInstallPlan(
        "appium",
        ["appium", ...(androidProject ? ["uiautomator2 driver"] : []), ...(iosProject ? ["xcuitest driver"] : [])],
        ["Install Appium and only the required platform driver in ArchiCode's versioned managed-tool cache.", "Use an explicitly selected emulator or simulator; never choose or boot a device silently."]
      )
    });
  }

  if (!toolchains.length) {
    toolchains.push({
      adapter: "generic",
      status: discoveredCommands.length || input.commands.length ? "ready" : "unsupported",
      evidence: discoveredCommands.length
        ? [`Detected ${discoveredCommands.length} finite project verification command(s).`]
        : ["No supported UI/mobile adapter or finite project test command was detected."]
    });
  }

  return {
    ecosystems: [packageJson ? "javascript" : "", flutterProject ? "flutter" : "", androidProject ? "android" : "", iosProject ? "ios" : ""].filter(Boolean),
    packageManager,
    discoveredCommands: Array.from(new Set(discoveredCommands.map((command) => command.trim()).filter(Boolean))),
    discoveredCommandDetails: Array.from(new Map(discoveredCommandDetails.map((detail) => [detail.command, detail])).values()),
    authorizedCommands: [],
    toolchains,
    runtimeProfiles: (projectBundle?.project.settings.runTargetProfiles ?? []).map((profile) => ({
      id: profile.id,
      label: profile.label,
      kind: profile.kind,
      targetRequired: profile.targetRequired,
      defaultTargetId: profile.defaultTargetId
    })),
    activeRuntimeServices: runtimeServices.map((service) => ({
      id: service.id,
      profileId: service.profileId,
      label: service.label,
      kind: service.kind,
      status: service.status,
      targetId: service.targetId,
      runTargetId: service.runTargetId,
      url: service.url
    }))
  };
}
