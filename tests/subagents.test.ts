import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFixtureProject, updateNode, updateProjectSettings } from "../src/main/storage/projectStore";
import { respondToSubagentRun, sendResearchChatMessage } from "../src/main/research";
import { createResearchChat, setResearchStorageRoot } from "../src/main/research/chatStore";

const execAsync = promisify(exec);

// SSE mock for an Anthropic Messages turn with text and/or tool_use blocks,
// mirroring the helper used in tests/research-chat.test.ts.
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function streamingAnthropicResponse(
  parts: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }>
): Response {
  const chunks: string[] = [];
  parts.forEach((part, index) => {
    if (part.type === "text") {
      chunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } })}\n\n`);
      chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: part.text } })}\n\n`);
    } else {
      chunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "tool_use", id: part.id, name: part.name, input: {} } })}\n\n`);
      chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(part.input) } })}\n\n`);
    }
    chunks.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`);
  });
  chunks.push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } })}\n\n`);
  chunks.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  return sseResponse(chunks);
}

function mergeResolutionOutputText(overrides: Partial<{ summary: string; verificationPassed: boolean; resolvedFiles: string[] }> = {}): string {
  return JSON.stringify({
    resolvedFiles: overrides.resolvedFiles ?? ["src/shared.ts"],
    verificationPassed: overrides.verificationPassed ?? true,
    verificationOutput: "tests passed",
    summary: overrides.summary ?? "Combined both sides of the conflict.",
    finalCheck: { syntaxValid: true, testsPassed: true, lintPassed: true, typecheckPassed: true, issues: [] }
  });
}

async function createRealMergeConflict(projectRoot: string, fileName: string): Promise<void> {
  await execAsync("git init -q", { cwd: projectRoot });
  await execAsync("git config user.email test@example.com", { cwd: projectRoot });
  await execAsync("git config user.name Test", { cwd: projectRoot });
  await writeFile(path.join(projectRoot, fileName), "base\n", "utf8");
  await execAsync(`git add ${fileName} && git commit -q -m base`, { cwd: projectRoot });
  await execAsync("git checkout -q -b feature", { cwd: projectRoot });
  await writeFile(path.join(projectRoot, fileName), "feature change\n", "utf8");
  await execAsync("git commit -q -am feature", { cwd: projectRoot });
  await execAsync("git checkout -q main || git checkout -q master", { cwd: projectRoot });
  await writeFile(path.join(projectRoot, fileName), "main change\n", "utf8");
  await execAsync("git commit -q -am main-change", { cwd: projectRoot });
  await execAsync("git merge feature", { cwd: projectRoot }).catch(() => undefined);
}

function graphReconciliationOutputText(withChangeSet = true): string {
  return JSON.stringify({
    graphChangeSet: withChangeSet ? {
      summary: "Update node to reflect merged behavior",
      operations: [{ kind: "update-node", flowId: "flow-main", patch: { id: "node-fixture-1", description: "Updated via reconciliation" } }]
    } : null,
    nodesAffected: withChangeSet ? ["node-fixture-1"] : [],
    reconciliationReport: withChangeSet ? "Checked resolved files against graph nodes; one node drifted." : "No discrepancies found.",
    discrepancies: []
  });
}

async function setupSubagentProject(subagents?: Partial<{ mergeConflictResolution: boolean; graphReconciliation: boolean; sherlockResearch: boolean; delphiTesting: boolean }>) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-subagents-project-"));
  setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), "archicode-subagents-storage-")));
  const bundle = await ensureFixtureProject(projectRoot);
  process.env.ANTHROPIC_SUBAGENT_TEST_KEY = "test";
  await updateProjectSettings(projectRoot, {
    ...bundle.project.settings,
    webSearch: { ...bundle.project.settings.webSearch, enabled: false },
    agentTools: {
      ...bundle.project.settings.agentTools,
      ...(subagents ? {
        subagents: {
          mergeConflictResolution: subagents.mergeConflictResolution ?? true,
          graphReconciliation: subagents.graphReconciliation ?? true,
          sherlockResearch: subagents.sherlockResearch ?? true,
          delphiTesting: subagents.delphiTesting ?? true
        }
      } : {})
    },
    providers: bundle.project.settings.providers.map((provider) => provider.kind === "anthropic-compatible"
      ? { ...provider, enabled: true, apiKeyEnv: "ANTHROPIC_SUBAGENT_TEST_KEY" }
      : { ...provider, enabled: false })
  });
  const session = await createResearchChat({ projectRoot, scope: { type: "flow", flowId: "flow-main" } });
  return { projectRoot, session };
}

async function markSharedFileAsGraphBacked(projectRoot: string): Promise<void> {
  await updateNode(projectRoot, "flow-main", {
    id: "node-project",
    acceptanceCriteria: ["Project reloads from readable JSON", "src/shared.ts behavior is represented in this node"]
  }, "llm");
}

function toolNames(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): string[] {
  const body = JSON.parse(fetchMock.mock.calls[callIndex]![1]!.body as string) as { tools?: Array<{ name?: string }> };
  return (body.tools ?? []).map((tool) => tool.name ?? "");
}

/** Drives an initial chat turn where the model requests merge resolution, leaving it awaiting approval. */
async function createAwaitingApprovalRun(
  projectRoot: string,
  sessionId: string,
  fetchMock: ReturnType<typeof vi.fn>,
  conflictedFiles: string[] = ["src/shared.ts"]
) {
  fetchMock
    .mockResolvedValueOnce(streamingAnthropicResponse([{
      type: "tool_use",
      id: "tu-spawn-merge",
      name: "archicode_spawn_merge_resolution_agent",
      input: { conflictedFiles, resolutionStrategy: "prefer main branch" }
    }]))
    .mockResolvedValueOnce(streamingAnthropicResponse([{ type: "text", text: "I've prepared a merge-resolution proposal for your review." }]));
  const session = await sendResearchChatMessage({ projectRoot, sessionId, content: "Resolve the merge conflicts" });
  const message = session.messages.find((item) => item.subagentRuns?.length);
  const run = message?.subagentRuns[0];
  if (!message || !run) throw new Error("Expected an awaiting-approval subagent run to be created.");
  return { session, message, run };
}

describe("Research chat subagent tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("advertises all subagent tools by default", async () => {
    const { projectRoot, session } = await setupSubagentProject();
    const fetchMock = vi.fn().mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "No conflicts to resolve." }]));
    vi.stubGlobal("fetch", fetchMock);

    await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Any merge conflicts?" });

    const names = toolNames(fetchMock, 0);
    expect(names).toContain("archicode_spawn_merge_resolution_agent");
    expect(names).toContain("archicode_spawn_picasso");
    expect(names).toContain("archicode_spawn_sherlock");
    expect(names).toContain("archicode_spawn_delphi");
  });

  it("runs Sherlock inline and stores only a compact activity summary in chat", async () => {
    const { projectRoot, session } = await setupSubagentProject();
    const activities: string[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-sherlock",
        name: "archicode_spawn_sherlock",
        input: { objective: "Find where project settings are validated", mode: "codebase" }
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-sherlock-cli",
        name: "archicode_console_run_command",
        input: { command: "pwd" }
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-sherlock-search",
        name: "archicode_project_search_files",
        input: { path: "src", query: "settings" }
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{ type: "text", text: JSON.stringify({
        summary: "Settings are validated in the shared schema.",
        findings: [{ title: "Schema owner", detail: "The shared schema parses settings.", confidence: "high", evidence: [{ source: "project", reference: "src/shared/schema.ts" }] }],
        sources: [{ label: "schema", reference: "src/shared/schema.ts", sourceType: "project-file" }],
        openQuestions: [],
        recommendedNextSteps: []
      }) }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "Sherlock found the settings schema owner." }]));
    vi.stubGlobal("fetch", fetchMock);

    const updated = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Investigate settings validation deeply",
      onActivity: (message) => activities.push(message)
    });
    const run = updated.messages.flatMap((message) => message.subagentRuns).find((item) => item.kind === "sherlock-research");

    expect(run).toMatchObject({ status: "completed", kind: "sherlock-research" });
    expect(run?.resultSummary).toContain("Settings are validated");
    expect(run?.resultSummary).not.toContain("src/shared/schema.ts");
    expect(run?.progress.some((message) => message.includes("Running guarded investigation command: pwd"))).toBe(true);
    expect(activities).toContain("Sherlock completed. Archi is reviewing the evidence and continuing the investigation below.");
    expect(activities.at(-1)).toContain("preparing the final answer");
  });

  it("creates an approval-gated Delphi audit without executing it inline", async () => {
    const { projectRoot, session } = await setupSubagentProject();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-delphi",
        name: "archicode_spawn_delphi",
        input: { objective: "Audit the checkout flow", mode: "audit", platforms: ["web"], commands: ["npm run test:e2e"] }
      }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "Delphi's audit is ready for approval." }]));
    vi.stubGlobal("fetch", fetchMock);

    const updated = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Have Delphi audit checkout"
    });
    const run = updated.messages.flatMap((message) => message.subagentRuns).find((item) => item.kind === "delphi-testing");

    expect(run).toMatchObject({ kind: "delphi-testing", status: "awaiting-approval" });
    expect(["supported", "unsupported", "unknown"]).toContain(run?.imageInputSupport);
    expect(JSON.parse(run!.argumentsJson)).toMatchObject({ mode: "setup", commands: ["npm run test:e2e"] });
    expect(run?.reviewReason).toContain("No project script/check was discovered");
    // Parent suggestions remain context for Delphi, not a command authorization
    // list shown as if the user were approving an exact execution script.
    expect(run?.reviewReason).not.toContain("npm run test:e2e");
    expect(fetchMock.mock.calls.every((call) => !String(call[1]?.body ?? "").includes("You are Delphi"))).toBe(true);
  });

  it("lists an exact Run App lifecycle in Delphi's approval card without launching it", async () => {
    const { projectRoot, session } = await setupSubagentProject();
    const bundle = await ensureFixtureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      runTargetProfiles: [{
        id: "desktop-audit",
        label: "Desktop Audit",
        kind: "electron",
        runCommand: "node -e \"require('fs').writeFileSync('research-delphi-launched.txt','yes'); setInterval(() => {}, 1000)\"",
        stopCommand: "node -e \"console.log('stop desktop audit')\"",
        targetRequired: false,
        diagnosticCommands: [],
        recoveryCommands: [],
        retryAfterRecovery: true,
        timeoutSeconds: 5
      }]
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-delphi-runtime",
        name: "archicode_spawn_delphi",
        input: {
          objective: "Audit the desktop app",
          mode: "audit",
          platforms: ["electron"],
          target: { profileId: "desktop-audit", launch: "if-needed", cleanup: "stop-if-started" }
        }
      }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "Delphi's runtime audit is ready for approval." }]));
    vi.stubGlobal("fetch", fetchMock);

    const updated = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Start and audit the desktop app" });
    const run = updated.messages.flatMap((message) => message.subagentRuns).find((item) => item.kind === "delphi-testing");

    expect(run).toMatchObject({ status: "awaiting-approval", kind: "delphi-testing" });
    expect(run?.reviewReason).toContain("Desktop Audit");
    expect(run?.reviewReason).toContain("research-delphi-launched.txt");
    expect(run?.reviewReason).toContain("stop desktop audit");
    await expect(access(path.join(projectRoot, "research-delphi-launched.txt"))).rejects.toThrow();
  });

  it("runs an approved Delphi audit through the guarded command path", async () => {
    const { projectRoot, session } = await setupSubagentProject();
    const configured = await ensureFixtureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...configured.project.settings,
      autoApproveShellCommands: false
    });
    await writeFile(path.join(projectRoot, "delphi-research-check.cjs"), "console.log('delphi-research-ok');\n", "utf8");
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "delphi-research-fixture",
      private: true,
      scripts: { "test:delphi": "node delphi-research-check.cjs" }
    }), "utf8");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-delphi-approved",
        name: "archicode_spawn_delphi",
        input: { objective: "Run the Delphi research fixture", mode: "audit", platforms: ["generic"] }
      }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "Delphi's audit is ready for approval." }]));
    vi.stubGlobal("fetch", fetchMock);
    const proposed = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Audit the fixture" });
    const message = proposed.messages.find((item) => item.subagentRuns.some((run) => run.kind === "delphi-testing"));
    const run = message?.subagentRuns.find((item) => item.kind === "delphi-testing");
    if (!message || !run) throw new Error("Expected Delphi approval card.");
    expect(JSON.parse(run.argumentsJson)).toMatchObject({ commands: [] });
    expect(run.reviewReason).toContain("1 discovered script/check option");

    fetchMock.mockReset()
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-delphi-inspect",
        name: "delphi_inspect_test_environment",
        input: {}
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-delphi-run",
        name: "archicode_console_run_command",
        input: { command: "npm run test:delphi" }
      }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: JSON.stringify({
        status: "completed",
        verdict: "passed",
        summary: "The approved Delphi research fixture passed.",
        attempts: 1,
        checks: [{ name: "Research fixture", status: "passed", command: "npm run test:delphi", outputSummary: "delphi-research-ok", evidence: ["exit code 0"] }],
        findings: [],
        toolchains: [{ adapter: "generic", status: "ready", evidence: ["Finite project test detected."] }],
        artifacts: [],
        blockers: [],
        recommendedNextSteps: []
      }) }]));

    const completed = await respondToSubagentRun({
      projectRoot,
      sessionId: session.id,
      messageId: message.id,
      runId: run.id,
      decision: "approved"
    });
    const completedRun = completed.messages.flatMap((item) => item.subagentRuns).find((item) => item.id === run.id);

    expect(completedRun).toMatchObject({ kind: "delphi-testing", status: "completed" });
    expect(completedRun?.resultSummary).toContain("Verdict: passed");
    expect(completed.messages.at(-1)?.content).toContain("Delphi finished with verdict: passed");
  });

  it("preflights missing Playwright into one managed-cache setup-and-audit card", async () => {
    const { projectRoot, session } = await setupSubagentProject();
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "web-without-playwright", private: true }), "utf8");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-delphi-web-setup",
        name: "archicode_spawn_delphi",
        input: {
          objective: "Audit the checkout page",
          mode: "audit",
          platforms: ["web"],
          target: { baseUrl: "http://127.0.0.1:4173" }
        }
      }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "The web audit is ready for approval." }]));
    vi.stubGlobal("fetch", fetchMock);
    const proposed = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Audit checkout" });
    const message = proposed.messages.find((item) => item.subagentRuns.some((run) => run.kind === "delphi-testing"));
    const run = message?.subagentRuns.find((item) => item.kind === "delphi-testing");
    if (!message || !run) throw new Error("Expected Delphi approval card.");

    expect(run).toMatchObject({ status: "awaiting-approval", kind: "delphi-testing" });
    expect(JSON.parse(run.argumentsJson)).toMatchObject({
      mode: "setup",
      observation: { mode: "visible", capture: "key-steps" },
      setup: { adapters: ["playwright"], playwrightBrowsers: ["chromium"], resumeMode: "audit" }
    });
    expect(run.reviewReason).toContain("managed cache");
    expect(run.reviewReason).toContain("automatically resumes this same audit");
    expect(fetchMock.mock.calls.every((call) => !String(call[1]?.body ?? "").includes("You are Delphi"))).toBe(true);
  });

  it("runs Picasso inline and captures its proposal in the normal review card", async () => {
    const { projectRoot, session } = await setupSubagentProject();
    const activities: string[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-picasso",
        name: "archicode_spawn_picasso",
        input: { objective: "Refine the project node description", mode: "refine", scope: { flowId: "flow-main", nodeIds: ["node-project"] } }
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-picasso-read",
        name: "picasso_read_graph",
        input: {}
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-picasso-propose",
        name: "propose_graph_change_set",
        input: {
          summary: "Refine project node",
          operations: [{ kind: "update-node", flowId: "flow-main", patch: { id: "node-project", description: "Refined by Picasso" } }]
        }
      }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "Picasso prepared one graph update for review." }]));
    vi.stubGlobal("fetch", fetchMock);

    const updated = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Use Picasso to refine the project node",
      onActivity: (message) => activities.push(message)
    });
    const assistant = updated.messages.find((message) => message.changeSet?.summary === "Refine project node");

    expect(assistant?.subagentRuns[0]).toMatchObject({ kind: "graph-reconciliation", status: "completed" });
    expect(assistant?.changeSet?.reviewedAt).toBeFalsy();
    expect(activities).toContain("Picasso completed. Archi is reviewing the graph proposal and preparing the response below.");
  });

  it("carries a confirmed substantial graph scope through memory and Picasso into a review card", async () => {
    const { projectRoot, session } = await setupSubagentProject();
    const pendingTodoId = "todo-rifqa-graph-draft";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicResponse([
        {
          type: "text",
          text: "I would derive six product flows and their nodes from the specification. Should I prepare this exact scope as the graph review card?"
        },
        {
          type: "tool_use",
          id: "tu-memory-pending-graph",
          name: "archicode_update_memory",
          input: {
            summary: "A six-flow specification-derived graph draft is awaiting scope confirmation.",
            todos: [{ id: pendingTodoId, title: "Prepare the six-flow graph draft", status: "awaiting-approval", notes: "Waiting for scope confirmation." }],
            openQuestions: [{ question: "Should the proposed six-flow scope be prepared as a review card?", status: "open" }]
          }
        }
      ]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-picasso-confirmed-scope",
        name: "archicode_spawn_picasso",
        input: { objective: "Create the confirmed six-flow specification-derived graph draft with its coordinated nodes and detail subflows.", mode: "design" }
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-picasso-read-confirmed-scope",
        name: "picasso_read_graph",
        input: {}
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-picasso-propose-confirmed",
        name: "propose_graph_change_set",
        input: {
          summary: "Create the first specification-derived product flow",
          operations: [{
            kind: "create-flow",
            flow: {
              id: "flow-platform-foundation",
              name: "Platform Foundation",
              description: "Platform Foundation defines the cross-cutting capabilities shared by every confirmed product flow, including identity, persistence, integrations, and operational safeguards. It keeps those platform responsibilities explicit while documenting the stable contracts consumed by the user-facing experiences.",
              ignored: false,
              nodes: [],
              edges: [],
              subflows: [],
              groups: [],
              updatedAt: ""
            }
          }]
        }
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([
        { type: "text", text: "Picasso prepared the confirmed graph proposal for review." },
        {
          type: "tool_use",
          id: "tu-memory-review-ready",
          name: "archicode_update_memory",
          input: {
            summary: "Picasso prepared the confirmed specification-derived graph draft; its review card is awaiting user approval.",
            todos: [{ id: pendingTodoId, title: "Prepare the six-flow graph draft", status: "awaiting-approval", notes: "Review card is ready for user approval." }]
          }
        }
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const scoped = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "Create a first draft from this specification with six flows and many coordinated nodes."
    });
    expect(scoped.messages.some((message) => Boolean(message.changeSet))).toBe(false);
    expect(scoped.memory.summary).toContain("awaiting scope confirmation");

    const confirmed = await sendResearchChatMessage({
      projectRoot,
      sessionId: session.id,
      content: "نعم، تابع"
    });
    const reviewMessage = confirmed.messages.find((message) => message.changeSet?.summary === "Create the first specification-derived product flow");

    expect(reviewMessage?.subagentRuns[0]).toMatchObject({ kind: "graph-reconciliation", status: "completed" });
    expect(reviewMessage?.changeSet?.operations).toHaveLength(1);
    expect(confirmed.memory.summary).toContain("review card is awaiting user approval");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("does not advertise disabled mutation/testing subagent tools", async () => {
    const { projectRoot, session } = await setupSubagentProject({ mergeConflictResolution: false, graphReconciliation: false, delphiTesting: false });
    const fetchMock = vi.fn().mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "No conflicts to resolve." }]));
    vi.stubGlobal("fetch", fetchMock);

    await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Any merge conflicts?" });

    const names = toolNames(fetchMock, 0);
    expect(names).not.toContain("archicode_spawn_merge_resolution_agent");
    expect(names).not.toContain("archicode_spawn_picasso");
    expect(names).not.toContain("archicode_spawn_delphi");
  });

  it("keeps manual graph reconciliation available even when merge-conflict resolution is disabled", async () => {
    const { projectRoot, session } = await setupSubagentProject({ mergeConflictResolution: false, graphReconciliation: true });
    const fetchMock = vi.fn().mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "ok" }]));
    vi.stubGlobal("fetch", fetchMock);

    await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "hi" });

    const names = toolNames(fetchMock, 0);
    expect(names).not.toContain("archicode_spawn_merge_resolution_agent");
    expect(names).toContain("archicode_spawn_picasso");
  });

  it("advertises merge resolution but not reconciliation when reconciliation is explicitly turned off", async () => {
    const { projectRoot, session } = await setupSubagentProject({ mergeConflictResolution: true, graphReconciliation: false });
    const fetchMock = vi.fn().mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "ok" }]));
    vi.stubGlobal("fetch", fetchMock);

    await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "hi" });

    const names = toolNames(fetchMock, 0);
    expect(names).toContain("archicode_spawn_merge_resolution_agent");
    expect(names).not.toContain("archicode_spawn_picasso");
  });

  it("creates an awaiting-approval activity card instead of running merge resolution inline", async () => {
    const { projectRoot, session } = await setupSubagentProject({ mergeConflictResolution: true, graphReconciliation: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { message, run } = await createAwaitingApprovalRun(projectRoot, session.id, fetchMock);

    expect(run).toMatchObject({
      kind: "merge-resolution",
      status: "awaiting-approval",
      proposedResolutionStrategy: "prefer main branch"
    });
    expect(message.content).toContain("prepared a merge-resolution proposal");
    // No merge-resolution/reconciliation microrun call happened yet — only the
    // outer turn (tool_use + final text) and its trailing memory-delta request.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
    expect(run.progress).toEqual([]);
    expect(run.resultSummary).toBeUndefined();
  });

  it("approving merge resolution asks before graph reconciliation when graph drift is plausible", async () => {
    const { projectRoot, session } = await setupSubagentProject({ mergeConflictResolution: true, graphReconciliation: true });
    await markSharedFileAsGraphBacked(projectRoot);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { message, run } = await createAwaitingApprovalRun(projectRoot, session.id, fetchMock);

    fetchMock
      .mockResolvedValueOnce(streamingAnthropicResponse([{ type: "text", text: mergeResolutionOutputText() }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "{}" }]));

    const updated = await respondToSubagentRun({
      projectRoot,
      sessionId: session.id,
      messageId: message.id,
      runId: run.id,
      decision: "approved"
    });

    // Only the merge-resolution microrun ran; graph reconciliation is now an
    // explicit follow-up decision because graph drift was detected.
    const updatedMessage = updated.messages.find((item) => item.id === message.id);
    expect(updatedMessage?.subagentRuns).toHaveLength(2);
    const mergeRun = updatedMessage?.subagentRuns.find((item) => item.kind === "merge-resolution");
    const reconciliationRun = updatedMessage?.subagentRuns.find((item) => item.kind === "graph-reconciliation");
    expect(mergeRun?.status).toBe("completed");
    expect(mergeRun?.resultSummary).toContain("Combined both sides");
    expect(reconciliationRun?.status).toBe("awaiting-approval");
    expect(reconciliationRun?.reviewReason).toContain("src/shared.ts");
    expect(updatedMessage?.changeSet).toBeUndefined();
    const report = updated.messages.find((item) => item.role === "assistant" && item.content.includes("Possible graph drift detected"));
    expect(report?.content).toContain("approval instead of running it automatically");
  });

  it("approving a graph reconciliation proposal runs it and captures its change set", async () => {
    const { projectRoot, session } = await setupSubagentProject({ mergeConflictResolution: true, graphReconciliation: true });
    await markSharedFileAsGraphBacked(projectRoot);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { message, run } = await createAwaitingApprovalRun(projectRoot, session.id, fetchMock);
    fetchMock
      .mockResolvedValueOnce(streamingAnthropicResponse([{ type: "text", text: mergeResolutionOutputText() }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-picasso-read-after-merge",
        name: "picasso_read_graph",
        input: {}
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{ type: "text", text: graphReconciliationOutputText() }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "{}" }]));

    const afterMerge = await respondToSubagentRun({
      projectRoot,
      sessionId: session.id,
      messageId: message.id,
      runId: run.id,
      decision: "approved"
    });
    const updatedMessage = afterMerge.messages.find((item) => item.id === message.id);
    const reconciliationRun = updatedMessage?.subagentRuns.find((item) => item.kind === "graph-reconciliation");
    expect(reconciliationRun?.status).toBe("awaiting-approval");

    const afterReconciliation = await respondToSubagentRun({
      projectRoot,
      sessionId: session.id,
      messageId: message.id,
      runId: reconciliationRun!.id,
      decision: "approved"
    });

    const finalMessage = afterReconciliation.messages.find((item) => item.id === message.id);
    const finalReconciliationRun = finalMessage?.subagentRuns.find((item) => item.kind === "graph-reconciliation");
    expect(finalReconciliationRun?.status).toBe("completed");
    expect(finalMessage?.changeSet?.summary).toBe("Update node to reflect merged behavior");
    expect(finalMessage?.changeSet?.reviewedAt).toBeFalsy();
    const report = afterReconciliation.messages.find((item) => item.role === "assistant" && item.content.includes("Graph reconciliation finished"));
    expect(report?.content).toContain("proposed 1 graph update");
  });

  it("rejecting a pending run never executes it and posts an acknowledgement instead", async () => {
    const { projectRoot, session } = await setupSubagentProject({ mergeConflictResolution: true, graphReconciliation: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { message, run } = await createAwaitingApprovalRun(projectRoot, session.id, fetchMock);

    const callsBeforeRespond = fetchMock.mock.calls.length;

    const updated = await respondToSubagentRun({
      projectRoot,
      sessionId: session.id,
      messageId: message.id,
      runId: run.id,
      decision: "rejected"
    });

    // Rejecting never spawns a merge-resolution/reconciliation microrun call or
    // a model-generated acknowledgement; the app writes a deterministic report.
    expect(fetchMock.mock.calls.length - callsBeforeRespond).toBe(0);
    const updatedMessage = updated.messages.find((item) => item.id === message.id);
    expect(updatedMessage?.subagentRuns[0]?.status).toBe("rejected");
    const acknowledgement = updated.messages.find((item) => item.role === "assistant" && item.content.includes("I did not run that subagent"));
    expect(acknowledgement).toBeDefined();
  });

  it("surfaces unresolved clarification questions from an approved run instead of inventing an answer", async () => {
    const { projectRoot, session } = await setupSubagentProject({ mergeConflictResolution: true, graphReconciliation: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { message, run } = await createAwaitingApprovalRun(projectRoot, session.id, fetchMock);

    fetchMock
      // Inner subagent asks a clarifying question first...
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-clarify",
        name: "ask_clarification",
        input: { question: "Should the config default to strict mode?" }
      }]))
      // ...then reports its final result after proceeding on its own judgment.
      .mockResolvedValueOnce(streamingAnthropicResponse([{ type: "text", text: mergeResolutionOutputText({ summary: "Kept strict mode enabled by default." }) }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{ type: "text", text: "Resolved, but flagged an assumption for you." }]));

    const updated = await respondToSubagentRun({
      projectRoot,
      sessionId: session.id,
      messageId: message.id,
      runId: run.id,
      decision: "approved"
    });

    const updatedMessage = updated.messages.find((item) => item.id === message.id);
    const mergeRun = updatedMessage?.subagentRuns.find((item) => item.kind === "merge-resolution");
    expect(mergeRun?.resultSummary).toContain("Proceeded without clarification");
    expect(mergeRun?.resultSummary).toContain("strict mode");
  });

  it("standalone graph reconciliation (outside a merge-conflict flow) still runs inline and captures its change set", async () => {
    const { projectRoot, session } = await setupSubagentProject({ mergeConflictResolution: true, graphReconciliation: true });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-spawn-reconcile",
        name: "archicode_spawn_picasso",
        input: {
          objective: "Reconcile the graph after the merged source changes.",
          mode: "reconcile",
          resolvedFiles: ["src/shared.ts"],
          resolutionSummary: "Combined both sides of the conflict.",
          verificationResult: "tests passed"
        }
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-picasso-read-standalone",
        name: "picasso_read_graph",
        input: {}
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{ type: "text", text: graphReconciliationOutputText() }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "Reconciliation complete; one node needs review." }]));
    vi.stubGlobal("fetch", fetchMock);

    const updated = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Reconcile the graph after that merge" });

    const assistant = updated.messages.find((message) => message.role === "assistant" && Boolean(message.changeSet));
    expect(assistant).toBeDefined();
    expect(assistant?.subagentRuns[0]).toMatchObject({ kind: "graph-reconciliation", status: "completed" });
    expect(assistant?.changeSet?.summary).toBe("Update node to reflect merged behavior");
    expect(assistant?.changeSet?.operations[0]).toMatchObject({ kind: "update-node", flowId: "flow-main" });
    expect(assistant?.changeSet?.reviewedAt).toBeFalsy();
    // The activity card shows a human summary, not a raw JSON dump of the output.
    expect(assistant?.subagentRuns[0]?.resultSummary).toContain("review the change-set card below");
    expect(assistant?.subagentRuns[0]?.resultSummary).not.toContain("\"graphChangeSet\"");
  });

  it("does not claim a review card exists when Picasso fails validation", async () => {
    const { projectRoot, session } = await setupSubagentProject({ graphReconciliation: true });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-spawn-invalid-picasso",
        name: "archicode_spawn_picasso",
        input: { objective: "Create a detail subflow", mode: "design", scope: { flowId: "flow-main", nodeIds: ["node-project"] } }
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-picasso-read-invalid",
        name: "picasso_read_graph",
        input: {}
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{ type: "text", text: JSON.stringify({
        graphChangeSet: {
          summary: "Invalid proposal",
          operations: [{ kind: "create-node", flowId: "flow-main", node: { id: "node-invalid" } }]
        },
        nodesAffected: [],
        designReport: "The review card is ready.",
        assumptions: [],
        validationChecks: [],
        openQuestions: []
      }) }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{ type: "text", text: "The proposal still does not satisfy the required operation schema." }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "Picasso finished and the review card is ready. Click Apply." }]));
    vi.stubGlobal("fetch", fetchMock);

    const updated = await sendResearchChatMessage({ projectRoot, sessionId: session.id, content: "Use Picasso for a detail subflow" });
    const assistant = [...updated.messages].reverse().find((message) => message.role === "assistant");

    expect(assistant?.subagentRuns[0]).toMatchObject({ kind: "graph-reconciliation", status: "failed" });
    expect(assistant?.changeSet).toBeUndefined();
    expect(assistant?.content).toContain("no review card was created");
    expect(assistant?.content).toContain("Nothing was applied");
    expect(assistant?.content).not.toContain("Click Apply");
  });

  it("commits the resolution as the final step of a successful, verified approval", async () => {
    const { projectRoot, session } = await setupSubagentProject({ mergeConflictResolution: true, graphReconciliation: false });
    await createRealMergeConflict(projectRoot, "shared.txt");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { message, run } = await createAwaitingApprovalRun(projectRoot, session.id, fetchMock, ["shared.txt"]);

    fetchMock
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-detect-stack",
        name: "detect_tech_stack",
        input: {}
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-read-conflict",
        name: "read_conflicted_file",
        input: { filePath: "shared.txt" }
      }]))
      // Inner subagent actually resolves the conflict marker in the real file.
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-write-resolved",
        name: "write_conflicted_file",
        input: { filePath: "shared.txt", content: "resolved\n", resolutionExplanation: "kept main branch version" }
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{
        type: "tool_use",
        id: "tu-final-status",
        name: "run_git_status",
        input: {}
      }]))
      .mockResolvedValueOnce(streamingAnthropicResponse([{ type: "text", text: mergeResolutionOutputText({ resolvedFiles: ["shared.txt"] }) }]))
      .mockResolvedValue(streamingAnthropicResponse([{ type: "text", text: "Merge is fully finished." }]));

    const updated = await respondToSubagentRun({
      projectRoot,
      sessionId: session.id,
      messageId: message.id,
      runId: run.id,
      decision: "approved"
    });

    const { stdout: logOutput } = await execAsync("git log --oneline -1", { cwd: projectRoot });
    expect(logOutput).toContain("Resolve merge conflict in shared.txt");
    const { stdout: statusOutput } = await execAsync("git status --porcelain shared.txt", { cwd: projectRoot });
    expect(statusOutput.trim()).toBe("");
    const mergeHeadCheck = await execAsync("git rev-parse -q --verify MERGE_HEAD", { cwd: projectRoot }).catch((error) => error);
    expect(mergeHeadCheck).toHaveProperty("code");

    const updatedMessage = updated.messages.find((item) => item.id === message.id);
    const mergeRun = updatedMessage?.subagentRuns.find((item) => item.kind === "merge-resolution");
    expect(mergeRun?.resultSummary).toContain("Committed the resolution.");
  });
});
