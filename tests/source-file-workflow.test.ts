import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileRuntimeProfilesWithLlm } from "../src/main/storage/commandInference";
import { addNote, attachNodeReferences } from "../src/main/storage/notes";
import { applyPatchProposal, evaluateSourceFileSafety, listPatchProposals } from "../src/main/storage/patches";
import { ensureProject, loadProject, updateProjectSettings } from "../src/main/storage/projectStore";
import { approveRun, dismissRunError, persistAndMaybeApplyPatchProposal, rejectRun, reportBug, startAgentRun, startDebuggingRun, startIncidentDebugRun, updateBugIncident } from "../src/main/storage/runEngine";
import { runSchema, type ProjectBundle, type Run } from "../src/shared/schema";

async function waitForRun(root: string, runId: string, predicate: (run: Run) => boolean): Promise<{ bundle: ProjectBundle; run: Run }> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const bundle = await loadProject(root);
    const run = bundle.runs.find((item) => item.id === runId);
    if (run && predicate(run)) return { bundle, run };
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const bundle = await loadProject(root);
  const run = bundle.runs.find((item) => item.id === runId);
  throw new Error(`Timed out waiting for run ${runId}. Last status: ${run?.status ?? "missing"}`);
}

function mockOpenAIResponses(): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | Array<{ content?: Array<{ text?: string }> }> };
    const content = typeof body.input === "string"
      ? body.input
      : body.input?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("\n") ?? "";
    const providerMessage = content.includes("ArchiCode phase: coding")
      ? JSON.stringify({
          archicodePatch: {
            schemaVersion: 1,
            summary: "Create generated app source.",
            operations: [
              {
                kind: "propose-source-file",
                path: "src/generated-app.ts",
                action: "create",
                content: "export const generatedApp = 'ready';\n",
                nodeId: "node-orchestrator",
                reason: "Implement the requested app source.",
                testIntent: "Imported by a future smoke test."
              }
            ]
          }
        })
      : "Planning complete. Coding can create src/generated-app.ts.";

    return new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }));
}

async function writeTinyPng(filePath: string): Promise<void> {
  await writeFile(filePath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  ));
}

describe("source file proposal workflow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ARCHICODE_TEST_OPENAI_KEY;
  });

  it("lets an API provider generate a safe source file through coding", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    mockOpenAIResponses();
    const root = await mkdtemp(path.join(tmpdir(), "archicode-api-source-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate a tiny source file",
      scope: { kind: "project", flowId: "flow-main", nodeIds: [], label: "Project" }
    });
    const { bundle: completed, run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    await expect(readFile(path.join(root, "src/generated-app.ts"), "utf8")).resolves.toContain("generatedApp");
    expect(run.sourceDiffArtifactIds).toHaveLength(1);
    expect(completed.artifacts.some((artifact) => artifact.type === "diff" && artifact.runId === runId)).toBe(true);
    const implementedNode = completed.flows[0]!.nodes.find((node) => node.id === "node-orchestrator")!;
    expect(implementedNode.implementationScope).toMatchObject({
      source: "implementation-agent",
      updatedByRunId: runId,
      checkedAt: expect.any(String),
      claims: [{ relation: "own", kind: "file", path: "src/generated-app.ts" }]
    });
    expect(implementedNode.attachments.some((artifact) => artifact.type === "diff" && artifact.runId === runId)).toBe(true);
    expect(completed.flows[0]!.nodes.find((node) => node.type === "project")?.implementationScope).toMatchObject({
      source: "implementation-agent",
      updatedByRunId: runId,
      checkedAt: expect.any(String),
      claims: [{ relation: "cover", kind: "directory", path: "." }]
    });

    // Existing projects created before implementation-scope persistence recover
    // the same mapping from applied source-proposal artifacts on their next load.
    const flowPath = path.join(root, ".archicode", "flows", "flow-main.json");
    const storedFlow = JSON.parse(await readFile(flowPath, "utf8")) as { nodes: Record<string, Record<string, unknown>> };
    const storedNode = storedFlow.nodes["node-orchestrator"]!;
    delete storedNode.implementationScope;
    await writeFile(flowPath, JSON.stringify(storedFlow, null, 2), "utf8");
    const backfilled = await loadProject(root);
    expect(backfilled.flows[0]!.nodes.find((node) => node.id === "node-orchestrator")?.implementationScope).toMatchObject({
      source: "implementation-agent",
      updatedByRunId: runId,
      checkedAt: expect.any(String),
      claims: [{ relation: "own", kind: "file", path: "src/generated-app.ts" }]
    });
    const backfilledFlowText = await readFile(flowPath, "utf8");
    await loadProject(root);
    await expect(readFile(flowPath, "utf8")).resolves.toBe(backfilledFlowText);

    // Load-time recovery never replaces an existing scope, even an older
    // importer-owned one.
    const healthyFlow = JSON.parse(backfilledFlowText) as { nodes: Record<string, Record<string, unknown>> };
    const healthyNode = healthyFlow.nodes["node-orchestrator"]!;
    healthyNode.implementationScope = {
      source: "codebase-importer",
      analyzerVersion: 1,
      checkedAt: "2026-01-01T00:00:00.000Z",
      claims: [{ relation: "cover", kind: "directory", path: "src" }]
    };
    await writeFile(flowPath, JSON.stringify(healthyFlow, null, 2), "utf8");
    const preserved = await loadProject(root);
    expect(preserved.flows[0]!.nodes.find((node) => node.id === "node-orchestrator")?.implementationScope).toMatchObject({
      source: "codebase-importer",
      checkedAt: "2026-01-01T00:00:00.000Z",
      claims: [{ relation: "cover", kind: "directory", path: "src" }]
    });

    // If the historical proposal no longer matches the source, recovery
    // prefers no hint over writing stale responsibility metadata.
    delete healthyNode.implementationScope;
    await writeFile(flowPath, JSON.stringify(healthyFlow, null, 2), "utf8");
    await writeFile(path.join(root, "src/generated-app.ts"), "export const generatedApp = 'changed later';\n", "utf8");
    const stale = await loadProject(root);
    expect(stale.flows[0]!.nodes.find((node) => node.id === "node-orchestrator")?.implementationScope).toBeUndefined();
  });

  it("stages many one-file tool calls in one successful coding provider turn", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    let codingCalls = 0;
    let codingTools: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        input?: string | Array<{ type?: string; output?: string }>;
        tools?: Array<{ name?: string }>;
      };
      const inputText = typeof body.input === "string"
        ? body.input
        : body.input?.map((item) => item.output ?? "").join("\n") ?? "";
      if (typeof body.input === "string" && inputText.includes("ArchiCode phase: coding")) {
        codingCalls += 1;
        codingTools = body.tools?.map((tool) => tool.name ?? "") ?? [];
        return new Response(JSON.stringify({
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-source-a",
              name: "archicode_submit_source_file",
              arguments: JSON.stringify({
                path: "src/a.ts",
                action: "create",
                content: "export const a = true;\n",
                nodeId: "node-orchestrator"
              })
            },
            {
              type: "function_call",
              call_id: "call-source-b",
              name: "archicode_submit_source_file",
              arguments: String.raw`{"path":"src/b.ts","action":"create","content":"export const label = "hello";\n","nodeId":"node-orchestrator"}`
            },
            {
              type: "function_call",
              call_id: "call-source-finish",
              name: "archicode_finish_source_batch",
              arguments: JSON.stringify({
                implementationStatus: "complete",
                summary: "Created two source modules."
              })
            }
          ]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Planning complete." }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-structured-source-fast-path-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY", openAiEndpointMode: "responses" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Create two source modules in one structured batch"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(codingCalls).toBe(1);
    expect(codingTools).toContain("archicode_submit_source_file");
    expect(codingTools).toContain("archicode_finish_source_batch");
    await expect(readFile(path.join(root, "src/a.ts"), "utf8")).resolves.toBe("export const a = true;\n");
    await expect(readFile(path.join(root, "src/b.ts"), "utf8")).resolves.toBe("export const label = \"hello\";\n");
    expect(run.logs.some((line) => line.text.includes("staged 2 file proposal(s) in one provider turn") && line.text.includes("src/b.ts"))).toBe(true);
  });

  it("repairs a missing-file replace, defers stale-disk tools, and completes without a verification-only batch", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    let codingCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      if (typeof body.input === "string" && body.input.includes("ArchiCode phase: coding")) {
        codingCalls += 1;
        return new Response(JSON.stringify({
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-stale-command-first",
              name: "archicode_console_run_command",
              arguments: JSON.stringify({ command: "npm install", timeoutMs: 60_000 })
            },
            {
              type: "function_call",
              call_id: "call-missing-replace",
              name: "archicode_submit_source_file",
              arguments: JSON.stringify({
                path: "src/main.ts",
                action: "replace",
                baseSha256: "c2a7a1b0f56f19e2e8f8f5e5a1f3a54a6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5",
                content: "export const ready = true;\n",
                nodeIds: ["node-orchestrator"]
              })
            },
            {
              type: "function_call",
              call_id: "call-verification-only-finish",
              name: "archicode_finish_source_batch",
              arguments: JSON.stringify({
                implementationStatus: "continue",
                summary: "All requested source files are staged.",
                nextSourceSlice: "Verify the build after applying staged files."
              })
            }
          ]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Planning complete." }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-structured-source-stale-gate-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY", openAiEndpointMode: "responses" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Create the missing entrypoint and let the host verify it"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(codingCalls).toBe(1);
    expect(run.implementation?.currentBatch).toBe(1);
    await expect(readFile(path.join(root, "src/main.ts"), "utf8")).resolves.toBe("export const ready = true;\n");
    const sourceCall = run.mcpToolCalls.find((call) => call.toolName === "submit_source_file");
    expect(sourceCall).toMatchObject({ status: "succeeded", serverLabel: "Source Handoff" });
    const sourceMetadata = JSON.parse(sourceCall?.argumentsJson ?? "{}") as Record<string, unknown>;
    expect(sourceMetadata).toMatchObject({
      path: "src/main.ts",
      requestedAction: "replace",
      action: "create",
      repairMethod: "missing-replace-to-create"
    });
    expect(sourceMetadata).not.toHaveProperty("content");
    expect(run.mcpToolCalls).toContainEqual(expect.objectContaining({
      toolName: "run_command",
      status: "deferred",
      resultSummary: expect.stringContaining("source files are staged but not on disk")
    }));
    expect(run.mcpToolCalls).toContainEqual(expect.objectContaining({
      toolName: "finish_source_batch",
      status: "succeeded",
      resultSummary: expect.stringContaining("status complete")
    }));
    expect(run.logs.some((line) => line.text.includes("missing-replace-to-create"))).toBe(true);
  });

  it("enforces the staging boundary for OpenRouter-style chat completions", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    let codingCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const bodyText = String(init?.body ?? "{}");
      if (bodyText.includes("ArchiCode phase: coding")) {
        codingCalls += 1;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [
                {
                  id: "chat-command-first",
                  type: "function",
                  function: { name: "archicode_console_run_command", arguments: JSON.stringify({ command: "npm install" }) }
                },
                {
                  id: "chat-source",
                  type: "function",
                  function: {
                    name: "archicode_submit_source_file",
                    arguments: JSON.stringify({ path: "src/chat.ts", action: "create", content: "export const chat = true;\n", nodeIds: ["node-orchestrator"] })
                  }
                },
                {
                  id: "chat-finish",
                  type: "function",
                  function: {
                    name: "archicode_finish_source_batch",
                    arguments: JSON.stringify({ implementationStatus: "complete", summary: "Created the chat entrypoint." })
                  }
                }
              ]
            }
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Planning complete." } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-chat-source-stale-gate-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Create one file through an OpenRouter-style tool response"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(codingCalls).toBe(1);
    await expect(readFile(path.join(root, "src/chat.ts"), "utf8")).resolves.toBe("export const chat = true;\n");
    expect(run.mcpToolCalls).toContainEqual(expect.objectContaining({
      toolName: "run_command",
      status: "deferred",
      resultSummary: expect.stringContaining("source files are staged but not on disk")
    }));
  });

  it("pauses an API run on a high-risk console command and resumes it after user approval", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    let codingCalls = 0;
    const codingBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const bodyText = String(init?.body ?? "{}");
      if (bodyText.includes("ArchiCode phase: coding")) {
        codingCalls += 1;
        codingBodies.push(bodyText);
        if (codingCalls === 1) {
          // First coding turn asks for a high-risk (interpreter) console command.
          return new Response(JSON.stringify({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: "chat-risky-command",
                  type: "function",
                  function: { name: "archicode_console_run_command", arguments: JSON.stringify({ command: "node -e \"console.log('sentinel-approved')\"" }) }
                }]
              }
            }]
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        // The resumed coding turn completes the work.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [
                {
                  id: "chat-source",
                  type: "function",
                  function: {
                    name: "archicode_submit_source_file",
                    arguments: JSON.stringify({ path: "src/approved.ts", action: "create", content: "export const approved = true;\n", nodeIds: ["node-orchestrator"] })
                  }
                },
                {
                  id: "chat-finish",
                  type: "function",
                  function: {
                    name: "archicode_finish_source_batch",
                    arguments: JSON.stringify({ implementationStatus: "complete", summary: "Created the approved entrypoint." })
                  }
                }
              ]
            }
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Planning complete." } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-console-approval-pause-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY", openAiEndpointMode: "chat-completions" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Pause for console approval then finish"
    });

    // The run pauses for the user instead of failing or dead-ending the model.
    const paused = await waitForRun(root, runId, (item) => item.status === "needs-permission");
    expect(paused.run.mcp?.pendingToolCall?.toolName).toBe("run_command");
    expect(paused.run.permission.decision).toBe("pending");
    expect(paused.run.permission.reason).toContain("sentinel-approved");

    await approveRun({ projectRoot: root, runId });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    // The approved command actually executed and its output fed the resumed phase.
    const commandCall = run.mcpToolCalls.find((call) => call.toolName === "run_command" && call.status === "succeeded");
    expect(commandCall?.resultSummary).toContain("sentinel-approved");
    expect(codingCalls).toBe(2);
    expect(codingBodies[1]).toContain("Approved MCP tool call: ArchiCode Tools / run_command");
    await expect(readFile(path.join(root, "src/approved.ts"), "utf8")).resolves.toBe("export const approved = true;\n");
  });

  it("keeps accepted files staged while asking the provider to resend only a rejected file", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    let codingCalls = 0;
    let targetedRepairReceiptSeen = false;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        input?: string | Array<{ type?: string; output?: string }>;
      };
      const continuationText = Array.isArray(body.input)
        ? body.input.map((item) => item.output ?? "").join("\n")
        : "";
      if (typeof body.input === "string" && body.input.includes("ArchiCode phase: coding")) {
        codingCalls += 1;
        return new Response(JSON.stringify({
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-accepted-first",
              name: "archicode_submit_source_file",
              arguments: JSON.stringify({ path: "src/accepted.ts", action: "create", content: "export const accepted = true;\n", nodeIds: ["node-orchestrator"] })
            },
            {
              type: "function_call",
              call_id: "call-rejected-first",
              name: "archicode_submit_source_file",
              arguments: JSON.stringify({ path: "src/retried.ts", action: "create", content: "export const retried = true;\n" })
            },
            {
              type: "function_call",
              call_id: "call-finish-first",
              name: "archicode_finish_source_batch",
              arguments: JSON.stringify({ implementationStatus: "complete", summary: "Create both files." })
            }
          ]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (Array.isArray(body.input) && continuationText.includes("Resend only src/retried.ts")) {
        codingCalls += 1;
        targetedRepairReceiptSeen = true;
        return new Response(JSON.stringify({
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-retried-second",
              name: "archicode_submit_source_file",
              arguments: JSON.stringify({ path: "src/retried.ts", action: "create", content: "export const retried = true;\n", nodeIds: ["node-orchestrator"] })
            },
            {
              type: "function_call",
              call_id: "call-finish-second",
              name: "archicode_finish_source_batch",
              arguments: JSON.stringify({ implementationStatus: "complete", summary: "Created both files after one targeted resend." })
            }
          ]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Planning complete." }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-structured-source-targeted-retry-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY", openAiEndpointMode: "responses" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Recover only the source tool call with missing node attribution"
    });
    await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(codingCalls).toBe(2);
    expect(targetedRepairReceiptSeen).toBe(true);
    await expect(readFile(path.join(root, "src/accepted.ts"), "utf8")).resolves.toContain("accepted = true");
    await expect(readFile(path.join(root, "src/retried.ts"), "utf8")).resolves.toContain("retried = true");
  });

  it("repairs planning tool validation failures in-place before continuing to coding", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    let repairFeedbackSeen = false;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        input?: string | Array<{ type?: string; output?: string; content?: Array<{ text?: string }> }>;
      };
      const content = typeof body.input === "string"
        ? body.input
        : body.input?.flatMap((item) => [
          ...(item.content?.map((part) => part.text ?? "") ?? []),
          item.output ?? ""
        ]).join("\n") ?? "";

      if (content.includes("ArchiCode phase: coding")) {
        const providerMessage = JSON.stringify({
          archicodePatch: {
            schemaVersion: 1,
            summary: "Create recovered source.",
            operations: [
              {
                kind: "propose-source-file",
                path: "src/recovered.ts",
                action: "create",
                content: "export const recovered = true;\n",
                nodeIds: ["node-orchestrator"],
                reason: "Validate repaired planning tool flow.",
                testIntent: "Recovered coding path writes a source file."
              }
            ]
          }
        });
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (Array.isArray(body.input)) {
        const latestToolOutput = body.input
          .filter((item) => item.type === "function_call_output")
          .map((item) => item.output ?? "")
          .at(-1) ?? "";
        if (latestToolOutput.includes("REPAIRABLE_TOOL_ERROR")) {
          repairFeedbackSeen = true;
          return new Response(JSON.stringify({
            status: "completed",
            output: [{
              type: "function_call",
              call_id: "call-list-retry",
              name: "archicode_project_list_files",
              arguments: JSON.stringify({ directory: "." })
            }]
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Planning complete after retry." }] }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call-list",
          name: "archicode_project_list_files",
          arguments: JSON.stringify({ directory: "/tmp/not-the-project-root" })
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-planning-tool-repair-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY", openAiEndpointMode: "responses" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Recover from a repairable planning tool failure"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(repairFeedbackSeen).toBe(true);
    await expect(readFile(path.join(root, "src/recovered.ts"), "utf8")).resolves.toContain("recovered");
    expect(run.mcpToolCalls.some((call) => call.status === "failed" && call.toolName === "list_files")).toBe(true);
    expect(run.mcpToolCalls.some((call) => call.status === "succeeded" && call.toolName === "list_files")).toBe(true);
    expect(run.logs.some((line) => line.text.includes("returned repair guidance to the provider"))).toBe(true);
  });

  it("normalizes an absolute project-root cwd for the built-in console without failing implementation", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    const root = await mkdtemp(path.join(tmpdir(), "archicode-console-cwd-normalize-"));
    const bundle = await ensureProject(root);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        input?: string | Array<{ output?: string }>;
      };
      const content = typeof body.input === "string"
        ? body.input
        : body.input?.map((item) => item.output ?? "").join("\n") ?? "";
      if (typeof body.input === "string" && content.includes("ArchiCode phase: coding")) {
        return new Response(JSON.stringify({
          status: "completed",
          output: [{
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify({
              archicodePatch: {
                schemaVersion: 1,
                summary: "Create source after console verification.",
                operations: [{
                  kind: "propose-source-file",
                  path: "src/console-recovered.ts",
                  action: "create",
                  content: "export const consoleRecovered = true;\n",
                  nodeIds: ["node-orchestrator"]
                }]
              }
            }) }]
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // After the user's approval the resumed turn carries the executed tool
      // result; a well-behaved model continues instead of re-requesting it.
      if (Array.isArray(body.input) || content.includes("Approved MCP tool call: ArchiCode Tools / run_command")) {
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Planning complete after the finite console check." }] }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call-console-absolute-cwd",
          name: "archicode_console_run_command",
          arguments: JSON.stringify({
            command: 'node -e "process.exit(0)"',
            cwd: root,
            timeoutMs: 30_000
          })
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY", openAiEndpointMode: "responses" as const }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Continue after an absolute console cwd is normalized"
    });
    // The high-risk interpreter command pauses for user approval first.
    await waitForRun(root, runId, (item) => item.status === "needs-permission");
    await approveRun({ projectRoot: root, runId });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(run.mcpToolCalls).toContainEqual(expect.objectContaining({
      toolName: "run_command",
      status: "succeeded",
      argumentsJson: expect.stringContaining('"cwd":"."')
    }));
    expect(run.logs.some((line) => line.text.includes("Normalized absolute project path arguments for run_command"))).toBe(true);
    await expect(readFile(path.join(root, "src/console-recovered.ts"), "utf8")).resolves.toContain("consoleRecovered");
  });

  it("exposes node note image attachments as metadata without auto-sending image bytes to provider runs", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> & { input?: string | Array<{ content?: Array<{ text?: string }> }> };
      requests.push(body);
      const content = typeof body.input === "string"
        ? body.input
        : body.input?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("\n") ?? "";
      const providerMessage = content.includes("ArchiCode phase: coding")
        ? JSON.stringify({
            archicodePatch: {
              schemaVersion: 1,
              summary: "Create generated app source.",
              operations: [
                {
                  kind: "propose-source-file",
                  path: "src/generated-from-image.ts",
                  action: "create",
                  content: "export const generatedFromImage = true;\n",
                  nodeId: "node-project",
                  reason: "Use the attached visual reference.",
                  testIntent: "Imported by a future smoke test."
                }
              ]
            }
          })
        : "Planning complete. Coding can create src/generated-from-image.ts.";
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-run-note-image-"));
    const imagePath = path.join(root, "reference.png");
    await writeTinyPng(imagePath);
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });
    const withNote = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Use the attached visual reference.",
      resolved: false
    });
    const noteId = withNote.notes.find((note) => note.body.includes("visual reference"))!.id;
    await attachNodeReferences(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      noteId,
      filePaths: [imagePath]
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      nodeId: "node-project",
      providerId: "openai-compatible",
      promptSummary: "Plan from the attached visual reference"
    });
    await waitForRun(root, runId, (run) => run.status === "succeeded");

    const requestText = JSON.stringify(requests[0]?.input ?? "");
    expect(requestText).toContain("reference.png");
    expect(requestText).toContain("node-note-attachment");
    expect(requestText).toContain("archicode_project_read_artifact");
    expect(requestText).not.toContain("data:image/png;base64,");
    expect(requestText).not.toContain("\"input_image\"");
  });

  it("shows agent runs immediately while preparing context", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    mockOpenAIResponses();
    const root = await mkdtemp(path.join(tmpdir(), "archicode-api-preparing-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const started = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate a tiny source file"
    });
    const visible = started.bundle.runs.find((run) => run.id === started.runId);

    expect(visible?.status).toBe("preparing");
    expect(visible?.logs.some((line) => line.text.includes("Preparing run context"))).toBe(true);

    await waitForRun(root, started.runId, (run) => run.status === "succeeded");
  });

  it("starts no-scope implementation runs directly in coding with a compact batch budget", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    const phases: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      phases.push(content.includes("ArchiCode phase: coding") ? "coding" : "planning");
      const providerMessage = JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          summary: "Apply the quick copy edit.",
          runSummary: {
            implementationStatus: "complete",
            notes: "No graph changes are needed."
          },
          operations: [
            {
              kind: "propose-source-file",
              path: "src/copy.ts",
              action: "create",
              content: "export const footerCopy = 'Copyright 2026';\n",
              nodeIds: ["node-orchestrator"],
              reason: "Apply the requested localized copy edit.",
              testIntent: "Covered by final verification when configured."
            }
          ]
        }
      });

      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-api-no-scope-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Change footer copyright copy.",
      scope: {
        kind: "no-scope",
        flowId: "flow-main",
        nodeIds: [],
        label: "Footer copy"
      }
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(phases).toEqual(["coding"]);
    expect(run.implementation?.maxBatches).toBe(2);
    expect(run.implementation?.tasks.every((task) => task.status === "done")).toBe(true);
    await expect(readFile(path.join(root, "src/copy.ts"), "utf8")).resolves.toContain("Copyright 2026");
  });

  it("sends an explicit runtime profile patch contract during reconciliation", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    let requestBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "No profile changes needed." }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-contract-"));
    const bundle = await ensureProject(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        dev: "vite --host 127.0.0.1",
        build: "vite build"
      }
    }, null, 2), "utf8");
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY", openAiEndpointMode: "responses" as const }
        : { ...provider, enabled: false })
    });

    await reconcileRuntimeProfilesWithLlm(root, "openai-compatible", "pre-build", "run-runtime-contract");

    expect(requestBody).toContain("Runtime profile handoff JSON contract");
    expect(requestBody).toContain("top-level shape: { \\\"archicodePatch\\\": { ... } }");
    expect(requestBody).toContain("Do not return the bare patch object");
    expect(requestBody).toContain("\\\"kind\\\": \\\"propose-run-profile\\\"");
    expect(requestBody).toContain("If no changes are needed, return prose only and no JSON");
  });

  it("skips command inference and LLM reconciliation when build targets are locked", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const root = await mkdtemp(path.join(tmpdir(), "archicode-locked-targets-"));
    const bundle = await ensureProject(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { dev: "vite", build: "vite build" }
    }), "utf8");
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      buildTargetsLocked: true,
      defaultBuildCommand: "custom verify",
      runTargetProfiles: []
    });

    const result = await reconcileRuntimeProfilesWithLlm(root, "openai-compatible", "pre-build", "run-locked-targets");

    expect(result.skippedReason).toContain("Build targets are locked");
    expect(result.bundle.project.settings.defaultBuildCommand).toBe("custom verify");
    expect(result.bundle.project.settings.runTargetProfiles).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("repairs invalid runtime profile reconciliation output before accepting a verify-phase handoff", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    const requestBodies: string[] = [];
    const providerEvents: Array<{ kind: "succeeded" | "failed" | "rejected"; retry: boolean }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const requestBody = String(init?.body ?? "");
      requestBodies.push(requestBody);
      const isRepairAttempt = requestBody.includes("Runtime Profile Reconciliation Repair Request");
      const text = isRepairAttempt
        ? JSON.stringify({
            archicodePatch: {
              schemaVersion: 1,
              summary: "Add a corrected web dev profile.",
              operations: [
                {
                  kind: "propose-run-profile",
                  mode: "create",
                  reason: "The project exposes a web dev script.",
                  profile: {
                    id: "web-dev",
                    label: "Web Dev",
                    kind: "web",
                    cwd: "",
                    runCommand: "npm run dev",
                    buildCommand: "npm run build",
                    url: "http://localhost:5173",
                    ports: [5173],
                    inferred: true
                  }
                }
              ]
            }
          })
        : JSON.stringify({
            archicodePatch: {
              schemaVersion: 1,
              summary: "Wrongly propose a source edit.",
              operations: [
                {
                  kind: "propose-source-file",
                  path: "src/should-not-apply.ts",
                  action: "create",
                  content: "export const shouldNotApply = true;\n",
                  nodeIds: ["node-orchestrator"],
                  reason: "This should be rejected by runtime profile reconciliation.",
                  testIntent: "Validator should force a retry."
                }
              ]
            }
          });
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-repair-"));
    const bundle = await ensureProject(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        dev: "vite --host 127.0.0.1",
        build: "vite build"
      }
    }, null, 2), "utf8");
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY", openAiEndpointMode: "responses" as const }
        : { ...provider, enabled: false })
    });

    const result = await reconcileRuntimeProfilesWithLlm(
      root,
      "openai-compatible",
      "pre-build",
      "run-runtime-repair",
      undefined,
      (event) => providerEvents.push(event)
    );

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toContain("Runtime Profile Reconciliation Repair Request");
    expect(requestBodies[1]).toContain("received propose-source-file");
    expect(result.repairSummary).toBe("Runtime profile reconciliation recovered after 1 repair attempt.");
    expect(providerEvents).toEqual([
      { kind: "succeeded", retry: false },
      { kind: "rejected", retry: false },
      { kind: "succeeded", retry: true }
    ]);
    expect(result.proposal?.valid).toBe(true);
    expect(result.bundle.project.settings.runTargetProfiles.some((profile) =>
      profile.id === "web-dev" && profile.runCommand === "npm run dev" && profile.buildCommand === "npm run build"
    )).toBe(true);
  });

  it("can continue coding through multiple implementation batches before verification", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    const codingPrompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      if (!content.includes("ArchiCode phase: coding")) {
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Planning complete. Build source in batches." }] }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      codingPrompts.push(content);
      const batchNumber = /Implementation batch 2\/|\"currentBatch\": 2/.test(content) ? 2 : 1;
      const providerMessage = JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          summary: batchNumber === 1 ? "Create the first implementation slice." : "Create the second implementation slice.",
          runSummary: {
            implementationStatus: batchNumber === 1 ? "continue" : "complete",
            nextSourceSlice: batchNumber === 1 ? "Create src/second.ts." : undefined,
            notes: batchNumber === 1 ? "First slice is ready." : "Implementation is complete."
          },
          operations: [
            {
              kind: "propose-source-file",
              path: batchNumber === 1 ? "src/first.ts" : "src/second.ts",
              action: "create",
              content: batchNumber === 1 ? "export const first = true;\n" : "export const second = true;\n",
              nodeIds: ["node-orchestrator"],
              reason: batchNumber === 1 ? "First implementation slice." : "Second implementation slice.",
              testIntent: "Covered by final verification."
            }
          ]
        }
      });

      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-api-source-batches-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate source in two batches"
    });
    const { bundle: completed, run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    await expect(readFile(path.join(root, "src/first.ts"), "utf8")).resolves.toContain("first");
    await expect(readFile(path.join(root, "src/second.ts"), "utf8")).resolves.toContain("second");
    expect(codingPrompts).toHaveLength(2);
    expect(codingPrompts[1]).toContain("\"runMemory\"");
    expect(codingPrompts[1]).toContain("First slice is ready");
    expect(run.runMemory?.currentPhase).toBe("coding");
    expect(run.runMemory?.completedWork.some((item) => item.includes("First slice is ready"))).toBe(true);
    expect(run.runMemory?.touchedFiles.some((item) => item.includes("source diff artifact"))).toBe(true);
    expect(run.implementation?.currentBatch).toBe(2);
    expect(run.implementation?.checkpoints).toHaveLength(2);
    expect(run.sourceDiffArtifactIds).toHaveLength(2);
    expect(completed.artifacts.filter((artifact) => artifact.type === "generated-file" && artifact.title.includes("Implementation batch") && artifact.runId === runId)).toHaveLength(2);
  });

  it("advances to the next planned task when a completed slice says continue", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      if (!content.includes("ArchiCode phase: coding")) {
        const providerMessage = JSON.stringify({
          archicodePatch: {
            schemaVersion: 1,
            summary: "Plan two source slices.",
            runSummary: {
              implementationTasks: [
                { id: "task-1", title: "Create the first slice", summary: "Create src/first.ts.", batchBudget: 1 },
                { id: "task-2", title: "Create the second slice", summary: "Create src/second.ts.", batchBudget: 1 }
              ]
            },
            operations: []
          }
        });
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      const secondTask = /"currentTask":\s*\{[^}]*"id":\s*"task-2"/.test(content);
      const providerMessage = JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          summary: secondTask ? "Create the second planned slice." : "Create the first planned slice.",
          runSummary: {
            implementationStatus: secondTask ? "complete" : "continue",
            nextSourceSlice: secondTask ? undefined : "Create src/second.ts.",
            notes: secondTask ? "Second slice complete." : "First slice complete; move to the next planned slice."
          },
          operations: [
            {
              kind: "propose-source-file",
              path: secondTask ? "src/second.ts" : "src/first.ts",
              action: "create",
              content: secondTask ? "export const second = true;\n" : "export const first = true;\n",
              nodeIds: ["node-orchestrator"],
              reason: secondTask ? "Complete the second planned slice." : "Complete the first planned slice.",
              testIntent: "Covered by final verification."
            }
          ]
        }
      });

      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-planned-task-advance-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate source in two planned slices"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    await expect(readFile(path.join(root, "src/first.ts"), "utf8")).resolves.toContain("first");
    await expect(readFile(path.join(root, "src/second.ts"), "utf8")).resolves.toContain("second");
    expect(run.implementation?.currentBatch).toBe(2);
    expect(run.implementation?.maxBatches).toBe(2);
    expect(run.implementation?.tasks.every((task) => task.status === "done")).toBe(true);
    expect(run.implementation?.checkpoints.map((checkpoint) => checkpoint.taskId)).toEqual(["task-1", "task-2"]);
  });

  it("succeeds when a later batch reports the task already complete with no source operations", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      if (!content.includes("ArchiCode phase: coding")) {
        const providerMessage = JSON.stringify({
          archicodePatch: {
            schemaVersion: 1,
            summary: "Plan two source slices.",
            runSummary: {
              implementationTasks: [
                { id: "task-1", title: "Create the first slice", summary: "Create src/first.ts.", batchBudget: 1 },
                { id: "task-2", title: "Create the second slice", summary: "Create src/second.ts.", batchBudget: 1 }
              ]
            },
            operations: []
          }
        });
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      const secondTask = /"currentTask":\s*\{[^}]*"id":\s*"task-2"/.test(content);
      // Batch 1 builds the first slice; batch 2 finds the work already done and
      // returns a valid completion handoff with no source operations.
      const providerMessage = secondTask
        ? JSON.stringify({
            archicodePatch: {
              schemaVersion: 1,
              summary: "All planned slices already exist; build passes.",
              runSummary: { implementationStatus: "complete", notes: "No further source-file operations are needed." },
              operations: []
            }
          })
        : JSON.stringify({
            archicodePatch: {
              schemaVersion: 1,
              summary: "Create the first planned slice.",
              runSummary: { implementationStatus: "continue", nextSourceSlice: "Create src/second.ts." },
              operations: [{
                kind: "propose-source-file",
                path: "src/first.ts",
                action: "create",
                content: "export const first = true;\n",
                nodeIds: ["node-orchestrator"],
                reason: "Complete the first planned slice.",
                testIntent: "Covered by final verification."
              }]
            }
          });
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-complete-noop-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate source where a later slice is already done"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    await expect(readFile(path.join(root, "src/first.ts"), "utf8")).resolves.toContain("first");
    // The empty-but-complete handoff is a success, not a "Provider handoff invalid" failure.
    expect(run.implementation?.tasks.every((task) => task.status === "done")).toBe(true);
    expect(JSON.stringify(run.logs)).not.toContain("did not include usable propose-source-file operations");
    expect(JSON.stringify(run.logs)).not.toContain("invalid or unsupported coding handoff");
  });

  it("allows a run to clean up its own unchanged, mistakenly named file", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    let codingBatch = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      const providerMessage = !content.includes("ArchiCode phase: coding")
        ? JSON.stringify({
            archicodePatch: {
              schemaVersion: 1,
              summary: "Plan a two-pass source correction.",
              runSummary: {
                implementationTasks: [{
                  id: "task-1",
                  title: "Create the correctly named source file",
                  summary: "Create the source and correct its filename if necessary.",
                  batchBudget: 2
                }]
              },
              operations: []
            }
          })
        : ++codingBatch === 1
          ? JSON.stringify({
              archicodePatch: {
                schemaVersion: 1,
                summary: "Create the first source slice.",
                runSummary: { implementationStatus: "continue", nextSourceSlice: "Correct the filename." },
                operations: [{
                  kind: "propose-source-file",
                  path: "source/wrong-name.custom",
                  action: "create",
                  content: "first version\n",
                  nodeIds: ["node-orchestrator"],
                  reason: "Create the initial source file."
                }]
              }
            })
          : JSON.stringify({
              archicodePatch: {
                schemaVersion: 1,
                summary: "Correct the source filename.",
                runSummary: { implementationStatus: "complete" },
                operations: [
                  {
                    kind: "propose-source-file",
                    path: "source/wrong-name.custom",
                    action: "delete",
                    nodeIds: ["node-orchestrator"],
                    reason: "Remove the incorrectly named file created by this run."
                  },
                  {
                    kind: "propose-source-file",
                    path: "source/right-name.custom",
                    action: "create",
                    content: "first version\n",
                    nodeIds: ["node-orchestrator"],
                    reason: "Create the correctly named file."
                  }
                ]
              }
            });
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-same-run-delete-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Create a source file and correct its name"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    await expect(readFile(path.join(root, "source/wrong-name.custom"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(root, "source/right-name.custom"), "utf8")).resolves.toBe("first version\n");
    expect(run.sourceReview).toBeUndefined();
    expect(run.implementation?.currentBatch).toBe(2);
  });

  it.each(["accepted", "rejected"] as const)(
    "%s source-deletion decisions resume the same auto-coding run",
    async (decision) => {
      process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
      let codingBatch = 0;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
        const content = body.input ?? "";
        const providerMessage = !content.includes("ArchiCode phase: coding")
          ? JSON.stringify({
              archicodePatch: {
                schemaVersion: 1,
                summary: "Plan one source cleanup task.",
                runSummary: {
                  implementationTasks: [{
                    id: "task-1",
                    title: "Clean up an existing file",
                    summary: "Request deletion and then finish according to the user's decision.",
                    batchBudget: 1
                  }]
                },
                operations: []
              }
            })
          : ++codingBatch === 1 || decision === "rejected"
            ? JSON.stringify({
                archicodePatch: {
                  schemaVersion: 1,
                  summary: "Request removal of the existing file.",
                  runSummary: { implementationStatus: "complete" },
                  operations: [{
                    kind: "propose-source-file",
                    path: "existing/user-file.custom",
                    action: "delete",
                    nodeIds: ["node-orchestrator"],
                    reason: "The implementation agent believes this file is obsolete."
                  }]
                }
              })
            : JSON.stringify({
                archicodePatch: {
                  schemaVersion: 1,
                  summary: "The approved cleanup is complete.",
                  runSummary: { implementationStatus: "complete" },
                  operations: []
                }
              });
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }));
      const root = await mkdtemp(path.join(tmpdir(), `archicode-delete-${decision}-`));
      const bundle = await ensureProject(root);
      await mkdir(path.join(root, "existing"), { recursive: true });
      await writeFile(path.join(root, "existing/user-file.custom"), "user-owned\n", "utf8");
      await updateProjectSettings(root, {
        ...bundle.project.settings,
        stopOnUnansweredQuestions: false,
        patchReviewMode: "auto",
        providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
          ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
          : { ...provider, enabled: false })
      });

      const { runId } = await startAgentRun({
        projectRoot: root,
        flowId: "flow-main",
        providerId: "openai-compatible",
        promptSummary: "Clean up an existing source file"
      });
      const paused = await waitForRun(root, runId, (item) => item.status === "needs-permission");
      expect(paused.run.sourceReview?.paths).toEqual(["existing/user-file.custom"]);
      if (decision === "accepted") await approveRun({ projectRoot: root, runId });
      else await rejectRun(root, runId, "Keep the user-owned file.");
      const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

      expect(run.id).toBe(runId);
      expect(run.sourceDeletionDecisions).toContainEqual(expect.objectContaining({
        path: "existing/user-file.custom",
        decision
      }));
      if (decision === "accepted") {
        await expect(readFile(path.join(root, "existing/user-file.custom"), "utf8")).rejects.toThrow();
      } else {
        await expect(readFile(path.join(root, "existing/user-file.custom"), "utf8")).resolves.toBe("user-owned\n");
        expect(codingBatch).toBe(2);
      }
    }
  );

  it("runs the build-derived typecheck alongside a narrow per-batch verification command", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      if (!content.includes("ArchiCode phase: coding")) {
        const providerMessage = JSON.stringify({
          archicodePatch: {
            schemaVersion: 1,
            summary: "Plan one slice with a narrow light check.",
            runSummary: {
              implementationTasks: [{
                id: "task-1",
                title: "Create the slice",
                summary: "Create src/only.ts.",
                batchBudget: 1,
                lightVerificationCommand: "npm run check"
              }]
            },
            operations: []
          }
        });
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const providerMessage = JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          summary: "Create the slice.",
          runSummary: { implementationStatus: "complete" },
          operations: [{
            kind: "propose-source-file",
            path: "src/only.ts",
            action: "create",
            content: "export const only = true;\n",
            nodeIds: ["node-orchestrator"],
            reason: "Implement the planned slice.",
            testIntent: "Covered by verification."
          }]
        }
      });
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-build-typecheck-"));
    const bundle = await ensureProject(root);
    // Local stub so `npm exec tsc -- -b` (derived from the build script) runs offline.
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(root, "node_modules", ".bin", "tsc"), "#!/usr/bin/env node\nprocess.exit(0);\n");
    await chmod(path.join(root, "node_modules", ".bin", "tsc"), 0o755);
    await writeFile(path.join(root, "lightcheck.cjs"), "process.exit(0);\n");
    await writeFile(path.join(root, "bundle.cjs"), "process.exit(0);\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { check: "node lightcheck.cjs", build: "tsc -b && node bundle.cjs" } }, null, 2));
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate source with a narrow per-batch check"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded" || item.status === "verifying" || item.status === "failed");

    // The per-batch verification ran both the model's narrow command AND the
    // build-derived whole-project typecheck (so config errors would be caught
    // at their source), joined into one command.
    const batchVerifyLine = run.logs.find((line) => /Targeted verification (?:passed|failed):/.test(line.text));
    expect(batchVerifyLine?.text).toContain("npm exec tsc -- -b");
    expect(batchVerifyLine?.text).toContain("npm run check");
  }, 20_000);

  it("retries an empty coding handoff with tighter guidance before failing", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      if (!content.includes("ArchiCode phase: coding")) {
        const providerMessage = JSON.stringify({
          archicodePatch: {
            schemaVersion: 1,
            summary: "Plan one slice.",
            runSummary: { implementationTasks: [{ id: "task-1", title: "Create the slice", summary: "Create src/only.ts.", batchBudget: 1 }] },
            operations: []
          }
        });
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // First coding attempt returns an empty handoff (no ops, no completion
      // signal). Only after the RETRY NOTICE guidance does it return real work.
      const isRetry = content.includes("RETRY NOTICE");
      const providerMessage = isRetry
        ? JSON.stringify({
            archicodePatch: {
              schemaVersion: 1,
              summary: "Create the slice after guidance.",
              runSummary: { implementationStatus: "complete" },
              operations: [{
                kind: "propose-source-file",
                path: "src/only.ts",
                action: "create",
                content: "export const only = true;\n",
                nodeIds: ["node-orchestrator"],
                reason: "Implement the planned slice.",
                testIntent: "Covered by final verification."
              }]
            }
          })
        : JSON.stringify({
            archicodePatch: {
              schemaVersion: 1,
              summary: "Nothing produced yet.",
              operations: []
            }
          });
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-empty-retry-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate source that first returns an empty handoff"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    // The retry produced the file, so the empty first handoff did not fail the run.
    await expect(readFile(path.join(root, "src/only.ts"), "utf8")).resolves.toContain("only");
    expect(JSON.stringify(run.logs)).toContain("retrying with tighter guidance");
  });

  it("extends the dynamic batch budget when the provider explicitly requests another source batch", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      if (!content.includes("ArchiCode phase: coding")) {
        const providerMessage = JSON.stringify({
          archicodePatch: {
            schemaVersion: 1,
            summary: "Plan one fast task that may need an extra source pass.",
            runSummary: {
              implementationTasks: [
                { id: "task-1", title: "Build the feature in slices", summary: "Create three files over successive source batches.", batchBudget: 2 }
              ]
            },
            operations: []
          }
        });
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      const batchNumber = /Implementation batch 3\/|\"currentBatch\": 3/.test(content)
        ? 3
        : /Implementation batch 2\/|\"currentBatch\": 2/.test(content)
          ? 2
          : 1;
      const providerMessage = JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          summary: `Create source slice ${batchNumber}.`,
          runSummary: {
            implementationStatus: batchNumber === 3 ? "complete" : "continue",
            nextSourceSlice: batchNumber === 1 ? "Create src/second.ts." : batchNumber === 2 ? "Create src/third.ts." : undefined,
            notes: batchNumber === 3 ? "All slices are complete." : `Slice ${batchNumber} is ready; another source batch is needed.`
          },
          operations: [
            {
              kind: "propose-source-file",
              path: batchNumber === 1 ? "src/first.ts" : batchNumber === 2 ? "src/second.ts" : "src/third.ts",
              action: "create",
              content: batchNumber === 1
                ? "export const first = true;\n"
                : batchNumber === 2
                  ? "export const second = true;\n"
                  : "export const third = true;\n",
              nodeIds: ["node-orchestrator"],
              reason: `Create slice ${batchNumber}.`,
              testIntent: "Covered by final verification."
            }
          ]
        }
      });

      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-batch-auto-extend-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate source that needs three explicit source batches",
      effort: "fast"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    await expect(readFile(path.join(root, "src/first.ts"), "utf8")).resolves.toContain("first");
    await expect(readFile(path.join(root, "src/second.ts"), "utf8")).resolves.toContain("second");
    await expect(readFile(path.join(root, "src/third.ts"), "utf8")).resolves.toContain("third");
    expect(run.implementation?.currentBatch).toBe(3);
    expect(run.implementation?.maxBatches).toBe(3);
    expect(run.logs.some((line) => line.text.includes("extended the dynamic batch budget to 3 batch(es)"))).toBe(true);
  });

  it("extends the dynamic batch budget to repair failed targeted verification", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    const codingPrompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      if (!content.includes("ArchiCode phase: coding")) {
        const providerMessage = JSON.stringify({
          archicodePatch: {
            schemaVersion: 1,
            summary: "Plan one task with a targeted verification repair pass.",
            runSummary: {
              implementationEffort: "fast",
              implementationTasks: [
                {
                  id: "task-1",
                  title: "Create a verified source file",
                  summary: "Create src/verified.txt and repair it if targeted verification fails.",
                  batchBudget: 1,
                  lightVerificationCommand: "node verify.cjs"
                }
              ]
            },
            operations: []
          }
        });
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      codingPrompts.push(content);
      const repairPass = content.includes("Targeted verification failed") || /"currentBatch":\s*2/.test(content);
      const providerMessage = JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          summary: repairPass ? "Repair the verified source file." : "Create the verified source file with an initial mistake.",
          runSummary: {
            implementationStatus: "complete",
            notes: repairPass ? "Targeted verification repair is complete." : "Initial source slice is ready."
          },
          operations: [
            {
              kind: "propose-source-file",
              path: repairPass ? "src/verified.ready" : "src/verified.txt",
              action: "create",
              content: repairPass ? "ready\n" : "not-ready\n",
              nodeIds: ["node-orchestrator"],
              reason: repairPass ? "Fix the targeted verification failure." : "Create the first implementation slice.",
              testIntent: "node verify.cjs checks that the ready marker exists."
            }
          ]
        }
      });
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-targeted-verification-repair-"));
    const bundle = await ensureProject(root);
    await writeFile(path.join(root, "verify.cjs"), [
      "const fs = require('fs');",
      "if (!fs.existsSync('src/verified.ready')) process.exit(1);",
      "const text = fs.readFileSync('src/verified.ready', 'utf8');",
      "if (!text.includes('ready')) process.exit(1);"
    ].join("\n"), "utf8");
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate source that needs targeted verification repair",
      effort: "fast"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(codingPrompts).toHaveLength(2);
    await expect(readFile(path.join(root, "src/verified.ready"), "utf8")).resolves.toBe("ready\n");
    expect(run.implementation?.currentBatch).toBe(2);
    expect(run.implementation?.maxBatches).toBe(2);
    expect(run.implementation?.checkpoints.map((checkpoint) => checkpoint.verification?.passed)).toEqual([false, true]);
    expect(run.logs.some((line) => line.text.includes("Targeted verification failed; extended the dynamic batch budget to 2 batch(es)"))).toBe(true);
    expect(run.runInstructions).not.toContain("source work remains");
  });

  it("uses planning implementation tasks to drive batches and targeted verification", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    const codingPrompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      if (!content.includes("ArchiCode phase: coding")) {
        const providerMessage = JSON.stringify({
          archicodePatch: {
            schemaVersion: 1,
            summary: "Plan source slices.",
            runSummary: {
              implementationTasks: [
                { id: "shell", title: "Create first slice", summary: "Create src/first.ts.", verificationCommand: "npm run test" },
                { id: "detail", title: "Create second slice", summary: "Create src/second.ts.", verificationCommand: "npm run test" }
              ]
            },
            operations: []
          }
        });
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      codingPrompts.push(content);
      const secondTask = /"currentTask":\s*\{[^}]*"id":\s*"detail"/.test(content);
      const providerMessage = JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          summary: secondTask ? "Create second planned task." : "Create first planned task.",
          runSummary: {
            implementationStatus: "complete",
            notes: secondTask ? "Second planned task complete." : "First planned task complete."
          },
          operations: [
            {
              kind: "propose-source-file",
              path: secondTask ? "src/second.ts" : "src/first.ts",
              action: "create",
              content: secondTask ? "export const second = true;\n" : "export const first = true;\n",
              nodeIds: ["node-orchestrator"],
              reason: secondTask ? "Complete the second planned task." : "Complete the first planned task.",
              testIntent: "npm run test verifies source files exist."
            }
          ]
        }
      });
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-planned-source-batches-"));
    const bundle = await ensureProject(root);
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"const fs=require('fs'); fs.writeFileSync('verification-created.opaque','generated by verification'); if(!fs.existsSync('src/first.ts')) process.exit(1)\""
      }
    }, null, 2), "utf8");
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate source from planned tasks"
    });
    const { bundle: completed, run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(codingPrompts).toHaveLength(2);
    expect(run.implementation?.tasks.map((task) => task.status)).toEqual(["done", "done"]);
    expect(run.implementation?.checkpoints).toHaveLength(2);
    expect(run.implementation?.checkpoints.every((checkpoint) => checkpoint.verification?.passed)).toBe(true);
    expect(completed.artifacts.filter((artifact) => artifact.title.includes("verification") && artifact.runId === runId)).toHaveLength(2);
    await expect(evaluateSourceFileSafety(root, {
      kind: "propose-source-file",
      path: "verification-created.opaque",
      action: "delete",
      reason: "Clean up generated verification output."
    })).resolves.toMatchObject({ safe: true, requiresReview: false });
  });

  it("moves coding blockers into a structured needs-replan state", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      const providerMessage = content.includes("ArchiCode phase: coding")
        ? JSON.stringify({
            archicodePatch: {
              schemaVersion: 1,
              summary: "Coding cannot continue.",
              runSummary: {
                implementationStatus: "blocked",
                needsReplan: true,
                replanReason: "The selected API contract is missing.",
                suggestedQuestions: ["Which API response shape should the page render?"]
              },
              operations: [
                {
                  kind: "propose-source-file",
                  path: "src/partial.ts",
                  action: "create",
                  content: "export const partial = true;\n",
                  nodeIds: ["node-orchestrator"],
                  reason: "Partial setup before blocker."
                }
              ]
            }
          })
        : JSON.stringify({
            archicodePatch: {
              schemaVersion: 1,
              summary: "Plan one source task.",
              runSummary: {
                implementationTasks: [{ id: "api", title: "Implement API-backed page", summary: "Requires API contract." }]
              },
              operations: []
            }
          });
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-needs-replan-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate source until blocker"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "needs-replan");

    expect(run.phase).toBe("needs-replan");
    expect(run.implementation?.needsReplan?.reason).toContain("API contract");
    expect(run.implementation?.tasks[0]?.status).toBe("blocked");
    expect(run.runInstructions).toContain("needs replanning");
  });

  it("auto-rejects planning-time source proposals instead of asking for file review", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-planning-source-hold-"));
    await ensureProject(root);
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        runId: "run-planning-source",
        summary: "Create source too early.",
        operations: [
          {
            kind: "propose-source-file",
            path: "src/early.ts",
            action: "create",
            content: "export const early = true;\n",
            reason: "This belongs in coding, not planning."
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(root, "run-planning-source", output, {
      allowSourceFileAutoApply: false,
      phase: "planning"
    });
    const proposals = await listPatchProposals(root);

    expect(persisted?.pendingReview).toBe(false);
    expect(persisted?.autoApplied).toBe(true);
    expect(proposals[0]?.artifact.status).toBe("rejected");
    expect(proposals[0]?.review?.results[0]?.message).toContain("Source-file proposals are only actionable during coding");
    await expect(readFile(path.join(root, "src/early.ts"), "utf8")).rejects.toThrow();
  });

  it("auto-resolves source proposals that already match files written by the provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-source-already-written-"));
    await ensureProject(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/already.ts"), "export const already = true;\n", "utf8");
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        runId: "run-already-written",
        summary: "Create an already-written source file.",
        operations: [
          {
            kind: "propose-source-file",
            path: "src/already.ts",
            action: "create",
            content: "export const already = true;\n",
            reason: "The provider already wrote this file directly."
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(root, "run-already-written", output);
    const proposals = await listPatchProposals(root);

    expect(persisted?.pendingReview).toBe(false);
    expect(proposals[0]?.artifact.status).toBe("applied");
    expect(proposals[0]?.review?.results[0]?.message).toContain("already existed with matching content");
  });

  it("records a source diff when a pending source proposal is applied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-source-apply-diff-"));
    await ensureProject(root);
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        runId: "run-apply-diff",
        summary: "Create a reviewed source file.",
        operations: [
          {
            kind: "propose-source-file",
            path: "src/reviewed.ts",
            action: "create",
            content: "export const reviewed = true;\n",
            reason: "Implement reviewed source."
          }
        ]
      }
    });

    await persistAndMaybeApplyPatchProposal(root, "run-apply-diff", output, {
      allowSourceFileAutoApply: false
    });
    const run = runSchema.parse({
      id: "run-apply-diff",
      flowId: "flow-main",
      providerId: "openai-compatible",
      status: "awaiting-code-review",
      phase: "awaiting-code-review",
      promptSummary: "Apply reviewed source",
      plannedCommands: [],
      permission: { decision: "allowed" },
      todos: [],
      logs: [],
      createdAt: new Date().toISOString()
    });
    await writeFile(path.join(root, ".archicode", "runs", `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`, "utf8");
    const proposal = (await listPatchProposals(root))[0]!;

    const bundle = await applyPatchProposal(root, proposal.artifact.id, [{ operationIndex: 0, decision: "accepted" }]);
    const updatedRun = bundle.runs.find((item) => item.id === run.id);

    await expect(readFile(path.join(root, "src/reviewed.ts"), "utf8")).resolves.toContain("reviewed");
    expect(updatedRun?.sourceDiffArtifactIds).toHaveLength(1);
    expect(bundle.artifacts.some((artifact) => artifact.type === "diff" && artifact.runId === run.id)).toBe(true);
  });

  it("fails coding runs that produce no source changes or source proposals", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      const providerMessage = content.includes("ArchiCode phase: coding")
        ? "Coding completed. No files changed."
        : "Planning complete. Coding should create files.";

      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-no-source-change-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      promptSummary: "Generate a tiny source file"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "failed");

    expect(run.runInstructions).toContain("did not produce source changes");
    expect(run.logs.some((line) => line.stream === "stderr" && line.text.includes("no source file changes"))).toBe(true);

    const dismissed = await dismissRunError(root, runId);
    const dismissedRun = dismissed.runs.find((item) => item.id === runId);
    expect(dismissedRun?.status).toBe("failed");
    expect(dismissedRun?.errorDismissedAt).toBeTruthy();
    expect(dismissedRun?.logs.some((line) => line.text === "Run error dismissed.")).toBe(true);
  });

  it("lets Build discovery verify successfully when no source changes are needed", async () => {
    process.env.ARCHICODE_TEST_OPENAI_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const content = body.input ?? "";
      const providerMessage = content.includes("ArchiCode phase: coding")
        ? "The finite verification path is already configured. No source or configuration changes are needed."
        : "Planning complete. Confirm the finite verification path, then run it.";

      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: providerMessage }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const root = await mkdtemp(path.join(tmpdir(), "archicode-build-discovery-no-change-"));
    const bundle = await ensureProject(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        test: "node --test"
      }
    }, null, 2), "utf8");
    await writeFile(path.join(root, "smoke.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('smoke', () => assert.equal(1, 1));\n", "utf8");
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      stopOnUnansweredQuestions: false,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      purpose: "build-discovery",
      promptSummary: "Detect and actually run the finite build/test verification target"
    });
    const { run } = await waitForRun(root, runId, (item) => item.status === "succeeded");

    expect(run.command).toBe("npm install && npm run test");
    expect(run.logs.some((line) => line.text.includes("No source or configuration changes were needed. Verification will run: npm install && npm run test"))).toBe(true);
    expect(run.logs.some((line) => line.text.includes("Verification phase started: npm install && npm run test"))).toBe(true);
    expect(run.runInstructions).toContain("Verification completed with `npm install && npm run test`.");
  });

  it("applies review-required source file proposals instead of showing them as graph review", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-unsafe-source-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      codeReviewMode: "manual"
    });
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Create environment file.",
        operations: [
          {
            kind: "propose-source-file",
            path: ".env.example",
            action: "create",
            content: "FEATURE_FLAG=true\n",
            reason: "Document required environment setting."
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(root, "run-env", output);
    const proposals = await listPatchProposals(root);
    expect(persisted?.pendingReview).toBe(false);
    expect(proposals[0]?.artifact.status).toBe("applied");
    await expect(readFile(path.join(root, ".env.example"), "utf8")).resolves.toContain("FEATURE_FLAG");
  });

  it("rejects path traversal source file proposals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-source-safety-"));
    await ensureProject(root);
    const safety = await evaluateSourceFileSafety(root, {
      kind: "propose-source-file",
      path: "../outside.ts",
      action: "create",
      content: "export const outside = true;\n"
    });

    expect(safety.safe).toBe(false);
    expect(safety.requiresReview).toBe(true);
    expect(safety.risk).toBe("high");
  });

  it("auto-deletes only unchanged artifacts recorded by managed verification, independent of stack", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-generated-cleanup-"));
    await ensureProject(root);
    await mkdir(path.join(root, "generated"), { recursive: true });
    await mkdir(path.join(root, "Sources"), { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".archicode", "runtime"), { recursive: true });
    const generatedFiles = new Map([
      ["generated/openapi_client.py", "# generated client\nclass Client: pass\n"],
      ["Sources/GeneratedModels.swift", "// generated models\nstruct Model {}\n"]
    ]);
    for (const [filePath, content] of generatedFiles) {
      await writeFile(path.join(root, filePath), content, "utf8");
    }
    await writeFile(path.join(root, "src", "handwritten.txt"), "important user-authored content\n", "utf8");
    await writeFile(path.join(root, "generated", "mutated.cs"), "// user changed this after generation\n", "utf8");
    const hash = (content: string): string => createHash("sha256").update(content).digest("hex");
    await writeFile(path.join(root, ".archicode", "runtime", "generated-artifacts.json"), JSON.stringify([
      ...[...generatedFiles].map(([filePath, content]) => ({
        path: filePath,
        sha256: hash(content),
        command: "project-specific verify command",
        runId: "run-generator",
        recordedAt: "2026-07-10T18:00:00.000Z",
        source: "verification"
      })),
      {
        path: "generated/mutated.cs",
        sha256: hash("// original generated content\n"),
        command: "another project-specific verify command",
        runId: "run-generator",
        recordedAt: "2026-07-10T18:00:00.000Z",
        source: "verification"
      }
    ], null, 2), "utf8");

    const operations = [...generatedFiles.keys()].map((filePath) => ({
      kind: "propose-source-file" as const,
      path: filePath,
      action: "delete" as const,
      nodeIds: ["node-orchestrator"],
      reason: "Delete generated artifact."
    }));
    for (const operation of operations) {
      await expect(evaluateSourceFileSafety(root, operation)).resolves.toMatchObject({
        safe: true,
        requiresReview: false,
        risk: "low",
        reason: expect.stringContaining("Safe generated-artifact cleanup")
      });
    }
    for (const protectedPath of ["src/handwritten.txt", "generated/mutated.cs"]) {
      await expect(evaluateSourceFileSafety(root, {
      kind: "propose-source-file",
      path: protectedPath,
      action: "delete",
      reason: "Delete generated artifact."
      })).resolves.toMatchObject({
        safe: true,
        requiresReview: true,
        reason: "Deleting a pre-existing or modified file requires explicit permission."
      });
    }

    const persisted = await persistAndMaybeApplyPatchProposal(root, "run-generated-cleanup", JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        runId: "run-generated-cleanup",
        summary: "Remove verified compiler byproducts.",
        operations
      }
    }), { phase: "coding" });

    expect(persisted?.autoApplied).toBe(true);
    for (const operation of operations) {
      await expect(readFile(path.join(root, operation.path), "utf8")).rejects.toThrow();
    }
    await expect(readFile(path.join(root, "src", "handwritten.txt"), "utf8")).resolves.toContain("user-authored");
    await expect(readFile(path.join(root, "generated", "mutated.cs"), "utf8")).resolves.toContain("user changed");
  });

  it("recovers stack-neutral generated-artifact provenance from legacy verification checkpoints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-legacy-generated-cleanup-"));
    const bundle = await ensureProject(root);
    await mkdir(path.join(root, "generated"), { recursive: true });
    const generatedPath = "generated/opaque-output.custom";
    await writeFile(path.join(root, generatedPath), "opaque verification output\n", "utf8");
    const now = Date.now();
    await writeFile(path.join(root, ".archicode", "artifacts", "legacy-provider-diff.json"), JSON.stringify({
      id: "legacy-provider-diff",
      type: "diff",
      title: "Provider source diff",
      path: ".archicode/artifacts/legacy-provider-diff.json",
      runId: "run-legacy-generator",
      createdAt: new Date(now).toISOString(),
      diff: "diff --git a/source.input b/source.input\n--- /dev/null\n+++ b/source.input\n@@\n+input\n"
    }, null, 2), "utf8");
    await writeFile(path.join(root, ".archicode", "runs", "run-legacy-generator.json"), JSON.stringify({
      id: "run-legacy-generator",
      flowId: bundle.project.activeFlowId,
      providerId: "offline-manual",
      status: "failed",
      phase: "complete",
      effort: "high",
      promptSummary: "Legacy provenance recovery fixture",
      permission: { decision: "allowed" },
      implementation: {
        currentBatch: 1,
        maxBatches: 1,
        tasks: [],
        checkpoints: [{
          id: "legacy-checkpoint",
          phase: "coding",
          batchNumber: 1,
          status: "changed",
          sourceDiffArtifactId: "legacy-provider-diff",
          verification: {
            command: "project-specific verify command",
            exitCode: 0,
            passed: true,
            summary: "Verification passed"
          },
          warnings: [],
          quarantinedOperationsCount: 0,
          startedAt: new Date(now - 5_000).toISOString(),
          completedAt: new Date(now + 5_000).toISOString()
        }]
      },
      createdAt: new Date(now - 5_000).toISOString()
    }, null, 2), "utf8");

    await expect(evaluateSourceFileSafety(root, {
      kind: "propose-source-file",
      path: generatedPath,
      action: "delete",
      reason: "Clean up generated verification output."
    })).resolves.toMatchObject({
      safe: true,
      requiresReview: false,
      reason: expect.stringContaining("project-specific verify command")
    });
  });

  it("surfaces malformed provider handoffs as recoverable proposals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-invalid-handoff-"));
    await ensureProject(root);
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Broken handoff.",
        operations: [
          {
            kind: "write-file",
            path: "src/app.ts",
            content: "export const app = true;\n"
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(root, "run-invalid-handoff", output);

    expect(persisted?.pendingReview).toBe(true);
    expect(persisted?.valid).toBe(false);
    expect(persisted?.hasSourceFileOperations).toBe(false);
    expect(persisted?.artifact.summary).toContain("could not safely use");
    const artifactText = await readFile(path.join(root, persisted!.artifact.path), "utf8");
    expect(artifactText).toContain("rawProviderOutput");
    expect(artifactText).toContain("Retry handoff");
  });

  it("surfaces malformed direct provider handoffs as recoverable proposals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-invalid-direct-handoff-"));
    await ensureProject(root);
    const output = JSON.stringify({
      schemaVersion: 1,
      summary: "Broken direct handoff.",
      operations: [
        {
          kind: "write-file",
          path: "src/app.ts",
          content: "export const app = true;\n"
        }
      ]
    });

    const persisted = await persistAndMaybeApplyPatchProposal(root, "run-invalid-direct-handoff", output, {
      phase: "coding"
    });

    expect(persisted?.pendingReview).toBe(true);
    expect(persisted?.valid).toBe(false);
    expect(persisted?.artifact.summary).toContain("could not safely use");
    const artifactText = await readFile(path.join(root, persisted!.artifact.path), "utf8");
    expect(artifactText).toContain("rawProviderOutput");
    expect(artifactText).toContain("did not include usable propose-source-file operations");
  });

  it("treats convention files as normal coding source-file proposals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-convention-source-files-"));
    await ensureProject(root);
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Create project convention files.",
        operations: [
          {
            kind: "propose-source-file",
            path: ".gitignore",
            action: "create",
            content: "node_modules/\ndist/\n",
            nodeIds: ["node-orchestrator"],
            reason: "Ignore generated dependency and build folders."
          },
          {
            kind: "propose-source-file",
            path: "README.md",
            action: "create",
            content: "# Test App\n",
            nodeIds: ["node-orchestrator"],
            reason: "Document the starter app."
          },
          {
            kind: "propose-source-file",
            path: "AGENTS.md",
            action: "create",
            content: "# Agent Notes\n",
            nodeIds: ["node-orchestrator"],
            reason: "Record local agent guidance."
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(root, "run-conventions", output, {
      phase: "coding"
    });

    expect(persisted?.valid).toBe(true);
    expect(persisted?.autoApplied).toBe(true);
    await expect(readFile(path.join(root, ".gitignore"), "utf8")).resolves.toContain("node_modules");
    await expect(readFile(path.join(root, "README.md"), "utf8")).resolves.toContain("Test App");
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).resolves.toContain("Agent Notes");
  });

  it("auto-applies direct fenced coding handoffs with array notes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-direct-source-handoff-"));
    await ensureProject(root);
    const output = [
      "```json",
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-old",
        summary: "Create a direct source handoff.",
        runSummary: {
          implementationStatus: "complete",
          notes: [
            "The provider returned a direct JSON patch.",
            "Source proposals should still be applied."
          ]
        },
        operations: [
          {
            kind: "propose-source-file",
            path: "src/main.ts",
            action: "create",
            content: "export const ready = true;\n",
            nodeIds: ["node-orchestrator"],
            reason: "Implement the entrypoint.",
            testIntent: "Imported by future tests."
          }
        ]
      }, null, 2),
      "```"
    ].join("\n");

    const persisted = await persistAndMaybeApplyPatchProposal(root, "run-direct-handoff", output, {
      phase: "coding"
    });

    expect(persisted?.valid).toBe(true);
    expect(persisted?.autoApplied).toBe(true);
    expect(persisted?.implementationNotes).toContain("direct JSON patch");
    await expect(readFile(path.join(root, "src/main.ts"), "utf8")).resolves.toContain("ready");
  });

  it("salvages valid coding source proposals and quarantines optional non-source metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-source-quarantine-"));
    await ensureProject(root);
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Create source and noisy metadata.",
        operations: [
          {
            kind: "propose-source-file",
            path: "src/app.ts",
            action: "create",
            content: "export const app = 'ready';\n",
            nodeIds: ["node-orchestrator"],
            reason: "Implement the app entry."
          },
          {
            kind: "propose-project-file",
            path: "NOT_SOURCE_CHANGE.md",
            mode: "create",
            content: "# Should be quarantined\n",
            reason: "Real project files must use propose-source-file during coding."
          },
          {
            kind: "add-note",
            nodeId: "node-orchestrator",
            noteKind: "system-note",
            author: "llm",
            category: "note",
            priority: "normal",
            body: "Run-level note that should remain separate from source changes."
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(root, "run-source-quarantine", output, {
      phase: "coding"
    });
    const proposals = await listPatchProposals(root);

    expect(persisted?.valid).toBe(true);
    expect(persisted?.autoApplied).toBe(true);
    expect(persisted?.warnings).toEqual([
      expect.stringContaining("operation 1 propose-project-file quarantined"),
      expect.stringContaining("operation 2 add-note quarantined")
    ]);
    await expect(readFile(path.join(root, "src/app.ts"), "utf8")).resolves.toContain("ready");
    await expect(readFile(path.join(root, "NOT_SOURCE_CHANGE.md"), "utf8")).rejects.toThrow();
    expect(proposals[0]?.proposal).toMatchObject({
      operations: [
        expect.objectContaining({
          kind: "propose-source-file",
          path: "src/app.ts"
        })
      ]
    });
    const artifactText = await readFile(path.join(root, persisted!.artifact.path), "utf8");
    expect(artifactText).toContain("codingHandoff");
    expect(artifactText).toContain("quarantinedOperations");
  });

  it("auto-applies a new package.json scaffold but still reviews replacements", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-package-scaffold-"));
    await ensureProject(root);

    const createSafety = await evaluateSourceFileSafety(root, {
      kind: "propose-source-file",
      path: "package.json",
      action: "create",
      content: JSON.stringify({ scripts: { dev: "vite", build: "vite build" }, dependencies: { "@vitejs/plugin-vue": "latest" } })
    });
    expect(createSafety.safe).toBe(true);
    expect(createSafety.requiresReview).toBe(false);

    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }), "utf8");
    const replaceSafety = await evaluateSourceFileSafety(root, {
      kind: "propose-source-file",
      path: "package.json",
      action: "replace",
      content: JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }),
      baseSha256: "mismatch"
    });
    expect(replaceSafety.requiresReview).toBe(true);
  });

  it("creates explicit debugging runs for failed work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-debug-run-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });
    const failed = {
      id: "run-failed",
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      providerId: "openai-compatible",
      status: "failed" as const,
      phase: "complete" as const,
      promptSummary: "Broken build",
      scope: { kind: "flow" as const, flowId: "flow-main", nodeIds: ["node-orchestrator"], label: "Main flow repair" },
      permission: { decision: "allowed" as const },
      contextArtifacts: [],
      planArtifactIds: [],
      sourceDiffArtifactIds: [],
      affectedNodeIds: ["node-orchestrator"],
      plannedCommands: [],
      plannedAllowedRoots: [root],
      reviewDecisions: [],
      todos: [],
      logs: [{ at: new Date().toISOString(), stream: "stderr" as const, text: "Expected failure" }],
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(path.join(root, ".archicode", "runs"), { recursive: true })
        .then(() => writeFile(path.join(root, ".archicode", "runs", `${failed.id}.json`), `${JSON.stringify(failed, null, 2)}\n`, "utf8"))
    );

    const succeeded = { ...failed, id: "run-succeeded", status: "succeeded" as const };
    await writeFile(path.join(root, ".archicode", "runs", `${succeeded.id}.json`), `${JSON.stringify(succeeded, null, 2)}\n`, "utf8");
    await expect(startDebuggingRun(root, succeeded.id)).rejects.toThrow("can only start from a failed run");

    const result = await startDebuggingRun(root, failed.id);
    const debugRun = result.bundle.runs.find((run) => run.id === result.runId);

    expect(debugRun?.status).toBe("debugging");
    expect(debugRun?.phase).toBe("debugging");
    expect(debugRun?.retryOf).toBe(failed.id);
    expect(debugRun?.scope).toEqual(failed.scope);

  });

  it("stores manual bug reports as open debug incidents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-report-bug-"));
    await ensureProject(root);

    const bundle = await reportBug({
      projectRoot: root,
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      title: "Todo save fails",
      description: "Saving a todo returns an internal server error.",
      priority: "high"
    });

    expect(bundle.incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "manual-report",
        status: "open",
        title: "Todo save fails",
        priority: "high",
        nodeId: "node-orchestrator"
      })
    ]));
  });

  it("edits and resolves manual bug reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-edit-bug-"));
    await ensureProject(root);
    const reported = await reportBug({
      projectRoot: root,
      flowId: "flow-main",
      title: "Original title",
      description: "Original description",
      priority: "normal"
    });
    const incident = reported.incidents[0]!;

    const edited = await updateBugIncident({
      projectRoot: root,
      incidentId: incident.id,
      patch: { title: "Clear title", description: "Clear reproduction steps", priority: "urgent" }
    });
    expect(edited.incidents.find((item) => item.id === incident.id)).toEqual(expect.objectContaining({
      title: "Clear title",
      description: "Clear reproduction steps",
      priority: "urgent",
      status: "open"
    }));

    const resolved = await updateBugIncident({ projectRoot: root, incidentId: incident.id, patch: { status: "resolved" } });
    expect(resolved.incidents.find((item) => item.id === incident.id)?.status).toBe("resolved");
  });

  it("starts incident debugging with only the selected bug reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-selected-bugs-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });
    const first = await reportBug({ projectRoot: root, flowId: "flow-main", title: "FIX THIS ONE", description: "Selected details." });
    const selectedId = first.incidents.find((item) => item.title === "FIX THIS ONE")!.id;
    await reportBug({ projectRoot: root, flowId: "flow-main", title: "DO NOT INCLUDE", description: "Unselected details." });

    const result = await startIncidentDebugRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      incidentIds: [selectedId]
    });
    const debugRun = result.bundle.runs.find((run) => run.id === result.runId)!;
    expect(debugRun.logs.some((line) => line.text.includes("FIX THIS ONE"))).toBe(true);
    expect(debugRun.logs.some((line) => line.text.includes("DO NOT INCLUDE"))).toBe(false);
    expect(debugRun.logs.some((line) => line.text.includes("1 open incident"))).toBe(true);
  });

  it("starts incident debugging from open bug notes and reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-incident-debug-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "openai-compatible"
        ? { ...provider, enabled: true, apiKeyEnv: "ARCHICODE_TEST_OPENAI_KEY" }
        : { ...provider, enabled: false })
    });
    await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      kind: "user-note",
      author: "user",
      body: "The app crashes when a todo is added.",
      category: "bug",
      priority: "urgent",
      resolved: false
    });
    await reportBug({
      projectRoot: root,
      flowId: "flow-main",
      title: "Runtime shows 500",
      description: "The browser displays Internal server error after Run App.",
      priority: "high"
    });
    const mainFlow = bundle.flows[0]!;
    await writeFile(path.join(root, ".archicode", "flows", "flow-secondary.json"), JSON.stringify({
      ...mainFlow,
      id: "flow-secondary",
      name: "Secondary",
      nodes: mainFlow.nodes.map((node) => ({ ...node, id: `${node.id}-secondary` })),
      edges: mainFlow.edges.map((edge) => ({
        ...edge,
        id: `${edge.id}-secondary`,
        source: `${edge.source}-secondary`,
        target: `${edge.target}-secondary`
      }))
    }, null, 2), "utf8");
    await addNote(root, {
      flowId: "flow-secondary",
      nodeId: "node-orchestrator-secondary",
      kind: "user-note",
      author: "user",
      body: "SECONDARY FLOW BUG MUST NOT LEAK",
      category: "bug",
      priority: "urgent",
      resolved: false
    });
    await reportBug({
      projectRoot: root,
      flowId: "flow-secondary",
      title: "SECONDARY FLOW INCIDENT MUST NOT LEAK",
      description: "Unrelated failure.",
      priority: "high"
    });

    const result = await startIncidentDebugRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "openai-compatible",
      guidance: {
        text: "Focus on the bug notes and keep the repair narrow.",
        evidence: ["node-notes"],
        source: "research-agent"
      }
    });
    const debugRun = result.bundle.runs.find((run) => run.id === result.runId);

    expect(debugRun?.status).toBe("debugging");
    expect(debugRun?.phase).toBe("debugging");
    expect(debugRun?.promptSummary).toBe("Debug open flagged bugs and failed incidents");
    expect(debugRun?.guidance?.source).toBe("research-agent");
    expect(debugRun?.guidance?.text).toContain("repair narrow");
    expect(debugRun?.affectedNodeIds).toContain("node-orchestrator");
    expect(debugRun?.scope).toEqual(expect.objectContaining({ kind: "nodes", flowId: "flow-main", nodeIds: ["node-orchestrator"] }));
    expect(debugRun?.logs.some((line) => line.text.includes("AI Debug started with 2 open incidents"))).toBe(true);
    expect(debugRun?.logs.some((line) => line.text.includes("Research agent incident debug guidance was attached."))).toBe(true);
    expect(debugRun?.logs.some((line) => line.text.includes("The app crashes when a todo is added"))).toBe(true);
    expect(debugRun?.logs.some((line) => line.text.includes("SECONDARY FLOW"))).toBe(false);
  });
});
