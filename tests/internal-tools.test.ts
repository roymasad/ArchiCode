import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARCHICODE_RESEARCH_RULES_TOOL_NAME,
  archicodeInternalTools,
  archicodeResearchRulesTool,
  callArchicodeInternalTool,
  createArchicodeInternalMcpServer,
  researchRulesToolRequiresApproval,
  setWebSearchSecretResolver
} from "../src/main/internalTools";
import { readArtifactText } from "../src/main/storage/patches";
import { ensureFixtureProject, loadProject, updateNode, updateProjectSettings } from "../src/main/storage/projectStore";
import { runInternalConsoleCommand } from "../src/main/storage/runEngine";
import { createSeedProject } from "../src/shared/fixtures";
import { codeKnowledgeSnapshotSchema } from "../src/shared/codeKnowledge";
import { writeCodeKnowledgeSnapshot } from "../src/main/importer/knowledgeSnapshot";
import { architecturePolicyEvaluationSchema, nodeRuleSchema } from "../src/shared/schema";

function codeKnowledgeFixture() {
  return codeKnowledgeSnapshotSchema.parse({
    version: 1,
    generatedAt: "2026-07-13T10:00:00.000Z",
    source: "codebase-import",
    nodes: [
      { id: "file-main", kind: "file", label: "main.ts", path: "src/main.ts", language: "typescript", community: "app" },
      { id: "symbol-answer", kind: "symbol", label: "answer", path: "src/main.ts", line: 1, symbolKind: "variable", language: "typescript", community: "app" }
    ],
    edges: [{
      id: "contains-main-answer",
      source: "file-main",
      target: "symbol-answer",
      kind: "contains",
      evidence: { origin: "extracted", confidence: 1, relationKinds: ["contains"], locations: [{ path: "src/main.ts", line: 1 }], verification: "verified", freshness: "current" }
    }],
    communities: [{ id: "app", label: "app", nodeCount: 2 }],
    stats: { files: 1, symbols: 1, dependencies: 0, calls: 0, availableNodes: 2, availableEdges: 1, truncated: false, unresolvedImports: 0, resolutionRate: 1 }
  });
}

describe("ArchiCode internal provider tools", () => {
  afterEach(() => {
    setWebSearchSecretResolver(null);
    vi.restoreAllMocks();
  });

  it("defaults built-in provider tool access on for new projects", () => {
    const project = createSeedProject("/tmp/archicode-tools").project;

    expect(project.settings.agentTools.projectFiles).toBe(true);
    expect(project.settings.agentTools.runArtifacts).toBe(true);
    expect(project.settings.agentTools.console).toBe(true);
    expect(project.settings.webSearch.enabled).toBe(true);
  });

  it("exposes built-in file, run, console, and web tools from settings", () => {
    const settings = createSeedProject("/tmp/archicode-tools").project.settings;
    const names = archicodeInternalTools(settings).map((tool) => tool.providerToolName);

    expect(names).toContain("archicode_project_list_files");
    expect(names).toContain("archicode_project_search_files");
    expect(names).toContain("archicode_project_read_file");
    expect(names).toContain("archicode_project_query_code_graph");
    expect(names).toContain(ARCHICODE_RESEARCH_RULES_TOOL_NAME);
    expect(names).toContain("archicode_project_list_runs");
    expect(names).toContain("archicode_project_read_artifact");
    expect(names).toContain("archicode_console_run_command");
    expect(names).toContain("archicode_web_open_url");
    expect(names).not.toContain("archicode_web_search");
  });

  it("exposes the built-in Brave web search tool when the project selects Brave", () => {
    const base = createSeedProject("/tmp/archicode-tools").project.settings;
    const settings = {
      ...base,
      webSearch: {
        ...base.webSearch,
        provider: "brave" as const
      }
    };

    expect(archicodeInternalTools(settings).map((tool) => tool.providerToolName)).toContain("archicode_web_search");
  });

  it("publishes strict JSON schemas for built-in provider tools", () => {
    const settings = createSeedProject("/tmp/archicode-tools").project.settings;
    const tools = archicodeInternalTools(settings);
    const schemas = new Map(tools.map((tool) => [tool.providerToolName, tool.inputSchema as Record<string, unknown>]));

    expect(tools.every((tool) => (tool.inputSchema as Record<string, unknown>).additionalProperties === false)).toBe(true);
    expect(schemas.get("archicode_project_search_files")?.required).toEqual(["query"]);
    expect(schemas.get("archicode_project_query_code_graph")?.required).toEqual(["action"]);
    expect((schemas.get("archicode_project_list_runs")?.properties as Record<string, Record<string, unknown>>).status.enum).toContain("needs-permission");
    expect(schemas.get("archicode_project_read_artifact")?.type).toBe("object");
    expect((schemas.get("archicode_project_read_artifact")?.properties as Record<string, unknown>).artifactId).toBeTruthy();
    expect((schemas.get("archicode_project_read_artifact")?.properties as Record<string, unknown>).path).toBeTruthy();
    expect((schemas.get("archicode_web_open_url")?.properties as Record<string, Record<string, unknown>>).url.pattern).toBe("^https?://");
  });

  it("keeps rule mutations Research-only while exposing violation reads to run agents", () => {
    const settings = createSeedProject("/tmp/archicode-tools").project.settings;
    const readTool = archicodeInternalTools(settings).find((item) => item.providerToolName === ARCHICODE_RESEARCH_RULES_TOOL_NAME)!;
    const researchTool = archicodeResearchRulesTool();
    const readActions = ((readTool.inputSchema as Record<string, Record<string, Record<string, unknown>>>).properties.action.enum as string[]);
    const researchActions = ((researchTool.inputSchema as Record<string, Record<string, Record<string, unknown>>>).properties.action.enum as string[]);

    expect(readActions).toEqual(["list", "get", "list_violations"]);
    expect(readActions).not.toContain("create");
    expect(readActions).not.toContain("update");
    expect(readTool.description).toContain("planning");
    expect(readTool.description).toContain("strictly read-only");
    expect(researchActions).toContain("create");
    expect(researchActions).toContain("update");
    expect(researchTool.description).toContain("Every create or update is blocked until the user approves");
    expect(researchTool.description).toContain("no model call");
    expect(researchRulesToolRequiresApproval(JSON.stringify({ action: "list" }))).toBe(false);
    expect(researchRulesToolRequiresApproval(JSON.stringify({ action: "list_violations" }))).toBe(false);
    expect(researchRulesToolRequiresApproval(JSON.stringify({ action: "create" }))).toBe(true);
    expect(researchRulesToolRequiresApproval(JSON.stringify({ action: "update" }))).toBe(true);
  });

  it("reads, creates, edits, and attaches reusable rules through the Research-only internal tool", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-rules-tool-"));
    const initial = await ensureFixtureProject(projectRoot);
    const env = {
      projectRoot,
      settings: initial.project.settings,
      loadProject: () => loadProject(projectRoot),
      readArtifactText: async () => "",
      researchRules: {
        updateProjectSettings: (settings: typeof initial.project.settings) => updateProjectSettings(projectRoot, settings),
        updateNodeRuleIds: (flowId: string, nodeId: string, ruleIds: string[]) =>
          updateNode(projectRoot, flowId, { id: nodeId, ruleIds }, "llm")
      }
    };
    const createArguments = JSON.stringify({
      action: "create",
      rule: {
        title: "Canvas nodes need descriptions",
        body: "Explain the responsibility before implementation.",
        kind: "policy",
        severity: "error",
        enforcement: "enforced",
        constraint: { kind: "required-node-metadata", scope: "attached", field: "description" }
      },
      attachTo: [{ flowId: "flow-main", nodeId: "node-canvas" }]
    });

    const created = await callArchicodeInternalTool(env, {
      providerToolName: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
      argumentsJson: createArguments
    });
    const createdPayload = JSON.parse(created.resultText);
    const ruleId = createdPayload.rule.id as string;

    expect(created.serverLabel).toBe("ArchiCode Rules");
    expect(createdPayload.implication).toMatchObject({
      evaluation: "local-deterministic",
      llmCallForLinting: false,
      runGate: expect.stringContaining("source-changing run fails")
    });
    expect((await loadProject(projectRoot)).flows[0]?.nodes.find((node) => node.id === "node-canvas")?.ruleIds).toContain(ruleId);

    const read = await callArchicodeInternalTool(env, {
      providerToolName: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
      argumentsJson: JSON.stringify({ action: "get", ruleId })
    });
    expect(JSON.parse(read.resultText).rules[0]).toMatchObject({
      rule: { id: ruleId, title: "Canvas nodes need descriptions" },
      attachments: [{ flowId: "flow-main", nodeId: "node-canvas" }]
    });

    await callArchicodeInternalTool(env, {
      providerToolName: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
      argumentsJson: JSON.stringify({
        action: "update",
        ruleId,
        patch: { body: "Document the node responsibility and boundaries before implementation." },
        detachFrom: [{ flowId: "flow-main", nodeId: "node-canvas" }]
      })
    });
    const updated = await loadProject(projectRoot);
    expect(updated.project.settings.nodeRules?.find((rule) => rule.id === ruleId)?.body).toContain("boundaries");
    expect(updated.flows[0]?.nodes.find((node) => node.id === "node-canvas")?.ruleIds ?? []).not.toContain(ruleId);
  });

  it("lets run agents inspect current flow violations without granting rule mutation access", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-run-rule-reads-"));
    const initial = await ensureFixtureProject(projectRoot);
    const now = "2026-07-16T10:00:00.000Z";
    const rule = nodeRuleSchema.parse({
      id: "rule-boundary",
      title: "Canvas cannot depend on storage",
      body: "Keep UI and storage boundaries separate.",
      kind: "policy",
      status: "active",
      severity: "error",
      enforcement: "enforced",
      constraint: {
        kind: "forbidden-dependency",
        fromPathGlobs: ["src/ui/**"],
        toPathGlobs: ["src/storage/**"],
        includeRuntime: false
      },
      createdAt: now,
      updatedAt: now
    });
    const settings = { ...initial.project.settings, nodeRules: [rule] };
    const policyFingerprint = createHash("sha256").update(JSON.stringify([{
      id: rule.id,
      title: rule.title,
      body: rule.body,
      kind: rule.kind,
      status: rule.status,
      severity: rule.severity,
      enforcement: rule.enforcement,
      constraint: rule.constraint
    }])).digest("hex");
    const policyEvaluation = architecturePolicyEvaluationSchema.parse({
      version: 1,
      generatedAt: now,
      analyzerVersion: 1,
      policyFingerprint,
      violations: [
        {
          id: "violation-flow",
          policyId: rule.id,
          policyTitle: rule.title,
          kind: "forbidden-dependency",
          severity: "error",
          enforcement: "enforced",
          message: "src/ui/Canvas.ts imports src/storage/db.ts",
          source: { entityKind: "file", path: "src/ui/Canvas.ts", flowId: "flow-main", nodeId: "node-canvas" },
          target: { entityKind: "file", path: "src/storage/db.ts" },
          checkedAt: now,
          firstSeenAt: now
        },
        {
          id: "violation-unassigned",
          policyId: rule.id,
          policyTitle: rule.title,
          kind: "forbidden-dependency",
          severity: "warning",
          enforcement: "advisory",
          message: "An unassigned source file crosses the boundary",
          source: { entityKind: "file", path: "src/ui/Loose.ts" },
          target: { entityKind: "file", path: "src/storage/db.ts" },
          checkedAt: now,
          firstSeenAt: now
        }
      ],
      stats: { policiesEvaluated: 1, edgesChecked: 2, violations: 2 }
    });
    const bundle = {
      ...initial,
      project: { ...initial.project, settings },
      policyEvaluation
    };
    const env = {
      projectRoot,
      settings,
      loadProject: async () => bundle,
      readArtifactText: async () => ""
    };

    const result = await callArchicodeInternalTool(env, {
      providerToolName: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
      argumentsJson: JSON.stringify({ action: "list_violations", flowId: "flow-main" })
    });
    const payload = JSON.parse(result.resultText);

    expect(payload.evaluation).toMatchObject({ status: "current", activePolicies: 1 });
    expect(payload.summary).toMatchObject({ matching: 1, blocking: 1, unassigned: 0 });
    expect(payload.summary.byFlow).toEqual([expect.objectContaining({ flowId: "flow-main", count: 1, blocking: 1 })]);
    expect(payload.violations[0]).toMatchObject({ id: "violation-flow", flowIds: ["flow-main"], nodeIds: ["node-canvas"], blocking: true });

    await expect(callArchicodeInternalTool(env, {
      providerToolName: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
      argumentsJson: JSON.stringify({ action: "update", ruleId: rule.id, patch: { body: "Changed without approval" } })
    })).rejects.toThrow("Rule mutations are available only to Research chat after exact user approval");
  });

  it("omits web tools when web search is disabled", () => {
    const settings = {
      ...createSeedProject("/tmp/archicode-tools").project.settings,
      webSearch: {
        provider: "native" as const,
        enabled: false,
        requirePerRunApproval: true,
        persistSearchArtifacts: true
      }
    };

    const names = archicodeInternalTools(settings).map((tool) => tool.providerToolName);
    expect(names).not.toContain("archicode_web_search");
    expect(names).not.toContain("archicode_web_open_url");
  });

  it("returns a configuration message when Brave search is selected without a saved API key", async () => {
    const base = createSeedProject("/tmp/archicode-tools").project.settings;
    const settings = {
      ...base,
      webSearch: {
        ...base.webSearch,
        provider: "brave" as const
      }
    };
    const env = {
      projectRoot: "/tmp/archicode-tools",
      settings,
      loadProject: async () => ensureFixtureProject("/tmp/archicode-tools"),
      readArtifactText: async () => ""
    };

    const result = await callArchicodeInternalTool(env, {
      providerToolName: "archicode_web_search",
      argumentsJson: JSON.stringify({ query: "archicode" })
    });

    expect(result.resultText).toContain("\"configured\": false");
    expect(result.resultText).toContain("no Brave Search API key");
  });

  it("uses Brave Search for internal web search when a local API key is available", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        query: { more_results_available: false },
        web: {
          results: [
            {
              title: "ArchiCode",
              url: "https://example.com/archicode",
              description: "Visual-first development environment.",
              extra_snippets: ["Extra context"]
            }
          ]
        }
      })
    }));
    vi.stubGlobal("fetch", fetchMock);
    const base = createSeedProject("/tmp/archicode-tools").project.settings;
    const settings = {
      ...base,
      webSearch: {
        ...base.webSearch,
        provider: "brave" as const
      }
    };
    const env = {
      projectRoot: "/tmp/archicode-tools",
      settings,
      loadProject: async () => ensureFixtureProject("/tmp/archicode-tools"),
      readArtifactText: async () => "",
      resolveWebSearchApiKey: async () => "brave-test-key"
    };

    const result = await callArchicodeInternalTool(env, {
      providerToolName: "archicode_web_search",
      argumentsJson: JSON.stringify({ query: "archicode", maxResults: 3 })
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.resultText).toContain("\"provider\": \"brave\"");
    expect(result.resultText).toContain("\"title\": \"ArchiCode\"");
    expect(result.resultText).toContain("\"url\": \"https://example.com/archicode\"");
  });

  it("reads and searches project files with secret redaction", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-internal-tools-"));
    await ensureFixtureProject(projectRoot);
    await writeFile(path.join(projectRoot, "README.md"), "Hello tool parity\n", "utf8");
    await writeFile(path.join(projectRoot, ".env"), "OPENAI_API_KEY=sk-secretsecretsecret\n", "utf8");
    const settings = (await loadProject(projectRoot)).project.settings;
    const env = {
      projectRoot,
      settings,
      loadProject: () => loadProject(projectRoot),
      readArtifactText: (artifactPath: string) => readArtifactText(projectRoot, artifactPath)
    };

    const search = await callArchicodeInternalTool(env, {
      providerToolName: "archicode_project_search_files",
      argumentsJson: JSON.stringify({ query: "tool parity" })
    });
    const read = await callArchicodeInternalTool(env, {
      providerToolName: "archicode_project_read_file",
      argumentsJson: JSON.stringify({ path: ".env" })
    });

    expect(search.resultText).toContain("README.md");
    expect(read.resultText).toContain("[redacted]");
    expect(read.resultText).not.toContain("sk-secretsecretsecret");
  });

  it("recovers near-miss project file paths instead of hard failing", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-internal-file-alias-"));
    await ensureFixtureProject(projectRoot);
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(path.join(projectRoot, "src", "styles.css"), "body { color: red; }\n", "utf8");
    const settings = (await loadProject(projectRoot)).project.settings;
    const env = {
      projectRoot,
      settings,
      loadProject: () => loadProject(projectRoot),
      readArtifactText: (artifactPath: string) => readArtifactText(projectRoot, artifactPath)
    };

    const read = await callArchicodeInternalTool(env, {
      providerToolName: "archicode_project_read_file",
      argumentsJson: JSON.stringify({ path: "src/style.css" })
    });

    expect(read.resultText).toContain("\"path\": \"src/styles.css\"");
    expect(read.resultText).toContain("\"requestedPath\": \"src/style.css\"");
    expect(read.resultText).toContain("\"aliasUsed\": true");
  });

  it("recovers near-miss artifact references by filename stem", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-internal-artifact-alias-"));
    await ensureFixtureProject(projectRoot);
    const artifactPath = path.join(projectRoot, ".archicode", "artifacts", "run-alias-plan.json");
    await writeFile(artifactPath, JSON.stringify({
      id: "plan-alias-123",
      type: "plan",
      title: "Alias Plan",
      path: ".archicode/artifacts/run-alias-plan.json",
      runId: "run-alias",
      summary: "Alias plan summary.",
      createdAt: new Date().toISOString()
    }, null, 2), "utf8");
    const settings = (await loadProject(projectRoot)).project.settings;
    const env = {
      projectRoot,
      settings,
      loadProject: () => loadProject(projectRoot),
      readArtifactText: (artifactRelativePath: string) => readArtifactText(projectRoot, artifactRelativePath)
    };

    const read = await callArchicodeInternalTool(env, {
      providerToolName: "archicode_project_read_artifact",
      argumentsJson: JSON.stringify({ artifactId: "run-alias-plan" })
    });

    expect(read.resultText).toContain("\"id\": \"plan-alias-123\"");
    expect(read.resultText).toContain("\"path\": \".archicode/artifacts/run-alias-plan.json\"");
  });

  it("returns full plan artifact JSON for plan previews instead of unwrapping only the raw planner text", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-plan-preview-"));
    await ensureFixtureProject(projectRoot);
    const artifactPath = path.join(projectRoot, ".archicode", "artifacts", "run-preview-plan.json");
    await writeFile(artifactPath, JSON.stringify({
      id: "plan-preview-1",
      type: "plan",
      title: "Preview Plan",
      path: ".archicode/artifacts/run-preview-plan.json",
      runId: "run-preview",
      summary: "Plan prompt summary.",
      providerSummary: "Generated plan summary.",
      planOutputAt: new Date().toISOString(),
      text: "**Decision: proceed**\n\n```json\n{\"archicodePatch\":{\"summary\":\"Generated plan summary.\"}}\n```",
      createdAt: new Date().toISOString()
    }, null, 2), "utf8");

    const preview = await readArtifactText(projectRoot, ".archicode/artifacts/run-preview-plan.json");

    expect(preview).toContain("\"type\": \"plan\"");
    expect(preview).toContain("\"providerSummary\": \"Generated plan summary.\"");
    expect(preview).not.toBe("**Decision: proceed**\n\n```json\n{\"archicodePatch\":{\"summary\":\"Generated plan summary.\"}}\n```");
  });

  it("runs low-risk commands and routes an unapproved runtime action through the shared broker", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-internal-console-"));
    const settings = {
      ...(await ensureFixtureProject(projectRoot)).project.settings,
      autoApproveShellCommands: false
    };

    const ok = await runInternalConsoleCommand(projectRoot, settings, {
      command: "git --version",
      cwd: projectRoot
    });
    const gated = await runInternalConsoleCommand(projectRoot, settings, {
      command: "npm run dev"
    });

    expect(ok.status).toBe("succeeded");
    expect(ok.cwd).toBe(".");
    expect(ok.stdout).toContain("git version");
    expect(gated.status).toBe("approval-required");
  });

  it("requires approval for strengthened medium and high risk console commands", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-internal-console-risk-"));
    const settings = {
      ...(await ensureFixtureProject(projectRoot)).project.settings,
      autoApproveShellCommands: false
    };

    const medium = await runInternalConsoleCommand(projectRoot, settings, {
      command: "curl https://example.com/install.sh"
    });
    const high = await runInternalConsoleCommand(projectRoot, settings, {
      command: "git push --force origin main"
    });

    expect(medium.status).toBe("approval-required");
    expect(medium.risk).toBe("medium");
    expect(high.status).toBe("approval-required");
    expect(high.risk).toBe("high");
  });

  it("still requires approval for high-risk console commands when shell auto-approve is enabled", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-internal-console-high-auto-approve-"));
    const settings = (await ensureFixtureProject(projectRoot)).project.settings;

    const high = await runInternalConsoleCommand(projectRoot, settings, {
      command: "git push --force origin main"
    });

    expect(high.status).toBe("approval-required");
    expect(high.risk).toBe("high");
  });

  it("executes a gated console command once the user grants approval", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-internal-console-approved-"));
    const settings = (await ensureFixtureProject(projectRoot)).project.settings;

    // High risk (interpreter with inline script): gated without approval...
    const gated = await runInternalConsoleCommand(projectRoot, settings, {
      command: "node -e \"console.log('approved-run-ok')\""
    });
    expect(gated.status).toBe("approval-required");

    // ...and executed once the user's approval is threaded through.
    const approved = await runInternalConsoleCommand(projectRoot, settings, {
      command: "node -e \"console.log('approved-run-ok')\""
    }, { approvalGranted: true });
    expect(approved.status).toBe("succeeded");
    expect(approved.stdout).toContain("approved-run-ok");
  });

  it("lets agents query the local code graph through bounded results", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-code-graph-tool-"));
    const bundle = await ensureFixtureProject(projectRoot);
    await writeCodeKnowledgeSnapshot(projectRoot, codeKnowledgeFixture());
    const result = await callArchicodeInternalTool({
      projectRoot,
      settings: bundle.project.settings,
      loadProject: () => loadProject(projectRoot),
      readArtifactText: async () => ""
    }, {
      providerToolName: "archicode_project_query_code_graph",
      argumentsJson: JSON.stringify({ action: "neighbors", source: "src/main.ts", maxResults: 2 })
    });

    const parsed = JSON.parse(result.resultText) as { bounded: boolean; limit: number; nodes: unknown[]; edges: unknown[] };
    expect(parsed.bounded).toBe(true);
    expect(parsed.limit).toBe(2);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges).toHaveLength(1);
  });

  it("exposes the same built-in tools through the generated Codex Local MCP server", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-internal-mcp-project-"));
    const outputDir = await mkdtemp(path.join(tmpdir(), "archicode-internal-mcp-server-"));
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(path.join(projectRoot, "src", "main.ts"), "export const answer = 42;\n", "utf8");
    const bundle = await ensureFixtureProject(projectRoot);
    await writeCodeKnowledgeSnapshot(projectRoot, codeKnowledgeFixture());
    const mcpServer = await createArchicodeInternalMcpServer(projectRoot, bundle.project.settings, outputDir);
    const client = new Client({ name: "archicode-test", version: "0.1.1" }, { capabilities: {} });

    await client.connect(new StdioClientTransport({
      command: mcpServer.command!,
      args: mcpServer.args,
      env: {},
      stderr: "pipe"
    }));
    try {
      const tools = await client.listTools();
      const listed = await client.callTool({
        name: "archicode_project_search_files",
        arguments: { query: "answer" }
      });
      const command = await client.callTool({
        name: "archicode_console_run_command",
        arguments: { command: "git --version", cwd: projectRoot }
      });
      const graph = await client.callTool({
        name: "archicode_project_query_code_graph",
        arguments: { action: "search", query: "answer", maxResults: 2 }
      });
      const violations = await client.callTool({
        name: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
        arguments: { action: "list_violations" }
      });
      const mutation = await client.callTool({
        name: ARCHICODE_RESEARCH_RULES_TOOL_NAME,
        arguments: { action: "create", rule: { title: "No", body: "Not from a run" } }
      });
      const commandText = (command.content as Array<{ type?: string; text?: string }>)
        .find((item) => item.type === "text")?.text ?? "";
      const violationText = (violations.content as Array<{ type?: string; text?: string }>)
        .find((item) => item.type === "text")?.text ?? "";
      const mutationText = (mutation.content as Array<{ type?: string; text?: string }>)
        .find((item) => item.type === "text")?.text ?? "";

      expect(tools.tools.map((tool) => tool.name)).toContain("archicode_project_search_files");
      expect(tools.tools.map((tool) => tool.name)).toContain("archicode_project_query_code_graph");
      expect(tools.tools.map((tool) => tool.name)).toContain(ARCHICODE_RESEARCH_RULES_TOOL_NAME);
      expect(JSON.stringify(listed)).toContain("src/main.ts");
      expect(JSON.stringify(graph)).toContain("symbol-answer");
      expect(violationText).toContain('"action": "list_violations"');
      expect(mutation.isError).toBe(true);
      expect(mutationText).toContain("read-only rule access");
      expect(commandText).toContain('"cwd": "."');
      expect(commandText).toContain('"status": "succeeded"');
    } finally {
      await client.close();
    }
  });

  it("passes the Brave Search API key to the generated internal MCP server when Brave search is enabled", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-internal-mcp-env-project-"));
    const outputDir = await mkdtemp(path.join(tmpdir(), "archicode-internal-mcp-env-server-"));
    const bundle = await ensureFixtureProject(projectRoot);
    setWebSearchSecretResolver(async () => "brave-secret");

    const server = await createArchicodeInternalMcpServer(projectRoot, {
      ...bundle.project.settings,
      webSearch: {
        ...bundle.project.settings.webSearch,
        provider: "brave"
      }
    }, outputDir);

    expect(server.env).toContainEqual({ name: "ARCHICODE_BRAVE_SEARCH_API_KEY", value: "brave-secret" });
  });

  it("preserves explicitly disabled built-in tool settings", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-internal-settings-"));
    const bundle = await ensureFixtureProject(projectRoot);
    const updated = await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      agentTools: {
        ...bundle.project.settings.agentTools,
        console: false
      }
    });

    expect(updated.project.settings.agentTools.console).toBe(false);
    expect(archicodeInternalTools(updated.project.settings).map((tool) => tool.providerToolName)).not.toContain("archicode_console_run_command");
  });
});
