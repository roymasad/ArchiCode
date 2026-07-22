import * as fs from "fs/promises";
import * as path from "path";
import type { MicroRunTool, MicroRunContext, MicroRunAgent, MicroRunToolInvocation } from "../microRuns";

const TEST_AUTHORING_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

// Input handed to the agent by the storage-layer invoker. Everything it needs to
// author tests for one node's acceptance criteria, plus detected stack context.
export interface TestAuthoringInput {
  flowId: string;
  nodeId: string;
  nodeTitle: string;
  nodeDescription: string;
  nodeType: string;
  techStack: string[];
  acceptanceCriteria: string[];
  existingCheckCriteria: string[];
  framework: string | null;
  packageManager: string | null;
  detectedTestCommand: string | null;
  moduleTestCommand: string | null;
  moduleCwd: string | null;
  stackAssumptions: string[];
  suggestedTestDir: string;
  /** True only when the invoking user action or an approved review operation
   * explicitly authorized this agent to create/overwrite test files. */
  writeAuthorizedByUser: boolean;
}

// One authored check the agent reports back: a criterion bound to the real test
// file it wrote and the command that runs it.
export interface AuthoredAcceptanceCheck {
  criterion: string;
  testFilePath: string;
  testCommand: string;
  testName?: string;
}

export interface TestAuthoringOutput {
  checks: AuthoredAcceptanceCheck[];
  filesWritten: string[];
  report: string;
}

// Reject absolute paths and traversal so the agent can only write inside the
// project tree. Returns the resolved absolute path, or null if out of bounds.
export function resolveSafeProjectPath(projectRoot: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const resolved = path.resolve(projectRoot, relativePath);
  const rootWithSep = path.resolve(projectRoot) + path.sep;
  return resolved.startsWith(rootWithSep) ? resolved : null;
}

function createTestAuthoringTools(context: MicroRunContext, input: TestAuthoringInput): MicroRunTool[] {
  const { projectRoot, onProgress } = context;
  const writeAuthorized = input.writeAuthorizedByUser === true;
  const assignedTestDirectory = resolveSafeProjectPath(projectRoot, input.suggestedTestDir);

  const listProjectFilesTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "list_project_files",
    toolName: "list_project_files",
    description: "List files and directories in a project directory (relative to project root).",
    inputSchema: {
      type: "object",
      properties: { directory: { type: "string", description: "Directory relative to project root (default '.')" } }
    },
    handler: async (args?: { directory?: string }) => {
      const target = resolveSafeProjectPath(projectRoot, args?.directory ?? ".") ?? path.resolve(projectRoot);
      onProgress?.(`Listing ${args?.directory ?? "."}`);
      try {
        const entries = await fs.readdir(target, { withFileTypes: true });
        return {
          directory: args?.directory ?? ".",
          files: entries.filter((e) => e.isFile()).map((e) => e.name),
          directories: entries.filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")).map((e) => e.name)
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  };

  const readProjectFileTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "read_project_file",
    toolName: "read_project_file",
    description: "Read a project file (relative to project root). Use it to learn the framework, test conventions, and existing test setup before authoring tests.",
    inputSchema: {
      type: "object",
      properties: { filePath: { type: "string", description: "Path relative to project root" } },
      required: ["filePath"]
    },
    handler: async (args: { filePath: string }) => {
      const resolved = resolveSafeProjectPath(projectRoot, args.filePath);
      if (!resolved) return { error: `Path "${args.filePath}" is outside the project.` };
      onProgress?.(`Reading ${args.filePath}`);
      try {
        const content = await fs.readFile(resolved, "utf8");
        return { filePath: args.filePath, content: content.slice(0, 20000), truncated: content.length > 20000 };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  };

  const searchFilesTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "search_files",
    toolName: "search_files",
    description: "Find files whose path contains a fragment (e.g. '.test.', 'spec', 'router'). Skips node_modules and dotfiles.",
    inputSchema: {
      type: "object",
      properties: { pathContains: { type: "string", description: "Substring to match against project-relative file paths" } },
      required: ["pathContains"]
    },
    handler: async (args: { pathContains: string }) => {
      onProgress?.(`Searching for "${args.pathContains}"`);
      const matches: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        if (matches.length >= 100) return;
        let entries: import("fs").Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(projectRoot, full);
          if (entry.isDirectory()) {
            await walk(full);
          } else if (rel.includes(args.pathContains)) {
            matches.push(rel);
            if (matches.length >= 100) return;
          }
        }
      };
      await walk(path.resolve(projectRoot));
      return { pathContains: args.pathContains, matches };
    }
  };

  const writeTestFileTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "write_test_file",
    toolName: "write_test_file",
    description: "Write (create or overwrite) a test file, AND declare which acceptance criteria it verifies and the command that runs it. Each call both writes the file and wires up the acceptance checks — you do not need a separate reporting step. The test should fail until the feature is implemented (red).",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Project-relative path of the test file. Place it inside the suggested test directory for this node." },
        content: { type: "string", description: "Full test file content" },
        checks: {
          type: "array",
          description: "One entry per acceptance criterion this file verifies. Each binds the criterion to the specific test/describe block name in the file that checks it.",
          items: {
            type: "object",
            properties: {
              criterion: { type: "string", description: "The acceptance criterion text, verbatim from the node's acceptanceCriteria." },
              testName: { type: "string", description: "The name of the it()/test()/describe block in this file that verifies the criterion (e.g. 'renders the /about route')." }
            },
            required: ["criterion", "testName"]
          }
        },
        testCommand: { type: "string", description: "The command that runs this test file through the project's real test runner (e.g. 'npx vitest run .archicode/tests/about-page/about-page.test.ts')." }
      },
      required: ["filePath", "content", "checks", "testCommand"]
    },
    handler: async (args: { filePath: string; content: string; checks?: unknown; testCommand?: unknown }) => {
      if (!writeAuthorized) {
        throw new Error("Writing test files requires explicit user authorization. Call request_test_write_authorization first, or return an inspection-only proposal without writing.");
      }
      const resolved = resolveSafeProjectPath(projectRoot, args.filePath);
      if (!resolved) return { success: false, error: `Path "${args.filePath}" is outside the project or absolute; refused. Use a project-relative path inside the suggested test directory.` };
      if (!assignedTestDirectory || (resolved !== assignedTestDirectory && !resolved.startsWith(`${assignedTestDirectory}${path.sep}`))) {
        return {
          success: false,
          error: `Path "${args.filePath}" is outside this agent's assigned test directory "${input.suggestedTestDir}"; refused.`
        };
      }
      try {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, args.content, "utf8");
        onProgress?.(`Wrote test file ${args.filePath}`);
        return { success: true, filePath: args.filePath, bytes: Buffer.byteLength(args.content, "utf8"), wiredChecks: Array.isArray(args.checks) ? args.checks.length : 0 };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  };

  const requestTestWriteAuthorizationTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "request_test_write_authorization",
    toolName: "request_test_write_authorization",
    description: "Ask the user to authorize creating or overwriting test files within this assigned test-authoring scope. Use only when that write permission was not already granted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string", description: "A concise explanation of the tests and scope you propose to write." }
      },
      required: ["reason"]
    },
    handler: async (args: { reason: string }) => {
      if (writeAuthorized) return { status: "authorized", message: "The user already authorized test writes for this assigned scope." };
      return {
        status: "approval-required",
        reason: args.reason.trim(),
        message: "Test-file writes require the caller's explicit structured approval. This running agent cannot obtain write authorization from free-form text; continue inspection-only and report the proposed tests."
      };
    }
  };

  // Sink tool: captures the final criterion→test wiring so parseOutput can recover
  // it from the tool call args even if the model's final text is lost.
  const reportAcceptanceTestsTool: MicroRunTool = {
    serverId: "micro-run-tools",
    serverLabel: "Micro-Run Tools",
    providerToolName: "report_acceptance_tests",
    toolName: "report_acceptance_tests",
    description: "Report the authored tests: one entry per acceptance criterion you wrote a test for, binding it to the test file and the command that runs it. Call this once at the end.",
    inputSchema: {
      type: "object",
      properties: {
        checks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              criterion: { type: "string" },
              testFilePath: { type: "string" },
              testCommand: { type: "string" }
            },
            required: ["criterion", "testFilePath", "testCommand"]
          }
        },
        report: { type: "string", description: "Short summary of what was authored and any criteria intentionally skipped." }
      },
      required: ["checks"]
    },
    handler: async (args: { checks: unknown[]; report?: string }) => {
      onProgress?.(`Reported ${args.checks.length} authored acceptance test(s).`);
      return { captured: true, checkCount: args.checks.length };
    }
  };

  return [
    listProjectFilesTool,
    readProjectFileTool,
    searchFilesTool,
    requestTestWriteAuthorizationTool,
    writeTestFileTool,
    reportAcceptanceTestsTool
  ];
}

function buildTestAuthoringSystemPrompt(input: unknown): string {
  const typed = input as TestAuthoringInput;
  const writeAuthorized = typed.writeAuthorizedByUser === true;
  return [
    "You are a test-authoring specialist practicing test-driven development (TDD) inside the ArchiCode app.",
    writeAuthorized
      ? "Goal: for one graph node, write real automated test files that verify its automatable acceptance criteria using the project's actual or intended framework and conventions."
      : "Goal: inspect the assigned acceptance-test scope and design meaningful automated tests. You may write them only after obtaining explicit user authorization through request_test_write_authorization.",
    "Own the investigation and authoring tactics. Inspect whatever project evidence is useful, adapt to greenfield or established repositories, and keep working while a useful test-authoring action remains.",
    "",
    "Safety and output contract:",
    writeAuthorized
      ? "- The user explicitly authorized test-file writes for this assigned scope. That permission does not extend to feature/source implementation files."
      : "- Test-file writes are not authorized yet. Inspect and propose freely, but call request_test_write_authorization and receive an explicit approval before write_test_file. If approval is unavailable or declined, do not write; return the proposed coverage and limitation honestly.",
    writeAuthorized
      ? "- IMPORTANT — greenfield projects: if the project has NO scaffold, NO package.json, and NO test framework yet, do NOT give up. Author the test files anyway using the INTENDED framework from the node's tech stack and the project's stack assumptions (for example: Vue 3 + Vite → Vitest with @vue/test-utils; React → Vitest/Jest + Testing Library; Python → pytest). Place them in that framework's conventional location (e.g. `tests/` or alongside source). These tests are EXPECTED to fail until the app is scaffolded and implemented — that is the whole point of writing tests first."
      : "- Greenfield projects are still valid test-design work. Infer the intended framework from the node tech stack and stack assumptions, but do not create those files until the user authorizes the write.",
    "- Cover each acceptance criterion that can be automated with meaningful test behavior. If none can be automated, report that honestly instead of writing hollow tests.",
    `- LOCATION: put ALL test files you write for this node under the dedicated directory "${typed.suggestedTestDir}" (create it as needed). Do not scatter tests at the repo root or outside this folder.`,
    "- WIRING CONTRACT: every written test file must identify its exact acceptance-criterion text, a distinct descriptive testName, and the real testCommand. ArchiCode builds the checklist from this structured write payload.",
    "- The tests are expected to FAIL until the feature is implemented — intentional red-phase TDD. Do NOT implement or scaffold the feature source itself; write only tests.",
    "- Never write inline-script or one-liner 'tests'. Author proper test files that a normal test runner executes.",
    "- Skip only a criterion that cannot be verified by ANY automated test (e.g. subjective visual style) — do not force a hollow test, but do not skip a criterion just because the app doesn't exist yet.",
    "- Do not duplicate criteria that already have checks.",
    "- Optionally call report_acceptance_tests at the end with a short summary; the checklist itself is built from your write_test_file calls.",
    "",
    `Detected framework: ${typed.framework ?? "unknown (infer from the node tech stack and project files)"}.`,
    `Package manager: ${typed.packageManager ?? "unknown"}. Project test command: ${typed.detectedTestCommand ?? typed.moduleTestCommand ?? "unknown"}.`,
    `Put this node's tests under: ${typed.suggestedTestDir}`,
    typed.moduleCwd ? `The node's module lives under: ${typed.moduleCwd}. Prefer that module's test layout.` : ""
  ].filter(Boolean).join("\n");
}

function buildTestAuthoringUserMessage(input: unknown): string {
  const typed = input as TestAuthoringInput;
  return JSON.stringify({
    node: { title: typed.nodeTitle, description: typed.nodeDescription, type: typed.nodeType, techStack: typed.techStack },
    stackAssumptions: typed.stackAssumptions,
    acceptanceCriteria: typed.acceptanceCriteria,
    alreadyCoveredCriteria: typed.existingCheckCriteria,
    suggestedTestDir: typed.suggestedTestDir,
    instruction: typed.writeAuthorizedByUser
      ? `The user authorized this action. Author meaningful red-phase tests for the automatable criteria under "${typed.suggestedTestDir}" and return the required criterion-to-test wiring.`
      : `Inspect and propose meaningful red-phase tests under "${typed.suggestedTestDir}". Obtain explicit user authorization through request_test_write_authorization before writing any file.`
  }, null, 2);
}

function coerceAuthoredChecks(value: unknown): AuthoredAcceptanceCheck[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): AuthoredAcceptanceCheck | undefined => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as Record<string, unknown>;
      const criterion = typeof record.criterion === "string" ? record.criterion.trim() : "";
      const testFilePath = typeof record.testFilePath === "string" ? record.testFilePath.trim() : "";
      const testCommand = typeof record.testCommand === "string" ? record.testCommand.trim() : "";
      const testName = typeof record.testName === "string" ? record.testName.trim() : undefined;
      return criterion && testFilePath && testCommand ? { criterion, testFilePath, testCommand, testName: testName || undefined } : undefined;
    })
    .filter((item): item is AuthoredAcceptanceCheck => item !== undefined);
}

// The last report_acceptance_tests call's parsed args, if any.
function lastReportArgs(toolCalls?: MicroRunToolInvocation[]): { checks?: unknown; report?: unknown } | undefined {
  if (!toolCalls) return undefined;
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    if (toolCalls[i].providerToolName !== "report_acceptance_tests") continue;
    try {
      return JSON.parse(toolCalls[i].argumentsJson) as { checks?: unknown; report?: unknown };
    } catch {
      // keep scanning earlier calls
    }
  }
  return undefined;
}

// Build checks primarily from the self-describing write_test_file calls (each
// binds a file to its criteria + command), so wiring survives even if the model
// skips the final report step. Falls back to report_acceptance_tests.
function checksFromWriteCalls(toolCalls?: MicroRunToolInvocation[]): AuthoredAcceptanceCheck[] {
  if (!toolCalls) return [];
  const checks: AuthoredAcceptanceCheck[] = [];
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (call.providerToolName !== "write_test_file") continue;
    try {
      const args = JSON.parse(call.argumentsJson) as { filePath?: unknown; checks?: unknown; testCommand?: unknown };
      const filePath = typeof args.filePath === "string" ? args.filePath.trim() : "";
      const testCommand = typeof args.testCommand === "string" ? args.testCommand.trim() : "";
      if (!filePath || !testCommand || !Array.isArray(args.checks)) continue;
      for (const raw of args.checks) {
        const criterion = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).criterion === "string"
          ? ((raw as Record<string, unknown>).criterion as string).trim()
          : typeof raw === "string" ? raw.trim() : "";
        const testName = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).testName === "string"
          ? ((raw as Record<string, unknown>).testName as string).trim()
          : undefined;
        if (!criterion) continue;
        const key = criterion.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        checks.push({ criterion, testFilePath: filePath, testCommand, testName: testName || undefined });
      }
    } catch {
      // ignore malformed call
    }
  }
  return checks;
}

function checksFromToolCalls(toolCalls?: MicroRunToolInvocation[]): AuthoredAcceptanceCheck[] {
  const fromWrites = checksFromWriteCalls(toolCalls);
  if (fromWrites.length) return fromWrites;
  return coerceAuthoredChecks(lastReportArgs(toolCalls)?.checks);
}

// Recover the set of test files actually written from the write_test_file tool
// calls, so we don't need mutable module state to report what landed.
function filesWrittenFromToolCalls(toolCalls?: MicroRunToolInvocation[]): string[] {
  if (!toolCalls) return [];
  const written = new Set<string>();
  for (const call of toolCalls) {
    if (call.providerToolName !== "write_test_file") continue;
    try {
      const args = JSON.parse(call.argumentsJson) as { filePath?: unknown };
      if (typeof args.filePath === "string" && args.filePath.trim()) written.add(args.filePath.trim());
    } catch {
      // ignore malformed call
    }
  }
  return [...written];
}

export function parseTestAuthoringOutput(text: string, toolCalls?: MicroRunToolInvocation[]): TestAuthoringOutput {
  const captured = checksFromToolCalls(toolCalls);
  const filesWritten = filesWrittenFromToolCalls(toolCalls);
  let report = "Test authoring completed.";
  const reportedText = lastReportArgs(toolCalls)?.report;
  if (typeof reportedText === "string" && reportedText.trim()) {
    report = reportedText.trim();
  } else {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { report?: string };
        if (typeof parsed.report === "string" && parsed.report.trim()) report = parsed.report.trim();
      } catch {
        // ignore; keep default report
      }
    }
  }
  return { checks: captured, filesWritten, report };
}

export const testAuthoringAgent: MicroRunAgent = {
  kind: "test-authoring",
  systemPrompt: buildTestAuthoringSystemPrompt,
  userMessage: buildTestAuthoringUserMessage,
  tools: (context, input) => createTestAuthoringTools(context, input as TestAuthoringInput),
  timeoutMs: TEST_AUTHORING_TIMEOUT_MS,
  parseOutput: parseTestAuthoringOutput
};
