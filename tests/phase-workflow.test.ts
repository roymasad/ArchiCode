import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearNodeAcceptanceTests, recordAcceptanceCheckResults, runNodeAcceptanceChecks, verifyRunAcceptanceChecks } from "../src/main/storage/acceptanceChecks";
import { addNote } from "../src/main/storage/notes";
import { ensureFixtureProject, loadProject, setGlobalMcpSettingsStore, updateNode, updateProjectSettings } from "../src/main/storage/projectStore";
import { approveRun, cancelRun, rejectRun, retryRun, startAgentRun, startDebuggingRun, startRunProfile } from "../src/main/storage/runEngine";
import { runSchema, type ProjectBundle, type ProjectSettings, type Run } from "../src/shared/schema";

// Generous deadline: healthy runs resolve in well under a second, but a fully
// parallel suite starves the event loop enough that 7s produced regular
// "Last status: succeeded" flakes (the run finished after the final poll).
const RUN_WAIT_DEADLINE_MS = 25000;

// These workflow tests spawn real subprocess chains (fake codex + npm
// scripts); under full-suite parallel load they can exceed vitest's 5s
// default even when healthy.
vi.setConfig({ testTimeout: 30000 });

async function waitForRun(root: string, runId: string, predicate: (run: Run) => boolean): Promise<{ bundle: ProjectBundle; run: Run }> {
  const started = Date.now();
  while (Date.now() - started < RUN_WAIT_DEADLINE_MS) {
    const bundle = await loadProject(root);
    const run = bundle.runs.find((item) => item.id === runId);
    if (run && predicate(run)) return { bundle, run };
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const bundle = await loadProject(root);
  const run = bundle.runs.find((item) => item.id === runId);
  throw new Error(`Timed out waiting for run ${runId}. Last status: ${run?.status ?? "missing"}`);
}

async function waitForBundle(root: string, predicate: (bundle: ProjectBundle) => boolean): Promise<ProjectBundle> {
  const started = Date.now();
  while (Date.now() - started < RUN_WAIT_DEADLINE_MS) {
    const bundle = await loadProject(root);
    if (predicate(bundle)) return bundle;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const bundle = await loadProject(root);
  throw new Error(`Timed out waiting for project state. Runs: ${bundle.runs.map((run) => `${run.id}:${run.status}`).join(", ")}`);
}

async function createFakeCodex(root: string, options: { failedVerification?: boolean } = {}): Promise<string> {
  const commandPath = path.join(root, "fake-codex.cjs");
  await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const failedVerification = ${JSON.stringify(Boolean(options.failedVerification))};
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--output-last-message");
  const outputPath = outIndex >= 0 ? args[outIndex + 1] : null;
  const cdIndex = args.indexOf("--cd");
  const projectRoot = cdIndex >= 0 ? args[cdIndex + 1] : process.cwd();
  const coding = stdin.includes("coding phase after an ArchiCode plan artifact");
  if (coding) {
    fs.writeFileSync(path.join(projectRoot, "app.txt"), "generated from node plan\\n", "utf8");
    if (failedVerification) {
      console.log(JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "/bin/zsh -lc 'npm run test'",
          aggregated_output: "failed to load config\\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite'",
          exit_code: 1,
          status: "failed"
        }
      }));
    }
  }
  const message = coding ? "Coding changed app.txt" : "Planning complete. Files: app.txt. Tests: npm test.";
  if (outputPath) fs.writeFileSync(outputPath, message, "utf8");
  process.exit(0);
});
`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function createSlowFakeCodex(root: string): Promise<string> {
  const commandPath = path.join(root, "slow-fake-codex.cjs");
  await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  setTimeout(() => {
    const args = process.argv.slice(2);
    const outIndex = args.indexOf("--output-last-message");
    const outputPath = outIndex >= 0 ? args[outIndex + 1] : null;
    const cdIndex = args.indexOf("--cd");
    const projectRoot = cdIndex >= 0 ? args[cdIndex + 1] : process.cwd();
    const coding = stdin.includes("coding phase after an ArchiCode plan artifact");
    if (coding) fs.writeFileSync(path.join(projectRoot, "app.txt"), "should not be written after cancel\\n", "utf8");
    if (outputPath) fs.writeFileSync(outputPath, coding ? "Coding changed app.txt" : "Planning complete. Files: app.txt. Tests: npm test.", "utf8");
    process.exit(0);
  }, 500);
});
`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

describe("phase workflow", () => {
  beforeEach(() => {
    // MCP servers are an app-wide preference persisted through this store (see
    // storage.ts's setGlobalMcpSettingsStore); wire up an in-memory stand-in so
    // servers set via updateProjectSettings round-trip the same way the real
    // app's global store keeps them, instead of vanishing on the next load.
    let globalMcp: ProjectSettings["mcp"] | null = null;
    setGlobalMcpSettingsStore({
      load: async () => globalMcp,
      save: async (settings) => {
        globalMcp = settings;
      }
    });
  });

  afterEach(() => {
    setGlobalMcpSettingsStore(null);
  });

  it("stores user guidance and context summary on retried runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-guided-retry-"));
    const providerCommand = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: providerCommand }
        : { ...provider, enabled: false })
    });
    const flow = bundle.flows[0]!;
    const started = await startAgentRun({
      projectRoot: root,
      flowId: flow.id,
      nodeId: flow.nodes[0]?.id,
      providerId: "codex-local",
      promptSummary: "Plan a small change"
    });
    const completed = await waitForRun(root, started.runId, (run) => run.status === "succeeded");
    const implementedNode = completed.bundle.flows[0]!.nodes.find((node) => node.id === flow.nodes[0]?.id)!;
    expect(implementedNode.implementationScope).toMatchObject({
      source: "implementation-agent",
      updatedByRunId: started.runId,
      checkedAt: expect.any(String),
      claims: [{ relation: "own", kind: "file", path: "app.txt" }]
    });
    expect(implementedNode.implementationScope?.claims.some((claim) => claim.path === "AGENTS.md" || claim.path === "README.md")).toBe(false);
    const retried = await retryRun(root, completed.run.id, {
      text: "Focus only on the settings panel.",
      evidence: ["last-error", "node-notes"]
    });
    const retryBundle = await loadProject(root);
    const retry = retryBundle.runs.find((run) => run.id === retried.runId);

    expect(retried.runId).toBe(completed.run.id);
    expect(retry?.retryOf).toBeUndefined();
    expect(retry?.guidance?.text).toBe("Focus only on the settings panel.");
    expect(retry?.guidance?.evidence).toContain("node-notes");
    expect(retry?.contextSummary?.items.some((item) => item.label === "detailed nodes")).toBe(true);
  });

  it("blocks retry and debug actions while another run is active", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-active-lane-block-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    const createdAt = new Date().toISOString();

    await writeFile(path.join(root, ".archicode", "runs", "run-active.json"), JSON.stringify({
      id: "run-active",
      flowId: flow.id,
      nodeId: node.id,
      providerId: "openai-compatible",
      status: "planning",
      phase: "planning",
      promptSummary: "Active run",
      permission: { decision: "allowed" },
      logs: [{ at: createdAt, stream: "system", text: "Planning phase started." }],
      createdAt,
      startedAt: createdAt
    }, null, 2));
    await writeFile(path.join(root, ".archicode", "runs", "run-failed.json"), JSON.stringify({
      id: "run-failed",
      flowId: flow.id,
      nodeId: node.id,
      providerId: "openai-compatible",
      status: "failed",
      phase: "complete",
      promptSummary: "Failed run",
      permission: { decision: "allowed" },
      logs: [{ at: createdAt, stream: "stderr", text: "Verification command failed." }],
      runInstructions: "Verification command failed.",
      completedAt: createdAt,
      createdAt
    }, null, 2));

    await expect(retryRun(root, "run-failed")).rejects.toThrow("Finish or cancel the active run (run-active)");
    await expect(startDebuggingRun(root, "run-failed")).rejects.toThrow("Finish or cancel the active run (run-active)");
  });

  it("serializes concurrent run creation so only one write-capable run can claim the lane", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-concurrent-run-start-"));
    const command = await createSlowFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command }
        : { ...provider, enabled: false }),
      stopOnUnansweredQuestions: false
    });

    const starts = await Promise.allSettled([
      startAgentRun({ projectRoot: root, flowId: "flow-main", providerId: "codex-local", promptSummary: "First concurrent start" }),
      startAgentRun({ projectRoot: root, flowId: "flow-main", providerId: "codex-local", promptSummary: "Second concurrent start" })
    ]);
    const fulfilled = starts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof startAgentRun>>> => result.status === "fulfilled");
    const rejected = starts.filter((result): result is PromiseRejectedResult => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toContain("Finish or cancel the active run");
    const activeBundle = await loadProject(root);
    expect(activeBundle.runs.filter((run) => ["preparing", "planning", "coding", "verifying"].includes(run.status))).toHaveLength(1);
    await cancelRun(root, fulfilled[0]!.value.runId);
    await waitForRun(root, fulfilled[0]!.value.runId, (run) => run.status === "cancelled");
  });

  it.skipIf(process.platform === "win32")("force-stops a command process group when cancellation is ignored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-force-cancel-"));
    const pidPath = path.join(root, "stubborn.pid");
    await ensureFixtureProject(root);
    await writeFile(path.join(root, "stubborn.cjs"), [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);"
    ].join("\n"), "utf8");

    const started = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Exercise forceful cancellation",
      command: "node stubborn.cjs",
      allowShell: true
    });
    let stubbornPid = 0;
    const pidDeadline = Date.now() + 3_000;
    while (!stubbornPid && Date.now() < pidDeadline) {
      stubbornPid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
      if (!stubbornPid) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(stubbornPid).toBeGreaterThan(0);

    await cancelRun(root, started.runId);
    await waitForRun(root, started.runId, (run) => run.status === "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    let stillAlive = true;
    try {
      process.kill(stubbornPid, 0);
    } catch {
      stillAlive = false;
    }
    expect(stillAlive).toBe(false);
  });

  it("reconciles runtime profiles with the LLM before direct build commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-prebuild-runtime-reconcile-"));
    const providerCommand = path.join(root, "fake-reconcile-codex.cjs");
    const buildCommand = "node build.cjs";
    await writeFile(providerCommand, `#!/usr/bin/env node
const fs = require("fs");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--output-last-message");
  const outputPath = outIndex >= 0 ? args[outIndex + 1] : null;
  const output = JSON.stringify({
    archicodePatch: {
      schemaVersion: 1,
      summary: "Add split frontend runtime",
      operations: [
        {
          kind: "propose-run-profile",
          mode: "create",
          profile: {
            id: "script-dev-web",
            label: "Web",
            kind: "web",
            cwd: "",
            description: "Run the frontend dev server.",
            targetRequired: false,
            readyPattern: "localhost|127\\\\.0\\\\.0\\\\.1|Local:",
            diagnosticCommands: [],
            recoveryCommands: [],
            retryAfterRecovery: true,
            runCommand: "npm run dev:web",
            setupCommand: "node setup.cjs",
            buildCommand: "npm run build",
            testCommand: "npm run test",
            inferred: true,
            timeoutSeconds: 120
          }
        }
      ]
    }
  });
  if (outputPath) fs.writeFileSync(outputPath, output, "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(providerCommand, 0o755);
    await writeFile(path.join(root, "setup.cjs"), "require('fs').writeFileSync('setup.txt', 'setup\\n', 'utf8');\n", "utf8");
    await writeFile(path.join(root, "build.cjs"), "const fs = require('fs'); if (!fs.existsSync('setup.txt')) process.exit(7); fs.writeFileSync('built.txt', 'built\\n', 'utf8');\n", "utf8");
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        build: "node build.cjs"
      }
    }), "utf8");
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      defaultBuildCommand: buildCommand,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: providerCommand }
        : { ...provider, enabled: false }),
      allowedShellCommands: [buildCommand]
    });
    const flow = bundle.flows[0]!;
    await writeFile(path.join(root, ".archicode", "flows", `${flow.id}.json`), JSON.stringify({
      ...flow,
      nodes: flow.nodes.map((node) => ({
        ...node,
        flags: node.stage === "draft-approved-production" ? node.flags : ["changed", "needs-attention", "modified-not-built"]
      })),
      updatedAt: "2026-06-24T10:00:00.000Z"
    }, null, 2));
    await writeFile(path.join(root, ".archicode", "flows", "flow-secondary.json"), JSON.stringify({
      ...flow,
      id: "flow-secondary",
      name: "Secondary flow",
      nodes: flow.nodes.map((node) => ({
        ...node,
        id: `${node.id}-secondary`,
        stage: node.stage === "draft-approved-production" ? node.stage : "draft",
        flags: node.stage === "draft-approved-production" ? node.flags : ["changed", "needs-attention", "modified-not-built"],
        updatedAt: "2026-06-24T10:00:00.000Z"
      })),
      edges: flow.edges.map((edge) => ({
        ...edge,
        id: `${edge.id}-secondary`,
        source: `${edge.source}-secondary`,
        target: `${edge.target}-secondary`
      })),
      updatedAt: "2026-06-24T10:00:00.000Z"
    }, null, 2));

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: `Run project build command: ${buildCommand}`,
      command: buildCommand,
      purpose: "build-discovery"
    });
    const { bundle: completed, run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(run.logs.some((line) => line.text.includes("Pre-build runtime profile reconciliation"))).toBe(true);
    expect(run.logs.some((line) => line.text.includes("Running setup command before build"))).toBe(true);
    await expect(readFile(path.join(root, "setup.txt"), "utf8")).resolves.toBe("setup\n");
    await expect(readFile(path.join(root, "built.txt"), "utf8")).resolves.toBe("built\n");
    expect(completed.project.settings.runTargetProfiles.some((profile) =>
      profile.id === "script-dev-web" && profile.runCommand === "npm run dev:web" && profile.setupCommand === "node setup.cjs"
    )).toBe(true);
    const editableNodes = completed.flows.flatMap((item) => item.nodes.filter((node) => node.stage !== "draft-approved-production"));
    expect(editableNodes.every((node) => !node.flags.includes("changed"))).toBe(true);
    expect(editableNodes.every((node) => !node.flags.includes("needs-attention"))).toBe(true);
    expect(editableNodes.every((node) => !node.flags.includes("modified-not-built"))).toBe(true);
  });

  it("creates a durable plan artifact before a provider run completes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-plan-artifact-"));
    const command = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command }
        : { ...provider, enabled: false }),
      stopOnUnansweredQuestions: false
    });
    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Plan a tiny change"
    });
    const { bundle: completed, run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(run.phase).toBe("complete");
    expect(run.planArtifactIds).toHaveLength(1);
    expect(completed.artifacts.some((artifact) => artifact.id === run.planArtifactIds[0] && artifact.type === "plan")).toBe(true);
    const planArtifact = JSON.parse(await readFile(path.join(root, ".archicode", "artifacts", `${runId}-plan.json`), "utf8")) as {
      title?: string;
      summary?: string;
      providerSummary?: string;
      text?: string;
    };
    expect(planArtifact.title).toBe("Plan a tiny change");
    expect(planArtifact.summary).toContain("Planning complete");
    expect(planArtifact.providerSummary).toContain("Planning complete");
    expect(planArtifact.text).toContain("Planning complete. Files: app.txt");
  });

  it("pauses after planning when manual plan review is enabled, then codes after approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-plan-review-"));
    const command = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      planningReviewMode: "manual",
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" }
        : { ...provider, enabled: false }),
      allowedShellCommands: [command],
      stopOnUnansweredQuestions: false
    });
    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Add a generated app text file"
    });
    await waitForRun(root, runId, (run) => run.status === "awaiting-plan-review");

    await approveRun({ projectRoot: root, runId });
    const { bundle: completed, run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    await expect(readFile(path.join(root, "app.txt"), "utf8")).resolves.toContain("generated from node plan");
    expect(run.sourceDiffArtifactIds).toHaveLength(1);
    expect(completed.artifacts.some((artifact) => artifact.id === run.sourceDiffArtifactIds[0] && artifact.type === "diff")).toBe(true);
  });

  it("does not stop for open planning questions when plan review is automatic", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-auto-plan-question-skip-"));
    const command = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    await addNote(root, {
      flowId: flow.id,
      nodeId: node.id,
      kind: "llm-question",
      author: "llm",
      body: "Which platform should this target first?",
      category: "note",
      priority: "high",
      resolved: false
    });
    const withQuestion = await loadProject(root);
    await updateProjectSettings(root, {
      ...withQuestion.project.settings,
      planningReviewMode: "auto",
      providers: withQuestion.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" }
        : { ...provider, enabled: false }),
      allowedShellCommands: [command],
      stopOnUnansweredQuestions: true
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: flow.id,
      nodeId: node.id,
      providerId: "codex-local",
      promptSummary: "Add a generated app text file despite an open question"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(run.reviewDecisions.some((decision) => decision.kind === "planning")).toBe(false);
    await expect(readFile(path.join(root, "app.txt"), "utf8")).resolves.toContain("generated from node plan");
  }, 10000);

  it("keeps a run cancelled when planning provider output arrives later", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-cancel-inflight-planning-"));
    const command = await createSlowFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      planningReviewMode: "auto",
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" }
        : { ...provider, enabled: false }),
      allowedShellCommands: [command],
      stopOnUnansweredQuestions: false
    });
    const node = bundle.flows[0]!.nodes[0]!;

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      nodeId: node.id,
      providerId: "codex-local",
      promptSummary: "Plan a change that will be cancelled"
    });
    await waitForRun(root, runId, (run) => run.status === "planning");
    await updateNode(root, "flow-main", { id: node.id, stage: "working" }, "user");

    await cancelRun(root, runId);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const finalBundle = await loadProject(root);
    const run = finalBundle.runs.find((item) => item.id === runId);

    expect(run?.status).toBe("cancelled");
    expect(run?.phase).toBe("complete");
    expect(run?.logs.some((line) => line.text === "Run cancelled.")).toBe(true);
    const cancelledNode = finalBundle.flows[0]?.nodes.find((item) => item.id === node.id);
    expect(cancelledNode?.stage).toBe("planned");
    expect(cancelledNode?.flags).not.toContain("needs-attention");
    await expect(readFile(path.join(root, "app.txt"), "utf8")).rejects.toThrow();
  }, 10000);

  it("records a rejected plan review and stops the run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-plan-reject-"));
    const command = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      planningReviewMode: "manual",
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" }
        : { ...provider, enabled: false }),
      allowedShellCommands: [command],
      stopOnUnansweredQuestions: false
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Plan a rejected change"
    });
    await waitForRun(root, runId, (run) => run.status === "awaiting-plan-review");

    const rejected = await rejectRun(root, runId);
    const run = rejected.runs.find((item) => item.id === runId);

    expect(run?.status).toBe("cancelled");
    expect(run?.phase).toBe("complete");
    expect(run?.reviewDecisions).toContainEqual(expect.objectContaining({ kind: "planning", decision: "rejected" }));
    await expect(readFile(path.join(root, "app.txt"), "utf8")).rejects.toThrow();
  });

  it("continues into coding without a second provider-launch approval for workspace-write Codex Local", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-code-no-provider-permission-"));
    const command = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" }
        : { ...provider, enabled: false }),
      stopOnUnansweredQuestions: false
    });
    const preexistingDirtyNode = bundle.flows[0]!.nodes.find((node) => !node.locked && node.stage !== "draft-approved-production")!;
    await updateNode(root, "flow-main", {
      id: preexistingDirtyNode.id,
      flags: [...preexistingDirtyNode.flags, "changed" as const, "needs-attention" as const]
    }, "user");

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Code without a redundant provider launch approval"
    });
    const { bundle: completed, run } = await waitForRun(root, runId, (item) => item.status === "succeeded");
    const nodes = completed.flows[0]?.nodes.filter((node) => !node.locked && node.stage !== "draft-approved-production") ?? [];

    await expect(readFile(path.join(root, "app.txt"), "utf8")).resolves.toContain("generated from node plan");
    expect(run.permission.decision).toBe("allowed");
    expect(run.permission.reason).toContain("workspace write");
    expect(nodes.every((node) => node.stage === "draft")).toBe(true);
    expect(nodes.every((node) => node.flags.includes("has-diff"))).toBe(true);
    expect(nodes.every((node) => node.flags.includes("modified-not-built"))).toBe(true);
    expect(nodes.find((node) => node.id === preexistingDirtyNode.id)?.flags).toContain("changed");
    expect(completed.notes.some((note) =>
      note.author === "llm" &&
      note.kind === "system-note" &&
      note.body.includes(`LLM handoff for run ${runId}`) &&
      note.attachmentIds.some((artifactId) => run.sourceDiffArtifactIds.includes(artifactId))
    )).toBe(true);
  });

  it("starts local runs before pausing on an actual Ask-mode MCP tool call, then resumes the same run after approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-approved-mcp-"));
    const commandPath = path.join(root, "capture-approved-mcp-codex.cjs");
    const mcpServerPath = path.join(root, "fake-context7-mcp.mjs");
    const argsPath = path.join(root, "codex-args.json");
    await writeFile(mcpServerPath, `#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-context7", version: "0.0.1" });
server.tool("resolve-library-id", "Resolve docs.", { libraryName: z.string().optional() }, async (args) => ({
  content: [{ type: "text", text: \`resolved:\${args.libraryName ?? "unknown"}\` }]
}));

await server.connect(new StdioServerTransport());
`, "utf8");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
process.stdin.on("end", () => {
  const previous = fs.existsSync(${JSON.stringify(argsPath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(argsPath)}, "utf8")) : [];
  const args = process.argv.slice(2);
  previous.push({ args, stdin });
  fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(previous), "utf8");
  const hasApprovedContext7 = args.some((arg) => String(arg).includes("mcp_servers.context7.command"));
  const message = hasApprovedContext7
    ? "Planning complete after approved MCP tool."
    : JSON.stringify({
        archicodeMcpRequest: {
          serverId: "context7",
          toolName: "resolve-library-id",
          arguments: { libraryName: "react-router" },
          intent: "Resolve the right documentation library id before finalizing the plan."
        }
      });
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], message, "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(mcpServerPath, 0o755);
    await chmod(commandPath, 0o755);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: commandPath }
        : { ...provider, enabled: false }),
      mcp: {
        ...bundle.project.settings.mcp,
        servers: [{
          id: "context7",
          label: "Context7",
          transport: "stdio",
          command: process.execPath,
          args: [mcpServerPath],
          env: [{ name: "CONTEXT7_API_KEY", value: "" }],
          headers: [],
          enabled: true,
          trusted: false,
          source: "project",
          tools: [{ name: "resolve-library-id", description: "Resolve docs." }],
          resources: [],
          prompts: []
        }]
      },
      stopOnUnansweredQuestions: false
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Plan with Context7 available after approval"
    });
    const pending = await waitForRun(root, runId, (run) => run.status === "needs-permission");
    const invocationsBeforeApproval = JSON.parse(await readFile(argsPath, "utf8")) as Array<{ args: string[]; stdin: string }>;

    expect(invocationsBeforeApproval).toHaveLength(1);
    expect(invocationsBeforeApproval[0]?.stdin).toContain("External MCP discovery for this run:");
    expect(invocationsBeforeApproval[0]?.stdin).toContain("context7 (Context7) [ask]");
    expect(invocationsBeforeApproval[0]?.args.join("\n")).not.toContain("mcp_servers.context7.command");
    expect(pending.run.mcp?.pendingServerIds).toEqual(["context7"]);
    expect(pending.run.mcp?.pendingToolCall).toMatchObject({
      serverId: "context7",
      serverLabel: "Context7",
      toolName: "resolve-library-id"
    });

    await approveRun({ projectRoot: root, runId });
    const completed = await waitForRun(root, runId, (run) => run.status === "succeeded");
    const invocations = JSON.parse(await readFile(argsPath, "utf8")) as Array<{ args: string[]; stdin: string }>;
    const agentInvocations = invocations.filter((invocation) =>
      invocation.stdin.includes("Prompt summary: Plan with Context7 available after approval")
    );
    const joinedInvocations = agentInvocations.map((invocation) => invocation.args.join("\n"));

    expect(completed.run.mcp?.approvedServerIds).toContain("context7");
    expect(completed.run.mcpToolCalls.some((call) => call.status === "approval-required" && call.toolName === "resolve-library-id")).toBe(true);
    expect(joinedInvocations.length).toBeGreaterThanOrEqual(2);
    expect(joinedInvocations.some((args) => args.includes(`mcp_servers.context7.command=${JSON.stringify(process.execPath)}`))).toBe(true);
    expect(joinedInvocations.some((args) => args.includes(`mcp_servers.context7.args=${JSON.stringify([mcpServerPath])}`))).toBe(true);
    expect(joinedInvocations.some((args) => args.includes("mcp_servers.context7.default_tools_approval_mode=\"approve\""))).toBe(true);
    expect(agentInvocations.some((invocation) => invocation.stdin.includes("Approved MCP tool call: Context7 / resolve-library-id"))).toBe(true);
    expect(agentInvocations.some((invocation) =>
      invocation.stdin.includes("resolved:react-router") ||
      invocation.stdin.includes("Tool execution failed after approval:")
    )).toBe(true);
  });

  it("does not pause for code review in auto mode when direct writes also include an invalid sidecar proposal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-auto-code-invalid-sidecar-"));
    const providerCommand = path.join(root, "fake-invalid-sidecar-codex.cjs");
    await writeFile(providerCommand, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--output-last-message");
  const outputPath = outIndex >= 0 ? args[outIndex + 1] : null;
  const cdIndex = args.indexOf("--cd");
  const projectRoot = cdIndex >= 0 ? args[cdIndex + 1] : process.cwd();
  const coding = stdin.includes("coding phase after an ArchiCode plan artifact");
  if (coding) {
    fs.writeFileSync(path.join(projectRoot, "app.txt"), "generated with invalid sidecar\\n", "utf8");
  }
  const message = coding
    ? JSON.stringify({ archicodePatch: { schemaVersion: 1, summary: "Bad sidecar", operations: [{ kind: "write-file", path: "extra.txt" }] } })
    : "Planning complete. Files: app.txt.";
  if (outputPath) fs.writeFileSync(outputPath, message, "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(providerCommand, 0o755);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      codeReviewMode: "auto-apply",
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: providerCommand, localSandbox: "workspace-write" }
        : { ...provider, enabled: false }),
      stopOnUnansweredQuestions: false
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Code without pausing for an invalid sidecar proposal"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(run.status).not.toBe("awaiting-code-review");
    expect(run.sourceDiffArtifactIds).toHaveLength(1);
    await expect(readFile(path.join(root, "app.txt"), "utf8")).resolves.toContain("generated with invalid sidecar");
  });

  it.each(["accepted", "rejected"] as const)(
    "%s direct-write deletions pause independently and then resume the same run",
    async (decision) => {
      const root = await mkdtemp(path.join(tmpdir(), `archicode-direct-delete-${decision}-`));
      const providerCommand = path.join(root, "fake-delete-codex.cjs");
      await writeFile(path.join(root, "keep.custom"), "pre-existing\n", "utf8");
      await writeFile(providerCommand, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--output-last-message");
  const outputPath = outIndex >= 0 ? args[outIndex + 1] : null;
  const cdIndex = args.indexOf("--cd");
  const projectRoot = cdIndex >= 0 ? args[cdIndex + 1] : process.cwd();
  const coding = stdin.includes("coding phase after an ArchiCode plan artifact");
  const hasDecision = stdin.includes("User approved deletion") || stdin.includes("User rejected deletion");
  if (coding && !hasDecision) fs.unlinkSync(path.join(projectRoot, "keep.custom"));
  const message = coding
    ? JSON.stringify({ archicodePatch: { schemaVersion: 1, summary: "Coding step complete.", runSummary: { implementationStatus: "complete" }, operations: [] } })
    : "Planning complete.";
  if (outputPath) fs.writeFileSync(outputPath, message, "utf8");
  process.exit(0);
});
`, "utf8");
      await chmod(providerCommand, 0o755);
      const bundle = await ensureFixtureProject(root);
      await updateProjectSettings(root, {
        ...bundle.project.settings,
        codeReviewMode: "auto-apply",
        stopOnUnansweredQuestions: false,
        providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
          ? { ...provider, enabled: true, localCommand: providerCommand, localSandbox: "workspace-write" }
          : { ...provider, enabled: false })
      });

      const { runId } = await startAgentRun({
        projectRoot: root,
        flowId: "flow-main",
        providerId: "codex-local",
        promptSummary: "Attempt a direct deletion"
      });
      const { run: paused } = await waitForRun(root, runId, (item) => item.status === "needs-permission");
      expect(paused.sourceReview?.paths).toEqual(["keep.custom"]);
      await expect(readFile(path.join(root, "keep.custom"), "utf8")).resolves.toBe("pre-existing\n");

      if (decision === "accepted") await approveRun({ projectRoot: root, runId });
      else await rejectRun(root, runId, "Keep this pre-existing file.");
      const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

      expect(run.id).toBe(runId);
      if (decision === "accepted") await expect(access(path.join(root, "keep.custom"))).rejects.toThrow();
      else await expect(readFile(path.join(root, "keep.custom"), "utf8")).resolves.toBe("pre-existing\n");
    }
  );

  it("infers and automatically runs install/test/build verification after generated package scripts appear", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-code-verification-handoff-"));
    const command = await createFakeCodex(root, { failedVerification: true });
    const bundle = await ensureFixtureProject(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        dev: "vite",
        test: "vitest",
        build: "vite build"
      }
    }, null, 2));
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" }
        : { ...provider, enabled: false }),
      stopOnUnansweredQuestions: false
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Code and surface failed verification"
    });
    const { bundle: completed, run } = await waitForRun(root, runId, (item) => item.status === "failed");

    expect(run.phase).toBe("complete");
    expect(run.command).toBeUndefined();
    expect(run.logs.some((line) => line.text.includes("Verification phase started"))).toBe(false);
    expect(run.logs.some((line) => line.text.includes("Targeted verification failed: npm install && npm run test -- --run"))).toBe(true);
    expect(completed.project.settings.defaultBuildCommand).toBe("npm run build");
    expect(completed.project.settings.defaultRunCommand).toBe("npm run dev");
    await expect(readFile(path.join(root, ".gitignore"), "utf8")).resolves.toContain("node_modules/");
    await expect(readFile(path.join(root, ".gitignore"), "utf8")).resolves.toContain(".archicode/local.json");
    await expect(readFile(path.join(root, ".gitignore"), "utf8")).resolves.toContain(".archicode/runs/");
    await expect(readFile(path.join(root, ".gitignore"), "utf8")).resolves.toContain(".archicode/artifacts/");
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).resolves.toContain("verification");
    await expect(readFile(path.join(root, "README.md"), "utf8")).resolves.toContain("npm run dev");
    expect(completed.flows[0]?.nodes
      .filter((node) => !node.locked && node.stage !== "draft-approved-production")
      .every((node) => node.stage === "draft")).toBe(true);

    await expect(readFile(path.join(root, "app.txt"), "utf8")).resolves.toContain("generated from node plan");
    expect(run.sourceDiffArtifactIds.length).toBeGreaterThan(0);
    expect(run.runInstructions).toContain("Implementation stopped before all planned source tasks completed");
    expect(run.runInstructions).toContain("npm install");
    expect(run.runInstructions).toContain("npm run test -- --run");
    expect(run.runInstructions).toContain("npm run build");
    expect(run.implementation?.checkpoints.map((checkpoint) => checkpoint.status)).toEqual(["failed", "no-changes"]);
    expect(run.logs.some((line) => line.text.includes("retrying with tighter guidance"))).toBe(true);
    expect(run.logs.some((line) => line.text.includes("Automatic debug pass 1/6 continuing in this run"))).toBe(false);
    expect(run.logs.some((line) => line.text.startsWith("Final status: Implementation stopped before all planned source tasks completed"))).toBe(true);
    const editableNodes = completed.flows[0]?.nodes.filter((node) => !node.locked && node.stage !== "draft-approved-production") ?? [];
    expect(editableNodes.every((node) => node.stage === "draft")).toBe(true);
    expect(editableNodes.every((node) => node.flags.includes("needs-attention"))).toBe(true);
    expect(editableNodes.every((node) => node.flags.includes("modified-not-built"))).toBe(true);
    expect(completed.notes.some((note) =>
      note.kind === "system-note" &&
      note.body.includes(`Run ${runId} failed`) &&
      note.body.includes("npm install")
    )).toBe(true);
  }, 15_000);

  it("keeps verification separate from the inferred dev command after verification passes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-code-run-smoke-"));
    const command = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await writeFile(path.join(root, "dev-server.cjs"), `console.log("Local: http://127.0.0.1:4173/"); setInterval(() => {}, 1000);\n`);
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        dev: "node dev-server.cjs",
        test: "node -e \"console.log('tests pass')\"",
        build: "node -e \"console.log('build passes')\""
      }
    }, null, 2));
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" }
        : { ...provider, enabled: false }),
      stopOnUnansweredQuestions: false
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Code and run smoke verification"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(run.command).toBe("npm install && npm run test && npm run build");
    expect(run.logs.some((line) => line.text.includes("Waiting for approval to verify"))).toBe(false);
    expect(run.runInstructions).toContain("Verification completed");
    expect(run.runInstructions).toContain("Run App");
    expect(run.runInstructions).not.toContain("Run locally with `npm run dev`");
    expect(run.logs.some((line) => line.text.includes("Run smoke passed"))).toBe(false);
    await expect(readFile(path.join(root, ".gitignore"), "utf8")).resolves.toContain("dist/");
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).resolves.toContain("ArchiCode graph");
    await expect(readFile(path.join(root, "README.md"), "utf8")).resolves.toContain("npm run test");
  }, 30000);

  it("retries a transient verification failure once before escalating", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-transient-verify-"));
    const command = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await mkdir(path.join(root, "node_modules"));
    // The build fails on its first invocation with a network-style (transient)
    // error, then passes on the retry.
    await writeFile(path.join(root, "build.cjs"), [
      "const fs = require('fs');",
      "if (!fs.existsSync('retry-marker.txt')) {",
      "  fs.writeFileSync('retry-marker.txt', '1');",
      "  console.error('npm ERR! network request to https://registry.npmjs.org failed, reason: read ECONNRESET');",
      "  process.exit(1);",
      "}",
      "console.log('build passes');"
    ].join("\n"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"console.log('tests pass')\"",
        build: "node build.cjs"
      }
    }, null, 2));
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" }
        : { ...provider, enabled: false }),
      stopOnUnansweredQuestions: false
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Code then verify with a transient failure"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    // The run succeeded via the transient retry rather than escalating to a debug pass.
    expect(run.logs.some((line) => /transient\/environmental error; retrying/.test(line.text))).toBe(true);
    expect(run.logs.some((line) => line.text.includes("Automatic debug pass"))).toBe(false);
    await expect(readFile(path.join(root, "retry-marker.txt"), "utf8")).resolves.toContain("1");
  }, 30000);

  it("retries a cancelled verification run as a verification resume with inherited context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-verification-resume-"));
    const command = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"console.log('tests pass')\"",
        build: "node -e \"console.log('build passes')\""
      }
    }, null, 2));
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "workspace-write" }
        : { ...provider, enabled: false }),
      stopOnUnansweredQuestions: false
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Code then resume verification"
    });
    const { run: completedRun } = await waitForRun(root, runId, (item) => item.status === "succeeded");
    expect(completedRun.phase).toBe("complete");
    expect(completedRun.command).toBe("npm run test && npm run build");
    expect(completedRun.sourceDiffArtifactIds).toHaveLength(1);

    const abandonedAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(path.join(root, ".archicode", "runs", `${runId}.json`), JSON.stringify({
      ...completedRun,
      status: "cancelled",
      phase: "complete",
      permission: {
        decision: "allowed",
        reason: "Approved verification command for this run."
      },
      logs: [
        ...completedRun.logs,
        { at: abandonedAt, stream: "system", text: "Run marked abandoned because ArchiCode restarted without an attached process." }
      ],
      runInstructions: "Run was abandoned after app restart. Start a new run if needed.",
      queueRemovedAt: abandonedAt,
      completedAt: abandonedAt
    }, null, 2));

    const retried = await retryRun(root, runId);
    const retryStarted = retried.bundle.runs.find((item) => item.id === retried.runId);
    expect(retried.runId).toBe(runId);
    expect(retryStarted?.retryOf).toBeUndefined();
    expect(retryStarted?.phase).toBe("verifying");
    expect(retryStarted?.sourceDiffArtifactIds).toEqual(completedRun.sourceDiffArtifactIds);
    expect(retryStarted?.planArtifactIds).toEqual(expect.arrayContaining(completedRun.planArtifactIds));
    expect(retryStarted?.contextArtifacts).toEqual(expect.arrayContaining([...completedRun.contextArtifacts, ...completedRun.sourceDiffArtifactIds]));

    const { run } = await waitForRun(root, retried.runId, (item) => item.status === "succeeded");
    expect(run.runInstructions).toContain("Verification completed");
    const originalCodingStarts = completedRun.logs.filter((line) => /Coding phase started/i.test(line.text)).length;
    const retryCodingStarts = run.logs.filter((line) => /Coding phase started/i.test(line.text)).length;
    expect(retryCodingStarts).toBe(originalCodingStarts);
    expect(run.command).toBe("npm run test && npm run build");
    expect(run.logs.some((line) => /Command exited with code 0/i.test(line.text))).toBe(true);
  });

  it("refreshes stale inferred verification commands when retrying a cancelled run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-stale-verification-command-"));
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      autoApproveShellCommands: false
    });
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest",
        build: "vite build"
      }
    }, null, 2));
    await writeFile(path.join(root, ".archicode", "artifacts", "diff-stale.json"), JSON.stringify({
      id: "diff-stale",
      type: "diff",
      title: "Source diff",
      path: ".archicode/artifacts/diff-stale.json",
      runId: "run-stale-command",
      summary: "1 changed file",
      sizeBytes: 10,
      createdAt: "2026-06-25T15:00:00.000Z"
    }, null, 2));
    await writeFile(path.join(root, ".archicode", "runs", "run-stale-command.json"), JSON.stringify({
      id: "run-stale-command",
      flowId: flow.id,
      nodeId: node.id,
      providerId: "codex-local",
      status: "cancelled",
      phase: "complete",
      promptSummary: "Retry stale Vitest verification",
      command: "npm run test && npm run build",
      permission: { decision: "pending" },
      sourceDiffArtifactIds: ["diff-stale"],
      affectedNodeIds: [node.id],
      reviewDecisions: [
        { kind: "code", decision: "accepted", decidedAt: "2026-06-25T15:00:01.500Z", reason: "Approved from run console." }
      ],
      logs: [
        { at: "2026-06-25T15:00:01.000Z", stream: "system", text: "Run cancelled before completion." }
      ],
      runInstructions: "Run cancelled before completion.",
      completedAt: "2026-06-25T15:00:02.000Z",
      createdAt: "2026-06-25T15:00:00.000Z"
    }, null, 2));

    const retried = await retryRun(root, "run-stale-command");
    const retry = retried.bundle.runs.find((item) => item.id === retried.runId);

    expect(retry?.status).toBe("needs-permission");
    expect(retry?.command).toBe("npm run test -- --run && npm run build");
    expect(retry?.phase).toBe("verifying");
    expect(retry?.sourceDiffArtifactIds).toEqual(["diff-stale"]);
  });

  it("prepends install when retrying verification with declared but missing packages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-retry-missing-deps-"));
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      autoApproveShellCommands: false
    });
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest",
        build: "vite build"
      },
      devDependencies: {
        vitest: "^3.0.0"
      }
    }, null, 2));
    await writeFile(path.join(root, ".archicode", "artifacts", "diff-missing-deps.json"), JSON.stringify({
      id: "diff-missing-deps",
      type: "diff",
      title: "Source diff",
      path: ".archicode/artifacts/diff-missing-deps.json",
      runId: "run-missing-deps",
      summary: "1 changed file",
      sizeBytes: 10,
      createdAt: "2026-06-25T15:00:00.000Z"
    }, null, 2));
    await writeFile(path.join(root, ".archicode", "runs", "run-missing-deps.json"), JSON.stringify({
      id: "run-missing-deps",
      flowId: flow.id,
      nodeId: node.id,
      providerId: "codex-local",
      status: "failed",
      phase: "complete",
      promptSummary: "Retry missing dependency verification",
      command: "npm run test && npm run build",
      permission: { decision: "pending" },
      sourceDiffArtifactIds: ["diff-missing-deps"],
      affectedNodeIds: [node.id],
      reviewDecisions: [
        { kind: "code", decision: "accepted", decidedAt: "2026-06-25T15:00:01.500Z", reason: "Approved from run console." }
      ],
      logs: [
        { at: "2026-06-25T15:00:01.000Z", stream: "stderr", text: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vitest'" }
      ],
      runInstructions: "Verification command failed.",
      completedAt: "2026-06-25T15:00:02.000Z",
      createdAt: "2026-06-25T15:00:00.000Z"
    }, null, 2));

    const retried = await retryRun(root, "run-missing-deps");
    const retry = retried.bundle.runs.find((item) => item.id === retried.runId);

    expect(retry?.status).toBe("needs-permission");
    expect(retry?.command).toBe("npm install && npm run test -- --run && npm run build");
    expect(retry?.phase).toBe("verifying");
  });

  it("routes schema-invalid retries back into coding when verification never started", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-retry-schema-invalid-"));
    const providerCommand = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: providerCommand, localSandbox: "workspace-write" }
        : { ...provider, enabled: false })
    });
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    await writeFile(path.join(root, ".archicode", "artifacts", "plan-schema-invalid.json"), JSON.stringify({
      id: "plan-schema-invalid",
      type: "plan",
      title: "Plan",
      path: ".archicode/artifacts/plan-schema-invalid.json",
      runId: "run-schema-invalid",
      summary: "Plan artifact",
      sizeBytes: 10,
      createdAt: "2026-06-25T15:00:00.000Z"
    }, null, 2));
    await writeFile(path.join(root, ".archicode", "runs", "run-schema-invalid.json"), JSON.stringify({
      id: "run-schema-invalid",
      flowId: flow.id,
      nodeId: node.id,
      providerId: "codex-local",
      status: "failed",
      phase: "coding",
      promptSummary: "Retry after schema failure",
      permission: { decision: "allowed" },
      planArtifactIds: ["plan-schema-invalid"],
      logs: [
        { at: "2026-06-25T15:00:00.000Z", stream: "system", text: "API coding phase started; provider must return source-file proposals for ArchiCode to apply." },
        { at: "2026-06-25T15:00:01.000Z", stream: "stderr", text: "Invalid schema for function 'archicode_project_read_artifact': schema must have type 'object'." }
      ],
      runInstructions: "Invalid schema for function 'archicode_project_read_artifact': schema must have type 'object'.",
      createdAt: "2026-06-25T15:00:00.000Z",
      startedAt: "2026-06-25T15:00:00.500Z",
      completedAt: "2026-06-25T15:00:01.500Z"
    }, null, 2));

    const retried = await retryRun(root, "run-schema-invalid");
    const retry = retried.bundle.runs.find((item) => item.id === retried.runId);

    expect(retry?.phase).toBe("coding");
    expect(retry?.status).toBe("coding");
    expect(retried.runId).toBe("run-schema-invalid");
    expect(retry?.retryOf).toBeUndefined();
  });

  it("rejects runtime commands in verification instead of starting the app", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-command-verification-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        dev: "node -e \"setInterval(() => {}, 1000)\""
      }
    }, null, 2));
    await writeFile(path.join(root, ".archicode", "runs", "run-runtime-verify.json"), JSON.stringify({
      id: "run-runtime-verify",
      flowId: flow.id,
      providerId: "codex-local",
      status: "cancelled",
      phase: "verifying",
      promptSummary: "Retry bad runtime verification",
      command: "npm run dev",
      permission: { decision: "allowed", reason: "Approved verification command for this run." },
      logs: [
        { at: "2026-06-25T15:10:00.000Z", stream: "system", text: "Verification phase started: npm run dev" }
      ],
      runInstructions: "Run cancelled before completion.",
      completedAt: "2026-06-25T15:10:01.000Z",
      createdAt: "2026-06-25T15:10:00.000Z"
    }, null, 2));

    const retried = await retryRun(root, "run-runtime-verify");
    const { run } = await waitForRun(root, retried.runId, (item) => item.status === "failed");

    expect(run.phase).toBe("complete");
    expect(run.runInstructions).toContain("would start an app/runtime/watch process");
    expect(run.logs.some((line) => line.text.includes("Verification command rejected"))).toBe(true);
  });

  it("reconciles draft nodes as built when managed verification passed before a run smoke failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-built-draft-reconcile-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    const diffArtifact = {
      id: "diff-smoke-failed",
      type: "diff" as const,
      title: "Source diff",
      path: ".archicode/artifacts/run-smoke-failed-source-diff.json",
      runId: "run-smoke-failed",
      summary: "1 changed file",
      sizeBytes: 10,
      createdAt: "2026-06-17T20:18:13.116Z"
    };

    await writeFile(path.join(root, ".archicode", "flows", `${flow.id}.json`), JSON.stringify({
      ...flow,
      nodes: flow.nodes.map((item) => item.id === node.id
        ? {
            ...item,
            stage: "draft",
            flags: ["changed", "has-diff", "modified-not-built", "needs-attention"],
            attachments: [...item.attachments, diffArtifact],
            updatedAt: "2026-06-17T20:19:19.406Z"
          }
        : item),
      updatedAt: "2026-06-17T20:19:19.406Z"
    }, null, 2));
    await writeFile(path.join(root, ".archicode", "runs", "run-smoke-failed.json"), JSON.stringify({
      id: "run-smoke-failed",
      flowId: flow.id,
      nodeId: node.id,
      providerId: "codex-local",
      status: "failed",
      phase: "complete",
      promptSummary: "Build then smoke",
      command: "custom-build --release",
      permission: { decision: "allowed" },
      sourceDiffArtifactIds: [diffArtifact.id],
      affectedNodeIds: [node.id],
      logs: [
        { at: "2026-06-17T20:19:05.365Z", stream: "system", text: "Waiting for approval to verify with: custom-build --release" },
        { at: "2026-06-17T20:19:10.180Z", stream: "system", text: "Command exited with code 0." },
        { at: "2026-06-17T20:19:19.400Z", stream: "stderr", text: "Run smoke exited before readiness with code 1." }
      ],
      runInstructions: "Verification completed with `custom-build --release`. Run smoke exited before readiness with code 1.",
      completedAt: "2026-06-17T20:19:19.402Z",
      createdAt: "2026-06-17T20:03:30.283Z"
    }, null, 2));

    const loaded = await loadProject(root);
    const loadedNode = loaded.flows[0]?.nodes.find((item) => item.id === node.id);
    expect(loadedNode?.stage).toBe("draft");
    expect(loadedNode?.flags).toContain("has-diff");
    expect(loadedNode?.flags).not.toContain("changed");
    expect(loadedNode?.flags).not.toContain("modified-not-built");
    expect(loadedNode?.flags).not.toContain("needs-attention");
  });

  it("clears dirty graph state only inside a successfully verified flow scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-flow-scoped-verification-"));
    const bundle = await ensureFixtureProject(root);
    const mainFlow = bundle.flows[0]!;
    const targetNode = mainFlow.nodes.find((node) => node.stage !== "draft-approved-production" && node.acceptanceChecks.length === 0)!;
    const dirtyFlags = ["changed", "needs-attention", "modified-not-built"];
    await writeFile(path.join(root, ".archicode", "flows", `${mainFlow.id}.json`), JSON.stringify({
      ...mainFlow,
      nodes: mainFlow.nodes.map((node) => node.id === targetNode.id ? { ...node, flags: dirtyFlags } : node)
    }, null, 2));
    await writeFile(path.join(root, ".archicode", "flows", "flow-secondary.json"), JSON.stringify({
      ...mainFlow,
      id: "flow-secondary",
      name: "Secondary flow",
      nodes: mainFlow.nodes.map((node) => ({
        ...node,
        id: `${node.id}-secondary`,
        stage: node.stage === "draft-approved-production" ? node.stage : "draft",
        flags: node.id === targetNode.id ? dirtyFlags : node.flags
      })),
      edges: mainFlow.edges.map((edge) => ({
        ...edge,
        id: `${edge.id}-secondary`,
        source: `${edge.source}-secondary`,
        target: `${edge.target}-secondary`
      }))
    }, null, 2));
    await writeFile(path.join(root, "verify.cjs"), "process.exit(0);\n", "utf8");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node verify.cjs" } }), "utf8");
    const started = await startAgentRun({
      projectRoot: root,
      flowId: mainFlow.id,
      providerId: "openai-compatible",
      promptSummary: "Verify only the main flow",
      command: "npm test",
      allowShell: true,
      scope: { kind: "flow", flowId: mainFlow.id, nodeIds: [], label: "Main flow" }
    });
    const { bundle: loaded } = await waitForRun(root, started.runId, (run) => run.status === "succeeded");
    const mainTarget = loaded.flows.find((flow) => flow.id === mainFlow.id)!.nodes.find((node) => node.id === targetNode.id)!;
    const secondaryTarget = loaded.flows.find((flow) => flow.id === "flow-secondary")!.nodes.find((node) => node.id === `${targetNode.id}-secondary`)!;
    expect(mainTarget.flags).not.toContain("changed");
    expect(mainTarget.flags).not.toContain("modified-not-built");
    expect(secondaryTarget.flags).toContain("changed");
    expect(secondaryTarget.flags).toContain("modified-not-built");
  });

  it("keeps a verified node dirty until its acceptance checks pass, then clears it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-acceptance-check-gate-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    const diffArtifact = {
      id: "diff-checks-gate",
      type: "diff" as const,
      title: "Source diff",
      path: ".archicode/artifacts/run-checks-gate-source-diff.json",
      runId: "run-checks-gate",
      summary: "1 changed file",
      sizeBytes: 10,
      createdAt: "2026-06-17T20:18:13.116Z"
    };

    await writeFile(path.join(root, ".archicode", "flows", `${flow.id}.json`), JSON.stringify({
      ...flow,
      nodes: flow.nodes.map((item) => item.id === node.id
        ? {
            ...item,
            stage: "draft",
            flags: ["changed", "has-diff", "modified-not-built"],
            acceptanceChecks: [
              { id: "check-1", criterion: "Login rejects bad passwords", testCommand: "npm test -- login", status: "failing", updatedAt: "2026-06-17T20:19:19.406Z" }
            ],
            attachments: [...item.attachments, diffArtifact],
            updatedAt: "2026-06-17T20:19:19.406Z"
          }
        : item),
      updatedAt: "2026-06-17T20:19:19.406Z"
    }, null, 2));
    await writeFile(path.join(root, ".archicode", "runs", "run-checks-gate.json"), JSON.stringify({
      id: "run-checks-gate",
      flowId: flow.id,
      nodeId: node.id,
      providerId: "codex-local",
      status: "succeeded",
      phase: "complete",
      promptSummary: "Build the feature",
      command: "custom-build --release",
      permission: { decision: "allowed" },
      sourceDiffArtifactIds: [diffArtifact.id],
      affectedNodeIds: [node.id],
      logs: [
        { at: "2026-06-17T20:19:05.365Z", stream: "system", text: "Waiting for approval to verify with: custom-build --release" },
        { at: "2026-06-17T20:19:10.180Z", stream: "system", text: "Command exited with code 0." }
      ],
      runInstructions: "Verification completed with `custom-build --release`.",
      completedAt: "2026-06-17T20:19:19.402Z",
      createdAt: "2026-06-17T20:03:30.283Z"
    }, null, 2));

    // Build verified, but the acceptance check is still failing → node stays dirty.
    const blocked = await loadProject(root);
    const blockedNode = blocked.flows[0]?.nodes.find((item) => item.id === node.id);
    expect(blockedNode?.flags).toContain("modified-not-built");
    expect(blockedNode?.flags).toContain("changed");

    // Once the check passes, the load-time reconcile clears the node.
    const cleared = await recordAcceptanceCheckResults(root, flow.id, node.id, [
      { id: "check-1", status: "passing", evidence: "login suite green" }
    ], "run-checks-gate");
    const clearedNode = cleared.flows[0]?.nodes.find((item) => item.id === node.id);
    expect(clearedNode?.acceptanceChecks[0]?.status).toBe("passing");
    expect(clearedNode?.flags).not.toContain("modified-not-built");
    expect(clearedNode?.flags).not.toContain("changed");
  });

  it("runs acceptance-check test commands and records pass/fail on a build", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-acceptance-verify-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;

    await writeFile(path.join(root, ".archicode", "flows", `${flow.id}.json`), JSON.stringify({
      ...flow,
      nodes: flow.nodes.map((item) => item.id === node.id
        ? {
            ...item,
            acceptanceChecks: [
              { id: "c-pass", criterion: "green criterion", testCommand: "true", status: "unverified" },
              { id: "c-fail", criterion: "red criterion", testCommand: "false", status: "unverified" }
            ]
          }
        : item)
    }, null, 2));

    const loaded = await loadProject(root);
    // providerId points at no configured provider, so the judge falls back to the raw exit code.
    const run = runSchema.parse({
      id: "run-verify-checks",
      flowId: flow.id,
      nodeId: node.id,
      providerId: "no-such-provider",
      status: "succeeded",
      phase: "complete",
      promptSummary: "Build",
      affectedNodeIds: [node.id],
      permission: { decision: "allowed" },
      createdAt: new Date().toISOString()
    });

    await verifyRunAcceptanceChecks(root, loaded, run);

    const after = await loadProject(root);
    const checks = after.flows[0]?.nodes.find((item) => item.id === node.id)?.acceptanceChecks ?? [];
    expect(checks.find((check) => check.id === "c-pass")?.status).toBe("passing");
    expect(checks.find((check) => check.id === "c-fail")?.status).toBe("failing");
    expect(checks.find((check) => check.id === "c-pass")?.verifiedByRunId).toBe("run-verify-checks");
  });

  it("skips high-risk acceptance checks even when shell auto-approve is enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-acceptance-verify-high-risk-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;

    await writeFile(path.join(root, ".archicode", "flows", `${flow.id}.json`), JSON.stringify({
      ...flow,
      nodes: flow.nodes.map((item) => item.id === node.id
        ? {
            ...item,
            acceptanceChecks: [
              { id: "c-risky", criterion: "risky criterion", testCommand: "git push --force origin main", status: "unverified" }
            ]
          }
        : item)
    }, null, 2));

    const loaded = await loadProject(root);
    const run = runSchema.parse({
      id: "run-verify-risky-checks",
      flowId: flow.id,
      nodeId: node.id,
      providerId: "no-such-provider",
      status: "succeeded",
      phase: "complete",
      promptSummary: "Build",
      affectedNodeIds: [node.id],
      permission: { decision: "allowed" },
      createdAt: new Date().toISOString()
    });

    const logs = await verifyRunAcceptanceChecks(root, loaded, run);

    expect(logs.some((line) => line.text.includes("requires manual shell approval"))).toBe(true);
    const after = await loadProject(root);
    const check = after.flows[0]?.nodes.find((item) => item.id === node.id)?.acceptanceChecks.find((item) => item.id === "c-risky");
    expect(check?.status).toBe("unverified");
    expect(check?.verifiedByRunId).toBeUndefined();
  });

  it("runs a node's acceptance checks on demand and reflects pass/fail on status and flags", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-run-checks-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;

    await writeFile(path.join(root, ".archicode", "flows", `${flow.id}.json`), JSON.stringify({
      ...flow,
      nodes: flow.nodes.map((item) => item.id === node.id
        ? {
            ...item,
            acceptanceChecks: [
              { id: "c-green", criterion: "green", testFilePath: "tests/green.test.ts", testCommand: "true", status: "unverified" },
              { id: "c-red", criterion: "red", testFilePath: "tests/red.test.ts", testCommand: "false", status: "unverified" }
            ]
          }
        : item)
    }, null, 2));

    const result = await runNodeAcceptanceChecks(root, flow.id, node.id);
    expect(result).toMatchObject({ total: 2, passing: 1, failing: 1 });

    const after = result.bundle.flows[0]?.nodes.find((item) => item.id === node.id);
    const checks = after?.acceptanceChecks ?? [];
    expect(checks.find((check) => check.id === "c-green")?.status).toBe("passing");
    expect(checks.find((check) => check.id === "c-red")?.status).toBe("failing");
    // A failing test flags the node for attention.
    expect(after?.flags).toContain("needs-attention");
  });

  it("uses the single available run target as the implied build module when a node stays on Auto", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-auto-module-checks-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;

    await updateProjectSettings(root, {
      ...bundle.project.settings,
      runTargetProfiles: [{
        id: "profile-web",
        label: "Web",
        kind: "node",
        runCommand: "npm run dev",
        testCommand: "true",
        targetRequired: false,
        diagnosticCommands: [],
        recoveryCommands: [],
        retryAfterRecovery: true,
        timeoutSeconds: 90
      }]
    });

    await writeFile(path.join(root, ".archicode", "flows", `${flow.id}.json`), JSON.stringify({
      ...flow,
      nodes: flow.nodes.map((item) => item.id === node.id
        ? {
            ...item,
            moduleProfileMode: "auto",
            moduleProfileId: undefined,
            acceptanceChecks: [
              { id: "c-auto", criterion: "auto profile check", testFilePath: ".archicode/tests/project/auto.test.ts", status: "unverified" }
            ]
          }
        : item)
    }, null, 2));

    const result = await runNodeAcceptanceChecks(root, flow.id, node.id);
    expect(result).toMatchObject({ total: 1, passing: 1, failing: 0 });
    expect(result.bundle.flows[0]?.nodes.find((item) => item.id === node.id)?.acceptanceChecks[0]?.status).toBe("passing");
  });

  it("clears generated acceptance tests for a node while keeping its acceptance criteria", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-clear-checks-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    const nodeSlug = (node.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "node");
    const keptCriterion = "Project still has a human-readable spec";
    const generatedPath = `.archicode/tests/${nodeSlug}/generated.test.ts`;
    const generatedAbsPath = path.join(root, generatedPath);

    await mkdir(path.dirname(generatedAbsPath), { recursive: true });
    await writeFile(generatedAbsPath, "test('generated', () => {})\n", "utf8");
    await writeFile(path.join(root, ".archicode", "flows", `${flow.id}.json`), JSON.stringify({
      ...flow,
      nodes: flow.nodes.map((item) => item.id === node.id
        ? {
            ...item,
            acceptanceCriteria: [keptCriterion],
            acceptanceChecks: [
              { id: "c-generated", criterion: keptCriterion, testFilePath: generatedPath, testCommand: "true", status: "unverified" }
            ]
          }
        : item)
    }, null, 2));

    const updated = await clearNodeAcceptanceTests(root, flow.id, node.id);
    const clearedNode = updated.flows[0]?.nodes.find((item) => item.id === node.id);
    expect(clearedNode?.acceptanceCriteria).toEqual([keptCriterion]);
    expect(clearedNode?.acceptanceChecks).toEqual([]);
    await expect(access(generatedAbsPath)).rejects.toThrow();
  });

  it("abandons stale in-progress runs after app restart so the queue can unblock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-stale-run-reconcile-"));
    const bundle = await ensureFixtureProject(root);
    const flow = bundle.flows[0]!;
    await writeFile(path.join(root, ".archicode", "runs", "run-stale-active.json"), JSON.stringify({
      id: "run-stale-active",
      flowId: flow.id,
      providerId: "codex-local",
      status: "running",
      phase: "coding",
      promptSummary: "Run app profile: Custom Device",
      command: "custom-run --device local",
      permission: { decision: "allowed" },
      logs: [
        { at: "2026-06-18T05:53:28.803Z", stream: "stdout", text: "App started and is streaming logs." }
      ],
      createdAt: "2026-06-18T05:51:00.094Z"
    }, null, 2));

    const loaded = await loadProject(root);
    const run = loaded.runs.find((item) => item.id === "run-stale-active");
    expect(run?.status).toBe("cancelled");
    expect(run?.phase).toBe("complete");
    expect(run?.queueRemovedAt).toBeTruthy();
    expect(run?.completedAt).toBeTruthy();
    expect(run?.runInstructions).toContain("abandoned after app restart");
    expect(run?.logs.some((line) => line.text.includes("without an attached process"))).toBe(true);
  });

  it("resumes stale resumable runs from their persisted phase after app restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-restart-resume-"));
    const providerCommand = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: providerCommand }
        : { ...provider, enabled: false })
    });
    const flow = bundle.flows[0]!;
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(path.join(root, ".archicode", "runs", "run-restart-resume.json"), JSON.stringify({
      id: "run-restart-resume",
      flowId: flow.id,
      providerId: "codex-local",
      status: "planning",
      phase: "planning",
      promptSummary: "Plan a small change",
      permission: { decision: "allowed" },
      logs: [
        { at: staleAt, stream: "system", text: "Planning phase started." }
      ],
      startedAt: staleAt,
      createdAt: staleAt
    }, null, 2));

    const loaded = await loadProject(root);
    const reconciled = loaded.runs.find((item) => item.id === "run-restart-resume");
    expect(reconciled?.status).not.toBe("cancelled");
    expect(reconciled?.logs.some((line) => line.text.includes("Resuming run from its last persisted phase"))).toBe(true);

    // The resumed run is picked up by the queue and completes the full pipeline.
    const { run } = await waitForRun(root, "run-restart-resume", (item) => item.status === "succeeded");
    expect(run.queueRemovedAt).toBeFalsy();
    expect(run.logs.some((line) => line.text.includes("Resuming run from its last persisted phase"))).toBe(true);
  });

  it("persists run logs in an append-only sidecar instead of the run document", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-log-sidecar-"));
    const providerCommand = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: providerCommand }
        : { ...provider, enabled: false })
    });
    const flow = bundle.flows[0]!;
    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: flow.id,
      nodeId: flow.nodes[0]?.id,
      providerId: "codex-local",
      promptSummary: "Plan a small change"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    // Hydrated runs carry full logs; the document on disk stays small with the
    // history living in the JSONL sidecar.
    expect(run.logs.length).toBeGreaterThan(0);
    const document = JSON.parse(await readFile(path.join(root, ".archicode", "runs", `${runId}.json`), "utf8")) as { logs: unknown[] };
    expect(document.logs).toEqual([]);
    const sidecar = await readFile(path.join(root, ".archicode", "runs", `${runId}.log.jsonl`), "utf8");
    const sidecarLines = sidecar.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { text: string });
    expect(sidecarLines.length).toBe(run.logs.length);
    expect(sidecarLines.some((line) => line.text.includes("Run started") || line.text.includes("Planning phase started"))).toBe(true);
  });

  it("runs a target-aware profile through discover, launch, wait, and run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-run-profile-"));
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      runTargetProfiles: [
        {
          id: "generic-target",
          label: "Generic Target",
          kind: "generic",
          discoverCommand: "node -e \"console.log('target-1 \\u2022 Target One \\u2022 Local \\u2022 generic')\"",
          targetPattern: "^\\s*(?<id>\\S+)\\s+\\u2022\\s+(?<label>[^\\u2022]+)\\s+\\u2022\\s+[^\\u2022]+\\s+\\u2022\\s+generic\\s*$",
          targetRequired: true,
          launchCommand: "node -e \"console.log('launch {targetId}')\"",
          waitCommand: "node -e \"console.log('ready {targetId}')\"",
          readyPattern: "{targetId}",
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          runCommand: "node -e \"console.log('run {targetId}')\"",
          timeoutSeconds: 5
        }
      ]
    });

    const { runId } = await startRunProfile({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      profileId: "generic-target",
      allowShell: true
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(run.command).toBe("node -e \"console.log('run target-1')\"");
    expect(run.runTargetId).toBe("target-1");
    expect(run.logs.some((line) => line.text.includes("Selected run target: Target One (target-1)"))).toBe(true);
    expect(run.logs.some((line) => line.text.includes("Run target is ready"))).toBe(true);
    expect(run.logs.some((line) => line.text.includes("run target-1"))).toBe(true);
  });

  it("prefers matching targets and extracts the attached runtime target before running", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-run-profile-runtime-target-"));
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      runTargetProfiles: [
        {
          id: "phone-target",
          label: "Phone Target",
          kind: "generic",
          discoverCommand: "node -e \"console.log('tablet_api \\u2022 Tablet \\u2022 Local \\u2022 generic'); console.log('phone_api \\u2022 Phone \\u2022 Local \\u2022 generic')\"",
          targetPattern: "^\\s*(?<id>\\S+)\\s+\\u2022\\s+(?<label>[^\\u2022]+)\\s+\\u2022\\s+[^\\u2022]+\\s+\\u2022\\s+generic\\s*$",
          targetPreferencePattern: "phone",
          targetRequired: true,
          waitCommand: "node -e \"console.log('Ready Phone (mobile) \\u2022 runtime-1234 \\u2022 generic-arm64 \\u2022 Runtime OS')\"",
          readyPattern: "\\u2022\\s+runtime-\\d+\\s+\\u2022\\s+generic",
          notReadyPattern: "offline",
          readyTargetPattern: "^.*?\\u2022\\s*(?<id>runtime-\\d+)\\s*\\u2022\\s*generic",
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          runCommand: "node -e \"console.log('run {runTargetId} from {targetId}')\"",
          timeoutSeconds: 5
        }
      ]
    });

    const { runId } = await startRunProfile({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      profileId: "phone-target",
      allowShell: true
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(run.command).toBe("node -e \"console.log('run runtime-1234 from phone_api')\"");
    expect(run.runTargetId).toBe("runtime-1234");
    expect(run.logs.some((line) => line.text.includes("Selected run target: Phone (phone_api)"))).toBe(true);
  });

  it("runs profile diagnostics and recovery before failing target readiness", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-run-profile-recovery-"));
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      runTargetProfiles: [
        {
          id: "recoverable-target",
          label: "Recoverable Target",
          kind: "generic",
          discoverCommand: "node -e \"console.log('target-1 \\u2022 Target One \\u2022 Local \\u2022 generic')\"",
          targetPattern: "^\\s*(?<id>\\S+)\\s+\\u2022\\s+(?<label>[^\\u2022]+)\\s+\\u2022\\s+[^\\u2022]+\\s+\\u2022\\s+generic\\s*$",
          targetRequired: true,
          waitCommand: "node -e \"const fs=require('fs'); console.log(fs.existsSync('ready.txt') ? 'ready target-1' : 'target-1 is offline')\"",
          readyPattern: "target-1",
          notReadyPattern: "offline",
          diagnosticCommands: ["node -e \"console.log('diagnose target')\""],
          recoveryCommands: ["node -e \"require('fs').writeFileSync('ready.txt','1')\""],
          retryAfterRecovery: true,
          runCommand: "node -e \"console.log('run {targetId}')\"",
          timeoutSeconds: 1
        }
      ]
    });

    const { runId } = await startRunProfile({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      profileId: "recoverable-target",
      allowShell: true
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(run.logs.some((line) => line.text.includes("Run target was not ready. Collecting diagnostics."))).toBe(true);
    expect(run.logs.some((line) => line.text.includes("Attempting run target recovery."))).toBe(true);
    expect(run.logs.some((line) => line.text.includes("Run target is ready"))).toBe(true);
    expect(run.logs.some((line) => line.text.includes("run target-1"))).toBe(true);
  });

  it("continues into coding without provider-launch approval for full-access Codex Local", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-code-danger-permission-"));
    const command = await createFakeCodex(root);
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command, localSandbox: "danger-full-access" }
        : { ...provider, enabled: false }),
      stopOnUnansweredQuestions: false
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Code without a full-access provider launch approval"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(run.permission.decision).toBe("allowed");
    expect(run.permission.reason).toContain("full access");
  });
});
