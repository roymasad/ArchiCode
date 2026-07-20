import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectDelphiTestEnvironment,
  isDependencySetupCommand,
  pinDelphiAuthorizedCommands,
  pinDelphiRuntimeTarget,
  type DelphiTestEnvironment
} from "../src/main/testing/toolchains";
import { delphiManagedAppiumHome, installDelphiManagedTool, setDelphiToolCacheRoot } from "../src/main/testing/toolCache";
import { delphiTestingAgent } from "../src/main/microRunAgents/delphiTesting";
import { ensureFixtureProject } from "../src/main/storage/projectStore";
import { delphiTestingInputSchema, type DelphiTestingOutput } from "../src/shared/schema";

afterEach(() => setDelphiToolCacheRoot(null));

describe("Delphi toolchain planning", () => {
  it("detects project-native Playwright and exposes project scripts as advisory choices", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-web-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { test: "vitest run", "test:e2e": "playwright test", dev: "vite" },
      devDependencies: { "@playwright/test": "1.0.0" }
    }), "utf8");
    await mkdir(path.join(root, "node_modules", "@playwright", "test"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "@playwright", "test", "package.json"), JSON.stringify({ name: "@playwright/test", version: "1.0.0" }), "utf8");
    const input = delphiTestingInputSchema.parse({ objective: "Audit web", platforms: ["web"] });

    const environment = await inspectDelphiTestEnvironment(root, input);

    expect(input.observation).toEqual({ mode: "visible", capture: "key-steps" });
    expect(environment.discoveredCommands).toEqual(expect.arrayContaining(["npm run test", "npm run test:e2e"]));
    expect(environment.authorizedCommands).toEqual([]);
    expect(environment.discoveredCommands).toContain("npm run dev");
    expect(environment.toolchains).toContainEqual(expect.objectContaining({ adapter: "playwright", status: "ready" }));
  });

  it("does not turn shell-metacharacter script names into executable commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-script-name-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { test: "vitest run", "test; touch escaped": "echo unsafe" }
    }), "utf8");
    const input = delphiTestingInputSchema.parse({ objective: "Audit scripts", platforms: ["generic"] });

    const environment = await inspectDelphiTestEnvironment(root, input);

    expect(environment.discoveredCommands).toContain("npm run test");
    expect(environment.discoveredCommands.some((command) => command.includes("touch escaped"))).toBe(false);
  });

  it("does not turn discovered scripts into a static authorization list or truncate discovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-command-review-"));
    const scripts = Object.fromEntries(Array.from({ length: 22 }, (_, index) => {
      const name = `test:${String(index + 1).padStart(2, "0")}`;
      return [name, `vitest run tests/fixture-${index + 1}.test.ts`];
    }));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts }), "utf8");
    const input = delphiTestingInputSchema.parse({ objective: "Audit reviewed scripts", platforms: ["generic"] });

    const environment = await inspectDelphiTestEnvironment(root, input);
    const pinned = pinDelphiAuthorizedCommands(input, environment);

    expect(environment.discoveredCommands).toHaveLength(22);
    expect(environment.discoveredCommandDetails[0]).toEqual({
      command: "npm run test:01",
      definition: "vitest run tests/fixture-1.test.ts"
    });
    expect(pinned.commands).toEqual([]);
    expect(pinned.commandReview).toBeUndefined();
  });

  it("leaves caller command ideas advisory while execution rejects dependency setup", () => {
    const input = delphiTestingInputSchema.parse({
      objective: "Build and audit the current website",
      platforms: ["web"],
      commands: ["npm install", "npm run build", "npm run typecheck"]
    });
    const environment: DelphiTestEnvironment = {
      ecosystems: ["node"],
      packageManager: "npm",
      discoveredCommands: ["npm run test"],
      discoveredCommandDetails: [{ command: "npm run test", definition: "vitest run" }],
      authorizedCommands: [],
      toolchains: [],
      runtimeProfiles: [],
      activeRuntimeServices: []
    };

    const pinned = pinDelphiAuthorizedCommands(input, environment);

    expect(pinned.commands).toEqual(["npm install", "npm run build", "npm run typecheck"]);
    expect(pinned.commandReview).toBeUndefined();
  });

  it("pins one unambiguous compatible runtime profile for the full audit lifecycle", () => {
    const input = delphiTestingInputSchema.parse({ objective: "Audit the live website", platforms: ["web"] });
    const environment: DelphiTestEnvironment = {
      ecosystems: ["node"],
      discoveredCommands: [],
      discoveredCommandDetails: [],
      authorizedCommands: [],
      toolchains: [],
      runtimeProfiles: [{ id: "web-local-browser", label: "Local Browser", kind: "web", targetRequired: false }],
      activeRuntimeServices: []
    };

    const pinned = pinDelphiRuntimeTarget(input, environment);

    expect(pinned.target).toEqual({
      profileId: "web-local-browser",
      launch: "if-needed",
      cleanup: "stop-if-started"
    });
  });

  it("does not guess when more than one compatible runtime profile exists", () => {
    const input = delphiTestingInputSchema.parse({ objective: "Audit the live website", platforms: ["web"] });
    const environment: DelphiTestEnvironment = {
      ecosystems: ["node"],
      discoveredCommands: [],
      discoveredCommandDetails: [],
      authorizedCommands: [],
      toolchains: [],
      runtimeProfiles: [
        { id: "web-one", label: "Web One", kind: "web", targetRequired: false },
        { id: "web-two", label: "Web Two", kind: "browser", targetRequired: false }
      ],
      activeRuntimeServices: []
    };

    expect(pinDelphiRuntimeTarget(input, environment).target).toBeUndefined();
  });

  it("returns managed-cache setup plans for missing browser and mobile adapters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-missing-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true }), "utf8");
    await mkdir(path.join(root, "android"));
    const input = delphiTestingInputSchema.parse({ objective: "Audit all targets", platforms: ["web", "android"] });

    const environment = await inspectDelphiTestEnvironment(root, input);

    expect(environment.toolchains).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "playwright", status: "missing", installPlan: expect.objectContaining({ scope: "managed-cache", requiresApproval: true }) }),
      expect.objectContaining({ adapter: "appium", status: "missing", installPlan: expect.objectContaining({ scope: "managed-cache", requiresApproval: true }) })
    ]));
  });

  it("classifies dependency setup separately from audit commands", () => {
    expect(isDependencySetupCommand("npm install @playwright/test")).toBe(true);
    expect(isDependencySetupCommand("npx playwright install chromium")).toBe(true);
    expect(isDependencySetupCommand("appium driver install uiautomator2")).toBe(true);
    expect(isDependencySetupCommand("npm run test:e2e")).toBe(false);
    expect(isDependencySetupCommand("flutter test")).toBe(false);
  });

  it("does not count rejected commands as passing evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-rejected-command-"));
    const bundle = await ensureFixtureProject(root);
    const input = delphiTestingInputSchema.parse({ objective: "Audit safely", platforms: ["generic"] });
    const tools = delphiTestingAgent.tools({
      projectRoot: root,
      bundle,
      provider: bundle.project.settings.providers[0]!,
      runConsoleCommand: async () => ({ status: "succeeded" })
    }, input);
    const commandTool = tools.find((tool) => tool.providerToolName === "archicode_console_run_command");
    if (!commandTool) throw new Error("Expected Delphi's guarded command tool.");

    await expect(commandTool.handler({ command: "npm install playwright" })).rejects.toThrow(/never installs dependencies/);
    await expect(commandTool.handler({ command: "npm run undiscovered" })).resolves.toMatchObject({ status: "succeeded" });
    const validationError = await delphiTestingAgent.validateOutput?.({
      status: "completed",
      verdict: "passed",
      summary: "Incorrect pass",
      attempts: 1,
      checks: [{ name: "Rejected command", status: "passed", evidence: [] }],
      findings: [],
      toolchains: [{ adapter: "generic", status: "ready", evidence: [] }],
      artifacts: [],
      blockers: [],
      recommendedNextSteps: []
    }, [
      { providerToolName: "delphi_inspect_test_environment", argumentsJson: "{}", succeeded: true },
      { providerToolName: "archicode_console_run_command", argumentsJson: "{}", succeeded: false }
    ], input);

    expect(validationError).toMatch(/pass without executing/);
  });

  it("does not consume an audit attempt when the guarded console declines to execute", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-attempt-accounting-"));
    const bundle = await ensureFixtureProject(root);
    const input = delphiTestingInputSchema.parse({
      objective: "Audit after approval",
      platforms: ["generic"],
      commands: ["npm run test"],
      maxAttempts: 1
    });
    let calls = 0;
    const tools = delphiTestingAgent.tools({
      projectRoot: root,
      bundle,
      provider: bundle.project.settings.providers[0]!,
      runConsoleCommand: async () => {
        calls += 1;
        return calls === 1
          ? { status: "approval-required", message: "This command still needs review." }
          : { status: "succeeded" };
      }
    }, input);
    const commandTool = tools.find((tool) => tool.providerToolName === "archicode_console_run_command");
    if (!commandTool) throw new Error("Expected Delphi's guarded command tool.");

    await expect(commandTool.handler({ command: "npm run test" })).rejects.toThrow(/still needs review/);
    await expect(commandTool.handler({ command: "npm run test" })).resolves.toMatchObject({ status: "succeeded" });
    expect(calls).toBe(2);
  });

  it("does not consume a browser-lane attempt for invalid preflight plans", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-direct-attempts-"));
    const bundle = await ensureFixtureProject(root);
    const input = delphiTestingInputSchema.parse({
      objective: "Audit a live browser",
      platforms: ["web"],
      target: { baseUrl: "http://127.0.0.1:4173" },
      maxAttempts: 1
    });
    const tools = delphiTestingAgent.tools({
      projectRoot: root,
      bundle,
      provider: bundle.project.settings.providers[0]!
    }, input);
    const playwrightTool = tools.find((tool) => tool.providerToolName === "delphi_run_playwright_flow");
    if (!playwrightTool) throw new Error("Expected Delphi's Playwright tool.");
    const invalidFlow = { actions: [{ action: "click" }] };

    await expect(playwrightTool.handler(invalidFlow)).rejects.toThrow(/requires a selector/);
    await expect(playwrightTool.handler(invalidFlow)).rejects.toThrow(/requires a selector/);
  });

  it("canonicalizes safe Playwright aliases at the tool boundary and records the accepted form", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-alias-boundary-"));
    setDelphiToolCacheRoot(await mkdtemp(path.join(tmpdir(), "archicode-delphi-alias-cache-")));
    const bundle = await ensureFixtureProject(root);
    const input = delphiTestingInputSchema.parse({
      objective: "Audit a live browser",
      platforms: ["web"],
      target: { baseUrl: "http://127.0.0.1:4173" },
      maxAttempts: 1
    });
    const tools = delphiTestingAgent.tools({
      projectRoot: root,
      bundle,
      provider: bundle.project.settings.providers[0]!
    }, input);
    const playwrightTool = tools.find((tool) => tool.providerToolName === "delphi_run_playwright_flow");
    if (!playwrightTool) throw new Error("Expected Delphi's Playwright tool.");

    // The alias payload passes the strict validator (proving canonicalization
    // ran) and fails only on the missing Playwright installation; the handler
    // records the canonical form in place for coverage checks and diagnostics.
    const args: Record<string, unknown> = { actions: [{ type: "navigate", path: "/about" }, { type: "assert-url", expectedPath: "/about" }] };
    await expect(playwrightTool.handler(args)).rejects.toThrow(/Playwright is not installed/);
    expect(args.actions).toEqual([{ action: "goto", value: "/about" }, { action: "assert-url", value: "/about" }]);

    await expect(playwrightTool.handler({ actions: [{ type: "hover", selector: "nav" }] })).rejects.toThrow(/Unsupported Playwright action "hover"/);
  });

  it("accepts an honest incomplete report without prescribing an exact browser action sequence", async () => {
    const input = delphiTestingInputSchema.parse({
      objective: "Test navigation from / to /about, check console errors and broken resources, and verify responsive behavior at desktop and mobile widths.",
      platforms: ["web"],
      target: { baseUrl: "http://127.0.0.1:4173" },
      maxAttempts: 3
    });
    const report: DelphiTestingOutput = {
      status: "blocked",
      verdict: "blocked",
      summary: "Functional checks ran; visual inspection is unavailable in this model.",
      attempts: 1,
      checks: [{ name: "Playwright", status: "passed", evidence: ["Live target opened."] }],
      findings: [],
      toolchains: [{ adapter: "playwright", status: "ready", evidence: [] }],
      artifacts: [],
      blockers: ["Pixel inspection unavailable."],
      recommendedNextSteps: []
    };
    const initialCalls = [
      { providerToolName: "delphi_inspect_test_environment", argumentsJson: "{}", succeeded: true },
      {
        providerToolName: "delphi_run_playwright_flow",
        argumentsJson: JSON.stringify({ actions: [{ action: "goto", value: "/" }, { action: "assert-visible", selector: "h1" }] }),
        succeeded: true,
        executionStarted: true
      }
    ];

    expect(delphiTestingAgent.validateOutput?.(report, initialCalls, input)).toBeUndefined();

    const completedCalls = [...initialCalls, {
      providerToolName: "delphi_run_playwright_flow",
      argumentsJson: JSON.stringify({ actions: [
        { action: "click", selector: "a[href='/about']" },
        { action: "assert-url", value: "/about" },
        { action: "assert-no-runtime-errors" },
        { action: "set-viewport", width: 1280, height: 800 },
        { action: "assert-no-horizontal-overflow" },
        { action: "set-viewport", width: 375, height: 812 },
        { action: "assert-no-horizontal-overflow" }
      ] }),
      succeeded: true,
      executionStarted: true
    }];
    expect(delphiTestingAgent.validateOutput?.(report, completedCalls, input)).toBeUndefined();
  });

  it("preserves authoritative terminal evidence in report repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-repair-evidence-"));
    const bundle = await ensureFixtureProject(root);
    const input = delphiTestingInputSchema.parse({ objective: "Build and typecheck", platforms: ["generic"] });
    const context = { projectRoot: root, bundle, provider: bundle.project.settings.providers[0]! };
    const toolCalls = [
      { providerToolName: "delphi_inspect_test_environment", argumentsJson: "{}", succeeded: true },
      {
        providerToolName: "archicode_console_run_command",
        argumentsJson: JSON.stringify({ command: "npm run build" }),
        succeeded: true,
        executionStarted: true,
        resultJson: JSON.stringify({ status: "succeeded", exitCode: 0, stdout: "vite build completed successfully" })
      }
    ];
    const report: DelphiTestingOutput = {
      status: "blocked",
      verdict: "blocked",
      summary: "The raw build output was not visible, so I cannot independently confirm it.",
      attempts: 1,
      checks: [{ name: "Build", status: "blocked", evidence: [] }],
      findings: [],
      toolchains: [{ adapter: "generic", status: "ready", evidence: [] }],
      artifacts: [],
      blockers: ["Build output unavailable."],
      recommendedNextSteps: []
    };

    const validationError = await delphiTestingAgent.validateOutput?.(report, toolCalls, input, context);
    expect(validationError).toMatch(/host retained authoritative command results/);
    const repair = delphiTestingAgent.repairMessage?.(input, JSON.stringify(report), validationError!, context, toolCalls);
    expect(repair).toContain("Host-authoritative executed checks");
    expect(repair).toContain("vite build completed successfully");
    expect(repair).toContain("do not downgrade them to inconclusive");
  });

  it("rejects a zero-execution blocked audit when relevant capabilities were never attempted", async () => {
    const input = delphiTestingInputSchema.parse({
      objective: "Build and audit the live website",
      mode: "audit",
      platforms: ["web"],
      commands: ["npm run build"],
      target: { baseUrl: "http://127.0.0.1:4173" }
    });
    const report: DelphiTestingOutput = {
      status: "blocked",
      verdict: "blocked",
      summary: "The command and Playwright results were not available in this isolated session.",
      attempts: 0,
      checks: [],
      findings: [],
      toolchains: [{ adapter: "playwright", status: "ready", evidence: ["Playwright is ready."] }],
      artifacts: [],
      blockers: ["No execution results were returned."],
      recommendedNextSteps: []
    };

    expect(delphiTestingAgent.validateOutput?.(report, [
      { providerToolName: "delphi_inspect_test_environment", argumentsJson: "{}", succeeded: true }
    ], input)).toMatch(/blocked without attempting any relevant command or runtime adapter/);
  });

  it("distinguishes human screenshot evidence from model-visible analysis", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-vision-contract-"));
    const bundle = await ensureFixtureProject(root);
    const input = delphiTestingInputSchema.parse({ objective: "Audit visual behavior", platforms: ["web"] });
    const context = {
      projectRoot: root,
      bundle,
      provider: bundle.project.settings.providers[0]!,
      imageInputSupport: "unknown" as const
    };

    expect(delphiTestingAgent.systemPrompt(input, context)).toContain("Screenshots are still captured for the user's evidence gallery, but their pixels are not available to you");
    const report = {
      status: "completed" as const,
      verdict: "failed" as const,
      summary: "A visual defect was found.",
      attempts: 1,
      checks: [{ name: "Browser", status: "failed" as const, evidence: ["capture"] }],
      findings: [{ title: "Overlap", severity: "medium" as const, category: "visual" as const, detail: "Elements overlap.", reproductionSteps: ["Open page"], evidence: ["capture"] }],
      toolchains: [{ adapter: "playwright" as const, status: "ready" as const, evidence: [] }],
      artifacts: [],
      blockers: [],
      recommendedNextSteps: []
    };
    const runtimeCalls = [
      { providerToolName: "delphi_inspect_test_environment", argumentsJson: "{}", succeeded: true },
      {
        providerToolName: "delphi_run_playwright_flow",
        argumentsJson: JSON.stringify({ actions: [
          { action: "set-viewport", width: 375, height: 812 },
          { action: "assert-no-horizontal-overflow" }
        ] }),
        succeeded: true,
        executionStarted: true
      }
    ];

    expect(delphiTestingAgent.validateOutput?.(report, runtimeCalls, input, context)).toMatch(/without analyzing the pixels/);
    expect(delphiTestingAgent.validateOutput?.(report, [
      ...runtimeCalls,
      { providerToolName: "delphi_analyze_observation", argumentsJson: "{}", succeeded: true }
    ], input, context)).toBeUndefined();

    const unsupportedVisualPass = {
      ...report,
      verdict: "passed" as const,
      summary: "Functional browser assertions passed.",
      checks: [{ name: "Browser", status: "passed" as const, evidence: [".hero is visible"] }],
      findings: []
    };
    expect(delphiTestingAgent.validateOutput?.(unsupportedVisualPass, runtimeCalls, input, context)).toMatch(/selected model cannot inspect screenshot pixels/);

    const honestNonVisionBlock = {
      ...unsupportedVisualPass,
      status: "blocked" as const,
      verdict: "blocked" as const,
      summary: "Functional browser checks passed, but responsive layout could not be visually verified because screenshot-pixel inspection is unavailable.",
      findings: [{
        title: "Responsive visual inspection unavailable",
        severity: "info" as const,
        category: "visual" as const,
        detail: "The selected model cannot inspect captured screenshot pixels, so responsive appearance remains unverified.",
        reproductionSteps: ["Review the captured responsive screenshot with a vision-capable model."],
        evidence: ["Screenshot captured for user review; pixels were not inspected by Delphi."]
      }],
      blockers: ["Pixel-level responsive inspection requires a vision-capable model."]
    };
    expect(delphiTestingAgent.validateOutput?.(honestNonVisionBlock, runtimeCalls, input, context)).toBeUndefined();
  });

  it("requires a vision-capable Delphi model to inspect pixels for an explicit visual audit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-required-vision-"));
    const bundle = await ensureFixtureProject(root);
    const input = delphiTestingInputSchema.parse({
      objective: "Audit the responsive layout and visual quality",
      platforms: ["web"],
      target: { baseUrl: "http://127.0.0.1:4173" }
    });
    const context = {
      projectRoot: root,
      bundle,
      provider: bundle.project.settings.providers[0]!,
      imageInputSupport: "supported" as const,
      analyzeObservation: async () => ({ status: "analyzed" as const, analysis: "The page has no visible clipping." })
    };
    const report = {
      status: "completed" as const,
      verdict: "passed" as const,
      summary: "Functional browser assertions passed.",
      attempts: 1,
      checks: [{ name: "Browser", status: "passed" as const, evidence: [".hero is visible"] }],
      findings: [],
      toolchains: [{ adapter: "playwright" as const, status: "ready" as const, evidence: [] }],
      artifacts: [{ label: "desktop", path: ".archicode/artifacts/delphi/desktop.png" }],
      blockers: [],
      recommendedNextSteps: []
    };
    const runtimeCalls = [
      { providerToolName: "delphi_inspect_test_environment", argumentsJson: "{}", succeeded: true },
      {
        providerToolName: "delphi_run_playwright_flow",
        argumentsJson: JSON.stringify({ actions: [
          { action: "set-viewport", width: 375, height: 812 },
          { action: "assert-no-horizontal-overflow" }
        ] }),
        succeeded: true,
        executionStarted: true
      }
    ];

    expect(delphiTestingAgent.validateOutput?.(report, runtimeCalls, input, context)).toMatch(/without analyzing any captured screenshot pixels/);
    expect(delphiTestingAgent.validateOutput?.(report, [
      ...runtimeCalls,
      { providerToolName: "delphi_analyze_observation", argumentsJson: "{}", succeeded: true }
    ], input, context)).toBeUndefined();
  });

  it("requires visual analysis when a failed browser flow already captured evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-failed-flow-vision-"));
    const bundle = await ensureFixtureProject(root);
    const input = delphiTestingInputSchema.parse({
      objective: "Visually audit the responsive layout",
      platforms: ["web"],
      target: { baseUrl: "http://127.0.0.1:4173" }
    });
    const context = {
      projectRoot: root,
      bundle,
      provider: bundle.project.settings.providers[0]!,
      imageInputSupport: "supported" as const,
      analyzeObservation: async () => ({ status: "analyzed" as const, analysis: "The captured page is visibly readable." })
    };
    const report: DelphiTestingOutput = {
      status: "completed",
      verdict: "failed",
      summary: "The browser URL assertion failed after the page was captured.",
      attempts: 1,
      checks: [{ name: "Browser URL", status: "failed", evidence: ["Expected /about but remained on /"] }],
      findings: [{
        title: "Navigation did not reach /about",
        severity: "medium",
        category: "functional",
        detail: "The browser remained on the landing page.",
        reproductionSteps: ["Open the landing page.", "Attempt the About navigation."],
        evidence: ["The URL assertion failed."]
      }],
      toolchains: [{ adapter: "playwright", status: "ready", evidence: [] }],
      artifacts: [{ label: "landing-before-failure", path: ".archicode/artifacts/delphi/capture-failed.png" }],
      blockers: [],
      recommendedNextSteps: []
    };
    const runtimeCalls = [
      { providerToolName: "delphi_inspect_test_environment", argumentsJson: "{}", succeeded: true },
      {
        providerToolName: "delphi_run_playwright_flow",
        argumentsJson: JSON.stringify({ actions: [{ action: "goto", value: "/" }, { action: "assert-url", value: "/about" }] }),
        succeeded: false,
        executionStarted: true,
        error: "URL assertion failed",
        resultJson: JSON.stringify({
          status: "failed",
          message: "URL assertion failed",
          artifacts: [{ id: "capture-failed", label: "landing-before-failure", path: ".archicode/artifacts/delphi/capture-failed.png", mediaType: "image/png" }]
        })
      }
    ];

    const validationError = await delphiTestingAgent.validateOutput?.(report, runtimeCalls, input, context);
    expect(validationError).toMatch(/without analyzing any captured screenshot pixels/);
    expect(delphiTestingAgent.repairMessage?.(input, JSON.stringify(report), validationError!, context, runtimeCalls))
      .toContain("capture-failed (landing-before-failure)");
    expect(await delphiTestingAgent.validateOutput?.(report, [
      ...runtimeCalls,
      { providerToolName: "delphi_analyze_observation", argumentsJson: JSON.stringify({ artifactId: "capture-failed" }), succeeded: true }
    ], input, context)).toBeUndefined();
  });

  it("lets the shared safety broker decide a newly discovered verification action at execution time", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-command-drift-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { "test:reviewed": "vitest run", "test:added-later": "vitest run changed" }
    }), "utf8");
    const bundle = await ensureFixtureProject(root);
    const input = delphiTestingInputSchema.parse({
      objective: "Audit the reviewed command only",
      platforms: ["generic"],
      commands: ["npm run test:reviewed"]
    });
    const environment = await inspectDelphiTestEnvironment(root, input);
    expect(environment.discoveredCommands).toEqual(expect.arrayContaining(["npm run test:reviewed", "npm run test:added-later"]));
    expect(environment.authorizedCommands).toEqual([]);

    const executed: string[] = [];
    const tools = delphiTestingAgent.tools({
      projectRoot: root,
      bundle,
      provider: bundle.project.settings.providers[0]!,
      runConsoleCommand: async (args) => {
        executed.push(String(args.command));
        return { status: "succeeded" };
      }
    }, input);
    const commandTool = tools.find((tool) => tool.providerToolName === "archicode_console_run_command");
    if (!commandTool) throw new Error("Expected Delphi's guarded command tool.");

    await expect(commandTool.handler({ command: "npm run test:added-later" })).resolves.toMatchObject({ status: "succeeded" });
    await expect(commandTool.handler({ command: "npm run test:reviewed" })).resolves.toMatchObject({ status: "succeeded" });
    expect(executed).toEqual(["npm run test:added-later", "npm run test:reviewed"]);
  });

  it("normalizes recoverable final-report shape variations without discarding audit evidence", () => {
    const parsed = delphiTestingAgent.parseOutput(JSON.stringify({
      status: "completed",
      verdict: "passed",
      summary: "The reviewed checks passed.",
      attempts: 2,
      checks: [{ name: "Typecheck", status: "success", evidence: "exit code 0" }],
      findings: [],
      toolchains: [{ name: "Playwright", status: "available", evidence: "Project configuration detected." }],
      artifacts: [{ path: ".archicode/artifacts/delphi-report.json" }],
      blockers: "",
      recommendedNextSteps: "Keep the existing checks in CI."
    }));

    expect(parsed).toMatchObject({
      checks: [{ name: "Typecheck", status: "passed", evidence: ["exit code 0"] }],
      toolchains: [{ adapter: "playwright", status: "ready", evidence: ["Project configuration detected."] }],
      artifacts: [{ label: "delphi-report.json", path: ".archicode/artifacts/delphi-report.json" }],
      blockers: [],
      recommendedNextSteps: ["Keep the existing checks in CI."]
    });
  });

  it("assembles executed checks, attempts, and artifacts from host tool results", () => {
    const parsed = delphiTestingAgent.parseOutput("The provider omitted its final JSON.", [
      {
        providerToolName: "delphi_inspect_test_environment",
        argumentsJson: "{}",
        succeeded: true,
        resultJson: JSON.stringify({ toolchains: [{ adapter: "playwright", status: "ready", evidence: ["managed cache"] }] })
      },
      {
        providerToolName: "delphi_run_playwright_flow",
        argumentsJson: JSON.stringify({ actions: [{ action: "goto" }] }),
        succeeded: true,
        executionStarted: true,
        resultJson: JSON.stringify({
          status: "passed",
          finalUrl: "http://127.0.0.1:4173/",
          actions: [{ index: 0, action: "goto", detail: "http://127.0.0.1:4173/" }],
          artifacts: [{ id: "capture-1", label: "final", path: ".archicode/artifacts/delphi/final.png", mediaType: "image/png" }]
        })
      }
    ]) as DelphiTestingOutput;

    expect(parsed.attempts).toBe(1);
    expect(parsed.checks).toEqual([expect.objectContaining({ name: "Playwright live target flow", status: "passed" })]);
    expect(parsed.toolchains).toEqual([expect.objectContaining({ adapter: "playwright", status: "ready" })]);
    expect(parsed.artifacts).toEqual([expect.objectContaining({ id: "capture-1" })]);
  });

  it("does not turn a corrected selector attempt into a final product defect", () => {
    const parsed = delphiTestingAgent.parseOutput(JSON.stringify({
      status: "completed",
      verdict: "passed",
      summary: "The corrected browser flow passed.",
      attempts: 2,
      checks: [],
      findings: [],
      toolchains: [{ adapter: "playwright", status: "ready", evidence: [] }],
      artifacts: [],
      blockers: [],
      recommendedNextSteps: []
    }), [
      {
        providerToolName: "delphi_run_playwright_flow",
        argumentsJson: JSON.stringify({ actions: [{ action: "click", selector: "a[href='/about']" }] }),
        succeeded: false,
        executionStarted: true,
        error: "SELECTOR_AMBIGUOUS: selector matched two elements"
      },
      {
        providerToolName: "delphi_run_playwright_flow",
        argumentsJson: JSON.stringify({ actions: [{ action: "click", selector: "a[href='/about']:has-text('About')" }] }),
        succeeded: true,
        executionStarted: true,
        resultJson: JSON.stringify({
          status: "passed",
          finalUrl: "http://127.0.0.1:4173/about",
          actions: [{ action: "click", detail: "Opened /about" }],
          artifacts: []
        })
      }
    ]) as DelphiTestingOutput;

    expect(parsed.verdict).toBe("passed");
    expect(parsed.checks).toEqual([expect.objectContaining({ status: "passed" })]);
    expect(parsed.findings).toEqual([]);
  });

  it("accepts the local-model visual prompt alias and exposes capture suppression", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-corrective-args-"));
    const bundle = await ensureFixtureProject(root);
    const input = delphiTestingInputSchema.parse({
      objective: "Audit a live browser visually",
      platforms: ["web"],
      target: { baseUrl: "http://127.0.0.1:4173" }
    });
    const tools = delphiTestingAgent.tools({
      projectRoot: root,
      bundle,
      provider: bundle.project.settings.providers[0]!,
      imageInputSupport: "supported",
      analyzeObservation: async () => ({ status: "analyzed" as const, analysis: "No clipping is visible." })
    }, input);
    const playwrightTool = tools.find((tool) => tool.providerToolName === "delphi_run_playwright_flow");
    const visualTool = tools.find((tool) => tool.providerToolName === "delphi_analyze_observation");
    if (!playwrightTool || !visualTool) throw new Error("Expected Delphi browser and visual tools.");

    const playwrightSchema = playwrightTool.inputSchema as { properties?: { capture?: { enum?: string[] } } };
    expect(playwrightSchema.properties?.capture?.enum).toEqual(["none"]);
    await expect(visualTool.handler({ artifactId: "missing", prompt: "Is any text visibly clipped?" }))
      .rejects.toThrow(/limited to an artifact captured by this Delphi audit/);
    await expect(visualTool.handler({ artifactId: "missing" }))
      .rejects.toThrow(/focused visual QA question/);
  });

  it("keeps a screenshot captured before a browser assertion failure available to the vision tool", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-partial-capture-"));
    const packageRoot = path.join(root, "node_modules", "playwright");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "partial-capture-fixture", private: true }), "utf8");
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "playwright", version: "1.0.0", type: "module", main: "index.js" }), "utf8");
    await writeFile(path.join(packageRoot, "index.js"), `
      let currentUrl = "about:blank";
      const page = {
        on() {},
        setDefaultTimeout() {},
        async goto(url) { currentUrl = String(url); },
        url() { return currentUrl; },
        async title() { return "Fixture"; },
        async screenshot() { return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); }
      };
      const launch = async () => ({ newPage: async () => page, close: async () => {} });
      export const chromium = { launch };
      export const firefox = { launch };
      export const webkit = { launch };
    `, "utf8");
    const bundle = await ensureFixtureProject(root);
    const input = delphiTestingInputSchema.parse({
      objective: "Visually inspect the landing page",
      platforms: ["web"],
      target: { baseUrl: "http://127.0.0.1:4173" }
    });
    const emitted: Array<{ id: string; label: string }> = [];
    const analyzed: string[] = [];
    const tools = delphiTestingAgent.tools({
      projectRoot: root,
      bundle,
      provider: bundle.project.settings.providers[0]!,
      imageInputSupport: "supported",
      onArtifact: (artifact) => emitted.push(artifact),
      analyzeObservation: async ({ artifact }) => {
        analyzed.push(artifact.id);
        return { status: "analyzed" as const, analysis: "The landing page pixels are visible." };
      }
    }, input);
    const playwrightTool = tools.find((tool) => tool.providerToolName === "delphi_run_playwright_flow");
    const visualTool = tools.find((tool) => tool.providerToolName === "delphi_analyze_observation");
    if (!playwrightTool || !visualTool) throw new Error("Expected Delphi browser and visual tools.");

    let failure: unknown;
    try {
      await playwrightTool.handler({ actions: [
        { action: "goto", value: "/" },
        { action: "screenshot", label: "landing-before-failure", purpose: "Preserve the state before the URL assertion" },
        { action: "assert-url", value: "/about" }
      ] });
    } catch (error) {
      failure = error;
    }
    const partialResult = (failure as Error & { partialResult?: { status?: string; artifacts?: Array<{ id: string; label: string }> } }).partialResult;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Captured observations remain available for visual analysis/);
    expect((failure as Error & { executionStarted?: boolean }).executionStarted).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(partialResult).toMatchObject({ status: "failed", artifacts: [expect.objectContaining({ id: emitted[0]!.id })] });

    await expect(visualTool.handler({ artifactId: emitted[0]!.id, question: "Is the landing page visibly readable?" }))
      .resolves.toMatchObject({ status: "analyzed" });
    expect(analyzed).toEqual([emitted[0]!.id]);
  });

  it("reports executed assertions instead of total browser actions and removes non-vision layout claims", () => {
    const parsed = delphiTestingAgent.parseOutput(JSON.stringify({
      status: "completed",
      verdict: "passed",
      summary: "6 Playwright checks passed and the responsive layout is intact.",
      attempts: 1,
      checks: [],
      findings: [],
      toolchains: [{ adapter: "playwright", status: "ready", evidence: [] }],
      artifacts: [],
      blockers: [],
      recommendedNextSteps: []
    }), [
      {
        providerToolName: "delphi_run_playwright_flow",
        argumentsJson: "{}",
        succeeded: true,
        executionStarted: true,
        resultJson: JSON.stringify({
          status: "passed",
          actions: [
            { action: "goto", detail: "http://127.0.0.1:4173/" },
            { action: "set-viewport", detail: "375x812" },
            { action: "assert-url", detail: "URL is /" },
            { action: "assert-visible", detail: "h1 is visible" },
            { action: "assert-no-runtime-errors", detail: "No runtime errors" },
            { action: "assert-no-horizontal-overflow", detail: "No horizontal overflow" }
          ],
          artifacts: []
        })
      }
    ]) as DelphiTestingOutput;

    expect(parsed.summary).toBe("4/4 assertions passed and no horizontal overflow detected.");
    expect(parsed.summary).not.toContain("6 Playwright checks");
    expect(parsed.summary).not.toContain("responsive layout");
  });

  it("installs approved Playwright components into the managed cache without editing the project", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-delphi-install-project-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "archicode-delphi-install-cache-"));
    setDelphiToolCacheRoot(cacheRoot);
    const labels: string[] = [];

    const result = await installDelphiManagedTool(projectRoot, {
      adapter: "playwright",
      playwrightBrowsers: ["chromium"]
    }, {
      runStep: async (step) => {
        labels.push(step.label);
        if (step.label.startsWith("Installing playwright")) {
          const packageRoot = path.join(step.cwd, "node_modules", "playwright");
          await mkdir(packageRoot, { recursive: true });
          await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "playwright", version: "7.8.9" }), "utf8");
        }
        return { label: step.label, exitCode: 0, output: "ok" };
      }
    });

    expect(result).toMatchObject({ adapter: "playwright", installed: true, version: "7.8.9" });
    expect(labels).toEqual([
      "Installing playwright in ArchiCode's managed Delphi cache",
      "Downloading managed Playwright browser: chromium"
    ]);
    await expect(access(path.join(projectRoot, "package.json"))).rejects.toThrow();
  });

  it("keeps approved Appium drivers inside the managed cache", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-delphi-appium-project-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "archicode-delphi-appium-cache-"));
    setDelphiToolCacheRoot(cacheRoot);
    let driverHome = "";

    const result = await installDelphiManagedTool(projectRoot, {
      adapter: "appium",
      appiumDrivers: ["uiautomator2"]
    }, {
      runStep: async (step) => {
        if (step.label.startsWith("Installing appium in")) {
          const packageRoot = path.join(step.cwd, "node_modules", "appium");
          await mkdir(packageRoot, { recursive: true });
          await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "appium", version: "3.4.5" }), "utf8");
        }
        if (step.label.includes("uiautomator2")) driverHome = step.env?.APPIUM_HOME ?? "";
        return { label: step.label, exitCode: 0, output: "ok" };
      }
    });

    expect(result).toMatchObject({ adapter: "appium", installed: true, version: "3.4.5" });
    expect(driverHome).toBe(delphiManagedAppiumHome(projectRoot));
    expect(driverHome.startsWith(cacheRoot)).toBe(true);
  });
});
