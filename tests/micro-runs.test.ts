import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeMicroRun,
  getConflictedFiles,
  isFileConflicted,
  resolveMicroRunProvider,
  runGitCommand,
  runVerificationCommand
} from "../src/main/microRuns";
import { graphReconciliationAgent } from "../src/main/microRunAgents/graphReconciliation";
import { mergeResolutionAgent, picassoGraphAgent, registerAllMicroRunAgents, sherlockResearchAgent } from "../src/main/microRunAgents";
import { investigationToolProgressMessage } from "../src/main/microRunAgents/readOnlyTools";
import { microRunResultText } from "../src/main/research/inspectionTools";
import { providerSettingsSchema, type GraphReconciliationOutput, type MicroRunKind, type ProjectBundle, type ProjectSettings } from "../src/shared/schema";

const execAsync = promisify(exec);

registerAllMicroRunAgents();

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

// Minimal Anthropic streaming response carrying a single final text block.
function streamingAnthropicText(text: string): Response {
  return sseResponse([
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
  ]);
}

function streamingAnthropicToolUse(name: string, input: unknown = {}): Response {
  return sseResponse([
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name, input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
  ]);
}

function fakeAnthropicProvider(): ProjectSettings["providers"][number] {
  return providerSettingsSchema.parse({
    id: "anthropic-test",
    kind: "anthropic-compatible",
    label: "Anthropic Test",
    model: "claude-sonnet-test",
    apiKey: "test-key",
    enabled: true
  });
}

function fakeOpenAIResponsesProvider(): ProjectSettings["providers"][number] {
  return providerSettingsSchema.parse({
    id: "openrouter-responses-test",
    kind: "openai-compatible",
    label: "OpenRouter Responses Test",
    model: "qwen/test",
    baseUrl: "https://openrouter.test/api/v1",
    openAiEndpointMode: "responses",
    apiKey: "test-key",
    enabled: true
  });
}

function fakeBundle(): ProjectBundle {
  return {
    project: {
      id: "proj-1",
      name: "Test Project",
      settings: {
        agentTools: { projectFiles: true, runArtifacts: true, console: true, subagents: { mergeConflictResolution: true, graphReconciliation: true, sherlockResearch: true } },
        webSearch: { enabled: false, provider: "native" }
      }
    },
    flows: []
  } as unknown as ProjectBundle;
}

function richPicassoNode(id: string, type: string, title: string) {
  return {
    id,
    type,
    title,
    description: `${title} owns a clearly bounded architectural responsibility and coordinates the inputs, outputs, and interactions needed by neighboring capabilities. It also defines operational constraints, failure behavior, and the observable outcomes required before implementation can be considered complete.`,
    visual: { shape: type === "data-store" ? "database" : "hexagon", backgroundColor: "#4f83cc" },
    techStack: ["TypeScript", "REST/JSON"],
    acceptanceCriteria: [`${title} exposes its documented behavior`, `${title} handles expected failure conditions`]
  };
}

function richPicassoFlow(id: string, name: string) {
  return {
    id,
    name,
    description: `${name} defines a bounded product and architecture perspective with clear responsibilities, participating actors, and coordinated capabilities. It also documents how this area exchanges information with neighboring flows while keeping its own implementation and validation concerns explicit.`,
    ignored: false,
    nodes: [],
    edges: [],
    subflows: [],
    groups: [],
    updatedAt: ""
  };
}

function arraySchemasMissingItems(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => arraySchemasMissingItems(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];

  const schema = value as Record<string, unknown>;
  const missing = schema.type === "array" && !("items" in schema) ? [path] : [];
  return [
    ...missing,
    ...Object.entries(schema).flatMap(([key, item]) => arraySchemasMissingItems(item, `${path}.${key}`))
  ];
}

async function tmpRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "archicode-microruns-"));
  await execAsync("git init -q", { cwd: root });
  await execAsync("git config user.email test@example.com", { cwd: root });
  await execAsync("git config user.name Test", { cwd: root });
  return root;
}

async function createMergeConflict(root: string): Promise<void> {
  await writeFile(path.join(root, "shared.txt"), "base\n", "utf8");
  await execAsync("git add shared.txt && git commit -q -m base", { cwd: root });
  await execAsync("git checkout -q -b feature", { cwd: root });
  await writeFile(path.join(root, "shared.txt"), "feature change\n", "utf8");
  await execAsync("git commit -q -am feature", { cwd: root });
  await execAsync("git checkout -q main || git checkout -q master", { cwd: root });
  await writeFile(path.join(root, "shared.txt"), "main change\n", "utf8");
  await execAsync("git commit -q -am main-change", { cwd: root });
  await execAsync("git merge feature", { cwd: root }).catch(() => undefined);
}

describe("executeMicroRun", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails fast when no agent is registered for the requested kind", async () => {
    const result = await executeMicroRun(
      "/nonexistent",
      "not-a-real-kind" as MicroRunKind,
      {},
      {} as ProjectSettings["providers"][number],
      {} as ProjectBundle
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/No micro-run agent registered/);
  });

  it("resolves independent subagent models while Default inherits the invoking provider model", () => {
    const seed = fakeAnthropicProvider();
    const chatSelectedProvider = {
      ...seed,
      model: "claude-chat-selected",
      detectedAvailableModels: ["claude-chat-selected", "claude-picasso"],
      phaseModelPolicies: {
        ...seed.phaseModelPolicies,
        brainstorming: { ...seed.phaseModelPolicies.brainstorming, modelOverride: "claude-chat-selected" }
      }
    };
    const inherited = resolveMicroRunProvider(chatSelectedProvider, "graph-reconciliation");
    const overridden = resolveMicroRunProvider({
      ...chatSelectedProvider,
      subagentModelPolicies: {
        ...chatSelectedProvider.subagentModelPolicies,
        picasso: { ...chatSelectedProvider.subagentModelPolicies.picasso, modelOverride: "claude-picasso" }
      }
    }, "graph-reconciliation");
    const stale = resolveMicroRunProvider({
      ...chatSelectedProvider,
      subagentModelPolicies: {
        ...chatSelectedProvider.subagentModelPolicies,
        picasso: { ...chatSelectedProvider.subagentModelPolicies.picasso, modelOverride: "claude-removed" }
      }
    }, "graph-reconciliation");

    expect(inherited.model).toBe("claude-chat-selected");
    expect(inherited.phaseModelPolicies.brainstorming.modelOverride).toBeUndefined();
    expect(overridden.phaseModelPolicies.brainstorming.modelOverride).toBe("claude-picasso");
    expect(stale.phaseModelPolicies.brainstorming.modelOverride).toBeUndefined();
  });

  it("retries once on a transient transport failure ('terminated') then succeeds", async () => {
    const output = JSON.stringify({
      graphChangeSet: null,
      nodesAffected: [],
      reconciliationReport: "No discrepancies found.",
      discrepancies: []
    });
    const fetchMock = vi.fn()
      // First provider attempt: the socket drops mid-request.
      .mockRejectedValueOnce(new Error("terminated"))
      // Retry succeeds, reads the graph, then returns the final report.
      .mockResolvedValueOnce(streamingAnthropicToolUse("picasso_read_graph"))
      .mockResolvedValue(streamingAnthropicText(output));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeMicroRun(
      "/nonexistent",
      "graph-reconciliation",
      { resolvedFiles: ["src/a.ts"], resolutionSummary: "done", verificationResult: "passed" },
      fakeAnthropicProvider(),
      fakeBundle()
    );

    expect(fetchMock.mock.calls.length).toBe(3);
    expect(result.status).toBe("completed");
    expect((result.output as GraphReconciliationOutput).reconciliationReport).toContain("No discrepancies");
  });

  it("gives up (fails) after a second transient failure without a third attempt", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("terminated"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeMicroRun(
      "/nonexistent",
      "graph-reconciliation",
      { resolvedFiles: ["src/a.ts"], resolutionSummary: "done", verificationResult: "passed" },
      fakeAnthropicProvider(),
      fakeBundle()
    );

    expect(fetchMock.mock.calls.length).toBe(2);
    expect(result.status).toBe("failed");
  });

  it("places an isolated subagent identity in the real provider system prompt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicToolUse("picasso_read_graph"))
      .mockResolvedValueOnce(streamingAnthropicToolUse("propose_graph_change_set", {
        summary: "Create a new flow",
        operations: [{
          kind: "create-flow",
          flow: richPicassoFlow("flow-new", "New Flow")
        }]
      }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = fakeAnthropicProvider();
    const result = await executeMicroRun(
      "/nonexistent",
      "graph-reconciliation",
      { objective: "Create a new top-level flow", mode: "design" },
      {
        ...provider,
        detectedAvailableModels: [provider.model!, "claude-picasso"],
        subagentModelPolicies: {
          ...provider.subagentModelPolicies,
          picasso: { ...provider.subagentModelPolicies.picasso, modelOverride: "claude-picasso" }
        }
      },
      fakeBundle()
    );

    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as {
      model?: string;
      system?: Array<{ text?: string }>;
      messages?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const systemText = (firstBody.system ?? []).map((block) => block.text ?? "").join("\n");
    const userText = (firstBody.messages ?? []).flatMap((message) => message.content ?? []).map((block) => block.text ?? "").join("\n");
    expect(result.status).toBe("completed");
    expect(systemText).toContain("You are Picasso");
    expect(systemText).toContain("LONG-RUN EXECUTION POLICY");
    expect(systemText).toContain("bounded, verifiable units");
    expect(systemText).not.toContain("Your name is Archi");
    expect(userText).not.toContain("You are Picasso");
    expect(firstBody.model).toBe("claude-picasso");
  });

  it("carries Picasso's full tool transcript across stateless Responses requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "resp-read-graph",
        status: "completed",
        output: [{ type: "function_call", call_id: "call-read-graph", name: "picasso_read_graph", arguments: "{}" }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "resp-batch-one",
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call-batch-one",
          name: "picasso_submit_graph_batch",
          arguments: JSON.stringify({
            summary: "Create the first confirmed flow",
            operations: [{
              kind: "create-flow", flow: richPicassoFlow("flow-one", "Flow One")
            }]
          })
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "resp-propose",
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call-propose",
          name: "propose_graph_change_set",
          arguments: JSON.stringify({
            summary: "Create the confirmed flows",
            operations: [{
              kind: "create-flow", flow: richPicassoFlow("flow-two", "Flow Two")
            }]
          })
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeMicroRun(
      "/nonexistent",
      "graph-reconciliation",
      { objective: "Create the confirmed top-level flow", mode: "design" },
      fakeOpenAIResponsesProvider(),
      fakeBundle()
    );

    const continuation = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
    const continuationText = JSON.stringify(continuation.input);
    expect(result.status).toBe("completed");
    expect((result.output as GraphReconciliationOutput).graphChangeSet?.operations).toHaveLength(2);
    expect(continuation.previous_response_id).toBeUndefined();
    expect(continuationText).toContain("Create the confirmed top-level flow");
    expect(continuationText).toContain('"type":"function_call"');
    expect(continuationText).toContain('"type":"function_call_output"');
    expect(continuationText).toContain("call-read-graph");
    const finalRequest = JSON.parse(fetchMock.mock.calls[2]![1]!.body as string) as Record<string, unknown>;
    expect(JSON.stringify(finalRequest.input)).toContain("picasso_submit_graph_batch");
    expect(JSON.stringify(finalRequest.input)).toContain("call-batch-one");
  });

  it("continues an OpenAI Responses tool loop after a rejected Picasso final batch", async () => {
    const progress: string[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "resp-read-graph",
        status: "completed",
        output: [{ type: "function_call", call_id: "call-read-graph", name: "picasso_read_graph", arguments: "{}" }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "resp-rejected-final",
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call-rejected-final",
          name: "propose_graph_change_set",
          arguments: JSON.stringify({
            summary: "Reference a missing flow",
            operations: [{ kind: "create-edge", flowId: "flow-missing", edge: { source: "a", target: "b", label: "invokes" } }]
          })
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "resp-corrected-final",
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call-corrected-final",
          name: "propose_graph_change_set",
          arguments: JSON.stringify({
            summary: "Create the valid flow",
            operations: [{ kind: "create-flow", flow: richPicassoFlow("flow-valid", "Valid Flow") }]
          })
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeMicroRun(
      "/nonexistent",
      "graph-reconciliation",
      { objective: "Create one valid flow", mode: "design" },
      fakeOpenAIResponsesProvider(),
      fakeBundle(),
      { onProgress: (message) => progress.push(message) }
    );

    expect(result.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.diagnostics?.repairAttempted).toBeUndefined();
    expect((result.output as GraphReconciliationOutput).graphChangeSet?.operations).toHaveLength(1);
    expect(progress).toEqual(expect.arrayContaining([
      expect.stringContaining("Rejected final graph batch"),
      expect.stringContaining("Submitted final graph batch B1")
    ]));
    const correctionRequest = JSON.parse(fetchMock.mock.calls[2]![1]!.body as string) as Record<string, unknown>;
    expect(JSON.stringify(correctionRequest.input)).toContain("Tool error: Batch rejected before assembly");
  });

  it("repairs one Picasso completion that read the graph but omitted the proposal tool", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicToolUse("picasso_read_graph"))
      .mockResolvedValueOnce(streamingAnthropicText("I reviewed the graph and the design is ready."))
      .mockResolvedValueOnce(streamingAnthropicToolUse("propose_graph_change_set", {
        summary: "Create a new flow",
        operations: [{
          kind: "create-flow",
          flow: richPicassoFlow("flow-new", "New Flow")
        }]
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeMicroRun(
      "/nonexistent",
      "graph-reconciliation",
      { objective: "Create a new top-level flow", mode: "design" },
      fakeAnthropicProvider(),
      fakeBundle()
    );

    expect(result.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.diagnostics?.repairAttempted).toBe(true);
    expect(result.diagnostics?.validationErrors?.[0]).toContain("without submitting");
    expect(result.diagnostics?.toolCallNames).toEqual(["picasso_read_graph", "propose_graph_change_set"]);
  });

  it("rejects malformed Picasso batches immediately, retains valid checkpoints, and continues after a rejected final batch", async () => {
    const flow = richPicassoFlow;
    const progress: string[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingAnthropicToolUse("picasso_read_graph"))
      .mockResolvedValueOnce(streamingAnthropicToolUse("picasso_submit_graph_batch", {
        summary: "Unsupported deletion",
        operations: [{ kind: "delete-flow", flowId: "flow-extra" }]
      }))
      .mockResolvedValueOnce(streamingAnthropicToolUse("picasso_submit_graph_batch", {
        summary: "Create the first valid flow",
        operations: [{ kind: "create-flow", flow: flow("flow-one", "Flow One") }]
      }))
      .mockResolvedValueOnce(streamingAnthropicToolUse("propose_graph_change_set", {
        summary: "Invalid flow-only note",
        operations: [{ kind: "add-note", note: { flowId: "flow-one", body: "Needs a node target." } }]
      }))
      .mockResolvedValueOnce(streamingAnthropicToolUse("propose_graph_change_set", {
        summary: "Create the final valid flow",
        operations: [{ kind: "create-flow", flow: flow("flow-two", "Flow Two") }]
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeMicroRun(
      "/nonexistent",
      "graph-reconciliation",
      { objective: "Create two confirmed flows", mode: "design" },
      fakeAnthropicProvider(),
      fakeBundle(),
      { onProgress: (message) => progress.push(message) }
    );

    expect(result.status).toBe("completed");
    expect((result.output as GraphReconciliationOutput).graphChangeSet?.operations).toHaveLength(2);
    expect((result.output as GraphReconciliationOutput).graphChangeSet?.operations.map((operation: { kind: string }) => operation.kind)).toEqual(["create-flow", "create-flow"]);
    expect(result.diagnostics?.repairAttempted).toBeUndefined();
    expect(progress.filter((line) => /^Submitted (?:final )?graph batch B\d+/.test(line))).toHaveLength(2);
    expect(progress).toEqual(expect.arrayContaining([
      expect.stringContaining("Rejected graph batch"),
      expect.stringContaining("Submitted graph batch B1"),
      expect.stringContaining("Rejected final graph batch"),
      expect.stringContaining("Submitted final graph batch B2")
    ]));
  });
});

describe("graph reconciliation output parsing", () => {
  it("documents selective note pinning in the reconciliation prompt", () => {
    const prompt = graphReconciliationAgent.systemPrompt(
      { resolvedFiles: ["src/a.ts"], resolutionSummary: "Merged hero copy", verificationResult: "passed" },
      { projectRoot: "/tmp/project", bundle: fakeBundle(), provider: fakeAnthropicProvider() }
    );

    expect(prompt).toContain("Note pinning policy");
    expect(prompt).toContain("use pinned: true for important decisions");
    expect(prompt).toContain("Use pinned: false for traceability");
    expect(prompt).toContain("Never say a note is pinned unless the add-note operation sets pinned: true");
  });

  it("recovers the change set from the propose_graph_change_set tool call when the final text has no JSON", () => {
    const parsed = graphReconciliationAgent.parseOutput(
      "All done — I've proposed the graph updates.",
      [
        { providerToolName: "read_resolved_file", argumentsJson: JSON.stringify({ filePath: "src/a.ts" }) },
        {
          providerToolName: "propose_graph_change_set",
          argumentsJson: JSON.stringify({
            summary: "Update landing node after merge",
            operations: [{ kind: "update-node", flowId: "flow-main", nodeId: "node-landing", patch: { description: "new" } }]
          })
        }
      ]
    ) as GraphReconciliationOutput;

    expect(parsed.graphChangeSet?.summary).toBe("Update landing node after merge");
    expect(parsed.graphChangeSet?.operations).toHaveLength(1);
    expect(parsed.reconciliationReport).toContain("recovered");
  });

  it("prefers the final JSON text's change set when present", () => {
    const parsed = graphReconciliationAgent.parseOutput(
      JSON.stringify({
        graphChangeSet: { summary: "From final text", operations: [{ kind: "add-note" }] },
        nodesAffected: ["n1"],
        reconciliationReport: "Done.",
        discrepancies: []
      }),
      [{ providerToolName: "propose_graph_change_set", argumentsJson: JSON.stringify({ summary: "From tool", operations: [{ kind: "update-node" }] }) }]
    ) as GraphReconciliationOutput;

    expect(parsed.graphChangeSet?.summary).toBe("From final text");
  });
});

describe("Sherlock and Picasso contracts", () => {
  it("describes read-only tool targets instead of repeating generic tool names", () => {
    expect(investigationToolProgressMessage("archicode_project_read_file", { path: "src/router.ts", startLine: 10, endLine: 40 }))
      .toBe("Reading src/router.ts (lines 10–40)");
    expect(investigationToolProgressMessage("archicode_project_search_files", { query: "createRouter", directory: "src" }))
      .toBe("Searching src for “createRouter”");
    expect(investigationToolProgressMessage("archicode_project_list_files", { path: "src", recursive: true }))
      .toBe("Listing src recursively");
    expect(investigationToolProgressMessage("archicode_web_open_url", { url: "https://example.com/docs" }))
      .toBe("Opening https://example.com/docs");
  });

  it("reports meaningful Picasso graph-read and proposal progress", async () => {
    const progress: string[] = [];
    const context = {
      projectRoot: "/tmp/project",
      bundle: fakeBundle(),
      provider: fakeAnthropicProvider(),
      onProgress: (message: string) => progress.push(message)
    };
    const tools = picassoGraphAgent.tools(context, {
      objective: "Refine routing responsibilities",
      mode: "refine",
      scope: { flowId: "flow-main", nodeIds: ["node-router"] }
    });

    await tools.find((tool) => tool.providerToolName === "picasso_read_graph")!.handler({});
    await tools.find((tool) => tool.providerToolName === "propose_graph_change_set")!.handler({
      summary: "Refine routing",
      operations: [{
        kind: "create-flow",
        flow: richPicassoFlow("flow-new", "New Flow")
      }]
    });

    expect(progress).toEqual([
      "Reading graph scope for flow flow-main (1 selected node)",
      "Submitted final graph batch B1 “Refine routing” with 1 operation; assembling the review card"
    ]);
  });

  it("projects accepted Picasso batches into later graph reads without mutating the persisted bundle", async () => {
    const progress: string[] = [];
    const bundle = fakeBundle();
    bundle.flows = [richPicassoFlow("flow-main", "Original Flow")];
    const context = {
      projectRoot: "/tmp/project",
      bundle,
      provider: fakeAnthropicProvider(),
      onProgress: (message: string) => progress.push(message)
    };
    const tools = picassoGraphAgent.tools(context, {
      objective: "Build the first architecture flow in batches",
      mode: "design",
      scope: { flowId: "flow-main" }
    });
    const batch = tools.find((tool) => tool.providerToolName === "picasso_submit_graph_batch")!;
    const read = tools.find((tool) => tool.providerToolName === "picasso_read_graph")!;

    await batch.handler({
      summary: "Rename and populate Flow A",
      operations: [
        { kind: "update-flow", flowId: "flow-main", patch: { name: "Flow A" } },
        { kind: "create-node", flowId: "flow-main", node: richPicassoNode("node-actor", "actor", "Operator") },
        { kind: "create-node", flowId: "flow-main", node: richPicassoNode("node-service", "service", "Trip Service") },
        { kind: "create-edge", flowId: "flow-main", edge: { id: "edge-operates", source: "node-actor", target: "node-service", label: "operates" } }
      ]
    });
    const projected = await read.handler({}) as {
      checkpoint: { state: string; acceptedBatches: number; acceptedOperations: number; instruction: string };
      flows: ProjectBundle["flows"];
    };

    expect(projected.checkpoint).toMatchObject({
      state: "staged-not-applied",
      acceptedBatches: 1,
      acceptedOperations: 4
    });
    expect(projected.checkpoint.instruction).toContain("Do not recreate or replace this staged work");
    expect(projected.flows[0]).toMatchObject({
      id: "flow-main",
      name: "Flow A",
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "node-actor", title: "Operator" }),
        expect.objectContaining({ id: "node-service", title: "Trip Service" })
      ]),
      edges: [expect.objectContaining({ id: "edge-operates", source: "node-actor", target: "node-service" })]
    });
    expect(bundle.flows[0]).toMatchObject({ name: "Original Flow", nodes: [], edges: [] });
    expect(progress).toContain("Reading graph scope for flow flow-main with staged checkpoint B1 (4 accepted operations)");
  });

  it("repairs safe Picasso visual-shape aliases without rejecting the graph batch", async () => {
    const progress: string[] = [];
    const context = {
      projectRoot: "/tmp/project",
      bundle: fakeBundle(),
      provider: fakeAnthropicProvider(),
      onProgress: (message: string) => progress.push(message)
    };
    const batch = picassoGraphAgent.tools(context, {
      objective: "Create a workflow-oriented trip flow",
      mode: "design"
    }).find((tool) => tool.providerToolName === "picasso_submit_graph_batch")!;
    const args = {
      summary: "Create Trip Flow with a workflow node",
      operations: [
        { kind: "create-flow", flow: richPicassoFlow("flow-trip", "Trip Flow") },
        {
          kind: "create-node",
          flowId: "flow-trip",
          node: {
            ...richPicassoNode("node-lifecycle", "workflow", "Trip Lifecycle"),
            visual: { shape: "workflow", backgroundColor: "#4f83cc" }
          }
        }
      ]
    };

    await expect(batch.handler(args)).resolves.toMatchObject({ acceptedForAssembly: true, batchNumber: 1 });
    expect(args.operations[1]).toMatchObject({ node: { type: "workflow", visual: { shape: "rounded" } } });
    expect(progress).toContainEqual(expect.stringContaining("Normalized 1 safe visual-shape alias"));
    expect(progress).toContainEqual(expect.stringContaining("Submitted graph batch B1"));
    expect(progress.some((line) => line.startsWith("Rejected graph batch"))).toBe(false);
  });

  it("counts only validated Picasso batches and rejects unsupported, cross-flow, and flow-only-note operations", async () => {
    const progress: string[] = [];
    const context = {
      projectRoot: "/tmp/project",
      bundle: fakeBundle(),
      provider: fakeAnthropicProvider(),
      onProgress: (message: string) => progress.push(message)
    };
    const tools = picassoGraphAgent.tools(context, { objective: "Create a graph in batches", mode: "design" });
    const batch = tools.find((tool) => tool.providerToolName === "picasso_submit_graph_batch")!;
    const final = tools.find((tool) => tool.providerToolName === "propose_graph_change_set")!;

    await expect(batch.handler({
      summary: "Delete an extra flow",
      operations: [{ kind: "delete-flow", flowId: "flow-extra" }]
    })).rejects.toThrow("Batch rejected before assembly");

    await batch.handler({
      summary: "Create a valid flow and node",
      operations: [
        { kind: "create-flow", flow: richPicassoFlow("flow-new", "New Flow") },
        { kind: "create-node", flowId: "flow-new", node: richPicassoNode("node-one", "service", "Node One") }
      ]
    });

    await expect(batch.handler({
      summary: "Attempt a cross-flow edge",
      operations: [{ kind: "create-edge", flowId: "flow-new", edge: { source: "node-one", target: "node-in-other-flow", label: "invokes" } }]
    })).rejects.toThrow("must connect two nodes in the same top-level flow");
    await expect(final.handler({
      summary: "Attempt a flow-only note",
      operations: [{ kind: "add-note", note: { flowId: "flow-new", body: "Missing node target" } }]
    })).rejects.toThrow("nodeId");

    await final.handler({
      summary: "Add a valid node-scoped note",
      operations: [{ kind: "add-note", note: { flowId: "flow-new", nodeId: "node-one", body: "Valid note" } }]
    });

    expect(progress.filter((line) => /^Submitted (?:final )?graph batch B\d+/.test(line))).toEqual([
      expect.stringContaining("Submitted graph batch B1"),
      expect.stringContaining("Submitted final graph batch B2")
    ]);
    expect(progress.filter((line) => line.startsWith("Rejected"))).toHaveLength(3);
    expect(progress).toContainEqual(expect.stringContaining("must connect two nodes in the same top-level flow"));
    expect(progress).toContainEqual(expect.stringContaining("Correct and resubmit only this batch"));
  });

  it("rejects skeletal Picasso nodes and requires a connected final topology", async () => {
    const context = {
      projectRoot: "/tmp/project",
      bundle: fakeBundle(),
      provider: fakeAnthropicProvider()
    };
    const tools = picassoGraphAgent.tools(context, { objective: "Design a connected platform flow", mode: "design" });
    const batch = tools.find((tool) => tool.providerToolName === "picasso_submit_graph_batch")!;
    const final = tools.find((tool) => tool.providerToolName === "propose_graph_change_set")!;

    await expect(batch.handler({
      summary: "Submit skeletal nodes",
      operations: [{ kind: "create-node", flowId: "flow-main", node: { id: "node-thin", title: "Thin Node", description: "Too short." } }]
    })).rejects.toThrow("substantial 2-4 sentence description");

    await batch.handler({
      summary: "Create a rich flow region",
      operations: [
        { kind: "create-flow", flow: richPicassoFlow("flow-rich", "Rich Flow") },
        { kind: "create-node", flowId: "flow-rich", node: richPicassoNode("node-api", "api", "Public API") },
        { kind: "create-node", flowId: "flow-rich", node: richPicassoNode("node-service", "service", "Domain Service") },
        { kind: "create-node", flowId: "flow-rich", node: richPicassoNode("node-store", "data-store", "Primary Store") }
      ]
    });

    await expect(final.handler({
      summary: "Finish without relationships",
      operations: [{ kind: "add-note", note: { flowId: "flow-rich", nodeId: "node-api", body: "Document the API boundary." } }]
    })).rejects.toThrow("without any logical edge");

    await final.handler({
      summary: "Connect the rich flow",
      operations: [
        { kind: "create-edge", flowId: "flow-rich", edge: { source: "node-api", target: "node-service", label: "invokes" } },
        { kind: "create-edge", flowId: "flow-rich", edge: { source: "node-service", target: "node-store", label: "reads and writes" } }
      ]
    });
  });

  it("requires generated Open details flows to be linked, populated, and internally connected", async () => {
    const context = { projectRoot: "/tmp/project", bundle: fakeBundle(), provider: fakeAnthropicProvider() };
    const final = picassoGraphAgent.tools(context, {
      objective: "Design an account capability with useful drill-down details",
      mode: "design"
    }).find((tool) => tool.providerToolName === "propose_graph_change_set")!;
    const baseOperations = [
      { kind: "create-flow", flow: richPicassoFlow("flow-account", "Account Experience") },
      { kind: "create-node", flowId: "flow-account", node: richPicassoNode("node-account", "capability", "Account Management") },
      { kind: "create-subflow", flowId: "flow-account", subflow: { id: "subflow-account-details", name: "Account Management Details", parentNodeId: "node-account" } },
      { kind: "link-node-subflow", flowId: "flow-account", nodeId: "node-account", subflowId: "subflow-account-details" }
    ];

    await expect(final.handler({
      summary: "Create an empty account detail flow",
      operations: baseOperations
    })).rejects.toThrow("must contain at least two meaningful child nodes");

    await final.handler({
      summary: "Create a populated account detail flow",
      operations: [
        ...baseOperations,
        { kind: "create-node", flowId: "flow-account", node: { ...richPicassoNode("node-profile", "screen", "Profile Editor"), subflowId: "subflow-account-details" } },
        { kind: "create-node", flowId: "flow-account", node: { ...richPicassoNode("node-preferences", "service", "Preference Service"), subflowId: "subflow-account-details" } },
        { kind: "create-edge", flowId: "flow-account", edge: { source: "node-profile", target: "node-preferences", label: "saves through" } }
      ]
    });
  });

  it("requires a model-owned detail-flow assessment before accepting a substantial flat flow", async () => {
    const context = { projectRoot: "/tmp/project", bundle: fakeBundle(), provider: fakeAnthropicProvider() };
    const tools = picassoGraphAgent.tools(context, { objective: "Design six peer platform capabilities", mode: "design" });
    const batch = tools.find((tool) => tool.providerToolName === "picasso_submit_graph_batch")!;
    const final = tools.find((tool) => tool.providerToolName === "propose_graph_change_set")!;
    const nodeSpecs = [
      ["node-actor", "actor", "Operator"],
      ["node-screen", "screen", "Operations Console"],
      ["node-workflow", "workflow", "Case Workflow"],
      ["node-api", "api", "Case API"],
      ["node-service", "service", "Case Service"],
      ["node-store", "data-store", "Case Store"]
    ] as const;
    await batch.handler({
      summary: "Create a substantial root flow",
      operations: [
        { kind: "create-flow", flow: richPicassoFlow("flow-cases", "Case Operations") },
        ...nodeSpecs.map(([id, type, title]) => ({ kind: "create-node", flowId: "flow-cases", node: richPicassoNode(id, type, title) }))
      ]
    });
    const edgeOperations = nodeSpecs.slice(0, -1).map(([id], index) => ({
      kind: "create-edge",
      flowId: "flow-cases",
      edge: { source: id, target: nodeSpecs[index + 1][0], label: "feeds" }
    }));

    await expect(final.handler({
      summary: "Connect a substantial flat flow without assessing drill-down",
      operations: edgeOperations
    })).rejects.toThrow("omitted detailFlowAssessments");

    await final.handler({
      summary: "Connect the assessed peer-level flow",
      operations: edgeOperations,
      detailFlowAssessments: [{
        flowId: "flow-cases",
        decision: "keep-flat",
        candidateNodeIds: ["node-workflow", "node-service"],
        rationale: "The six nodes represent distinct peer-level runtime boundaries; decomposing either candidate would duplicate the same responsibilities rather than reveal a meaningful internal workflow."
      }]
    });
  });

  it("advertises the nested flow payload required by create-flow operations", () => {
    const context = {
      projectRoot: "/tmp/project",
      bundle: fakeBundle(),
      provider: fakeAnthropicProvider()
    };
    const proposalTool = picassoGraphAgent.tools(context, {
      objective: "Create a trip-management flow",
      mode: "design"
    }).find((tool) => tool.providerToolName === "propose_graph_change_set");
    const schema = proposalTool?.inputSchema as {
      properties?: {
        operations?: {
          items?: { properties?: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
        };
      };
    };

    expect(schema.properties?.operations?.items?.properties).toHaveProperty("flow");
    expect(schema.properties?.operations?.items?.properties?.node?.required).toEqual(expect.arrayContaining(["type", "description", "visual", "techStack", "acceptanceCriteria"]));
    expect(schema.properties?.operations?.items?.properties?.node?.properties).toHaveProperty("techStack");
    expect(proposalTool?.inputSchema).toMatchObject({ properties: { detailFlowAssessments: { type: "array" } } });
    const batchTool = picassoGraphAgent.tools(context, {
      objective: "Create a trip-management flow",
      mode: "design"
    }).find((tool) => tool.providerToolName === "picasso_submit_graph_batch");
    const batchSchema = batchTool?.inputSchema as { properties?: { operations?: { maxItems?: number } } };
    expect(batchSchema.properties?.operations?.maxItems).toBe(16);
    const prompt = picassoGraphAgent.systemPrompt({ objective: "Design the platform graph", mode: "design" }, context);
    expect(prompt).toContain("Never emit delete-flow");
    expect(prompt).toContain("Graph edges are strictly intra-flow");
    expect(prompt).toContain("Every add-note operation must target a concrete node");
    expect(prompt).toContain("richer than a flat checklist");
    expect(prompt).toContain("connect every new node into a coherent navigable graph");
    expect(prompt).toContain("at least 160 characters");
    expect(prompt).toContain("Perform a semantic Open details audit");
    expect(prompt).toContain("detailFlowAssessments");
  });

  it("keeps every exposed Picasso array schema portable across strict providers", () => {
    const context = {
      projectRoot: "/tmp/project",
      bundle: fakeBundle(),
      provider: fakeOpenAIResponsesProvider()
    };
    const tools = picassoGraphAgent.tools(context, {
      objective: "Create a trip-management flow",
      mode: "design"
    });

    const missingItems = tools.flatMap((tool) =>
      arraySchemasMissingItems(tool.inputSchema, tool.providerToolName)
    );

    expect(missingItems).toEqual([]);
  });

  it("accepts Picasso constraints serialized as text by a weak parent model", () => {
    const context = { projectRoot: "/tmp/project", bundle: fakeBundle(), provider: fakeAnthropicProvider() };
    const input = {
      objective: "Create the confirmed platform graph",
      mode: "design",
      constraints: '["Exactly six flows", "No cross-flow edges"]'
    };

    expect(() => picassoGraphAgent.tools(context, input)).not.toThrow();
    const prompt = picassoGraphAgent.systemPrompt(input, context);
    expect(prompt).toContain("Constraints: Exactly six flows; No cross-flow edges");
  });

  it("keeps Sherlock read-only and disables online search when project web access is off", () => {
    const context = { projectRoot: "/tmp/project", bundle: fakeBundle(), provider: fakeAnthropicProvider() };
    const tools = sherlockResearchAgent.tools(context, { objective: "Investigate routing", mode: "mixed" });

    expect(tools.map((tool) => tool.providerToolName)).not.toContain("archicode_console_run_command");
    expect(tools.some((tool) => tool.providerToolName.includes("spawn"))).toBe(false);
    expect(sherlockResearchAgent.webSearchEnabled?.({ objective: "Check current docs", mode: "online" }, context)).toBe(false);
  });

  it("parses Sherlock's compact evidence dossier", () => {
    const parsed = sherlockResearchAgent.parseOutput(JSON.stringify({
      summary: "The route is registered in one place.",
      findings: [{
        title: "Route registration",
        detail: "The router owns the path.",
        confidence: "high",
        evidence: [{ source: "project", reference: "src/router.ts:12" }]
      }],
      sources: [{ label: "router", reference: "src/router.ts", sourceType: "project-file" }],
      openQuestions: [],
      recommendedNextSteps: ["Update the route test"]
    })) as { findings: unknown[]; summary: string };

    expect(parsed.summary).toContain("registered");
    expect(parsed.findings).toHaveLength(1);
  });

  it("recovers Sherlock's source index from evidence-backed findings", () => {
    const parsed = sherlockResearchAgent.parseOutput(JSON.stringify({
      status: "completed",
      blockers: [],
      summary: "The route is registered in one place.",
      findings: [{
        title: "Route registration",
        detail: "The router owns the path.",
        confidence: "high",
        evidence: [{ source: "src/router.ts", reference: "line 12" }]
      }],
      openQuestions: [],
      recommendedNextSteps: []
    })) as { sources: Array<{ label: string; reference: string; sourceType: string }> };

    expect(parsed.sources).toEqual([{
      label: "src/router.ts",
      reference: "line 12",
      sourceType: "project-file"
    }]);
    expect(sherlockResearchAgent.validateOutput?.(
      parsed,
      [{ providerToolName: "archicode_project_search_files", argumentsJson: JSON.stringify({ path: "src", query: "router" }) }],
      { objective: "Find the router implementation", mode: "codebase" }
    )).toBeUndefined();
  });

  it("does not hide a failed micro-run behind its partial output", () => {
    const resultText = microRunResultText({
      id: "micro-failed",
      kind: "sherlock-research",
      status: "failed",
      output: { status: "completed", summary: "Partial but useful dossier." },
      error: "Evidence contract was not satisfied.",
      createdAt: "2026-07-15T00:00:00.000Z",
      completedAt: "2026-07-15T00:01:00.000Z"
    });

    expect(JSON.parse(resultText)).toEqual({
      status: "failed",
      error: "Evidence contract was not satisfied.",
      partialOutput: { status: "completed", summary: "Partial but useful dossier." }
    });
  });

  it("rejects unstructured Sherlock prose after evidence collection", () => {
    const parsed = sherlockResearchAgent.parseOutput("I inspected the project and found the router.");
    expect(sherlockResearchAgent.validateOutput?.(
      parsed,
      [{ providerToolName: "archicode_project_search_files", argumentsJson: JSON.stringify({ path: "src", query: "router" }) }],
      { objective: "Find the router implementation", mode: "codebase" }
    )).toContain("without any structured findings");
  });

  it("rejects Sherlock and Picasso completions that did not satisfy their evidence contracts", () => {
    const blockedSherlock = sherlockResearchAgent.parseOutput(JSON.stringify({
      status: "blocked",
      blockers: ["تعذّر الوصول إلى ملف المصدر المطلوب"],
      summary: "لم يكتمل التحقيق.",
      findings: [],
      sources: [],
      openQuestions: [],
      recommendedNextSteps: []
    }));
    expect(sherlockResearchAgent.validateOutput?.(
      blockedSherlock,
      [{ providerToolName: "archicode_project_list_files", argumentsJson: "{}" }],
      { objective: "Audit the source", mode: "codebase" }
    )).toContain("evidence-collection blocker");

    const blockedPicasso = picassoGraphAgent.parseOutput(JSON.stringify({
      status: "blocked",
      blockers: ["تعذّرت قراءة نطاق المخطط"],
      nodesAffected: [],
      designReport: "لم يكتمل تقييم المخطط.",
      assumptions: [],
      validationChecks: [],
      openQuestions: []
    }));
    expect(picassoGraphAgent.validateOutput?.(blockedPicasso, [], { objective: "راجع المخطط", mode: "assess" }))
      .toContain("graph-inspection blocker");

    const unreadPicasso = picassoGraphAgent.parseOutput(JSON.stringify({
      nodesAffected: [],
      designReport: "No graph changes needed.",
      assumptions: [],
      validationChecks: [],
      openQuestions: []
    }));
    expect(picassoGraphAgent.validateOutput?.(unreadPicasso, [], { objective: "Review the graph" }))
      .toContain("without reading");
  });

  it("requires Sherlock source evidence from structured mode and paths, not objective keywords", () => {
    const dossier = sherlockResearchAgent.parseOutput(JSON.stringify({
      status: "completed",
      blockers: [],
      summary: "اكتمل التحقيق.",
      findings: [{
        title: "مسار التنفيذ",
        detail: "تم تحديد نقطة الدخول.",
        confidence: "high",
        evidence: [{ source: "project", reference: "src/router.ts:12" }]
      }],
      sources: [{ label: "router", reference: "src/router.ts", sourceType: "project-file" }],
      openQuestions: [],
      recommendedNextSteps: []
    }));

    expect(sherlockResearchAgent.validateOutput?.(
      dossier,
      [{ providerToolName: "archicode_project_list_files", argumentsJson: "{}" }],
      { objective: "تحقق من السلوك المطلوب", mode: "mixed", codePaths: ["src/router.ts"] }
    )).toContain("no source file read or source search");
  });

  it("recovers Picasso's proposal from its sink tool without applying it", () => {
    const parsed = picassoGraphAgent.parseOutput("Design complete.", [{
      providerToolName: "propose_graph_change_set",
      argumentsJson: JSON.stringify({
        summary: "Refine the auth flow",
        operations: [{ kind: "update-node", flowId: "flow-main", patch: { id: "node-auth", description: "Updated" } }]
      })
    }]) as { graphChangeSet?: { summary?: string; operations?: unknown[] }; designReport: string };

    expect(parsed.graphChangeSet?.summary).toBe("Refine the auth flow");
    expect(parsed.graphChangeSet?.operations).toHaveLength(1);
    expect(parsed.designReport).toContain("proposed 1 graph update");
  });

  it("repairs Picasso's flattened scoped operations into the Research graph envelope", () => {
    const toolCalls = [{
      providerToolName: "picasso_read_graph",
      argumentsJson: "{}"
    }, {
      providerToolName: "propose_graph_change_set",
      argumentsJson: JSON.stringify({
        summary: "Create Contact Page Breakdown",
        operations: [
          { kind: "create-subflow", id: "subflow-contact-detail", name: "Contact Page Breakdown", parentNodeId: "node-contact-page" },
          { kind: "link-node-subflow", nodeId: "node-contact-page", subflowId: "subflow-contact-detail" },
          { kind: "create-node", id: "node-contact-form", type: "task", title: "Contact Form", description: "Owns the form.", stage: "planned", subflowId: "subflow-contact-detail" },
          { kind: "create-edge", source: "node-contact-form", target: "node-contact-page", label: "supports" },
          { kind: "add-note", nodeId: "node-contact-page", noteKind: "system-note", body: "Use Formspree with a mailto fallback.", pinned: true }
        ]
      })
    }];
    const output = picassoGraphAgent.parseOutput("Design complete.", toolCalls) as {
      graphChangeSet?: { operations?: Array<Record<string, unknown>> };
    };
    const validationError = picassoGraphAgent.validateOutput?.(output, toolCalls, {
      objective: "Create Contact Page Breakdown",
      mode: "design",
      scope: { flowId: "flow-main", nodeIds: ["node-contact-page"] }
    });
    const operations = output.graphChangeSet?.operations ?? [];

    expect(validationError).toBeUndefined();
    expect(operations[0]).toMatchObject({
      kind: "create-subflow",
      flowId: "flow-main",
      subflow: { id: "subflow-contact-detail", name: "Contact Page Breakdown" }
    });
    expect(operations[2]).toMatchObject({
      kind: "create-node",
      flowId: "flow-main",
      node: { id: "node-contact-form", subflowId: "subflow-contact-detail" }
    });
    expect(operations[3]).toMatchObject({ kind: "create-edge", flowId: "flow-main", edge: { label: "supports" } });
    expect(operations[4]).toMatchObject({
      kind: "add-note",
      note: { flowId: "flow-main", nodeId: "node-contact-page", kind: "system-note", author: "llm", pinned: true }
    });
  });

  it("repairs flattened create-flow operations and supplies empty graph collections", () => {
    const toolCalls = [{
      providerToolName: "picasso_read_graph",
      argumentsJson: "{}"
    }, {
      providerToolName: "propose_graph_change_set",
      argumentsJson: JSON.stringify({
        summary: "Create Trip Management",
        operations: [{ kind: "create-flow", id: "flow-trip", name: "Trip Management", description: "Trip lifecycle" }]
      })
    }];
    const output = picassoGraphAgent.parseOutput("Design complete.", toolCalls) as {
      graphChangeSet?: { operations?: Array<Record<string, unknown>> };
    };
    const validationError = picassoGraphAgent.validateOutput?.(output, toolCalls, {
      objective: "Create Trip Management",
      mode: "design"
    });
    const operation = output.graphChangeSet?.operations?.[0] as { flow?: Record<string, unknown> } | undefined;

    expect(validationError).toBeUndefined();
    expect(operation).toMatchObject({
      kind: "create-flow",
      flow: { id: "flow-trip", name: "Trip Management", description: "Trip lifecycle", nodes: [], edges: [], subflows: [], groups: [], updatedAt: "" }
    });
  });

  it("marks malformed Solomon output as a contract failure", async () => {
    const output = mergeResolutionAgent.parseOutput("Merge complete, everything looks good.");
    await expect(mergeResolutionAgent.validateOutput?.(
      output,
      [],
      { conflictedFiles: ["src/shared.ts"] }
    )).resolves.toContain("without a valid structured merge-resolution report");
  });

  it("fails default Picasso design work that completes without a reviewable graph change set", () => {
    const output = picassoGraphAgent.parseOutput("Submitted the reviewable graph change-set proposal.", [{
      providerToolName: "picasso_read_graph",
      argumentsJson: "{}"
    }]);

    expect(picassoGraphAgent.validateOutput?.(output, [{
      providerToolName: "picasso_read_graph",
      argumentsJson: "{}"
    }], { objective: "Create a Landing Page Breakdown detail subflow" }))
      .toContain("without submitting a reviewable graph change set");
  });

  it("allows Picasso reconciliation to complete without changes when no discrepancies are found", () => {
    const output = picassoGraphAgent.parseOutput(JSON.stringify({
      nodesAffected: [],
      designReport: "The graph is already aligned with the resolved files.",
      assumptions: [],
      validationChecks: [],
      openQuestions: []
    }), [{
      providerToolName: "picasso_read_graph",
      argumentsJson: "{}"
    }]);

    expect(picassoGraphAgent.validateOutput?.(output, [{
      providerToolName: "picasso_read_graph",
      argumentsJson: "{}"
    }], { mode: "reconcile", objective: "Check whether the graph needs updates" }))
      .toBeUndefined();
  });

  it("allows Picasso assessment-only work to succeed without a graph change set", () => {
    const toolCalls = [{ providerToolName: "picasso_read_graph", argumentsJson: "{}" }];
    const input = {
      mode: "assess",
      objective: "Assess the current flow without editing it",
      scope: { flowId: "flow-main" }
    };
    const output = picassoGraphAgent.parseOutput(JSON.stringify({
      nodesAffected: ["node-router"],
      designReport: "The flow is coherent, with one missing relationship worth considering.",
      assumptions: [],
      validationChecks: ["Read flow-main"],
      openQuestions: []
    }), toolCalls);
    const prompt = picassoGraphAgent.systemPrompt(input, {
      projectRoot: "/tmp/project",
      bundle: fakeBundle(),
      provider: fakeAnthropicProvider()
    });

    expect(picassoGraphAgent.validateOutput?.(output, toolCalls, input)).toBeUndefined();
    expect(prompt).toContain("This is assessment-only");
    expect(prompt).toContain("Do not call propose_graph_change_set");
    expect(picassoGraphAgent.userMessage(input, {
      projectRoot: "/tmp/project",
      bundle: fakeBundle(),
      provider: fakeAnthropicProvider()
    })).toContain("This is read-only analysis");
  });

  it("uses the structured Picasso mode instead of inferring behavior from objective wording", () => {
    const toolCalls = [{ providerToolName: "picasso_read_graph", argumentsJson: "{}" }];
    const input = {
      mode: "refine",
      objective: "حلّل التدفق فقط ولا تقترح أي تغييرات على الرسم.",
      scope: { flowId: "flow-main" }
    };
    const output = picassoGraphAgent.parseOutput(JSON.stringify({
      nodesAffected: [],
      designReport: "Assessment completed with no edits proposed.",
      assumptions: [],
      validationChecks: [],
      openQuestions: []
    }), toolCalls);

    expect(picassoGraphAgent.validateOutput?.(output, toolCalls, input))
      .toContain("without submitting a reviewable graph change set");
    expect(picassoGraphAgent.systemPrompt(input, {
      projectRoot: "/tmp/project",
      bundle: fakeBundle(),
      provider: fakeAnthropicProvider()
    })).not.toContain("This is assessment-only");
  });
});

describe("git utilities used by the merge-resolution subagent", () => {
  it("detects conflicted files and lists them via git status/diff", async () => {
    const root = await tmpRepo();
    await createMergeConflict(root);

    const conflicted = await getConflictedFiles(root);
    expect(conflicted).toContain("shared.txt");
    expect(await isFileConflicted(root, "shared.txt")).toBe(true);

    // Resolve the conflict and confirm the helpers reflect the new state.
    await writeFile(path.join(root, "shared.txt"), "resolved\n", "utf8");
    await runGitCommand(root, ["add", "shared.txt"]);
    expect(await isFileConflicted(root, "shared.txt")).toBe(false);
    expect(await getConflictedFiles(root)).not.toContain("shared.txt");
  });
});

describe("runVerificationCommand", () => {
  it("reports pass/fail based on exit code", async () => {
    const root = await tmpRepo();
    const passed = await runVerificationCommand(root, process.platform === "win32" ? "cmd" : "true", []);
    expect(passed.passed).toBe(true);

    const failed = await runVerificationCommand(root, process.platform === "win32" ? "cmd /c exit 1" : "false", []);
    expect(failed.passed).toBe(false);
    expect(failed.exitCode).not.toBe(0);
  });
});
