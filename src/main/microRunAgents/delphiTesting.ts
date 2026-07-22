import type { MicroRunAgent, MicroRunContext, MicroRunTool, MicroRunToolInvocation } from "../microRuns";
import {
  delphiTestingInputSchema,
  delphiTestingOutputSchema,
  type DelphiTestingInput,
  type DelphiTestingOutput
} from "../../shared/schema";
import { canonicalizeDelphiPlaywrightActions, runDelphiPlaywrightFlow, type DelphiPlaywrightAction } from "../testing/playwrightAdapter";
import { runDelphiAppiumFlow, type DelphiAppiumAction } from "../testing/appiumAdapter";
import { runDelphiMobileTargetFlow, type DelphiMobileTargetAction } from "../testing/mobileTargetAdapter";
import type { DelphiObservationArtifact } from "../testing/evidenceArtifacts";
import { createReadOnlyInvestigationTools, extractJsonObject } from "./readOnlyTools";
import { createGuardedConsoleTool } from "./guardedConsole";

const DELPHI_TIMEOUT_MS = 45 * 60 * 1000;
const DELPHI_MAX_OBSERVATION_ARTIFACTS = 12;

function capturedObservationRefs(toolCalls: MicroRunToolInvocation[]): Array<{ id: string; label: string }> {
  const refs = new Map<string, { id: string; label: string }>();
  for (const call of toolCalls) {
    if (!call.resultJson || !["delphi_run_playwright_flow", "delphi_run_appium_flow", "delphi_run_mobile_target_flow"].includes(call.providerToolName)) continue;
    try {
      const result = JSON.parse(call.resultJson) as { artifacts?: Array<{ id?: unknown; label?: unknown }> };
      for (const artifact of result.artifacts ?? []) {
        if (typeof artifact.id !== "string" || !artifact.id.trim()) continue;
        refs.set(artifact.id, {
          id: artifact.id,
          label: typeof artifact.label === "string" && artifact.label.trim() ? artifact.label : artifact.id
        });
      }
    } catch {
      // A malformed tool result is handled by the normal evidence validation;
      // it simply cannot supply a visual-repair target here.
    }
  }
  return [...refs.values()];
}

function systemPrompt(input: unknown, context: MicroRunContext): string {
  const task = delphiTestingInputSchema.parse(input);
  return [
    "You are Delphi, ArchiCode's Test & Runtime Oracle.",
    "Audit the assigned project behavior in a fresh isolated context. You are evidence-first: never report a pass without an executed check, and never infer a visual or mobile result from source code alone.",
    "Choose your own investigation and execution tactics from the available capabilities. inspect_test_environment can reveal project scripts, runtime profiles, and adapter readiness; project reads can clarify tests and configuration when useful.",
    task.mode === "plan" ? "This is plan mode. Inspect the environment but do not execute test commands."
      : task.mode === "setup" ? "This setup request must be executed by the host approval flow, not by this model run. Do not execute commands."
        : "Run the smallest relevant finite checks, then report exact failures and evidence. You may retry a failing check only when the retry adds evidence (for example, confirming flakiness); do not burn attempts repeating an unchanged deterministic failure.",
    "The approved audit grants a bounded project-verification capability, not a prewritten command sequence. Choose finite project-local checks that materially support the objective; every chosen action is still evaluated by the shared safety broker. Dependency installation, upgrades, deployments, and source-file edits are outside this audit. If tooling is missing, return needs-setup with the host-provided approval-required install plan.",
    "For web/Electron work, use the direct Playwright adapter against the approved live URL when available; do not substitute source review or CLI tests for requested UI coverage. Choose the browser states and assertions that adequately support the objective, and report any requested coverage you could not verify. For Flutter, use existing Flutter unit/widget/integration tests. For Android/iOS, use the explicit launched device target through the native adapter for bounded readiness/screenshots (and Android interaction), or Appium when a session is available.",
    task.observation.mode === "visible"
      ? "This is an observable audit. Open supported targets visibly so the user can watch. Capture screenshots only when a distinct state materially supports a check, finding, or requested visual comparison."
      : "This audit may run headlessly. Capture screenshots only when a distinct state materially supports the report.",
    "A source review is not a visual test. A test command is not an emulator audit unless it actually exercised the selected emulator/device.",
    "A captured screenshot is evidence, not by itself proof that the layout is correct. DOM/runtime assertions support only the exact conditions they assert; pixel-level layout or visual-quality conclusions require an executed visual-regression check or actual screenshot-pixel analysis.",
    "Report the number of executed assert-* actions as assertions. Never label the total Playwright action count as checks or assertions. Without screenshot-pixel analysis, say no horizontal overflow was detected when that assertion passed; do not call the responsive layout intact, correct, or visually verified.",
    task.visualInspection === "pixel" && context.analyzeObservation
      ? "The caller explicitly requested pixel-level visual inspection and the selected Delphi model supports image input. Screenshot paths returned by runtime adapters do not expose their pixels to you; use delphi_analyze_observation on enough relevant captured states to support that requested coverage. Each captured artifact may be analyzed once."
      : task.visualInspection === "pixel"
        ? `The caller explicitly requested pixel-level visual inspection, but the selected Delphi model's image-input capability is ${context.imageInputSupport ?? "unknown"}. Screenshots may still be captured for the user's evidence gallery, but their pixels are not available to you. Preserve functional results and return visual coverage as blocked; do not return visual-category findings based only on screenshot paths.`
        : task.visualInspection === "capture"
          ? "The caller requested screenshots for human review, not model pixel analysis. Capture purposeful states, but do not turn their paths into visual-quality conclusions or visual-category findings."
          : "The caller did not request visual inspection. Do not broaden the audit into visual-quality evaluation.",
    `The audit has an overall time/resource boundary and a ceiling of ${DELPHI_MAX_OBSERVATION_ARTIFACTS} screenshots. These are ceilings, never quotas or KPIs. Do not repeat a command, browser flow, or screenshot unless the repetition answers a concrete unresolved question. Give each screenshot a descriptive label and purpose, and stop collecting evidence once the objective is supported.`,
    "Return exactly one JSON object with: status, verdict, summary, attempts, checks, findings, toolchains, artifacts, blockers, recommendedNextSteps.",
    "status is completed, blocked, or needs-setup. verdict is passed, failed, blocked, or not-run. Include commands and concise evidence in checks. Findings must include severity, category, detail, reproductionSteps, and evidence. Finding category must be one of: functional, visual, accessibility, performance, compatibility, tooling, or other.",
    "Schema details: checks[].evidence, findings[].evidence, and findings[].reproductionSteps are arrays of strings. Each toolchain requires adapter (playwright, flutter-integration-test, appium, project-native, or generic), status (ready, missing, or unsupported), and an evidence array. Each artifact requires label and path.",
    `Mode: ${task.mode}.`,
    task.platforms.length ? `Requested platforms: ${task.platforms.join(", ")}.` : "No platform was specified; infer only from direct project evidence.",
    task.target ? `Explicit audit target: ${JSON.stringify(task.target)}.` : "No runtime/device target was selected. Do not claim an emulator, simulator, device, or live URL was exercised.",
    task.scope ? `Scope: ${task.scope}` : "",
    task.acceptanceCriteria.length ? `Acceptance criteria: ${task.acceptanceCriteria.join("; ")}` : "",
    task.commands.length ? `Caller-suggested checks (advisory, not exhaustive): ${task.commands.join(" | ")}` : ""
  ].filter(Boolean).join("\n");
}

function userMessage(input: unknown): string {
  const task = delphiTestingInputSchema.parse(input);
  return `Audit this objective and return only the structured Delphi report:\n\n${task.objective}`;
}

function commandTool(context: MicroRunContext, input: DelphiTestingInput): MicroRunTool | undefined {
  return createGuardedConsoleTool(context, {
    description: "Run one bounded project verification chosen for the audit objective. The shared safety broker evaluates the actual action. Dependency setup, deployment, and source edits are outside Delphi's audit capability.",
    progressLabel: "Running audit check",
    unavailableWhen: input.mode === "plan" || input.mode === "setup",
    requireExecution: true,
    beforeRun: async (command) => {
      const { isDependencySetupCommand } = await import("../testing/toolchains");
      if (isDependencySetupCommand(command)) {
        throw new Error("Delphi never installs dependencies inside an audit. Inspect the test environment and return its approval-required setup plan.");
      }
    }
  });
}

function tools(context: MicroRunContext, rawInput: unknown): MicroRunTool[] {
  const input = delphiTestingInputSchema.parse(rawInput);
  const observationArtifacts = new Map<string, DelphiObservationArtifact>();
  const analyzedArtifactIds = new Set<string>();
  let environmentPromise: Promise<unknown> | undefined;
  const remainingArtifactBudget = (): number => Math.max(0, DELPHI_MAX_OBSERVATION_ARTIFACTS - observationArtifacts.size);
  const recordObservationArtifact = (artifact: DelphiObservationArtifact): void => {
    observationArtifacts.set(artifact.id, artifact);
    context.onArtifact?.(artifact);
  };

  const runDirectAdapter = async <T extends { artifacts: DelphiObservationArtifact[] }>(
    label: string,
    operation: (maxArtifacts: number, onExecutionStart: () => void) => Promise<T>
  ): Promise<T> => {
    const artifactsBeforeAttempt = new Set(observationArtifacts.keys());
    let executionStarted = false;
    const onExecutionStart = (): void => {
      if (executionStarted) return;
      executionStarted = true;
      context.onProgress?.(`Running ${label}`);
    };
    try {
      const result = await operation(remainingArtifactBudget(), onExecutionStart);
      for (const artifact of result.artifacts) observationArtifacts.set(artifact.id, artifact);
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const capturedArtifacts = [...observationArtifacts.values()].filter((artifact) => !artifactsBeforeAttempt.has(artifact.id));
      if (executionStarted) {
        Object.defineProperty(failure, "executionStarted", { value: true, configurable: true });
      }
      if (capturedArtifacts.length) {
        const originalMessage = failure.message;
        Object.defineProperty(failure, "partialResult", {
          value: { status: "failed", message: originalMessage, artifacts: capturedArtifacts },
          configurable: true
        });
        failure.message = `${originalMessage}\nCaptured observations remain available for visual analysis: ${capturedArtifacts.map((artifact) => `${artifact.id} (${artifact.label})`).join("; ")}`;
      }
      throw failure;
    }
  };
  const inspectTool: MicroRunTool = {
    providerToolName: "delphi_inspect_test_environment",
    serverId: "archicode-delphi",
    serverLabel: "Delphi Test Adapter",
    toolName: "inspect_test_environment",
    description: "Inspect project test ecosystems, finite commands, and Playwright/Flutter/Appium adapter readiness. Missing tooling returns a non-mutating approval-required setup plan.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    handler: async () => {
      context.onProgress?.("Inspecting test frameworks and adapter readiness");
      if (!environmentPromise) {
        environmentPromise = import("../testing/toolchains").then(({ inspectDelphiTestEnvironment }) => inspectDelphiTestEnvironment(context.projectRoot, input));
      }
      return environmentPromise;
    }
  };
  const executable = commandTool(context, input);
  const playwrightTool: MicroRunTool | undefined = input.mode !== "setup" && input.target?.baseUrl ? {
    providerToolName: "delphi_run_playwright_flow",
    serverId: "archicode-delphi",
    serverLabel: "Delphi Playwright Adapter",
    toolName: "run_playwright_flow",
    description: `Control the explicitly approved app/site origin in a fresh ${input.observation.mode === "visible" ? "visible" : "headless"} Playwright browser. Supports bounded navigation, interaction, exact URL assertions, console/page/resource-error assertions, horizontal-overflow assertions, viewport changes, and durable PNG screenshots. Choose the actions and purposeful evidence needed for the audit goal; the host validates that reported conclusions are supported. Navigation cannot leave the approved origin.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["actions"],
      properties: {
        browser: { type: "string", enum: ["chromium", "firefox", "webkit"] },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
        capture: {
          type: "string",
          enum: ["none"],
          description: "Suppress additional screenshots for a corrective flow after sufficient evidence was already captured. The approved observation policy remains the default."
        },
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 80,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["action"],
            properties: {
              action: { type: "string", enum: ["goto", "click", "fill", "press", "wait-for", "assert-text", "assert-visible", "assert-url", "assert-no-runtime-errors", "assert-no-horizontal-overflow", "screenshot", "set-viewport"] },
              selector: { type: "string" },
              value: { type: "string" },
              state: { type: "string", enum: ["attached", "detached", "visible", "hidden"] },
              label: { type: "string" },
              purpose: { type: "string", description: "For screenshot actions, the distinct report question or state this capture supports." },
              fullPage: { type: "boolean" },
              width: { type: "integer", minimum: 240, maximum: 3840 },
              height: { type: "integer", minimum: 240, maximum: 2160 }
            }
          }
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const browser = args.browser === "firefox" || args.browser === "webkit" ? args.browser : "chromium";
      const actions = canonicalizeDelphiPlaywrightActions(Array.isArray(args.actions) ? args.actions as DelphiPlaywrightAction[] : []);
      // Normalize in place so the recorded invocation (coverage checks,
      // diagnostics) carries the exact form that passed the tool boundary.
      args.actions = actions;
      if (!actions.length) throw new Error("At least one Playwright action is required.");
      const missingScreenshotPurpose = actions.find((action) => action.action === "screenshot" && (!action.label?.trim() || !action.purpose?.trim()));
      if (missingScreenshotPurpose) throw new Error("Every screenshot action needs a descriptive label and purpose. Screenshots are evidence chosen by Delphi, not an automatic quota.");
      return runDirectAdapter("Playwright audit flow", (maxArtifacts, onExecutionStart) => runDelphiPlaywrightFlow(context.projectRoot, {
        baseUrl: input.target!.baseUrl!,
        browser,
        actions,
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        observationMode: input.observation.mode,
        capture: args.capture === "none" ? "none" : input.observation.capture
      }, { signal: context.signal, onProgress: context.onProgress, onArtifact: recordObservationArtifact, maxArtifacts, onExecutionStart }));
    }
  } : undefined;
  const appiumTool: MicroRunTool | undefined = input.mode !== "setup" && input.target?.appiumServerUrl && input.target?.appiumSessionId ? {
    providerToolName: "delphi_run_appium_flow",
    serverId: "archicode-delphi",
    serverLabel: "Delphi Appium Adapter",
    toolName: "run_appium_flow",
    description: "Control one explicitly supplied existing Appium session on localhost. Delphi never starts Appium, creates a session, chooses a device, or boots an emulator implicitly.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["actions"],
      properties: {
        capture: {
          type: "string",
          enum: ["none"],
          description: "Suppress additional screenshots for a corrective flow after sufficient evidence was already captured."
        },
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 80,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["action"],
            properties: {
              action: { type: "string", enum: ["find", "click", "fill", "assert-text", "back", "source", "screenshot"] },
              using: { type: "string", enum: ["accessibility id", "id", "xpath", "class name", "-android uiautomator", "-ios predicate string"] },
              selector: { type: "string" },
              value: { type: "string" },
              label: { type: "string" },
              purpose: { type: "string", description: "For screenshot actions, the distinct report question or state this capture supports." }
            }
          }
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const actions = Array.isArray(args.actions) ? args.actions as DelphiAppiumAction[] : [];
      if (!actions.length) throw new Error("At least one Appium action is required.");
      if (actions.some((action) => action.action === "screenshot" && (!action.label?.trim() || !action.purpose?.trim()))) throw new Error("Every screenshot action needs a descriptive label and purpose.");
      return runDirectAdapter("Appium audit flow", (maxArtifacts, onExecutionStart) => runDelphiAppiumFlow(context.projectRoot, {
        serverUrl: input.target!.appiumServerUrl!,
        sessionId: input.target!.appiumSessionId!,
        actions,
        capture: args.capture === "none" ? "none" : input.observation.capture
      }, { signal: context.signal, onProgress: context.onProgress, onArtifact: recordObservationArtifact, maxArtifacts, onExecutionStart }));
    }
  } : undefined;
  const nativePlatform = input.platforms.includes("android") ? "android" : input.platforms.includes("ios") ? "ios" : undefined;
  const mobileTargetTool: MicroRunTool | undefined = input.mode !== "setup" && nativePlatform && input.target?.deviceId ? {
    providerToolName: "delphi_run_mobile_target_flow",
    serverId: "archicode-delphi",
    serverLabel: "Delphi Mobile Target Adapter",
    toolName: "run_mobile_target_flow",
    description: "Audit the explicitly selected running Android emulator/device or iOS simulator. Android supports readiness, screenshots, taps, safe text/key input, UI hierarchy, assertions, and URL opening. Native iOS supports readiness, screenshots, and URL opening; use an explicit Appium session for richer iOS interaction.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["actions"],
      properties: {
        capture: {
          type: "string",
          enum: ["none"],
          description: "Suppress additional screenshots for a corrective flow after sufficient evidence was already captured."
        },
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 80,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["action"],
            properties: {
              action: { type: "string", enum: ["assert-device-ready", "screenshot", "tap", "text", "keyevent", "dump-ui", "assert-text", "open-url"] },
              x: { type: "number" },
              y: { type: "number" },
              value: { type: "string" },
              label: { type: "string" },
              purpose: { type: "string", description: "For screenshot actions, the distinct report question or state this capture supports." }
            }
          }
        }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const actions = Array.isArray(args.actions) ? args.actions as DelphiMobileTargetAction[] : [];
      if (!actions.length) throw new Error("At least one mobile target action is required.");
      if (actions.some((action) => action.action === "screenshot" && (!action.label?.trim() || !action.purpose?.trim()))) throw new Error("Every screenshot action needs a descriptive label and purpose.");
      return runDirectAdapter(`${nativePlatform} target audit flow`, (maxArtifacts, onExecutionStart) => runDelphiMobileTargetFlow(context.projectRoot, {
        platform: nativePlatform,
        deviceId: input.target!.deviceId!,
        actions,
        capture: args.capture === "none" ? "none" : input.observation.capture
      }, { signal: context.signal, onProgress: context.onProgress, onArtifact: recordObservationArtifact, maxArtifacts, onExecutionStart }));
    }
  } : undefined;
  const analyzeObservationTool: MicroRunTool | undefined = context.analyzeObservation ? {
    providerToolName: "delphi_analyze_observation",
    serverId: "archicode-delphi",
    serverLabel: "Delphi Visual Observation",
    toolName: "analyze_observation",
    description: "Analyze the actual pixels of one screenshot captured by a Delphi runtime adapter. This is the only tool that gives the model visual access to a captured observation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["artifactId", "question"],
      properties: {
        artifactId: { type: "string", minLength: 1, description: "The exact artifact id returned by a Delphi runtime adapter." },
        question: { type: "string", minLength: 1, maxLength: 1000, description: "A focused visual QA question about this capture." }
      }
    },
    handler: async (args: Record<string, unknown>) => {
      const artifactId = typeof args.artifactId === "string" ? args.artifactId.trim() : "";
      const question = typeof args.question === "string"
        ? args.question.trim()
        : typeof args.prompt === "string"
          ? args.prompt.trim()
          : "";
      if (!question) throw new Error("A focused visual QA question is required.");
      const artifact = observationArtifacts.get(artifactId);
      if (!artifact) throw new Error("Visual analysis is limited to an artifact captured by this Delphi audit. Use an exact artifact id returned by a runtime adapter.");
      if (analyzedArtifactIds.has(artifactId)) throw new Error("This captured artifact was already analyzed. Use its existing visual result or analyze a different captured state.");
      const result = await context.analyzeObservation!({ artifact, question });
      analyzedArtifactIds.add(artifactId);
      return result;
    }
  } : undefined;
  return [
    ...createReadOnlyInvestigationTools(context, { includeWeb: false }),
    inspectTool,
    ...(executable ? [executable] : []),
    ...(playwrightTool ? [playwrightTool] : []),
    ...(appiumTool ? [appiumTool] : []),
    ...(mobileTargetTool ? [mobileTargetTool] : []),
    ...(analyzeObservationTool ? [analyzeObservationTool] : [])
  ];
}

function delphiRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function delphiString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function delphiStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(delphiString).filter((entry): entry is string => Boolean(entry));
  const single = delphiString(value);
  return single ? [single] : [];
}

function delphiCheckStatus(value: unknown): unknown {
  const status = delphiString(value)?.toLowerCase();
  if (status === "pass" || status === "success" || status === "succeeded") return "passed";
  if (status === "fail" || status === "error") return "failed";
  if (status === "block") return "blocked";
  if (status === "skip" || status === "not-run" || status === "not run") return "skipped";
  return value;
}

function delphiFindingSeverity(value: unknown): DelphiTestingOutput["findings"][number]["severity"] {
  const severity = delphiString(value)?.toLowerCase();
  if (severity === "informational" || severity === "notice") return "info";
  if (severity === "warning" || severity === "warn" || severity === "moderate") return "medium";
  if (severity === "error" || severity === "major") return "high";
  if (severity === "blocker" || severity === "fatal") return "critical";
  if (["info", "low", "medium", "high", "critical"].includes(severity ?? "")) {
    return severity as DelphiTestingOutput["findings"][number]["severity"];
  }
  return "info";
}

/**
 * Finding categories are presentation metadata, not evidence. Providers often
 * return useful, more-specific labels such as `responsive-layout` or
 * `verification-coverage`; normalize those labels instead of silently dropping
 * the entire evidence-backed finding and trapping the agent in contract repair.
 */
export function normalizeDelphiFindingCategory(value: unknown): DelphiTestingOutput["findings"][number]["category"] {
  const category = delphiString(value)?.toLowerCase().replace(/[\s_]+/g, "-") ?? "";
  if (["functional", "visual", "accessibility", "performance", "compatibility", "tooling", "other"].includes(category)) {
    return category as DelphiTestingOutput["findings"][number]["category"];
  }
  if (/(?:visual|layout|responsive|appearance|design|styling|spacing|alignment|contrast)/.test(category)
    || /\b(?:ui|ux)\b/.test(category)) return "visual";
  if (/(?:accessib|a11y|aria|keyboard|screen-reader)/.test(category)) return "accessibility";
  if (/(?:performance|latency|speed|memory|cpu|bundle-size)/.test(category)) return "performance";
  if (/(?:compatib|browser|platform|device|cross-platform)/.test(category)) return "compatibility";
  if (/(?:tool|build|test|verification|coverage|environment|dependency|setup|configuration)/.test(category)) return "tooling";
  if (/(?:function|behavior|navigation|runtime|interaction)/.test(category)) return "functional";
  return "other";
}

function normalizeDelphiFinding(value: unknown, index: number): DelphiTestingOutput["findings"][number] | undefined {
  const entry = delphiRecord(value);
  if (!entry) {
    const detail = delphiString(value);
    return detail ? {
      title: detail.slice(0, 160),
      severity: "info",
      category: "other",
      detail,
      reproductionSteps: [],
      evidence: []
    } : undefined;
  }
  const detail = delphiString(entry.detail)
    ?? delphiString(entry.description)
    ?? delphiString(entry.message)
    ?? delphiString(entry.summary)
    ?? delphiString(entry.title);
  if (!detail) return undefined;
  const title = delphiString(entry.title)
    ?? delphiString(entry.name)
    ?? detail.split(/(?<=[.!?])\s+/)[0]!.slice(0, 160)
    ?? `Delphi finding ${index + 1}`;
  return {
    title,
    severity: delphiFindingSeverity(entry.severity),
    category: normalizeDelphiFindingCategory(entry.category),
    detail,
    reproductionSteps: delphiStringList(entry.reproductionSteps ?? entry.steps ?? entry.reproduction),
    evidence: delphiStringList(entry.evidence)
  };
}

function delphiToolchainAdapter(entry: Record<string, unknown>): string {
  const explicit = delphiString(entry.adapter);
  if (["playwright", "flutter-integration-test", "appium", "project-native", "generic"].includes(explicit ?? "")) return explicit!;
  const label = [entry.adapter, entry.name, entry.toolchain, entry.label].map(delphiString).filter(Boolean).join(" ").toLowerCase();
  if (label.includes("playwright")) return "playwright";
  if (label.includes("flutter")) return "flutter-integration-test";
  if (label.includes("appium")) return "appium";
  if (/android|ios|adb|simctl|native/.test(label)) return "project-native";
  return "generic";
}

function delphiToolchainStatus(value: unknown): unknown {
  const status = delphiString(value)?.toLowerCase();
  if (["ready", "available", "installed", "present", "passed", "pass"].includes(status ?? "")) return "ready";
  if (["missing", "unavailable", "not-installed", "not installed", "absent"].includes(status ?? "")) return "missing";
  if (["unsupported", "not-supported", "not supported"].includes(status ?? "")) return "unsupported";
  return value;
}

function delphiArtifact(value: unknown): unknown {
  if (typeof value === "string") {
    const artifactPath = value.trim();
    return { label: artifactPath.split(/[\\/]/).pop() || "Delphi artifact", path: artifactPath };
  }
  const entry = delphiRecord(value);
  if (!entry) return value;
  const artifactPath = delphiString(entry.path) ?? "";
  const label = delphiString(entry.label)
    ?? delphiString(entry.title)
    ?? delphiString(entry.name)
    ?? artifactPath.split(/[\\/]/).pop()
    ?? "Delphi artifact";
  return { ...entry, label, path: artifactPath };
}

function invocationResult(call: MicroRunToolInvocation | undefined): Record<string, unknown> | undefined {
  if (!call) return undefined;
  if (!call.resultJson) return undefined;
  try {
    return delphiRecord(JSON.parse(call.resultJson));
  } catch {
    return undefined;
  }
}

function invocationArguments(call: MicroRunToolInvocation): Record<string, unknown> {
  try {
    return delphiRecord(JSON.parse(call.argumentsJson || "{}")) ?? {};
  } catch {
    return {};
  }
}

function invocationEvidence(result: Record<string, unknown> | undefined, error?: string): string[] {
  const evidence = [
    ...delphiStringList(result?.evidence),
    ...delphiStringList(result?.outputSummary),
    ...delphiStringList(result?.stdout),
    ...delphiStringList(result?.stderr),
    ...delphiStringList(result?.finalUrl),
    ...delphiStringList(result?.consoleErrors),
    ...delphiStringList(result?.pageErrors),
    ...delphiStringList(result?.requestErrors),
    ...(Array.isArray(result?.actions) ? result.actions.flatMap((value) => {
      const action = delphiRecord(value);
      return action ? delphiStringList(action.detail) : [];
    }) : []),
    ...(Array.isArray(result?.artifacts) ? result.artifacts.flatMap((value) => {
      const artifact = delphiRecord(value);
      return artifact ? delphiStringList(artifact.path) : [];
    }) : []),
    ...delphiStringList(error)
  ];
  return Array.from(new Set(evidence.map((entry) => entry.slice(0, 2000)))).slice(0, 12);
}

function isRecoveredDirectAdapterAttempt(
  toolCalls: MicroRunToolInvocation[],
  callIndex: number,
  call: MicroRunToolInvocation,
  result: Record<string, unknown> | undefined
): boolean {
  if (!call.executionStarted || (call.succeeded !== false && result?.status !== "failed")) return false;
  if (![
    "delphi_run_playwright_flow",
    "delphi_run_appium_flow",
    "delphi_run_mobile_target_flow"
  ].includes(call.providerToolName)) return false;
  const failure = [call.error, delphiString(result?.message)].filter(Boolean).join(" ");
  // These are adapter-instruction failures, not defects in the project under
  // test. Keep them in diagnostics, but once the same lane succeeds later in
  // the run they must not poison the final verdict or become a product finding.
  if (!/\b(?:SELECTOR_AMBIGUOUS|SELECTOR_NOT_FOUND|STRICT_MODE_VIOLATION)\b/i.test(failure)) return false;
  return toolCalls.slice(callIndex + 1).some((next) => {
    if (next.providerToolName !== call.providerToolName || !next.executionStarted || next.succeeded === false) return false;
    return invocationResult(next)?.status !== "failed";
  });
}

function hostChecks(toolCalls: MicroRunToolInvocation[]): DelphiTestingOutput["checks"] {
  return toolCalls.flatMap((call, callIndex) => {
    if (!["archicode_console_run_command", "delphi_run_playwright_flow", "delphi_run_appium_flow", "delphi_run_mobile_target_flow"].includes(call.providerToolName)) return [];
    if (!call.executionStarted) return [];
    const args = invocationArguments(call);
    const result = invocationResult(call);
    if (isRecoveredDirectAdapterAttempt(toolCalls, callIndex, call, result)) return [];
    const command = delphiString(args.command);
    const label = call.providerToolName === "archicode_console_run_command" ? `Command: ${command ?? "reviewed console check"}`
      : call.providerToolName === "delphi_run_playwright_flow" ? "Playwright live target flow"
        : call.providerToolName === "delphi_run_appium_flow" ? "Appium session flow"
          : "Native mobile target flow";
    const failed = call.succeeded === false || result?.status === "failed";
    return [{
      name: label,
      status: failed ? "failed" as const : "passed" as const,
      command,
      outputSummary: failed ? (call.error ?? delphiString(result?.message) ?? "The executed check failed.") : delphiString(result?.message),
      evidence: invocationEvidence(result, call.error)
    }];
  });
}

function hostToolchains(toolCalls: MicroRunToolInvocation[]): DelphiTestingOutput["toolchains"] {
  const inspection = [...toolCalls].reverse().find((call) => call.providerToolName === "delphi_inspect_test_environment" && call.succeeded !== false);
  const entries = invocationResult(inspection!)?.toolchains;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const checked = delphiTestingOutputSchema.shape.toolchains.safeParse([entry]);
    return checked.success ? checked.data : [];
  });
}

function hostArtifacts(toolCalls: MicroRunToolInvocation[]): DelphiTestingOutput["artifacts"] {
  const unique = new Map<string, DelphiTestingOutput["artifacts"][number]>();
  for (const call of toolCalls) {
    const artifacts = invocationResult(call)?.artifacts;
    if (!Array.isArray(artifacts)) continue;
    for (const value of artifacts) {
      const normalized = delphiArtifact(value);
      const checked = delphiTestingOutputSchema.shape.artifacts.safeParse([normalized]);
      if (checked.success && checked.data[0]) unique.set(checked.data[0].id ?? checked.data[0].path, checked.data[0]);
    }
  }
  return [...unique.values()];
}

function parseOutput(text: string, toolCalls: MicroRunToolInvocation[] = []): DelphiTestingOutput {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = extractJsonObject(text);
  } catch {
    // Executed tool results below remain authoritative even when a provider
    // wraps or truncates its final JSON response.
  }
  const executedChecks = hostChecks(toolCalls);
  const modelChecks = Array.isArray(parsed.checks) ? parsed.checks.flatMap((value) => {
    const entry = delphiRecord(value);
    if (!entry) return [];
    const checked = delphiTestingOutputSchema.shape.checks.safeParse([{
      ...entry,
      status: delphiCheckStatus(entry.status),
      evidence: delphiStringList(entry.evidence)
    }]);
    return checked.success ? checked.data : [];
  }) : [];
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.flatMap((value, index) => {
        const finding = normalizeDelphiFinding(value, index);
        return finding ? [finding] : [];
      })
    : [];
  const executedFailure = executedChecks.find((check) => check.status === "failed");
  if (executedFailure && !findings.length) {
    findings.push({
      title: executedFailure.name,
      severity: "high",
      category: executedFailure.command ? "tooling" : "functional",
      detail: executedFailure.outputSummary ?? "An executed Delphi check failed.",
      reproductionSteps: executedFailure.command ? [executedFailure.command] : ["Repeat the recorded adapter flow against the same approved target."],
      evidence: executedFailure.evidence
    });
  }
  const inspectedToolchains = hostToolchains(toolCalls);
  const reportedToolchains = Array.isArray(parsed.toolchains) ? parsed.toolchains.flatMap((value) => {
    const entry = delphiRecord(value);
    if (!entry) return [];
    const installPlan = delphiRecord(entry.installPlan);
    const checked = delphiTestingOutputSchema.shape.toolchains.safeParse([{
      ...entry,
      adapter: delphiToolchainAdapter(entry),
      status: delphiToolchainStatus(entry.status),
      evidence: delphiStringList(entry.evidence),
      installPlan: installPlan ? { ...installPlan, packages: delphiStringList(installPlan.packages), actions: delphiStringList(installPlan.actions) } : entry.installPlan
    }]);
    return checked.success ? checked.data : [];
  }) : [];
  const recordedArtifacts = hostArtifacts(toolCalls);
  const reportedArtifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts.flatMap((value) => {
    const checked = delphiTestingOutputSchema.shape.artifacts.safeParse([delphiArtifact(value)]);
    return checked.success ? checked.data : [];
  }) : [];
  const artifacts = new Map([...recordedArtifacts, ...reportedArtifacts].map((artifact) => [artifact.id ?? artifact.path, artifact]));
  const toolchains = new Map(inspectedToolchains.map((toolchain) => [toolchain.adapter, toolchain]));
  for (const toolchain of reportedToolchains) {
    const inspected = toolchains.get(toolchain.adapter);
    // Inspection is the baseline, but a runtime adapter may become unavailable
    // after that snapshot. Preserve a reported missing/unsupported transition;
    // any managed setup it triggers still requires a separate host approval.
    if (!inspected || toolchain.status !== "ready") toolchains.set(toolchain.adapter, toolchain);
  }
  const modelVerdict = ["passed", "failed", "blocked", "not-run"].includes(String(parsed.verdict)) ? parsed.verdict as DelphiTestingOutput["verdict"] : "not-run";
  const candidate = {
    ...parsed,
    status: parsed.status === "blocked" || parsed.status === "needs-setup" ? parsed.status : "completed",
    verdict: executedFailure ? "failed" : modelVerdict,
    summary: typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : executedFailure
        ? `${executedFailure.name} failed. See the recorded evidence for details.`
        : text.trim().slice(0, 4000) || "Delphi returned no narrative summary; the host assembled the executed evidence below.",
    attempts: toolCalls.filter((call) => call.executionStarted).length,
    checks: executedChecks.length ? executedChecks : modelChecks,
    findings,
    toolchains: [...toolchains.values()],
    artifacts: [...artifacts.values()],
    blockers: delphiStringList(parsed.blockers),
    recommendedNextSteps: delphiStringList(parsed.recommendedNextSteps)
  };
  return delphiTestingOutputSchema.parse(candidate);
}

function validateOutput(output: unknown, toolCalls: MicroRunToolInvocation[], rawInput: unknown, context?: MicroRunContext): string | undefined {
  const task = delphiTestingInputSchema.parse(rawInput);
  const report = delphiTestingOutputSchema.parse(output);
  const executionToolNames = ["archicode_console_run_command", "delphi_run_playwright_flow", "delphi_run_appium_flow", "delphi_run_mobile_target_flow"];
  const attemptedExecution = toolCalls.filter((call) => executionToolNames.includes(call.providerToolName));
  const executed = attemptedExecution.filter((call) => call.succeeded !== false && call.executionStarted);
  const runtimeExecutionStarted = toolCalls.filter((call) => ["delphi_run_playwright_flow", "delphi_run_appium_flow", "delphi_run_mobile_target_flow"].includes(call.providerToolName) && call.executionStarted);
  const directRuntimeChecks = runtimeExecutionStarted.filter((call) => call.succeeded !== false);
  const executionRequested = task.mode === "audit" || task.commands.length > 0 || Boolean(task.target?.baseUrl || task.target?.appiumSessionId || task.target?.deviceId);
  if (task.mode === "audit" && executionRequested && report.verdict === "blocked" && report.status === "blocked" && attemptedExecution.length === 0) {
    return "Delphi declared the audit blocked without attempting any relevant command or runtime adapter. The execution capabilities are available in this isolated run: choose a useful command or Playwright/Appium/native action now, and report incomplete coverage only if a concrete tool result prevents execution.";
  }
  if (task.mode === "audit" && task.target?.baseUrl && report.status !== "needs-setup" && runtimeExecutionStarted.length === 0) {
    const rejected = toolCalls.filter((call) => call.providerToolName === "delphi_run_playwright_flow" && call.succeeded === false);
    const rejectionDetail = rejected.length
      ? ` The host rejected ${rejected.length} Playwright call(s) before browser execution. Latest rejection: ${rejected.at(-1)?.error ?? "unknown pre-execution rejection"}`
      : "";
    return `The approved live web target was never opened or exercised. Call delphi_run_playwright_flow with a valid action batch now; do not return a blocked report merely because an earlier plan was rejected.${rejectionDetail}`;
  }
  if (task.mode === "plan" && report.verdict === "passed") return "Delphi reported a passing verdict in non-executing plan mode.";
  if (task.mode !== "plan" && report.verdict === "passed" && executed.length === 0) return "Delphi reported a pass without executing any test command.";
  if (task.mode !== "plan" && report.verdict === "passed" && (task.target?.baseUrl || (task.target?.deviceId && (task.platforms.includes("android") || task.platforms.includes("ios")))) && directRuntimeChecks.length === 0) {
    return "Delphi reported direct UI/runtime coverage as passing without executing the approved Playwright, Appium, or native mobile adapter. CLI checks cannot substitute for the requested live target audit.";
  }
  if (report.status === "completed" && report.verdict === "blocked") return "Delphi marked the audit completed while returning a blocked verdict.";
  if (report.status === "needs-setup" && report.toolchains.every((toolchain) => toolchain.status !== "missing")) return "Delphi requested setup without identifying a missing toolchain.";
  if (report.verdict === "failed" && report.findings.length === 0) return "Delphi reported a failure without a structured finding.";
  const analyzedPixels = toolCalls.some((call) => call.providerToolName === "delphi_analyze_observation" && call.succeeded !== false);
  const visualAuditReachedRuntime = directRuntimeChecks.length > 0 || capturedObservationRefs(toolCalls).length > 0;
  if (!context?.analyzeObservation && task.visualInspection === "pixel" && visualAuditReachedRuntime && report.verdict === "passed") {
    return "This audit requested pixel-level visual, layout, or responsive inspection, but the selected model cannot inspect screenshot pixels. Preserve the passing functional checks, explicitly mark visual inspection unavailable, and return a blocked status/verdict instead of claiming the whole visual audit passed.";
  }
  if (context?.analyzeObservation && task.visualInspection === "pixel" && visualAuditReachedRuntime && !analyzedPixels) {
    return "This audit requested pixel-level visual, layout, or responsive inspection and the selected model supports image input, but Delphi completed without analyzing any captured screenshot pixels.";
  }
  if (report.findings.some((finding) => finding.category === "visual") && !analyzedPixels) {
    return "Delphi returned a visual finding without analyzing the pixels of a captured runtime observation. Screenshot paths alone are human-visible evidence, not model visual evidence.";
  }
  return undefined;
}

function repairMessage(_input: unknown, outputText: string, validationError: string, context: MicroRunContext, toolCalls: MicroRunToolInvocation[]): string {
  const visualRepair = validationError.includes("screenshot pixels") && context.analyzeObservation
    ? [
        "The selected model supports image input. Use delphi_analyze_observation now on at least one relevant captured artifact before returning a visual-quality conclusion.",
        capturedObservationRefs(toolCalls).length
          ? `Available captured artifacts: ${capturedObservationRefs(toolCalls).map((artifact) => `${artifact.id} (${artifact.label})`).join("; ")}`
          : "No captured artifact id is available; do not claim a pixel-level visual result."
      ].join("\n")
    : "";
  const authoritativeChecks = hostChecks(toolCalls).map((check) => ({
    name: check.name,
    status: check.status,
    command: check.command,
    outputSummary: check.outputSummary,
    evidence: check.evidence.map((entry) => entry.slice(0, 1200))
  }));
  const hostEvidence = authoritativeChecks.length
    ? `Host-authoritative executed checks (these survived the provider turn; do not downgrade them to inconclusive or say their output is unavailable):\n${JSON.stringify(authoritativeChecks).slice(0, 14_000)}`
    : "No host-authoritative execution result was recorded.";
  return [
    "Your previous response did not satisfy Delphi's audit-report contract.",
    `Validation error: ${validationError}`,
    visualRepair,
    hostEvidence,
    "Return exactly one corrected JSON object with status, verdict, summary, attempts, checks, findings, toolchains, artifacts, blockers, and recommendedNextSteps. checks[].evidence, findings[].evidence, and findings[].reproductionSteps must be arrays of strings. Every toolchain needs a valid adapter and ready/missing/unsupported status; every artifact needs label and path. Preserve gathered evidence; do not invent executions or passes.",
    outputText.trim() ? `Previous response:\n${outputText.slice(0, 4000)}` : ""
  ].filter(Boolean).join("\n\n");
}

export const delphiTestingAgent: MicroRunAgent = {
  kind: "delphi-testing",
  systemPrompt,
  userMessage,
  tools,
  timeoutMs: DELPHI_TIMEOUT_MS,
  parseOutput,
  validateOutput,
  repairMessage,
  preservePartialOutputOnFailure: true
};
