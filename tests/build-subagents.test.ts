import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatchProposal, listPatchProposals } from "../src/main/storage/patches";
import { ensureProject, loadProject, updateProjectSettings } from "../src/main/storage/projectStore";
import { callProviderForRun, executeRunSubagentTool, extractLocalProviderSubagentRequest, runSubagentTools } from "../src/main/storage/runEngine";
import { llmPatchProposalSchema, runSchema } from "../src/shared/schema";

function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`));
      controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`));
      controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`));
      controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } })}\n\n`));
      controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`));
      controller.close();
    }
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function sseToolResponse(name: string, input: unknown = {}): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name, input: {} } })}\n\n`));
      controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })}\n\n`));
      controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`));
      controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } })}\n\n`));
      controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`));
      controller.close();
    }
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function setupBuildRun() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-build-subagent-"));
  const bundle = await ensureProject(projectRoot);
  process.env.ANTHROPIC_BUILD_SUBAGENT_TEST_KEY = "test";
  const settings = {
    ...bundle.project.settings,
    webSearch: { ...bundle.project.settings.webSearch, enabled: false },
    providers: bundle.project.settings.providers.map((provider) => provider.kind === "anthropic-compatible"
      ? { ...provider, enabled: true, apiKeyEnv: "ANTHROPIC_BUILD_SUBAGENT_TEST_KEY" }
      : { ...provider, enabled: false })
  };
  await updateProjectSettings(projectRoot, settings);
  const provider = settings.providers.find((item) => item.kind === "anthropic-compatible")!;
  const run = runSchema.parse({
    id: "run-build-subagent",
    flowId: "flow-main",
    providerId: provider.id,
    status: "planning",
    phase: "planning",
    effort: "high",
    promptSummary: "Investigate before planning",
    permission: { decision: "allowed", reason: "No shell command requested." },
    contextArtifacts: [],
    todos: [],
    logs: [],
    createdAt: new Date().toISOString()
  });
  await writeFile(path.join(projectRoot, ".archicode", "runs", `${run.id}.json`), JSON.stringify(run, null, 2), "utf8");
  return { projectRoot, settings, run };
}

describe("AI build-run subagent tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_BUILD_SUBAGENT_TEST_KEY;
  });

  it("advertises settings-gated Sherlock and Picasso tools", async () => {
    const { settings } = await setupBuildRun();
    expect(runSubagentTools(settings).map((tool) => tool.providerToolName)).toEqual([
      "archicode_spawn_sherlock",
      "archicode_spawn_picasso"
    ]);
    expect(runSubagentTools({
      ...settings,
      agentTools: {
        ...settings.agentTools,
        subagents: { mergeConflictResolution: true, graphReconciliation: false, sherlockResearch: false }
      }
    })).toEqual([]);
  });

  it("runs Sherlock in isolation and returns a compact artifact-backed result", async () => {
    const { projectRoot, settings, run } = await setupBuildRun();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(sseToolResponse("archicode_project_search_files", { path: ".", query: "provider validation" }))
      .mockResolvedValue(sseResponse(JSON.stringify({
      summary: "The shared schema owns provider validation.",
      findings: [{ title: "Schema owner", detail: "Provider settings use Zod.", confidence: "high", evidence: [{ source: "project", reference: "src/shared/schema.ts" }] }],
      sources: [{ label: "schema", reference: "src/shared/schema.ts", sourceType: "project-file" }],
      openQuestions: [],
      recommendedNextSteps: []
    }))));

    const result = await executeRunSubagentTool(projectRoot, run.id, settings, {
      providerToolName: "archicode_spawn_sherlock",
      argumentsJson: JSON.stringify({ objective: "Find provider validation ownership", mode: "codebase" })
    });
    const compact = JSON.parse(result.resultText) as { summary: string; findingCount: number; reportArtifact: { id: string } };
    const loaded = await loadProject(projectRoot);
    const updatedRun = loaded.runs.find((item) => item.id === run.id)!;

    expect(compact.summary).toContain("shared schema");
    expect(compact.findingCount).toBe(1);
    expect(updatedRun.contextArtifacts).toContain(compact.reportArtifact.id);
    expect(updatedRun.usage).toBeDefined();
  });

  it("forces Picasso graph operations into review without mutating the graph", async () => {
    const { projectRoot, settings, run } = await setupBuildRun();
    const before = await loadProject(projectRoot);
    const beforeDescription = before.flows[0].nodes.find((node) => node.id === "node-project")?.description;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(sseToolResponse("picasso_read_graph", {}))
      .mockResolvedValueOnce(sseToolResponse("propose_graph_change_set", {
        summary: "Refine project responsibility",
        operations: [
          { kind: "update-node", flowId: "flow-main", patch: { id: "node-project", description: "Picasso proposal" } },
          { kind: "create-group", flowId: "flow-main", group: { id: "group-picasso", name: "Picasso group", color: "#445566" } }
        ]
      })));

    const result = await executeRunSubagentTool(projectRoot, run.id, settings, {
      providerToolName: "archicode_spawn_picasso",
      argumentsJson: JSON.stringify({ objective: "Refine the project node", mode: "refine" })
    });
    const compact = JSON.parse(result.resultText) as { operationCount: number; reviewArtifact?: { id: string } };
    const after = await loadProject(projectRoot);
    const proposals = await listPatchProposals(projectRoot);

    expect(compact.operationCount).toBe(2);
    expect(compact.reviewArtifact).toBeDefined();
    expect(after.flows[0].nodes.find((node) => node.id === "node-project")?.description).toBe(beforeDescription);
    expect(after.flows[0].groups.some((group) => group.id === "group-picasso")).toBe(false);
    const reviewProposal = proposals.find((proposal) => proposal.artifact.id === compact.reviewArtifact?.id);
    expect(reviewProposal?.artifact.status).toBe("pending-review");
    const parsedReviewProposal = llmPatchProposalSchema.parse(reviewProposal?.proposal);
    expect(parsedReviewProposal.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "propose-graph-operation", operation: expect.objectContaining({ kind: "create-group" }) })
    ]));
    const reviewed = await applyPatchProposal(projectRoot, reviewProposal!.artifact.id, [
      { operationIndex: 0, decision: "accepted" },
      { operationIndex: 1, decision: "accepted" }
    ], { recordSourceDiff: false });
    expect(reviewed.flows[0].nodes.find((node) => node.id === "node-project")?.description).toBe("Picasso proposal");
    expect(reviewed.flows[0].groups.some((group) => group.id === "group-picasso")).toBe(true);
  });

  it("parses the local-provider host delegation envelope", () => {
    expect(extractLocalProviderSubagentRequest(JSON.stringify({
      archicodeSubagentRequest: {
        agent: "sherlock",
        input: { objective: "Trace the auth flow", mode: "codebase" }
      }
    }))).toMatchObject({ agent: "sherlock", input: { objective: "Trace the auth flow" } });
    expect(extractLocalProviderSubagentRequest("ordinary provider output")).toBeNull();
  });

  it("runs and resumes a Sherlock delegation requested by a Codex Local build agent", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-local-build-subagent-"));
    const commandPath = path.join(projectRoot, "mock-codex.mjs");
    await writeFile(commandPath, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";
const prompt = fs.readFileSync(0, "utf8");
let output;
if (prompt.includes("You are Sherlock") && !prompt.includes("Structured tool transcript so far:")) {
  output = JSON.stringify({
    archicodeResearchTurn: {
      toolCalls: [{ id: "search-1", providerToolName: "archicode_project_search_files", arguments: { path: ".", query: "validation owner" } }]
    }
  });
} else if (prompt.includes("You are Sherlock")) {
  output = JSON.stringify({
    summary: "Sherlock isolated the validation owner.",
    findings: [{ title: "Owner", detail: "The schema validates it.", confidence: "high", evidence: [{ source: "project", reference: "src/shared/schema.ts" }] }],
    sources: [{ label: "schema", reference: "src/shared/schema.ts", sourceType: "project-file" }],
    openQuestions: [],
    recommendedNextSteps: []
  });
} else if (prompt.includes("Completed Fresh-Context Delegation")) {
  output = "Planning resumed with Sherlock's compact result.";
} else {
  output = JSON.stringify({ archicodeSubagentRequest: { agent: "sherlock", input: { objective: "Find the validation owner", mode: "codebase" } } });
}
if (outputPath) fs.writeFileSync(outputPath, output, "utf8");
process.stdout.write(output + "\\n");
`, "utf8");
    await chmod(commandPath, 0o755);
    const initial = await ensureProject(projectRoot);
    const settings = {
      ...initial.project.settings,
      providers: initial.project.settings.providers.map((provider) => provider.kind === "codex-local"
        ? { ...provider, enabled: true, localCommand: commandPath }
        : { ...provider, enabled: false })
    };
    await updateProjectSettings(projectRoot, settings);
    const provider = settings.providers.find((item) => item.kind === "codex-local")!;
    const run = runSchema.parse({
      id: "run-local-subagent",
      flowId: "flow-main",
      providerId: provider.id,
      status: "planning",
      phase: "planning",
      effort: "high",
      promptSummary: "Plan after investigation",
      permission: { decision: "allowed" },
      contextArtifacts: [],
      todos: [],
      logs: [],
      createdAt: new Date().toISOString()
    });
    await writeFile(path.join(projectRoot, ".archicode", "runs", `${run.id}.json`), JSON.stringify(run, null, 2), "utf8");

    const output = await callProviderForRun(projectRoot, run.id, provider, "Project context", run.promptSummary, {
      projectRoot,
      phase: "planning",
      webSearchEnabled: false,
      selectedSkillsPrompt: "Use the archicodeSubagentRequest contract for substantial isolated investigation."
    });
    const loaded = await loadProject(projectRoot);
    const updatedRun = loaded.runs.find((item) => item.id === run.id)!;

    expect(output).toContain("Planning resumed");
    expect(updatedRun.contextArtifacts.length).toBeGreaterThan(0);
    expect(updatedRun.logs.some((entry) => entry.text.includes("Sherlock completed"))).toBe(true);
  });
});
