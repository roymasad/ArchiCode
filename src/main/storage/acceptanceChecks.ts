import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { acceptanceCheckSchema, flowSchema, isProductionApproved, nodeAcceptanceChecksSatisfied } from "../../shared/schema";
import type { AcceptanceCheckStatus } from "../../shared/schema";
import { classifyCommandRisk } from "../../shared/execution";
import { gaiaAgent } from "../../shared/agentIdentities";
import { isSubflowIgnored } from "../../shared/graph";
import { runVerificationCommand, executeMicroRun } from "../microRuns";
import { detectTechStack, type TechStack } from "../techStack";
import type { TestAuthoringInput, TestAuthoringOutput } from "../microRunAgents/testAuthoring";
import { readProjectFile, readProjectFileDiff } from "../projectTools";
import type { AcceptanceCheck, Flow, NodeModuleProfileMode, ProjectBundle, ProjectSettings, Run } from "../../shared/schema";
import { callProvider } from "../providers";
import { hydrateProviderForUse, loadProject, touchProject } from "./projectStore";
import { commandsAutoApproved, nodeIdsForRunOutcome } from "./runEngine";
import { exists, id, iso, projectStatePath, safeFileName, writeJson } from "./persistence";

export const ACCEPTANCE_CHECK_OUTPUT_LIMIT = 4000;
export const ACCEPTANCE_CHECK_TEST_TIMEOUT_MS = 5 * 60 * 1000;

export function nodeModuleProfileMode(node: Pick<Flow["nodes"][number], "moduleProfileMode">): NodeModuleProfileMode {
  return node.moduleProfileMode ?? "auto";
}

export function resolveNodeRunTargetProfile(
  settings: Pick<ProjectSettings, "runTargetProfiles">,
  node: Pick<Flow["nodes"][number], "moduleProfileId" | "moduleProfileMode">
): ProjectSettings["runTargetProfiles"][number] | undefined {
  const mode = nodeModuleProfileMode(node);
  if (mode === "none") return undefined;
  if (node.moduleProfileId) return settings.runTargetProfiles.find((item) => item.id === node.moduleProfileId);
  if (mode === "auto" && settings.runTargetProfiles.length === 1) return settings.runTargetProfiles[0];
  return undefined;
}

// The effective test command for a check: its own testCommand, else the test
// command of the module (runTargetProfile) the node is bound to.
export function resolveAcceptanceCheckCommand(
  check: AcceptanceCheck,
  node: Flow["nodes"][number],
  profileById: Map<string, ProjectSettings["runTargetProfiles"][number]>
): string | undefined {
  if (check.testCommand?.trim()) return check.testCommand.trim();
  const profile = resolveNodeRunTargetProfile({ runTargetProfiles: [...profileById.values()] }, node);
  return profile?.testCommand?.trim() || undefined;
}

export function parseAcceptanceCheckVerdicts(response: string): Array<{ id: string; status: string; evidence?: string }> | undefined {
  const start = response.indexOf("[");
  const end = response.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(response.slice(start, end + 1));
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((item) => item && typeof item.id === "string" && typeof item.status === "string");
  } catch {
    return undefined;
  }
}

// LLM-judges each executed check from its criterion + captured test output. Falls
// back to the raw exit code when no usable provider is configured or the judge
// response cannot be parsed — a zero exit is treated as passing in that case.
export async function judgeAcceptanceChecks(
  provider: ProjectSettings["providers"][number] | undefined,
  projectRoot: string,
  node: Flow["nodes"][number],
  executed: Array<{ check: AcceptanceCheck; command: string; exitCode: number; output: string }>
): Promise<Array<{ id: string; status: AcceptanceCheckStatus; evidence: string }>> {
  const fallback = (): Array<{ id: string; status: AcceptanceCheckStatus; evidence: string }> =>
    executed.map(({ check, command, exitCode, output }) => ({
      id: check.id,
      status: exitCode === 0 ? "passing" : "failing",
      evidence: `\`${command}\` exited ${exitCode}.${output ? ` ${output.slice(0, 300)}` : ""}`.trim()
    }));

  if (!provider || provider.kind === "offline-manual") return fallback();

  const prompt = JSON.stringify({
    task: "Judge whether each acceptance-check test proves its criterion is met. Return ONLY a JSON array of { id, status: \"passing\" | \"failing\", evidence } with one entry per check. A check is passing only if the test actually exercised the criterion and succeeded; a zero exit with empty or irrelevant output is failing.",
    node: { title: node.title, description: node.description },
    checks: executed.map(({ check, command, exitCode, output }) => ({ id: check.id, criterion: check.criterion, command, exitCode, output }))
  });

  try {
    const response = await callProvider(
      await hydrateProviderForUse(provider),
      prompt,
      `Verify ${executed.length} acceptance check${executed.length === 1 ? "" : "s"} for "${node.title}"`,
      { projectRoot, webSearchEnabled: false, phase: "verifying" }
    );
    const parsed = parseAcceptanceCheckVerdicts(response);
    if (!parsed) return fallback();
    const verdictById = new Map(parsed.map((verdict) => [verdict.id, verdict]));
    return executed.map(({ check, command, exitCode, output }) => {
      const verdict = verdictById.get(check.id);
      if (verdict && (verdict.status === "passing" || verdict.status === "failing")) {
        return { id: check.id, status: verdict.status, evidence: verdict.evidence?.slice(0, 500) ?? `\`${command}\` exited ${exitCode}.` };
      }
      return {
        id: check.id,
        status: exitCode === 0 ? "passing" : "failing",
        evidence: `\`${command}\` exited ${exitCode}.${output ? ` ${output.slice(0, 300)}` : ""}`.trim()
      };
    });
  } catch {
    return fallback();
  }
}

// Build-time acceptance verifier: after a verified build, run each affected
// node's acceptance-check tests (LLM-authored), have the run's provider judge
// the results, and write pass/fail + evidence back onto the checks. This is what
// flips checks from unverified/failing to passing, which in turn lets the node's
// dirty flags clear (nodeAcceptanceChecksSatisfied). Skipped entirely when the
// user requires per-command approval, so LLM-authored commands never auto-run.
export async function verifyRunAcceptanceChecks(projectRoot: string, bundle: ProjectBundle, run: Run): Promise<Run["logs"]> {
  const settings = bundle.project.settings;
  if (!settings.autoApproveShellCommands) return [];
  const flow = bundle.flows.find((item) => item.id === run.flowId);
  if (!flow) return [];
  const nodeIds = nodeIdsForRunOutcome(flow, run);
  if (!nodeIds.size) return [];
  const profileById = new Map(settings.runTargetProfiles.map((profile) => [profile.id, profile]));
  const provider = run.providerId ? settings.providers.find((item) => item.id === run.providerId) : undefined;
  const logs: Run["logs"] = [];

  for (const node of flow.nodes) {
    if (!nodeIds.has(node.id) || node.ignored || isSubflowIgnored(flow, node.subflowId) || isProductionApproved(node)) continue;
    const runnable = node.acceptanceChecks.filter((check) => resolveAcceptanceCheckCommand(check, node, profileById));
    if (!runnable.length) continue;

    const profile = resolveNodeRunTargetProfile(settings, node);
    const cwd = profile?.cwd ? path.join(projectRoot, profile.cwd) : projectRoot;
    const executed: Array<{ check: AcceptanceCheck; command: string; exitCode: number; output: string }> = [];
    for (const check of runnable) {
      const command = resolveAcceptanceCheckCommand(check, node, profileById)!;
      const risk = classifyCommandRisk(command);
      if (!commandsAutoApproved(settings, risk, command)) {
        logs.push({
          at: iso(),
          stream: "stderr",
          text: `Acceptance check "${check.criterion}" requires manual shell approval before running \`${command}\` (${risk} risk).`
        });
        continue;
      }
      const result = await runVerificationCommand(cwd, command, [], { timeout: ACCEPTANCE_CHECK_TEST_TIMEOUT_MS })
        .catch((error) => ({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1, passed: false }));
      const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, ACCEPTANCE_CHECK_OUTPUT_LIMIT);
      executed.push({ check, command, exitCode: result.exitCode, output });
      logs.push({ at: iso(), stream: result.exitCode === 0 ? "system" : "stderr", text: `Acceptance check "${check.criterion}" ran \`${command}\` (exit ${result.exitCode}).` });
    }

    if (!executed.length) continue;
    const results = await judgeAcceptanceChecks(provider, projectRoot, node, executed);
    await recordAcceptanceCheckResults(projectRoot, flow.id, node.id, results, run.id);
    const passing = results.filter((result) => result.status === "passing").length;
    logs.push({ at: iso(), stream: "system", text: `Acceptance checks for "${node.title}": ${passing}/${results.length} passing.` });
  }

  return logs;
}

export async function recordAcceptanceCheckResults(
  projectRoot: string,
  flowId: string,
  nodeId: string,
  results: Array<{ id: string; status: AcceptanceCheckStatus; evidence?: string; testCommand?: string; testFilePath?: string }>,
  runId?: string
): Promise<ProjectBundle> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  const node = flow.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} was not found.`);
  const resultById = new Map(results.map((result) => [result.id, result]));
  const now = iso();
  let mutated = false;
  const acceptanceChecks: AcceptanceCheck[] = node.acceptanceChecks.map((check) => {
    const result = resultById.get(check.id);
    if (!result) return check;
    mutated = true;
    return {
      ...check,
      status: result.status,
      evidence: result.evidence ?? check.evidence,
      testCommand: result.testCommand ?? check.testCommand,
      testFilePath: result.testFilePath ?? check.testFilePath,
      verifiedByRunId: runId ?? check.verifiedByRunId,
      updatedAt: now
    };
  });
  if (!mutated) return bundle;
  const nextFlow = flowSchema.parse({
    ...flow,
    nodes: flow.nodes.map((item) => item.id === nodeId ? { ...node, acceptanceChecks, updatedAt: now } : item),
    updatedAt: now
  });
  await writeJson(projectStatePath(projectRoot, "flows", `${flowId}.json`), nextFlow);
  await touchProject(projectRoot);
  return loadProject(projectRoot);
}

export interface GeneratedCheckItem {
  criterion: string;
  testCommand: string;
  testFilePath?: string;
}

export function coerceGeneratedCheckItems(value: unknown): GeneratedCheckItem[] {
  // Accept a bare array, or an object wrapping the array under a common key.
  const array = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (["checks", "acceptanceChecks", "items", "results"] as const)
          .map((key) => (value as Record<string, unknown>)[key])
          .find((candidate) => Array.isArray(candidate)) as unknown[] | undefined
      : undefined;
  if (!Array.isArray(array)) return [];
  return array
    .map((item): GeneratedCheckItem | undefined => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as Record<string, unknown>;
      const criterion = typeof record.criterion === "string" ? record.criterion : undefined;
      // Tolerate common key aliases the model may use for the command.
      const testCommand = [record.testCommand, record.test, record.command]
        .find((candidate) => typeof candidate === "string") as string | undefined;
      const testFilePath = [record.testFilePath, record.testFile, record.filePath, record.path]
        .find((candidate) => typeof candidate === "string" && candidate.trim()) as string | undefined;
      return criterion && testCommand ? { criterion, testCommand, testFilePath } : undefined;
    })
    .filter((item): item is GeneratedCheckItem => item !== undefined);
}

export function parseGeneratedAcceptanceChecks(response: string): GeneratedCheckItem[] {
  // Prefer a fenced ```json block if present, else the outermost array, else the
  // outermost object — trying each so wrapped/prefixed model output still parses.
  const candidates: string[] = [];
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const arrStart = response.indexOf("[");
  const arrEnd = response.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(response.slice(arrStart, arrEnd + 1));
  const objStart = response.indexOf("{");
  const objEnd = response.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) candidates.push(response.slice(objStart, objEnd + 1));

  for (const candidate of candidates) {
    try {
      const items = coerceGeneratedCheckItems(JSON.parse(candidate));
      if (items.length) return items;
    } catch {
      // try the next candidate
    }
  }
  return [];
}

export interface AcceptanceCheckGenerationResult {
  nodeId: string;
  title: string;
  added: number;
}

// Draft (but do not persist) new acceptance checks for one node: LLM-proposes one
// testable check per criterion with a test command, skipping criteria that can't
// be automatically verified and any criterion already covered by an existing
// check. Returns [] when the node has no criteria or the model proposes nothing.
export async function draftAcceptanceChecksForNode(
  projectRoot: string,
  settings: ProjectSettings,
  node: Flow["nodes"][number],
  provider: ProjectSettings["providers"][number],
  techStack: TechStack | null
): Promise<AcceptanceCheck[]> {
  const criteria = node.acceptanceCriteria.map((text) => text.trim()).filter(Boolean);
  if (!criteria.length) return [];
  const profile = resolveNodeRunTargetProfile(settings, node);
  const existing = new Set(node.acceptanceChecks.map((check) => check.criterion.trim().toLowerCase()));

  const prompt = JSON.stringify({
    task: [
      "Convert this node's acceptance criteria into structured, testable acceptance checks.",
      "Return ONLY a JSON array of { criterion, testFilePath, testCommand } — one entry per criterion that can be verified by an automated test.",
      "testFilePath is the project-relative path of the test file that verifies the criterion (it may not exist yet; a later implementation run will author it). Follow the project's detected framework and conventions for naming and location.",
      "testCommand must invoke that test through the project's real test runner/framework and target that file (e.g. a framework test command scoped to the file). Reuse the project/module test command as the base when available.",
      "HARD RULES: Do NOT write inline scripts or ad-hoc one-liners as the test — never use `node -e`, `python -c`, `bash -c`, `eval`, or piping code into an interpreter. Do NOT bundle a build with the test unless the framework requires it. If a criterion cannot be verified by a normal automated test in this stack (e.g. subjective visual style), omit it entirely rather than inventing a command.",
      "Skip any criterion already covered by an existing check."
    ].join(" "),
    node: { title: node.title, description: node.description, type: node.type, techStack: node.techStack },
    project: {
      primaryLanguage: techStack?.primaryLanguage ?? null,
      testFramework: techStack?.testFramework ?? null,
      packageManager: techStack?.packageManager ?? null,
      detectedTestCommand: techStack?.suggestedCommands.test ?? null,
      stackAssumptions: settings.stackAssumptions ?? []
    },
    moduleTestCommand: profile?.testCommand ?? null,
    defaultTestCommand: settings.runTargetProfiles.find((item) => item.testCommand)?.testCommand ?? techStack?.suggestedCommands.test ?? null,
    existingChecks: node.acceptanceChecks.map((check) => ({ criterion: check.criterion, testFilePath: check.testFilePath ?? null })),
    acceptanceCriteria: criteria
  });

  const response = await callProvider(
    await hydrateProviderForUse(provider),
    prompt,
    `Draft acceptance checks for "${node.title}"`,
    // Bare extraction: bypass the orchestrator/phase agent framing so the model
    // returns the requested JSON array instead of a plan/patch/questions envelope
    // (local agentic CLIs like codex are otherwise derailed by the framing).
    { projectRoot, webSearchEnabled: false, phase: "planning", bareExtraction: true }
  );

  return parseGeneratedAcceptanceChecks(response)
    .filter((item) => item.criterion.trim() && item.testCommand.trim() && !existing.has(item.criterion.trim().toLowerCase()))
    .filter((item) => !isInlineScriptTestCommand(item.testCommand))
    .map((item) => acceptanceCheckSchema.parse({
      id: id("check"),
      criterion: item.criterion.trim(),
      testCommand: item.testCommand.trim(),
      testFilePath: item.testFilePath?.trim() || undefined,
      status: "unverified",
      updatedAt: iso()
    }));
}

// Guard against the model slipping an inline-script "test" past the prompt rules
// (node -e / python -c / bash -c / piping code into an interpreter). These are
// brittle non-tests, so we drop them rather than persist a hollow check.
export function isInlineScriptTestCommand(command: string): boolean {
  return /(^|[\s;&|])(node|deno|bun|ts-node)\s+(-e|--eval)\b/i.test(command) ||
    /(^|[\s;&|])(python3?|ruby|php|perl)\s+-[a-z]*e\b/i.test(command) ||
    /(^|[\s;&|])(bash|sh|zsh)\s+-c\b/i.test(command) ||
    /\beval\b/i.test(command) ||
    /\|\s*(node|python3?|bash|sh)\b/i.test(command);
}

// LLM drafter, node- or flow-scoped. When nodeId is given, converts that one
// node's criteria into checks (erroring if it has none). When nodeId is omitted,
// runs across every eligible node in the flow (has criteria, not ignored, not
// production-approved) as a single batch. Writes directly and non-destructively:
// existing checks are preserved, only uncovered criteria are added, and new
// checks start "unverified" so they still gate the node on the next build.
export async function generateAcceptanceChecksScoped(
  projectRoot: string,
  flowId: string,
  nodeId?: string,
  providerId?: string
): Promise<{ bundle: ProjectBundle; results: AcceptanceCheckGenerationResult[] }> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);

  const settings = bundle.project.settings;
  const provider = (providerId ? settings.providers.find((item) => item.id === providerId) : undefined)
    ?? settings.providers.find((item) => item.enabled);
  if (!provider || provider.kind === "offline-manual") {
    throw new Error("An online AI provider is required to generate acceptance checks from criteria.");
  }

  let targets: Flow["nodes"];
  if (nodeId) {
    const node = flow.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`Node ${nodeId} was not found.`);
    if (!node.acceptanceCriteria.some((text) => text.trim())) {
      throw new Error("This node has no acceptance criteria to convert into checks.");
    }
    targets = [node];
  } else {
    targets = flow.nodes.filter((node) =>
      !node.ignored && !isProductionApproved(node) && node.acceptanceCriteria.some((text) => text.trim()));
    if (!targets.length) throw new Error("No eligible nodes with acceptance criteria were found in this flow.");
  }

  // Detect the stack once so the drafter proposes real framework test files/commands.
  const techStack = await detectTechStack(projectRoot).catch(() => null);
  const additionsByNodeId = new Map<string, AcceptanceCheck[]>();
  const results: AcceptanceCheckGenerationResult[] = [];
  for (const node of targets) {
    const additions = await draftAcceptanceChecksForNode(projectRoot, settings, node, provider, techStack);
    if (additions.length) additionsByNodeId.set(node.id, additions);
    results.push({ nodeId: node.id, title: node.title, added: additions.length });
  }

  const totalAdded = results.reduce((sum, result) => sum + result.added, 0);
  if (nodeId && totalAdded === 0) {
    throw new Error("The AI did not return any new testable acceptance checks for these criteria.");
  }
  if (totalAdded > 0) {
    const nextFlow = flowSchema.parse({
      ...flow,
      nodes: flow.nodes.map((node) => {
        const additions = additionsByNodeId.get(node.id);
        return additions ? { ...node, acceptanceChecks: [...node.acceptanceChecks, ...additions], updatedAt: iso() } : node;
      }),
      updatedAt: iso()
    });
    await writeJson(projectStatePath(projectRoot, "flows", `${flowId}.json`), nextFlow);
    await touchProject(projectRoot);
  }
  return { bundle: await loadProject(projectRoot), results };
}

// Single-node wrapper retained for the inspector button and IPC path.
export async function generateAcceptanceChecksFromCriteria(
  projectRoot: string,
  flowId: string,
  nodeId: string,
  providerId?: string
): Promise<ProjectBundle> {
  const { bundle } = await generateAcceptanceChecksScoped(projectRoot, flowId, nodeId, providerId);
  return bundle;
}

export interface AuthorAcceptanceTestsResult {
  bundle: ProjectBundle;
  results: Array<{ nodeId: string; title: string; testsAdded: number; filesWritten: string[]; report: string }>;
}

// Generated acceptance tests are IDE-internal and kept in their own dedicated
// subfolder `.archicode/tests` (committed with the repo, but sandboxed and clearly
// separate from the project's normal tests), grouped per node: `.archicode/tests/<node-slug>`.
export function acceptanceTestDirForNode(nodeTitle: string): string {
  const slug = nodeTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "node";
  return `.archicode/tests/${slug}`;
}

// Prune-to-match: after regenerating a node's tests, delete any file inside its
// dedicated `.archicode/tests/<slug>` folder that is no longer referenced by one
// of its checks (orphans from renames or removed criteria). Overwrites handle the
// same-path case; this cleans up the rest. Hard-scoped to `.archicode/tests/` so
// it can never touch the user's source or another feature's files.
export async function pruneNodeTestDirectory(projectRoot: string, testDir: string, keepRelPaths: Set<string>): Promise<void> {
  const absDir = path.resolve(projectRoot, testDir);
  const allowedRoot = path.resolve(projectRoot, ".archicode", "tests") + path.sep;
  if (!(absDir + path.sep).startsWith(allowedRoot)) return;
  if (!(await exists(absDir))) return;

  const toDelete: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(projectRoot, full).split(path.sep).join("/");
        if (!keepRelPaths.has(rel)) toDelete.push(full);
      }
    }
  };
  await walk(absDir);
  for (const file of toDelete) {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

// Part 2 — TDD test-authoring agent. Runs the `test-authoring` micro-agent for a
// node: it writes real failing test files into the working tree (respecting the
// project framework) and reports the criterion→test wiring, which we persist as
// new "unverified" (red) acceptanceChecks. A later build/implement run makes them
// pass. Node- or whole-flow scoped, mirroring the metadata drafter's scoping.
export type EnhanceableNodeField = "description" | "acceptanceCriteria";

export async function enhanceNodeField(
  projectRoot: string,
  flowId: string,
  nodeId: string,
  field: EnhanceableNodeField,
  providerId?: string
): Promise<string> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  const node = flow.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} was not found.`);

  const settings = bundle.project.settings;
  const providerSource = (providerId ? settings.providers.find((item) => item.id === providerId) : undefined)
    ?? settings.providers.find((item) => item.enabled && item.kind !== "offline-manual")
    ?? settings.providers.find((item) => item.enabled);
  if (!providerSource || providerSource.kind === "offline-manual") {
    throw new Error("An online AI provider is required to enhance this field.");
  }
  const provider = await hydrateProviderForUse(providerSource);

  const nodeContext = [
    `Node title: ${node.title}`,
    `Node type: ${node.type}`,
    `Node stage: ${node.stage}`,
    `Current description: ${node.description.trim() || "(empty)"}`,
    `Current acceptance criteria:\n${node.acceptanceCriteria.some((text) => text.trim())
      ? node.acceptanceCriteria.map((text) => `- ${text}`).join("\n")
      : "(none)"}`
  ].join("\n\n");

  const instruction = field === "description"
    ? "Rewrite this node's description to be clearer, more specific, and more useful for an engineer implementing it. Keep it concise (2-5 sentences). Return only the improved description text with no preamble, no markdown headers, and no quotation marks around it."
    : [
        "Lightly tighten this node's acceptance criteria. These criteria are used directly as input for generating automated tests, so each one you add becomes a real test — do not multiply them.",
        "Keep the same number of criteria unless one is genuinely two unrelated requirements bundled together, or something essential and obviously implied by the description is missing entirely (add at most one such criterion).",
        "Prefer light editing of existing wording over rewriting from scratch: fix vagueness or ambiguity only where it would actually block someone from writing a test, and leave criteria that are already clear and testable untouched.",
        "Do not split a single criterion into a per-browser or per-breakpoint checklist, do not invent new dimensions (browsers, viewport sizes, edge cases) that weren't implied by the original text, and do not add generic boilerplate criteria.",
        "Return only the improved list, one criterion per line, with no numbering, bullets, or preamble."
      ].join(" ");

  // bareExtraction bypasses the orchestrator/plan agent framing that phased
  // callProvider requests normally get (which pushes local CLI providers toward
  // a Goal/Approach/Steps plan instead of a direct answer); it sends only the
  // context text below to the model, so the instruction must live inside it.
  const context = [instruction, "", nodeContext].join("\n");

  // Run under the "summarizing" phase (low reasoning effort, small output
  // budget) rather than the default "planning" phase, whose high reasoning
  // effort and 16k-token ceiling make a trivial field rewrite needlessly slow.
  const result = await callProvider(provider, context, instruction, { projectRoot, webSearchEnabled: false, bareExtraction: true, phase: "summarizing" });
  return result.trim();
}

export async function generateGitCommitMessage(
  projectRoot: string,
  filePaths: string[],
  providerId?: string
): Promise<string> {
  if (!filePaths.length) throw new Error("Select at least one changed file to generate a commit message from.");

  const bundle = await loadProject(projectRoot);
  const settings = bundle.project.settings;
  const providerSource = (providerId ? settings.providers.find((item) => item.id === providerId) : undefined)
    ?? settings.providers.find((item) => item.enabled && item.kind !== "offline-manual")
    ?? settings.providers.find((item) => item.enabled);
  if (!providerSource || providerSource.kind === "offline-manual") {
    throw new Error("An online AI provider is required to generate a commit message.");
  }
  const provider = await hydrateProviderForUse(providerSource);

  const maxTotalChars = 40000;
  let usedChars = 0;
  const fileSections: string[] = [];
  for (const relativePath of filePaths) {
    if (usedChars >= maxTotalChars) {
      fileSections.push(`--- ${relativePath} ---\n(omitted; commit message context budget reached)`);
      continue;
    }
    let section: string;
    try {
      const { diff } = await readProjectFileDiff(projectRoot, relativePath);
      if (diff.trim()) {
        section = `--- ${relativePath} ---\n${diff}`;
      } else {
        // No tracked diff usually means a new/untracked file; show its content instead.
        const file = await readProjectFile(projectRoot, relativePath);
        section = file.binary
          ? `--- ${relativePath} ---\n(new binary file, no text diff available)`
          : `--- ${relativePath} (new file) ---\n${file.content.slice(0, 4000)}`;
      }
    } catch (error) {
      section = `--- ${relativePath} ---\n(could not read changes: ${error instanceof Error ? error.message : String(error)})`;
    }
    section = section.slice(0, maxTotalChars - usedChars);
    usedChars += section.length;
    fileSections.push(section);
  }

  const instruction = [
    "Write a single git commit message describing the diff below.",
    "Use a concise summary line under 72 characters in the imperative mood with no trailing period, optionally followed by a blank line and a short body of a few bullet points only if the change genuinely needs more explanation.",
    "Base the message only on what the diff actually shows; do not invent motivation, ticket numbers, or context that isn't visible in the diff.",
    "Return only the commit message text, no preamble, no markdown fences, and no quotation marks around it."
  ].join(" ");

  const context = [instruction, "", "Changed files:", fileSections.join("\n\n")].join("\n");
  const result = await callProvider(provider, context, instruction, { projectRoot, webSearchEnabled: false, bareExtraction: true, phase: "summarizing" });
  return result.trim();
}

export async function authorAcceptanceTestsScoped(
  projectRoot: string,
  flowId: string,
  nodeId?: string,
  providerId?: string,
  options: {
    onProgress?: (message: string) => void;
    onClarification?: (question: string) => Promise<string>;
    writeAuthorizedByUser?: boolean;
  } = {}
): Promise<AuthorAcceptanceTestsResult> {
  const { onProgress, onClarification, writeAuthorizedByUser = false } = options;
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);

  const settings = bundle.project.settings;
  const providerSource = (providerId ? settings.providers.find((item) => item.id === providerId) : undefined)
    ?? settings.providers.find((item) => item.enabled && item.kind !== "offline-manual")
    ?? settings.providers.find((item) => item.enabled);
  if (!providerSource || providerSource.kind === "offline-manual") {
    throw new Error("An online AI provider is required to author acceptance tests.");
  }
  const provider = await hydrateProviderForUse(providerSource);

  let targets: Flow["nodes"];
  if (nodeId) {
    const node = flow.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`Node ${nodeId} was not found.`);
    if (!node.acceptanceCriteria.some((text) => text.trim())) {
      throw new Error("This node has no acceptance criteria to author tests for.");
    }
    targets = [node];
  } else {
    targets = flow.nodes.filter((node) =>
      !node.ignored && !isProductionApproved(node) && node.acceptanceCriteria.some((text) => text.trim()));
    if (!targets.length) throw new Error("No eligible nodes with acceptance criteria were found in this flow.");
  }

  const techStack = await detectTechStack(projectRoot).catch(() => null);
  const syncedChecksByNodeId = new Map<string, AcceptanceCheck[]>();
  const results: AuthorAcceptanceTestsResult["results"] = [];

  for (const node of targets) {
    const profile = resolveNodeRunTargetProfile(settings, node);
    const input: TestAuthoringInput = {
      flowId,
      nodeId: node.id,
      nodeTitle: node.title,
      nodeDescription: node.description,
      nodeType: node.type,
      techStack: node.techStack,
      acceptanceCriteria: node.acceptanceCriteria.map((text) => text.trim()).filter(Boolean),
      existingCheckCriteria: node.acceptanceChecks.map((check) => check.criterion),
      framework: techStack?.testFramework ?? null,
      packageManager: techStack?.packageManager ?? null,
      detectedTestCommand: techStack?.suggestedCommands.test ?? null,
      moduleTestCommand: profile?.testCommand ?? null,
      moduleCwd: profile?.cwd ?? null,
      stackAssumptions: settings.stackAssumptions ?? [],
      suggestedTestDir: acceptanceTestDirForNode(node.title),
      writeAuthorizedByUser
    };

    onProgress?.(`Authoring tests for "${node.title}"…`);
    const runResult = await executeMicroRun(projectRoot, "test-authoring", input, provider, bundle, { onProgress, onClarification });
    if (runResult.status === "failed") {
      throw new Error(runResult.error ?? `Test authoring failed for "${node.title}".`);
    }
    const output = (runResult.output ?? { checks: [], filesWritten: [], report: "" }) as TestAuthoringOutput;
    const writtenFiles = new Set(output.filesWritten);
    const agentChecks = output.checks.filter((check) =>
      writtenFiles.has(check.testFilePath)
      && check.criterion.trim()
      && check.testCommand.trim()
      && !isInlineScriptTestCommand(check.testCommand));

    // Sync the node's checks to its criteria: agent-produced checks create/update
    // (preserving the id of an existing check for the same criterion, resetting
    // status since the test changed), existing checks for still-present criteria
    // are kept, and checks whose criterion no longer exists are dropped.
    const synced = syncNodeAcceptanceChecks(node, agentChecks);
    const isDifferent = synced.length !== node.acceptanceChecks.length ||
      synced.some((check, index) => JSON.stringify(check) !== JSON.stringify(node.acceptanceChecks[index]));
    if (isDifferent) syncedChecksByNodeId.set(node.id, synced);
    results.push({ nodeId: node.id, title: node.title, testsAdded: agentChecks.length, filesWritten: output.filesWritten, report: output.report });
  }

  const totalAgentChecks = results.reduce((sum, result) => sum + result.testsAdded, 0);
  const totalFiles = results.reduce((sum, result) => sum + result.filesWritten.length, 0);
  if (nodeId && totalAgentChecks === 0 && totalFiles === 0) {
    const report = results[0]?.report?.trim();
    throw new Error(
      `The agent wrote no tests for these criteria.${report ? ` Agent report: ${report}` : ""} ` +
      `If this is a brand-new project with no app scaffold yet, run AI Implement with ${gaiaAgent.name} first to create the app, then generate tests.`
    );
  }
  if (syncedChecksByNodeId.size) {
    // The agent wrote test files to disk; node data on disk is unchanged, so we
    // apply the synced checks to the in-memory flow.
    const nextFlow = flowSchema.parse({
      ...flow,
      nodes: flow.nodes.map((node) => {
        const synced = syncedChecksByNodeId.get(node.id);
        return synced ? { ...node, acceptanceChecks: synced, updatedAt: iso() } : node;
      }),
      updatedAt: iso()
    });
    await writeJson(projectStatePath(projectRoot, "flows", `${flowId}.json`), nextFlow);
    await touchProject(projectRoot);
  }

  // Prune orphaned test files: for every node we processed, delete anything left
  // in its `.archicode/tests/<slug>` folder that no surviving check references.
  for (const node of targets) {
    const finalChecks = syncedChecksByNodeId.get(node.id) ?? node.acceptanceChecks;
    const keep = new Set(finalChecks.map((check) => check.testFilePath).filter((value): value is string => Boolean(value)));
    await pruneNodeTestDirectory(projectRoot, acceptanceTestDirForNode(node.title), keep);
  }

  return { bundle: await loadProject(projectRoot), results };
}

export async function clearNodeAcceptanceTests(
  projectRoot: string,
  flowId: string,
  nodeId: string
): Promise<ProjectBundle> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  const node = flow.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} was not found.`);

  await pruneNodeTestDirectory(projectRoot, acceptanceTestDirForNode(node.title), new Set());

  const nextFlow = flowSchema.parse({
    ...flow,
    nodes: flow.nodes.map((item) => item.id === nodeId
      ? { ...item, acceptanceChecks: [], updatedAt: iso() }
      : item),
    updatedAt: iso()
  });
  await writeJson(projectStatePath(projectRoot, "flows", `${flowId}.json`), nextFlow);
  await touchProject(projectRoot);
  return loadProject(projectRoot);
}

// Reconcile a node's acceptanceChecks to its acceptance criteria: one check per
// criterion, in criteria order. An agent-produced check creates/updates (keeping
// an existing check's id, resetting status since the test changed); an existing
// check for a still-present criterion is kept as-is; a check whose criterion no
// longer exists is dropped. Criteria the agent could not test stay uncovered.
export function syncNodeAcceptanceChecks(node: Flow["nodes"][number], agentChecks: Array<{ criterion: string; testFilePath: string; testCommand: string; testName?: string }>): AcceptanceCheck[] {
  const criteria = node.acceptanceCriteria.map((text) => text.trim()).filter(Boolean);
  const agentByCriterion = new Map(agentChecks.map((check) => [check.criterion.trim().toLowerCase(), check]));
  const existingByCriterion = new Map(node.acceptanceChecks.map((check) => [check.criterion.trim().toLowerCase(), check]));
  const result: AcceptanceCheck[] = [];
  for (const criterion of criteria) {
    const key = criterion.toLowerCase();
    const agent = agentByCriterion.get(key);
    const existing = existingByCriterion.get(key);
    if (agent) {
      result.push(acceptanceCheckSchema.parse({
        id: existing?.id ?? id("check"),
        criterion,
        testFilePath: (agent.testFilePath.trim() || existing?.testFilePath) || undefined,
        testName: (agent.testName?.trim() || existing?.testName) || undefined,
        testCommand: agent.testCommand.trim(),
        status: "unverified",
        updatedAt: iso()
      }));
    } else if (existing) {
      result.push(existing);
    }
  }
  return result;
}

export interface RunAcceptanceChecksResult {
  bundle: ProjectBundle;
  total: number;
  passing: number;
  failing: number;
}

// "Run all tests" for a node: execute each check's testCommand, set each check's
// status from the exit code, and reflect the outcome on the node's flags
// (needs-attention when any check fails). Explicit user action, so it runs the
// commands directly. Failing/errored commands (e.g. no scaffold yet) read as red.
export async function runNodeAcceptanceChecks(
  projectRoot: string,
  flowId: string,
  nodeId: string,
  runId?: string
): Promise<RunAcceptanceChecksResult> {
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) throw new Error(`Flow ${flowId} was not found.`);
  const node = flow.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} was not found.`);

  const settings = bundle.project.settings;
  const profileById = new Map(settings.runTargetProfiles.map((item) => [item.id, item]));
  const runnable = node.acceptanceChecks
    .map((check) => ({ check, command: resolveAcceptanceCheckCommand(check, node, profileById) }))
    .filter((entry): entry is { check: AcceptanceCheck; command: string } => Boolean(entry.command));
  if (!runnable.length) throw new Error("This node has no acceptance checks with a test command to run.");

  const profile = resolveNodeRunTargetProfile(settings, node);
  const cwd = profile?.cwd ? path.join(projectRoot, profile.cwd) : projectRoot;

  const results: Array<{ id: string; status: AcceptanceCheckStatus; evidence: string }> = [];
  for (const { check, command } of runnable) {
    const outcome = await runVerificationCommand(cwd, command, [], { timeout: ACCEPTANCE_CHECK_TEST_TIMEOUT_MS })
      .catch((error) => ({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1, passed: false }));
    const output = `${outcome.stdout}\n${outcome.stderr}`.trim().slice(0, ACCEPTANCE_CHECK_OUTPUT_LIMIT);
    results.push({
      id: check.id,
      status: outcome.exitCode === 0 ? "passing" : "failing",
      evidence: `\`${command}\` exited ${outcome.exitCode}.${output ? ` ${output.slice(0, 300)}` : ""}`.trim()
    });
  }

  await recordAcceptanceCheckResults(projectRoot, flowId, nodeId, results, runId);

  // Reflect failures on the node flags (unless approved/ignored).
  const anyFailing = results.some((result) => result.status === "failing");
  const refreshed = await loadProject(projectRoot);
  const refreshedFlow = refreshed.flows.find((item) => item.id === flowId);
  const refreshedNode = refreshedFlow?.nodes.find((item) => item.id === nodeId);
  if (refreshedFlow && refreshedNode && !refreshedNode.ignored && !isProductionApproved(refreshedNode)) {
    const flags = new Set(refreshedNode.flags);
    if (anyFailing) flags.add("needs-attention");
    else if (!flags.has("llm-question")) flags.delete("needs-attention");
    const nextFlags = [...flags];
    if (nextFlags.join("|") !== refreshedNode.flags.join("|")) {
      const nextFlow = flowSchema.parse({
        ...refreshedFlow,
        nodes: refreshedFlow.nodes.map((item) => item.id === nodeId ? { ...refreshedNode, flags: nextFlags, updatedAt: iso() } : item),
        updatedAt: iso()
      });
      await writeJson(projectStatePath(projectRoot, "flows", `${flowId}.json`), nextFlow);
      await touchProject(projectRoot);
    }
  }

  const passing = results.filter((result) => result.status === "passing").length;
  return { bundle: await loadProject(projectRoot), total: results.length, passing, failing: results.length - passing };
}
