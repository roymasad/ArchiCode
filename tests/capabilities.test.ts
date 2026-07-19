import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callProvider, callResearchProvider } from "../src/main/providers";
import { createProjectSkill, listProjectSkills, selectedSkillsPrompt } from "../src/main/skills";
import { importMcpServers, listMcpRegistryServers, mcpServerFromRegistryEntry, registryEntryFromServer, type ProviderMcpTool } from "../src/main/mcp";
import { createSeedProject } from "../src/shared/fixtures";
import { archicodeCapabilityDigest, archicodeCapabilityVersion, archicodeCurrentProjectOptions } from "../src/shared/appCapabilities";

const originalFetch = globalThis.fetch;

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function chatCompletionTextSse(text: string): Response {
  return sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    "data: [DONE]\n\n"
  ]);
}

function chatCompletionToolCallsSse(toolCalls: Array<{ id: string; name: string; arguments: string }>): Response {
  const chunks = toolCalls.map((toolCall, index) =>
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.arguments } }] } }] })}\n\n`
  );
  chunks.push("data: [DONE]\n\n");
  return sseResponse(chunks);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  delete process.env.OPENAI_TEST_KEY;
  delete process.env.ANTHROPIC_TEST_KEY;
});

describe("ArchiCode product capability digest", () => {
  it("keeps current app awareness categorized by chat, workspace, and UI-only capabilities", () => {
    const digest = archicodeCapabilityDigest();
    const allText = JSON.stringify(digest);

    expect(digest.version).toBe(archicodeCapabilityVersion);
    expect(allText).toContain("acceptance checks");
    expect(allText).toContain("implementation-scope");
    expect(allText).toContain("Sherlock");
    expect(allText).toContain("Delphi");
    expect(allText).toContain("read-only navigable 3D graph views");
    expect(allText).toContain("AI-assisted commit-message drafting");
    expect(allText).toContain("fork/archive/cancel/export Research chats");
    expect(digest.researchChat.cannot.join(" ")).toContain("Edit target source files directly");

    const options = archicodeCurrentProjectOptions(createSeedProject("/tmp/archicode-options").project.settings) as {
      reviewAndApproval: { codeReviewMode: string };
      agentTools: { subagents: { sherlockResearch: boolean; delphiTesting: boolean } };
      providers: Array<{ apiKey?: string }>;
    };
    expect(options.reviewAndApproval.codeReviewMode).toBe("auto-apply");
    expect(options.agentTools.subagents.sherlockResearch).toBe(true);
    expect(options.agentTools.subagents.delphiTesting).toBe(true);
    expect(JSON.stringify(options)).not.toContain("apiKey");
  });
});

describe("skills capabilities", () => {
  it("creates and lists project-local skills with prompt injection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-skills-"));
    await createProjectSkill(root, {
      id: "react-ui-review",
      title: "React UI Review",
      description: "Review React UI changes.",
      whenToUse: "Use for React renderer work.",
      instructions: "Prefer existing components."
    });

    const settings = {
      ...createSeedProject(root).project.settings,
      skills: { enabledSkillIds: ["react-ui-review"] }
    };
    const skills = await listProjectSkills(root, settings);
    const prompt = await selectedSkillsPrompt(root, settings);

    expect(skills).toHaveLength(1);
    expect(skills[0].enabled).toBe(true);
    expect(prompt).toContain("Selected ArchiCode Skills");
    expect(prompt).toContain("Prefer existing components.");
  });

  it("rejects invalid skill ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-skills-invalid-"));
    await expect(createProjectSkill(root, { id: "!!", title: "Bad" })).rejects.toThrow(/Skill id/);
  });
});

describe("mcp registry", () => {
  it("imports JSON mcpServers definitions", async () => {
    const servers = await importMcpServers({
      kind: "json",
      content: JSON.stringify({
        mcpServers: {
          docs: {
            command: "node",
            args: ["server.js"],
            env: { DOCS_TOKEN: "token" }
          }
        }
      })
    });

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      id: "docs",
      label: "docs",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      enabled: false
    });
    expect(servers[0].env[0]).toEqual({ name: "DOCS_TOKEN", value: "token" });
  });

  it("imports Codex TOML nested env sections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-home-"));
    const configDir = path.join(root, ".codex");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "config.toml"), [
      "[mcp_servers.node_repl]",
      "command = \"/bin/node_repl\"",
      "args = []",
      "",
      "[mcp_servers.node_repl.env]",
      "CODEX_HOME = \"/tmp/codex\"",
      "NODE_REPL_NODE_PATH = \"/bin/node\"",
      ""
    ].join("\n"));
    process.env.CODEX_HOME = configDir;

    const servers = await importMcpServers({ kind: "codex-auto" });

    expect(servers[0]).toMatchObject({ id: "node-repl", command: "/bin/node_repl" });
    expect(servers[0].env).toEqual(expect.arrayContaining([
      { name: "CODEX_HOME", value: "/tmp/codex" },
      { name: "NODE_REPL_NODE_PATH", value: "/bin/node" }
    ]));
  });

  it("normalizes registry remote entries with required headers", () => {
    const entry = registryEntryFromServer({
      server: {
        name: "ai.example/docs",
        title: "Docs MCP",
        description: "Search docs.",
        version: "1.0.0",
        icons: [{ src: "https://example.test/icon.png", mimeType: "image/png" }],
        remotes: [{
          type: "streamable-http",
          url: "https://example.test/mcp",
          headers: [{ name: "Authorization", isRequired: true, isSecret: true }]
        }]
      },
      _meta: {
        "io.modelcontextprotocol.registry/official": {
          status: "active",
          isLatest: true
        }
      }
    });

    expect(entry).toMatchObject({
      id: "ai.example/docs@1.0.0",
      iconUrl: "https://example.test/icon.png",
      installable: true,
      install: {
        kind: "remote",
        transport: "streamable-http",
        url: "https://example.test/mcp"
      }
    });

    const server = mcpServerFromRegistryEntry({ entry: entry!, refresh: false });
    expect(server).toMatchObject({
      id: "ai-example-docs",
      transport: "streamable-http",
      url: "https://example.test/mcp",
      enabled: false,
      source: "registry"
    });
    expect(server.headers).toEqual([{ name: "Authorization", value: "" }]);
  });

  it("normalizes registry npm packages into npx stdio servers", () => {
    const entry = registryEntryFromServer({
      server: {
        name: "ai.example/local-docs",
        title: "Local Docs MCP",
        version: "2.1.0",
        packages: [{
          registryType: "npm",
          identifier: "@example/local-docs-mcp",
          version: "2.1.0",
          transport: { type: "stdio" },
          environmentVariables: [{ name: "DOCS_TOKEN", isRequired: false, isSecret: true }]
        }]
      },
      _meta: {
        "io.modelcontextprotocol.registry/official": {
          status: "active",
          isLatest: true
        }
      }
    });

    expect(entry?.install).toMatchObject({
      kind: "package",
      command: "npx",
      args: ["-y", "@example/local-docs-mcp@2.1.0"],
      packageType: "npm"
    });

    const server = mcpServerFromRegistryEntry({ entry: entry!, enabled: true });
    expect(server).toMatchObject({
      id: "ai-example-local-docs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@example/local-docs-mcp@2.1.0"],
      enabled: true,
      trusted: true,
      source: "registry"
    });
    expect(server.env).toEqual([{ name: "DOCS_TOKEN", value: "" }]);
  });

  it("uses the registry search parameter for text queries", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      expect(url.searchParams.get("search")).toBe("context7");
      expect(url.searchParams.get("limit")).toBe("10");
      return {
        ok: true,
        json: async () => ({
          servers: [{
            server: {
              name: "io.github.upstash/context7",
              title: "Context7",
              version: "1.0.31",
              packages: [{
                registryType: "npm",
                identifier: "@upstash/context7-mcp",
                version: "1.0.31",
                transport: { type: "stdio" }
              }]
            }
          }],
          metadata: {
            count: 1
          }
        })
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await listMcpRegistryServers({ query: "context7", limit: 10 });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].install?.packageId).toBe("@upstash/context7-mcp");
    expect(result.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("provider mcp tool loops", () => {
  const mcpTools: ProviderMcpTool[] = [{
    providerToolName: "mcp_docs_search",
    serverId: "docs",
    serverLabel: "Docs",
    toolName: "search",
    description: "Search docs",
    inputSchema: { type: "object", properties: { query: { type: "string" } } }
  }];

  it("executes OpenAI-compatible tool calls before returning final text", async () => {
    process.env.OPENAI_TEST_KEY = "test";
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKeyEnv: "OPENAI_TEST_KEY",
      openAiEndpointMode: "chat-completions" as const
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id: "call-1", type: "function", function: { name: "mcp_docs_search", arguments: "{\"query\":\"sdk\"}" } }]
            }
          }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "Final with tool result." } }] })
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const callMcpTool = vi.fn(async () => "tool result");

    const output = await callProvider(provider, "{}", "Use MCP", {
      mcpTools,
      callMcpTool
    });

    expect(output).toBe("Final with tool result.");
    expect(callMcpTool).toHaveBeenCalledWith({ providerToolName: "mcp_docs_search", argumentsJson: "{\"query\":\"sdk\"}" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("executes OpenAI-compatible research MCP tool calls", async () => {
    process.env.OPENAI_TEST_KEY = "test";
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKeyEnv: "OPENAI_TEST_KEY",
      openAiEndpointMode: "chat-completions" as const
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatCompletionToolCallsSse([
        { id: "call-1", name: "mcp_docs_search", arguments: "{\"query\":\"context7\"}" }
      ]))
      .mockResolvedValueOnce(chatCompletionTextSse("Research answer with docs."));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const callMcpTool = vi.fn(async () => "docs result");

    const output = await callResearchProvider(provider, "Check docs", {
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools,
      callMcpTool
    });

    expect(output).toBe("Research answer with docs.");
    expect(callMcpTool).toHaveBeenCalledWith({ providerToolName: "mcp_docs_search", argumentsJson: "{\"query\":\"context7\"}" });
  });

  it("omits an empty tool_calls field when repairing an invalid OpenAI-compatible final answer", async () => {
    process.env.OPENAI_TEST_KEY = "test";
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKeyEnv: "OPENAI_TEST_KEY",
      openAiEndpointMode: "chat-completions" as const
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatCompletionTextSse("Initial incomplete answer."))
      .mockResolvedValueOnce(chatCompletionTextSse("Repaired answer with REQUIRED_MARKER."));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    let validationCount = 0;

    const output = await callResearchProvider(provider, "Answer and follow any correction guidance.", {
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      validateFinalAnswer: (text) => {
        validationCount += 1;
        return text.includes("REQUIRED_MARKER") ? undefined : "Add REQUIRED_MARKER to the answer.";
      }
    });

    const continuationBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string) as {
      messages: Array<{ role?: string; tool_calls?: unknown[] }>;
    };
    const repairedAssistant = continuationBody.messages.filter((message) => message.role === "assistant").at(-1);

    expect(output).toBe("Repaired answer with REQUIRED_MARKER.");
    expect(validationCount).toBe(2);
    expect(repairedAssistant).not.toHaveProperty("tool_calls");
  });

  it("executes OpenAI-compatible research tool calls through Responses API", async () => {
    process.env.OPENAI_TEST_KEY = "test";
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKeyEnv: "OPENAI_TEST_KEY",
      openAiEndpointMode: "responses" as const
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "resp-1",
          status: "completed",
          output: [{
            type: "function_call",
            call_id: "call-1",
            name: "mcp_docs_search",
            arguments: "{\"query\":\"responses\"}"
          }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "completed",
          output_text: "Research answer with Responses tools."
        })
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const callMcpTool = vi.fn(async () => "responses docs result");

    const output = await callResearchProvider(provider, "Check docs", {
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools,
      callMcpTool
    });
    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);

    expect(output).toBe("Research answer with Responses tools.");
    expect(firstBody.tools).toContainEqual(expect.objectContaining({ type: "function", name: "mcp_docs_search" }));
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user" }),
      {
        type: "function_call",
        call_id: "call-1",
        name: "mcp_docs_search",
        arguments: "{\"query\":\"responses\"}"
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "responses docs result"
      }
    ]));
    expect(callMcpTool).toHaveBeenCalledWith({ providerToolName: "mcp_docs_search", argumentsJson: "{\"query\":\"responses\"}" });
  });

  it("streams OpenAI Responses research answers when tools are available but unused", async () => {
    process.env.OPENAI_TEST_KEY = "test";
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKeyEnv: "OPENAI_TEST_KEY",
      openAiEndpointMode: "responses" as const
    };
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Direct"}\n\n'));
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" answer"}\n\n'));
          controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'));
          controller.close();
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const chunks: string[] = [];

    const output = await callResearchProvider(provider, "Answer directly", {
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools,
      callMcpTool: vi.fn(async () => "unused"),
      onToken: (text) => chunks.push(text)
    });

    expect(output).toBe("Direct answer");
    expect(chunks).toEqual(["Direct", " answer"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streams OpenAI Responses final research answers after tool calls", async () => {
    process.env.OPENAI_TEST_KEY = "test";
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKeyEnv: "OPENAI_TEST_KEY",
      openAiEndpointMode: "responses" as const
    };
    const encoder = new TextEncoder();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[{"type":"function_call","call_id":"call-1","name":"mcp_docs_search","arguments":"{\\\\\\"query\\\\\\":\\\\\\"stream\\\\\\"}"}]}}\n\n'));
          controller.close();
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Tool"}\n\n'));
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" answer"}\n\n'));
          controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'));
          controller.close();
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const callMcpTool = vi.fn(async () => "stream docs result");
    const chunks: string[] = [];

    const output = await callResearchProvider(provider, "Use docs", {
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools,
      callMcpTool,
      onToken: (text) => chunks.push(text)
    });
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);

    expect(output).toBe("Tool answer");
    expect(chunks).toEqual(["Tool", " answer"]);
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({
        type: "function_call",
        call_id: "call-1",
        name: "mcp_docs_search"
      }),
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "stream docs result"
      }
    ]));
  });

  it("executes Anthropic-compatible tool uses before returning final text", async () => {
    process.env.ANTHROPIC_TEST_KEY = "test";
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!,
      apiKeyEnv: "ANTHROPIC_TEST_KEY"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: "tool_use", id: "toolu-1", name: "mcp_docs_search", input: { query: "sdk" } }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "Final Anthropic text." }] })
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const callMcpTool = vi.fn(async () => "tool result");

    const output = await callProvider(provider, "{}", "Use MCP", {
      mcpTools,
      callMcpTool
    });

    expect(output).toBe("Final Anthropic text.");
    expect(callMcpTool).toHaveBeenCalledWith({ providerToolName: "mcp_docs_search", argumentsJson: "{\"query\":\"sdk\"}" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries Anthropic-compatible tool requests without thinking when thinking exhausts max tokens", async () => {
    process.env.ANTHROPIC_TEST_KEY = "test";
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!,
      apiKeyEnv: "ANTHROPIC_TEST_KEY"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [],
          stop_reason: "max_tokens",
          usage: {
            input_tokens: 6178,
            output_tokens: 16000,
            output_tokens_details: { thinking_tokens: 16000 }
          }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "Recovered Anthropic text." }] })
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const progress: string[] = [];

    const output = await callProvider(provider, "{}", "Use MCP", {
      mcpTools,
      callMcpTool: vi.fn(async () => "tool result"),
      onProgress: (event) => progress.push(event.text)
    });
    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);

    expect(output).toBe("Recovered Anthropic text.");
    expect(firstBody.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(secondBody.thinking).toBeUndefined();
    expect(secondBody.output_config).toBeUndefined();
    expect(secondBody.temperature).toBe(0.2);
    expect(progress.join("\n")).toContain("Retrying once without Anthropic thinking controls");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
