import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFixtureProject, loadProject, updateProjectSettings } from "../src/main/storage/projectStore";
import { approveRun, startAgentRun } from "../src/main/storage/runEngine";
import type { Run } from "../src/shared/schema";

async function waitForRun(root: string, runId: string, predicate: (run: Run) => boolean): Promise<Run> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const run = (await loadProject(root)).runs.find((item) => item.id === runId);
    if (run && predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const run = (await loadProject(root)).runs.find((item) => item.id === runId);
  throw new Error(`Timed out waiting for Delphi setup approval. Last status: ${run?.status ?? "missing"}`);
}

function openAiChatSse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function openAiChatTextSse(content: string): Response {
  return openAiChatSse([
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    "data: [DONE]\n\n"
  ]);
}

function openAiChatToolSse(id: string, name: string, argumentsJson = "{}"): Response {
  return openAiChatSse([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: argumentsJson } }] } }] })}\n\n`,
    "data: [DONE]\n\n"
  ]);
}

describe("Delphi managed setup in build/debug runs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ARCHICODE_DELPHI_SETUP_TEST_KEY;
  });

  it("pauses before downloading managed tooling and records the exact setup request", async () => {
    process.env.ARCHICODE_DELPHI_SETUP_TEST_KEY = "test";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const bodyText = String(init?.body ?? "{}");
      if (bodyText.includes("ArchiCode phase: coding")) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "setup-delphi-tools",
                type: "function",
                function: {
                  name: "archicode_setup_delphi_managed_tools",
                  arguments: JSON.stringify({ adapters: ["playwright"], playwrightBrowsers: ["chromium"] })
                }
              }]
            }
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Planning complete." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-run-setup-"));
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_DELPHI_SETUP_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Prepare browser testing with Delphi"
    });
    const paused = await waitForRun(root, runId, (run) => run.status === "needs-permission");

    expect(paused.mcp?.pendingToolCall).toMatchObject({
      serverId: "archicode-subagents",
      toolName: "setup_delphi_managed_tools",
      providerToolName: "archicode_setup_delphi_managed_tools"
    });
    expect(paused.permission.reason).toContain("Playwright");
    expect(paused.mcp?.pendingToolCall?.argumentsJson).toContain("chromium");
    await expect(access(path.join(root, ".archicode", "tool-cache", "delphi-tools", "playwright-v1", "package.json"))).rejects.toThrow();
  });

  it("pauses before Delphi starts an app target and records the exact lifecycle", async () => {
    process.env.ARCHICODE_DELPHI_SETUP_TEST_KEY = "test";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const bodyText = String(init?.body ?? "{}");
      if (bodyText.includes("ArchiCode phase: coding")) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "launch-delphi-target",
                type: "function",
                function: {
                  name: "archicode_spawn_delphi",
                  arguments: JSON.stringify({
                    objective: "Audit the running desktop target",
                    platforms: ["electron"],
                    target: { profileId: "desktop-test", launch: "if-needed", cleanup: "stop-if-started" }
                  })
                }
              }]
            }
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Planning complete." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-run-target-"));
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      runTargetProfiles: [{
        id: "desktop-test",
        label: "Desktop Test",
        kind: "electron",
        runCommand: "node -e \"require('fs').writeFileSync('delphi-launched.txt','yes'); setInterval(() => {}, 1000)\"",
        runtimeReadyPattern: "ready",
        targetRequired: false,
        diagnosticCommands: [],
        recoveryCommands: [],
        retryAfterRecovery: true,
        timeoutSeconds: 5
      }],
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_DELPHI_SETUP_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Audit the desktop target with Delphi"
    });
    const paused = await waitForRun(root, runId, (run) => run.status === "needs-permission");

    expect(paused.mcp?.pendingToolCall).toMatchObject({
      serverId: "archicode-subagents",
      toolName: "spawn_delphi",
      providerToolName: "archicode_spawn_delphi"
    });
    expect(paused.permission.reason).toContain("Desktop Test");
    expect(paused.permission.reason).toContain("delphi-launched.txt");
    await expect(access(path.join(root, "delphi-launched.txt"))).rejects.toThrow();
  });

  it("approves a bounded Delphi verification capability instead of pinning command names", async () => {
    process.env.ARCHICODE_DELPHI_SETUP_TEST_KEY = "test";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const bodyText = String(init?.body ?? "{}");
      if (bodyText.includes("ArchiCode phase: coding")) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "approve-delphi-command",
                type: "function",
                function: {
                  name: "archicode_spawn_delphi",
                  arguments: JSON.stringify({ objective: "Run the finite fixture", platforms: ["generic"] })
                }
              }]
            }
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Planning complete." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-run-command-approval-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      private: true,
      scripts: { "test:delphi": "node -e \"console.log('ok')\"" }
    }), "utf8");
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      autoApproveShellCommands: false,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_DELPHI_SETUP_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Audit the finite fixture with Delphi"
    });
    const paused = await waitForRun(root, runId, (run) => run.status === "needs-permission");
    const pendingArgs = JSON.parse(paused.mcp?.pendingToolCall?.argumentsJson ?? "{}") as { commands?: string[] };

    expect(paused.mcp?.pendingToolCall).toMatchObject({ providerToolName: "archicode_spawn_delphi" });
    expect(pendingArgs.commands).toEqual([]);
    expect(paused.permission.reason).toMatch(/verification capability/i);
  });

  it("requires approval for a browser audit even when it has no shell commands or runtime launch", async () => {
    process.env.ARCHICODE_DELPHI_SETUP_TEST_KEY = "test";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const bodyText = String(init?.body ?? "{}");
      if (bodyText.includes("ArchiCode phase: coding")) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "approve-delphi-browser-origin",
                type: "function",
                function: {
                  name: "archicode_spawn_delphi",
                  arguments: JSON.stringify({
                    objective: "Audit the reviewed browser target",
                    platforms: ["web"],
                    target: { baseUrl: "https://staging.example.test/app" }
                  })
                }
              }]
            }
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Planning complete." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-browser-approval-"));
    await mkdir(path.join(root, "node_modules", "playwright"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true }), "utf8");
    await writeFile(path.join(root, "node_modules", "playwright", "package.json"), JSON.stringify({ name: "playwright" }), "utf8");
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_DELPHI_SETUP_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Audit the reviewed browser target with Delphi"
    });
    const paused = await waitForRun(root, runId, (run) => run.status === "needs-permission");
    const pendingArgs = JSON.parse(paused.mcp?.pendingToolCall?.argumentsJson ?? "{}") as { mode?: string; target?: { baseUrl?: string } };

    expect(paused.mcp?.pendingToolCall).toMatchObject({ providerToolName: "archicode_spawn_delphi" });
    expect(pendingArgs).toMatchObject({ mode: "audit", target: { baseUrl: "https://staging.example.test/app" } });
    expect(paused.permission.reason).toContain("Approved browser origin: https://staging.example.test");
  });

  it("turns an API Delphi needs-setup result into a second explicit setup approval", async () => {
    process.env.ARCHICODE_DELPHI_SETUP_TEST_KEY = "test";
    let delphiTurns = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const bodyText = String(init?.body ?? "{}");
      if (bodyText.includes("You are Delphi")) {
        delphiTurns += 1;
        if (delphiTurns === 1) {
          return openAiChatToolSse("inspect-delphi-before-setup", "delphi_inspect_test_environment");
        }
        return openAiChatTextSse(JSON.stringify({
          status: "needs-setup",
          verdict: "not-run",
          summary: "A browser component became unavailable during the audit.",
          attempts: 0,
          checks: [],
          findings: [],
          toolchains: [{
            adapter: "playwright",
            status: "missing",
            evidence: ["The adapter could not launch."],
            installPlan: {
              scope: "managed-cache",
              packages: ["playwright"],
              actions: ["Install the managed browser adapter after approval."],
              requiresApproval: true
            }
          }],
          artifacts: [],
          blockers: ["Playwright unavailable"],
          recommendedNextSteps: ["Approve managed setup"]
        }));
      }
      if (bodyText.includes("ArchiCode phase: coding")) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{
            id: "spawn-delphi-needs-setup",
            type: "function",
            function: {
              name: "archicode_spawn_delphi",
              arguments: JSON.stringify({
                objective: "Audit the browser target",
                platforms: ["web"],
                target: { baseUrl: "http://127.0.0.1:4173" }
              })
            }
          }] } }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Planning complete." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-delphi-api-setup-handoff-"));
    await mkdir(path.join(root, "node_modules", "playwright"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true }), "utf8");
    await writeFile(path.join(root, "node_modules", "playwright", "package.json"), JSON.stringify({ name: "playwright" }), "utf8");
    const bundle = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_DELPHI_SETUP_TEST_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Audit and request setup if the adapter fails"
    });
    const auditApproval = await waitForRun(root, runId, (run) => run.status === "needs-permission");
    expect(auditApproval.mcp?.pendingToolCall?.providerToolName).toBe("archicode_spawn_delphi");

    const afterAudit = await approveRun({ projectRoot: root, runId });
    const setupApproval = afterAudit.runs.find((run) => run.id === runId)!;

    expect(setupApproval.status).toBe("needs-permission");
    expect(setupApproval.mcp?.pendingToolCall).toMatchObject({
      providerToolName: "archicode_setup_delphi_managed_tools",
      toolName: "setup_delphi_managed_tools"
    });
    expect(setupApproval.mcp?.continuation?.providerKind).toBe("api");
    expect(setupApproval.permission.reason).toContain("download managed test tooling");
  });
});
